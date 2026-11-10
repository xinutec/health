//! The day's inputs, read from the database and PhoneTrack.
//!
//! The output is a `serde_json::Value`, not a struct: it is the fixture's
//! `inputs` block, so field order and number rendering are part of the
//! contract (`serde_json` keeps insertion order).
//!
//! Numbers render as JS renders them ([`js_num`]: `25`, never `25.0`), and
//! every numeric read refuses a value it cannot decode ([`num`]) rather than
//! defaulting: a defaulted centroid is a plausible wrong place.

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use sqlx::{MySqlPool, Row};

/// A numeric column as `f64`, however the driver hands it over: float,
/// integer, unsigned, or a numeric string. Anything else is an error, never a
/// default.
///
/// DECIMAL columns are cast to CHAR in the SQL and parsed here: sqlx cannot
/// decode a DECIMAL without the `rust_decimal` feature, and a correctly rounded
/// `parse::<f64>` yields the double the text denotes.
fn num(row: &sqlx::mysql::MySqlRow, col: &str) -> Result<f64> {
    if let Ok(v) = row.try_get::<f64, _>(col) {
        return Ok(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(col) {
        return Ok(v as f64);
    }
    // `focus_places.id` is an unsigned BIGINT, a distinct sqlx type.
    if let Ok(v) = row.try_get::<u64, _>(col) {
        return Ok(v as f64);
    }
    let raw: String = row
        .try_get::<String, _>(col)
        .with_context(|| format!("{col} is not a float, an integer, an unsigned, or a string"))?;
    raw.parse::<f64>()
        .with_context(|| format!("{col} came back as {raw:?}, which is not a number"))
}

/// The same, for a column that may be NULL. `None` stays `None`; a value that
/// will not decode is still an error.
fn num_opt(row: &sqlx::mysql::MySqlRow, col: &str) -> Result<Option<f64>> {
    if let Ok(v) = row.try_get::<Option<f64>, _>(col) {
        return Ok(v);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(col) {
        return Ok(v.map(|x| x as f64));
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(col) {
        return Ok(v.map(|x| x as f64));
    }
    match row.try_get::<Option<String>, _>(col) {
        Ok(None) => Ok(None),
        Ok(Some(raw)) => raw
            .parse::<f64>()
            .map(Some)
            .with_context(|| format!("{col} came back as {raw:?}, which is not a number")),
        Err(e) => Err(anyhow::Error::new(e).context(format!("decoding {col}"))),
    }
}

/// A `f64` rendered as `JSON.stringify` renders a JS number: an integral value
/// without a fraction (`25`, not `25.0`). Not a cast: most values here are
/// genuinely fractional.
pub fn js_num(v: f64) -> Value {
    // Within i64's range an integral f64 converts exactly; beyond it, and for
    // NaN or an infinity, `as i64` would saturate, so those stay floats.
    if v.fract() == 0.0
        && v.is_finite()
        && (-9.223_372_036_854_776e18..=9.223_372_036_854_776e18).contains(&v)
    {
        json!(v as i64)
    } else {
        json!(v)
    }
}

/// `num_opt` rendered as JSON — `null` stays null rather than becoming zero.
fn num_json(row: &sqlx::mysql::MySqlRow, col: &str) -> Result<Value> {
    Ok(num_opt(row, col)?.map_or(Value::Null, js_num))
}

/// `focus_places`, as the place snapper and picker read them. `hour_profile`
/// is comma-separated per-mille integers ([`parse_hour_profile`]).
pub async fn known_places(pool: &MySqlPool, user_id: &str) -> Result<Value> {
    let rows = sqlx::query(
        "SELECT id, CAST(centroid_lat AS CHAR) AS centroid_lat, \
         CAST(centroid_lon AS CHAR) AS centroid_lon, radius_m, display_name, sleep_hours, \
         amenity_label, unique_days, hour_profile, total_dwell_sec, visit_count \
         FROM focus_places WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading focus_places for {user_id}"))?;

    // Every numeric is required: a centroid of 0.0 is a real place, in the Gulf
    // of Guinea.
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(json!({
            "id": num(r, "id")? as i64,
            "centroidLat": js_num(num(r, "centroid_lat")?),
            "centroidLon": js_num(num(r, "centroid_lon")?),
            "radiusM": js_num(num(r, "radius_m")?),
            "displayName": r.try_get::<Option<String>, _>("display_name").context("display_name")?,
            // An unmined row has no sleep evidence: zero hours.
            "sleepHours": js_num(num_opt(r, "sleep_hours")?.unwrap_or(0.0)),
            "amenityLabel": r.try_get::<Option<String>, _>("amenity_label").context("amenity_label")?,
            "uniqueDays": num_opt(r, "unique_days")?.map(|v| v as i64),
            "hourProfile": parse_hour_profile(
                r.try_get::<Option<String>, _>("hour_profile").context("hour_profile")?.as_deref(),
            ),
            "totalDwellSec": js_num(num(r, "total_dwell_sec")?),
            "visitCount": num_opt(r, "visit_count")?.map(|v| v as i64),
        }));
    }
    Ok(Value::Array(out))
}

/// A stored hour profile as 24 fractions, or `null` when it cannot be read.
///
/// The column holds per-mille integers joined by commas (`59,58,56,…`), not
/// JSON. `null` means "no time-of-day signal"; an empty array would instead
/// claim every hour is equally unlikely. A wrong length is rejected whole, and
/// an empty bucket reads as 0.
pub fn parse_hour_profile(raw: Option<&str>) -> Value {
    let Some(s) = raw.filter(|s| !s.is_empty()) else {
        // A row mined before the column existed has nothing to say.
        return Value::Null;
    };
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != HOUR_BUCKETS {
        tracing::warn!(
            "focus_places.hour_profile has {} bucket(s), not {HOUR_BUCKETS} — ignoring it",
            parts.len()
        );
        return Value::Null;
    }
    let mut out = Vec::with_capacity(HOUR_BUCKETS);
    for p in parts {
        let t = p.trim();
        let n = if t.is_empty() {
            0.0
        } else {
            match t.parse::<f64>() {
                Ok(v) if !v.is_nan() => v,
                _ => {
                    tracing::warn!(
                        "focus_places.hour_profile has a non-numeric bucket {p:?} — ignoring it"
                    );
                    return Value::Null;
                }
            }
        };
        // `js_num`: a zero bucket renders as `0`.
        out.push(js_num(n / 1000.0));
    }
    Value::Array(out)
}

/// Hours in a day, and the length a stored profile must have.
const HOUR_BUCKETS: usize = 24;

/// The instant the step stream is complete to (Unix seconds): the watch's last
/// sync, from `device_battery_log.ts_utc`. A later minute with no step row is
/// not synced yet, not still. `null` when no row carries it.
pub async fn steps_through(pool: &MySqlPool, user_id: &str) -> Result<Value> {
    let newest: Option<String> = sqlx::query_scalar(
        "SELECT CAST(MAX(ts_utc) AS CHAR) FROM device_battery_log WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .with_context(|| format!("reading the newest watch sync for {user_id}"))?;
    Ok(match newest {
        Some(ts) => {
            let t = chrono::NaiveDateTime::parse_from_str(&ts, "%Y-%m-%d %H:%M:%S")
                .with_context(|| format!("unreadable watch sync instant {ts:?}"))?;
            json!(t.and_utc().timestamp())
        }
        None => Value::Null,
    })
}

/// `mode_biometrics`: the per-mode signatures the cadence and speed scorers
/// read. A statistic without samples stays null, not zero.
pub async fn mode_biometrics(pool: &MySqlPool, user_id: &str) -> Result<Value> {
    let rows = sqlx::query(
        "SELECT mode, CAST(hr_mean AS CHAR) AS hr_mean, CAST(hr_std AS CHAR) AS hr_std, \
         hr_sample_count, CAST(cadence_mean AS CHAR) AS cadence_mean, \
         CAST(cadence_std AS CHAR) AS cadence_std, cadence_sample_count, \
         CAST(speed_mean AS CHAR) AS speed_mean, CAST(speed_std AS CHAR) AS speed_std, \
         speed_sample_count, sample_count FROM mode_biometrics WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading mode_biometrics for {user_id}"))?;

    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(json!({
                // A MySQL ENUM, read as a plain string.
            "mode": r.try_get::<String, _>("mode").context("mode")?,
            "hrMean": num_json(r, "hr_mean")?,
            "hrStd": num_json(r, "hr_std")?,
            "hrSampleCount": num_opt(r, "hr_sample_count")?.map(|v| v as i64),
            "cadenceMean": num_json(r, "cadence_mean")?,
            "cadenceStd": num_json(r, "cadence_std")?,
            "cadenceSampleCount": num_opt(r, "cadence_sample_count")?.map(|v| v as i64),
            "speedMean": num_json(r, "speed_mean")?,
            "speedStd": num_json(r, "speed_std")?,
            "speedSampleCount": num_opt(r, "speed_sample_count")?.map(|v| v as i64),
            "sampleCount": num_opt(r, "sample_count")?.map(|v| v as i64),
        }));
    }
    Ok(Value::Array(out))
}

/// The mined venue-type priors as of the day served, or `null`. A blob that
/// does not parse is `null` with a warning: priors are evidence, and losing
/// them must not fail the day.
pub async fn venue_priors(pool: &MySqlPool, user_id: &str, as_of_unix: i64) -> Result<Value> {
    // The newest snapshot at or before the day, else the current row. Never a
    // later snapshot: that would score a day with evidence mined after it.
    let snap = sqlx::query(
        "SELECT priors_json, as_of FROM venue_type_prior_snapshots \
         WHERE user_id = ? AND as_of <= FROM_UNIXTIME(?) \
         ORDER BY as_of DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(as_of_unix)
    .fetch_optional(pool)
    .await
    .with_context(|| format!("reading venue_type_prior_snapshots for {user_id}"))?;
    let row = match snap {
        Some(r) => Some(r),
        None => sqlx::query("SELECT priors_json FROM venue_type_priors WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .with_context(|| format!("reading venue_type_priors for {user_id}"))?,
    };
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let raw: String = row
        .try_get("priors_json")
        .context("decoding venue_type_priors.priors_json")?;
    // Warned, not silent: a scorer missing its priors should be visible.
    let blob = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                "venue_type_priors blob for {user_id} did not parse ({e}) — treating as no evidence"
            );
            return Ok(Value::Null);
        }
    };
    Ok(as_of(blob, user_id, as_of_unix))
}

