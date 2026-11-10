//! Candidate OSM rows from the live mirror, for the fold's asks (#982, #1709).
//!
//! [`RowSetSource`](crate::rowset_answerer::RowSetSource) answers from the rows
//! a golden fixture carries, which is what made the day port checkable with no
//! database. This is the other implementation of the same trait: the rows come
//! from `osm_points`/`osm_lines` in production.
//!
//! # ⚠ The SQL is a PRE-FILTER. It is not allowed to score.
//!
//! `osm-local.ts`'s `queryPoints`/`queryLines` compute the distance,
//! order by it and `LIMIT 50`, all inside MariaDB. **None of that is copied
//! here**, and the omission is the point rather than an oversight:
//!
//!   * `ST_Distance` on a multi-vertex LINESTRING returns the distance to the
//!     nearest VERTEX, not the perpendicular distance to the way. That is the
//!     defect health #413 is open about — worst measured 37.96 m on
//!     `nearbyWays` — and reproducing the `ORDER BY` would reproduce it;
//!   * the cap and the ordering belong to `Verified.Geo.OsmSpatial`, which is
//!     where every other caller of this trait already gets them from.
//!
//! So the statements below select CANDIDATES inside a bounding box and hand
//! every one of them to Lean.
//!
//! Measured when the oracle swapped (#413, 2026-08-02): across every day both
//! oracles replayed, 0 of 315 timeline states changed `place` or `wayName`.
//! This source also drops the `LIMIT 50`; the corpus has been blessed against
//! it since.
//!
//! # ⚠ The box must be a SUPERSET of Lean's scoring window
//!
//! A row the SQL drops is a row Lean never sees, so the pre-filter can only be
//! allowed to over-include. The box is the TypeScript's own — half-width
//! `radiusM / min(111000, 111000·cos lat)` in BOTH axes — and it contains both
//! of Lean's windows:
//!
//!   * `queryLines` scores in DEGREE space against `radiusM / (111320·cos lat)`,
//!     which is the smaller half-width of the two (111320 > 111000);
//!   * `queryPoints` scores in METRES with `haversineAt`. The box's latitude
//!     half-width is `radiusM · 111000·cos(lat) / 111000` ≥ `radiusM` in metres
//!     for every `lat`, and its longitude half-width is `radiusM` exactly.
//!
//! Both hold for the whole inhabited range. The constants are deliberately the
//! mirror's own `111000` rather than the Kalman filter's `111320` — see
//! `Verified.Geo.OsmCoverage.METERS_PER_DEG_LAT`, which says the same thing
//! about the same number.
//!
//! # The coverage gate, and what a decline means here
//!
//! The TypeScript's `ensureCovered` fetched from Overpass when an area had not
//! been filled. This source does not: it asks
//! [`lean::osm_covered`](crate::lean::osm_covered), and where the TypeScript
//! fetched, this DECLINES. A decline is honest — the fold records the key as
//! unanswerable and the caller can see it — where an empty row list would be the
//! claim that there are no roads there (#976).
//!
//! ⚠ **AND IT RECORDS THE DECLINE.** The write half is [`crate::osm_mirror`],
//! drained beside the pod by [`crate::fetch_drain`] (#1889): a fetch here would
//! put an Overpass round trip on the serving path, which is what the queue
//! exists to avoid (#1076, #1658).
//!
//! The three matcher reads — `walkableRoads`, `buildingsNear`,
//! `drivableRoads` — come through here too (#1709), on the same pool and
//! through the same coverage gate, so a decline on the walk path is recorded
//! exactly as one on the naming path is.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

use crate::fold_payload::bits;
use crate::lean::{self, CoverageRow};
use crate::rowset_answerer::RowSource;

/// How far beyond the asked disc a ROAD corridor read reaches. The corridor
/// fetch samples the leg and unions the ways around each sample; the margin is
/// what lets a way that starts just outside one sample's disc still be found.
/// ⚠ Applied AFTER the ask key is formed, so moving it changes production and
/// changes nothing any fixture answers — which is why it is stamped into a
/// capture's `meta` (`osm_trace::capture_inputs`).
pub const ROAD_CORRIDOR_MARGIN_M: f64 = 400.0;

/// As above, for building outlines around a walk.
const BUILDING_QUERY_MARGIN_M: f64 = 100.0;

