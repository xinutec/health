//! `stationchain` — the board/alight resolver, exercised rather than probed
//! (#1424).
//!
//! # Why this is not the probe it resembles
//!
//! `tests/lean_serve.rs` also sends `{"mode":"stationchain"}`, and #1003's check
//! deliberately does not count it: that test asserts the arm answers in its own
//! words and is indifferent to the answer. This one asserts what the resolver
//! DECIDES, including the case where it decides to say nothing.
//!
//! # The geography is INVENTED (#860), and small on purpose
//!
//! One straight line, two or three halts on it. A synthetic corridor makes each
//! refusal below unambiguous — on a real graph, "no resolution" could always be
//! the fixture failing to build rather than the rule firing.
//!
//! ⚠ ONE `#[test]`, for the reason `tests/lean_ffi.rs` gives: `lean::init()`
//! starts a runtime and several tests racing on it would flake.

use serde_json::{Value, json};

const START: i64 = 1_000_000;

/// One observation minute on the line, `i` tenths of the way along it.
fn obs_row(i: i64) -> Value {
    json!({
        "ts": START + i * 60,
        "gps": { "lat": (i as f64 / 10.0) * 0.02, "lon": 0.0, "speedKmh": 60.0 },
        "hr": null, "cadence": null, "hourLocal": 9, "dayOfWeekLocal": 1,
        "inBed": false, "roadDistM": null, "railDistM": 5.0,
        "reacquireAgeMin": null, "prevGpsFix": null, "nextGpsFix": null
    })
}

fn station(id: &str, lat: f64, name: &str) -> Value {
    json!({ "id": id, "lat": lat, "lon": 0.0, "stationName": name, "edgeIds": ["E1"] })
}

/// The request, with `nodes` and `segs` varied per case.
fn request(nodes: Vec<Value>, segs: Vec<Value>, obs: Vec<Value>) -> Value {
    json!({
        "mode": "stationchain",
        "edges": [{
            "id": "E1",
            "geometry": (0..11).map(|i| json!({ "lat": f64::from(i) * 0.002, "lon": 0.0 }))
                .collect::<Vec<_>>(),
            "lineMemberships": ["Test Line"],
            "underground": false,
            "startNode": "N1", "endNode": "N2"
        }],
        "nodes": nodes, "obs": obs, "segs": segs
    })
}

fn two_halts() -> Vec<Value> {
    vec![
        station("N1", 0.0, "Alpha Halt"),
        station("N2", 0.02, "Beta Halt"),
    ]
}

fn all_obs() -> Vec<Value> {
    (0..11).map(obs_row).collect()
}

/// A ridden leg whose timestamps land on observation rows.
fn train_leg() -> Value {
    json!({ "mode": "train", "lineName": "Test Line",
            "startTs": START, "endTs": START + 11 * 60 })
}

fn resolve(req: &Value) -> Vec<Value> {
    let out = backend::lean::serve(&req.to_string()).expect("stationchain must answer");
    let v: Value = serde_json::from_str(&out).expect("the reply parses");
    assert!(v.get("error").is_none(), "{v}");
    v["resolved"]
        .as_array()
        .unwrap_or_else(|| panic!("no `resolved` in {v}"))
        .clone()
}

#[test]
fn the_chain_resolves_a_ride_and_refuses_what_it_cannot_tell_apart() {
    backend::lean::init().expect("the Lean runtime must start");

    // ── 1. A ride between two halts resolves BOTH ends ──────────────────────
    let got = resolve(&request(two_halts(), vec![train_leg()], all_obs()));
    assert_eq!(got.len(), 1, "one leg in, one resolution out: {got:?}");
    assert_eq!(got[0][0], 0, "the resolution carries its segment index");
    assert_eq!(got[0][1], "Alpha Halt", "board");
    assert_eq!(got[0][2], "Beta Halt", "alight");

    // ── 2. TWO PLAUSIBLE ALIGHTS AND IT REFUSES TO GUESS ────────────────────
    // A third halt ~65 m from the far end. The margin between the two alight
    // candidates no longer clears, so the alight comes back NULL while the
    // board — still unambiguous — resolves. This is the whole point of the
    // resolver: a station it cannot tell apart is not reported, and a caller
    // that got a guess here would persist a ride to the wrong platform.
    let mut crowded = two_halts();
    crowded.push(station("N3", 0.0194, "Gamma Halt"));
    let got = resolve(&request(crowded, vec![train_leg()], all_obs()));
    assert_eq!(got.len(), 1, "the leg still resolves as a leg: {got:?}");
    assert_eq!(
        got[0][1], "Alpha Halt",
        "the unambiguous board still resolves"
    );
    assert!(
        got[0][2].is_null(),
        "two candidates within the margin must yield NO alight, got {}",
        got[0][2]
    );

    // ── 3. The four ways a segment is not a ride at all ─────────────────────
    // Each differs from the resolving baseline in ONE field.
    for (why, seg) in [
        (
            "a walk is not a ride",
            json!({ "mode": "walking", "lineName": "Test Line",
                                         "startTs": START, "endTs": START + 11 * 60 }),
        ),
        (
            "an unknown line cannot be routed",
            json!({ "mode": "train",
            "lineName": "unknown_rail", "startTs": START, "endTs": START + 11 * 60 }),
        ),
        (
            "no line name at all",
            json!({ "mode": "train",
            "startTs": START, "endTs": START + 11 * 60 }),
        ),
        // ⚠ The endpoints are looked up BY TIMESTAMP in the observation rows
        // (`startTs`, and `endTs - 60`). A leg whose ends fall between rows has
        // no pair and is skipped — silently, which is why it is pinned here.
        (
            "endpoints off the observation grid",
            json!({ "mode": "train",
            "lineName": "Test Line", "startTs": START + 13, "endTs": START + 11 * 60 }),
        ),
    ] {
        let got = resolve(&request(two_halts(), vec![seg], all_obs()));
        assert!(got.is_empty(), "{why}: expected no resolution, got {got:?}");
    }

    // ── 4. No observations is a well-defined nothing, not an error ──────────
    let got = resolve(&request(two_halts(), vec![train_leg()], vec![]));
    assert!(got.is_empty(), "no obs, nothing to resolve: {got:?}");
}
