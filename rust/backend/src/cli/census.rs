//! Read-only censuses over the database: `freshness`, `tz-census`, `focus-
//! audit`, `zones-census`, `column-fill`, `coverage`, `owntracks-log`.

use anyhow::{Context, Result};
use backend::db;

/// What span of history does each biometric table actually hold?
///
/// # Why this exists
///
/// The Google Health migration needs to know which rows have a Google source
/// and which do not. `backend google-probe` measures the far side; this
/// measures this side, so the two can be compared instead of one being assumed
/// from the other.
///
/// ⚠ FIVE GOOGLE STREAMS AGREEING ON ONE DATE IS NOT CORROBORATION. It is one
/// observation of one system, and it could as easily be an artefact of how the
/// probe asks as a fact about the data. A backfill sized from it alone would be
/// sized from a single unchecked number.
///
/// ⚠ `CAST(... AS CHAR)`, always. A bare `MIN(date)` decodes as a temporal type
/// and MariaDB's DATE/DATETIME mapping fails on real rows in ways an empty
/// table never shows — the same trap that has bitten DECIMAL and BIGINT
/// UNSIGNED here before. A string crosses cleanly and this is a readout, not
/// arithmetic.
///
/// Read-only: every statement is a SELECT over a fixed table list compiled in.
/// Report any stream that has stopped arriving, and FAIL if one has.
///
/// # Why this is an outcome check and not an error check
///
/// A sync stream can stop for an hour with every run exiting 0 and the only
/// trace one ERROR line in a pod log that nothing reads (Fitbit once began
/// quoting an integer). This asks the outcome question instead.
///
/// ⚠ Watching for a known error string would not have caught it, and would not
/// catch the NEXT one either — a stream that writes nothing without erroring
/// looks identical from the outside. This asks the only question that
/// generalises: did rows actually arrive?
///
/// ⚠ **THIS WILL FIRE BY DESIGN IN SEPTEMBER** for every stream still owned by
/// Fitbit — the Web API is decommissioned and they stop. That is a true alarm,
/// not a false one: it is the migration's remaining scope going quiet, and it
/// should be read as "these streams are now gone" rather than muted.
pub(crate) async fn freshness() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // ⚠ `DATEDIFF` in SQL rather than parsing dates here, so the comparison is
    // against the DATABASE's today. A local clock in another zone would shift
    // every lag by a day.
    //
    // ⚠ The intraday tables store a LOCAL WALL CLOCK, not an instant (see
    // fitbit::sync::hrv) — which is why every bound here is in days, where a
    // sub-day offset cannot change the verdict.
    let rows = sqlx::query(
        "SELECT 'body' AS t, DATEDIFF(CURDATE(), MAX(date)) AS lag FROM body \
         UNION ALL SELECT 'breathing_rate', DATEDIFF(CURDATE(), MAX(date)) FROM breathing_rate \
         UNION ALL SELECT 'hrv_daily', DATEDIFF(CURDATE(), MAX(date)) FROM hrv_daily \
         UNION ALL SELECT 'skin_temperature', DATEDIFF(CURDATE(), MAX(date)) FROM skin_temperature \
         UNION ALL SELECT 'spo2_daily', DATEDIFF(CURDATE(), MAX(date)) FROM spo2_daily \
         UNION ALL SELECT 'daily_activity', DATEDIFF(CURDATE(), MAX(date)) FROM daily_activity \
         UNION ALL SELECT 'daily_activity.steps', \
          DATEDIFF(CURDATE(), MAX(CASE WHEN steps IS NOT NULL THEN date END)) FROM daily_activity \
         UNION ALL SELECT 'sleep', DATEDIFF(CURDATE(), MAX(date)) FROM sleep \
         UNION ALL SELECT 'heart_rate_zones', DATEDIFF(CURDATE(), MAX(date)) FROM heart_rate_zones \
         UNION ALL SELECT 'heart_rate_intraday', DATEDIFF(CURDATE(), MAX(ts)) FROM heart_rate_intraday \
         UNION ALL SELECT 'hrv_intraday', DATEDIFF(CURDATE(), MAX(ts)) FROM hrv_intraday \
         UNION ALL SELECT 'steps_intraday', DATEDIFF(CURDATE(), MAX(ts)) FROM steps_intraday \
         UNION ALL SELECT 'daily_activity.active_minutes', \
          DATEDIFF(CURDATE(), MAX(CASE WHEN minutes_fairly_active IS NOT NULL THEN date END)) \
          FROM daily_activity \
         UNION ALL SELECT 'device_battery_log', DATEDIFF(CURDATE(), MAX(ts_utc)) FROM device_battery_log \
         UNION ALL SELECT 'spo2_intraday', DATEDIFF(CURDATE(), MAX(ts)) FROM spo2_intraday \
         UNION ALL SELECT 'google_points', DATEDIFF(CURDATE(), MAX(start_utc)) FROM google_points \
         UNION ALL SELECT 'exercise_sessions', DATEDIFF(CURDATE(), MAX(start_ts)) FROM exercise_sessions",
    )
    .fetch_all(&pool)
    .await
    .context("reading stream freshness")?;

    let mut stale = Vec::new();
    let mut checked = 0usize;
    for row in &rows {
        let t: String = row.try_get("t").context("table name")?;
        let lag: Option<i64> = row.try_get("lag").unwrap_or(None);
        checked += 1;
        match backend::freshness::stale_reason(&t, lag) {
            Some(why) => {
                println!("  ⚠ {why}");
                stale.push(t);
            }
            None => println!(
                "{t:<22}  ok: {} days behind",
                lag.map_or_else(|| "?".into(), |d| d.to_string())
            ),
        }
    }

    if stale.is_empty() {
        println!("\nall {checked} streams fresh");
        return Ok(());
    }
    // ⚠ NON-ZERO, and the names in the message. A check that reports a problem
    // by printing and exiting 0 is the failure it is meant to detect.
    anyhow::bail!(
        "{} stream(s) not arriving: {}",
        stale.len(),
        stale.join(", ")
    )
}

