//! `decoded_days.segments_json` in the stored rows' field order, not
//! `Lean.Json.mkObj`'s sorted keys, so a row diff shows decode changes, not key
//! order. `jq` cannot do this diff: `25.0 == 25`, and absent equals null.

use backend::row_json::render_segments;

/// A segment as Lean returns it: keys sorted, because `Json.mkObj` sorts them.
/// Written out in that order deliberately — the input to this function is not
/// the order anybody wrote, and a fixture in the pretty order would test nothing.
fn lean_train_segment() -> serde_json::Value {
    serde_json::json!({
        "alightStation": "Echo",
        "boardStation": "Alpha",
        "endTs": 1_000_540,
        "lineName": "Central Line",
        "mode": "train",
        "placeId": null,
        "startTs": 1_000_000,
    })
}

fn keys(v: &serde_json::Value) -> Vec<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
}

#[test]
fn the_field_order_is_the_one_node_writes() {
    let out = render_segments(&serde_json::json!([lean_train_segment()])).unwrap();
    assert_eq!(
        keys(&out[0]),
        vec![
            "startTs",
            "endTs",
            "mode",
            "placeId",
            "lineName",
            "boardStation",
            "alightStation"
        ],
        "`groupStatesIntoSegments`'s literal, then the two fields decode.ts assigns after it"
    );
    // The rendering is the only thing that changes. A field that moved value
    // would be a far worse defect than one that moved position.
    assert_eq!(out[0]["boardStation"], "Alpha");
    assert_eq!(out[0]["alightStation"], "Echo");
    assert_eq!(out[0]["placeId"], serde_json::Value::Null);
    assert_eq!(out[0]["startTs"], 1_000_000);
}

/// Absent stays absent. A segment the chain never reached carries no station
/// key at all; inserting a null here would erase a distinction node's rows make
/// and this port has to reproduce.
#[test]
fn an_absent_station_key_is_not_filled_in_with_null() {
    let stationary = serde_json::json!({
        "endTs": 1_014_940, "lineName": null, "mode": "stationary",
        "placeId": null, "startTs": 1_000_540,
    });
    let out = render_segments(&serde_json::json!([stationary])).unwrap();
    assert_eq!(
        keys(&out[0]),
        vec!["startTs", "endTs", "mode", "placeId", "lineName"],
        "no station keys at all"
    );
    let o = out[0].as_object().unwrap();
    assert!(!o.contains_key("boardStation") && !o.contains_key("alightStation"));
}

/// And an explicit NULL stays explicit. A resolved leg whose board side the
/// chain could not separate carries `null` — "wrong is worse than missing" — and
/// that is a different row from the one above.
#[test]
fn a_resolved_but_unseparated_side_keeps_its_null() {
    let half = serde_json::json!({
        "alightStation": "Echo", "boardStation": null,
        "endTs": 1_000_540, "lineName": "Central Line", "mode": "train",
        "placeId": null, "startTs": 1_000_000,
    });
    let out = render_segments(&serde_json::json!([half])).unwrap();
    let o = out[0].as_object().unwrap();
    assert!(o.contains_key("boardStation"), "the key is present");
    assert_eq!(o["boardStation"], serde_json::Value::Null);
    assert_eq!(o["alightStation"], "Echo");
}

/// An unlisted field is carried, not dropped, or a new Lean field would look
/// like a decode that stopped producing one.
#[test]
fn an_unknown_field_survives_after_the_known_ones() {
    let mut seg = lean_train_segment();
    seg["confidence"] = serde_json::json!(0.87);
    let out = render_segments(&serde_json::json!([seg])).unwrap();
    assert_eq!(*keys(&out[0]).last().unwrap(), "confidence");
    assert_eq!(out[0]["confidence"], 0.87);
}

/// The order of the segments themselves is the day. Only the keys inside each
/// one are reordered — a stable sort applied to the array would rewrite the
/// timeline.
#[test]
fn the_segments_keep_their_own_order() {
    let out = render_segments(&serde_json::json!([
        { "startTs": 300, "endTs": 400, "mode": "walking", "placeId": null, "lineName": null },
        { "startTs": 100, "endTs": 200, "mode": "stationary", "placeId": 1, "lineName": null },
    ]))
    .unwrap();
    assert_eq!(out[0]["startTs"], 300);
    assert_eq!(out[1]["startTs"], 100);
}

/// A degenerate answer is refused by name rather than written as an empty day.
#[test]
fn a_non_array_is_refused() {
    let err = render_segments(&serde_json::json!({ "segments": [] }))
        .unwrap_err()
        .to_string();
    assert!(err.contains("did not return an array"), "got: {err}");
}

#[test]
fn an_empty_day_renders_empty() {
    assert_eq!(
        render_segments(&serde_json::json!([])).unwrap(),
        serde_json::json!([])
    );
}
