//! The battery trace's marshalling, on synthetic rows.
//!
//! The corpus check lives in `head_corpus.rs` and needs both the golden days
//! and a Node-produced oracle. This one needs neither, and covers the case the
//! corpus CANNOT: a PhoneTrack row with no `battery` key at all.
//!
//! ⚠ That gap is measured, not assumed. Sending `0` instead of `null` for an
//! absent reading left all 42 golden days agreeing, because every row the
//! loader produces carries the key. A branch no fixture reaches is a branch
//! only a written test can hold.
//!
//! The ALGORITHM is not under test here — `Verified.Geo.Velocity.batterySeries`
//! is `#guard`ed against the Node references and `velocity-refs.mts` runs every
//! verify. What is under test is which rows cross the wire and how.

use backend::head::battery_series;
use serde_json::{Value, json};

fn rows(v: &[Value]) -> Vec<&Value> {
    v.iter().collect()
}

#[test]
fn battery_keeps_the_endpoints_of_a_constant_run() {
    let v = vec![
        json!({"ts": 100, "battery": 80}),
        json!({"ts": 160, "battery": 80}),
        json!({"ts": 220, "battery": 80}),
        json!({"ts": 280, "battery": 79}),
    ];
    let out = battery_series(&rows(&v), None, 1_000).expect("the series builds");
    // The middle of a flat run collapses; the chart still draws the flat line
    // from its two endpoints, and the step at 280 survives.
    assert_eq!(out, vec![(100, 80), (220, 80), (280, 79)]);
}

#[test]
fn battery_drops_a_missing_reading() {
    // ⚠ NO `battery` KEY on the middle row — the case no golden fixture has.
    // It must vanish from the series, not arrive as a level of 0, which would
    // draw a cliff to zero and back on the chart.
    let v = vec![
        json!({"ts": 100, "battery": 80}),
        json!({"ts": 160}),
        json!({"ts": 220, "battery": 60}),
    ];
    let out = battery_series(&rows(&v), None, 1_000).expect("the series builds");
    assert_eq!(out, vec![(100, 80), (220, 60)]);
}

#[test]
fn battery_drops_an_explicit_null_reading() {
    let v = vec![
        json!({"ts": 100, "battery": 80}),
        json!({"ts": 160, "battery": Value::Null}),
        json!({"ts": 220, "battery": 60}),
    ];
    let out = battery_series(&rows(&v), None, 1_000).expect("the series builds");
    assert_eq!(out, vec![(100, 80), (220, 60)]);
}

#[test]
fn the_cross_day_tail_interpolates_to_the_day_boundary() {
    let v = vec![
        json!({"ts": 100, "battery": 40}),
        json!({"ts": 200, "battery": 20}),
    ];
    // The phone went idle at 200 and reported 60 at 400, past the day end at
    // 300. The chart should climb halfway to 60 and STOP at the boundary rather
    // than run into the next day.
    let out = battery_series(&rows(&v), Some(&json!({"ts": 400, "level": 60})), 300)
        .expect("the series builds");
    assert_eq!(out, vec![(100, 40), (200, 20), (300, 40)]);
}

#[test]
fn a_tail_that_predates_the_last_reading_is_a_no_op() {
    let v = vec![
        json!({"ts": 100, "battery": 40}),
        json!({"ts": 200, "battery": 20}),
    ];
    let out = battery_series(&rows(&v), Some(&json!({"ts": 150, "level": 90})), 300)
        .expect("the series builds");
    assert_eq!(out, vec![(100, 40), (200, 20)]);
}

#[test]
fn no_tail_leaves_the_series_at_its_last_reading() {
    let v = vec![json!({"ts": 100, "battery": 40})];
    assert_eq!(
        battery_series(&rows(&v), None, 300).expect("the series builds"),
        vec![(100, 40)]
    );
    assert_eq!(
        battery_series(&rows(&v), Some(&Value::Null), 300).expect("the series builds"),
        vec![(100, 40)]
    );
}