/// What shape is `heart_rate_zones` actually in?
///
/// ⚠ The row count alone cannot tell junk from duplication: rows starting in
/// 2010 where every other biometric table starts in 2023, at ~19 a day
/// where Fitbit reports four or five zones, are either dates the watch never
/// saw or a zone axis nobody expected. Those need opposite repairs, and deleting
/// before knowing which would be a guess.
///
/// The primary key is `(user_id, date, zone_name)`, so rows ARE distinct
/// triples: `rows / (days x zones x users)` is 1 when the table is exactly what
/// its key says, and anything else names which axis grew.
///
/// Three queries rather than one union, because they have different shapes and
/// the tunnel cost of two extra round trips is far below the cost of reading a
/// column that means something different per arm. ⚠ Each literal is INLINE at
/// its call site: the crate refuses a dynamically built SQL string and
/// dev-lint's DL-SQLX-SCHEMA-TRUTH refuses even a `const` held in a variable.
pub(crate) async fn zones_census() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    let sum = sqlx::query(
        "SELECT COUNT(*) AS rows_total, COUNT(DISTINCT date) AS days, \
         COUNT(DISTINCT zone_name) AS zones, COUNT(DISTINCT user_id) AS users, \
         CAST(MIN(date) AS CHAR) AS lo, CAST(MAX(date) AS CHAR) AS hi \
         FROM heart_rate_zones",
    )
    .fetch_one(&pool)
    .await
    .context("counting heart_rate_zones")?;

    let total: i64 = sum.try_get("rows_total").context("rows_total")?;
    let days: i64 = sum.try_get("days").context("days")?;
    let zones: i64 = sum.try_get("zones").context("zones")?;
    let users: i64 = sum.try_get("users").context("users")?;
    let lo: Option<String> = sum.try_get("lo").unwrap_or(None);
    let hi: Option<String> = sum.try_get("hi").unwrap_or(None);
    let span = match (&lo, &hi) {
        (Some(lo), Some(hi)) => format!("{lo} → {hi}"),
        _ => "(empty)".to_string(),
    };
    println!(
        "heart_rate_zones: {total} rows, {days} distinct dates, {zones} zone names, {users} user(s), {span}"
    );
    // ⚠ SAY THE PRODUCT OUT LOUD. "19 rows a day" is the number that made this
    // look wrong, and it is only wrong against an expected zone count — naming
    // the identity is what turns the surprise into an axis.
    let expect = days.saturating_mul(zones).saturating_mul(users);
    if expect > 0 {
        println!("  dates x zones x users = {expect}, table holds {total}");
    }

    let by_zone = sqlx::query(
        "SELECT zone_name, COUNT(*) AS n, COUNT(DISTINCT date) AS days \
         FROM heart_rate_zones GROUP BY zone_name ORDER BY n DESC",
    )
    .fetch_all(&pool)
    .await
    .context("counting heart_rate_zones by zone")?;
    println!("\nby zone name:");
    for row in &by_zone {
        let z: String = row.try_get("zone_name").context("zone_name")?;
        let n: i64 = row.try_get("n").context("n")?;
        let d: i64 = row.try_get("days").context("days")?;
        println!("  {z:<24} {n:>7} rows over {d} dates");
    }

    // ⚠ The oldest dates, not a sample. A sentinel date is at one end by
    // construction, and the question is whether the earliest date is one row or
    // a decade of them, which `LIMIT 20` from the oldest end answers and a
    // random sample cannot.
    // ⚠ `CAST(SUM(...) AS CHAR)`, not the bare SUM. `SUM` over INT widens to
    // DECIMAL in MariaDB, which sqlx decodes as neither i64 nor f64, leaving the
    // one number that decides junk versus real unreadable. A cast on some
    // columns is not a cast.
    let oldest = sqlx::query(
        "SELECT CAST(date AS CHAR) AS d, COUNT(*) AS n, \
         CAST(SUM(COALESCE(minutes, 0)) AS CHAR) AS total_minutes \
         FROM heart_rate_zones GROUP BY date ORDER BY date LIMIT 20",
    )
    .fetch_all(&pool)
    .await
    .context("reading the oldest heart_rate_zones dates")?;
    println!("\n20 oldest dates:");
    for row in &oldest {
        let d: String = row.try_get("d").context("d")?;
        let n: i64 = row.try_get("n").context("n")?;
        let tm: String = row.try_get("total_minutes").context("total_minutes")?;
        println!("  {d}  {n} rows, {tm} zone-minutes");
    }

    // ⚠ WHERE THE REAL DATA STARTS — and NOT by asking for zero minutes, which
    // was the obvious guess and is wrong. A date with no heart-rate data comes
    // back from Fitbit as `Out of Range = 1440`: the whole day, counted as
    // below the first zone. So every date in the table sums to a full day and
    // "zero minutes" selects nothing. Measured, not assumed — the first cut
    // asked the zero question and got 0 dates back, which reads as "it is all
    // real" and is the opposite of the truth.
    //
    // The discriminator is minutes OUTSIDE `Out of Range`. A day the watch
    // actually recorded puts some minutes in Fat Burn, Cardio or Peak; a
    // synthesised day cannot.
    let bound = sqlx::query(
        "SELECT (SELECT COUNT(*) FROM (SELECT date FROM heart_rate_zones \
           GROUP BY date HAVING SUM(COALESCE(minutes, 0)) = 0) z) AS zero_days, \
         (SELECT COUNT(*) FROM (SELECT date FROM heart_rate_zones GROUP BY date \
           HAVING SUM(CASE WHEN zone_name = 'Out of Range' THEN 0 \
             ELSE COALESCE(minutes, 0) END) = 0) z) AS flat_days, \
         (SELECT CAST(MIN(date) AS CHAR) FROM (SELECT date FROM heart_rate_zones \
           GROUP BY date HAVING SUM(CASE WHEN zone_name = 'Out of Range' THEN 0 \
             ELSE COALESCE(minutes, 0) END) > 0) z) AS first_active",
    )
    .fetch_one(&pool)
    .await
    .context("finding the first active heart_rate_zones date")?;
    let zero_days: i64 = bound.try_get("zero_days").context("zero_days")?;
    let flat_days: i64 = bound.try_get("flat_days").context("flat_days")?;
    let first_active: Option<String> = bound.try_get("first_active").unwrap_or(None);
    println!("\n{zero_days} dates sum to zero minutes across all four zones");
    println!("{flat_days} dates hold NOTHING outside `Out of Range` — no heart rate was recorded");
    println!(
        "first date with minutes in Fat Burn / Cardio / Peak: {}",
        first_active.as_deref().unwrap_or("none")
    );

    pool.close().await;
    Ok(())
}

