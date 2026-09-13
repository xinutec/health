//! The WORLDLINE-FEASIBILITY ceiling over the golden corpus — no Node, no DB.
//!
//! ```text
//!   fixture.inputs → head::capture → converge → states ─┐
//!   fixture.osmTrace.stationsOnLine ────────────────────┴→ feasibility → ceilinggate
//! ```
//!
//! Pippijn's standing requirement, 2026-09-01: *"Correct or at least viable
//! trajectory is important. It shouldn't show definitely-wrong interpretations
//! that can't be right given the data."* This is the check that enforces it,
//! and it had no reader from #975 until now — the fourth and fifth baselines
//! to come back (#1048).
//!
//! A model-independent assertion on the OUTPUT: a real worldline is one
//! continuous path through space-time, so some drawn timelines are impossible
//! regardless of how the cascade produced them. Four invariants —
//! `impossible-mode-kinematics` (a walk at vehicle pace, and a train at
//! pedestrian pace while the wearer steps), `invalid-rail-triple` (a line
//! labelled through a station it does not reach), `rail-discontinuity` and
//! `degenerate-train-leg`.
//!
//! # A CEILING, not a floor, and the ratchet is the other way
//!
//! `feasibility-baseline.json` and `rail-triple-baseline.json` record standing
//! defects as per-day COUNTS that may only shrink. A day emitting more than its
//! committed count fails; fewer is an improvement to re-bless with
//! `FEASIBILITY_BLESS=1`.
//!
//! ⚠ SILENCE IS NOT ZERO. `current[date] ?? 0` cannot tell a day with no
//! defects from a day that never ran, and against a non-zero ceiling the second
//! reads as the first — so a change that breaks a fixture AND worsens that day
//! would report as an IMPROVEMENT. `measured` and `attempted` are passed
//! separately for exactly that reason; see `Verified.Eval.CeilingGate`.
//!
//! # Local-only
//!
//! `tests/golden/days` is gitignored (#860); both baselines are tracked, being
//! counts and dates only. Announces a skip rather than passing quietly.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
const KINEMATIC: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/feasibility-baseline.json"
);
const TRIPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/rail-triple-baseline.json"
);

fn load(path: &str) -> BTreeMap<String, u64> {
    serde_json::from_str(&std::fs::read_to_string(path).expect("the ceiling is tracked"))
        .expect("the ceiling parses")
}

/// A ceiling on the `floorgate`-style wire: `[{date, keys}]` is for sets, so
/// counts get their own shape rather than being smuggled through as a length.
fn ceiling_wire(m: &BTreeMap<String, u64>) -> Vec<Value> {
    m.iter()
        .map(|(d, n)| json!({ "date": d, "count": n }))
        .collect()
}

