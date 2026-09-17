//! `busRouteCache` is filtered to what the day can reach (#1071).
//!
//! # Why a filter here is sound, and why that has to be TESTED rather than argued
//!
//! `Verified.Geo.Bus.bestPairFor` returns `none` unless `anchorsNear` finds a
//! stop within `BUS_STOP_ANCHOR_M` (120 m) of BOTH the leg's board fix and its
//! alight fix, and `Env.busFixes` is `env.points`. So a route with no stop near
//! any fix cannot label any leg, and shipping it only costs the Lean parse —
//! which is ~20x the text in heap (61 MiB for a 3.0 MB request, against 1 MiB
//! for everything the fold then computes).
//!
//! ⚠ **THE DANGER IS A FILTER THAT IS TOO TIGHT, and it would be SILENT**: a
//! dropped route is not an error downstream, it is a leg that reads as
//! `driving` with no bus label — exactly the false negative #328 is about. So
//! these tests pin the KEEP side hardest.

use backend::fold_payload::reachable_bus_routes;
use serde_json::{Value, json};

/// A public central-London coordinate, deliberately not anywhere the user goes
/// (#860). Only the arithmetic matters here.
const LAT: f64 = 51.5080;
const LON: f64 = -0.1281;

fn route(name: &str, stops: &[(f64, f64)]) -> Value {
    json!({
        "routeRef": name,
        "stops": stops.iter().enumerate()
            .map(|(i, (la, lo))| json!({"name": format!("s{i}"), "lat": la, "lon": lo, "seq": i}))
            .collect::<Vec<_>>(),
    })
}

fn refs(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|r| r["routeRef"].as_str().expect("a ref").to_string())
        .collect()
}

/// Metres, converted to degrees of latitude — 1 degree is ~111.32 km.
fn north(m: f64) -> f64 {
    LAT + m / 111_320.0
}

#[test]
fn a_route_stopping_at_the_day_keeps_and_one_far_away_goes() {
    let cache = json!([
        route("near", &[(LAT, LON), (north(300.0), LON)]),
        route("far", &[(north(50_000.0), LON)]),
    ]);
    let points = json!([{ "ts": 1, "lat": LAT, "lon": LON }]);
    let got = reachable_bus_routes(Some(&cache), Some(&points)).expect("a filtered cache");
    assert_eq!(refs(&got), vec!["near"], "the far route is unreachable");
}

/// ⚠ THE SUPERSET PROPERTY, and the one that matters. The Lean gate is 120 m;
/// anything inside it must survive, and the grid is deliberately coarser so
/// that a stop a little beyond 120 m survives too. A filter that trimmed to
/// exactly 120 m would be correct only if this file and the Lean constant never
/// drift apart, which is not a bet worth taking.
#[test]
fn every_stop_within_the_matchers_radius_survives() {
    for m in [0.0, 50.0, 119.0, 120.0] {
        let cache = json!([route("r", &[(north(m), LON)])]);
        let points = json!([{ "ts": 1, "lat": LAT, "lon": LON }]);
        let got = reachable_bus_routes(Some(&cache), Some(&points)).expect("a filtered cache");
        assert_eq!(refs(&got), vec!["r"], "a stop {m} m away must be kept");
    }
}

/// ⚠ NO FIXES IS NOT "NO BUSES". With nothing to filter against there is no
/// basis for the judgement, and an empty cache reads downstream exactly like a
/// day with no bus service — a silent wrong answer rather than a loud one.
#[test]
fn a_day_with_no_fixes_keeps_the_whole_cache() {
    let cache = json!([
        route("a", &[(LAT, LON)]),
        route("b", &[(north(50_000.0), LON)])
    ]);
    for points in [json!([]), Value::Null] {
        let got = reachable_bus_routes(Some(&cache), Some(&points)).expect("the cache");
        assert_eq!(refs(&got), vec!["a", "b"], "no fixes must not filter");
    }
    let got = reachable_bus_routes(Some(&cache), None).expect("the cache");
    assert_eq!(refs(&got), vec!["a", "b"], "absent points must not filter");
}

/// A stop with no usable coordinate cannot be SHOWN unreachable, so the route
/// stays. Erring towards the larger set is the only safe direction here.
#[test]
fn a_stop_without_coordinates_keeps_its_route() {
    let cache = json!([{
        "routeRef": "odd",
        "stops": [{ "name": "nowhere", "seq": 0 }],
    }]);
    let points = json!([{ "ts": 1, "lat": north(50_000.0), "lon": LON }]);
    let got = reachable_bus_routes(Some(&cache), Some(&points)).expect("the cache");
    assert_eq!(refs(&got), vec!["odd"], "an uncheckable stop is kept");
}

/// One reachable stop is enough — the matcher anchors board and alight
/// independently and a long route can enter the day at any point along it.
#[test]
fn one_reachable_stop_of_many_keeps_the_route() {
    let mut stops: Vec<(f64, f64)> = (1..40)
        .map(|i| (north(1_000.0 * f64::from(i)), LON))
        .collect();
    stops.push((LAT, LON));
    let cache = json!([route("long", &stops)]);
    let points = json!([{ "ts": 1, "lat": LAT, "lon": LON }]);
    let got = reachable_bus_routes(Some(&cache), Some(&points)).expect("the cache");
    assert_eq!(
        refs(&got),
        vec!["long"],
        "one stop in range keeps the route"
    );
}
