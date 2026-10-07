//! The WORLDLINE-FEASIBILITY ceiling — the fifth grader behind the one replay.
//!
//! ```text
//!   fixture → trace → fold → states ─┐
//!   fixture.osmTrace.stationsOnLine ──┴→ feasibility → ceilinggate
//! ```
//!
//! The user's standing requirement, 2026-09-01: *"Correct or at least viable
//! trajectory is important. It shouldn't show definitely-wrong interpretations
//! that can't be right given the data."* A model-independent assertion on the
//! OUTPUT: a real worldline is one continuous path through space-time, so some
//! drawn timelines are impossible regardless of how the cascade produced them.
//! Five invariants — `impossible-mode-kinematics` (a walk at vehicle pace, and
//! a train at pedestrian pace while the wearer steps), `invalid-rail-triple`
//! (a line labelled through a station it does not reach), `teleport` (two
//! stays at different places too far apart for the time between),
//! `rail-discontinuity` and `degenerate-train-leg`.
//!
//! ⚠ **IT WAS A SEPARATE TEST WITH ITS OWN FOLD, AND THAT IS WHY IT FOUND
//! REGRESSIONS LAST.** `suite::feasibility_corpus` re-folded all 45 days on
//! its own, so it was too slow for the commit table and ran only in
//! `deploy.sh`'s full gate — and never in the `CORPUS_DAYS=` replays a change is
//! developed against. On 2026-09-27 a rail-anchor change passed every replay
//! it was checked with and failed the deploy tree on 07-16's ceiling, 0 → 1,
//! an hour later (#1654). Behind the shared replay it costs one Lean question
//! per day already folded, so it is judged on every day anyone replays.
//!
//! # A CEILING, not a floor, and the ratchet is the other way
//!
//! `feasibility-baseline.json`, `rail-triple-baseline.json` and
//! `teleport-baseline.json` record standing defects as per-day COUNTS that may only shrink. A day emitting more than its
//! committed count fails; fewer is an improvement to re-bless with
//! `FEASIBILITY_BLESS=1` (single-shard, like every bless in this runner).
//!
//! ⚠ SILENCE IS NOT ZERO. `current[date] ?? 0` cannot tell a day with no
//! defects from a day that never ran, and against a non-zero ceiling the second
//! reads as the first — so a change that breaks a fixture AND worsens that day
//! would report as an IMPROVEMENT. `measured` and `attempted` are passed
//! separately for exactly that reason; see `Verified.Eval.CeilingGate`.
//!
//! Sharding is sound the way it is for the floors: the committed ceiling is
//! filtered to the days this shard attempted, and between the shards every
//! ceiling key is checked exactly once.
//!
//! `FEASIBILITY_DEBUG` prints every violation; `FEASIBILITY_DUMP=<path>`
//! writes the `(legs, points, steps, lineStations)` each day was judged on.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::Replay;

/// `(label, violation kind, baseline file)`: each kind with a standing count.
const CEILINGS: [(&str, &str, &str); 3] = [
    (
        "kinematic",
        "impossible-mode-kinematics",
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/golden/feasibility-baseline.json"
        ),
    ),
    (
        "rail-triple",
        "invalid-rail-triple",
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/golden/rail-triple-baseline.json"
        ),
    ),
    (
        "teleport",
        "teleport",
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/golden/teleport-baseline.json"
        ),
    ),
];

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

