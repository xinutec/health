//! Google Fit comparisons and the sleep backfill: `google-compare*`, `google-
//! backfill-sleep`.

use anyhow::{Context, Result};
use backend::db;

/// How a type is fetched. ⚠ NOT cosmetic — the aggregates REFUSE `list`
/// ("List is not supported for data type total-calories"), and `list` on
/// `steps` returns per-interval samples rather than a civil-day sum. Getting
/// this wrong reports a populated stream as empty.
#[derive(PartialEq, Eq, Clone, Copy)]
pub(crate) enum Source {
    List,
    Rollup,
}

pub(crate) struct Pair {
    pub(crate) google: &'static str,
    pub(crate) source: Source,
    /// Multiply Google's value by this before comparing.
    ///
    /// ⚠ THE UNITS ARE NOT THE SAME ON BOTH SIDES. `distance.millimetersSum` is
    /// millimetres and `daily_activity.distance_km` is kilometres — a factor of
    /// a million. Left at 1.0 that comparison reports every day as differing by
    /// the entire reading, which looks exactly like a wrong mapping.
    pub(crate) scale: f64,
    pub(crate) pointer: &'static str,
    /// Subtract this pointer's value from `pointer`, day by day, before
    /// comparing.
    ///
    /// ⚠ EXISTS BECAUSE A STREAM CAN BE PRESENT WITHOUT BEING A FIELD. Fitbit's
    /// `skin_temperature.relative_deviation` is a deviation from a personal
    /// baseline; Google publishes the nightly temperature and the baseline as
    /// separate absolutes and has no field for the difference. Comparing
    /// against any single field reports 1194 of 1194 days differing, which
    /// reads as "Google does not have this" when Google has both halves of it.
    ///
    /// A day is compared only when BOTH pointers have it — a difference needs
    /// two operands, and defaulting the missing one to zero would silently turn
    /// an absolute into a deviation.
    pub(crate) minus: Option<&'static str>,
    pub(crate) table: &'static str,
    pub(crate) column: &'static str,
    pub(crate) tol: f64,
    pub(crate) unit: &'static str,
}