pub const WALKABLE_ROAD_SUBTYPES: &[&str] = &[
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

/// An untagged building is enclosing; only the named roof-like subtypes are
/// exempt.
const NON_ENCLOSING_BUILDING_SUBTYPES: &[&str] = &["roof", "canopy"];

/// `subtype IN (…)` with one placeholder per value — never interpolated.
fn placeholders(n: usize) -> String {
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(",")
}

/// The matcher reads' box: the disc plus a margin, in degrees.
fn margin_box_wkt(lat: f64, lon: f64, radius_m: f64, margin_m: f64) -> String {
    let d_lat = (radius_m + margin_m) / 111_320.0;
    let d_lon = (radius_m + margin_m) / (111_320.0 * lat.to_radians().cos());
    let (min_lat, max_lat) = (lat - d_lat, lat + d_lat);
    let (min_lon, max_lon) = (lon - d_lon, lon + d_lon);
    format!(
        "POLYGON(({min_lon} {min_lat},{max_lon} {min_lat},{max_lon} {max_lat},\
         {min_lon} {max_lat},{min_lon} {min_lat}))"
    )
}

/// How much larger than the TypeScript's box, and why it is not 1.
///
/// # ⚠ The unwidened box clears Lean's window by 0.18%
///
/// The TypeScript's own half-width is `radiusM / min(111000, 111000·cos lat)`,
/// and it only ever had to contain MariaDB's scoring, which happened inside the
/// same query. This box feeds a DIFFERENT scorer, so what it has to contain is
/// Lean's window, and the two clear each other by the ratio between constants
/// that live in different files:
///
///   * points — `haversineAt` measures metres on a sphere of radius
///     `LEAN_EARTH_R`, so one degree is ~111195 m. The box's half-width is
///     `radiusM · 111195/111000` = 1.0018·`radiusM` in both axes;
///   * lines — `queryLines` compares a degree-space distance against
///     `radiusM / (111320·cos lat)`, and 111320/111000 is the same 1.0029.
///
/// **Measured, not reasoned:** shrinking the box by 1% loses rows on the corpus
/// (`tests/suite/mirror_source.rs`, ablated 2026-08-22 — 4 of 7 ways at one query
/// point); shrinking it by 0.1% does not. So the corpus sits inside that margin,
/// and a change to any one of those three constants would silently start
/// dropping the nearest way.
///
/// # Why widening is the safe direction here and not a moved goalpost
///
/// A row this box admits that Lean scores out costs one comparison and changes
/// no answer; a row it excludes changes the answer with nothing to show for it.
/// The two errors are not symmetric, so the margin buys real safety at a price
/// of a few candidate rows at a 50–200 m radius. It is NOT a tolerance on a
/// result — nothing downstream compares against it.
const SUPERSET_MARGIN: f64 = 1.05;

/// A backstop, not a cap the queries may spend.
///
/// The point buckets are asked with 50–200 m radii
/// (`fold_payload::default_radius_m`), so a bucket inside one box is tens of
/// rows in the densest city, and reaching this many means the box is not the
/// box this module thinks it is: the run ERRORS rather than answering from a
/// truncated set — a silently truncated candidate list scores as "the nearest
/// way is 40 m away" with no way to tell it from the truth.
///
/// ⚠ THE MATCHER READS ARE NOT THAT SHAPE, and they DECLINE here instead of
/// erroring. A walk's disc is its own extent plus 120 m — routinely 500–1800 m
/// (measured over the golden corpus 2026-09-25: 14 walkable-roads asks over
/// 1 km, three within 300 rows of this cap, one AT it) — and the corridor box
/// adds 400 m a side, so a central-London walk asks for 10,000–20,000 highway
/// rows. Two production days (a 1.4 km and a 4.3 km disc) answered 400 for the
/// whole day because one leg crossed this line. A declined leg draws as a raw
/// chord and the day SAYS so (`declined_by_table`); a failed day draws nothing.
pub const CANDIDATE_LIMIT: i64 = 20_000;

/// SQL statements this source has issued, process-wide.
///
/// ⚠ A DENOMINATOR, not a performance counter. A round trip costs far more over
/// `scripts/prod-db.sh`'s SSH tunnel than inside the cluster (measured
/// 2026-08-17: 54 s in-cluster vs 64 min tunnelled, same work), so a duration
/// measured from the Mac says nothing about production unless the query count is
/// known.
///
/// ⚠ "The fold is dominated by round trips" is REFUTED (#1071): halving the
/// queries — 489 to 273 on one day — moved fold time by 0-17%. That claim came
/// from dividing fold time by query count, which assumes what it appears to
/// measure. [`take_db_nanos`] exists so the question is answered, not inferred.
static QUERIES: AtomicU64 = AtomicU64::new(0);

/// Nanoseconds spent INSIDE [`MirrorSource::block`] — the database, and nothing
/// else. Paired with [`QUERIES`] so a per-query cost can be stated rather than
/// derived from the fold's total.
static DB_NANOS: AtomicU64 = AtomicU64::new(0);

/// Read the query count and reset it, so a count belongs to one request.
pub fn take_queries() -> u64 {
    QUERIES.swap(0, Ordering::Relaxed)
}

/// Read the accumulated database time and reset it.
///
/// ⚠ Wall clock inside `block_on`, so it includes waiting for the connection
/// pool as well as the query. That is the right boundary for "would fewer
/// queries help": pool contention is a cost of issuing queries too.
pub fn take_db_nanos() -> u64 {
    DB_NANOS.swap(0, Ordering::Relaxed)
}

/// Rows from the live mirror. One per fold: the coverage decisions it
/// memoises are only valid for the `now_ms` it was built with.
/// The side of a tile the line and point reads are cached by, in degrees: about
/// 550 m north–south and 350 m east–west in London. A walk asks for the ways
/// around each of its fixes, metres apart, so consecutive asks share their
/// tiles: one read and one parse per tile replace one per ask.
const TILE_DEG: f64 = 0.0025;

/// Which mirror table a tile holds.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Geo {
    Lines,
    Points,
}

/// One feature, held as numbers: its bounding box
/// (`[min_lat, max_lat, min_lon, max_lon]`) to pick it for an ask, and what
/// its answer row is built from. Coordinates are kept as `f64` and spelled as
/// the answer's bit-pattern strings only when an ask returns the feature —
/// held as those strings, a tile cost several times the memory.
struct CachedRow {
    mbr: [f64; 4],
    osm_id: i64,
    subtype: Value,
    name: Value,
    tags: Value,
    geom: CachedGeom,
}

enum CachedGeom {
    Line(Vec<(f64, f64)>),
    Point(f64, f64),
}

impl CachedRow {
    /// The row as `line_rows` / `point_rows` answer it.
    fn row(&self) -> Value {
        match &self.geom {
            CachedGeom::Line(pts) => {
                let coords: Vec<Value> = pts
                    .iter()
                    .map(|(la, lo)| json!([bits(*la), bits(*lo)]))
                    .collect();
                json!([self.osm_id, self.subtype, self.name, coords, self.tags])
            }
            CachedGeom::Point(la, lo) => {
                json!([
                    self.osm_id,
                    self.subtype,
                    self.name,
                    bits(*la),
                    bits(*lo),
                    self.tags
                ])
            }
        }
    }
}

/// The mirror's lines and points, read by tile and kept for the fold.
///
/// An ask's candidates are the cached features whose box meets its candidate
/// box — the predicate the per-ask SQL applied (`MBRIntersects`) — so the
/// candidate set is the one the database would have returned, read once. The
/// order is the features' key, `(osm_type, osm_id)`: the database returned its
/// spatial index's order, which nothing defined, and Lean's stable sort by
/// distance carried that order into ties.
/// A tile of one bucket of one table: `(table, bucket, lat index, lon index)`.
type TileKey = (Geo, String, i64, i64);
/// A feature's key in its table: `(osm_type, osm_id)`.
type FeatureKey = (String, i64);

#[derive(Default)]
struct TileCache {
    fetched: HashSet<TileKey>,
    rows: HashMap<(Geo, String), BTreeMap<FeatureKey, CachedRow>>,
    by_tile: HashMap<TileKey, Vec<FeatureKey>>,
}

fn tile_of(deg: f64) -> i64 {
    (deg / TILE_DEG).floor() as i64
}

fn boxes_meet(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] <= b[1] && a[1] >= b[0] && a[2] <= b[3] && a[3] >= b[2]
}

pub struct MirrorSource {
    pool: MySqlPool,
    /// ⚠ The runtime this blocks on, captured by the caller. See
    /// [`with_mirror_answerer`] — this type must not be driven from async code.
    handle: tokio::runtime::Handle,
    /// The clock, owned by the host. Lean's staleness rule takes it as an
    /// argument so that the decision does not depend on when it was asked.
    now_ms: i64,
    /// Coverage boxes per feature bucket, read once each. `readCoverage` is
    /// "cheap (~tens of rows)" in the TypeScript and a day asks its buckets
    /// dozens of times, so re-reading them would be the query this walk repeats
    /// most.
    coverage: HashMap<String, Vec<CoverageRow>>,
    /// Coverage VERDICTS, keyed by the question rather than the bucket: the
    /// local-data probe is two indexed queries and the same coordinate is asked
    /// for several tables.
    decided: HashMap<(String, u64, u64, u64), bool>,
    /// Every distinct railway line name, read once. ~1k strings.
    ///
    /// ⚠ Cached for the same reason the TypeScript caches it, which is not
    /// tidiness: without it each `stationsOnLine` is a `DISTINCT name` scan, and
    /// a day asks about a dozen lines.
    rail_names: Option<Vec<String>>,
    /// Every railway station point, read once. ~1.2k rows.
    ///
    /// ⚠ Pre-fetched WHOLE rather than per-line bbox, which is the TypeScript's
    /// measured choice: a London-wide MBR query against a million-row
    /// `osm_points` takes ~30 s even when only ~100 stations match, because the
    /// spatial index is poorly suited to a box tens of km on a side. One small
    /// indexed read plus an in-memory filter per line is far cheaper.
    rail_stations: Option<Vec<Value>>,
    /// The line and point reads, by tile ([`TileCache`]).
    tiles: TileCache,
}

