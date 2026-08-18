//! What is left in Rust after the cursor arithmetic moved to Lean (#982).
//!
//! `prevDayBounded` and `prevWindowBounded` are now `Verified/Sync.lean`'s, and
//! their cases live in that file's `#guard`s and in `tests/lean_ffi.rs` — where
//! they exercise the path the backend actually takes. Duplicating them here
//! would be a second copy of a rule with nothing keeping the copies equal,
//! which is the defect this repository keeps being bitten by.

use backend::backfill::{DayResult, StreakFold, fold_empty_streak};

#[test]
fn only_a_genuinely_empty_day_advances_the_streak() {
    assert_eq!(
        fold_empty_streak(&DayResult::Ok { points: 0 }),
        StreakFold::Advance
    );
    assert_eq!(
        fold_empty_streak(&DayResult::Ok { points: 1 }),
        StreakFold::Reset
    );
    // ⚠ THE ONE THAT TRUNCATED HISTORY. A failure is a retry opportunity, not
    // evidence about what Fitbit holds for that day.
    assert_eq!(fold_empty_streak(&DayResult::Failed), StreakFold::Hold);
}

/// ⚠ The regression this file exists for, stated as the streak itself.
///
/// A boolean cannot say what a failed day does, so a caller holding one has to
/// choose between the two answers it can express — and both are wrong. The
/// first version of the walk chose `reset`, which is the conservative error but
/// still an error: a stream that fails once every `maxEmpty - 1` days can never
/// reach the empty streak, so it walks to the 2010 floor spending API budget on
/// history that is not there.
///
/// `src/sync.ts` gets this right by accident of having three branches
/// (`if advance / else if result.ok / no else`); the port collapsed them.
#[test]
fn a_failed_day_neither_advances_nor_clears_the_streak() {
    let mut streak = 13i64;
    for r in [DayResult::Failed, DayResult::Failed] {
        streak = fold_empty_streak(&r).apply(streak);
    }
    assert_eq!(streak, 13, "a failed day says nothing about history");

    streak = fold_empty_streak(&DayResult::Ok { points: 0 }).apply(streak);
    assert_eq!(streak, 14, "the empty day after it still counts");

    streak = fold_empty_streak(&DayResult::Ok { points: 7 }).apply(streak);
    assert_eq!(streak, 0, "and real data still clears it");
}
