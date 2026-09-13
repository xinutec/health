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

/// ⚠ THE STATION CHAIN RUNS INSIDE `assemblesegments`, and the alternative was
/// not "a second call" but "a second call carrying the 1440-row tensor" — the
/// `stationchain` mode takes `obs`, so wiring it from the shell would put back
/// on the wire exactly the payload #411 exists to delete.
///
/// ⚠ AND THE FIELDS ARE ABSENT, NOT NULL, WHERE THE RESOLVER DID NOT REACH.
/// The TypeScript ASSIGNS `boardStation`/`alightStation` only at the indices
/// `resolveStationsServed` returned, and `JSON.stringify` omits an `undefined`.
/// `segments_json` is compared as TEXT — a `jq` diff parses both sides and calls
/// them equal — so a null where node writes nothing is a real divergence that
/// the obvious comparison cannot see.
#[test]
fn an_unresolved_segment_carries_no_station_keys_at_all() {
    setup();
    let segs = lean::assemble_segments(&request(observation(serde_json::json!([]))))
        .expect("assemblesegments")
        .expect("a viable path");
    let arr = segs.as_array().expect("segments is an array");
    assert!(!arr.is_empty());
    // No edges and no nodes, so nothing can resolve — and every segment must
    // therefore be missing the KEY, not carrying a null.
    for s in arr {
        let o = s.as_object().unwrap();
        assert!(
            !o.contains_key("boardStation") && !o.contains_key("alightStation"),
            "an unresolved segment must carry no station keys: {s}"
        );
        // The five fields that are always there.
        for k in ["startTs", "endTs", "mode", "placeId", "lineName"] {
            assert!(o.contains_key(k), "{k} is missing from {s}");
        }
    }
}

/// ⚠ `railStopRelations` ABSENT AND `[]` ARE DIFFERENT REQUESTS. Absent means the
/// mirror was never consulted, so every candidate's `servedPen` is 0; empty means
/// it was consulted and had nothing. Both must decode — this pins that neither is
/// an error, which is what a shell that cannot reach the mirror depends on.
#[test]
fn the_two_empty_relation_forms_are_both_accepted() {
    setup();
    for rels in [serde_json::Value::Null, serde_json::json!([])] {
        let mut r = request(observation(serde_json::json!([])));
        r["railStopRelations"] = rels.clone();
        lean::assemble_segments(&r)
            .unwrap_or_else(|e| panic!("railStopRelations {rels} must decode: {e}"))
            .expect("a viable path");
    }
    // And a relation of the shape `classification_inputs::rail_stops_cache`
    // writes — column names checked against `parseRelation`, not assumed.
    let mut r = request(observation(serde_json::json!([])));
    r["railStopRelations"] = serde_json::json!([{
        "osmRelationId": 12345,
        "routeType": "subway",
        "lineRef": "Central",
        "lineName": "Central Line",
        "stops": [{ "name": "Bank", "lat": "0", "lon": "0", "seq": 0 }],
    }]);
    lean::assemble_segments(&r)
        .expect("the cached relation shape must be accepted")
        .expect("a viable path");
}

/// The five-station synthetic line the Lean guards use
/// (`lean/experiments/station-chain-refs.mts`), renamed onto a line the state
/// space actually has — `Test Line` is not in `KNOWN_LINES`, so a decode could
/// never emit it.
mod line {
    pub const LONS: [f64; 5] = [
        0.0,
        0.021_645_543_464_882_695,
        0.043_291_086_929_765_39,
        0.064_936_630_394_648_09,
        0.086_582_173_859_530_78,
    ];
    pub const KEYS: [&str; 5] = [
        "51.50000,0.00000",
        "51.50000,0.02165",
        "51.50000,0.04329",
        "51.50000,0.06494",
        "51.50000,0.08658",
    ];
    pub const NAMES: [&str; 5] = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    pub const NAME: &str = "Central Line";
}

