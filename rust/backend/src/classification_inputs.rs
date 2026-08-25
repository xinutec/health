//! The day's inputs, read from the database (#982).
//!
//! Port of the DB half of `src/geo/load-classification-inputs.ts`. That file
//! loads twelve things in parallel plus four PhoneTrack range fetches; this is
//! the nine whose shape is pure SQL and whose output is a fixture field.
//!
//! ⚠ ALL TWELVE ARE HERE. `load` was `load_partial` while any were missing, and
//! the rename is the record of that closing — the day's inputs no longer need
//! Node to be assembled.
//!
//! ⚠ ONE OF THEM REPRODUCES A KNOWN DEFECT ON PURPOSE: PhoneTrack's
//! `maxPoints=10000` silently truncates (#1032). Parity is what makes the
//! TypeScript deletable, so the port keeps the cap rather than quietly
//! out-fetching the arm it is being compared against. See
//! `phonetrack_windows`.
//!
//! ⚠ `biometrics` TAKES home_tz TWICE, as `home_tz` and as the caller's `tz`.
//! In `loadBiometrics` those are two distinct arguments: `home_tz` read from
//! sync_state, and the display tz the request resolved. On the loader path they
//! are the same value, and passing it twice is honest about that rather than
//! dropping a parameter the TypeScript has — the two differ only for a caller
//! that does not exist yet.
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
//! knownPlaces      117 places      byte-identical
//! biometrics       1440 hr, 30 sleep, 250 steps   byte-identical
//! motionLog        611 fixes       byte-identical
//! modeBiometrics   6 modes         byte-identical
//! hsmmDecode       29 segments     byte-identical
//! homeTz                           byte-identical
//! sleepWindows                     byte-identical
//! emptyDayBracket                  byte-identical
//! venuePriors                      byte-identical
//! railRouteCache    48/51 shared rows byte-identical - 3 re-mined 08-20 05:10
//! busRouteCache    959/994           - 35 re-mined, newest 08-21 05:42
//! railStopsCache   231/259           - table rewritten 08-20 06:11
//! ```
//!
//! ⚠ BYTE-identical, compared as SERIALISED TEXT. A `jq` comparison is not
//! enough and said "no mismatch" while three fields were still wrong: jq parses
//! both sides to doubles, so `25.0 == 25`. See `js_num`.
//!
//! ⚠ THE THREE PARTIAL ROWS ARE DRIFT, AND THAT IS MEASURED RATHER THAN
//! ASSUMED: every differing row's `computed_at` is later than the fixture's
//! capture, and the differences are changed COORDINATES, not changed
//! renderings. "It must be drift" is what the first reading of #1052 said too.
//!
//! Five defects this diff caught that `backend check` could not, all of the
//! same kind — a value that decodes or renders to something plausible and
//! wrong:
//!
//!   * `hour_profile` read as JSON when it is comma-separated per-mille
//!     integers, so all 117 profiles decoded to absent;
//!   * `minutesAsleep` rendered `553.0` against the TypeScript's `553`;
//!   * `osmRelationId` likewise, which made a thousand identical rows share
//!     ZERO keys when diffed on it;
//!   * every integral `f64` — `radiusM`, `sleepHours`, `accM`, and each zero
//!     bucket of an hour profile — for the same reason, now `js_num`;
//!   * `ROUND(AVG(bpm))` is a DECIMAL, so the HR stream would not decode at
//!     all until it was CAST AS CHAR.
//!
//! ⚠ TWO OF THOSE WERE CAUGHT BY THE HELPERS REFUSING RATHER THAN DEFAULTING —
//! `num` errors on a type it cannot read, and `presence_log`'s INT UNSIGNED and
//! the bpm DECIMAL both came back as errors naming the column. That is the
//! whole argument for not writing `unwrap_or_default()` in a loader.
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

