//! The frontier an incremental decode would start from, logged per decode.

use backend::decode_frontier::{day_wide_moved, note, prev_path};
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
    let (user, date) = ("u", "2026-07-15");
    assert_eq!(
        note(&dir, user, date, &req(&[0])).unwrap(),
        "no previous decode"
    );
    assert_eq!(
        note(&dir, user, date, &req(&[0])).unwrap(),
        "nothing changed"
    );
    // Minutes 1–599 are dark; the fix at 600 becomes their next fix.
    assert_eq!(
        note(&dir, user, date, &req(&[0, 600])).unwrap(),
        "minute 1 of 1440"
    );
    let mut moved = req(&[0, 600]);
    moved["edges"] = json!([{"id": "way:1"}]);
    assert_eq!(
        note(&dir, user, date, &moved).unwrap(),
        "minute 0 (day-wide: edges)"
    );
    // An earlier day's file goes once a later day is written.
    note(&dir, user, "2026-07-14", &req(&[0])).unwrap();
    assert!(prev_path(&dir, user, "2026-07-14").exists());
    note(&dir, user, date, &req(&[0])).unwrap();
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
