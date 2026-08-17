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

/// Whether this outcome advances the consecutive-empty-day streak.
///
/// ⚠ `Failed` must NOT advance it. A transient 5xx, a network blip or an
/// auth-refresh hiccup is a retry opportunity, not a statement about history.
///
/// Kept in Rust rather than moved to Lean, and the line has to be drawn
/// somewhere: this is a projection of a type declared here, not a rule about
/// dates or budgets. A JSON round trip to ask which constructor a value has
/// would cost more than it proves.
pub fn should_advance_empty_streak(result: &DayResult) -> bool {
    matches!(result, DayResult::Ok { points: 0 })
}
