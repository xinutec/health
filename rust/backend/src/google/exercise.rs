//! Recorded workouts: Google's `exercise` points into `exercise_sessions` (#1886).
//!
//! Fitbit's history had no table for these. Google serves every one — the
//! watch's (walks, runs, rides, workouts back to 2023) and the Fit app's —
//! each with its interval, type, a metrics summary, start/stop events and
//! splits.
//!
//! ⚠ THE WHOLE POINT IS KEPT (`raw`). The typed columns are what a query wants
//! first; the splits, heart-rate zone durations and events are only in `raw`,
//! and storing them whole is the rule: full resolution, no rollups.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// One workout as `exercise_sessions` stores it.
#[derive(Debug, Clone, PartialEq)]
pub struct ExerciseSession {
    /// The last segment of the point's `name`: Google's id for the session,
    /// stable across edits, so a re-served session replaces its row.
    pub point_id: String,
    pub platform: Option<String>,
    /// The device's display name, or the app's package when no device is named.
    pub source: Option<String>,
    pub exercise_type: Option<String>,
    pub display_name: Option<String>,
    /// The instants, `YYYY-MM-DD HH:MM:SS` UTC.
    pub start_utc: String,
    pub end_utc: String,
    /// The wall clocks the session was lived in, from each end's own offset.
    pub start_ts: String,
    pub end_ts: String,
    pub active_s: Option<i64>,
    pub steps: Option<i64>,
    pub distance_m: Option<f64>,
    pub calories_kcal: Option<f64>,
    pub avg_hr: Option<f64>,
    pub has_gps: Option<bool>,
    /// Google's `updateTime`, so an edit is visible as one.
    pub update_time: Option<String>,
    /// The point exactly as served.
    pub raw: String,
}

/// Read one `exercise` point. `None` when it has no id or no readable interval:
/// a workout with no time is nothing to file.
#[must_use]
pub fn parse_exercise(pt: &serde_json::Value) -> Option<ExerciseSession> {
    use crate::google::health::{numeric, rfc3339_to_utc_datetime, wall_clock_from_physical};
    let str_at = |p: &str| pt.pointer(p).and_then(serde_json::Value::as_str);
    let point_id = str_at("/name")?.rsplit('/').next()?.to_string();
    let ex = pt.get("exercise")?;
    let at = |p: &str| ex.pointer(p).and_then(serde_json::Value::as_str);
    let (start, so, end, eo) = (
        at("/interval/startTime")?,
        at("/interval/startUtcOffset")?,
        at("/interval/endTime")?,
        at("/interval/endUtcOffset")?,
    );
    let summary = |k: &str| {
        ex.pointer(&format!("/metricsSummary/{k}"))
            .and_then(numeric)
    };
    Some(ExerciseSession {
        point_id,
        platform: str_at("/dataSource/platform").map(str::to_string),
        source: str_at("/dataSource/device/displayName")
            .or_else(|| str_at("/dataSource/application/packageName"))
            .map(str::to_string),
        exercise_type: at("/exerciseType").map(str::to_string),
        display_name: at("/displayName").map(str::to_string),
        start_utc: rfc3339_to_utc_datetime(start)?,
        end_utc: rfc3339_to_utc_datetime(end)?,
        start_ts: wall_clock_from_physical(start, so)?,
        end_ts: wall_clock_from_physical(end, eo)?,
        // "3539.368s": whole seconds, as every other duration column holds.
        active_s: at("/activeDuration")
            .and_then(|d| d.strip_suffix('s'))
            .and_then(|d| d.parse::<f64>().ok())
            .map(|d| d.trunc() as i64),
        steps: summary("steps").map(|s| s.round() as i64),
        distance_m: summary("distanceMillimeters").map(|mm| mm / 1000.0),
        calories_kcal: summary("caloriesKcal"),
        avg_hr: summary("averageHeartRateBeatsPerMinute"),
        has_gps: ex
            .pointer("/exerciseMetadata/hasGps")
            .and_then(serde_json::Value::as_bool),
        update_time: at("/updateTime").map(str::to_string),
        raw: pt.to_string(),
    })
}

/// Rows per INSERT, as the other archives batch: the prod tunnel makes every
/// statement a round trip.
const BATCH_ROWS: usize = 200;

/// Every workout Google holds, into `exercise_sessions`.
///
/// ⚠ ALL OF THEM, EVERY RUN. Measured 2026-10-02: 756 sessions, one page, so a
/// filter would save nothing — and a full read is what picks up a session
/// Google edited after the fact. An edit REPLACES its row (keyed by point id):
/// this is Google's record of the session, not a re-decision of ours.
pub async fn sync_exercise(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let points = crate::google::health::fetch_all_points(http, access_token, "exercise")
        .await
        .context("fetching exercise")?;
    let sessions: Vec<ExerciseSession> = points.iter().filter_map(parse_exercise).collect();
    let skipped = points.len() - sessions.len();

    let mut tx = pool
        .begin()
        .await
        .context("opening the exercise transaction")?;
    for batch in sessions.chunks(BATCH_ROWS) {
        let mut qb: sqlx::QueryBuilder<sqlx::MySql> = sqlx::QueryBuilder::new(
            "INSERT INTO exercise_sessions (user_id, point_id, platform, source, exercise_type, \
             display_name, start_utc, end_utc, start_ts, end_ts, active_s, steps, distance_m, \
             calories_kcal, avg_hr, has_gps, update_time, raw) ",
        );
        qb.push_values(batch, |mut row, s| {
            row.push_bind(user_id)
                .push_bind(&s.point_id)
                .push_bind(&s.platform)
                .push_bind(&s.source)
                .push_bind(&s.exercise_type)
                .push_bind(&s.display_name)
                .push_bind(&s.start_utc)
                .push_bind(&s.end_utc)
                .push_bind(&s.start_ts)
                .push_bind(&s.end_ts)
                .push_bind(s.active_s)
                .push_bind(s.steps)
                .push_bind(s.distance_m)
                .push_bind(s.calories_kcal)
                .push_bind(s.avg_hr)
                .push_bind(s.has_gps)
                .push_bind(&s.update_time)
                .push_bind(&s.raw);
        });
        qb.push(
            " ON DUPLICATE KEY UPDATE platform=VALUES(platform), source=VALUES(source), \
             exercise_type=VALUES(exercise_type), display_name=VALUES(display_name), \
             start_utc=VALUES(start_utc), end_utc=VALUES(end_utc), start_ts=VALUES(start_ts), \
             end_ts=VALUES(end_ts), active_s=VALUES(active_s), steps=VALUES(steps), \
             distance_m=VALUES(distance_m), calories_kcal=VALUES(calories_kcal), \
             avg_hr=VALUES(avg_hr), has_gps=VALUES(has_gps), update_time=VALUES(update_time), \
             raw=VALUES(raw)",
        );
        qb.build()
            .execute(&mut *tx)
            .await
            .context("writing a batch of exercise_sessions")?;
    }
    tx.commit().await.context("committing exercise_sessions")?;
    tracing::info!(
        "[{user_id}] google exercise_sessions: {} session(s) from {} point(s), {skipped} unreadable",
        sessions.len(),
        points.len()
    );
    Ok(sessions.len())
}
