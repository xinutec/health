//! The Lean decisions, called through the C ABI (#982).
//!
//! The point of asking Lean at all is that the rules the backend runs ARE the
//! ones in `Verified/Sync.lean`, and a pipe that carries the question wrongly
//! would look exactly like one that works.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY. `health_backend_init` starts a
//! process-global runtime, and Rust runs a test binary's tests on many threads.
//! Cargo gives this file its own binary but does not serialise the tests inside
//! it, so several `#[test]`s racing on initialisation would flake in a way that
//! reads as a Lean bug. Sections in order, each asserting with a message naming
//! the case.
//!
//! The expected values are the ones in `Verified/Sync.lean`'s `#guard`s and in
//! the Rust tests these replaced — so this failing means the FFI, not the rule.

use backend::lean;

#[test]
fn the_lean_decisions_answer_through_the_ffi() {
    lean::init().expect("the Lean runtime must start");

    // ---- the PhoneTrack chunk walk -----------------------------------------
    let chunks = |v: &[(&str, &str)]| -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    };
    assert_eq!(
        lean::chunk_range("2026-08-01", "2026-08-17", 7, 60).unwrap(),
        chunks(&[
            ("2026-08-01", "2026-08-08"),
            ("2026-08-08", "2026-08-15"),
            ("2026-08-15", "2026-08-17"),
        ]),
        "the last chunk is clamped to the end rather than overshooting it"
    );
    // ⚠ Adjacent chunks SHARE an endpoint, so a boundary day is fetched twice.
    // Asserted rather than merely documented: closing the interval would look
    // like a tidy-up and would silently change which fixes exist.
    let cs = lean::chunk_range("2026-08-01", "2026-08-17", 7, 60).unwrap();
    for pair in cs.windows(2) {
        assert_eq!(
            pair[0].1, pair[1].0,
            "chunk {:?} must end where {:?} begins",
            pair[0], pair[1]
        );
    }
    assert_eq!(
        lean::chunk_range("2026-08-01", "2026-08-15", 7, 60).unwrap(),
        chunks(&[
            ("2026-08-01", "2026-08-08"),
            ("2026-08-08", "2026-08-15"),
            ("2026-08-15", "2026-08-15"),
        ]),
        "an exact multiple ends with a degenerate chunk — one wasted request, \
         kept because the TypeScript's loop guard does the same"
    );
    assert_eq!(
        lean::chunk_range("2026-08-17", "2026-08-17", 7, 60).unwrap(),
        chunks(&[("2026-08-17", "2026-08-17")]),
        "one day in, one chunk out"
    );
    assert!(
        lean::chunk_range("2026-08-17", "2026-08-01", 7, 60)
            .unwrap()
            .is_empty(),
        "backwards asks for nothing"
    );
    assert_eq!(
        lean::chunk_range(
            "2026-07-18",
            "2026-08-17",
            lean::TRACK_CHUNK_DAYS,
            lean::MAX_TRACK_CHUNKS
        )
        .unwrap()
        .len(),
        5,
        "the 30-day default forward window fits well inside the bound"
    );
    for (start, end, days, max) in [
        // Over the chunk bound: refuses rather than fetching a prefix, because a
        // prefix would stamp every row past it with a confident wrong zone.
        ("2026-08-01", "2026-08-15", 7, 2),
        ("2026-08-01", "2026-08-08", 7, 1),
        ("2026-08-01", "2026-08-15", 7, 0),
        // A non-positive step would ask for the same chunk forever.
        ("2026-08-01", "2026-08-15", 0, 60),
        ("2026-08-01", "2026-08-15", -7, 60),
        ("garbage", "2026-08-17", 7, 60),
        ("2026-02-30", "2026-08-17", 7, 60),
    ] {
        assert!(
            lean::chunk_range(start, end, days, max).is_err(),
            "chunkRange({start:?}, {end:?}, {days}, {max}) must refuse"
        );
    }

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