pub(crate) async fn coverage() -> Result<()> {
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // ⚠ ONE STATIC QUERY, INLINE: not a loop over a table list, and not a
    // `const` bound above.
    //
    // Two guards want this. The crate refuses a dynamically built SQL string, so
    // a `format!`-ed table name will not compile; dev-lint's DL-SQLX-SCHEMA-TRUTH
    // then refuses even a `const` held in a variable, because schema checking
    // reads the argument at the call site. And the prod tunnel is latency-bound:
    // eleven separate reads over it would cost far more than eleven arms of one.
    let rows = sqlx::query(
        "\
         SELECT 'body' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM body \
         UNION ALL SELECT 'breathing_rate' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM breathing_rate \
         UNION ALL SELECT 'daily_activity' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM daily_activity \
         UNION ALL SELECT 'heart_rate_zones' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM heart_rate_zones \
         UNION ALL SELECT 'hrv_daily' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM hrv_daily \
         UNION ALL SELECT 'skin_temperature' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM skin_temperature \
         UNION ALL SELECT 'sleep' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM sleep \
         UNION ALL SELECT 'spo2_daily' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM spo2_daily \
         UNION ALL SELECT 'heart_rate_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM heart_rate_intraday \
         UNION ALL SELECT 'hrv_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM hrv_intraday \
         UNION ALL SELECT 'steps_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM steps_intraday \
         ",
    )
    .fetch_all(&pool)
    .await
    .context("reading table coverage")?;

    println!("{:<22} {:>10}  earliest → latest", "table", "rows");
    for row in rows {
        use sqlx::Row as _;
        let t: String = row.try_get("t").unwrap_or_else(|_| "?".into());
        let n: i64 = row.try_get("n").unwrap_or(-1);
        let lo: Option<String> = row.try_get("lo").unwrap_or(None);
        let hi: Option<String> = row.try_get("hi").unwrap_or(None);
        match (lo, hi) {
            // ⚠ An empty table is said out loud. A blank span beside a zero
            // count reads as a failed query.
            (None, _) | (_, None) => println!("{t:<22} {n:>10}  (empty)"),
            (Some(lo), Some(hi)) => println!("{t:<22} {n:>10}  {lo} → {hi}"),
        }
    }
    Ok(())
}

