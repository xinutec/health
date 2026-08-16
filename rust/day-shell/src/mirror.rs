//! The OSM mirror, read directly — the production answer to the fold's
//! mid-run lookups (#959).
//!
//! # Why this is in Rust and not in Lean
//!
//! The standing rule is that as much as possible lives in Lean and Rust takes
//! only what proof would not help. A SQL round trip is exactly that: there is
//! no theorem about `MBRIntersects` worth having, and the answer is whatever
//! the mirror holds. What the fold DECIDES with — the matcher, the smoother,
//! the corrector, the display gate — is all Lean and stays there.
//!
//! # These are ports of three TS functions, and the port has to be exact
//!
//! ```text
//! queryWalkableRoads    src/geo/osm-local.ts:1027
//! queryDrivableRoads    src/geo/osm-local.ts:964
//! queryBuildingsNear    src/geo/osm-local.ts:1074
//! ```
//!
//! Same box, same subtype sets, same `LIMIT`, same minimum vertex counts, and
//! deliberately NO `ORDER BY` — because the TS has none either, and the fold's
//! way list is consumed in the order it arrives. Adding one here would be a
//! silent behaviour change dressed as tidiness.
//!
//! ⚠ `ensureCovered` is NOT here. It is the Overpass fetch that fills the
//! mirror on a cold miss, and it is deliberately out of scope: while the TS arm
//! still runs it has already covered the day's area for both buckets
//! (`nearbyWays` ensures `highway`, `nearbyBuildings` ensures `building`).
//! Porting HTTP and coverage bookkeeping belongs with deleting the TS geometry,
//! not before it. A read against an uncovered area answers EMPTY here, which
//! the counters in `osm.rs` report as a miss rather than hiding.
//!
//! # How it is checked
//!
//! Not by "it returned something". `--osm <captured trace>` answers the same
//! lookups from what the TS arm recorded on that day, so the two paths can be
//! run against each other on identical keys and must produce identical ways and
//! rings — `--osm-verify` does exactly that.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use mysql::prelude::*;
use mysql::{Opts, OptsBuilder, Pool, PooledConn};

/// `ROAD_CORRIDOR_MARGIN_M` — `osm-local.ts:951`.
const ROAD_CORRIDOR_MARGIN_M: f64 = 400.0;
/// `BUILDING_QUERY_MARGIN_M` — `osm-local.ts:1057`.
const BUILDING_QUERY_MARGIN_M: f64 = 100.0;

/// `WALKABLE_ROAD_SUBTYPES` — `osm-local.ts:1002`. Motorway and trunk are the
/// only highway classes left out: genuinely unwalkable. Every other road class
/// is in, because OSM rarely maps a main road's footway separately and
/// excluding them left holes in the pedestrian graph at every main road.
const WALKABLE_ROAD_SUBTYPES: &[&str] = &[
    "footway",
    "path",
    "pedestrian",
    "steps",
    "cycleway",
    "bridleway",
    "living_street",
    "residential",
    "service",
    "unclassified",
    "track",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
];

/// `DRIVABLE_ROAD_SUBTYPES` — `osm-local.ts:934`. ⚠ No `_link` variants, unlike
/// the walkable set. That asymmetry is the TS's and is reproduced rather than
/// tidied: changing which ways a road leg can match onto is a behaviour change,
/// and it belongs in the TS first where the corpus can grade it.
const DRIVABLE_ROAD_SUBTYPES: &[&str] = &[
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "service",
    "unclassified",
    "track",
    "living_street",
];

/// `NON_ENCLOSING_BUILDING_SUBTYPES` — `osm-local.ts:1065`. A roof over open
/// walkable ground is not an obstacle; treating one as impassable scores a walk
/// genuinely taken as crossing a building.
const NON_ENCLOSING_BUILDING_SUBTYPES: &[&str] = &["roof", "canopy"];

/// One way, in the shape [`crate::osm`] serves.
pub struct MirrorWay {
    pub osm_id: i64,
    pub name: Option<String>,
    pub subtype: Option<String>,
    pub coords: Vec<(f64, f64)>,
}

/// The pool, opened once on first use. A `Mutex` rather than a connection per
/// call: the fold's callbacks are synchronous and strictly sequential — it asks
/// one question, waits, and asks the next — so there is never contention to
/// resolve, only a borrow to make safe.
static CONN: Mutex<Option<PooledConn>> = Mutex::new(None);
static POOL: std::sync::OnceLock<Option<Pool>> = std::sync::OnceLock::new();

