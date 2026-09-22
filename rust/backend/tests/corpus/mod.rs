//! One replay of one golden day, shared by every corpus grader (#1359).
//!
//! ⚠ **THE REPLAY WAS PAID FOUR TIMES.** `day_corpus`, `truth_corpus`,
//! `journey_corpus` and `walk_gate` each rebuilt the same day from the same
//! fixture and then graded it differently — measured 2026-09-03 at ~1.31 s/day,
//! and far worse once the walk matcher started running in the fold (#1418):
//! `user` 2934 s against 718 s wall on one row, because the matcher's ~305 s was
//! paid per harness rather than per day. `corpus_gate` replays once per day and
//! hands the result to all four.
//!
//! ⚠ **THE GRADERS DO NOT ALL REPLAY THE SAME INPUT, and that is why `priors`
//! is a parameter rather than read from the environment here.** `day_corpus`
//! and `truth_corpus` replace the fixture's captured `venuePriors` with
//! `VENUE_PRIORS_FILE` for #343's A/B; `journey_corpus` and `walk_gate` never
//! inject. A shared replay that guessed would either feed those two priors they
//! did not ask for, or quietly stop #343's A/B from being an A/B — and
//! **neither fails**, both produce plausible numbers. So `corpus_gate` replays
//! each ARM it needs: one when `VENUE_PRIORS_FILE` is unset (every grader wants
//! the fixture's own blob, so they share it), two when it is set.
//!
//! ⚠ **THE TRACE IS INDEXED ONCE PER DAY, BEFORE ANY ARM,** and both arms
//! borrow it. `load_trace` is separate from `replay` for that reason, not by
//! accident.

use serde_json::Value;

use backend::osm_trace::{Sections, TraceAnswerer};
use backend::rowset_answerer::RowSetAnswerer;

pub mod day;
pub mod journey;
pub mod truth;
pub mod walk;

/// One day, replayed once: the fixture as it was fed in, and what the fold said.
///
/// ⚠ `dead_code` is allowed because **the graders use different subsets** —
/// `day` reads `rounds` and `unanswerable`, `walk` reads `request`, the others
/// read neither.
#[allow(dead_code)]
pub struct Replay {
    /// The fixture, AFTER any priors injection — so a grader reads the same
    /// inputs the fold saw rather than what was on disk.
    pub fx: Value,
    /// The fold's reply, parsed.
    pub out: Value,
    /// The day request the fold was driven with; `walk` reads raw fixes out of it.
    pub request: Value,
    /// Every ask the fold made, with whether it was answered. `day` names the
    /// declined ones; `walk` counts the three matcher reads.
    pub asks: Vec<(backend::lean::Ask, bool)>,
}

impl Replay {
    pub fn declined(&self) -> Vec<backend::lean::Ask> {
        self.asks
            .iter()
            .filter(|(_, ok)| !ok)
            .map(|(a, _)| a.clone())
            .collect()
    }

    /// `(answered, declined)` over `walkableRoads`, `buildingsNear`,
    /// `drivableRoads`.
    pub fn osm_counts(&self) -> (u64, u64) {
        backend::fold::OSM_READS.iter().fold((0, 0), |(h, m), w| {
            self.asks
                .iter()
                .filter(|(a, _)| a.what == *w)
                .fold(
                    (h, m),
                    |(h, m), (_, ok)| if *ok { (h + 1, m) } else { (h, m + 1) },
                )
        })
    }
}

