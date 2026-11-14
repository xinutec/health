//! The live-map rules. `/location/tail` filters and caps inline rather than
//! shipping thousands of points to Lean per poll, so this file holds the host's
//! copy, and the three constants restated in `lean.rs`, to the rule.

use backend::lean;
use backend::location_cache::{TailPoint, tail_after};

fn init() {
    lean::init().expect("lean host");
}

fn points(tss: &[i64]) -> Vec<TailPoint> {
    tss.iter()
        .map(|&ts| TailPoint {
            lat: 51.5,
            lon: -0.1,
            ts,
        })
        .collect()
}

/// The constants are restated in Rust for the serving path. If Lean's move
/// and these do not, the host quietly serves a different policy.
#[test]
fn constants_match_lean() {
    init();
    let (tail_max, fix_ttl, tail_ttl) = lean::location_policy().expect("policy");
    assert_eq!(lean::TAIL_MAX_POINTS, tail_max);
    assert_eq!(lean::LATEST_FIX_TTL_MS, fix_ttl);
    assert_eq!(lean::TAIL_TTL_MS, tail_ttl);
}

/// The drift guard for the filter and the cap.
#[test]
fn tail_agrees_with_lean() {
    init();
    let long: Vec<i64> = (1..=3000).collect();
    let cases: Vec<(Vec<i64>, i64)> = vec![
        (vec![1, 2, 3], 2),
        (vec![1, 2, 3], 0),
        (vec![1, 2, 3], 3),
        (vec![], 0),
        ((1..=10).collect(), 4),
        (long.clone(), 0),
        (long.clone(), 2500),
        // A `since` beyond every point: an empty tail, not the whole buffer.
        (long.clone(), 99_999),
    ];
    for (tss, since) in cases {
        let want = lean::tail_after_ref(&tss, since).expect("lean tail");
        let got: Vec<i64> = tail_after(&points(&tss), since as f64)
            .into_iter()
            .map(|p| p.ts)
            .collect();
        assert_eq!(got, want, "tail_after(len={}, since={since})", tss.len());
    }
}

/// The filter is strict: the point the caller already holds is not resent.
#[test]
fn since_is_exclusive() {
    let got = tail_after(&points(&[1, 2, 3]), 2.0);
    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].ts, 3,
        "a `>=` here would redraw the caller's own point"
    );
}

/// The cap keeps the newest points; the oldest would look like lag, not a bug.
#[test]
fn the_cap_keeps_the_newest() {
    let tss: Vec<i64> = (1..=3000).collect();
    let got = tail_after(&points(&tss), 0.0);
    assert_eq!(got.len(), 2000);
    assert_eq!(got.first().map(|p| p.ts), Some(1001));
    assert_eq!(got.last().map(|p| p.ts), Some(3000));
}