/// `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` — the same five the TS
/// reads in `src/config.ts:72`. Absent host or database means "no mirror
/// configured", which is not an error: it is the fixture-only and stub cases,
/// and they must keep working.
///
/// ⚠ DELIBERATELY NOT the TS's defaults, and this is the one place the two
/// disagree on purpose. `config.ts` defaults `host` to `health-db` and
/// `database` to `health`, because a server that cannot reach its database has
/// nothing to do. This has plenty to do without one — answer empty, count the
/// miss, let the fold draw raw — so defaulting would turn every dev-shell run
/// into a DNS timeout per lookup for a host that does not resolve. Both are set
/// in the production pod (checked against the live CronJob), so the difference
/// never shows there. `DB_PORT` DOES default, to the same 3306, because a port
/// is not evidence of intent the way a hostname is.
fn opts() -> Option<Opts> {
    let host = std::env::var("DB_HOST").ok()?;
    let database = std::env::var("DB_NAME").ok()?;
    Some(
        OptsBuilder::new()
            .ip_or_hostname(Some(host))
            .tcp_port(
                std::env::var("DB_PORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(3306),
            )
            .user(std::env::var("DB_USER").ok())
            .pass(std::env::var("DB_PASSWORD").ok())
            .db_name(Some(database))
            .into(),
    )
}

/// Whether a mirror is configured at all. Distinct from "the mirror answered
/// nothing", which is a finding about coverage.
pub fn configured() -> bool {
    POOL.get_or_init(|| opts().and_then(|o| Pool::new(o).ok()))
        .is_some()
}

/// Mirror queries that FAILED, as opposed to ones that answered nothing.
///
/// `with_conn` turns every failure into `None`, and every caller turns that
/// into an empty `Vec` — so a database that is down produces byte-for-byte the
/// same answer as an area with genuinely no roads. Worse, the miss it causes is
/// still paired with a `MIRROR_READS` increment, so `misses() > mirror_reads`
/// stays false and the `⚠ MISSES` guard never fires. A whole day could fold on
/// raw chords behind a summary line identical to a healthy one (health #976).
///
/// This counter is the only thing that separates the two.
///
/// ⚠ NOT incremented when no mirror is CONFIGURED. That is absence, not
/// failure, and counting it would light up every fixture-only run — training
/// the reader to ignore the one signal that means something.
static FAILS: AtomicU64 = AtomicU64::new(0);

/// Read the failure count and reset it, so a count belongs to one request.
pub fn take_fails() -> u64 {
    FAILS.swap(0, Ordering::Relaxed)
}

/// Run `f` with the shared connection, opening it on first use. `None` when no
/// mirror is configured or the connection cannot be made — the caller then
/// answers empty and counts a miss, rather than aborting a day's fold over a
/// database that is merely absent.
fn with_conn<T>(f: impl FnOnce(&mut PooledConn) -> mysql::Result<T>) -> Option<T> {
    // Before the counter, deliberately: an unconfigured mirror is absence.
    let pool = POOL.get_or_init(|| opts().and_then(|o| Pool::new(o).ok())).as_ref()?;
    // Past this point every `None` is a real failure — a poisoned lock, a
    // connection that would not open, or a query that errored. They are counted
    // together because the caller cannot act on the difference: all three yield
    // an empty answer that means "no roads here" downstream.
    let attempt = || -> Option<T> {
        let mut guard = CONN.lock().ok()?;
        if guard.is_none() {
            *guard = pool.get_conn().ok();
        }
        let conn = guard.as_mut()?;
        match f(conn) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("mirror: query failed: {e}");
                None
            }
        }
    };
    let out = attempt();
    if out.is_none() {
        FAILS.fetch_add(1, Ordering::Relaxed);
    }
    out
}

/// `bboxPolygonWkt(bbox)` — `osm-local.ts:843`, vertex for vertex. The ring is
/// closed by repeating the first corner, which is what `ST_GeomFromText`
/// requires of a polygon.
pub fn bbox_polygon_wkt(lat: f64, lon: f64, radius_m: f64, margin_m: f64) -> String {
    let d_lat = (radius_m + margin_m) / 111_320.0;
    let d_lon = (radius_m + margin_m) / (111_320.0 * (lat * std::f64::consts::PI / 180.0).cos());
    let (min_lat, max_lat) = (lat - d_lat, lat + d_lat);
    let (min_lon, max_lon) = (lon - d_lon, lon + d_lon);
    format!(
        "POLYGON(({min_lon} {min_lat},{max_lon} {min_lat},{max_lon} {max_lat},\
         {min_lon} {max_lat},{min_lon} {min_lat}))"
    )
}

