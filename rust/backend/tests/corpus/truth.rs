//! The provenance-aware truth gate over the golden corpus, with no database.
//!
//! ```text
//!   fixture.inputs → head::capture → fold → states ─┐
//!   ground-truth/<date>.md → Lean parse → tz resolve ───┴→ truthcheck → floorgate
//! ```
//!
//! Grades the pipeline against what a human wrote down, so it cannot be
//! blessed away: `ratchetUpFloor` takes a union, and a row that stops holding
//! keeps failing until the narrative stops describing it. The logic is
//! `Verified.Eval.TruthCheck` and `FloorGate`; this file replays and prints.
//!
//! Grading shards (floor and `KNOWN_UNHELD` filtered to the days run).
//! `TRUTH_BLESS` does not: it rewrites one floor file, so `corpus_gate` runs
//! shard 0 over all days for a bless.
//!
//! `tests/golden/{days,ground-truth}` is gitignored (real places and
//! biometrics); `truth-baseline.json` holds timestamps only and is tracked. A
//! missing corpus is announced as a skip; output never prints a place.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::Replay;

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);
/// The name-confidence measurement, one JSON line per date: per naming rule,
/// how many of the day's graded stay rows its names got right.
pub const NAME_CONFIDENCE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/name-confidence.jsonl"
);

/// Per naming rule, `(right, graded)` over one day's stay rows with a clean
/// verdict, counted under the rule that named the `covering` state. Rows whose
/// verdict came from no stay, and states with no rule, are not counted.
pub fn name_confidence_counts(
    rows: &[Value],
    verdicts: &[Value],
    covering: &[Value],
    states: &[Value],
) -> BTreeMap<String, (u64, u64)> {
    let mut out: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for (i, (row, v)) in rows.iter().zip(verdicts).enumerate() {
        let t = &row["truth"];
        if !matches!(t["mode"].as_str(), Some("stationary" | "sleeping"))
            || t["place"].as_str().is_none()
        {
            continue;
        }
        let right = match v.as_str() {
            Some("verified" | "cleared") => true,
            Some("regressed" | "known-error") => false,
            _ => continue,
        };
        let Some(st) = covering
            .get(i)
            .and_then(Value::as_u64)
            .and_then(|k| states.get(usize::try_from(k).ok()?))
        else {
            continue;
        };
        if !matches!(st["mode"].as_str(), Some("stationary" | "sleeping")) {
            continue;
        }
        let Some(src) = st["placeConfidenceKey"].as_str() else {
            continue;
        };
        let e = out.entry(src.to_string()).or_default();
        e.0 += u64::from(right);
        e.1 += 1;
    }
    out
}

/// Per date `[within, total]`: the confirmed stay edges (an arrival or a
/// departure the narrative wrote) the served stay puts within
/// `EDGE_WITHIN_S`. A floor: `within` may not fall. `EDGE_BLESS` rewrites it.
const EDGE_BASELINE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/edge-baseline.json"
);
const EDGE_WITHIN_S: i64 = 120;

const BASELINE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/truth-baseline.json"
);

/// The confirmed rows that do not hold, exempted by name so the rest can gate.
/// Still in the floor, printed every run, and failing if one holds again.
///
/// ⚠ An entry must be a pipeline defect confirmed against the fixes, and a
/// narrative row is re-cut only to what the fixes show, never to what the
/// pipeline drew: that would make the corpus self-referential.
///
/// The two shops 49 m apart decode as one stay at the mined place beside them
/// (`stayMove`); the user ruled the merge a lesser defect than one-minute stays.
const KNOWN_UNHELD: [(&str, i64, &str); 6] = [
    (
        "2026-06-09",
        1_781_027_880,
        "Olivomare named The Plumbers Arms by his habits (a pub and a restaurant 22 m apart)",
    ),
    (
        "2026-06-09",
        1_781_035_560,
        "Black Sheep Coffee, named by his habits, yields to the station just alighted at",
    ),
    (
        "2026-10-06",
        1_791_291_780,
        "La Viña named Cafe de Finca by his habits (a bar and a café a metre apart)",
    ),
    (
        "2026-11-08",
        1_794_148_740,
        "The Chess Shop named David Wej by his habits (a shop his habits have never seen)",
    ),
    (
        "2026-06-24",
        1_782_326_820,
        "Currys merged with Lidl into one stay (stayMove at a listed place)",
    ),
    (
        "2026-06-24",
        1_782_327_360,
        "Lidl merged with Currys into one stay (stayMove at a listed place)",
    ),
];

