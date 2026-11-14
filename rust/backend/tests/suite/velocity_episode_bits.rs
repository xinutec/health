//! Episode coordinates must leave `/api/velocity` as numbers. The fold's
//! internal wire uses IEEE-754 bit strings; forwarded, Leaflet read one as a
//! latitude and the Android WebView hung. The client has no bit decoder, so the
//! conversion is at the serve boundary.

use backend::routes::velocity::decode_episode_bits;
use serde_json::json;

/// `51.5693619f64.to_bits()` and `(-0.2784158f64).to_bits()`.
const LAT_BITS: &str = "4632454559779392337";
const LON_BITS: &str = "13822059149945217962";

#[test]
fn bit_strings_become_the_numbers_they_encode() {
    let out = decode_episode_bits(json!([{
        "kind": "raw",
        "points": [{ "lat": LAT_BITS, "lon": LON_BITS, "ts": "4745247766530228224" }],
    }]));
    let p = &out[0]["points"][0];
    assert!(
        (p["lat"].as_f64().unwrap() - 51.569_361_9).abs() < 1e-9,
        "lat: {p}"
    );
    assert!(
        (p["lon"].as_f64().unwrap() - -0.278_415_8).abs() < 1e-9,
        "lon: {p}"
    );
    // A whole `ts` stays an INTEGER. `points` already ships it as one, and a
    // client comparing an episode's ts against a point's should not have to
    // care which field it came from.
    assert_eq!(p["ts"].as_i64(), Some(1_778_831_133), "ts: {p}");
}

#[test]
fn numbers_are_left_alone() {
    // Tolerant on purpose: if the fold's encoder ever starts emitting numbers,
    // this must not double-decode them into nonsense.
    let out = decode_episode_bits(json!([{
        "points": [{ "lat": 51.5, "lon": -0.12, "ts": 1_778_831_133 }],
    }]));
    let p = &out[0]["points"][0];
    assert_eq!(p["lat"].as_f64(), Some(51.5));
    assert_eq!(p["lon"].as_f64(), Some(-0.12));
    assert_eq!(p["ts"].as_i64(), Some(1_778_831_133));
}

#[test]
fn every_other_field_survives_untouched() {
    // The episode's own shape is the map's contract — only the coordinates are
    // being repaired here.
    let out = decode_episode_bits(json!([{
        "startTs": 1, "endTs": 2, "mode": "walking", "kind": "anchor",
        "place": "Somewhere", "points": [{ "lat": LAT_BITS, "lon": LON_BITS }],
    }]));
    assert_eq!(out[0]["mode"], "walking");
    assert_eq!(out[0]["kind"], "anchor");
    assert_eq!(out[0]["place"], "Somewhere");
    assert_eq!(out[0]["startTs"], 1);
}

#[test]
fn an_unparseable_value_is_left_rather_than_zeroed() {
    // Not defaulted to 0: a zeroed coordinate draws a line across the planet.
    let out = decode_episode_bits(json!([{ "points": [{ "lat": "banana", "lon": LON_BITS }] }]));
    assert_eq!(out[0]["points"][0]["lat"], "banana");
}
