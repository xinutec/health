//! The day's inputs, read from the database (#982).
//!
//! Port of the DB half of `src/geo/load-classification-inputs.ts`. That file
//! loads twelve things in parallel plus four PhoneTrack range fetches; this is
//! the nine whose shape is pure SQL and whose output is a fixture field.
//!
//! ⚠ WHAT IS STILL MISSING IS NAMED, not left to be inferred from a count:
//! `biometrics` (three streams of its own), `emptyDayBracket` (two presence_log
//! reads plus a focus_places centroid), `homeTz` (a `sync_state` read that
//! already has its own module), and PhoneTrack itself (four range fetches
//! against Nextcloud, not SQL). `load_partial` is named for that gap and keeps
//! the name until they land — see #982.
//!
//! The insertion order below is `load-classification-inputs.ts`'s RETURN order,
//! not its `Promise.all` order, because the return object is what a fixture
//! records and what a diff compares.
//!
//! # Measured against the TypeScript, 2026-08-21
//!
//! `backend inputs <user> <date>` prints this module's output; a golden
//! fixture's `inputs` block IS the TypeScript loader's output for that day. On
//! 2026-08-13, keyed row by row:
//!
//! ```text
//! knownPlaces      117/117 identical
//! modeBiometrics       6/6 identical
//! motionLog        611/611 identical
//! venuePriors          identical
//! sleepWindows         identical
//! hsmmDecode        29 segments, identical
//! railRouteCache     48/51  - 3 re-mined 2026-08-20 05:10
//! busRouteCache    959/994  - 35 re-mined, newest 2026-08-21 05:42
//! railStopsCache   231/259  - whole table rewritten 2026-08-20 06:11
//! ```
//!
//! ⚠ THE THREE PARTIAL ROWS ARE DRIFT, AND THAT IS MEASURED RATHER THAN
//! ASSUMED: every differing row's `computed_at` is later than the fixture's
//! capture, and the differences are changed COORDINATES, not changed
//! renderings. "It must be drift" is what the first reading of #1052 said too.
//!
//! Three defects this diff caught that `backend check` could not, all of the
//! same kind — a value that decodes to something plausible and wrong:
//!
//!   * `hour_profile` read as JSON when it is comma-separated per-mille
//!     integers, so all 117 profiles decoded to absent;
//!   * `minutesAsleep` rendered `553.0` against the TypeScript's `553`;
//!   * `osmRelationId` likewise, which made a thousand identical rows share
//!     ZERO keys.
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
/// ⚠ `hour_profile` is a COMMA-SEPARATED list of per-mille integers, not JSON.
/// A row that does not parse yields `null` — "no time-of-day signal" — because
/// a mined profile is evidence, not structure: a day should still decode
/// without it. See `parse_hour_profile`.
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

/// A stored hour profile as 24 fractions, or `null` when it cannot be read.
///
/// ⚠ THE STORED FORM IS NOT JSON. `serializeHourProfile` writes
/// `profile.map(f => Math.round(f * 1000)).join(",")` into a VARCHAR(127) —
/// `59,58,56,…` — and the column is per-mille INTEGERS, quantised deliberately
/// (the round-trip is lossy to ~0.1 %, which is fine for a soft scoring signal).
///
/// ⚠ THE FIRST VERSION OF THIS FUNCTION READ IT AS JSON, and it was wrong in
/// the quiet direction: every profile "parsed" to empty, so all 117 of
/// production's focus places lost their time-of-day signal while the loader
/// reported success. Its unit tests passed because they asserted the JSON form
/// — they tested this function against its own assumption rather than against
/// the writer. Found by diffing the two arms' JSON, which is the only check
/// here that consults the TypeScript instead of me.
///
/// ⚠ `null`, NOT an empty array. `parseHourProfile` returns null and the
/// consumer (`hourProfileMatch`) tests for it to mean "no signal"; an empty
/// array is a profile that says every hour is equally unlikely, which is a
/// claim about the user's habits rather than an absence of one.
///
/// A wrong LENGTH is rejected whole, matching the TS: 23 buckets is not a
/// profile missing an hour, it is a value written by something else.
///
/// ⚠ `""` PARSES AS 0, deliberately, because JS `Number("")` is 0 and this has
/// to agree with what the writer's reader does. Rust's `str::parse` errors on
/// it, so the empty case is handled before parsing. Not mirrored: JS's hex and
/// `Infinity` literals, which `serializeHourProfile` cannot emit.
pub fn parse_hour_profile(raw: Option<&str>) -> Value {
    let Some(s) = raw.filter(|s| !s.is_empty()) else {
        // Absent is not warned: a row mined before the column existed has
        // nothing to say, and the TS `if (!s) return null` treats "" the same.
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
        out.push(json!(n / 1000.0));
    }
    Value::Array(out)
}

