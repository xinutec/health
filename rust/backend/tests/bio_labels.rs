//! `biolabels` — the cadence passes, exercised rather than probed (#1424).
//!
//! # Why this is not the probe it resembles
//!
//! `tests/lean_serve.rs` also sends `{"mode":"biolabels"}`, and #1003's check
//! deliberately does NOT count it: that test asserts the arm answers in its own
//! words and is indifferent to the answer, which is the whole of hop 1. This
//! one asserts what the pass DECIDES. That difference is the point — a
//! `#guard`-pinned port can be correct and never run, and a guard cannot fail
//! for a parameter that does not exist yet, which is how `pickWinningAmenity`
//! drifted for nine days.
//!
//! # Every rule is bracketed
//!
//! Each decision below is asserted against a near-identical input that differs
//! in ONE field and decides the other way. A test that only ever sees a flip
//! cannot tell a working rule from one that flips everything.
//!
//! ⚠ ONE `#[test]`, for the reason `tests/lean_ffi.rs` gives: `lean::init()`
//! starts a runtime and several tests racing on it would flake.

use backend::fold_payload::bits;
use serde_json::{Value, json};

/// A segment on the `biolabels` wire, as `parseLabelSeg` reads it.
fn seg(start: i64, end: i64, mode: &str, refined: Option<&str>, kinds: &[&str], avg: f64) -> Value {
    json!({
        "startTs": start,
        "endTs": end,
        "mode": mode,
        "refinedMode": refined,
        "kinds": kinds,
        "avgSpeed": bits(avg),
        "maxSpeed": bits(avg + 2.0),
        "linearity": bits(0.9),
        "pointCount": 30,
    })
}

/// Per-minute pedometer rows over `[from, to]`, `spm` steps in each.
///
/// ⚠ Runs PAST `to`: `hasFreshData` requires a reading at or after the
/// segment's end, so steps that stop at the boundary make the pass decline for
/// a reason that has nothing to do with cadence.
fn steps(from: i64, to: i64, spm: f64) -> Vec<Value> {
    let mut v = Vec::new();
    let mut t = from;
    while t <= to + 120 {
        v.push(json!([t, bits(spm)]));
        t += 60;
    }
    v
}

fn run(pass: &str, segs: &[Value], steps: &[Value]) -> Vec<Value> {
    let req = json!({ "mode": "biolabels", "pass": pass, "segs": segs, "steps": steps });
    let out = backend::lean::serve(&req.to_string()).expect("biolabels must answer");
    let v: Value = serde_json::from_str(&out).expect("the reply parses");
    assert!(v.get("error").is_none(), "{pass}: {v}");
    v["decisions"]
        .as_array()
        .unwrap_or_else(|| panic!("{pass}: no decisions in {v}"))
        .clone()
}

#[test]
fn the_cadence_passes_decide_what_their_rules_say() {
    backend::lean::init().expect("the Lean runtime must start");

    // ── cadence: a slow walk the pedometer does not corroborate is a ride ────
    // Ten minutes, pedestrian speed, one step a minute. WALKING_MIN_CADENCE is
    // 5, so this is under it.
    let (s, e) = (1_000_000, 1_000_600);
    let slow = run(
        "cadence",
        &[seg(s, e, "walking", None, &[], 4.0)],
        &steps(s, e, 1.0),
    );
    let d = &slow[0];
    assert!(!d.is_null(), "one step a minute over ten minutes must flip");
    assert_eq!(d[0], "driving", "the flip is to driving: {d}");
    assert_eq!(
        d[2], "low-cadence",
        "and it is tagged so revert can find it: {d}"
    );

    // The bracket: the SAME segment, walked properly. Only the cadence differs.
    let brisk = run(
        "cadence",
        &[seg(s, e, "walking", None, &[], 4.0)],
        &steps(s, e, 90.0),
    );
    assert!(
        brisk[0].is_null(),
        "90 steps a minute is a walk, got {}",
        brisk[0]
    );

    // Too short to judge: CADENCE_CORRECTION_MIN_DURATION_S is 180 s.
    let brief = run(
        "cadence",
        &[seg(s, s + 120, "walking", None, &[], 4.0)],
        &steps(s, s + 120, 1.0),
    );
    assert!(
        brief[0].is_null(),
        "under three minutes must not flip, got {}",
        brief[0]
    );

    // Too fast to be a walk at all, so the pass declines rather than flipping:
    // WALKING_MAX_SPEED_KMH is 15.
    let fast = run(
        "cadence",
        &[seg(s, e, "walking", None, &[], 40.0)],
        &steps(s, e, 1.0),
    );
    assert!(
        fast[0].is_null(),
        "40 km/h is not the cadence pass's business, got {}",
        fast[0]
    );

    // ── revert: a flip with no vehicular context is an under-recorded walk ───
    // CADENCE_REVERT_PEDESTRIAN_AVG_KMH is 7, so 4 km/h is pedestrian-paced.
    let flipped = seg(s, e, "walking", Some("driving"), &["low-cadence"], 4.0);
    let alone = run(
        "revert",
        &[
            seg(s - 900, s - 60, "stationary", None, &[], 0.0),
            flipped.clone(),
            seg(e + 60, e + 900, "stationary", None, &[], 0.0),
        ],
        &[],
    );
    assert!(
        !alone[1].is_null(),
        "an isolated pedestrian flip must revert"
    );
    assert_eq!(alone[1][0], "walking", "reverted to walking: {}", alone[1]);
    assert!(
        alone[0].is_null() && alone[2].is_null(),
        "the neighbours are untouched"
    );

    // The bracket: one neighbour is real driving, so the flip keeps its ride.
    let beside_a_drive = run(
        "revert",
        &[
            seg(s - 900, s - 60, "driving", None, &[], 30.0),
            flipped.clone(),
            seg(e + 60, e + 900, "stationary", None, &[], 0.0),
        ],
        &[],
    );
    assert!(
        beside_a_drive[1].is_null(),
        "adjacent real driving vouches for the flip, got {}",
        beside_a_drive[1]
    );

    // ⚠ And a SIBLING FLIP MUST NOT VOUCH — otherwise a run of flips would
    // vouch for each other and none would ever revert. This is the rule
    // `isRealDrive` exists for, and it is the one a careless refactor loses.
    let beside_a_flip = run(
        "revert",
        &[
            seg(
                s - 900,
                s - 60,
                "walking",
                Some("driving"),
                &["low-cadence"],
                4.0,
            ),
            flipped,
            seg(e + 60, e + 900, "stationary", None, &[], 0.0),
        ],
        &[],
    );
    assert!(
        !beside_a_flip[1].is_null(),
        "a sibling cadence flip is not evidence of driving, got keep"
    );
}
