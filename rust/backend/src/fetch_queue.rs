//! What the serving path could not answer, so a job can fetch it later
//! (#1076, #1658).
//!
//! # Why a queue and not a fetch
//!
//! The fold reaches OSM through lookups it DECLINES when it has no data — an
//! honest decline, never an empty answer, because "nothing is there" is a claim
//! about the world (#976). Declining is right and it is also a dead end: the
//! same coordinate went unanswered on every fold forever, because nothing
//! recorded that anyone had asked.
//!
//! Fetching inline would fix that and put a network round trip on the serving
//! path, which is where the fold's latency already hurts (#1071 measures ~27 s
//! on a heavy day). So the request RECORDS and a job FETCHES: the day is blank
//! once and right afterwards.
//!
//! # `kind` is `osm_cache.query_type`
//!
//! Deliberately the same vocabulary. The drain writes back into the cache the
//! fold reads, and a queue whose names do not match what consumes it is how a
//! queue fills with entries nothing drains.
//!
//! # Recording is BEST EFFORT and must never fail a day
//!
//! A user's timeline does not depend on this table. [`record`] logs and returns
//! `Ok` on a write failure — the alternative is a 500 on a page because a
//! telemetry insert lost a race, and the miss will be re-recorded on the next
//! fold anyway.
//!
//! # One writer
//!
//! Every decline — the seven answerer tables and the three matcher reads —
//! comes through `MirrorSource`'s coverage gate (#1709), so there is one
//! `INSERT` and one key vocabulary. The drain is `backend fetch-osm`, where
//! Overpass is.

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

/// The queue `kind` for a feature bucket.
///
/// ⚠ NAMESPACED. `osm_fetch_queue` already holds the geocode's `nominatim_z<n>`
/// kinds (#1076); a bare `highway` beside those reads as a third vocabulary.
#[must_use]
pub fn queue_kind(bucket: &str) -> String {
    format!("osm_{bucket}")
}

/// The queue key for one declined question.
///
/// ⚠ THE QUESTION, NOT THE BOX. Keying by box would need the box to be snapped
/// to a grid to dedup at all, and a grid-shaped box leaves every point within
/// its radius of a cell edge permanently uncovered — `osm_covered` wants the
/// disc inside ONE box and boxes do not union. Keying by the question keeps the
/// key exact, lets `asked_count` mean "folds that wanted this", and moves the
/// dedup to the drain, which can ask the coverage gate itself.
///
/// ⚠ FULL PRECISION, for `backend::rowset_answerer::decline_key`'s reason: a
/// rounded key names a question nobody asks.
#[must_use]
pub fn queue_key(lat: f64, lon: f64, radius_m: f64) -> String {
    format!("{lat}|{lon}|{radius_m}")
}

/// Read a key back. `None` when it is not three numbers.
#[must_use]
pub fn parse_queue_key(key: &str) -> Option<(f64, f64, f64)> {
    let mut p = key.split('|');
    let lat = p.next()?.parse().ok()?;
    let lon = p.next()?.parse().ok()?;
    let radius = p.next()?.parse().ok()?;
    if p.next().is_some() {
        return None;
    }
    Some((lat, lon, radius))
}

/// How many times a key is retried before it is left alone.
///
/// ⚠ NOT a deletion. A key removed from the queue reappears the moment the day
/// is folded again and is retried forever — an invisible loop against a
/// rate-limited public service. Leaving it with `attempts` past the bar keeps it
/// visible and out of the way, which is what a human needs to see.
pub const MAX_ATTEMPTS: i32 = 5;

/// One thing to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub kind: String,
    pub key: String,
    /// How many folds have wanted it. A high count is a coordinate he visits.
    pub asked_count: i32,
    pub attempts: i32,
}

/// Note that a lookup went unanswered. Idempotent per `(kind, key)`.
///
/// ⚠ Errors are logged, not returned — see the module header.
pub async fn record(pool: &MySqlPool, kind: &str, key: &str) {
    let out = sqlx::query(
        "INSERT INTO osm_fetch_queue (kind, fetch_key) VALUES (?, ?) \
         ON DUPLICATE KEY UPDATE asked_count = asked_count + 1",
    )
    .bind(kind)
    .bind(key)
    .execute(pool)
    .await;
    if let Err(e) = out {
        // ⚠ Loud, and not fatal. dev-lint: this is not a masking fallback —
        // the value is a side record, the caller has no use for the error, and
        // the miss re-records on the next fold.
        eprintln!("osm_fetch_queue: could not record {kind}({key}): {e}");
    }
}

