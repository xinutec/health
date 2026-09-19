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
