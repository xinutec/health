//! A WHOLE DAY with no Node and no database, against the TypeScript's timeline.
//!
//! ```text
//!   fixture.inputs → head::capture → build_day_request → converge → states
//! ```
//!
//! Every link existed before this file except the first: `converge` and
//! `RowSetAnswerer` were written against `FOLD_CAPTURE` files, which only the
//! TypeScript pipeline could produce. `head::capture` computes the same thing,
//! so the chain closes and the day can be replayed from the fixture alone
//! (#982).
//!
//! The oracle is `expected.tsArm.capture.statesOut` — the timeline the
//! TypeScript cascade produced from the same inputs.
//!
//! # ⚠ WHERE THIS TEST BEGINS, AND THEREFORE WHAT IT DOES NOT COVER
//!
//! It starts at `fixture.inputs`. **Nothing that PRODUCES an input is exercised
//! here** — `classification_inputs::load` and every DB query, cache load,
//! PhoneTrack window and biometrics join inside it are upstream of the fixture
//! and are not reached by this file or any other in the corpus.
//!
//! That boundary is invisible from the pass line, and it has already misled
//! once: a change to `classification_inputs::load` on 2026-08-30 was reported
//! green by 339 tests that never executed it (#1273). A change to what the fold
//! is FED must land on the replay path above, or be covered by something else
//! that is named — a loader is the most dangerous place for this, because it
//! moves the answer while every assertion here still holds.
//!
//! # ⚠ THE CORPUS IS CLOSED, and not by policy
//!
//! Every day here carries a frozen `tsArm`, and one CANNOT be created any more:
//! `compare-day --freeze` went with the TS cascade (#975). So a day arriving
//! without an oracle fails and can never be made to pass. That is option 2 of
//! #1063 in force — arrived at by deletion rather than chosen — and it means
//! the corpus can lose days but cannot gain them.
//!
//! # Why this test is local-only, and how it says so
//!
//! `tests/golden/days` is gitignored: the fixtures carry real coordinates,
//! place names and biometrics. It ANNOUNCES A SKIP rather than passing quietly.

use std::path::Path;

use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Map, Value};

/// Days whose timeline the Lean fold and the TypeScript cascade build
/// differently — each with its divergence ADJUDICATED, not merely observed.
///
/// ⚠ THIS LIST MAY ONLY SHRINK. Listing a day keeps the other 41 checkable
/// instead of one red day hiding them all; re-capturing a day to make a miss
/// go away is forbidden (#1054).
///
/// 2026-08-09 is a day the ORACLE is wrong about, adjudicated 2026-09-02:
/// state 5's venue. Both arms tag, plan and consolidate the same jitter run
/// (the TS's own segsOut says "consolidated 3 GPS-jitter stay fragments");
/// at the merged centre the recorded rows put Morr at 1.59 m and KFC at
/// 2.39 m, both near-field, and Lean's near-field-first rule answers Morr
/// where the TS answered KFC. Pippijn confirmed the stay WAS Morr. The frozen
/// oracle cannot be edited (it is the TS's real output), so the day stays
/// here — as a recorded improvement, not an open question.
const KNOWN_DIVERGENT: [&str; 1] = ["2026-08-09-pippijn.json"];

/// Keys the offline answerer cannot supply, beyond the blank-zone `bestPlace`
/// asked before `tzAt` resolves.
///
/// Measured 2026-08-23: 7 keys over 5 days — `reverseGeocode` on six (one at
/// zoom 18, five at zoom 16) and one `transitStops`. Each means the fold reached
/// a lookup the TypeScript run never made, so the recorded trace has no answer
/// and the row set is not that lookup's source. Per #1054 the miss IS the
/// finding, so this is a CEILING that must fall, not a budget.
///
/// ⚠ Was 8 until 2026-08-23. The eighth was 06-09's `nearbyLandmarks`, which
/// was never an un-asked lookup at all — the answerer had NO ARM for that table
/// and fell through the catch-all, so it read as adjudicated when it was not
/// (#1054). The arm exists now, so the ceiling drops with it.
///
/// What remains is the two tables that are declined ON PURPOSE:
/// `reverseGeocode` is a Nominatim call whose keys are coordinates the pipeline
/// DERIVES (#1076), and `transitStops` is injected rather than computed from
/// rows. Neither falls without porting something.
const UNANSWERED_MAX: usize = 7;

/// The tables an unanswered key may belong to. Anything else is a new gap.
const UNANSWERED_KINDS: [&str; 3] = ["reverseGeocode", "nearbyLandmarks", "transitStops"];

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// `null` and absent are the SAME state here, and comparing without this would
/// report every state as differing.
///
/// The seam is TypeScript's `undefined` against Lean's `null`: `JSON.stringify`
/// drops an undefined field, and Lean has no undefined so it writes `null`.
/// Dropping nulls on BOTH sides equates exactly those two and nothing else — a
/// field the fold nulls and the TypeScript fills still differs, because one
/// side then has a key the other does not.
fn drop_nulls(v: &Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), drop_nulls(v)))
                .collect::<Map<String, Value>>(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(drop_nulls).collect()),
        other => other.clone(),
    }
}

