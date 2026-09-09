//! One replay of one golden day, shared by every corpus grader (#1359).
//!
//! ⚠ **THE REPLAY WAS PAID FOUR TIMES.** `day_corpus`, `truth_corpus`,
//! `journey_corpus` and `walk_gate` each rebuilt the same day from the same
//! fixture and then graded it differently — measured 2026-09-03 at ~1.31 s/day,
//! and far worse since the walk matcher started running in the fold (#1418):
//! `user` 2934 s against 718 s wall on one row, because the matcher's ~305 s is
//! paid per harness rather than per day.
//!
//! ⚠ **THE GRADERS DO NOT ALL REPLAY THE SAME INPUT, and that is why `priors`
//! is a parameter rather than read from the environment here.** `day_corpus`
//! and `truth_corpus` replace the fixture's captured `venuePriors` with
//! `VENUE_PRIORS_FILE` for #343's A/B; `journey_corpus` never injects. A shared
//! replay that guessed would either feed journey_corpus priors it did not ask
//! for, or quietly stop #343's A/B from being an A/B — and **neither fails**,
//! both produce plausible numbers. So the caller states its own arm, and a
//! merged runner must not share one replay across graders that disagree on it.

use serde_json::Value;

use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;

/// One day, replayed once: the fixture as it was fed in, and what the fold said.
///
/// ⚠ `dead_code` is allowed because **each test binary compiles this module
/// separately and uses a different subset** — `day_corpus` reads `rounds` and
/// `unanswerable`, `walk_gate` reads `request`, the others read neither. Without
/// this every binary warns about the fields it happens not to want, which is a
/// property of how Rust builds `tests/`, not of the struct.
#[allow(dead_code)]
pub struct Replay {
    /// The fixture, AFTER any priors injection — so a grader reads the same
    /// inputs the fold saw rather than what was on disk.
    pub fx: Value,
    /// The fold's reply, parsed.
    pub out: Value,
    /// The day request the fold was driven with; `walk_gate` reads raw fixes
    /// out of it.
    pub request: Value,
    /// Converge rounds, which `day_corpus` reports.
    pub rounds: u32,
    /// Keys no answerer could supply — `day_corpus` names them. `Miss`, not a
    /// rendered string: the table and the key parts are what a caller reports.
    pub unanswerable: Vec<backend::lean::Miss>,
}

/// Replay one fixture. `Err` carries a message already prefixed with `name`,
/// which is the shape every caller's `failures` vector wants.
///
/// ⚠ `priors` is the CALLER's arm, not this function's business — see the
/// header. `None` means the fixture's own captured blob.
pub fn replay(golden: &str, name: &str, priors: Option<&Value>) -> Result<Replay, String> {
    let text = std::fs::read_to_string(format!("{golden}/{name}"))
        .map_err(|e| format!("{name}: reading: {e}"))?;
    let mut fx: Value = serde_json::from_str(&text).map_err(|e| format!("{name}: parsing: {e}"))?;
    if let Some(blob) = priors {
        fx["inputs"]["venuePriors"] = blob.clone();
    }
    let (date, user) = (&name[..10], name[11..].trim_end_matches(".json"));

    let inputs = &fx["inputs"];
    let rowset = inputs
        .get("osmRowSet")
        .ok_or_else(|| format!("{name}: no osmRowSet to answer from"))?;
    let cap =
        backend::head::capture(inputs, date, user).map_err(|e| format!("{name}: head: {e:#}"))?;
    let mut answerer =
        RowSetAnswerer::new(rowset).map_err(|e| format!("{name}: row set: {e:#}"))?;

    // ⚠ **WITHOUT A TRACE THE WALK PASS DOES NOT RUN** (#1418). The matcher
    // reads its roads through day-shell's `walkableRoads` callback, which
    // answers EMPTY unless one is loaded — and on empty `annotateWalkMatches`
    // bails per leg, so the raw drawing survives looking exactly like a leg the
    // matcher considered and left alone. Production runs the matcher.
    //
    // ⚠ Off unless `CORPUS_TRACE=1`, on COST rather than doubt: the row goes
    // 376.5 s -> 553.7 s with it on, because the matcher is paid per harness.
    // Sharing this replay is what makes flipping it affordable, and the flip
    // must move together with the oracle bless — blessing one arm while the
    // gate runs the other makes the gate red in its own configuration.
    if std::env::var("CORPUS_TRACE").is_ok()
        && inputs
            .pointer("/osmTrace/walkableRoads")
            .and_then(Value::as_object)
            .is_some_and(|o| !o.is_empty())
    {
        backend::osm_host::load_trace(&format!("{golden}/{name}"))
            .map_err(|e| format!("{name}: osm trace: {e}"))?;
    }

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
