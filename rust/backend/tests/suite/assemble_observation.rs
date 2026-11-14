//! `assemblesegments` building the observation tensor itself, from the day's
//! fixes and two small tables: a row-a-minute tensor on the wire is tens of
//! MiB a day. The request is a `Value`, so only a round trip shows a bad shape.

use crate::with_record;
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
    with_record(serde_json::json!({
        "observation": observation,
        "edges": [], "places": [], "nodes": null, "continuity": null,
        "flags": {},
        "maxD": 30,
    }))
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

/// A minute absent from `proximity` is "not known to be near either", not
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

/// A 25-hour day decodes through its last hour: the tensor is as long as
/// `localCtx`, not a fixed 1440 rows.
#[test]
fn a_25_hour_day_is_decoded_to_its_end() {
    setup();
    let mut obs = observation(serde_json::json!([]));
    obs["localCtx"] = serde_json::json!((0..1500).map(|m| [(m / 60) % 24, 1]).collect::<Vec<_>>());
    let segs = lean::assemble_segments(&request(obs))
        .expect("assemblesegments")
        .expect("a viable path");
    let last = segs.as_array().unwrap().last().unwrap()["endTs"]
        .as_i64()
        .unwrap();
    assert!(last > T0 + 1440 * 60, "the last segment ends at {last}");
}

/// The lookup table is one local day, and its length is the tensor's. A table
/// far from 23 to 25 hours is a caller bug, refused here rather than decoded as
/// a short day.
#[test]
fn a_short_local_ctx_is_refused_by_name() {
    setup();
    let mut obs = observation(serde_json::json!([]));
    obs["localCtx"] = serde_json::json!(vec![[0, 1]; 100]);
    let err = lean::assemble_segments(&request(obs))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("localCtx has 100 rows; a local day is 1320 to 1560 minutes"),
        "the error must name the table, its count and the range, got: {err}"
    );
}

/// The two input forms are not interchangeable, and `head::capture`'s `obs` is
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

/// `maxD` is the model's: absent, it takes
/// `Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION`, with no copy in Rust.
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

/// A proximity value the decoder cannot read is a refusal, not a NULL:
/// swallowed, the decoder never learns any fix was on a railway, unnoticed.
/// It also gives `minute_proximity.rs`'s bit-pattern test teeth.
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

/// The station chain runs inside `assemblesegments`, since it reads `obs`. Its
/// fields are absent, not null, where the resolver did not reach;
/// `segments_json` is compared as text, which a `jq` diff would not see.
#[test]
fn an_unresolved_segment_carries_no_station_keys_at_all() {
    setup();
    let segs = lean::assemble_segments(&request(observation(serde_json::json!([]))))
        .expect("assemblesegments")
        .expect("a viable path");
    let arr = segs.as_array().expect("segments is an array");
    assert!(!arr.is_empty());
    // No edges and no nodes, so nothing can resolve — and every segment must
    // therefore be missing the key, not carrying a null.
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

/// `railStopRelations` absent (never consulted, `servedPen` 0) and `[]`
/// (consulted, nothing) both decode, so an unreachable mirror is not an error.
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

/// The five-station synthetic line the Lean guards use, renamed onto a line
/// the state space actually has: `Test Line` is not in `KNOWN_LINES`, so a
/// decode could never emit it.
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
            #[expect(clippy::cast_precision_loss, reason = "RIDE_MIN is 8; exact")]
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

    with_record(serde_json::json!({
        "observation": {
            "startUtc": T0, "points": points, "hr": [], "steps": [], "sleep": [],
            "localCtx": local_ctx(), "proximity": proximity,
        },
        "edges": edges, "nodes": nodes, "places": [], "placeNearLine": [],
        "continuity": null,
        "railStopRelations": relations,
        "flags": {},
    }))
}

/// The positive case, without which the absent-key test is vacuous: an actual
/// train leg with both stations asserted by name. It relies on the decoder
/// choosing `train`; if a model change breaks it, check that first.
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

    // And only the train leg. A stationary segment is not a leg the chain can
    // resolve, so it carries no key — not a null.
    for s in arr.iter().filter(|s| s["mode"] != "train") {
        let o = s.as_object().unwrap();
        assert!(
            !o.contains_key("boardStation") && !o.contains_key("alightStation"),
            "a non-train segment must carry no station keys: {s}"
        );
    }
}

/// No relations is not no chain: with `servedPen` 0 the resolver still names
/// the stations from the graph.
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