#[test]
fn no_day_draws_more_impossible_legs_than_its_ceiling() {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let (kin_base, tri_base) = (load(KINEMATIC), load(TRIPLE));

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("the corpus directory is readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    if let Ok(only) = std::env::var("FEASIBILITY_DAYS") {
        names.retain(|n| only.split(',').any(|d| n.starts_with(d)));
    }
    assert!(!names.is_empty(), "the corpus directory is empty");

    let dump = std::env::var("FEASIBILITY_DUMP").ok();
    let mut dumped: Vec<String> = Vec::new();
    let mut kin_now: BTreeMap<String, u64> = BTreeMap::new();
    let mut tri_now: BTreeMap<String, u64> = BTreeMap::new();
    let mut measured: BTreeSet<String> = BTreeSet::new();
    let mut attempted: BTreeSet<String> = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();
    let mut detail: Vec<String> = Vec::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        let inputs = &fx["inputs"];
        let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));
        attempted.insert(date.to_string());

        let Some(rowset) = inputs.get("osmRowSet") else {
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
        let mut answerer = RowSetAnswerer::new(rowset).expect("the row set opens");
        let r = match converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: converge: {e:#}"));
                continue;
            }
        };
        let out: Value = serde_json::from_str(&r.out).expect("the fold reply parses");
        let legs: Vec<Value> = out["states"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|s| {
                json!({
                    "startTs": s["startTs"], "endTs": s["endTs"],
                    "mode": s["mode"], "wayName": s["wayName"],
                })
            })
            .collect();
        if legs.is_empty() {
            failures.push(format!("{name}: the fold produced no legs to judge"));
            continue;
        }

        // ⚠ `/env/points` carries lat/lon as IEEE-754 bit strings and the Lean
        // wire reads either encoding, so they are passed through UNTOUCHED —
        // re-parsing them here would put a rounding step between the fold and
        // the invariant that judges it.
        let pts = r.request.pointer("/env/points").and_then(Value::as_array);
        let points: Vec<Value> = pts
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let t = p.as_array()?;
                        Some(json!({ "ts": t.first()?, "lat": t.get(1)?, "lon": t.get(2)? }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let steps: Vec<Value> = r
            .request
            .pointer("/env/steps")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| {
                        let t = s.as_array()?;
                        Some(json!({ "ts": t.first()?, "steps": t.get(1)? }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Line membership from the fixture's own recorded trace. A day whose
        // capture never asked for a line contributes NOTHING here rather than
        // an empty list — see the mode's header.
        let line_stations: Vec<Value> = inputs
            .pointer("/osmTrace/stationsOnLine")
            .and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .map(|(line, v)| {
                        let stations: Vec<Value> = v
                            .as_array()
                            .map_or(&[][..], Vec::as_slice)
                            .iter()
                            .filter_map(|s| s.get("name").cloned())
                            .collect();
                        json!({ "line": line, "stations": stations })
                    })
                    .collect()
            })
            .unwrap_or_default();

        if dump.is_some() {
            dumped.push(
                json!({ "date": date, "legs": legs, "points": points,
                        "steps": steps, "lineStations": line_stations })
                .to_string(),
            );
        }

        let req = json!({
            "mode": "feasibility", "legs": legs, "points": points,
            "steps": steps, "lineStations": line_stations,
        });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{name}: the invariants must answer: {e:#}"));
        let fr: Value = serde_json::from_str(&reply).expect("the reply parses");
        assert!(fr.get("error").is_none(), "{name}: refused: {fr}");

        measured.insert(date.to_string());
        let (mut kin, mut tri) = (0u64, 0u64);
        for v in fr["violations"].as_array().map_or(&[][..], Vec::as_slice) {
            match v["kind"].as_str() {
                Some("impossible-mode-kinematics") => kin += 1,
                Some("invalid-rail-triple") => tri += 1,
                // ⚠ CONTINUITY AND SELF-RIDE ARE AT ZERO AND HAVE NO CEILING
                // FILE. They are hard failures, not standing debt: there is no
                // committed count for them, so any occurrence is reported and
                // fails below rather than being silently tolerated.
                _ => failures.push(format!(
                    "{date}: {} — {}",
                    v["kind"].as_str().unwrap_or("?"),
                    v["detail"].as_str().unwrap_or("")
                )),
            }
            if std::env::var("FEASIBILITY_DEBUG").is_ok() {
                detail.push(format!(
                    "      {date} {} {}",
                    v["kind"].as_str().unwrap_or("?"),
                    v["detail"].as_str().unwrap_or("")
                ));
            }
        }
        if kin > 0 {
            kin_now.insert(date.to_string(), kin);
        }
        if tri > 0 {
            tri_now.insert(date.to_string(), tri);
        }
    }

    if let Some(path) = &dump {
        std::fs::write(path, dumped.join("\n")).expect("the dump is writable");
        eprintln!("feasibility: dumped {} day(s) to {path}", dumped.len());
    }
    for d in &detail {
        eprintln!("{d}");
    }

    let measured_v: Vec<&String> = measured.iter().collect();
    let attempted_v: Vec<&String> = attempted.iter().collect();
    let gate = |committed: &BTreeMap<String, u64>, current: &BTreeMap<String, u64>| -> Value {
        let req = json!({
            "mode": "ceilinggate",
            "committed": ceiling_wire(committed),
            "current": ceiling_wire(current),
            "measured": measured_v,
            "attempted": attempted_v,
        });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("the ceiling gate must answer: {e:#}"));
        serde_json::from_str(&reply).expect("the gate reply parses")
    };

    let kin_gate = gate(&kin_base, &kin_now);
    let tri_gate = gate(&tri_base, &tri_now);
    assert!(
        kin_gate.get("error").is_none(),
        "kinematic gate: {kin_gate}"
    );
    assert!(tri_gate.get("error").is_none(), "triple gate: {tri_gate}");

    if std::env::var("FEASIBILITY_BLESS").is_ok() {
        for (path, committed, current) in [
            (KINEMATIC, &kin_base, &kin_now),
            (TRIPLE, &tri_base, &tri_now),
        ] {
            let req = json!({
                "mode": "ceilingbless",
                "committed": ceiling_wire(committed),
                "current": ceiling_wire(current),
                "measured": measured_v,
            });
            let reply = backend::lean::serve(&req.to_string()).expect("the bless must answer");
            let r: Value = serde_json::from_str(&reply).expect("the bless reply parses");
            let mut out = serde_json::Map::new();
            for e in r["ceiling"].as_array().map_or(&[][..], Vec::as_slice) {
                if let Some(d) = e["date"].as_str() {
                    out.insert(d.to_string(), e["count"].clone());
                }
            }
            let text = serde_json::to_string_pretty(&Value::Object(out)).expect("serialises");
            std::fs::write(path, format!("{}\n", text.replace("  ", "\t"))).expect("writable");
            eprintln!("feasibility: re-blessed {path}");
        }
        return;
    }

    let empty: &[Value] = &[];
    let mut regressions: Vec<String> = Vec::new();
    for (label, g) in [("kinematic", &kin_gate), ("rail-triple", &tri_gate)] {
        for r in g["regressed"].as_array().map_or(empty, Vec::as_slice) {
            regressions.push(format!(
                "      ✗ {} {} — was {}, now {}",
                r["date"].as_str().unwrap_or("?"),
                label,
                r["was"],
                r["now"]
            ));
        }
        let improved = g["improvedDays"].as_u64().unwrap_or(0);
        if improved > 0 {
            eprintln!(
                "feasibility: {label} — {improved} day(s) below the ceiling; re-bless to ratchet down"
            );
        }
        let un = g["unmeasured"].as_array().map_or(empty, Vec::as_slice);
        if !un.is_empty() {
            eprintln!(
                "feasibility: {label} — {} day(s) not measured, ceiling unchecked: {}",
                un.len(),
                un.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    eprintln!(
        "feasibility: {} impossible-kinematics leg(s) over {} day(s), \
         {} invalid rail triple(s); ceilings {} and {}",
        kin_now.values().sum::<u64>(),
        measured.len(),
        tri_now.values().sum::<u64>(),
        kin_base.values().sum::<u64>(),
        tri_base.values().sum::<u64>()
    );

    assert!(
        failures.is_empty(),
        "feasibility violations with NO ceiling — these are hard failures:\n{}",
        failures.join("\n")
    );
    assert!(
        regressions.is_empty(),
        "feasibility: FAIL — {} day(s) above their ceiling:\n{}",
        regressions.len(),
        regressions.join("\n")
    );
}
