//! Backfill primitives for the per-day and per-window sync streams.
//!
//! Port of the pure half of `src/backfill.ts`. Each Fitbit stream (HR, steps,
//! HRV, …) tracks its own historical coverage, and an orchestrator walks it
//! backwards from a stored cursor. These are the day-level and window-level
//! decisions that walk is made of; the orchestration around them needs a client
//! and a connection and lives in the sync entrypoint.
//!
//! ⚠ ALL FOUR ARE LEAN CANDIDATES AND HAVE NOT MOVED, for the same reason as
//! `fitbit::rate_limit`: `backend` does not link the Lean runtime yet. The case
//! here is stronger than usual and worth writing down, because
//! `Verified/Civil.lean` — added earlier today — is exactly the module that
//! makes these safe by construction:
//!
//!   `prevDayBounded` exists because a skip condition that always fired once
//!   walked the cursor indefinitely backward, crossed year 0, and produced
//!   malformed strings like `-000026-02`. The TypeScript defends with a regex
//!   and a floor comparison. `Civil.parseDate` cannot produce that state at
//!   all: it parses to three integers or refuses.
//!
//! So when the FFI lands these move first, together with `decide_rate_limit_wait`.
//!
//! # Three outcomes, and the middle one is the subtle one
//!
//! A day's fetch either has data, genuinely has none, or FAILED. Only the
//! second advances the empty-day streak that eventually marks a stream
//! complete. Conflating the third with the second used to silently truncate
//! history after 14 consecutive transient failures — a stream would declare
//! itself finished because Fitbit had been returning 5xx, and nothing said so.

use chrono::NaiveDate;

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
pub fn should_advance_empty_streak(result: &DayResult) -> bool {
    matches!(result, DayResult::Ok { points: 0 })
}

/// The day before `date`, refusing to reach `floor` or earlier.
///
/// `None` when the input is not a `YYYY-MM-DD` date, or when the previous day
/// is at or before `floor` — which is treated as the earliest date the backfill
/// may consider, EXCLUSIVE. Callers must stop when this returns `None`; that is
/// the guard that stops a runaway loop walking into negative years.
pub fn prev_day_bounded(date: &str, floor: &str) -> Option<String> {
    let d = parse_ymd(date)?;
    let prev = d.pred_opt()?;
    let prev = prev.format("%Y-%m-%d").to_string();
    // Lexicographic comparison, which is what the TypeScript does and is exact
    // for a fixed-width `YYYY-MM-DD`.
    if prev.as_str() <= floor {
        return None;
    }
    Some(prev)
}

/// The next older `[start, end]` window of `window_days` inclusive days.
///
/// `start` is clamped UP to `floor`, so a window never reaches before the
/// earliest date the backfill should consider. `None` when `window_days < 1`,
/// `end` does not parse, or `end` is at or before `floor`.
pub fn prev_window_bounded(end: &str, window_days: i64, floor: &str) -> Option<(String, String)> {
    if window_days < 1 {
        return None;
    }
    let e = parse_ymd(end)?;
    if end <= floor {
        return None;
    }
    let start = e.checked_sub_signed(chrono::TimeDelta::days(window_days - 1))?;
    let start = start.format("%Y-%m-%d").to_string();
    let start = if start.as_str() < floor {
        floor.to_string()
    } else {
        start
    };
    Some((start, end.to_string()))
}

/// Order streams by cursor recency, most recent first.
///
/// A brand-new stream has no stored cursor and takes `fallback` (typically
/// today), so it sorts first and catches up before the deeper-backfilling
/// streams resume — otherwise HR mid-2024 could starve steps for many runs.
///
/// STABLE: streams with the same effective cursor keep their input order.
/// `sort_by` in Rust is stable, matching `Array.prototype.sort`'s guarantee.
pub fn sort_streams_by_cursor_recency<T, N>(
    streams: &mut [T],
    name_of: N,
    cursors: &dyn Fn(&str) -> Option<String>,
    fallback: &str,
) where
    N: Fn(&T) -> String,
{
    streams.sort_by(|a, b| {
        let ca = cursors(&name_of(a)).unwrap_or_else(|| fallback.to_string());
        let cb = cursors(&name_of(b)).unwrap_or_else(|| fallback.to_string());
        cb.cmp(&ca)
    });
}

/// Strict `YYYY-MM-DD`.
///
/// ⚠ THE WIDTH CHECK IS NOT REDUNDANT, and assuming it was is a mistake this
/// module's tests caught. `NaiveDate::parse_from_str(s, "%Y-%m-%d")` is LENIENT
/// about component widths: it accepts `2026-2-3` and returns 2026-02-03. So the
/// TypeScript's `/^\d{4}-\d{2}-\d{2}$/` gate does real work, and dropping it
/// would let a cursor of the wrong shape keep walking instead of stopping the
/// stream — the failure `prev_day_bounded` exists to prevent.
///
/// Checked by shape rather than by pulling in a regex crate for one pattern:
/// exactly ten bytes, dashes at 4 and 7, digits everywhere else. `chrono` then
/// rejects the impossible days (`2026-02-30`).
fn parse_ymd(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}