#[test]
fn every_golden_day_replays_to_the_typescript_timeline() {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("golden dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "the corpus directory is empty");

    let mut failures: Vec<String> = Vec::new();
    let mut agreed = 0usize;
    let mut deepest = 0u32;
    let mut unanswered: Vec<String> = Vec::new();
    let mut divergent: Vec<String> = Vec::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        let inputs = &fx["inputs"];
        let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));

        let Some(want) = fx.pointer("/expected/tsArm/capture/statesOut") else {
            failures.push(format!(
                "{name}: no frozen tsArm timeline — and one CANNOT be created. \
                 `compare-day --freeze` went with the TS cascade (#975), so a day \
                 arriving without an oracle can never gain one and cannot join this \
                 corpus. Every day here carries one; seeing this means a new day was \
                 added or a capture dropped an existing arm. See #1063."
            ));
            continue;
        };
        let Some(rows) = inputs.get("osmRowSet") else {
            failures.push(format!("{name}: no osmRowSet to answer from"));
            continue;
        };

        let cap = match backend::head::capture(inputs, date, user) {
            Ok(c) => c,
            Err(e) => {
                failures.push(format!("{name}: head: {e:#}"));
                continue;
            }
        };
        let mut answerer = RowSetAnswerer::new(rows).expect("the row set opens");
        let r = match converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: converge: {e:#}"));
                continue;
            }
        };
        deepest = deepest.max(r.rounds);

        // ⚠ THE ONLY ACCEPTED RESIDUE. The fold asks `bestPlace` once before
        // `tzAt` has resolved the stay's zone and again after; the blank-zone
        // spelling is a question asked too early, not a stay with no zone, and
        // the answerer declines it rather than pick one. Measured on 2026-04-29:
        // 8 spans, each asked twice, every one recorded by the TypeScript at
        // Europe/Amsterdam. ANYTHING ELSE unanswered means the timeline below
        // was built from a default for a question the day really asked, and
        // matching `statesOut` anyway would be luck rather than agreement.
        for m in &r.unanswerable {
            if m.what == "bestPlace" && m.key.ends_with('|') {
                continue;
            }
            if UNANSWERED_KINDS.contains(&m.what.as_str()) {
                unanswered.push(format!("{name}: {}({})", m.what, m.key));
            } else {
                failures.push(format!("{name}: unanswered {}({})", m.what, m.key));
            }
        }

        let out: Value = serde_json::from_str(&r.out).expect("the fold answers JSON");
        let got = out.get("states").cloned().unwrap_or(Value::Null);
        let same = drop_nulls(&got) == drop_nulls(want);
        match (same, KNOWN_DIVERGENT.contains(&name.as_str())) {
            (true, false) => agreed += 1,
            (false, true) => {
                divergent.push(format!("{name}: {}", first_state_difference(&got, want)))
            }
            (false, false) => {
                failures.push(format!("{name}: {}", first_state_difference(&got, want)));
            }
            // ⚠ A day that AGREES while listed as divergent is not a pass. It
            // means the divergence is gone and the list is now a lie, and a
            // stale entry here would hide the next real one.
            (true, true) => failures.push(format!(
                "{name} is listed as divergent on #1054 but now agrees — delete the entry"
            )),
        }
    }

    for d in &divergent {
        eprintln!("  #1054     {d}");
    }
    for u in &unanswered {
        eprintln!("  unanswered {u}");
    }
    assert!(
        failures.is_empty(),
        "{agreed}/{} days replay to the TypeScript timeline (deepest walk {deepest} rounds).\n{}",
        names.len(),
        failures.join("\n")
    );
    assert!(
        unanswered.len() <= UNANSWERED_MAX,
        "{} key(s) unanswered, up from the {UNANSWERED_MAX} measured — each is a lookup the \
         TypeScript never made, so the day was built from a default for it:\n{}",
        unanswered.len(),
        unanswered.join("\n")
    );
    assert_eq!(
        agreed + divergent.len(),
        names.len(),
        "some day neither agreed nor diverged, which means it was skipped"
    );
    eprintln!(
        "{agreed}/{} days replay to the TypeScript timeline; {} known-divergent (#1054); \
         {} key(s) unanswered; deepest walk {deepest} rounds",
        names.len(),
        divergent.len(),
        unanswered.len()
    );
}

/// The first state that differs, and which of its fields.
///
/// Printing the timelines whole buries the one state that moved; printing only
/// the index does not say which field, which is the mistake
/// `compare-head.mts` records making.
fn first_state_difference(got: &Value, want: &Value) -> String {
    let empty = Vec::new();
    let g = got.as_array().unwrap_or(&empty);
    let w = want.as_array().unwrap_or(&empty);
    for i in 0..g.len().max(w.len()) {
        let (a, b) = (g.get(i).map(drop_nulls), w.get(i).map(drop_nulls));
        if a == b {
            continue;
        }
        let (Some(a), Some(b)) = (&a, &b) else {
            return format!(
                "{} states vs {} — state {i} exists on only one side",
                g.len(),
                w.len()
            );
        };
        let keys: std::collections::BTreeSet<&String> = a
            .as_object()
            .into_iter()
            .chain(b.as_object())
            .flat_map(serde_json::Map::keys)
            .collect();
        let fields: Vec<String> = keys
            .into_iter()
            .filter(|k| a.get(k.as_str()) != b.get(k.as_str()))
            .map(|k| {
                format!(
                    "{k}: rust {} vs ts {}",
                    a.get(k.as_str()).unwrap_or(&Value::Null),
                    b.get(k.as_str()).unwrap_or(&Value::Null)
                )
            })
            .collect();
        return format!(
            "{} states vs {} — state {i} differs on {}",
            g.len(),
            w.len(),
            fields.join(", ")
        );
    }
    format!("{} states vs {} — no field differs", g.len(), w.len())
}