/// A `f64` rendered the way `JSON.stringify` renders a JS number.
///
/// ⚠ THIS IS NOT COSMETIC. Every one of these columns reaches the TypeScript
/// through `Number(...)`, and JS has ONE number type: `JSON.stringify(25)` is
/// `25`, never `25.0`. `serde_json` keeps the f64-ness and writes `25.0`, so a
/// radius of 25 m, a sleep total of 998 h and an accuracy of 15 m all rendered
/// differently in the two arms while being the same number.
///
/// A cast to `i64` would NOT do: `radius_m` is genuinely fractional for most
/// places, and forcing it to an integer would change the value rather than the
/// rendering. The rule is JS's own — integral doubles print without a fraction,
/// everything else prints as itself.
///
/// ⚠ INVISIBLE TO A `jq` COMPARISON, which is how it survived the first parity
/// pass: jq parses both sides to doubles, so `25.0 == 25` and a keyed diff
/// reports no mismatch. It shows up only when the SERIALISED text is compared,
/// which is what a fixture actually stores.
pub fn js_num(v: f64) -> Value {
    // ⚠ THE BOUND IS i64's RANGE, NOT 2^53. An integral f64 casts to i64
    // exactly anywhere it fits, and JS prints plain digits until 1e21 — which
    // is past i64::MAX — so inside this window the two agree. Outside it, and
    // for NaN or an infinity, fall through: `as i64` SATURATES rather than
    // failing, and a saturated value is a wrong number that looks like a right
    // one. None of these columns can reach that, and the branch is here so
    // that stays true if one ever does.
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
            "centroidLat": js_num(num(r, "centroid_lat")?),
            "centroidLon": js_num(num(r, "centroid_lon")?),
            "radiusM": js_num(num(r, "radius_m")?),
            "displayName": r.try_get::<Option<String>, _>("display_name").context("display_name")?,
            // `?? 0` in the TS: an unmined row has no sleep evidence, which is
            // zero hours, not "unknown".
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
        // ⚠ `js_num`: a zero bucket is `0` in the TypeScript, not `0.0`, and
        // most profiles have several.
        out.push(js_num(n / 1000.0));
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
            "lat": js_num(num(r, "lat")?),
            "lon": js_num(num(r, "lon")?),
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

/// The day's Fitbit streams: per-minute HR, sleep stages, and stepped minutes.
///
/// Port of `loadBiometrics` in `src/geo/velocity.ts`. SIX queries, not three:
/// each stream has a primary read on the derived `ts_utc` column and a fallback
/// for the stragglers where `ts_utc IS NULL`.
///
/// ⚠ THE FALLBACK IS NOT DEAD CODE AND MUST NOT BE DROPPED. Those rows predate
/// the backfill that derives `ts_utc`; they carry a WALL CLOCK plus a `tz`, and
/// the tz chain is `row.tz -> home_tz -> the caller's tz` (`docs/design/
/// timezone.md`). A port that kept only the primary read would lose them
/// silently — the day would decode, with less biometric evidence than the
/// TypeScript had, and nothing would say so.
///
/// ⚠ THE TWO PATHS BOUND THE WINDOW DIFFERENTLY, and that asymmetry is copied
/// deliberately rather than tidied: the primary is `>= start AND < end` in SQL,
/// the fallback is `>= start AND <= end` in the loop (`ts < startUtc || ts >
/// endUtc` skips). Sleep's fallback is different again — an OVERLAP test, since
/// a stage that begins before the window can still land inside it. Making these
/// agree would be a behaviour change wearing a cleanup's clothes.
///
/// ⚠ `ROUND(AVG(bpm))` STAYS IN SQL. Fitbit stores HR at 1 s (~21 k rows/day)
/// and the pipeline wants per-minute; doing the rounding in MySQL is what the
/// TypeScript does, so both arms inherit the same half-away-from-zero rule
/// rather than Rust's round-half-to-even disagreeing on every .5.
///
/// ⚠ AND IT IS CAST TO CHAR, because `AVG` returns a DECIMAL and sqlx will not
/// decode one — the same trap as `focus_places.centroid_lat`, one aggregate
/// further along. `num` REFUSED it rather than defaulting, which is exactly why
/// that helper errors instead of falling back to zero: a bpm of 0 for every
/// minute of a day would otherwise have printed as a full stream.
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
        // ⚠ The TS skips a NULL here even though the WHERE cannot return one.
        // Kept: it costs nothing and it is the shape of the row, not a guess.
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
        // ⚠ An OVERLAP test, not a containment one — a stage beginning before
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
    steps.sort_by_key(|&(ts, _)| ts);

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

/// A wall clock plus a resolved zone, as a Unix timestamp — or `None`.
///
/// `None` covers both of the TS's `Number.isNaN` exits: an unparseable clock,
/// and a row whose tz chain resolved to nothing. The caller SKIPS the row in
/// both cases, which is what `if (Number.isNaN(ts)) continue` does.
fn wall_clock_ts_str(raw: &str, tz: Option<&str>) -> Option<i64> {
    match tz {
        // `fitbitTsToUnix` with no tz reads the components as UTC.
        None => crate::timezone::parse_wall_clock(raw).map(|d| d.and_utc().timestamp()),
        Some(tz) => crate::timezone::wall_clock_to_unix(raw, tz),
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC. Mirrors `utcSecondsToDatetimeStr`.
fn utc_seconds_to_datetime_str(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// `YYYY-MM-DD` in UTC — the TS `padDate`.
fn utc_seconds_to_date_str(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// A `YYYY-MM-DD HH:MM:SS` UTC datetime as Unix seconds. Mirrors
/// `utcDatetimeStrToSeconds`, which reads the components AS UTC — the stored
/// bytes are UTC by the column's contract, not by a zone conversion.
fn utc_datetime_str_to_seconds(s: &str) -> Option<i64> {
    crate::timezone::parse_wall_clock(s).map(|d| d.and_utc().timestamp())
}

/// The pre-resolved cross-day bracket for a no-data day, or `null`.
///
/// ⚠ THE RULE IS AGREEMENT, NOT PRESENCE. A day with no observations is not
/// automatically unknown: if the previous day ENDED at place X and the next
/// day's DOMINANT place is also X, the user was at X throughout — the classic
/// multi-day hospital stay. Either side missing, or the two disagreeing, and
/// there is no bracket; the day stays blank rather than being guessed at.
/// `bracketedStayPlaceId` is that whole rule and it is three lines, so it is
/// inlined here rather than given a module.
///
/// Only consumed when the day has no states AND no points (#1055).
pub async fn empty_day_bracket(pool: &MySqlPool, user_id: &str, date: &str) -> Result<Value> {
    // ⚠ `u64`, NOT `i64`. `presence_log.*_place_id` is INT UNSIGNED, which sqlx
    // treats as a distinct type and refuses to hand back as a signed integer —
    // the same trap `num` carries a branch for, met here through `query_scalar`
    // where there is no helper to fall back through.
    let prev: Option<u64> = {
        // ⚠ TWO distinct absences, and both are real: no ROW for that date, and
        // a row whose place id is NULL. `fetch_optional` answers the first and
        // `try_get::<Option<u64>>` the second.
        //
        // ⚠ `u64`, NOT `i64`. `presence_log.*_place_id` is INT UNSIGNED, which
        // sqlx treats as a distinct type and REFUSES to hand back as signed.
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
        // ⚠ TWO distinct absences, and both are real: no ROW for that date, and
        // a row whose place id is NULL. `fetch_optional` answers the first and
        // `try_get::<Option<u64>>` the second.
        //
        // ⚠ `u64`, NOT `i64`. `presence_log.*_place_id` is INT UNSIGNED, which
        // sqlx treats as a distinct type and REFUSES to hand back as signed.
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
        return Ok(Value::Null);
    };
    if prev != next {
        return Ok(Value::Null);
    }

    // ⚠ CAST AS CHAR: DECIMAL again, and this one is the centroid that names
    // the stay. Getting 0.0 here would place a hospital admission in the Gulf
    // of Guinea and still return a bracket.
    let row = sqlx::query(
        "SELECT CAST(centroid_lat AS CHAR) AS centroid_lat, \
         CAST(centroid_lon AS CHAR) AS centroid_lon FROM focus_places WHERE id = ?",
    )
    .bind(prev)
    .fetch_optional(pool)
    .await
    .context("reading the bracket's focus place")?;
    // A bracket pointing at a place that no longer exists is no bracket. The TS
    // returns null on `fp === undefined` for the same reason.
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "centroidLat": js_num(num(&row, "centroid_lat")?),
        "centroidLon": js_num(num(&row, "centroid_lon")?),
    }))
}

/// `date` shifted by whole days, as `YYYY-MM-DD`. Mirrors `shiftDay`.
/// ⚠ `pub` because `decode-day` needs the SAME day arithmetic for its
/// continuity seed. Subtracting 86400 from a timestamp instead lands on the
/// same civil date across a DST boundary, and the chain would seed itself from
/// today.
pub fn shift_day(date: &str, days: i64) -> Result<String> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?;
    Ok((d + chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string())
}

/// The default decode window: `n` days ending YESTERDAY, most recent first.
///
/// ⚠ STARTS AT YESTERDAY, never today, and `src/cli/decode-day.ts` loops
/// `d = 1; d <= days` for the same reason. At the cron's 06:00 today is a
/// six-hour stub, and `save_decode` stamps whatever it writes with the current
/// `CLASSIFIER_VERSION` — so a stub row does not read as stale to a consumer,
/// it reads as a decoded day that happens to be nearly empty. Starting at 0
/// also drops the oldest day of the requested window, silently.
pub fn decode_window(now: chrono::DateTime<chrono::Utc>, days: i64) -> Vec<String> {
    (1..=days)
        .map(|o| {
            (now - chrono::Duration::days(o))
                .format("%Y-%m-%d")
                .to_string()
        })
        .collect()
}

/// The PhoneTrack half of the day's inputs: three fix windows and the battery
/// tail. The last input, and the only one that is not SQL.
///
/// ⚠ THE THREE WINDOWS ARE NOT THE DAY. `today` is the date's own UTC span,
/// `morning` reaches to noon UTC on the following day, and `priorEvening` back
/// to noon UTC on the previous one — because a local day is not a UTC day, and
/// a segment that starts before local midnight or ends after it needs fixes
/// from outside the date to be reconstructed at all.
///
/// ⚠ `batteryTail` IS DISPLAY-ONLY and its window covers a gap neither of the
/// others does: from the LOCAL day end to 18 h later. When the phone goes on
/// charge in the evening and stops reporting, the next reading lands in the
/// local-day-end..next-UTC-midnight hole, and the battery chart needs it to
/// draw an angled line instead of stopping dead.
///
/// # ⚠ THIS REPRODUCES A KNOWN DEFECT, DELIBERATELY (#1032)
///
/// `maxPoints=10000` is a silent cap: PhoneTrack truncates and says nothing, and
/// a 7-day chunk at one fix a minute is 10,080. The port keeps it because
/// PARITY IS WHAT MAKES THE TYPESCRIPT DELETABLE — a Rust arm that quietly
/// fetched more would diff against the TS as a defect in the port, and the real
/// defect would be harder to see, not easier. Fixing it is #1032's job and it
/// has to move both arms at once, or neither.
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
    // `${nextDay}T12:00:00Z` and `${prevDay}T12:00:00Z` — noon UTC, expressed
    // as midnight plus half a day so there is one date parser here, not two.
    let noon = 12 * 3600;
    let today = (midnight(date)?, midnight(&next_day)?);
    let morning = (midnight(&next_day)?, midnight(&next_day)? + noon);
    let prior_evening = (midnight(&prev_day)? + noon, midnight(date)?);
    let tail = (day_end_utc, day_end_utc + BATTERY_TAIL_LOOKAHEAD_H * 3600);

    let mut fetched = Vec::with_capacity(4);
    for (a, b) in [today, morning, prior_evening, tail] {
        let f = pt
            .fetch_window(pool, a, b)
            .await
            .with_context(|| format!("fetching PhoneTrack fixes for [{a}, {b}]"))?;
        // ⚠ A PARTIAL WALK IS SAID OUT LOUD. `failed_devices` is the difference
        // between "the phone was off" and "one device 500ed", and the whole
        // pipeline reads absence of fixes as evidence about where someone was.
        if f.failed_devices > 0 {
            tracing::warn!(
                "phonetrack: {} device(s) failed for [{a}, {b}] — these fixes are a SUBSET of the \
                 window, and a gap in them is not evidence of stillness",
                f.failed_devices
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

/// `BATTERY_TAIL_LOOKAHEAD_H` from `src/geo/load-classification-inputs.ts`.
const BATTERY_TAIL_LOOKAHEAD_H: i64 = 18;

/// The day-path default for the Nextcloud base URL.
///
/// ⚠ NOT the same as `Config::nextcloud_base_url` being `None`. That Option is
/// the SYNC path's, where an unset `NC_BASE_URL` legitimately means "do not do
/// PhoneTrack tz inference" (#1037). The DAY path has always had a default —
/// `decode-day.ts` and `config.ts` both `.default(...)` it — because a day
/// without GPS is not a day. Collapsing the two would either break sync or
/// silently blank every timeline.
pub const DAY_NEXTCLOUD_BASE_URL: &str = "https://dash.xinutec.org";

/// Which day, for whom, in which zone — the TypeScript's `DayIdentity`.
///
/// ⚠ `display_tz` IS NOT `home_tz`. This one bounds the local day and is the
/// zone the day was LIVED in; `home_tz` is the profile's, and is only the
/// fallback for segments no GPS fix covers. They coincide for a user at home,
/// which is exactly why passing one for the other goes unnoticed until someone
/// travels.
#[derive(Debug, Clone, Copy)]
pub struct DayIdentity<'a> {
    pub user_id: &'a str,
    pub date: &'a str,
    pub display_tz: &'a str,
}

/// Every day input, in the field order `SerializedInputs` uses.
///
/// ⚠ NO LONGER PARTIAL. It was `load_partial` while any input was missing, and
/// the name was the record of that — an absent key is a caller's error, an empty
/// array is a day with no rail cache, and the two must not look alike. All
/// twelve are here now.
///
/// `osm` is deliberately absent: it is an ADAPTER, not data, and
/// `toSerializedInputs` strips it for the same reason. `osmTrace` / `osmRowSet`
/// belong to fixture capture, not to loading.
pub async fn load(
    pool: &MySqlPool,
    http: &reqwest::Client,
    base_url: &str,
    identity: &DayIdentity<'_>,
    bounds: crate::timezone::DayBounds,
    home_tz: Option<&str>,
) -> Result<Value> {
    let DayIdentity {
        user_id,
        date,
        display_tz,
    } = *identity;
    let (start_utc, end_utc) = (bounds.start_utc, bounds.end_utc);
    let (phonetrack, battery_tail) =
        phonetrack_windows(pool, http, base_url, user_id, date, end_utc).await?;
    let mut m = Map::new();
    m.insert(
        "identity".into(),
        json!({"userId": user_id, "date": date, "displayTz": display_tz}),
    );
    m.insert("phonetrack".into(), phonetrack);
    m.insert("batteryTail".into(), battery_tail);
    m.insert("knownPlaces".into(), known_places(pool, user_id).await?);
    m.insert(
        "biometrics".into(),
        biometrics(pool, user_id, start_utc, end_utc, home_tz, home_tz).await?,
    );
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
    // ⚠ `homeTz` is ALREADY DEFAULTED by the time it reaches here, matching the
    // TS `homeTzRaw ?? "Europe/Amsterdam"`. The default is the pipeline's
    // displayTz fallback for segments no GPS fix covers, so an absent value and
    // the default are the same day — but the defaulting has to happen once, and
    // the caller is where it happens.
    m.insert(
        "homeTz".into(),
        Value::String(home_tz.unwrap_or("Europe/Amsterdam").to_string()),
    );
    m.insert(
        "sleepWindows".into(),
        sleep_windows(pool, user_id, date).await?,
    );
    m.insert(
        "emptyDayBracket".into(),
        empty_day_bracket(pool, user_id, date).await?,
    );
    m.insert("venuePriors".into(), venue_priors(pool, user_id).await?);
    Ok(Value::Object(m))
}
