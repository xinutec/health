//! The converge loop, walked over the real corpus (#982).
//!
//! Local-only and announces a skip, for the reason `fold_request_corpus.rs`
//! gives: the day fixtures carry real coordinates and are gitignored.
//!
//! # What this measures
//!
//! With [`RecordOnly`] — an answerer that supplies nothing — a day either
//! converges on the tables the capture already holds, or it names exactly what
//! it needs beyond them. That is the honest shape of the question a Rust host
//! has to answer, and it is measurable before any lookup is implemented.
//!
//! The TypeScript's `fold-capture.ts` predicts this outcome on purpose: a
//! recorded table has only the questions the TypeScript asked, so where the
//! Lean arm asks a different one it misses, and "the miss IS the finding".

use std::path::Path;

use backend::fold_converge::{RecordOnly, converge};
use serde_json::Value;

fn capture_dir() -> String {
    std::env::var("FOLD_CAPTURE").unwrap_or_else(|_| "/tmp/foldcap".to_string())
}

#[test]
fn every_day_either_converges_or_names_what_it_needs() {
    let caps = capture_dir();
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    if !Path::new(&caps).is_dir() || !Path::new(golden).is_dir() {
        eprintln!("SKIPPED: no corpus at {caps} / {golden}; see fold_request_corpus.rs");
        return;
    }

    let mut names: Vec<String> = std::fs::read_dir(&caps)
        .expect("capture dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();

    let (mut clean, mut needs) = (0usize, 0usize);
    let mut wanted: std::collections::BTreeMap<String, usize> = Default::default();

    for name in &names {
        let (Ok(cap_raw), Ok(fx_raw)) = (
            std::fs::read_to_string(format!("{caps}/{name}")),
            std::fs::read_to_string(format!("{golden}/{name}")),
        ) else {
            continue;
        };
        let cap: Value = serde_json::from_str(&cap_raw).expect("capture parses");
        let fx: Value = serde_json::from_str(&fx_raw).expect("fixture parses");
        let inputs = &fx["inputs"];

        let r = converge(&cap, inputs, inputs.get("osmTrace"), &mut RecordOnly)
            .unwrap_or_else(|e| panic!("{name}: {e:#}"));

        // ⚠ Every walk must TERMINATE, whatever it found. A day that neither
        // converges nor names an unanswerable key would be the loop spinning,
        // and `converge` promises it cannot: it either returns or errors.
        assert!(r.rounds >= 1 && r.rounds <= backend::fold_converge::MAX_ROUNDS);

        if r.unanswerable.is_empty() {
            clean += 1;
            // A day that converged did so with the FIRST round's answer, since
            // nothing was ever added to the tables.
            assert_eq!(
                r.rounds, 1,
                "{name}: converged but took {} rounds",
                r.rounds
            );
            let v: Value = serde_json::from_str(&r.out).expect("a JSON answer");
            assert!(v.get("states").is_some(), "{name}: no timeline");
        } else {
            needs += 1;
            for m in &r.unanswerable {
                *wanted.entry(m.what.clone()).or_default() += 1;
            }
        }
    }

    assert!(
        clean + needs >= 20,
        "only {} day(s) walked — a nearly-empty corpus would make this pass for \
         the wrong reason",
        clean + needs
    );
    eprintln!("converged on the recorded tables: {clean}   need more: {needs}");
    eprintln!("keys wanted beyond the capture: {wanted:?}");

    // The measured split, pinned. It is a fact about the corpus rather than a
    // requirement on the code, so it is asserted loosely — but a change that
    // moved it a long way means the request changed, and that is worth failing
    // over rather than noticing later.
    assert!(
        clean >= 15,
        "only {clean} day(s) converge on the recorded tables; it was 22 when the \
         encoder was verified byte-identical, so the request has probably changed"
    );
}
