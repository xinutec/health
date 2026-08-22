//! The raw recovery numbers coach reads (#982).
//!
//! ⚠ These are NUMBERS, never a readiness score. health does not know what
//! readiness means; coach composes it. Two apps scoring the same nights would
//! drift on what a bad day is, and the athlete would be told two things.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

fn s(pairs: &[(&str, Option<f64>)]) -> Vec<(String, Option<f64>)> {
    pairs.iter().map(|(d, v)| ((*d).to_string(), *v)).collect()
}

/// ⚠ ONE reading has NO baseline, and the mean is that reading rather than
/// zero. A zero mean would make the first reading look enormously above
/// baseline; this way any z-score the caller derives is 0, and `n` says why.
#[test]
fn a_single_reading_is_its_own_baseline() {
    init();
    let r = lean::recovery_as_of("2026-08-22", &s(&[("2026-08-22", Some(50.0))]), &[], &[])
        .expect("recovery");
    let hrv = r.hrv.expect("hrv present");
    assert_eq!(hrv.latest, 50.0);
    assert_eq!(hrv.mean, 50.0, "the mean must not be zero");
    assert_eq!(hrv.sd, 0.0);
    assert_eq!(hrv.n, 0, "n is how the caller knows not to trust a z-score");
}

/// A no-wear night is DROPPED, not counted as zero — a missing night is not a
/// night of no sleep.
#[test]
fn a_missing_night_is_not_a_zero() {
    init();
    let r = lean::recovery_as_of(
        "2026-08-03",
        &s(&[
            ("2026-08-01", Some(10.0)),
            ("2026-08-02", None),
            ("2026-08-03", Some(30.0)),
        ]),
        &[],
        &[],
    )
    .expect("recovery");
    let hrv = r.hrv.expect("hrv present");
    assert_eq!(hrv.latest, 30.0);
    assert_eq!(
        hrv.mean, 10.0,
        "the gap must not pull the mean towards zero"
    );
    assert_eq!(hrv.n, 1);
}

/// ⚠ A question about a PAST morning must not see the future. Coach's ledger
/// asks what was known that day; leaking later readings would let it judge a
/// session against information nobody had.
#[test]
fn a_past_morning_cannot_see_later_readings() {
    init();
    let series = s(&[
        ("2026-08-01", Some(10.0)),
        ("2026-08-02", Some(20.0)),
        ("2026-08-03", Some(999.0)),
    ]);
    let r = lean::recovery_as_of("2026-08-02", &series, &[], &[]).expect("recovery");
    let hrv = r.hrv.expect("hrv present");
    assert_eq!(hrv.latest, 20.0, "2026-08-03 must be invisible on the 2nd");
    assert_eq!(r.as_of, "2026-08-02");
}

/// The baseline window is 28 days, inclusive, and an older reading drops out —
/// otherwise it would creep wider the longer the account existed.
#[test]
fn the_baseline_window_is_bounded_at_both_ends() {
    init();
    let inside = lean::recovery_as_of(
        "2026-08-22",
        &s(&[("2026-07-25", Some(10.0)), ("2026-08-22", Some(20.0))]),
        &[],
        &[],
    )
    .expect("recovery");
    assert_eq!(inside.hrv.expect("hrv").n, 1, "27 days back is inside");

    let outside = lean::recovery_as_of(
        "2026-08-22",
        &s(&[("2026-07-24", Some(10.0)), ("2026-08-22", Some(20.0))]),
        &[],
        &[],
    )
    .expect("recovery");
    assert_eq!(
        outside.hrv.expect("hrv").n,
        0,
        "29 days back has dropped out"
    );
}

/// ⚠ A too-wide or backwards range is REFUSED, not truncated. Returning 400
/// days for a decade-wide request would look complete to the caller.
#[test]
fn an_unanswerable_span_is_refused() {
    init();
    assert!(lean::recovery_span_ok("2026-08-01", "2026-08-22").expect("span"));
    assert!(lean::recovery_span_ok("2026-08-22", "2026-08-22").expect("span"));
    assert!(!lean::recovery_span_ok("2026-08-22", "2026-08-01").expect("span"));
    assert!(!lean::recovery_span_ok("2025-01-01", "2026-08-22").expect("span"));
    assert!(!lean::recovery_span_ok("nonsense", "2026-08-22").expect("span"));
}

/// Population standard deviation, dividing by n rather than n-1: these are the
/// days observed, not a sample drawn from a larger population.
#[test]
fn the_deviation_is_over_the_days_observed() {
    init();
    let r = lean::recovery_as_of(
        "2026-08-03",
        &s(&[
            ("2026-08-01", Some(10.0)),
            ("2026-08-02", Some(20.0)),
            ("2026-08-03", Some(30.0)),
        ]),
        &[],
        &[],
    )
    .expect("recovery");
    let hrv = r.hrv.expect("hrv present");
    assert_eq!(hrv.mean, 15.0);
    assert_eq!(hrv.sd, 5.0, "n-1 would give 7.07…");
    assert_eq!(hrv.n, 2);
}
