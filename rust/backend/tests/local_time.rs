//! `local_hour_of` / `local_stay_samples` against the TypeScript (#982).
//!
//! These two exist because `Verified.Geo.OpeningHours` decides open-versus-
//! closed but instant → local `(weekday, minute)` is tzdata, so the shell
//! resolves the pairs and puts them on the wire. They feed `bestPlace`, whose
//! entries are the only DERIVED ones in any answer table.
//!
//! The cases were produced by running `dist/geo/opening-hours.js` and
//! `dist/geo/venue-prior.js` — see `fixtures/local-time-ts.mjs`. They are
//! chosen for what these get wrong quietly rather than loudly: the Monday-based
//! weekday index, both European DST transitions, a zero-length window, a stay
//! that starts mid-minute, and a southern-hemisphere zone whose DST runs the
//! other way.

use backend::timezone::{local_hour_of, local_stay_samples};
use serde_json::Value;

#[test]
fn the_local_hour_matches_the_typescript() {
    let raw = include_str!("fixtures/local-time-ts.json");
    let fx: Value = serde_json::from_str(raw).expect("fixture parses");
    let cases = fx["hours"].as_array().expect("hours");
    assert!(cases.len() >= 40, "fixture shrank to {}", cases.len());

    for c in cases {
        let ts = c["ts"].as_i64().expect("ts");
        let tz = c["tz"].as_str().expect("tz");
        let want = u32::try_from(c["hour"].as_i64().expect("hour")).expect("hour fits");
        let got = local_hour_of(ts, tz).unwrap_or_else(|e| panic!("{ts} {tz}: {e}"));
        assert_eq!(got, want, "local hour of {ts} in {tz}");
    }
}

#[test]
fn the_stay_samples_match_the_typescript() {
    let raw = include_str!("fixtures/local-time-ts.json");
    let fx: Value = serde_json::from_str(raw).expect("fixture parses");
    let cases = fx["stays"].as_array().expect("stays");
    assert!(!cases.is_empty());

    for c in cases {
        let s = c["startTs"].as_i64().expect("startTs");
        let e = c["endTs"].as_i64().expect("endTs");
        let tz = c["tz"].as_str().expect("tz");
        let want: Vec<(u32, u32)> = c["samples"]
            .as_array()
            .expect("samples")
            .iter()
            .map(|p| {
                (
                    u32::try_from(p[0].as_i64().expect("dayIdx")).expect("fits"),
                    u32::try_from(p[1].as_i64().expect("minute")).expect("fits"),
                )
            })
            .collect();
        let got = local_stay_samples(s, e, tz).unwrap_or_else(|err| panic!("{s}..{e} {tz}: {err}"));
        assert_eq!(got, want, "stay {s}..{e} in {tz}");
    }
}

/// ⚠ MONDAY IS ZERO, and nothing about the shape of the output says so.
///
/// `chrono`'s `num_days_from_sunday` is the obvious call and is wrong here.
/// Using it shifts every opening-hours judgement by one day while producing
/// output of exactly the right length and range — a venue judged open on the
/// wrong weekday, with no signal anywhere.
#[test]
fn the_weekday_index_is_monday_based() {
    // 2026-01-01 00:00Z is a Thursday.
    let thursday = 1_767_225_600;
    let got = local_stay_samples(thursday, thursday, "UTC").expect("samples");
    assert_eq!(got, vec![(3, 0)], "Thursday is 3 when Monday is 0");

    // And the day before it is Wednesday, not Friday — which is what a
    // Sunday-based index would give for the same instant.
    let wednesday = thursday - 86_400;
    assert_eq!(
        local_stay_samples(wednesday, wednesday, "UTC").expect("samples"),
        vec![(2, 0)]
    );
}

/// A zero-length window is the instant at its start, not an empty list.
///
/// An empty sample list is not "a stay of no minutes" to the scorer — it is a
/// stay it can say nothing about, which scores differently from one sampled at
/// a single instant.
#[test]
fn a_zero_length_stay_samples_its_start() {
    let t = 1_768_435_200;
    let got = local_stay_samples(t, t, "Europe/London").expect("samples");
    assert_eq!(got.len(), 1);
    // And an end BEFORE the start is the same case, not a negative walk.
    assert_eq!(
        local_stay_samples(t, t - 600, "Europe/London").expect("s"),
        got
    );
}

/// ⚠ THE OBSERVATION TENSOR'S TABLE IS RESOLVED PER MINUTE, and the two days a
/// year that matters are the two days the decoder is hardest to debug. On a
/// spring-forward day 01:00 local is followed by 03:00 local, so the naive
/// `(m / 60) % 24` — which every fixture in this repo uses, because a fixture
/// never spans a transition — is wrong for 22 of the 24 hours.
#[test]
fn the_local_ctx_table_follows_dst_rather_than_the_minute_index() {
    use backend::timezone::{date_bounds_utc, local_ctx_table};

    // 2026-03-29, the European spring forward: London's clocks go 00:59 → 02:00.
    let b = date_bounds_utc("2026-03-29", Some("Europe/London")).unwrap();
    let t = local_ctx_table(b.start_utc, "Europe/London").unwrap();
    assert_eq!(
        t.len(),
        1440,
        "the table is one row per minute-of-day index"
    );
    assert_eq!(t[0], [0, 0], "midnight on a Sunday");
    // Minute 60 is the hour that does not exist: local time is already 02:00.
    assert_eq!(t[59], [0, 0]);
    assert_eq!(t[60], [2, 0], "01:00 local never happens on this day");
    assert!(
        t.iter().all(|p| p[0] != 1),
        "no minute of this civil day is in the 01:00 hour"
    );
    // ⚠ AND THE INDEX IS NOT THE HOUR. Stated as its own assertion because the
    // whole point is that a table built from `m / 60` would pass every other
    // check in this file.
    assert_ne!(
        t.iter().map(|p| p[0]).collect::<Vec<_>>(),
        (0..1440).map(|m: u32| (m / 60) % 24).collect::<Vec<_>>()
    );

    // ⚠ SUNDAY IS 0 HERE AND 6 IN `local_stay_samples`. The two live in one file
    // and disagree deliberately: opening hours are Monday-based, the tensor
    // follows JavaScript's `Date`. Pinned so a shared helper is never "tidied"
    // in without noticing it shifts every hour profile by a day.
    let mon = date_bounds_utc("2026-03-30", Some("Europe/London")).unwrap();
    assert_eq!(
        local_ctx_table(mon.start_utc, "Europe/London").unwrap()[0],
        [0, 1]
    );
    assert_eq!(
        local_stay_samples(mon.start_utc, mon.start_utc, "Europe/London").unwrap()[0].0,
        0
    );
}
