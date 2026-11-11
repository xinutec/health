//! `date_bounds_utc`: a civil date runs from its local midnight to the next.
//!
//! The oracle is the zone's own local date at each instant, asked through
//! `chrono-tz` one second either side of each bound, so it checks the bounds
//! without repeating how they are computed. The hand-written cases below pin
//! the days where a fixed 24-hour day or an hour-only offset would be wrong.

use backend::timezone::date_bounds_utc;
use chrono::{DateTime, NaiveDate};
use chrono_tz::Tz;

const ZONES: [&str; 10] = [
    "UTC",
    "Europe/London",
    "America/New_York",
    "Asia/Tokyo",
    "Pacific/Kiritimati",
    "Pacific/Midway",
    "Asia/Kolkata",
    "America/St_Johns",
    "Australia/Lord_Howe",
    "Pacific/Chatham",
];

const DATES: [&str; 10] = [
    "2026-01-15",
    "2026-03-29",
    "2026-10-25",
    "2026-02-28",
    "2026-12-31",
    "2026-01-01",
    "2024-02-29",
    "2026-06-30",
    "2026-11-01",
    "2026-03-31",
];

fn local_date(ts: i64, zone: Tz) -> NaiveDate {
    DateTime::from_timestamp(ts, 0)
        .expect("representable")
        .with_timezone(&zone)
        .date_naive()
}

#[test]
fn each_bound_is_where_the_local_date_changes() {
    for tz in ZONES {
        let zone: Tz = tz.parse().unwrap();
        for date in DATES {
            let day: NaiveDate = date.parse().unwrap();
            let b = date_bounds_utc(date, Some(tz)).unwrap();
            assert_eq!(local_date(b.start_utc, zone), day, "{date} {tz} start");
            assert!(local_date(b.start_utc - 1, zone) < day, "{date} {tz} start");
            assert_eq!(local_date(b.end_utc - 1, zone), day, "{date} {tz} end");
            assert!(local_date(b.end_utc, zone) > day, "{date} {tz} end");
        }
    }
}

#[test]
fn no_zone_is_utc_midnight_to_midnight() {
    let b = date_bounds_utc("2026-01-15", None).unwrap();
    assert_eq!((b.start_utc, b.end_utc), (1_768_435_200, 1_768_521_600));
    assert_eq!(date_bounds_utc("2026-01-15", Some("")).unwrap(), b);
}

#[test]
fn a_dst_day_is_23_or_25_hours() {
    // London's clocks change at 01:00 UTC on both days.
    let spring = date_bounds_utc("2026-03-29", Some("Europe/London")).unwrap();
    assert_eq!(spring.start_utc, 1_774_742_400, "00:00 GMT");
    assert_eq!(spring.end_utc - spring.start_utc, 23 * 3600);

    let autumn = date_bounds_utc("2026-10-25", Some("Europe/London")).unwrap();
    assert_eq!(autumn.start_utc, 1_792_882_800, "00:00 BST is 23:00 UTC");
    assert_eq!(autumn.end_utc - autumn.start_utc, 25 * 3600);
}

#[test]
fn a_half_hour_zone_keeps_its_minutes() {
    let utc_midnight = 1_768_435_200; // the date's 00:00 UTC
    let kolkata = date_bounds_utc("2026-01-15", Some("Asia/Kolkata")).unwrap();
    assert_eq!(utc_midnight - kolkata.start_utc, 5 * 3600 + 1800, "+05:30");
    let st_johns = date_bounds_utc("2026-01-15", Some("America/St_Johns")).unwrap();
    assert_eq!(st_johns.start_utc - utc_midnight, 3 * 3600 + 1800, "-03:30");
}

#[test]
fn a_midnight_that_never_happens_starts_the_day_at_the_jump() {
    // America/Santiago springs forward at local midnight: this date has no
    // 00:00, its first instant is 01:00 -03 (04:00 UTC).
    let b = date_bounds_utc("2026-09-06", Some("America/Santiago")).unwrap();
    assert_eq!(b.start_utc, 1_788_667_200);
    assert_eq!(b.end_utc - b.start_utc, 23 * 3600);
}

#[test]
fn a_bad_date_or_zone_is_an_error() {
    assert!(date_bounds_utc("2026-02-30", Some("UTC")).is_err());
    assert!(date_bounds_utc("2026-01-15", Some("Mars/Olympus")).is_err());
}
