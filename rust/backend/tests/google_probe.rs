//! The probe's only pure part: does it report SHAPE and never a value? (#260)

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
            "weight.sampleTime.physicalTime".to_string(),
            "weight.weightGrams".to_string()
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
        vec!["stages[].minutes".to_string(), "stages[].stage".to_string()]
    );
}

/// ⚠ An empty array must be DISTINGUISHABLE from an absent field. "the type
/// exists but carried nothing" and "the type does not have this field" are
/// different answers to the migration question, and a readout that renders both
/// as silence cannot be acted on.
#[test]
fn an_empty_array_is_not_silence() {
    let v = serde_json::json!({ "stages": [] });
    assert_eq!(shape_of(&v), vec!["stages[] (empty)".to_string()]);
}