impl MirrorSource {
    /// ⚠ Call from a BLOCKING thread only. [`with_mirror_answerer`] is the
    /// supported entry point; constructing this on a runtime worker and letting
    /// a query reach it aborts the process rather than returning an error.
    pub fn new(pool: MySqlPool, handle: tokio::runtime::Handle, now_ms: i64) -> Self {
        Self {
            rail_names: None,
            rail_stations: None,
            pool,
            handle,
            now_ms,
            coverage: HashMap::new(),
            decided: HashMap::new(),
            tiles: TileCache::default(),
        }
    }

    /// Read every tile the box touches that `buckets` have not been read for,
    /// in ONE query over the tiles still missing (a lookup whose box straddles
    /// four tiles is still one read), each row filed under every tile it meets.
    fn fetch_tiles(&mut self, geo: Geo, buckets: &[&str], bx: &[f64; 4]) -> Result<()> {
        let mut missing: Vec<(String, i64, i64)> = Vec::new();
        for ti in tile_of(bx[0])..=tile_of(bx[1]) {
            for tj in tile_of(bx[2])..=tile_of(bx[3]) {
                for b in buckets {
                    if !self
                        .tiles
                        .fetched
                        .contains(&(geo, (*b).to_string(), ti, tj))
                    {
                        missing.push(((*b).to_string(), ti, tj));
                    }
                }
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        let mut want: Vec<&str> = buckets
            .iter()
            .copied()
            .filter(|b| missing.iter().any(|m| m.0 == *b))
            .collect();
        want.dedup();
        let ti0 = missing.iter().map(|m| m.1).min().unwrap_or(0);
        let ti1 = missing.iter().map(|m| m.1).max().unwrap_or(0);
        let tj0 = missing.iter().map(|m| m.2).min().unwrap_or(0);
        let tj1 = missing.iter().map(|m| m.2).max().unwrap_or(0);
        let (s, w) = (ti0 as f64 * TILE_DEG, tj0 as f64 * TILE_DEG);
        let (n, e) = ((ti1 + 1) as f64 * TILE_DEG, (tj1 + 1) as f64 * TILE_DEG);
        let poly = format!("POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))");
        let placeholders = std::iter::repeat_n("?", want.len())
            .collect::<Vec<_>>()
            .join(",");
        let (table, geom_cols) = match geo {
            Geo::Lines => ("osm_lines", "ST_AsText(geom) AS wkt"),
            Geo::Points => ("osm_points", "ST_X(geom) AS lon, ST_Y(geom) AS lat"),
        };
        let sql = format!(
            "SELECT feature_type, osm_type, osm_id, subtype, name, tags_json, {geom_cols} \
             FROM {table} WHERE feature_type IN ({placeholders}) \
             AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?"
        );
        // ⚠ `AssertSqlSafe`: audited — the interpolations are a table name and
        // its geometry columns from the match above and a run of `?`
        // placeholders whose length is `want.len()`. Every value is bound.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for b in &want {
            q = q.bind(*b);
        }
        let cap = CANDIDATE_LIMIT * want.len() as i64;
        let label = match geo {
            Geo::Lines => "lineTile",
            Geo::Points => "pointTile",
        };
        let rows = self
            .block(label, q.bind(&poly).bind(cap).fetch_all(&self.pool))
            .with_context(|| format!("reading {table} tiles"))?;
        Self::check_limit_at(rows.len(), table, &want.join(","), cap)?;
        for r in rows {
            let bucket: String = r
                .try_get("feature_type")
                .with_context(|| format!("{table}.feature_type"))?;
            if !want.contains(&bucket.as_str()) {
                bail!(
                    "{table} returned feature_type {bucket:?}, which was not among the buckets asked for"
                );
            }
            let key = (
                r.try_get::<String, _>("osm_type")
                    .with_context(|| format!("{table}.osm_type"))?,
                r.try_get::<i64, _>("osm_id")
                    .with_context(|| format!("{table}.osm_id"))?,
            );
            let held = self.tiles.rows.entry((geo, bucket.clone())).or_default();
            if !held.contains_key(&key) {
                let cached = match geo {
                    Geo::Lines => {
                        let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
                        // ⚠ `parse_linestring_wkt` swaps to `(lat, lon)`: WKT writes
                        // `lon lat`, and Lean's `lineDistDeg` reads the first as the
                        // latitude — the other order gives plausible wrong distances.
                        let pts = parse_linestring_wkt(&wkt);
                        // A way with one vertex is not a line — same guard as before.
                        if pts.len() < 2 {
                            continue;
                        }
                        let mbr = pts.iter().fold(
                            [
                                f64::INFINITY,
                                f64::NEG_INFINITY,
                                f64::INFINITY,
                                f64::NEG_INFINITY,
                            ],
                            |m, (la, lo)| {
                                [m[0].min(*la), m[1].max(*la), m[2].min(*lo), m[3].max(*lo)]
                            },
                        );
                        CachedRow {
                            mbr,
                            osm_id: key.1,
                            subtype: subtype_of(&r, table)?,
                            name: name_of(&r, table)?,
                            tags: tags_of(&r)?,
                            geom: CachedGeom::Line(pts),
                        }
                    }
                    Geo::Points => {
                        let plat: f64 = r.try_get("lat").context("osm_points ST_Y")?;
                        let plon: f64 = r.try_get("lon").context("osm_points ST_X")?;
                        CachedRow {
                            mbr: [plat, plat, plon, plon],
                            osm_id: key.1,
                            subtype: subtype_of(&r, table)?,
                            name: name_of(&r, table)?,
                            tags: tags_of(&r)?,
                            geom: CachedGeom::Point(plat, plon),
                        }
                    }
                };
                held.insert(key.clone(), cached);
            }
            // Filed under each missing tile of its bucket it meets: a tile marked
            // read below then holds every row of the bucket that meets it.
            let Some(mbr) = held.get(&key).map(|c| c.mbr) else {
                continue;
            };
            for (b, ti, tj) in &missing {
                if *b != bucket {
                    continue;
                }
                let (ts, tw) = (*ti as f64 * TILE_DEG, *tj as f64 * TILE_DEG);
                if boxes_meet(&mbr, &[ts, ts + TILE_DEG, tw, tw + TILE_DEG]) {
                    self.tiles
                        .by_tile
                        .entry((geo, bucket.clone(), *ti, *tj))
                        .or_default()
                        .push(key.clone());
                }
            }
        }
        for (b, ti, tj) in missing {
            self.tiles.fetched.insert((geo, b, ti, tj));
        }
        Ok(())
    }

    /// The cached features of `bucket` whose box meets `bx`, in key order.
    fn tile_answer(&self, geo: Geo, bucket: &str, bx: &[f64; 4]) -> Vec<Value> {
        let mut keys: BTreeSet<&(String, i64)> = BTreeSet::new();
        for ti in tile_of(bx[0])..=tile_of(bx[1]) {
            for tj in tile_of(bx[2])..=tile_of(bx[3]) {
                if let Some(ks) = self.tiles.by_tile.get(&(geo, bucket.to_string(), ti, tj)) {
                    keys.extend(ks.iter());
                }
            }
        }
        let Some(held) = self.tiles.rows.get(&(geo, bucket.to_string())) else {
            return Vec::new();
        };
        keys.into_iter()
            .filter_map(|k| held.get(k))
            .filter(|c| boxes_meet(&c.mbr, bx))
            .map(CachedRow::row)
            .collect()
    }

    /// The pre-filter box, as `[min_lat, max_lat, min_lon, max_lon]`.
    ///
    /// Half-width `radiusM / min(METERS_PER_DEG_LAT, metersPerDegLon(lat))` in
    /// BOTH axes — the TypeScript's own. See the module note for why this
    /// contains Lean's scoring window; `tests/suite/mirror_source.rs` checks that claim
    /// against the corpus by comparing answers rather than trusting it.
    ///
    /// Public because that test needs the predicate the SQL applies, and a test
    /// that reimplements the box from the same paragraph would agree with a
    /// wrong box.
    pub fn candidate_box(lat: f64, lon: f64, radius_m: f64) -> [f64; 4] {
        const METERS_PER_DEG_LAT: f64 = 111_000.0;
        let m_per_deg_lon = METERS_PER_DEG_LAT * lat.to_radians().cos();
        let d = SUPERSET_MARGIN * radius_m / METERS_PER_DEG_LAT.min(m_per_deg_lon);
        [lat - d, lat + d, lon - d, lon + d]
    }

    /// `mbrBoxWkt` — [`candidate_box`](Self::candidate_box) as a closed ring.
    ///
    /// ⚠ WKT writes `lon lat`, and the stored geometry was built from
    /// `POINT(lon lat)`. Swapping the pair here produces a box in the wrong
    /// hemisphere that still parses.
    fn mbr_box_wkt(lat: f64, lon: f64, radius_m: f64) -> String {
        let [s, n, w, e] = Self::candidate_box(lat, lon, radius_m);
        format!("POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))")
    }

    /// Run one query against the pool, blocking on the captured runtime.
    ///
    /// ⚠ A FAILED QUERY IS AN ERROR, never a decline and never an empty answer.
    /// health #976 is that distinction going wrong — a database that is down
    /// producing the same answer as an area with no roads.
    fn block<T, E, F>(&self, label: &str, f: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: Into<anyhow::Error>,
    {
        // Counted here rather than at each call site: every query this source
        // makes goes through this one boundary, so the count cannot drift from
        // the queries. `label` names the statement kind for the fold's ledger
        // (`db.<label>`), so a day's SQL time can be read per query rather
        // than as one total.
        QUERIES.fetch_add(1, Ordering::Relaxed);
        let t0 = std::time::Instant::now();
        let out = self.handle.block_on(f);
        let ns = t0.elapsed().as_nanos() as u64;
        DB_NANOS.fetch_add(ns, Ordering::Relaxed);
        crate::fold::LEDGER.charge(&format!("db.{label}"), ns);
        out.map_err(Into::into)
    }

    /// The coverage boxes for one bucket, read once.
    ///
    /// ⚠ `min_lat` and friends are `DECIMAL(9,6)`, which sqlx cannot decode into
    /// `f64` without the `rust_decimal` feature this crate line deliberately does
    /// not carry. `CAST(… AS CHAR)` then `str::parse` — CHAR and not DOUBLE,
    /// because that is the path the TypeScript's driver already takes and
    /// `str::parse` is correctly rounded, where `CAST(… AS DOUBLE)` moves the
    /// rounding into MariaDB and the two arms would agree only by luck. The
    /// first Rust loader in this crate to get this wrong decoded all 117 of
    /// production's places to centroid 0.0 and still printed OK.
    fn coverage_rows(&mut self, bucket: &str) -> Result<&[CoverageRow]> {
        if !self.coverage.contains_key(bucket) {
            // ⚠ The landmark bucket's boxes are read under the CURRENT venue
            // vocabulary (`osm_mirror::venue_vocab`): a box fetched before a
            // tag joined `VENUE_TAGS` is not coverage for it. Asked of Lean
            // once per source, the same way the drain asks.
            let vocab = if bucket == crate::osm_mirror::VOCAB_BUCKET {
                Some(crate::osm_mirror::venue_vocab(&crate::lean::venue_tags()?))
            } else {
                None
            };
            let pool = self.pool.clone();
            let b = bucket.to_string();
            let out = self
                .block("coverageRows", async move {
                    crate::osm_mirror::coverage_rows(&pool, &b, vocab.as_deref()).await
                })
                .with_context(|| format!("reading osm_coverage for {bucket}"))?;
            crate::fold::LEDGER.count(&format!("boxes.{bucket}"), out.len() as u64);
            self.coverage.insert(bucket.to_string(), out);
        }
        Ok(&self.coverage[bucket])
    }

    /// The coverage rows that can decide a question at `(lat, lon)`: those
    /// whose box contains the point.
    ///
    /// ⚠ A PRE-FILTER, NOT THE RULE. `decideCoverage` says covered when some
    /// FRESH row contains the whole query box; a row that contains the query
    /// box contains its centre, so dropping rows that miss the centre drops no
    /// row the rule could accept, and the staleness test is per row. The rule
    /// stays Lean's; this only stops the host serialising three hundred boxes
    /// to ask about one point. `tests/suite/osm_coverage.rs` checks the two
    /// verdicts agree on random rows.
    pub fn boxes_around(lat: f64, lon: f64, rows: &[CoverageRow]) -> Vec<CoverageRow> {
        rows.iter()
            .filter(|c| {
                c.min_lat <= lat && lat <= c.max_lat && c.min_lon <= lon && lon <= c.max_lon
            })
            .copied()
            .collect()
    }

    /// "Do we have ANY data here for this bucket?" — `hasLocalData`, one indexed
    /// `LIMIT 1` per table, lines first so a hit short-circuits the second.
    ///
    /// It exists because a sibling bucket's fetch can have populated this
    /// bucket's rows without leaving a matching coverage row, and re-asking
    /// Overpass for an area that already has data is how the TypeScript once
    /// spent minutes per request looping on ETIMEDOUT.
    ///
    /// ⚠ WRITTEN OUT TWICE ON PURPOSE. The obvious form loops over
    /// `["osm_lines", "osm_points"]` and picks the statement inside the loop,
    /// which hands `sqlx::query` a variable — and `DL-SQLX-SCHEMA-TRUTH` refuses
    /// that, because SQL reaching the driver through a binding cannot be checked
    /// against the schema. A table name is not something to parameterise anyway.
    fn has_local_data(&self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Result<bool> {
        let poly = Self::mbr_box_wkt(lat, lon, radius_m);
        let in_lines = self
            .block(
                "probeLines",
                sqlx::query(
                    "SELECT 1 FROM osm_lines WHERE feature_type = ? \
                     AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT 1",
                )
                .bind(bucket)
                .bind(&poly)
                .fetch_optional(&self.pool),
            )
            .with_context(|| format!("probing osm_lines for {bucket}"))?;
        if in_lines.is_some() {
            return Ok(true);
        }
        let in_points = self
            .block(
                "probePoints",
                sqlx::query(
                    "SELECT 1 FROM osm_points WHERE feature_type = ? \
                     AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT 1",
                )
                .bind(bucket)
                .bind(&poly)
                .fetch_optional(&self.pool),
            )
            .with_context(|| format!("probing osm_points for {bucket}"))?;
        Ok(in_points.is_some())
    }

    /// May the mirror be read for this bucket at this point?
    ///
    /// The TypeScript's `ensureCovered` without its fetch: coverage rows, then
    /// the local-data probe only when they say no — the probe is two queries and
    /// most questions are answered by the boxes alone.
    fn covered(&mut self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Result<bool> {
        let k = (
            bucket.to_string(),
            lat.to_bits(),
            lon.to_bits(),
            radius_m.to_bits(),
        );
        if let Some(v) = self.decided.get(&k) {
            return Ok(*v);
        }
        let now = self.now_ms;
        let boxes = Self::boxes_around(lat, lon, self.coverage_rows(bucket)?);
        // ⚠ TIMED, and not under `foldLeanMs`: that timer is the scoring of
        // candidate rows. This is a second Lean round trip per (bucket, point),
        // and it was the largest unmeasured piece of an ask (#1921): shipping
        // every box the bucket had — 97 to 306 on the pod — it cost 2 ms a call,
        // 476 calls and 950 ms on the heaviest smoke day.
        let t0 = std::time::Instant::now();
        let mut covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, false)
            .with_context(|| format!("coverage gate for {bucket}"))?;
        crate::fold::LEDGER.charge("cover", t0.elapsed().as_nanos() as u64);
        // ⚠ NOT for the landmark bucket. The probe exists because a SIBLING
        // bucket's fetch can leave rows without a coverage box; nothing but the
        // landmark fetch writes landmarks, so for them it is only a bypass of
        // the box's date and vocabulary (`osm_mirror::VOCAB_BUCKET`), and a
        // vocabulary the box was not fetched under is exactly what must decline
        // (#1891, 2026-10-03: every area he had been kept its old landmark box).
        if !covered
            && bucket != crate::osm_mirror::VOCAB_BUCKET
            && self.has_local_data(bucket, lat, lon, radius_m)?
        {
            // ⚠ Asked through Lean again rather than set to `true` here.
            // `hasLocalData` short-circuits staleness as well as containment,
            // and that trade is a rule — it belongs in `decideCoverage`, not in
            // a `||` on this line.
            let t0 = std::time::Instant::now();
            covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, true)
                .with_context(|| format!("coverage gate for {bucket} with local data"))?;
            crate::fold::LEDGER.charge("cover", t0.elapsed().as_nanos() as u64);
        }
        // ⚠ **RECORDED, NOT FETCHED** — the same trade `geocode` makes below,
        // for the same reason. A decline used to leave no trace at all, so
        // unmirrored ground stayed unmirrored on every fold forever: nothing in
        // the tree wrote `osm_lines`/`osm_points`/`osm_coverage`, and the base
        // mirror was frozen at whatever the TypeScript left (#1658). Fetching
        // here would put an Overpass round trip inside a fold that already costs
        // ~27 s on a heavy day (#1071).
        //
        // ⚠ Inside the memo, so one question is recorded once per source even
        // though `nearbyWays` asks four buckets per coordinate.
        if !covered
            && crate::osm_mirror::bucket_of(&crate::osm_mirror::queue_kind(bucket)).is_some()
        {
            let pool = self.pool.clone();
            let kind = crate::osm_mirror::queue_kind(bucket);
            let key = crate::osm_mirror::queue_key(lat, lon, radius_m);
            self.block("queue", async move {
                crate::fetch_queue::record(&pool, &kind, &key).await;
                Ok::<(), anyhow::Error>(())
            })?;
        }
        self.decided.insert(k, covered);
        Ok(covered)
    }

    /// Guard the backstop. See [`CANDIDATE_LIMIT`].
    fn check_limit(n: usize, table: &str, bucket: &str) -> Result<()> {
        Self::check_limit_at(n, table, bucket, CANDIDATE_LIMIT)
    }

    /// The matcher reads' backstop: `true` means DECLINE this ask. Loud, so a
    /// day drawn on a raw chord is never a silent one. See [`CANDIDATE_LIMIT`].
    fn matcher_backstop(n: usize, table: &str, bucket: &str, radius_m: f64) -> bool {
        if (n as i64) < CANDIDATE_LIMIT {
            return false;
        }
        tracing::warn!(
            table,
            bucket,
            radius_m,
            rows = n,
            cap = CANDIDATE_LIMIT,
            "at the backstop — the ask is declined and the leg draws raw"
        );
        true
    }

    /// As [`check_limit`](Self::check_limit) with the cap stated, because the
    /// batched read shares one cap across several buckets.
    fn check_limit_at(n: usize, table: &str, bucket: &str, cap: i64) -> Result<()> {
        if n as i64 >= cap {
            bail!(
                "{table} returned {n} candidate {bucket} row(s), at the {cap} backstop \
                 — the pre-filter box is not bounding what it should, and scoring a truncated \
                 candidate list would answer with a nearest feature that is not the nearest"
            );
        }
        Ok(())
    }
}

impl MirrorSource {
    /// Ways of the given subtypes intersecting the disc plus its margin, as the
    /// fold reads them. `None` declines: the coverage gate said no, and the
    /// decline is recorded for the drain.
    fn ways(
        &mut self,
        lat: f64,
        lon: f64,
        radius_m: f64,
        subtypes: &[&str],
    ) -> Result<Option<Value>> {
        // ⚠ BEFORE THE QUERY, because the query cannot tell the two cases
        // apart: no rows over unfetched ground and no rows over empty ground are
        // the same answer. Both way readers draw from `highway`.
        if !self.covered("highway", lat, lon, radius_m)? {
            return Ok(None);
        }
        let poly = margin_box_wkt(lat, lon, radius_m, ROAD_CORRIDOR_MARGIN_M);
        let sql = format!(
            "SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt \
             FROM osm_lines \
             WHERE feature_type = 'highway' \
               AND subtype IN ({}) \
               AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
             LIMIT ?",
            placeholders(subtypes.len())
        );
        // ⚠ `AssertSqlSafe` because sqlx refuses a non-'static SQL string by
        // default — a good rule, and this is the audited exception. The only
        // runtime part of the statement is `placeholders(n)`, which emits `?`
        // and commas; every value, each subtype included, is BOUND.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for st in subtypes {
            q = q.bind(*st);
        }
        q = q.bind(&poly).bind(CANDIDATE_LIMIT);
        let rows = self
            .block("ways", q.fetch_all(&self.pool))
            .context("reading osm_lines for a matcher corridor")?;
        if Self::matcher_backstop(rows.len(), "osm_lines", "highway corridor", radius_m) {
            return Ok(None);
        }
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
            let coords: Vec<Value> = parse_linestring_wkt(&wkt)
                .into_iter()
                .map(|(la, lo)| json!([bits(la), bits(lo)]))
                .collect();
            // A way with one vertex is not a line.
            if coords.len() < 2 {
                continue;
            }
            out.push(json!({
                "osmId": r.try_get::<i64, _>("osm_id").context("osm_lines.osm_id")?,
                "name": r.try_get::<Option<String>, _>("name").context("osm_lines.name")?,
                "subtype": r.try_get::<Option<String>, _>("subtype").context("osm_lines.subtype")?,
                "coords": coords,
            }));
        }
        Ok(Some(Value::Array(out)))
    }
}

