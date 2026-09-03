//! The provenance-aware TRUTH gate over the golden corpus — no Node, no database.
//!
//! ```text
//!   fixture.inputs → head::capture → converge → states ─┐
//!   ground-truth/<date>.md → Lean parse → tz resolve ───┴→ truthcheck → floorgate
//! ```
//!
//! This is #1052. The check that filed that task died with the TypeScript
//! (#975): `tests/golden/truth-baseline.json` had ZERO readers, so the two
//! confirmed rows it named were neither passing nor failing — they were
//! UNMEASURED, and had been for months. This file is the reader.
//!
//! # Why this gate is different from every other one in the corpus
//!
//! Every other check compares the pipeline against itself or against
//! previously-blessed pipeline output. Here a human wrote down what actually
//! happened, in prose, and the pipeline is graded against that. It is the only
//! non-self-referential signal the corpus has — which is also why it cannot be
//! blessed away: `ratchetUpFloor` takes a union, so a row that stopped holding
//! stays in the floor and keeps failing. The one escape is re-auditing the
//! narrative so the row is no longer described, and that is reported by name.
//!
//! # The split
//!
//! All five verdicts, the field-level comparator, the midpoint windowing and
//! the ratchet are `Verified.Eval.TruthCheck` and `Verified.Eval.FloorGate`.
//! This file replays fixtures, reads the tz database, and prints. Per the
//! standing rule: logic in Lean, IO glue in Rust.
//!
//! # The port's evidence
//!
//! `truth-check.ts` was recovered at `06346bd^` and run against the Lean port
//! differentially on 2026-09-01: **55,246 cases, 0 disagreements**, built from
//! every real truth cell in the corpus crossed with live labels rendered from
//! those cells, plus the degenerate labels a hand-written parser gets wrong.
//! Twelve ablations of the Lean each moved that count; two branches the corpus
//! cannot reach are pinned by `#guard` instead, and named there.
//!
//! ⚠ THAT DIFFERENTIAL IS NOT THIS GATE. It proves the comparator agrees with
//! the TypeScript on the shapes; this proves the whole chain — replay, states,
//! narrative, zone resolution, verdicts, ratchet — still satisfies a floor a
//! human blessed from the other implementation.
//!
//! # Local-only
//!
//! `tests/golden/{days,ground-truth}` is gitignored: the fixtures carry real
//! coordinates, place names and biometrics (#860). `truth-baseline.json` IS
//! tracked, because it is unix timestamps and nothing else. This announces a
//! skip rather than passing quietly, and prints counts and times, never a place.

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
    "/../../tests/golden/truth-baseline.json"
);

/// The confirmed rows that DO NOT hold, exempted by name so the other 312 can
/// gate. Not a blessing: the floor still holds these keys, they are printed
/// every run, and the assertion below fails in BOTH directions — a new
/// regression fails, and so does one of these starting to hold again.
///
/// ⚠ WHY THEY ARE HERE RATHER THAN FIXED IN THIS COMMIT. Both are pipeline
/// defects, not port defects, and both were diagnosed before this gate existed
/// (#1052). Fixing either changes the fold's output across all 42 days, and
/// changing the pipeline in the same commit that first establishes the gate
/// leaves nothing independent to check the change against. This gate is what
/// makes those fixes measurable; it has to land first.
///
/// ⚠ THIS LIST HELD TWO ROWS UNTIL 2026-09-01, AND THE FIRST ONE WAS NOT A
/// PIPELINE DEFECT AT ALL. `@11:09Z` was carried here on the ticket's diagnosis
/// — "the walk overruns by nine seconds because `vehicleSplit` ends on a fix
/// above `ACCURACY_CEILING_M`". Replaying the day with the fold trace refuted
/// it twice over: the fix at 11:11:09Z is an ordinary walking-pace one (53 m in
/// 75 s, then 1023 m in the next 35), and the points this pass receives are
/// `[ts, lat, lon, speedKmh]` — there is no accuracy field in them to test.
///
/// The narrative row claimed the ride ran 11:09–11:13; the fixes put him at
/// walking pace until 11:11:09. Pippijn re-cut it to start 11:11 on 2026-09-01
/// ("moving them a bit isn't damage"), the floor key moved with it, and the row
/// verifies. ⚠ THE JUSTIFICATION IS THE FIXES, NOT THE PIPELINE — re-cutting a
/// row to whatever the pipeline drew would make this corpus self-referential,
/// which is the one property that makes it worth having.
///
/// What remains is `@11:13Z`: mode and bounds right, way NAME wrong. That is
/// #445, and it is a naming question rather than a truth question.
const KNOWN_UNHELD: [(&str, i64, &str); 1] = [(
    "2026-06-16",
    1_781_608_380,
    "right mode and bounds, wrong way name (#445)",
)];

/// A day's rows, resolved to unix seconds, ready for `truthcheck`.
struct Resolved {
    rows: Vec<Value>,
    /// Window starts, positionally aligned with `rows` — the floor's keys.
    starts: Vec<i64>,
}

