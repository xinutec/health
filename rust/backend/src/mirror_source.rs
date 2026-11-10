//! Candidate OSM rows from the live mirror, for the fold's asks: the
//! production implementation of the row-source trait (the golden fixtures'
//! [`RowSetSource`](crate::rowset_answerer::RowSetSource) is the other).
//!
//! # The SQL is a pre-filter; Lean scores
//!
//! The SQL selects candidates inside a bounding box and hands every one to Lean
//! (`Verified.Geo.OsmSpatial`), which owns the distance, the order and the cap.
//! `ST_Distance` on a LINESTRING measures to the nearest vertex, not the way, so
//! scoring in MariaDB would be wrong.
//!
//! # The box must contain Lean's scoring window
//!
//! A row the SQL drops is a row Lean never sees, so the box may only
//! over-include. Its half-width is `radiusM / min(111000, 111000·cos lat)` in
//! both axes, which contains `queryLines`' degree-space window
//! (`radiusM / (111320·cos lat)`) and `queryPoints`' metre window
//! (`haversineAt`), widened by [`SUPERSET_MARGIN`].
//!
//! # Coverage
//!
//! Before any read, [`lean::osm_covered`](crate::lean::osm_covered) decides
//! whether the mirror holds this area for this bucket. If not, the source
//! declines (an empty list would claim there are no roads) and records the
//! decline for [`crate::fetch_drain`] to fetch, off the serving path. The three
//! matcher reads (`walkableRoads`, `buildingsNear`, `drivableRoads`) go through
//! the same gate.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

use crate::fold_payload::bits;
use crate::lean::{self, CoverageRow};
use crate::rowset_answerer::RowSource;

/// How far beyond the asked disc a road corridor read reaches, so a way that
/// starts just outside one sample's disc is still found. Applied after the ask
/// key is formed, so it is stamped into a capture's `meta`.
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

/// How much the candidate box is widened beyond `radiusM`.
///
/// The unwidened box clears Lean's window only by the ratio of constants in
/// different files: 111195/111000 = 1.0018 for points (`haversineAt` on
/// `LEAN_EARTH_R`), 111320/111000 = 1.0029 for lines. Shrinking it by 1% loses
/// rows on the corpus (`tests/suite/mirror_source.rs`). Widening is the safe
/// direction: an extra row costs one comparison, a missing row changes the
/// answer.
const SUPERSET_MARGIN: f64 = 1.05;

/// A backstop, not a cap the queries may spend.
///
/// The point buckets ask 50–200 m radii, so reaching this means the box is
/// wrong: the run errors rather than scoring a truncated list ("nearest way 40 m
/// away" would be indistinguishable from the truth).
///
/// The matcher reads are larger (a walk's extent plus a 400 m corridor, often
/// 10 000–20 000 highway rows in central London) and decline here instead: a
/// declined leg draws as a chord and the day says so (`declined_by_table`).
pub const CANDIDATE_LIMIT: i64 = 20_000;

/// SQL statements this source has issued, process-wide: the denominator for any
/// timing, since a round trip through the tunnel costs far more than in the
/// cluster. [`take_db_nanos`] measures the time itself.
static QUERIES: AtomicU64 = AtomicU64::new(0);

/// Nanoseconds spent INSIDE [`MirrorSource::block`] — the database, and nothing
/// else. Paired with [`QUERIES`] so a per-query cost can be stated rather than
/// derived from the fold's total.
static DB_NANOS: AtomicU64 = AtomicU64::new(0);

/// Read the query count and reset it, so a count belongs to one request.
pub fn take_queries() -> u64 {
    QUERIES.swap(0, Ordering::Relaxed)
}

/// Read the accumulated database time and reset it. Wall clock inside
/// `block_on`, so pool waits count: they are a cost of issuing queries too.
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

/// A tile of one bucket of one table: `(table, bucket, lat index, lon index)`.
type TileKey = (Geo, String, i64, i64);
/// A feature's key in its table: `(osm_type, osm_id)`.
type FeatureKey = (String, i64);
/// The mirror's lines and points, read by tile and kept for the fold. An ask's
/// candidates are the cached features whose box meets its candidate box (the
/// SQL's `MBRIntersects`), in feature-key order `(osm_type, osm_id)`.
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
    /// The runtime this blocks on, captured by the caller (see
    /// [`with_mirror_answerer`]).
    handle: tokio::runtime::Handle,
    /// The clock, owned by the host. Lean's staleness rule takes it as an
    /// argument so that the decision does not depend on when it was asked.
    now_ms: i64,
    /// Coverage boxes per feature bucket, read once each: a day asks each bucket
    /// dozens of times.
    coverage: HashMap<String, Vec<CoverageRow>>,
    /// Coverage VERDICTS, keyed by the question rather than the bucket: the
    /// local-data probe is two indexed queries and the same coordinate is asked
    /// for several tables.
    decided: HashMap<(String, u64, u64, u64), bool>,
    /// Every distinct railway line name, read once (~1k strings): each
    /// `stationsOnLine` would otherwise scan for them.
    rail_names: Option<Vec<String>>,
    /// Every railway station point, read once (~1.2k rows). Whole, not per line:
    /// a London-wide MBR query against `osm_points` takes ~30 s, where one small
    /// indexed read plus an in-memory filter is cheap.
    rail_stations: Option<Vec<Value>>,
    /// The line and point reads, by tile ([`TileCache`]).
    tiles: TileCache,
}

