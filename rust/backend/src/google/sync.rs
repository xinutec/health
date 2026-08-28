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
        // ⚠ A day with only STAGE rates still writes, and that is a reversal.
        //
        // This originally skipped any day with no full rate, reasoning that a
        // stage-only row was a shape the readers had never had to handle. That
        // was decided when the three stage columns held ZERO rows — when a
        // stage-only day could not exist. Google supplies them, 10 such days
        // exist, and the skip was silently discarding all ten every run.
        //
        // Both readers (`routes::tables`, `rows_check`) are `SELECT *` and every
        // column is nullable, so a half-filled row costs nothing. Matches
        // [`sync_hrv_daily`], which writes on either column.
        sqlx::query(
            "INSERT INTO breathing_rate (user_id, date, full_sleep_rate, deep_sleep_rate, \
             light_sleep_rate, rem_sleep_rate) VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE full_sleep_rate=VALUES(full_sleep_rate), \
             deep_sleep_rate=VALUES(deep_sleep_rate), light_sleep_rate=VALUES(light_sleep_rate), \
             rem_sleep_rate=VALUES(rem_sleep_rate)",
        )
        .bind(user_id)
        .bind(date)
        .bind(br.full)
        .bind(br.deep)
        .bind(br.light)
        .bind(br.rem)
        .execute(pool)
        .await
        .with_context(|| format!("writing breathing_rate for {date}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google breathing_rate: {written} day(s), {} with a full rate, {} with a \
         deep-sleep rate",
        by_day.values().filter(|b| b.full.is_some()).count(),
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

/// `skin_temperature`, computed from TWO Google fields.
///
/// # There is no field for this
///
/// Fitbit's `nightlyRelative` is a deviation from a personal baseline. Google
/// publishes the nightly temperature and the baseline as separate ABSOLUTES and
/// nothing in between, so the value we store has to be computed. Measured
/// 2026-08-28 against the live account:
///
/// ```text
///   nightlyTemperatureCelsius - baselineTemperatureCelsius   1194/1194, worst 0.050
///   relativeNightlyStddev30dCelsius                          1192 of 1194 differ, p50 0.599
///   nightlyTemperatureCelsius                                1194 differ, p50 33.612
///   baselineTemperatureCelsius                               1194 differ, p50 33.601
/// ```
///
/// ⚠ THE FIELD WHOSE NAME MATCHES IS THE WORST MAPPING OF THE THREE.
/// `relativeNightlyStddev30dCelsius` reads like the right answer and is a
/// different statistic; taking it on the strength of its name would have moved
/// the column onto something else entirely, and taking its disagreement at face
/// value would have read as "Google does not carry skin temperature".
///
/// ⚠ The 0.050 residual is OURS. `relative_deviation` is `DECIMAL(4,2)` holding
/// values quantised to 0.1 °C, and half a step is 0.05 — the whole of it. The
/// mapping is exact to the limit of what the column can store, so this GAINS
/// precision rather than losing it.
pub async fn sync_skin_temperature(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    const TYPE: &str = "daily-sleep-temperature-derivations";

    let nightly = fetch_daily_series(
        http,
        access_token,
        TYPE,
        "/dailySleepTemperatureDerivations/nightlyTemperatureCelsius",
    )
    .await
    .context("fetching nightlyTemperatureCelsius")?;

    let baseline: BTreeMap<String, f64> = fetch_daily_series(
        http,
        access_token,
        TYPE,
        "/dailySleepTemperatureDerivations/baselineTemperatureCelsius",
    )
    .await
    .context("fetching baselineTemperatureCelsius")?
    .into_iter()
    .map(|d| (d.date, d.value))
    .collect();

    let mut written = 0usize;
    let mut unpaired = 0usize;
    for n in &nightly {
        // ⚠ BOTH HALVES OR NOTHING. A difference needs two operands, and
        // defaulting the absent baseline to zero would store a ~33 °C absolute
        // in a column of ±2 °C deviations — a value the readers would plot
        // without complaint. Google had 4 nights of nightly beyond our range and
        // the counts are reported, so a systematic gap cannot pass as silence.
        let Some(base) = baseline.get(&n.date) else {
            unpaired += 1;
            continue;
        };
        sqlx::query(
            "INSERT INTO skin_temperature (user_id, date, relative_deviation) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE relative_deviation=VALUES(relative_deviation)",
        )
        .bind(user_id)
        .bind(&n.date)
        .bind(n.value - base)
        .execute(pool)
        .await
        .with_context(|| format!("writing skin_temperature for {}", n.date))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google skin_temperature: {written} night(s), {unpaired} without a baseline"
    );
    Ok(written)
}

/// One day's oxygen saturation, any of which may be absent.
#[derive(Default, Clone, Copy)]
struct Spo2 {
    avg: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
}

/// `spo2_daily`, all THREE columns, from one Google type.
///
/// # Why this was written up as blocked, and why that was wrong
///
/// #260 recorded spo2 as BLOCKED: 12 days differ by up to 4.4 percentage points,
/// with a mechanism — `WRITE_OXYGEN_SATURATION` is the one denied Health Connect
/// grant, so Google's SpO2 was presumed to arrive by another path as a different
/// daily statistic.
///
/// ⚠ **THE DAY PATTERN REFUTES THAT.** A different statistic disagrees
/// EVERYWHERE; this one agrees on 1162 of 1174 shared days with p50, p90 AND p99
/// all 0.000, and the twelve exceptions are CONSECUTIVE — 2024-04-15 to
/// 2024-04-26. That is an episode with a cause, not a mismatch of definitions.
/// A count alone could not tell those apart, which is why `google-compare` now
/// prints WHICH days differ.
///
/// ⚠ `lowerBound`/`upperBound` were NOT taken on their names. They sit beside
/// `standardDeviationPercentage`, which is what a confidence interval looks
/// like, so the hypothesis was measured: `average - stddev` against `min_value`
/// agrees on 13 of 1161 days at p50 1.700. Refuted — they are real extremes.
pub async fn sync_spo2_daily(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    const TYPE: &str = "daily-oxygen-saturation";
    let mut by_day: BTreeMap<String, Spo2> = BTreeMap::new();

    for (pointer, which) in [
        ("/dailyOxygenSaturation/averagePercentage", 0u8),
        ("/dailyOxygenSaturation/lowerBoundPercentage", 1),
        ("/dailyOxygenSaturation/upperBoundPercentage", 2),
    ] {
        for d in fetch_daily_series(http, access_token, TYPE, pointer)
            .await
            .with_context(|| format!("fetching {pointer}"))?
        {
            let e = by_day.entry(d.date).or_default();
            match which {
                0 => e.avg = Some(d.value),
                1 => e.min = Some(d.value),
                _ => e.max = Some(d.value),
            }
        }
    }

    let mut written = 0usize;
    for (date, s) in &by_day {
        // ⚠ Any column present writes the row; all three are nullable and the
        // readers take them as such. Same rule as the other writers here.
        sqlx::query(
            "INSERT INTO spo2_daily (user_id, date, avg_value, min_value, max_value) \
             VALUES (?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE avg_value=VALUES(avg_value), min_value=VALUES(min_value), \
             max_value=VALUES(max_value)",
        )
        .bind(user_id)
        .bind(date)
        .bind(s.avg)
        .bind(s.min)
        .bind(s.max)
        .execute(pool)
        .await
        .with_context(|| format!("writing spo2_daily for {date}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google spo2_daily: {written} day(s), {} with a range",
        by_day.values().filter(|s| s.min.is_some()).count()
    );
    Ok(written)
}
