//! The PhoneTrack wire shapes (#982).
//!
//! These points decide which timezone a Fitbit wall clock is stamped with, and
//! that decision is written to a column and never revisited. So the parser's
//! failure mode that matters is not "throws on bad input" — it is any path where
//! a fix is DROPPED or MISPLACED and the result still looks like a well-formed
//! quiet day.
//!
//! ⚠ The coordinates below are the null island and a round number in the North
//! Sea. Nothing here is a place anybody has been: `tests/golden/ground-truth/`
//! is where real locations live, and it is gitignored for that reason.

use backend::nextcloud::phonetrack::{parse_points, parse_sessions};

#[test]
fn a_point_carries_every_optional_field_it_was_given() {
    let body = r#"[
      {"timestamp":1755388800,"lat":0.5,"lon":0.25,
       "altitude":12.5,"speed":1.5,"accuracy":8.0,"batterylevel":77.0}
    ]"#;
    let ps = parse_points(body).unwrap();
    assert_eq!(ps.len(), 1);
    assert_eq!(ps[0].ts, 1_755_388_800);
    assert_eq!(ps[0].lat, 0.5);
    assert_eq!(ps[0].lon, 0.25);
    assert_eq!(ps[0].altitude, Some(12.5));
    assert_eq!(ps[0].speed, Some(1.5));
    assert_eq!(ps[0].accuracy, Some(8.0));
    assert_eq!(ps[0].battery, Some(77.0));
}

/// Every field past the position is nullable on the wire — an indoor fix has no
/// speed, a desktop client has no battery. A missing one must not take the whole
/// point with it, because a dropped fix is a zone the inference then has to
/// guess at.
#[test]
fn absent_optionals_do_not_drop_the_point() {
    let explicit_null = r#"[{"timestamp":1,"lat":0.0,"lon":0.0,
        "altitude":null,"speed":null,"accuracy":null,"batterylevel":null}]"#;
    let omitted = r#"[{"timestamp":1,"lat":0.0,"lon":0.0}]"#;

    for body in [explicit_null, omitted] {
        let ps = parse_points(body).unwrap();
        assert_eq!(ps.len(), 1, "the point survives: {body}");
        assert_eq!(ps[0].ts, 1);
        assert_eq!(ps[0].altitude, None);
        assert_eq!(ps[0].battery, None);
    }
}

/// ⚠ The parser does NOT sort, and that is asserted rather than assumed. The
/// range fetch concatenates several devices and several chunks and sorts the
/// whole; a sort here would be per device and would still leave the result
/// unordered, while looking like the ordering was handled.
#[test]
fn points_come_back_in_wire_order() {
    let body = r#"[
      {"timestamp":300,"lat":0.0,"lon":0.0},
      {"timestamp":100,"lat":0.0,"lon":0.0},
      {"timestamp":200,"lat":0.0,"lon":0.0}
    ]"#;
    let ts: Vec<i64> = parse_points(body).unwrap().iter().map(|p| p.ts).collect();
    assert_eq!(ts, [300, 100, 200]);
}

#[test]
fn an_empty_device_day_is_an_empty_list_not_an_error() {
    assert!(parse_points("[]").unwrap().is_empty());
}

/// A malformed body must REFUSE rather than decode to zero points. Zero points
/// is a real answer — a device that was off — so a parser that returned it on
/// garbage would report "no fixes that day" for a response nobody could read.
#[test]
fn a_malformed_points_body_refuses() {
    for body in [
        "not json",
        "{}",
        r#"{"points":[]}"#,
        // A point with no position is not a point.
        r#"[{"timestamp":1}]"#,
        r#"[{"lat":0.0,"lon":0.0}]"#,
    ] {
        assert!(parse_points(body).is_err(), "must refuse: {body}");
    }
}

#[test]
fn sessions_are_read_from_the_values_not_the_tokens() {
    let body = r#"{
      "sometoken": {"id": 7, "name": "phone",
                    "devices": {"d1": {"id": 11, "name": "pixel"}}},
      "othertoken": {"id": 9, "name": "spare",
                     "devices": {"d2": {"id": 22, "name": "old"},
                                 "d3": {"id": 33, "name": "tablet"}}}
    }"#;
    let ss = parse_sessions(body).unwrap();
    assert_eq!(ss.len(), 2, "both sessions, keyed by a token nothing reads");
}

/// A session nothing has ever posted to has NO `devices` key at all. It must
/// parse — an account with one live session and one empty one is ordinary, and
/// refusing the listing would cost the live session's fixes too.
#[test]
fn a_session_with_no_devices_parses() {
    let body = r#"{"t": {"id": 7, "name": "unused"}}"#;
    assert_eq!(parse_sessions(body).unwrap().len(), 1);
}

#[test]
fn a_malformed_sessions_body_refuses() {
    for body in ["not json", "[]", r#"{"t": {"name":"no id"}}"#] {
        assert!(parse_sessions(body).is_err(), "must refuse: {body}");
    }
}