/// Does Google agree with Fitbit, day by day? (#260)
///
/// # Why this must run NOW
///
/// The Fitbit Web API is decommissioned in September. Until then BOTH sources
/// answer, and that overlap is the only period in which the Google numbers can
/// be checked against the ones we already trust. Afterwards a discrepancy is
/// permanent and invisible — there is nothing left to compare against.
///
/// ⚠ READ-ONLY. It writes nothing. A cutover that has not been diffed first is
/// a guess, and this is the instrument that makes it not one.
///
/// ⚠ THREE STREAMS ONLY, and deliberately. These are the ones where the
/// QUANTITY is unambiguous — breaths per minute against breaths per minute.
/// `skin_temperature.relative_deviation` against Google's
/// `nightlyTemperatureCelsius` is a deviation against an absolute, and
/// `daily_activity.resting_heart_rate` may be computed over a different window;
/// comparing those without establishing the semantics first would produce a
/// disagreement that means nothing. Add them when someone has checked.
pub(crate) async fn google_compare() -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;

    // (google type, value pointer, our table, our column, tolerance, unit)
    //
    // ⚠ THE TOLERANCE IS NOT A FUDGE FACTOR. Both sides store a float the
    // devices reported; an exact-equality test would fail on the last decimal
    // place and say nothing about whether the migration is safe. These are
    // tight enough that a real disagreement — a different window, a different
    // statistic — cannot hide inside one.
    const PAIRS: &[Pair] = &[
        // ⚠ `respiratory-rate-sleep-summary`, NOT `daily-respiratory-rate`.
        //
        // `breathing_rate` has FOUR value columns and `daily-respiratory-rate`
        // supplies ONE number. Comparing only `full_sleep_rate` against it said
        // "1186/1186 agree" and would have licensed a writer that fills one
        // column and leaves deep/light/rem NULL — three quarters of the table
        // dropped, with a green comparison behind it.
        //
        // ⚠ A COLUMN NOT COMPARED IS A COLUMN NOT MIGRATED. Match the table's
        // shape, not the first Google type whose name resembles it.
        // ⚠ BOTH TYPES FEED THIS ONE TABLE. Measured 2026-08-28:
        //
        //   full_sleep_rate vs daily-respiratory-rate        1186/1186 EXACT
        //   full_sleep_rate vs summary fullSleepStats        61 differ, 2.6 worst
        //
        // They are DIFFERENT STATISTICS and ours is the first. "Compare every
        // column" correctly caught that one column was not the table — but
        // moving the WHOLE table to the sleep summary, which is what that first
        // suggested, would have broken the column that already agreed exactly.
        //
        // ⚠ The three stage columns hold ZERO rows here and Google has 1,197
        // days of each, so this table GAINS three columns on migration rather
        // than risking them.
        Pair {
            google: "daily-respiratory-rate",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyRespiratoryRate/breathsPerMinute",
            minus: None,
            table: "breathing_rate",
            column: "full_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        // Kept as a CONTRAST, not a candidate: its 61 disagreements are the
        // evidence that the two statistics differ, and deleting it would leave
        // the next reader to rediscover that by mapping the wrong one.
        Pair {
            google: "respiratory-rate-sleep-summary",
            source: Source::List,
            scale: 1.0,
            pointer: "/respiratoryRateSleepSummary/fullSleepStats/breathsPerMinute",
            minus: None,
            table: "breathing_rate",
            column: "full_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        Pair {
            google: "respiratory-rate-sleep-summary",
            source: Source::List,
            scale: 1.0,
            pointer: "/respiratoryRateSleepSummary/deepSleepStats/breathsPerMinute",
            minus: None,
            table: "breathing_rate",
            column: "deep_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        Pair {
            google: "respiratory-rate-sleep-summary",
            source: Source::List,
            scale: 1.0,
            pointer: "/respiratoryRateSleepSummary/lightSleepStats/breathsPerMinute",
            minus: None,
            table: "breathing_rate",
            column: "light_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        Pair {
            google: "respiratory-rate-sleep-summary",
            source: Source::List,
            scale: 1.0,
            pointer: "/respiratoryRateSleepSummary/remSleepStats/breathsPerMinute",
            minus: None,
            table: "breathing_rate",
            column: "rem_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        Pair {
            google: "daily-oxygen-saturation",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyOxygenSaturation/averagePercentage",
            minus: None,
            table: "spo2_daily",
            column: "avg_value",
            tol: 0.05,
            unit: "%",
        },
        Pair {
            google: "daily-heart-rate-variability",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyHeartRateVariability/averageHeartRateVariabilityMilliseconds",
            minus: None,
            table: "hrv_daily",
            column: "daily_rmssd",
            tol: 0.05,
            unit: "ms",
        },
        // ⚠ THE SECOND COLUMN OF THE SAME TABLE, under the same type. #260 had
        // `hrv_daily` written up as "1195/1195 exact, single source" and cleared
        // to flip — a verdict produced by comparing ONE of its two value
        // columns. `deep_rmssd` was never compared, and a flip on that reading
        // would have frozen it at whatever Fitbit last wrote.
        Pair {
            google: "daily-heart-rate-variability",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyHeartRateVariability/deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds",
            minus: None,
            table: "hrv_daily",
            column: "deep_rmssd",
            tol: 0.05,
            unit: "ms",
        },
        // skin_temperature.relative_deviation holds Fitbit's `nightlyRelative`.
        // ⚠ ALL THREE of Google's fields are compared against it because NONE is
        // obviously the same statistic: `relativeNightlyStddev30dCelsius` reads
        // as a figure in units of a 30-day stddev rather than a °C deviation,
        // and the other two are absolutes. Two of these are therefore controls
        // that SHOULD disagree — if all three disagree, the answer is probably
        // `nightly - baseline`, a computed comparison this tool cannot express.
        // Picking one on the strength of its name is how breathing_rate nearly
        // moved onto the wrong statistic.
        Pair {
            google: "daily-sleep-temperature-derivations",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailySleepTemperatureDerivations/relativeNightlyStddev30dCelsius",
            minus: None,
            table: "skin_temperature",
            column: "relative_deviation",
            tol: 0.005,
            unit: "°C",
        },
        Pair {
            google: "daily-sleep-temperature-derivations",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailySleepTemperatureDerivations/nightlyTemperatureCelsius",
            minus: None,
            table: "skin_temperature",
            column: "relative_deviation",
            tol: 0.005,
            unit: "°C",
        },
        Pair {
            google: "daily-sleep-temperature-derivations",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailySleepTemperatureDerivations/baselineTemperatureCelsius",
            minus: None,
            table: "skin_temperature",
            column: "relative_deviation",
            tol: 0.005,
            unit: "°C",
        },
        // The hypothesis the three above are the controls for: a DEVIATION, not
        // a field. The three single-field candidates each differ on 1192-1194 of
        // 1194 days, and `relativeNightlyStddev30dCelsius` covers EXACTLY our
        // 1194 nights while disagreeing on nearly all of them — the right nights
        // carrying a different statistic.
        Pair {
            google: "daily-sleep-temperature-derivations",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailySleepTemperatureDerivations/nightlyTemperatureCelsius",
            minus: Some("/dailySleepTemperatureDerivations/baselineTemperatureCelsius"),
            table: "skin_temperature",
            column: "relative_deviation",
            tol: 0.005,
            unit: "°C",
        },
        // daily_activity, one column of twelve. ⚠ THE OTHER NINE THAT NEED A
        // SOURCE CANNOT BE COMPARED HERE YET: they are `dailyRollUp` types and
        // this tool only walks `list`. Measured 2026-08-28 — `floors` and
        // `elevation_m` are 0 of 1246 rows and need no source at all.
        Pair {
            google: "daily-resting-heart-rate",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyRestingHeartRate/beatsPerMinute",
            minus: None,
            table: "daily_activity",
            column: "resting_heart_rate",
            tol: 0.5,
            unit: "bpm",
        },
        // spo2_daily has THREE value columns, not one. ⚠ `lowerBound`/`upperBound`
        // are NOT self-evidently min/max: `standardDeviationPercentage` sits
        // beside them in the same point, which is what a CONFIDENCE INTERVAL
        // looks like — mean ± k·σ, a different statistic from an observed
        // extreme. The third pair below tests exactly that, so the naming is
        // never what decides it.
        Pair {
            google: "daily-oxygen-saturation",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyOxygenSaturation/lowerBoundPercentage",
            minus: None,
            table: "spo2_daily",
            column: "min_value",
            tol: 0.05,
            unit: "%",
        },
        Pair {
            google: "daily-oxygen-saturation",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyOxygenSaturation/upperBoundPercentage",
            minus: None,
            table: "spo2_daily",
            column: "max_value",
            tol: 0.05,
            unit: "%",
        },
        // The CI hypothesis, as a control on the two above: if lowerBound is
        // mean − σ then THIS agrees with min_value and the pair above does not.
        Pair {
            google: "daily-oxygen-saturation",
            source: Source::List,
            scale: 1.0,
            pointer: "/dailyOxygenSaturation/averagePercentage",
            minus: Some("/dailyOxygenSaturation/standardDeviationPercentage"),
            table: "spo2_daily",
            column: "min_value",
            tol: 0.05,
            unit: "%",
        },
        // daily_activity's rollup columns. ⚠ These REFUSE `list`; the aggregate
        // types only answer `rollup`/`dailyRollup`, which is why nine of the ten
        // columns could not be measured until now.
        Pair {
            google: "steps",
            source: Source::Rollup,
            scale: 1.0,
            pointer: "/steps/countSum",
            minus: None,
            table: "daily_activity",
            column: "steps",
            tol: 0.5,
            unit: "steps",
        },
        Pair {
            google: "distance",
            source: Source::Rollup,
            // millimetres → kilometres.
            scale: 1e-6,
            pointer: "/distance/millimetersSum",
            minus: None,
            table: "daily_activity",
            column: "distance_km",
            tol: 0.01,
            unit: "km",
        },
        Pair {
            google: "total-calories",
            source: Source::Rollup,
            scale: 1.0,
            pointer: "/totalCalories/kcalSum",
            minus: None,
            table: "daily_activity",
            column: "calories_total",
            tol: 0.5,
            unit: "kcal",
        },
        Pair {
            google: "active-energy-burned",
            source: Source::Rollup,
            scale: 1.0,
            pointer: "/activeEnergyBurned/kcalSum",
            minus: None,
            table: "daily_activity",
            column: "calories_active",
            tol: 0.5,
            unit: "kcal",
        },
    ];

    // The rollup window. ⚠ Bounded by our own data, not by the API: a rollup is
    // chunked at 14 days per request, so asking for four years is ~100 round
    // trips. This covers the corpus and is stated rather than guessed.
    let end_d = chrono::Utc::now().date_naive() + chrono::Duration::days(1);
    let start_d = chrono::NaiveDate::from_ymd_opt(2023, 4, 1).expect("a literal date");

    for p in PAIRS {
        let mut theirs = match p.source {
            Source::List => {
                backend::google::health::fetch_daily_series(&http, &token, p.google, p.pointer)
                    .await?
            }
            Source::Rollup => {
                backend::google::health::fetch_daily_rollup(
                    &http, &token, p.google, start_d, end_d, p.pointer,
                )
                .await?
            }
        };
        if p.scale != 1.0 {
            for d in &mut theirs {
                d.value *= p.scale;
            }
        }
        if let Some(sub) = p.minus {
            let base =
                backend::google::health::fetch_daily_series(&http, &token, p.google, sub).await?;
            let by_day: std::collections::BTreeMap<&str, f64> =
                base.iter().map(|d| (d.date.as_str(), d.value)).collect();
            // ⚠ A day missing from either side is DROPPED, not defaulted. Zero
            // is a legal temperature difference, so a defaulted operand would
            // enter the comparison as a real measurement.
            theirs.retain(|d| by_day.contains_key(d.date.as_str()));
            for d in &mut theirs {
                d.value -= by_day[d.date.as_str()];
            }
        }
        let ours = read_daily_column(&pool, p.table, p.column).await?;
        report_pair(p, &theirs, &ours);
    }
    Ok(())
}

