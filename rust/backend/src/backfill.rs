//! Backfill primitives for the per-day and per-window sync streams.
//!
//! ⚠ THE CURSOR ARITHMETIC IS NOT HERE ANY MORE. `prevDayBounded` and
//! `prevWindowBounded` live in `Verified/Sync.lean` and are reached through
//! [`crate::lean`]. What remains is the day-result shape and the one projection
//! of it that is not a decision.
//!
//! Moving them was the point of linking Lean at all. The guard exists because a
//! skip condition that always fired walked a cursor indefinitely backward,
//! crossed year 0, and wrote `-000026-02` into `sync_state`. In Rust that was
//! defended against — a width check and a floor comparison bolted onto
//! arithmetic that could still produce the bad state. In Lean it cannot be
//! produced: `Verified.Civil.parseDate` yields three integers or nothing, so
//! there is no path from a malformed string to a malformed successor.
//!
//! # Three outcomes, and the middle one is the subtle one
//!
//! A day's fetch either has data, genuinely has none, or FAILED. Only the
//! second advances the empty-day streak that eventually marks a stream
//! complete. Conflating the third with the second used to silently truncate
//! history after 14 consecutive transient failures — a stream declared itself
//! finished because Fitbit had been returning 5xx, and nothing said so.

/// The outcome of one day's fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DayResult {
    /// The call succeeded. `points == 0` means the day is genuinely empty.
    Ok { points: u64 },
    /// The call failed. NOT evidence that the day is empty.
    Failed,
}

/// How one day's outcome folds into the consecutive-empty-day streak.
///
/// ⚠ THREE ANSWERS, AND THE TYPE HAS TO SAY SO. This was a `bool` and the two
/// call sites wrote `if advance { n += 1 } else { n = 0 }` — which is the only
/// thing a caller holding a boolean can write, and it is wrong: it clears the
/// streak on a day that FAILED. A failure is not evidence that history has run
/// out, and it is equally not evidence that it has not.
///
/// The conservative error is still an error. A stream that fails once every
/// `maxEmpty - 1` days can then never reach the empty streak at all, so instead
/// of stopping where its history stops it walks to the 2010 floor, spending
/// shared API budget on days Fitbit holds nothing for.
///
/// `src/sync.ts` gets this right, but by the shape of its branches rather than
/// by saying so — `if (advance) ++; else if (result.ok) = 0;` with no final
/// `else`. Naming the third case is what stops the next port dropping it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreakFold {
    /// A genuinely empty day: one step closer to "this stream has no more".
    Advance,
    /// Real data: history plainly has not run out.
    Reset,
    /// The call failed. Says nothing either way, so the streak does not move.
    Hold,
}

impl StreakFold {
    /// Apply this outcome to a running streak.
    pub fn apply(self, streak: i64) -> i64 {
        match self {
            StreakFold::Advance => streak + 1,
            StreakFold::Reset => 0,
            StreakFold::Hold => streak,
        }
    }
}

/// Fold one day's outcome into the streak.
///
/// Kept in Rust rather than moved to Lean, and the line has to be drawn
/// somewhere: this is a projection of a type declared here, not a rule about
/// dates or budgets. A JSON round trip to ask which constructor a value has
/// would cost more than it proves.
pub fn fold_empty_streak(result: &DayResult) -> StreakFold {
    match result {
        DayResult::Ok { points: 0 } => StreakFold::Advance,
        DayResult::Ok { .. } => StreakFold::Reset,
        DayResult::Failed => StreakFold::Hold,
    }
}
