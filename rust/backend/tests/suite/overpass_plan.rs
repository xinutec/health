//! The mirrors' decisions through the Lean FFI: which region, which tiles,
//! whether to write, and the breaker. Each changes what a cron does to
//! production data.

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
    // Amsterdam is first in the list and still loses: the home region is the
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
    // A single focus place gives a degenerate box before the margin is added.
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

/// The tile key is a row's owner. Every bus row carries it, and a partial run
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

/// A moved bbox renames every tile: `tile_key` is the south-west corner, so a
/// shifted origin shares no key with the old lattice, and the merge's per-tile
/// `DELETE` only names current keys. Old rows become unreachable, yet the
/// reader still takes them.
///
/// ⚠ The numbers are synthetic and must stay so: the real grid derives from
/// mined places, i.e. where the user goes, and this repository is public.
#[test]
fn shifting_the_bbox_renames_every_tile() {
    // A whole degree apart would be absurd; the real case is a shift of a few
    // hundred metres, and that is what this reproduces. Round origins, chosen to
    // be obviously invented.
    let live = |k: f64| MirrorTile {
        min_lat: 51.5000 + 0.0360 * k,
        max_lat: 51.5000 + 0.0360 * (k + 1.0),
        min_lon: -0.2000,
        max_lon: -0.1533,
    };
    // Off both lattices: 51.5876 is not 51.5000 + 0.0360k, and the longitude
    // misses by a single unit in the last place the key keeps.
    let retired = MirrorTile {
        min_lat: 51.5876,
        max_lat: 51.6236,
        min_lon: -0.2001,
        max_lon: -0.1534,
    };

    let planned: Vec<String> = (0..5).map(|k| tile_key(&live(f64::from(k)))).collect();
    assert!(
        !planned.contains(&tile_key(&retired)),
        "the retired key must not be reachable from the live lattice: {planned:?}"
    );

    // And the near miss is the point. The longitudes differ by 0.0001 — one
    // unit in the last place the key keeps — so the two names look identical at
    // a glance and share nothing as strings.
    assert_eq!(tile_key(&retired), "51.5876,-0.2001");
    assert_eq!(tile_key(&live(0.0)), "51.5000,-0.2000");
    let neighbour = MirrorTile {
        min_lon: -0.2000,
        ..retired
    };
    assert_ne!(
        tile_key(&neighbour),
        tile_key(&retired),
        "0.0001 of longitude is a different owner, not a rounding detail"
    );
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
    // `node(r)` is what makes small tiles safe: a relation touching the tile
    // comes back with its full stop list, so tiling finds routes rather than
    // clipping them.
    assert!(rail.contains("node(r)") && bus.contains("node(r)"));
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

    // A success while open must not close it — the cooldown is the recovery
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
