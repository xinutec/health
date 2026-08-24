//! `mineCluster` answers, and answers the gates the cron depends on (#982).
//!
//! ⚠ THE POINT IS THAT IT ANSWERS AT ALL. A `match` arm added to
//! `BackendEntry` links against a STALE archive perfectly happily and then
//! replies "unknown op" at runtime — the same shape as `nearbyLandmarks`
//! answering `[]` for every stay while every count read as answered (#1054).
//! A test that only checked the label could pass on a build where the arm does
//! not exist, if the label it expected were `None`.

use backend::lean::{MineStay, mine_cluster};

/// One landmark in the shape `lean::shape_landmarks` ACTUALLY RETURNS.
///
/// ⚠ THE DISTANCE FIELD IS `distanceM`, AND IT IS A BIT-PATTERN STRING. The
/// Lean `shapeLandmarks` export names it `distanceMBits`; the Rust wrapper
/// remaps it to `distanceM` because `DayEntry.parsePoi` and the trace-fed fold
/// read that name. This helper said `distanceMBits` until 2026-08-24 and every
/// test here passed — against a shape the producer never emits. Production
/// then refused every landmark with "a landmark has no distanceMBits", after
/// the cluster half had already answered correctly.
///
/// ⚠ So: build fixtures from what the PRODUCER emits, not from what the
/// consumer's parser happens to accept. A test that invents its own wire
/// format tests its own copy of the wiring, and this one did.
fn lm(name: &str, ty: &str, subtype: &str, dist: f64) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "type": ty,
        "subtype": subtype,
        "distanceM": backend::fold_payload::bits(dist),
        "enclosing": false,
    })
}

fn stay(duration_sec: i64, landmarks: Vec<serde_json::Value>) -> MineStay {
    MineStay {
        start_ts: 1_700_000_000,
        end_ts: 1_700_000_000 + duration_sec,
        local_hour: 13,
        duration_sec,
        // One sample; the venues here carry no `openingHours`, so the fraction
        // is `none` either way and the ranking falls back to distance.
        samples: vec![(0, 780)],
        landmarks: serde_json::Value::Array(landmarks),
    }
}

fn init() {
    backend::lean::init().expect("Lean runtime");
}

#[test]
fn a_long_stay_on_one_venue_takes_the_label() {
    init();
    let cafe = lm("Cafe", "amenity", "cafe", 10.0);
    let out = mine_cluster(
        &[stay(3600, vec![cafe.clone()])],
        &serde_json::json!([cafe]),
    )
    .expect("mineCluster answers");
    assert_eq!(out.amenity_label.as_deref(), Some("Cafe"));
    assert_eq!(out.amenity_kind.as_deref(), Some("cafe"));
    assert_eq!(out.refusal, None);
}

#[test]
fn the_near_field_exemption_survives_the_ffi() {
    init();
    // 10 minutes against a 30-minute floor, but seen from 10 m — inside the
    // 12 m near field. This is the behaviour that was MISSING from Lean for
    // nine days (#1003); pinning it here means the wire carries it too.
    let cafe = lm("Cafe", "amenity", "cafe", 10.0);
    let out = mine_cluster(&[stay(600, vec![cafe.clone()])], &serde_json::json!([cafe]))
        .expect("mineCluster answers");
    assert_eq!(out.amenity_label.as_deref(), Some("Cafe"));

    // The same short stay from 40 m is not exempt, and gate 1 refuses it BY
    // WEIGHT. Naming the gate is the check: a refusal that reported the wrong
    // reason would still produce a null label and look identical.
    let far = lm("Far", "amenity", "cafe", 40.0);
    let out = mine_cluster(&[stay(600, vec![far.clone()])], &serde_json::json!([far]))
        .expect("mineCluster answers");
    assert_eq!(out.amenity_label, None);
    assert_eq!(out.refusal.as_deref(), Some("1-weight"));
}

#[test]
fn the_centroid_gate_refuses_a_venue_that_is_not_at_the_cluster() {
    init();
    let cafe = lm("Cafe", "amenity", "cafe", 10.0);
    let out = mine_cluster(&[stay(3600, vec![cafe])], &serde_json::json!([]))
        .expect("mineCluster answers");
    assert_eq!(out.amenity_label, None);
    assert_eq!(out.refusal.as_deref(), Some("3-centroid"));
}

#[test]
fn an_unambiguous_stay_trains_the_prior_even_when_a_gate_refuses_the_label() {
    init();
    let cafe = lm("Cafe", "amenity", "cafe", 10.0);
    let out = mine_cluster(&[stay(3600, vec![cafe])], &serde_json::json!([]))
        .expect("mineCluster answers");
    assert_eq!(out.amenity_label, None);
    // Attribution and labelling answer different questions.
    assert_eq!(out.attributed.len(), 1);
    assert_eq!(out.attributed[0].subtype, "cafe");
    assert_eq!(out.attributed[0].duration_sec, 3600.0);
    assert_eq!(out.attributed[0].local_hour, 13);
}

#[test]
fn a_park_is_not_label_worthy_however_long_the_stay() {
    init();
    let park = lm("Park", "leisure", "park", 5.0);
    let out = mine_cluster(
        &[stay(7200, vec![park.clone()])],
        &serde_json::json!([park]),
    )
    .expect("mineCluster answers");
    assert_eq!(out.amenity_label, None);
    // ⚠ No vote was ever cast, so there is nothing to refuse. A `1-weight`
    // here would mean the gate-2 filter had let it through and gate 1 caught
    // it instead, which is a different pipeline.
    assert_eq!(out.refusal, None);
}
