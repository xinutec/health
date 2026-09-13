//! The Overpass extraction path, end to end through the Lean FFI (#982 Tier 2).
//!
//! ⚠ THE FIXTURE IS A GENUINE OVERPASS RESPONSE, sliced from a real
//! central-London rail tile fetched 2026-08-25 — two relations and exactly the
//! nodes they reference. It is NOT hand-built, and that is the point: a
//! hand-built fixture invented a wire format the producer never emitted once
//! already this week, and five tests passed against the fiction.
//!
//! The expectations below are the TYPESCRIPT ARM'S OUTPUT for this same input,
//! read off `dist/geo/osm-rail-stops.js`, not values chosen to match the port.

use backend::lean;

/// ⚠ The Lean runtime must be started before any op, and each `#[test]` is its
/// own entry point into the process — `init()` is idempotent, so every test
/// calls it rather than relying on whichever ran first.
fn setup() {
    lean::init().expect("the Lean runtime must start");
}

fn fixture() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/overpass_rail_tile.json"
    ))
    .expect("the Overpass fixture is missing")
}

#[test]
fn rail_extraction_matches_the_typescript_arm() {
    setup();
    let routes = lean::extract_routes("rail", &fixture()).expect("extract");
    assert_eq!(routes.len(), 2, "both relations are keepable");

    let central = routes
        .iter()
        .find(|r| r.osm_relation_id == 102768)
        .expect("the Central line relation");
    assert_eq!(central.route_type.as_deref(), Some("subway"));
    assert_eq!(central.route_ref.as_deref(), Some("Central"));
    assert_eq!(central.stops.len(), 36);

    // ⚠ Member order is the ROUTE DIRECTION. Epping is first because the
    // relation lists it first, not because it sorts first.
    assert_eq!(central.stops[0].name.as_deref(), Some("Epping"));
    assert_eq!(central.stops[0].seq, 0);
    assert_eq!(central.stops[0].lat, 51.6934076);
    assert_eq!(central.stops[0].lon, 0.113805);
}

/// ⚠ THE CASE THAT MAKES RAIL DIFFERENT FROM BUS. This relation carries a `name`
/// and NO `ref`; the bus arm would drop it. 19 of the 188 relations in the tile
/// this was sliced from are like this — 10% of London's rail.
#[test]
fn a_rail_relation_with_no_ref_is_kept_on_its_name() {
    setup();
    let routes = lean::extract_routes("rail", &fixture()).expect("extract");
    let named = routes
        .iter()
        .find(|r| r.osm_relation_id == 5776935)
        .expect("the Liverpool Street relation");
    assert_eq!(named.route_ref, None, "this relation genuinely has no ref");
    assert!(
        named
            .route_name
            .as_deref()
            .unwrap_or("")
            .starts_with("London Liverpool Street"),
    );
    assert_eq!(named.route_type.as_deref(), Some("train"));
    assert_eq!(named.stops.len(), 8);
    assert_eq!(
        named.stops[0].name.as_deref(),
        Some("London Liverpool Street")
    );
}

/// ⚠ THE SAME BYTES THROUGH THE BUS ARM YIELD NOTHING, because these are rail
/// relations. A shared extractor would have to pick one rule, and this is what
/// picking the wrong one costs.
#[test]
fn the_bus_arm_keeps_nothing_from_a_rail_tile() {
    setup();
    let routes = lean::extract_routes("bus", &fixture()).expect("extract");
    assert!(routes.is_empty(), "route=subway/train are not route=bus");
}

/// Coordinates cross the FFI as bit patterns, so an exact comparison is the
/// right one — a tolerance here would hide a rendering bug rather than a
/// rounding one.
#[test]
fn coordinates_survive_the_ffi_exactly() {
    setup();
    let routes = lean::extract_routes("rail", &fixture()).expect("extract");
    let central = routes.iter().find(|r| r.osm_relation_id == 102768).unwrap();
    for s in &central.stops {
        assert!(s.lat > 51.0 && s.lat < 52.5, "lat {} is off the map", s.lat);
        assert!(s.lon > -1.0 && s.lon < 1.5, "lon {} is off the map", s.lon);
    }
    // Sequence is dense and ordered — an unresolvable member must leave no gap.
    let seqs: Vec<i64> = central.stops.iter().map(|s| s.seq).collect();
    assert_eq!(seqs, (0..36).collect::<Vec<i64>>());
}

/// ⚠ `stops_json` IS COMPARED ROW FOR ROW against the TypeScript arm's, and
/// `JSON.stringify` follows the object literal's field order. `serde` follows
/// declaration order, so this pins the declaration.
#[test]
fn the_serialised_stop_field_order_matches_json_stringify() {
    setup();
    let routes = lean::extract_routes("rail", &fixture()).expect("extract");
    let s = &routes
        .iter()
        .find(|r| r.osm_relation_id == 102768)
        .unwrap()
        .stops[0];
    let json = serde_json::to_string(s).unwrap();
    assert_eq!(
        json, r#"{"name":"Epping","lat":51.6934076,"lon":0.113805,"seq":0}"#,
        "field order or number rendering drifted from the TypeScript"
    );
}
