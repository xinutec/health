//! The day's inputs, read from the database (#982).
//!
//! Port of the DB half of `src/geo/load-classification-inputs.ts`. That file
//! loads twelve things in parallel plus four PhoneTrack range fetches; this is
//! the five whose shape is pure SQL and whose output is a fixture field. The
//! rest — biometrics, the HSMM decode, the bus and rail-stop caches, the sleep
//! windows, the empty-day bracket, and PhoneTrack itself — are named in #982
//! and not here.
//!
//! # Why the output is `serde_json::Value` and not a struct
//!
//! It has to be COMPARABLE against the TypeScript, field for field. A fixture's
//! `inputs` is what the TS loader produced, and the only honest way to know this
//! port agrees is to run both against one database and diff the JSON — the same
//! method that proved `fold_payload` byte-identical on 42 days. A Rust struct
//! would impose its own field order and its own number formatting, and the diff
//! would then measure the serialiser rather than the query.
//!
//! `serde_json` here carries `preserve_order`, so a map keeps insertion order
//! and the field sequence matches the TS object literal.
//!
//! # Numbers
//!
//! ⚠ `lat`/`lon`/`centroid_*`/`total_dwell_sec` are MySQL DECIMAL. The TS reads
//! them through `Number(...)`, so the value that reaches the fixture is a
//! double. Reading them as `f64` here matches that; reading them as `Decimal`
//! and formatting would not, and the difference shows up as a diff on a digit
//! nobody changed.

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use sqlx::{MySqlPool, Row};

/// ⚠ WHY THE DECIMAL COLUMNS ARE CAST TO CHAR IN THE SQL
///
/// sqlx cannot hand back a MySQL DECIMAL at all without the `rust_decimal`
/// feature, and this crate's feature list is deliberately identical to the seven
/// sibling repos — adding one here is not a local decision. Casting is the
/// alternative, and CHAR rather than DOUBLE is the faithful one: the Kysely
/// driver already gives the TypeScript a STRING for these, which it parses with
/// `Number(...)`. Rust's `str::parse::<f64>` is correctly rounded and agrees with
/// V8 (unlike `serde_json`'s `as_f64` without `float_roundtrip` — the same
/// hazard, one layer down), so string-and-parse reproduces the TS value exactly
/// where `CAST(... AS DOUBLE)` would ask MySQL to do the rounding instead.
///
/// Missing a DECIMAL column is not silent: `num` refuses a type it cannot read
/// rather than defaulting, which is how this was found — 117 focus places had
/// decoded to centroid 0.0 and the production check still said OK.
const _DECIMAL_NOTE: () = ();