/// A day's rows, resolved to unix seconds, ready for `truthcheck`.
struct Resolved {
    rows: Vec<Value>,
    /// Window starts, positionally aligned with `rows` — the floor's keys.
    starts: Vec<i64>,
}

/// Parse a narrative and resolve its civil windows in the zone
/// `parseGroundTruth` read it in (a `Times:` line can override the fixture's).
fn resolve_narrative(date: &str, tz: &str) -> Option<Resolved> {
    let md = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md")).ok()?;
    let req = json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz });
    let reply = backend::lean::serve(&req.to_string())
        .unwrap_or_else(|e| panic!("{date}: the narrative parser must answer: {e:#}"));
    let r: Value = serde_json::from_str(&reply).expect("the parser reply parses");
    assert!(r.get("error").is_none(), "{date}: parser refused: {r}");
    let zone = r["tz"].as_str().unwrap_or(tz);

    let (mut rows, mut starts) = (Vec::new(), Vec::new());
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
            // A window that will not resolve takes its truth claim with it, and
            // a floor key that can never be satisfied fails forever. Loud.
            panic!("{date}: a row's civil time did not resolve in {zone}");
        };
        rows.push(json!({
            "startTs": a, "endTs": b,
            "status": row["status"], "provenance": row["provenance"], "truth": row["truth"],
        }));
        starts.push(a);
    }
    Some(Resolved { rows, starts })
}

/// The floor wire: a date-keyed JSON object becomes `[{date, keys}]`.
fn to_wire(map: &BTreeMap<String, Vec<i64>>) -> Vec<Value> {
    map.iter()
        .map(|(d, ks)| json!({ "date": d, "keys": ks }))
        .collect()
}

pub struct Truth {
    baseline: BTreeMap<String, Vec<i64>>,
    /// Per-date: rows satisfied now, every enforceable `correct` row the
    /// narrative still describes, and the ones standing regressed.
    verified: BTreeMap<String, Vec<i64>>,
    described: BTreeMap<String, Vec<i64>>,
    standing: BTreeMap<String, Vec<i64>>,
    /// Days that produced a truth report at all. A day whose fixture threw or
    /// whose narrative is gone measured nothing, which to a floor gate looks
    /// like losing everything; excluded by name.
    reported: BTreeSet<String>,
    /// `TRUTH_ROWS_OUT`: every narrative row with its resolved window, one
    /// JSON line per date, appended so the shards do not clobber each other.
    rows_out: Option<String>,
    /// Per date, each confirmed stay edge's error in seconds (served − truth).
    edges: BTreeMap<String, Vec<i64>>,
    failures: Vec<String>,
    /// Injection makes the run report-only: a floor graded on injected priors
    /// would enforce against an arm nobody blessed.
    report_only: bool,
    tally_v: usize,
    tally_r: usize,
    tally_k: usize,
    tally_c: usize,
    tally_u: usize,
    /// Rows that produced no verdict, by date, split by cause:
    /// `(untrusted, unstatused)`. `rowVerdict` has two ways in, and a bare
    /// count mixes them.
    ungraded: BTreeMap<String, (usize, usize)>,
    /// The blessed name-confidence counts by date (`NAME_CONFIDENCE`).
    name_confidence: BTreeMap<String, BTreeMap<String, (u64, u64)>>,
}

