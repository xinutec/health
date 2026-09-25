//! The HSMM decode, replayed from the frozen fixtures (#1048's last item).
//!
//! ```text
//!   decoded_days inputs ── the decode_one chain, fixture-fed ── assemblesegments
//!                                                              vs the fixture's `expected`
//! ```
//!
//! This is the half `decoder_scoreboard.rs` deliberately does not do: the
//! LIVE Lean decode of each day's raw materials, gated against the segments
//! the TypeScript decoder was blessed to produce. Together they close #1048's
//! gate list: a decoder change that shifts any day's segments fails HERE, and
//! one that degrades journey structure fails the scoreboard.
//!
//! The request each day replays is `backend::decode_fixture::request` — the
//! same one `decode-bench` times, so the decoder that is measured is the
//! decoder that is gated.
//!
//! ⚠ Announces a skip when the corpus is absent rather than passing quietly.

use serde_json::Value;

#[test]
fn every_frozen_decode_still_decodes() {
    // ⚠ The trellis decode of a full 1440-minute day overflows the 2 MiB
    // default test-thread stack; production decodes on the binary's main
    // thread. Same work, roomier stack.
    std::thread::Builder::new()
        .name("hsmm-decode-corpus".into())
        .stack_size(256 * 1024 * 1024)
        .spawn(run_corpus)
        .expect("spawn")
        .join()
        .expect("the corpus thread must not panic");
}

fn run_corpus() {
    let Some(names) = backend::decode_fixture::fixture_names().expect("corpus dir readable") else {
        eprintln!(
            "SKIPPED: no golden corpus at {}; see this file's header.",
            backend::decode_fixture::corpus_dir().display()
        );
        return;
    };
    assert!(!names.is_empty(), "the decoded corpus is empty");

    let mut failures: Vec<String> = Vec::new();
    for name in &names {
        let fx: Value = backend::decode_fixture::read(name).expect("fixture parses");
        let req = backend::decode_fixture::request(&fx).unwrap_or_else(|e| panic!("{name}: {e:#}"));

        let Some(segments) = backend::lean::assemble_segments(&req).expect("assemble answers")
        else {
            failures.push(format!("{name}: the decode is DEGENERATE — no viable path"));
            continue;
        };
        let got = backend::row_json::render_segments(&segments).expect("segments render");
        let got = got.as_array().cloned().unwrap_or_default();
        let want = fx["expected"].as_array().expect("expected").clone();

        if got.len() != want.len() {
            failures.push(format!(
                "{name}: {} segments vs {} expected",
                got.len(),
                want.len()
            ));
            continue;
        }
        for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
            // Compare the fields the fixture stores; the render may carry more.
            for f in [
                "startTs",
                "endTs",
                "mode",
                "placeId",
                "lineName",
                "boardStation",
                "alightStation",
            ] {
                let (gv, wv) = (g.get(f), w.get(f));
                // An absent render field vs an explicit null in the fixture is
                // the same claim.
                let norm = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
                if norm(gv) != norm(wv) {
                    failures.push(format!(
                        "{name}: segment {i} differs on {f}: lean {} vs blessed {}",
                        norm(gv),
                        norm(wv)
                    ));
                }
            }
        }
    }

    eprintln!(
        "{} decoded day(s) replayed, {} failure(s)",
        names.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
