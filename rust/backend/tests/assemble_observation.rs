//! `assemblesegments` building the observation tensor itself (#982, #411).
//!
//! ⚠ THIS FILE EXISTS BECAUSE ITS ABSENCE WAS THE DEFECT. `decode-day` shipped
//! with a request that `assemblesegments` could never accept — it sent
//! `head::capture`'s `obs`, the DAY TENANT's object, where the decoder wants a
//! tensor. It compiled, CI was green, and every production run failed with
//! `array expected`. There was a test for the date window and none for the
//! request, so nothing could catch it.
//!
//! ⚠ THE TENSOR MUST NOT CROSS THE WIRE. Lean builds it from the day's fixes and
//! two small lookup tables; shipping the 1440 rows instead is the 33-40 MiB per
//! day #411 measures.

use backend::lean;

fn setup() {
    lean::init().expect("the Lean runtime must start");
}

const T0: i64 = 1_000_000;

/// 1440 `[hourLocal, dayOfWeek]` pairs — the timezone resolution the shell owns
/// because it is not pure.
fn local_ctx() -> Vec<[i64; 2]> {
    (0..1440).map(|m| [(m / 60) % 24, 1]).collect()
}

fn request(observation: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "observation": observation,
        "edges": [], "places": [], "nodes": null, "continuity": null,
        "flags": { "reacquireRobust": true, "segEvidence": true, "chainContext": true },
        "maxD": 30,
    })
}

/// The same request with no `maxD` at all — what `decode-day` sends.
fn request_default_max_d(observation: serde_json::Value) -> serde_json::Value {
    let mut r = request(observation);
    r.as_object_mut().unwrap().remove("maxD");
    r
}

fn observation(proximity: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "startUtc": T0,
        "points": [
            { "ts": T0 + 30, "lat": 51.5, "lon": -0.1, "speedKmh": 0.0 },
            { "ts": T0 + 90, "lat": 51.6, "lon": -0.1, "speedKmh": 40.0 },
        ],
        "hr": [{ "ts": T0 + 30, "bpm": 60.0 }],
        "steps": [{ "ts": T0 + 30, "steps": 10.0 }],
        "sleep": [],
        "localCtx": local_ctx(),
        "proximity": proximity,
        "imputeCadence": true,
    })
}

#[test]
fn a_day_decodes_from_raw_materials_with_no_tensor_on_the_wire() {
    setup();
    let segs = lean::assemble_segments(&request(observation(serde_json::json!([
        [T0, 12.5, null],
        [T0 + 60, null, 8.0]
    ]))))
    .expect("assemblesegments")
    .expect("a viable path");
    let arr = segs.as_array().expect("segments is an array");
    assert!(!arr.is_empty(), "a day with fixes must produce segments");
    // Segments are contiguous and ordered — the grouping is Lean's and this
    // pins that it survives the wire.
    for w in arr.windows(2) {
        assert_eq!(
            w[0]["endTs"], w[1]["startTs"],
            "segments must abut: {:?} then {:?}",
            w[0], w[1]
        );
    }
}

/// ⚠ A MINUTE ABSENT FROM `proximity` IS "not known to be near either", NOT
/// "far from both". An empty table must decode, because a day whose OSM lookups
/// all failed still has a timeline.
#[test]
fn an_empty_proximity_table_still_decodes() {
    setup();
    let segs = lean::assemble_segments(&request(observation(serde_json::json!([]))))
        .expect("assemblesegments")
        .expect("a viable path");
    assert!(!segs.as_array().unwrap().is_empty());
}

/// ⚠ THE LOOKUP TABLE IS EXACTLY ONE DAY. A short one would silently index out
/// of range for every later minute, and the failure would look like a decode
/// problem rather than a caller problem.
#[test]
fn a_short_local_ctx_is_refused_by_name() {
    setup();
    let mut obs = observation(serde_json::json!([]));
    obs["localCtx"] = serde_json::json!(vec![[0, 1]; 100]);
    let err = lean::assemble_segments(&request(obs))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("localCtx has 100 rows, not 1440"),
        "the error must name the table and both counts, got: {err}"
    );
}

/// ⚠ The two input forms are NOT interchangeable, and `head::capture`'s `obs` is
/// neither of them. This is the exact request decode-day was sending.
#[test]
fn the_day_tenant_obs_object_is_refused() {
    setup();
    let err = lean::assemble_segments(&serde_json::json!({
        "obs": { "points": [], "rawFixes": [], "steps": [], "hr": [], "sleep": [] },
        "edges": [], "places": [],
    }))
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("array expected"),
        "the day tenant's obs OBJECT must not be mistaken for a tensor, got: {err}"
    );
}

/// ⚠ `maxD` IS THE MODEL'S, NOT THE CALLER'S. It is the depth of the
/// `O(T·S·maxD)` trellis every arm has to agree on, so an absent one takes
/// `Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION` rather than a number the shell
/// spelled — the shell has no basis for an opinion about it, and a second copy in
/// Rust is a second thing to drift. This pins the default against the TypeScript
/// twin, `DEFAULT_MAX_DURATION` in `src/hmm/hsmm-viterbi.ts`, while that twin
/// still exists to compare with (#975).
#[test]
fn an_absent_max_d_is_the_models_own_240() {
    setup();
    let obs = || observation(serde_json::json!([[T0, 12.5, null]]));
    let dflt = lean::assemble_segments(&request_default_max_d(obs())).expect("assemblesegments");
    let mut explicit = request(obs());
    explicit["maxD"] = serde_json::json!(240);
    assert_eq!(
        dflt,
        lean::assemble_segments(&explicit).expect("assemblesegments"),
        "omitting maxD must decode exactly as 240 does"
    );
    // And it is genuinely the default rather than a value ignored: a different
    // depth is a different decode, so the equality above is not vacuous.
    let mut short = request(obs());
    short["maxD"] = serde_json::json!(2);
    assert_ne!(
        dflt,
        lean::assemble_segments(&short).expect("assemblesegments"),
        "maxD must still be honoured when it is sent"
    );
}

/// ⚠ A PROXIMITY VALUE THE DECODER CANNOT READ IS A REFUSAL, NOT A NULL. This is
/// the worst failure available on this path: swallowed, the day decodes, every
/// segment looks plausible, and the decoder simply never learned that any fix
/// was on a railway — and it would take a ground-truth audit to notice. It is
/// also what makes the bit-pattern test in `minute_proximity.rs` an actual test:
/// with the bits support removed the table parses to nothing, and without this
/// refusal that removal is invisible.
#[test]
fn an_unreadable_proximity_distance_is_refused_by_name() {
    setup();
    let err = lean::assemble_segments(&request(observation(serde_json::json!([[
        T0,
        "not-a-number",
        null
    ]]))))
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("not a float bit pattern"),
        "the error must name what could not be read, got: {err}"
    );
}
