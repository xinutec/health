//! The walk referee over the whole golden corpus — no Node, no database.
//!
//! ```text
//!   fixture.inputs → head::capture → converge → episodes → walkgate → metrics
//! ```
//!
//! This is #1048's Group B for the walk gate. The five replay gates died with
//! the TypeScript (#975); this one comes back with its logic in Lean
//! (`Verified.Eval.WalkMetrics` measures, `Verified.Eval.WalkGate` judges) and
//! only the file handling here, per the standing split.
//!
//! # It GATES, and the floor it gates against is sound
//!
//! Measured 2026-08-31 on the whole corpus: **238 walks over 42 days, every one
//! paired with its floor, and not one whose `lenM` moved by more than 0.5 m.**
//! Zero regressed, zero improved, zero unmatched, zero added. The ported
//! referee reproduces `tests/golden/walk-baseline.json` on real days.
//!
//! ⚠ THAT IS ALSO THE STRONGEST EVIDENCE THE PORT IS RIGHT, and it is why the
//! assertion below is on `passes` rather than on a re-blessed floor. The
//! `#guard`s in `Verified.Eval.WalkMetrics` pin the arithmetic against doubles
//! the deleted TypeScript printed for SYNTHETIC lines; this pins the whole
//! chain — fold, episodes, raw fixes, ways, buildings, steps — against a file
//! a human blessed from the real pipeline.
//!
//! ⚠ A CORRECTION LIVES HERE ON PURPOSE. An earlier reading of this concluded
//! the floor was stale, from feeding the fixtures' FROZEN
//! `expected.tsArm.capture.episodesOut` through the same metrics and finding
//! `lenM`/`p90M`/`offPathM` off by up to 70%. The difference was real; the
//! attribution was wrong. `episodesOut` is not the arm the floor was blessed
//! from — the fold's own output is, and it agrees. Anyone re-measuring through
//! `episodesOut` will see that gap again and should not re-derive the wrong
//! conclusion from it.
//!
//! # All four axes are live
//!
//! `routeCorr` was dark on 45 floor entries until 2026-08-31 — it is the only
//! walk metric scored by NAME rather than geometry, and its narrative parser
//! went with the TypeScript (#975). The parser is Lean now
//! (`Verified.Eval.GroundTruth`, #1290) and those 45 entries MEASURE, and agree
//! with the floor.
//!
//! ⚠ THAT AGREEMENT IS AN END-TO-END ORACLE, and it is worth more than the
//! metric. The chain is: Lean parses the narrative, Rust resolves the anchored
//! civil times through the tz database, Lean scores the drawn line against the
//! accepted names — and the answer lands on a column a human blessed from the
//! OTHER implementation. Every link had to be right for `unmeasured` to reach
//! zero, and no link is checked anywhere else.
//!
//! So: stall, off-path building crossing, step budget, the speed ceiling, and
//! route-correctness are all gating.
//!
//! # Cost
//!
//! ~314 s for the corpus, measured, of which the fold replay is ~1.3 s/day and
//! the referee ~6.2 s/day. The referee's share is the off-walkable p90, which
//! scans every walkable way per sample exactly as the TypeScript did. A spatial
//! index would cut it (`Verified.Geo.WalkSmooth.mkWalkGrid` already exists) but
//! that changes the metric's code path, and it is not being changed in the same
//! commit that establishes it agrees with the floor. Held on #1291.
//!
//! # Why this is local-only
//!
//! `tests/golden/days` is gitignored — the fixtures carry real coordinates,
//! place names and biometrics (#860). It ANNOUNCES A SKIP rather than passing
//! quietly, and it prints metrics only, never a coordinate.

use std::path::Path;

use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
const BASELINE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/walk-baseline.json"
);

/// Every value of an `osmTrace` section, flattened across its query keys — the
/// universe the drawn line is scored against, exactly as the deleted
/// `allWalkable`/`allBuildings` built it.
fn flatten_section(trace: &Value, key: &str) -> Vec<Value> {
    let Some(Value::Object(o)) = trace.get(key) else {
        return Vec::new();
    };
    o.values()
        .filter_map(|v| v.as_array())
        .flat_map(|a| a.iter().cloned())
        .collect()
}

