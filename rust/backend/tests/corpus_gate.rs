//! Every corpus grader, over one replay of each golden day.
//!
//! ```text
//!   fixture → trace → fold ─┬→ day      (the last blessed timeline, state by state)
//!                               ├→ truth    (confirmed rows, a ratchet)
//!                               ├→ journeys (the story, a floor)
//!                               ├→ walks    (the walk referee's four axes)
//!                               └→ feasibility (impossible legs, a ceiling)
//! ```
//!
//! The replay, walk matcher included, is paid once rather than per grader. The
//! trace is loaded before each replay, as in production, so every grader sees
//! the matched geometry. With `VENUE_PRIORS_FILE` set there are two arms:
//! `day` and `truth` grade the injected priors, `journeys` and `walks` never do.
//!
//! Shards split days by index modulo; each grader filters its floor or ceiling
//! to the days reported, so every key is checked once. ⚠ A bless is
//! single-shard: shard 0 measures all days and the others stand down.
//!
//! `tests/golden/{days,ground-truth}` is gitignored; the baselines hold only
//! timestamps and metrics. A missing corpus announces a skip.

use std::path::Path;

mod corpus;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// How many ways the corpus is split. The row's wall clock is its slowest
/// single test, the shards running beside `hsmm_decode_corpus`'s; six measured
/// no worse than four. The limit is memory (the walk referee is ~1.6 GB per
/// process), so measure the sum before adding shards.
const SHARDS: usize = 6;

#[test]
fn every_golden_day_grades_shard_a() {
    run(0, SHARDS);
}

#[test]
fn every_golden_day_grades_shard_b() {
    run(1, SHARDS);
}

#[test]
fn every_golden_day_grades_shard_c() {
    run(2, SHARDS);
}

#[test]
fn every_golden_day_grades_shard_d() {
    run(3, SHARDS);
}

#[test]
fn every_golden_day_grades_shard_e() {
    run(4, SHARDS);
}

#[test]
fn every_golden_day_grades_shard_f() {
    run(5, SHARDS);
}