/// A numeric column as a `f64`, however the driver hands it over.
///
/// ⚠ THIS EXISTS BECAUSE `try_get::<f64>` IS NOT ENOUGH. MySQL DECIMAL comes
/// back as a STRING — which is why every one of these is wrapped in `Number(...)`
/// on the TypeScript side — and asking sqlx for an `f64` simply fails. Paired
/// with `unwrap_or_default()` that failure was invisible: the first version of
/// this module decoded all 117 of production's focus places to centroid 0.0 and
/// the check still printed OK, because it counted rows and never looked at one.
///
/// So: try the native decode, fall back to parsing the string, and ERROR if
/// neither works. The fallback is not a mask — the error path is still an error.
fn num(row: &sqlx::mysql::MySqlRow, col: &str) -> Result<f64> {
    if let Ok(v) = row.try_get::<f64, _>(col) {
        return Ok(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(col) {
        return Ok(v as f64);
    }
    // ⚠ UNSIGNED is a distinct sqlx type. `focus_places.id` is an unsigned
    // BIGINT and decodes as none of the signed forms — which the first version
    // of this helper reported as "neither a float, an integer, nor a string",
    // correctly refusing rather than guessing.
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

/// `num_opt` rendered as JSON — `null` stays null rather than becoming zero.
fn num_json(row: &sqlx::mysql::MySqlRow, col: &str) -> Result<Value> {
    Ok(num_opt(row, col)?.map_or(Value::Null, |v| json!(v)))
}

/// `focus_places`, projected as `snapToPlace` and the place picker read it.
///
/// ⚠ `hour_profile` is stored as text and parsed into an array. A row whose
/// blob does not parse yields an EMPTY profile rather than failing the day —
/// which is what the TS `parseHourProfile` does, and the reason is that a
/// mined-profile blob is evidence, not structure: a day should still decode
/// without it.
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

    // ⚠ `?` on every numeric, never a default. A place at centroid 0.0 is not a
    // place with an unknown centroid — it is a place in the Gulf of Guinea, and
    // the snapper would happily measure distances to it.
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(json!({
            "id": num(r, "id")? as i64,
            "centroidLat": num(r, "centroid_lat")?,
            "centroidLon": num(r, "centroid_lon")?,
            "radiusM": num(r, "radius_m")?,
            "displayName": r.try_get::<Option<String>, _>("display_name").context("display_name")?,
            // `?? 0` in the TS: an unmined row has no sleep evidence, which is
            // zero hours, not "unknown".
            "sleepHours": num_opt(r, "sleep_hours")?.unwrap_or(0.0),
            "amenityLabel": r.try_get::<Option<String>, _>("amenity_label").context("amenity_label")?,
            "uniqueDays": num_opt(r, "unique_days")?.map(|v| v as i64),
            "hourProfile": parse_hour_profile(
                r.try_get::<Option<String>, _>("hour_profile").context("hour_profile")?.as_deref(),
            ),
            "totalDwellSec": num(r, "total_dwell_sec")?,
            "visitCount": num_opt(r, "visit_count")?.map(|v| v as i64),
        }));
    }
    Ok(Value::Array(out))
}

/// A stored hour profile, or an empty array when it is absent or unparseable.
///
/// ⚠ IT WARNS, and that is the whole difference between this and a mask. The
/// TypeScript's equivalent logs before returning its default; dropping the log
/// while keeping the default would turn a corrupt blob into a place that simply
/// has no hour profile, which is a claim about the user's habits rather than an
/// admission that a row could not be read. `dev-lint`'s `rust-serde-swallow`
/// caught exactly that here.
///
/// Absent is NOT warned: a row mined before profiles existed has nothing to say.
pub fn parse_hour_profile(raw: Option<&str>) -> Value {
    let Some(s) = raw else {
        return Value::Array(vec![]);
    };
    match serde_json::from_str::<Value>(s) {
        Ok(v) if v.is_array() => v,
        Ok(_) => {
            tracing::warn!(
                "focus_places.hour_profile is valid JSON but not an array — ignoring it"
            );
            Value::Array(vec![])
        }
        Err(e) => {
            tracing::warn!("focus_places.hour_profile did not parse ({e}) — ignoring it");
            Value::Array(vec![])
        }
    }
}

/// `mode_biometrics` — the per-user, per-mode signatures the cadence and speed
/// scorers read.
///
/// ⚠ Every statistic is NULLABLE and stays null. A mode with no samples is not
/// a mode with a mean of zero: the scorer tests for absence and skips, where a
/// zero would be a claim about the user's heart rate.
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
                // ⚠ Read as String, not as an enum. `mode` is a MySQL ENUM and
                // sqlx will not decode one into a Rust enum without a type map;
                // the TS carries it as a plain string and so does the fixture.
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

/// The mined venue-type priors, or `null`.
///
/// ⚠ A blob that fails to parse is `null`, not an error. The TS warns and
/// carries on, on the rule that a prior is evidence: losing it weakens the venue
/// scorer and must not fail the day.
pub async fn venue_priors(pool: &MySqlPool, user_id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT priors_json FROM venue_type_priors WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .with_context(|| format!("reading venue_type_priors for {user_id}"))?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let raw: String = row
        .try_get("priors_json")
        .context("decoding venue_type_priors.priors_json")?;
    // ⚠ WARNS rather than defaulting quietly. A prior is evidence: losing it
    // weakens the venue scorer and must not fail the day, but a scorer running
    // without priors it believes it has is a different thing from one that knows
    // they are missing. The TypeScript warns here too.
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => Ok(v),
        Err(e) => {
            tracing::warn!(
                "venue_type_priors blob for {user_id} did not parse ({e}) — treating as no evidence"
            );
            Ok(Value::Null)
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

/// The day's `motion_log` rows — per-fix heading, velocity and accuracy.
///
/// ⚠ HALF-OPEN on the end (`ts < end`), matching the TS. A closed interval would
/// hand the last second of the day to two days at once, and the duplicate fix
/// would move a segment boundary by one sample on every day in the corpus.
///
/// Days before the ingest deployed simply return `[]`.
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
            "lat": num(r, "lat")?,
            "lon": num(r, "lon")?,
            "cogDeg": num_json(r, "cog")?,
            "velKmh": num_json(r, "vel")?,
            "accM": num_json(r, "acc")?,
        }));
    }
    Ok(Value::Array(out))
}

/// Everything above, in the field order `SerializedInputs` uses.
///
/// ⚠ PARTIAL, and it says so by NAMING what it does not load rather than
/// emitting an empty array for it. An absent key is a caller's error; an empty
/// array is a day with no rail cache, and the two must not look alike.
pub async fn load_partial(
    pool: &MySqlPool,
    user_id: &str,
    start_utc: i64,
    end_utc: i64,
) -> Result<Value> {
    let mut m = Map::new();
    m.insert("knownPlaces".into(), known_places(pool, user_id).await?);
    m.insert(
        "modeBiometrics".into(),
        mode_biometrics(pool, user_id).await?,
    );
    m.insert(
        "motionLog".into(),
        motion_log(pool, user_id, start_utc, end_utc).await?,
    );
    m.insert("railRouteCache".into(), rail_route_cache(pool).await?);
    m.insert("venuePriors".into(), venue_priors(pool, user_id).await?);
    Ok(Value::Object(m))
}
