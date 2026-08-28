//! The rollup's civil-day keying and its chunking arithmetic (#260).
//!
//! ⚠ The HTTP half is not tested here — it needs the live API. What IS testable
//! is the part that silently files data on the wrong day, which is the failure
//! that would survive a green build and show up as a chart shifted by one.

use backend::google::health::{DailyValue, day_of_rollup_point};

/// ⚠ THE DAY IS `civilStartTime`. The rollup also carries `civilEndTime`, which
/// for a one-day window is the FOLLOWING midnight — the exclusive bound. Keying
/// on it files every value one day late, and a whole series shifted by one still
/// looks like plausible data.
#[test]
fn the_day_is_the_start_not_the_end() {
    let pt = serde_json::json!({
        "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 13 } },
        "civilEndTime":   { "date": { "year": 2026, "month": 8, "day": 14 } },
        "steps": { "countSum": 9134 }
    });
    assert_eq!(
        day_of_rollup_point(&pt, "/steps/countSum"),
        Some(DailyValue {
            date: "2026-08-13".to_string(),
            value: 9134.0
        })
    );
}

/// Zero-padded, or a string sort puts 2026-8-9 before 2026-12-01.
#[test]
fn the_date_is_zero_padded() {
    let pt = serde_json::json!({
        "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 9 } },
        "steps": { "countSum": 1 }
    });
    assert_eq!(
        day_of_rollup_point(&pt, "/steps/countSum").map(|d| d.date),
        Some("2026-08-09".to_string())
    );
}

/// A point missing the summed field is DROPPED, not defaulted to zero. A zero
/// step count is a real reading; an absent one is not, and writing 0 would turn
/// a gap into a claim that the day was sedentary.
#[test]
fn an_absent_sum_is_not_zero() {
    let pt = serde_json::json!({
        "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 13 } },
        "steps": {}
    });
    assert_eq!(day_of_rollup_point(&pt, "/steps/countSum"), None);
}

/// Each type names its own summed field; the pointer is the caller's.
#[test]
fn the_sum_field_is_per_type() {
    let pt = serde_json::json!({
        "civilStartTime": { "date": { "year": 2026, "month": 8, "day": 13 } },
        "distance": { "millimetersSum": 4321.0 }
    });
    assert_eq!(
        day_of_rollup_point(&pt, "/distance/millimetersSum").map(|d| d.value),
        Some(4321.0)
    );
}

/// ⚠ Google quotes some numeric fields and not others, per FIELD rather than per
/// stream. `dailyRestingHeartRate.beatsPerMinute` is a string; 1258 points were
/// silently dropped by `as_f64()` and the stream reported as zero days, which
/// reads as "Google does not carry resting heart rate".
#[test]
fn a_quoted_number_is_read_not_dropped() {
    use backend::google::health::numeric;
    assert_eq!(numeric(&serde_json::json!("62")), Some(62.0));
    assert_eq!(numeric(&serde_json::json!("62.5")), Some(62.5));
    assert_eq!(numeric(&serde_json::json!(62)), Some(62.0));
    assert_eq!(numeric(&serde_json::json!(62.5)), Some(62.5));
}

/// ⚠ AND THE CONVERSE, or this is a permissive fallback rather than a fix. A
/// value we cannot read is not a value we may guess.
#[test]
fn a_non_numeric_value_is_still_dropped() {
    use backend::google::health::numeric;
    assert_eq!(numeric(&serde_json::json!("not a number")), None);
    assert_eq!(numeric(&serde_json::json!("")), None);
    assert_eq!(numeric(&serde_json::json!(null)), None);
    assert_eq!(numeric(&serde_json::json!({"a": 1})), None);
    assert_eq!(numeric(&serde_json::json!([1])), None);
}
