//! `local_hour_of` / `local_stay_samples`: Rust resolves instants to local
//! `(weekday, minute)` (tzdata) for `Verified.Geo.OpeningHours` and `bestPlace`.
//!
//! Cases recorded from the retired implementation (`fixtures/local-time-ts.mjs`),
//! picked for quiet failures: the Monday-based weekday, both European DST
//! transitions, a zero-length window, a mid-minute start, and a southern zone.

use backend::timezone::{local_hour_of, local_stay_samples};
use serde_json::Value;

#[test]
fn the_local_hour_matches_the_typescript() {
    let raw = include_str!("../fixtures/local-time-ts.json");
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
    let raw = include_str!("../fixtures/local-time-ts.json");
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

/// Monday is zero. `chrono`'s `num_days_from_sunday` would shift every opening
/// judgement by a day with output of the right shape.
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

/// A zero-length window is the instant at its start, not an empty list, which
/// the scorer reads as a stay it knows nothing about.
#[test]
fn a_zero_length_stay_samples_its_start() {
    let t = 1_768_435_200;
    let got = local_stay_samples(t, t, "Europe/London").expect("samples");
    assert_eq!(got.len(), 1);
    // And an end before the start is the same case, not a negative walk.
    assert_eq!(
        local_stay_samples(t, t - 600, "Europe/London").expect("s"),
        got
    );
}

/// The observation tensor's table is per minute: a spring-forward day has 1380
/// minutes, and `(m / 60) % 24` is wrong for 22 of its hours.
#[test]
fn the_local_ctx_table_follows_dst_rather_than_the_minute_index() {
    use backend::timezone::{date_bounds_utc, local_ctx_table};

    // 2026-03-29, the European spring forward: London's clocks go 00:59 → 02:00.
    let b = date_bounds_utc("2026-03-29", Some("Europe/London")).unwrap();
    let t = local_ctx_table(b.start_utc, b.end_utc, "Europe/London").unwrap();
    assert_eq!(t.len(), 23 * 60, "one row per minute of the 23-hour day");
    assert_eq!(t[t.len() - 1], [23, 0], "the last minute is 23:59");
    assert_eq!(t[0], [0, 0], "midnight on a Sunday");
    // Minute 60 is the hour that does not exist: local time is already 02:00.
    assert_eq!(t[59], [0, 0]);
    assert_eq!(t[60], [2, 0], "01:00 local never happens on this day");
    assert!(
        t.iter().all(|p| p[0] != 1),
        "no minute of this civil day is in the 01:00 hour"
    );
    // And the index is not the hour. Stated as its own assertion because the
    // whole point is that a table built from `m / 60` would pass every other
    // check in this file.
    assert_ne!(
        t.iter().map(|p| p[0]).collect::<Vec<_>>(),
        (0..23 * 60).map(|m: u32| (m / 60) % 24).collect::<Vec<_>>()
    );

    // Sunday is 0 here and 6 in `local_stay_samples`, deliberately: opening
    // hours are Monday-based, the tensor Sunday-based. A shared helper would
    // shift every hour profile by a day.
    let mon = date_bounds_utc("2026-03-30", Some("Europe/London")).unwrap();
    assert_eq!(
        local_ctx_table(mon.start_utc, mon.end_utc, "Europe/London").unwrap()[0],
        [0, 1]
    );
    assert_eq!(
        local_stay_samples(mon.start_utc, mon.start_utc, "Europe/London").unwrap()[0].0,
        0
    );
}
