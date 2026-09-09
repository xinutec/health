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
//! # ⚠ THIS GATE DOES NOT RUN THE WALK MATCHER, AND THAT IS STAGED (#1418)
//!
//! The fold's walk pass reads its roads through day-shell's `walkableRoads`
//! callback, which answers from a loaded trace and EMPTY otherwise — and on
//! empty `annotateWalkMatches` bails per leg, so the RAW drawing survives
//! looking exactly like a leg the matcher considered and left alone.
//!
//! `WALK_TRACE=none|walkable|buildings|drivable|all` chooses what the trace
//! answers, per day; `WALK_DAYS=<dates>` restricts the corpus. **`none` is the
//! default and is today's behaviour.** Measured 2026-09-08 over four days, one
//! section at a time:
//!
//! ```text
//!   arm         moved/30   regressed  improved
//!   none               0           0         0    <- reproduces the blessed floor
//!   walkable          21           9        17
//!   buildings          0           0         0    <- never ASKED without ways
//!   drivable           0           0         0
//!   all               28          11        22
//! ```
//!
//! So the drift is `walkableRoads`, and the floor corresponds to the raw
//! drawing. Turning it on for real means re-baselining 204 of 238 corpus walks
//! and grading 68 regressions that are pre-existing production behaviour — that
//! is #1418's remaining work, not this file's.
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

