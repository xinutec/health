//! The mirror's coverage gate, across the bridge.
//!
//! `Verified.Geo.OsmCoverage` carries its own `#guard`s, so the DECISION is
//! already pinned against V8 (`lean/experiments/osmcoverage-refs.mts`). What
//! those guards cannot check is the wire: whether this host spells the question
//! the way the mode reads it. A float that crossed as the wrong bit pattern, or
//! a `fetchedAt` that arrived as seconds instead of milliseconds, would give a
//! confident wrong answer with every guard still green.
//!
//! So these are the same twelve cases, asked through `lean::osm_covered`.

use backend::lean::{CoverageRow, osm_covered};

const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 86_400_000;
const FRESH_DAYS: i64 = 180;

fn row(
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    age_days: Option<i64>,
) -> CoverageRow {
    CoverageRow {
        min_lat,
        max_lat,
        min_lon,
        max_lon,
        fetched_at: age_days.map(|d| NOW - d * DAY),
    }
}

fn big() -> CoverageRow {
    row(51.0, 52.0, -1.0, 1.0, Some(1))
}
fn stale() -> CoverageRow {
    row(51.0, 52.0, -1.0, 1.0, Some(FRESH_DAYS + 1))
}
fn legacy() -> CoverageRow {
    row(51.0, 52.0, -1.0, 1.0, None)
}

/// The same 111_000 / `cos` the module uses, so the "exact box" case really is
/// exact rather than nearly so.
fn meters_per_deg_lon(lat: f64) -> f64 {
    111_000.0 * (lat * std::f64::consts::PI / 180.0).cos()
}

fn ask(coverage: &[CoverageRow], radius_m: f64, has_local: bool) -> bool {
    osm_covered(51.5, -0.1, radius_m, coverage, NOW, has_local).expect("the bridge answers")
}

#[test]
fn has_local_data_short_circuits_everything() {
    assert!(ask(&[], 500.0, true), "an empty coverage list");
    assert!(ask(&[stale()], 500.0, true), "a stale row");
}

#[test]
fn containment_and_staleness() {
    assert!(!ask(&[], 500.0, false), "no rows at all");
    assert!(ask(&[big()], 500.0, false), "one fresh containing row");
    assert!(
        !ask(&[stale()], 500.0, false),
        "a stale row must NOT suppress a refresh"
    );
    assert!(
        ask(&[legacy()], 500.0, false),
        "a row with no fetch time is FRESH, not stale"
    );
    assert!(
        !ask(&[big()], 500_000.0, false),
        "a radius that pokes outside the row"
    );
}

#[test]
fn there_is_no_union_across_rows() {
    // ⚠ Two rows that jointly cover the box. Adding union logic would change
    // the answer, so this asserts the absence rather than assuming it.
    let west = row(51.0, 52.0, -1.0, -0.1, Some(1));
    let east = row(51.0, 52.0, -0.1, 1.0, Some(1));
    assert!(!ask(&[west, east], 500.0, false));
}

#[test]
fn the_box_is_inclusive_at_both_ends() {
    let d_lat = 500.0 / 111_000.0;
    let d_lon = 500.0 / meters_per_deg_lon(51.5);
    let exact = row(
        51.5 - d_lat,
        51.5 + d_lat,
        -0.1 - d_lon,
        -0.1 + d_lon,
        Some(1),
    );
    assert!(ask(&[exact], 500.0, false));
}

#[test]
fn a_high_latitude_stretches_the_longitude_half_of_the_box() {
    // dLon >> dLat at 70°N. A host that sent the two the wrong way round would
    // still answer, and would be wrong only far from home.
    let r = row(69.9, 70.1, 19.9, 20.1, Some(1));
    assert!(osm_covered(70.0, 20.0, 500.0, &[r], NOW, false).expect("the bridge answers"));
}

/// The mirror ships only the rows whose box contains the query POINT (#1921:
/// 476 calls a day, each carrying every box the bucket had). The claim that
/// this changes no verdict is the module's to make and this test's to check:
/// random rows, random points, every radius, both `hasLocalData` arms, with
/// stale and legacy rows mixed in — the filtered list and the full list must
/// agree every time.
#[test]
fn the_point_prefilter_changes_no_coverage_verdict() {
    use backend::mirror_source::MirrorSource;
    // A fixed-seed LCG: the cases are reproducible and need no crate.
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut agreed = 0usize;
    let mut covered = 0usize;
    for _ in 0..400 {
        let n = (next() * 12.0) as usize;
        let rows: Vec<CoverageRow> = (0..n)
            .map(|_| {
                // Boxes from a few hundred metres to several kilometres, near
                // London, so some contain the point, some only straddle it.
                let (lat, lon) = (51.4 + next() * 0.2, -0.2 + next() * 0.2);
                let (d_lat, d_lon) = (0.001 + next() * 0.03, 0.001 + next() * 0.05);
                let age = match (next() * 4.0) as u8 {
                    0 => None,
                    1 => Some(FRESH_DAYS + 1 + (next() * 100.0) as i64),
                    _ => Some((next() * 100.0) as i64),
                };
                row(lat - d_lat, lat + d_lat, lon - d_lon, lon + d_lon, age)
            })
            .collect();
        let (lat, lon) = (51.4 + next() * 0.2, -0.2 + next() * 0.2);
        let radius_m = [50.0, 150.0, 500.0, 1500.0][(next() * 4.0) as usize];
        let around = MirrorSource::boxes_around(lat, lon, &rows);
        assert!(around.len() <= rows.len());
        for has_local in [false, true] {
            let full = osm_covered(lat, lon, radius_m, &rows, NOW, has_local).expect("the bridge");
            let few = osm_covered(lat, lon, radius_m, &around, NOW, has_local).expect("the bridge");
            assert_eq!(
                full, few,
                "rows {rows:?} at ({lat}, {lon}) r={radius_m} local={has_local}"
            );
            agreed += 1;
            covered += usize::from(full);
        }
    }
    // Both verdicts must occur, or the comparison proved nothing.
    assert!(
        covered > 50 && covered < agreed - 50,
        "covered {covered} of {agreed}"
    );
}
