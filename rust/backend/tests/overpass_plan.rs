//! The mirrors' decisions, through the Lean FFI (#982 Tier 2): which region,
//! which tiles, whether to write, and the breaker.
//!
//! ⚠ NONE OF THESE ARE ARITHMETIC CHECKS. Each pins a decision that changes what
//! the cron does to production data — which city gets mirrored, and whether a
//! bad run is allowed to replace a good cache.

use backend::lean::{self, MirrorTile, tile_key};

fn setup() {
    lean::init().expect("the Lean runtime must start");
}

const LDN: (f64, f64) = (51.5074, -0.1278);
const LDN2: (f64, f64) = (51.5100, -0.1300);
const LDN3: (f64, f64) = (51.5200, -0.1100);
const AMS: (f64, f64) = (52.3676, 4.9041);

#[test]
fn the_home_metro_wins_over_a_travel_cluster() {
    setup();
    // Amsterdam is FIRST in the list and still loses: the home region is the
    // largest, not the earliest. A user with one trip abroad must not have
    // their mirror pointed at the trip.
    let plan = lean::mirror_region(&[AMS, LDN, LDN2, LDN3], 80.0, 0.05, 1500.0)
        .unwrap()
        .expect("four places bound something");
    assert_eq!(plan.region_count, 2, "London and Amsterdam are two metros");
    assert_eq!(plan.place_count, 4);
    assert!(
        plan.bbox.min_lat > 51.0 && plan.bbox.max_lat < 52.0,
        "the bbox must be London's, not a box containing the North Sea: {:?}",
        plan.bbox
    );
}

#[test]
fn no_places_is_nothing_to_mirror_not_an_error() {
    setup();
    assert!(
        lean::mirror_region(&[], 80.0, 0.05, 1500.0)
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_tiny_region_still_produces_at_least_one_tile() {
    setup();
    // ⚠ A single focus place gives a degenerate box before the margin is added.
    // Zero tiles would mean the cron fetches nothing and reports success.
    let plan = lean::mirror_region(&[LDN], 80.0, 0.05, 1500.0)
        .unwrap()
        .unwrap();
    assert!(!plan.tiles.is_empty(), "a degenerate box must still tile");
    assert_eq!(plan.region_count, 1);
}

#[test]
fn tiles_cover_the_bbox_corner_to_corner() {
    setup();
    let plan = lean::mirror_region(&[LDN, LDN2, LDN3], 80.0, 0.05, 1500.0)
        .unwrap()
        .unwrap();
    let first = plan.tiles.first().unwrap();
    let last = plan.tiles.last().unwrap();
    let near = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(near(first.min_lat, plan.bbox.min_lat));
    assert!(near(first.min_lon, plan.bbox.min_lon));
    assert!(near(last.max_lat, plan.bbox.max_lat));
    assert!(near(last.max_lon, plan.bbox.max_lon));
}

/// ⚠ THE TILE KEY IS A ROW'S OWNER. Every bus row carries it, and a partial run
/// replaces only the keys that answered — so a change of precision here orphans
/// every row already in the table.
#[test]
fn the_tile_key_is_four_decimal_places_of_the_south_west_corner() {
    let t = MirrorTile {
        min_lat: 51.523456789,
        max_lat: 51.6,
        min_lon: -0.123456789,
        max_lon: -0.1,
    };
    assert_eq!(tile_key(&t), "51.5235,-0.1235");
}

#[test]
fn a_query_names_the_tile_and_the_right_route_types() {
    setup();
    let t = MirrorTile {
        min_lat: 51.5,
        max_lat: 51.6,
        min_lon: -0.2,
        max_lon: -0.1,
    };
    let rail = lean::overpass_query("rail", &t).unwrap();
    assert_eq!(
        rail,
        "[out:json][timeout:180];relation[route~\"^(subway|train|light_rail|tram)$\"](51.5,-0.2,51.6,-0.1);out body;node(r);out body;"
    );
    let bus = lean::overpass_query("bus", &t).unwrap();
    assert_eq!(
        bus,
        "[out:json][timeout:180];relation[route=bus](51.5,-0.2,51.6,-0.1);out body;node(r);out body;"
    );
    // ⚠ `node(r)` is what makes small tiles safe: a relation touching the tile
    // comes back with its FULL stop list, so tiling finds routes rather than
    // clipping them.
    assert!(rail.contains("node(r)") && bus.contains("node(r)"));
}

/// ⚠ #1134 LIVES HERE. Both rules are ported as they stand, defects included,
/// because the parity diff is the instrument that finds defects of this class.
#[test]
fn the_two_arms_refuse_differently_and_that_is_deliberate() {
    setup();
    // ⚠ 18 tiles and ~995 routes are PRODUCTION's numbers, measured 2026-08-25
    // against the real `focus_places` — 65 recent places, 4 regions, a 51-place
    // home region tiling to 18. An invented tile count here would read as
    // production and would not be.

    // Bus: every tile failed against a populated cache — refuse.
    let v = lean::may_rebuild("bus", 0, 18, 18, 995).unwrap();
    assert!(!v.may_write);
    assert!(v.refusal.unwrap().contains("Every tile failed"));

    // Bus: ONE tile answered — proceed, because tile ownership makes it
    // lossless. This is the shape #1134 reports as a defect: 2 of 18 exits 0.
    let v = lean::may_rebuild("bus", 12, 17, 18, 995).unwrap();
    assert!(v.may_write);
    assert!(
        !v.full_rebuild,
        "a partial run is not authoritative for the bbox"
    );

    // Bus: a clean run may replace everything.
    let v = lean::may_rebuild("bus", 995, 0, 18, 995).unwrap();
    assert!(v.may_write && v.full_rebuild);

    // Bus: nothing to protect, so an all-failed first run still proceeds.
    assert!(lean::may_rebuild("bus", 0, 18, 18, 0).unwrap().may_write);

    // Rail: the discriminator is zero-found-with-any-failure.
    assert!(!lean::may_rebuild("rail", 0, 3, 18, 259).unwrap().may_write);
    // ⚠ Rail proceeds on a PARTIAL run and has no tile_key, so it will delete
    // the tiles that did not answer. Pinned because it is a live defect, not
    // because it is right.
    assert!(
        lean::may_rebuild("rail", 12, 12, 18, 259)
            .unwrap()
            .may_write
    );
    // Rail: a genuinely empty region with no failures is not an error.
    assert!(lean::may_rebuild("rail", 0, 0, 18, 259).unwrap().may_write);
}

#[test]
fn the_breaker_trips_on_a_burst_and_not_on_a_trickle() {
    setup();
    let t0: u64 = 1_000_000;

    let mut st = lean::BreakerState::new();
    for i in 0..3 {
        st = lean::breaker_step(&st, "failure", t0 + i * 10).unwrap();
    }
    assert!(st.open, "three failures inside the window trip it");

    // ⚠ A success while OPEN must not close it — the cooldown is the recovery
    // window, and reopening on the first lucky response invites the storm back.
    let after = lean::breaker_step(&st, "success", t0 + 100).unwrap();
    assert!(after.open);

    // Past the cooldown it is closed again.
    let later = lean::breaker_step(&st, "check", t0 + 20 + 60_000).unwrap();
    assert!(!later.open);

    // A trickle spread beyond the 30s window never trips.
    let mut st = lean::BreakerState::new();
    for i in 0..3 {
        st = lean::breaker_step(&st, "failure", t0 + i * 30_001).unwrap();
    }
    assert!(!st.open, "pruned failures must not accumulate");
}
