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
/// ⚠ EXTRACTED SO THE BOUNDARY CAN BE DRIVEN. Until 2026-09-01 this returns
/// `None` on every run, so the branch that actually writes had never executed —
/// and the only test on the cutover asserted the CONSTANT was not earlier than
/// the shutdown, which is a fact about a string. A guard that has only ever been
/// observed refusing is a guard nobody has tested
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
}

/// `daily_activity`, from the cutover forward only.
///
/// # Why not the history too
///
/// Measured 2026-08-28: Google's step counts are SYSTEMATICALLY LOWER — 570 of
/// 642 differing days, median 6 fewer, p90 517, p99 3346. Rewriting 1229 days of
/// existing history with them would change four years of a record Pippijn has
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
             resting_heart_rate) VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE steps=COALESCE(VALUES(steps), steps), \
             distance_km=COALESCE(VALUES(distance_km), distance_km), \
             calories_total=COALESCE(VALUES(calories_total), calories_total), \
             calories_active=COALESCE(VALUES(calories_active), calories_active), \
             resting_heart_rate=COALESCE(VALUES(resting_heart_rate), resting_heart_rate)",
        )
        .bind(user_id)
        .bind(date)
        .bind(a.steps)
        .bind(a.distance_km)
        .bind(a.calories_total)
        .bind(a.calories_active)
        .bind(a.resting_hr)
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
) -> Result<usize> {
    // ⚠ NO `IS NOT NULL` — same MIN/MAX-optimization defeat as the heart-rate
    // writer above (#1322); `MAX` skips NULLs anyway.
    let high: Option<String> =
        sqlx::query_scalar("SELECT CAST(MAX(end_time_utc) AS CHAR) FROM sleep WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .context("reading the sleep high-water mark")?;

    let since = match &high {
        Some(ts) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable sleep high-water mark {ts:?}"))?;
            (parsed - chrono::Duration::days(1))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        }
        None => (chrono::Utc::now() - chrono::Duration::days(7))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    };
    let filter = format!("sleep.interval.end_time >= \"{since}\"");
    let points = crate::google::health::fetch_points_filtered(http, access_token, "sleep", &filter)
        .await
        .context("fetching sleep sessions")?;

    let mut written = 0usize;
    let mut skipped = 0usize;
    for pt in &points {
        let Some(s) = crate::google::health::parse_sleep_point(pt) else {
            skipped += 1;
            continue;
        };
        sqlx::query(
            // The same column policy as the Fitbit writer: figures overwrite
            // (Google revises a recent night exactly as Fitbit did), tz and the
            // UTC columns COALESCE-preserve.
            "INSERT INTO sleep (user_id, log_id, date, start_time, end_time, duration_ms, \
             efficiency, minutes_asleep, minutes_awake, minutes_deep, minutes_light, \
             minutes_rem, minutes_wake, is_main_sleep, tz, start_time_utc, end_time_utc) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) \
             ON DUPLICATE KEY UPDATE end_time=VALUES(end_time), \
             duration_ms=VALUES(duration_ms), efficiency=VALUES(efficiency), \
             minutes_asleep=VALUES(minutes_asleep), minutes_awake=VALUES(minutes_awake), \
             minutes_deep=VALUES(minutes_deep), minutes_light=VALUES(minutes_light), \
             minutes_rem=VALUES(minutes_rem), minutes_wake=VALUES(minutes_wake), \
             start_time_utc=COALESCE(start_time_utc, VALUES(start_time_utc)), \
             end_time_utc=COALESCE(end_time_utc, VALUES(end_time_utc))",
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
            "SELECT log_id FROM sleep WHERE user_id = ? AND start_time = ? AND is_main_sleep = ? \
             LIMIT 1",
        )
        .bind(user_id)
        .bind(&s.start_time)
        .bind(s.is_main_sleep)
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
        "[{user_id}] google sleep: {written} session(s) from {} point(s), {skipped} unreadable",
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

    let mut watch: BTreeMap<String, i64> = BTreeMap::new();
    let mut phone: BTreeMap<String, i64> = BTreeMap::new();
    let mut skipped = 0usize;
    for pt in &points {
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
        let Some(cs) = crate::google::health::wall_clock_from_physical(sp, so) else {
            skipped += 1;
            continue;
        };
        let minute = format!("{}:00", &cs[..16]);
        let c = count.round() as i64;
        let m = if is_phone { &mut phone } else { &mut watch };
        // Two same-source intervals in one minute keep the larger — a re-served
        // correction, not an addition.
        m.entry(minute)
            .and_modify(|v| *v = (*v).max(c))
            .or_insert(c);
    }
    let mut merged = watch;
    for (m, c) in phone {
        merged.entry(m).or_insert(c);
    }

    let mut written = 0usize;
    for (ts, steps) in &merged {
        if *steps <= 0 {
            continue;
        }
        sqlx::query(
            "INSERT INTO steps_intraday (user_id, ts, steps) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE steps=VALUES(steps)",
        )
        .bind(user_id)
        .bind(ts)
        .bind(steps)
        .execute(pool)
        .await
        .with_context(|| format!("writing steps_intraday at {ts}"))?;
        written += 1;
    }
    tracing::info!(
        "[{user_id}] google steps_intraday: {written} minute(s) from {} point(s), {skipped} unreadable",
        points.len()
    );
    Ok(written)
}
