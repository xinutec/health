//! The Lean decisions, called through the C ABI.
//!
//! The point of asking Lean at all is that the rules the backend runs ARE the
//! ones in Lean, and a pipe that carries the question wrongly
//! would look exactly like one that works.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY. `health_backend_init` starts a
//! process-global runtime, and Rust runs a test binary's tests on many threads.
//! Cargo gives this file its own binary but does not serialise the tests inside
//! it, so several `#[test]`s racing on initialisation would flake in a way that
//! reads as a Lean bug. Sections in order, each asserting with a message naming
//! the case.
//!
//! The expected values are the ones in the Lean modules' `#guard`s and in
//! the Rust tests these replaced — so this failing means the FFI, not the rule.

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
    // ⚠ Where this is STRICTER than the TypeScript it replaced. `new Date`
    // rolled "2026-02-30" forward to March and turned "nonsense" into `NaN`,
    // which reached the query string as the literal text `NaN`.
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
