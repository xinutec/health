//! The JOURNEY floor over the golden corpus — no Node, no database.
//!
//! ```text
//!   fixture.inputs → head::capture → converge → states ─┐
//!   ground-truth/<date>.md → parse → resolve → journeys ┴→ journeyshape → floorgate
//! ```
//!
//! The story-correctness of the drawn timeline: does the day read as the right
//! SEQUENCE OF TRIPS? `tests/golden/journey-baseline.json` records the
//! ground-truth journeys the pipeline reconstructs, and had no reader from #975
//! until now — the third of seven baselines to get one back (#1048).
//!
//! ⚠ MOST JOURNEYS DO NOT MATCH, AND THAT IS THE DESIGN. The floor is the
//! current non-zero set of working ones, so the standing failures are a floor
//! that can only shrink — the measurement the joint mode+position model (#257)
//! is built against. A journey that never worked is not in the floor and does
//! not fail; one that used to work and stopped is a hard failure.
//!
//! # A match is SHAPE and COVERAGE, and the second conjunct is the quiet one
//!
//! Measured 2026-08-11: five of the corpus's fifteen unmatched journeys
//! reconstruct their EXACT expected mode shape and fail on coverage instead,
//! one of them an enforced regression nobody could attribute (#752). So this
//! prints `uncovered … of … (slack …)` and the match's ENDS beside every
//! failure, and lists every pipeline journey touching the window — because
//! `bestOverlap` grades ONE journey, and a trip the pipeline split in two is
//! scored on its larger half with the rest counted as uncovered.
//!
//! # The port's evidence
//!
//! `journey-score.ts` was recovered at `06346bd^` and run over the SAME
//! `(gt, states)` pairs this harness feeds Lean (dump them with
//! `JOURNEY_DUMP=<path>`): 28 days, 92 journeys, every field of every result
//! plus the pipeline journeys themselves — **920 comparisons, 0
//! disagreements**. Eight ablations of the Lean; five move that count, and the
//! three that do not are silent for reasons measured off this corpus and
//! written down in `Verified/Eval/JourneyShape.lean`.
//!
//! ⚠ AND THE FLOOR IS THE SECOND, INDEPENDENT ORACLE: 80 of 92 reconstructed,
//! against a committed floor of exactly 80 blessed from the TypeScript, with
//! nothing regressed, nothing newly held and nothing dropped.
//!
//! # The split
//!
//! `statesToJourneys`, `modeShape`, `bestOverlap` and the end-clip are
//! `Verified.Eval.JourneyShape`; the ratchet is `Verified.Eval.FloorGate`,
//! already built for the truth floor. This file replays, resolves and prints.
//!
//! # Local-only
//!
//! `tests/golden/{days,ground-truth}` is gitignored (#860). `journey-baseline`
//! IS tracked: unix timestamps and nothing else. Announces a skip rather than
//! passing quietly, and prints modes and times, never a place.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);
const BASELINE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/journey-baseline.json"
);

/// The narrative's journeys for a day, resolved to unix seconds.
fn ground_truth_journeys(date: &str, tz: &str) -> Option<Vec<Value>> {
    let md = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md")).ok()?;
    let req = json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz });
    let reply = backend::lean::serve(&req.to_string())
        .unwrap_or_else(|e| panic!("{date}: the narrative parser must answer: {e:#}"));
    let r: Value = serde_json::from_str(&reply).expect("the parser reply parses");
    assert!(r.get("error").is_none(), "{date}: parser refused: {r}");
    let zone = r["tz"].as_str().unwrap_or(tz);

    let mut rows = Vec::new();
    for row in r["rows"].as_array().map_or(&[][..], Vec::as_slice) {
        let stamp = |d: &Value, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d.as_str()?, h.as_u64()?, m.as_u64()?),
                zone,
            )
        };
        let (Some(a), Some(b)) = (
            stamp(&row["startDay"], &row["startHh"], &row["startMm"]),
            stamp(&row["endDay"], &row["endHh"], &row["endMm"]),
        ) else {
            panic!("{date}: a row's civil time did not resolve in {zone}");
        };
        rows.push(json!({
            "startTs": a, "endTs": b, "status": row["status"], "truth": row["truth"],
        }));
    }
    let jreq = json!({ "mode": "journeys", "rows": rows });
    let jreply = backend::lean::serve(&jreq.to_string())
        .unwrap_or_else(|e| panic!("{date}: journeys must answer: {e:#}"));
    let jr: Value = serde_json::from_str(&jreply).expect("the journeys reply parses");
    assert!(jr.get("error").is_none(), "{date}: journeys refused: {jr}");
    Some(jr["journeys"].as_array().cloned().unwrap_or_default())
}

