//! `railfill` through the linked Lean host (#982, #363).
//!
//! `Verified.Geo.RailRouteFill`'s `#guard`s settle whether the SCAN is right —
//! each one is what `src/geo/rail-route-fill.ts` produced under Node. What they
//! cannot settle is whether this process reaches it: the crate links a prebuilt
//! static library, so a mode added to `ServeEntry.lean` is invisible until
//! `lake build ServeEntry:static` has run, and Lean answers `unknown mode`,
//! which reads as a broken mode rather than an absent one.
//!
//! These re-ask the guard cases across the wire, so a failure is about the link
//! or the encoding and never about the decision.

use backend::lean;
use serde_json::{Value, json};

/// `[ts, latBits, lonBits]` — the fix wire form.
fn pt(ts: i64, lat: f64, lon: f64) -> Value {
    json!([ts, lat.to_bits().to_string(), lon.to_bits().to_string()])
}

/// `[mode, refinedMode, startTs, endTs, wayName, hasSnappedPath]`.
fn seg(
    mode: &str,
    refined: Option<&str>,
    start: i64,
    end: i64,
    way: Option<&str>,
    snapped: bool,
) -> Value {
    json!([mode, refined, start, end, way, snapped])
}

fn points() -> Vec<Value> {
    vec![
        pt(100, 51.5, -0.1),
        pt(150, 51.51, -0.11),
        pt(200, 51.52, -0.12),
        pt(300, 51.53, -0.13),
        pt(400, 51.54, -0.14),
    ]
}

/// `(key, startTs, endTs, #fixes)` — the same shape the refs script printed.
fn shape(cs: &[lean::FillCandidate]) -> Vec<(String, i64, i64, usize)> {
    cs.iter()
        .map(|c| (c.key.clone(), c.start_ts, c.end_ts, c.fixes.len()))
        .collect()
}

#[test]
fn a_labelled_unsnapped_train_leg_is_a_candidate_and_the_window_is_inclusive() {
    lean::init().expect("the Lean runtime must start");
    let got = lean::unsnapped_train_routes(
        &[seg("train", None, 100, 200, Some("A → B · L"), false)],
        &points(),
    )
    .expect("railfill answers");
    // ts 100 and ts 200 are BOTH inside [100, 200] — three fixes, not one.
    assert_eq!(shape(&got), [("A → B · L".to_string(), 100, 200, 3)]);
}

#[test]
fn the_refined_mode_decides_in_both_directions() {
    lean::init().expect("the Lean runtime must start");
    let away = lean::unsnapped_train_routes(
        &[seg("train", Some("car"), 100, 200, Some("A → B"), false)],
        &points(),
    )
    .unwrap();
    assert!(
        away.is_empty(),
        "a leg refined AWAY from train is not a candidate"
    );

    let into = lean::unsnapped_train_routes(
        &[seg("car", Some("train"), 100, 200, Some("A → B"), false)],
        &points(),
    )
    .unwrap();
    assert_eq!(shape(&into), [("A → B".to_string(), 100, 200, 3)]);
}

#[test]
fn an_unlabelled_or_already_snapped_leg_is_skipped() {
    lean::init().expect("the Lean runtime must start");
    // No label: the label IS the cache key, so there is nothing to fill.
    let unlabelled =
        lean::unsnapped_train_routes(&[seg("train", None, 100, 200, None, false)], &points())
            .unwrap();
    assert!(unlabelled.is_empty());

    // Already on rails. Re-filling would recompute a row the nightly job owns
    // with better evidence.
    let snapped = lean::unsnapped_train_routes(
        &[seg("train", None, 100, 200, Some("A → B"), true)],
        &points(),
    )
    .unwrap();
    assert!(snapped.is_empty());
}

#[test]
fn legs_sharing_a_key_pool_their_fixes_and_keep_the_first_window() {
    lean::init().expect("the Lean runtime must start");
    let got = lean::unsnapped_train_routes(
        &[
            seg("train", None, 100, 200, Some("A → B"), false),
            seg("train", None, 300, 400, Some("A → B"), false),
        ],
        &points(),
    )
    .unwrap();
    // ⚠ 3 + 2 = 5 fixes, and the window is the FIRST leg's — NOT the union.
    // A union spanning two separate rides would name a journey nobody took.
    assert_eq!(shape(&got), [("A → B".to_string(), 100, 200, 5)]);
}

#[test]
fn the_order_out_is_the_order_the_day_was_walked() {
    lean::init().expect("the Lean runtime must start");
    let got = lean::unsnapped_train_routes(
        &[
            seg("train", None, 300, 400, Some("B → C"), false),
            seg("train", None, 100, 200, Some("A → B"), false),
        ],
        &points(),
    )
    .unwrap();
    // ⚠ Not sorted by key or by time. The queue drains in this order.
    assert_eq!(
        shape(&got),
        [
            ("B → C".to_string(), 300, 400, 2),
            ("A → B".to_string(), 100, 200, 3),
        ]
    );
}

#[test]
fn a_leg_with_no_fixes_in_its_window_is_still_a_candidate() {
    lean::init().expect("the Lean runtime must start");
    let got = lean::unsnapped_train_routes(
        &[seg("train", None, 900, 950, Some("A → B"), false)],
        &points(),
    )
    .unwrap();
    // Thin or absent corridor evidence is the FILL's problem — it refuses
    // rather than guessing. Dropping the leg here would withdraw the one thing
    // that could still route it from the line fallback.
    assert_eq!(shape(&got), [("A → B".to_string(), 900, 950, 0)]);
    assert!(got[0].fixes.is_empty());
}

#[test]
fn an_empty_day_asks_for_nothing() {
    lean::init().expect("the Lean runtime must start");
    assert!(
        lean::unsnapped_train_routes(&[], &points())
            .unwrap()
            .is_empty()
    );
    assert!(lean::unsnapped_train_routes(&[], &[]).unwrap().is_empty());
}
