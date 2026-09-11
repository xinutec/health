//! Capturing the fold's unanswered keys from an in-process call (#982).
//!
//! ⚠ ONE `#[test]`, for two reasons that both bite. `lean::init()` starts a
//! runtime several tests racing on would flake over, and the capture redirects
//! fd 2, which is process-wide — a concurrent test would swallow the other's
//! stderr or lose its own.

use backend::fold_payload::{AnswerTables, build_day_request};
use backend::lean::{self, misses_in};

/// The parser, on the message shape the fold actually prints.
///
/// ⚠ The bracket case is the one worth having. A line name IS a key and line
/// names contain brackets, so a parser anchored on the FIRST `)` silently
/// answers a different key — which the loop then believes it has handled, and
/// which looks exactly like convergence.
#[test]
fn the_parser_survives_a_key_containing_brackets() {
    let line = "PANIC at _private.DayEntry.0.Day.hit DayEntry:52:12: verified_cli day: \
                uncaptured stationsOnLine(Northern Line (Charing Cross Branch) Southbound) \
                — re-capture required";
    let got = misses_in(line);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].what, "stationsOnLine");
    assert_eq!(
        got[0].key,
        "Northern Line (Charing Cross Branch) Southbound"
    );

    // Repeats collapse: `panic!` fires per call, so a coordinate asked twice
    // prints twice and must still be answered once.
    let twice = format!("{line}\n{line}");
    assert_eq!(misses_in(&twice).len(), 1);

    // Two different keys stay two.
    let other = line.replace("Southbound", "Northbound");
    assert_eq!(misses_in(&format!("{line}\n{other}")).len(), 2);

    // Unrelated stderr is not a miss.
    assert!(misses_in("lean-bridge: serving verified core (ok)").is_empty());
}

/// The capture itself, against a request that is known to miss BY CONSTRUCTION.
///
/// ⚠ THIS USED TO READ A BARE `/tmp` PATH, and it was wrong twice over (#1531).
/// The path could only be filled by a recipe that died with the TypeScript
/// (`node dist/cli/golden-check.js`), so the test announced a skip on every
/// machine and the skip could never lift. And when an unrelated session happened
/// to leave a file there, it FAILED — blaming an fd-2 redirection that was
/// working fine, because that file held the fold's FINAL round, which by
/// definition carries every answer table and therefore misses nothing.
///
/// So the request is built here instead, from the corpus, with EMPTY answer
/// tables — which is exactly what `converge` feeds its first round. A first
/// round cannot have its lookups answered, so a day that reports no misses is a
/// real finding about the capture rather than a guess about the input.
#[test]
fn a_real_round_reports_its_unanswered_keys() {
    const STEM: &str = "2026-05-15-pippijn";

    // Skips LOUDLY: `tests/golden/days` is gitignored, so its absence is the
    // ordinary case off this machine and must not read as a pass.
    let path = format!(
        "{}/../../tests/golden/days/{STEM}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("SKIPPED: no corpus at {path}");
        return;
    };

    lean::init().expect("the Lean runtime must start");

    let fx: serde_json::Value = serde_json::from_str(&text).expect("the fixture parses");
    let inputs = &fx["inputs"];
    let (date, user) = (&STEM[..10], &STEM[11..]);
    let cap = backend::head::capture(inputs, date, user).expect("head::capture");

    // The FIRST round: no answers gathered yet, the same state `converge` starts
    // from. `dump_day_request` prints the LAST round and is not usable here.
    let req = build_day_request(
        &cap,
        inputs,
        inputs.get("osmTrace"),
        &AnswerTables::default(),
    )
    .expect("the first-round request builds");
    let req = serde_json::to_string(&req).expect("the request serialises");
    let wrapped = format!("{{\"mode\":\"day\",{}", &req[1..]);

    let (out, misses) = lean::serve_capturing_misses(&wrapped).expect("the fold answers");

    // ⚠ The round still RETURNS. Its output is poisoned by the defaults the
    // misses read, which is why the loop keeps only the key set — but a round
    // that failed outright would be a different bug, so this pins that it did
    // not.
    let v: serde_json::Value = serde_json::from_str(&out).expect("a JSON answer");
    assert!(
        v.get("states").is_some(),
        "the round produced a timeline: {out:.200}"
    );

    assert!(
        !misses.is_empty(),
        "a FIRST-round request was served with empty answer tables, so the fold \
         had nothing to resolve its lookups from and must have reported at least \
         one — capturing zero means the capture did not see stderr, not that the \
         day converged"
    );
    for m in &misses {
        assert!(
            !m.what.is_empty() && !m.key.is_empty(),
            "malformed miss {m:?}"
        );
    }
    eprintln!("{} unanswered key(s): {:?}", misses.len(), misses.first());
}
