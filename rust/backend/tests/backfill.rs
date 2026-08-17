//! The backfill guards, at the edges that produced real bugs (#982).
//!
//! Two of these functions exist because of specific failures, and the tests
//! name them rather than testing the happy path around them:
//!
//!   * a skip condition that always fired walked the cursor indefinitely
//!     backward, crossed year 0, and wrote `-000026-02` into `sync_state`;
//!   * conflating "the call failed" with "the day is empty" truncated history
//!     after 14 consecutive transient failures, and the stream marked itself
//!     complete.

use backend::backfill::{
    DayResult, prev_day_bounded, prev_window_bounded, should_advance_empty_streak,
};

const FLOOR: &str = "2010-01-01";

#[test]
fn only_a_genuinely_empty_day_advances_the_streak() {
    assert!(should_advance_empty_streak(&DayResult::Ok { points: 0 }));
    assert!(!should_advance_empty_streak(&DayResult::Ok { points: 1 }));
    // ⚠ THE ONE THAT TRUNCATED HISTORY. A failure is a retry opportunity, not
    // evidence about what Fitbit holds for that day.
    assert!(!should_advance_empty_streak(&DayResult::Failed));
}

#[test]
fn prev_day_steps_back_one_day() {
    assert_eq!(
        prev_day_bounded("2026-08-17", FLOOR).as_deref(),
        Some("2026-08-16")
    );
}

#[test]
fn prev_day_crosses_month_and_year_and_leap_boundaries() {
    assert_eq!(
        prev_day_bounded("2026-03-01", FLOOR).as_deref(),
        Some("2026-02-28")
    );
    assert_eq!(
        prev_day_bounded("2024-03-01", FLOOR).as_deref(),
        Some("2024-02-29"),
        "2024 is a leap year"
    );
    assert_eq!(
        prev_day_bounded("2027-01-01", FLOOR).as_deref(),
        Some("2026-12-31")
    );
}

#[test]
fn prev_day_refuses_at_and_below_the_floor() {
    // The floor is EXCLUSIVE: landing exactly on it stops the walk.
    assert_eq!(prev_day_bounded("2010-01-02", FLOOR), None);
    assert_eq!(prev_day_bounded("2010-01-01", FLOOR), None);
    assert_eq!(prev_day_bounded("2009-06-01", FLOOR), None);
}

#[test]
fn prev_day_refuses_what_is_not_a_date() {
    // ⚠ The runaway-cursor bug. Once a malformed string is in sync_state, the
    // walk must refuse it rather than compound it.
    assert_eq!(prev_day_bounded("-000026-02", FLOOR), None);
    assert_eq!(prev_day_bounded("not-a-date", FLOOR), None);
    assert_eq!(
        prev_day_bounded("2026-2-3", FLOOR),
        None,
        "widths are strict"
    );
    assert_eq!(prev_day_bounded("2026-02-30", FLOOR), None, "no such day");
    assert_eq!(prev_day_bounded("", FLOOR), None);
}

#[test]
fn window_walks_back_inclusively() {
    // Inclusive of both ends: a 7-day window ending on the 17th starts on the
    // 11th, not the 10th.
    assert_eq!(
        prev_window_bounded("2026-08-17", 7, FLOOR),
        Some(("2026-08-11".to_string(), "2026-08-17".to_string()))
    );
    assert_eq!(
        prev_window_bounded("2026-08-17", 1, FLOOR),
        Some(("2026-08-17".to_string(), "2026-08-17".to_string()))
    );
}

#[test]
fn window_start_is_clamped_up_to_the_floor() {
    // The window may straddle the floor; it must not reach before it.
    let (start, end) = prev_window_bounded("2010-01-05", 30, FLOOR).expect("straddles the floor");
    assert_eq!(start, FLOOR, "clamped up rather than reaching 2009");
    assert_eq!(end, "2010-01-05");
}

#[test]
fn window_refuses_a_nonsense_size_or_an_exhausted_end() {
    assert_eq!(prev_window_bounded("2026-08-17", 0, FLOOR), None);
    assert_eq!(prev_window_bounded("2026-08-17", -5, FLOOR), None);
    assert_eq!(
        prev_window_bounded("2010-01-01", 7, FLOOR),
        None,
        "at floor"
    );
    assert_eq!(prev_window_bounded("2009-12-31", 7, FLOOR), None);
    assert_eq!(prev_window_bounded("garbage", 7, FLOOR), None);
}