/// Our side of one comparison, as `(date, value)`.
///
/// ⚠ One literal per table, not a `format!`. The crate refuses a dynamically
/// built SQL string and dev-lint refuses even a `const` in a variable — schema
/// checking reads the argument at the call site.
pub(crate) async fn read_daily_column(
    pool: &sqlx::MySqlPool,
    table: &str,
    column: &str,
) -> Result<Vec<(String, f64)>> {
    use sqlx::Row as _;
    let rows = match (table, column) {
        ("breathing_rate", "full_sleep_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(full_sleep_rate AS CHAR) v FROM breathing_rate WHERE full_sleep_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("breathing_rate", "deep_sleep_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(deep_sleep_rate AS CHAR) v FROM breathing_rate WHERE deep_sleep_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("breathing_rate", "light_sleep_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(light_sleep_rate AS CHAR) v FROM breathing_rate WHERE light_sleep_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("breathing_rate", "rem_sleep_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(rem_sleep_rate AS CHAR) v FROM breathing_rate WHERE rem_sleep_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("spo2_daily", "avg_value") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(avg_value AS CHAR) v FROM spo2_daily WHERE avg_value IS NOT NULL")
                .fetch_all(pool).await
        }
        ("hrv_daily", "daily_rmssd") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(daily_rmssd AS CHAR) v FROM hrv_daily WHERE daily_rmssd IS NOT NULL")
                .fetch_all(pool).await
        }
        ("daily_activity", "steps") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(steps AS CHAR) v FROM daily_activity WHERE steps IS NOT NULL")
                .fetch_all(pool).await
        }
        ("daily_activity", "distance_km") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(distance_km AS CHAR) v FROM daily_activity WHERE distance_km IS NOT NULL")
                .fetch_all(pool).await
        }
        ("daily_activity", "calories_total") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(calories_total AS CHAR) v FROM daily_activity WHERE calories_total IS NOT NULL")
                .fetch_all(pool).await
        }
        ("daily_activity", "calories_active") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(calories_active AS CHAR) v FROM daily_activity WHERE calories_active IS NOT NULL")
                .fetch_all(pool).await
        }
        ("spo2_daily", "min_value") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(min_value AS CHAR) v FROM spo2_daily WHERE min_value IS NOT NULL")
                .fetch_all(pool).await
        }
        ("spo2_daily", "max_value") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(max_value AS CHAR) v FROM spo2_daily WHERE max_value IS NOT NULL")
                .fetch_all(pool).await
        }
        ("daily_activity", "resting_heart_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(resting_heart_rate AS CHAR) v FROM daily_activity WHERE resting_heart_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("skin_temperature", "relative_deviation") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(relative_deviation AS CHAR) v FROM skin_temperature WHERE relative_deviation IS NOT NULL")
                .fetch_all(pool).await
        }
        ("hrv_daily", "deep_rmssd") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(deep_rmssd AS CHAR) v FROM hrv_daily WHERE deep_rmssd IS NOT NULL")
                .fetch_all(pool).await
        }
        _ => anyhow::bail!("no query wired for {table}.{column}"),
    }
    .with_context(|| format!("reading {table}.{column}"))?;

    let mut out = Vec::new();
    for r in rows {
        let d: String = r.try_get("d").context("date column")?;
        // ⚠ `CAST(... AS CHAR)` ON THE VALUE TOO, not only on the date.
        //
        // These columns are DECIMAL, and sqlx decodes DECIMAL into neither f32
        // nor f64 — a live run answered
        //
        //     Rust type `f32` (as SQL type `FLOAT`) is not compatible with
        //     SQL type `DECIMAL`
        //
        // and an f64/f32 fallback does not help, because the fault is the SQL
        // type rather than its width. ⚠ THIS FAILS ON REAL ROWS ONLY: an empty
        // table decodes fine and the check passes, so a test against a fixture
        // would never have caught it. A string crosses cleanly from every
        // numeric type and this is a readout, not arithmetic.
        let raw: String = r.try_get("v").context("value column")?;
        let v: f64 = raw
            .parse()
            .with_context(|| format!("{table}.{column} value {raw:?} is not a number"))?;
        out.push((d, v));
    }
    Ok(out)
}

/// Print one stream's agreement, and say which side each gap is on.
///
/// ⚠ "Only in Google" and "only in ours" are DIFFERENT FINDINGS and are never
/// merged into one count: the first is data we would gain, the second is data
/// the migration would LOSE. A single "mismatch" number hides the direction,
/// which is the half that decides whether a cutover is safe.
pub(crate) fn report_pair(
    p: &Pair,
    theirs: &[backend::google::health::DailyValue],
    ours: &[(String, f64)],
) {
    let (google, pointer, table, column, unit, tol) =
        (p.google, p.pointer, p.table, p.column, p.unit, p.tol);
    use std::collections::HashMap;
    let g: HashMap<&str, f64> = theirs.iter().map(|d| (d.date.as_str(), d.value)).collect();
    let o: HashMap<&str, f64> = ours.iter().map(|(d, v)| (d.as_str(), *v)).collect();

    let (mut agree, mut differ, mut worst, mut worst_day) = (0usize, 0usize, 0.0f64, String::new());
    for (d, gv) in &g {
        if let Some(ov) = o.get(d) {
            let delta = (gv - ov).abs();
            if delta <= tol {
                agree += 1;
            } else {
                differ += 1;
                if delta > worst {
                    worst = delta;
                    worst_day = (*d).to_string();
                }
            }
        }
    }
    let only_google = g.keys().filter(|d| !o.contains_key(*d)).count();
    let only_ours = o.keys().filter(|d| !g.contains_key(*d)).count();

    println!(
        // ⚠ THE LAST PATH SEGMENT IS NOT A LABEL. All four breathing_rate
        // pointers end in `breathsPerMinute`, so printing only that made four
        // different comparisons look identical — a pointer typo would have been
        // invisible in the readout.
        "{google}{pointer} vs {table}.{column}"
    );
    println!("  google {:>5} days   ours {:>5} days", g.len(), o.len());
    // ⚠ THE COARSER SIDE SETS THE FLOOR ON AGREEMENT. If our stored values are
    // quantised to 0.1 and Google reports full precision, the two can never
    // agree closer than half a step no matter how right the mapping is — and
    // the residual looks exactly like a wrong statistic. Printing the step
    // separates "the mapping is wrong" from "the old source was rounder".
    let step = |vs: &mut dyn Iterator<Item = f64>| -> Option<f64> {
        let vals: Vec<f64> = vs.collect();
        [1.0f64, 0.5, 0.1, 0.05, 0.01, 0.001]
            .into_iter()
            .find(|k| vals.iter().all(|v| ((v / k).round() * k - v).abs() < 1e-9))
    };
    // ⚠ Reported per side, NOT only when both are known. A computed pointer
    // (a difference of two full-precision values) lands on no clean step, so a
    // both-known condition stays silent for exactly the comparison whose
    // residual most needs explaining.
    let fmt = |x: Option<f64>| x.map_or("none".to_string(), |v| format!("{v}"));
    let (gs, os) = (
        step(&mut g.values().copied()),
        step(&mut o.values().copied()),
    );
    if gs != os {
        println!(
            "  ⚠ granularity: google {}, ours {} {unit} — half of the coarser step is the floor on agreement",
            fmt(gs),
            fmt(os)
        );
    }
    println!("  agree within {tol} {unit}: {agree}");
    if differ > 0 {
        println!("  ⚠ DIFFER: {differ}   worst {worst:.3} {unit} on {worst_day}");
        // ⚠ A WORST CASE ALONE CANNOT SIZE A DISAGREEMENT. "worst 0.050" is one
        // reading whether it is a single outlier or every day, and those are
        // opposite verdicts: a lone spike is a bad day, a flat 0.05 across the
        // corpus is a units or precision mismatch. The quantiles separate them.
        let mut deltas: Vec<f64> = g
            .iter()
            .filter_map(|(d, gv)| o.get(d).map(|ov| (gv - ov).abs()))
            .collect();
        // ⚠ `total_cmp`, not `partial_cmp().unwrap()`. These deltas come from
        // two live sources; asserting no NaN is a claim about data neither of
        // them promises, and the cost of being wrong is a panic in a diagnostic.
        deltas.sort_by(f64::total_cmp);
        let at = |q: f64| deltas[((deltas.len() - 1) as f64 * q) as usize];
        println!(
            "    spread over all {} shared days: p50 {:.3}  p90 {:.3}  p99 {:.3} {unit}",
            deltas.len(),
            at(0.50),
            at(0.90),
            at(0.99)
        );
        // ⚠ WHICH days, not just how many. Twelve scattered disagreements and
        // one bad fortnight are the same count and opposite diagnoses: the first
        // is a statistic that does not match, the second is an episode with a
        // cause you can go and find. Sorted, and capped so a wholesale mismatch
        // cannot flood the readout — the cap is REPORTED, because a silent
        // truncation would read as "that is all of them".
        // ⚠ WHICH SIDE IS HIGHER. `|delta|` cannot distinguish "Google counts
        // more" from "Google counts less", and for a migration those are
        // completely different decisions: a consistent excess is a second
        // source being counted, a consistent shortfall is data we would lose.
        // A symmetric split is neither — it is noise or a boundary.
        let higher = g
            .iter()
            .filter(|(d, gv)| o.get(*d).is_some_and(|ov| *gv - ov > tol))
            .count();
        let lower = g
            .iter()
            .filter(|(d, gv)| o.get(*d).is_some_and(|ov| ov - *gv > tol))
            .count();
        println!("    direction: google higher on {higher}, lower on {lower}");
        let mut days: Vec<&str> = g
            .iter()
            .filter(|(d, gv)| o.get(*d).is_some_and(|ov| (*gv - ov).abs() > tol))
            .map(|(d, _)| *d)
            .collect();
        days.sort_unstable();
        const SHOW: usize = 20;
        let shown = days.len().min(SHOW);
        println!(
            "    differing days: {}{}",
            days[..shown].join(" "),
            if days.len() > SHOW {
                format!(" … and {} more", days.len() - SHOW)
            } else {
                String::new()
            }
        );
    }
    if only_google > 0 {
        println!("  only in google: {only_google}  (data the migration would GAIN)");
    }
    if only_ours > 0 {
        println!("  ⚠ only in ours: {only_ours}  (data the migration would LOSE)");
    }
    println!();
}

