//! The Overpass HTTP client for the two OSM mirrors: which URL, what timeout,
//! which status codes are worth a second mirror. The breaker is
//! `Verified.Geo.OverpassBreaker`'s.
//!
//! ⚠ The status-code rule is not "retry on !ok". A 4xx other than 429 is a
//! malformed query: returned at once, not tried on the other mirror and not
//! counted toward the breaker, or it wastes both budgets and trips the breaker
//! for queries that would work.

use anyhow::{Context, Result, bail};
use std::time::Duration;

/// Identify ourselves. Overpass's public mirrors block unattributed clients,
/// and this address is the one their admins can reach.
// dev-lint: allow-pii the contact address the mirrors ask for
pub const USER_AGENT: &str = "health.xinutec.org (pippijn@xinutec.org)";

/// `overpass-api.de` first (faster), `kumi.systems` second. Every mirror's
/// failure is carried, so a two-endpoint outage does not read as one.
/// `overpass.osm.ch` is excluded: outside Switzerland it answers 200 with zero
/// elements, which would silently empty the mirror.
const OVERPASS_URLS: [&str; 2] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/// Which mirrors attempt number `attempt` may use (0 is the first try). A retry
/// goes to the primary alone: `kumi.systems` connects and then sends nothing until
/// the cap. It stays in attempt 0, so the primary has something behind it.
pub fn attempt_urls(attempt: usize) -> &'static [&'static str] {
    if attempt == 0 {
        &OVERPASS_URLS
    } else {
        &OVERPASS_URLS[..1]
    }
}

/// The request path's budget. The offline mirrors pass their own, larger one.
pub const REQUEST_TIMEOUT_MS: u64 = 20_000;

/// The offline mirrors' budget, well above the request path's: a central-London
/// tile is ~5 MB, and Overpass holds the socket silent while queuing for a slot.
pub const MIRROR_TIMEOUT_MS: u64 = 90_000;

/// What a mirror gets after the first has failed: the tile has spent its budget,
/// and `kumi.systems` cost ~90 s per refused tile at the full one. Not applied to
/// the primary, which can legitimately sit silent in Overpass's queue.
pub const FALLBACK_TIMEOUT_MS: u64 = 15_000;

/// `overpass-api.de`'s status endpoint. Cheap, and the one they publish so a
/// client does not have to guess.
const STATUS_URL: &str = "https://overpass-api.de/api/status";

/// What `/api/status` says about this client's compute slots. The limit is small
/// (2), a burst earns an IP ban, and a fixed sleep tracks nothing; when slots are
/// spent the endpoint names when the next frees (`in N seconds`), so the polite
/// client asks.
#[derive(Debug, PartialEq, Eq)]
pub struct Slots {
    /// The per-IP concurrency limit. `0` means unmetered for this client.
    pub limit: u32,
    pub available: u32,
    /// Seconds until the soonest slot frees. `None` when one is free now.
    pub next_in_s: Option<u64>,
}

/// Read `/api/status`; `None` when it does not parse, not an error, so a changed
/// page cannot stop the refresh. The wait is taken from `in N seconds`, not the
/// quoted timestamp, so a skewed local clock does not matter.
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
    // A body naming neither a count nor a wait is not a status page. Not
    // `unwrap_or`, whose argument (a `return None`) is evaluated even on `Some`.
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

/// Ask Overpass whether it has a slot and wait out the answer, returning the
/// seconds slept. `cap_s` bounds an absurd wait. One status read per tile: the
/// endpoint says how long, so polling would be the same discourtesy.
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
    /// Every mirror failed (the caller records it against the breaker), one
    /// entry per mirror in the order tried.
    AllFailed {
        errors: Vec<String>,
        /// Did any mirror reply with an HTTP status rather than fail at the
        /// transport? A refused connection means asking again earns a ban; a 429
        /// or 5xx means asking again is fair. `wait_for_slot` returns 0 exactly
        /// when the status page is unreachable too, so it cannot tell.
        answered: bool,
    },
}

impl Outcome {
    /// May the tile that produced this be asked again? Here so the tile loop and
    /// its test read the same predicate rather than a restated one.
    pub fn may_retry(&self) -> bool {
        matches!(self, Outcome::AllFailed { answered: true, .. })
    }
}

/// POST one query to each mirror this attempt may use ([`attempt_urls`]) until
/// one answers. The breaker is Lean state the caller's loop owns, so it is not
/// touched here.
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
                // Permanent unless transient. 429 and 5xx are worth another
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

/// Parse an Overpass response body into its `elements`. Missing `elements` is an
/// empty list (Overpass omits it when nothing matched), but a malformed one is an
/// error: a default would shrink the mirror with every signal saying it worked.
pub fn elements(body: &str) -> Result<Vec<serde_json::Value>> {
    let v: serde_json::Value =
        serde_json::from_str(body).context("the Overpass response is not JSON")?;
    match v.get("elements") {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(a)) => Ok(a.clone()),
        Some(other) => bail!("the Overpass response's `elements` is {other}, not an array"),
    }
}
