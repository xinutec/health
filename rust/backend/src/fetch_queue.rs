//! What the serving path could not answer, so the drain beside it can fetch it.
//!
//! The fold declines a lookup it has no data for ("nothing is there" would be a
//! claim), and without a record the same coordinate went unanswered on every
//! fold. Fetching inline would put a network round trip on the serving path, so
//! the request records and `crate::fetch_drain` fetches within seconds: the day
//! is blank once and right on its next view.
//!
//! `kind` is `osm_cache.query_type`, so the drain writes into the cache the
//! fold reads.
//!
//! Recording is best effort: [`record`] logs and returns `Ok` on a write
//! failure rather than fail a page; the next fold records the miss again.
//!
//! Every decline comes through `MirrorSource`'s coverage gate, the one writer.
//! The drain runs in the `health-fetch` sidecar, or by hand as
//! `backend fetch-osm` / `fetch-geocodes`.

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

/// The queue `kind` for a feature bucket, namespaced apart from the geocode's
/// `nominatim_z<n>` kinds.
#[must_use]
pub fn queue_kind(bucket: &str) -> String {
    format!("osm_{bucket}")
}

/// The queue key for one declined question, not a box: grid-snapped boxes leave
/// points near a cell edge uncovered, since `osm_covered` wants the disc inside
/// one box. The key stays exact, `asked_count` counts folds that wanted it, and
/// the drain dedups against the coverage gate. Full precision, as
/// `rowset_answerer::decline_key`.
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

/// How many times a key is retried. Past it the row stays rather than being
/// deleted: a deleted key reappears on the next fold, an invisible retry loop.
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
/// Errors are logged, not returned — see the module header.
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
        // Loud, and not fatal. dev-lint: this is not a masking fallback —
        // the value is a side record, the caller has no use for the error, and
        // the miss re-records on the next fold.
        eprintln!("osm_fetch_queue: could not record {kind}({key}): {e}");
    }
}

/// Keys still worth fetching, capped, most-wanted first (`asked_count` DESC),
/// so the rate-limited budget goes to coordinates several days want.
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

/// One counted attempt at a key. Counting after the fetch, a crash mid-fetch (an
/// OOM kill) counted nothing and every restart asked the same key first,
/// forever; an outcome is written only through this, so it is always counted.
#[must_use = "record the outcome with done, failed or exhaust"]
pub struct Attempt<'a> {
    pool: &'a MySqlPool,
    kind: &'a str,
    key: &'a str,
}

/// Count an attempt at `key` before making it.
pub async fn claim<'a>(pool: &'a MySqlPool, kind: &'a str, key: &'a str) -> Result<Attempt<'a>> {
    sqlx::query(
        "UPDATE osm_fetch_queue SET attempts = attempts + 1, \
         last_error = 'attempt started; no outcome recorded' \
         WHERE kind = ? AND fetch_key = ?",
    )
    .bind(kind)
    .bind(key)
    .execute(pool)
    .await
    .context("claiming an osm_fetch_queue row")?;
    Ok(Attempt { pool, kind, key })
}

impl Attempt<'_> {
    /// The key is answered: drop it.
    pub async fn done(self) -> Result<()> {
        sqlx::query("DELETE FROM osm_fetch_queue WHERE kind = ? AND fetch_key = ?")
            .bind(self.kind)
            .bind(self.key)
            .execute(self.pool)
            .await
            .context("clearing an osm_fetch_queue row")?;
        Ok(())
    }

    /// The attempt failed; the key stays visible and is retried while
    /// attempts remain.
    pub async fn failed(self, why: &str) -> Result<()> {
        self.note(None, why).await
    }

    /// The key will fail the same way every time (a malformed query, an area
    /// the endpoint will not serve): no further attempts, the row carries why.
    pub async fn exhaust(self, why: &str) -> Result<()> {
        self.note(Some(MAX_ATTEMPTS), why).await
    }

    /// A clean shutdown interrupted it: not an attempt. Every deploy stops the
    /// drains, and counting that would retire whichever key was in flight.
    pub async fn release(self) -> Result<()> {
        sqlx::query(
            "UPDATE osm_fetch_queue SET attempts = GREATEST(attempts - 1, 0), \
             last_error = 'interrupted by a shutdown' \
             WHERE kind = ? AND fetch_key = ?",
        )
        .bind(self.kind)
        .bind(self.key)
        .execute(self.pool)
        .await
        .context("releasing an osm_fetch_queue row")?;
        Ok(())
    }

    async fn note(self, attempts: Option<i32>, why: &str) -> Result<()> {
        // Truncated here: MariaDB truncates silently or errors depending on
        // strict mode.
        let why: String = why.chars().take(255).collect();
        sqlx::query(
            "UPDATE osm_fetch_queue SET attempts = COALESCE(?, attempts), last_error = ? \
             WHERE kind = ? AND fetch_key = ?",
        )
        .bind(attempts)
        .bind(&why)
        .bind(self.kind)
        .bind(self.key)
        .execute(self.pool)
        .await
        .context("recording an osm_fetch_queue outcome")?;
        Ok(())
    }
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
                // `CAST(… AS SIGNED)`: MariaDB sums a boolean into DECIMAL,
                // which sqlx will not hand back as an i64 — a mismatch that only
                // shows up on real rows.
                r.try_get::<Option<i64>, _>("waiting")?.unwrap_or(0),
                r.try_get::<Option<i64>, _>("exhausted")?.unwrap_or(0),
            ))
        })
        .collect()
}
