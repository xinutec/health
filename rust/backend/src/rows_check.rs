//! Render the twelve table endpoints' rows against production, for diffing
//! against the TypeScript (#982).
//!
//! ⚠ THIS IS THE ONLY THING THAT CHECKS THE DECODE. `tests/row_json.rs` pins the
//! rules — which SQL type takes which JSON shape, and that the host's ISO
//! formatter agrees with Lean's — but a `MySqlRow` cannot be constructed without
//! a server, so no test has ever watched a DECIMAL come off the wire. That gap
//! is not theoretical: running this is what found sqlx refusing `NaiveDateTime`
//! for a TIMESTAMP column, which no amount of reading had suggested.
//!
//! `scripts/rows-check-ts.mjs` prints the same rows through the TypeScript's
//! driver and `JSON.stringify`. The two outputs are meant to be `diff`ed;
//! reading either alone proves nothing.
//!
//! ```text
//! scripts/prod-db.sh node scripts/rows-check-ts.mjs <user> <since> <date> > /tmp/ts.txt
//! scripts/prod-db.sh backend rows-check <user> <since> <date> > /tmp/rs.txt
//! diff /tmp/ts.txt /tmp/rs.txt
//! ```
//!
//! ⚠ `prod-db.sh` forwards a port and `kubectl` writes its own chatter to
//! stdout, so filter both files to the endpoint lines before diffing.
//!
//! ⚠ CAPTURE BOTH SIDES IN ONE TUNNEL SESSION. The window has no upper bound,
//! so it includes today, and today's rows are still being written: a sync
//! landing between two captures moves `steps`, `distance_km` and `synced_at`,
//! which reads exactly like a rendering difference. It cost one false alarm
//! already — the two runs were half an hour apart and disagreed only on the
//! last row of the two tables that had just been synced.

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

use crate::{lean, row_json};

/// Print one line per endpoint: `<name>\t<rows as compact JSON>`.
pub async fn run(pool: &MySqlPool, user: &str, since: &str, date: &str) -> Result<()> {
    let mut failures = 0usize;

    // ⚠ A fn-local literal array, NOT a reference to `routes::tables`' consts.
    // `DL-SQLX-SCHEMA-TRUTH` resolves an inline or fn-local array and checks
    // every query's tables, columns and bind arity against the replayed schema;
    // a const path is opaque to it, and unchecked SQL inside the one command
    // whose job is validating SQL would be the wrong place to lose that.
    let queries: [(&str, &str); 8] = [
        (
            "activity",
            "SELECT * FROM daily_activity WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "sleep",
            "SELECT * FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "heartrate/zones",
            "SELECT * FROM heart_rate_zones WHERE user_id = ? AND date >= ? ORDER BY date, zone_name",
        ),
        (
            "body",
            "SELECT * FROM body WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "spo2",
            "SELECT * FROM spo2_daily WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "hrv",
            "SELECT * FROM hrv_daily WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "breathing",
            "SELECT * FROM breathing_rate WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
        (
            "temperature",
            "SELECT * FROM skin_temperature WHERE user_id = ? AND date >= ? ORDER BY date",
        ),
    ];

    // ⚠ CHECKED HERE, at the moment of use. A parity run that queried something
    // other than what serves would prove nothing and would look exactly as
    // green, so the duplication above is refused rather than trusted.
    let serving: [&str; 8] = [
        crate::routes::tables::SQL_ACTIVITY,
        crate::routes::tables::SQL_SLEEP,
        crate::routes::tables::SQL_HEARTRATE_ZONES,
        crate::routes::tables::SQL_BODY,
        crate::routes::tables::SQL_SPO2,
        crate::routes::tables::SQL_HRV,
        crate::routes::tables::SQL_BREATHING,
        crate::routes::tables::SQL_TEMPERATURE,
    ];
    for (i, (name, sql)) in queries.iter().enumerate() {
        anyhow::ensure!(
            *sql == serving[i],
            "{name}: rows-check would query something the route does not serve.\n               rows-check: {sql}\n  route:      {}",
            serving[i]
        );
    }

    for (name, sql) in queries {
        let rows = sqlx::query(sql)
            .bind(user)
            .bind(since)
            .fetch_all(pool)
            .await
            .with_context(|| format!("{name}: query"))?;
        // ⚠ An unmapped column type fails HERE rather than serving a response
        // with a field quietly missing, which is what the refusal in
        // `Verified.RowShape` is for.
        failures += emit(name, row_json::rows_to_json(&rows))?;
    }

    // `sleep/stages` resolves its main-sleep log first, exactly as the endpoint
    // does — including the absent `ORDER BY`.
    let log = sqlx::query(
        "SELECT log_id FROM sleep WHERE user_id = ? AND date = ? AND is_main_sleep = 1 LIMIT 1",
    )
    .bind(user)
    .bind(date)
    .fetch_optional(pool)
    .await
    .context("sleep/stages: main sleep log")?;
    let stages = match log {
        None => Vec::new(),
        Some(row) => {
            let log_id: i64 = row.try_get("log_id").context("sleep.log_id")?;
            sqlx::query(
                "SELECT * FROM sleep_stages WHERE user_id = ? AND sleep_log_id = ? ORDER BY ts",
            )
            .bind(user)
            .bind(log_id)
            .fetch_all(pool)
            .await
            .context("sleep/stages: stages")?
        }
    };
    failures += emit("sleep/stages", row_json::rows_to_json(&stages))?;

    // The two whole-table reads bind only the user.
    let whole: [(&str, &str); 2] = [
        ("devices", "SELECT * FROM devices WHERE user_id = ?"),
        ("sync-state", "SELECT * FROM sync_state WHERE user_id = ?"),
    ];
    let whole_serving: [&str; 2] = [
        crate::routes::tables::SQL_DEVICES,
        crate::routes::tables::SQL_SYNC_STATE,
    ];
    for (i, (name, sql)) in whole.iter().enumerate() {
        anyhow::ensure!(
            *sql == whole_serving[i],
            "{name}: rows-check would query something the route does not serve"
        );
    }
    for (name, sql) in whole {
        let rows = sqlx::query(sql)
            .bind(user)
            .fetch_all(pool)
            .await
            .with_context(|| format!("{name}: query"))?;
        failures += emit(name, row_json::rows_to_json(&rows))?;
    }

    let next = lean::next_day(date)?;
    let hr = sqlx::query(
        "SELECT * FROM heart_rate_intraday WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts",
    )
    .bind(user)
    .bind(date)
    .bind(&next)
    .fetch_all(pool)
    .await
    .context("heartrate/intraday: query")?;
    failures += emit("heartrate/intraday", row_json::rows_to_json(&hr))?;

    if failures > 0 {
        anyhow::bail!("{failures} endpoint(s) could not be rendered");
    }
    Ok(())
}

/// Print one endpoint's line. Returns 1 when it could not be rendered — the
/// failure is printed and counted rather than thrown, so one unmapped column
/// does not hide the other nine endpoints' output.
fn emit(name: &str, rendered: Result<Vec<serde_json::Value>>) -> Result<usize> {
    match rendered {
        Ok(v) => {
            println!("{name}\t{}", serde_json::to_string(&v)?);
            Ok(0)
        }
        Err(e) => {
            println!("{name}\tERROR {e:#}");
            Ok(1)
        }
    }
}