impl RowSource for MirrorSource {
    fn walkable_roads(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        self.ways(lat, lon, radius_m, WALKABLE_ROAD_SUBTYPES)
    }

    fn drivable_roads(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        self.ways(lat, lon, radius_m, DRIVABLE_ROAD_SUBTYPES)
    }

    /// Building outlines as closed rings. `None` declines, and this is the
    /// bucket the gate was missing entirely until #1667: nothing declined a
    /// building question, so no `building` box was ever queued.
    fn buildings_near(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        if !self.covered("building", lat, lon, radius_m)? {
            return Ok(None);
        }
        let poly = margin_box_wkt(lat, lon, radius_m, BUILDING_QUERY_MARGIN_M);
        let sql = format!(
            "SELECT ST_AsText(geom) AS wkt \
             FROM osm_lines \
             WHERE feature_type = 'building' \
               AND (subtype IS NULL OR subtype NOT IN ({})) \
               AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
             LIMIT ?",
            placeholders(NON_ENCLOSING_BUILDING_SUBTYPES.len())
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for st in NON_ENCLOSING_BUILDING_SUBTYPES {
            q = q.bind(*st);
        }
        q = q.bind(&poly).bind(CANDIDATE_LIMIT);
        let rows = self
            .block("buildings", q.fetch_all(&self.pool))
            .context("reading osm_lines for buildings")?;
        if Self::matcher_backstop(rows.len(), "osm_lines", "building", radius_m) {
            return Ok(None);
        }
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
            let ring: Vec<Value> = parse_linestring_wkt(&wkt)
                .into_iter()
                .map(|(la, lo)| json!([bits(la), bits(lo)]))
                .collect();
            // Fewer than three vertices is not a polygon.
            if ring.len() < 3 {
                continue;
            }
            out.push(Value::Array(ring));
        }
        Ok(Some(Value::Array(out)))
    }