/// `parseLineStringWkt(wkt)` — `osm-local.ts:823`. WKT writes `lon lat`; every
/// consumer here wants `(lat, lon)`, and the swap is where that happens.
/// A coordinate that does not parse is DROPPED, exactly as the TS's
/// `Number.isFinite` guard drops it.
pub fn parse_linestring_wkt(wkt: &str) -> Vec<(f64, f64)> {
    let t = wkt.trim();
    let Some(inner) = t
        .strip_prefix("LINESTRING(")
        .or_else(|| t.strip_prefix("LINESTRING ("))
        .and_then(|s| s.strip_suffix(')'))
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .filter_map(|pair| {
            let mut it = pair.split_whitespace();
            let lon: f64 = it.next()?.parse().ok()?;
            let lat: f64 = it.next()?.parse().ok()?;
            (lat.is_finite() && lon.is_finite()).then_some((lat, lon))
        })
        .collect()
}

/// `subtype IN (…)` with one placeholder per value — never interpolated, so a
/// subtype list can never become SQL.
pub fn placeholders(n: usize) -> String {
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(",")
}

fn query_ways(lat: f64, lon: f64, radius_m: f64, subtypes: &[&str]) -> Vec<MirrorWay> {
    let poly = bbox_polygon_wkt(lat, lon, radius_m, ROAD_CORRIDOR_MARGIN_M);
    let sql = format!(
        "SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt \
         FROM osm_lines \
         WHERE feature_type = 'highway' \
           AND subtype IN ({}) \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
         LIMIT 20000",
        placeholders(subtypes.len())
    );
    let mut params: Vec<mysql::Value> = subtypes.iter().map(|s| (*s).into()).collect();
    params.push(poly.into());
    with_conn(|c| {
        c.exec_map(
            &sql,
            params,
            |(osm_id, name, subtype, wkt): (i64, Option<String>, Option<String>, String)| MirrorWay {
                osm_id,
                name,
                subtype,
                coords: parse_linestring_wkt(&wkt),
            },
        )
    })
    .unwrap_or_default()
    .into_iter()
    // `coords.length >= 2` — a way with one vertex is not a line.
    .filter(|w| w.coords.len() >= 2)
    .collect()
}

pub fn walkable_roads(lat: f64, lon: f64, radius_m: f64) -> Vec<MirrorWay> {
    query_ways(lat, lon, radius_m, WALKABLE_ROAD_SUBTYPES)
}

pub fn drivable_roads(lat: f64, lon: f64, radius_m: f64) -> Vec<MirrorWay> {
    query_ways(lat, lon, radius_m, DRIVABLE_ROAD_SUBTYPES)
}

/// Building outlines as closed rings. `subtype IS NULL OR subtype NOT IN (…)`
/// is the TS's own predicate: an untagged building is enclosing, and only the
/// named roof-like subtypes are exempt.
pub fn buildings_near(lat: f64, lon: f64, radius_m: f64) -> Vec<Vec<(f64, f64)>> {
    let poly = bbox_polygon_wkt(lat, lon, radius_m, BUILDING_QUERY_MARGIN_M);
    let sql = format!(
        "SELECT ST_AsText(geom) AS wkt \
         FROM osm_lines \
         WHERE feature_type = 'building' \
           AND (subtype IS NULL OR subtype NOT IN ({})) \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
         LIMIT 20000",
        placeholders(NON_ENCLOSING_BUILDING_SUBTYPES.len())
    );
    let mut params: Vec<mysql::Value> = NON_ENCLOSING_BUILDING_SUBTYPES
        .iter()
        .map(|s| (*s).into())
        .collect();
    params.push(poly.into());
    with_conn(|c| c.exec_map(&sql, params, |wkt: String| parse_linestring_wkt(&wkt)))
        .unwrap_or_default()
        .into_iter()
        // `coords.length >= 3` — fewer than three vertices is not a polygon.
        .filter(|r| r.len() >= 3)
        .collect()
}