/// The daily-summary series the heart-rate trend reads: `(table, metric
/// column, key)`. Every table dates its rows in a `date DATE` column.
///
/// `resp` is Google's daily figure, which is the deep-sleep rate when there is
/// one (see `google::sync::sync_breathing_rate`); the three stage rates beside
/// it are null where Google had no reading for that stage.
const HR_TREND_SOURCES: [(&str, &str, &str); 6] = [
    ("daily_activity", "resting_heart_rate", "rhr"),
    ("hrv_daily", "daily_rmssd", "rmssd"),
    ("breathing_rate", "full_sleep_rate", "resp"),
    ("breathing_rate", "deep_sleep_rate", "resp_deep"),
    ("breathing_rate", "light_sleep_rate", "resp_light"),
    ("breathing_rate", "rem_sleep_rate", "resp_rem"),
];

fn is_iso_date(s: &str) -> bool {
    s.len() == 10
        && s.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// Recent resting HR / HRV / breathing rate, one row per date since `since`.
///
/// `backend hr-trend [--json] [SINCE]`: a table, or with `--json` the array
/// `[{"date", "rhr", "rmssd", "resp", "resp_deep", "resp_light", "resp_rem"}]`, a key present only where that table
/// has a row for the day, `null` where the row holds no value.
/// `~/Code/dicom-scan/refresh_hr_data.py` reads it through `scripts/prod-db.sh`.
///
/// ⚠ DECIMAL columns are read as CHAR and parsed here — sqlx refuses them on a
/// real row ([[reference_sqlx_mysql_type_traps]]).
pub(crate) async fn hr_trend(since: &str, json: bool) -> Result<()> {
    use sqlx::Row as _;
    if !is_iso_date(since) {
        anyhow::bail!("SINCE must be YYYY-MM-DD, got {since:?}");
    }
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let mut by_date: std::collections::BTreeMap<
        String,
        serde_json::Map<String, serde_json::Value>,
    > = Default::default();
    for (table, metric, key) in HR_TREND_SOURCES {
        // `AssertSqlSafe`: the table and column are constants from `HR_TREND_SOURCES`;
        // `since` is BOUND.
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, CAST({metric} AS CHAR) AS v              FROM {table} WHERE date >= ? ORDER BY d"
        )))
        .bind(since)
        .fetch_all(&pool)
        .await
        .with_context(|| format!("reading {table}.{metric}"))?;
        for r in &rows {
            let d: String = r.get("d");
            let v: Option<String> = r.get("v");
            let v = v
                .and_then(|s| s.parse::<f64>().ok())
                .map_or(serde_json::Value::Null, |n| serde_json::json!(n));
            let e = by_date.entry(d.clone()).or_default();
            e.insert("date".into(), serde_json::json!(d));
            e.insert(key.into(), v);
        }
    }
    pool.close().await;
    let out: Vec<serde_json::Value> = by_date
        .into_values()
        .map(serde_json::Value::Object)
        .collect();
    if json {
        println!("{}", serde_json::to_string(&out)?);
        return Ok(());
    }
    println!("date        RHR   RMSSD  resp  deep light   rem");
    let cell = |o: &serde_json::Value, k: &str| match o.get(k).and_then(serde_json::Value::as_f64) {
        Some(n) => format!("{n:>5}"),
        None => "  -  ".to_string(),
    };
    for o in &out {
        println!(
            "{}  {} {} {} {} {} {}",
            o["date"].as_str().unwrap_or("-"),
            cell(o, "rhr"),
            cell(o, "rmssd"),
            cell(o, "resp"),
            cell(o, "resp_deep"),
            cell(o, "resp_light"),
            cell(o, "resp_rem")
        );
    }
    Ok(())
}

