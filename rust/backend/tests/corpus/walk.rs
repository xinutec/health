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
//! **Measured 2026-09-09, and the shape changed when the matcher was turned on
//! (#1418).** Unsharded, the corpus was ~242 s with the matcher OFF and ~547 s
//! with it ON — so the matcher is ~305 s of it, running in the FOLD. Fitting
//! three corpus sizes gives **~38 s fixed + ~12.1 s per day**.
//!
//! Sharded in two, the `corpus replay gates` row went **639.7 s -> 376.5 s**
//! (shards at 326.6 s and 376.5 s; they contend, so each is slower than it would
//! be alone — the earlier single-shard model predicted 292 s and was 30% out).
//!
//! ⚠ **THE MATCHER'S ~305 s IS HIDDEN, NOT REMOVED.** Sharding spends cores that
//! were idle. `annotateWalkMatches`/`drawMatcher` is still the cost and it is
//! unprofiled.
//!
//! ⚠ It was going to MULTIPLY when the other three graders loaded a trace too,
//! and that is why #1418 stalled on cost. It does not any more: they read the
//! matched geometry off THIS replay (#1359), so the matcher is paid once per
//! day rather than once per harness.
//!
//! ⚠ **Two levers have been named wrongly from the shape of the code.** #1291's
//! `mkWalkGrid` targets the referee's off-walkable p90, which is 83% of the
//! REFEREE's cost but is NOT REQUESTED on a gating run (`want_p90` is
//! `WALK_GATE_DUMP`). #1359 shares one replay across the graders, which cut
//! total CPU and not this row's critical path. Profile before proposing a third.
//!
//! Remaining headroom from sharding alone is ~138 s: `hsmm_decode_corpus` runs
//! 238.6 s in this row and floors it.
//!
//! # ⚠ SHARDING AND THE ABLATION ARMS
//!
//! Grading shards by day; the referee is called once per shard over the days
//! that shard replayed, and the floor comparison is a verdict over those days
//! only. `WALK_BLESS` does NOT shard — it writes the floor WHOLE, so shard 0
//! measures every day and the others stand down.
//!
//! ⚠ **A NON-DEFAULT `WALK_TRACE` ARM STANDS THE OTHER GRADERS DOWN.** An arm
//! withholds trace sections on purpose, so the fold's geometry is ablated — and
//! `day`, `truth` and `journey` grading that geometry against their blessed
//! oracles would report a corpus-wide regression that is really the control
//! working as designed. `corpus_gate` runs walks ALONE on any arm but `all`.
//!
//! # Why this is local-only
//!
//! `tests/golden/days` is gitignored — the fixtures carry real coordinates,
//! place names and biometrics (#860). It ANNOUNCES A SKIP rather than passing
//! quietly, and it prints metrics only, never a coordinate.

use serde_json::{Value, json};

use super::Replay;

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
///
/// `Copy` because the runner both hands it to `Walk` and reads it per day to
/// mask the trace load.
#[derive(Clone, Copy)]
pub struct Arm {
    pub label: &'static str,
    pub walkable: bool,
    pub buildings: bool,
    pub drivable: bool,
}

