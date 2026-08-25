//! The Overpass HTTP client — IO glue for the two OSM mirrors (#982 Tier 2).
//!
//! Port of the transport half of `src/geo/osm-overpass.ts`. The DECISIONS this
//! file appears to make are not made here: whether the breaker is open, and what
//! a failure does to it, live in `Verified.Geo.OverpassBreaker`. What is left is
//! genuinely IO — which URL, what timeout, which status codes are worth a
//! second mirror.
//!
//! ⚠ THE STATUS-CODE RULE IS NOT "RETRY ON !ok". A 4xx that is not 429 is
//! PERMANENT — a malformed query — and is returned immediately without trying
//! the other mirror and without counting toward the breaker. Retrying a bad
//! query on every mirror wastes the timeout budget twice and then trips the
//! breaker for the queries that would have worked.

use anyhow::{Context, Result, bail};
use std::time::Duration;

/// Identify ourselves. Overpass's public mirrors block unattributed clients,
/// and this address is the one their admins can reach.
pub const USER_AGENT: &str = "health.xinutec.org (pippijn@xinutec.org)";

/// ⚠ SAME ORDER AS THE TYPESCRIPT, and that is deliberate rather than
/// incidental: `overpass-api.de` first, `kumi.systems` second. Measurement on
/// 2026-08-25 had the first answering a central-London bus query in 1.5 s while
/// the second returned 500 after 31 s, so the order also happens to be the fast
/// one — but matching the arm being replaced is the reason it is written this
/// way.
///
/// ⚠ A FAILING MIRROR LEAVES NO RECORD UNLESS IT FAILS LAST. `Outcome::AllFailed`
/// carries only the LAST error, exactly as `overpassFetch` keeps only `lastErr`,
/// which is why #1153's log named kumi and read as a one-endpoint outage when
/// both endpoints were down. Preserved for parity; the caller should log the
/// tile, not just this string.
///
/// ⚠ `overpass.osm.ch` IS NOT A SUBSTITUTE and is deliberately absent: it
/// answers 200 with zero elements for anything outside Switzerland, which is
/// indistinguishable from "no routes here" and would silently empty the mirror
/// for a London user. #1153 reached for it as a replacement mirror; it cannot be
/// one.
const OVERPASS_URLS: [&str; 2] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/// The request path's budget. The offline mirrors pass their own, larger one.
pub const REQUEST_TIMEOUT_MS: u64 = 20_000;

/// The offline mirrors' budget — well above the request path's fail-fast cap,
/// because a 0.05-degree central-London tile legitimately returns ~5 MB.
pub const MIRROR_TIMEOUT_MS: u64 = 90_000;

/// What one fetch attempt produced.
pub enum Outcome {
    /// A 2xx, with the body.
    Ok(String),
    /// A permanent refusal — a non-429 4xx. Not worth another mirror, and not
    /// the breaker's business.
    Permanent { status: u16 },
    /// Every mirror failed. The caller records this against the breaker.
    AllFailed { last: String },
}

/// POST one query to each mirror in turn until one answers.
///
/// ⚠ THIS DOES NOT TOUCH THE BREAKER. The caller owns the breaker state because
/// the breaker is Lean's, and threading it through here would mean holding Lean
/// state in a `static`. The caller's loop is where `recordFailure` and
/// `recordSuccess` belong.
pub async fn fetch_once(client: &reqwest::Client, query: &str, timeout_ms: u64) -> Outcome {
    let mut last = String::from("no mirror was tried");
    for url in OVERPASS_URLS {
        let res = client
            .post(url)
            .header("Content-Type", "text/plain")
            .header("User-Agent", USER_AGENT)
            .timeout(Duration::from_millis(timeout_ms))
            .body(query.to_string())
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => match r.text().await {
                Ok(body) => return Outcome::Ok(body),
                // A 2xx whose body could not be read is a transport failure, not
                // a permanent one — try the other mirror.
                Err(e) => last = format!("{url}: reading the body failed: {e}"),
            },
            Ok(r) => {
                let status = r.status().as_u16();
                // ⚠ Permanent unless transient. 429 and 5xx are worth another
                // mirror; every other 4xx means the query itself is wrong and
                // the second mirror will say the same thing.
                if status != 429 && status < 500 {
                    return Outcome::Permanent { status };
                }
                last = format!("{url} returned {status}");
            }
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Outcome::AllFailed { last }
}

/// Parse an Overpass response body into its `elements` array.
///
/// ⚠ A MISSING `elements` KEY IS AN EMPTY LIST, matching `data.elements ?? []`.
/// Overpass omits it for a query that matched nothing, and treating that as an
/// error would turn "this tile has no bus routes" into a tile failure — which
/// then counts toward the refusal that protects the cache.
///
/// ⚠ BUT A MALFORMED ONE IS AN ERROR, not an empty list. Defaulting there is the
/// same defect as the DECIMAL columns that decoded to 0.0 while the check
/// printed OK: the mirror would shrink and every signal would say it worked.
pub fn elements(body: &str) -> Result<Vec<serde_json::Value>> {
    let v: serde_json::Value =
        serde_json::from_str(body).context("the Overpass response is not JSON")?;
    match v.get("elements") {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(a)) => Ok(a.clone()),
        Some(other) => bail!("the Overpass response's `elements` is {other}, not an array"),
    }
}
