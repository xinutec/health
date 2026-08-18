//! Capturing the fold's unanswered keys from an in-process call (#982).
//!
//! ⚠ ONE `#[test]`, for two reasons that both bite. `lean::init()` starts a
//! runtime several tests racing on would flake over, and the capture redirects
//! fd 2, which is process-wide — a concurrent test would swallow the other's
//! stderr or lose its own.

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

/// The capture itself, against a real request that is known to miss.
///
/// Skips loudly when the corpus is absent — see `fold_request_corpus.rs` for
/// why the day fixtures cannot be committed.
#[test]
fn a_real_round_reports_its_unanswered_keys() {
    lean::init().expect("the Lean runtime must start");

    let path = "/tmp/req-2026-05-15-pippijn.json";
    let Ok(req) = std::fs::read_to_string(path) else {
        eprintln!("SKIPPED: no request at {path}; see fold_request_corpus.rs for how to build one");
        return;
    };

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
        "this day is known to leave keys unanswered; capturing none means fd 2 \
         was not redirected, not that the day converged"
    );
    for m in &misses {
        assert!(
            !m.what.is_empty() && !m.key.is_empty(),
            "malformed miss {m:?}"
        );
    }
    eprintln!("{} unanswered key(s): {:?}", misses.len(), misses.first());
}