impl MirrorSource {
    /// ⚠ Call from a blocking thread only ([`with_mirror_answerer`]): a query
    /// reached from a runtime worker aborts the process.
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
        // `AssertSqlSafe`: the interpolations are a table name and geometry
        // columns from the match above and a `?` run; every value is bound.
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
                        // `parse_linestring_wkt` swaps WKT's `lon lat` to `(lat,
                        // lon)`, the order Lean's `lineDistDeg` reads.
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

    /// The pre-filter box, `[min_lat, max_lat, min_lon, max_lon]`: half-width
    /// `radiusM / min(METERS_PER_DEG_LAT, metersPerDegLon(lat))` in both axes
    /// (see the module note). Public so `tests/suite/mirror_source.rs` can test
    /// the predicate the SQL applies, not a reimplementation of it.
    pub fn candidate_box(lat: f64, lon: f64, radius_m: f64) -> [f64; 4] {
        const METERS_PER_DEG_LAT: f64 = 111_000.0;
        let m_per_deg_lon = METERS_PER_DEG_LAT * lat.to_radians().cos();
        let d = SUPERSET_MARGIN * radius_m / METERS_PER_DEG_LAT.min(m_per_deg_lon);
        [lat - d, lat + d, lon - d, lon + d]
    }

    /// [`candidate_box`](Self::candidate_box) as a closed WKT ring. ⚠ WKT writes
    /// `lon lat`; the other order is a box in the wrong hemisphere that still
    /// parses.
    fn mbr_box_wkt(lat: f64, lon: f64, radius_m: f64) -> String {
        let [s, n, w, e] = Self::candidate_box(lat, lon, radius_m);
        format!("POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))")
    }

    /// Run one query against the pool, blocking on the captured runtime. A
    /// failed query is an error, never a decline or an empty answer: a database
    /// that is down must not look like an area with no roads.
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

    /// The coverage boxes for one bucket, read once. The `DECIMAL(9,6)` bounds
    /// are cast to CHAR and parsed (sqlx cannot decode DECIMAL without
    /// `rust_decimal`).
    fn coverage_rows(&mut self, bucket: &str) -> Result<&[CoverageRow]> {
        if !self.coverage.contains_key(bucket) {
            // The landmark bucket's boxes are read under the current venue
            // vocabulary (`osm_mirror::venue_vocab`): a box fetched before a tag
            // joined `VENUE_TAGS` is not coverage for it.
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

    /// The coverage rows whose box contains `(lat, lon)`. A pre-filter, not the
    /// rule: `decideCoverage` needs a fresh row containing the whole query box,
    /// which contains the centre, so nothing it could accept is dropped.
    /// `tests/suite/osm_coverage.rs` checks the verdicts agree.
    pub fn boxes_around(lat: f64, lon: f64, rows: &[CoverageRow]) -> Vec<CoverageRow> {
        rows.iter()
            .filter(|c| {
                c.min_lat <= lat && lat <= c.max_lat && c.min_lon <= lon && lon <= c.max_lon
            })
            .copied()
            .collect()
    }

    /// Whether the mirror has any row of this bucket here (`hasLocalData`): one
    /// indexed `LIMIT 1` per table, lines first. A sibling bucket's fetch can
    /// leave rows without a matching coverage box.
    ///
    /// Written out twice, not looped over table names: a statement chosen in a
    /// loop reaches `sqlx::query` through a variable, which the schema lint
    /// cannot check.
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

    /// May the mirror be read for this bucket at this point? Coverage rows first;
    /// the local-data probe (two queries) only when they say no.
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
        // Timed apart from `foldLeanMs` (which is candidate scoring): a second
        // Lean round trip per (bucket, point).
        let t0 = std::time::Instant::now();
        let mut covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, false)
            .with_context(|| format!("coverage gate for {bucket}"))?;
        crate::fold::LEDGER.charge("cover", t0.elapsed().as_nanos() as u64);
        // Not for the landmark bucket: only the landmark fetch writes landmarks,
        // so the probe would only bypass the box's date and vocabulary, which
        // must decline.
        if !covered
            && bucket != crate::osm_mirror::VOCAB_BUCKET
            && self.has_local_data(bucket, lat, lon, radius_m)?
        {
            // Through Lean again, not set here: `hasLocalData` overriding
            // staleness is a rule, and rules live in `decideCoverage`.
            let t0 = std::time::Instant::now();
            covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, true)
                .with_context(|| format!("coverage gate for {bucket} with local data"))?;
            crate::fold::LEDGER.charge("cover", t0.elapsed().as_nanos() as u64);
        }
        // Recorded for the drain, not fetched here: an Overpass round trip has
        // no place inside a fold. Inside the memo, so one question is recorded
        // once even though `nearbyWays` asks four buckets per coordinate.
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
        // Before the query: no rows over unfetched ground and no rows over empty
        // ground look the same. Both way readers draw from `highway`.
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
        // `AssertSqlSafe`: the only runtime part is `placeholders(n)`; every
        // value, each subtype included, is bound.
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

