//! The walk referee over the whole golden corpus, with no database:
//!
//! ```text
//!   fixture.inputs → head::capture → fold → episodes → walkgate → metrics
//! ```
//!
//! The logic is Lean's (`Verified.Eval.WalkMetrics` measures,
//! `Verified.Eval.WalkGate` judges); this file handles files. Every walk is
//! paired with its blessed floor (`tests/golden/walk-baseline.json`), and all
//! five axes gate: stall, off-path building crossing, step budget, the speed
//! ceiling, and route-correctness (`routeCorr`, scored by name against the
//! narratives, `Verified.Eval.GroundTruth`).
//!
//! # Arms
//!
//! `WALK_TRACE=none|walkable|buildings|drivable|all` chooses which recorded
//! matcher reads the fold is answered from; `all`, the default, is the gating
//! arm, since the matcher runs in production. The others are attribution
//! controls: `none` draws the raw walks. A non-default arm stands the other
//! graders down, since it ablates the geometry they grade. `WALK_DAYS=<dates>`
//! restricts the corpus.
//!
//! # Sharding
//!
//! Grading shards by day, and each shard's verdict covers its own days.
//! `WALK_BLESS` writes the floor whole, so it does not shard: shard 0 measures
//! every day and the others stand down.
//!
//! `tests/golden/days` is gitignored (real coordinates and places), so without
//! it this announces a skip, and it prints metrics only, never a coordinate.

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
/// window. ⚠ From `env.rawFixes`, where the day request nests them: a pointer
/// at the wrong key yields an empty slice, not an error. The bit strings pass
/// through untouched.
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

/// The day's enforceable named-walk windows, as `(startTs, endTs, wayName)`:
/// what makes `routeCorr` measurable.
///
/// A row must be a walking truth, name a way, and be enforceable (a definite
/// verdict with `corroborated`/`user`/`derived` provenance): an `inferred` row
/// comes from the pipeline's own output and would make its guess the standard.
/// The zone is the fixture's (a narrative may declare its own with `Times:`).
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