/// `[[ts, a, b, …]]` rows out of the day request, as `{ts, <k1>, <k2>}` objects.
///
/// ⚠ `/env/points` carries lat/lon as IEEE-754 bit strings and the Lean wire
/// reads either encoding, so they are passed through UNTOUCHED — re-parsing
/// them here would put a rounding step between the fold and the invariant that
/// judges it.
fn rows(request: &Value, at: &str, keys: &[&str]) -> Vec<Value> {
    request
        .pointer(at)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let t = p.as_array()?;
                    let mut o = serde_json::Map::new();
                    o.insert("ts".into(), t.first()?.clone());
                    for (i, k) in keys.iter().enumerate() {
                        o.insert((*k).into(), t.get(i + 1)?.clone());
                    }
                    Some(Value::Object(o))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub struct Feasibility {
    /// Per `CEILINGS` entry: the committed counts and this run's.
    base: Vec<BTreeMap<String, u64>>,
    now: Vec<BTreeMap<String, u64>>,
    measured: BTreeSet<String>,
    attempted: BTreeSet<String>,
    failures: Vec<String>,
    dump: Option<String>,
    dumped: Vec<String>,
}

impl Feasibility {
    /// Every ceiling is tracked, so unlike the narrative graders this one has
    /// no skip: a missing baseline is a broken checkout, not an absent corpus.
    pub fn new() -> Self {
        Self {
            base: CEILINGS.iter().map(|c| load(c.2)).collect(),
            now: vec![BTreeMap::new(); CEILINGS.len()],
            measured: BTreeSet::new(),
            attempted: BTreeSet::new(),
            failures: Vec::new(),
            dump: std::env::var("FEASIBILITY_DUMP").ok(),
            dumped: Vec::new(),
        }
    }

    pub fn grade(&mut self, name: &str, rep: &Replay) {
        let date = &name[..10];
        self.attempted.insert(date.to_string());

        let legs: Vec<Value> = rep.out["states"]
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|s| {
                json!({
                    "startTs": s["startTs"], "endTs": s["endTs"],
                    "mode": s["mode"], "wayName": s["wayName"],
                    "place": s["place"], "placeAt": s["placeAt"],
                })
            })
            .collect();
        // ⚠ NON-VACUITY: a moved key yields an EMPTY slice, not an error, and an
        // empty timeline has no impossible leg in it.
        if legs.is_empty() {
            self.failures
                .push(format!("{name}: the fold produced no legs to judge"));
            return;
        }
        let points = rows(&rep.request, "/env/points", &["lat", "lon"]);
        let steps = rows(&rep.request, "/env/steps", &["steps"]);
        let acc_fixes = rows(&rep.request, "/env/rawFixes", &["lat", "lon", "accuracy"]);
        // Line membership from the fixture's own recorded trace. A day whose
        // capture never asked for a line contributes NOTHING here rather than
        // an empty list — see the mode's header.
        let line_stations: Vec<Value> = rep
            .fx
            .pointer("/inputs/osmTrace/stationsOnLine")
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

        if self.dump.is_some() {
            self.dumped.push(
                json!({ "date": date, "legs": legs, "points": points,
                        "steps": steps, "lineStations": line_stations,
                        "accFixes": acc_fixes })
                .to_string(),
            );
        }

        let req = json!({
            "mode": "feasibility", "legs": legs, "points": points,
            "steps": steps, "lineStations": line_stations, "accFixes": acc_fixes,
        });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{name}: the invariants must answer: {e:#}"));
        let fr: Value = serde_json::from_str(&reply).expect("the reply parses");
        assert!(fr.get("error").is_none(), "{name}: refused: {fr}");

        self.measured.insert(date.to_string());
        let mut counts = vec![0u64; CEILINGS.len()];
        for v in fr["violations"].as_array().map_or(&[][..], Vec::as_slice) {
            let (kind, detail) = (
                v["kind"].as_str().unwrap_or("?"),
                v["detail"].as_str().unwrap_or(""),
            );
            match CEILINGS.iter().position(|c| c.1 == kind) {
                Some(i) => counts[i] += 1,
                // ⚠ CONTINUITY AND SELF-RIDE ARE AT ZERO AND HAVE NO CEILING
                // FILE. They are hard failures, not standing debt: there is no
                // committed count for them, so any occurrence is reported and
                // fails below rather than being silently tolerated.
                None => self.failures.push(format!("{date}: {kind} — {detail}")),
            }
            if std::env::var("FEASIBILITY_DEBUG").is_ok() {
                eprintln!("      {date} {kind} {detail}");
            }
        }
        for (now, n) in self.now.iter_mut().zip(counts) {
            if n > 0 {
                now.insert(date.to_string(), n);
            }
        }
    }

    /// The ceiling gate over everything this shard graded. Returns the
    /// failures rather than asserting, so the runner can name WHICH grader
    /// failed.
    pub fn finish(self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Some(path) = &self.dump {
            std::fs::write(path, self.dumped.join("\n")).expect("the dump is writable");
            eprintln!("feasibility: dumped {} day(s) to {path}", self.dumped.len());
        }

        let measured_v: Vec<&String> = self.measured.iter().collect();
        let attempted_v: Vec<&String> = self.attempted.iter().collect();
        // The other shards' days leave the committed side, or they read as
        // unmeasured here on every run (#408).
        let mine = |committed: &BTreeMap<String, u64>| -> BTreeMap<String, u64> {
            committed
                .iter()
                .filter(|(d, _)| self.attempted.contains(*d))
                .map(|(d, n)| (d.clone(), *n))
                .collect()
        };
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
        let mine_all: Vec<BTreeMap<String, u64>> = self.base.iter().map(mine).collect();
        let gates: Vec<Value> = mine_all
            .iter()
            .zip(&self.now)
            .map(|(m, n)| gate(m, n))
            .collect();
        for (c, g) in CEILINGS.iter().zip(&gates) {
            assert!(g.get("error").is_none(), "{} gate: {g}", c.0);
        }

        if std::env::var("FEASIBILITY_BLESS").is_ok() {
            // ⚠ The runner made this a single shard measuring every day, so the
            // FULL committed ceiling is the right input here, not `mine`.
            for ((c, committed), current) in CEILINGS.iter().zip(&self.base).zip(&self.now) {
                let path = c.2;
                let req = json!({
                    "mode": "ceilingbless",
                    "committed": ceiling_wire(committed),
                    "current": ceiling_wire(current),
                    "measured": measured_v,
                });
                let reply = backend::lean::serve(&req.to_string()).expect("the bless must answer");
                let r: Value = serde_json::from_str(&reply).expect("the bless reply parses");
                let mut o = serde_json::Map::new();
                for e in r["ceiling"].as_array().map_or(&[][..], Vec::as_slice) {
                    if let Some(d) = e["date"].as_str() {
                        o.insert(d.to_string(), e["count"].clone());
                    }
                }
                let text = serde_json::to_string_pretty(&Value::Object(o)).expect("serialises");
                std::fs::write(path, format!("{}\n", text.replace("  ", "\t"))).expect("writable");
                eprintln!("feasibility: re-blessed {path}");
            }
            return out;
        }

        let empty: &[Value] = &[];
        let mut regressions: Vec<String> = Vec::new();
        for (c, g) in CEILINGS.iter().zip(&gates) {
            let label = c.0;
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
        let tally: Vec<String> = CEILINGS
            .iter()
            .zip(&self.now)
            .zip(&mine_all)
            .map(|((c, now), m)| {
                format!(
                    "{} {} (ceiling {})",
                    c.0,
                    now.values().sum::<u64>(),
                    m.values().sum::<u64>()
                )
            })
            .collect();
        eprintln!(
            "feasibility: over {} day(s): {}",
            self.measured.len(),
            tally.join(", ")
        );

        if !self.failures.is_empty() {
            out.push(format!(
                "feasibility: violations with NO ceiling — these are hard failures:\n{}",
                self.failures.join("\n")
            ));
        }
        if !regressions.is_empty() {
            out.push(format!(
                "feasibility: FAIL — {} day(s) above their ceiling:\n{}",
                regressions.len(),
                regressions.join("\n")
            ));
        }
        out
    }
}
