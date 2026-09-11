//! Repair `sleep.end_time_utc` rows that contradict their own wall clock (#340).
//!
//! ⚠ AN EXAMPLE, NOT A `bin/backend` VERB — a one-off data repair, and a
//! production CLI that exists to rewrite production rows is the wrong shape.
//!
//! # Why not `google-backfill-sleep`
//!
//! That was the first plan and the diff refuted it. Re-fetching 130 days
//! rewrites every night in the window from Google: measured 2026-09-11, it
//! would have rewritten 115 stage series, moved `date` on 11 nights, and
//! replaced SEVEN full nights with Google's stub sessions — 2026-06-07's
//! 10h52m becomes 28 minutes. That is data loss, not a repair.
//!
//! This touches ONE column on the rows that are provably wrong, and derives the
//! value from data already in the row.
//!
//! # The oracle
//!
//! A row is wrong when its stored instant disagrees with what its OWN stored
//! wall clock and zone imply: `end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')`.
//! That is an internal contradiction, not a judgement about where he was — a
//! genuine DST night converts correctly and is left alone, because `CONVERT_TZ`
//! consults the zone database rather than assuming a fixed offset.
//!
//! ⚠ ROWS WITH `tz IS NULL` ARE NOT TOUCHED. Those are the Google writer's
//! (it binds `tz` as a literal NULL); with no zone there is nothing to derive
//! from, and `CONVERT_TZ` would return NULL and ERASE a value. The `WHERE`
//! requires a non-null conversion for exactly that reason.
//!
//! ```text
//! scripts/prod-db.sh rust/target/release/examples/sleep_utc_repair          # dry run
//! scripts/prod-db.sh rust/target/release/examples/sleep_utc_repair --write  # apply
//! ```

use anyhow::{Context, Result};
use backend::db;
use sqlx::Row as _;

/// ⚠ Counts arrive as DECIMAL/BIGINT and a plain `try_get::<i64>` FAILS on the
/// real row; wrapping that in `unwrap_or(0)` is what once printed "0 null" for
/// 32 million rows. Everything is `CAST(... AS CHAR)` and parsed, so a bad
/// decode stops the program instead of becoming a zero.
fn count(r: &sqlx::mysql::MySqlRow, col: &str) -> Result<i64> {
    let s: String = r
        .try_get(col)
        .with_context(|| format!("column `{col}` did not decode as CHAR"))?;
    s.trim()
        .parse()
        .with_context(|| format!("column `{col}` = {s:?} is not a number"))
}

/// ⚠ THE PREDICATE IS WRITTEN OUT AT EVERY SITE, not hoisted into a `const`.
/// `DL-SQLX-SCHEMA-TRUTH` wants a string LITERAL so sqlx can check it against
/// the schema, and a tool that UPDATEs production is the last place to trade
/// that away for tidiness. The three copies below must stay identical — the
/// before/after counts are only evidence if they ask the same question.

#[tokio::main]
async fn main() -> Result<()> {
    let write = std::env::args().any(|a| a == "--write");
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url()).await.context("connecting")?;

    // ⚠ PROVE `CONVERT_TZ` WORKS BEFORE TRUSTING ANY COUNT. It returns NULL when
    // the server's zone tables are not loaded, and a NULL makes every row look
    // consistent — a clean bill from a function that answered nothing.
    let probe = sqlx::query(
        "SELECT CAST(CONVERT_TZ('2026-06-15 12:00:00','Europe/London','UTC') AS CHAR) v",
    )
    .fetch_one(&pool)
    .await
    .context("CONVERT_TZ probe")?;
    let v: Option<String> = probe.try_get("v").context("probe decode")?;
    let Some(v) = v else {
        anyhow::bail!(
            "CONVERT_TZ returned NULL — the server's timezone tables are not loaded, \
             so every row would read as consistent. Load them before trusting this."
        );
    };
    println!("CONVERT_TZ probe: Europe/London 12:00 -> {v} UTC (expect 11:00:00)");

    let n = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
               AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
               AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("counting broken rows")?,
        "n",
    )?;
    println!("{n} row(s) whose end_time_utc contradicts their own end_time + tz");

    // Show them before touching anything — dates and offsets only, no places.
    let rows = sqlx::query(
        "SELECT CAST(date AS CHAR) d, CAST(end_time AS CHAR) et, \
         CAST(end_time_utc AS CHAR) etu, CAST(CONVERT_TZ(end_time, tz, 'UTC') AS CHAR) fixed \
         FROM sleep \
         WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
           AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
           AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC') \
         ORDER BY date",
    )
    .fetch_all(&pool)
    .await
    .context("listing broken rows")?;
    for r in &rows {
        let g = |c: &str| -> String { r.try_get(c).unwrap_or_default() };
        println!(
            "  {}  end {}   stored {}  ->  {}",
            g("d"),
            g("et"),
            g("etu"),
            g("fixed")
        );
    }

    if !write {
        println!(
            "\nDRY RUN — nothing written. This sets end_time_utc from the row's own \
             end_time and tz on the {n} row(s) above, and touches no other column.\n\
             Apply with: --write"
        );
        pool.close().await;
        return Ok(());
    }

    let res = sqlx::query(
        "UPDATE sleep SET end_time_utc = CONVERT_TZ(end_time, tz, 'UTC') \
         WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
           AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
           AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')",
    )
    .execute(&pool)
    .await
    .context("applying the repair")?;
    println!("wrote {} row(s)", res.rows_affected());

    let left = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
               AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
               AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("re-counting after the write")?,
        "n",
    )?;
    println!("{left} row(s) still contradicting (expect 0)");
    pool.close().await;
    Ok(())
}
