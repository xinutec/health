//! `rankvenues` — read the venue ranking's own terms instead of modelling them.
//!
//! ⚠ THIS TEST IS THE MODE'S CALLER, and that is deliberate (#1003). #325 built
//! this probe and REVERTED it rather than land a serve mode nothing exercised.
//! It is back because #1405 needed it: a hand-computed `shapeScore` disagreed
//! with what the fold actually served, and a model that disagrees with the
//! artefact is worth nothing. The mode has to stay reachable for the next such
//! question, so it ships with this.
//!
//! ⚠ `rankvenues` is registered in BOTH dispatch surfaces — `result` (the
//! in-process host and `serve`) and `cliMain` (argv). Registering only the
//! first is how the first run of this probe failed: argv fell through to the
//! HSMM model parser, which asks for property `T`, and the error named a field
//! this mode has never heard of.
//!
//! Floats cross as PLAIN NUMBERS here, not `fBits`. This is read by a human and
//! by the literals below, not a Lean-to-Lean parity hop.

use backend::lean;
use serde_json::{Value, json};

#[test]
fn the_ranking_reports_the_term_that_decided_it() {
    lean::init().expect("the Lean runtime must start");

    // Two venues at the same place, differing only in subtype and distance —
    // the shape of the #1405 case. No priors and no stay: the shape and hours
    // terms are then BOTH absent, so distance is the only thing left that can
    // order them, and the nearer one must win.
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

    // The parts must SUM to the total, or the breakdown is decoration rather
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

    // ⚠ The gap the probe MEASURED on #1405, pinned so it cannot rot: at these
    // two distances the whole geometric advantage is ~0.67 nats, while the
    // shape term's own clamps span 9.4. A venue prior can therefore outvote a
    // 3x distance difference — which is a fact about the CLAMPS, and was NOT
    // what moved the live case. See #1405 before tuning either.
    let near = ranked[0]["distance"].as_f64().unwrap();
    let far = ranked[1]["distance"].as_f64().unwrap();
    assert!(
        (near - far - 0.672).abs() < 0.01,
        "the 16.57 m vs 49.24 m geometric advantage moved: {}",
        near - far
    );
}
