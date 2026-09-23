//! Read-only censuses over the database: `freshness`, `tz-census`, `focus-
//! audit`, `zones-census`, `column-fill`, `coverage`.

use anyhow::{Context, Result};
use backend::db;

/// What span of history does each biometric table actually hold? (#260)
///
/// # Why this exists
///
/// The Google Health migration needs to know which rows have a Google source
/// and which do not. `backend google-probe` measured the far side: the watch
/// series there begin 2023-04-16. This measures THIS side, so the two can be
/// compared instead of one being assumed from the other.
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
/// On 2026-08-28 `daily_activity` stopped for over an hour because Fitbit began
/// quoting an integer. `health-sync` exited 0 on every run; the only trace was
/// one ERROR line in a pod log that nothing read. It surfaced because I happened
/// to be watching a deploy for an unrelated reason.
///
/// ⚠ Watching for a known error string would not have caught it, and would not
/// catch the NEXT one either — a stream that writes nothing without erroring
/// looks identical from the outside. This asks the only question that
/// generalises: did rows actually arrive?
///
/// ⚠ **THIS WILL FIRE BY DESIGN IN SEPTEMBER** for every stream still owned by
/// Fitbit — the Web API is decommissioned and they stop. That is a true alarm,
/// not a false one: it is the migration's remaining scope going quiet, and it
/// should be read as "these streams are now gone" rather than muted (#260).
pub(crate) async fn freshness() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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
         UNION ALL SELECT 'steps_intraday', DATEDIFF(CURDATE(), MAX(ts)) FROM steps_intraday",
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

/// Which timezones are actually stored, and could GPS inference have changed
/// them? (#1037)
///
/// `NC_BASE_URL` is unset for health, so `build_tz_source`'s
/// `if let Some(base) = nextcloud_base_url` is false on every run and the
/// forward sync's zone comes from `profile.timezone` alone. The GPS half —
/// nearest fix within 6 h, polygon lookup, the memo — has never executed in
/// production, in either arm.
///
/// ⚠ THE ROWS CANNOT CONFIRM THE BUG AND #1037 SAYS SO: with a fix inside the
/// window the polygon returns the same zone for someone at home, so both paths
/// agree and the column cannot tell them apart. What the rows CAN bound is
/// whether turning it on could matter — a record that only ever held one zone
/// has no travel days in it for the inference to have got right.
pub(crate) async fn tz_census() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // ⚠ One static query, inline: the crate refuses a dynamically built SQL
    // string and dev-lint refuses even a `const` in a variable.
    //
    // ⚠ NO `ORDER BY`, AND THE SORT IS IN RUST. dev-lint's DL-SQLX-SCHEMA-TRUTH
    // resolves every identifier in the statement against the query's tables, and
    // `ORDER BY t, n DESC` names two ALIASES — reported as "column `t` exists in
    // none of this query's table(s)". `coverage()` above has no ORDER BY, which
    // is why it never hit this. Repeating the aliases in each UNION arm does not
    // help; removing the clause does.
    let rows = sqlx::query(
        "SELECT 'steps_intraday' AS t, tz, COUNT(*) AS n, \
          CAST(MIN(DATE(ts)) AS CHAR) AS lo, CAST(MAX(DATE(ts)) AS CHAR) AS hi \
          FROM steps_intraday GROUP BY tz \
         UNION ALL SELECT 'heart_rate_intraday' AS t, tz, COUNT(*) AS n, \
          CAST(MIN(DATE(ts)) AS CHAR) AS lo, CAST(MAX(DATE(ts)) AS CHAR) AS hi \
          FROM heart_rate_intraday GROUP BY tz \
         UNION ALL SELECT 'sleep' AS t, tz, COUNT(*) AS n, \
          CAST(MIN(date) AS CHAR) AS lo, CAST(MAX(date) AS CHAR) AS hi \
          FROM sleep GROUP BY tz",
    )
    .fetch_all(&pool)
    .await
    .context("reading stored timezones")?;

    // Named rather than a tuple: five fields of which three are `Option<String>`
    // is exactly what `clippy::type_complexity` is for, and the names are the
    // difference between reading this and counting positions.
    struct TzRow {
        table: String,
        tz: Option<String>,
        rows: i64,
        lo: Option<String>,
        hi: Option<String>,
    }
    let mut out: Vec<TzRow> = rows
        .iter()
        .map(|row| TzRow {
            table: row.try_get("t").unwrap_or_else(|_| "?".to_string()),
            tz: row.try_get("tz").unwrap_or(None),
            rows: row.try_get("n").unwrap_or(-1),
            lo: row.try_get("lo").unwrap_or(None),
            hi: row.try_get("hi").unwrap_or(None),
        })
        .collect();
    // The sort, in Rust: see the note on the missing ORDER BY above.
    out.sort_by(|a, b| a.table.cmp(&b.table).then(b.rows.cmp(&a.rows)));

    println!("{:<22} {:<28} {:>10}  span", "table", "tz", "rows");
    let mut distinct: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for r in &out {
        if let Some(z) = &r.tz {
            distinct.insert(z.clone());
        }
        println!(
            "{:<22} {:<28} {:>10}  {} → {}",
            r.table,
            r.tz.as_deref().unwrap_or("(NULL)"),
            r.rows,
            r.lo.as_deref().unwrap_or("?"),
            r.hi.as_deref().unwrap_or("?")
        );
    }
    println!(
        "\n{} distinct non-NULL zone(s) across all three: {}",
        distinct.len(),
        distinct.iter().cloned().collect::<Vec<_>>().join(", ")
    );
    // ⚠ A SINGLE ZONE DOES NOT PROVE THE INFERENCE IS POINTLESS, only that it has
    // had nothing to correct in what is stored. A travel day recorded with the
    // HOME zone because the GPS half never ran looks exactly like a day at home.
    if distinct.len() <= 1 {
        println!(
            "  ⚠ one zone only — so enabling GPS inference (#1037) would change nothing \
             ALREADY WRITTEN, and this cannot say what it would do to a future travel day."
        );
    }

    pool.close().await;
    Ok(())
}

