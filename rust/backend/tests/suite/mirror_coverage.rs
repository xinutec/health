//! A route mirror whose area is mostly stale must FAIL its run, on both arms.
//!
//! ⚠ THIS DRIVES THE REAL PATH. The rule is Lean's, and these go through the
//! same `lean::mirror_staleness` FFI call the CronJob makes — not a
//! re-implementation of the arithmetic here, which would test its own copy.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY, for the reason `lean_ffi.rs` gives:
//! `health_backend_init` starts a process-global runtime and cargo does not
//! serialise the tests inside one binary, so several racing on initialisation
//! flake in a way that reads as a Lean bug.

use backend::lean;

#[test]
fn a_mostly_stale_area_fails_the_run() {
    lean::init().expect("the Lean runtime must start");

    // ---- most of the area unanswered for two weeks -------------------------
    let why = lean::mirror_staleness(994, 34, 36, 14)
        .expect("the rule answers")
        .expect("2 of 36 fresh is a stale cache");
    assert!(why.contains("2/36"), "{why}");
    assert!(why.contains("14 days"), "{why}");
    assert!(why.contains("stale"), "{why}");

    // ---- ordinary flakiness stays green ------------------------------------
    // A few tiles refused on a few nights: they are due again the next night,
    // and the alarm must not cry wolf and get muted.
    assert_eq!(
        lean::mirror_staleness(531, 4, 36, 14).expect("answers"),
        None
    );
    assert_eq!(
        lean::mirror_staleness(531, 0, 36, 14).expect("answers"),
        None
    );

    // ---- ⚠ AN EMPTY CACHE BOOTSTRAPS ---------------------------------------
    // With nothing in it there is nothing old to be mistaken for current.
    assert_eq!(
        lean::mirror_staleness(0, 35, 36, 14).expect("answers"),
        None
    );

    // ---- ⚠ THE BOUNDARY, both sides ----------------------------------------
    // A check only at 2/36 passes with the comparison written either way round.
    assert_eq!(
        lean::mirror_staleness(531, 18, 36, 14).expect("answers"),
        None,
        "18 of 36 fresh is exactly the floor and passes"
    );
    assert!(
        lean::mirror_staleness(531, 19, 36, 14)
            .expect("answers")
            .is_some(),
        "17 of 36 fresh is under the floor"
    );
}
