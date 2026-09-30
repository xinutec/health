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

/// How many ways the decoded days are split (2026-09-30, #1654). This test
/// decoded its days one after another and was the SLOWEST test of the deploy
/// gate's corpus row (~140 s against 50–85 s for the fold shards beside it), so
/// it alone set that row's wall. Days are independent and each decode holds
/// its own model; by index modulo, like `corpus_gate`'s shards.
const SHARDS: usize = 4;

#[test]
fn every_frozen_decode_still_decodes_a() {
    on_big_stack(0);
}

#[test]
fn every_frozen_decode_still_decodes_b() {
    on_big_stack(1);
}

#[test]
fn every_frozen_decode_still_decodes_c() {
    on_big_stack(2);
}

#[test]
fn every_frozen_decode_still_decodes_d() {
    on_big_stack(3);
}

fn on_big_stack(shard: usize) {
    // ⚠ The trellis decode of a full 1440-minute day overflows the 2 MiB
    // default test-thread stack; production decodes on the binary's main
    // thread. Same work, roomier stack.
    std::thread::Builder::new()
        .name(format!("hsmm-decode-corpus-{shard}"))
        .stack_size(256 * 1024 * 1024)
        .spawn(move || run_corpus(shard))
        .expect("spawn")
        .join()
        .expect("the corpus thread must not panic");
}

fn run_corpus(shard: usize) {
    let Some(names) = backend::decode_fixture::fixture_names().expect("corpus dir readable") else {
        eprintln!(
            "SKIPPED: no golden corpus at {}; see this file's header.",
            backend::decode_fixture::corpus_dir().display()
        );
        return;
    };
    assert!(!names.is_empty(), "the decoded corpus is empty");
    let names: Vec<String> = names
        .into_iter()
        .enumerate()
        .filter(|(i, _)| i % SHARDS == shard)
        .map(|(_, n)| n)
        .collect();

    let mut failures: Vec<String> = Vec::new();
    for name in &names {
        let fx: Value = backend::decode_fixture::read(name).expect("fixture parses");
        let req = backend::decode_fixture::request(&fx).unwrap_or_else(|e| panic!("{name}: {e:#}"));
        // `DECODE_REQUEST_OUT=<dir>`: the request itself, one file per day —
        // what `verified_cli decodetrace` reads by hand (2026-09-29, #238).
        if let Ok(dir) = std::env::var("DECODE_REQUEST_OUT") {
            std::fs::write(
                std::path::Path::new(&dir).join(name),
                serde_json::to_vec(&req).expect("request serialises"),
            )
            .expect("DECODE_REQUEST_OUT writes");
        }

        let Some(segments) = backend::lean::assemble_segments(&req).expect("assemble answers")
        else {
            failures.push(format!("{name}: the decode is DEGENERATE — no viable path"));
            continue;
        };
        let got = backend::row_json::render_segments(&segments).expect("segments render");
        let got = got.as_array().cloned().unwrap_or_default();
        // `DECODE_BLESS=1`: the fixture's `expected` becomes TODAY'S decode, the
        // compared fields only — for landing a decoder change the scoreboard's
        // live arm has already judged (#366). Tab-indented like the capture.
        // `DECODE_DUMP_OUT=<path>`: the Lean decode per day, one JSON line each,
        // APPENDED — for laying an arm's segments against the narrative without
        // blessing anything (2026-09-29, #366).
        if let Ok(path) = std::env::var("DECODE_DUMP_OUT") {
            use std::io::Write;
            let line = format!("{}\n", serde_json::json!({ "name": name, "segments": got }));
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .expect("DECODE_DUMP_OUT opens")
                .write_all(line.as_bytes())
                .expect("DECODE_DUMP_OUT writes");
        }
        if std::env::var("DECODE_BLESS").is_ok() {
            let mut fx = fx.clone();
            fx["expected"] = Value::Array(
                got.iter()
                    .map(|g| {
                        let mut o = serde_json::Map::new();
                        for f in [
                            "startTs",
                            "endTs",
                            "mode",
                            "placeId",
                            "lineName",
                            "boardStation",
                            "alightStation",
                        ] {
                            // `placeId` and `lineName` are written even when null: the
                            // frozen fixtures carry them explicitly.
                            if let Some(v) = g.get(f)
                                && (!v.is_null() || f == "placeId" || f == "lineName")
                            {
                                o.insert(f.into(), v.clone());
                            }
                        }
                        Value::Object(o)
                    })
                    .collect(),
            );
            let mut buf = Vec::new();
            let fmt = serde_json::ser::PrettyFormatter::with_indent(b"\t");
            let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
            serde::Serialize::serialize(&fx, &mut ser).expect("the fixture serialises");
            buf.push(b'\n');
            std::fs::write(backend::decode_fixture::corpus_dir().join(name), buf)
                .expect("the fixture is writable");
            eprintln!(
                "BLESSED  {name}: expected rewritten from the Lean decode ({} segments)",
                got.len()
            );
            continue;
        }
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
        "shard {shard}/{SHARDS}: {} decoded day(s) replayed, {} failure(s)",
        names.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