    /// Line candidates, in `osmspatial`'s positional form, from the tiles
    /// ([`TileCache`]): the features whose box meets the candidate box.
    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        if !self.covered(bucket, lat, lon, radius_m)? {
            return Ok(None);
        }
        let bx = Self::candidate_box(lat, lon, radius_m);
        self.fetch_tiles(Geo::Lines, &[bucket], &bx)?;
        let out = self.tile_answer(Geo::Lines, bucket, &bx);
        Self::check_limit(out.len(), "osm_lines", bucket)?;
        Ok(Some(out))
    }

    /// Point candidates, in `osmspatial`'s positional form, from the tiles.
    ///
    /// ⚠ The tiles read `ST_X` as LONGITUDE and `ST_Y` as latitude: the geometry
    /// was built from `POINT(lon lat)` WKT. A coordinate read in the binary
    /// protocol against the fixtures' text rendering was measured not to move
    /// any distance (`backend mirror-check`).
    fn point_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        if !self.covered(bucket, lat, lon, radius_m)? {
            return Ok(None);
        }
        let bx = Self::candidate_box(lat, lon, radius_m);
        self.fetch_tiles(Geo::Points, &[bucket], &bx)?;
        let out = self.tile_answer(Geo::Points, bucket, &bx);
        Self::check_limit(out.len(), "osm_points", bucket)?;
        Ok(Some(out))
    }

    /// The four line buckets `nearbyWays` needs, read together.
    ///
    /// ⚠ Coverage is checked PER BUCKET: a coordinate the mirror cannot vouch
    /// for in one bucket declines the whole answer, and reading the buckets
    /// together must not quietly answer for an area that was never fetched.
    ///
    /// ⚠ Every requested bucket gets an entry even when it matched no rows. An
    /// absent key and an empty one mean different things here — "no ways of this
    /// kind nearby" is an answer, and the caller must not read it as a decline.
    fn line_rows_multi(
        &mut self,
        buckets: &[&str],
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<crate::rowset_answerer::LinesByBucket>> {
        // ⚠ EVERY BUCKET IS ASKED even once one has already declined. The
        // answer is the same — one bucket the mirror cannot vouch for declines
        // the whole thing — but `covered` is where a decline is RECORDED for
        // the fetch queue (#1658), and an early return records only the first
        // uncovered bucket of four.
        let mut all_covered = true;
        for b in buckets {
            if !self.covered(b, lat, lon, radius_m)? {
                all_covered = false;
            }
        }
        if !all_covered {
            return Ok(None);
        }
        let bx = Self::candidate_box(lat, lon, radius_m);
        self.fetch_tiles(Geo::Lines, buckets, &bx)?;
        let out: crate::rowset_answerer::LinesByBucket = buckets
            .iter()
            .map(|b| ((*b).to_string(), self.tile_answer(Geo::Lines, b, &bx)))
            .collect();
        let n: usize = out.iter().map(|(_, v)| v.len()).sum();
        Self::check_limit_at(
            n,
            "osm_lines",
            "nearbyWays buckets",
            CANDIDATE_LIMIT * buckets.len() as i64,
        )?;
        Ok(Some(out))
    }

    /// ⚠ NOT gated on coverage, and that is the difference between this and
    /// every other read here. Coverage boxes are spatial and this question has
    /// no coordinate — a line is a name. The mirror either holds railway ways
    /// or it does not, and `rail_ways_named` returning nothing is what says so.
    fn rail_line_names(&mut self) -> Result<Option<Vec<String>>> {
        if self.rail_names.is_none() {
            let rows = self
                .block(
                    "railNames",
                    sqlx::query(
                        "SELECT DISTINCT name FROM osm_lines \
                         WHERE feature_type = 'railway' AND name IS NOT NULL",
                    )
                    .fetch_all(&self.pool),
                )
                .context("reading distinct railway line names")?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                if let Some(n) = r
                    .try_get::<Option<String>, _>("name")
                    .context("osm_lines.name")?
                {
                    out.push(n);
                }
            }
            self.rail_names = Some(out);
        }
        Ok(self.rail_names.clone())
    }

    fn rail_ways_named(&mut self, names: &[String]) -> Result<Option<Vec<Value>>> {
        if names.is_empty() {
            return Ok(Some(vec![]));
        }
        // ⚠ An exact `name IN (…)` so the index serves it. The substring match
        // already happened in Lean against the cached name list — doing it here
        // as a leading-wildcard LIKE is the ~28 s scan this design avoids.
        let placeholders = std::iter::repeat_n("?", names.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT ST_AsText(geom) AS wkt FROM osm_lines              WHERE feature_type = 'railway' AND name IN ({placeholders})"
        );
        // ⚠ `AssertSqlSafe` because sqlx 0.9 refuses a non-'static SQL string.
        // Audited: the only interpolation is the `?` placeholder run, whose
        // length comes from `names.len()`. Every NAME is bound, never inlined.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for n in names {
            q = q.bind(n);
        }
        let rows = self
            .block("railWays", q.fetch_all(&self.pool))
            .context("reading railway way geometry")?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
            out.push(Value::Array(
                parse_linestring_wkt(&wkt)
                    .into_iter()
                    .map(|(la, lo)| json!([bits(la), bits(lo)]))
                    .collect(),
            ));
        }
        Ok(Some(out))
    }

    fn rail_stations(&mut self) -> Result<Option<Vec<Value>>> {
        if self.rail_stations.is_none() {
            // ⚠ NO ORDER BY, matching the TypeScript. Order is part of the
            // answer, so it must be the same order — and the TypeScript takes
            // whatever the server returns for this unordered read. Adding a sort
            // here would be a defensible choice that produces a DIFFERENT
            // answer, which is the one thing a port must not do.
            let rows = self
                .block(
                    "railStations",
                    sqlx::query(
                        "SELECT name, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM osm_points \
                         WHERE feature_type = 'railway' AND subtype = 'station'",
                    )
                    .fetch_all(&self.pool),
                )
                .context("reading railway stations")?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                let Some(name) = r
                    .try_get::<Option<String>, _>("name")
                    .context("osm_points.name")?
                else {
                    continue;
                };
                let lat: f64 = r.try_get("lat").context("osm_points ST_Y")?;
                let lon: f64 = r.try_get("lon").context("osm_points ST_X")?;
                out.push(json!({
                    "name": name,
                    "latBits": bits(lat),
                    "lonBits": bits(lon),
                }));
            }
            self.rail_stations = Some(out);
        }
        Ok(self.rail_stations.clone())
    }

    /// One reverse geocode, from the cache the TypeScript filled (#1076).
    ///
    /// ⚠ **READ-ONLY, AND NO NETWORK.** `osm_cache` stopped growing when the
    /// TypeScript was deleted (#975), so this answers habitual ground and
    /// declines on new ground — measured at 13 of 15 keys on an ordinary day and
    /// 6 of 32 on the first day somewhere new. Putting the FETCH here would put
    /// a Nominatim round trip on the serving path, which is where the fold's
    /// latency already hurts (#1071); the fetch belongs in a deferred job, which
    /// is the same shape #1658 needs for Overpass.
    ///
    /// ⚠ **A NEGATIVE SENTINEL DECLINES, WHATEVER ITS AGE.** `withCache` wrote a
    /// failed fetch as `{_err, _at}` under a five-minute TTL, and 331 of those
    /// are now permanent because the fetcher that would have overwritten them is
    /// gone. But the TTL only ever governed whether to RE-FETCH, and this reader
    /// does not fetch — so a sentinel is simply an absent answer. Returning
    /// `null` for a fresh one would tell the fold "nothing is named here", which
    /// is a claim about the world made out of a network error (#976).
    fn geocode(&mut self, lat: f64, lon: f64, zoom: i64) -> Result<Option<Value>> {
        let pool = self.pool.clone();
        let found = self.block("geocode", async move {
            crate::nominatim::cache_get(&pool, zoom, lat, lon).await
        })?;
        Ok(match found {
            Some(crate::nominatim::Cached::Answer(Some(g))) => Some(serde_json::to_value(g)?),
            // ⚠ Nominatim answering "nothing is here" IS an answer, and the fold
            // reads a null entry as a RESOLVED lookup with no name — which is a
            // different state from an unanswered key, and the reason this arm
            // exists separately from the two below.
            Some(crate::nominatim::Cached::Answer(None)) => Some(Value::Null),
            // ⚠ **RECORDED, NOT FETCHED.** A decline used to leave no trace, so
            // the same coordinate went unanswered on every fold forever. The
            // queue is what lets the drain fill it within seconds; fetching here
            // would put a Nominatim round trip on the serving path (#1071, #1076).
            Some(crate::nominatim::Cached::Failed { .. }) | None => {
                let pool = self.pool.clone();
                let kind = crate::nominatim::query_type(zoom);
                let key = crate::nominatim::queue_key(lat, lon);
                self.block("geocodeRecord", async move {
                    crate::fetch_queue::record(&pool, &kind, &key).await;
                    Ok::<(), anyhow::Error>(())
                })?;
                None
            }
        })
    }
}

