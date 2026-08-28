//! Has each stream actually stopped arriving? (#1231)
//!
//! # Why an outcome check and not an error check
//!
//! On 2026-08-28 `daily_activity` stopped for over an hour because Fitbit began
//! quoting an integer. `health-sync` exited 0 on every run; the only trace was
//! one ERROR line in a pod log that nothing read. It surfaced because someone
//! happened to be watching a deploy for an unrelated reason.
//!
//! ⚠ Watching for a known error string would not have caught it and would not
//! catch the next one either — a stream that writes nothing WITHOUT erroring
//! looks identical from the outside. "Did rows arrive?" is the only question
//! that generalises.

/// How stale one stream may be before something is wrong.
pub struct Freshness {
    pub table: &'static str,
    pub max_lag_days: i64,
    pub why: &'static str,
}

/// ⚠ ONE BOUND PER STREAM, NOT ONE FOR ALL. Measured 2026-08-28: every daily
/// stream was same-day, `sleep` was one night behind, and `body` was TEN DAYS
/// behind and perfectly healthy — weigh-ins are irregular. A single threshold is
/// either so loose it never fires or so tight that `body` screams forever, and
/// an alarm that cries wolf gets muted, which is worse than no alarm.
///
/// ⚠ Every bound is set ABOVE MEASURED NORMAL and each `why` carries the
/// observation, so a later reader can tell a chosen bound from an invented one.
pub const FRESHNESS: &[Freshness] = &[
    Freshness {
        table: "body",
        max_lag_days: 45,
        why: "weigh-ins are irregular; 10 days behind and healthy when measured",
    },
    Freshness {
        table: "breathing_rate",
        max_lag_days: 3,
        why: "nightly, from Google; same-day when measured",
    },
    Freshness {
        table: "hrv_daily",
        max_lag_days: 3,
        why: "nightly, from Google; same-day when measured",
    },
    Freshness {
        table: "skin_temperature",
        max_lag_days: 3,
        why: "nightly, from Google; same-day when measured",
    },
    Freshness {
        table: "spo2_daily",
        max_lag_days: 3,
        why: "nightly, from Google; same-day when measured",
    },
    Freshness {
        table: "daily_activity",
        max_lag_days: 3,
        why: "daily; same-day when measured. ⚠ THE ONE THIS EXISTS FOR — it died silently for an hour on 2026-08-28 while health-sync exited 0 every run",
    },
    Freshness {
        table: "sleep",
        max_lag_days: 4,
        why: "nightly, one night behind when measured; a missed night is normal",
    },
    Freshness {
        table: "heart_rate_zones",
        max_lag_days: 3,
        why: "daily; same-day when measured. See #1223, the early rows are junk",
    },
    Freshness {
        table: "heart_rate_intraday",
        max_lag_days: 3,
        why: "continuous; same-day when measured",
    },
    Freshness {
        table: "hrv_intraday",
        max_lag_days: 3,
        why: "per main sleep; same-day when measured",
    },
    Freshness {
        table: "steps_intraday",
        max_lag_days: 3,
        why: "continuous; same-day when measured",
    },
];

/// Why this stream is not arriving, or `None` if it is fine.
///
/// ⚠ `lag` is `None` for an EMPTY table — `MAX()` over no rows is NULL. That is
/// maximally stale, NOT a row to skip: skipping it would let a stream that never
/// arrived at all pass the check, which is the failure this exists to catch.
///
/// ⚠ An UNBUDGETED table is also a failure. A stream added to the query and not
/// to [`FRESHNESS`] would otherwise be silently unwatched — the same shape of
/// bug again, one level up.
pub fn stale_reason(table: &str, lag: Option<i64>) -> Option<String> {
    let Some(rule) = FRESHNESS.iter().find(|f| f.table == table) else {
        return Some(format!("{table}: no freshness bound — unwatched"));
    };
    match lag {
        None => Some(format!("{table}: EMPTY, no rows at all")),
        Some(d) if d > rule.max_lag_days => Some(format!(
            "{table}: {d} days behind, bound {} ({})",
            rule.max_lag_days, rule.why
        )),
        Some(_) => None,
    }
}
