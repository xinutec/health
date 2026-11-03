//! The frontier an incremental decode would start from, logged per decode.

use backend::decode_frontier::{Frontier, compare, day_wide_moved, keep, prev_path};
use serde_json::{Value, json};

const START: i64 = 1_784_156_400;

fn req(fix_minutes: &[i64]) -> Value {
    json!({
        "observation": {
            "startUtc": START,
            "points": fix_minutes.iter().map(|m| json!({
                "ts": START + m * 60 + 5, "lat": 51.5, "lon": -0.1, "speedKmh": 0.0,
                "accuracyM": null
            })).collect::<Vec<_>>(),
            "hr": [], "steps": [], "sleep": [],
            "localCtx": vec![json!([0, 0]); 1440],
            "proximity": [],
            "imputeCadence": false,
        },
        "edges": [], "nodes": [], "places": [], "placeNearLine": [],
        "railStopRelations": null, "continuity": null, "flags": {}, "tz": "Europe/London",
    })
}

#[test]
fn a_new_fix_moves_the_frontier_back_over_the_dark_minutes_before_it() {
    let dir = std::env::temp_dir().join(format!("decode-frontier-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (user, date, code) = ("u", "2026-07-15", "abc+v17");
    let cmp = |r: &Value| compare(&dir, user, date, code, r).unwrap();
    assert_eq!(cmp(&req(&[0])), Frontier::NoPrevious);
    keep(&dir, user, date, code, &req(&[0])).unwrap();
    assert_eq!(cmp(&req(&[0])), Frontier::Unchanged);
    // Minutes 1–599 are dark; the fix at 600 becomes their next fix.
    assert_eq!(cmp(&req(&[0, 600])), Frontier::Minute(1));
    let mut moved = req(&[0]);
    moved["edges"] = json!([{"id": "way:1"}]);
    assert_eq!(cmp(&moved), Frontier::DayWide(vec!["edges"]));
    assert_eq!(
        compare(&dir, user, date, "def+v17", &req(&[0])).unwrap(),
        Frontier::CodeChanged
    );
    // An earlier day's file goes once a later day is kept.
    keep(&dir, user, "2026-07-14", code, &req(&[0])).unwrap();
    assert!(prev_path(&dir, user, "2026-07-14").exists());
    keep(&dir, user, date, code, &req(&[0])).unwrap();
    assert!(!prev_path(&dir, user, "2026-07-14").exists());
    assert!(prev_path(&dir, user, date).exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn only_the_inputs_outside_the_rows_count_as_day_wide() {
    let a = req(&[0]);
    let mut b = req(&[0, 600]);
    assert!(day_wide_moved(&a, &b).is_empty());
    b["places"] = json!([{"id": 1}]);
    b["tz"] = json!("Europe/Paris");
    assert_eq!(day_wide_moved(&a, &b), vec!["places", "tz"]);
}