/// Google's intraday heart-rate against `heart_rate_intraday`, per second AND
/// per minute. (#260)
///
/// The per-sample counterpart to {@link google_compare}: `PAIRS` is day-keyed
/// by construction and cannot express this stream, so it gets its own readout —
/// how many samples exist on each side, how many timestamps are shared, and the
/// p50/p90/p99 of |Δbpm| over the shared ones.
///
/// # ⚠ TWO JOINS, because the clocks differ before the values do
///
/// Fitbit stores a sample every ~5-15 s, Google every ~2-3 s, and neither
/// promises alignment — so an exact-second join can come back nearly empty on
/// two streams that measure the SAME heart perfectly. That would read as "the
/// data disagrees" when the truth is "the clocks tick differently". The
/// minute-mean join answers the question the flip actually needs — same signal?
/// — and the second join reports how much literal overlap exists.
///
/// # ⚠ JOINED ON `ts_utc`, NEVER `ts`
///
/// `ts` is a wall clock, and the Fitbit rows' `tz` is NULL on the days the
/// backfill CLI never reached — a wall-clock join would silently compare
/// different instants across a DST boundary. Rows without `ts_utc` cannot be
/// joined at all and are counted out loud instead of vanishing from the
/// denominator.
///
/// ⚠ READ-ONLY, like `google-compare`. It writes nothing.
pub(crate) async fn google_compare_intraday(days: i64) -> Result<()> {
    use std::collections::BTreeMap;

    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;

    let end = chrono::Utc::now();
    let start = end - chrono::Duration::days(days);
    let filter = format!(
        "heart_rate.sample_time.physical_time >= \"{}\" AND heart_rate.sample_time.physical_time < \"{}\"",
        start.format("%Y-%m-%dT%H:%M:%SZ"),
        end.format("%Y-%m-%dT%H:%M:%SZ"),
    );
    let points =
        backend::google::health::fetch_points_filtered(&http, &token, "heart-rate", &filter)
            .await
            .context("fetching filtered heart-rate")?;

    // Google's side, keyed by UTC second. A duplicate second keeps the LAST
    // point and is counted — the writer's `ON DUPLICATE KEY` does the same, so
    // the comparison sees what a sync would have stored.
    let mut g: BTreeMap<String, f64> = BTreeMap::new();
    let (mut unreadable, mut dup_seconds) = (0usize, 0usize);
    for pt in &points {
        let bpm = pt
            .pointer("/heartRate/beatsPerMinute")
            .and_then(backend::google::health::numeric);
        let ts = pt
            .pointer("/heartRate/sampleTime/physicalTime")
            .and_then(|v| v.as_str())
            .and_then(backend::google::health::rfc3339_to_utc_datetime);
        let (Some(bpm), Some(ts)) = (bpm, ts) else {
            unreadable += 1;
            continue;
        };
        if g.insert(ts, bpm).is_some() {
            dup_seconds += 1;
        }
    }

    // Our side of the same window.
    use sqlx::Row as _;
    let start_s = start.format("%Y-%m-%d %H:%M:%S").to_string();
    let end_s = end.format("%Y-%m-%d %H:%M:%S").to_string();
    let rows = sqlx::query(
        "SELECT CAST(ts_utc AS CHAR) t, CAST(bpm AS CHAR) v FROM heart_rate_intraday \
         WHERE ts_utc >= ? AND ts_utc < ?",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_all(&pool)
    .await
    .context("reading heart_rate_intraday")?;
    let mut o: BTreeMap<String, f64> = BTreeMap::new();
    for r in rows {
        let t: String = r.try_get("t").context("ts_utc column")?;
        let raw: String = r.try_get("v").context("bpm column")?;
        let v: f64 = raw
            .parse()
            .with_context(|| format!("bpm value {raw:?} is not a number"))?;
        o.insert(t, v);
    }
    // ⚠ Counted on the WALL clock, because a row with no ts_utc has nothing
    // else — approximate at the window's edges and exact in its interior, and a
    // count is all this is.
    let no_utc: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM heart_rate_intraday \
         WHERE ts_utc IS NULL AND ts >= ? AND ts < ?",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(&pool)
    .await
    .context("counting NULL-ts_utc rows")?;

    println!(
        "heart-rate/heartRate/beatsPerMinute vs heart_rate_intraday.bpm — last {days} day(s), {start_s}Z..{end_s}Z"
    );
    println!(
        "  google {:>7} samples  ({unreadable} unreadable, {dup_seconds} duplicate seconds)",
        g.len()
    );
    print!("  ours   {:>7} samples", o.len());
    if no_utc > 0 {
        print!("  ⚠ +{no_utc} in-window rows with NULL ts_utc — unjoinable");
    }
    println!();

    let spread = |label: &str, g: &BTreeMap<String, f64>, o: &BTreeMap<String, f64>| {
        let shared: Vec<(&String, f64, f64)> = g
            .iter()
            .filter_map(|(t, gv)| o.get(t).map(|ov| (t, *gv, *ov)))
            .collect();
        println!(
            "  [{label}] shared: {} of google {}, ours {}",
            shared.len(),
            g.len(),
            o.len()
        );
        if shared.is_empty() {
            return;
        }
        let identical = shared.iter().filter(|(_, gv, ov)| gv == ov).count();
        let mut deltas: Vec<f64> = shared.iter().map(|(_, gv, ov)| (gv - ov).abs()).collect();
        deltas.sort_by(f64::total_cmp);
        let at = |q: f64| deltas[((deltas.len() - 1) as f64 * q) as usize];
        let (worst_t, worst_g, worst_o) = shared
            .iter()
            .max_by(|a, b| (a.1 - a.2).abs().total_cmp(&(b.1 - b.2).abs()))
            .map(|(t, gv, ov)| ((*t).clone(), *gv, *ov))
            .expect("shared is non-empty");
        println!(
            "    identical: {identical}/{}   |Δbpm| p50 {:.2}  p90 {:.2}  p99 {:.2}  worst {:.2} at {worst_t}Z (google {worst_g:.1}, ours {worst_o:.1})",
            shared.len(),
            at(0.50),
            at(0.90),
            at(0.99),
            (worst_g - worst_o).abs(),
        );
        let higher = shared.iter().filter(|(_, gv, ov)| gv > ov).count();
        let lower = shared.iter().filter(|(_, gv, ov)| gv < ov).count();
        println!("    direction: google higher on {higher}, lower on {lower}");
    };

    spread("exact second", &g, &o);

    // Minute means. The key is the DATETIME string cut at the minute, which is
    // safe exactly because the strings are fixed-width `YYYY-MM-DD HH:MM:SS`.
    let by_minute = |m: &BTreeMap<String, f64>| -> BTreeMap<String, f64> {
        let mut acc: BTreeMap<String, (f64, u32)> = BTreeMap::new();
        for (t, v) in m {
            let e = acc.entry(t[..16].to_string()).or_insert((0.0, 0));
            e.0 += v;
            e.1 += 1;
        }
        acc.into_iter()
            .map(|(t, (sum, n))| (t, sum / f64::from(n)))
            .collect()
    };
    spread("minute mean", &by_minute(&g), &by_minute(&o));

    // ⚠ The same direction split as report_pair, on coverage rather than value:
    // minutes only one side has. "Only google" is what the flip would GAIN,
    // "only ours" is what it would LOSE.
    let (gm, om) = (by_minute(&g), by_minute(&o));
    let only_google = gm.keys().filter(|t| !om.contains_key(*t)).count();
    let only_ours = om.keys().filter(|t| !gm.contains_key(*t)).count();
    println!("  minutes only in google: {only_google}  (GAIN)   only in ours: {only_ours}  (LOSE)");
    Ok(())
}

/// Google's sleep sessions against `sleep` + `sleep_stages`, per column. (#260)
///
/// Joined on `start_time_utc` — the one field both sources state as an instant.
/// Every column is compared by name so a single wrong mapping cannot hide
/// inside a night-level "agrees"; the stage series is compared as per-stage
/// totals and entry counts per night.
///
/// ⚠ READ-ONLY. It writes nothing.
/// Re-fetch a WIDE sleep window through the routine writer (#1491).
///
/// ⚠ **THE ROUTINE SYNC CANNOT REACH A HISTORICAL ROW.** Its window is
/// `MAX(end_time_utc)` less a day, so a row that is wrong for any reason stays
/// wrong on every schedule — measured 2026-09-08, the night of 2-3 Sep. This is
/// how such a row gets repaired BY THE PIPELINE rather than by hand, which
/// matters because a hand-edited row leaves the writer unproven against it.
///
/// ⚠ **DRY RUN UNLESS `--write`.** The writer UPSERTS and its figures
/// overwrite, so a wide window rewrites every night inside it. That is the
/// intent, and it is still not something to do by typing a number slightly
/// wrong. `google-compare-sleep <days>` shows the diff first and never writes.
pub(crate) async fn google_backfill_sleep(
    days: i64,
    write: bool,
    allow_shrink: bool,
) -> Result<()> {
    anyhow::ensure!(days > 0, "a backfill window must be at least a day");
    let user_id = std::env::var("GH_USER_ID")
        .context("GH_USER_ID names the Google-configured user and must be set")?;
    let since = (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%d %H:%MZ");

    if !write {
        println!(
            "DRY RUN — would re-fetch sleep sessions ending on or after {since} \
             ({days} day(s)) for {user_id} and upsert every one through the routine writer.\n\
             \n\
             The writer's figures OVERWRITE, so this rewrites every night in the window.\n\
             A session more than {ratio}x SHORTER than the one it would replace is refused\n\
             and named instead: Google leaves a fragment behind when it records a night in\n\
             progress and never revises it, and that fragment shares the start instant the\n\
             night is keyed on. --allow-shrink writes those too.\n\
             See the diff first:  backend google-compare-sleep {days}\n\
             Then apply:          backend google-backfill-sleep {days} --write",
            ratio = backend::google::sync::SLEEP_SHRINK_REFUSAL_RATIO
        );
        return Ok(());
    }

    // ⚠ READ AFTER THE DRY-RUN BRANCH ON PURPOSE: previewing a plan must not
    // require credentials for a database the preview never opens.
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;

    // ⚠ THE ROUTINE WRITER, not a copy of it. A backfill that wrote through its
    // own INSERT would repair the rows and prove nothing about the path that
    // produces them daily.
    let n =
        backend::google::sync::sync_sleep(&pool, &http, &token, &user_id, Some(days), allow_shrink)
            .await
            .context("backfilling sleep")?;
    println!("backfilled {n} sleep session(s) ending on or after {since} for {user_id}");
    Ok(())
}

pub(crate) async fn google_compare_sleep(days: i64) -> Result<()> {
    use std::collections::BTreeMap;

    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;

    let start = chrono::Utc::now() - chrono::Duration::days(days);
    let filter = format!(
        "sleep.interval.end_time >= \"{}\"",
        start.format("%Y-%m-%dT%H:%M:%SZ")
    );
    let points = backend::google::health::fetch_points_filtered(&http, &token, "sleep", &filter)
        .await
        .context("fetching sleep sessions")?;
    let mut unreadable = 0usize;
    let mut google: BTreeMap<String, backend::google::health::GoogleSleepSession> = BTreeMap::new();
    for pt in &points {
        match backend::google::health::parse_sleep_point(pt) {
            Some(s) => {
                google.insert(s.start_time_utc.clone(), s);
            }
            None => unreadable += 1,
        }
    }

    use sqlx::Row as _;
    let start_s = start.format("%Y-%m-%d %H:%M:%S").to_string();
    let rows = sqlx::query(
        "SELECT CAST(log_id AS CHAR) log_id, CAST(date AS CHAR) d, \
         CAST(start_time AS CHAR) st, CAST(end_time AS CHAR) et, \
         CAST(start_time_utc AS CHAR) stu, CAST(duration_ms AS CHAR) dur, \
         CAST(efficiency AS CHAR) eff, CAST(minutes_asleep AS CHAR) ma, \
         CAST(minutes_awake AS CHAR) mw, CAST(minutes_deep AS CHAR) md, \
         CAST(minutes_light AS CHAR) ml, CAST(minutes_rem AS CHAR) mr, \
         CAST(minutes_wake AS CHAR) mk, CAST(is_main_sleep AS CHAR) main \
         FROM sleep WHERE end_time_utc >= ?",
    )
    .bind(&start_s)
    .fetch_all(&pool)
    .await
    .context("reading sleep rows")?;

    struct OurNight {
        log_id: String,
        cols: BTreeMap<&'static str, Option<String>>,
    }
    let mut ours: BTreeMap<String, OurNight> = BTreeMap::new();
    for r in &rows {
        let stu: Option<String> = r.try_get("stu").ok();
        let Some(stu) = stu else { continue };
        let mut cols: BTreeMap<&'static str, Option<String>> = BTreeMap::new();
        for k in [
            "d", "st", "et", "dur", "eff", "ma", "mw", "md", "ml", "mr", "mk", "main",
        ] {
            cols.insert(k, r.try_get::<Option<String>, _>(k).ok().flatten());
        }
        ours.insert(
            stu,
            OurNight {
                log_id: r
                    .try_get::<Option<String>, _>("log_id")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                cols,
            },
        );
    }

    println!(
        "sleep sessions vs sleep table — last {days} day(s): google {} ({unreadable} unreadable), ours {}",
        google.len(),
        ours.len()
    );
    let only_g = google.keys().filter(|k| !ours.contains_key(*k)).count();
    let only_o = ours.keys().filter(|k| !google.contains_key(*k)).count();
    println!(
        "  shared start instants: {}   only google: {only_g} (GAIN)   only ours: {only_o} (LOSE)",
        google.keys().filter(|k| ours.contains_key(*k)).count()
    );

    // Per-column agreement over the shared nights. Booleans cross as "1"/"0".
    let mut agree: BTreeMap<&str, usize> = BTreeMap::new();
    let mut differ: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (stu, g) in &google {
        let Some(o) = ours.get(stu) else { continue };
        let gcols: [(&str, Option<String>); 12] = [
            ("d", Some(g.date.clone())),
            ("st", Some(g.start_time.clone())),
            ("et", Some(g.end_time.clone())),
            ("dur", Some(g.duration_ms.to_string())),
            ("eff", Some(g.efficiency.to_string())),
            ("ma", Some(g.minutes_asleep.to_string())),
            ("mw", Some(g.minutes_awake.to_string())),
            ("md", g.minutes_deep.map(|v| v.to_string())),
            ("ml", g.minutes_light.map(|v| v.to_string())),
            ("mr", g.minutes_rem.map(|v| v.to_string())),
            ("mk", g.minutes_wake.map(|v| v.to_string())),
            (
                "main",
                Some(if g.is_main_sleep { "1" } else { "0" }.to_string()),
            ),
        ];
        for (k, gv) in gcols {
            let ov = o.cols.get(k).cloned().flatten();
            if gv == ov {
                *agree.entry(k).or_default() += 1;
            } else {
                differ.entry(k).or_default().push(format!(
                    "{stu}: google {} vs ours {}",
                    gv.as_deref().unwrap_or("NULL"),
                    ov.as_deref().unwrap_or("NULL")
                ));
            }
        }
    }
    for k in [
        "d", "st", "et", "dur", "eff", "ma", "mw", "md", "ml", "mr", "mk", "main",
    ] {
        let a = agree.get(k).copied().unwrap_or(0);
        match differ.get(k) {
            None => println!("  {k:>4}: {a} agree"),
            Some(d) => {
                println!("  {k:>4}: {a} agree, ⚠ {} DIFFER", d.len());
                for line in d.iter().take(4) {
                    println!("        {line}");
                }
                if d.len() > 4 {
                    println!("        … and {} more", d.len() - 4);
                }
            }
        }
    }

    // Stage series, per shared night: entry count and per-stage second totals,
    // ours read via the stored row's log_id (the join the frontend uses).
    let mut nights_same = 0usize;
    let mut nights_differ = 0usize;
    for (stu, g) in &google {
        let Some(o) = ours.get(stu) else { continue };
        // No user_id clause: log ids are globally unique, and guessing the
        // user from the env here could silently compare against nothing.
        let srows = sqlx::query(
            "SELECT stage, CAST(SUM(duration_seconds) AS CHAR) s, COUNT(*) n \
             FROM sleep_stages WHERE sleep_log_id = ? GROUP BY stage",
        )
        .bind(&o.log_id)
        .fetch_all(&pool)
        .await
        .context("reading sleep_stages totals")?;
        let mut theirs: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for st in &g.stages {
            let e = theirs.entry(st.stage.clone()).or_default();
            e.0 += st.duration_seconds;
            e.1 += 1;
        }
        let mut mine: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for r in &srows {
            let stage: String = r.try_get("stage").context("stage")?;
            let s: String = r.try_get("s").context("sum")?;
            let n: i64 = r.try_get("n").context("count")?;
            mine.insert(stage, (s.parse().unwrap_or(-1), n));
        }
        if theirs == mine {
            nights_same += 1;
        } else {
            nights_differ += 1;
            println!("  ⚠ stages differ on {stu}: google {theirs:?} vs ours {mine:?}");
        }
    }
    println!("  stage series: {nights_same} night(s) identical, {nights_differ} differ");
    Ok(())
}

/// Google's HRV samples against `hrv_intraday.rmssd`, joined on the CIVIL
/// timestamp — the table has no ts_utc column. (#260)
///
/// ⚠ READ-ONLY.
pub(crate) async fn google_compare_hrv(days: i64) -> Result<()> {
    use std::collections::BTreeMap;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;
    let start = chrono::Utc::now() - chrono::Duration::days(days);
    let filter = format!(
        "heart_rate_variability.sample_time.physical_time >= \"{}\"",
        start.format("%Y-%m-%dT%H:%M:%SZ")
    );
    let points = backend::google::health::fetch_points_filtered(
        &http,
        &token,
        "heart-rate-variability",
        &filter,
    )
    .await?;
    let mut g: BTreeMap<String, f64> = BTreeMap::new();
    let mut unreadable = 0usize;
    for pt in &points {
        let v = pt
            .pointer("/heartRateVariability/rootMeanSquareOfSuccessiveDifferencesMilliseconds")
            .and_then(backend::google::health::numeric);
        let ts = backend::google::health::civil_datetime(
            pt.pointer("/heartRateVariability/sampleTime/civilTime"),
        );
        let (Some(v), Some(ts)) = (v, ts) else {
            unreadable += 1;
            continue;
        };
        g.insert(ts, v);
    }
    use sqlx::Row as _;
    // A day of slack on the wall-clock read: the fetch bound was physical.
    let start_s = (start - chrono::Duration::days(1))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let rows = sqlx::query(
        "SELECT CAST(ts AS CHAR) t, CAST(rmssd AS CHAR) v FROM hrv_intraday WHERE ts >= ?",
    )
    .bind(&start_s)
    .fetch_all(&pool)
    .await
    .context("reading hrv_intraday")?;
    let mut o: BTreeMap<String, f64> = BTreeMap::new();
    for r in rows {
        let t: String = r.try_get("t").context("ts")?;
        let raw: String = r.try_get("v").context("rmssd")?;
        o.insert(t, raw.parse().context("rmssd not a number")?);
    }
    println!(
        "heart-rate-variability/rmssd vs hrv_intraday.rmssd — last {days} day(s): google {} ({unreadable} unreadable), ours {}",
        g.len(),
        o.len()
    );
    let shared: Vec<(&String, f64, f64)> = g
        .iter()
        .filter_map(|(t, gv)| o.get(t).map(|ov| (t, *gv, *ov)))
        .collect();
    let only_g = g.keys().filter(|t| !o.contains_key(*t)).count();
    let only_o = o.keys().filter(|t| !g.contains_key(*t)).count();
    println!(
        "  shared civil ts: {}   only google: {only_g} (GAIN)   only ours: {only_o} (LOSE)",
        shared.len()
    );
    if !shared.is_empty() {
        let identical = shared
            .iter()
            .filter(|(_, gv, ov)| (gv - ov).abs() < 0.0005)
            .count();
        let mut deltas: Vec<f64> = shared.iter().map(|(_, gv, ov)| (gv - ov).abs()).collect();
        deltas.sort_by(f64::total_cmp);
        let at = |q: f64| deltas[((deltas.len() - 1) as f64 * q) as usize];
        println!(
            "  within our 0.001 step: {identical}/{}   |Δms| p50 {:.3}  p90 {:.3}  p99 {:.3}  worst {:.3}",
            shared.len(),
            at(0.50),
            at(0.90),
            at(0.99),
            deltas.last().copied().unwrap_or(0.0)
        );
    }
    Ok(())
}

/// Google's zone bounds + zone-interval sums against `heart_rate_zones`. (#260)
///
/// Prints every DISTINCT `heartRateZoneType` seen, so the enum→display-name
/// mapping is verified against the live vocabulary rather than assumed.
///
/// ⚠ READ-ONLY.
pub(crate) async fn google_compare_zones(days: i64) -> Result<()> {
    use std::collections::{BTreeMap, BTreeSet};
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;
    let since = (chrono::Utc::now() - chrono::Duration::days(days)).date_naive();

    let bounds = backend::google::health::fetch_points_filtered(
        &http,
        &token,
        "daily-heart-rate-zones",
        &format!("daily_heart_rate_zones.date >= \"{since}\""),
    )
    .await?;
    let intervals = backend::google::health::fetch_points_filtered(
        &http,
        &token,
        "time-in-heart-rate-zone",
        &format!(
            "time_in_heart_rate_zone.interval.start_time >= \"{}T00:00:00Z\"",
            since - chrono::Duration::days(1)
        ),
    )
    .await?;

    let mut vocab: BTreeSet<String> = BTreeSet::new();
    // google side: (date, display zone) -> (min, max, minutes)
    let mut g: BTreeMap<(String, String), (i64, i64, i64)> = BTreeMap::new();
    let mut secs: BTreeMap<(String, String), i64> = BTreeMap::new();
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
        vocab.insert(zt.to_string());
        let Some(zone) = backend::google::sync::zone_display_name(zt) else {
            continue;
        };
        let (Some(cs), Ok(s), Ok(e)) = (
            backend::google::health::wall_clock_from_physical(sp, so),
            chrono::DateTime::parse_from_rfc3339(sp),
            chrono::DateTime::parse_from_rfc3339(ep),
        ) else {
            continue;
        };
        *secs
            .entry((cs[..10].to_string(), zone.to_string()))
            .or_default() += (e - s).num_seconds();
    }
    for pt in &bounds {
        let Some(d) = pt.get("dailyHeartRateZones") else {
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
                    .and_then(backend::google::health::numeric),
                z.get("maxBeatsPerMinute")
                    .and_then(backend::google::health::numeric),
            ) else {
                continue;
            };
            vocab.insert(zt.to_string());
            let Some(zone) = backend::google::sync::zone_display_name(zt) else {
                continue;
            };
            let minutes = secs
                .get(&(date.clone(), zone.to_string()))
                .map(|s| (*s + 30) / 60)
                .unwrap_or(0);
            g.insert(
                (date.clone(), zone.to_string()),
                (min.round() as i64, max.round() as i64, minutes),
            );
        }
    }

    use sqlx::Row as _;
    let rows = sqlx::query(
        "SELECT CAST(date AS CHAR) d, zone_name, CAST(minutes AS CHAR) m,          CAST(min_bpm AS CHAR) mn, CAST(max_bpm AS CHAR) mx, CAST(calories AS CHAR) c          FROM heart_rate_zones WHERE date >= ?",
    )
    .bind(since.to_string())
    .fetch_all(&pool)
    .await
    .context("reading heart_rate_zones")?;
    // Our side of one (date, zone) row: min_bpm, max_bpm, minutes.
    type ZoneRow = (Option<i64>, Option<i64>, Option<i64>);
    let mut o: BTreeMap<(String, String), ZoneRow> = BTreeMap::new();
    let mut ours_calories = 0usize;
    for r in &rows {
        let d: String = r.try_get("d").context("date")?;
        let z: String = r.try_get("zone_name").context("zone")?;
        let num = |k: &str| -> Option<i64> {
            r.try_get::<Option<String>, _>(k)
                .ok()
                .flatten()
                .and_then(|v| v.parse().ok())
        };
        if r.try_get::<Option<String>, _>("c").ok().flatten().is_some() {
            ours_calories += 1;
        }
        o.insert((d, z), (num("mn"), num("mx"), num("m")));
    }

    println!(
        "daily-heart-rate-zones + time-in-heart-rate-zone vs heart_rate_zones — last {days} day(s)"
    );
    println!("  google zone vocabulary seen: {vocab:?}");
    println!(
        "  google {} (date,zone) rows   ours {}   (ours with calories: {ours_calories})",
        g.len(),
        o.len()
    );
    let shared: Vec<_> = g.iter().filter(|(k, _)| o.contains_key(*k)).collect();
    let only_g = g.keys().filter(|k| !o.contains_key(*k)).count();
    let only_o = o.keys().filter(|k| !g.contains_key(*k)).count();
    println!(
        "  shared: {}   only google: {only_g} (GAIN)   only ours: {only_o} (LOSE)",
        shared.len()
    );
    let (mut bounds_ok, mut bounds_bad, mut min_ok, mut min_bad) = (0usize, 0usize, 0usize, 0usize);
    let mut worst_min: Option<(i64, String)> = None;
    for (k, (gmin, gmax, gm)) in &shared {
        let (omin, omax, om) = &o[*k];
        if Some(*gmin) == *omin && Some(*gmax) == *omax {
            bounds_ok += 1;
        } else {
            bounds_bad += 1;
        }
        match om {
            Some(om) => {
                let d = (gm - om).abs();
                if d <= 1 {
                    min_ok += 1;
                } else {
                    min_bad += 1;
                    if worst_min.as_ref().is_none_or(|(w, _)| d > *w) {
                        worst_min = Some((d, format!("{}/{} google {gm} ours {om}", k.0, k.1)));
                    }
                }
            }
            None => min_bad += 1,
        }
    }
    println!("  bounds (min/max bpm): {bounds_ok} agree, {bounds_bad} differ");
    println!("  minutes (±1): {min_ok} agree, {min_bad} differ");
    if let Some((d, w)) = worst_min {
        println!("    worst minutes gap {d} on {w}");
    }
    Ok(())
}

