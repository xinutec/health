//! A fixture carries what it was captured under, and a moved constant REFUSES
//! (#1660).
//!
//! ⚠ WHY THIS TEST AND NOT JUST THE CODE: the thing being guarded against is a
//! change that leaves every gate green. `ROAD_CORRIDOR_MARGIN_M` is applied
//! inside `query_ways`, AFTER the trace key is formed, so moving it changes what
//! production fetches and changes nothing any fixture answers (#1071). A guard
//! against that failure mode is itself invisible unless something makes it fire
//! — which is the whole lesson of #1418 and of this ticket's own morning.

use serde_json::json;

#[test]
fn an_absent_stamp_is_not_a_mismatch() {
    // ⚠ THE 42 EXISTING FIXTURES CARRY NO STAMP. Refusing them would be
    // claiming they were taken under something they never recorded, and would
    // break every gate on a change that improved nothing.
    assert!(backend::osm_host::check_capture_inputs(&json!({})).is_ok());
    assert!(
        backend::osm_host::check_capture_inputs(&json!({"fixtureFormatVersion": 1})).is_ok(),
        "a meta block without captureInputs must pass"
    );
}

#[test]
fn the_stamp_this_build_writes_is_accepted() {
    let meta = json!({ "captureInputs": backend::osm_host::capture_inputs() });
    assert!(
        backend::osm_host::check_capture_inputs(&meta).is_ok(),
        "a capture taken under this build must replay under it"
    );
}

#[test]
fn a_moved_constant_refuses_and_says_which() {
    // The margin as it was on 2026-09-18. If this build legitimately moves it,
    // this test is the reminder that the 42 fixtures need re-capturing — not a
    // number to update in place.
    let meta = json!({
        "captureInputs": { "roadCorridorMarginM": 100.0, "candidateLimit": 20_000 }
    });
    let err = backend::osm_host::check_capture_inputs(&meta)
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
    // ⚠ A constant REMOVED is as much a divergence as one moved, and the
    // obvious implementation — look up each key and compare — silently passes
    // when the key is gone. This is the arm that catches that.
    let meta = json!({ "captureInputs": { "someRetiredKnob": 7 } });
    let err = backend::osm_host::check_capture_inputs(&meta)
        .expect_err("a stamp naming a constant this build does not have must REFUSE");
    assert!(err.contains("someRetiredKnob"), "got: {err}");
}
