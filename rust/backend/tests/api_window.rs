//! The multi-day API window, through the linked Lean host (#982).
//!
//! One of these is a convenience and one is a security boundary. The boundary is
//! `earliest_visible`: a share recipient's read is capped by their window
//! however large `days` is, and getting the comparison backwards hands them the
//! owner's whole history in a response that looks entirely normal.
//!
//! # ⚠ THESE TESTS ARE ONLY AS CURRENT AS THE LAST SUCCESSFUL `:static` BUILD
//!
//! Reversing that comparison in `Verified/ApiWindow.lean` was ablated on
//! 2026-08-22. Four `#guard`s failed to compile, which is the real guard — and
//! THIS FILE STILL PASSED, because a failed `lake build` leaves the previous
//! `.a` in place and the host went on calling yesterday's Lean.
//!
//! So a green run here is evidence about the WIRE, not about the rule. The
//! rules are pinned by the `#guard`s, which cannot be stale because a wrong one
//! is a build error. Rebuild the statics before trusting a change measured
//! here.

use backend::lean;

#[test]
fn days_is_rejected_out_of_range_rather_than_clamped() {
    lean::init().expect("the Lean runtime must start");

    // Absent is the ONLY input that becomes the default.
    assert_eq!(lean::validate_days(None).unwrap(), Some(30));
    assert_eq!(lean::validate_days(Some(7.0)).unwrap(), Some(7));
    assert_eq!(lean::validate_days(Some(1.0)).unwrap(), Some(1));
    assert_eq!(lean::validate_days(Some(365.0)).unwrap(), Some(365));

    // ⚠ REJECTED. A clamp would answer `days=400` with a plausible year and the
    // caller would never learn it asked for something impossible.
    assert_eq!(lean::validate_days(Some(0.0)).unwrap(), None);
    assert_eq!(lean::validate_days(Some(-1.0)).unwrap(), None);
    assert_eq!(lean::validate_days(Some(366.0)).unwrap(), None);
    assert_eq!(lean::validate_days(Some(100_000.0)).unwrap(), None);
    // `.int()` rejects a fraction rather than truncating it.
    assert_eq!(lean::validate_days(Some(7.5)).unwrap(), None);
}

#[test]
fn an_unparseable_days_is_rejected_and_does_not_arrive_as_absent() {
    lean::init().expect("the Lean runtime must start");
    // ⚠ NaN cannot cross JSON. If it were dropped it would read as absent and
    // become 30 — a bad request answered with a month of data.
    assert_eq!(lean::validate_days(Some(f64::NAN)).unwrap(), None);
    // `Number("")` is 0, which fails the minimum. A host mapping `""` to absent
    // turns this rejection into a 30-day read.
    assert_eq!(lean::validate_days(Some(0.0)).unwrap(), None);
}

#[test]
fn the_owner_is_bounded_only_by_days() {
    lean::init().expect("the Lean runtime must start");
    assert_eq!(
        lean::earliest_visible("2026-08-22", 30, None)
            .unwrap()
            .as_deref(),
        Some("2026-07-23")
    );
    assert_eq!(
        lean::earliest_visible("2026-08-22", 365, None)
            .unwrap()
            .as_deref(),
        Some("2025-08-22")
    );
}

#[test]
fn a_share_window_caps_a_wide_read_and_does_not_widen_a_narrow_one() {
    lean::init().expect("the Lean runtime must start");
    let from = Some("2026-08-11");

    // ⚠ THE BOUNDARY. 365 days of history requested; the share's start is what
    // comes back.
    assert_eq!(
        lean::earliest_visible("2026-08-22", 365, from)
            .unwrap()
            .as_deref(),
        Some("2026-08-11")
    );
    assert_eq!(
        lean::earliest_visible("2026-08-22", 30, from)
            .unwrap()
            .as_deref(),
        Some("2026-08-11")
    );

    // …and the cap is a floor, not a replacement: a 7-day request stays 7 days.
    assert_eq!(
        lean::earliest_visible("2026-08-22", 7, from)
            .unwrap()
            .as_deref(),
        Some("2026-08-15")
    );
    assert_eq!(
        lean::earliest_visible("2026-08-22", 1, from)
            .unwrap()
            .as_deref(),
        Some("2026-08-21")
    );
}

#[test]
fn the_day_arithmetic_rolls_months_years_and_a_leap_day() {
    lean::init().expect("the Lean runtime must start");
    let at = |today: &str, days: i64| lean::earliest_visible(today, days, None).unwrap();

    assert_eq!(at("2026-03-01", 1).as_deref(), Some("2026-02-28"));
    assert_eq!(at("2026-01-01", 1).as_deref(), Some("2025-12-31"));
    assert_eq!(at("2026-03-01", 60).as_deref(), Some("2025-12-31"));
    // ⚠ 2024 is a leap year: the day before 1 March is the 29th.
    assert_eq!(at("2024-03-01", 1).as_deref(), Some("2024-02-29"));
    assert_eq!(at("2024-03-01", 2).as_deref(), Some("2024-02-28"));
    // An unparseable date is refused rather than becoming an epoch.
    assert_eq!(at("not-a-date", 1), None);
}
