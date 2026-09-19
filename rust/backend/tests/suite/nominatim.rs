//! The reverse-geocode cache key and the wire shape (#1076).
//!
//! The cache these keys address is in PRODUCTION, written by the TypeScript
//! before it was deleted (#975). A key that disagrees with the TypeScript's does
//! not fail — it misses, and re-pays Nominatim for an answer already bought. So
//! the rounding is pinned here rather than trusted.
//!
//! Round-tripping against the corpus's own 795 recorded answers is
//! `geocode_wire.rs`; this file is the arithmetic and the narrowing.

use backend::nominatim::{Geocode, narrow, query_type, round_coord};

/// ⚠ THE WHOLE POINT OF THIS MODULE'S KEY. `Math.round` takes a half toward
/// +∞; `f64::round` takes it away from zero. Every longitude in this record is
/// negative, so the two rules disagree on exactly the data in hand, and the Rust
/// one would miss every row the TypeScript wrote at this coordinate.
#[test]
fn a_negative_half_rounds_the_way_javascript_rounds_it() {
    let lon = -0.18365_f64;
    assert_eq!(round_coord(lon), -0.1836);
    assert_ne!(
        round_coord(lon),
        (lon * 10000.0).round() / 10000.0,
        "if these agree the test has stopped discriminating — pick another half"
    );
}

#[test]
fn a_positive_half_rounds_up_under_both_rules() {
    assert_eq!(round_coord(51.55625), 51.5563);
}

#[test]
fn ordinary_coordinates_round_to_four_places() {
    assert_eq!(round_coord(51.556_213_7), 51.5562);
    assert_eq!(round_coord(-0.279_481_2), -0.2795);
}

#[test]
fn the_query_type_is_the_typescripts() {
    assert_eq!(query_type(18), "nominatim_z18");
    assert_eq!(query_type(16), "nominatim_z16");
}

/// The narrowing, pinning `class` winning over `category` — the field the
/// TypeScript read, and the one Nominatim actually sends.
#[test]
fn a_reply_narrows_to_the_wire_shape() {
    let body = r#"{
        "display_name": "Trafalgar Square, London, England, United Kingdom",
        "type": "square",
        "class": "highway",
        "category": "ignored",
        "address": {"city": "London", "country_code": "gb"}
    }"#;
    let g = narrow(body).expect("a reply with a display_name narrows");
    assert_eq!(g.kind, "square");
    assert_eq!(g.category, "highway");
    assert_eq!(g.address["city"], "London");
}

/// ⚠ A reply WITHOUT a `display_name` is Nominatim saying nothing is there.
/// That is an answer and gets cached; it is not a failure, and conflating the
/// two would re-ask a settled question on every fold.
#[test]
fn a_reply_with_no_display_name_is_a_valid_empty_answer() {
    assert_eq!(narrow(r#"{"error":"Unable to geocode"}"#), None);
}

/// The fold reads these names, so they are wire format and a rename is a
/// fixture-breaking change.
#[test]
fn a_geocode_encodes_in_the_fixtures_own_field_names() {
    let g = Geocode {
        display_name: "X".into(),
        kind: "residential".into(),
        category: "highway".into(),
        address: serde_json::Map::new(),
    };
    let v = serde_json::to_value(&g).expect("encodes");
    assert!(
        v.get("displayName").is_some(),
        "displayName, not display_name"
    );
    assert_eq!(v["type"], "residential");
    assert_eq!(v["category"], "highway");
}

/// ⚠ THE SEAM BETWEEN THE QUEUE AND THE CACHE. A miss is recorded under
/// `queue_key`, and the drain parses that key back into coordinates and hands
/// them to `cache_put`, which rounds AGAIN. If rounding were not idempotent the
/// answer would land under a key the fold never forms — a fetch paid for and an
/// entry that stays missing, with nothing to see.
#[test]
fn a_queued_key_parses_back_to_the_same_cache_key() {
    for (lat, lon) in [
        (51.508_039_f64, -0.128_069_f64),
        (51.5, -0.12),
        (51.556_213_7, -0.279_481_2),
        (-33.868_82, 151.209_29),
    ] {
        let key = backend::nominatim::queue_key(lat, lon);
        let mut parts = key.split('|');
        let (plat, plon) = (
            parts.next().unwrap().parse::<f64>().unwrap(),
            parts.next().unwrap().parse::<f64>().unwrap(),
        );
        assert_eq!(
            format!("{:.4}|{:.4}", round_coord(plat), round_coord(plon)),
            format!("{:.4}|{:.4}", round_coord(lat), round_coord(lon)),
            "the drain must write where the reader looks, for {lat},{lon}"
        );
    }
}

/// Two fixes metres apart must queue ONE fetch. The service allows one request
/// per second, so a queue keyed on raw coordinates would spend a night on one
/// stay.
#[test]
fn nearby_coordinates_collapse_to_one_queued_key() {
    let a = backend::nominatim::queue_key(51.508_039, -0.128_069);
    let b = backend::nominatim::queue_key(51.508_041, -0.128_071);
    assert_eq!(a, b);
}

/// The drain learns which zooms were asked by reading them back off the queue's
/// `kind`, rather than carrying a list. If this did not round-trip, a whole
/// consumer's keys would sit in the table forever with nothing to notice.
#[test]
fn a_query_type_round_trips_back_to_its_zoom() {
    for z in [16_i64, 18] {
        assert_eq!(backend::nominatim::zoom_of(&query_type(z)), Some(z));
    }
    assert_eq!(backend::nominatim::zoom_of("overpass_r50"), None);
    assert_eq!(backend::nominatim::zoom_of("nominatim"), None);
}
