//! The daily-summary streams: SpO2, skin temperature, breathing rate, devices.
//!
//! Ports of `src/fitbit/sync/{spo2,temperature,breathing,devices}.ts`.
//!
//! # Nothing here goes to Lean, and that is the split working
//!
//! The test from `lib.rs` is *does this DECIDE anything, or does it only move
//! bytes?* These four only move bytes: one range call, a loop, an upsert. The
//! single conditional in the whole file — `battery_level` present or not — is a
//! null check on a wire field, not a rule. So they are Rust in full, and no
//! marker is left behind claiming otherwise.
//!
//! # Every write is an upsert, and re-fetching is deliberate
//!
//! The forward sync re-queries the last two days even once the cursor has moved
//! past them, because Fitbit finalises a day's biometrics after you wake and
//! can revise a recent one. That only works if writing the same day twice is
//! harmless, so every statement here is `ON DUPLICATE KEY UPDATE` — matching the
//! TypeScript exactly, including which columns it updates.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use crate::fitbit::client::{FitbitClient, FitbitError};

/// `{"dateTime": …, "value": {…}}`, the shape every range endpoint returns.
#[derive(Deserialize)]
struct Entry<T> {
    #[serde(rename = "dateTime")]
    date_time: String,
    value: T,
}

#[derive(Deserialize)]
struct SpO2Value {
    avg: f64,
    min: f64,
    max: f64,
}

