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

/// ⚠ ORDER MATTERS: `overpass-api.de` first, `kumi.systems` second — the order
/// the replaced TypeScript used, and the faster one.
///
/// ⚠ EVERY MIRROR'S FAILURE IS CARRIED, NOT JUST THE LAST. Keeping only the
/// final error makes a two-endpoint outage read as a one-endpoint one, because
/// the first mirror's failure is overwritten before anything prints it.
///
/// ⚠ `overpass.osm.ch` IS NOT A SUBSTITUTE and is deliberately absent: it
/// answers 200 with zero elements outside Switzerland, which is
/// indistinguishable from "no routes here" and would silently empty the mirror
/// for a London user.
const OVERPASS_URLS: [&str; 2] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/// Which mirrors attempt number `attempt` may use. Attempt 0 is the first try.
///
/// ⚠ A RETRY GOES TO THE PRIMARY ALONE. `kumi.systems` connects and then returns
/// zero bytes until the cap, so a second full-mirror pass costs
/// `FALLBACK_TIMEOUT_MS` per tile to buy nothing; primary-only keeps a retry
/// affordable against the job's deadline.
///
/// ⚠ IT IS NOT REMOVED FROM ATTEMPT 0. Never having answered here is a reason
/// not to pay for it twice, not proof it cannot answer — and dropping it leaves
/// one endpoint with nothing behind it (`overpass.osm.ch` cannot be that; see
/// [`OVERPASS_URLS`]).
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
/// ⚠ A FALLBACK IS ONLY WORTH A SHORT WAIT. The tile has already spent its
/// budget on the primary, so a fallback that cannot answer promptly is not
/// helping — it is delaying the next tile. `kumi.systems` connects and then
/// never answers, so at the full budget it cost ~90 s per refused tile.
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
/// ⚠ OVERPASS PUBLISHES A CONCURRENCY LIMIT AND LIVE AVAILABILITY, and the
/// limit is small (2 for this client). Firing a tile burst without regard for
/// it earns an IP-level ban, and a fixed inter-tile sleep cannot substitute:
/// it tracks nothing, which is why a pacing bracket came out non-monotonic.
///
/// When the slots are spent the endpoint names the moment the next one frees
/// (`Slot available after: <ts>, in N seconds`), so the polite client is not a
/// slower one — it is one that ASKS.
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
    AllFailed {
        errors: Vec<String>,
        /// Did ANY mirror reply with an HTTP status, as opposed to failing at
        /// the transport?
        ///
        /// ⚠ THE BAN/THROTTLE LINE, and it decides whether a retry is allowed.
        /// A refused connection means the server has stopped listening, and
        /// asking again is what earns a ban; a 429 or 5xx means it is still
        /// talking, and asking again is fair.
        ///
        /// ⚠ IT CANNOT BE INFERRED FROM `wait_for_slot`, which returns 0 when
        /// `/api/status` is itself unreachable — precisely the banned case.
        answered: bool,
    },
}

impl Outcome {
    /// May the tile that produced this be asked again?
    ///
    /// ⚠ LIVES HERE SO THE TILE LOOP AND ITS TEST READ THE SAME ONE. Written as
    /// a `matches!` at the call site, a test could only restate it — and a test
    /// that rebuilds the condition it is checking passes whatever the caller
    /// actually does, including the opposite.
    pub fn may_retry(&self) -> bool {
        matches!(self, Outcome::AllFailed { answered: true, .. })
    }
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
    let mut answered = false;
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
                // It replied. Whatever it said, it is not refusing our packets.
                answered = true;
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
    Outcome::AllFailed { errors, answered }
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
