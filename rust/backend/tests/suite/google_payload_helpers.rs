//! The pure readers for a Google Health point, against the public API.
//!
//! Each test below pins a way to get a payload wrong that has cost something,
//! and none of them touches the network — these are total functions of a JSON
//! value, which is why they can be tested at all.

use serde_json::json;

use backend::google::health::{
    civil_datetime, numeric, parse_sleep_point, rfc3339_to_utc_datetime, utc_datetime_to_rfc3339,
    wall_clock_from_physical,
};

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

/// The high-water mark crosses from `MAX(ts_utc)` back into a `filter` bound.
/// A splice instead of a parse would happily emit a filter from a mangled
/// readout; the round trip below is the property the sync path leans on.
#[test]
fn a_stored_utc_datetime_round_trips_into_a_filter_bound() {
    assert_eq!(
        utc_datetime_to_rfc3339("2026-09-01 06:05:09").as_deref(),
        Some("2026-09-01T06:05:09Z")
    );
    assert_eq!(
        utc_datetime_to_rfc3339("2026-09-01 06:05:09")
            .as_deref()
            .and_then(rfc3339_to_utc_datetime)
            .as_deref(),
        Some("2026-09-01 06:05:09"),
        "the two converters must be inverses on the stored format"
    );
    assert_eq!(utc_datetime_to_rfc3339("2026-09-01T06:05:09Z"), None);
    assert_eq!(utc_datetime_to_rfc3339("not a time"), None);
}

/// A synthetic sleep point exercising every trap at once: QUOTED minutes, a
/// non-UTC offset (the wall clock must MOVE), the STAGES vocabulary (AWAKE is
/// Fitbit's `wake`), the end-date convention, and the id in the `name` path.
#[test]
fn a_sleep_point_parses_into_the_row_the_table_wants() {
    let pt = json!({
        "name": "users/123/dataTypes/sleep/dataPoints/7000000000000000001",
        "sleep": {
            "type": "STAGES",
            "metadata": {"mainSleep": true, "processed": true, "stagesStatus": "SUCCEEDED"},
            "interval": {
                "startTime": "2026-01-01T22:30:00Z", "startUtcOffset": "3600s",
                "endTime": "2026-01-02T05:30:00Z", "endUtcOffset": "3600s"
            },
            "stages": [
                {"startTime": "2026-01-01T22:30:00Z", "startUtcOffset": "3600s",
                 "endTime": "2026-01-01T23:00:00Z", "endUtcOffset": "3600s", "type": "LIGHT"},
                {"startTime": "2026-01-01T23:00:00Z", "startUtcOffset": "3600s",
                 "endTime": "2026-01-01T23:10:00Z", "endUtcOffset": "3600s", "type": "AWAKE"}
            ],
            "summary": {
                "minutesAsleep": "390", "minutesAwake": "30",
                "minutesInSleepPeriod": "420", "minutesToFallAsleep": "5",
                "minutesAfterWakeUp": "2",
                "stagesSummary": [
                    {"type": "DEEP", "minutes": "80", "count": "4"},
                    {"type": "AWAKE", "minutes": "30", "count": "6"}
                ]
            }
        }
    });
    let s = parse_sleep_point(&pt).expect("parses");
    assert_eq!(s.log_id, 7_000_000_000_000_000_001);
    // +01:00 moves the wall clock; the date is the civil END date.
    assert_eq!(s.start_time, "2026-01-01 23:30:00");
    assert_eq!(s.end_time, "2026-01-02 06:30:00");
    assert_eq!(s.date, "2026-01-02");
    assert_eq!(s.start_time_utc, "2026-01-01 22:30:00");
    assert_eq!(s.duration_ms, 7 * 3600 * 1000);
    // 390/420, as an integer percent.
    assert_eq!(s.efficiency, 93);
    assert_eq!((s.minutes_asleep, s.minutes_awake), (390, 30));
    // stagesSummary: AWAKE lands in minutes_wake for a STAGES session.
    assert_eq!(s.minutes_deep, Some(80));
    assert_eq!(s.minutes_wake, Some(30));
    assert_eq!(s.minutes_light, None);
    assert!(s.is_main_sleep);
    // The stage series: wall-clock keys, seconds from the interval, mapped level.
    assert_eq!(s.stages.len(), 2);
    assert_eq!(s.stages[0].ts, "2026-01-01 23:30:00");
    assert_eq!(s.stages[0].duration_seconds, 1800);
    assert_eq!(s.stages[0].stage, "light");
    assert_eq!(s.stages[1].stage, "wake", "STAGES AWAKE is Fitbit's `wake`");
}

/// A CLASSIC session keeps Fitbit's classic vocabulary — `awake` stays `awake`.
#[test]
fn a_classic_sleep_keeps_awake_unmapped() {
    let pt = json!({
        "name": "users/123/dataTypes/sleep/dataPoints/42",
        "sleep": {
            "type": "CLASSIC",
            "metadata": {"mainSleep": false},
            "interval": {
                "startTime": "2026-01-01T14:00:00Z", "startUtcOffset": "0s",
                "endTime": "2026-01-01T15:00:00Z", "endUtcOffset": "0s"
            },
            "stages": [
                {"startTime": "2026-01-01T14:00:00Z", "startUtcOffset": "0s",
                 "endTime": "2026-01-01T14:10:00Z", "endUtcOffset": "0s", "type": "AWAKE"}
            ],
            "summary": {"minutesAsleep": "50", "minutesAwake": "10",
                         "minutesInSleepPeriod": "60"}
        }
    });
    let s = parse_sleep_point(&pt).expect("parses");
    assert_eq!(s.stages[0].stage, "awake");
    assert!(!s.is_main_sleep);
    assert_eq!(s.efficiency, 83);
}

/// A negative offset moves the wall clock BACK — the splice this function
/// exists to prevent would have kept UTC.
#[test]
fn a_negative_offset_moves_the_wall_clock_back() {
    assert_eq!(
        wall_clock_from_physical("2026-01-01T03:00:00Z", "-18000s").as_deref(),
        Some("2025-12-31 22:00:00")
    );
    assert_eq!(
        wall_clock_from_physical("2026-01-01T03:00:00Z", "nonsense"),
        None
    );
}