/// Re-aggregate the blob's evidence as of the end of the day served. A blob
/// that carries no `events` has only the aggregate and is served as-is, with a
/// log line.
fn as_of(blob: Value, user_id: &str, as_of_unix: i64) -> Value {
    let Some(events) = blob.get("events") else {
        tracing::info!(
            "venue_type_priors for {user_id} predates the event log — serving the \
             aggregate, so this day is scored against the prior as mined, not as of itself"
        );
        return blob;
    };
    let events: Vec<crate::lean::WirePriorEvent> = match serde_json::from_value(events.clone()) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("venue_type_priors events for {user_id} did not parse ({e})");
            return blob;
        }
    };
    match crate::lean::priors_as_of(&events, as_of_unix) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("priorsAsOf failed for {user_id} ({e}) — serving the aggregate");
            blob
        }
    }
}

/// The whole `rail_route_cache`. Global, not user-scoped, and small enough to
/// load eagerly — the day looks routes up in memory and ignores the rest.
pub async fn rail_route_cache(pool: &MySqlPool) -> Result<Value> {
    let rows = sqlx::query("SELECT route_key, geometry_json FROM rail_route_cache")
        .fetch_all(pool)
        .await
        .context("reading rail_route_cache")?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "routeKey": r.try_get::<String, _>("route_key").unwrap_or_default(),
                "geometryJson": r.try_get::<String, _>("geometry_json").unwrap_or_default(),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

/// The day's `motion_log` rows: per-fix heading, velocity and accuracy.
/// Half-open on the end, so the day's last second is not also the next day's.
pub async fn motion_log(
    pool: &MySqlPool,
    user_id: &str,
    start_utc: i64,
    end_utc: i64,
) -> Result<Value> {
    let rows = sqlx::query(
        "SELECT ts, CAST(lat AS CHAR) AS lat, CAST(lon AS CHAR) AS lon, cog, vel, acc \
         FROM motion_log WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts",
    )
    .bind(user_id)
    .bind(start_utc)
    .bind(end_utc)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading motion_log for {user_id} in [{start_utc}, {end_utc})"))?;

    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(json!({
            "ts": num(r, "ts")? as i64,
            "lat": js_num(num(r, "lat")?),
            "lon": js_num(num(r, "lon")?),
            "cogDeg": num_json(r, "cog")?,
            "velKmh": num_json(r, "vel")?,
            "accM": num_json(r, "acc")?,
        }));
    }
    Ok(Value::Array(out))
}