/// Parse a narrative and resolve its civil windows through the tz database.
///
/// ⚠ THE ZONE IS THE NARRATIVE'S IF IT DECLARES ONE. `parseGroundTruth` returns
/// the zone it actually read the clock times in, which is the caller's unless a
/// `Times:` line overrode it — two files in this corpus do. Resolving with the
/// fixture's zone regardless would silently shift every window on those days.
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

/// #343 P0: the injected-priors arm, parsed once per call site.
fn injected_priors() -> Option<Value> {
    let path = std::env::var("VENUE_PRIORS_FILE").ok()?;
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("VENUE_PRIORS_FILE {path}: {e}"));
    Some(serde_json::from_str(&text).unwrap_or_else(|e| panic!("VENUE_PRIORS_FILE {path}: {e}")))
}

#[test]
fn every_confirmed_row_still_holds() {
    if !Path::new(GOLDEN).is_dir() || !Path::new(NARRATIVES).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let baseline: BTreeMap<String, Vec<i64>> = serde_json::from_str(
        &std::fs::read_to_string(BASELINE)
            .expect("the truth floor is tracked and must be readable"),
    )
    .expect("the truth floor parses");

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("the corpus directory is readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    if let Ok(only) = std::env::var("TRUTH_DAYS") {
        names.retain(|n| only.split(',').any(|d| n.starts_with(d)));
    }
    assert!(!names.is_empty(), "the corpus directory is empty");

    // Per-date: rows satisfied now, every enforceable `correct` row the
    // narrative still describes, and the ones standing regressed.
    let mut verified: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut described: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut standing: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    // Days that produced a truth report AT ALL. ⚠ A day whose fixture threw or
    // whose narrative is gone measured NOTHING, and to a floor gate that is
    // indistinguishable from having lost everything (#408). Excluded by name.
    let mut reported: BTreeSet<String> = BTreeSet::new();
    let (mut tally_v, mut tally_r, mut tally_k, mut tally_c, mut tally_u) = (0, 0, 0, 0, 0);
    let mut failures: Vec<String> = Vec::new();
    let mut ab_rows: BTreeMap<String, Vec<Value>> = BTreeMap::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let mut fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        // #343 P0: the priors A/B. `VENUE_PRIORS_FILE` replaces the fixture's
        // CAPTURED `venuePriors` blob for this replay only — the file comes
        // from `refresh-focus-places --hard-out/--soft-out`, so the arm and
        // the baseline mine the same population. Injection makes this run
        // REPORT-ONLY (see the end of the test): a floor graded on injected
        // priors would enforce against an arm nobody blessed.
        if let Some(blob) = injected_priors() {
            fx["inputs"]["venuePriors"] = blob;
        }
        let inputs = &fx["inputs"];
        let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));
        let tz = fx
            .pointer("/meta/tz")
            .and_then(Value::as_str)
            .unwrap_or("Europe/London");

        let Some(narrative) = resolve_narrative(date, tz) else {
            continue; // no narrative for this day — nothing to enforce
        };
        if narrative.rows.is_empty() {
            continue;
        }

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
        let states = out["states"].as_array().cloned().unwrap_or_default();
        // ⚠ NON-VACUITY. `states` is read by key, and a key that moved yields an
        // EMPTY slice rather than an error — every row would then regress at
        // once, which reads like a pipeline collapse rather than a wiring bug.
        if states.is_empty() {
            failures.push(format!("{name}: the fold produced no states to grade"));
            continue;
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
        reported.insert(date.to_string());
        if std::env::var("VENUE_AB_OUT").is_ok() {
            ab_rows.insert(
                date.to_string(),
                verdicts
                    .iter()
                    .zip(&narrative.starts)
                    .map(|(v, ts)| json!([ts, v.as_str().unwrap_or("?")]))
                    .collect::<Vec<_>>(),
            );
        }
        // ⚠ WHY THIS DIAGNOSTIC EXISTS: a regressed row names what BROKE and
        // never what the pipeline said instead, so attributing one meant a hand
        // dig every time. `covering` comes back from the same lookup that
        // produced the verdict, so this cannot explain a verdict with a state
        // the check did not use. Off by default: it prints places.
        if std::env::var("TRUTH_DEBUG").is_ok() {
            let covering = tr["covering"].as_array().map_or(&[][..], Vec::as_slice);
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
        let (v, d, s) = (
            verified.entry(date.to_string()).or_default(),
            described.entry(date.to_string()).or_default(),
            standing.entry(date.to_string()).or_default(),
        );
        for (i, verdict) in verdicts.iter().enumerate() {
            match verdict.as_str() {
                // `verified | regressed` IS the enforceable-`correct` set:
                // those are the only two verdicts such a row can take.
                Some("verified") => {
                    v.push(narrative.starts[i]);
                    d.push(narrative.starts[i]);
                    tally_v += 1;
                }
                Some("regressed") => {
                    d.push(narrative.starts[i]);
                    s.push(narrative.starts[i]);
                    tally_r += 1;
                }
                Some("known-error") => tally_k += 1,
                Some("cleared") => tally_c += 1,
                _ => tally_u += 1,
            }
        }
    }
    assert!(
        failures.is_empty(),
        "the replay did not reach the truth check:\n{}",
        failures.join("\n")
    );
    assert!(
        tally_v > 0,
        "no row was verified on any day — the gate would pass vacuously"
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
        "current": to_wire(&verified),
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

    let standing_n: usize = standing.values().map(Vec::len).sum();
    let held: usize = verified.values().map(Vec::len).sum();
    eprintln!(
        "truth: {tally_v} verified · {tally_k} known-error · {tally_c} cleared · \
         {tally_r} regressed  ({tally_u} unverified) over {} day(s)",
        reported.len()
    );
    if let Ok(out) = std::env::var("VENUE_AB_OUT") {
        std::fs::write(
            &out,
            serde_json::to_string_pretty(&ab_rows).expect("the A/B rows serialise"),
        )
        .expect("writing VENUE_AB_OUT");
        eprintln!("truth: per-row verdicts -> {out}");
    }
    if injected_priors().is_some() {
        eprintln!(
            "truth: ⚠ REPORT ONLY — venuePriors were INJECTED from \
             $VENUE_PRIORS_FILE; the floor is not enforced against an arm \
             nobody blessed. Diff the VENUE_AB_OUT files of two arms instead."
        );
        return;
    }
    eprintln!(
        "truth: {held} confirmed row(s) held against a floor of {}",
        measured_baseline.values().map(Vec::len).sum::<usize>()
    );
    if standing_n > 0 {
        eprintln!(
            "truth: {standing_n} standing regressed row(s) across {} day(s) — \
             below the floor, reported not enforced.",
            standing.values().filter(|v| !v.is_empty()).count()
        );
    }
    if !unmeasured.is_empty() {
        eprintln!(
            "truth: {} day(s) not measured this run, floor unchecked: {}",
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
    // ⚠ A DROP IS THE ONLY WAY A RED GATE GOES GREEN WITHOUT A FIX. Never silent.
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

    // ⚠ THE TWO ROWS THIS GATE WAS BUILT TO ANSWER — see KNOWN_UNHELD.
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
        if reported.contains(d) {
            eprintln!("truth: standing — {d} @{} {why}", hm(t));
        } else {
            eprintln!("truth: exempt but NOT MEASURED this run — {d} @{}", hm(t));
        }
    }
    // ⚠ FAILS WHEN THE DEBT IS PAID, which is the half that keeps an exemption
    // from rotting. A row that starts holding again must force this list to
    // shrink; otherwise the gate quietly tolerates a row it no longer needs to,
    // and the next real regression on that key is invisible.
    //
    // ⚠ AND IT EXCLUDES UNMEASURED DAYS, for the #408 reason one more time. The
    // first version of this check did not, and `TRUTH_DAYS=2026-05-22` made it
    // announce that both exempted rows HOLD AGAIN on a run that never opened
    // their day — the same silence-reads-as-a-verdict bug the floor gate above
    // is careful about, reproduced inside the guard written to watch it.
    // ⚠ THE BLESS PATH, and it is deliberately NOT a way to make a red gate
    // green. `ratchetUpFloor` takes a union, so a row that stopped holding stays
    // in the floor and keeps failing; the only key that can LEAVE is one the
    // narrative no longer DESCRIBES, and every such drop is printed above by
    // name. So blessing after a genuine re-audit works and blessing to escape a
    // regression does not — which is why this writes the floor LEAN computed
    // rather than "the keys that happened to pass this run".
    //
    // Safe on a partial run by construction: a date absent from `described` was
    // not measured, and its committed floor passes through untouched.
    if std::env::var("TRUTH_BLESS").is_ok() {
        let mut out = serde_json::Map::new();
        for entry in g["floor"].as_array().map_or(empty, Vec::as_slice) {
            let Some(date) = entry["date"].as_str() else {
                continue;
            };
            out.insert(date.to_string(), entry["keys"].clone());
        }
        // Dates the gate never saw are not in the ratchet's output at all.
        for (date, keys) in &baseline {
            out.entry(date.clone()).or_insert_with(|| json!(keys));
        }
        let text = serde_json::to_string_pretty(&Value::Object(out)).expect("the floor serialises");
        std::fs::write(BASELINE, format!("{}\n", text.replace("  ", "\t")))
            .expect("the floor is writable");
        eprintln!("truth: floor re-blessed to {BASELINE}");
        return;
    }

    let repaid: Vec<&(&str, i64, &str)> = KNOWN_UNHELD
        .iter()
        .filter(|(d, _, _)| reported.contains(*d))
        .filter(|(d, t, _)| !now_unheld.contains(&(*d, *t)))
        .collect();
    assert!(
        repaid.is_empty(),
        "truth: {} exempted row(s) HOLD again — delete them from KNOWN_UNHELD:\n{}",
        repaid.len(),
        repaid
            .iter()
            .map(|(d, t, _)| format!("      ✓ {d} @{}", hm(*t)))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        fresh.is_empty(),
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
    );
}
