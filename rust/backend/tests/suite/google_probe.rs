//! The probe's only pure part: does it report shape and never a value?

use backend::google::probe::shape_of;

/// A value must never reach the readout — the output goes to a pod log, and a
/// log is no place for a heart rate.
#[test]
fn reports_key_paths_and_no_values() {
    let v = serde_json::json!({
        "weight": { "weightGrams": 68300, "sampleTime": { "physicalTime": "2026-08-18T07:12:00Z" } }
    });
    let got = shape_of(&v);
    assert_eq!(
        got,
        vec![
            "weight.sampleTime.physicalTime: string".to_string(),
            "weight.weightGrams: number".to_string()
        ]
    );
    let joined = got.join(" ");
    assert!(!joined.contains("68300"), "a value leaked: {joined}");
    assert!(!joined.contains("2026-08-18"), "a value leaked: {joined}");
}

/// An array reports its element's shape, taken from the first element.
#[test]
fn array_reports_its_elements_shape() {
    let v = serde_json::json!({ "stages": [ { "stage": "REM", "minutes": 42 } ] });
    assert_eq!(
        shape_of(&v),
        vec![
            "stages[].minutes: number".to_string(),
            "stages[].stage: string".to_string()
        ]
    );
}

/// A quoted number must report `string`: `as_f64()` treats `"62"` like an
/// absent field, which hid Google's resting heart rate. The live API mixes
/// types in one object (`date.year` a number, `beatsPerMinute` a string).
#[test]
fn a_quoted_number_reports_as_a_string_not_a_number() {
    let v = serde_json::json!({
        "dailyRestingHeartRate": { "beatsPerMinute": "62", "date": { "year": 2026 } }
    });
    assert_eq!(
        shape_of(&v),
        vec![
            "dailyRestingHeartRate.beatsPerMinute: string".to_string(),
            "dailyRestingHeartRate.date.year: number".to_string()
        ]
    );
}

/// Naming the type must not start naming the value — the readout still goes
/// to a pod log.
#[test]
fn the_type_annotation_leaks_no_reading() {
    let v = serde_json::json!({ "hr": { "bpm": 62, "note": "resting" } });
    let joined = shape_of(&v).join(" ");
    assert!(!joined.contains("62"), "a value leaked: {joined}");
    assert!(!joined.contains("resting"), "a value leaked: {joined}");
}

/// An empty array must differ from an absent field: "carried nothing" and "has
/// no such field" answer the migration question differently.
#[test]
fn an_empty_array_is_not_silence() {
    let v = serde_json::json!({ "stages": [] });
    assert_eq!(shape_of(&v), vec!["stages[] (empty)".to_string()]);
}

/// A date is found by shape, wherever the type happens to nest it — each type
/// uses its own key, so a path table would be a list of guesses.
#[test]
fn finds_a_date_under_any_key() {
    use backend::google::probe::date_of;
    let v = serde_json::json!({
        "dailyRestingHeartRate": { "beatsPerMinute": 52, "date": {"year": 2022, "month": 4, "day": 8} }
    });
    assert_eq!(date_of(&v), Some("2022-04-08".to_string()));
}

/// Zero-padded. `Y-4-8` sorts after `Y-12-01` as a string and would
/// misreport which end of the series is the oldest.
#[test]
fn a_date_is_zero_padded() {
    use backend::google::probe::date_of;
    let v = serde_json::json!({ "x": { "date": {"year": 2022, "month": 12, "day": 1} } });
    assert_eq!(date_of(&v), Some("2022-12-01".to_string()));
}

/// No date is None, not a fabricated one.
#[test]
fn no_date_is_none() {
    use backend::google::probe::date_of;
    assert_eq!(date_of(&serde_json::json!({"a": {"b": 1}})), None);
}
