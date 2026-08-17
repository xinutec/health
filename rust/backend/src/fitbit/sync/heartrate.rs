//! Heart rate: daily zone summaries and the 1-second intraday series.
//!
//! Port of `src/fitbit/sync/heartrate.ts`.
//!
//! # Nothing here decides; the one rule it had went to Lean
//!
//! Zones are a nested loop over a range response, and intraday is a per-second
//! series stamped with a tz. The only judgement in the TypeScript was the day
//! walk, and that is now `Verified.Sync.dateRangeInclusive` — see
//! [`super`] for why.
//!
//! # Why intraday is one call per day
//!
//! Fitbit's intraday endpoint serves 24 hours at a time, so a range means a
//! call per day and a budget that can run out mid-range. Stopping early is
//! correct and not a failure: the cursor has not moved, so the next scheduled
//! run resumes where this one stopped.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use super::TzSource;
use crate::fitbit::client::{FitbitClient, FitbitError};
use crate::timezone::wall_clock_to_utc_string;

/// Below this remaining budget the day loop stops. Matches the other intraday
/// streams, and sits above the client's own floor so this exits first.
const HR_BUDGET_FLOOR: i64 = 10;

#[derive(Deserialize)]
struct Zone {
    name: String,
    min: i64,
    max: i64,
    minutes: i64,
    #[serde(rename = "caloriesOut")]
    calories_out: f64,
}

#[derive(Deserialize)]
struct ZonesValue {
    #[serde(rename = "heartRateZones")]
    heart_rate_zones: Vec<Zone>,
}

#[derive(Deserialize)]
struct ZonesDay {
    #[serde(rename = "dateTime")]
    date_time: String,
    value: ZonesValue,
}

#[derive(Deserialize)]
struct IntradayPoint {
    time: String,
    value: i64,
}

#[derive(Deserialize)]
struct Intraday {
    dataset: Vec<IntradayPoint>,
}

#[derive(Deserialize)]
struct HrResponse {
    #[serde(rename = "activities-heart", default)]
    days: Vec<ZonesDay>,
    #[serde(rename = "activities-heart-intraday")]
    intraday: Option<Intraday>,
}

/// One `heart_rate_intraday` row.
pub struct HrRow {
    pub ts: String,
    pub bpm: i64,
    pub tz: Option<String>,
    pub ts_utc: Option<String>,
}

/// The pure part: an intraday response and a per-second tz, as rows.
///
/// ⚠ Unlike [`super::steps`] there is NO zero filter here. A zero-step minute
/// carries no information because absence means zero, but a heart rate of zero
/// is not a resting state — Fitbit does not emit one, and dropping it if it did
/// would hide a device fault rather than save a row.
pub fn parse_hr_dataset(body: &str, date: &str, tz_for: TzSource<'_>) -> Result<Vec<HrRow>> {
    let parsed: HrResponse = serde_json::from_str(body).context("parsing heart rate response")?;
    let Some(intraday) = parsed.intraday else {
        return Ok(Vec::new());
    };
    Ok(intraday
        .dataset
        .into_iter()
        .map(|d| {
            let ts = format!("{date} {}", d.time);
            let tz = tz_for(date, &d.time);
            HrRow {
                bpm: d.value,
                ts_utc: wall_clock_to_utc_string(&ts, tz.as_deref()),
                ts,
                tz,
            }
        })
        .collect())
}

/// `/1/user/-/activities/heart/date/{start}/{end}.json`
pub async fn sync_heart_rate_zones(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    start_date: &str,
    end_date: &str,
) -> Result<usize, FitbitError> {
    let body = client
        .get_json(
            access_token,
            &format!("/1/user/-/activities/heart/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let parsed: HrResponse = serde_json::from_str(&body).context("parsing HR zones response")?;

    for day in &parsed.days {
        for z in &day.value.heart_rate_zones {
            sqlx::query(
                "INSERT INTO heart_rate_zones (user_id, date, zone_name, minutes, calories, \
                 min_bpm, max_bpm) VALUES (?, ?, ?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE minutes=VALUES(minutes), calories=VALUES(calories), \
                 min_bpm=VALUES(min_bpm), max_bpm=VALUES(max_bpm)",
            )
            .bind(user_id)
            .bind(&day.date_time)
            .bind(&z.name)
            .bind(z.minutes)
            .bind(z.calories_out)
            .bind(z.min)
            .bind(z.max)
            .execute(pool)
            .await
            .context("writing heart_rate_zones")?;
        }
    }
    tracing::info!("[{user_id}] Synced {} days of HR zones", parsed.days.len());
    Ok(parsed.days.len())
}

/// `/1/user/-/activities/heart/date/{date}/1d/1sec.json`, one call per day.
pub async fn sync_heart_rate_intraday(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    dates: &[String],
    tz_for: TzSource<'_>,
) -> Result<usize, FitbitError> {
    let mut total = 0usize;
    for date in dates {
        if client.rate.remaining() <= HR_BUDGET_FLOOR {
            tracing::info!("[{user_id}] HR intraday paused, rate limit low");
            break;
        }
        let body = client
            .get_json(
                access_token,
                &format!("/1/user/-/activities/heart/date/{date}/1d/1sec.json"),
            )
            .await?;
        let rows = parse_hr_dataset(&body, date, tz_for)?;
        if rows.is_empty() {
            continue;
        }
        for r in &rows {
            sqlx::query(
                // `bpm` overwrites and the tz columns COALESCE-preserve: a
                // re-sync may correct a reading, but it must not erase a zone
                // the backfill CLI established.
                "INSERT INTO heart_rate_intraday (user_id, ts, bpm, tz, ts_utc) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE bpm=VALUES(bpm), tz=COALESCE(tz, VALUES(tz)), \
                 ts_utc=COALESCE(ts_utc, VALUES(ts_utc))",
            )
            .bind(user_id)
            .bind(&r.ts)
            .bind(r.bpm)
            .bind(&r.tz)
            .bind(&r.ts_utc)
            .execute(pool)
            .await
            .context("writing heart_rate_intraday")?;
        }
        total += rows.len();
        tracing::info!(
            "[{user_id}] Synced {} HR intraday points for {date}",
            rows.len()
        );
    }
    Ok(total)
}