/// ⚠ A NULL subtype becomes `""`, not `null`. Lean's row parser reads this
/// position with `getStr?` and a `null` fails the whole request; `""` is also
/// what the TypeScript writes (`f.subtype ?? ""`), and it is in no subtype
/// filter, so a row without one is excluded exactly as `subtype IN (…)`
/// excluded it.
fn subtype_of(r: &sqlx::mysql::MySqlRow, table: &str) -> Result<Value> {
    Ok(Value::String(
        r.try_get::<Option<String>, _>("subtype")
            .with_context(|| format!("{table}.subtype"))?
            .unwrap_or_default(),
    ))
}

/// ⚠ A NULL name stays `null`. Lean reads this position as an `Option` and an
/// unnamed way contributes nothing to `linesAtPoint`; `""` would be a name.
fn name_of(r: &sqlx::mysql::MySqlRow, table: &str) -> Result<Value> {
    Ok(
        match r
            .try_get::<Option<String>, _>("name")
            .with_context(|| format!("{table}.name"))?
        {
            Some(n) => Value::String(n),
            None => Value::Null,
        },
    )
}

/// `tags_json` as the `[[key, value], …]` pairs Lean reads.
///
/// ⚠ NON-STRING VALUES ARE DROPPED rather than stringified. Lean's parser takes
/// both halves with `getStr?`, so a numeric tag would fail the request; OSM tag
/// values are strings, and one that is not is a row this port should not be
/// silently reshaping.
fn tags_of(r: &sqlx::mysql::MySqlRow) -> Result<Value> {
    // ⚠ Serves BOTH tables now. A venue is a point POI or a building outline,
    // and `nearbyLandmarks` needs both sides.
    let raw: Option<String> = r
        .try_get("tags_json")
        .context("tags_json does not decode as text")?;
    tags_pairs(raw.as_deref())
}

