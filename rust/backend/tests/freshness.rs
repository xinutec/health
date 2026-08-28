//! The freshness check must FAIL, not only pass (#1231).
//!
//! ⚠ Every stream in prod was fresh when this was written, so the passing path
//! is the only one a live run can exercise. A check nobody has seen fail is
//! exactly the thing #1231 is about.

use backend::freshness::{FRESHNESS, stale_reason};

#[test]
fn a_stream_within_its_bound_is_fine() {
    assert!(stale_reason("daily_activity", Some(0)).is_none());
    assert!(stale_reason("daily_activity", Some(3)).is_none());
    assert!(stale_reason("body", Some(10)).is_none());
}

/// ⚠ The bound is a MAXIMUM, so one day past it must fire. An off-by-one here
/// would let a stream sit a day stale forever without a word.
#[test]
fn one_day_past_the_bound_fires() {
    let why = stale_reason("daily_activity", Some(4)).expect("4 > 3 must be stale");
    assert!(why.contains("daily_activity"), "{why}");
    assert!(why.contains("4 days behind"), "{why}");
}

/// ⚠ AN EMPTY TABLE IS MAXIMALLY STALE, NOT SKIPPABLE. `MAX()` over no rows is
/// NULL; treating that as "no data to judge" would let a stream that never
/// arrived at all pass.
#[test]
fn an_empty_table_is_stale_not_skipped() {
    let why = stale_reason("sleep", None).expect("an empty table must be stale");
    assert!(why.contains("EMPTY"), "{why}");
}

/// ⚠ A table with no bound is UNWATCHED, which is a failure and not a pass —
/// otherwise adding a stream to the query and forgetting the bound produces a
/// green check over a stream nobody is looking at.
#[test]
fn a_table_without_a_bound_is_a_failure() {
    let why = stale_reason("a_table_nobody_budgeted", Some(0)).expect("unbudgeted must fail");
    assert!(why.contains("no freshness bound"), "{why}");
}

/// ⚠ `body` needs its OWN bound: it was 10 days behind and healthy when
/// measured, so the daily bound of 3 would have it screaming permanently. An
/// alarm that cries wolf gets muted, which is worse than no alarm.
#[test]
fn body_is_not_held_to_the_daily_bound() {
    assert!(stale_reason("body", Some(10)).is_none());
    assert!(stale_reason("breathing_rate", Some(10)).is_some());
}

/// Every bound records the observation it came from, so a chosen bound can be
/// told apart from an invented one.
#[test]
fn every_bound_records_why() {
    for f in FRESHNESS {
        assert!(f.why.len() > 20, "{} has no reason recorded", f.table);
        assert!(f.max_lag_days > 0, "{} has a nonsense bound", f.table);
    }
}