/// Window means of the same three series, computed in SQL so they are
/// reproducible rather than hand-tallied.
///
/// `backend hr-trend --averages <FROM> <BOUNDARY>` — `{"windows", "preop",
/// "postop"}` where `preop` covers `[FROM, BOUNDARY)` and `postop`
/// `[BOUNDARY, now)`, each `{key: {"avg", "n"}}`. `resp` also carries
/// `without_deep`: how many of its `n` nights had no deep-sleep reading, so
/// their figure is Google's fallback rather than the deep-sleep rate.
/// The dates are the CALLER's:
/// this repository is public, and which day divides the two windows belongs
/// to the case file that asks, not here.
pub(crate) async fn hr_trend_averages(from: &str, boundary: &str) -> Result<()> {
    use sqlx::Row as _;
    if !is_iso_date(from) || !is_iso_date(boundary) {
        anyhow::bail!("windows are YYYY-MM-DD, got {from:?} and {boundary:?}");
    }
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let group = |lo: &str, hi: Option<&str>| {
        let lo = lo.to_string();
        let hi = hi.map(str::to_string);
        let pool = pool.clone();
        async move {
            let mut o = serde_json::Map::new();
            for (table, metric, key) in HR_TREND_SOURCES {
                let sql = match &hi {
                    Some(_) => format!(
                        "SELECT CAST(AVG({metric}) AS CHAR) AS a, CAST(COUNT({metric}) AS CHAR) AS n                          FROM {table} WHERE date >= ? AND date < ?"
                    ),
                    None => format!(
                        "SELECT CAST(AVG({metric}) AS CHAR) AS a, CAST(COUNT({metric}) AS CHAR) AS n                          FROM {table} WHERE date >= ?"
                    ),
                };
                // Table and column come from the constant list above; the dates are BOUND.
                let mut q = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(lo.clone());
                if let Some(h) = &hi {
                    q = q.bind(h.clone());
                }
                let r = q
                    .fetch_one(&pool)
                    .await
                    .with_context(|| format!("averaging {table}.{metric}"))?;
                let a: Option<String> = r.get("a");
                let n: String = r.get("n");
                o.insert(
                    key.into(),
                    serde_json::json!({
                        "avg": a.and_then(|s| s.parse::<f64>().ok()),
                        "n": n.parse::<u64>().unwrap_or(0),
                    }),
                );
            }
            let sql = match &hi {
                Some(_) => {
                    "SELECT CAST(COUNT(*) AS CHAR) AS n FROM breathing_rate \
                     WHERE full_sleep_rate IS NOT NULL AND deep_sleep_rate IS NULL \
                     AND date >= ? AND date < ?"
                }
                None => {
                    "SELECT CAST(COUNT(*) AS CHAR) AS n FROM breathing_rate \
                     WHERE full_sleep_rate IS NOT NULL AND deep_sleep_rate IS NULL \
                     AND date >= ?"
                }
            };
            let mut q = sqlx::query(sql).bind(lo.clone());
            if let Some(h) = &hi {
                q = q.bind(h.clone());
            }
            let n: String = q
                .fetch_one(&pool)
                .await
                .context("counting nights without a deep-sleep reading")?
                .get("n");
            if let Some(resp) = o.get_mut("resp").and_then(serde_json::Value::as_object_mut) {
                resp.insert(
                    "without_deep".into(),
                    serde_json::json!(n.parse::<u64>().unwrap_or(0)),
                );
            }
            Ok::<_, anyhow::Error>(serde_json::Value::Object(o))
        }
    };
    let preop = group(from, Some(boundary)).await?;
    let postop = group(boundary, None).await?;
    pool.close().await;
    println!(
        "{}",
        serde_json::json!({
            "windows": { "preop": [from, boundary], "postop": [boundary, "now"] },
            "preop": preop,
            "postop": postop,
        })
    );
    Ok(())
}