/// Has `refresh_focus_places` ever deleted real places? (#1140)
///
/// The bug: a swallowed per-device PhoneTrack failure made `points` a SUBSET,
/// so real places matched nothing and the run's `DELETE FROM focus_places`
/// removed them. The Rust arm refuses on `failed_devices > 0` and is what the
/// cron runs, so the mechanism is closed — but whether it ever FIRED was never
/// measured, and #1140 asks for that before treating it as theoretical.
///
/// ⚠ A RUN THAT LOST ROWS IS INVISIBLE AFTERWARDS. The next good run puts the
/// places back, so the table looks correct. What it cannot put back is the `id`:
/// `AUTO_INCREMENT` never reuses a value, so every row ever deleted leaves a
/// permanent hole in the sequence.
///
/// ⚠ THE ids ARE MEANINGFUL ACROSS RUNS, which is what makes this work at all. A
/// matched place is UPDATEd IN PLACE and keeps its id — deliberately, so a
/// re-mine does not look like a new place. Only unmatched places are DELETEd. So
/// a hole is a place that once existed and was never matched again.
///
///     rows                       what is there now
///     max(id) - min(id) + 1      how many ids were handed out over that span
///     the difference             ids issued to rows that no longer exist
///
/// ⚠ THE DIFFERENCE IS NOT ALL DAMAGE, and reading it as damage would be the
/// error this whole task is about. A place the user genuinely stopped visiting
/// is deleted correctly and leaves the same hole. What the number bounds is the
/// TOTAL deletions ever; a figure near zero would refute the concern outright,
/// and a large one says "look at the shape", not "rows were lost".
pub(crate) async fn focus_audit() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    let r = sqlx::query(
        // ⚠ `CAST(... AS SIGNED)`. `id` is `INT UNSIGNED` and sqlx refuses it as
        // `i64` on a REAL ROW ONLY — the query compiles and the schema check
        // passes ([[reference_sqlx_mysql_type_traps]]).
        "SELECT COUNT(*) AS rows_now, CAST(MIN(id) AS SIGNED) AS lo, CAST(MAX(id) AS SIGNED) AS hi, \
         COUNT(DISTINCT user_id) AS users, \
         CAST(MIN(FROM_UNIXTIME(first_seen_ts)) AS CHAR) AS oldest_seen, \
         CAST(MAX(refreshed_at) AS CHAR) AS last_refresh FROM focus_places",
    )
    .fetch_one(&pool)
    .await
    .context("counting focus_places")?;

    let rows_now: i64 = r.try_get("rows_now").context("rows_now")?;
    if rows_now == 0 {
        println!("focus_places is empty");
        pool.close().await;
        return Ok(());
    }
    let lo: i64 = r.try_get("lo").context("lo")?;
    let hi: i64 = r.try_get("hi").context("hi")?;
    let users: i64 = r.try_get("users").context("users")?;
    let oldest: Option<String> = r.try_get("oldest_seen").unwrap_or(None);
    let refreshed: Option<String> = r.try_get("last_refresh").unwrap_or(None);
    let span = hi - lo + 1;
    println!("focus_places: {rows_now} row(s) for {users} user(s), ids {lo}..{hi} (span {span})");
    println!(
        "  oldest first_seen {}   last refreshed {}",
        oldest.as_deref().unwrap_or("?"),
        refreshed.as_deref().unwrap_or("?")
    );
    println!(
        "  ids issued to rows that are gone: {} — an UPPER BOUND on deletions ever, \
         not a count of losses",
        span - rows_now
    );

    // ⚠ THE SHAPE, NOT THE TOTAL. A place deleted because the user stopped going
    // there leaves one hole wherever it was. A #1140 event deletes MANY AT ONCE
    // and the next run re-inserts them together, so it leaves a RUN of
    // consecutive missing ids followed by a block of consecutive new ones. The
    // gaps are what tell those apart, and only the largest ones are worth eyes.
    let ids = sqlx::query("SELECT CAST(id AS SIGNED) AS id FROM focus_places ORDER BY id")
        .fetch_all(&pool)
        .await
        .context("reading focus_places ids")?;
    let ids: Vec<i64> = ids
        .iter()
        .map(|r| r.try_get::<i64, _>("id").unwrap_or(-1))
        .collect();
    let mut gaps: Vec<(i64, i64)> = Vec::new();
    for w in ids.windows(2) {
        let missing = w[1] - w[0] - 1;
        if missing > 0 {
            gaps.push((missing, w[0] + 1));
        }
    }
    gaps.sort_by_key(|g| std::cmp::Reverse(g.0));
    println!("\n{} gap(s) in the id sequence; largest first:", gaps.len());
    for (n, from) in gaps.iter().take(10) {
        println!("  {n:>4} consecutive id(s) missing from {from}");
    }
    if gaps.len() > 10 {
        println!("  … {} more, all smaller", gaps.len() - 10);
    }

    // ⚠ THIS CANNOT DATE ANYTHING, AND SAYING SO IS THE POINT. The column is
    // `DEFAULT CURRENT_TIMESTAMP` with no `ON UPDATE`, which reads like an
    // insert time — but the writer sets `refreshed_at = CURRENT_TIMESTAMP`
    // EXPLICITLY in its `UPDATE`, so every surviving row carries the LAST RUN's
    // timestamp. It is printed anyway so nobody re-derives that: a single cohort
    // here is the expected output and means only "the last run touched
    // everything", never "everything was created that day". I read it the wrong
    // way round first.
    let cohorts = sqlx::query(
        "SELECT CAST(DATE(refreshed_at) AS CHAR) AS day, COUNT(*) AS n, \
         CAST(MIN(id) AS SIGNED) AS lo, CAST(MAX(id) AS SIGNED) AS hi \
         FROM focus_places GROUP BY DATE(refreshed_at) ORDER BY day",
    )
    .fetch_all(&pool)
    .await
    .context("reading focus_places cohorts")?;
    println!("\nrefreshed_at (LAST refresh, not creation — one cohort is normal):");
    for row in &cohorts {
        let day: Option<String> = row.try_get("day").unwrap_or(None);
        let n: i64 = row.try_get("n").unwrap_or(-1);
        let lo: i64 = row.try_get("lo").unwrap_or(-1);
        let hi: i64 = row.try_get("hi").unwrap_or(-1);
        println!(
            "  {}  {n:>4} row(s)  ids {lo}..{hi}",
            day.as_deref().unwrap_or("?")
        );
    }

    pool.close().await;
    Ok(())
}

