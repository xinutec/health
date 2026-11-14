//! Read-only censuses over the database: `freshness`, `tz-census`, `focus-
//! audit`, `zones-census`, `column-fill`, `coverage`, `owntracks-log`.

use anyhow::{Context, Result};
use backend::db;

/// Did every sync stream's rows actually arrive recently? Fails if one stopped.
///
/// An outcome check, not an error check: a stream can stop with every run
/// exiting 0 and one unread error line in a pod log, and a stream that writes
/// nothing looks the same from outside. `DATEDIFF` in SQL measures against the
/// database's today, and every bound is in days, so a wall-clock table's
/// sub-day offset cannot change the verdict.
pub(crate) async fn freshness() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // `DATEDIFF` in SQL, against the database's today rather than a local clock.
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
    // Non-zero, and the names in the message. A check that reports a problem
    // by printing and exiting 0 is the failure it is meant to detect.
    anyhow::bail!(
        "{} stream(s) not arriving: {}",
        stale.len(),
        stale.join(", ")
    )
}

/// What shape is `heart_rate_zones` in? Rows from 2010 at ~19 a day, against
/// four or five zones and every other table starting 2023, are either dates the
/// watch never saw or an unexpected zone axis, which need opposite repairs.
/// With key `(user_id, date, zone_name)`, `rows / (days × zones × users)` is 1
/// when the table is what its key says. Three literal queries, since the crate
/// refuses dynamic SQL and dev-lint's dl-sqlx-schema-truth a `const` in a
/// variable.
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
    // Say the product out loud. "19 rows a day" is the number that made this
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

    // The oldest dates, not a sample: a sentinel date sits at one end. And
    // `CAST(SUM(...) AS CHAR)`: `SUM` over INT widens to DECIMAL, which sqlx
    // decodes as neither i64 nor f64.
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

    // Where the real data starts, not "zero minutes": a day with no heart rate
    // came back as `Out of Range = 1440`, so every date sums to a full day. A
    // recorded day puts minutes in Fat Burn, Cardio or Peak.
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

/// What span of history does each biometric table hold? Read-only.
///
/// ⚠ `CAST(... AS CHAR)`, always: a bare `MIN(date)` decodes as a temporal type,
/// and MariaDB's DATE/DATETIME mapping fails on real rows in ways an empty table
/// never shows.
pub(crate) async fn coverage() -> Result<()> {
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // One static query, inline: the crate refuses dynamic SQL, dev-lint's
    // dl-sqlx-schema-truth a `const` in a variable, and the prod tunnel is
    // latency-bound, so one query beats eleven.
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
            // An empty table is said out loud. A blank span beside a zero
            // count reads as a failed query.
            (None, _) | (_, None) => println!("{t:<22} {n:>10}  (empty)"),
            (Some(lo), Some(hi)) => println!("{t:<22} {n:>10}  {lo} → {hi}"),
        }
    }
    Ok(())
}

/// The daily-summary series the heart-rate trend reads, `(table, metric
/// column, key)`, each dated in a `date DATE` column. `resp` is Google's daily
/// figure, the deep-sleep rate where there is one; the stage rates are null
/// where Google had none.
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

/// Recent resting HR, HRV and breathing rate, one row per date since `since`.
/// `backend hr-trend [--json] [SINCE]`: a table, or `[{"date", "rhr", "rmssd",
/// "resp", "resp_deep", "resp_light", "resp_rem"}]` with a key only where the
/// table has a row and `null` where it has no value. Read by
/// `~/Code/dicom-scan/refresh_hr_data.py` via `scripts/prod-db.sh`. DECIMAL is
/// read as CHAR (sqlx refuses it on a real row).
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
        // `since` is bound.
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

/// Window means of the same three series, in SQL so they are reproducible.
/// `backend hr-trend --averages <FROM> <BOUNDARY>`: `{"windows", "preop",
/// "postop"}` over `[from, boundary)` and `[boundary, now)`, each `{key: {"avg",
/// "n"}}`; `resp` adds `without_deep`, nights with Google's fallback figure.
/// The dates are the caller's: this repository is public.
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
                // Table and column come from the constant list above; the dates are bound.
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

/// The full HRV and resting-HR history as CSV, `date,hrv,rhr`, ascending; an
/// empty cell is a missing reading, and an RMSSD of 0 counts as missing (a
/// failed reading). `hrv_daily` itself keeps what was recorded.
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

/// The OwnTracks proxy's decisions, newest last, from the table written beside
/// the log line, so they survive a rollout. Every column is cast to CHAR.
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

/// `venue-prior-snapshots <user> <out-dir>`: every prior snapshot as
/// `<as_of>.json` and the current row as `current.json`, which the corpus reads
/// back through `VENUE_PRIORS_DIR` by the serving rule (newest snapshot at or
/// before the day). Prints the anchor, stay count and size per file; a prior
/// holds no place or coordinate.
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

/// Heart rate awake and at rest, one row per local day (`Verified.RestHr`):
/// `backend rest-hr [--json] USER SINCE [UNTIL]` gives the median of settled
/// 5-minute blocks, their 25–75th and 5–95th percentiles and the minutes;
/// `-` without a sleep record or settled rest.
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
    let tz = backend::sync_state::home_tz(&pool, user).await?;
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
