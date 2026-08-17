//! The Lean decisions, called through the C ABI (#982).
//!
//! This is the equivalence `rust/day-shell`'s check makes for the day fold,
//! at this crate's scale: the point of linking Lean is that the rules the
//! backend runs ARE the ones in `Verified/Sync.lean`, and an FFI that builds
//! but answers wrongly would look exactly like one that works.
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

    // ---- the rate-limit decision -------------------------------------------
    use lean::RateLimitAction as A;
    assert_eq!(
        lean::decide_rate_limit_wait(150, 3_600_000, 60_000).unwrap(),
        A::Proceed,
        "budget above the floor proceeds however far away the reset is"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(5, 30_000, 60_000).unwrap(),
        A::Sleep { ms: 30_000 },
        "the floor itself is not above the floor: `>` not `>=`"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(0, 0, 60_000).unwrap(),
        A::Proceed,
        "an already-reset window proceeds on a spent budget"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(0, 60_000, 60_000).unwrap(),
        A::Sleep { ms: 60_000 },
        "exactly at the cap is still a sleep"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(0, 60_001, 60_000).unwrap(),
        A::Exhausted { resume_in_sec: 61 },
        "one millisecond past the cap bails out, rounding the resume time UP"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(0, 3_600_000, 60_000).unwrap(),
        A::Exhausted {
            resume_in_sec: 3600
        },
        "a full hour"
    );
    assert_eq!(
        lean::decide_rate_limit_wait(0, 5_000, 1_000).unwrap(),
        A::Exhausted { resume_in_sec: 5 },
        "the cap is honoured as PASSED, not read from a constant"
    );

    // ---- the backfill cursor -----------------------------------------------
    const FLOOR: &str = "2010-01-01";
    for (date, want) in [
        ("2026-08-17", Some("2026-08-16")),
        ("2026-03-01", Some("2026-02-28")),
        ("2024-03-01", Some("2024-02-29")), // leap year
        ("2027-01-01", Some("2026-12-31")),
        // The floor is EXCLUSIVE.
        ("2010-01-02", None),
        ("2010-01-01", None),
        ("2009-06-01", None),
        // ⚠ The runaway cursor: a malformed value already in sync_state must
        // stop the walk rather than be compounded.
        ("-000026-02", None),
        ("not-a-date", None),
        ("2026-2-3", None),
        ("2026-02-30", None),
        ("", None),
    ] {
        assert_eq!(
            lean::prev_day_bounded(date, FLOOR).unwrap().as_deref(),
            want,
            "prevDayBounded({date:?})"
        );
    }

    // ---- the backfill window -----------------------------------------------
    assert_eq!(
        lean::prev_window_bounded("2026-08-17", 7, FLOOR).unwrap(),
        Some(("2026-08-11".to_string(), "2026-08-17".to_string())),
        "inclusive of both ends"
    );
    assert_eq!(
        lean::prev_window_bounded("2026-08-17", 1, FLOOR).unwrap(),
        Some(("2026-08-17".to_string(), "2026-08-17".to_string()))
    );
    assert_eq!(
        lean::prev_window_bounded("2010-01-05", 30, FLOOR).unwrap(),
        Some((FLOOR.to_string(), "2010-01-05".to_string())),
        "a window may straddle the floor but its start is clamped up"
    );
    for (end, days) in [
        ("2026-08-17", 0),
        ("2026-08-17", -5),
        ("2010-01-01", 7),
        ("2009-12-31", 7),
        ("garbage", 7),
    ] {
        assert_eq!(
            lean::prev_window_bounded(end, days, FLOOR).unwrap(),
            None,
            "prevWindowBounded({end:?}, {days})"
        );
    }

    // ---- the forward day walk ----------------------------------------------
    assert_eq!(
        lean::date_range_inclusive("2026-08-15", "2026-08-17", 400).unwrap(),
        ["2026-08-15", "2026-08-16", "2026-08-17"],
        "inclusive of both ends"
    );
    assert_eq!(
        lean::date_range_inclusive("2026-08-17", "2026-08-17", 400).unwrap(),
        ["2026-08-17"],
        "a single day is a one-element walk, not an empty one"
    );
    assert_eq!(
        lean::date_range_inclusive("2024-02-28", "2024-03-01", 400).unwrap(),
        ["2024-02-28", "2024-02-29", "2024-03-01"],
        "the leap day comes from Civil, not from a day counter here"
    );
    assert!(
        lean::date_range_inclusive("2026-08-17", "2026-08-15", 400)
            .unwrap()
            .is_empty(),
        "backwards is empty — what a caught-up cursor asks for"
    );
    assert_eq!(
        lean::date_range_inclusive("2026-08-01", "2026-08-03", 3)
            .unwrap()
            .len(),
        3,
        "exactly at the bound passes"
    );
    // ⚠ REFUSES RATHER THAN TRUNCATING. A shortened list would be a sync that
    // quietly did less than it reported.
    for (start, end, max) in [
        ("2026-08-01", "2026-08-04", 3),
        ("2026-08-01", "2026-08-01", 0),
        // The TypeScript's silent-zero-days case: `new Date("garbage")` compares
        // false against everything, so its loop body never runs and the caller
        // is told the sync succeeded.
        ("garbage", "2026-08-17", 400),
        ("2026-08-15", "", 400),
        ("2026-8-15", "2026-08-17", 400),
        ("2026-02-30", "2026-03-05", 400),
    ] {
        assert!(
            lean::date_range_inclusive(start, end, max).is_err(),
            "dateRangeInclusive({start:?}, {end:?}, {max}) must refuse"
        );
    }

    // ---- the backfill walk --------------------------------------------------
    use lean::BackfillStep as S;
    use lean::CompleteReason as R;
    let fetch = |d: &str| S::Fetch {
        date: d.to_string(),
    };
    let done = |r| S::Complete { reason: r };

    assert_eq!(
        lean::decide_backfill_step(150, 0, 14, "2026-08-17", FLOOR).unwrap(),
        fetch("2026-08-16"),
        "the ordinary step is the day before the cursor"
    );
    // The budget boundary is `<=`.
    assert_eq!(
        lean::decide_backfill_step(15, 0, 14, "2026-08-17", FLOOR).unwrap(),
        S::Pause
    );
    assert_eq!(
        lean::decide_backfill_step(16, 0, 14, "2026-08-17", FLOOR).unwrap(),
        fetch("2026-08-16")
    );
    // The streak boundary is `>=`.
    assert_eq!(
        lean::decide_backfill_step(150, 14, 14, "2026-08-17", FLOOR).unwrap(),
        done(R::EmptyStreak)
    );
    // ⚠ THE ONE THAT MATTERS. `complete` is durable — it stops the stream being
    // walked again — so a spent budget must never reach it. With the streak
    // unmet, an exhausted run can only pause.
    assert_eq!(
        lean::decide_backfill_step(0, 13, 14, "2026-08-17", FLOOR).unwrap(),
        S::Pause,
        "a rate-limited run must not conclude a stream is complete"
    );
    // The floor is a statement about the data, so it wins over both.
    assert_eq!(
        lean::decide_backfill_step(0, 20, 14, "2010-01-02", FLOOR).unwrap(),
        done(R::ReachedFloor)
    );
    // ⚠ The runaway cursor, reported as its own reason rather than as the floor.
    for bad in ["-000026-02", "not-a-date", "2026-2-3", "2026-02-30", ""] {
        assert_eq!(
            lean::decide_backfill_step(150, 0, 14, bad, FLOOR).unwrap(),
            done(R::CursorUnusable),
            "cursor {bad:?}"
        );
    }

    // ---- the range walk -----------------------------------------------------
    use lean::RangeBackfillStep as RS;
    assert_eq!(
        lean::decide_range_backfill_step(150, 0, 3, 30, "2026-08-17", FLOOR).unwrap(),
        RS::Fetch {
            start: "2026-07-18".to_string(),
            end: "2026-08-16".to_string(),
        },
        "the window ends the day BEFORE the cursor and spans 30 inclusive days"
    );
    assert_eq!(
        lean::decide_range_backfill_step(150, 0, 3, 30, "2010-01-20", FLOOR).unwrap(),
        RS::Fetch {
            start: FLOOR.to_string(),
            end: "2010-01-19".to_string(),
        },
        "a window may straddle the floor but its start clamps up"
    );
    assert_eq!(
        lean::decide_range_backfill_step(0, 2, 3, 30, "2026-08-17", FLOOR).unwrap(),
        RS::Pause,
        "same rule as the day walk: a spent budget pauses, it does not complete"
    );
    assert_eq!(
        lean::decide_range_backfill_step(0, 3, 3, 30, "2026-08-17", FLOOR).unwrap(),
        RS::Complete {
            reason: R::EmptyStreak
        }
    );

    // ---- stream priority ----------------------------------------------------
    let order = |v: Vec<(&str, Option<&str>)>| {
        let pairs: Vec<(String, Option<String>)> = v
            .into_iter()
            .map(|(n, c)| (n.to_string(), c.map(str::to_string)))
            .collect();
        lean::order_by_cursor_recency(&pairs, "2026-08-17").unwrap()
    };
    assert_eq!(
        order(vec![
            ("hr", Some("2024-03-01")),
            ("steps", Some("2026-08-01")),
            ("hrv", Some("2025-01-01")),
        ]),
        ["steps", "hrv", "hr"],
        "most recent cursor first"
    );
    assert_eq!(
        order(vec![("hr", Some("2024-03-01")), ("steps", None)]),
        ["steps", "hr"],
        "an unstarted stream takes the fallback and is not starved by a deep backfill"
    );
    // Stable, both ways round — so priority between equals is the caller's list
    // order rather than a property of the sort.
    assert_eq!(
        order(vec![("a", Some("2026-01-01")), ("b", Some("2026-01-01"))]),
        ["a", "b"]
    );
    assert_eq!(
        order(vec![("b", Some("2026-01-01")), ("a", Some("2026-01-01"))]),
        ["b", "a"]
    );
    assert!(order(vec![]).is_empty());

    // ---- a bad request is an error, not a wrong answer ----------------------
    // The dispatch reports `{"error": …}` for anything it cannot serve, and the
    // Rust side must surface that rather than decode it as a verdict.
    assert!(
        lean::decide_rate_limit_wait(0, 0, 0).is_ok(),
        "a well-formed request stays ok"
    );
}