/// Shards may share a process (`cargo test` threads, `deploy.sh`): the loaded
/// trace is a value each replay is handed, not a global. As a global, threaded
/// shards replayed days against each other's roads, a fault that looked like
/// shared Lean state though Lean holds none.
fn run(shard: usize, of: usize) {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let all = corpus::day_names(GOLDEN);
    assert!(!all.is_empty(), "the corpus directory is empty");
    let all = corpus::restrict(all, std::env::var("CORPUS_DAYS").ok());

    // ⚠ A floor bless is single-shard: `truth`, `walk` and `feasibility` each
    // rewrite one file, and half a corpus would read as complete. `day` writes
    // per fixture and shards normally.
    let blessing = [
        "TRUTH_BLESS",
        "WALK_BLESS",
        "FEASIBILITY_BLESS",
        "EDGE_BLESS",
    ]
    .iter()
    .any(|k| std::env::var(k).is_ok());
    let names = if blessing {
        if shard != 0 {
            eprintln!("corpus: a bless is single-shard — shard {shard} stands down");
            return;
        }
        eprintln!("corpus: BLESS — shard 0 measures ALL {} day(s)", all.len());
        all.clone()
    } else {
        corpus::shard_of(&all, shard, of)
    };

    // The injected-priors arm. Unset in the gate, so the two arms coincide and
    // one replay serves every grader; see the header on why they must not be
    // merged when it is set.
    let injected: Option<corpus::Injection> = corpus::Injection::from_env();

    // An ablation arm (`WALK_TRACE`) stands the other graders down: their
    // regression would be the control working. Arms dump, not assert.
    let arm = corpus::walk::Arm::from_env();
    let gating_arm = arm.label == "all";
    if !gating_arm {
        eprintln!(
            "corpus: TRACE ARM {} — walks only, and NOT the gating default",
            arm.label
        );
    }
    let mut walk = corpus::walk::Walk::new(arm);
    if walk.is_none() {
        eprintln!("walks: SKIPPED — no blessed floor; see corpus/walk.rs.");
    }
    let mut day = corpus::day::Day::new(GOLDEN, injected.is_some());
    let mut truth = corpus::truth::Truth::new(injected.is_some());
    let mut journey = corpus::journey::Journey::new();
    if journey.is_none() || truth.is_none() {
        eprintln!("truth/journeys: SKIPPED — no ground-truth narratives.");
    }
    let mut feasibility = corpus::feasibility::Feasibility::new();

    let mut failures: Vec<String> = Vec::new();
    let mut replayed = 0usize;

    for name in &names {
        let fx = match corpus::read_fixture(GOLDEN, name) {
            Ok(v) => v,
            Err(e) => {
                failures.push(e);
                continue;
            }
        };
        // His habits over every visit, for the habit rule, as of the day
        // (`VENUE_HABITS_DIR`, laid out as `VENUE_PRIORS_DIR`).
        let fx = match std::env::var("VENUE_HABITS_DIR") {
            Ok(dir) => {
                let mut fx = fx;
                fx["inputs"]["venueHabits"] =
                    corpus::Injection::Dir(std::path::PathBuf::from(dir)).for_fixture(name);
                fx
            }
            Err(_) => fx,
        };
        // Once for both arms: the trace is read-only and both replays borrow it.
        let traced = match corpus::load_trace(
            GOLDEN,
            name,
            &fx,
            arm.walkable,
            arm.buildings,
            arm.drivable,
        ) {
            Ok(t) => t,
            Err(e) => {
                failures.push(e);
                continue;
            }
        };
        if let Some(w) = walk.as_mut().filter(|_| traced.is_none()) {
            w.no_capture(name);
        }

        let clean = match corpus::replay(name, corpus::with_priors(&fx, None), traced.as_ref()) {
            Ok(r) => r,
            Err(e) => {
                failures.push(e);
                continue;
            }
        };
        replayed += 1;

        // `day` and `truth` grade the injected arm; when nothing is injected
        // that is this same replay and no second fold is paid.
        let injected_rep = match injected.as_ref() {
            None => None,
            Some(inj) => {
                let p = inj.for_fixture(name);
                match corpus::replay(name, corpus::with_priors(&fx, Some(&p)), traced.as_ref()) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        failures.push(e);
                        continue;
                    }
                }
            }
        };
        let priors_arm = injected_rep.as_ref().unwrap_or(&clean);

        if let Some(w) = walk.as_mut().filter(|_| traced.is_some()) {
            w.grade(name, &clean);
        }
        if !gating_arm {
            continue;
        }
        day.grade(name, priors_arm);
        if let Some(t) = truth.as_mut() {
            t.grade(name, priors_arm);
        }
        if let Some(j) = journey.as_mut() {
            j.grade(name, &clean);
        }
        feasibility.grade(name, &clean);
    }

    eprintln!(
        "corpus: shard {shard}/{of} replayed {replayed} of {} day(s)",
        names.len()
    );
    if let Some(w) = walk {
        failures.extend(w.finish());
    }
    if !gating_arm {
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        return;
    }
    failures.extend(day.finish());
    if let Some(t) = truth {
        failures.extend(t.finish());
    }
    if let Some(j) = journey {
        failures.extend(j.finish());
    }
    failures.extend(feasibility.finish());
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The name-confidence table the app shows (`Verified.Geo.NameConfidence.COUNTS`)
/// is the SUM of its blessed per-day measurement — two copies of one number
/// must not drift.
#[test]
fn the_name_confidence_table_is_its_measurement() {
    let Ok(raw) = std::fs::read_to_string(corpus::truth::NAME_CONFIDENCE) else {
        eprintln!("SKIPPED: no golden corpus");
        return;
    };
    let mut sum: std::collections::BTreeMap<String, (u64, u64)> = std::collections::BTreeMap::new();
    for line in raw.lines() {
        let j: serde_json::Value =
            serde_json::from_str(line).expect("a name-confidence line parses");
        for (src, v) in j["counts"].as_object().expect("counts is an object") {
            let e = sum.entry(src.clone()).or_default();
            e.0 += v[0].as_u64().expect("right");
            e.1 += v[1].as_u64().expect("graded");
        }
    }
    let reply = backend::lean::serve(r#"{"mode":"nameconfidence"}"#).expect("the table answers");
    let table: serde_json::Value = serde_json::from_str(&reply).expect("the table parses");
    let lean: std::collections::BTreeMap<String, (u64, u64)> = table["counts"]
        .as_array()
        .expect("counts")
        .iter()
        .map(|r| {
            (
                r[0].as_str().expect("source").to_string(),
                (
                    r[1].as_u64().expect("right"),
                    r[2].as_u64().expect("graded"),
                ),
            )
        })
        .collect();
    assert_eq!(
        lean, sum,
        "Verified.Geo.NameConfidence.COUNTS must equal the sum of tests/golden/name-confidence.jsonl"
    );
}

/// A stay row graded at a walk's midpoint judged no name: the stay that grazes
/// its first minute is not charged for it.
#[test]
fn a_name_is_graded_by_the_state_its_verdict_read() {
    use serde_json::json;
    let states = [
        json!({"mode": "stationary", "startTs": 0, "endTs": 600, "placeConfidenceKey": "station"}),
        json!({"mode": "walking", "startTs": 600, "endTs": 1200}),
    ];
    let row = |a: i64, b: i64| json!({"startTs": a, "endTs": b, "truth": {"mode": "stationary", "place": "Somewhere"}});
    let rows = [row(0, 600), row(540, 1140)];
    let verdicts = [json!("verified"), json!("regressed")];
    let covering = [json!(0), json!(1)];
    let counts = corpus::truth::name_confidence_counts(&rows, &verdicts, &covering, &states);
    assert_eq!(
        counts,
        std::collections::BTreeMap::from([("station".to_string(), (1, 1))])
    );
}
