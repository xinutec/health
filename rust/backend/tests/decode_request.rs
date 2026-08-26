//! The `assemblesegments` request `decode-day` actually sends (#982).
//!
//! ⚠ THIS FILE EXISTS BECAUSE THE REQUEST SHIPPED WRONG TWICE, in the same way
//! both times: a field whose SHAPE was never checked. First `obs`, where
//! `head::capture`'s day-tenant object was sent in place of the observation
//! tensor; then `places`, where `focus_places` ROWS were sent in place of the
//! decoder's places. Both compiled. Both passed CI. Both failed on the first
//! production run — the second only because the first was fixed and the run got
//! far enough to reach it.
//!
//! The pattern is worth naming: every field on this wire is `serde_json::Value`,
//! so nothing on the Rust side can tell a wrong shape from a right one. Lean
//! refuses by name, which is the only check there is — and it only runs if
//! something sends a realistic request.

use backend::classification_inputs::decode_places;
use backend::lean;

fn setup() {
    lean::init().expect("the Lean runtime must start");
}

/// A `knownPlaces` row exactly as `classification_inputs::known_places` writes
/// it — column names, not concept names.
fn known_row(id: i64, lat: f64, lon: f64) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "centroidLat": lat,
        "centroidLon": lon,
        "radiusM": 25.0,
        "displayName": "Home",
        "sleepHours": 0.0,
        "amenityLabel": serde_json::Value::Null,
        "uniqueDays": 3,
        "hourProfile": serde_json::Value::Null,
        "totalDwellSec": 3600.0,
        "visitCount": 2,
    })
}

fn request(places: serde_json::Value, place_near_line: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "obs": [],
        "edges": [], "nodes": null, "continuity": null,
        "places": places,
        "placeNearLine": place_near_line,
        "flags": { "reacquireRobust": true, "segEvidence": true, "chainContext": true },
    })
}

/// ⚠ THE ROW SHAPE IS REFUSED BY NAME. This is the exact request `decode-day`
/// would have sent on the first run that got past the observation tensor, and
/// the error is the one a production log would have carried.
#[test]
fn the_focus_places_row_shape_is_refused() {
    setup();
    let err = lean::assemble_segments(&request(
        serde_json::json!([known_row(1, 51.5, -0.1)]),
        serde_json::json!([]),
    ))
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("property not found: lat"),
        "the row shape must be refused, got: {err}"
    );
}

/// And the mapped shape is accepted — which is what makes the refusal above a
/// statement about the SHAPE rather than about the request as a whole.
#[test]
fn the_mapped_shape_is_accepted() {
    setup();
    let places = decode_places(Some(&serde_json::json!([known_row(1, 51.5, -0.1)]))).unwrap();
    assert_eq!(
        places,
        serde_json::json!([{
            "id": 1, "name": "Home", "lat": 51.5, "lon": -0.1,
            "hourProfile": null, "dwell": 3600.0
        }]),
        "column names become concept names, and nothing else changes"
    );
    lean::assemble_segments(&request(places, serde_json::json!([])))
        .expect("the mapped shape must be accepted");
}

/// ⚠ A ROW WITH NO CENTROID IS A ROW THIS CODE HAS MISREAD, and it must say so
/// rather than decode a place in the Gulf of Guinea. `known_places` already
/// refuses to write one; this refuses to forward one.
#[test]
fn a_row_with_no_centroid_is_refused_by_name() {
    let mut bad = known_row(1, 51.5, -0.1);
    bad.as_object_mut().unwrap().remove("centroidLat");
    let err = decode_places(Some(&serde_json::json!([bad])))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("centroidLat"),
        "the error must name the missing column, got: {err}"
    );
}

/// An unmined place has no display name, which is ordinary and must not fail.
#[test]
fn an_unnamed_place_maps_to_a_null_name() {
    let mut row = known_row(7, 51.5, -0.1);
    row["displayName"] = serde_json::Value::Null;
    let places = decode_places(Some(&serde_json::json!([row]))).unwrap();
    assert_eq!(places[0]["name"], serde_json::Value::Null);
    assert_eq!(places[0]["id"], 7);
}

#[test]
fn no_places_is_an_empty_list_not_an_error() {
    assert_eq!(decode_places(None).unwrap(), serde_json::json!([]));
    assert_eq!(
        decode_places(Some(&serde_json::Value::Null)).unwrap(),
        serde_json::json!([])
    );
}