/// The full HRV + resting-HR history as CSV, `date,hrv,rhr`, one row per day
/// present in either table, ascending; an empty cell is a missing reading.
///
/// `backend hrv-history` backs the long-term chart in the case file. ⚠ A
/// recorded zero counts as missing: an RMSSD of 0 ms is a failed reading, not a
/// measurement. Dropped here and not at ingest: `hrv_daily` keeps what Fitbit
/// recorded, verbatim.
pub(crate) async fn hrv_history() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let mut by_date: std::collections::BTreeMap<String, (Option<f64>, Option<f64>)> =
        Default::default();
    for (table, metric, is_hrv) in [
        ("hrv_daily", "daily_rmssd", true),
        ("daily_activity", "resting_heart_rate", false),
    ] {
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, CAST({metric} AS CHAR) AS v FROM {table} ORDER BY d"
        )))
        .fetch_all(&pool)
        .await
        .with_context(|| format!("reading {table}.{metric}"))?;
        for r in &rows {
            let d: String = r.get("d");
            let v: Option<String> = r.get("v");
            let v = v.and_then(|s| s.parse::<f64>().ok()).filter(|n| *n > 0.0);
            let e = by_date.entry(d).or_default();
            if is_hrv {
                e.0 = v;
            } else {
                e.1 = v;
            }
        }
    }
    pool.close().await;
    let cell = |v: Option<f64>| v.map(|n| n.to_string()).unwrap_or_default();
    println!("date,hrv,rhr");
    for (d, (hrv, rhr)) in &by_date {
        println!("{d},{},{}", cell(*hrv), cell(*rhr));
    }
    Ok(())
}

