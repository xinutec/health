//! Candidate OSM rows from the live mirror, for the fold's converge walk (#982).
//!
//! [`RowSetSource`](crate::rowset_answerer::RowSetSource) answers from the rows
//! a golden fixture carries, which is what made the day port checkable with no
//! database. This is the other implementation of the same trait: the rows come
//! from `osm_points`/`osm_lines` in production.
//!
//! # ⚠ The SQL is a PRE-FILTER. It is not allowed to score.
//!
//! `src/geo/osm-local.ts`'s `queryPoints`/`queryLines` compute the distance,
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
//! ⚠ HOW MUCH THIS CHANGES SERVED LABELS IS UNMEASURED, and an earlier version
//! of this note claimed it moves them. #413 measured the opposite for the
//! oracle swap alone — 2026-08-02, across every day where both oracles replay,
//! **0 of 315 timeline states** carry a different `place` or `wayName`. What is
//! predicted to move is narrower and comes from step 4 of
//! `docs/proposals/2026-07-osm-into-lean.md`: landmark polygons shifting up to
//! 17.67 m across `NEAR_FIELD_DECISIVE_M = 12`, **9 queries losing a named
//! street to `LIMIT 50` displacement**, and 541 `nearbyWays` reorderings that
//! are inert.
//!
//! This source drops `LIMIT 50`, so those 9 are the cases to look for — and
//! whether they survive the 0-of-315 result is exactly what the re-bless
//! answers. Do not assert a direction before it runs.
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
//! `ensureCovered` in the TypeScript FETCHES from Overpass when an area has not
//! been filled. This source does not: it asks
//! [`lean::osm_covered`](crate::lean::osm_covered), and where the TypeScript
//! would fetch, this DECLINES. A decline is honest — the fold records the key as
//! unanswerable and the caller can see it — where an empty row list would be the
//! claim that there are no roads there (#976). The write half is separate work
//! and is not in this module.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{MySqlPool, Row};

use crate::fold_payload::bits;
use crate::lean::{self, CoverageRow};
use crate::rowset_answerer::RowSource;

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
/// (`tests/mirror_source.rs`, ablated 2026-08-22 — 4 of 7 ways at one query
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
/// The radii these tables are asked with are 50–200 m
/// (`fold_payload::default_radius_m`), so a bucket inside one box is tens of
/// rows in the densest city. Reaching this many means the box is not the box
/// this module thinks it is, and the run ERRORS rather than answering from a
/// truncated set — a silently truncated candidate list scores as "the nearest
/// way is 40 m away" with no way to tell it from the truth.
pub const CANDIDATE_LIMIT: i64 = 20_000;

/// SQL statements this source has issued, process-wide.
///
/// ⚠ NOT A PERFORMANCE COUNTER SO MUCH AS A DENOMINATOR. The fold's wall clock
/// is dominated by round trips, and a round trip costs ~50x more over
/// `scripts/prod-db.sh`'s SSH tunnel than inside the cluster (measured
/// 2026-08-17: 54 s in-cluster vs 64 min tunnelled, same work). So a duration
/// measured from the Mac says nothing about production UNLESS the query count is
/// known — with it, the two can be compared; without it, any claim about
/// in-cluster latency is a guess.
static QUERIES: AtomicU64 = AtomicU64::new(0);

/// Read the query count and reset it, so a count belongs to one request.
pub fn take_queries() -> u64 {
    QUERIES.swap(0, Ordering::Relaxed)
}

