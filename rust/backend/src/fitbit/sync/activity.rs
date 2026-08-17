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

/// Fitbit's daily summary.
///
/// # ⚠ EVERY FIELD IS OPTIONAL, and that was learned the hard way
///
/// These were required, and a run against production failed with
/// ``missing field `floors` `` — Fitbit omits it entirely for a tracker with no
/// altimeter. The whole activity stream was lost for all three days: steps,
/// calories, distance and every active-minute band, because one field about
/// stairs was absent.
///
/// The TypeScript "declares" the same fields non-optional, but a TS interface is
/// erased at runtime — `s.floors` is `undefined`, binds as NULL, and the row is
/// written with a hole nobody is told about. So the two implementations failed
/// in opposite directions: it lost the fact, this lost the day.
///
/// ⚠ The `daily_activity` schema has ALWAYS said so: every data column in it is
/// nullable. Requiring them here was stricter than the table, stricter than
/// Fitbit, and stricter than the TypeScript — three sources that agreed, none of
/// which was consulted.
///
/// Absent now means NULL, which is what the column is for, plus a warning naming
/// the fields — the honest answer the TypeScript reaches silently.
#[derive(Deserialize)]
struct Summary {
    steps: Option<i64>,
    #[serde(rename = "caloriesOut")]
    calories_out: Option<f64>,
    #[serde(rename = "activityCalories")]
    activity_calories: Option<f64>,
    #[serde(default)]
    distances: Option<Vec<Distance>>,
    floors: Option<i64>,
    elevation: Option<f64>,
    #[serde(rename = "sedentaryMinutes")]
    sedentary_minutes: Option<i64>,
    #[serde(rename = "lightlyActiveMinutes")]
    lightly_active_minutes: Option<i64>,
    #[serde(rename = "fairlyActiveMinutes")]
    fairly_active_minutes: Option<i64>,
    #[serde(rename = "veryActiveMinutes")]
    very_active_minutes: Option<i64>,
    #[serde(rename = "restingHeartRate")]
    resting_heart_rate: Option<i64>,
    #[serde(rename = "activeScore")]
    active_score: Option<i64>,
}

impl Summary {
    /// The fields Fitbit did not send, for the log line.
    ///
    /// ⚠ Reported rather than counted. "3 fields missing" would not say WHICH,
    /// and the difference between an absent `floors` (a tracker without an
    /// altimeter, permanent and uninteresting) and an absent `steps` (something
    /// is wrong) is the entire content of the message.
    fn absent(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut check = |present: bool, name: &'static str| {
            if !present {
                out.push(name)
            }
        };
        check(self.steps.is_some(), "steps");
        check(self.calories_out.is_some(), "caloriesOut");
        check(self.activity_calories.is_some(), "activityCalories");
        check(self.distances.is_some(), "distances");
        check(self.floors.is_some(), "floors");
        check(self.elevation.is_some(), "elevation");
        check(self.sedentary_minutes.is_some(), "sedentaryMinutes");
        check(
            self.lightly_active_minutes.is_some(),
            "lightlyActiveMinutes",
        );
        check(self.fairly_active_minutes.is_some(), "fairlyActiveMinutes");
        check(self.very_active_minutes.is_some(), "veryActiveMinutes");
        check(self.active_score.is_some(), "activeScore");
        // ⚠ `restingHeartRate` is NOT here. It is legitimately absent on a day
        // with too little heart-rate coverage to compute one, so listing it
        // would make the warning fire on ordinary days and train the reader to
        // ignore it.
        out
    }
}

#[derive(Deserialize)]
struct DailySummary {
    summary: Summary,
}

/// The total distance across the day.
///
/// Fitbit breaks `distances` down by activity — `total`, `tracker`,
/// `loggedActivities` and several more — and only `total` is the day's figure.
///
/// ⚠ Absent is `None`, NOT `0.0`, and this is a deliberate change from both the
/// TypeScript and this function's first version. Zero distance and unknown
/// distance are different facts, and only one of them is a claim about the day.
/// Fitbit reports a `total` entry even for a day spent still — it reads
/// `0`, not nothing — so an absent breakdown means the API did not say, and
/// writing zero would manufacture a day of no movement out of a gap in the
/// response.
fn total_distance(s: &Summary) -> Option<f64> {
    s.distances
        .as_ref()?
        .iter()
        .find(|d| d.activity == "total")
        .map(|d| d.distance)
}

/// One day's summary, ready to write.
///
/// Every field is `Option` because every column is nullable and Fitbit omits
/// what the device cannot measure. See [`Summary`] for what that cost once.
#[derive(Debug, Default, PartialEq)]
pub struct ActivityRow {
    pub steps: Option<i64>,
    pub calories_total: Option<f64>,
    pub calories_active: Option<f64>,
    pub distance_km: Option<f64>,
    pub floors: Option<i64>,
    pub elevation_m: Option<f64>,
    pub minutes_sedentary: Option<i64>,
    pub minutes_lightly_active: Option<i64>,
    pub minutes_fairly_active: Option<i64>,
    pub minutes_very_active: Option<i64>,
    pub active_score: Option<i64>,
    pub resting_heart_rate: Option<i64>,
    /// Field names Fitbit did not send. Empty on a complete response.
    pub absent: Vec<&'static str>,
}

/// Parse one `/1/user/-/activities/date/{date}.json` body.
///
/// ⚠ Refuses only when the response has no `summary` at all. An INDIVIDUAL
/// missing field is a NULL and a note, never a refusal — refusing lost the
/// whole day's steps and calories over an absent stair count.
pub fn parse_activity_summary(body: &str) -> Result<ActivityRow> {
    let parsed: DailySummary = serde_json::from_str(body).context("parsing activity response")?;
    let s = &parsed.summary;
    Ok(ActivityRow {
        steps: s.steps,
        calories_total: s.calories_out,
        calories_active: s.activity_calories,
        distance_km: total_distance(s),
        floors: s.floors,
        elevation_m: s.elevation,
        minutes_sedentary: s.sedentary_minutes,
        minutes_lightly_active: s.lightly_active_minutes,
        minutes_fairly_active: s.fairly_active_minutes,
        minutes_very_active: s.very_active_minutes,
        active_score: s.active_score,
        resting_heart_rate: s.resting_heart_rate,
        absent: s.absent(),
    })
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
        let s = parse_activity_summary(&body)?;

        let absent = &s.absent;
        if !absent.is_empty() {
            // WARN and not ERROR: the row is still written and the missing
            // columns are honestly NULL. It is worth a line because the
            // TypeScript reaches the same rows in silence, which is how a
            // permanently-absent field looks identical to one that just stopped
            // arriving.
            tracing::warn!(
                "[{user_id}] activity {date}: Fitbit omitted {} — stored as NULL",
                absent.join(", ")
            );
        }

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
        .bind(s.calories_total)
        .bind(s.calories_active)
        .bind(s.distance_km)
        .bind(s.floors)
        .bind(s.elevation_m)
        .bind(s.minutes_sedentary)
        .bind(s.minutes_lightly_active)
        .bind(s.minutes_fairly_active)
        .bind(s.minutes_very_active)
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