/// A building ring as the referee wants it. The trace stores `{lat, lon}`
/// objects and the wire takes `[lat, lon]` pairs; converting is this file's job,
/// not Lean's.
fn ring_to_pairs(ring: &Value) -> Value {
    let Some(pts) = ring.as_array() else {
        return json!([]);
    };
    Value::Array(
        pts.iter()
            .filter_map(|p| Some(json!([p.get("lat")?, p.get("lon")?])))
            .collect(),
    )
}

/// The raw fixes the fold was given, as `[latBits, lonBits]` inside the leg's
/// window.
///
/// ⚠ `env.rawFixes`, NOT `obs.rawFixes`. The observation block is what
/// `head::capture` builds; the DAY REQUEST nests the fold's inputs under `env`,
/// and pointing at the wrong one yields an empty slice rather than an error —
/// which is how corridor stall read 0.0 on all 238 walks while the gate stayed
/// green. Rows are `[ts, latBits, lonBits, accBits]`, and the
/// bit strings ride through untouched — the Lean side reads either encoding, so
/// nothing is re-rounded on the way in.
fn raw_in_window(request: &Value, start: i64, end: i64) -> Value {
    let rows = request
        .pointer("/env/rawFixes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    Value::Array(
        rows.iter()
            .filter(|r| {
                r.get(0)
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| ts >= start && ts <= end)
            })
            .filter_map(|r| Some(json!([r.get(1)?, r.get(2)?])))
            .collect(),
    )
}

/// Per-minute pedometer rows as the referee's wire wants them.
fn steps_rows(inputs: &Value) -> Value {
    let rows = inputs
        .pointer("/biometrics/steps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    Value::Array(
        rows.iter()
            .filter_map(|r| Some(json!([r.get("ts")?, r.get("steps")?])))
            .collect(),
    )
}

/// The day's enforceable named-walk windows, as `(startTs, endTs, wayName)`.
///
/// This is what makes `routeCorr` measurable — the only walk metric scored by
/// NAME rather than geometry. The narrative parser is Lean
/// (`Verified.Eval.GroundTruth`, #1290); this resolves its output and applies
/// the filter the deleted `loadNamedWalkWindows` applied.
///
/// ⚠ THREE FILTERS, AND THE THIRD IS THE ONE THAT MATTERS. A row must be a
/// WALKING truth, must NAME a way, and must be ENFORCEABLE — a definite verdict
/// backed by `corroborated`/`user`/`derived` provenance. An `inferred` row is
/// read back from the pipeline's own output, so letting it through would make
/// the pipeline's guess the standard it is judged against.
///
/// ⚠ THE ZONE IS THE FIXTURE'S, not a default. Two of the 31 narratives declare
/// their own with a `Times:` line and the parser honours it; passing the wrong
/// zone here would shift every window by hours and silently score the wrong
/// legs.
///
/// ⚠ A DELIBERATE DIVERGENCE, AND IT WAS MEASURED. The original resolved these
/// through `fitbitTsToUnix`, which went with the TypeScript (#975). This uses
/// the repo's own resolver, which picks the LATER instant for an ambiguous wall
/// clock and steps back through a spring-forward gap.
///
/// All 790 instants in the corpus were resolved both ways on 2026-08-31 and
/// agreed exactly — see `ground_truth_corpus.rs` and its `GT_DUMP_UNIX=1`. That
/// is a fact about THIS corpus, not a proof about the functions: a narrated
/// window containing a DST transition could still separate them.
fn named_walk_windows(date: &str, tz: &str) -> Vec<(i64, i64, String)> {
    let path = format!(
        "{}/../../tests/golden/ground-truth/{date}.md",
        env!("CARGO_MANIFEST_DIR")
    );
    let Ok(md) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let req = json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz });
    let Ok(reply) = backend::lean::serve(&req.to_string()) else {
        return Vec::new();
    };
    let Ok(r) = serde_json::from_str::<Value>(&reply) else {
        return Vec::new();
    };
    let zone = r["tz"].as_str().unwrap_or(tz);
    let mut out = Vec::new();
    for row in r["rows"].as_array().map_or(&[][..], Vec::as_slice) {
        if row["enforceable"].as_bool() != Some(true) {
            continue;
        }
        let truth = &row["truth"];
        if truth["mode"].as_str() != Some("walking") {
            continue;
        }
        let Some(way) = truth["wayName"].as_str() else {
            continue;
        };
        let stamp = |d: Option<&str>, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d?, h.as_u64()?, m.as_u64()?),
                zone,
            )
        };
        let (Some(a), Some(b)) = (
            stamp(row["startDay"].as_str(), &row["startHh"], &row["startMm"]),
            stamp(row["endDay"].as_str(), &row["endHh"], &row["endMm"]),
        ) else {
            continue;
        };
        out.push((a, b, way.to_string()));
    }
    out
}

