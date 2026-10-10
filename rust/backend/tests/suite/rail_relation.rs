//! `lean::relation_route` — the `relationroute` mode's production caller.
//!
//! `refresh-rail-routes` reaches for it when the mirror holds no connected
//! track between a long ride's stations: the route relation's own ways are
//! routed over, near-touching ways bridged. The job runs nightly against
//! Overpass, so nothing in a test can drive it; this drives the mode through
//! the same Rust function the job calls.
//!
//! The geography is invented — no tracked test carries a real place: two ways
//! running north from the origin that do not share a node.
//!
//! ⚠ ONE `#[test]`: `lean::init()` starts a runtime, and tests racing on it
//! flake (see `rail_snap.rs`).

use backend::fold_payload::bits;
use serde_json::json;

/// A way north along the meridian from `a` to `b` degrees of latitude.
fn way(a: f64, b: f64) -> serde_json::Value {
    let coords: Vec<serde_json::Value> = (0..=10)
        .map(|i| {
            let lat = a + (b - a) * f64::from(i) / 10.0;
            json!([bits(lat), bits(0.0)])
        })
        .collect();
    json!({ "name": null, "subtype": "rail", "coords": coords })
}

#[test]
fn relation_route_joins_a_relations_ways_and_refuses_a_gap_too_wide() {
    backend::lean::init().expect("the Lean runtime must start");

    // ── 1. A 100 m gap between the two ways is bridged ──────────────────────
    // 0.0009° of latitude is about 100 m, under the 200 m bridge.
    let ways = vec![way(0.0, 0.01), way(0.0109, 0.02)];
    let fixes: Vec<(f64, f64)> = (0..5).map(|i| (f64::from(i) * 0.005, 0.0)).collect();
    let (median, path) =
        backend::lean::relation_route(1000.0, 1600.0, &ways, (0.0, 0.0), (0.02, 0.0), &fixes)
            .expect("the mode answers")
            .expect("the bridged ways join the two ends");
    assert_eq!(path.len(), 22, "both ways' vertices, end to end");
    let lat = |i: usize| path[i]["lat"].as_f64().expect("a latitude");
    assert!(lat(0).abs() < 1e-9 && (lat(path.len() - 1) - 0.02).abs() < 1e-9);
    assert!(median < 1.0, "fixes on the track lie on it: {median} m");

    // ── 2. A 1 km gap is not bridged: leave it raw ──────────────────────────
    let apart = vec![way(0.0, 0.01), way(0.019, 0.03)];
    let none =
        backend::lean::relation_route(1000.0, 1600.0, &apart, (0.0, 0.0), (0.03, 0.0), &fixes)
            .expect("the mode answers");
    assert!(none.is_none(), "no path across a gap wider than the bridge");
}