/// `bus_route_cache`, every mirrored OSM bus route. A malformed row is dropped:
/// bus naming is additive evidence, so a corrupt row costs a label, never the
/// day.
pub async fn bus_route_cache(pool: &MySqlPool) -> Result<Value> {
    let rows = sqlx::query(
        "SELECT osm_relation_id, route_ref, route_name, stops_json FROM bus_route_cache",
    )
    .fetch_all(pool)
    .await
    .context("reading bus_route_cache")?;
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        let Some(stops) = stops_array(r, "stops_json") else {
            continue;
        };
        out.push(json!({
            "routeRef": r.try_get::<String, _>("route_ref").context("route_ref")?,
            "routeName": r.try_get::<Option<String>, _>("route_name").context("route_name")?,
            // BIGINT as i64, so it renders `8336`, not `8336.0`.
            "osmRelationId": num(r, "osm_relation_id")? as i64,
            "stops": stops,
        }));
    }
    Ok(Value::Array(out))
}

/// `rail_stops_cache`: each mirrored rail service's ordered stops, the stations
/// it calls at. Same drop rule as `bus_route_cache`.
pub async fn rail_stops_cache(pool: &MySqlPool) -> Result<Value> {
    let rows = sqlx::query(
        "SELECT osm_relation_id, route_type, line_ref, line_name, stops_json \
         FROM rail_stops_cache",
    )
    .fetch_all(pool)
    .await
    .context("reading rail_stops_cache")?;
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        let Some(stops) = stops_array(r, "stops_json") else {
            continue;
        };
        out.push(json!({
            // `as i64` for the same reason as the bus mirror above.
            "osmRelationId": num(r, "osm_relation_id")? as i64,
            "routeType": r.try_get::<String, _>("route_type").context("route_type")?,
            "lineRef": r.try_get::<Option<String>, _>("line_ref").context("line_ref")?,
            "lineName": r.try_get::<Option<String>, _>("line_name").context("line_name")?,
            "stops": stops,
        }));
    }
    Ok(Value::Array(out))
}

/// The ordered stop array of a `stops_json` blob, or `None`: fewer than two
/// stops cannot anchor a leg's ends, so such a row is no answer.
pub fn parse_stops(raw: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    if parsed.as_array()?.len() < 2 {
        return None;
    }
    Some(parsed)
}

/// `parse_stops` against a column, dropping a row the driver will not hand over
/// as text at all.
fn stops_array(row: &sqlx::mysql::MySqlRow, col: &str) -> Option<Value> {
    parse_stops(&row.try_get::<String, _>(col).ok()?)
}

