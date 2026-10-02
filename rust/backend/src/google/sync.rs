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

/// The date Google takes over `daily_activity`.
///
/// ⚠ **THIS IS WHAT KEEPS TWO WRITERS OFF ONE TABLE.** `daily_activity` is the
/// one stream whose COLUMNS need different owners: Google serves steps,
/// distance and calories; Fitbit is the only source there has ever been for
/// `minutes_sedentary` and `active_score`. The roster's one-owner-per-stream
/// rule cannot express that, and flipping the owner would stop Fitbit writing
/// the columns Google cannot serve — while it still works.
///
/// A date resolves it without a second ownership model. Fitbit writes every
/// column up to the shutdown; Google writes from it. Their ranges do not
/// overlap, so neither can clobber the other, and the Fitbit-only columns keep
/// their history instead of being nulled.
pub const DAILY_ACTIVITY_CUTOVER: &str = "2026-09-01";

/// Which days the Google writer owns as of `today`, or `None` before the cutover.
///
/// ⚠ EXTRACTED SO THE BOUNDARY CAN BE DRIVEN. Before the cutover this returns
/// `None` on every run, so the branch that writes never executes — and a test
/// asserting the CONSTANT is not earlier than the shutdown is a fact about a
/// string. A guard only ever observed refusing is a guard nobody has tested
/// (\[\[feedback_verify_conditions_not_only_behaviour\]\]).
///
/// ⚠ HALF-OPEN `[start, end)`, because `fetch_daily_rollup` is: "the inclusive
/// start and the exclusive end". So `end` is TOMORROW, and the off-by-one that
/// matters is at the cutover day itself — on 2026-08-31 `end` is 2026-09-01,
/// which equals `start`, and an empty window is correctly refused. The writer
/// opens on 2026-09-01 and not a day either side.
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
/// ⚠ THIS LIST IS HALF OF A CONTRACT. `fitbit::sync::activity::FITBIT_ONLY_COLUMNS`
/// is the other half, and a test holds them disjoint and exhaustive. If a column
/// leaves this list without joining that one it is written by NOBODY and goes
/// silently NULL from the cutover; if it is in both, both writers keep assigning
/// it and the last job to run wins — which is exactly the overlap the cutover
/// exists to prevent.
pub const GOOGLE_OWNED_COLUMNS: &[&str] = &[
    "steps",
    "distance_km",
    "calories_total",
    "calories_active",
    "resting_heart_rate",
    // From `active-minutes` (2026-10-02, #260): moderate + vigorous equals
    // Fitbit's fairly + very on all 1,253 days measured, the summary card's
    // number; light agrees on 91 %.
    "minutes_lightly_active",
    "minutes_fairly_active",
    "minutes_very_active",
];

/// Is this day the Google writer's to write?
///
/// ⚠ A LEXICOGRAPHIC COMPARE ON DATE STRINGS, and it is sound rather than lucky:
/// both parse boundaries in `google::health` build the date with
/// `format!("{y:04}-{m:02}-{d:02}")`, so every date reaching here is zero-padded
/// `YYYY-MM-DD`, where byte order and calendar order agree. An unpadded
/// `2026-9-1` would sort BEFORE `2026-09-01` and be silently dropped — which is
/// why the test pins the producer's padding and not just this function.
///
/// Used for the `list` walk only. The four rollup types are windowed by the API
/// through [`cutover_window`], so they need no second filter.
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

