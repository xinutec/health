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

/// How many ways the decoded days are split. This test
/// decoded its days one after another and was the SLOWEST test of the deploy
/// gate's corpus row (~140 s against 50–85 s for the fold shards beside it), so
/// it alone set that row's wall. Days are independent and each decode holds
/// its own model; by index modulo, like `corpus_gate`'s shards. Eight since the
/// corpus grew from 11 days to 43: four shards took 66 s.
const SHARDS: usize = 8;

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

#[test]
fn every_frozen_decode_still_decodes_e() {
    on_big_stack(4);
}

#[test]
fn every_frozen_decode_still_decodes_f() {
    on_big_stack(5);
}

#[test]
fn every_frozen_decode_still_decodes_g() {
    on_big_stack(6);
}

#[test]
fn every_frozen_decode_still_decodes_h() {
    on_big_stack(7);
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
        // what `verified_cli decodetrace` reads by hand.
        if let Ok(dir) = std::env::var("DECODE_REQUEST_OUT") {
            std::fs::write(
                std::path::Path::new(&dir).join(name),
                serde_json::to_vec(&req).expect("request serialises"),
            )
            .expect("DECODE_REQUEST_OUT writes");
        }

        let Some(answer) = backend::lean::assemble_response(&req).expect("assemble answers") else {
            failures.push(format!("{name}: the decode is DEGENERATE — no viable path"));
            continue;
        };
        // The journey bound (`segEmission.journey.maxJ`) sizes the inner
        // sweep's tables; it is not a behaviour, so it must never bind. A
        // decoded journey as long as the bound would be one scored in pieces.
        if let (Some(longest), Some(max_j)) = (
            answer["longestJourneyMin"].as_u64(),
            req["flags"]["segEmission"]["journey"]["maxJ"].as_u64(),
        ) && longest >= max_j
        {
            failures.push(format!(
                "{name}: the journey bound binds — a decoded journey of {longest} min at maxJ {max_j}"
            ));
        }
        let segments = answer["segments"].clone();
        let got = backend::row_json::render_segments(&segments).expect("segments render");
        let got = got.as_array().cloned().unwrap_or_default();
        // `DECODE_BLESS=1`: the fixture's `expected` becomes TODAY'S decode, the
        // rendered row whole — the row `save_decode` stores and the served fold
        // heads with, so `boardTs` and whatever else Lean grows reach the
        // corpus gate as they reach production; the comparison below reads the
        // named fields only. For landing a decoder change the scoreboard's
        // live arm has already judged. Tab-indented like the capture.
        // `DECODE_DUMP_OUT=<path>`: the Lean decode per day, one JSON line each,
        // APPENDED — for laying an arm's segments against the narrative without
        // blessing anything.
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
            fx["expected"] = Value::Array(got.clone());
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
        failures.extend(segment_diffs(name, &got, &want));
    }

    eprintln!(
        "shard {shard}/{SHARDS}: {} decoded day(s) replayed, {} failure(s)",
        names.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// Where `got` differs from the fixture's `expected`, on the fields it stores.
fn segment_diffs(name: &str, got: &[Value], want: &[Value]) -> Vec<String> {
    if got.len() != want.len() {
        return vec![format!(
            "{name}: {} segments vs {} expected",
            got.len(),
            want.len()
        )];
    }
    let mut out = Vec::new();
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
            // An absent render field vs an explicit null in the fixture is
            // the same claim.
            let norm = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
            let (gv, wv) = (norm(g.get(f)), norm(w.get(f)));
            if gv != wv {
                out.push(format!(
                    "{name}: segment {i} differs on {f}: lean {gv} vs blessed {wv}"
                ));
            }
        }
    }
    out
}

/// The days the incremental decode is replayed on, and the minutes each is cut
/// at: a day's request with every reading from the cut on removed, then the
/// whole request, through one worker in `assemblesegmentsinc`. The second
/// answer must be the frozen decode; at least one of a test's runs must have
/// reused (a frontier, not `full`), or the test proves nothing.
const INC_CUTS: [usize; 1] = [1320];
const INC_EVERY: usize = 16;

#[test]
fn an_incremental_decode_is_the_frozen_decode_a() {
    incremental_corpus(0);
}

#[test]
fn an_incremental_decode_is_the_frozen_decode_b() {
    incremental_corpus(1);
}

#[test]
fn an_incremental_decode_is_the_frozen_decode_c() {
    incremental_corpus(2);
}

#[test]
fn an_incremental_decode_is_the_frozen_decode_d() {
    incremental_corpus(3);
}

/// `req` as it stood before minute `cut`: no fix, heart rate, step or
/// proximity row from then on.
fn cut_request(req: &Value, cut: usize) -> Value {
    let mut r = req.clone();
    let start = r["observation"]["startUtc"].as_i64().expect("startUtc");
    let cut_ts = start + (cut as i64) * 60;
    for k in ["points", "hr", "steps"] {
        if let Some(a) = r["observation"][k].as_array_mut() {
            a.retain(|x| x["ts"].as_i64().is_some_and(|t| t < cut_ts));
        }
    }
    if let Some(a) = r["observation"]["proximity"].as_array_mut() {
        a.retain(|x| x[0].as_i64().is_some_and(|t| t < cut_ts));
    }
    r
}

fn incremental_corpus(part: usize) {
    use std::io::{BufRead, BufReader, Write};
    let Some(names) = backend::decode_fixture::fixture_names().expect("corpus dir readable") else {
        eprintln!("SKIPPED: no golden corpus");
        return;
    };
    let names: Vec<String> = names
        .into_iter()
        .enumerate()
        .filter(|(i, _)| i % INC_EVERY == part)
        .map(|(_, n)| n)
        .collect();
    let cli = backend::lean_worker::verified_cli_path().expect("verified_cli");
    let mut child = std::process::Command::new(cli)
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("verified_cli serve spawns");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut ask = |req: &Value| -> Value {
        writeln!(stdin, "{req}").expect("the worker reads");
        stdin.flush().expect("flush");
        let line = lines.next().expect("the worker answers").expect("a line");
        let v: Value = serde_json::from_str(&line).expect("the answer parses");
        v["result"].clone()
    };
    let (mut failures, mut reused) = (Vec::new(), 0usize);
    for name in &names {
        let fx: Value = backend::decode_fixture::read(name).expect("fixture parses");
        let req = backend::decode_fixture::request(&fx).unwrap_or_else(|e| panic!("{name}: {e:#}"));
        let want = fx["expected"].as_array().expect("expected").clone();
        for cut in INC_CUTS {
            let key = format!("test|{name}|{cut}");
            let mut a = cut_request(&req, cut);
            a["mode"] = "assemblesegmentsinc".into();
            a["todayKey"] = key.clone().into();
            let mut b = req.clone();
            b["mode"] = "assemblesegmentsinc".into();
            b["todayKey"] = key.into();
            ask(&a);
            let answer = ask(&b);
            if let Some(e) = answer.get("error") {
                failures.push(format!("{name} cut {cut}: {e}"));
                continue;
            }
            let inc = &answer["incremental"];
            if inc.get("frontier").is_some() {
                reused += 1;
            }
            eprintln!("{name} cut {cut}: {inc}");
            let got =
                backend::row_json::render_segments(&answer["segments"]).expect("segments render");
            let got = got.as_array().cloned().unwrap_or_default();
            failures.extend(segment_diffs(&format!("{name} cut {cut}"), &got, &want));
        }
    }
    drop(stdin);
    let _ = child.wait();
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert!(
        names.is_empty() || reused > 0,
        "no run reused a frontier over {} day(s): the incremental path went untested",
        names.len()
    );
}
