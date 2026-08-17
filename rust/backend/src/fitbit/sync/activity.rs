//! The daily activity summary. Port of `src/fitbit/sync/activity.ts`.
//!
//! # One call per day, and the budget check comes AFTER the write
//!
//! Fitbit's daily summary is single-date, so a range is a call per day. The
//! TypeScript checks the budget at the END of each iteration rather than the
//! start, which means a run always makes at least one call and always finishes
//! the day it started. Kept as-is: the alternative shape can stop having
//! fetched a day without writing it, and the summary is one row — there is no
//! partial state to leave behind.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use crate::fitbit::client::{FitbitClient, FitbitError};

/// Below this remaining budget the day loop stops. See [`super::heartrate`].
const ACTIVITY_BUDGET_FLOOR: i64 = 10;

#[derive(Deserialize)]
struct Distance {
    activity: String,
    distance: f64,
}

#[derive(Deserialize)]
struct Summary {
    steps: i64,
    #[serde(rename = "caloriesOut")]
    calories_out: f64,
    #[serde(rename = "activityCalories")]
    activity_calories: f64,
    #[serde(default)]
    distances: Vec<Distance>,
    floors: i64,
    elevation: f64,
    #[serde(rename = "sedentaryMinutes")]
    sedentary_minutes: i64,
    #[serde(rename = "lightlyActiveMinutes")]
    lightly_active_minutes: i64,
    #[serde(rename = "fairlyActiveMinutes")]
    fairly_active_minutes: i64,
    #[serde(rename = "veryActiveMinutes")]
    very_active_minutes: i64,
    #[serde(rename = "restingHeartRate")]
    resting_heart_rate: Option<i64>,
    #[serde(rename = "activeScore")]
    active_score: i64,
}

#[derive(Deserialize)]
struct DailySummary {
    summary: Summary,
}

/// The total distance across the day.
///
/// Fitbit breaks `distances` down by activity — `total`, `tracker`, `loggedActivities`
/// and several more — and only `total` is the day's figure. A missing entry is
/// `0.0` and not null, matching the TypeScript: the column is a distance and a
/// day with no movement genuinely walked zero.
fn total_distance(s: &Summary) -> f64 {
    s.distances
        .iter()
        .find(|d| d.activity == "total")
        .map(|d| d.distance)
        .unwrap_or(0.0)
}

/// `/1/user/-/activities/date/{date}.json`, one call per day.
pub async fn sync_activity(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    dates: &[String],
) -> Result<usize, FitbitError> {
    let mut synced = 0usize;

    for date in dates {
        let body = client
            .get_json(
                access_token,
                &format!("/1/user/-/activities/date/{date}.json"),
            )
            .await?;
        let parsed: DailySummary =
            serde_json::from_str(&body).context("parsing activity response")?;
        let s = &parsed.summary;

        sqlx::query(
            "INSERT INTO daily_activity (user_id, date, steps, calories_total, calories_active, \
             distance_km, floors, elevation_m, minutes_sedentary, minutes_lightly_active, \
             minutes_fairly_active, minutes_very_active, active_score, resting_heart_rate) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE steps=VALUES(steps), \
             calories_total=VALUES(calories_total), calories_active=VALUES(calories_active), \
             distance_km=VALUES(distance_km), floors=VALUES(floors), \
             elevation_m=VALUES(elevation_m), minutes_sedentary=VALUES(minutes_sedentary), \
             minutes_lightly_active=VALUES(minutes_lightly_active), \
             minutes_fairly_active=VALUES(minutes_fairly_active), \
             minutes_very_active=VALUES(minutes_very_active), \
             active_score=VALUES(active_score), resting_heart_rate=VALUES(resting_heart_rate)",
        )
        .bind(user_id)
        .bind(date)
        .bind(s.steps)
        .bind(s.calories_out)
        .bind(s.activity_calories)
        .bind(total_distance(s))
        .bind(s.floors)
        .bind(s.elevation)
        .bind(s.sedentary_minutes)
        .bind(s.lightly_active_minutes)
        .bind(s.fairly_active_minutes)
        .bind(s.very_active_minutes)
        .bind(s.active_score)
        .bind(s.resting_heart_rate)
        .execute(pool)
        .await
        .context("writing daily_activity")?;
        synced += 1;

        if client.rate.remaining() <= ACTIVITY_BUDGET_FLOOR {
            tracing::info!("[{user_id}] Activity paused at {date}, rate limit low");
            break;
        }
    }

    tracing::info!("[{user_id}] Synced {synced} days of activity");
    Ok(synced)
}
