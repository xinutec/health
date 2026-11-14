//! `rankvenues` — read the venue ranking's own terms instead of modelling them.
//! This test is the mode's caller, so it stays reachable. It is registered in
//! both `dispatch` (`serve`) and `cliMain` (argv). Floats cross as plain
//! numbers: this is read by a human, not a Lean-to-Lean hop.
//!
//! ⚠ The probe does not reproduce the fold: on the same landmarks, stay window
//! and priors, `bestplace` disagreed with the fold on two of three prior blobs.
//! Some `StayEnrich` input is not modelled: perhaps the mined centroid it names
//! at, `preferResidential`, or `samples`. Settle naming questions with the fold:
//!
//!     cargo run --release --example dump_day_request -- <day> > req.json
//!     # rewrite req.env.venuePriors, then
//!     lean/.lake/build/bin/verified_cli day < req.json
//!
//! whose `segsSplit`/`segsEnriched`/`segsMid`/`segs`/`states` show the stage a
//! label changes at.

use backend::lean;
use serde_json::{Value, json};

#[test]
fn the_ranking_reports_the_term_that_decided_it() {
    lean::init().expect("the Lean runtime must start");

    // Two venues differing only in subtype and distance, with no priors and no
    // stay: distance alone orders them, and the nearer wins.
    let req = json!({
        "mode": "rankvenues",
        "landmarks": [
            {"name": "Near", "type": "amenity", "subtype": "fast_food", "distanceM": 16.57},
            {"name": "Far",  "type": "amenity", "subtype": "restaurant", "distanceM": 49.24},
        ],
        "stay": null,
        "priors": null,
    });
    let reply = lean::serve(&req.to_string()).expect("the mode answers");
    let v: Value = serde_json::from_str(&reply).expect("the reply parses");
    let ranked = v["ranked"].as_array().expect("a ranked array");

    assert_eq!(
        ranked.len(),
        2,
        "every candidate comes back, not just the winner"
    );
    assert_eq!(ranked[0]["name"], "Near");
    assert_eq!(
        ranked[0]["shape"],
        Value::Null,
        "no priors means NO shape evidence — not a shape of zero, which would \
         read as 'measured and neutral'"
    );
    assert_eq!(
        ranked[0]["hours"],
        Value::Null,
        "no stay means no hours evidence"
    );

    // The parts must sum to the total, or the breakdown is decoration rather
    // than the thing that decided the order.
    for c in ranked {
        let total = c["total"].as_f64().expect("a total");
        let parts = c["distance"].as_f64().expect("a distance")
            + c["venue"].as_f64().expect("a venue term")
            + c["shape"].as_f64().unwrap_or(0.0)
            + c["hours"].as_f64().unwrap_or(0.0);
        assert!(
            (total - parts).abs() < 1e-12,
            "{}: total {total} is not its parts {parts}",
            c["name"]
        );
    }

    // At these distances the geometric advantage is ~0.67 nats while the shape
    // term's clamps span 9.4, so a venue prior can outvote a 3x distance gap.
    let near = ranked[0]["distance"].as_f64().unwrap();
    let far = ranked[1]["distance"].as_f64().unwrap();
    assert!(
        (near - far - 0.672).abs() < 0.01,
        "the 16.57 m vs 49.24 m geometric advantage moved: {}",
        near - far
    );
}

/// The `bestplace` mode, the whole chain, and its caller. It pins the two gates
/// the ranking cannot show: an enclosing landmark short-circuits everything,
/// and otherwise the label is the ranked winner, not the geocode.
#[test]
fn the_chain_reports_a_label_and_an_enclosure_wins_outright() {
    lean::init().expect("the Lean runtime must start");

    let ask = |enclosing_far: bool| {
        let req = json!({
            "mode": "bestplace",
            "landmarks": [
                {"name": "Near", "type": "amenity", "subtype": "cafe", "distanceM": 5.0},
                {"name": "Far", "type": "amenity", "subtype": "hospital",
                 "distanceM": 90.0, "enclosing": enclosing_far},
            ],
            // No geocode at all: the chain must answer from the landmarks, and a
            // `null` here is what an uncaptured reverse-geocode looks like.
            "geocode": {"18": Value::Null, "16": Value::Null},
            "samples": [],
            "stay": Value::Null,
            "priors": Value::Null,
            "preferResidential": false,
        });
        let reply = lean::serve(&req.to_string()).expect("the mode answers");
        let v: Value = serde_json::from_str(&reply).expect("the reply parses");
        v["label"].as_str().map(str::to_string)
    };

    assert_eq!(
        ask(false).as_deref(),
        Some("Near"),
        "with nothing enclosing, the nearest candidate names the stay"
    );
    assert_eq!(
        ask(true).as_deref(),
        Some("Far"),
        "an ENCLOSING landmark outranks a nearer one — it is the chain's first \
         gate, and the ranking below it never runs"
    );
}
