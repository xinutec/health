//! The watch's battery trace for one day, read back from `device_battery_log`.
//!
//! Plotted alongside the phone series on the day view. The shaping — which rows
//! count, the window, the collapse — is `Verified.Geo.Velocity.watchBatterySeries`.
//! What is here is the query and the one conversion Lean cannot do.
//!
//! # ⚠ `last_sync_time` is a WALL CLOCK, so the window cannot be done in SQL
//!
//! Fitbit sends a local time with no offset and the column stores it verbatim.
//! Which instants a civil day covers therefore depends on the zone, and the
//! comparison the `WHERE` can make is between wall clocks. So the query
//! PRE-FILTERS with a generous margin and the exact `[startUtc, endUtc)` window
//! is applied after the conversion, in Lean — the same split the TypeScript
//! makes, for the same reason.
//!
//! # ⚠ NO `ORDER BY`, and that is deliberate
//!
//! Two devices reporting at the same instant keep the row that came LATER in the
//! result set. Adding an `ORDER BY` here would change which level is drawn
//! without changing anything that looks like a decision. Lean sorts by time
//! itself, stably, which is the only ordering the shaping wants.

use anyhow::{Context, Result};
use serde_json::json;
use sqlx::{MySqlPool, Row};

use crate::lean;
use crate::timezone::wall_clock_to_unix;

/// Any zone offset is under 14 h, so ±1 day cannot miss an in-window reading.
/// The TypeScript's own margin.
const QUERY_MARGIN_S: i64 = 86_400;

/// `YYYY-MM-DD HH:MM:SS` in UTC, for comparing against a `DATETIME`.
fn sql_datetime(unix_s: i64) -> Result<String> {
    Ok(chrono::DateTime::from_timestamp(unix_s, 0)
        .with_context(|| format!("{unix_s} is not a representable instant"))?
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

/// The day's watch-battery readings as `(ts, level)`.
///
/// The caller treats a failure as NO SERIES rather than a failed request: this
/// is a display-only chart beside the timeline, and a database hiccup should
/// cost the second line on a graph, not the day.
pub async fn load(
    pool: &MySqlPool,
    user_id: &str,
    tz: &str,
    start_utc: i64,
    end_utc: i64,
) -> Result<Vec<(i64, i64)>> {
    // ⚠ `CAST(battery_level AS SIGNED)`. The column is `TINYINT UNSIGNED`, and
    // sqlx decodes an unsigned MySQL integer into its own exact width — a
    // mismatch compiles and fails only on real rows. The cast is exact for an
    // integer (unlike the `AS CHAR` a DECIMAL needs) and makes the Rust type
    // obvious rather than a fact about the column's declaration.
    let rows = sqlx::query(
        "SELECT last_sync_time, CAST(battery_level AS SIGNED) AS battery_level, device_version \
         FROM device_battery_log \
         WHERE user_id = ? AND last_sync_time >= ? AND last_sync_time < ?",
    )
    .bind(user_id)
    .bind(sql_datetime(start_utc - QUERY_MARGIN_S)?)
    .bind(sql_datetime(end_utc + QUERY_MARGIN_S)?)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading device_battery_log for {user_id}"))?;

    // ⚠ EVERY DECODE ERRORS RATHER THAN DEFAULTING, and this is not caution for
    // its own sake. The first version of this loop wrote
    // `try_get::<u8, _>("battery_level").unwrap_or(0)`, which turns a width
    // mismatch into a watch that reports EMPTY at every sync — a well-formed
    // chart of a dead battery, indistinguishable from a real one. That is the
    // same shape as the loader that decoded 117 production places to centroid
    // 0.0 and still printed OK.
    //
    // The caller may treat a failure here as "no watch series". It must not be
    // this function's job to decide that a broken read looks like a flat line.
    let mut wire: Vec<serde_json::Value> = Vec::with_capacity(rows.len());
    for r in rows {
        // Decoded as a `NaiveDateTime` and re-rendered, not read as text: the
        // column is a `DATETIME` and sqlx will not hand a temporal type back as
        // a string. The wall clock survives either way — no zone is applied on
        // the way out because none was applied on the way in.
        let wall: chrono::NaiveDateTime = r
            .try_get("last_sync_time")
            .context("device_battery_log.last_sync_time does not decode")?;
        // ⚠ An UNRESOLVABLE wall clock is `null`, not an error. A zone gap or a
        // malformed row is a reading whose instant is unknown, and Lean drops
        // it; that is a fact about the data, where a failed decode is a fact
        // about this code.
        let ts = wall_clock_to_unix(&wall.format("%Y-%m-%d %H:%M:%S").to_string(), tz);
        let level: i64 = r
            .try_get("battery_level")
            .context("device_battery_log.battery_level does not decode")?;
        // Nullable. An absent one is an UNKNOWN device rather than the phone, so
        // it stays null and Lean keeps the row.
        let device: Option<String> = r
            .try_get("device_version")
            .context("device_battery_log.device_version does not decode")?;
        wire.push(json!([ts, level, device]));
    }

    lean::watch_battery_series(&wire, start_utc, end_utc)
}