/// ⚠ THE LINE LIST IS LEAN'S. A Rust copy would let the shell resolve stations
/// for a different set of lines than the model has states for, and neither side
/// would report it: extra pairs never match a state, missing ones silently drop
/// a hard zero.
#[test]
fn the_known_lines_come_from_the_model() {
    setup();
    let lines = lean::known_lines().unwrap();
    assert!(lines.contains(&"Central Line".to_string()));
    assert!(lines.contains(&"Elizabeth Line".to_string()));
    assert_eq!(lines.len(), 11, "the served state space's train lines");
}

/// ⚠ THE HARD CONSTRAINT ITSELF. A place 100 m from a Central Line station may
/// board it; a place 40 km away may not, and the ABSENCE of its key is what says
/// so. An empty result is therefore not a neutral one — it removes every hard
/// zero rather than adding them.
#[test]
fn a_place_is_near_the_line_it_can_walk_to_and_no_other() {
    setup();
    // Two places and two lines with one station each, 40 km apart.
    let near_central = (1_i64, 51.5, -0.1);
    let near_circle = (2_i64, 51.86, -0.1);
    let pairs = lean::place_near_line(
        &[near_central, near_circle],
        &[
            ("Central Line".into(), vec![(51.5009, -0.1)]),
            ("Circle Line".into(), vec![(51.86, -0.1)]),
        ],
    )
    .unwrap();
    assert_eq!(pairs, vec!["1|Central Line", "2|Circle Line"]);
}

/// ⚠ A LINE THE MIRROR ANSWERED WITH NOTHING CONTRIBUTES NOTHING, and it reads
/// the same as a line every place is far from. That is deliberate: an OSM gap is
/// not evidence that nobody lives near the Piccadilly Line.
#[test]
fn a_line_with_no_stations_yields_no_pairs() {
    setup();
    assert!(
        lean::place_near_line(&[(1, 51.5, -0.1)], &[("Piccadilly Line".into(), vec![])])
            .unwrap()
            .is_empty()
    );
    assert!(
        lean::place_near_line(&[], &[("Central Line".into(), vec![(51.5, -0.1)])])
            .unwrap()
            .is_empty()
    );
}

/// ⚠ THE PAIRS REACH THE DECODER AS PAIRS. `placeNearLine` crosses as a list of
/// `"id|line"` strings and Lean rebuilds the set; a shape the decoder could not
/// read would be swallowed as "no place is near any line", which is the failure
/// this whole path exists to avoid.
#[test]
fn the_pairs_are_accepted_by_assemblesegments() {
    setup();
    let places = decode_places(Some(&serde_json::json!([known_row(1, 51.5, -0.1)]))).unwrap();
    let pairs = lean::place_near_line(
        &[(1, 51.5, -0.1)],
        &[("Central Line".into(), vec![(51.5009, -0.1)])],
    )
    .unwrap();
    assert_eq!(pairs, vec!["1|Central Line"]);
    lean::assemble_segments(&request(places, serde_json::json!(pairs)))
        .expect("the decoder must accept the pairs this pipeline produces");
}

/// ⚠ THE CHAIN SEED IS FOUR FIELDS, NOT ONE — the third field-shape defect on
/// this request. `{priorPlaceId}` alone is refused, and `decode-day` sent exactly
/// that until 2026-08-26. Both halves are asserted, because the refusal alone
/// would still pass if the replacement shape were also wrong.
#[test]
fn the_continuity_seed_needs_all_four_fields() {
    setup();
    let with = |c: serde_json::Value| {
        let mut r = request(serde_json::json!([]), serde_json::json!([]));
        r["continuity"] = c;
        r
    };
    let err = lean::assemble_segments(&with(serde_json::json!({ "priorPlaceId": 42 })))
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("property not found: hoursSince"),
        "a bare priorPlaceId must be refused, got: {err}"
    );
    lean::assemble_segments(&with(serde_json::json!({
        "priorPlaceId": 42,
        "priorPlaceCoord": [51.5, -0.1],
        "hoursSince": 9.5,
        "priorPosterior": 0.87,
    })))
    .expect("the four-field seed must be accepted");
}

/// ⚠ `priorPlaceCoord` IS A PAIR ON THE WIRE, even though the TypeScript's own
/// `ContinuityContext` holds `{lat, lon}`. The object form is refused, and a
/// null one is the documented un-gated case rather than an error.
#[test]
fn the_prior_place_coord_is_a_pair_and_may_be_null() {
    setup();
    let seed = |coord: serde_json::Value| {
        let mut r = request(serde_json::json!([]), serde_json::json!([]));
        r["continuity"] = serde_json::json!({
            "priorPlaceId": 42, "priorPlaceCoord": coord,
            "hoursSince": 9.5, "priorPosterior": 0.87,
        });
        r
    };
    lean::assemble_segments(&seed(serde_json::Value::Null))
        .expect("no known centroid leaves the continuity bonus un-gated");
    assert!(
        lean::assemble_segments(&seed(serde_json::json!({ "lat": 51.5, "lon": -0.1 }))).is_err(),
        "the TypeScript's object shape is not the wire shape"
    );
}

