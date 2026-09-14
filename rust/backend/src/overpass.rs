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
/// ⚠ EVERY MIRROR'S FAILURE IS CARRIED, NOT JUST THE LAST — this is a deliberate
/// DEPARTURE from `overpassFetch`, which keeps only `lastErr`. That is why
/// #1153's log named `kumi.systems` on every line and read as a one-endpoint
/// outage while BOTH endpoints were down: the first mirror's failure was
/// overwritten before anything printed it. Reproduced here once (2026-08-25
/// dry run, 6 of 18 tiles) and then fixed. The behaviour is unchanged — only
/// the diagnosis is.
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

/// Which mirrors attempt number `attempt` may use. Attempt 0 is the first try.
///
/// ⚠ A RETRY GOES TO THE PRIMARY ALONE, because the fallback has never answered
/// anything. Measured from isis on 2026-09-12 and again on 2026-09-14:
/// `kumi.systems` completes the TCP connect in 0.02-0.15 s and then returns
/// zero bytes until the cap. What it reliably costs is `FALLBACK_TIMEOUT_MS`;
/// what it has reliably produced is nothing.
///
/// That cost is what makes the retry affordable. On 2026-09-14 the nightly lost
/// 15 of 36 tiles, each spending ~6 s on the primary's 504 and then the full
/// 15 s on the fallback — ~21 s a tile, which accounts for the whole 5m17s by
/// which that run exceeded 2026-09-13's. A second full-mirror pass would add
/// another five minutes; a primary-only pass adds ~6 s per tile still refusing.
///
/// ⚠ THE FALLBACK IS NOT REMOVED FROM ATTEMPT 0. It has never answered *here*,
/// on this host, in these measurements — a reason not to pay for it twice, not
/// proof it can never answer. Dropping it would leave one endpoint with nothing
/// behind it, and `overpass.osm.ch` cannot be that something (see above).
pub fn attempt_urls(attempt: usize) -> &'static [&'static str] {
    if attempt == 0 {
        &OVERPASS_URLS
    } else {
        &OVERPASS_URLS[..1]
    }
}

/// The request path's budget. The offline mirrors pass their own, larger one.
pub const REQUEST_TIMEOUT_MS: u64 = 20_000;

/// The offline mirrors' budget — well above the request path's fail-fast cap,
/// because a 0.05-degree central-London tile legitimately returns ~5 MB and
/// Overpass queues for a compute slot under load, holding the socket silent
/// before it streams.
pub const MIRROR_TIMEOUT_MS: u64 = 90_000;

/// What a mirror gets AFTER the first one has already failed.
///
/// ⚠ A FALLBACK IS ONLY WORTH A SHORT WAIT. By the time it is tried the primary
/// has refused, the tile has already cost its budget, and the fallback's job is
/// to be a QUICK alternative — one that cannot answer promptly is not helping,
/// it is just delaying the next tile.
///
/// ⚠ MEASURED, because the 90 s above was costing a full minute and a half per
/// failed tile. From isis on 2026-09-12:
///
/// ```text
/// overpass-api.de  200, first byte 1.4 s, 3.3 MB complete in 2.1 s
/// overpass-api.de  504, in 6.0-6.3 s
/// kumi.systems     connects in 0.15 s and then NEVER ANSWERS — 120 s cap hit
/// ```
///
/// So `kumi.systems` was burning the whole 90 s on every tile the primary
/// refused, and that is where ~102 s between consecutive tile failures went
/// (#1153). Fifteen seconds is seven times a healthy full tile's total.
///
/// ⚠ NOT APPLIED TO THE FIRST MIRROR. Overpass's slot queuing means a
/// legitimate primary request can sit silent well past this, and cutting it
/// would trade a real answer for a fast failure.
pub const FALLBACK_TIMEOUT_MS: u64 = 15_000;

/// `overpass-api.de`'s status endpoint. Cheap, and the one they publish so a
/// client does not have to guess.
const STATUS_URL: &str = "https://overpass-api.de/api/status";

/// What `/api/status` says about THIS client's compute slots.
///
/// ⚠ **OVERPASS PUBLISHES A CONCURRENCY LIMIT AND LIVE AVAILABILITY, and until
/// 2026-09-13 nothing here read either.** Measured from isis that day:
///
/// ```text
/// Connected as: 3712168559
/// Current time: 2026-09-13T10:21:15Z
/// Rate limit: 2
/// 2 slots available now.
/// ```
///
/// **Two.** The bus refresh fired eighteen tile queries back to back with no
/// regard for that number, which is what got isis banned at the IP level for
/// 45+ minutes (#1153 defect A). A fixed inter-tile sleep cannot fix it either,
/// because it is not tracking anything — which is why the pacing bracket came
/// out non-monotonic and was rightly refuted.
///
/// When the slots are spent the endpoint names the moment the next one frees:
///
/// ```text
/// Slot available after: 2026-09-13T10:25:00Z, in 42 seconds.
/// ```
///
/// So the polite client is not a slower one, it is one that ASKS.
#[derive(Debug, PartialEq, Eq)]
pub struct Slots {
    /// The per-IP concurrency limit. `0` means unmetered for this client.
    pub limit: u32,
    pub available: u32,
    /// Seconds until the soonest slot frees. `None` when one is free now.
    pub next_in_s: Option<u64>,
}