/// The pure half of [`tags_of`], so the null and non-string cases have a test.
pub fn tags_pairs(raw: Option<&str>) -> Result<Value> {
    let Some(raw) = raw else {
        return Ok(json!([]));
    };
    let v: Value = serde_json::from_str(raw).context("osm_points.tags_json is not JSON")?;
    let Some(o) = v.as_object() else {
        return Ok(json!([]));
    };
    Ok(Value::Array(
        o.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| json!([k, s])))
            .collect(),
    ))
}

/// `parseLineStringWkt` — WKT writes `lon lat`; the pair comes back `(lat, lon)`.
/// A coordinate that does not parse is DROPPED, as the TypeScript's
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

/// Run something with a mirror-backed answerer, on a blocking thread.
///
/// # ⚠ Why this exists rather than a `MirrorSource` the caller drives
///
/// The fold answers its asks SYNCHRONOUSLY — the worker is blocked on the pipe
/// until the row comes back — while `sqlx` is async. So the fold has to run on
/// a blocking thread with a runtime handle to block on, and `Handle::block_on`
/// from a runtime WORKER aborts the process instead of returning an error.
///
/// That hazard cannot be detected from inside [`MirrorSource`]: tokio sets the
/// runtime context on blocking-pool threads too, so `Handle::try_current()`
/// says the same thing in the safe case and the fatal one. What replaces the
/// check is that the blocking hop lives HERE, with the only public constructor
/// that pairs a pool with a handle — a caller that folds from a handler has to
/// have gone around this function to do it.
pub async fn with_mirror_answerer<F, T>(pool: MySqlPool, now_ms: i64, f: F) -> Result<T>
where
    F: FnOnce(&mut crate::rowset_answerer::OsmAnswerer<MirrorSource>) -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let source = MirrorSource::new(pool, handle, now_ms);
        f(&mut crate::rowset_answerer::OsmAnswerer::with_source(
            source,
        ))
    })
    .await
    .context("the mirror thread panicked")?
}