/// ⚠ NO PRIOR DAY IS A CHAIN START, NOT A FAULT. `null` must decode — the first
/// day of a user's history has no seed, and so does any day after a gap.
#[test]
fn a_null_continuity_is_a_chain_start() {
    setup();
    let mut r = request(serde_json::json!([]), serde_json::json!([]));
    r["continuity"] = serde_json::Value::Null;
    lean::assemble_segments(&r).expect("a chain start must decode");
}

/// ⚠ THE FIFTH SHAPE DEFECT, AND THE ONLY ONE ENTIRELY INSIDE THIS REPOSITORY.
/// `buildWireGraph` emits every coordinate as an IEEE-754 bit pattern — on
/// purpose, because a re-rounded coordinate moves a node's 5-dp key, which is
/// its identity. `assemblesegments` read only JSON numbers and refused the
/// output of the entry point next door with `number expected`. Two Lean files,
/// one wire, no agreement, and nothing between them to notice.
///
/// `jFloat` now takes either encoding. This sends the wire graph EXACTLY as
/// `lean::build_wire_graph` returns it.
#[test]
fn the_wire_graph_is_accepted_in_the_encoding_it_is_produced_in() {
    setup();
    let (edges, nodes) = lean::build_wire_graph(
        &[serde_json::json!({
            "id": "w1",
            // ⚠ `[latBits, lonBits]` PAIRS on the way in, `{lat, lon}` OBJECTS
            // on the way out — `parse_linestring_wkt` builds the pairs and
            // `buildWireGraph` emits the objects. The asymmetry is real; this
            // test uses the producer's shape on both sides rather than a
            // guess at either.
            "geometry": [
                [backend::fold_payload::bits(51.5), backend::fold_payload::bits(-0.1)],
                [backend::fold_payload::bits(51.51), backend::fold_payload::bits(-0.1)],
            ],
            "name": "Central Line",
            "subtype": "subway",
            "tags": [["railway", "subway"]],
        })],
        &[],
    )
    .expect("buildWireGraph");
    // ⚠ Asserted, not assumed: the whole point is that this side is strings.
    assert!(
        edges[0]["geometry"][0]["lat"].is_string(),
        "the producer emits bit patterns, and that is what makes this a test"
    );

    let mut r = request(serde_json::json!([]), serde_json::json!([]));
    r["edges"] = edges;
    r["nodes"] = nodes;
    lean::assemble_segments(&r)
        .expect("the decoder must accept the graph the graph builder produces");
}

/// And a plain number still works, because the TypeScript arms send those —
/// `jFloat` accepts both encodings rather than swapping one for the other.
#[test]
fn a_plain_number_coordinate_still_parses() {
    setup();
    let mut r = request(serde_json::json!([]), serde_json::json!([]));
    r["edges"] = serde_json::json!([{
        "id": "w1",
        "geometry": [{ "lat": 51.5, "lon": -0.1 }, { "lat": 51.51, "lon": -0.1 }],
        "lineMemberships": ["Central Line"], "underground": true,
        "startNode": "n1", "endNode": "n2",
    }]);
    lean::assemble_segments(&r).expect("the TypeScript encoding must still parse");
}

/// ⚠ AND A STRING THAT IS NOT A BIT PATTERN IS STILL AN ERROR. Accepting two
/// encodings is not the same as accepting anything: a lenient parse here would
/// read an unusable coordinate as zero and put the way in the Gulf of Guinea.
#[test]
fn a_string_that_is_not_a_bit_pattern_is_refused_by_name() {
    setup();
    let mut r = request(serde_json::json!([]), serde_json::json!([]));
    r["edges"] = serde_json::json!([{
        "id": "w1",
        "geometry": [{ "lat": "51.5", "lon": "-0.1" }],
        "lineMemberships": [], "underground": false,
        "startNode": "n1", "endNode": "n2",
    }]);
    let err = lean::assemble_segments(&r).unwrap_err().to_string();
    assert!(
        err.contains("not a float bit pattern"),
        "the error must name what could not be read, got: {err}"
    );
}
