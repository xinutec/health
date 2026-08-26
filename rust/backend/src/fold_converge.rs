//! The day fold's converge loop — run, collect what it could not answer,
//! answer it, run again (#982).
//!
//! # Why this can work at all
//!
//! The fold is a PURE FUNCTION OF ITS TABLES. Run it against a table it does
//! not have, let it name what it wanted, answer that, run it again. When a
//! round asks for nothing new, every answer it read was real.
//!
//! That needs `panic!` to print and continue, which is what Lean does: a round
//! with an incomplete table runs to the end and names every key it reached
//! rather than stopping at the first. The rest of that round's output is
//! poisoned by the defaults it read and is THROWN AWAY — only the key set is
//! kept, and only the final round's answer is returned.
//!
//! The round count is not the number of lookups. It is the DEPTH of the
//! dependency chain among them: how many times an answer decides the next
//! question.
//!
//! # ⚠ Convergence is an EMPTY miss list, not "nothing new"
//!
//! A key asked again after being answered means the answer went somewhere the
//! fold does not read it — a wrong table name, a key spelled differently than
//! the fold spells it. That is a harness fault, and it would otherwise look
//! exactly like convergence: the round asks for nothing NEW, so a loop watching
//! for new keys would stop and return the poisoned output as the day.

use std::collections::HashSet;

use anyhow::{Context, Result, bail};
use serde_json::Value;

use crate::fold_payload::{AnswerTables, build_day_request};
use crate::lean::{self, Miss};

/// A generous bound on the dependency depth, so a run that fails to converge
/// says so instead of looping.
///
/// ⚠ NOT A BUDGET THE LOOP MAY SPEND. Reaching it is a reported failure: the
/// interesting number is the depth, and a truncated depth is not a depth. The
/// TypeScript measures 2-7 rounds on this corpus.
pub const MAX_ROUNDS: u32 = 40;

/// What one converged run cost and produced.
#[derive(Debug)]
pub struct Converged {
    /// Rounds run, including the final one that asked for nothing.
    pub rounds: u32,
    /// Distinct keys answered across the whole walk.
    pub answered: usize,
    /// Keys the answerer could not supply. ⚠ A run with any of these did NOT
    /// converge on complete data — it converged because nothing new was left to
    /// try, which is a different claim.
    pub unanswerable: Vec<Miss>,
    /// The final round's response.
    pub out: String,
    /// ⚠ THE REQUEST THE FOLD ACTUALLY RECEIVED on the final round, tables and
    /// all — not the one the first round was built from. Handed back because
    /// the only way to check that a SECOND host answers the same day identically
    /// is to give it the same bytes, and rebuilding them outside this loop means
    /// rebuilding the convergence too. The TypeScript's `DAY_REQ_DUMP` dumped
    /// exactly this and nothing in Rust could until now (#975).
    pub request: Value,
}

/// Supplies the answer to one unanswered key, already in the wire form the
/// fold's tables carry.
///
/// `Ok(None)` means "not mine / cannot answer" and is recorded rather than
/// treated as an error: the TypeScript's own loop has two tables it cannot
/// answer offline, and a day that needs one of them should say so rather than
/// abort the walk.
pub trait Answerer {
    fn answer(&mut self, miss: &Miss) -> Result<Option<(String, Value)>>;
}

/// Print every key the walk asks about, so a naming that came out wrong can be
/// read back as the questions that produced it.
///
/// Off unless `FOLD_TRACE_KEYS` is set. A count alone cannot distinguish "the
/// stay was never asked about" from "it was asked and the answer named nothing"
/// — those have different causes and this is what tells them apart.
fn trace_key(round: u32, verdict: &str, m: &Miss) {
    if std::env::var_os("FOLD_TRACE_KEYS").is_some() {
        eprintln!("  r{round} {verdict} {}({})", m.what, m.key);
    }
}

/// As `trace_key`, plus the answer itself when `FOLD_TRACE_KEYS=rows`.
///
/// ⚠ An answered key is not an informative answer. A table that supplies an
/// EMPTY row reads as "answered" in every count here, and a naming that came
/// out blank because nothing was near it looks identical to one that ranked its
/// candidates and rejected them. The row is what separates those.
fn trace_answer(round: u32, m: &Miss, row: &Value) {
    if std::env::var_os("FOLD_TRACE_KEYS").as_deref() == Some(std::ffi::OsStr::new("rows")) {
        let s = row.to_string();
        let clipped: String = s.chars().take(600).collect();
        eprintln!("  r{round} answered {}({}) = {clipped}", m.what, m.key);
    } else {
        trace_key(round, "answered", m);
    }
}

/// Walk the fold to convergence.
pub fn converge<A: Answerer>(
    cap: &Value,
    inputs: &Value,
    trace: Option<&Value>,
    answerer: &mut A,
) -> Result<Converged> {
    let mut tables = AnswerTables::default();
    let mut asked: HashSet<Miss> = HashSet::new();
    let mut unanswerable: Vec<Miss> = Vec::new();

    for round in 1..=MAX_ROUNDS {
        let req = build_day_request(cap, inputs, trace, &tables)
            .with_context(|| format!("building the request for round {round}"))?;
        let body = serde_json::to_string(&req).context("serialising the request")?;
        // The fold takes `{"mode": "day", …}`; the request object IS the rest.
        let wrapped = format!("{{\"mode\":\"day\",{}", &body[1..]);

        let (out, misses) =
            lean::serve_capturing_misses(&wrapped).with_context(|| format!("round {round}"))?;

        // ⚠ Only keys we have NOT already answered count as progress. One that
        // reappears was answered into somewhere the fold does not read.
        let fresh: Vec<Miss> = misses
            .iter()
            .filter(|m| !asked.contains(*m))
            .cloned()
            .collect();

        if misses.is_empty() || fresh.is_empty() && !unanswerable.is_empty() {
            // Either nothing was missing, or everything still missing is
            // something this answerer already declined. Both are terminal;
            // `unanswerable` is what distinguishes them to the caller.
            return Ok(Converged {
                rounds: round,
                answered: asked.len() - unanswerable.len(),
                unanswerable,
                out,
                request: req,
            });
        }

        if fresh.is_empty() {
            let m = &misses[0];
            bail!(
                "re-asked {}({}) after answering it — the answer is going \
                 somewhere the fold does not read, which is a harness fault and \
                 not convergence",
                m.what,
                m.key
            );
        }

        for m in fresh {
            asked.insert(m.clone());
            match answerer.answer(&m)? {
                Some((table, row)) => {
                    trace_answer(round, &m, &row);
                    tables.push(&table, row);
                }
                None => {
                    trace_key(round, "declined", &m);
                    unanswerable.push(m);
                }
            }
        }
    }

    bail!(
        "no convergence in {MAX_ROUNDS} rounds — {} key(s) answered",
        asked.len()
    )
}

/// An answerer that supplies nothing, so every miss is recorded.
///
/// Not a placeholder: it is how a day is MEASURED. Running it says exactly
/// which keys a day needs beyond what the capture recorded, which is the
/// question "does this day converge on the recorded tables" — and 22 of the 35
/// golden days answer yes.
#[derive(Debug, Default)]
pub struct RecordOnly;

impl Answerer for RecordOnly {
    fn answer(&mut self, _miss: &Miss) -> Result<Option<(String, Value)>> {
        Ok(None)
    }
}