impl Arm {
    /// ⚠ **THE DEFAULT IS `all`, AND IT IS THE GATING ARM.** The matcher runs
    /// in production — measured, `day-mirror` names 8 of 8 walking states on
    /// 2026-06-16 while `day-live` with no OSM source names 0 of 7 — so a gate
    /// that never loads a trace grades a pass the serving path does not execute.
    /// It was `none` until `d7bcd2e`; this comment said so until 2026-09-09,
    /// three commits after the flip.
    ///
    /// ⚠ THE 68 "REGRESSIONS" THE FLIP EXPOSED WERE GRADED, NOT BLESSED AWAY,
    /// and 62 of them were an artefact rather than a cost. They are `stall`,
    /// which compares the DRAWN line against the raw fixes — on the `none` arm
    /// the drawn line IS the raw fixes, so the floor holds a value measured
    /// against itself and any real geometry scores worse. The tell was that 62
    /// moved and NOT ONE improved, which is not what a real regression
    /// distribution looks like. The genuine cost is 4 walks; `offPath` improved
    /// 103:3 and corpus building-crossing metres fell 9765 -> 1253.
    ///
    /// The other arms are an ATTRIBUTION CONTROL, not a knob to leave turned:
    /// turning all three sections on at once moved 204 of 238 walks, which says
    /// the trace did it and nothing about WHICH part. `none` is the control that
    /// must reproduce the blessed floor exactly — if it does not, the drift is
    /// this harness rather than the roads.
    pub fn from_env() -> Self {
        match std::env::var("WALK_TRACE").as_deref().unwrap_or("all") {
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

pub struct Walk {
    baseline: Value,
    arm: Arm,
    days_req: Vec<Value>,
    baseline_req: Vec<Value>,
    way_table: Vec<Value>,
    building_table: Vec<Value>,
    way_index: std::collections::HashMap<String, usize>,
    building_index: std::collections::HashMap<String, usize>,
    no_walk_capture: Vec<String>,
    graded: usize,
    osm_asked: u64,
    osm_missed: u64,
}

impl Walk {
    /// `None` when the blessed floor is absent — announced by the caller.
    ///
    /// ⚠ NOT a defaulted parse. A floor that is PRESENT but does not parse has
    /// to stop the run: reading it as `{}` would leave every walk unfloored, the
    /// gate silent and the test green — the same silent-pass the non-vacuity
    /// assertion below catches, arriving one step earlier and looking even more
    /// like success. A floor that is ABSENT is a different thing and announces a
    /// skip, because it is gitignored beside the fixtures it describes.
    pub fn new(arm: Arm) -> Option<Self> {
        let baseline: Value = match std::fs::read_to_string(BASELINE) {
            Ok(text) => serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{BASELINE} is present but does not parse: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => panic!("reading {BASELINE}: {e}"),
        };
        Some(Self {
            baseline,
            arm,
            days_req: Vec::new(),
            baseline_req: Vec::new(),
            way_table: Vec::new(),
            building_table: Vec::new(),
            way_index: std::collections::HashMap::new(),
            building_index: std::collections::HashMap::new(),
            no_walk_capture: Vec::new(),
            graded: 0,
            osm_asked: 0,
            osm_missed: 0,
        })
    }

    /// A day whose fixture captured no walkable roads. ⚠ NAMED, NOT JUST
    /// COUNTED: a day that cannot run the matcher is a day this gate does not
    /// cover, and a coverage hole nobody can see reads as coverage.
    pub fn no_capture(&mut self, name: &str) {
        self.no_walk_capture.push(name.to_string());
    }

    pub fn grade(&mut self, name: &str, rep: &Replay) {
        let date = &name[..10];
        self.graded += 1;
        // ⚠ ASKED-AND-HIT, not "a trace loaded". A fixture whose keys the fold
        // never spells answers nothing and is indistinguishable from no fixture
        // at all — which is the exact failure #1418 was about.
        let c = backend::osm_host::take_counts();
        self.osm_asked += c.asked();
        self.osm_missed += c.misses();

        let inputs = &rep.fx["inputs"];
        let tz = rep
            .fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");
        let windows = named_walk_windows(date, tz);
        let legs = walking_legs(&rep.out, &rep.request, &windows);
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
            .map(|w| intern(&mut self.way_table, &mut self.way_index, w))
            .collect();
        let day_buildings: Vec<usize> = flatten_section(&trace, "buildingsNear")
            .iter()
            .map(ring_to_pairs)
            .map(|b| intern(&mut self.building_table, &mut self.building_index, b))
            .collect();
        self.days_req.push(json!({
            "date": date,
            "wayIdx": day_ways,
            "buildingIdx": day_buildings,
            "steps": steps_rows(inputs),
            "walks": legs,
        }));
        if let Some(b) = self.baseline.get(date) {
            self.baseline_req.push(json!({ "date": date, "walks": b }));
        }
    }

    pub fn finish(self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        // ⚠ THE WALK PASS'S INPUT, ASSERTED THE SAME WAY AND FOR THE SAME
        // REASON. An unanswered `walkableRoads` lookup is not an error: the
        // callback returns an empty way list, the matcher declines the leg, and
        // the raw drawing survives looking exactly like a leg the matcher
        // considered and left alone. So a silently trace-less run is a green run
        // over a pass that never executed — which is what #1418 measured, and it
        // stayed invisible for as long as nothing asserted the fold had ASKED
        // and been ANSWERED.
        if !self.no_walk_capture.is_empty() {
            eprintln!(
                "walks: {} of {} day(s) carry no walkable capture and drew every leg RAW: {}",
                self.no_walk_capture.len(),
                self.graded + self.no_walk_capture.len(),
                self.no_walk_capture.join(", ")
            );
        }
        let seen = self.graded + self.no_walk_capture.len();
        if self.no_walk_capture.len() * 10 >= seen {
            out.push(format!(
                "walks: {} of {seen} days have no walkable capture — the matcher is running on \
                 too little of the corpus for this gate to mean what it says",
                self.no_walk_capture.len()
            ));
            return out;
        }

        // ⚠ GATING RUNS ONLY. An ablation arm withholds sections ON PURPOSE, so
        // its lookups miss by design and these two would fire before the referee
        // is ever reached — which is exactly what happened the first time the
        // arms were run, and it made every control look like a failure of the
        // harness.
        if self.arm.walkable {
            if self.osm_asked == 0 {
                out.push(
                    "walks: the fold never asked for a road or a building — the walk matcher \
                     did not run, and every metric below is measuring the raw drawing"
                        .to_string(),
                );
                return out;
            }
            if self.osm_missed * 4 >= self.osm_asked {
                out.push(format!(
                    "walks: {} of {} OSM lookups went unanswered by the fixtures — the fold is \
                     spelling keys these captures do not carry, so the legs it could not match \
                     kept their raw drawing",
                    self.osm_missed, self.osm_asked
                ));
                return out;
            }
        } else if self.arm.label != "all" {
            eprintln!(
                "walks: arm {} — {} lookup(s), {} unanswered",
                self.arm.label, self.osm_asked, self.osm_missed
            );
        }

        // ⚠ THE CORRIDOR-STALL INPUT, ASSERTED SEPARATELY. `raw_in_window` reads
        // a JSON pointer, and a pointer at the wrong key yields an EMPTY SLICE
        // rather than an error. `maxCorridorStall` then returns 0 — a legitimate
        // value it cannot distinguish from a real one, for a line with no
        // corridor to compare against.
        //
        // That happened. The pointer said `/obs/rawFixes` where the day request
        // nests its inputs under `env`, so stall read 0.0 on all 238 walks. The
        // GATE DID NOT CATCH IT: `STALL_EPS_M` is 15 m and every floor stall on
        // this corpus is at or under 15, so the whole metric collapsed to zero
        // INSIDE its own tolerance and the verdict stayed green. A dead axis and
        // a clean one are indistinguishable from the verdict, so the FEED is
        // checked.
        let fed: usize = self
            .days_req
            .iter()
            .flat_map(|d| d["walks"].as_array().map_or(&[][..], Vec::as_slice))
            .filter(|w| w["raw"].as_array().is_some_and(|a| a.len() >= 2))
            .count();
        let total_walks: usize = self
            .days_req
            .iter()
            .map(|d| d["walks"].as_array().map_or(0, Vec::len))
            .sum();
        if fed * 2 <= total_walks {
            out.push(format!(
                "walks: only {fed} of {total_walks} walks carry raw GPS — corridor stall is \
                 measured against nothing and reads 0 for every one of them"
            ));
            return out;
        }

        // ⚠ `p90M` IS NOT REQUESTED ON A GATING RUN. It is 83% of the referee's
        // cost — it samples each line every 5 m and scans ~24k walkable ways per
        // sample — and the ratchet does not act on it (`Metric` has no `p90`
        // case). Asked for only when dumping, which is when a human is reading
        // the column or refreshing the floor.
        //
        // ⚠ An indexed nearest-way search was tried first and REFUTED: exact,
        // and 3.3x SLOWER (314s -> 1052s), because a bounding-box bound only
        // bites once `best` is small and nothing orders the ways by proximity
        // (#1291). Not computing the metric beats computing it faster.
        let want_p90 = std::env::var("WALK_GATE_DUMP").is_ok();
        eprintln!(
            "walks: {} way(s) and {} building(s) sent once, deduped from the days",
            self.way_table.len(),
            self.building_table.len()
        );
        let req = json!({
            "mode": "walkgate",
            "baseline": self.baseline_req,
            "days": self.days_req,
            "wayTable": self.way_table,
            "buildingTable": self.building_table,
            "wantP90": want_p90,
        });
        let reply = backend::lean::serve(&req.to_string()).expect("the referee must answer");
        let r: Value = serde_json::from_str(&reply).expect("the referee reply parses");
        assert!(
            r.get("error").is_none(),
            "referee refused the request: {reply}"
        );

        // Every walk the fold drew was measured. This is the CHAIN assertion —
        // the one thing that can be checked while the floor is stale.
        let measured: usize = r["current"].as_array().map_or(0, |ds| {
            ds.iter()
                .map(|d| d["walks"].as_array().map_or(0, Vec::len))
                .sum()
        });
        let drawn: usize = self
            .days_req
            .iter()
            .map(|d| d["walks"].as_array().map_or(0, Vec::len))
            .sum();
        if measured != drawn {
            out.push(format!(
                "walks: a drawn walk reached the referee and came back unmeasured \
                 ({measured} measured, {drawn} drawn)"
            ));
            return out;
        }
        if drawn == 0 {
            out.push(
                "walks: no golden day drew a walk — the chain is broken upstream of the referee"
                    .to_string(),
            );
            return out;
        }

        // ⚠ THE VERDICT ALONE CANNOT DISTINGUISH "agrees with the floor" from
        // #394 oracle transition (2026-09-03, see corpus/day.rs's header):
        // WALK_BLESS rewrites walk-baseline.json from the measured set — every
        // date this run measured replaces its floor rows wholesale, in the
        // floor's own shape (JSON numbers, not the wire's bit patterns;
        // `routeCorr` may be null). Bless deliberately, read the diff.
        //
        // ⚠ It writes the floor WHOLE, so the runner must hand it every day in
        // ONE process — see this module's header on why a bless does not shard.
        if std::env::var("WALK_BLESS").is_ok() {
            let mut floor: std::collections::BTreeMap<String, Value> = self
                .baseline
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
                floor.insert(date.to_string(), Value::Array(rows));
            }
            let text = serde_json::to_string_pretty(&floor).expect("the floor serialises");
            std::fs::write(BASELINE, text + "\n").expect("writing the walk floor");
            eprintln!("  BLESSED  walk-baseline.json rewritten from the measured set");
            return out;
        }

        // "never compared anything". Both read as zero regressions. So count, on
        // the raw numbers, how many paired walks actually MOVED — a run where
        // the gate is silent AND nothing moved is agreement; silent while
        // everything moved would mean the pairing quietly matched nothing.
        let mut compared = 0usize;
        let mut moved = 0usize;
        for d in r["current"].as_array().map_or(&[][..], Vec::as_slice) {
            let date = d["date"].as_str().unwrap_or("");
            let Some(floor) = self.baseline.get(date).and_then(Value::as_array) else {
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
        eprintln!("walks: {compared} paired with a floor, {moved} whose lenM moved >0.5 m");
        if compared == 0 {
            out.push(
                "walks: no current walk paired with any floor entry — the comparison was vacuous"
                    .to_string(),
            );
            return out;
        }

        // The referee as an ADJUDICATION tool, not only a gate. The deleted CLI
        // printed a per-walk table and several open tasks are arguments about
        // one named leg (#1056, #638, #385); without this they can only be
        // reasoned about from the floor file, which records what was blessed
        // rather than what the pipeline draws today.
        //
        // Metrics only — never a coordinate (#860).
        if std::env::var("WALK_GATE_DUMP").is_ok() {
            for d in r["current"].as_array().map_or(&[][..], Vec::as_slice) {
                let date = d["date"].as_str().unwrap_or("");
                let floor = self.baseline.get(date).and_then(Value::as_array);
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
            "walks: {drawn} walks over {} days — {} regressed, {} improved, \
             {} unmatched, {} added, {} unmeasured",
            self.days_req.len(),
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
        // It is NOT a second geometry check and must not be read as one.
        // Ablated 2026-08-31 by nudging every drawn line 22 m north: `moved`
        // stayed 0, because a rigid translation preserves length, while the gate
        // caught 6 of 7 walks. The two see different things and both are
        // load-bearing.
        //
        // ⚠ BOTH ARE GATING-ARM ASSERTIONS. On any arm that answers
        // `walkableRoads` the matcher redraws the leg, so geometry MOVING is the
        // measurement rather than a fault — asserting here would abort before
        // the regressions can be read, which is exactly what blocked #1418's
        // grading twice. The arm dumps the referee's whole reply instead, and
        // the caller grades it.
        if self.arm.label == "all" {
            if moved != 0 {
                out.push(format!(
                    "walks: {moved} of {compared} paired walks moved more than 0.5 m against the \
                     blessed floor — either the geometry changed or this harness stopped feeding \
                     the referee what the floor was blessed from"
                ));
            }
            if !r["passes"].as_bool().unwrap_or(false) {
                out.push(format!(
                    "walks: regressed against their floor: {}",
                    r["regressed"]
                ));
            }
        } else {
            let dump = format!(
                "{}/../target/walk-arm-{}.json",
                env!("CARGO_MANIFEST_DIR"),
                self.arm.label
            );
            std::fs::write(
                &dump,
                serde_json::to_vec_pretty(&r).expect("the reply serialises"),
            )
            .unwrap_or_else(|e| panic!("writing {dump}: {e}"));
            eprintln!(
                "walks: arm {} — {moved} of {compared} moved; reply written to {dump}",
                self.arm.label
            );
        }
        // ⚠ `unmeasured` IS EXPECTED TO BE ZERO NOW, and it is not asserted at
        // zero on purpose: a narrative that stops naming a street is a fact
        // about the corpus, not a defect, and it must surface rather than fail.
        // A jump back toward 45 means the parser or the tz resolution broke.
        eprintln!(
            "walks: {} floor entries unmeasured (was 45 before the narrative parser landed, #1290)",
            n("unmeasured")
        );
        out
    }
}
