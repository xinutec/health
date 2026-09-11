//! Does each `_utc` column agree with the wall clock beside it? (#340)
//!
//! ⚠ AN EXAMPLE, NOT A `bin/backend` VERB — a one-off audit against production,
//! and a production CLI that exists to grade production data is the wrong shape.
//!
//! # ⚠ THE OBVIOUS ORACLE IS WRONG, and it was tried first
//!
//! "A London wall clock differs from UTC by 0 or 60 minutes, so anything else is
//! a defect" reports 12% of every intraday table as broken. It is not: the other
//! offsets are −420, +600, −480, −240, +120 — Pacific, Australia, Eastern,
//! Europe. Pippijn travels, and an offset is not evidence of anything on its
//! own. That instrument was measuring the itinerary.
//!
//! So each pair is graded against something that cannot encode a guess about
//! where he was:
//!
//!   * intraday — `CONVERT_TZ(ts, tz, 'UTC') = ts_utc`. The row states its own
//!     zone; the question is whether the derived column matches the zone stored
//!     BESIDE it. A wrong answer is an internal contradiction, not a journey.
//!   * `sleep` — the two ends of ONE session must carry the SAME offset. No zone
//!     needed, and it is the comparison that finds a frozen `end_time_utc`
//!     (`start_time_utc` is right because a start is never revised). A genuine
//!     DST transition mid-sleep shows as exactly ±60 and is reported apart.
//!
//! ```text
//! scripts/prod-db.sh rust/target/release/examples/utc_column_audit
//! ```

use anyhow::{Context, Result};
use backend::db;
use sqlx::Row as _;

