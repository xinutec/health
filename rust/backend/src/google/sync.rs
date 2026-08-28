//! Writing Google Health into the biometric tables (#260).
//!
//! ⚠ ONE WRITER PER STREAM, and `google::source` says which streams these are.
//! The tables are `ON DUPLICATE KEY UPDATE`, so a stream written by both this
//! and `fitbit::sync` would flip with whichever job ran last.

use anyhow::{Context, Result};
use sqlx::MySqlPool;
use std::collections::BTreeMap;

use super::health::fetch_daily_series;

/// One day's breathing rates, any of which may be absent.
#[derive(Default, Clone, Copy)]
struct Br {
    full: Option<f64>,
    deep: Option<f64>,
    light: Option<f64>,
    rem: Option<f64>,
}

/// `breathing_rate`, drawn from TWO Google types.
///
/// # Why two
///
/// Measured 2026-08-28 against the live account:
///
/// ```text
///   full_sleep_rate vs daily-respiratory-rate       1186/1186 EXACT
///   full_sleep_rate vs summary/fullSleepStats       61 differ, worst 2.6
/// ```
///
/// They are different statistics and ours is the daily one. Fitbit's own code
/// says why: `full_sleep_rate` falls back to the top-level `breathingRate` when
/// the per-stage summary is absent — and for this account it is ALWAYS absent,
/// which is why our three stage columns hold zero rows. So our full rate has
/// always been the daily figure, and `daily-respiratory-rate` is its twin.
///
/// ⚠ The three stage columns are a GAIN, not a risk: Fitbit never returned them
/// (0 rows in 1,186 days) and Google has 1,197 days of each.
///
/// ⚠ A day present in only one type still writes. The columns are independent
/// and a missing stage rate is a null, exactly as the Fitbit writer leaves it.
pub async fn sync_breathing_rate(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let mut by_day: BTreeMap<String, Br> = BTreeMap::new();

    for d in fetch_daily_series(
        http,
        access_token,
        "daily-respiratory-rate",
        "/dailyRespiratoryRate/breathsPerMinute",
    )
    .await
    .context("fetching daily-respiratory-rate")?
    {
        by_day.entry(d.date).or_default().full = Some(d.value);
    }

    // ⚠ Three walks of the same type rather than one walk reading three
    // pointers. It is ~1,200 points over two pages in a daily job, and the
    // alternative is a bespoke multi-pointer fetch whose only virtue is saving
    // a round trip nobody is waiting on.
    for (pointer, which) in [
        (
            "/respiratoryRateSleepSummary/deepSleepStats/breathsPerMinute",
            0u8,
        ),
        (
            "/respiratoryRateSleepSummary/lightSleepStats/breathsPerMinute",
            1,
        ),
        (
            "/respiratoryRateSleepSummary/remSleepStats/breathsPerMinute",
            2,
        ),
    ] {
        for d in fetch_daily_series(
            http,
            access_token,
            "respiratory-rate-sleep-summary",
            pointer,
        )
        .await
        .with_context(|| format!("fetching {pointer}"))?
        {
            let e = by_day.entry(d.date).or_default();
            match which {
                0 => e.deep = Some(d.value),
                1 => e.light = Some(d.value),
                _ => e.rem = Some(d.value),
            }
        }
    }

    let mut written = 0usize;
    for (date, br) in &by_day {
        // ⚠ A row with NO full rate is skipped. Fitbit's writer treats a null
        // full rate as "the row is useless" and this keeps that: writing a day
        // whose only content is a stage rate would create a row the readers
        // have never had to handle.
        let Some(full) = br.full else { continue };
        sqlx::query(
            "INSERT INTO breathing_rate (user_id, date, full_sleep_rate, deep_sleep_rate, \
             light_sleep_rate, rem_sleep_rate) VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE full_sleep_rate=VALUES(full_sleep_rate), \
             deep_sleep_rate=VALUES(deep_sleep_rate), light_sleep_rate=VALUES(light_sleep_rate), \
             rem_sleep_rate=VALUES(rem_sleep_rate)",
        )
        .bind(user_id)
        .bind(date)
        .bind(full)
        .bind(br.deep)
        .bind(br.light)
        .bind(br.rem)
        .execute(pool)
        .await
        .with_context(|| format!("writing breathing_rate for {date}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google breathing_rate: {written} day(s), {} with a deep-sleep rate",
        by_day.values().filter(|b| b.deep.is_some()).count()
    );
    Ok(written)
}

/// One day's HRV figures, either of which may be absent.
#[derive(Default, Clone, Copy)]
struct Hrv {
    daily: Option<f64>,
    deep: Option<f64>,
}

/// `hrv_daily`, drawn from ONE Google type through TWO pointers.
///
/// # Both columns, and why that needed saying
///
/// Measured 2026-08-28 against the live account:
///
/// ```text
///   daily_rmssd vs averageHeartRateVariabilityMilliseconds        1195/1195 EXACT
///   deep_rmssd  vs deepSleepRootMeanSquare…Milliseconds           1196/1196 EXACT
/// ```
///
/// ⚠ #260 had this stream written up as "1195/1195 exact, **single source**"
/// and cleared to flip. That verdict came from comparing ONE of the table's two
/// value columns; `deep_rmssd` had never been compared, and flipping on it would
/// have frozen that column at whatever Fitbit last wrote while the other went on
/// updating — a table half-live, with a green comparison over it.
///
/// The deep figure is in the SAME type, not a per-stage sibling. That sibling
/// was guessed from `respiratory-rate-sleep-summary` (which is how
/// `breathing_rate` got its stage columns) and measured HTTP 400, "not
/// supported" — see the note in [`super::probe`].
///
/// ⚠ A day with only ONE of the two still writes. Both columns are nullable and
/// both readers already take `Option<f64>`, so a half-filled row is a shape they
/// handle; dropping the day instead would discard a real measurement to avoid a
/// null that costs nothing.
pub async fn sync_hrv_daily(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let mut by_day: BTreeMap<String, Hrv> = BTreeMap::new();

    for (pointer, is_deep) in [
        (
            "/dailyHeartRateVariability/averageHeartRateVariabilityMilliseconds",
            false,
        ),
        (
            "/dailyHeartRateVariability/deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds",
            true,
        ),
    ] {
        for d in fetch_daily_series(http, access_token, "daily-heart-rate-variability", pointer)
            .await
            .with_context(|| format!("fetching {pointer}"))?
        {
            let e = by_day.entry(d.date).or_default();
            if is_deep {
                e.deep = Some(d.value);
            } else {
                e.daily = Some(d.value);
            }
        }
    }

    let mut written = 0usize;
    for (date, h) in &by_day {
        sqlx::query(
            "INSERT INTO hrv_daily (user_id, date, daily_rmssd, deep_rmssd) VALUES (?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE daily_rmssd=VALUES(daily_rmssd), deep_rmssd=VALUES(deep_rmssd)",
        )
        .bind(user_id)
        .bind(date)
        .bind(h.daily)
        .bind(h.deep)
        .execute(pool)
        .await
        .with_context(|| format!("writing hrv_daily for {date}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google hrv_daily: {written} day(s), {} with a deep-sleep rmssd",
        by_day.values().filter(|h| h.deep.is_some()).count()
    );
    Ok(written)
}