    /// Building outlines as closed rings. `None` declines, which also queues the
    /// `building` box for fetching.
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

    /// Point candidates, in `osmspatial`'s positional form, from the tiles. The
    /// tiles read `ST_X` as longitude and `ST_Y` as latitude (the geometry is
    /// `POINT(lon lat)`).
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

    /// The four line buckets `nearbyWays` needs, read together. Coverage is
    /// checked per bucket: one the mirror cannot vouch for declines the whole
    /// answer. Every bucket gets an entry, empty ones included: "no ways of this
    /// kind nearby" is an answer, not a decline.
    fn line_rows_multi(
        &mut self,
        buckets: &[&str],
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<crate::rowset_answerer::LinesByBucket>> {
        // Every bucket is asked even after one declined: `covered` records each
        // decline for the fetch queue, and an early return would record only the
        // first.
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

    /// Not gated on coverage: this question has no coordinate. The mirror holds
    /// railway ways or not, and `rail_ways_named` returning nothing says so.
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
        // An exact `name IN (…)` so the index serves it; the substring match
        // already ran in Lean over the cached names (a leading-wildcard LIKE
        // would scan ~28 s).
        let placeholders = std::iter::repeat_n("?", names.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT ST_AsText(geom) AS wkt FROM osm_lines              WHERE feature_type = 'railway' AND name IN ({placeholders})"
        );
        // `AssertSqlSafe`: the only interpolation is the `?` run, sized by
        // `names.len()`; every name is bound.
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
            // No ORDER BY: the order is the server's, and part of the answer.
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

    /// One reverse geocode, from `osm_cache`. Read-only: a miss is recorded for
    /// the drain to fetch, so no Nominatim round trip sits on the serving path.
    ///
    /// A stored failure (`{_err, _at}`) declines whatever its age: returning
    /// `null` would claim "nothing is named here" out of a network error.
    fn geocode(&mut self, lat: f64, lon: f64, zoom: i64) -> Result<Option<Value>> {
        let pool = self.pool.clone();
        let found = self.block("geocode", async move {
            crate::nominatim::cache_get(&pool, zoom, lat, lon).await
        })?;
        Ok(match found {
            Some(crate::nominatim::Cached::Answer(Some(g))) => Some(serde_json::to_value(g)?),
            // Nominatim's "nothing is here" is an answer: a resolved lookup with
            // no name, unlike an unanswered key.
            Some(crate::nominatim::Cached::Answer(None)) => Some(Value::Null),
            // Recorded for the drain, which fills it within seconds.
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

/// A NULL subtype becomes `""`: Lean reads the position with `getStr?`, and
/// `""` matches no subtype filter, as `subtype IN (…)` excluded it.
fn subtype_of(r: &sqlx::mysql::MySqlRow, table: &str) -> Result<Value> {
    Ok(Value::String(
        r.try_get::<Option<String>, _>("subtype")
            .with_context(|| format!("{table}.subtype"))?
            .unwrap_or_default(),
    ))
}

/// A NULL name stays `null`: Lean reads an `Option`, and `""` would be a name.
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

/// `tags_json` as the `[[key, value], …]` pairs Lean reads. Non-string values
/// are dropped, not stringified: OSM tag values are strings.
fn tags_of(r: &sqlx::mysql::MySqlRow) -> Result<Value> {
    // Both tables: a venue is a point POI or a building outline.
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

/// WKT `LINESTRING(lon lat, …)` as `(lat, lon)` pairs; a coordinate that does
/// not parse is dropped.
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
/// The fold answers its asks synchronously while `sqlx` is async, so it must run
/// on a blocking thread with a runtime handle, and `Handle::block_on` from a
/// runtime worker aborts the process. That cannot be detected inside
/// [`MirrorSource`] (tokio sets the context on blocking threads too), so the hop
/// lives here, in the only public constructor pairing a pool with a handle.
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

/// [`fold_from_mirror`], recording every row served as the fixture's
/// `osmRowSet` and the matcher reads' answers as its `osmTrace` sections. The
/// recorder wraps the source, so declines are captured too: without them a
/// replay would answer where production could not.
///
/// Returns `(folded, row_set, matcher_trace, geocode_section)`; the geocode
/// section is `None` when no geocode was answered.
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