/// ⚠ `SUM()`/`COUNT()` arrive as DECIMAL/BIGINT and a plain `try_get::<i64>`
/// FAILS on the real row — the first cut of this file wrapped that in
/// `unwrap_or(0)` and printed "0 null" for every table, which read as a clean
/// bill. Every count is `CAST(... AS CHAR)` in SQL and parsed here, so a decode
/// that goes wrong is loud.
fn count(r: &sqlx::mysql::MySqlRow, col: &str) -> Result<i64> {
    let s: String = r
        .try_get(col)
        .with_context(|| format!("column `{col}` did not decode as CHAR"))?;
    s.trim()
        .parse()
        .with_context(|| format!("column `{col}` = {s:?} is not a number"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url()).await.context("connecting")?;

    // Intraday: does the derived instant match the zone stored on the same row?
    for (label, sql) in [
        (
            "sleep_stages",
            "SELECT CAST(COUNT(*) AS CHAR) n, \
             CAST(SUM(ts_utc IS NULL) AS CHAR) nul, \
             CAST(SUM(tz IS NULL) AS CHAR) notz, \
             CAST(SUM(tz IS NOT NULL AND ts_utc IS NOT NULL \
                  AND CONVERT_TZ(ts, tz, 'UTC') <> ts_utc) AS CHAR) bad \
             FROM sleep_stages",
        ),
        (
            "heart_rate_intraday",
            "SELECT CAST(COUNT(*) AS CHAR) n, \
             CAST(SUM(ts_utc IS NULL) AS CHAR) nul, \
             CAST(SUM(tz IS NULL) AS CHAR) notz, \
             CAST(SUM(tz IS NOT NULL AND ts_utc IS NOT NULL \
                  AND CONVERT_TZ(ts, tz, 'UTC') <> ts_utc) AS CHAR) bad \
             FROM heart_rate_intraday",
        ),
        (
            "steps_intraday",
            "SELECT CAST(COUNT(*) AS CHAR) n, \
             CAST(SUM(ts_utc IS NULL) AS CHAR) nul, \
             CAST(SUM(tz IS NULL) AS CHAR) notz, \
             CAST(SUM(tz IS NOT NULL AND ts_utc IS NOT NULL \
                  AND CONVERT_TZ(ts, tz, 'UTC') <> ts_utc) AS CHAR) bad \
             FROM steps_intraday",
        ),
    ] {
        let r = sqlx::query(sql).fetch_one(&pool).await.context(label)?;
        let (n, nul, notz, bad) = (
            count(&r, "n")?,
            count(&r, "nul")?,
            count(&r, "notz")?,
            count(&r, "bad")?,
        );
        println!(
            "{label}: {n} rows — {nul} null ts_utc, {notz} null tz, \
             {bad} CONTRADICT their own tz"
        );
    }

    // sleep: the two ends of one session must carry the same offset.
    let r = sqlx::query(
        "SELECT CAST(COUNT(*) AS CHAR) n, \
         CAST(SUM(start_time_utc IS NULL OR end_time_utc IS NULL) AS CHAR) nul, \
         CAST(SUM(start_time_utc IS NOT NULL AND end_time_utc IS NOT NULL AND \
              TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) \
              <> TIMESTAMPDIFF(MINUTE, end_time_utc, end_time)) AS CHAR) mismatch, \
         CAST(SUM(start_time_utc IS NOT NULL AND end_time_utc IS NOT NULL AND \
              ABS(TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) \
                - TIMESTAMPDIFF(MINUTE, end_time_utc, end_time)) = 60) AS CHAR) dst \
         FROM sleep",
    )
    .fetch_one(&pool)
    .await
    .context("sleep offset pairing")?;
    let (n, nul, mismatch, dst) = (
        count(&r, "n")?,
        count(&r, "nul")?,
        count(&r, "mismatch")?,
        count(&r, "dst")?,
    );
    println!(
        "sleep: {n} sessions — {nul} missing a utc end, {mismatch} whose two ends \
         DISAGREE on the offset ({dst} of those by exactly 60 = a real DST night)"
    );

    // The shape of the disagreement, so it is not read as noise.
    let rows = sqlx::query(
        "SELECT CAST(TIMESTAMPDIFF(MINUTE, end_time_utc, end_time) \
              - TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) AS CHAR) drift, \
         CAST(COUNT(*) AS CHAR) n FROM sleep \
         WHERE start_time_utc IS NOT NULL AND end_time_utc IS NOT NULL \
           AND TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) \
            <> TIMESTAMPDIFF(MINUTE, end_time_utc, end_time) \
         GROUP BY drift ORDER BY COUNT(*) DESC LIMIT 12",
    )
    .fetch_all(&pool)
    .await
    .context("sleep drift histogram")?;
    for r in &rows {
        let drift: String = r.try_get("drift").context("drift")?;
        println!(
            "    end drifts {drift:>7} min from the start's offset  ×{}",
            count(r, "n")?
        );
    }

    // WHEN they are, which decides whether the defect belongs to the Google
    // writer alone or to the Fitbit one that preceded it.
    let rows = sqlx::query(
        "SELECT LEFT(CAST(date AS CHAR), 7) ym, CAST(COUNT(*) AS CHAR) n, \
         CAST(SUM(tz IS NULL) AS CHAR) google FROM sleep \
         WHERE start_time_utc IS NOT NULL AND end_time_utc IS NOT NULL \
           AND TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) \
            <> TIMESTAMPDIFF(MINUTE, end_time_utc, end_time) \
           AND ABS(TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) \
                 - TIMESTAMPDIFF(MINUTE, end_time_utc, end_time)) <> 60 \
         GROUP BY ym ORDER BY ym",
    )
    .fetch_all(&pool)
    .await
    .context("sleep drift by month")?;
    println!(
        "the defective sessions by month (`google` = tz IS NULL, the Google writer's signature):"
    );
    for r in &rows {
        let ym: String = r.try_get("ym").context("ym")?;
        println!(
            "    {ym}  ×{}  of which google {}",
            count(r, "n")?,
            count(r, "google")?
        );
    }

    pool.close().await;
    Ok(())
}