/// [`fold_from_mirror`], RECORDING every row the answerer was served, as the
/// `osmRowSet` a golden fixture carries, and the three matcher reads' answers
/// as its `osmTrace` sections (#1660).
///
/// ⚠ The recorder wraps the source rather than re-running the queries, so what
/// is captured is exactly what production asked and got — including the
/// DECLINES, without which a replay answers where the mirror could not and the
/// day comes out better in the fixture than it does in production.
///
/// Returns `(folded, row_set, matcher_trace, geocode_section)`; the geocode
/// section is `None` when the source answered no geocode at all (#1076).
pub async fn fold_from_mirror_recording(
    pool: MySqlPool,
    cap: Value,
    inputs: Value,
    now_ms: i64,
) -> Result<(crate::fold::Folded, Value, Value, Option<Value>)> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let source = MirrorSource::new(pool, handle, now_ms);
        let (recording, rec) = crate::rowset_capture::RecordingSource::new(source);
        let mut answerer = crate::osm_trace::RecordingAnswerer::new(
            crate::rowset_answerer::OsmAnswerer::with_source(recording),
        );
        let folded = crate::fold::run_day(&cap, &inputs, &mut answerer)?;
        let trace = answerer.take();
        let recorded = rec
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let row_set = recorded.row_set();
        let geocodes = recorded.geocode_section();
        drop(recorded);
        Ok((folded, row_set, trace, geocodes))
    })
    .await
    .context("the mirror thread panicked")?
}

/// Answers `walkableRoads` from `inner` and declines everything else.
struct WalkableOnly<A>(A);

impl<A: crate::lean::Answerer> crate::lean::Answerer for WalkableOnly<A> {
    fn answer(&mut self, ask: &crate::lean::Ask) -> Result<Option<Value>> {
        if ask.what == crate::osm_trace::MatcherRead::Walkable.name() {
            self.0.answer(ask)
        } else {
            Ok(None)
        }
    }
}

/// Re-record ONLY a golden fixture's `walkableRoads` from the live mirror.
///
/// The day is replayed exactly as the corpus gate replays it — its own trace,
/// then its own row set — except that the walkable section is withheld and
/// answered by the mirror instead. So the walk legs, and therefore the walkable
/// questions, are the ones the gate will ask; and every OTHER table keeps the
/// answers the day was blessed on. A decline the gate would see stays a decline
/// here: the mirror answers nothing but `walkableRoads`.
///
/// Returns the fold and the new `walkableRoads` section, in the fixture's shape.
pub async fn rerecord_walkable(
    pool: MySqlPool,
    fixture: Value,
    user: String,
    date: String,
    now_ms: i64,
) -> Result<(crate::fold::Folded, Value)> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let inputs = fixture.get("inputs").context("the fixture has no inputs")?;
        let row_set = inputs
            .get("osmRowSet")
            .context("the fixture has no osmRowSet")?;
        let trace = crate::osm_trace::TraceAnswerer::from_fixture(
            &fixture,
            &date,
            crate::osm_trace::Sections {
                walkable: false,
                buildings: true,
                drivable: true,
            },
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        let rows = crate::rowset_answerer::RowSetAnswerer::new(row_set)?;
        let live = crate::osm_trace::RecordingAnswerer::new(WalkableOnly(
            crate::rowset_answerer::OsmAnswerer::with_source(MirrorSource::new(
                pool, handle, now_ms,
            )),
        ));
        let cap = crate::head::capture(inputs, &date, &user)?;
        let mut answerer = crate::lean::Chain(trace, crate::lean::Chain(rows, live));
        let folded = crate::fold::run_day(&cap, inputs, &mut answerer)?;
        let section = answerer
            .1
            .1
            .take()
            .get(crate::osm_trace::MatcherRead::Walkable.name())
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        Ok((folded, section))
    })
    .await
    .context("the mirror thread panicked")?
}

/// Answer, from the live mirror, ONLY the lookups a golden fixture's own record
/// cannot.
///
/// The day is replayed as the corpus gate replays it — its trace, then its row
/// set — with the mirror last in the chain, so the mirror is asked exactly what
/// the fixture declines: the new questions a code change asks (a stay named at
/// a point the capturing build never asked about). Every answer the day was
/// blessed on stays; nothing else of the day is re-read from production, so the
/// replay measures the change and not the data's drift since capture.
///
/// Returns the fold, the new matcher-read and geocode answers as `osmTrace`
/// sections, and how many map ROWS the mirror had to serve — which a caller
/// must refuse, since rows belong in `osmRowSet` and are not merged here.
pub async fn rerecord_unanswered(
    pool: MySqlPool,
    fixture: Value,
    user: String,
    date: String,
    now_ms: i64,
) -> Result<(crate::fold::Folded, Value, Option<Value>, usize)> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let inputs = fixture.get("inputs").context("the fixture has no inputs")?;
        let row_set = inputs
            .get("osmRowSet")
            .context("the fixture has no osmRowSet")?;
        let trace = crate::osm_trace::TraceAnswerer::from_fixture(
            &fixture,
            &date,
            crate::osm_trace::Sections {
                walkable: true,
                buildings: true,
                drivable: true,
            },
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        let rows = crate::rowset_answerer::RowSetAnswerer::new(row_set)?;
        let (recording, rec) =
            crate::rowset_capture::RecordingSource::new(MirrorSource::new(pool, handle, now_ms));
        let live = crate::osm_trace::RecordingAnswerer::new(
            crate::rowset_answerer::OsmAnswerer::with_source(recording),
        );
        let cap = crate::head::capture(inputs, &date, &user)?;
        let mut answerer = crate::lean::Chain(trace, crate::lean::Chain(rows, live));
        let folded = crate::fold::run_day(&cap, inputs, &mut answerer)?;
        let matcher = answerer.1.1.take();
        let recorded = rec
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok((
            folded,
            matcher,
            recorded.geocode_section(),
            recorded.served_rows(),
        ))
    })
    .await
    .context("the mirror thread panicked")?
}

/// Fold a day against the live mirror. See [`with_mirror_answerer`] for why
/// this hop exists.
pub async fn fold_from_mirror(
    pool: MySqlPool,
    cap: Value,
    inputs: Value,
    now_ms: i64,
) -> Result<crate::fold::Folded> {
    with_mirror_answerer(pool, now_ms, move |answerer| {
        crate::fold::run_day(&cap, &inputs, answerer)
    })
    .await
}