/// The OwnTracks proxy's decisions, newest last.
///
/// The same fields as the `owntracks …` log line, read from the table the
/// route writes beside it, so the answer survives a rollout. ⚠ `CAST(... AS
/// CHAR)` on every column: this is a readout, and a TINYINT or an unsigned
/// INT decoding as a Rust integer fails on real rows in ways an empty table
/// never shows.
pub(crate) async fn owntracks_log(user: &str, limit: i64) -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let rows = sqlx::query(
        "SELECT CAST(ts AS CHAR) AS ts, CAST(fixes AS CHAR) AS fixes, \
                CAST(local_hour AS CHAR) AS local_hour, CAST(phone_mode AS CHAR) AS phone_mode, \
                prev_profile, profile, CAST(monitoring AS CHAR) AS monitoring, \
                CAST(interval_s AS CHAR) AS interval_s, CAST(recorded_at AS CHAR) AS recorded_at \
         FROM (SELECT * FROM owntracks_decisions WHERE user_id = ? ORDER BY id DESC LIMIT ?) d \
         ORDER BY id ASC",
    )
    .bind(user)
    .bind(limit)
    .fetch_all(&pool)
    .await
    .context("reading owntracks_decisions")?;
    pool.close().await;
    let dash = |v: Option<String>| v.unwrap_or_else(|| "-".to_string());
    println!(
        "recorded_at          ts          hist hour phone prev->profile          monitoring interval"
    );
    for r in &rows {
        println!(
            "{:<20} {:<11} {:>4} {:>4} {:>5} {:<22} {:>10} {:>8}",
            r.get::<String, _>("recorded_at"),
            r.get::<String, _>("ts"),
            r.get::<String, _>("fixes"),
            dash(r.get::<Option<String>, _>("local_hour")),
            dash(r.get::<Option<String>, _>("phone_mode")),
            format!(
                "{}->{}",
                dash(r.get::<Option<String>, _>("prev_profile")),
                r.get::<String, _>("profile")
            ),
            r.get::<String, _>("monitoring"),
            dash(r.get::<Option<String>, _>("interval_s")),
        );
    }
    eprintln!("{} row(s)", rows.len());
    Ok(())
}

