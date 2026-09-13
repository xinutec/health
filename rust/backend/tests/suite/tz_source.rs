//! The tz inference, checked against its Lean specification (#982).
//!
//! `Verified.FitbitTz.nearestFix` is a linear scan — obviously correct, and far
//! too slow to run: a day of 1-second heart rate is 86 400 rows against a sync
//! window that can hold thousands of fixes. `tz_source::nearest_fix` searches
//! instead.
//!
//! ⚠ NEITHER IS TRUSTED ON ITS OWN. Reading a hand-written binary search does
//! not catch an off-by-one at the tie, which is the failure that matters here —
//! it decides which zone a row on a travel day is stamped with. So both are
//! driven over the same inputs and compared, with the specification as arbiter.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY, for the reason `lean_ffi.rs` gives:
//! `health_backend_init` starts a process-global runtime and Cargo does not
//! serialise the tests inside one binary.

use backend::fitbit::tz_source::{FIX_SEARCH_WINDOW_S, Fix, ForwardTzSource, nearest_fix};
use backend::lean::{self, TzChoice};
use backend::timezone::wall_clock_to_unix;

/// A deterministic LCG. `Math.random` is not available and a fixed sequence is
/// what makes a failure reproducible.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.0 >> 33
    }
    fn in_range(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

#[test]
fn the_search_agrees_with_its_specification() {
    lean::init().expect("the Lean runtime must start");

    // ---- the cases that are named, before the ones that are generated -------
    let t = [100i64, 200, 300];
    for (times, target, want) in [
        (&[][..], 150i64, None),
        (&[100][..], 150, Some(0)),
        (&t[..], 90, Some(0)),
        (&t[..], 140, Some(0)),
        (&t[..], 160, Some(1)),
        (&t[..], 310, Some(2)),
        (&t[..], 100, Some(0)),
        // ⚠ THE TIE. 150 is 50 from both 100 and 200; the LATER one wins.
        (&t[..], 150, Some(1)),
        (&t[..], 250, Some(2)),
        // Duplicated timestamps: the last of the equals wins.
        (&[100, 100, 100][..], 100, Some(2)),
    ] {
        assert_eq!(
            nearest_fix(times, target),
            want,
            "nearest_fix({times:?}, {target})"
        );
        assert_eq!(
            lean::nearest_fix_spec(times, target).unwrap(),
            want,
            "the specification must agree on the named case too"
        );
    }

    // ---- and then a sweep, because the named cases are the ones I thought of
    // Small ranges on purpose: ties and duplicates are the interesting inputs,
    // and a wide range would almost never produce one.
    let mut rng = Lcg(0x5EED);
    let mut ties_seen = 0usize;
    let mut dupes_seen = 0usize;
    for case in 0..600 {
        let n = rng.in_range(9) as usize; // 0..8 fixes, including empty
        let mut times: Vec<i64> = (0..n).map(|_| rng.in_range(20) as i64).collect();
        times.sort_unstable();
        if times.windows(2).any(|w| w[0] == w[1]) {
            dupes_seen += 1;
        }
        let target = rng.in_range(24) as i64 - 2; // can fall outside both ends

        let got = nearest_fix(&times, target);
        let want = lean::nearest_fix_spec(&times, target).unwrap();
        assert_eq!(got, want, "case {case}: nearest_fix({times:?}, {target})");

        // Did this case actually exercise a tie? Count it so the sweep cannot
        // pass by never generating the input it exists to test.
        if let Some(i) = want {
            let d = (times[i] - target).abs();
            if times.iter().filter(|t| (**t - target).abs() == d).count() > 1 {
                ties_seen += 1;
            }
        }
    }
    // ⚠ Not a coverage nicety. A sweep that never produced a tie would pass
    // against a search with the tie rule inverted, and would read as evidence.
    assert!(
        ties_seen > 20,
        "the sweep must actually exercise ties; saw {ties_seen}"
    );
    assert!(
        dupes_seen > 20,
        "the sweep must actually exercise duplicate timestamps; saw {dupes_seen}"
    );

    // ---- the window and the fallback, also against the specification --------
    for (times, seed, want) in [
        (&[][..], Some(150i64), TzChoice::Profile),
        (&[100, 200, 300][..], None, TzChoice::Profile),
        (&[100, 200, 300][..], Some(150), TzChoice::Fix { index: 1 }),
        (
            &[0][..],
            Some(FIX_SEARCH_WINDOW_S),
            TzChoice::Fix { index: 0 },
        ),
        // ⚠ The boundary is `>`: exactly six hours away still counts.
        (&[0][..], Some(FIX_SEARCH_WINDOW_S + 1), TzChoice::Profile),
        (
            &[0][..],
            Some(-FIX_SEARCH_WINDOW_S),
            TzChoice::Fix { index: 0 },
        ),
        (&[0][..], Some(-FIX_SEARCH_WINDOW_S - 1), TzChoice::Profile),
    ] {
        assert_eq!(
            lean::decide_tz_spec(times, seed).unwrap(),
            want,
            "decideTz({times:?}, {seed:?})"
        );
    }

    // ---- the assembled source, end to end -----------------------------------
    // The fix's instant is DERIVED rather than written down. `for_wall_clock`
    // seeds its search by reading the wall clock in the PROFILE zone, so a
    // hand-computed constant has to agree with a conversion the test is not
    // performing — and a first attempt at one here was two hours out, which
    // showed up only as a fallback to the profile zone. `wall_clock_to_unix` is
    // covered by `tests/timezone.rs`, so using it as the fixture source states
    // the intent instead: "a fix at exactly this moment".
    let noon = wall_clock_to_unix("2026-05-12 00:06:00", "Europe/London")
        .expect("the fixture wall clock must convert");
    let amsterdam = |_lat: f64, _lon: f64| Some("Europe/Amsterdam".to_string());

    let src = ForwardTzSource::new(
        vec![Fix {
            ts: noon,
            lat: 52.37,
            lon: 4.89,
        }],
        Some("Europe/London".to_string()),
        &amsterdam,
    );
    assert_eq!(
        src.for_wall_clock("2026-05-12", "00:06:00").as_deref(),
        Some("Europe/Amsterdam"),
        "a fix inside the window outranks the profile zone"
    );
    // Three months away is far outside the six-hour window, so the profile
    // zone answers instead.
    assert_eq!(
        src.for_wall_clock("2026-08-12", "00:06:00").as_deref(),
        Some("Europe/London")
    );
    // An unparseable wall clock falls back rather than searching from nonsense.
    assert_eq!(
        src.for_wall_clock("not-a-date", "xx").as_deref(),
        Some("Europe/London")
    );

    // No fixes at all: the profile zone, and nothing else consulted.
    let bare = ForwardTzSource::new(vec![], Some("Europe/London".to_string()), &amsterdam);
    assert_eq!(
        bare.for_wall_clock("2026-05-12", "00:06:00").as_deref(),
        Some("Europe/London")
    );

    // ⚠ No signal at all answers None, and that is correct rather than a
    // failure: the row gets tz=NULL and its ts_utc stays null with it.
    let blind = ForwardTzSource::new(vec![], None, &amsterdam);
    assert_eq!(blind.for_wall_clock("2026-05-12", "00:06:00"), None);

    // A fix the lookup cannot place still beats answering nothing.
    let unplaceable = |_lat: f64, _lon: f64| None;
    let src2 = ForwardTzSource::new(
        vec![Fix {
            ts: noon,
            lat: 0.0,
            lon: 0.0,
        }],
        Some("Europe/London".to_string()),
        &unplaceable,
    );
    assert_eq!(
        src2.for_wall_clock("2026-05-12", "00:06:00").as_deref(),
        Some("Europe/London")
    );
}