/// `daily_activity`, from the cutover forward only.
///
/// # Why not the history too
///
/// Measured 2026-08-28: Google's step counts are SYSTEMATICALLY LOWER — 570 of
/// 642 differing days, median 6 fewer, p90 517, p99 3346. Rewriting 1229 days of
/// existing history with them would change four years of a record the user has
/// already read. Decided: keep Fitbit's history, write only from the cutover.
///
/// ```text
///   distance_km      1193/1226 agree
///   calories_total    968/1246 agree
///   steps             587/1229 agree   ⚠ google lower on 570
///   calories_active   111 days of 1246 ⚠ Google barely has it
/// ```
///
/// ⚠ `minutes_sedentary` and `active_score` have NO Google source and are not
/// written here. They stop when Fitbit does; nothing this writer can do changes
/// that, and pretending otherwise by deriving them would be invention.
/// `heart_rate_intraday` from Google's `heart-rate` list type.
///
/// # Why this is a FILTERED `list` walk and not a rollup or a full walk
///
/// `heart-rate` carries one point per SAMPLE, not per day, so `dailyRollUp`
/// would collapse exactly the resolution this table exists for. And the
/// unbounded walk cannot work either — first written that way, it would have
/// hit `MAX_PAGES` years short of the oldest point on every single run,
/// because the list is newest-first at ~34,000 points a day. The fetch is
/// bounded to everything after the stored high-water mark, less an hour of
/// overlap so a partially-delivered boundary is re-read rather than trusted
/// (the `ON DUPLICATE KEY` makes the overlap free).
///
/// ⚠ A TABLE WITH NO `ts_utc` YET starts 7 days back, not at all of history:
/// #260's decision is that Fitbit's history stays and Google writes only from
/// the cutover forward.
///
/// # ⚠ THE WALL CLOCK IS THE KEY, AND GOOGLE GIVES IT DIRECTLY
///
/// `ts` is LOCAL civil time — the Fitbit path had to repair a `Z` the API
/// stamps on non-UTC timestamps (#340) and then derive `ts_utc` from a
/// per-second zone lookup. Google publishes all three parts separately:
/// `civilTime` (the wall clock), `physicalTime` (the instant) and `utcOffset`.
/// So this writer needs no repair and no tz table — it reads what the other
/// path had to reconstruct.
///
/// ⚠ `tz` STAYS NULL HERE. Google gives an OFFSET, not a zone name, and
/// `+01:00` does not identify `Europe/London`. Writing an offset into a column
/// every other reader treats as an IANA name would be worse than leaving it
/// unset, and the `ON DUPLICATE KEY` below preserves whatever the backfill CLI
/// established rather than overwriting it.
pub async fn sync_heart_rate_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<usize> {
    // The high-water mark. CAST AS CHAR for the same reason read_daily_column
    // casts: crossing as a string sidesteps the DECIMAL/DATETIME decode traps
    // that only fire on real rows.
    //
    // ⚠ NO `ts_utc IS NOT NULL` — `MAX` skips NULLs by definition, and the
    // redundant predicate DEFEATS MariaDB's MIN/MAX optimization: measured
    // 2026-09-02 (#1322), with it the plan is a `range` over all 28.4M index
    // entries at 14-16s per sync; without it, `Select tables optimized away`,
    // one seek. Same answer, verified against prod.
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
        // ⚠ `beatsPerMinute` is a STRING on this type. `as_f64` returns None on
        // one, which is how 1258 resting-heart-rate points were once discarded
        // silently — `numeric` reads either form and still refuses a
        // non-numeric string.
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

    // ⚠ `scale` is applied here for the same reason google-compare needs it:
    // `millimetersSum` against a kilometre column is a factor of a million.
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
        // ⚠ The list walk has no date window, so it returns the whole history —
        // filtered to the cutover here rather than by the API.
        if owned_by_google(&d.date) {
            by_day.entry(d.date).or_default().resting_hr = Some(d.value);
        }
    }

    let mut written = 0usize;
    for (date, a) in &by_day {
        // ⚠ `COALESCE(VALUES(col), col)`, NOT `VALUES(col)`. Google has
        // calories_active for 9% of days; a plain assignment would write NULL
        // over a real Fitbit value on the other 91% — a migration that DELETES
        // data while reporting rows written.
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
/// 4x, where the narrowest measured stub was 8.6x shorter than the night it
/// would have replaced (#1536). Set BELOW the evidence rather than at it: the bound
/// guards a class — a session Google recorded in progress and never revised —
/// not the seven dates that happened to show it.
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
/// # ⚠ The fetch MUST be filtered — and not for volume this time
///
/// A sleep list is small, but `probe_one`'s pageSize=1 request returns 200 with
/// NO dataPoints for session types (measured 2026-09-02, the request shape that
/// twice produced "Google does not carry this"). This walk uses the filtered
/// path with a real page size, the shape a consumer sends. The high-water mark
/// is `MAX(end_time_utc)` less a day, so a session Fitbit revised at the
/// boundary is re-read rather than trusted; an empty table starts 7 days back
/// (#260: history stays Fitbit's).
///
/// # ⚠ `backfill_days` exists because that window CANNOT REACH BACK
///
/// `None` is the routine sync and derives the window as above. It is one day
/// wide, so **any historical row that is wrong, for any reason, is permanently
/// out of reach of the pipeline that would correct it** — measured 2026-09-08
/// (#1491): the night of 7-8 Sep repaired itself the moment the writer was
/// fixed, because it sat inside the window; the night of 2-3 Sep did not, and
/// never would, on any schedule.
///
/// `Some(days)` re-fetches a wider window THROUGH THIS WRITER, which is the
/// point. The alternative used on 2026-09-08 was editing the row by hand: that
/// fixes the row and leaves the writer unproven against it.
///
/// # Identity
///
/// The dataPoint `name` ends in an 18-19-digit id, which this writer parses as
/// `log_id` — Fitbit-logId-SIZED, equality UNVERIFIED, and nothing depends on
/// it: the `(user_id, start_time, is_main_sleep)` unique key routes a night
/// written by both sources into ONE row (the upsert preserves the stored
/// log_id, exactly like the Fitbit writer's canonical-id lookup), and the
/// stages join on whatever log_id that row actually holds.
///
/// ⚠ `tz` STAYS NULL, like the heart-rate writer: Google gives an offset, not a
/// zone name.
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
    // A backfill states its own window and never reads the high-water mark —
    // the mark is precisely what it exists to reach past (#1491).
    let high: Option<String> = match backfill_days {
        Some(_) => None,
        // ⚠ NO `IS NOT NULL` — same MIN/MAX-optimization defeat as the
        // heart-rate writer above (#1322); `MAX` skips NULLs anyway.
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
        // ⚠ A REVISED NIGHT DOES NOT LOSE AN ORDER OF MAGNITUDE (#1536). Google
        // writes a session while it is still in progress and sometimes never
        // revises it, leaving a fragment that ends shortly before midnight.
        // Measured over 130 days: seven such fragments stood against full nights
        // at the SAME start instant, each between 8.6x and 23x shorter than the
        // night it would have replaced, every one of their durations ending in
        // `999`. The ratios are quoted rather than the lengths: a sleep duration
        // is a biometric value and this repo is public (#860).
        //
        // That start instant is `uniq_sleep_user_start`, so a stub does not land
        // BESIDE the night, it overwrites it — every figure in the update list
        // at once. The routine nightly sync has not done this only because the
        // high-water mark keeps it from reaching back; a backfill states its own
        // window and does reach.
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
            // The same column policy as the Fitbit writer: figures overwrite
            // (Google revises a recent night exactly as Fitbit did), tz and the
            // UTC columns COALESCE-preserve.
            //
            // ⚠ `date` and `is_main_sleep` overwrite for a reason. Google writes
            // a session while it is still in progress — end_time inside the
            // START day, and no `metadata/mainSleep` yet — then revises it once
            // the night is scored. Leaving either out of this list froze the
            // provisional answer: measured 2026-09-08, the nights of 2 and 7 Sep
            // sat at the start day's `date` with `is_main_sleep = 0` while
            // Google reported the end day and 1, agreeing on every other column.
            // A night the dashboard cannot see, because it selects on both.
            //
            // ⚠ `end_time_utc` OVERWRITES for exactly that reason, and freezing
            // it was the same defect one column over (#340). The revision above
            // moves `end_time` and `duration_ms`; a COALESCE that kept the first
            // `end_time_utc` pinned the in-progress instant beside a corrected
            // wall clock, and the two then disagreed forever. Measured
            // 2026-09-11 on the three most recent nights: the ends were frozen
            // 612, 51 and 33 minutes early while `duration_ms` matched the wall
            // clock exactly. It cannot go null when `end_time` does not —
            // `parse_sleep_point` takes both from `interval.endTime` under one
            // `?`, so there is no null to preserve. `start_time_utc` keeps the
            // COALESCE because `start_time` is not revised either: a start is
            // observed once.
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
/// ⚠ `coverage`/`hf`/`lf` are NOT written and the upsert does not touch them:
/// Google has no source for them, they are stored-and-never-read (#260), and
/// they NULL forward on new rows rather than freezing at a last Fitbit value.
///
/// The table keys on the WALL clock and has no ts_utc column, so the sample's
/// served `civilTime` is the key (same `civil_datetime` as heart-rate). The
/// filter still bounds by PHYSICAL time — the only documented sample filter —
/// with a day of slack past the high-water mark so no offset gap can hide a
/// sample; the upsert makes the overlap free.
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

/// Fitbit's display name for a Google `heartRateZoneType`, or `None` for a
/// vocabulary this mapping has never seen — which the caller COUNTS rather
/// than writes, so a new enum value cannot invent a fifth zone row.
///
/// ⚠ GOOGLE RENAMED THE ZONES, and the first guess here was Fitbit's own enum
/// spellings (OUT_OF_RANGE/FAT_BURN/CARDIO) — measured 2026-09-02, the live
/// vocabulary is LIGHT/MODERATE/VIGOROUS/PEAK. The mapping is by intensity
/// order and VERIFIED BY BOUNDS: each zone's min/max bpm must equal the stored
/// Fitbit row's, and `google-compare-zones` checks exactly that per day.
pub fn zone_display_name(zone_type: &str) -> Option<&'static str> {
    Some(match zone_type {
        "LIGHT" => "Out of Range",
        "MODERATE" => "Fat Burn",
        "VIGOROUS" => "Cardio",
        "PEAK" => "Peak",
        _ => return None,
    })
}

/// `heart_rate_zones` from TWO Google types: `daily-heart-rate-zones` gives
/// each day's zone BOUNDS (min/max bpm, QUOTED numbers), and
/// `time-in-heart-rate-zone` gives the intervals whose per-day sums are the
/// MINUTES. (#260, #1223)
///
/// ⚠ `calories` is NOT written and the upsert does not touch it — no Google
/// source; NULL forward.
///
/// The minutes sum keys on the interval's civil START date, matching how the
/// bounds type dates itself.
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

/// `steps_intraday` from Google's `steps` interval type, WATCH-FIRST per
/// minute. (#260)
///
/// # The merge rule, measured not assumed
///
/// Fitbit's stored series is a per-window arbitration across devices that
/// nothing documents. Candidates against 7 days of stored rows (2026-09-02):
///
/// ```text
///   per-minute MAX over FITBIT/*   REFUTED  901/1297 identical, overcounts
///   watch-first, phone fallback    1282/1297 identical, sums within 0.5%
/// ```
///
/// The 15 misses are minutes inside device-transition windows, where Fitbit
/// sometimes takes the phone even though the watch has a (smaller) sample.
/// Accepted: functionally the same series, and the fallback GAINS the
/// phone-only minutes a watchless window used to lose.
///
/// ⚠ HEALTH_CONNECT sources are EXCLUDED: they are echoes of the same steps
/// re-imported through the phone, sub-minute-aligned, and counting them
/// double-counts. A `dataSource.device.displayName` of "MobileTrack" (or no
/// device at all) is the phone; any other named device is the watch.
///
/// ⚠ Zero-count minutes are not written — the stored series has never held
/// zero rows, and a `(user_id, ts)` row saying 0 would read as measured
/// stillness where the convention is absence.
///
/// # ⚠ THE INSTANT IS STORED, NOT ONLY THE WALL CLOCK
///
/// `ts` is the wall clock and the table's key, so the same minute served under
/// two offsets lands as two rows. It happened crossing into Paris
/// (2026-09-30): the walk was stored at 14:37 London and again at 15:37 once the
/// watch took the new zone, and with `ts_utc` NULL the reader took both as
/// London — a copy of the walk an hour late, stepping through a lie-down. So
/// minutes are merged by INSTANT, each is written with its `ts_utc`, and a row
/// already holding that instant under another wall clock is removed.
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

/// The archive's minutes: those whose WALL CLOCK date is in `[from, until)`,
/// non-zero, as `(ts_utc, ts, steps)` in instant order.
///
/// By wall clock because that is how the stored series is keyed: Fitbit's
/// history begins at 2024-01-13 00:00 local, so an archive `until` that date
/// meets it at exactly that minute whatever the offsets either side. (#1886)
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

/// Archive Google's step minutes over `[from, until)` by wall clock into
/// `steps_intraday`, for the stretch Fitbit's own history never covered
/// (2023-04-15 → 2024-01-12). (#1886)
///
/// ⚠ HOLES ONLY. A minute already stored keeps its value and nothing is deleted:
/// this fills history, it does not re-decide it, so even a range that strays
/// into Fitbit's era cannot rewrite a row (decided against, #260). The fetch is
/// a day wider than the range either side, so a minute near an edge is seen
/// whatever its offset; `archive_minutes` keeps the range.
pub async fn archive_steps_intraday(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
    from: chrono::NaiveDate,
    until: chrono::NaiveDate,
) -> Result<usize> {
    anyhow::ensure!(
        from < until,
        "an archive range must not be empty ({from} → {until})"
    );
    let filter = format!(
        "steps.interval.start_time >= \"{}T00:00:00Z\" AND steps.interval.start_time < \"{}T00:00:00Z\"",
        from - chrono::Duration::days(1),
        until + chrono::Duration::days(1),
    );
    let points = crate::google::health::fetch_points_filtered(http, access_token, "steps", &filter)
        .await
        .context("fetching step intervals")?;
    let (merged, skipped) = merge_step_points(&points);
    let minutes = archive_minutes(&merged, from, until);

    tracing::info!(
        "[{user_id}] google steps archive {from} → {until}: {} point(s) fetched, {} minute(s) in range",
        points.len(),
        minutes.len()
    );

    // ⚠ BATCHED. Over the prod tunnel every statement is a round trip, and nine
    // months is ~10⁵ minutes: one INSERT each outlived its run (2026-10-02).
    let mut tx = pool
        .begin()
        .await
        .context("opening the steps archive transaction")?;
    let mut written = 0u64;
    for batch in minutes.chunks(ARCHIVE_BATCH_ROWS) {
        let mut qb: sqlx::QueryBuilder<sqlx::MySql> = sqlx::QueryBuilder::new(
            "INSERT IGNORE INTO steps_intraday (user_id, ts, steps, ts_utc) ",
        );
        qb.push_values(batch, |mut row, (ts_utc, ts, steps)| {
            row.push_bind(user_id)
                .push_bind(ts)
                .push_bind(steps)
                .push_bind(ts_utc);
        });
        let done = qb
            .build()
            .execute(&mut *tx)
            .await
            .context("archiving a batch of steps_intraday")?;
        written += done.rows_affected();
    }
    tx.commit().await.context("committing the steps archive")?;
    tracing::info!(
        "[{user_id}] google steps archive {from} → {until}: {written} new minute(s) of {} in range, from {} point(s), {skipped} unreadable",
        minutes.len(),
        points.len()
    );
    usize::try_from(written).context("minute count")
}

/// Blood-oxygen samples from Google's `oxygen-saturation` points, keyed by the
/// UTC instant and carrying the wall clock Google serves beside it, with how
/// many were unreadable. (#1886)
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
/// took, at full resolution. (#1886)
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
    /// The last path segment of `name` — the same id Fitbit's devices.json
    /// carried (measured 2026-10-01: `…/pairedDevices/3065341880` is the
    /// Inspire 3 stored under `3065341880`), so the history continues.
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
/// Fitbit's devices.json (#260; scope `googlehealth.settings.readonly`).
///
/// ⚠ THE INSTANT GOES IN `ts_utc`, and the reader prefers it. Fitbit's
/// `last_sync_time` is the WATCH's wall clock, which the reader converts in the
/// day's display zone; Google's is UTC. Writing Google's as a wall clock would
/// be the step-minutes mistake again (47d2502). `last_sync_time` carries the
/// UTC clock too, because it is the key.
///
/// Both this and Fitbit's device sync write until the Fitbit Web API ends
/// (2026-10-30): different keys for the same reading at worst, one point each.
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
