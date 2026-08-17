//! The rate-limit decision, at every boundary (#982).
//!
//! `src/fitbit/rate-limit.ts` says this function was split out so it could be
//! "exhaustively unit-tested without a live client". The TypeScript has those
//! tests; the port must not arrive without them, because the decision is the
//! difference between a clean resume next tick and a CronJob killed at its
//! `activeDeadlineSeconds` — which surfaces as a spurious `Failed` and looks
//! like a broken sync rather than a spent budget.
//!
//! The three outcomes and the exact edges between them are what matter, so each
//! boundary is tested on both sides.

use backend::fitbit::rate_limit::{
    MAX_INPROCESS_WAIT_MS, RATE_LIMIT_FLOOR, RateLimitAction, decide_rate_limit_wait,
};

const CAP: i64 = MAX_INPROCESS_WAIT_MS;

#[test]
fn budget_above_the_floor_always_proceeds() {
    // However far away the reset is, a client with budget left just goes.
    assert_eq!(
        decide_rate_limit_wait(RATE_LIMIT_FLOOR + 1, 3_600_000, CAP),
        RateLimitAction::Proceed
    );
    assert_eq!(
        decide_rate_limit_wait(150, 3_600_000, CAP),
        RateLimitAction::Proceed
    );
}

#[test]
fn the_floor_itself_is_not_above_the_floor() {
    // `remaining > FLOOR`, not `>=`. At exactly the floor the client stops, and
    // getting this edge backwards would spend the last calls the backfill loops
    // are holding in reserve.
    assert_eq!(
        decide_rate_limit_wait(RATE_LIMIT_FLOOR, 30_000, CAP),
        RateLimitAction::Sleep { ms: 30_000 }
    );
}

#[test]
fn an_already_reset_window_proceeds_even_with_no_budget() {
    // A non-positive time-to-reset means the window has already turned over, so
    // the remaining count is stale. Proceed and let the response headers
    // correct it.
    assert_eq!(decide_rate_limit_wait(0, 0, CAP), RateLimitAction::Proceed);
    assert_eq!(
        decide_rate_limit_wait(0, -5_000, CAP),
        RateLimitAction::Proceed
    );
}

#[test]
fn a_short_wait_is_ridden_out_in_process() {
    assert_eq!(
        decide_rate_limit_wait(0, 1, CAP),
        RateLimitAction::Sleep { ms: 1 }
    );
    // Exactly at the cap is still a sleep: the bail-out is `>`, not `>=`.
    assert_eq!(
        decide_rate_limit_wait(0, CAP, CAP),
        RateLimitAction::Sleep { ms: CAP }
    );
}

#[test]
fn one_millisecond_past_the_cap_bails_out() {
    // ⚠ THE EDGE THAT MATTERS. Blocking past the cap is what overruns the job
    // deadline; bailing lets the next cron tick resume from the stored cursor.
    assert_eq!(
        decide_rate_limit_wait(0, CAP + 1, CAP),
        RateLimitAction::Exhausted { resume_in_sec: 61 }
    );
}

#[test]
fn the_resume_time_rounds_up_never_down() {
    // Reporting a resume earlier than the budget actually returns sends the
    // caller back into a 429. 60_001 ms is 60.001 s → 61, not 60.
    assert_eq!(
        decide_rate_limit_wait(0, 60_001, CAP),
        RateLimitAction::Exhausted { resume_in_sec: 61 }
    );
    // An exact second stays exact rather than gaining one.
    assert_eq!(
        decide_rate_limit_wait(0, 120_000, CAP),
        RateLimitAction::Exhausted { resume_in_sec: 120 }
    );
    // A full hour, the real case when the budget is spent early in a window.
    assert_eq!(
        decide_rate_limit_wait(0, 3_600_000, CAP),
        RateLimitAction::Exhausted {
            resume_in_sec: 3600
        }
    );
}

#[test]
fn the_cap_is_honoured_as_given_not_as_a_constant() {
    // The parameter exists so a caller can tighten it; a port that read the
    // constant instead would ignore that and still pass every test above.
    assert_eq!(
        decide_rate_limit_wait(0, 5_000, 1_000),
        RateLimitAction::Exhausted { resume_in_sec: 5 }
    );
    assert_eq!(
        decide_rate_limit_wait(0, 5_000, 10_000),
        RateLimitAction::Sleep { ms: 5_000 }
    );
}