/// Names of every enforceable window overlapping the leg — `w.end > start &&
/// w.start < end`, the original's half-open overlap.
fn accepted_names(windows: &[(i64, i64, String)], start: i64, end: i64) -> Vec<String> {
    let mut names: Vec<String> = windows
        .iter()
        .filter(|(a, b, _)| *b > start && *a < end)
        .map(|(_, _, n)| n.clone())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The walking legs of a fold reply, with the line the map would draw.
///
/// `acceptedNames` comes from the day's ground-truth narrative via
/// `named_walk_windows` above. An empty list is not a failure — it means the
/// narrative named no street over this leg, and `routeCorr` is then honestly
/// unmeasured rather than scored 0.
fn walking_legs(out: &Value, request: &Value, windows: &[(i64, i64, String)]) -> Vec<Value> {
    let Some(eps) = out.get("episodes").and_then(Value::as_array) else {
        return Vec::new();
    };
    eps.iter()
        .filter(|e| e.get("mode").and_then(Value::as_str) == Some("walking"))
        .filter_map(|e| {
            let pts = e.get("points")?.as_array()?;
            if pts.len() < 2 {
                return None;
            }
            let (start, end) = (e.get("startTs")?.as_i64()?, e.get("endTs")?.as_i64()?);
            // `lat`/`lon` ride as IEEE-754 bit strings and are passed through
            // UNTOUCHED — the Lean wire reads either encoding, so nothing is
            // re-rounded between the fold and the referee.
            let drawn: Vec<Value> = pts
                .iter()
                .filter_map(|p| Some(json!([p.get("lat")?, p.get("lon")?])))
                .collect();
            Some(json!({
                "startTs": start,
                "endTs": end,
                "drawn": drawn,
                "raw": raw_in_window(request, start, end),
                "acceptedNames": accepted_names(windows, start, end),
            }))
        })
        .collect()
}

/// A metric off the referee's wire, which always writes bit patterns.
fn bits_of(v: &Value) -> Option<f64> {
    Some(f64::from_bits(v.as_str()?.parse::<u64>().ok()?))
}

#[test]
fn every_golden_day_measures_its_walks() {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    // ⚠ NOT a defaulted parse. A floor that is PRESENT but does not parse has to
    // stop the run: reading it as `{}` would leave every walk unfloored, the
    // gate silent and the test green — the same silent-pass this file's
    // non-vacuity assertion catches later, arriving one step earlier and
    // looking even more like success. A floor that is ABSENT is a different
    // thing and announces a skip, because it is gitignored beside the fixtures
    // it describes.
    let baseline: Value = match std::fs::read_to_string(BASELINE) {
        Ok(text) => serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{BASELINE} is present but does not parse: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("SKIPPED: no blessed floor at {BASELINE}; see this file's header.");
            return;
        }
        Err(e) => panic!("reading {BASELINE}: {e}"),
    };

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("golden dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    // One day at a time while iterating: the full corpus is ~5 minutes.
    if let Ok(only) = std::env::var("WALK_GATE_DAYS") {
        names.retain(|n| only.split(',').any(|d| n.starts_with(d)));
    }
    assert!(!names.is_empty(), "the corpus directory is empty");

    let mut days_req: Vec<Value> = Vec::new();
    let mut baseline_req: Vec<Value> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        let inputs = &fx["inputs"];
        let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));

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
        let out: Value = serde_json::from_str(&r.out).expect("the fold reply parses");
        let tz = fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");
        let windows = named_walk_windows(date, tz);
        let legs = walking_legs(&out, &r.request, &windows);
        let trace = inputs.get("osmTrace").cloned().unwrap_or_else(|| json!({}));

        days_req.push(json!({
            "date": date,
            "ways": flatten_section(&trace, "walkableRoads"),
            "buildings": flatten_section(&trace, "buildingsNear")
                .iter().map(ring_to_pairs).collect::<Vec<_>>(),
            "steps": steps_rows(inputs),
            "walks": legs,
        }));
        if let Some(b) = baseline.get(date) {
            baseline_req.push(json!({ "date": date, "walks": b }));
        }
    }
    assert!(
        failures.is_empty(),
        "the replay did not reach the referee:\n{}",
        failures.join("\n")
    );

    // ⚠ THE CORRIDOR-STALL INPUT, ASSERTED SEPARATELY. `raw_in_window` reads a
    // JSON pointer, and a pointer at the wrong key yields an EMPTY SLICE rather
    // than an error. `maxCorridorStall` then returns 0 — a legitimate value it
    // cannot distinguish from a real one, for a line with no corridor to
    // compare against.
    //
    // That happened. The pointer said `/obs/rawFixes` where the day request
    // nests its inputs under `env`, so stall read 0.0 on all 238 walks. The
    // GATE DID NOT CATCH IT: `STALL_EPS_M` is 15 m and every floor stall on
    // this corpus is at or under 15, so the whole metric collapsed to zero
    // INSIDE its own tolerance and the verdict stayed green. A dead axis and a
    // clean one are indistinguishable from the verdict, so the FEED is checked.
    let fed: usize = days_req
        .iter()
        .flat_map(|d| d["walks"].as_array().map_or(&[][..], Vec::as_slice))
        .filter(|w| w["raw"].as_array().is_some_and(|a| a.len() >= 2))
        .count();
    let total_walks: usize = days_req
        .iter()
        .map(|d| d["walks"].as_array().map_or(0, Vec::len))
        .sum();
    assert!(
        fed * 2 > total_walks,
        "only {fed} of {total_walks} walks carry raw GPS — corridor stall is measured against \
         nothing and reads 0 for every one of them"
    );

    // ⚠ `p90M` IS NOT REQUESTED ON A GATING RUN. It is 83% of the referee's
    // cost — it samples each line every 5 m and scans ~24k walkable ways per
    // sample — and the ratchet does not act on it (`Metric` has no `p90` case).
    // Asked for only when dumping, which is when a human is reading the column
    // or refreshing the floor.
    //
    // ⚠ An indexed nearest-way search was tried first and REFUTED: exact, and
    // 3.3x SLOWER (314s -> 1052s), because a bounding-box bound only bites once
    // `best` is small and nothing orders the ways by proximity (#1291). Not
    // computing the metric beats computing it faster.
    let want_p90 = std::env::var("WALK_GATE_DUMP").is_ok();
    let req = json!({
        "mode": "walkgate",
        "baseline": baseline_req,
        "days": days_req,
        "wantP90": want_p90,
    });
    let reply = backend::lean::serve(&req.to_string()).expect("the referee must answer");
    let r: Value = serde_json::from_str(&reply).expect("the referee reply parses");
    assert!(
        r.get("error").is_none(),
        "referee refused the request: {reply}"
    );

    // Every walk the fold drew was measured. This is the CHAIN assertion — the
    // one thing that can be checked while the floor is stale.
    let measured: usize = r["current"].as_array().map_or(0, |ds| {
        ds.iter()
            .map(|d| d["walks"].as_array().map_or(0, Vec::len))
            .sum()
    });
    let drawn: usize = days_req
        .iter()
        .map(|d| d["walks"].as_array().map_or(0, Vec::len))
        .sum();
    assert_eq!(
        measured, drawn,
        "a drawn walk reached the referee and came back unmeasured"
    );
    assert!(
        drawn > 0,
        "no golden day drew a walk — the chain is broken upstream of the referee"
    );

    // ⚠ THE VERDICT ALONE CANNOT DISTINGUISH "agrees with the floor" from
    // "never compared anything". Both read as zero regressions. So count, on
    // the raw numbers, how many paired walks actually MOVED — a run where the
    // gate is silent AND nothing moved is agreement; silent while everything
    // moved would mean the pairing quietly matched nothing.
    let mut compared = 0usize;
    let mut moved = 0usize;
    for d in r["current"].as_array().map_or(&[][..], Vec::as_slice) {
        let date = d["date"].as_str().unwrap_or("");
        let Some(floor) = baseline.get(date).and_then(Value::as_array) else {
            continue;
        };
        for w in d["walks"].as_array().map_or(&[][..], Vec::as_slice) {
            let ts = w["startTs"].as_i64().unwrap_or(0);
            let Some(b) = floor
                .iter()
                .find(|b| (b["startTs"].as_i64().unwrap_or(0) - ts).abs() <= 120)
            else {
                continue;
            };
            let (Some(now), Some(was)) = (bits_of(&w["lenM"]), b["lenM"].as_f64()) else {
                continue;
            };
            compared += 1;
            if (now - was).abs() > 0.5 {
                moved += 1;
            }
        }
    }
    eprintln!(
        "walk referee: {compared} walks paired with a floor, {moved} whose lenM moved >0.5 m"
    );
    assert!(
        compared > 0,
        "no current walk paired with any floor entry — the comparison was vacuous"
    );

    // The referee as an ADJUDICATION tool, not only a gate. The deleted CLI
    // printed a per-walk table and several open tasks are arguments about one
    // named leg (#1056, #638, #385); without this they can only be reasoned
    // about from the floor file, which records what was blessed rather than
    // what the pipeline draws today.
    //
    // Metrics only — never a coordinate (#860).
    if std::env::var("WALK_GATE_DUMP").is_ok() {
        for d in r["current"].as_array().map_or(&[][..], Vec::as_slice) {
            let date = d["date"].as_str().unwrap_or("");
            let floor = baseline.get(date).and_then(Value::as_array);
            for w in d["walks"].as_array().map_or(&[][..], Vec::as_slice) {
                let ts = w["startTs"].as_i64().unwrap_or(0);
                let g = |k: &str| bits_of(&w[k]).map_or("null".into(), |v| format!("{v:.1}"));
                let b = floor.and_then(|f| {
                    f.iter()
                        .find(|b| (b["startTs"].as_i64().unwrap_or(0) - ts).abs() <= 120)
                });
                let bf = |k: &str| {
                    b.and_then(|b| b[k].as_f64())
                        .map_or("null".into(), |v| format!("{v:.1}"))
                };
                eprintln!(
                    "{date} ts={ts}  len {:>7} (floor {:>7})  offPath {:>6} ({:>6})  \
                     stall {:>6} ({:>6})  p90 {:>6} ({:>6})  speed {:>5} ({:>5})  \
                     budget {:>7} ({:>7})",
                    g("lenM"),
                    bf("lenM"),
                    g("offPathM"),
                    bf("offPathM"),
                    g("stallM"),
                    bf("stallM"),
                    g("p90M"),
                    bf("p90M"),
                    g("speedKmh"),
                    bf("speedKmh"),
                    g("budgetM"),
                    bf("budgetM"),
                );
            }
        }
    }

    let n = |k: &str| r[k].as_array().map_or(0, Vec::len);
    eprintln!(
        "walk referee: {drawn} walks over {} days — {} regressed, {} improved, \
         {} unmatched, {} added, {} unmeasured",
        days_req.len(),
        n("regressed"),
        n("improved"),
        n("unmatched"),
        n("added"),
        n("unmeasured")
    );
    // ⚠ `moved` is the non-vacuity witness and it is asserted, not just
    // printed. A pairing bug that matched nothing would leave `regressed`
    // empty too, and a silent gate reads exactly like a passing one.
    //
    // It is NOT a second geometry check and must not be read as one. Ablated
    // 2026-08-31 by nudging every drawn line 22 m north: `moved` stayed 0,
    // because a rigid translation preserves length, while the gate caught 6 of
    // 7 walks. The two see different things and both are load-bearing.
    assert_eq!(
        moved, 0,
        "{moved} of {compared} paired walks moved more than 0.5 m against the blessed floor — \
         either the geometry changed or this harness stopped feeding the referee what the \
         floor was blessed from"
    );
    assert!(
        r["passes"].as_bool().unwrap_or(false),
        "walks regressed against their floor: {}",
        r["regressed"]
    );
    // ⚠ `unmeasured` IS EXPECTED TO BE ZERO NOW, and it is not asserted at
    // zero on purpose: a narrative that stops naming a street is a fact about
    // the corpus, not a defect, and it must surface rather than fail. A jump
    // back toward 45 means the parser or the tz resolution broke.
    eprintln!(
        "{} floor entries unmeasured (was 45 before the narrative parser landed, #1290)",
        n("unmeasured")
    );
}