/// The walk matcher's identity report for the segment covering `[start, end)`
/// (`Seg.walkWayUm`): where the route ran, and for how far. A diagnostic, not a
/// metric. Matched on exact bounds: a walking episode keeps its segment's
/// window, so a near miss means they diverged.
fn way_um_for(out: &Value, start: i64, end: i64) -> Vec<Value> {
    out.get("segs")
        .and_then(Value::as_array)
        .and_then(|segs| {
            segs.iter().find(|s| {
                s.get("startTs").and_then(Value::as_i64) == Some(start)
                    && s.get("endTs").and_then(Value::as_i64) == Some(end)
            })
        })
        .and_then(|s| s.get("walkWayUm"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Whether the fold had building outlines for this leg's ground
/// (`Seg.walkBuildingsMeasured`, joined from `segs` by window). Absent means no
/// read was made for this leg, so the day's other outlines are not its ground.
fn buildings_measured_for(out: &Value, start: i64, end: i64) -> bool {
    out.get("segs")
        .and_then(Value::as_array)
        .and_then(|segs| {
            segs.iter().find(|s| {
                s.get("startTs").and_then(Value::as_i64) == Some(start)
                    && s.get("endTs").and_then(Value::as_i64) == Some(end)
            })
        })
        .and_then(|s| s.get("walkBuildingsMeasured"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The walking legs of a fold reply, with the line the map would draw.
/// `acceptedNames` comes from the narrative (`named_walk_windows`); an empty
/// list leaves `routeCorr` unmeasured, not scored 0.
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
                // Joined from `segs`: the report is on the segment, and episodes
                // drop it.
                "wayUm": way_um_for(out, start, end),
                // Per leg, and the fold's own answer.
                "buildingsMeasured": buildings_measured_for(out, start, end),
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
    /// The arm from `WALK_TRACE`, `all` by default: the gating arm, since the
    /// matcher runs in production. The others attribute drift to a trace
    /// section; `none` must reproduce the floor exactly, or the drift is this
    /// harness.
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
    /// Per day: `(date, legs, unmeasured, their startTs)`.
    coverage: Vec<(String, usize, usize, Vec<i64>)>,
    graded: usize,
    osm_asked: u64,
    osm_missed: u64,
    /// Misses on days the capture itself recorded the mirror DECLINING (no
    /// coverage: the travel days off the mirror's ground, 09-30 and 10-01).
    /// A coverage gap, not a key the fold spells and the capture lacks, so it
    /// is reported beside the ratio rather than in it.
    osm_missed_uncovered: u64,
}

impl Walk {
    /// `None` when the blessed floor is absent (gitignored beside the
    /// fixtures), announced by the caller. A floor that is present but does not
    /// parse stops the run: read as `{}`, every walk would go unfloored and the
    /// test would pass.
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
            coverage: Vec::new(),
            graded: 0,
            osm_asked: 0,
            osm_missed: 0,
            osm_missed_uncovered: 0,
        })
    }

    /// A day whose fixture captured no walkable roads, named: a day that cannot
    /// run the matcher is a hole in this gate.
    pub fn no_capture(&mut self, name: &str) {
        self.no_walk_capture.push(name.to_string());
    }

    pub fn grade(&mut self, name: &str, rep: &Replay) {
        let date = &name[..10];
        self.graded += 1;
        // Asked and answered, not "a trace loaded": keys the fold never spells
        // answer nothing.
        let (hits, misses) = rep.osm_counts();
        let declined = rep.fx["inputs"]["osmRowSet"]["declined"]
            .as_array()
            .is_some_and(|d| !d.is_empty());
        if declined {
            self.osm_missed_uncovered += misses;
        } else {
            self.osm_asked += hits + misses;
            self.osm_missed += misses;
        }

        let inputs = &rep.fx["inputs"];
        let tz = rep
            .fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");
        let windows = named_walk_windows(date, tz);
        let trace = inputs.get("osmTrace").cloned().unwrap_or_else(|| json!({}));
        let legs = walking_legs(&rep.out, &rep.request, &windows);
        // The coverage report prints every time: a report that speaks only on a
        // bad day cannot tell "all covered" from "the test stopped working".
        let unmeasured = legs
            .iter()
            .filter(|l| l["buildingsMeasured"] == json!(false))
            .count();
        // Named, not counted, so a leg that loses the wall lens is identifiable.
        let unmeasured_at: Vec<i64> = legs
            .iter()
            .filter(|l| l["buildingsMeasured"] == json!(false))
            .filter_map(|l| l["startTs"].as_i64())
            .collect();
        self.coverage
            .push((date.to_string(), legs.len(), unmeasured, unmeasured_at));

        // Ways and buildings are sent once for the run, not per day: the days'
        // boxes overlap heavily, and re-sending them was 91% of the request.
        // Deduplicated by serialised form, so only byte-identical geometry is
        // shared.
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
        // The wall-coverage report, always printed, in the truth grader's clock.
        let hm = |ts: i64| {
            let secs = ts.rem_euclid(86_400);
            format!("{:02}:{:02}Z", secs / 3600, (secs % 3600) / 60)
        };
        let legs: usize = self.coverage.iter().map(|(_, n, _, _)| n).sum();
        let unmeasured: usize = self.coverage.iter().map(|(_, _, u, _)| u).sum();
        eprintln!(
            "walks: building ground — {} of {legs} leg(s) UNMEASURED over {} day(s)",
            unmeasured,
            self.coverage.len()
        );
        for (date, n, u, at) in &self.coverage {
            if *u > 0 {
                eprintln!(
                    "      {date}: {u} of {n} leg(s) score no wall metric — unmeasured, not clean; at {}",
                    at.iter().map(|t| hm(*t)).collect::<Vec<_>>().join(", ")
                );
            }
        }
        // The walk pass's input, asserted: an unanswered `walkableRoads` lookup
        // makes the matcher decline, and the raw drawing then looks like a leg
        // the matcher left alone, a green run over a pass that never ran.
        if !self.no_walk_capture.is_empty() {
            eprintln!(
                "walks: {} of {} day(s) carry no walkable capture and drew every leg RAW: {}",
                self.no_walk_capture.len(),
                self.graded + self.no_walk_capture.len(),
                self.no_walk_capture.join(", ")
            );
        }
        let seen = self.graded + self.no_walk_capture.len();
        // A third of the shard's days: the failure caught is systemic (most days
        // draw raw), and one day the capture genuinely lacks must not trip it.
        if self.no_walk_capture.len() * 3 > seen {
            out.push(format!(
                "walks: {} of {seen} days have no walkable capture — the matcher is running on \
                 too little of the corpus for this gate to mean what it says",
                self.no_walk_capture.len()
            ));
            return out;
        }

        // Gating runs only: an ablation arm withholds sections on purpose, so its
        // lookups miss by design.
        if self.osm_missed_uncovered > 0 {
            eprintln!(
                "walks: {} OSM lookup(s) unanswered on days whose capture the mirror declined \
                 (no coverage there) — not counted against the spelling ratio below",
                self.osm_missed_uncovered
            );
        }
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

        // The corridor-stall input, asserted: a wrong pointer yields an empty
        // slice and a stall of 0, inside the metric's 15 m tolerance, so a dead
        // axis would read green.
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

        // `p90M` only when dumping: it is most of the referee's cost (a sample
        // every 5 m against ~24k ways) and the ratchet does not act on it.
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

        // WALK_BLESS rewrites walk-baseline.json from the measured set: each date
        // measured replaces its floor rows wholesale, in the floor's shape (JSON
        // numbers; `routeCorr` may be null). Bless deliberately and read the diff.
        // It writes the floor whole, so it needs every day in one process.
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
        // The building-crossing SIGNAL, counted on both sides. See the guard
        // below for why a count and not a value.
        let mut floor_crossings = 0usize;
        let mut now_crossings = 0usize;
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
                if b["offPathM"].as_f64().is_some_and(|v| v > 0.0) {
                    floor_crossings += 1;
                }
                if bits_of(&w["offPathM"]).is_some_and(|v| v > 0.0) {
                    now_crossings += 1;
                }
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

        // A per-walk table, for arguing about one named leg against what the
        // pipeline draws today rather than what the floor recorded. Metrics only,
        // never a coordinate.
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
                    // Coverage on its own line, with no floor column: no baseline
                    // holds it.
                    eprintln!(
                        "{date} ts={ts}  COVER  raw {:>7}  matched/raw {:>5}  \
                         coverMax {:>7}  cover90 {:>7}  uncov {:>5}  headGap {:>6}  \
                         tailGap {:>6}",
                        g("rawLenM"),
                        match (bits_of(&w["lenM"]), bits_of(&w["rawLenM"])) {
                            (Some(l), Some(r)) if r > 0.0 => format!("{:.2}", l / r),
                            _ => "null".into(),
                        },
                        g("coverMaxM"),
                        g("cover90M"),
                        bits_of(&w["uncoveredFrac"]).map_or("null".into(), |v| format!("{v:.2}")),
                        g("headGapM"),
                        g("tailGapM"),
                    );
                    // On its own line, only when non-empty, as a share: `wayUm`
                    // is the matcher's integer unit, which never converts to
                    // metres.
                    let raw: Vec<(String, u64)> = w["wayUm"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|e| {
                                    let p = e.as_array()?;
                                    Some((p.first()?.as_str()?.to_string(), p.get(1)?.as_u64()?))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let total: u64 = raw.iter().map(|(_, u)| *u).sum();
                    let report: Vec<String> = raw
                        .iter()
                        .map(|(n, u)| {
                            // Denominator is the NAMED arc only — unnamed ways
                            // never reach this report, so these sum to 100%
                            // and do not describe the whole route.
                            let pct = if total == 0 {
                                0.0
                            } else {
                                (*u as f64) * 100.0 / (total as f64)
                            };
                            format!("{n}={pct:.0}%")
                        })
                        .collect();
                    if !report.is_empty() {
                        eprintln!(
                            "{date} ts={ts}  route (share of NAMED arc) {}",
                            report.join("  ")
                        );
                    }
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
        // `moved` is the non-vacuity witness, asserted: a pairing bug that
        // matched nothing would also leave `regressed` empty. It is not a
        // geometry check (a rigid shift keeps every length); the gate is.
        //
        // Gating arm only: on another arm the matcher redraws legs, so movement
        // is the measurement, not a fault.
        if self.arm.label == "all" {
            // A guard on the building detector: a detector stubbed to `false`
            // reads every crossing as 0, which the ratchet scores as an
            // improvement everywhere. A count, not a value: one walk may reach
            // 0, but the floor having crossings and the run finding none cannot
            // happen.
            if floor_crossings > 0 && now_crossings == 0 {
                out.push(format!(
                    "walks: the floor records {floor_crossings} walk(s) crossing a building on                      these days and this run found NONE — the building detector is answering                      nothing, which the ratchet scores as an improvement on every walk"
                ));
            }
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
        // `unmeasured` should be zero, and is printed, not asserted: a narrative
        // that stops naming a street surfaces here. A jump means the parser or
        // the zone resolution broke.
        eprintln!(
            "walks: {} floor entries unmeasured (was 45 before the narrative parser landed, #1290)",
            n("unmeasured")
        );
        out
    }
}
