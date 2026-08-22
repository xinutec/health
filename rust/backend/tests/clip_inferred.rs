//! `clipinferred` through the linked Lean host (#982).
//!
//! `Verified.Geo.DayState.clipInferredFuture` decides what to drop and what to
//! truncate. What this covers is the WIRE around it, which has a failure the
//! decision cannot have: the mode parses the day mode's own state objects and
//! re-emits them, so a field `parseDayState` does not read is a field the
//! clipped day silently loses. The unclipped day keeps it, so the two disagree
//! about a state that was never clipped at all.
//!
//! That is why the encoder is SHARED (`Day.stateJson`) rather than restated, and
//! why the first test below round-trips a REAL day's states rather than a
//! hand-written object with the fields I happened to think of.

use std::path::Path;

use backend::fold_converge::converge;
use backend::lean;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

/// A day's states, straight out of the fold — the only source that cannot
/// disagree with what the mode has to parse.
fn states_of_a_real_day() -> Option<Vec<Value>> {
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    if !Path::new(golden).is_dir() {
        return None;
    }
    let mut names: Vec<String> = std::fs::read_dir(golden)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    let name = names.first()?.clone();
    let raw = std::fs::read_to_string(format!("{golden}/{name}")).ok()?;
    let fx: Value = serde_json::from_str(&raw).ok()?;
    let date = name.get(..10)?.to_string();
    let user = name.get(11..name.len() - 5)?.to_string();
    let inputs = fx.get("inputs")?;

    let cap = backend::head::capture(inputs, &date, &user).ok()?;
    let rows = inputs.get("osmRowSet")?;
    let mut answerer = RowSetAnswerer::new(rows).ok()?;
    let r = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer).ok()?;
    let out: Value = serde_json::from_str(&r.out).ok()?;
    Some(out.get("states")?.as_array()?.clone())
}

#[test]
fn a_settled_day_round_trips_through_the_clip_unchanged() {
    lean::init().expect("the Lean runtime must start");
    let Some(states) = states_of_a_real_day() else {
        eprintln!("SKIPPED: no corpus");
        return;
    };
    assert!(!states.is_empty(), "the day must have states to round-trip");

    // A `nowTs` past any plausible day end, so nothing is clipped and the only
    // thing under test is the encode/parse pair.
    let far_future = 4_102_444_800; // 2100-01-01
    let got = lean::clip_inferred_future(&states, far_future).expect("clipinferred answers");

    assert_eq!(
        got, states,
        "a state changed by passing through the clip that clipped nothing — \
         parseDayState and Day.stateJson have drifted"
    );
}

/// One state in the day mode's own shape. Every optional field carries a VALUE,
/// so a parser that drops one is visible; the null cases are the next test.
fn state(start: i64, end: i64, inferred: Option<bool>) -> Value {
    json!({
        "startTs": start, "endTs": end, "mode": "stationary",
        "place": "somewhere", "wayName": "a way", "asleep": false,
        "tz": "Europe/London", "minutesAsleep": 42,
        "inferred": inferred,
    })
}

#[test]
fn an_inferred_state_is_truncated_or_dropped_and_an_observed_one_is_not() {
    lean::init().expect("the Lean runtime must start");
    let now = 1_000;

    // Wholly future and inferred: dropped.
    let got = lean::clip_inferred_future(&[state(2_000, 3_000, Some(true))], now).unwrap();
    assert!(got.is_empty());

    // Straddles now: truncated to now, everything else intact.
    let got = lean::clip_inferred_future(&[state(500, 3_000, Some(true))], now).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["endTs"], json!(now));
    assert_eq!(got[0]["startTs"], json!(500));
    assert_eq!(got[0]["place"], json!("somewhere"));
    assert_eq!(got[0]["minutesAsleep"], json!(42));

    // ⚠ OBSERVED states are untouched even when they end after `now`. Real data
    // cannot be in the future, so a timestamp past it is not a claim about what
    // has yet to happen — clipping it would delete measured minutes.
    let observed = state(500, 3_000, None);
    let got = lean::clip_inferred_future(std::slice::from_ref(&observed), now).unwrap();
    assert_eq!(got, vec![observed]);

    // Inferred but already ended: untouched.
    let past = state(100, 900, Some(true));
    let got = lean::clip_inferred_future(std::slice::from_ref(&past), now).unwrap();
    assert_eq!(got, vec![past]);
}

#[test]
fn absent_optional_fields_survive_as_null_rather_than_vanishing() {
    lean::init().expect("the Lean runtime must start");
    // ⚠ Lean's encoder emits every key, `null` for absent — the TypeScript's own
    // capture OMITS them instead. A caller diffing a clipped day against an
    // unclipped one must see the same spelling on both sides, which it does
    // because both come from `Day.stateJson`.
    let bare = json!({
        "startTs": 100, "endTs": 200, "mode": "walking",
        "place": null, "wayName": null, "asleep": null,
        "tz": null, "minutesAsleep": null, "inferred": null,
    });
    let got = lean::clip_inferred_future(std::slice::from_ref(&bare), 1_000).unwrap();
    assert_eq!(got, vec![bare]);
}

#[test]
fn an_empty_timeline_clips_to_an_empty_timeline() {
    lean::init().expect("the Lean runtime must start");
    assert!(lean::clip_inferred_future(&[], 1_000).unwrap().is_empty());
}
