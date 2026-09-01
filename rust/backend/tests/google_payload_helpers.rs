//! The pure readers for a Google Health point, against the public API.
//!
//! Each test below pins a way to get a payload wrong that has cost something,
//! and none of them touches the network — these are total functions of a JSON
//! value, which is why they can be tested at all.

use serde_json::json;

use backend::google::health::{civil_datetime, numeric, rfc3339_to_utc_datetime};

#[test]
fn civil_time_becomes_a_datetime_and_seconds_are_optional() {
    let with_seconds = json!({
        "date": { "year": 2026, "month": 9, "day": 1 },
        "time": { "hours": 7, "minutes": 5, "seconds": 9 },
    });
    assert_eq!(
        civil_datetime(Some(&with_seconds)).as_deref(),
        Some("2026-09-01 07:05:09")
    );
    // ⚠ The daily types omit `seconds` and the heart-rate samples carry it. A
    // missing one is zero, not a reason to drop the point.
    let no_seconds = json!({
        "date": { "year": 2026, "month": 9, "day": 1 },
        "time": { "hours": 7, "minutes": 5 },
    });
    assert_eq!(
        civil_datetime(Some(&no_seconds)).as_deref(),
        Some("2026-09-01 07:05:00")
    );
}

#[test]
fn a_civil_time_missing_its_date_is_unreadable_rather_than_defaulted() {
    assert_eq!(
        civil_datetime(Some(&json!({ "time": { "hours": 7 } }))),
        None
    );
    assert_eq!(civil_datetime(None), None);
}

/// ⚠ THE WHOLE REASON `physicalTime` IS PARSED RATHER THAN SLICED.
///
/// Taking the first 19 characters off an offset timestamp stores a LOCAL clock
/// in the UTC column. Every summer reading would be an hour out, in a column
/// whose entire purpose is to be the instant.
#[test]
fn physical_time_is_converted_to_utc_not_truncated() {
    assert_eq!(
        rfc3339_to_utc_datetime("2026-09-01T07:05:09+01:00").as_deref(),
        Some("2026-09-01 06:05:09"),
        "an offset timestamp must MOVE, not lose its offset"
    );
    assert_eq!(
        rfc3339_to_utc_datetime("2026-09-01T06:05:09Z").as_deref(),
        Some("2026-09-01 06:05:09")
    );
    assert_eq!(rfc3339_to_utc_datetime("not a time"), None);
}

/// `heartRate.beatsPerMinute` is a QUOTED number — the shape that once
/// discarded 1258 `dailyRestingHeartRate` points in silence while
/// `google-compare` printed `google 0 days`, which reads as "Google does not
/// carry this".
#[test]
fn a_quoted_number_reads_and_a_non_numeric_string_still_does_not() {
    assert_eq!(numeric(&json!("62")), Some(62.0));
    assert_eq!(numeric(&json!(62)), Some(62.0));
    assert_eq!(numeric(&json!("62.5")), Some(62.5));
    // ⚠ NOT a permissive fallback: a value we cannot read is not one we guess.
    assert_eq!(numeric(&json!("n/a")), None);
    assert_eq!(numeric(&json!(null)), None);
}