/// Keys still worth fetching, oldest-asked first, capped.
///
/// ⚠ Ordered by `asked_count` DESC so a coordinate several days want is fetched
/// before one a single day wanted. A FIFO drain spends a rate-limited budget on
/// whatever happened to arrive first.
pub async fn due(pool: &MySqlPool, kind: &str, limit: i64) -> Result<Vec<Pending>> {
    let rows = sqlx::query(
        "SELECT kind, fetch_key, asked_count, attempts FROM osm_fetch_queue \
         WHERE kind = ? AND attempts < ? \
         ORDER BY asked_count DESC, first_seen ASC LIMIT ?",
    )
    .bind(kind)
    .bind(MAX_ATTEMPTS)
    .bind(limit)
    .fetch_all(pool)
    .await
    .context("reading osm_fetch_queue")?;
    rows.into_iter()
        .map(|r| {
            Ok(Pending {
                kind: r.try_get("kind")?,
                key: r.try_get("fetch_key")?,
                asked_count: r.try_get("asked_count")?,
                attempts: r.try_get("attempts")?,
            })
        })
        .collect()
}

/// Drop a key that has been fetched.
pub async fn done(pool: &MySqlPool, kind: &str, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM osm_fetch_queue WHERE kind = ? AND fetch_key = ?")
        .bind(kind)
        .bind(key)
        .execute(pool)
        .await
        .context("clearing an osm_fetch_queue row")?;
    Ok(())
}

/// Record a failed attempt, keeping the key visible.
pub async fn failed(pool: &MySqlPool, kind: &str, key: &str, why: &str) -> Result<()> {
    // ⚠ TRUNCATED to the column width HERE rather than letting MariaDB do it.
    // A non-strict server truncates silently and a strict one errors, so the
    // same code would behave differently on two servers — and the error it
    // would raise is about the error message, not about the fetch.
    let why: String = why.chars().take(255).collect();
    sqlx::query(
        "UPDATE osm_fetch_queue SET attempts = attempts + 1, last_error = ? \
         WHERE kind = ? AND fetch_key = ?",
    )
    .bind(&why)
    .bind(kind)
    .bind(key)
    .execute(pool)
    .await
    .context("recording an osm_fetch_queue failure")?;
    Ok(())
}

/// Retire a key that will fail the same way every time.
///
/// ⚠ THE DIFFERENCE FROM [`failed`] IS THE CAUSE, not the count. A transport
/// failure earns another night; a PERMANENT refusal — a malformed query, an area
/// the endpoint will not serve — is the same query tomorrow, and spending
/// [`MAX_ATTEMPTS`] nights discovering that is an invisible loop against a
/// rate-limited public service. The row STAYS, past the bar, carrying why.
pub async fn exhaust(pool: &MySqlPool, kind: &str, key: &str, why: &str) -> Result<()> {
    let why: String = why.chars().take(255).collect();
    sqlx::query(
        "UPDATE osm_fetch_queue SET attempts = ?, last_error = ? \
         WHERE kind = ? AND fetch_key = ?",
    )
    .bind(MAX_ATTEMPTS)
    .bind(&why)
    .bind(kind)
    .bind(key)
    .execute(pool)
    .await
    .context("retiring an osm_fetch_queue row")?;
    Ok(())
}

/// What is waiting, by kind: `(kind, waiting, exhausted)`.
pub async fn census(pool: &MySqlPool) -> Result<Vec<(String, i64, i64)>> {
    let rows = sqlx::query(
        "SELECT kind, \
            CAST(SUM(attempts < ?) AS SIGNED) AS waiting, \
            CAST(SUM(attempts >= ?) AS SIGNED) AS exhausted \
         FROM osm_fetch_queue GROUP BY kind ORDER BY kind",
    )
    .bind(MAX_ATTEMPTS)
    .bind(MAX_ATTEMPTS)
    .fetch_all(pool)
    .await
    .context("censusing osm_fetch_queue")?;
    rows.into_iter()
        .map(|r| {
            Ok((
                r.try_get("kind")?,
                // ⚠ `CAST(… AS SIGNED)`: MariaDB sums a boolean into DECIMAL,
                // which sqlx will not hand back as an i64 — a mismatch that only
                // shows up on real rows.
                r.try_get::<Option<i64>, _>("waiting")?.unwrap_or(0),
                r.try_get::<Option<i64>, _>("exhausted")?.unwrap_or(0),
            ))
        })
        .collect()
}