fn ride_request(relations: serde_json::Value) -> serde_json::Value {
    let b = backend::fold_payload::bits;
    let edges: Vec<_> = (0..4)
        .map(|i| {
            serde_json::json!({
                "id": format!("way:{}", 1000 + i),
                "geometry": [
                    { "lat": b(51.5), "lon": b(line::LONS[i]) },
                    { "lat": b(51.5), "lon": b(line::LONS[i + 1]) },
                ],
                "lineMemberships": [line::NAME],
                "underground": true,
                "startNode": line::KEYS[i], "endNode": line::KEYS[i + 1],
            })
        })
        .collect();
    let nodes: Vec<_> = (0..5)
        .map(|i| {
            let mut ids = Vec::new();
            if i > 0 {
                ids.push(format!("way:{}", 999 + i));
            }
            if i < 4 {
                ids.push(format!("way:{}", 1000 + i));
            }
            serde_json::json!({
                "id": line::KEYS[i], "lat": b(51.5), "lon": b(line::LONS[i]),
                "stationName": line::NAMES[i], "edgeIds": ids,
            })
        })
        .collect();
    // An eight-minute run west to east at 45 km/h, hugging the rail and well
    // clear of any road — the evidence the decoder needs to call it a train.
    const RIDE_MIN: i64 = 8;
    let points: Vec<_> = (0..=RIDE_MIN)
        .map(|m| {
            #[allow(clippy::cast_precision_loss)]
            let frac = m as f64 / RIDE_MIN as f64;
            serde_json::json!({
                "ts": T0 + m * 60 + 30, "lat": 51.5,
                "lon": line::LONS[0] + frac * (line::LONS[4] - line::LONS[0]),
                "speedKmh": 45.0,
            })
        })
        .collect();
    let proximity: Vec<_> = (0..=RIDE_MIN)
        .map(|m| serde_json::json!([T0 + m * 60, b(400.0), b(3.0)]))
        .collect();

    serde_json::json!({
        "observation": {
            "startUtc": T0, "points": points, "hr": [], "steps": [], "sleep": [],
            "localCtx": local_ctx(), "proximity": proximity, "imputeCadence": false,
        },
        "edges": edges, "nodes": nodes, "places": [], "placeNearLine": [],
        "continuity": null,
        "railStopRelations": relations,
        "flags": { "reacquireRobust": true, "segEvidence": true, "chainContext": true },
    })
}

/// ⚠ THE POSITIVE CASE, WITHOUT WHICH THE ABSENT-KEY TEST ABOVE IS VACUOUS. A
/// day where nothing resolves would pass that test with the whole chain deleted.
/// This one decodes an actual train leg and asserts the two stations by name, so
/// removing the wiring fails here first.
///
/// ⚠ IT DEPENDS ON THE DECODER CHOOSING `train`, which is a model outcome rather
/// than a wire contract. If a model change breaks this, read it as "the ride no
/// longer decodes as a train" before reading it as a station-chain fault.
#[test]
fn a_decoded_train_leg_carries_its_board_and_alight_stations() {
    setup();
    let segs = lean::assemble_segments(&ride_request(serde_json::json!([{
        "osmRelationId": 1, "routeType": "subway",
        "lineRef": "Central", "lineName": line::NAME,
        "stops": line::NAMES.iter().map(|n| serde_json::json!({ "name": n })).collect::<Vec<_>>(),
    }])))
    .expect("assemblesegments")
    .expect("a viable path");
    let arr = segs.as_array().unwrap();

    let train = arr
        .iter()
        .find(|s| s["mode"] == "train")
        .unwrap_or_else(|| panic!("the ride must decode as a train: {segs}"));
    assert_eq!(train["lineName"], line::NAME);
    assert_eq!(
        train["boardStation"], "Alpha",
        "boarded at the west end: {train}"
    );
    assert_eq!(
        train["alightStation"], "Echo",
        "alighted at the east end: {train}"
    );

    // ⚠ AND ONLY THE TRAIN LEG. A stationary segment is not a leg the chain can
    // resolve, so it carries no key — not a null.
    for s in arr.iter().filter(|s| s["mode"] != "train") {
        let o = s.as_object().unwrap();
        assert!(
            !o.contains_key("boardStation") && !o.contains_key("alightStation"),
            "a non-train segment must carry no station keys: {s}"
        );
    }
}

/// ⚠ NO RELATIONS IS NOT NO CHAIN. Absent `railStopRelations` means every
/// candidate's `servedPen` is 0 — the resolver still runs and still names the
/// stations from the graph. This pins that the mirror being unreachable degrades
/// the answer rather than removing it.
#[test]
fn the_chain_still_resolves_without_the_relation_cache() {
    setup();
    let segs = lean::assemble_segments(&ride_request(serde_json::Value::Null))
        .expect("assemblesegments")
        .expect("a viable path");
    let train = segs
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["mode"] == "train")
        .expect("the ride must still decode as a train");
    assert_eq!(train["boardStation"], "Alpha");
    assert_eq!(train["alightStation"], "Echo");
}