fn to_wire(map: &BTreeMap<String, Vec<i64>>) -> Vec<Value> {
    map.iter()
        .map(|(d, ks)| json!({ "date": d, "keys": ks }))
        .collect()
}

fn shape(v: &Value) -> String {
    v.as_array().map_or_else(
        || "-".to_string(),
        |a| {
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        },
    )
}

#[test]
fn every_reconstructed_journey_still_reconstructs() {
    if !Path::new(GOLDEN).is_dir() || !Path::new(NARRATIVES).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let baseline: BTreeMap<String, Vec<i64>> = serde_json::from_str(
        &std::fs::read_to_string(BASELINE)
            .expect("the journey floor is tracked and must be readable"),
    )
    .expect("the journey floor parses");

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("the corpus directory is readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    if let Ok(only) = std::env::var("JOURNEY_DAYS") {
        names.retain(|n| only.split(',').any(|d| n.starts_with(d)));
    }
    assert!(!names.is_empty(), "the corpus directory is empty");
    // A one-shot dump for checking this port against the recovered TypeScript:
    // the same `(gt, states)` pairs both sides see. Off by default; it carries
    // no places, but it is a corpus artefact and belongs outside the tree.
    let dump = std::env::var("JOURNEY_DUMP").ok();
    let mut dumped: Vec<String> = Vec::new();

    let mut matched_now: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut described: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut reported: BTreeSet<String> = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();
    let (mut total, mut matched_n) = (0usize, 0usize);

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        let inputs = &fx["inputs"];
        let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));
        let tz = fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");

        let Some(gt) = ground_truth_journeys(date, tz) else {
            continue; // no narrative for this day
        };

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
        // ⚠ ONLY the three fields the referee is allowed to see. Passing whole
        // states would let a place name reach a comparison that must not use one.
        let states: Vec<Value> = out["states"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|s| json!({ "startTs": s["startTs"], "endTs": s["endTs"], "mode": s["mode"] }))
            .collect();
        // ⚠ NON-VACUITY: a moved key yields an EMPTY slice, not an error, and
        // every journey would then read as unreconstructed at once.
        if states.is_empty() {
            failures.push(format!("{name}: the fold produced no states to grade"));
            continue;
        }
        // A day the narrative describes no journeys for measures nothing here.
        if gt.is_empty() {
            continue;
        }

        if let Some(path) = &dump {
            dumped.push(json!({ "date": date, "gt": gt, "states": states }).to_string());
            let _ = path; // written once below
        }

        let req = json!({ "mode": "journeyshape", "gt": gt, "states": states });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{name}: the journey referee must answer: {e:#}"));
        let jr: Value = serde_json::from_str(&reply).expect("the referee reply parses");
        assert!(jr.get("error").is_none(), "{name}: referee refused: {jr}");

        let results = jr["results"].as_array().map_or(&[][..], Vec::as_slice);
        assert_eq!(
            results.len(),
            gt.len(),
            "{name}: one result per ground-truth journey"
        );
        reported.insert(date.to_string());
        let (m, d) = (
            matched_now.entry(date.to_string()).or_default(),
            described.entry(date.to_string()).or_default(),
        );
        let pipeline = jr["pipelineJourneys"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        for res in results {
            total += 1;
            let start = res["startTs"].as_i64().unwrap_or(0);
            d.push(start);
            if res["matched"].as_bool() == Some(true) {
                m.push(start);
                matched_n += 1;
            } else if std::env::var("JOURNEY_DEBUG").is_ok() {
                let (s, e) = (start, res["endTs"].as_i64().unwrap_or(0));
                let touching: Vec<String> = pipeline
                    .iter()
                    .filter(|p| {
                        p["endTs"].as_i64().unwrap_or(0) > s
                            && p["startTs"].as_i64().unwrap_or(0) < e
                    })
                    .map(|p| format!("{}-{}", p["startTs"], p["endTs"]))
                    .collect();
                eprintln!(
                    "      ✗ {date} @{s}  expected [{}]  got [{}]  uncovered {}s of {}s (slack {}s)  \
                     got {}-{}  {} pipeline journey(s) touch: {}",
                    shape(&res["expectedShape"]),
                    shape(&res["actualShape"]),
                    res["uncoveredS"],
                    e - s,
                    res["slackS"],
                    res["matchStartTs"],
                    res["matchEndTs"],
                    touching.len(),
                    if touching.is_empty() {
                        "(none)".to_string()
                    } else {
                        touching.join("  ")
                    }
                );
            }
        }
    }
    assert!(
        failures.is_empty(),
        "the replay did not reach the referee:\n{}",
        failures.join("\n")
    );
    if let Some(path) = &dump {
        std::fs::write(path, dumped.join("\n")).expect("the dump is writable");
        eprintln!("journeys: dumped {} day(s) to {path}", dumped.len());
    }
    assert!(
        matched_n > 0,
        "no journey reconstructed on any day — the gate would pass vacuously"
    );

    // Both sides lose the unmeasured days, or their floors read as lost (#408).
    let unmeasured: Vec<&String> = baseline.keys().filter(|d| !reported.contains(*d)).collect();
    let measured_baseline: BTreeMap<String, Vec<i64>> = baseline
        .iter()
        .filter(|(d, _)| reported.contains(*d))
        .map(|(d, k)| (d.clone(), k.clone()))
        .collect();

    let req = json!({
        "mode": "floorgate",
        "baseline": to_wire(&measured_baseline),
        "current": to_wire(&matched_now),
        "described": to_wire(&described),
    });
    let reply = backend::lean::serve(&req.to_string())
        .unwrap_or_else(|e| panic!("the floor gate must answer: {e:#}"));
    let g: Value = serde_json::from_str(&reply).expect("the gate reply parses");
    assert!(g.get("error").is_none(), "the floor gate refused: {g}");

    let hm = |ts: i64| {
        let s = ts.rem_euclid(86_400);
        format!("{:02}:{:02}Z", s / 3600, (s % 3600) / 60)
    };
    let empty: &[Value] = &[];
    let regressed = g["regressed"].as_array().map_or(empty, Vec::as_slice);
    let improved = g["improved"].as_array().map_or(empty, Vec::as_slice);
    let dropped = g["dropped"].as_array().map_or(empty, Vec::as_slice);

    eprintln!(
        "journeys: {matched_n}/{total} reconstructed over {} day(s), against a floor of {}",
        reported.len(),
        measured_baseline.values().map(Vec::len).sum::<usize>()
    );
    if !unmeasured.is_empty() {
        eprintln!(
            "journeys: {} day(s) not measured this run, floor unchecked: {}",
            unmeasured.len(),
            unmeasured
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if !improved.is_empty() {
        eprintln!(
            "journeys: {} newly reconstructed — re-bless to ratchet the floor up:",
            improved.len()
        );
        for im in improved {
            eprintln!(
                "      ✓ {} @{}",
                im["date"].as_str().unwrap_or("?"),
                hm(im["startTs"].as_i64().unwrap_or(0))
            );
        }
    }
    // ⚠ A drop is the only way a red gate goes green without a fix. Never silent.
    if !dropped.is_empty() {
        eprintln!(
            "journeys: {} floor key(s) the narrative no longer describes:",
            dropped.len()
        );
        for d in dropped {
            eprintln!(
                "      – {} @{}",
                d["date"].as_str().unwrap_or("?"),
                hm(d["startTs"].as_i64().unwrap_or(0))
            );
        }
    }
    assert!(
        regressed.is_empty(),
        "journeys: FAIL — {} previously-reconstructed journey(s) regressed:\n{}",
        regressed.len(),
        regressed
            .iter()
            .map(|r| format!(
                "      ✗ {} @{}",
                r["date"].as_str().unwrap_or("?"),
                hm(r["startTs"].as_i64().unwrap_or(0))
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