/// `HOUR_BUCKETS` from `src/geo/focus-places.ts` — hours in a day, and the
/// exact length a stored profile must have.
const HOUR_BUCKETS: usize = 24;

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

/// `bus_route_cache`, every mirrored OSM bus route.
///
/// Global, not user-scoped, and small — a city is a few thousand stops of JSON.
///
/// ⚠ A MALFORMED ROW IS DROPPED, NOT FATAL, and the two are different claims.
/// `parseBusRouteRow` returns null on unparseable `stops_json` or a route left
/// with fewer than two stops, because bus naming is purely ADDITIVE evidence:
/// a corrupt row must cost the day its bus label, never its timeline. That is
/// the TS posture and it is copied deliberately — it is NOT the `num` posture
/// two screens up, where a column that will not decode is an error, because
/// there the failure would be silent and wrong rather than absent.
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
            // ⚠ BIGINT, narrowed with `as i64` so it RENDERS as `8336` and not
            // `8336.0`. The TS narrows with `Number(...)` for the size reason
            // (ids are well under 2^53); the cast here is additionally about
            // the byte string, which is what the parity diff compares — and
            // what caught this: keyed on the id, the two arms shared ZERO rows
            // out of a thousand that were in fact the same thousand rows.
            "osmRelationId": num(r, "osm_relation_id")? as i64,
            "stops": stops,
        }));
    }
    Ok(Value::Array(out))
}

/// `rail_stops_cache`, every mirrored rail route relation (#364).
///
/// The ORDERED stop-role members of each service — which stations it actually
/// calls at, as opposed to which it merely passes within 300 m of. Same drop
/// rule and same reason as `bus_route_cache`.
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

/// The ordered stop array of a `stops_json` blob, or `None` if it is unusable.
///
/// Shared by the two mirrors because they apply the SAME rule and it is a rule,
/// not a coincidence: fewer than two stops cannot anchor a leg's endpoints, so
/// such a row is not a smaller answer, it is no answer.
///
/// Takes the STRING rather than the row so it can be tested without a database,
/// which is the same split the TypeScript makes — `parseBusRouteRow` is pure and
/// round-trip-tested, and the read around it is a thin wrapper.
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

/// The day's HSMM decode from `decoded_days`, or `null`.
///
/// ⚠ `null` HAS TWO CAUSES AND THEY MEAN THE SAME THING HERE: no row, or a row
/// left by an older classifier. `loadDecode` checks `classifier_version` and
/// discards a mismatch, so a stale decode reads as "not decoded yet" rather
/// than as evidence — which is right, because the segments a version-6 run
/// produced are not the segments version 7 would.
///
/// The version is filtered IN SQL rather than after the fetch. Same answer,
/// and it does not drag a MEDIUMTEXT across the wire to throw it away.
pub async fn hsmm_decode(pool: &MySqlPool, user_id: &str, date: &str) -> Result<Value> {
    let row = sqlx::query(
        "SELECT segments_json FROM decoded_days \
         WHERE user_id = ? AND date = ? AND classifier_version = ?",
    )
    .bind(user_id)
    .bind(date)
    .bind(CLASSIFIER_VERSION)
    .fetch_optional(pool)
    .await
    .context("reading decoded_days")?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let raw: String = row.try_get("segments_json").context("segments_json")?;
    // ⚠ NOT `.ok().unwrap_or(Null)`. The two mirrors above drop a corrupt row
    // because their evidence is additive; this one is not. The decode drives
    // stationary placeId attribution, and a day that silently decoded without
    // it is a different day — so an unparseable blob is an ERROR, and the TS
    // agrees: `JSON.parse` there is unguarded and throws.
    serde_json::from_str(&raw).context("decoded_days.segments_json is not JSON")
}

/// `CLASSIFIER_VERSION` from `src/hmm/persist.ts`.
///
/// ⚠ BUMPED IN TWO PLACES OR IN NEITHER. A decode written by the TypeScript
/// cron and read by this loader has to agree on the number, and there is no
/// shared header to put it in — the TS constant is the original. `decoded_days`
/// reading empty for a day the cron decoded is the symptom of these drifting.
const CLASSIFIER_VERSION: i32 = 7;

