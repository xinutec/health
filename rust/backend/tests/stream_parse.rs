//! The pure halves of `sync::{heartrate, hrv, body}` (#982).
//!
//! Grouped in one binary because each is a handful of cases over a wire shape
//! rather than a subsystem. Sleep gets its own file — it carries the 64-bit id
//! history and the per-stage tz.

use backend::fitbit::sync::body::{Point, merge_series, positive_num};
use backend::fitbit::sync::heartrate::parse_hr_dataset;
use backend::fitbit::sync::hrv::parse_hrv_intraday;
use backend::fitbit::sync::null_tz;

// ---- heart rate ------------------------------------------------------------

const HR: &str = r#"{
  "activities-heart": [],
  "activities-heart-intraday": {
    "dataset": [
      {"time": "00:00:00", "value": 58},
      {"time": "00:00:01", "value": 57}
    ]
  }
}"#;

#[test]
fn hr_intraday_stamps_each_point_with_its_date() {
    let rows = parse_hr_dataset(HR, "2026-05-12", &null_tz).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].ts, "2026-05-12 00:00:00");
    assert_eq!(rows[0].bpm, 58);
    assert_eq!(rows[1].ts, "2026-05-12 00:00:01");
    assert_eq!(rows[0].tz, None);
    assert_eq!(rows[0].ts_utc, None);
}

#[test]
fn hr_intraday_keeps_a_zero_reading() {
    // ⚠ The opposite of steps, deliberately. Absence means zero for steps; a
    // heart rate of zero is a device fault and dropping it would hide one.
    let body = HR.replace("\"value\": 58", "\"value\": 0");
    let rows = parse_hr_dataset(&body, "2026-05-12", &null_tz).unwrap();
    assert_eq!(rows.len(), 2, "no row is filtered out");
    assert_eq!(rows[0].bpm, 0);
}

#[test]
fn hr_with_no_intraday_block_is_empty_and_not_an_error() {
    // A zones-only range response has no intraday key at all. That is a day the
    // watch was off, which the backfill counts toward its empty streak — an
    // error here would stop the streak advancing and the stream would never
    // complete.
    let rows = parse_hr_dataset(r#"{"activities-heart": []}"#, "2026-05-12", &null_tz).unwrap();
    assert!(rows.is_empty());
}

#[test]
fn hr_intraday_derives_utc_from_the_per_second_tz() {
    let rows = parse_hr_dataset(HR, "2026-05-12", &|_, _| Some("Europe/Amsterdam".into())).unwrap();
    assert_eq!(rows[0].ts_utc.as_deref(), Some("2026-05-11 22:00:00"));
}

// ---- HRV -------------------------------------------------------------------

const HRV: &str = r#"{
  "hrv": [{
    "dateTime": "2026-05-12",
    "minutes": [
      {"minute": "2026-05-12T00:06:30.000", "value": {"rmssd": 34.5, "coverage": 0.94, "hf": 210.1, "lf": 480.2}},
      {"minute": "2026-05-12T00:11:30.000", "value": {"rmssd": 36.0, "coverage": 0.91, "hf": 205.0, "lf": 470.0}}
    ]
  }]
}"#;

#[test]
fn hrv_minutes_become_datetime_shaped_wall_clocks() {
    let rows = parse_hrv_intraday(HRV).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0].ts, "2026-05-12 00:06:30",
        "the T becomes a space and the milliseconds are dropped"
    );
    assert_eq!(rows[0].rmssd, 34.5);
    assert_eq!(rows[0].coverage, 0.94);
    assert_eq!(rows[0].hf, 210.1);
    assert_eq!(rows[0].lf, 480.2);
}

#[test]
fn hrv_flattens_across_days() {
    let two = HRV.replace(
        "\"hrv\": [{",
        "\"hrv\": [{\"dateTime\": \"2026-05-11\", \"minutes\": []}, {",
    );
    assert_eq!(
        parse_hrv_intraday(&two).unwrap().len(),
        2,
        "a day with no main sleep contributes nothing rather than failing"
    );
}

#[test]
fn hrv_with_no_days_is_empty() {
    assert!(parse_hrv_intraday(r#"{"hrv": []}"#).unwrap().is_empty());
    assert!(parse_hrv_intraday("{}").unwrap().is_empty());
}

// ---- body ------------------------------------------------------------------

#[test]
fn a_zero_in_the_body_series_is_not_a_measurement() {
    // The series carries "0" — not a gap — for every day before the first
    // measurement. Storing that as a body mass of zero is the failure.
    assert_eq!(positive_num("0"), None);
    assert_eq!(positive_num("0.0"), None);
    assert_eq!(positive_num("-1.5"), None);
    assert_eq!(positive_num(""), None);
    assert_eq!(positive_num("abc"), None);
    assert_eq!(positive_num("NaN"), None);
    assert_eq!(positive_num("Infinity"), None);
    assert_eq!(positive_num("72.4"), Some(72.4));
    assert_eq!(positive_num("72"), Some(72.0));
    // The trim closes the one divergence a bare `parse` would have from
    // JavaScript's `Number`, which tolerates surrounding space.
    assert_eq!(positive_num(" 72.4 "), Some(72.4));
    // ⚠ The divergence that remains, recorded rather than claimed away:
    // `Number("0x10")` is 16. Fitbit sends decimal strings, so it is
    // unreachable from real data.
    assert_eq!(positive_num("0x10"), None);
}

fn point(date: &str, value: &str) -> Point {
    Point {
        date_time: date.to_string(),
        value: value.to_string(),
    }
}

#[test]
fn the_three_body_series_merge_by_date() {
    let merged = merge_series(
        &[point("2026-05-11", "72.4"), point("2026-05-12", "72.1")],
        &[point("2026-05-12", "22.6")],
        &[point("2026-05-12", "0")],
    );
    assert_eq!(merged.len(), 2);
    let a = &merged["2026-05-11"];
    assert_eq!(a.weight, Some(72.4));
    assert_eq!(a.bmi, None, "a date the BMI series does not cover");
    let b = &merged["2026-05-12"];
    assert_eq!(b.weight, Some(72.1));
    assert_eq!(b.bmi, Some(22.6));
    assert_eq!(
        b.fat, None,
        "the forward-filled zero before a first reading"
    );
}

#[test]
fn merged_dates_come_out_sorted() {
    // Not required for correctness — every write is a keyed upsert — but it
    // makes two runs produce the same log, which the TypeScript's Map did not
    // guarantee.
    let merged = merge_series(
        &[
            point("2026-05-12", "72.1"),
            point("2026-05-10", "72.9"),
            point("2026-05-11", "72.4"),
        ],
        &[],
        &[],
    );
    let dates: Vec<&str> = merged.keys().map(String::as_str).collect();
    assert_eq!(dates, ["2026-05-10", "2026-05-11", "2026-05-12"]);
}
