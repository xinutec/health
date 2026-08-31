//! The backend calls the Lean algorithm mode table in-process (#982).
//!
//! ⚠ ONE `#[test]`, for the reason `tests/lean_ffi.rs` gives: `lean::init()`
//! starts a runtime, and several tests racing on it would flake.
//!
//! # What this is evidence FOR
//!
//! That `ServeEntry` — every handler that used to sit beside `main` and so
//! could not be linked — answers the same question here that it answers as a
//! subprocess. The expected strings below were produced by
//!
//!     lean/.lake/build/bin/verified_cli serve
//!
//! on exactly these requests, which makes `verified_cli` the oracle for this
//! path rather than my expectation of it — MINUS the `{"id", "result"}`
//! envelope, which `serveLoop` adds and `dispatch` does not. That envelope
//! correlates replies on one NDJSON pipe; a host that called the function has
//! nothing to correlate. The BODY is the answer and it is what must match.

use backend::lean;

#[test]
fn the_mode_table_answers_in_process() {
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

    // ⚠ Each of these reaches a DIFFERENT handler, and each fails in that
    // handler's own words. A single shared error would mean the dispatch never
    // got there — which is exactly what a broken link looks like from here.
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

    // ⚠ The battery chart, which the velocity pipeline computes BESIDE the day
    // fold rather than inside it — so a host porting that pipeline needs it
    // callable. It was ported to Lean and `#guard`ed, then reachable from no
    // entry point at all (#1003's shape) until this mode existed.
    //
    // The tail case is the one worth pinning: the last in-day reading is
    // (200, 60), the tail is (300, 40) and the day ends at 250, so the level
    // where that line crosses the boundary is 60 + (40-60) * 0.5 = 50.
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

    // ⚠ The walk referee (#1048 Group B) is WIRED. Its arithmetic is witnessed
    // in `Verified.Eval.WalkMetrics` against doubles the deleted TypeScript
    // printed; what those witnesses cannot see is whether `dispatch` still
    // routes to it. An empty corpus is the cheapest question that distinguishes
    // "reached the handler" from "fell through" — a missing arm answers
    // `unknown mode walkgate` here, which is exactly how the OTHER gates were
    // found to be dead only after three days (#975).
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
