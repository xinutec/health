//! A fixture carries what it was captured under, and a moved constant refuses:
//! `ROAD_CORRIDOR_MARGIN_M` applies after the trace key is formed, so moving it
//! changes production and no fixture answer. This makes the guard fire.

use serde_json::json;

#[test]
fn an_absent_stamp_is_not_a_mismatch() {
    // Unstamped fixtures pass: refusing them would claim conditions they never
    // recorded.
    assert!(backend::osm_trace::check_capture_inputs(&json!({})).is_ok());
    assert!(
        backend::osm_trace::check_capture_inputs(&json!({"fixtureFormatVersion": 1})).is_ok(),
        "a meta block without captureInputs must pass"
    );
}

#[test]
fn the_stamp_this_build_writes_is_accepted() {
    let meta = json!({ "captureInputs": backend::osm_trace::capture_inputs() });
    assert!(
        backend::osm_trace::check_capture_inputs(&meta).is_ok(),
        "a capture taken under this build must replay under it"
    );
}

#[test]
fn a_moved_constant_refuses_and_says_which() {
    // The margin the fixtures were captured under: if a build moves it, the
    // fixtures need re-capturing, not this number updating.
    let meta = json!({
        "captureInputs": { "roadCorridorMarginM": 100.0, "candidateLimit": 20_000 }
    });
    let err = backend::osm_trace::check_capture_inputs(&meta)
        .expect_err("a fixture captured at a different margin must REFUSE");
    assert!(
        err.contains("roadCorridorMarginM"),
        "the refusal must name the constant that moved, got: {err}"
    );
    assert!(
        err.contains("captured under"),
        "the refusal must say which side is which, got: {err}"
    );
}

#[test]
fn a_stamp_naming_something_this_build_lost_also_refuses() {
    // A removed constant diverges too; comparing only present keys would pass.
    let meta = json!({ "captureInputs": { "someRetiredKnob": 7 } });
    let err = backend::osm_trace::check_capture_inputs(&meta)
        .expect_err("a stamp naming a constant this build does not have must REFUSE");
    assert!(err.contains("someRetiredKnob"), "got: {err}");
}