/// Every golden day, sorted.
///
/// ⚠ It does NOT apply `CORPUS_DAYS` — `restrict` does, separately, so that an
/// empty corpus and a mistyped filter cannot produce the same message. They are
/// different faults and the first version of this conflated them.
pub fn day_names(golden: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(golden)
        .expect("the corpus directory is readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names
}

/// Narrow the corpus to a comma-separated list of date prefixes.
///
/// ⚠ **A SUBSET RUN IS NOT A GATING RUN, and it says so rather than passing
/// quietly**: every floor comparison downstream is a verdict over the days that
/// actually replayed. This is what makes a four-arm ablation affordable — the
/// full corpus is ~390 s a run.
///
/// ⚠ **A TYPO MUST NOT RETAIN SILENTLY.** `CORPUS_DAYS=2026-13-01` matches no
/// fixture, and a clean run over nothing reads exactly like a clean run over
/// everything. Carried over from `WALK_DAYS`, which asserted this; the first
/// version of `corpus_gate` dropped the assertion and left the empty result to
/// be reported as "the corpus directory is empty", naming the wrong cause.
pub fn restrict(names: Vec<String>, filter: Option<String>) -> Vec<String> {
    let Some(only) = filter else { return names };
    let want: Vec<&str> = only
        .split(',')
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .collect();
    let kept: Vec<String> = names
        .into_iter()
        .filter(|n| want.iter().any(|d| n.starts_with(d)))
        .collect();
    assert!(
        !kept.is_empty(),
        "CORPUS_DAYS={only:?} matched no fixture — a typo here reads as a clean run over nothing"
    );
    eprintln!(
        "corpus: CORPUS_DAYS restricts this run to {} day(s) — NOT a gating verdict",
        kept.len()
    );
    kept
}

/// The `shard`-th of `of` slices, by index modulo — so each shard draws days
/// from across the corpus rather than one contiguous month, and a slow stretch
/// does not land entirely on one of them.
pub fn shard_of(names: &[String], shard: usize, of: usize) -> Vec<String> {
    names
        .iter()
        .enumerate()
        .filter(|(i, _)| i % of == shard)
        .map(|(_, n)| n.clone())
        .collect()
}

/// Read and parse one fixture.
pub fn read_fixture(golden: &str, name: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(format!("{golden}/{name}"))
        .map_err(|e| format!("{name}: reading: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{name}: parsing: {e}"))
}

/// The fixture with `priors` injected, or a plain clone when `None`.
pub fn with_priors(fx: &Value, priors: Option<&Value>) -> Value {
    let mut fx = fx.clone();
    if let Some(blob) = priors {
        fx["inputs"]["venuePriors"] = blob.clone();
    }
    fx
}

/// Index the day's recorded walkable roads, buildings and drivable ways, so the
/// fold's walk pass runs the way production runs it.
///
/// ⚠ **WITHOUT A TRACE THE WALK PASS DOES NOT RUN** (#1418). The matcher's
/// `walkableRoads` ask is DECLINED unless a trace answers it — and on a decline
/// `annotateWalkMatches` bails per leg, so the raw drawing survives looking
/// exactly like a leg the matcher considered and left alone.
///
/// ⚠ **PRESENCE OF THE KEY IS NOT PRESENCE OF A TRACE.** 2026-08-12 carries all
/// three sections as EMPTY OBJECTS; a key-presence check calls that capturable
/// and the loader then refuses it, which cost a 9-minute run to find out. Count
/// the entries.
///
/// `Ok(None)` means the fixture captured no walk read, and the caller must
/// record that day as unmeasured for walks.
pub fn load_trace(
    golden: &str,
    name: &str,
    fx: &Value,
    walkable: bool,
    buildings: bool,
    drivable: bool,
) -> Result<Option<TraceAnswerer>, String> {
    // ⚠ REFUSE A FIXTURE CAPTURED UNDER CONSTANTS THIS BUILD NO LONGER USES.
    // The margin and the candidate limit are applied AFTER the ask key is
    // formed, so moving one changes production and changes nothing any fixture
    // answers — the gate stays green while the served day differs (#1071), and
    // #328 is the same fault from the other side. Absent stamp is not a
    // mismatch: the 42 fixtures predating this carry none.
    backend::osm_trace::check_capture_inputs(&fx["meta"]).map_err(|e| format!("{name}: {e}"))?;

    let trace = TraceAnswerer::from_fixture(
        fx,
        &format!("{golden}/{name}"),
        Sections {
            walkable,
            buildings,
            drivable,
        },
    )
    .map_err(|e| format!("{name}: osm trace: {e}"))?;
    // ⚠ AN EMPTY BUILDING ANSWER IS UNMEASURED, NOT CLEAN (#1501), and the
    // referee knows that per LEG (`WalkIn.buildingsMeasured`), so a partial
    // capture is answered as far as it goes rather than refused. What replaces
    // a refusal is the REPORT: `walks:` prints the measured / unmeasured tally
    // and names each unmeasured leg on every run.
    Ok(trace.has_walk_capture().then_some(trace))
}

/// Replay one already-parsed fixture. `Err` carries a message already prefixed
/// with `name`, which is the shape every caller's `failures` vector wants.
pub fn replay(name: &str, fx: Value, trace: Option<&TraceAnswerer>) -> Result<Replay, String> {
    let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));

    let inputs = &fx["inputs"];
    let rowset = inputs
        .get("osmRowSet")
        .ok_or_else(|| format!("{name}: no osmRowSet to answer from"))?;
    let cap =
        backend::head::capture(inputs, date, user).map_err(|e| format!("{name}: head: {e:#}"))?;
    let rows = RowSetAnswerer::new(rowset).map_err(|e| format!("{name}: row set: {e:#}"))?;

    // The trace first — the answers the day was blessed on — and the row set
    // for what it does not hold. No trace loaded means the seven answerer
    // tables still come from the trace sections the fixture carries, if any;
    // only the three matcher reads are withheld.
    let r = match trace {
        Some(t) => backend::fold::run_day(&cap, inputs, &mut backend::lean::Chain(t, rows)),
        None => {
            let tables = TraceAnswerer::from_fixture(
                &fx,
                name,
                Sections {
                    walkable: false,
                    buildings: false,
                    drivable: false,
                },
            )
            .map_err(|e| format!("{name}: osm trace: {e}"))?;
            backend::fold::run_day(&cap, inputs, &mut backend::lean::Chain(tables, rows))
        }
    }
    .map_err(|e| format!("{name}: fold: {e:#}"))?;
    let out: Value =
        serde_json::from_str(&r.out).map_err(|e| format!("{name}: the fold reply: {e}"))?;
    Ok(Replay {
        fx,
        out,
        request: r.request,
        asks: r.asks,
    })
}

/// ⚠ **TRANSITIONAL (#1359)** — the pre-shared-runner entry point, for graders
/// not yet moved into `corpus_gate`. It reads the fixture per caller, which is
/// the cost the move exists to remove, and it deliberately does NOT load the
/// trace: a grader still on this path must keep replaying the arm it was
/// blessed against until it moves and is re-blessed together with the flip.
#[allow(dead_code)]
pub fn replay_own(golden: &str, name: &str, priors: Option<&Value>) -> Result<Replay, String> {
    let fx = read_fixture(golden, name)?;
    replay(name, with_priors(&fx, priors), None)
}
