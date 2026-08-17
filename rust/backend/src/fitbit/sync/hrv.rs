//! Heart-rate variability: the daily RMSSD pair and the 5-minute series.
//!
//! Port of `src/fitbit/sync/hrv.ts`.
//!
//! # The intraday series stores a wall clock with NO tz, unlike its neighbours
//!
//! `hrv_intraday` has no `tz`/`ts_utc` columns and this port does not add them.
//! Fitbit's `minute` field is a local wall clock exactly like heart rate's, so
//! the same three-tier treatment would apply — the columns simply do not exist
//! yet, and inventing them here would be a schema change smuggled into a port.
//!
//! ⚠ That means an HRV point cannot currently be placed on a UTC timeline, and
//! a reader joining it to heart rate is comparing a wall clock to an instant.
//! Written down rather than quietly carried across; the fix is a migration.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use crate::fitbit::client::{FitbitClient, FitbitError};

/// Below this remaining budget the day loop stops. See [`super::heartrate`].
const HRV_BUDGET_FLOOR: i64 = 10;

#[derive(Deserialize)]
struct DailyValue {
    #[serde(rename = "dailyRmssd")]
    daily_rmssd: f64,
    #[serde(rename = "deepRmssd")]
    deep_rmssd: f64,
}

#[derive(Deserialize)]
struct DailyEntry {
    #[serde(rename = "dateTime")]
    date_time: String,
    value: DailyValue,
}

#[derive(Deserialize)]
struct DailyResponse {
    #[serde(default)]
    hrv: Vec<DailyEntry>,
}

#[derive(Deserialize)]
struct MinuteValue {
    rmssd: f64,
    coverage: f64,
    hf: f64,
    lf: f64,
}

#[derive(Deserialize)]
struct MinuteEntry {
    minute: String,
    value: MinuteValue,
}

#[derive(Deserialize)]
struct IntradayDay {
    #[serde(default)]
    minutes: Vec<MinuteEntry>,
}

#[derive(Deserialize)]
struct IntradayResponse {
    #[serde(default)]
    hrv: Vec<IntradayDay>,
}

/// One `hrv_intraday` row.
pub struct HrvRow {
    pub ts: String,
    pub rmssd: f64,
    pub coverage: f64,
    pub hf: f64,
    pub lf: f64,
}

/// The pure part: flatten an intraday response into rows.
///
/// `minute` arrives as `2026-05-10T22:48:30.000` and is stored as the DATETIME
/// `2026-05-10 22:48:30` — the raw Fitbit wall clock kept verbatim, matching how
/// every other stream treats the value it was given.
pub fn parse_hrv_intraday(body: &str) -> Result<Vec<HrvRow>> {
    let parsed: IntradayResponse =
        serde_json::from_str(body).context("parsing HRV intraday response")?;
    let mut rows = Vec::new();
    for day in parsed.hrv {
        for m in day.minutes {
            // Same normalisation as the TypeScript's `replace("T"," ").slice(0,19)`:
            // swap the separator, drop the milliseconds. A value already in
            // DATETIME shape passes through unchanged.
            let ts: String = m
                .minute
                .chars()
                .map(|c| if c == 'T' { ' ' } else { c })
                .take(19)
                .collect();
            rows.push(HrvRow {
                ts,
                rmssd: m.value.rmssd,
                coverage: m.value.coverage,
                hf: m.value.hf,
                lf: m.value.lf,
            });
        }
    }
    Ok(rows)
}

/// `/1/user/-/hrv/date/{start}/{end}.json`
pub async fn sync_hrv(
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
            &format!("/1/user/-/hrv/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let parsed: DailyResponse = serde_json::from_str(&body).context("parsing HRV response")?;

    for e in &parsed.hrv {
        sqlx::query(
            "INSERT INTO hrv_daily (user_id, date, daily_rmssd, deep_rmssd) VALUES (?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE daily_rmssd=VALUES(daily_rmssd), deep_rmssd=VALUES(deep_rmssd)",
        )
        .bind(user_id)
        .bind(&e.date_time)
        .bind(e.value.daily_rmssd)
        .bind(e.value.deep_rmssd)
        .execute(pool)
        .await
        .context("writing hrv_daily")?;
    }
    tracing::info!("[{user_id}] Synced {} days of HRV", parsed.hrv.len());
    Ok(parsed.hrv.len())
}

/// `/1/user/-/hrv/date/{date}/all.json`, one call per day.
///
/// A day with no main sleep has no HRV, which is an empty response and not an
/// error — the same shape as a day the watch was off.
pub async fn sync_hrv_intraday(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    dates: &[String],
) -> Result<usize, FitbitError> {
    let mut total = 0usize;
    for date in dates {
        if client.rate.remaining() <= HRV_BUDGET_FLOOR {
            tracing::info!("[{user_id}] HRV intraday paused, rate limit low");
            break;
        }
        let body = client
            .get_json(access_token, &format!("/1/user/-/hrv/date/{date}/all.json"))
            .await?;
        let rows = parse_hrv_intraday(&body)?;
        if rows.is_empty() {
            continue;
        }
        for r in &rows {
            sqlx::query(
                "INSERT INTO hrv_intraday (user_id, ts, rmssd, coverage, hf, lf) \
                 VALUES (?, ?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE rmssd=VALUES(rmssd), coverage=VALUES(coverage), \
                 hf=VALUES(hf), lf=VALUES(lf)",
            )
            .bind(user_id)
            .bind(&r.ts)
            .bind(r.rmssd)
            .bind(r.coverage)
            .bind(r.hf)
            .bind(r.lf)
            .execute(pool)
            .await
            .context("writing hrv_intraday")?;
        }
        total += rows.len();
        tracing::info!(
            "[{user_id}] Synced {} HRV intraday points for {date}",
            rows.len()
        );
    }
    Ok(total)
}
