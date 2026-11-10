//! Writing Google Health into the biometric tables.
//!
//! ⚠ One writer per stream; `google::source` says which streams these are.
//! The tables upsert, so a stream written by both this and `fitbit::sync`
//! would flip with whichever job ran last.

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

/// `breathing_rate`, drawn from two Google types.
///
/// `daily-respiratory-rate` gives `full_sleep_rate`, matching Fitbit's on every
/// shared day. `respiratory-rate-sleep-summary` gives the three stage rates,
/// which Fitbit never returned for this account (so its full rate was always
/// the daily figure). A day present in only one type still writes; a missing
/// rate is a null, as the Fitbit writer leaves it.
///
/// Google sends `0.0` for a stage it could not read. No breathing rate is 0,
/// so a zero is stored as NULL; every run re-reads the whole history, so a
/// stored zero is cleared too.
///
/// `full_sleep_rate` is not an average of the stages. It mostly equals the deep
/// rate, and without one Google falls back to another part of the night, which
/// can sit below every stage. It is stored as Google gives it, the figure the
/// Fitbit app shows; `hr-trend --averages` counts those nights as `without_deep`.
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
    .into_iter()
    .filter(|d| d.value > 0.0)
    {
        by_day.entry(d.date).or_default().full = Some(d.value);
    }

    // Three walks of one type rather than a multi-pointer fetch: ~1,200
    // points in a daily job, and the round trip saved is not worth the code.
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
        .into_iter()
        .filter(|d| d.value > 0.0)
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
        // A day with only stage rates still writes. Both readers
        // (`routes::tables`, `rows_check`) are `SELECT *` over nullable
        // columns, so a half-filled row costs nothing; as [`sync_hrv_daily`].
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

