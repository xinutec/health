//! Splitting a capped PhoneTrack window loses no second and repeats none (#1032).
//!
//! ⚠ PhoneTrack truncates at `maxPoints` and puts NOTHING in the response to say
//! so, and a truncated week is shaped exactly like a quiet one. The fetch reacts
//! to the symptom — a response of exactly the cap — by halving the window and
//! asking again, so the arithmetic below is what stands between a lost tail and
//! a correct one.
//!
//! ⚠ **Both bounds are INCLUSIVE.** `Verified.Sync.chunkRange` documents its
//! touching chunk endpoints as a deliberate duplicate, which is what fixes the
//! convention. So the halves must be `[a, mid]` and `[mid + 1, b]`: splitting at
//! `mid` twice re-fetches the boundary second, and `[mid, b]` with `[a, mid - 1]`
//! would drop it. Coverage is asserted second by second below rather than
//! argued.

use backend::nextcloud::phonetrack::split_window;

/// Every second in `[a, b]` appears in exactly one half.
fn covers_exactly(a: i64, b: i64) {
    let Some((lo, hi)) = split_window(a, b) else {
        panic!("[{a}, {b}] should split");
    };
    let mut seen = Vec::new();
    for (x, y) in [lo, hi] {
        assert!(x <= y, "[{x}, {y}] is empty or inverted");
        for t in x..=y {
            seen.push(t);
        }
    }
    let want: Vec<i64> = (a..=b).collect();
    assert_eq!(seen, want, "[{a}, {b}] was not covered exactly once");
}

#[test]
fn the_halves_cover_the_window_exactly() {
    for (a, b) in [(0, 1), (0, 2), (0, 3), (10, 11), (100, 199), (5, 1000)] {
        covers_exactly(a, b);
    }
}

/// ⚠ Real bounds are Unix seconds, and a 7-day chunk is the case that motivated
/// this — 604 800 seconds, which must still divide without losing its ends.
#[test]
fn a_seven_day_window_splits_without_losing_its_ends() {
    let a = 1_787_000_000;
    let b = a + 7 * 24 * 60 * 60;
    let ((lo_a, lo_b), (hi_a, hi_b)) = split_window(a, b).expect("a week splits");
    assert_eq!(lo_a, a, "the low half must start at the window start");
    assert_eq!(hi_b, b, "the high half must end at the window end");
    assert_eq!(hi_a, lo_b + 1, "the halves must touch without overlapping");
}

/// ⚠ THE TERMINATION ARGUMENT. The caller loops until nothing splits, so a
/// window that could return itself would hang against a server that keeps
/// answering at the cap.
#[test]
fn a_single_second_does_not_split() {
    assert_eq!(split_window(42, 42), None);
    assert_eq!(
        split_window(42, 41),
        None,
        "an inverted window is not split"
    );
}

#[test]
fn every_split_strictly_narrows() {
    let mut window = (0i64, 10_000i64);
    let mut guard = 0;
    while let Some((lo, _hi)) = split_window(window.0, window.1) {
        assert!(
            lo.1 - lo.0 < window.1 - window.0,
            "the low half must be narrower"
        );
        window = lo;
        guard += 1;
        assert!(
            guard < 64,
            "splitting 10 000 seconds should converge quickly"
        );
    }
    assert_eq!(window.0, window.1, "narrowing ends at a single second");
}
