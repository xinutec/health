//! The backend reaches the Lean mode table over the worker's pipe and gets the
//! reply body byte for byte: the expected strings are `verified_cli serve`'s
//! output on these requests, minus the `{"id", "result"}` envelope the worker
//! strips textually.

use backend::lean;

#[test]
fn the_mode_table_answers_over_the_pipe() {
    lean::init().expect("the Lean runtime must start");

    // A real answer, not an error: focus on empty input is a well-defined
    // clustering of nothing, so this exercises the handler rather than its
    // parse guard.
    let focus = lean::serve(
        r#"{"id":1,"mode":"focus","sleepWindows":[],"points":[],"clusters":[],"old":[]}"#,
    )
    .expect("focus must answer");
    assert_eq!(
        focus,
        r#"{"identity":{"assignments":[],"deleted":[]},"mined":[],"names":[],"split":[],"stays":[]}"#,
        "the body `verified_cli serve` returns for this request, without its envelope"
    );

    // Each reaches a different handler and fails in its own words; one shared
    // error would mean dispatch never got there.
    for (mode, want) in [
        ("kalman", "property not found: pts"),
        ("gpsquality", "property not found: pts"),
        ("biolabels", "property not found: pass"),
        ("stationchain", "property not found: edges"),
        ("day", "property not found: env"),
        ("head", "property not found: op"),
    ] {
        let got = lean::serve(&format!(r#"{{"id":1,"mode":"{mode}"}}"#))
            .unwrap_or_else(|e| panic!("{mode} must answer: {e}"));
        assert!(
            got.contains(want),
            "{mode}: expected its own parse error {want:?}, got {got}"
        );
    }

    // The battery chart, computed beside the day fold, so it must be callable.
    // The tail case: last in-day reading (200, 60), tail (300, 40), day end 250,
    // so the boundary level is 60 + (40-60) * 0.5 = 50.
    let battery = lean::serve(
        r#"{"mode":"battery","points":[[100,80],[200,60]],"tail":[300,40],"dayEndTs":250}"#,
    )
    .expect("battery must answer");
    assert_eq!(battery, r#"{"series":[[100,80],[200,60],[250,50]]}"#);

    // A tail that does not postdate the last in-day sample is a no-op, not an
    // extrapolation backwards.
    let stale = lean::serve(
        r#"{"mode":"battery","points":[[100,80],[200,60]],"tail":[150,40],"dayEndTs":250}"#,
    )
    .expect("battery must answer");
    assert_eq!(stale, r#"{"series":[[100,80],[200,60]]}"#);

    // The walk referee is wired: an empty corpus tells "reached the handler"
    // from a missing arm's `unknown mode walkgate`.
    let walkgate = lean::serve(r#"{"mode":"walkgate"}"#).expect("walkgate must answer");
    assert_eq!(
        walkgate,
        r#"{"added":[],"current":[],"improved":[],"passes":true,"regressed":[],"unmatched":[],"unmeasured":[]}"#,
        "the body `verified_cli serve` returns for an empty corpus, without its envelope"
    );

    // The dispatch still refuses what it does not know, rather than falling
    // through to something.
    let unknown = lean::serve(r#"{"id":1,"mode":"nope"}"#).expect("must answer");
    assert!(unknown.contains("unknown mode nope"), "got {unknown}");
}