impl Truth {
    /// `None` when there are no narratives to grade against.
    pub fn new(report_only: bool) -> Option<Self> {
        if !std::path::Path::new(NARRATIVES).is_dir() {
            return None;
        }
        let baseline: BTreeMap<String, Vec<i64>> = serde_json::from_str(
            &std::fs::read_to_string(BASELINE)
                .expect("the truth floor is tracked and must be readable"),
        )
        .expect("the truth floor parses");
        Some(Self {
            baseline,
            verified: BTreeMap::new(),
            described: BTreeMap::new(),
            standing: BTreeMap::new(),
            reported: BTreeSet::new(),
            rows_out: std::env::var("TRUTH_ROWS_OUT").ok(),
            edges: BTreeMap::new(),
            failures: Vec::new(),
            report_only,
            tally_v: 0,
            tally_r: 0,
            tally_k: 0,
            tally_c: 0,
            tally_u: 0,
            ungraded: BTreeMap::new(),
            name_confidence: std::fs::read_to_string(NAME_CONFIDENCE)
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .map(|j| {
                    let counts = j["counts"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .map(|(k, v)| {
                                    let g =
                                        |i: usize| v.get(i).and_then(Value::as_u64).unwrap_or(0);
                                    (k.clone(), (g(0), g(1)))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (j["date"].as_str().unwrap_or_default().to_string(), counts)
                })
                .collect(),
        })
    }

    pub fn grade(&mut self, name: &str, rep: &Replay) {
        let date = &name[..10];
        let tz = rep
            .fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");

        let Some(narrative) = resolve_narrative(date, tz) else {
            return; // no narrative for this day — nothing to enforce
        };
        if narrative.rows.is_empty() {
            return;
        }

        let states = rep.out["states"].as_array().cloned().unwrap_or_default();
        // Non-vacuity. `states` is read by key, and a moved key yields an
        // empty slice, not an error: every row would regress at once, reading
        // like a pipeline collapse rather than a wiring bug.
        if states.is_empty() {
            self.failures
                .push(format!("{name}: the fold produced no states to grade"));
            return;
        }

        let req = json!({ "mode": "truthcheck", "rows": narrative.rows, "states": states });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{name}: the truth check must answer: {e:#}"));
        let tr: Value = serde_json::from_str(&reply).expect("the truth reply parses");
        assert!(
            tr.get("error").is_none(),
            "{name}: truth check refused: {tr}"
        );

        let verdicts = tr["verdicts"].as_array().map_or(&[][..], Vec::as_slice);
        assert_eq!(
            verdicts.len(),
            narrative.rows.len(),
            "{name}: the verdict list must be positional"
        );
        self.reported.insert(date.to_string());
        self.edges.insert(
            date.to_string(),
            tr["stayEdges"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .flat_map(|pair| pair.as_array().cloned().unwrap_or_default())
                .filter_map(|v| v.as_i64())
                .collect(),
        );
        // The name-confidence counts, re-measured every run against their
        // blessed values: the percentage the app shows is this measurement,
        // and a naming change that moves it must say so.
        let covering = tr["covering"].as_array().map_or(&[][..], Vec::as_slice);
        assert_eq!(
            covering.len(),
            narrative.rows.len(),
            "{name}: the covering list must be positional"
        );
        let counts = name_confidence_counts(&narrative.rows, verdicts, covering, &states);
        if std::env::var("NAME_CONFIDENCE_BLESS").is_ok() {
            use std::io::Write;
            let obj: serde_json::Map<String, Value> = counts
                .iter()
                .map(|(k, (r, n))| (k.clone(), json!([r, n])))
                .collect();
            let line = format!("{}\n", json!({ "date": date, "counts": obj }));
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(NAME_CONFIDENCE)
                .expect("NAME_CONFIDENCE opens")
                .write_all(line.as_bytes())
                .expect("NAME_CONFIDENCE writes");
        } else if !self.report_only {
            let blessed = self.name_confidence.get(date).cloned().unwrap_or_default();
            if counts != blessed {
                self.failures.push(format!(
                    "{name}: name-confidence counts moved — now {counts:?}, blessed {blessed:?}; \
                     if the naming change is intended, re-bless with NAME_CONFIDENCE_BLESS=1 \
                     (after removing tests/golden/name-confidence.jsonl) and update \
                     Verified.Geo.NameConfidence.COUNTS to the new sums"
                ));
            }
        }
        if let Some(path) = &self.rows_out {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("TRUTH_ROWS_OUT opens");
            // One buffer, one write: shards append concurrently. The verdicts
            // and graded states ride along beside the truth.
            let line = format!(
                "{}\n",
                json!({ "date": date, "rows": narrative.rows, "verdicts": verdicts, "states": states })
            );
            f.write_all(line.as_bytes()).expect("TRUTH_ROWS_OUT writes");
        }
        // `VENUE_AB_OUT`: one JSON line per date, `{"date", "rows": [[ts, verdict]…]}`,
        // appended in one write like `TRUTH_ROWS_OUT`, since shards in one
        // process would overwrite a file written whole.
        if let Ok(path) = std::env::var("VENUE_AB_OUT") {
            use std::io::Write;
            let rows = verdicts
                .iter()
                .zip(&narrative.starts)
                .map(|(v, ts)| json!([ts, v.as_str().unwrap_or("?")]))
                .collect::<Vec<_>>();
            let line = format!("{}\n", json!({ "date": date, "rows": rows }));
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .expect("VENUE_AB_OUT opens")
                .write_all(line.as_bytes())
                .expect("VENUE_AB_OUT writes");
        }
        // Explains a regressed row with the states the check used. Off by
        // default: it prints places.
        if std::env::var("TRUTH_DEBUG").is_ok() {
            for (i, verdict) in verdicts.iter().enumerate() {
                if verdict.as_str() != Some("regressed") {
                    continue;
                }
                let row = &narrative.rows[i];
                let idx = covering.get(i).and_then(Value::as_i64).unwrap_or(-1);
                let live = if idx < 0 {
                    "(no state covers this window)".to_string()
                } else {
                    let st = &states[idx as usize];
                    format!(
                        "{}{}{} [{}-{}]",
                        st["mode"].as_str().unwrap_or("?"),
                        st["place"]
                            .as_str()
                            .map(|p| format!(" @ {p}"))
                            .unwrap_or_default(),
                        st["wayName"]
                            .as_str()
                            .map(|w| format!(" on {w}"))
                            .unwrap_or_default(),
                        st["startTs"],
                        st["endTs"]
                    )
                };
                eprintln!(
                    "      ✗ {date} row {}-{} truth {} | pipeline said: {live}",
                    row["startTs"], row["endTs"], row["truth"]
                );
            }
        }
        let v = self.verified.entry(date.to_string()).or_default();
        for (i, verdict) in verdicts.iter().enumerate() {
            if verdict.as_str() == Some("verified") {
                v.push(narrative.starts[i]);
            }
        }
        let d = self.described.entry(date.to_string()).or_default();
        let s = self.standing.entry(date.to_string()).or_default();
        for (i, verdict) in verdicts.iter().enumerate() {
            match verdict.as_str() {
                // `verified | regressed` is the enforceable-`correct` set:
                // those are the only two verdicts such a row can take.
                Some("verified") => {
                    d.push(narrative.starts[i]);
                    self.tally_v += 1;
                }
                Some("regressed") => {
                    d.push(narrative.starts[i]);
                    s.push(narrative.starts[i]);
                    self.tally_r += 1;
                }
                Some("known-error") => self.tally_k += 1,
                Some("cleared") => self.tally_c += 1,
                // `unverified` is a refusal, not a failure to grade yet; see the
                // reporter below.
                _ => {
                    self.tally_u += 1;
                    // Which `rowVerdict` branch refused it: a bad status is a
                    // malformed cell; untrusted provenance only the user can fix.
                    let row = &narrative.rows[i];
                    let st = row["status"].as_str().unwrap_or("");
                    let e = self.ungraded.entry(date.to_string()).or_default();
                    if st == "correct" || st == "wrong" {
                        e.0 += 1;
                    } else {
                        e.1 += 1;
                    }
                }
            }
        }
    }

    /// The stay-edge floor: prints the corpus's share within two and five
    /// minutes, and fails a day whose count within two fell.
    fn edge_floor(&self) -> Vec<String> {
        let all: Vec<i64> = self.edges.values().flatten().copied().collect();
        let within = |xs: &[i64], s: i64| xs.iter().filter(|e| e.abs() <= s).count();
        eprintln!(
            "truth: stay edges — {} of {} within 2 min, {} within 5 min, over {} day(s)",
            within(&all, EDGE_WITHIN_S),
            all.len(),
            within(&all, 300),
            self.edges.len()
        );
        // Absent before its first bless; a file that is there must parse.
        let mut floor: BTreeMap<String, (usize, usize)> =
            match std::fs::read_to_string(EDGE_BASELINE) {
                Ok(text) => serde_json::from_str(&text).expect("the edge floor parses"),
                Err(_) => BTreeMap::new(),
            };
        if std::env::var("EDGE_BLESS").is_ok() {
            for (date, xs) in &self.edges {
                floor.insert(date.clone(), (within(xs, EDGE_WITHIN_S), xs.len()));
            }
            let text = serde_json::to_string_pretty(&floor).expect("the edge floor serialises");
            std::fs::write(EDGE_BASELINE, format!("{text}\n")).expect("the edge floor is writable");
            eprintln!("truth: stay-edge floor re-blessed to {EDGE_BASELINE}");
            return Vec::new();
        }
        let fell: Vec<String> = self
            .edges
            .iter()
            .filter_map(|(date, xs)| {
                let now = within(xs, EDGE_WITHIN_S);
                match floor.get(date) {
                    Some((was, _)) if now < *was => Some(format!(
                        "      ✗ {date} — {now} of {} stay edge(s) within 2 min, was {was}",
                        xs.len()
                    )),
                    Some(_) => None,
                    None if xs.is_empty() => None,
                    None => Some(format!(
                        "      ✗ {date} — {} stay edge(s) with no floor: EDGE_BLESS=1",
                        xs.len()
                    )),
                }
            })
            .collect();
        if fell.is_empty() {
            Vec::new()
        } else {
            vec![format!(
                "truth: FAIL — a confirmed stay's arrival or departure moved off its time:\n{}",
                fell.join("\n")
            )]
        }
    }

    pub fn finish(self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.failures.is_empty() {
            out.push(format!(
                "truth: the replay did not reach the truth check:\n{}",
                self.failures.join("\n")
            ));
            return out;
        }
        if self.tally_v == 0 {
            out.push(
                "truth: no row was verified on any day — the gate would pass vacuously".to_string(),
            );
            return out;
        }
        out.extend(self.edge_floor());

        // Both sides lose the unmeasured days, or their floors read as lost.
        let unmeasured: Vec<&String> = self
            .baseline
            .keys()
            .filter(|d| !self.reported.contains(*d))
            .collect();
        let measured_baseline: BTreeMap<String, Vec<i64>> = self
            .baseline
            .iter()
            .filter(|(d, _)| self.reported.contains(*d))
            .map(|(d, k)| (d.clone(), k.clone()))
            .collect();

        let req = json!({
            "mode": "floorgate",
            "baseline": to_wire(&measured_baseline),
            "current": to_wire(&self.verified),
            "described": to_wire(&self.described),
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

        let standing_n: usize = self.standing.values().map(Vec::len).sum();
        let held: usize = self.verified.values().map(Vec::len).sum();
        eprintln!(
            "truth: {} verified · {} known-error · {} cleared · {} regressed  \
             ({} unverified) over {} day(s)",
            self.tally_v,
            self.tally_k,
            self.tally_c,
            self.tally_r,
            self.tally_u,
            self.reported.len()
        );
        if let Ok(out) = std::env::var("VENUE_AB_OUT") {
            eprintln!("truth: per-row verdicts appended -> {out}");
        }
        if self.report_only {
            eprintln!(
                "truth: ⚠ REPORT ONLY — venuePriors were INJECTED from \
                 $VENUE_PRIORS_FILE; the floor is not enforced against an arm \
                 nobody blessed. Diff the VENUE_AB_OUT files of two arms instead."
            );
            return out;
        }
        eprintln!(
            "truth: {held} confirmed row(s) held against a floor of {}",
            measured_baseline.values().map(Vec::len).sum::<usize>()
        );
        if standing_n > 0 {
            eprintln!(
                "truth: {standing_n} standing regressed row(s) across {} day(s) — \
                 below the floor, reported not enforced:",
                self.standing.values().filter(|v| !v.is_empty()).count()
            );
            // Named, not counted: `correct` rows that never held sit under the
            // floor, so no gate fails for them. A composed way label ("A, B")
            // lands here too; check the cell first (`../README.md`).
            for (date, rows) in &self.standing {
                for ts in rows {
                    eprintln!("  standing  {date} @{}", hm(*ts));
                }
            }
        }
        // Refusals, not debt: `partial`/`unclear` status or untrusted
        // provenance. Never fix one by writing `{user}`: that claims the user
        // confirmed it.
        if !self.ungraded.is_empty() {
            let n: usize = self.ungraded.values().map(|(a, b)| a + b).sum();
            eprintln!(
                "truth: {n} row(s) on {} day(s) are REFUSED by the provenance ladder \
                 — not graded, and deliberately so. `partial`/`unclear` is a row \
                 that makes no clean assertion; an untrusted provenance is a legacy \
                 or pipeline-derived row that must not gate:",
                self.ungraded.len()
            );
            for (date, (untrusted, unstatused)) in &self.ungraded {
                eprintln!(
                    "  ungraded  {date}  {untrusted} untrusted-provenance · \
                     {unstatused} status-not-correct-or-wrong"
                );
            }
        }
        if !unmeasured.is_empty() {
            eprintln!(
                "truth: {} day(s) not measured by this shard, floor unchecked here: {}",
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
                "truth: {} newly held — re-bless to ratchet the floor up:",
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
        // A drop is the only way a red gate goes green without a fix; never silent.
        if !dropped.is_empty() {
            eprintln!(
                "truth: {} floor key(s) the narrative no longer describes:",
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

        // The rows this gate exempts; see KNOWN_UNHELD.
        let known: BTreeSet<(&str, i64)> = KNOWN_UNHELD.iter().map(|(d, t, _)| (*d, *t)).collect();
        let now_unheld: BTreeSet<(&str, i64)> = regressed
            .iter()
            .filter_map(|r| Some((r["date"].as_str()?, r["startTs"].as_i64()?)))
            .filter(|k| known.contains(k))
            .collect();
        let fresh: Vec<&Value> = regressed
            .iter()
            .filter(|r| {
                !r["date"]
                    .as_str()
                    .zip(r["startTs"].as_i64())
                    .is_some_and(|k| known.contains(&k))
            })
            .collect();

        for (d, t, why) in KNOWN_UNHELD {
            if self.reported.contains(d) {
                eprintln!("truth: standing — {d} @{} {why}", hm(t));
            } else {
                eprintln!(
                    "truth: exempt but NOT MEASURED by this shard — {d} @{}",
                    hm(t)
                );
            }
        }
        // Bless writes the floor Lean computed, a union: only a key the
        // narrative no longer describes leaves, printed above. Unmeasured dates
        // pass through, but all days must run in one process (see the header).
        if std::env::var("TRUTH_BLESS").is_ok() {
            let mut floor = serde_json::Map::new();
            for entry in g["floor"].as_array().map_or(empty, Vec::as_slice) {
                let Some(date) = entry["date"].as_str() else {
                    continue;
                };
                floor.insert(date.to_string(), entry["keys"].clone());
            }
            // Dates the gate never saw are not in the ratchet's output at all.
            for (date, keys) in &self.baseline {
                floor.entry(date.clone()).or_insert_with(|| json!(keys));
            }
            let text =
                serde_json::to_string_pretty(&Value::Object(floor)).expect("the floor serialises");
            std::fs::write(BASELINE, format!("{}\n", text.replace("  ", "\t")))
                .expect("the floor is writable");
            eprintln!("truth: floor re-blessed to {BASELINE}");
            return out;
        }

        // Fails when an exemption holds again, so it must leave the list.
        // Unmeasured days are excluded.
        let repaid: Vec<&(&str, i64, &str)> = KNOWN_UNHELD
            .iter()
            .filter(|(d, _, _)| self.reported.contains(*d))
            .filter(|(d, t, _)| !now_unheld.contains(&(*d, *t)))
            .collect();
        if !repaid.is_empty() {
            out.push(format!(
                "truth: {} exempted row(s) HOLD again — delete them from KNOWN_UNHELD:\n{}",
                repaid.len(),
                repaid
                    .iter()
                    .map(|(d, t, _)| format!("      ✓ {d} @{}", hm(*t)))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if !fresh.is_empty() {
            out.push(format!(
                "truth: FAIL — {} confirmed row(s) no longer hold:\n{}",
                fresh.len(),
                fresh
                    .iter()
                    .map(|r| format!(
                        "      ✗ {} @{}",
                        r["date"].as_str().unwrap_or("?"),
                        hm(r["startTs"].as_i64().unwrap_or(0))
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        out
    }
}
