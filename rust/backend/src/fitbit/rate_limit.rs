//! Fitbit rate-limit policy for the sync process.
//!
//! Port of `src/fitbit/rate-limit.ts`, semantics unchanged.
//!
//! The sync runs as an every-15-minutes CronJob with `concurrencyPolicy:
//! Forbid` and a hard `activeDeadlineSeconds` of ~55 min. Fitbit's budget
//! (~150 calls/hour) replenishes all at once at the top of each hour — there is
//! no gradual refill to wait out. So when the budget is spent the right move is
//! NOT to block until the reset (that overruns the job deadline and the job is
//! killed, surfacing as a spurious `Failed`), but to stop cleanly and let the
//! next tick resume from each stream's stored cursor.
//!
//! ⚠ LEAN CANDIDATE, NOT YET MOVED. `decideRateLimitWait` is pure — its
//! TypeScript doc says outright that it was split out so it could be tested
//! without a live client — and by the standing rule it belongs in Lean. It is
//! here because `backend` does not link the Lean runtime yet; `day-shell` does,
//! through `build.rs` and the C ABI, and doing the same for this crate is a
//! deliberate piece of work rather than something to bolt on mid-port. When
//! that lands this function is the first thing to move, and the table of cases
//! below is already the guard list.

/// Longest the client will block in-process for the budget to reset.
/// Comfortably under the job's `activeDeadlineSeconds`.
pub const MAX_INPROCESS_WAIT_MS: i64 = 60_000;

/// Below this remaining count the client stops issuing calls. The stream-level
/// backfill loops gate higher (`> 15`) so they exit before reaching it.
pub const RATE_LIMIT_FLOOR: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitAction {
    Proceed,
    Sleep { ms: i64 },
    Exhausted { resume_in_sec: i64 },
}

/// What a depleted-or-not client should do before its next call.
///
///   * budget above the floor, or the window already reset → proceed
///   * budget spent, reset within the in-process cap → sleep it out
///   * budget spent, reset beyond the cap → exhausted (bail; resume next tick)
pub fn decide_rate_limit_wait(
    remaining: i64,
    ms_until_reset: i64,
    max_wait_ms: i64,
) -> RateLimitAction {
    if remaining > RATE_LIMIT_FLOOR || ms_until_reset <= 0 {
        return RateLimitAction::Proceed;
    }
    if ms_until_reset > max_wait_ms {
        // Ceiling, matching the TypeScript's `Math.ceil(ms / 1000)`. Rounding
        // down would report a resume time before the budget actually returns,
        // and the caller uses it to decide when to come back.
        //
        // Written out rather than `div_ceil`, which is stable for unsigned
        // integers only. `ms_until_reset` is positive on this branch — it is
        // greater than `max_wait_ms` — so the `+ 999` form is exact here.
        return RateLimitAction::Exhausted {
            resume_in_sec: (ms_until_reset + 999) / 1000,
        };
    }
    RateLimitAction::Sleep { ms: ms_until_reset }
}

/// The budget is spent and the reset is further out than this process should
/// block for. Callers treat it as "stop now, the next cron run resumes" — NEVER
/// as a failure of the specific day or stream being fetched, so no cursor is
/// advanced past data that was never retrieved.
#[derive(Debug, thiserror::Error)]
#[error("Fitbit rate budget exhausted; resets in {resume_in_sec}s")]
pub struct RateLimitExhausted {
    pub resume_in_sec: i64,
}
