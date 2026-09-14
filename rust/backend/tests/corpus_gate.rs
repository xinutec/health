//! Every corpus grader, over ONE replay of each golden day (#1359).
//!
//! ```text
//!   fixture → trace → converge ─┬→ day      (the TypeScript timeline, state by state)
//!                               ├→ truth    (confirmed rows, a ratchet)
//!                               ├→ journeys (the story, a floor)
//!                               └→ walks    (the walk referee's four axes)
//! ```
//!
//! ⚠ **THE REPLAY IS PAID ONCE, NOT ONCE PER HARNESS.** With the walk matcher
//! on, four replays cost `user` 2934 s against 718 s wall (measured 2026-09-08,
//! one gate row), the matcher's ~305 s charged to `walk_gate` alone. What was
//! unaffordable was paying for it four times, not the matcher (#1418).
//!
//! ⚠ **SO #1418 IS NOT A FLAG HERE, IT IS THE STRUCTURE.** `load_trace` runs
//! before the replay every day that captured one, exactly as production does,
//! and every grader sees the matched geometry because they all read the same
//! fold output. The old `CORPUS_TRACE` switch is gone: it existed only to make
//! a per-harness cost optional, and there is no per-harness cost left.
//!
//! ⚠ **TWO ARMS, NOT ONE, WHEN `VENUE_PRIORS_FILE` IS SET.** `day` and `truth`
//! grade #343's injected-priors arm; `journeys` and `walks` never inject. With
//! the variable unset — the gate's configuration — those are the same fixture
//! and one replay serves all four. With it set they are different inputs and
//! must not be shared: feeding `journeys` priors it did not ask for, or
//! quietly grading `day` against the fixture's own blob, both produce
//! PLAUSIBLE numbers and neither fails.
//!
//! # Sharding
//!
//! By day, index modulo, so no shard draws one contiguous stretch. Every
//! grader is sound under it: `day` is per-day outright, and `truth`,
//! `journeys` and `walks` each filter their floor to the days the run actually
//! reported and announce the rest as unchecked (#408). Between the shards every
//! floor key is checked exactly once.
//!
//! ⚠ A BLESS IS SINGLE-SHARD. Each grader's bless path measures ALL days from
//! shard 0 and stands the others down — a floor written from half the corpus
//! would look complete and would silently drop the other half.
//!
//! # Local-only
//!
//! `tests/golden/{days,ground-truth}` is gitignored (#860); the baselines are
//! tracked and carry timestamps and metrics, never a place. Announces a skip
//! rather than passing quietly.

use std::path::Path;

use serde_json::Value;

mod corpus;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// How many ways the corpus is split.
///
/// ⚠ FOUR, AND FOUR IS NOT ARBITRARY. This row's wall clock is its SLOWEST
/// SINGLE TEST, not its total work — the shards run concurrently and the
/// machine is not saturated during the replay (it is during the compile). At
/// two shards the corpus was 21 days each, ~340 s, while `hsmm_decode_corpus`
/// beside it took 244 s. Splitting to four puts the corpus at ~170 s, under
/// that floor, so a fifth shard buys nothing until `hsmm` is the one that moves.
///
/// ⚠ It was stuck at two because two shards in one process CORRUPTED each
/// other — `day-shell`'s `osm::TRACE` was a process global and the replays
/// interleaved (#1560). That is fixed; the trace is thread-local, so shard
/// count is now a scheduling choice rather than a correctness one.
///
/// ⚠ The ceiling is MEMORY, not cores. The walk referee is ~1.6 GB per
/// process, so four is ~6.4 GB of the 32 available, alongside the rest of the
/// gate. Raise it only with that measured, not by taste.
const SHARDS: usize = 4;

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

