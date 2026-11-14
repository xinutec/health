//! The watch's battery trace for one day, read back from `device_battery_log`.
//! Lean shapes it (`Verified.Geo.Velocity.watchBatterySeries`); this is the
//! query and the one conversion Lean cannot do.
//!
//! Google rows carry their instant in `ts_utc`; the legacy Fitbit rows only a
//! local `last_sync_time`, resolved in the user's zone. So the query
//! pre-filters with a day's margin and Lean applies the exact window.
//!
//! No `ORDER BY`: same-instant rows keep result order, and Lean sorts stably.

use anyhow::{Context, Result};
use serde_json::json;
use sqlx::{MySqlPool, Row};

use crate::lean;
use crate::timezone::wall_clock_to_unix;

/// Any zone offset is under 14 h, so ±1 day cannot miss an in-window reading.
const QUERY_MARGIN_S: i64 = 86_400;

/// `YYYY-MM-DD HH:MM:SS` in UTC, for comparing against a `DATETIME`.
fn sql_datetime(unix_s: i64) -> Result<String> {
    Ok(chrono::DateTime::from_timestamp(unix_s, 0)
        .with_context(|| format!("{unix_s} is not a representable instant"))?
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

/// The day's watch-battery readings as `(ts, level)`. The caller treats a
/// failure as no series: a display-only chart must not cost the day.
pub async fn load(
    pool: &MySqlPool,
    user_id: &str,
    tz: &str,
    start_utc: i64,
    end_utc: i64,
) -> Result<Vec<(i64, i64)>> {
    // ⚠ `CAST(battery_level AS SIGNED)`: the column is `TINYINT UNSIGNED`, and
    // sqlx decodes unsigned integers at their exact width, failing only on
    // real rows.
    let rows = sqlx::query(
        "SELECT last_sync_time, ts_utc, CAST(battery_level AS SIGNED) AS battery_level, \
         device_version FROM device_battery_log \
         WHERE user_id = ? AND last_sync_time >= ? AND last_sync_time < ?",
    )
    .bind(user_id)
    .bind(sql_datetime(start_utc - QUERY_MARGIN_S)?)
    .bind(sql_datetime(end_utc + QUERY_MARGIN_S)?)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading device_battery_log for {user_id}"))?;

    // Every decode errors rather than defaulting: `unwrap_or(0)` would draw a
    // dead battery at every sync. The caller decides what a failure shows.
    let mut wire: Vec<serde_json::Value> = Vec::with_capacity(rows.len());
    for r in rows {
        // Decoded as a `NaiveDateTime`: sqlx will not return a `DATETIME` as
        // text. No zone is applied either way.
        let wall: chrono::NaiveDateTime = r
            .try_get("last_sync_time")
            .context("device_battery_log.last_sync_time does not decode")?;
        // `ts_utc` when the row has it (Google's); else the legacy wall clock
        // in `tz`, `null` when unresolvable, which Lean drops.
        let utc: Option<chrono::NaiveDateTime> = r
            .try_get("ts_utc")
            .context("device_battery_log.ts_utc does not decode")?;
        let ts = match utc {
            Some(u) => Some(u.and_utc().timestamp()),
            None => wall_clock_to_unix(&wall.format("%Y-%m-%d %H:%M:%S").to_string(), tz),
        };
        let level: i64 = r
            .try_get("battery_level")
            .context("device_battery_log.battery_level does not decode")?;
        // Nullable. An absent one is an unknown device rather than the phone, so
        // it stays null and Lean keeps the row.
        let device: Option<String> = r
            .try_get("device_version")
            .context("device_battery_log.device_version does not decode")?;
        wire.push(json!([ts, level, device]));
    }

    lean::watch_battery_series(&wire, start_utc, end_utc)
}