/// Read `/api/status`. `None` when it cannot be parsed, which is deliberately
/// NOT an error: a status endpoint that changed shape must not stop the refresh.
///
/// ⚠ The seconds are taken from `in N seconds`, not by subtracting the quoted
/// timestamp from the local clock. A host whose clock is off would otherwise
/// compute a negative or enormous wait out of a correct answer.
pub fn parse_status(body: &str) -> Option<Slots> {
    let mut limit = None;
    let mut available = None;
    let mut next: Option<u64> = None;
    for line in body.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Rate limit:") {
            limit = rest.trim().parse::<u32>().ok();
        } else if let Some(n) = t
            .strip_suffix("slots available now.")
            .or_else(|| t.strip_suffix("slot available now."))
        {
            available = n.trim().parse::<u32>().ok();
        } else if t.starts_with("Slot available after:")
            && let Some((_, tail)) = t.rsplit_once(", in ")
        {
            // `42 seconds.` — the soonest of however many are listed.
            if let Some(secs) = tail
                .trim_end_matches('.')
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
            {
                next = Some(next.map_or(secs, |c: u64| c.min(secs)));
            }
        }
    }
    // A body naming neither a count nor a wait is not a status page.
    //
    // ⚠ NOT `unwrap_or`, which evaluates its argument even when the Option is
    // Some — the `return None` inside one fired on every healthy response and
    // made a parsed "2 slots available now." read as an unparseable page.
    let available = match available {
        Some(a) => a,
        None if next.is_some() => 0,
        None => return None,
    };
    Some(Slots {
        limit: limit.unwrap_or(0),
        available,
        next_in_s: if available > 0 { None } else { next },
    })
}

/// Ask Overpass whether it has a slot for us, and wait out the answer.
///
/// Returns the seconds actually slept. `cap_s` bounds it so a mirror announcing
/// an absurd wait cannot stall the whole refresh — the caller's breaker and
/// deadline stay in charge.
///
/// ⚠ ONE STATUS READ PER TILE, not a poll loop. The endpoint says how long to
/// wait, so waiting that long and proceeding is the whole protocol; asking
/// repeatedly while we wait would be the same discourtesy in miniature.
pub async fn wait_for_slot(client: &reqwest::Client, cap_s: u64) -> u64 {
    let res = client
        .get(STATUS_URL)
        .header("User-Agent", USER_AGENT)
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .send()
        .await;
    let Ok(r) = res else { return 0 };
    let Ok(body) = r.text().await else { return 0 };
    let Some(s) = parse_status(&body) else {
        return 0;
    };
    if s.available > 0 {
        return 0;
    }
    // `+1` so we come back just after the slot frees rather than on the tick.
    let wait = s.next_in_s.unwrap_or(0).saturating_add(1).min(cap_s);
    if wait > 0 {
        eprintln!("  overpass: 0 of {} slots free — waiting {wait}s", s.limit);
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
    wait
}

/// What one fetch attempt produced.
pub enum Outcome {
    /// A 2xx, with the body.
    Ok(String),
    /// A permanent refusal — a non-429 4xx. Not worth another mirror, and not
    /// the breaker's business.
    Permanent { status: u16 },
    /// Every mirror failed. The caller records this against the breaker.
    ///
    /// ⚠ ONE ENTRY PER MIRROR, in the order tried. A single string here is what
    /// made a two-endpoint outage unreadable.
    AllFailed { errors: Vec<String> },
}

/// POST one query to each mirror this attempt may use, in turn, until one
/// answers. `attempt` is 0 for a tile's first try; see [`attempt_urls`] for why
/// a later one is narrower.
///
/// ⚠ THIS DOES NOT TOUCH THE BREAKER. The caller owns the breaker state because
/// the breaker is Lean's, and threading it through here would mean holding Lean
/// state in a `static`. The caller's loop is where `recordFailure` and
/// `recordSuccess` belong.
pub async fn fetch_attempt(
    client: &reqwest::Client,
    query: &str,
    timeout_ms: u64,
    attempt: usize,
) -> Outcome {
    let mut errors: Vec<String> = Vec::new();
    for (i, url) in attempt_urls(attempt).iter().enumerate() {
        // The first mirror gets the caller's budget; anything after it gets the
        // fallback's, which is what stops a hung mirror costing a minute and a
        // half per tile.
        let budget = if i == 0 {
            timeout_ms
        } else {
            timeout_ms.min(FALLBACK_TIMEOUT_MS)
        };
        let res = client
            .post(*url)
            .header("Content-Type", "text/plain")
            .header("User-Agent", USER_AGENT)
            .timeout(Duration::from_millis(budget))
            .body(query.to_string())
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => match r.text().await {
                Ok(body) => return Outcome::Ok(body),
                // A 2xx whose body could not be read is a transport failure, not
                // a permanent one — try the other mirror.
                Err(e) => errors.push(format!("{url}: reading the body failed: {e}")),
            },
            Ok(r) => {
                let status = r.status().as_u16();
                // ⚠ Permanent unless transient. 429 and 5xx are worth another
                // mirror; every other 4xx means the query itself is wrong and
                // the second mirror will say the same thing.
                if status != 429 && status < 500 {
                    return Outcome::Permanent { status };
                }
                errors.push(format!("{url} returned {status}"));
            }
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Outcome::AllFailed { errors }
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