/// The day's stored HSMM decode, or `null` if it was never decoded. Any
/// classifier version: an older row is served while the decode worker replaces
/// it.
pub async fn hsmm_decode(pool: &MySqlPool, user_id: &str, date: &str) -> Result<Value> {
    let row = sqlx::query("SELECT segments_json FROM decoded_days WHERE user_id = ? AND date = ?")
        .bind(user_id)
        .bind(date)
        .fetch_optional(pool)
        .await
        .context("reading decoded_days")?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let raw: String = row.try_get("segments_json").context("segments_json")?;
    // Unlike the mirrors, a corrupt decode is an error: it drives stay
    // attribution, and a day decoded without it is a different day.
    serde_json::from_str(&raw).context("decoded_days.segments_json is not JSON")
}

/// The classifier version, declared once. Bumped when a typical day's output
/// would change: a stored decode of another version is stale and re-decoded.
pub const CLASSIFIER_VERSION: i32 = 18;

/// The main-sleep windows bracketing this day: this morning's (filed under
/// today) and tonight's (filed under tomorrow, the date it ends). Every main
/// sleep of each date is read, since a nap can be marked main too; which
/// overlapping window stands is `DayChain.distinctSleepWindows`.
///
/// `start_time`/`end_time` are wall clock in `tz`. A row without `tz` is read
/// in `home_tz`, not UTC: rows written without a zone are local, and reading
/// them as UTC put every summer night an hour late. The `_utc` columns derive
/// from this same wall clock and are not the source.
pub async fn sleep_windows(
    pool: &MySqlPool,
    user_id: &str,
    date: &str,
    home_tz: Option<&str>,
) -> Result<Value> {
    let mut out: Vec<Value> = Vec::new();
    for d in [date.to_string(), next_date_string(date)?] {
        let rows = sqlx::query(
            "SELECT start_time, end_time, tz, minutes_asleep FROM sleep \
             WHERE user_id = ? AND date = ? AND is_main_sleep = 1 ORDER BY start_time",
        )
        .bind(user_id)
        .bind(&d)
        .fetch_all(pool)
        .await
        .with_context(|| format!("reading sleep for {d}"))?;
        for row in rows {
            let row_tz: Option<String> = row.try_get("tz").context("sleep.tz")?;
            // The zone used for CONVERSION. `tz` below stays the row's own value so
            // the served window still says where the reading came from.
            let tz = row_tz.clone().or_else(|| home_tz.map(str::to_string));
            out.push(json!({
                "startTs": wall_clock_ts(&row, "start_time", tz.as_deref())?,
                "endTs": wall_clock_ts(&row, "end_time", tz.as_deref())?,
                "tz": row_tz,
                // NULL is 0: an unknown duration is no reason to drop a window
                // whose bounds are known. `as i64` renders `553`, not `553.0`.
                "minutesAsleep": num_opt(&row, "minutes_asleep")?.unwrap_or(0.0) as i64,
            }));
        }
    }
    Ok(Value::Array(out))
}

/// One wall-clock DATETIME column as a Unix timestamp, through
/// `timezone::wall_clock_to_unix`, where the DST rules live.
fn wall_clock_ts(row: &sqlx::mysql::MySqlRow, col: &str, tz: Option<&str>) -> Result<i64> {
    let naive: chrono::NaiveDateTime = row
        .try_get(col)
        .with_context(|| format!("{col} is not a DATETIME"))?;
    let text = naive.format("%Y-%m-%d %H:%M:%S").to_string();
    match tz {
        // No zone: the components are read as UTC.
        None => Ok(naive.and_utc().timestamp()),
        Some(tz) => crate::timezone::wall_clock_to_unix(&text, tz)
            .with_context(|| format!("{col} {text:?} is not a wall clock in {tz:?}")),
    }
}

/// `date` plus one day, as `YYYY-MM-DD`.
pub fn next_date_string(date: &str) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?;
    Ok(d.succ_opt()
        .with_context(|| format!("{date:?} has no next day"))?
        .format("%Y-%m-%d")
        .to_string())
}