/// `venue-prior-snapshots <user> <out-dir>`: every `venue_type_prior_snapshots`
/// row as `<as_of>.json`, and the current `venue_type_priors` row as
/// `current.json` — the inputs the serving path resolves `venuePriors` from
/// (`classification_inputs::venue_priors`: the newest snapshot at or before the
/// day, else the current row). Read-only. The corpus harness reads the directory
/// back through `VENUE_PRIORS_DIR` and resolves per fixture date by the same
/// rule, so a replay under it names a day the way the pod does.
///
/// Prints one line per file: the anchor, the mined stay count and the size.
/// A prior is subtype statistics — no place, no coordinate.
pub(crate) async fn venue_prior_snapshots(user: &str, out_dir: &str) -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    std::fs::create_dir_all(out_dir).with_context(|| format!("creating {out_dir}"))?;

    let rows = sqlx::query(
        "SELECT CAST(as_of AS CHAR) AS as_of, priors_json, mined_stays \
         FROM venue_type_prior_snapshots WHERE user_id = ? ORDER BY as_of",
    )
    .bind(user)
    .fetch_all(&pool)
    .await
    .context("reading venue_type_prior_snapshots")?;
    for r in &rows {
        let as_of: String = r.try_get("as_of").context("as_of")?;
        let blob: String = r.try_get("priors_json").context("priors_json")?;
        let mined: i64 = r.try_get("mined_stays").context("mined_stays")?;
        let path = format!("{out_dir}/{as_of}.json");
        std::fs::write(&path, &blob).with_context(|| format!("writing {path}"))?;
        println!("{as_of}  {mined:>5} stay(s)  {:>7} bytes", blob.len());
    }
    let current = sqlx::query("SELECT priors_json FROM venue_type_priors WHERE user_id = ?")
        .bind(user)
        .fetch_optional(&pool)
        .await
        .context("reading venue_type_priors")?;
    match current {
        Some(r) => {
            let blob: String = r.try_get("priors_json").context("priors_json")?;
            let path = format!("{out_dir}/current.json");
            std::fs::write(&path, &blob).with_context(|| format!("writing {path}"))?;
            println!(
                "current     {:>13} bytes  (the fall-through for a day before the first snapshot)",
                blob.len()
            );
        }
        None => println!("current     (no venue_type_priors row)"),
    }
    println!("{} snapshot(s) -> {out_dir}", rows.len());
    pool.close().await;
    Ok(())
}

/// Heart rate awake and at rest, one row per day (`Verified.RestHr`).
///
/// `backend rest-hr [--json] USER SINCE [UNTIL]` — per local day (the user's
/// home zone): the median of the settled 5-minute blocks, their 25th–75th and
/// 5th–95th percentiles, and the minutes behind it; `-` where the day has no
/// sleep record or no settled rest. `--json` prints the array
/// `[{"date", "median", "p25", "p75", "p05", "p95", "restMinutes"}]`.
pub(crate) async fn rest_hr(
    user: &str,
    since: &str,
    until: Option<&str>,
    json: bool,
) -> Result<()> {
    if !is_iso_date(since) || until.is_some_and(|u| !is_iso_date(u)) {
        anyhow::bail!("dates must be YYYY-MM-DD");
    }
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let tz = backend::rest_hr::home_tz(&pool, user).await?;
    let first = chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d")?;
    let last = match until {
        Some(u) => chrono::NaiveDate::parse_from_str(u, "%Y-%m-%d")?,
        None => chrono::Utc::now().date_naive() - chrono::Duration::days(1),
    };
    let out = backend::rest_hr::days(&pool, user, first, last, &tz).await?;
    pool.close().await;
    if json {
        println!("{}", serde_json::to_string(&out)?);
        return Ok(());
    }
    println!("date        median   p25   p75    p5   p95  minutes");
    let cell = |o: &serde_json::Value, k: &str| match o.get(k).and_then(serde_json::Value::as_f64) {
        Some(n) => format!("{n:>5.1}"),
        None => "    -".to_string(),
    };
    for o in &out {
        println!(
            "{}  {}  {} {} {} {}  {:>7}",
            o["date"].as_str().unwrap_or("-"),
            cell(o, "median"),
            cell(o, "p25"),
            cell(o, "p75"),
            cell(o, "p05"),
            cell(o, "p95"),
            o.get("restMinutes")
                .and_then(serde_json::Value::as_u64)
                .map_or("-".to_string(), |n| n.to_string())
        );
    }
    Ok(())
}