/// What shape is `heart_rate_zones` actually in? (#1223)
///
/// ⚠ THE ROW COUNT ALONE CANNOT TELL JUNK FROM DUPLICATION. `backend coverage`
/// read 24,332 rows starting 2010-01-01, where every other biometric table
/// starts 2023-04-01 — but 24,332 over ~1,250 real days is ~19 rows a day and
/// Fitbit reports four or five zones, so the surplus is either dates the watch
/// never saw or a zone axis nobody expected. Those need opposite repairs, and
/// deleting before knowing which would be a guess.
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
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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

    // ⚠ THE OLDEST DATES, not a sample. A sentinel date is at one end by
    // construction, and the question is whether 2010-01-01 is one row or a
    // decade of them — which `LIMIT 20` from the oldest end answers and a
    // random sample cannot.
    // ⚠ `CAST(SUM(...) AS CHAR)`, NOT the bare SUM. `SUM` over INT widens to
    // DECIMAL in MariaDB, which sqlx decodes as neither i64 nor f64
    // ([[reference_sqlx_mysql_type_traps]]) — and the first cut of this read it
    // bare, printed `?` for every row, and left the one number that decides
    // junk-versus-real unreadable. A cast on SOME columns is not a cast.
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

/// Which columns of `daily_activity` actually hold data? (#260)
///
/// ⚠ A COLUMN THAT IS EMPTY NEEDS NO SOURCE, and a column that is nearly empty
/// needs a decision rather than a mapping. `daily_activity` has TWELVE value
/// columns and the migration has to answer for every one of them; without this,
/// "map all twelve" and "map the eight that carry data" look like the same job,
/// and the four empties would be mapped to whatever Google field had a
/// plausible name.
///
/// One query, one row, one COUNT per column — `COUNT(col)` skips NULLs, which is
/// exactly the question. ⚠ Not `COUNT(*)`: that counts rows and would report
/// every column as full.
pub(crate) async fn column_fill() -> Result<()> {
    use sqlx::Row as _;
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    let r = sqlx::query(
        "SELECT COUNT(*) AS rows_total, COUNT(steps) AS steps, \
         COUNT(calories_total) AS calories_total, COUNT(calories_active) AS calories_active, \
         COUNT(distance_km) AS distance_km, COUNT(floors) AS floors, \
         COUNT(elevation_m) AS elevation_m, COUNT(minutes_sedentary) AS minutes_sedentary, \
         COUNT(minutes_lightly_active) AS minutes_lightly_active, \
         COUNT(minutes_fairly_active) AS minutes_fairly_active, \
         COUNT(minutes_very_active) AS minutes_very_active, \
         COUNT(active_score) AS active_score, COUNT(resting_heart_rate) AS resting_heart_rate, \
         CAST(MIN(date) AS CHAR) AS lo, CAST(MAX(date) AS CHAR) AS hi FROM daily_activity",
    )
    .fetch_one(&pool)
    .await
    .context("counting daily_activity columns")?;

    let total: i64 = r.try_get("rows_total").context("rows_total")?;
    let lo: String = r.try_get("lo").context("lo")?;
    let hi: String = r.try_get("hi").context("hi")?;
    println!("daily_activity: {total} rows, {lo} → {hi}");
    for c in [
        "steps",
        "calories_total",
        "calories_active",
        "distance_km",
        "floors",
        "elevation_m",
        "minutes_sedentary",
        "minutes_lightly_active",
        "minutes_fairly_active",
        "minutes_very_active",
        "active_score",
        "resting_heart_rate",
    ] {
        let n: i64 = r.try_get(c).with_context(|| format!("column {c}"))?;
        let note = if n == 0 {
            "  ← EMPTY, needs no source"
        } else if n * 10 < total * 9 {
            "  ← partial"
        } else {
            ""
        };
        println!("  {c:<24} {n:>6} / {total}{note}");
    }
    Ok(())
}

pub(crate) async fn coverage() -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // ⚠ ONE STATIC QUERY, NOT A LOOP OVER A TABLE LIST.
    //
    // Two reasons, and the first is enforced: the crate refuses a dynamically
    // built SQL string (`dynamic SQL strings should be audited for possible
    // injections`), so a `format!`-ed table name will not compile. The second
    // is that the prod tunnel is latency-bound — eleven round trips over it
    // cost far more than eleven arms of one.
    // ⚠ THE LITERAL IS INLINE, not a `const` bound above.
    //
    // Two guards want this and they want slightly different things. The crate
    // refuses a dynamically built SQL string, so a `format!`-ed table name will
    // not compile; dev-lint's DL-SQLX-SCHEMA-TRUTH then refuses even a `const`
    // held in a variable, because schema checking reads the argument at the
    // call site. Inline satisfies both, and one static query is also one round
    // trip — the prod tunnel is latency-bound, so eleven separate reads over it
    // would cost far more than eleven arms of this.
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
