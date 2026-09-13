//! The watch-battery series through the linked Lean host (#982).
//!
//! `Verified.Geo.Velocity`'s `#guard`s settle the shaping — each is what
//! `src/fitbit/watch-battery.ts` produced under Node. These re-ask a few of them
//! across the wire, because the crate links a PREBUILT static library and a mode
//! added to `ServeEntry.lean` is invisible until `ServeEntry:static` is rebuilt.
//!
//! The SQL half has no test here: it needs `device_battery_log` on a real
//! database, and the risk it carries is stated in the module rather than
//! asserted — no `ORDER BY`, and the window applied after the conversion.

use backend::lean;
use serde_json::{Value, json};

const D0: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z
const D1: i64 = D0 + 86_400;

/// `[ts|null, level, deviceVersion|null]`.
fn row(offset: i64, level: i64, device: Option<&str>) -> Value {
    json!([D0 + offset, level, device])
}

fn watch(rows: &[Value]) -> Vec<(i64, i64)> {
    lean::watch_battery_series(rows, D0, D1)
        .expect("watchbattery answers")
        .into_iter()
        .map(|(ts, l)| (ts - D0, l))
        .collect()
}

#[test]
fn the_phone_pseudo_device_never_reaches_the_watch_series() {
    lean::init().expect("the Lean runtime must start");
    // ⚠ MobileTrack is Fitbit's phone step tracker and reports battery 0.
    // Keeping it draws the watch flat-lining at empty all day.
    let got = watch(&[
        row(100, 0, Some("MobileTrack")),
        row(200, 90, Some("Charge 5")),
    ]);
    assert_eq!(got, [(200, 90)]);

    // An untagged row is an UNKNOWN device, not the phone — it stays.
    assert_eq!(watch(&[row(100, 90, None)]), [(100, 90)]);
}

#[test]
fn the_window_is_half_open_and_readings_are_sorted() {
    lean::init().expect("the Lean runtime must start");
    let got = watch(&[
        row(-1, 99, Some("Charge 5")),
        row(86_400, 49, Some("Charge 5")),
        row(86_399, 50, Some("Charge 5")),
        row(0, 90, Some("Charge 5")),
    ]);
    // The start instant is in, the end instant is out; the table is unordered.
    assert_eq!(got, [(0, 90), (86_399, 50)]);
}

#[test]
fn a_flat_run_collapses_but_a_returning_level_is_a_real_step() {
    lean::init().expect("the Lean runtime must start");
    let flat = watch(&[
        row(100, 90, None),
        row(200, 90, None),
        row(300, 90, None),
        row(400, 85, None),
    ]);
    assert_eq!(
        flat,
        [(100, 90), (400, 85)],
        "a flat step needs only its start"
    );

    // ⚠ Compared against the previous KEPT sample only, never the whole series.
    let returns = watch(&[row(100, 90, None), row(200, 85, None), row(300, 90, None)]);
    assert_eq!(returns, [(100, 90), (200, 85), (300, 90)]);
}

#[test]
fn two_devices_at_one_instant_keep_the_later_row_in_input_order() {
    lean::init().expect("the Lean runtime must start");
    // ⚠ This is the ROW ORDER of the result set, not a rule about which device
    // is right — which is why the query must not gain an `ORDER BY`.
    assert_eq!(
        watch(&[row(100, 90, None), row(100, 70, None)]),
        [(100, 70)]
    );
    assert_eq!(
        watch(&[row(100, 70, None), row(100, 90, None)]),
        [(100, 90)]
    );
}

#[test]
fn an_unresolved_wall_clock_is_dropped_rather_than_defaulted() {
    lean::init().expect("the Lean runtime must start");
    // A reading at a guessed instant would draw a step that never happened.
    let got = watch(&[json!([Value::Null, 90, "Charge 5"]), row(200, 85, None)]);
    assert_eq!(got, [(200, 85)]);
}

#[test]
fn a_day_with_nothing_in_it_has_no_series() {
    lean::init().expect("the Lean runtime must start");
    assert!(watch(&[]).is_empty());
    assert!(watch(&[row(-10, 90, None), row(86_410, 80, None)]).is_empty());
}
