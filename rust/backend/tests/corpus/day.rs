//! A WHOLE DAY with no Node and no database, against the last blessed timeline.
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
//! The oracle is `expected.tsArm.capture.statesOut`. ⚠ THE KEY IS NAMED FOR AN
//! ARM THAT NO LONGER EXISTS: since 2026-09-03 it holds the last BLESSED LEAN
//! output, not what the TypeScript cascade produced.
//!
//! # ⚠ WHERE THIS GRADER BEGINS, AND THEREFORE WHAT IT DOES NOT COVER
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
//! # ⚠ THE ORACLE'S MEANING CHANGED on 2026-09-03 (#394, Pippijn's call)
//!
//! `statesOut` is no longer "what the TypeScript produced" but "the last
//! BLESSED output of the Lean arm". The port-fidelity era ended when the #394
//! bearing fix shipped: the fix makes timelines the deleted TS is wrong about,
//! so holding its output as the oracle would freeze the bug in. `DAY_BLESS=1`
//! re-blesses — it OVERWRITES each fixture's `statesOut` with the current
//! replay and prints what it touched. Bless deliberately, on a clean tree,
//! and read the diff of the inner golden repo before committing it.
//!
//! ⚠ Blessing is per-FIXTURE here, not to a shared floor file, so it is the one
//! bless in the corpus that is safe to run sharded: each shard rewrites only
//! its own days and they cannot race. It is still only COMPLETE if both shards
//! run.
//!
//! # Why this grader is local-only
//!
//! `tests/golden/days` is gitignored: the fixtures carry real coordinates,
//! place names and biometrics. The runner ANNOUNCES A SKIP rather than passing
//! quietly.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::Replay;

/// Days whose timeline the Lean fold and the TypeScript cascade build
/// differently — each with its divergence ADJUDICATED, not merely observed.
///
/// ⚠ THIS LIST MAY ONLY SHRINK. Listing a day keeps the other 41 checkable
/// instead of one red day hiding them all; re-capturing a day to make a miss
/// go away is forbidden (#1054).
///
/// RETIRED 2026-09-03: the oracle stopped being the TS's output (see the
/// header), so the 08-09 bless wrote Morr into `statesOut` and the entry
/// would have tripped the stale-entry check below. The adjudication lives in
/// #1054; the list stays for the next genuinely divergent day.
const KNOWN_DIVERGENT: [&str; 0] = [];

/// The tables an unanswered key may belong to. Anything else is a new gap.
const UNANSWERED_KINDS: [&str; 3] = ["reverseGeocode", "nearbyLandmarks", "transitStops"];

/// Keys the offline answerer cannot supply, BY DAY, beyond the blank-zone
/// `bestPlace` asked before `tzAt` resolves.
///
/// Each means the fold reached a lookup the TypeScript run never made, so the
/// recorded trace has no answer and the row set is not that lookup's source.
/// Per #1054 the miss IS the finding, so this is a CEILING that must fall, not
/// a budget.
///
/// What it holds is the two tables declined ON PURPOSE: `reverseGeocode` is a
/// Nominatim call whose keys are coordinates the pipeline DERIVES (#1076), and
/// `transitStops` is injected rather than computed from rows. Neither falls
/// without porting something.
///
/// ⚠ **PER DAY, NOT A TOTAL, AND THAT IS WHAT MAKES IT SHARDABLE** (#1359).
/// The ceiling was one corpus-wide number (16, measured 2026-09-03) until the
/// graders moved behind a sharded runner. A shard cannot check a corpus-wide
/// total — asserting `≤ 16` on each half passes at 32 — and pasting the bound
/// onto a smaller denominator is exactly the failure mode that silences the
/// question. Keyed by day it shards exactly, and it also says WHICH day grew,
/// which the total never did.
///
/// ⚠ Re-blessed 2026-09-09 together with the matcher flip (#1418): the matched
/// geometry moves stay boundaries, and a moved boundary DERIVES a different
/// `reverseGeocode` key. Blessing this while the gate ran the other arm is the
/// mistake that made day_corpus red in its own configuration (backed out at
/// `c226cb9`) — the flip and this table move together or not at all.
/// `DAY_UNANSWERED_OUT=<path>` prints the table this run measured.
const UNANSWERED_BY_DAY: [(&str, usize); 12] = [
    ("2026-05-11", 2),
    ("2026-05-22", 1),
    ("2026-05-25", 1),
    ("2026-06-09", 2),
    ("2026-06-12", 1),
    ("2026-06-15", 1),
    ("2026-06-18", 2),
    ("2026-06-24", 2),
    ("2026-07-10", 1),
    ("2026-07-17", 1),
    ("2026-08-06", 1),
    ("2026-08-08", 1),
];