/// `/1/user/-/spo2/date/{start}/{end}.json`
pub async fn sync_spo2_daily(
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
            &format!("/1/user/-/spo2/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let rows: Vec<Entry<SpO2Value>> =
        serde_json::from_str(&body).context("parsing spo2 response")?;

    for e in &rows {
        sqlx::query(
            "INSERT INTO spo2_daily (user_id, date, avg_value, min_value, max_value) \
             VALUES (?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE avg_value=VALUES(avg_value), min_value=VALUES(min_value), \
             max_value=VALUES(max_value)",
        )
        .bind(user_id)
        .bind(&e.date_time)
        .bind(e.value.avg)
        .bind(e.value.min)
        .bind(e.value.max)
        .execute(pool)
        .await
        .context("writing spo2_daily")?;
    }
    tracing::info!("[{user_id}] Synced {} days of SpO2", rows.len());
    Ok(rows.len())
}

#[derive(Deserialize)]
struct TempValue {
    #[serde(rename = "nightlyRelative")]
    nightly_relative: f64,
}

#[derive(Deserialize)]
struct TempBody {
    #[serde(rename = "tempSkin")]
    temp_skin: Vec<Entry<TempValue>>,
}

/// `/1/user/-/temp/skin/date/{start}/{end}.json`
pub async fn sync_temperature(
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
            &format!("/1/user/-/temp/skin/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let parsed: TempBody = serde_json::from_str(&body).context("parsing temperature response")?;

    for e in &parsed.temp_skin {
        sqlx::query(
            "INSERT INTO skin_temperature (user_id, date, relative_deviation) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE relative_deviation=VALUES(relative_deviation)",
        )
        .bind(user_id)
        .bind(&e.date_time)
        .bind(e.value.nightly_relative)
        .execute(pool)
        .await
        .context("writing skin_temperature")?;
    }
    tracing::info!(
        "[{user_id}] Synced {} days of temperature",
        parsed.temp_skin.len()
    );
    Ok(parsed.temp_skin.len())
}

#[derive(Deserialize)]
struct BrSummary {
    #[serde(rename = "breathingRate")]
    breathing_rate: f64,
}

#[derive(Deserialize)]
struct BrValue {
    #[serde(rename = "breathingRate")]
    breathing_rate: f64,
    #[serde(rename = "fullSleepSummary")]
    full_sleep_summary: Option<BrSummary>,
    #[serde(rename = "deepSleepSummary")]
    deep_sleep_summary: Option<BrSummary>,
    #[serde(rename = "lightSleepSummary")]
    light_sleep_summary: Option<BrSummary>,
    #[serde(rename = "remSleepSummary")]
    rem_sleep_summary: Option<BrSummary>,
}

#[derive(Deserialize)]
struct BrBody {
    br: Vec<Entry<BrValue>>,
}

/// `/1/user/-/br/date/{start}/{end}.json`
///
/// ⚠ `full_sleep_rate` falls back to the top-level `breathingRate` when the
/// per-stage summary is absent, and the three stage columns do NOT — they stay
/// null. That asymmetry is the TypeScript's and is preserved: a null stage rate
/// means Fitbit reported none, while a null full rate would mean the row is
/// useless.
pub async fn sync_breathing_rate(
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
            &format!("/1/user/-/br/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let parsed: BrBody = serde_json::from_str(&body).context("parsing breathing response")?;

    for e in &parsed.br {
        let v = &e.value;
        sqlx::query(
            "INSERT INTO breathing_rate (user_id, date, full_sleep_rate, deep_sleep_rate, \
             light_sleep_rate, rem_sleep_rate) VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE full_sleep_rate=VALUES(full_sleep_rate), \
             deep_sleep_rate=VALUES(deep_sleep_rate), light_sleep_rate=VALUES(light_sleep_rate), \
             rem_sleep_rate=VALUES(rem_sleep_rate)",
        )
        .bind(user_id)
        .bind(&e.date_time)
        .bind(
            v.full_sleep_summary
                .as_ref()
                .map(|s| s.breathing_rate)
                .unwrap_or(v.breathing_rate),
        )
        .bind(v.deep_sleep_summary.as_ref().map(|s| s.breathing_rate))
        .bind(v.light_sleep_summary.as_ref().map(|s| s.breathing_rate))
        .bind(v.rem_sleep_summary.as_ref().map(|s| s.breathing_rate))
        .execute(pool)
        .await
        .context("writing breathing_rate")?;
    }
    tracing::info!(
        "[{user_id}] Synced {} days of breathing rate",
        parsed.br.len()
    );
    Ok(parsed.br.len())
}

#[derive(Deserialize)]
struct Device {
    id: String,
    #[serde(rename = "deviceVersion")]
    device_version: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    battery: Option<String>,
    /// Fitbit sends this as a number on current devices and omits it on older
    /// ones. `Option<f64>` and not `Option<i64>`: a non-integral level would
    /// otherwise fail the whole response rather than one column.
    #[serde(rename = "batteryLevel")]
    battery_level: Option<f64>,
    #[serde(rename = "lastSyncTime")]
    last_sync_time: Option<String>,
}

/// `/1/user/-/devices.json`
pub async fn sync_devices(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
) -> Result<usize, FitbitError> {
    let body = client
        .get_json(access_token, "/1/user/-/devices.json")
        .await?;
    let devices: Vec<Device> = serde_json::from_str(&body).context("parsing devices response")?;

    for d in &devices {
        sqlx::query(
            "INSERT INTO devices (user_id, device_id, device_version, type, battery, \
             battery_level, last_sync_time) VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE device_version=VALUES(device_version), type=VALUES(type), \
             battery=VALUES(battery), battery_level=VALUES(battery_level), \
             last_sync_time=VALUES(last_sync_time)",
        )
        .bind(user_id)
        .bind(&d.id)
        .bind(&d.device_version)
        .bind(&d.kind)
        .bind(&d.battery)
        .bind(d.battery_level)
        .bind(&d.last_sync_time)
        .execute(pool)
        .await
        .context("writing devices")?;

        // The battery history, keyed by `last_sync_time` so re-syncing the same
        // reading is idempotent and a genuinely new sync adds one point. Only
        // when Fitbit gave BOTH a numeric level and a sync time — older devices
        // and responses omit both, and a row keyed on a missing time would
        // collide with itself.
        if let (Some(level), Some(ts)) = (d.battery_level, d.last_sync_time.as_ref()) {
            sqlx::query(
                "INSERT INTO device_battery_log (user_id, device_id, last_sync_time, \
                 battery_level, device_version) VALUES (?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE battery_level=VALUES(battery_level)",
            )
            .bind(user_id)
            .bind(&d.id)
            .bind(ts)
            .bind(level)
            .bind(&d.device_version)
            .execute(pool)
            .await
            .context("writing device_battery_log")?;
        }
    }
    tracing::info!("[{user_id}] Synced {} devices", devices.len());
    Ok(devices.len())
}
