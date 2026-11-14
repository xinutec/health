//! The Lean decisions, called through the worker: a pipe carrying the question
//! wrongly would look like one that works. Expected values are the Lean
//! modules' `#guard`s', so a failure here is the wire, not the rule.
//!
//! One `#[test]` in ordered sections: `lean::init()` starts process-global
//! state that parallel tests would race on.

use backend::lean;

#[test]
fn the_lean_decisions_answer_through_the_ffi() {
    lean::init().expect("the Lean runtime must start");

    // ---- a date as an instant ----------------------------------------------
    // The PhoneTrack query bounds. UTC midnight, matching what
    // `new Date("YYYY-MM-DD").getTime()` computed.
    assert_eq!(lean::midnight_utc("1970-01-01").unwrap(), 0, "the epoch");
    assert_eq!(
        lean::midnight_utc("2026-08-18").unwrap() - lean::midnight_utc("2026-08-17").unwrap(),
        86_400,
        "consecutive midnights are a day apart"
    );
    assert!(
        lean::midnight_utc("1969-12-31").unwrap() < 0,
        "pre-epoch dates are negative, not unsigned garbage"
    );
    // Stricter than JavaScript's `new Date`, which rolls 30 February forward
    // to March and turns "nonsense" into `NaN`, reaching a query string as the
    // literal text `NaN`.
    for bad in ["2026-02-30", "nonsense", "", "2026-8-17"] {
        assert!(
            lean::midnight_utc(bad).is_err(),
            "midnightUtc({bad:?}) must refuse"
        );
    }

    // ---- a bad request is an error, not a wrong answer ----------------------
    // The dispatch reports `{"error": …}` for anything it cannot serve, and the
    // Rust side must surface that rather than decode it as a verdict.
    assert!(
        lean::midnight_utc("2026-08-17").is_ok(),
        "a well-formed request stays ok"
    );
}