/// ⚠ TWO SHARDS IN ONE PROCESS USED TO REGRADE THE CORPUS SILENTLY (#1560).
///
/// Measured 2026-09-12, same commit and same archives, one variable at a time:
///
/// ```text
/// nextest    + dev       0 of 118 walks moved   day 21/21
/// nextest    + release   0 of 118 walks moved   day 21/21
/// cargo test + release   94 moved, 49 regressed — 215 OSM lookups unanswered
///                        against 17 under nextest
/// ```
///
/// ⚠ **THE FIRST DIAGNOSIS WAS WRONG, and it is worth saying why.** It blamed
/// the Lean runtime: the walk referee "hands its ways to a process-wide
/// `OnceLock`, so two shards overwrite each other". Lean holds NO mutable state
/// — there is not one `IO.Ref` or `initialize` in the tree — and the way tables
/// travel INSIDE each request. The story fit every number and named the wrong
/// layer, which is the failure mode this file exists to record.
///
/// The clobbered global was Rust's, in `day-shell`'s `osm::TRACE`. A replay is
/// `load_trace(day)` then `replay(day)`; run the shards as threads and those
/// pairs interleave, so one shard replays its day against the other's roads.
/// `TRACE` is thread-local as of 2026-09-13 and the interleaving cannot happen,
/// so `cargo test` is sound again and the refusal that stood here is gone.
///
/// ⚠ `deploy.sh` WAS THE ONLY CALLER THAT RAN THEM THIS WAY, and it produced
/// FALSE FAILURES for an unknown length of time — it reproduced at `7f5b412`
/// with identical numbers. Nothing caught it: `gate.dhall`'s rows are nextest
/// (its header says the #1003 mode trace RELIES on test-per-process) and CI
/// cannot run these gates at all, because the fixtures are gitignored. So the
/// breakage was invisible until somebody tried to ship.
fn run(shard: usize, of: usize) {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }
    let all = corpus::day_names(GOLDEN);
    assert!(!all.is_empty(), "the corpus directory is empty");
    let all = corpus::restrict(all, std::env::var("CORPUS_DAYS").ok());

    // ⚠ A BLESS IS SINGLE-SHARD. `truth` rewrites one floor FILE, so two shards
    // blessing at once race on it and a floor written from half the corpus reads
    // as complete. `day` writes per-fixture and would survive sharding, but the
    // rule is uniform because getting it wrong is silent in exactly one
    // direction: the half that was not measured looks blessed.
    let blessing = ["DAY_BLESS", "TRUTH_BLESS", "WALK_BLESS"]
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

    // #343's A/B. Unset in the gate, so the two arms coincide and one replay
    // serves every grader — see the header on why they must not be merged when
    // it IS set.
    let injected: Option<Value> = std::env::var("VENUE_PRIORS_FILE").ok().map(|path| {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("VENUE_PRIORS_FILE {path}: {e}"));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("VENUE_PRIORS_FILE {path}: {e}"))
    });

    // ⚠ AN ABLATION ARM STANDS THE OTHER GRADERS DOWN. `WALK_TRACE` withholds
    // trace sections ON PURPOSE, so the fold's geometry is ablated — and `day`,
    // `truth` and `journey` grading that against their blessed oracles would
    // report a corpus-wide regression that is really the control working. The
    // arms are an attribution tool, run by hand; they dump rather than assert.
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
        // ⚠ Before the replay, and once for both arms: the matcher reads its
        // roads out of a day-shell global, so a day that captured nothing must
        // leave NO trace loaded rather than the PREVIOUS day's roads.
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
        // ⚠ Leave NO trace loaded rather than the PREVIOUS day's roads.
        if let Some(w) = walk.as_mut().filter(|_| !traced) {
            w.no_capture(name);
        }

        let clean = match corpus::replay(name, corpus::with_priors(&fx, None)) {
            Ok(r) => r,
            Err(e) => {
                failures.push(e);
                continue;
            }
        };
        replayed += 1;

        // ⚠ `day` and `truth` grade the INJECTED arm; when nothing is injected
        // that is this same replay and no second fold is paid.
        let injected_rep = match injected.as_ref() {
            None => None,
            Some(p) => match corpus::replay(name, corpus::with_priors(&fx, Some(p))) {
                Ok(r) => Some(r),
                Err(e) => {
                    failures.push(e);
                    continue;
                }
            },
        };
        let priors_arm = injected_rep.as_ref().unwrap_or(&clean);

        // ⚠ `walk` FIRST: it drains day-shell's lookup counters, and they must
        // be read for the replay that just ran rather than accumulated across
        // days into a number that cannot be attributed.
        if let Some(w) = walk.as_mut().filter(|_| traced) {
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
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