/// Add `v` to `table` if its serialised form is new, and return its index.
///
/// Keyed on the serialised bytes rather than on an id: the trace's items carry
/// no stable identifier here, and byte-equality is the only sharing that cannot
/// fuse two geometries the referee would score differently.
fn intern(
    table: &mut Vec<Value>,
    index: &mut std::collections::HashMap<String, usize>,
    v: Value,
) -> usize {
    let key = v.to_string();
    if let Some(&i) = index.get(&key) {
        return i;
    }
    let i = table.len();
    index.insert(key, i);
    table.push(v);
    i
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

/// Which trace sections this run answers from. See `WALK_TRACE`.
struct Arm {
    label: &'static str,
    walkable: bool,
    buildings: bool,
    drivable: bool,
}

impl Arm {
    /// ⚠ **THE DEFAULT IS `none`, WHICH IS TODAY'S BEHAVIOUR, AND IT IS STAGED
    /// RATHER THAN CHOSEN.** `all` is where this is going: the matcher runs in
    /// production (measured — `day-mirror` names 8 of 8 walking states on
    /// 2026-06-16, `day-live` with no OSM source names 0 of 7), so a gate that
    /// never loads a trace grades a pass the serving path does not execute.
    ///
    /// It is not flipped yet because `walk-baseline.json` was blessed from the
    /// RAW drawing — the `none` arm reproduces it exactly, which is how that was
    /// established — and turning the matcher on moves 204 of 238 corpus walks,
    /// 68 of them REGRESSING on truth-anchored axes. Those 68 are pre-existing
    /// production behaviour nobody has ever graded, and blessing them away in
    /// the commit that first makes them visible is the one thing not to do.
    ///
    /// Flipping the default is #1418's remaining work, and it needs the 68
    /// graded and ticketed first.
    fn from_env() -> Self {
        match std::env::var("WALK_TRACE").as_deref().unwrap_or("none") {
            "none" => Arm {
                label: "none",
                walkable: false,
                buildings: false,
                drivable: false,
            },
            "walkable" => Arm {
                label: "walkable",
                walkable: true,
                buildings: false,
                drivable: false,
            },
            "buildings" => Arm {
                label: "buildings",
                walkable: false,
                buildings: true,
                drivable: false,
            },
            "drivable" => Arm {
                label: "drivable",
                walkable: false,
                buildings: false,
                drivable: true,
            },
            "all" => Arm {
                label: "all",
                walkable: true,
                buildings: true,
                drivable: true,
            },
            other => {
                panic!("WALK_TRACE={other:?} is not one of none|walkable|buildings|drivable|all")
            }
        }
    }
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

    // ⚠ A SUBSET RUN IS NOT A GATING RUN, and it says so rather than passing
    // quietly: the floor comparison below is only a verdict over the days it
    // actually replayed. `WALK_DAYS=2026-06-16,2026-04-29` restricts it, which
    // is what makes a four-arm ablation affordable — the full corpus is 806 s
    // an arm. Mirrors `TRUTH_DAYS` in truth_corpus.
    if let Ok(only) = std::env::var("WALK_DAYS") {
        let want: Vec<&str> = only
            .split(',')
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .collect();
        names.retain(|n| want.iter().any(|d| n.starts_with(d)));
        assert!(
            !names.is_empty(),
            "WALK_DAYS={only:?} matched no fixture — a typo here reads as a clean run over nothing"
        );
        eprintln!(
            "walk_gate: WALK_DAYS restricts this run to {} day(s) — NOT a gating verdict",
            names.len()
        );
    }
    // One day at a time while iterating: the full corpus is ~5 minutes.
    if let Ok(only) = std::env::var("WALK_GATE_DAYS") {
        names.retain(|n| only.split(',').any(|d| n.starts_with(d)));
    }
    assert!(!names.is_empty(), "the corpus directory is empty");

    let mut days_req: Vec<Value> = Vec::new();
    let (mut way_table, mut building_table): (Vec<Value>, Vec<Value>) = (Vec::new(), Vec::new());
    let (mut way_index, mut building_index) = (
        std::collections::HashMap::<String, usize>::new(),
        std::collections::HashMap::<String, usize>::new(),
    );
    let mut baseline_req: Vec<Value> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let (mut osm_asked, mut osm_missed) = (0u64, 0u64);
    let mut no_walk_capture: Vec<String> = Vec::new();

    // ⚠ AN ATTRIBUTION CONTROL, NOT A KNOB TO LEAVE TURNED. `load_trace` feeds
    // THREE sections and turning all three on at once moved 204 of 238 walks
    // (#1418) — which says the trace did it, and nothing about WHICH part.
    // `WALK_TRACE=none|walkable|buildings|drivable|all` runs one arm; `none`
    // is the control that must reproduce the blessed floor exactly, because if
    // it does not, the drift is this harness rather than the roads.
    let arm = Arm::from_env();
    if arm.label != "none" {
        eprintln!(
            "walk_gate: TRACE ARM {} — not the gating default",
            arm.label
        );
    }

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

        // ⚠ WITHOUT THIS THE FOLD DRAWS EVERY WALK RAW, and the gate below then
        // measures the walk pass by never running it (#1418). The matcher's
        // roads arrive through day-shell's `walkableRoads` callback, which
        // answers from a loaded trace and EMPTY otherwise — and on empty,
        // `annotateWalkMatches` bails per leg and the raw drawing survives. It
        // is loaded per day, which is why that trace is no longer write-once.
        //
        // ⚠ A CAPTURE WITH NO WALKABLE SECTIONS IS A DIFFERENT THING FROM A
        // BROKEN ONE, and the difference is read off the fixture rather than off
        // the loader's error text. 2026-08-12 has neither section (pre-existing,
        // recorded on #1418): that day CANNOT exercise the matcher, and saying so
        // out loud is the point — silently letting it draw raw is the very
        // failure this change exists to end. A fixture that HAS the sections and
        // still will not load is a real failure and stays one.
        // ⚠ NON-EMPTY, not merely PRESENT. 2026-08-12 carries all three section
        // keys as empty objects, so a presence check calls it capturable and the
        // load then refuses it — which cost a 9-minute run to find out.
        let section_keys = |k: &str| {
            inputs
                .pointer(&format!("/osmTrace/{k}"))
                .and_then(Value::as_object)
                .map_or(0, serde_json::Map::len)
        };
        let has_sections = section_keys("walkableRoads") + section_keys("buildingsNear") > 0;
        if has_sections {
            let r = backend::osm_host::load_trace_sections(
                &format!("{GOLDEN}/{name}"),
                arm.walkable,
                arm.buildings,
                arm.drivable,
            );
            if let Err(e) = r {
                failures.push(format!("{name}: osm trace: {e}"));
                continue;
            }
        } else {
            // Leave NO trace loaded rather than the previous day's roads.
            no_walk_capture.push(name.clone());
        }

        let r = match converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{name}: converge: {e:#}"));
                continue;
            }
        };
        // ⚠ ASKED-AND-HIT, not "a trace loaded". A fixture whose keys the fold
        // never spells answers nothing and is indistinguishable from no fixture
        // at all — which is the exact failure this whole change is undoing.
        let c = backend::osm_host::take_counts();
        osm_asked += c.asked();
        osm_missed += c.misses();

        let out: Value = serde_json::from_str(&r.out).expect("the fold reply parses");
        let tz = fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");
        let windows = named_walk_windows(date, tz);
        let legs = walking_legs(&out, &r.request, &windows);
        let trace = inputs.get("osmTrace").cloned().unwrap_or_else(|| json!({}));

        // ⚠ WAYS AND BUILDINGS ARE SENT ONCE, NOT PER DAY. Measured 2026-09-03
        // over this corpus: 713,183 way items but 59,606 distinct, 132,502
        // buildings but 15,175 distinct — 91% of a 145 MiB request was the same
        // geometry re-sent, because 42 bboxes over one city overlap heavily.
        // That cost 3.9 GB here plus ~2.9 GB in Lean, and a run that size
        // starves anything building beside it (#1367).
        //
        // Dedupe is by the SERIALISED FORM, so two ways are shared only when
        // they are byte-identical — a coordinate differing in its last decimal
        // stays a separate entry rather than being silently fused.
        let day_ways: Vec<usize> = flatten_section(&trace, "walkableRoads")
            .into_iter()
            .map(|w| intern(&mut way_table, &mut way_index, w))
            .collect();
        let day_buildings: Vec<usize> = flatten_section(&trace, "buildingsNear")
            .iter()
            .map(ring_to_pairs)
            .map(|b| intern(&mut building_table, &mut building_index, b))
            .collect();
        days_req.push(json!({
            "date": date,
            "wayIdx": day_ways,
            "buildingIdx": day_buildings,
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

    // ⚠ THE WALK PASS'S INPUT, ASSERTED THE SAME WAY AND FOR THE SAME REASON.
    // An unanswered `walkableRoads` lookup is not an error: the callback returns
    // an empty way list, the matcher declines the leg, and the raw drawing
    // survives looking exactly like a leg the matcher considered and left alone.
    // So a silently trace-less run is a green run over a pass that never
    // executed — which is what #1418 measured, and it stayed invisible for as
    // long as nothing asserted the fold had ASKED and been ANSWERED.
    // ⚠ NAMED, NOT JUST COUNTED. A day that cannot run the matcher is a day
    // this gate does not cover, and a coverage hole nobody can see reads as
    // coverage.
    if !no_walk_capture.is_empty() {
        eprintln!(
            "walk_gate: {} of {} day(s) carry no walkable capture and drew every leg RAW: {}",
            no_walk_capture.len(),
            names.len(),
            no_walk_capture.join(", ")
        );
    }
    assert!(
        no_walk_capture.len() * 10 < names.len(),
        "{} of {} days have no walkable capture — the matcher is running on too \
         little of the corpus for this gate to mean what it says",
        no_walk_capture.len(),
        names.len()
    );

    //
    // ⚠ GATING RUNS ONLY. An ablation arm withholds sections ON PURPOSE, so its
    // lookups miss by design and these two would fire before the referee is
    // ever reached — which is exactly what happened the first time the arms were
    // run, and it made every control look like a failure of the harness.
    if arm.walkable {
        assert!(
            osm_asked > 0,
            "the fold never asked for a road or a building — the walk matcher did \
             not run, and every metric below is measuring the raw drawing"
        );
        assert!(
            osm_missed * 4 < osm_asked,
            "{osm_missed} of {osm_asked} OSM lookups went unanswered by the fixtures \
             — the fold is spelling keys these captures do not carry, so the legs it \
             could not match kept their raw drawing"
        );
    } else if arm.label != "none" {
        eprintln!(
            "walk_gate: arm {} — {osm_asked} lookup(s), {osm_missed} unanswered",
            arm.label
        );
    }

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
    eprintln!(
        "walk referee: {} way(s) and {} building(s) sent once, deduped from the days",
        way_table.len(),
        building_table.len()
    );
    let req = json!({
        "mode": "walkgate",
        "baseline": baseline_req,
        "days": days_req,
        "wayTable": way_table,
        "buildingTable": building_table,
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
    // #394 oracle transition (2026-09-03, see day_corpus's header): WALK_BLESS
    // rewrites walk-baseline.json from the measured set — every date this run
    // measured replaces its floor rows wholesale, in the floor's own shape
    // (JSON numbers, not the wire's bit patterns; `routeCorr` may be null).
    // 236 of 238 rows are identical either way; the point is the two walks a
    // shifted stay boundary re-keys. Bless deliberately, read the diff.
    if std::env::var("WALK_BLESS").is_ok() {
        let mut out: std::collections::BTreeMap<String, Value> = baseline
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let keys = [
            "budgetM",
            "lenM",
            "offPathM",
            "p90M",
            "routeCorr",
            "speedKmh",
            "stallM",
        ];
        for d in r["current"].as_array().map_or(&[][..], Vec::as_slice) {
            let date = d["date"].as_str().unwrap_or("");
            let rows: Vec<Value> = d["walks"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|w| {
                    let mut row = serde_json::Map::new();
                    row.insert("startTs".into(), w["startTs"].clone());
                    for k in keys {
                        row.insert(k.into(), bits_of(&w[k]).map_or(Value::Null, |v| json!(v)));
                    }
                    Value::Object(row)
                })
                .collect();
            out.insert(date.to_string(), Value::Array(rows));
        }
        let text = serde_json::to_string_pretty(&out).expect("the floor serialises");
        std::fs::write(BASELINE, text + "\n").expect("writing the walk floor");
        eprintln!("  BLESSED  walk-baseline.json rewritten from the measured set");
        return;
    }

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
    //
    // ⚠ BOTH ARE GATING-ARM ASSERTIONS. On any arm that answers `walkableRoads`
    // the matcher redraws the leg, so geometry MOVING is the measurement rather
    // than a fault — asserting here would abort before the regressions can be
    // read, which is exactly what blocked #1418's grading twice. The arm dumps
    // the referee's whole reply instead, and the caller grades it.
    if arm.label == "none" {
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
    } else {
        let out = format!(
            "{}/../target/walk-arm-{}.json",
            env!("CARGO_MANIFEST_DIR"),
            arm.label
        );
        std::fs::write(
            &out,
            serde_json::to_vec_pretty(&r).expect("the reply serialises"),
        )
        .unwrap_or_else(|e| panic!("writing {out}: {e}"));
        eprintln!(
            "walk_gate: arm {} — {moved} of {compared} moved; reply written to {out}",
            arm.label
        );
    }
    // ⚠ `unmeasured` IS EXPECTED TO BE ZERO NOW, and it is not asserted at
    // zero on purpose: a narrative that stops naming a street is a fact about
    // the corpus, not a defect, and it must surface rather than fail. A jump
    // back toward 45 means the parser or the tz resolution broke.
    eprintln!(
        "{} floor entries unmeasured (was 45 before the narrative parser landed, #1290)",
        n("unmeasured")
    );
}
