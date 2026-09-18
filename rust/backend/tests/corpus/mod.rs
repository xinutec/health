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
//! ⚠ **THE TRACE IS LOADED ONCE PER DAY, BEFORE ANY ARM.** It lives in a
//! day-shell global, so loading it per replay would pay the parse twice for
//! nothing. `load_trace` is separate from `replay` for that reason, not by
//! accident.

use serde_json::Value;

use backend::fold_converge::converge;
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
    /// Converge rounds, which `day` reports.
    pub rounds: u32,
    /// Keys no answerer could supply — `day` names them. `Miss`, not a rendered
    /// string: the table and the key parts are what a caller reports.
    pub unanswerable: Vec<backend::lean::Miss>,
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

/// Load the day's walkable roads, buildings and drivable ways into day-shell's
/// global, so the fold's walk pass runs the way production runs it.
///
/// ⚠ **WITHOUT A TRACE THE WALK PASS DOES NOT RUN** (#1418). The matcher reads
/// its roads through day-shell's `walkableRoads` callback, which answers EMPTY
/// unless one is loaded — and on empty `annotateWalkMatches` bails per leg, so
/// the raw drawing survives looking exactly like a leg the matcher considered
/// and left alone.
///
/// ⚠ **PRESENCE OF THE KEY IS NOT PRESENCE OF A TRACE.** 2026-08-12 carries all
/// three sections as EMPTY OBJECTS; a key-presence check calls that capturable
/// and the loader then refuses it, which cost a 9-minute run to find out. Count
/// the entries.
///
/// `Ok(false)` means the fixture captured nothing to load, and the caller must
/// record that day as unmeasured for walks rather than grading it against the
/// PREVIOUS day's roads.
pub fn load_trace(
    golden: &str,
    name: &str,
    fx: &Value,
    walkable: bool,
    buildings: bool,
    drivable: bool,
) -> Result<bool, String> {
    let section = |k: &str| {
        fx.pointer(&format!("/inputs/osmTrace/{k}"))
            .and_then(Value::as_object)
            .map_or(0, serde_json::Map::len)
    };
    if section("walkableRoads") + section("buildingsNear") == 0 {
        return Ok(false);
    }
    // ⚠ AN EMPTY BUILDING ANSWER IS UNMEASURED, NOT CLEAN (#1501). The wall
    // metric `offPathBuildingCrossingM` is the walk referee's "true defect"
    // axis, and it reads 0.0 both when a line crosses no wall and when the
    // mirror had no walls to check it against. The referee draws that
    // distinction per DAY (`offPathM` is `none` when the day's buildings are
    // empty) but not per LOCATION, which is where coverage actually varies.
    //
    // Measured 2026-09-17 over the whole corpus: 239 `buildingsNear` keys, ZERO
    // empty, and the least-covered query still returns 27 outlines (p50 327).
    // So this cannot fire today, and that is the point — it is a TRIPWIRE for
    // the first re-capture that lands on ground the building layer does not
    // reach, not a check that something is presently wrong.
    //
    // It is deliberately FATAL rather than a warning. The failure mode it
    // guards is a metric scoring 0.0 everywhere and reading as an improvement
    // on all of it, which is the same shape that let a deleted detector pass
    // this gate twice (#1501 §2). When it does fire, the fix is the
    // per-location distinction that ticket asks for — not a looser bar here.
    if let Some(bldg) = fx
        .pointer("/inputs/osmTrace/buildingsNear")
        .and_then(Value::as_object)
    {
        let blank: Vec<&String> = bldg
            .iter()
            .filter(|(_, v)| v.as_array().is_none_or(Vec::is_empty))
            .map(|(k, _)| k)
            .collect();
        if !blank.is_empty() {
            return Err(format!(
                "{name}: {} of {} buildingsNear key(s) came back EMPTY. That is \
                 UNMEASURED ground, and every walk reading it scores \
                 offPathBuildingCrossingM 0.0 — which the referee cannot tell \
                 from a clean line. See #1501: the fix is to report wall \
                 coverage per location, not to drop this check.",
                blank.len(),
                bldg.len(),
            ));
        }
    }

    // ⚠ REFUSE A FIXTURE CAPTURED UNDER CONSTANTS THIS BUILD NO LONGER USES.
    // The margin and the candidate limit are applied AFTER the trace key is
    // formed, so moving one changes production and changes nothing any fixture
    // answers — the gate stays green while the served day differs (#1071), and
    // #328 is the same fault from the other side. Absent stamp is not a
    // mismatch: the 42 fixtures predating this carry none.
    backend::osm_host::check_capture_inputs(&fx["meta"]).map_err(|e| format!("{name}: {e}"))?;

    // ⚠ FROM `fx`, NOT FROM THE PATH. The path form re-reads and re-parses the
    // fixture this function was already handed — 370 MiB and 470 ms on a 28 MB
    // golden day, per day, in a gate that walks 42 of them (#1654).
    backend::osm_host::load_trace_value_sections(
        fx,
        &format!("{golden}/{name}"),
        walkable,
        buildings,
        drivable,
    )
    .map_err(|e| format!("{name}: osm trace: {e}"))?;
    Ok(true)
}

/// Replay one already-parsed fixture. `Err` carries a message already prefixed
/// with `name`, which is the shape every caller's `failures` vector wants.
pub fn replay(name: &str, fx: Value) -> Result<Replay, String> {
    let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));

    let inputs = &fx["inputs"];
    let rowset = inputs
        .get("osmRowSet")
        .ok_or_else(|| format!("{name}: no osmRowSet to answer from"))?;
    let cap =
        backend::head::capture(inputs, date, user).map_err(|e| format!("{name}: head: {e:#}"))?;
    let mut answerer =
        RowSetAnswerer::new(rowset).map_err(|e| format!("{name}: row set: {e:#}"))?;

    let r = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer)
        .map_err(|e| format!("{name}: converge: {e:#}"))?;
    let out: Value =
        serde_json::from_str(&r.out).map_err(|e| format!("{name}: the fold reply: {e}"))?;
    Ok(Replay {
        fx,
        out,
        request: r.request,
        rounds: r.rounds,
        unanswerable: r.unanswerable,
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
    replay(name, with_priors(&fx, priors))
}