/// The day's watch streams: per-minute heart rate, sleep stages, stepped
/// minutes.
///
/// Each stream has two reads: the primary on `ts_utc`, and a fallback for rows
/// without one, which carry a wall clock and a zone (`row.tz`, else `home_tz`,
/// else the caller's). The primary bounds are half-open, the fallback's
/// closed, and sleep's fallback is an overlap test: a stage that starts early
/// can still fall inside.
///
/// Heart rate per minute is `ROUND(AVG(bpm))` in SQL, cast to CHAR because
/// `AVG` returns a DECIMAL.
pub async fn biometrics(
    pool: &MySqlPool,
    user_id: &str,
    start_utc: i64,
    end_utc: i64,
    home_tz: Option<&str>,
    tz: Option<&str>,
) -> Result<Value> {
    let start_dt = utc_seconds_to_datetime_str(start_utc);
    let end_dt = utc_seconds_to_datetime_str(end_utc);
    // The fallback rows are matched on a WALL CLOCK, which can sit up to a day
    // either side of the UTC window depending on the zone — so the SQL casts a
    // wider net and the loop below narrows it once the tz is known.
    let day_before = utc_seconds_to_date_str(start_utc - 86_400);
    let day_after = utc_seconds_to_date_str(end_utc + 86_400);
    let resolve_tz = |row_tz: Option<&str>| -> Option<String> {
        row_tz
            .map(str::to_string)
            .or_else(|| home_tz.map(str::to_string))
            .or_else(|| tz.map(str::to_string))
    };

    // ---- heart rate -------------------------------------------------------
    let mut hr: Vec<(i64, f64)> = Vec::new();
    let rows = sqlx::query(
        "SELECT DATE_FORMAT(MIN(ts_utc), '%Y-%m-%d %H:%i:00') AS ts_utc, CAST(ROUND(AVG(bpm)) AS CHAR) AS bpm \
         FROM heart_rate_intraday \
         WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ? \
         GROUP BY DATE_FORMAT(ts_utc, '%Y-%m-%d %H:%i') ORDER BY ts_utc",
    )
    .bind(user_id)
    .bind(&start_dt)
    .bind(&end_dt)
    .fetch_all(pool)
    .await
    .context("reading heart_rate_intraday")?;
    for r in &rows {
        let ts: String = r.try_get("ts_utc").context("hr ts_utc")?;
        hr.push((
            utc_datetime_str_to_seconds(&ts).context("hr ts_utc is not a UTC datetime")?,
            num(r, "bpm")?,
        ));
    }
    let rows = sqlx::query(
        "SELECT DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00') AS ts, CAST(ROUND(AVG(bpm)) AS CHAR) AS bpm, \
         MAX(tz) AS tz FROM heart_rate_intraday \
         WHERE user_id = ? AND ts >= ? AND ts < ? AND ts_utc IS NULL \
         GROUP BY DATE_FORMAT(ts, '%Y-%m-%d %H:%i')",
    )
    .bind(user_id)
    .bind(&day_before)
    .bind(&day_after)
    .fetch_all(pool)
    .await
    .context("reading heart_rate_intraday (ts_utc IS NULL)")?;
    for r in &rows {
        let raw: String = r.try_get("ts").context("hr fallback ts")?;
        let row_tz: Option<String> = r.try_get("tz").context("hr fallback tz")?;
        let Some(ts) = wall_clock_ts_str(&raw, resolve_tz(row_tz.as_deref()).as_deref()) else {
            continue;
        };
        if ts < start_utc || ts > end_utc {
            continue;
        }
        hr.push((ts, num(r, "bpm")?));
    }
    hr.sort_by_key(|&(ts, _)| ts);

    // ---- sleep stages -----------------------------------------------------
    let mut sleep: Vec<(i64, i64, String)> = Vec::new();
    let rows = sqlx::query(
        "SELECT ts_utc, stage, duration_seconds FROM sleep_stages \
         WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ?",
    )
    .bind(user_id)
    .bind(&start_dt)
    .bind(&end_dt)
    .fetch_all(pool)
    .await
    .context("reading sleep_stages")?;
    for r in &rows {
        // The WHERE excludes NULL; the column type does not.
        let Some(ts_utc) = r
            .try_get::<Option<chrono::NaiveDateTime>, _>("ts_utc")
            .context("sleep ts_utc")?
        else {
            continue;
        };
        let start = ts_utc.and_utc().timestamp();
        let dur = num(r, "duration_seconds")? as i64;
        sleep.push((start, start + dur, r.try_get("stage").context("stage")?));
    }
    let rows = sqlx::query(
        "SELECT ts, stage, duration_seconds, tz FROM sleep_stages \
         WHERE user_id = ? AND ts >= ? AND ts < ? AND ts_utc IS NULL",
    )
    .bind(user_id)
    .bind(&day_before)
    .bind(&day_after)
    .fetch_all(pool)
    .await
    .context("reading sleep_stages (ts_utc IS NULL)")?;
    for r in &rows {
        let raw: chrono::NaiveDateTime = r.try_get("ts").context("sleep fallback ts")?;
        let row_tz: Option<String> = r.try_get("tz").context("sleep fallback tz")?;
        let text = raw.format("%Y-%m-%d %H:%M:%S").to_string();
        let Some(start) = wall_clock_ts_str(&text, resolve_tz(row_tz.as_deref()).as_deref()) else {
            continue;
        };
        let end = start + num(r, "duration_seconds")? as i64;
        // An overlap test, not containment: a stage beginning before
        // the window still covers time inside it.
        if end < start_utc || start > end_utc {
            continue;
        }
        sleep.push((start, end, r.try_get("stage").context("stage")?));
    }
    sleep.sort_by_key(|&(start, _, _)| start);

    // ---- stepped minutes --------------------------------------------------
    // Only non-zero minutes are stored, so a row IS "at least one step here".
    let mut steps: Vec<(i64, f64)> = Vec::new();
    let rows = sqlx::query(
        "SELECT ts_utc, steps FROM steps_intraday WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ?",
    )
    .bind(user_id)
    .bind(&start_dt)
    .bind(&end_dt)
    .fetch_all(pool)
    .await
    .context("reading steps_intraday")?;
    for r in &rows {
        let Some(ts_utc) = r
            .try_get::<Option<chrono::NaiveDateTime>, _>("ts_utc")
            .context("steps ts_utc")?
        else {
            continue;
        };
        steps.push((ts_utc.and_utc().timestamp(), num(r, "steps")?));
    }
    let rows = sqlx::query(
        "SELECT ts, steps, tz FROM steps_intraday \
         WHERE user_id = ? AND ts >= ? AND ts < ? AND ts_utc IS NULL",
    )
    .bind(user_id)
    .bind(&day_before)
    .bind(&day_after)
    .fetch_all(pool)
    .await
    .context("reading steps_intraday (ts_utc IS NULL)")?;
    for r in &rows {
        let raw: chrono::NaiveDateTime = r.try_get("ts").context("steps fallback ts")?;
        let row_tz: Option<String> = r.try_get("tz").context("steps fallback tz")?;
        let text = raw.format("%Y-%m-%d %H:%M:%S").to_string();
        let Some(ts) = wall_clock_ts_str(&text, resolve_tz(row_tz.as_deref()).as_deref()) else {
            continue;
        };
        if ts < start_utc || ts > end_utc {
            continue;
        }
        steps.push((ts, num(r, "steps")?));
    }
    // One minute per instant. A wall clock written under two offsets is two
    // rows (the table keys on `ts`); the stable sort keeps the `ts_utc` row,
    // pushed first, over a zone-less copy that resolves to the same instant.
    steps.sort_by_key(|&(ts, _)| ts);
    steps.dedup_by_key(|&mut (ts, _)| ts);

    Ok(json!({
        "hr": hr.iter().map(|&(ts, bpm)| json!({"ts": ts, "bpm": bpm as i64})).collect::<Vec<_>>(),
        "sleep": sleep.iter()
            .map(|(a, b, st)| json!({"startTs": a, "endTs": b, "stage": st}))
            .collect::<Vec<_>>(),
        "steps": steps.iter()
            .map(|&(ts, n)| json!({"ts": ts, "steps": n as i64}))
            .collect::<Vec<_>>(),
    }))
}

