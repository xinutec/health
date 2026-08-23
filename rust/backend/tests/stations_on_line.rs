//! `stationsOnLine` is keyed by a LINE NAME, and that is why it went unanswered.
//!
//! Every other table the answerer serves is keyed by a coordinate, so the
//! dispatch parsed `lat|lon|…` out of the key before matching the table name. A
//! bare line name has no `|`, so it fell out of the dispatch before reaching any
//! arm — 13 declines a day, silently, while every other table was wired (#1075).
//!
//! ⚠ What a missing answer COSTS here is not a missing name. It is a missing
//! MERGE: the table tells the tube-hop pass which stations a line serves, and
//! without it consecutive legs of one ride arrive as separate segments. The
//! symptom is a timeline with more entries than it should have, every one of
//! them correctly labelled — which is why no name comparison caught it.
//!
//! This checks the fixture arm against the answers the TypeScript RECORDED for
//! the same day, so it measures agreement with the oracle rather than
//! self-consistency.
//!
//! ⚠ `tests/golden/days` is gitignored — the fixtures carry real coordinates and
//! place names. Like `day_corpus`, this ANNOUNCES A SKIP rather than passing
//! quietly when the corpus is absent.

use backend::fold_converge::Answerer;
use backend::lean;
use backend::lean::Miss;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::Value;

const DAY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/days/2026-05-22-pippijn.json"
);

/// `None` when the corpus is absent, which the callers report as a SKIP.
fn fixture() -> Option<Value> {
    if !std::path::Path::new(DAY).exists() {
        eprintln!("SKIPPED: no golden corpus at {DAY}; see this file's header.");
        return None;
    }
    let text = std::fs::read_to_string(DAY).expect("reading the day fixture");
    Some(serde_json::from_str(&text).expect("the day fixture is not JSON"))
}

/// Every line the day asked about, answered from the fixture's own row set and
/// compared against what the TypeScript recorded.
#[test]
fn the_fixture_arm_reproduces_the_recorded_answers() {
    lean::init().expect("the Lean runtime must start");
    let Some(day) = fixture() else { return };
    let inputs = day.get("inputs").expect("no inputs");
    let recorded = inputs
        .pointer("/osmTrace/stationsOnLine")
        .and_then(Value::as_object)
        .expect("the fixture recorded no stationsOnLine");
    assert!(
        !recorded.is_empty(),
        "the day asked about no lines — this test would pass vacuously"
    );

    let rows = inputs.get("osmRowSet").expect("no osmRowSet");
    let mut a = RowSetAnswerer::new(rows).expect("building the answerer");

    for (line, want) in recorded {
        let got = a
            .answer(&Miss {
                what: "stationsOnLine".into(),
                key: line.clone(),
            })
            .expect("the answerer errored")
            .unwrap_or_else(|| {
                panic!("DECLINED {line} — a line-name key must reach the arm (#1075)")
            });
        assert_eq!(got.0, "stationsOnLine");

        // `[line, [[name, latBits, lonBits], …]]`.
        let parts = got.1.as_array().expect("the row is not an array");
        assert_eq!(parts[0].as_str(), Some(line.as_str()), "row is mis-keyed");
        let names: Vec<&str> = parts[1]
            .as_array()
            .expect("the answer is not an array")
            .iter()
            .map(|s| s[0].as_str().expect("a station name is not a string"))
            .collect();

        let want_names: Vec<&str> = want
            .as_array()
            .expect("recorded answer is not an array")
            .iter()
            .map(|s| s["name"].as_str().expect("recorded name is not a string"))
            .collect();

        // ⚠ ORDER, not set equality. Downstream journey resolution reads
        // positional relationships out of this list, so a set-equal-but-
        // reordered answer is a different answer — the port says so itself.
        assert_eq!(
            names,
            want_names,
            "{line}: answered {} station(s) against the TypeScript's {}",
            names.len(),
            want_names.len()
        );
    }
}

/// A name whose base token no way carries is an EMPTY answer, not a decline.
///
/// ⚠ This is the one place an empty answer is honest, and the distinction is
/// worth pinning because #1054 was the opposite mistake. "No way of this name"
/// really is "no stations on it" — a siding, a junction curve. Declining would
/// leave the fold asking about it forever.
#[test]
fn a_line_the_mirror_does_not_carry_is_answered_empty() {
    lean::init().expect("the Lean runtime must start");
    let Some(day) = fixture() else { return };
    let rows = day.pointer("/inputs/osmRowSet").expect("no osmRowSet");
    let mut a = RowSetAnswerer::new(rows).expect("building the answerer");
    let (_, row) = a
        .answer(&Miss {
            what: "stationsOnLine".into(),
            key: "Nonexistent Fictional Line".into(),
        })
        .expect("errored")
        .expect("DECLINED — an unknown line must answer empty, not decline");
    assert!(
        row.as_array().expect("not an array")[1]
            .as_array()
            .expect("answer not an array")
            .is_empty()
    );
}
