//! Repair `sleep`'s derived UTC columns where they contradict their own wall
//! clock (#340).
//!
//! ⚠ **TWO COLUMNS, AND THE SECOND ONE IS WHY THIS TICKET REOPENED.** The first
//! run (2026-09-11) named `end_time_utc` alone and repaired 39 rows. Its twin
//! `start_time_utc` was never asked the same question, so three rows went on
//! contradicting their own wall clock for four more days — by 10, 25 and 41
//! minutes, offsets London cannot produce. A repair scoped to one column of a
//! pair leaves the pair inconsistent and reports success.
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
//! wall clock and zone imply — `end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')`,
//! and the same sentence with `start_`.
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

/// Print the rows a pass is about to change.
///
/// ⚠ **DATES AND CLOCK TIMES ONLY.** These repos are public and a sleep row
/// says where he was; the columns selected here carry no place and no
/// coordinate, and the callers all alias to `wall`/`stored`/`fixed` so this
/// stays true however the query is edited.
fn show(rows: &[sqlx::mysql::MySqlRow]) {
    for r in rows {
        let g = |c: &str| -> String { r.try_get(c).unwrap_or_default() };
        println!(
            "  {}  wall {}   stored {}  ->  {}",
            g("d"),
            g("wall"),
            g("stored"),
            g("fixed")
        );
    }
}

// ⚠ THE PREDICATE IS WRITTEN OUT AT EVERY SITE, not hoisted into a `const`.
// `DL-SQLX-SCHEMA-TRUTH` wants a string LITERAL so sqlx can check it against
// the schema, and a tool that UPDATEs production is the last place to trade
// that away for tidiness. The three copies per column must stay identical —
// the before/after counts are only evidence if they ask the same question.
//
// ⚠ **AND THAT DUPLICATION IS WHAT HID THE SECOND COLUMN.** Six near-identical
// literals that differ in one token read as one repair; the eye supplies the
// symmetry the code does not have. The pairing is now stated by the OUTPUT —
// both columns are counted on every run, including the dry one, so a column
// left out is visible before anything is written rather than four days after.
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

    // ⚠ **BOTH COLUMNS ARE COUNTED BEFORE EITHER IS WRITTEN**, so a dry run
    // states the whole job. The first pass of this repair reported "0 still
    // contradicting" while three rows in the twin column were untouched — a
    // true sentence about half a question.
    let end_n = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
               AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
               AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("counting broken end_time_utc rows")?,
        "n",
    )?;
    println!("{end_n} row(s) whose end_time_utc contradicts their own end_time + tz");

    // Show them before touching anything — dates and offsets only, no places.
    let rows = sqlx::query(
        "SELECT CAST(date AS CHAR) d, CAST(end_time AS CHAR) wall, \
         CAST(end_time_utc AS CHAR) stored, CAST(CONVERT_TZ(end_time, tz, 'UTC') AS CHAR) fixed \
         FROM sleep \
         WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
           AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
           AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC') \
         ORDER BY date",
    )
    .fetch_all(&pool)
    .await
    .context("listing broken end_time_utc rows")?;
    show(&rows);

    let start_n = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND start_time_utc IS NOT NULL \
               AND CONVERT_TZ(start_time, tz, 'UTC') IS NOT NULL \
               AND start_time_utc <> CONVERT_TZ(start_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("counting broken start_time_utc rows")?,
        "n",
    )?;
    println!("{start_n} row(s) whose start_time_utc contradicts their own start_time + tz");

    let rows = sqlx::query(
        "SELECT CAST(date AS CHAR) d, CAST(start_time AS CHAR) wall, \
         CAST(start_time_utc AS CHAR) stored, \
         CAST(CONVERT_TZ(start_time, tz, 'UTC') AS CHAR) fixed \
         FROM sleep \
         WHERE tz IS NOT NULL AND start_time_utc IS NOT NULL \
           AND CONVERT_TZ(start_time, tz, 'UTC') IS NOT NULL \
           AND start_time_utc <> CONVERT_TZ(start_time, tz, 'UTC') \
         ORDER BY date",
    )
    .fetch_all(&pool)
    .await
    .context("listing broken start_time_utc rows")?;
    show(&rows);

    if !write {
        println!(
            "\nDRY RUN — nothing written. This sets each column from the row's own \
             wall clock and tz on the {end_n} + {start_n} row(s) above, and touches \
             no other column.\nApply with: --write"
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
    .context("applying the end_time_utc repair")?;
    println!("wrote {} end_time_utc row(s)", res.rows_affected());

    let res = sqlx::query(
        "UPDATE sleep SET start_time_utc = CONVERT_TZ(start_time, tz, 'UTC') \
         WHERE tz IS NOT NULL AND start_time_utc IS NOT NULL \
           AND CONVERT_TZ(start_time, tz, 'UTC') IS NOT NULL \
           AND start_time_utc <> CONVERT_TZ(start_time, tz, 'UTC')",
    )
    .execute(&pool)
    .await
    .context("applying the start_time_utc repair")?;
    println!("wrote {} start_time_utc row(s)", res.rows_affected());

    let end_left = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND end_time_utc IS NOT NULL \
               AND CONVERT_TZ(end_time, tz, 'UTC') IS NOT NULL \
               AND end_time_utc <> CONVERT_TZ(end_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("re-counting end_time_utc after the write")?,
        "n",
    )?;
    let start_left = count(
        &sqlx::query(
            "SELECT CAST(COUNT(*) AS CHAR) n FROM sleep \
             WHERE tz IS NOT NULL AND start_time_utc IS NOT NULL \
               AND CONVERT_TZ(start_time, tz, 'UTC') IS NOT NULL \
               AND start_time_utc <> CONVERT_TZ(start_time, tz, 'UTC')",
        )
        .fetch_one(&pool)
        .await
        .context("re-counting start_time_utc after the write")?,
        "n",
    )?;
    println!(
        "{end_left} end_time_utc + {start_left} start_time_utc row(s) still contradicting \
         (expect 0 and 0)"
    );
    pool.close().await;
    Ok(())
}
