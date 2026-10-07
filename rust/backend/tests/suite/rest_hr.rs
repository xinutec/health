//! `resthr` — heart rate awake and at rest, exercised through the serve path
//! the route and the CLI use (`backend::lean::serve`), with each rule bracketed
//! by an input that differs in one thing and decides the other way.
//!
//! ⚠ ONE `#[test]`, for the reason `tests/lean_ffi.rs` gives: `lean::init()`
//! starts a runtime and several tests racing on it would flake.

use serde_json::{Value, json};

/// One sample a minute at `bpm` for minutes `[a, b)`.
fn flat(a: i64, b: i64, bpm: i64) -> Vec<Value> {
    (a..b).map(|m| json!([m * 60, bpm])).collect()
}

/// A field as a number: Lean writes a whole float as `60`, not `60.0`.
fn num(d: &Value, k: &str) -> Option<f64> {
    d[k].as_f64()
}

fn ask(samples: &[Value], steps: &[i64], sleep: &[(i64, i64)]) -> Value {
    let req = json!({
        "mode": "resthr", "samples": samples, "steps": steps,
        "sleep": sleep.iter().map(|&(s, e)| json!([s, e])).collect::<Vec<_>>(),
        "dayStart": 0, "dayEnd": 100_000,
    });
    let out = backend::lean::serve(&req.to_string()).expect("resthr must answer");
    let v: Value = serde_json::from_str(&out).expect("resthr answers JSON");
    v["day"].clone()
}

#[test]
fn rest_heart_rate_counts_only_settled_awake_still_minutes() {
    backend::lean::init().expect("the Lean runtime must start");
    let night = [(100_000, 100_060)];

    // 25 still minutes: 5 settle, four 5-minute blocks.
    let d = ask(&flat(0, 25, 60), &[], &night);
    assert_eq!(num(&d, "median"), Some(60.0));
    assert_eq!(num(&d, "restMinutes"), Some(20.0));

    // The settling minutes do not count: 70 bpm there leaves the median at 60…
    let mut s = flat(0, 5, 70);
    s.extend(flat(5, 25, 60));
    assert_eq!(num(&ask(&s, &[], &night), "median"), Some(60.0));
    // …while 70 bpm after them moves it.
    let mut s = flat(0, 15, 60);
    s.extend(flat(15, 25, 70));
    assert_ne!(num(&ask(&s, &[], &night), "median"), Some(60.0));

    // A step splits the run below 15 minutes: nothing to measure.
    assert_eq!(ask(&flat(0, 25, 60), &[10], &night), Value::Null);
    // The same step at the run's edge leaves 24 minutes.
    assert_eq!(
        ask(&flat(0, 25, 60), &[24], &night)["restMinutes"],
        json!(15)
    );

    // Sleep covers minutes 0–9: 15 awake minutes remain, two blocks.
    assert_eq!(
        ask(&flat(0, 25, 60), &[], &[(0, 600)])["restMinutes"],
        json!(10)
    );

    // No sleep record: the night would read as rest, so the day is not measured.
    assert_eq!(ask(&flat(0, 25, 60), &[], &[]), Value::Null);

    // A spike is dropped: one 140 among 60s does not move a block.
    let mut s = flat(0, 25, 60);
    s.push(json!([20 * 60 + 30, 140]));
    s.sort_by_key(|v| v[0].as_i64());
    assert_eq!(num(&ask(&s, &[], &night), "p95"), Some(60.0));
}
