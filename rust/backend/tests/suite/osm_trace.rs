//! A fixture's recorded trace answers the fold's asks (#1709).
//!
//! The matcher reads match QUANTISED — the two arms that wrote and read a key
//! compute a corridor centre one ULP apart on ~0.5% of rows — and the answerer
//! tables match exactly. A ring with no vertices is refused at load, because
//! a shape the parser drops once decoded every building outline to nothing.

use backend::fold_payload::bits;
use backend::lean::{Answerer, Ask};
use backend::osm_trace::{MatcherRead, Sections, TraceAnswerer};
use serde_json::json;

#[test]
fn a_matcher_key_matches_quantised_and_a_table_key_exactly() {
    let trace = json!({
        "walkableRoads": {
            "52.1|4.3|120": [{"osmId": 1, "name": "A", "coords": [[52.1, 4.3], [52.2, 4.4]]}]
        },
        "nearbyWays": {
            "52.1|4.3": [{"type": "highway", "subtype": "residential", "name": "A", "distanceM": 1.5}]
        }
    });
    let mut t = TraceAnswerer::new(Some(&trace), None, "t", Sections::ALL).unwrap();
    // One ULP off on the longitude still hits.
    let lon = f64::from_bits(4.3f64.to_bits() + 1);
    let key = format!(
        "{}|{}|{}",
        52.1f64.to_bits(),
        lon.to_bits(),
        120f64.to_bits()
    );
    let ways = t
        .answer(&Ask {
            what: "walkableRoads".into(),
            key,
        })
        .unwrap()
        .expect("answered");
    assert_eq!(ways[0]["osmId"], 1);
    assert_eq!(ways[0]["coords"][0][0], bits(52.1));

    let key = format!("{}|{}", 52.1f64.to_bits(), 4.3f64.to_bits());
    let row = t
        .answer(&Ask {
            what: "nearbyWays".into(),
            key,
        })
        .unwrap()
        .expect("answered");
    assert_eq!(row[2][0]["name"], "A");
    let key = format!("{}|{}", 52.1f64.to_bits(), lon.to_bits());
    assert!(
        t.answer(&Ask {
            what: "nearbyWays".into(),
            key
        })
        .unwrap()
        .is_none(),
        "an answerer table matches exactly"
    );
    assert!(t.has_walk_capture());
}

#[test]
fn a_ring_with_no_vertices_is_refused_not_decoded_to_nothing() {
    let trace = json!({ "buildingsNear": { "1|2|3": [[]] } });
    assert!(TraceAnswerer::new(Some(&trace), None, "t", Sections::ALL).is_err());
    let trace = json!({ "buildingsNear": { "1|2|3": [[{"lat": 1.0, "lon": 2.0}]] } });
    let t = TraceAnswerer::new(Some(&trace), None, "t", Sections::ALL).unwrap();
    assert!(t.has_walk_capture());
}

#[test]
fn the_three_reads_round_trip_their_names() {
    for r in MatcherRead::ALL {
        assert_eq!(MatcherRead::parse(r.name()), Some(r));
    }
    assert_eq!(MatcherRead::parse("nearbyWays"), None);
}
