//! What is left in Rust after the cursor arithmetic moved to Lean (#982).
//!
//! `prevDayBounded` and `prevWindowBounded` are now `Verified/Sync.lean`'s, and
//! their cases live in that file's `#guard`s and in `tests/lean_ffi.rs` — where
//! they exercise the path the backend actually takes. Duplicating them here
//! would be a second copy of a rule with nothing keeping the copies equal,
//! which is the defect this repository keeps being bitten by.

use backend::backfill::{DayResult, should_advance_empty_streak};

#[test]
fn only_a_genuinely_empty_day_advances_the_streak() {
    assert!(should_advance_empty_streak(&DayResult::Ok { points: 0 }));
    assert!(!should_advance_empty_streak(&DayResult::Ok { points: 1 }));
    // ⚠ THE ONE THAT TRUNCATED HISTORY. A failure is a retry opportunity, not
    // evidence about what Fitbit holds for that day.
    assert!(!should_advance_empty_streak(&DayResult::Failed));
}
