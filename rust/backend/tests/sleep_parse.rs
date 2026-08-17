//! `sync::sleep`'s pure half (#982).
//!
//! The cases are the ones the TypeScript's own tests cover plus the two this
//! port changes the answer to: a `logId` past 2^53, and a stage series whose tz
//! shifts inside one night.

use backend::fitbit::sync::null_tz;
use backend::fitbit::sync::sleep::{
    FitbitSleepLog, has_stages, parse_sleep_log, parse_sleep_stages,
};

fn log(json: &str) -> FitbitSleepLog {
    serde_json::from_str(json).expect("fixture must parse")
}

/// A full log: every optional stage summary present.
const FULL: &str = r#"{
  "logId": 7108245123456789012,
  "dateOfSleep": "2026-05-12",
  "startTime": "2026-05-12T00:06:00.000",
  "endTime": "2026-05-12T07:41:30.000",
  "duration": 27330000,
  "efficiency": 94,
  "minutesAsleep": 421,
  "minutesAwake": 34,
  "isMainSleep": true,
  "levels": {
    "summary": {
      "deep": {"minutes": 71},
      "light": {"minutes": 245},
      "rem": {"minutes": 105},
      "wake": {"minutes": 34}
    },
    "data": [
      {"dateTime": "2026-05-12T00:06:00.000", "level": "wake", "seconds": 300},
      {"dateTime": "2026-05-12T00:11:00.000", "level": "light", "seconds": 1800}
    ]
  }
}"#;

/// A nap: no `levels` at all, which Fitbit does send.
const BARE: &str = r#"{
  "logId": 7108245987654321,
  "dateOfSleep": "2026-05-12",
  "startTime": "2026-05-12T14:00:00.000",
  "endTime": "2026-05-12T14:35:00.000",
  "duration": 2100000,
  "efficiency": 88,
  "minutesAsleep": 30,
  "minutesAwake": 5,
  "isMainSleep": false
}"#;

#[test]
fn the_log_id_survives_past_two_to_the_fifty_third() {
    // A realistic Fitbit id: nineteen digits, ~770× the 2^53 a JS `Number` holds
    // exactly. `JSON.parse` would land on a nearby representable double.
    assert_eq!(log(FULL).log_id, 7_108_245_123_456_789_012);

    // And the boundary itself. 2^53 + 1 is the smallest integer a double cannot
    // represent; JavaScript rounds it DOWN to 2^53, and that rounded value in
    // one of `sleep.log_id` / `sleep_stages.sleep_log_id` but not the other is
    // what broke the `/api/sleep/stages` join.
    let edge: FitbitSleepLog = log(&FULL.replace("7108245123456789012", "9007199254740993"));
    assert_eq!(edge.log_id, 9_007_199_254_740_993);
    assert_ne!(edge.log_id, 9_007_199_254_740_992);
}

#[test]
fn a_full_log_maps_every_column() {
    let r = parse_sleep_log(&log(FULL), &null_tz);
    assert_eq!(r.date, "2026-05-12");
    assert_eq!(r.start_time, "2026-05-12T00:06:00.000");
    assert_eq!(r.duration_ms, 27_330_000);
    assert_eq!(r.efficiency, 94);
    assert_eq!(r.minutes_asleep, 421);
    assert_eq!(r.minutes_awake, 34);
    // The four stage-minute columns, in order. A transposition here is the
    // failure the named struct exists to prevent.
    assert_eq!(r.minutes_deep, Some(71));
    assert_eq!(r.minutes_light, Some(245));
    assert_eq!(r.minutes_rem, Some(105));
    assert_eq!(r.minutes_wake, Some(34));
    assert!(r.is_main_sleep);
}

#[test]
fn a_log_without_levels_writes_nulls_and_no_stages() {
    let l = log(BARE);
    let r = parse_sleep_log(&l, &null_tz);
    assert_eq!(r.minutes_deep, None);
    assert_eq!(r.minutes_light, None);
    assert_eq!(r.minutes_rem, None);
    assert_eq!(r.minutes_wake, None);
    assert!(!r.is_main_sleep);
    assert!(!has_stages(&l), "no levels means no stage rows to write");
    assert!(parse_sleep_stages(&l, r.log_id, &null_tz).is_empty());
}

#[test]
fn no_tz_means_no_utc_column() {
    let r = parse_sleep_log(&log(FULL), &null_tz);
    assert_eq!(r.tz, None);
    assert_eq!(
        r.start_time_utc, None,
        "a guessed instant in a UTC column is worse than an absent one"
    );
    assert_eq!(r.end_time_utc, None);
}

#[test]
fn a_known_tz_derives_both_utc_columns_from_the_start_zone() {
    let r = parse_sleep_log(&log(FULL), &|_, _| Some("Europe/Amsterdam".into()));
    assert_eq!(r.tz.as_deref(), Some("Europe/Amsterdam"));
    // May: CEST, UTC+2.
    assert_eq!(r.start_time_utc.as_deref(), Some("2026-05-11 22:06:00"));
    assert_eq!(r.end_time_utc.as_deref(), Some("2026-05-12 05:41:30"));
}

#[test]
fn the_tz_is_asked_per_stage_and_not_once_per_log() {
    let l = log(FULL);
    // The two stages are five minutes apart and get different answers. A parser
    // that resolved the zone once would stamp both with the first.
    let rows = parse_sleep_stages(&l, l.log_id, &|_, time| {
        Some(if time.starts_with("00:06") {
            "Europe/Amsterdam".to_string()
        } else {
            "Europe/London".to_string()
        })
    });
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].tz.as_deref(), Some("Europe/Amsterdam"));
    assert_eq!(rows[1].tz.as_deref(), Some("Europe/London"));
    // CEST is UTC+2, BST is UTC+1 — the derived instants differ accordingly.
    assert_eq!(rows[0].ts_utc.as_deref(), Some("2026-05-11 22:06:00"));
    assert_eq!(rows[1].ts_utc.as_deref(), Some("2026-05-11 23:11:00"));
    // The wall clock is stored verbatim either way.
    assert_eq!(rows[0].ts, "2026-05-12T00:06:00.000");
    assert_eq!(rows[0].stage, "wake");
    assert_eq!(rows[0].duration_seconds, 300);
}

#[test]
fn stages_are_written_under_the_id_they_are_given() {
    // The canonical-id lookup happens in the caller; the parser must not
    // second-guess it and reuse the log's own id.
    let l = log(FULL);
    let rows = parse_sleep_stages(&l, 42, &null_tz);
    assert!(rows.iter().all(|r| r.sleep_log_id == 42));
}
