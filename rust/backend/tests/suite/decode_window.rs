//! The decode cron's date window (#982 Tier 2).
//!
//! ⚠ THE WINDOW IS THE WHOLE POINT OF THIS FILE. The first Rust port looped
//! `0..n`, which decoded TODAY and dropped the oldest day of the window.
//! `src/cli/decode-day.ts` loops `d = 1; d <= days`. The failure is not loud:
//! at the cron's 06:00 today is a six-hour stub, and `save_decode` stamps it
//! with the current `CLASSIFIER_VERSION`, so it does not read as stale to a
//! consumer — it reads as a decoded day that happens to be nearly empty.

use backend::classification_inputs::decode_window;

fn at(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s).unwrap().into()
}

/// The cron's own invocation: `--days 7` at 06:00.
#[test]
fn seven_days_ends_yesterday_and_excludes_today() {
    let w = decode_window(at("2026-08-25T06:00:00Z"), 7);
    assert_eq!(
        w,
        vec![
            "2026-08-24",
            "2026-08-23",
            "2026-08-22",
            "2026-08-21",
            "2026-08-20",
            "2026-08-19",
            "2026-08-18",
        ],
        "the window must end yesterday and reach back seven days"
    );
    assert!(
        !w.contains(&"2026-08-25".to_string()),
        "today is a six-hour stub at 06:00 and must never be decoded"
    );
}

/// The count is the count — `0..n` silently returned n days ending TODAY, which
/// is the same length and a different set.
#[test]
fn length_matches_the_requested_days() {
    for n in [1, 7, 14] {
        assert_eq!(decode_window(at("2026-08-25T06:00:00Z"), n).len() as i64, n);
    }
}

/// Most recent first, so a truncated run has decoded the days most likely to be
/// read.
#[test]
fn ordered_most_recent_first() {
    let w = decode_window(at("2026-08-25T06:00:00Z"), 5);
    let mut sorted = w.clone();
    sorted.sort();
    sorted.reverse();
    assert_eq!(w, sorted);
}

/// ⚠ The date list is derived from UTC, NOT from the user's home_tz — the tz is
/// used for the day's BOUNDS, not for choosing which dates to decode.
/// `decode-day.ts` uses `setUTCDate` for the same reason, and matching it is
/// what keeps the two arms decoding the same set near midnight.
#[test]
fn dates_come_from_utc_not_the_local_day() {
    // 00:30 UTC on the 25th is still the 25th in London (BST, UTC+1 — 01:30),
    // so both arms agree; the point is that the arithmetic is UTC's.
    assert_eq!(
        decode_window(at("2026-08-25T00:30:00Z"), 1),
        vec!["2026-08-24"]
    );
    // 23:30 UTC on the 24th is already the 25th in London. UTC arithmetic still
    // yields the 23rd, which is what the TypeScript yields.
    assert_eq!(
        decode_window(at("2026-08-24T23:30:00Z"), 1),
        vec!["2026-08-23"]
    );
}

/// A month boundary is where an off-by-one is easiest to miss by eye.
#[test]
fn crosses_a_month_boundary() {
    assert_eq!(
        decode_window(at("2026-09-02T06:00:00Z"), 4),
        vec!["2026-09-01", "2026-08-31", "2026-08-30", "2026-08-29"]
    );
}

/// Degenerate, and it must be empty rather than "today".
#[test]
fn zero_days_is_empty() {
    assert!(decode_window(at("2026-08-25T06:00:00Z"), 0).is_empty());
}