/// Rows from the live mirror. One per converge walk: the coverage decisions it
/// memoises are only valid for the `now_ms` it was built with.
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
        }
    }

    /// The pre-filter box, as `[min_lat, max_lat, min_lon, max_lon]`.
    ///
    /// Half-width `radiusM / min(METERS_PER_DEG_LAT, metersPerDegLon(lat))` in
    /// BOTH axes — the TypeScript's own. See the module note for why this
    /// contains Lean's scoring window; `tests/mirror_source.rs` checks that claim
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
    /// `day-shell`'s mirror turns a failure into `None` and counts it, because
    /// it must finish a day it is halfway through; this is on the serving path,
    /// where the fold can be told. health #976 is that distinction going wrong
    /// in the other direction — a database that is down producing byte-for-byte
    /// the same answer as an area with no roads.
    fn block<T, F>(&self, f: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T, sqlx::Error>>,
    {
        // Counted here rather than at each call site: every query this source
        // makes goes through this one boundary, so the count cannot drift from
        // the queries.
        QUERIES.fetch_add(1, Ordering::Relaxed);
        Ok(self.handle.block_on(f)?)
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
            let rows = self
                .block(
                    sqlx::query(
                        "SELECT CAST(min_lat AS CHAR) AS min_lat, \
                            CAST(max_lat AS CHAR) AS max_lat, \
                            CAST(min_lon AS CHAR) AS min_lon, \
                            CAST(max_lon AS CHAR) AS max_lon, \
                            CAST(UNIX_TIMESTAMP(fetched_at) AS SIGNED) AS fetched_s \
                     FROM osm_coverage WHERE feature_type = ?",
                    )
                    .bind(bucket)
                    .fetch_all(&self.pool),
                )
                .with_context(|| format!("reading osm_coverage for {bucket}"))?;

            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                let f = |name: &str| -> Result<f64> {
                    r.try_get::<String, _>(name)
                        .with_context(|| format!("osm_coverage.{name} is not a string"))?
                        .trim()
                        .parse::<f64>()
                        .with_context(|| format!("osm_coverage.{name} does not parse"))
                };
                out.push(CoverageRow {
                    min_lat: f("min_lat")?,
                    max_lat: f("max_lat")?,
                    min_lon: f("min_lon")?,
                    max_lon: f("max_lon")?,
                    // ⚠ A row with no fetch time is FRESH, not stale — legacy
                    // data from before fetch times were tracked. Lean's
                    // `decideCoverage` says so; mapping it to 0 here would make
                    // every one of them stale and re-fetch the whole mirror.
                    fetched_at: r
                        .try_get::<Option<i64>, _>("fetched_s")
                        .context("osm_coverage.fetched_at does not decode")?
                        .map(|s| s * 1000),
                });
            }
            self.coverage.insert(bucket.to_string(), out);
        }
        Ok(&self.coverage[bucket])
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
        let boxes = self.coverage_rows(bucket)?.to_vec();
        let mut covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, false)
            .with_context(|| format!("coverage gate for {bucket}"))?;
        if !covered && self.has_local_data(bucket, lat, lon, radius_m)? {
            // ⚠ Asked through Lean again rather than set to `true` here.
            // `hasLocalData` short-circuits staleness as well as containment,
            // and that trade is a rule — it belongs in `decideCoverage`, not in
            // a `||` on this line.
            covered = lean::osm_covered(lat, lon, radius_m, &boxes, now, true)
                .with_context(|| format!("coverage gate for {bucket} with local data"))?;
        }
        self.decided.insert(k, covered);
        Ok(covered)
    }

    /// Guard the backstop. See [`CANDIDATE_LIMIT`].
    fn check_limit(n: usize, table: &str, bucket: &str) -> Result<()> {
        Self::check_limit_at(n, table, bucket, CANDIDATE_LIMIT)
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

impl RowSource for MirrorSource {
    /// Line candidates, in `osmspatial`'s positional form.
    ///
    /// ⚠ `parse_linestring_wkt` swaps to `(lat, lon)`: WKT writes `lon lat` and
    /// Lean's `lineDistDeg` reads `c.1` as the latitude. The swapped version
    /// produces distances that are wrong and entirely plausible.
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
        let poly = Self::mbr_box_wkt(lat, lon, radius_m);
        let rows = self
            .block(
                sqlx::query(
                    // ⚠ `tags_json` too. `nearbyLandmarks` needs the FULL tag
                    // map — it spawns one landmark per tag key — and while this
                    // column was absent from the line query that table could
                    // not be answered at all, so served days lost venue names
                    // (#1054). Buildings are ways, so the line side is exactly
                    // where a venue's outline lives.
                    "SELECT osm_id, subtype, name, tags_json, ST_AsText(geom) AS wkt \
                     FROM osm_lines \
                     WHERE feature_type = ? AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
                     LIMIT ?",
                )
                .bind(bucket)
                .bind(&poly)
                .bind(CANDIDATE_LIMIT)
                .fetch_all(&self.pool),
            )
            .with_context(|| format!("reading osm_lines for {bucket}"))?;
        Self::check_limit(rows.len(), "osm_lines", bucket)?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
            let coords: Vec<Value> = parse_linestring_wkt(&wkt)
                .into_iter()
                .map(|(la, lo)| json!([bits(la), bits(lo)]))
                .collect();
            // A way with one vertex is not a line — the same guard `day-shell`'s
            // mirror applies, and `lineDistDeg` on a single point would measure
            // to a vertex rather than along anything.
            if coords.len() < 2 {
                continue;
            }
            out.push(json!([
                r.try_get::<i64, _>("osm_id").context("osm_lines.osm_id")?,
                subtype_of(&r, "osm_lines")?,
                name_of(&r, "osm_lines")?,
                coords,
                // ⚠ Position 4, matching `parseLineRow`. Lean treats it as
                // optional, so an older caller sending four elements still
                // parses — but this one always sends it.
                tags_of(&r)?
            ]));
        }
        Ok(Some(out))
    }

    /// Point candidates, in `osmspatial`'s positional form.
    ///
    /// ⚠ `ST_X` is LONGITUDE and `ST_Y` is latitude: the geometry was built from
    /// `POINT(lon lat)` WKT. The row set the fixtures carry is extracted with
    /// this same pair of expressions (`src/geo/osm-rowset.ts`).
    ///
    /// That leaves one worry, and it is now MEASURED rather than argued: the
    /// capture read those doubles through the TypeScript driver's TEXT rendering
    /// and this reads them in the binary protocol, so a stored coordinate whose
    /// text form does not round-trip would differ in the last ULP and move every
    /// distance computed from it. `backend mirror-check` against production on
    /// 2026-08-22 found no such case — every difference between the two arms
    /// moved `name` or `subtype`, and NONE moved `distanceM`, which a coordinate
    /// difference could not avoid doing.
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
        let poly = Self::mbr_box_wkt(lat, lon, radius_m);
        let rows = self
            .block(
                sqlx::query(
                    "SELECT osm_id, subtype, name, tags_json, \
                            ST_X(geom) AS lon, ST_Y(geom) AS lat FROM osm_points \
                     WHERE feature_type = ? AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) \
                     LIMIT ?",
                )
                .bind(bucket)
                .bind(&poly)
                .bind(CANDIDATE_LIMIT)
                .fetch_all(&self.pool),
            )
            .with_context(|| format!("reading osm_points for {bucket}"))?;
        Self::check_limit(rows.len(), "osm_points", bucket)?;

        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let plat: f64 = r.try_get("lat").context("osm_points ST_Y")?;
            let plon: f64 = r.try_get("lon").context("osm_points ST_X")?;
            out.push(json!([
                r.try_get::<i64, _>("osm_id").context("osm_points.osm_id")?,
                subtype_of(&r, "osm_points")?,
                name_of(&r, "osm_points")?,
                bits(plat),
                bits(plon),
                tags_of(&r)?
            ]));
        }
        Ok(Some(out))
    }

    /// The four line buckets `nearbyWays` needs, in ONE query.
    ///
    /// ⚠ Coverage is still checked PER BUCKET. The batching is about round
    /// trips, not about the gate: a coordinate the mirror cannot vouch for in
    /// one bucket is still a decline for the whole answer, and folding the
    /// buckets into one `IN` list would otherwise quietly answer for an area
    /// that was never fetched.
    ///
    /// ⚠ `feature_type` is SELECTED BACK, not assumed from the query order.
    /// MariaDB is free to return an `IN` list's rows in any order, and the
    /// bucket becomes each way's `type` downstream — deriving it from position
    /// would mislabel every way on some days and none on others.
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
        for b in buckets {
            if !self.covered(b, lat, lon, radius_m)? {
                return Ok(None);
            }
        }
        let poly = Self::mbr_box_wkt(lat, lon, radius_m);
        let placeholders = std::iter::repeat_n("?", buckets.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT feature_type, osm_id, subtype, name, tags_json, ST_AsText(geom) AS wkt              FROM osm_lines              WHERE feature_type IN ({placeholders})                AND MBRIntersects(geom, ST_GeomFromText(?, 4326))              LIMIT ?"
        );
        // ⚠ `AssertSqlSafe`: audited — the only interpolation is the `?`
        // placeholder run, whose length comes from `buckets.len()`. Every bucket
        // NAME is bound.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
        for b in buckets {
            q = q.bind(*b);
        }
        // ⚠ The candidate cap is now shared across four buckets where it used to
        // be per bucket, so it is multiplied to keep the same headroom each had.
        // Leaving it at the single-bucket value would silently truncate a dense
        // coordinate — which reads as "fewer roads here", not as an error.
        let cap = CANDIDATE_LIMIT * buckets.len() as i64;
        let rows = self
            .block(q.bind(&poly).bind(cap).fetch_all(&self.pool))
            .context("reading osm_lines for the nearbyWays buckets")?;
        Self::check_limit_at(rows.len(), "osm_lines", "nearbyWays buckets", cap)?;

        let mut out: crate::rowset_answerer::LinesByBucket = buckets
            .iter()
            .map(|b| ((*b).to_string(), Vec::new()))
            .collect();
        for r in rows {
            let bucket: String = r
                .try_get("feature_type")
                .context("osm_lines.feature_type")?;
            let wkt: String = r.try_get("wkt").context("osm_lines.geom has no WKT")?;
            let coords: Vec<Value> = parse_linestring_wkt(&wkt)
                .into_iter()
                .map(|(la, lo)| json!([bits(la), bits(lo)]))
                .collect();
            // A way with one vertex is not a line — same guard as `line_rows`.
            if coords.len() < 2 {
                continue;
            }
            let row = json!([
                r.try_get::<i64, _>("osm_id").context("osm_lines.osm_id")?,
                subtype_of(&r, "osm_lines")?,
                name_of(&r, "osm_lines")?,
                coords,
                tags_of(&r)?
            ]);
            match out.iter_mut().find(|(b, _)| *b == bucket) {
                Some((_, v)) => v.push(row),
                // ⚠ Loud. A row whose `feature_type` is none of the four asked
                // for means the WHERE clause and this grouping disagree, and
                // dropping it silently would lose ways with no symptom.
                None => bail!(
                    "osm_lines returned feature_type {bucket:?}, which was not among the \
                     buckets asked for — the query and the grouping disagree"
                ),
            }
        }
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
            .block(q.fetch_all(&self.pool))
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
/// `converge` is SYNCHRONOUS — the fold reaches an answerer through a Lean
/// callback, and there is no `await` to hand an answer back through — while
/// `sqlx` is async. So the walk has to happen on a blocking thread with a
/// runtime handle to block on, and `Handle::block_on` from a runtime WORKER
/// aborts the process instead of returning an error.
///
/// That hazard cannot be detected from inside [`MirrorSource`]: tokio sets the
/// runtime context on blocking-pool threads too, so `Handle::try_current()`
/// says the same thing in the safe case and the fatal one. `day-shell`'s mirror
/// can refuse because it owns a private runtime; this cannot. What replaces the
/// check is that the blocking hop lives HERE, with the only public constructor
/// that pairs a pool with a handle — a caller that reaches `converge` from a
/// handler has to have gone around this function to do it.
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

/// Walk a day to convergence against the live mirror. See
/// [`with_mirror_answerer`] for why this hop exists.
pub async fn converge_from_mirror(
    pool: MySqlPool,
    cap: Value,
    inputs: Value,
    now_ms: i64,
) -> Result<crate::fold_converge::Converged> {
    with_mirror_answerer(pool, now_ms, move |answerer| {
        // No trace: production has no recording to seed the tables from, and
        // passing one would answer questions the mirror is here to answer.
        crate::fold_converge::converge(&cap, &inputs, None, answerer)
    })
    .await
}