/// A wall clock in a resolved zone as Unix seconds, or `None` when the clock
/// does not parse or no zone resolved; the caller skips the row.
fn wall_clock_ts_str(raw: &str, tz: Option<&str>) -> Option<i64> {
    match tz {
        // No zone: the components are read as UTC.
        None => crate::timezone::parse_wall_clock(raw).map(|d| d.and_utc().timestamp()),
        Some(tz) => crate::timezone::wall_clock_to_unix(raw, tz),
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC.
fn utc_seconds_to_datetime_str(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// `YYYY-MM-DD` in UTC.
fn utc_seconds_to_date_str(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// A `YYYY-MM-DD HH:MM:SS` UTC datetime as Unix seconds.
fn utc_datetime_str_to_seconds(s: &str) -> Option<i64> {
    crate::timezone::parse_wall_clock(s).map(|d| d.and_utc().timestamp())
}

/// Where a day with no data was spent, or `null`: the place the previous day
/// ended at, when it is also the next day's dominant place (a multi-day
/// hospital stay). Either side missing, or the two disagreeing, leaves the day
/// blank. Consumed only when the day has no states and no points.
pub async fn empty_day_bracket(pool: &MySqlPool, user_id: &str, date: &str) -> Result<Value> {
    let Some(prev) = empty_day_bracket_place(pool, user_id, date).await? else {
        return Ok(Value::Null);
    };
    bracket_centroid(pool, prev).await
}

/// The place a no-data day is bracketed at (`empty_day_bracket`'s rule), or
/// `None`: the previous day ended there and the next day's dominant place is
/// the same.
pub async fn empty_day_bracket_place(
    pool: &MySqlPool,
    user_id: &str,
    date: &str,
) -> Result<Option<u64>> {
    // `INT UNSIGNED`: sqlx decodes it only as `u64`. No row and a NULL place
    // both mean "unknown".
    let prev: Option<u64> = {
        let row = sqlx::query(
            "SELECT end_of_day_place_id FROM presence_log WHERE user_id = ? AND date = ?",
        )
        .bind(user_id)
        .bind(shift_day(date, -1)?)
        .fetch_optional(pool)
        .await
        .context("reading presence_log for the day before")?;
        match row {
            None => None,
            Some(r) => r.try_get::<Option<u64>, _>("end_of_day_place_id")?,
        }
    };
    let next: Option<u64> = {
        let row = sqlx::query(
            "SELECT dominant_place_id FROM presence_log WHERE user_id = ? AND date = ?",
        )
        .bind(user_id)
        .bind(shift_day(date, 1)?)
        .fetch_optional(pool)
        .await
        .context("reading presence_log for the day after")?;
        match row {
            None => None,
            Some(r) => r.try_get::<Option<u64>, _>("dominant_place_id")?,
        }
    };

    let (Some(prev), Some(next)) = (prev, next) else {
        return Ok(None);
    };
    Ok((prev == next).then_some(prev))
}

/// The bracket place's centroid, which names the stay; `null` when the place
/// no longer exists.
async fn bracket_centroid(pool: &MySqlPool, prev: u64) -> Result<Value> {
    // DECIMAL, cast to CHAR (see `num`).
    let row = sqlx::query(
        "SELECT CAST(centroid_lat AS CHAR) AS centroid_lat, \
         CAST(centroid_lon AS CHAR) AS centroid_lon FROM focus_places WHERE id = ?",
    )
    .bind(prev)
    .fetch_optional(pool)
    .await
    .context("reading the bracket's focus place")?;
    // A bracket at a deleted place is no bracket.
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "centroidLat": js_num(num(&row, "centroid_lat")?),
        "centroidLon": js_num(num(&row, "centroid_lon")?),
    }))
}

/// `date` shifted by whole days, as `YYYY-MM-DD`: through the calendar, not
/// 86 400 s, so a DST change cannot leave it on the same date.
pub fn shift_day(date: &str, days: i64) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?;
    Ok((d + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string())
}

/// The decoder's `places`, from the `knownPlaces` rows: `centroidLat` → `lat`,
/// `totalDwellSec` → `dwell`, `displayName` → `name`. The name is optional (an
/// unmined place); the centroid and dwell are required.
pub fn decode_places(known: Option<&Value>) -> Result<Value> {
    let rows = known
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let out = rows
        .iter()
        .map(|r| {
            let f = |k: &str| -> Result<f64> {
                r.get(k)
                    .and_then(Value::as_f64)
                    .with_context(|| format!("a knownPlaces row has no numeric {k}"))
            };
            Ok(json!({
                "id": r.get("id").and_then(Value::as_i64)
                    .context("a knownPlaces row has no id")?,
                "name": r.get("displayName").cloned().unwrap_or(Value::Null),
                "lat": f("centroidLat")?,
                "lon": f("centroidLon")?,
                "hourProfile": r.get("hourProfile").cloned().unwrap_or(Value::Null),
                "dwell": f("totalDwellSec")?,
                "visits": r.get("visitCount").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Value::Array(out))
}

/// The default decode window: `n` days ending yesterday, newest first. Never
/// today: at the morning run today is a stub, and a stub stored under the
/// current version would read as a decoded day.
pub fn decode_window(now: chrono::DateTime<chrono::Utc>, days: i64) -> Vec<String> {
    (1..=days)
        .map(|o| {
            (now - chrono::Duration::days(o))
                .format("%Y-%m-%d")
                .to_string()
        })
        .collect()
}

/// The PhoneTrack half of the inputs: three fix windows and the battery tail.
///
/// `today` is the date's UTC span, `morning` runs to noon UTC the next day, and
/// `priorEvening` spans the whole previous day: a local day is not a UTC day,
/// and a night is attributed to where the phone last reported, possibly hours
/// before midnight. `batteryTail` is display-only: the first reading in the 18 h
/// after the local day ends, for the battery chart to draw to.
///
/// PhoneTrack silently caps a request at 10 000 points; a capped window that
/// cannot be split further is warned about below.
async fn phonetrack_windows(
    pool: &MySqlPool,
    http: &reqwest::Client,
    base_url: &str,
    user_id: &str,
    date: &str,
    day_end_utc: i64,
) -> Result<(Value, Value)> {
    let pt = crate::nextcloud::phonetrack::PhoneTrack::open(http.clone(), pool, base_url, user_id)
        .await
        .with_context(|| format!("opening PhoneTrack for {user_id}"))?;

    let next_day = shift_day(date, 1)?;
    let prev_day = shift_day(date, -1)?;
    let midnight = |d: &str| -> Result<i64> {
        crate::lean::midnight_utc(d).with_context(|| format!("resolving UTC midnight for {d}"))
    };
    // Noon UTC, as midnight plus half a day. `priorEvening` is named for its old
    // window; it now spans the whole previous day.
    let noon = 12 * 3600;
    let today = (midnight(date)?, midnight(&next_day)?);
    let morning = (midnight(&next_day)?, midnight(&next_day)? + noon);
    // The whole previous day: a phone that goes quiet before midnight last
    // reported hours earlier, and that is where the night was spent. Golden
    // fixtures capture this window, so only served days exercise it.
    let prior_evening = (midnight(&prev_day)?, midnight(date)?);
    let tail = (day_end_utc, day_end_utc + BATTERY_TAIL_LOOKAHEAD_H * 3600);

    // The four windows are fetched together; each is read back below.
    let pt = &pt;
    let fetch = |(a, b): (i64, i64)| async move {
        pt.fetch_window(pool, a, b)
            .await
            .with_context(|| format!("fetching PhoneTrack fixes for [{a}, {b}]"))
            .map(|f| (a, b, f))
    };
    let windows = tokio::try_join!(
        fetch(today),
        fetch(morning),
        fetch(prior_evening),
        fetch(tail)
    )?;
    let mut fetched = Vec::with_capacity(4);
    for (a, b, f) in [windows.0, windows.1, windows.2, windows.3] {
        // A failed device makes the fixes a subset: a gap is then not stillness.
        if f.failed_devices > 0 {
            tracing::warn!(
                "phonetrack: {} device(s) failed for [{a}, {b}] — these fixes are a SUBSET of the \
                 window, and a gap in them is not evidence of stillness",
                f.failed_devices
            );
        }
        // Likewise a window that hit the point cap and could not be split.
        if f.capped_windows > 0 {
            tracing::warn!(
                "phonetrack: {} window(s) hit the point cap and could not be split for [{a}, {b}] \
                 — these fixes are a SUBSET of the window",
                f.capped_windows
            );
        }
        fetched.push(f.points);
    }
    let after_day = fetched.pop().expect("four windows fetched");
    let prior_evening = fetched.pop().expect("four windows fetched");
    let morning = fetched.pop().expect("four windows fetched");
    let today = fetched.pop().expect("four windows fetched");

    // `after_day` is ascending, so the first battery-bearing fix is the earliest
    // reading after the day end — which is what the chart wants to draw to.
    let battery_tail = after_day.iter().find(|p| p.battery.is_some()).map_or(
        Value::Null,
        |p| json!({"ts": p.ts, "level": js_num(p.battery.unwrap_or_default())}),
    );

    Ok((
        json!({
            "today": fixes_json(&today),
            "morning": fixes_json(&morning),
            "priorEvening": fixes_json(&prior_evening),
        }),
        battery_tail,
    ))
}

/// PhoneTrack fixes in the field order `RawPhonetrackFix` uses.
fn fixes_json(points: &[crate::nextcloud::phonetrack::RawTrackPoint]) -> Value {
    Value::Array(
        points
            .iter()
            .map(|p| {
                json!({
                    "ts": p.ts,
                    "lat": js_num(p.lat),
                    "lon": js_num(p.lon),
                    "altitude": p.altitude.map_or(Value::Null, js_num),
                    "speed": p.speed.map_or(Value::Null, js_num),
                    "accuracy": p.accuracy.map_or(Value::Null, js_num),
                    "battery": p.battery.map_or(Value::Null, js_num),
                })
            })
            .collect(),
    )
}

/// How far past the local day's end the battery tail looks (h).
const BATTERY_TAIL_LOOKAHEAD_H: i64 = 18;

/// The day path's Nextcloud base URL. Distinct from an unset
/// `Config::nextcloud_base_url`, which on the sync path means "skip
/// PhoneTrack": a day always needs its fixes.
pub const DAY_NEXTCLOUD_BASE_URL: &str = "https://dash.xinutec.org";

/// Which day, for whom, in which zone. `display_tz` is the zone the day was
/// lived in and bounds the local day; `home_tz` is only the fallback for
/// segments no fix covers.
#[derive(Debug, Clone, Copy)]
pub struct DayIdentity<'a> {
    pub user_id: &'a str,
    pub date: &'a str,
    pub display_tz: &'a str,
}

/// Every day input, in the fixture's field order: [`load_timed`] without the
/// split.
pub async fn load(
    pool: &MySqlPool,
    http: &reqwest::Client,
    base_url: &str,
    identity: &DayIdentity<'_>,
    bounds: crate::timezone::DayBounds,
    home_tz: Option<&str>,
) -> Result<Value> {
    Ok(load_timed(pool, http, base_url, identity, bounds, home_tz)
        .await?
        .0)
}

/// Every day input, with each read's duration in ms in read order; the route
/// ships them as `timing.load.<read>`.
pub async fn load_timed(
    pool: &MySqlPool,
    http: &reqwest::Client,
    base_url: &str,
    identity: &DayIdentity<'_>,
    bounds: crate::timezone::DayBounds,
    home_tz: Option<&str>,
) -> Result<(Value, Vec<(&'static str, u64)>)> {
    let DayIdentity {
        user_id,
        date,
        display_tz,
    } = *identity;
    let (start_utc, end_utc) = (bounds.start_utc, bounds.end_utc);
    let mut split: Vec<(&'static str, u64)> = Vec::new();
    let mut t = std::time::Instant::now();
    let mut lap = |name: &'static str, split: &mut Vec<(&'static str, u64)>| {
        split.push((name, t.elapsed().as_millis() as u64));
        t = std::time::Instant::now();
    };
    let (phonetrack, battery_tail) =
        phonetrack_windows(pool, http, base_url, user_id, date, end_utc).await?;
    lap("phonetrack", &mut split);
    let mut m = Map::new();
    m.insert(
        "identity".into(),
        json!({"userId": user_id, "date": date, "displayTz": display_tz}),
    );
    m.insert("phonetrack".into(), phonetrack);
    m.insert("batteryTail".into(), battery_tail);
    m.insert("knownPlaces".into(), known_places(pool, user_id).await?);
    lap("knownPlaces", &mut split);
    let mut biom = biometrics(pool, user_id, start_utc, end_utc, home_tz, home_tz).await?;
    lap("biometrics", &mut split);
    if let Some(o) = biom.as_object_mut() {
        o.insert("stepsThrough".into(), steps_through(pool, user_id).await?);
        lap("stepsThrough", &mut split);
    }
    m.insert("biometrics".into(), biom);
    m.insert(
        "motionLog".into(),
        motion_log(pool, user_id, start_utc, end_utc).await?,
    );
    lap("motionLog", &mut split);
    m.insert(
        "modeBiometrics".into(),
        mode_biometrics(pool, user_id).await?,
    );
    lap("modeBiometrics", &mut split);
    m.insert("hsmmDecode".into(), hsmm_decode(pool, user_id, date).await?);
    lap("hsmmDecode", &mut split);
    m.insert("railRouteCache".into(), rail_route_cache(pool).await?);
    lap("railRouteCache", &mut split);
    m.insert("busRouteCache".into(), bus_route_cache(pool).await?);
    lap("busRouteCache", &mut split);
    m.insert("railStopsCache".into(), rail_stops_cache(pool).await?);
    lap("railStopsCache", &mut split);
    // `home_tz` is defaulted here, once; the default only covers segments no
    // fix places.
    m.insert(
        "homeTz".into(),
        Value::String(home_tz.unwrap_or("Europe/Amsterdam").to_string()),
    );
    m.insert(
        "sleepWindows".into(),
        sleep_windows(pool, user_id, date, home_tz).await?,
    );
    lap("sleepWindows", &mut split);
    m.insert(
        "emptyDayBracket".into(),
        empty_day_bracket(pool, user_id, date).await?,
    );
    lap("emptyDayBracket", &mut split);
    m.insert(
        "venuePriors".into(),
        venue_priors(pool, user_id, end_utc).await?,
    );
    lap("venuePriors", &mut split);
    Ok((Value::Object(m), split))
}