fn ceiling_for(date: &str) -> usize {
    UNANSWERED_BY_DAY
        .iter()
        .find(|(d, _)| *d == date)
        .map_or(0, |(_, n)| *n)
}

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

pub struct Day {
    golden: &'static str,
    /// ⚠ INJECTION MAKES THE RUN REPORT-ONLY, for the reason the truth referee
    /// gives: the oracle was blessed from an arm nobody re-blessed under these
    /// priors, so a mismatch is the MEASUREMENT, not a regression. What it
    /// answers is the half the truth floor structurally cannot — the footprint
    /// on stays no narrative row grades.
    report_only: bool,
    places: BTreeMap<String, Vec<Value>>,
    measured: BTreeMap<String, usize>,
    failures: Vec<String>,
    unanswered: Vec<String>,
    divergent: Vec<String>,
    agreed: usize,
    graded: usize,
    deepest: u32,
}

impl Day {
    pub fn new(golden: &'static str, report_only: bool) -> Self {
        Self {
            golden,
            report_only,
            places: BTreeMap::new(),
            measured: BTreeMap::new(),
            failures: Vec::new(),
            unanswered: Vec::new(),
            divergent: Vec::new(),
            agreed: 0,
            graded: 0,
            deepest: 0,
        }
    }

    pub fn grade(&mut self, name: &str, rep: &Replay) {
        let date = &name[..10];
        self.graded += 1;
        let fx = &rep.fx;

        let Some(want) = fx.pointer("/expected/tsArm/capture/statesOut").cloned() else {
            self.failures.push(format!(
                "{name}: no frozen tsArm timeline — and one CANNOT be created. \
                 `compare-day --freeze` went with the TS cascade (#975), so a day \
                 arriving without an oracle can never gain one and cannot join this \
                 corpus. Every day here carries one; seeing this means a new day was \
                 added or a capture dropped an existing arm. See #1063."
            ));
            return;
        };
        self.deepest = self.deepest.max(rep.rounds);

        // ⚠ THE ONLY ACCEPTED RESIDUE. The fold asks `bestPlace` once before
        // `tzAt` has resolved the stay's zone and again after; the blank-zone
        // spelling is a question asked too early, not a stay with no zone, and
        // the answerer declines it rather than pick one. Measured on 2026-04-29:
        // 8 spans, each asked twice, every one recorded by the TypeScript at
        // Europe/Amsterdam. ANYTHING ELSE unanswered means the timeline below
        // was built from a default for a question the day really asked, and
        // matching `statesOut` anyway would be luck rather than agreement.
        let mut n = 0usize;
        for m in &rep.unanswerable {
            if m.what == "bestPlace" && m.key.ends_with('|') {
                continue;
            }
            if UNANSWERED_KINDS.contains(&m.what.as_str()) {
                n += 1;
                self.unanswered
                    .push(format!("{name}: {}({})", m.what, m.key));
            } else {
                self.failures
                    .push(format!("{name}: unanswered {}({})", m.what, m.key));
            }
        }
        self.measured.insert(date.to_string(), n);
        let ceiling = ceiling_for(date);
        if n > ceiling {
            self.failures.push(format!(
                "{name}: {n} key(s) unanswered, up from the {ceiling} measured for this day — \
                 each is a lookup the recorded trace never answered, so the day was built from \
                 a default for it (#1076)"
            ));
        }

        let got = rep.out.get("states").cloned().unwrap_or(Value::Null);

        // #343: every stay's place, POSITIONALLY — the truth referee learned the
        // hard way that a ts-keyed diff lies, because 06-22 carries two rows with
        // the same `startTs`.
        if self.report_only || std::env::var("VENUE_PLACES_OUT").is_ok() {
            let rows: Vec<Value> = got
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|st| st.get("mode").and_then(Value::as_str) == Some("stationary"))
                .map(|st| {
                    json!({
                        "startTs": st.get("startTs").cloned().unwrap_or(Value::Null),
                        "endTs": st.get("endTs").cloned().unwrap_or(Value::Null),
                        "place": st.get("place").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            self.places.insert(name.to_string(), rows);
        }
        if self.report_only {
            self.agreed += 1;
            return;
        }
        let same = drop_nulls(&got) == drop_nulls(&want);
        if !same && std::env::var("DAY_BLESS").is_ok() {
            let mut fx2 = fx.clone();
            *fx2.pointer_mut("/expected/tsArm/capture/statesOut")
                .expect("the oracle node exists — we just read it") = got.clone();
            std::fs::write(format!("{}/{name}", self.golden), fx2.to_string())
                .unwrap_or_else(|e| panic!("blessing {name}: {e}"));
            eprintln!("  BLESSED  {name}: statesOut rewritten from the Lean arm");
            self.agreed += 1;
            return;
        }
        match (same, KNOWN_DIVERGENT.contains(&name)) {
            (true, false) => self.agreed += 1,
            (false, true) => self
                .divergent
                .push(format!("{name}: {}", first_state_difference(&got, &want))),
            (false, false) => self
                .failures
                .push(format!("{name}: {}", first_state_difference(&got, &want))),
            // ⚠ A day that AGREES while listed as divergent is not a pass. It
            // means the divergence is gone and the list is now a lie, and a
            // stale entry here would hide the next real one.
            (true, true) => self.failures.push(format!(
                "{name} is listed as divergent on #1054 but now agrees — delete the entry"
            )),
        }
    }

    pub fn finish(self) -> Vec<String> {
        if let Ok(out) = std::env::var("VENUE_PLACES_OUT") {
            std::fs::write(
                &out,
                serde_json::to_string_pretty(&self.places).expect("the place dump serialises"),
            )
            .expect("writing VENUE_PLACES_OUT");
            eprintln!("day: {} day(s) of stay places -> {out}", self.places.len());
        }
        // The table this run measured, for re-blessing `UNANSWERED_BY_DAY`.
        // Appends: the two shards each write their own half.
        if let Ok(out) = std::env::var("DAY_UNANSWERED_OUT") {
            let lines: String = self
                .measured
                .iter()
                .filter(|(_, n)| **n > 0)
                .map(|(d, n)| format!("    (\"{d}\", {n}),\n"))
                .collect();
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&out)
                .expect("DAY_UNANSWERED_OUT is writable");
            f.write_all(lines.as_bytes()).expect("writing the table");
        }
        if self.report_only {
            eprintln!(
                "day: REPORT-ONLY — replayed under $VENUE_PRIORS_FILE, so the oracle is not \
                 enforced against an arm nobody blessed. Diff two arms' $VENUE_PLACES_OUT files."
            );
            return Vec::new();
        }

        for d in &self.divergent {
            eprintln!("  #1054     {d}");
        }
        for u in &self.unanswered {
            eprintln!("  unanswered {u}");
        }
        let mut out = Vec::new();
        if !self.failures.is_empty() {
            out.push(format!(
                "day: {}/{} days replay to the blessed timeline (deepest walk {} rounds).\n{}",
                self.agreed,
                self.graded,
                self.deepest,
                self.failures.join("\n")
            ));
            return out;
        }
        if self.agreed + self.divergent.len() != self.graded {
            out.push(
                "day: some day neither agreed nor diverged, which means it was skipped".to_string(),
            );
            return out;
        }
        eprintln!(
            "day: {}/{} days replay to the blessed timeline; {} known-divergent (#1054); \
             {} key(s) unanswered; deepest walk {} rounds",
            self.agreed,
            self.graded,
            self.divergent.len(),
            self.unanswered.len(),
            self.deepest
        );
        out
    }
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