/// Google's step intervals against `steps_intraday`. (#260)
///
/// ⚠ THE INSTRUMENT FOR TWO OPEN QUESTIONS, before any writer exists:
/// interval WIDTH (our rows are per-minute), and DOUBLE-COUNTING (the probe saw
/// a watch device AND a phone package as dataSources). Reports per-source
/// interval-width histograms and per-day sums per source against ours.
///
/// ⚠ READ-ONLY.
pub(crate) async fn google_compare_steps(days: i64) -> Result<()> {
    use std::collections::BTreeMap;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;
    let start = chrono::Utc::now() - chrono::Duration::days(days);
    let filter = format!(
        "steps.interval.start_time >= \"{}\"",
        start.format("%Y-%m-%dT%H:%M:%SZ")
    );
    let points =
        backend::google::health::fetch_points_filtered(&http, &token, "steps", &filter).await?;

    // source label -> (interval-width seconds -> count, civil day -> steps sum,
    //                  minute-aligned count, total intervals)
    struct Src {
        widths: BTreeMap<i64, usize>,
        day_sum: BTreeMap<String, i64>,
        minute_aligned: usize,
        n: usize,
    }
    let mut sources: BTreeMap<String, Src> = BTreeMap::new();
    let mut unreadable = 0usize;
    for pt in &points {
        let label = format!(
            "{}/{}",
            pt.pointer("/dataSource/platform")
                .and_then(|v| v.as_str())
                .unwrap_or("?"),
            pt.pointer("/dataSource/application/packageName")
                .and_then(|v| v.as_str())
                .or_else(|| pt
                    .pointer("/dataSource/device/displayName")
                    .and_then(|v| v.as_str()))
                .unwrap_or("?")
        );
        let Some(st) = pt.get("steps") else {
            unreadable += 1;
            continue;
        };
        let (Some(count), Some(sp), Some(so), Some(ep)) = (
            st.get("count").and_then(backend::google::health::numeric),
            st.pointer("/interval/startTime").and_then(|v| v.as_str()),
            st.pointer("/interval/startUtcOffset")
                .and_then(|v| v.as_str()),
            st.pointer("/interval/endTime").and_then(|v| v.as_str()),
        ) else {
            unreadable += 1;
            continue;
        };
        let (Some(cs), Ok(s), Ok(e)) = (
            backend::google::health::wall_clock_from_physical(sp, so),
            chrono::DateTime::parse_from_rfc3339(sp),
            chrono::DateTime::parse_from_rfc3339(ep),
        ) else {
            unreadable += 1;
            continue;
        };
        let src = sources.entry(label).or_insert_with(|| Src {
            widths: BTreeMap::new(),
            day_sum: BTreeMap::new(),
            minute_aligned: 0,
            n: 0,
        });
        let width = (e - s).num_seconds();
        *src.widths.entry(width).or_default() += 1;
        *src.day_sum.entry(cs[..10].to_string()).or_default() += count.round() as i64;
        if width == 60 && cs.ends_with(":00") {
            src.minute_aligned += 1;
        }
        src.n += 1;
    }

    use sqlx::Row as _;
    let start_s = (start - chrono::Duration::days(1))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let rows = sqlx::query(
        "SELECT CAST(ts AS CHAR) t, CAST(steps AS CHAR) v FROM steps_intraday WHERE ts >= ?",
    )
    .bind(&start_s)
    .fetch_all(&pool)
    .await
    .context("reading steps_intraday")?;
    let mut ours_day: BTreeMap<String, i64> = BTreeMap::new();
    let mut ours_n = 0usize;
    for r in rows {
        let t: String = r.try_get("t").context("ts")?;
        let raw: String = r.try_get("v").context("steps")?;
        *ours_day.entry(t[..10].to_string()).or_default() +=
            raw.parse::<i64>().context("steps not a number")?;
        ours_n += 1;
    }

    println!(
        "steps intervals vs steps_intraday — last {days} day(s): {} google point(s) ({unreadable} unreadable), {} of ours",
        points.len(),
        ours_n
    );

    // ⚠ THE CANDIDATE WRITE RULE, measured before any writer exists. v1 was
    // per-minute MAX across the FITBIT/* sources — REFUTED 2026-09-02, it
    // overcounts (60,732 vs ours 57,480 on shared minutes; worst minute
    // google 82 vs ours 2). v2 is WATCH-FIRST: the device series where the
    // device has the minute, the phone (MobileTrack) only where it does not —
    // which is the shape of the daily deltas (ours ≈ Inspire on worn days to
    // ±dozens, phone filling 08-26's watchless window). HEALTH_CONNECT points
    // stay excluded as echoes with sub-minute widths.
    {
        let mut watch: BTreeMap<String, i64> = BTreeMap::new();
        let mut phone: BTreeMap<String, i64> = BTreeMap::new();
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
            let Some(st) = pt.get("steps") else { continue };
            let (Some(count), Some(sp), Some(so)) = (
                st.get("count").and_then(backend::google::health::numeric),
                st.pointer("/interval/startTime").and_then(|v| v.as_str()),
                st.pointer("/interval/startUtcOffset")
                    .and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            let Some(cs) = backend::google::health::wall_clock_from_physical(sp, so) else {
                continue;
            };
            let minute = cs[..16].to_string();
            let c = count.round() as i64;
            let m = if is_phone { &mut phone } else { &mut watch };
            m.entry(minute)
                .and_modify(|v| *v = (*v).max(c))
                .or_insert(c);
        }
        let mut cand: BTreeMap<String, i64> = watch.clone();
        for (m, c) in &phone {
            cand.entry(m.clone()).or_insert(*c);
        }
        // Ours per minute, over the same wall-clock span the candidate covers.
        let mut ours_min: BTreeMap<String, i64> = BTreeMap::new();
        let rows = sqlx::query(
            "SELECT CAST(ts AS CHAR) t, CAST(steps AS CHAR) v FROM steps_intraday WHERE ts >= ?",
        )
        .bind(&start_s)
        .fetch_all(&pool)
        .await
        .context("re-reading steps_intraday")?;
        for r in rows {
            let t: String = r.try_get("t").context("ts")?;
            let raw: String = r.try_get("v").context("steps")?;
            ours_min.insert(t[..16].to_string(), raw.parse().context("steps")?);
        }
        let span_start = cand.keys().next().cloned();
        let in_span = |k: &String| span_start.as_ref().is_none_or(|s| k >= s);
        let shared: Vec<(&String, i64, i64)> = cand
            .iter()
            .filter_map(|(m, c)| ours_min.get(m).map(|o| (m, *c, *o)))
            .collect();
        let identical = shared.iter().filter(|(_, c, o)| c == o).count();
        let only_c = cand.keys().filter(|m| !ours_min.contains_key(*m)).count();
        let only_o = ours_min
            .keys()
            .filter(|m| in_span(m) && !cand.contains_key(*m))
            .count();
        println!(
            "  CANDIDATE watch-first over FITBIT/*: {} minute(s), shared {}, identical {}/{}",
            cand.len(),
            shared.len(),
            identical,
            shared.len()
        );
        println!(
            "    only candidate: {only_c} (would GAIN)   only ours in span: {only_o} (would LOSE)"
        );
        let mut worst: Option<(i64, String)> = None;
        let mut sum_c = 0i64;
        let mut sum_o = 0i64;
        for (m, c, o) in &shared {
            sum_c += c;
            sum_o += o;
            let d = (c - o).abs();
            if worst.as_ref().is_none_or(|(w, _)| d > *w) {
                worst = Some((d, format!("{m} google {c} ours {o}")));
            }
        }
        println!("    shared-minute sums: candidate {sum_c} vs ours {sum_o}");
        if let Some((d, w)) = worst
            && d > 0
        {
            println!("    worst minute gap {d} at {w}");
        }
    }
    for (label, src) in &sources {
        println!(
            "  source {label}: {} interval(s), {} exactly minute-aligned",
            src.n, src.minute_aligned
        );
        let mut widths: Vec<_> = src.widths.iter().collect();
        widths.sort_by(|a, b| b.1.cmp(a.1));
        let top: Vec<String> = widths
            .iter()
            .take(5)
            .map(|(w, n)| format!("{w}s×{n}"))
            .collect();
        println!(
            "    widths: {}{}",
            top.join("  "),
            if widths.len() > 5 { "  …" } else { "" }
        );
        for (day, sum) in &src.day_sum {
            let o = ours_day.get(day);
            println!(
                "    {day}: google {sum}   ours {}   Δ {}",
                o.map_or("—".to_string(), |v| v.to_string()),
                o.map_or("—".to_string(), |v| (sum - v).to_string())
            );
        }
    }
    Ok(())
}