/// The main-sleep windows bracketing this day: today's morning sleep and the
/// night beginning this evening.
///
/// ⚠ TWO ROWS BY TWO DATES, NOT A RANGE. A sleep row is filed under the date it
/// ENDS on, so the night that starts tonight is stored under tomorrow — which
/// is why the TS issues two point queries rather than a `BETWEEN`, and why the
/// order of the result is morning-then-evening rather than anything the
/// database chose. Both are optional; a day with neither yields `[]`.
///
/// ⚠ `start_time` / `end_time` are WALL CLOCK, not UTC (#340, and
/// `docs/design/timezone.md`). `tz` rides alongside and may be NULL, in which
/// case the TS falls back to reading the components AS UTC — a guess, but the
/// established one, and changing it here would re-time rows nothing else moved.
pub async fn sleep_windows(pool: &MySqlPool, user_id: &str, date: &str) -> Result<Value> {
    let mut out: Vec<Value> = Vec::new();
    for d in [date.to_string(), next_date_string(date)?] {
        let row = sqlx::query(
            "SELECT start_time, end_time, tz, minutes_asleep FROM sleep \
             WHERE user_id = ? AND date = ? AND is_main_sleep = 1",
        )
        .bind(user_id)
        .bind(&d)
        .fetch_optional(pool)
        .await
        .with_context(|| format!("reading sleep for {d}"))?;
        let Some(row) = row else { continue };
        let tz: Option<String> = row.try_get("tz").context("sleep.tz")?;
        out.push(json!({
            "startTs": wall_clock_ts(&row, "start_time", tz.as_deref())?,
            "endTs": wall_clock_ts(&row, "end_time", tz.as_deref())?,
            "tz": tz,
            // ⚠ NULL becomes 0, matching the TS `?? 0`. Not a mask: the field
            // is a reported duration, and "we do not know how long" is not a
            // reason to drop a window whose BOUNDS are known.
            //
            // ⚠ `as i64`, like every other integer column here. Without it this
            // serialises as `553.0` where the TypeScript writes `553` — the
            // SAME number and a different byte string, which is exactly what
            // the JSON-diff parity check compares. Caught by that diff, not by
            // reading: `minutes_asleep` is an INT and both arms agree on its
            // value, so nothing but the rendering was ever wrong.
            "minutesAsleep": num_opt(&row, "minutes_asleep")?.unwrap_or(0.0) as i64,
        }));
    }
    Ok(Value::Array(out))
}

/// One wall-clock DATETIME column as a Unix timestamp.
///
/// The driver hands a DATETIME back as a `NaiveDateTime` whose components ARE
/// the stored wall clock, which is exactly what `fitbitTsToUnix` reconstructs
/// by regex from the ISO rendering. So this formats and defers to
/// `timezone::wall_clock_to_unix` rather than restating the DST choices — those
/// were measured against the production TypeScript once, and once is the point.
fn wall_clock_ts(row: &sqlx::mysql::MySqlRow, col: &str, tz: Option<&str>) -> Result<i64> {
    let naive: chrono::NaiveDateTime = row
        .try_get(col)
        .with_context(|| format!("{col} is not a DATETIME"))?;
    let text = naive.format("%Y-%m-%d %H:%M:%S").to_string();
    match tz {
        // No tz: read the components as UTC. `fitbitTsToUnix` returns
        // `Date.UTC(...)` when its `tz` argument is absent.
        None => Ok(naive.and_utc().timestamp()),
        Some(tz) => crate::timezone::wall_clock_to_unix(&text, tz)
            .with_context(|| format!("{col} {text:?} is not a wall clock in {tz:?}")),
    }
}

/// `date` plus one day, as `YYYY-MM-DD`. Mirrors `nextDateString`.
pub fn next_date_string(date: &str) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?;
    Ok(d.succ_opt()
        .with_context(|| format!("{date:?} has no next day"))?
        .format("%Y-%m-%d")
        .to_string())
}

/// Everything above, in the field order `SerializedInputs` uses.
///
/// ⚠ PARTIAL, and it says so by NAMING what it does not load rather than
/// emitting an empty array for it. An absent key is a caller's error; an empty
/// array is a day with no rail cache, and the two must not look alike.
pub async fn load_partial(
    pool: &MySqlPool,
    user_id: &str,
    date: &str,
    start_utc: i64,
    end_utc: i64,
) -> Result<Value> {
    let mut m = Map::new();
    m.insert("knownPlaces".into(), known_places(pool, user_id).await?);
    m.insert(
        "motionLog".into(),
        motion_log(pool, user_id, start_utc, end_utc).await?,
    );
    m.insert(
        "modeBiometrics".into(),
        mode_biometrics(pool, user_id).await?,
    );
    m.insert("hsmmDecode".into(), hsmm_decode(pool, user_id, date).await?);
    m.insert("railRouteCache".into(), rail_route_cache(pool).await?);
    m.insert("busRouteCache".into(), bus_route_cache(pool).await?);
    m.insert("railStopsCache".into(), rail_stops_cache(pool).await?);
    m.insert(
        "sleepWindows".into(),
        sleep_windows(pool, user_id, date).await?,
    );
    m.insert("venuePriors".into(), venue_priors(pool, user_id).await?);
    Ok(Value::Object(m))
}