/// `hrv_daily`, drawn from one Google type through two pointers.
///
/// Both columns match Fitbit's on every shared day. ⚠ Compare and write both:
/// a comparison of `daily_rmssd` alone once cleared this stream, and writing
/// one column would have frozen `deep_rmssd` at Fitbit's last value.
///
/// The deep figure is in the same type; the per-stage sibling type answers 400
/// "not supported" (see [`super::probe`]).
///
/// A day with only one of the two still writes: both columns are nullable and
/// both readers take `Option<f64>`.
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
            // An RMSSD of 0 ms is no reading, and the source sends some. The
            // day is still written, so the upsert clears a stored zero.
            let v = (d.value > 0.0).then_some(d.value);
            if is_deep {
                e.deep = v;
            } else {
                e.daily = v;
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

/// `skin_temperature`, computed from two Google fields.
///
/// Fitbit's `nightlyRelative` is a deviation from a personal baseline; Google
/// publishes the nightly temperature and the baseline as separate absolutes,
/// so the value is their difference. It matches Fitbit's on every shared day
/// to within 0.05 °C, half the 0.1 °C step Fitbit's values come quantised to.
///
/// ⚠ `relativeNightlyStddev30dCelsius` is a different statistic, despite the
/// name: it differs on nearly every day.
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
        // ⚠ Both halves or nothing. A missing baseline defaulted to zero
        // would store a ~33 °C absolute among ±2 °C deviations, and the
        // readers would plot it. Skipped nights are counted and reported.
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

/// `spo2_daily`, all three columns, from one Google type.
///
/// The average matches Fitbit's on all but twelve shared days, and those
/// twelve are consecutive: an episode with a cause, not a different
/// statistic, which would disagree everywhere. `google-compare` prints which
/// days differ so the two can be told apart.
///
/// `lowerBound`/`upperBound` are real extremes, not a confidence interval:
/// `average - stddev` almost never equals `min_value`.
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
        // Any column present writes the row; all three are nullable.
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

/// The date Google takes over `daily_activity`.
///
/// ⚠ This keeps two writers off one table. Google serves steps, distance and
/// calories; only Fitbit had `minutes_sedentary` and `active_score`. One owner
/// per stream cannot express that, so a date splits it: Fitbit writes every
/// column before it, Google from it, and the Fitbit-only columns keep their
/// history.
pub const DAILY_ACTIVITY_CUTOVER: &str = "2026-09-01";

/// Which days the Google writer owns as of `today`, or `None` before the cutover.
///
/// A function so a test can drive the boundary; before the cutover the writing
/// branch never runs.
///
/// Half-open `[start, end)`, as `fetch_daily_rollup` takes it, so `end` is
/// tomorrow: the day before the cutover gives `end == start`, an empty window,
/// refused.
pub fn cutover_window(
    today: chrono::NaiveDate,
) -> Result<Option<(chrono::NaiveDate, chrono::NaiveDate)>> {
    let start = chrono::NaiveDate::parse_from_str(DAILY_ACTIVITY_CUTOVER, "%Y-%m-%d")
        .context("parsing the daily_activity cutover")?;
    let end = today + chrono::Duration::days(1);
    Ok((start < end).then_some((start, end)))
}

/// The `daily_activity` columns the Google writer owns from the cutover.
///
/// ⚠ Half of a contract with [`ENDED_COLUMNS`]: a test holds the two disjoint
/// and exhaustive over the table's data columns. A column in neither goes NULL
/// from the cutover; one in both is written by two jobs.
pub const GOOGLE_OWNED_COLUMNS: &[&str] = &[
    "steps",
    "distance_km",
    "calories_total",
    "calories_active",
    "resting_heart_rate",
    // From `active-minutes`: moderate + vigorous equals Fitbit's fairly + very
    // on every day measured; light agrees on 91 %.
    "minutes_lightly_active",
    "minutes_fairly_active",
    "minutes_very_active",
];

/// The `daily_activity` columns that ended with the Fitbit Web API.
///
/// Google has no source for them and deriving them would be invention (the
/// best derivation of sedentary minutes was 26–38 min/day off), so no writer
/// assigns them and their history stands as Fitbit left it.
pub const ENDED_COLUMNS: &[&str] = &["floors", "elevation_m", "minutes_sedentary", "active_score"];

/// Is this day the Google writer's to write?
///
/// A string compare, sound because both parse boundaries in `google::health`
/// build zero-padded `YYYY-MM-DD`, where byte and calendar order agree. ⚠ An
/// unpadded month sorts wrong (`-8-` after `-09-`), so the test pins the
/// producer's padding too.
///
/// Used for the `list` walk only; the rollup types are windowed by the API
/// through [`cutover_window`].
pub fn owned_by_google(date: &str) -> bool {
    date >= DAILY_ACTIVITY_CUTOVER
}

/// One day's activity, from four Google types.
#[derive(Default, Clone, Copy)]
struct Activity {
    steps: Option<f64>,
    distance_km: Option<f64>,
    calories_total: Option<f64>,
    calories_active: Option<f64>,
    resting_hr: Option<f64>,
    light: Option<f64>,
    moderate: Option<f64>,
    vigorous: Option<f64>,
}

/// `heart_rate_intraday` from Google's `heart-rate` list type.
///
/// One point per sample, so a daily rollup would lose the resolution this table
/// exists for, and the list is newest-first at ~34,000 points a day, too many
/// to walk whole. The fetch starts at the stored high-water mark less an hour,
/// so a partly delivered boundary is re-read; the upsert makes the overlap
/// free. An empty table starts 7 days back: the history stays Fitbit's.
///
/// `ts` is the wall clock and is the key. Google serves it directly
/// (`civilTime`), beside the instant and the offset, so no zone lookup is
/// needed.
///
/// ⚠ `tz` stays NULL: Google gives an offset, and `+01:00` names no IANA zone.
/// The upsert keeps whatever the backfill CLI wrote.
pub async fn sync_heart_rate_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    // The high-water mark, cast to CHAR to avoid sqlx's DECIMAL/DATETIME decode
    // traps.
    //
    // ⚠ No `ts_utc IS NOT NULL`: `MAX` skips NULLs anyway, and the predicate
    // defeats MariaDB's MIN/MAX optimisation, turning one seek into a 14 s
    // range scan of the whole index.
    let high: Option<String> = sqlx::query_scalar(
        "SELECT CAST(MAX(ts_utc) AS CHAR) FROM heart_rate_intraday WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .context("reading the heart_rate_intraday high-water mark")?;

    let since = match &high {
        Some(ts) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable high-water mark {ts:?}"))?;
            (parsed - chrono::Duration::hours(1))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        }
        None => (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    };
    let filter = format!("heart_rate.sample_time.physical_time >= \"{since}\"");
    let points =
        crate::google::health::fetch_points_filtered(http, access_token, "heart-rate", &filter)
            .await
            .context("fetching heart-rate")?;

    let mut written = 0usize;
    let mut skipped = 0usize;
    for pt in &points {
        let Some(hr) = pt.get("heartRate") else {
            skipped += 1;
            continue;
        };
        // ⚠ `beatsPerMinute` is a string on this type, and `as_f64` returns
        // None on one; `numeric` reads either form.
        let Some(bpm) = hr
            .get("beatsPerMinute")
            .and_then(crate::google::health::numeric)
        else {
            skipped += 1;
            continue;
        };
        let Some(ts) = crate::google::health::civil_datetime(hr.pointer("/sampleTime/civilTime"))
        else {
            skipped += 1;
            continue;
        };
        let ts_utc = hr
            .pointer("/sampleTime/physicalTime")
            .and_then(|v| v.as_str())
            .and_then(crate::google::health::rfc3339_to_utc_datetime);

        sqlx::query(
            "INSERT INTO heart_rate_intraday (user_id, ts, bpm, ts_utc) VALUES (?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE bpm=VALUES(bpm), ts_utc=COALESCE(ts_utc, VALUES(ts_utc))",
        )
        .bind(user_id)
        .bind(&ts)
        .bind(bpm.round() as i64)
        .bind(&ts_utc)
        .execute(pool)
        .await
        .with_context(|| format!("writing heart_rate_intraday at {ts}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google heart_rate_intraday: {written} sample(s) from {} point(s), {skipped} unreadable",
        points.len()
    );
    Ok(written)
}

/// `daily_activity`, from the cutover forward only.
///
/// Google's step counts are lower than Fitbit's on most days that differ, so
/// rewriting years of history the user has read would change it. Fitbit's
/// history stays; this writes only from [`DAILY_ACTIVITY_CUTOVER`].
///
/// `minutes_sedentary` and `active_score` have no Google source and are not
/// written here ([`ENDED_COLUMNS`]).
pub async fn sync_daily_activity(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let Some((start, end)) = cutover_window(chrono::Utc::now().date_naive())? else {
        tracing::info!(
            "[{user_id}] google daily_activity: before the {DAILY_ACTIVITY_CUTOVER} cutover, nothing to write"
        );
        return Ok(0);
    };

    let mut by_day: BTreeMap<String, Activity> = BTreeMap::new();

    // `scale` converts units, e.g. `millimetersSum` into a kilometre column.
    for (ty, pointer, scale, which) in [
        ("steps", "/steps/countSum", 1.0, 0u8),
        ("distance", "/distance/millimetersSum", 1e-6, 1),
        ("total-calories", "/totalCalories/kcalSum", 1.0, 2),
        (
            "active-energy-burned",
            "/activeEnergyBurned/kcalSum",
            1.0,
            3,
        ),
    ] {
        for d in super::health::fetch_daily_rollup(http, access_token, ty, start, end, pointer)
            .await
            .with_context(|| format!("rolling up {ty}"))?
        {
            let e = by_day.entry(d.date).or_default();
            let v = d.value * scale;
            match which {
                0 => e.steps = Some(v),
                1 => e.distance_km = Some(v),
                2 => e.calories_total = Some(v),
                _ => e.calories_active = Some(v),
            }
        }
    }

    for pt in
        super::health::fetch_daily_rollup_points(http, access_token, "active-minutes", start, end)
            .await
            .context("rolling up active-minutes")?
    {
        if let Some(d) = super::health::active_minutes_of_rollup_point(&pt) {
            let e = by_day.entry(d.date).or_default();
            (e.light, e.moderate, e.vigorous) = (Some(d.light), Some(d.moderate), Some(d.vigorous));
        }
    }

    for d in fetch_daily_series(
        http,
        access_token,
        "daily-resting-heart-rate",
        "/dailyRestingHeartRate/beatsPerMinute",
    )
    .await
    .context("fetching daily-resting-heart-rate")?
    {
        // The list walk has no date window, so it is filtered to the cutover
        // here.
        if owned_by_google(&d.date) {
            by_day.entry(d.date).or_default().resting_hr = Some(d.value);
        }
    }

    let mut written = 0usize;
    for (date, a) in &by_day {
        // ⚠ `COALESCE(VALUES(col), col)`, not `VALUES(col)`: Google has
        // calories_active for 9% of days, and a plain assignment would write
        // NULL over Fitbit's value on the rest.
        sqlx::query(
            "INSERT INTO daily_activity \
             (user_id, date, steps, distance_km, calories_total, calories_active, \
             resting_heart_rate, minutes_lightly_active, minutes_fairly_active, \
             minutes_very_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE steps=COALESCE(VALUES(steps), steps), \
             distance_km=COALESCE(VALUES(distance_km), distance_km), \
             calories_total=COALESCE(VALUES(calories_total), calories_total), \
             calories_active=COALESCE(VALUES(calories_active), calories_active), \
             resting_heart_rate=COALESCE(VALUES(resting_heart_rate), resting_heart_rate), \
             minutes_lightly_active=COALESCE(VALUES(minutes_lightly_active), minutes_lightly_active), \
             minutes_fairly_active=COALESCE(VALUES(minutes_fairly_active), minutes_fairly_active), \
             minutes_very_active=COALESCE(VALUES(minutes_very_active), minutes_very_active)",
        )
        .bind(user_id)
        .bind(date)
        .bind(a.steps)
        .bind(a.distance_km)
        .bind(a.calories_total)
        .bind(a.calories_active)
        .bind(a.resting_hr)
        .bind(a.light.map(|v| v.round() as i64))
        .bind(a.moderate.map(|v| v.round() as i64))
        .bind(a.vigorous.map(|v| v.round() as i64))
        .execute(pool)
        .await
        .with_context(|| format!("writing daily_activity for {date}"))?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google daily_activity: {written} day(s) from {DAILY_ACTIVITY_CUTOVER}, \
         {} with steps, {} with active calories",
        by_day.values().filter(|a| a.steps.is_some()).count(),
        by_day
            .values()
            .filter(|a| a.calories_active.is_some())
            .count()
    );
    Ok(written)
}

/// How much shorter a re-fetched sleep session may be before the writer refuses
/// it rather than overwriting the night in place.
///
/// The narrowest stub measured was 8.6x shorter than its night; 4x sits below
/// that, since the bound guards a class of stub, not the cases seen.
pub const SLEEP_SHRINK_REFUSAL_RATIO: i64 = 4;

/// Whether a re-fetched session is a STUB that must not overwrite the night it
/// shares a start instant with.
///
/// Pure so the rule can be pinned against the measured pairs without a
/// database; the writer holds the same decision behind `--allow-shrink`.
pub fn refuses_as_sleep_stub(new_ms: i64, existing_ms: i64) -> bool {
    new_ms.saturating_mul(SLEEP_SHRINK_REFUSAL_RATIO) < existing_ms
}

/// `sleep` + `sleep_stages` from Google's `sleep` session type.
///
/// ⚠ The fetch is filtered with a real page size: a `pageSize=1` request
/// returns 200 with no dataPoints for session types. The window starts at
/// `MAX(end_time_utc)` less a day, so a session revised at the boundary is
/// re-read; an empty table starts 7 days back (history stays Fitbit's).
///
/// That window is one day wide, so a wrong historical row is out of its reach.
/// `backfill_days` re-fetches a wider window through this writer, which fixes
/// the row and proves the writer against it; editing the row by hand would
/// do only the first.
///
/// The dataPoint `name` ends in an id parsed as `log_id`. Nothing depends on
/// it matching Fitbit's: the `(user_id, start_time, is_main_sleep)` key routes
/// a night from both sources into one row, the upsert keeps the stored
/// `log_id`, and the stages join on that.
///
/// `tz` stays NULL, as in the heart-rate writer.
pub async fn sync_sleep(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
    backfill_days: Option<i64>,
    // Write a session that is drastically shorter than the one it replaces.
    // Only a human at the CLI passes this; the nightly path never does.
    allow_shrink: bool,
) -> Result<usize> {
    if let Some(days) = backfill_days {
        anyhow::ensure!(
            days > 0,
            "a backfill window must be at least a day, got {days}"
        );
    }
    // A backfill states its own window and never reads the high-water mark,
    // which is what it exists to reach past.
    let high: Option<String> = match backfill_days {
        Some(_) => None,
        // No `IS NOT NULL`: the same MIN/MAX optimisation as the heart-rate
        // writer.
        None => sqlx::query_scalar(
            "SELECT CAST(MAX(end_time_utc) AS CHAR) FROM sleep WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .context("reading the sleep high-water mark")?,
    };

    let since = match (backfill_days, &high) {
        (Some(days), _) => (chrono::Utc::now() - chrono::Duration::days(days))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
        (None, Some(ts)) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable sleep high-water mark {ts:?}"))?;
            (parsed - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        }
        (None, None) => (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    };
    let filter = format!("sleep.interval.end_time >= \"{since}\"");
    let points = crate::google::health::fetch_points_filtered(http, access_token, "sleep", &filter)
        .await
        .context("fetching sleep sessions")?;

    let mut written = 0usize;
    let mut refused = 0usize;
    let mut skipped = 0usize;
    for pt in &points {
        let Some(s) = crate::google::health::parse_sleep_point(pt) else {
            skipped += 1;
            continue;
        };
        // ⚠ A revised night does not shrink by an order of magnitude. Google
        // writes a session while it is in progress and sometimes never revises
        // it, leaving a fragment at the same start instant as the full night,
        // 8.6x to 23x shorter. That instant is `uniq_sleep_user_start`, so the
        // stub would overwrite the night. The routine sync cannot reach back
        // that far; a backfill can. Ratios rather than lengths: sleep durations
        // are biometric and this repo is public.
        if !allow_shrink {
            let prev: Option<i64> = sqlx::query_scalar(
                "SELECT duration_ms FROM sleep WHERE user_id = ? AND start_time = ?",
            )
            .bind(user_id)
            .bind(&s.start_time)
            .fetch_optional(pool)
            .await
            .context("reading the session being overwritten")?
            .flatten();
            if let Some(prev) = prev
                && refuses_as_sleep_stub(s.duration_ms, prev)
            {
                tracing::warn!(
                    "[{user_id}] google sleep: REFUSED {} — {} ms would replace {} ms \
                         ({}x shorter); pass --allow-shrink to write it anyway",
                    s.start_time,
                    s.duration_ms,
                    prev,
                    prev / s.duration_ms.max(1)
                );
                refused += 1;
                continue;
            }
        }

        sqlx::query(
            // The Fitbit writer's column policy: figures overwrite (Google
            // revises a recent night), tz and `start_time_utc` COALESCE-preserve.
            //
            // ⚠ `date`, `is_main_sleep` and `end_time_utc` overwrite too. An
            // in-progress session has its end inside the start day and no
            // `metadata/mainSleep`; the scored revision moves both. Keeping
            // the first values hid the night from the dashboard, which selects
            // on `date` and `is_main_sleep`, and left `end_time_utc` up to
            // hours before `end_time`. `parse_sleep_point` takes both ends from
            // `interval.endTime` under one `?`, so there is no null to preserve.
            "INSERT INTO sleep (user_id, log_id, date, start_time, end_time, duration_ms, \
             efficiency, minutes_asleep, minutes_awake, minutes_deep, minutes_light, \
             minutes_rem, minutes_wake, is_main_sleep, tz, start_time_utc, end_time_utc) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) \
             ON DUPLICATE KEY UPDATE date=VALUES(date), end_time=VALUES(end_time), \
             is_main_sleep=VALUES(is_main_sleep), \
             duration_ms=VALUES(duration_ms), efficiency=VALUES(efficiency), \
             minutes_asleep=VALUES(minutes_asleep), minutes_awake=VALUES(minutes_awake), \
             minutes_deep=VALUES(minutes_deep), minutes_light=VALUES(minutes_light), \
             minutes_rem=VALUES(minutes_rem), minutes_wake=VALUES(minutes_wake), \
             start_time_utc=COALESCE(start_time_utc, VALUES(start_time_utc)), \
             end_time_utc=VALUES(end_time_utc)",
        )
        .bind(user_id)
        .bind(s.log_id)
        .bind(&s.date)
        .bind(&s.start_time)
        .bind(&s.end_time)
        .bind(s.duration_ms)
        .bind(s.efficiency)
        .bind(s.minutes_asleep)
        .bind(s.minutes_awake)
        .bind(s.minutes_deep)
        .bind(s.minutes_light)
        .bind(s.minutes_rem)
        .bind(s.minutes_wake)
        .bind(s.is_main_sleep)
        .bind(&s.start_time_utc)
        .bind(&s.end_time_utc)
        .execute(pool)
        .await
        .with_context(|| format!("writing sleep for {}", s.date))?;

        if s.stages.is_empty() {
            written += 1;
            continue;
        }

        // The stages join on whatever `sleep.log_id` CURRENTLY holds — the
        // upsert above may have merged into a Fitbit-written row keeping its
        // id. Same transaction discipline as the Fitbit writer: the DELETE and
        // the INSERTs commit together or not at all.
        let mut tx = pool.begin().await.context("opening sleep stages tx")?;
        let canonical: Option<i64> = sqlx::query_scalar(
            // Keyed on the start instant alone: `is_main_sleep` is revisable
            // now, so including it would miss the row it is meant to find the
            // moment Google scores the night.
            "SELECT log_id FROM sleep WHERE user_id = ? AND start_time = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(&s.start_time)
        .fetch_optional(&mut *tx)
        .await
        .context("reading canonical sleep log_id")?;
        let sleep_log_id = canonical.unwrap_or(s.log_id);

        sqlx::query("DELETE FROM sleep_stages WHERE user_id = ? AND sleep_log_id = ?")
            .bind(user_id)
            .bind(sleep_log_id)
            .execute(&mut *tx)
            .await
            .context("clearing sleep_stages")?;
        for st in &s.stages {
            sqlx::query(
                "INSERT INTO sleep_stages (user_id, sleep_log_id, ts, stage, duration_seconds, \
                 tz, ts_utc) VALUES (?, ?, ?, ?, ?, NULL, ?)",
            )
            .bind(user_id)
            .bind(sleep_log_id)
            .bind(&st.ts)
            .bind(&st.stage)
            .bind(st.duration_seconds)
            .bind(&st.ts_utc)
            .execute(&mut *tx)
            .await
            .context("writing sleep_stages")?;
        }
        tx.commit().await.context("committing sleep stages")?;
        written += 1;
    }

    tracing::info!(
        "[{user_id}] google sleep: {written} session(s) from {} point(s), {skipped} unreadable, {refused} refused as stubs",
        points.len()
    );
    Ok(written)
}

/// `hrv_intraday.rmssd` from Google's `heart-rate-variability` sample type.
///
/// `coverage`/`hf`/`lf` have no Google source and were never read; the upsert
/// leaves them alone and new rows have them NULL.
///
/// The table keys on the wall clock, so the sample's `civilTime` is the key.
/// The filter bounds by physical time, the only documented sample filter, with
/// a day of slack past the high-water mark so no offset gap hides a sample.
pub async fn sync_hrv_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let high: Option<String> =
        sqlx::query_scalar("SELECT CAST(MAX(ts) AS CHAR) FROM hrv_intraday WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .context("reading the hrv_intraday high-water mark")?;
    let since = match &high {
        Some(ts) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable hrv high-water mark {ts:?}"))?;
            (parsed - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        }
        None => (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    };
    let filter = format!("heart_rate_variability.sample_time.physical_time >= \"{since}\"");
    let points = crate::google::health::fetch_points_filtered(
        http,
        access_token,
        "heart-rate-variability",
        &filter,
    )
    .await
    .context("fetching heart-rate-variability")?;

    let mut written = 0usize;
    let mut skipped = 0usize;
    for pt in &points {
        let Some(hrv) = pt.get("heartRateVariability") else {
            skipped += 1;
            continue;
        };
        let Some(rmssd) = hrv
            .get("rootMeanSquareOfSuccessiveDifferencesMilliseconds")
            .and_then(crate::google::health::numeric)
        else {
            skipped += 1;
            continue;
        };
        let Some(ts) = crate::google::health::civil_datetime(hrv.pointer("/sampleTime/civilTime"))
        else {
            skipped += 1;
            continue;
        };
        sqlx::query(
            "INSERT INTO hrv_intraday (user_id, ts, rmssd) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE rmssd=VALUES(rmssd)",
        )
        .bind(user_id)
        .bind(&ts)
        .bind(rmssd)
        .execute(pool)
        .await
        .with_context(|| format!("writing hrv_intraday at {ts}"))?;
        written += 1;
    }
    tracing::info!(
        "[{user_id}] google hrv_intraday: {written} sample(s) from {} point(s), {skipped} unreadable",
        points.len()
    );
    Ok(written)
}

/// Fitbit's display name for a Google `heartRateZoneType`, or `None` for an
/// unknown value, which the caller counts rather than writes.
///
/// ⚠ Google renamed the zones (LIGHT/MODERATE/VIGOROUS/PEAK, not Fitbit's
/// OUT_OF_RANGE/FAT_BURN/CARDIO). The mapping is by intensity order and checked
/// by bounds: `google-compare-zones` requires each zone's min/max bpm to equal
/// the stored Fitbit row's.
pub fn zone_display_name(zone_type: &str) -> Option<&'static str> {
    Some(match zone_type {
        "LIGHT" => "Out of Range",
        "MODERATE" => "Fat Burn",
        "VIGOROUS" => "Cardio",
        "PEAK" => "Peak",
        _ => return None,
    })
}

/// `heart_rate_zones` from two Google types: `daily-heart-rate-zones` gives
/// each day's zone bounds (min/max bpm, as quoted numbers), and
/// `time-in-heart-rate-zone` gives intervals whose per-day sums are the
/// minutes, keyed on the interval's civil start date as the bounds are.
///
/// `calories` has no Google source; the upsert leaves it alone.
pub async fn sync_heart_rate_zones(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let high: Option<String> = sqlx::query_scalar(
        "SELECT CAST(MAX(date) AS CHAR) FROM heart_rate_zones WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .context("reading the heart_rate_zones high-water mark")?;
    // Two days of slack: Fitbit revises a recent day, and the daily type dates
    // in civil time while the interval filter runs on physical time.
    let since_date = match &high {
        Some(d) => {
            let parsed = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .with_context(|| format!("unreadable zones high-water mark {d:?}"))?;
            parsed - chrono::Duration::days(2)
        }
        None => (chrono::Utc::now() - chrono::Duration::days(7)).date_naive(),
    };

    let bounds_filter = format!("daily_heart_rate_zones.date >= \"{since_date}\"");
    let bounds = crate::google::health::fetch_points_filtered(
        http,
        access_token,
        "daily-heart-rate-zones",
        &bounds_filter,
    )
    .await
    .context("fetching daily-heart-rate-zones")?;

    let minutes_filter = format!(
        "time_in_heart_rate_zone.interval.start_time >= \"{}T00:00:00Z\"",
        since_date - chrono::Duration::days(1)
    );
    let intervals = crate::google::health::fetch_points_filtered(
        http,
        access_token,
        "time-in-heart-rate-zone",
        &minutes_filter,
    )
    .await
    .context("fetching time-in-heart-rate-zone")?;

    // (date, zone display name) -> summed seconds, keyed on the CIVIL start.
    let mut secs: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut unknown_zone = 0usize;
    for pt in &intervals {
        let Some(t) = pt.get("timeInHeartRateZone") else {
            continue;
        };
        let (Some(zt), Some(sp), Some(so), Some(ep)) = (
            t.get("heartRateZoneType").and_then(|v| v.as_str()),
            t.pointer("/interval/startTime").and_then(|v| v.as_str()),
            t.pointer("/interval/startUtcOffset")
                .and_then(|v| v.as_str()),
            t.pointer("/interval/endTime").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let Some(zone) = zone_display_name(zt) else {
            unknown_zone += 1;
            continue;
        };
        let (Some(civil_start), Ok(s), Ok(e)) = (
            crate::google::health::wall_clock_from_physical(sp, so),
            chrono::DateTime::parse_from_rfc3339(sp),
            chrono::DateTime::parse_from_rfc3339(ep),
        ) else {
            continue;
        };
        *secs
            .entry((civil_start[..10].to_string(), zone.to_string()))
            .or_default() += (e - s).num_seconds();
    }

    let mut written = 0usize;
    let mut skipped = 0usize;
    for pt in &bounds {
        let Some(d) = pt.get("dailyHeartRateZones") else {
            skipped += 1;
            continue;
        };
        let Some(date) = d.get("date").and_then(|v| {
            Some(format!(
                "{:04}-{:02}-{:02}",
                v.get("year")?.as_i64()?,
                v.get("month")?.as_i64()?,
                v.get("day")?.as_i64()?
            ))
        }) else {
            skipped += 1;
            continue;
        };
        for z in d
            .get("heartRateZones")
            .and_then(|v| v.as_array())
            .map(|v| v.as_slice())
            .unwrap_or_default()
        {
            let (Some(zt), Some(min), Some(max)) = (
                z.get("heartRateZoneType").and_then(|v| v.as_str()),
                z.get("minBeatsPerMinute")
                    .and_then(crate::google::health::numeric),
                z.get("maxBeatsPerMinute")
                    .and_then(crate::google::health::numeric),
            ) else {
                skipped += 1;
                continue;
            };
            let Some(zone) = zone_display_name(zt) else {
                unknown_zone += 1;
                continue;
            };
            let minutes = secs
                .get(&(date.clone(), zone.to_string()))
                .map(|s| (*s + 30) / 60)
                .unwrap_or(0);
            sqlx::query(
                "INSERT INTO heart_rate_zones (user_id, date, zone_name, minutes, min_bpm, max_bpm) \
                 VALUES (?, ?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE minutes=VALUES(minutes), min_bpm=VALUES(min_bpm), \
                 max_bpm=VALUES(max_bpm)",
            )
            .bind(user_id)
            .bind(&date)
            .bind(zone)
            .bind(minutes)
            .bind(min.round() as i64)
            .bind(max.round() as i64)
            .execute(pool)
            .await
            .with_context(|| format!("writing heart_rate_zones for {date}/{zone}"))?;
            written += 1;
        }
    }
    tracing::info!(
        "[{user_id}] google heart_rate_zones: {written} row(s), {skipped} unreadable, \
         {unknown_zone} unknown zone type(s)",
    );
    Ok(written)
}

/// Google's step intervals as one count per UTC minute, WATCH-FIRST, each
/// carrying the wall clock it is filed under — and how many were unreadable.
/// The key is the INSTANT, so one minute served under two offsets is one entry.
pub fn merge_step_points(points: &[serde_json::Value]) -> (BTreeMap<String, (String, i64)>, usize) {
    // Keyed by the UTC minute; the value carries the wall clock it is filed under.
    let mut watch: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut phone: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut skipped = 0usize;
    for pt in points {
        let platform = pt
            .pointer("/dataSource/platform")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        if platform != "FITBIT" {
            continue;
        }
        let is_phone = pt
            .pointer("/dataSource/device/displayName")
            .and_then(|v| v.as_str())
            .is_none_or(|d| d == "MobileTrack");
        let Some(st) = pt.get("steps") else {
            skipped += 1;
            continue;
        };
        let (Some(count), Some(sp), Some(so)) = (
            st.get("count").and_then(crate::google::health::numeric),
            st.pointer("/interval/startTime").and_then(|v| v.as_str()),
            st.pointer("/interval/startUtcOffset")
                .and_then(|v| v.as_str()),
        ) else {
            skipped += 1;
            continue;
        };
        let (Some(cs), Some(us)) = (
            crate::google::health::wall_clock_from_physical(sp, so),
            crate::google::health::rfc3339_to_utc_datetime(sp),
        ) else {
            skipped += 1;
            continue;
        };
        let minute = format!("{}:00", &cs[..16]);
        let instant = format!("{}:00", &us[..16]);
        let c = count.round() as i64;
        let m = if is_phone { &mut phone } else { &mut watch };
        // Two same-source intervals in one minute keep the larger — a re-served
        // correction, not an addition.
        m.entry(instant)
            .and_modify(|v| {
                if c > v.1 {
                    *v = (minute.clone(), c);
                }
            })
            .or_insert((minute, c));
    }
    let mut merged = watch;
    for (m, c) in phone {
        merged.entry(m).or_insert(c);
    }
    (merged, skipped)
}

/// `steps_intraday` from Google's `steps` interval type, watch first per
/// minute.
///
/// Fitbit's stored series arbitrates across devices by an undocumented rule.
/// Watch-first with a phone fallback matches it on 1282 of 1297 minutes
/// (per-minute max matched 901 and overcounts); the misses are device
/// transitions, and the fallback gains phone-only minutes.
///
/// ⚠ HEALTH_CONNECT sources are excluded: they re-import the same steps and
/// would double-count. A device named "MobileTrack", or none, is the phone;
/// any other is the watch.
///
/// Zero-count minutes are not written: the series marks stillness by absence.
///
/// ⚠ The instant is stored too. `ts` is the wall clock and the key, so a minute
/// served under two offsets (crossing a zone) would land twice and read as a
/// copy an hour late. Minutes merge by instant, each is written with `ts_utc`,
/// and a row holding that instant under another wall clock is removed.
pub async fn sync_steps_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let high: Option<String> =
        sqlx::query_scalar("SELECT CAST(MAX(ts) AS CHAR) FROM steps_intraday WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .context("reading the steps_intraday high-water mark")?;
    let since = match &high {
        Some(ts) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable steps high-water mark {ts:?}"))?;
            (parsed - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        }
        None => (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    };
    let filter = format!("steps.interval.start_time >= \"{since}\"");
    let points = crate::google::health::fetch_points_filtered(http, access_token, "steps", &filter)
        .await
        .context("fetching step intervals")?;

    let (merged, skipped) = merge_step_points(&points);

    // One transaction: the DELETE of a relabelled copy and the INSERT that
    // replaces it land together or not at all.
    let mut tx = pool
        .begin()
        .await
        .context("opening the steps transaction")?;
    let mut written = 0usize;
    for (ts_utc, (ts, steps)) in &merged {
        if *steps <= 0 {
            continue;
        }
        sqlx::query("DELETE FROM steps_intraday WHERE user_id = ? AND ts_utc = ? AND ts <> ?")
            .bind(user_id)
            .bind(ts_utc)
            .bind(ts)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("removing a relabelled copy of {ts_utc}"))?;
        sqlx::query(
            "INSERT INTO steps_intraday (user_id, ts, steps, ts_utc) VALUES (?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE steps=VALUES(steps), ts_utc=VALUES(ts_utc)",
        )
        .bind(user_id)
        .bind(ts)
        .bind(steps)
        .bind(ts_utc)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing steps_intraday at {ts}"))?;
        written += 1;
    }
    tx.commit()
        .await
        .context("committing the steps transaction")?;
    tracing::info!(
        "[{user_id}] google steps_intraday: {written} minute(s) from {} point(s), {skipped} unreadable",
        points.len()
    );
    Ok(written)
}

/// Rows per archive INSERT: 1,000 × 4 binds stays far under MariaDB's 65,535
/// placeholders and the packet limit.
const ARCHIVE_BATCH_ROWS: usize = 1000;

/// The archive's minutes: those whose wall clock date is in `[from, until)`,
/// non-zero, as `(ts_utc, ts, steps)` in instant order.
///
/// By wall clock because the stored series is keyed that way: Fitbit's history
/// begins at local midnight, so an archive `until` that date meets it exactly.
#[must_use]
pub fn archive_minutes(
    merged: &BTreeMap<String, (String, i64)>,
    from: chrono::NaiveDate,
    until: chrono::NaiveDate,
) -> Vec<(String, String, i64)> {
    let (from, until) = (from.to_string(), until.to_string());
    merged
        .iter()
        .filter(|(_, (ts, steps))| {
            let day = ts.get(..10).unwrap_or("");
            *steps > 0 && day >= from.as_str() && day < until.as_str()
        })
        .map(|(ts_utc, (ts, steps))| (ts_utc.clone(), ts.clone(), *steps))
        .collect()
}

/// Blood-oxygen samples from Google's `oxygen-saturation` points, keyed by the
/// UTC instant with the served wall clock beside it, and how many were
/// unreadable.
///
/// By INSTANT, as steps are: a reading served under two offsets is one reading,
/// and the first served keeps its wall clock.
#[must_use]
pub fn spo2_samples(points: &[serde_json::Value]) -> (BTreeMap<String, (String, f64)>, usize) {
    let mut out: BTreeMap<String, (String, f64)> = BTreeMap::new();
    let mut skipped = 0usize;
    for pt in points {
        let o = pt.get("oxygenSaturation");
        let pct = o
            .and_then(|o| o.get("percentage"))
            .and_then(crate::google::health::numeric);
        let ts = o.and_then(|o| {
            crate::google::health::civil_datetime(o.pointer("/sampleTime/civilTime"))
        });
        let ts_utc = o
            .and_then(|o| o.pointer("/sampleTime/physicalTime"))
            .and_then(serde_json::Value::as_str)
            .and_then(crate::google::health::rfc3339_to_utc_datetime);
        match (pct, ts, ts_utc) {
            (Some(pct), Some(ts), Some(ts_utc)) => {
                out.entry(ts_utc).or_insert((ts, pct));
            }
            _ => skipped += 1,
        }
    }
    (out, skipped)
}

/// How long an SpO2 archive fetch spans: a month of nightly readings is a few
/// pages, and a failed window costs one month, not three years.
const SPO2_ARCHIVE_WINDOW_DAYS: i64 = 31;

/// `spo2_intraday` from Google's `oxygen-saturation`: every reading the watch
/// took, at full resolution.
///
/// `archive` is `(from, until)` by UTC date, fetched a window at a time, for
/// the history Fitbit's API never gave us (the table had no writer). Without
/// it, the routine sync: from an hour before the newest stored instant, or a
/// week back on an empty table.
///
/// ⚠ HOLES ONLY (`INSERT IGNORE`), as the steps archive: a stored reading keeps
/// its value, and the routine overlap costs nothing.
pub async fn sync_spo2_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
    archive: Option<(chrono::NaiveDate, chrono::NaiveDate)>,
) -> Result<usize> {
    let windows: Vec<(String, Option<String>)> = match archive {
        Some((from, until)) => {
            anyhow::ensure!(
                from < until,
                "an archive range must not be empty ({from} → {until})"
            );
            let mut out = Vec::new();
            let mut a = from;
            while a < until {
                let b = (a + chrono::Duration::days(SPO2_ARCHIVE_WINDOW_DAYS)).min(until);
                out.push((format!("{a}T00:00:00Z"), Some(format!("{b}T00:00:00Z"))));
                a = b;
            }
            out
        }
        None => {
            let high: Option<String> = sqlx::query_scalar(
                "SELECT CAST(MAX(ts_utc) AS CHAR) FROM spo2_intraday WHERE user_id = ?",
            )
            .bind(user_id)
            .fetch_one(pool)
            .await
            .context("reading the spo2_intraday high-water mark")?;
            let since = match &high {
                Some(ts) => {
                    let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                        .with_context(|| format!("unreadable spo2 high-water mark {ts:?}"))?;
                    parsed - chrono::Duration::hours(1)
                }
                None => (chrono::Utc::now() - chrono::Duration::days(7)).naive_utc(),
            };
            vec![(since.format("%Y-%m-%dT%H:%M:%SZ").to_string(), None)]
        }
    };

    let mut written = 0u64;
    let (mut fetched, mut skipped) = (0usize, 0usize);
    for (since, before) in &windows {
        let field = "oxygen_saturation.sample_time.physical_time";
        let filter = match before {
            Some(b) => format!("{field} >= \"{since}\" AND {field} < \"{b}\""),
            None => format!("{field} >= \"{since}\""),
        };
        let points = crate::google::health::fetch_points_filtered(
            http,
            access_token,
            "oxygen-saturation",
            &filter,
        )
        .await
        .with_context(|| format!("fetching oxygen-saturation from {since}"))?;
        let (samples, bad) = spo2_samples(&points);
        fetched += points.len();
        skipped += bad;
        let rows: Vec<_> = samples.into_iter().collect();
        let mut tx = pool.begin().await.context("opening the spo2 transaction")?;
        for batch in rows.chunks(ARCHIVE_BATCH_ROWS) {
            let mut qb: sqlx::QueryBuilder<sqlx::MySql> = sqlx::QueryBuilder::new(
                "INSERT IGNORE INTO spo2_intraday (user_id, ts, value, ts_utc) ",
            );
            qb.push_values(batch, |mut row, (ts_utc, (ts, pct))| {
                row.push_bind(user_id)
                    .push_bind(ts)
                    .push_bind((pct * 10.0).round() / 10.0)
                    .push_bind(ts_utc);
            });
            written += qb
                .build()
                .execute(&mut *tx)
                .await
                .context("writing a batch of spo2_intraday")?
                .rows_affected();
        }
        tx.commit().await.context("committing spo2_intraday")?;
        if before.is_some() {
            tracing::info!(
                "[{user_id}] google spo2 archive {since}: {} reading(s)",
                rows.len()
            );
        }
    }
    tracing::info!(
        "[{user_id}] google spo2_intraday: {written} new reading(s) from {fetched} point(s), {skipped} unreadable"
    );
    usize::try_from(written).context("reading count")
}

/// One paired device's battery reading, as `users.pairedDevices` serves it.
#[derive(Debug, Clone, PartialEq)]
pub struct BatteryReading {
    /// The last path segment of `name`, the same id Fitbit's devices.json
    /// carried, so the history continues.
    pub device_id: String,
    pub device_version: Option<String>,
    pub battery_level: i64,
    /// The sync instant, UTC, as `YYYY-MM-DD HH:MM:SS`.
    pub last_sync_utc: String,
}

/// The readings in a `pairedDevices` reply. A device without a numeric level or
/// a sync time is skipped: the phone ("MobileTrack") reports a status and no
/// level, and a row keyed on a missing time would collide with itself.
pub fn battery_readings(reply: &serde_json::Value) -> Vec<BatteryReading> {
    reply
        .get("pairedDevices")
        .and_then(|d| d.as_array())
        .map(|v| v.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|d| {
            let device_id = d.get("name")?.as_str()?.rsplit('/').next()?.to_string();
            let battery_level = d
                .get("batteryLevel")
                .and_then(crate::google::health::numeric)?;
            let last_sync_utc = d
                .get("lastSyncTime")
                .and_then(|t| t.as_str())
                .and_then(crate::google::health::rfc3339_to_utc_datetime)?;
            Some(BatteryReading {
                device_id,
                device_version: d
                    .get("deviceVersion")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                battery_level: battery_level.round() as i64,
                last_sync_utc,
            })
        })
        .collect()
}

/// The watch's battery from `users.pairedDevices`, Google's replacement for
/// Fitbit's devices.json (scope `googlehealth.settings.readonly`).
///
/// ⚠ The instant goes in `ts_utc`, which the reader prefers: Google's
/// `last_sync_time` is UTC, where Fitbit's is the watch's wall clock.
/// `last_sync_time` carries the UTC clock too, because it is the key.
///
/// This and Fitbit's device sync both write while Fitbit's API lasts: at worst
/// one reading under two keys.
pub async fn sync_paired_devices(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    let res = http
        .get("https://health.googleapis.com/v4/users/me/pairedDevices")
        .bearer_auth(access_token)
        .send()
        .await
        .context("GET pairedDevices")?;
    let status = res.status();
    let body = res.text().await.context("body of pairedDevices")?;
    if !status.is_success() {
        anyhow::bail!(
            "pairedDevices {}: {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        );
    }
    let reply: serde_json::Value = serde_json::from_str(&body).context("decoding pairedDevices")?;
    let readings = battery_readings(&reply);
    for r in &readings {
        sqlx::query(
            "INSERT INTO device_battery_log (user_id, device_id, last_sync_time, battery_level, \
             device_version, ts_utc) VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE battery_level=VALUES(battery_level), ts_utc=VALUES(ts_utc)",
        )
        .bind(user_id)
        .bind(&r.device_id)
        .bind(&r.last_sync_utc)
        .bind(r.battery_level)
        .bind(&r.device_version)
        .bind(&r.last_sync_utc)
        .execute(pool)
        .await
        .context("writing device_battery_log")?;
    }
    Ok(readings.len())
}
