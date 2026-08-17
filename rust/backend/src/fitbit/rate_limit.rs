//! Fitbit rate-limit policy — constants and the exhausted signal.
//!
//! ⚠ THE DECISION ITSELF IS NOT HERE ANY MORE. It lives in
//! `Verified/Sync.lean`'s `decideRateLimitWait` and is reached through
//! [`crate::lean`]. This module holds what is left: two numbers the deployment
//! shape justifies, and the error that carries the verdict outward.
//!
//! It was in Rust for one commit, with a note saying it belonged in Lean. That
//! note is the thing this codebase already has 25 of — Lean written ahead of
//! its caller and left unreachable (#1003) — so it was moved rather than
//! accumulated.
//!
//! # Why the policy is "stop cleanly" and not "wait it out"
//!
//! The sync runs as an every-15-minutes CronJob with `concurrencyPolicy:
//! Forbid` and a hard `activeDeadlineSeconds` of ~55 min. Fitbit's budget
//! (~150 calls/hour) replenishes all at once at the top of the hour — there is
//! no gradual refill to wait for. Blocking until the reset overruns the job
//! deadline and the job is killed, which surfaces as a spurious `Failed` and
//! reads as a broken sync rather than a spent budget.

/// Longest the client will block in-process for the budget to reset.
/// Comfortably under the job's `activeDeadlineSeconds`.
pub const MAX_INPROCESS_WAIT_MS: i64 = 60_000;

/// The budget is spent and the reset is further out than this process should
/// block for. Callers treat it as "stop now, the next scheduled run resumes" —
/// NEVER as a failure of the specific day or stream being fetched, so no cursor
/// is advanced past data that was never retrieved.
#[derive(Debug, thiserror::Error)]
#[error("Fitbit rate budget exhausted; resets in {resume_in_sec}s")]
pub struct RateLimitExhausted {
    pub resume_in_sec: i64,
}
