//! The steps parser's one rule, and its tz handling (#982).
//!
//! The rule is that a zero-step minute is not stored — absence implies zero, and
//! keeping them costs ~5x the rows for no information. The tz half is where it
//! can be wrong quietly: a row whose `tz` is unknown must carry a NULL `ts_utc`
//! rather than a guess, because a guess in a column declared to hold UTC is
//! indistinguishable downstream from a fact.

use backend::fitbit::sync::steps::parse_steps_dataset;

const BODY: &str = r#"{
  "activities-steps": [{"dateTime":"2026-08-17","value":"1234"}],
  "activities-steps-intraday": {"dataset":[
    {"time":"00:00:00","value":0},
    {"time":"08:30:00","value":57},
    {"time":"08:31:00","value":0},
    {"time":"14:30:00","value":12}
  ]}
}"#;

#[test]
fn zero_step_minutes_are_dropped() {
    let rows = parse_steps_dataset(BODY, "2026-08-17", &|_, _| None).unwrap();
    assert_eq!(rows.len(), 2, "only the two non-zero minutes are stored");
    assert_eq!(rows[0].ts, "2026-08-17 08:30:00");
    assert_eq!(rows[0].steps, 57);
    assert_eq!(rows[1].steps, 12);
}

#[test]
fn an_unknown_zone_writes_a_null_ts_utc_rather_than_a_guess() {
    let rows = parse_steps_dataset(BODY, "2026-08-17", &|_, _| None).unwrap();
    for r in &rows {
        assert_eq!(r.tz, None);
        assert_eq!(
            r.ts_utc, None,
            "no zone means no UTC — never a guess in a column declared to hold it"
        );
    }
}

#[test]
fn a_known_zone_derives_ts_utc() {
    let rows = parse_steps_dataset(BODY, "2026-08-17", &|_, _| {
        Some("Europe/London".to_string())
    })
    .unwrap();
    // August is BST, so the wall clock is an hour ahead of UTC.
    assert_eq!(rows[0].ts_utc.as_deref(), Some("2026-08-17 07:30:00"));
    assert_eq!(rows[1].ts_utc.as_deref(), Some("2026-08-17 13:30:00"));
}

#[test]
fn the_zone_is_asked_per_minute_not_per_day() {
    // The forward sync's inference can change within a day — a flight crosses a
    // boundary mid-afternoon. A parser that resolved once per day would stamp
    // the whole day with the morning's zone.
    let rows = parse_steps_dataset(BODY, "2026-08-17", &|_, time| {
        Some(if time.starts_with("08") {
            "Europe/London".to_string()
        } else {
            "Asia/Kolkata".to_string()
        })
    })
    .unwrap();
    assert_eq!(rows[0].tz.as_deref(), Some("Europe/London"));
    assert_eq!(rows[1].tz.as_deref(), Some("Asia/Kolkata"));
    assert_eq!(rows[1].ts_utc.as_deref(), Some("2026-08-17 09:00:00"));
}

#[test]
fn a_response_with_no_intraday_block_is_empty_not_an_error() {
    // Fitbit omits the block entirely for a day the watch was off. That is a
    // genuinely empty day, which the backfill counts toward its empty streak —
    // it must not surface as a failure, which would NOT advance the streak.
    let rows = parse_steps_dataset(
        r#"{"activities-steps":[{"dateTime":"2026-08-17","value":"0"}]}"#,
        "2026-08-17",
        &|_, _| None,
    )
    .unwrap();
    assert!(rows.is_empty());
}
