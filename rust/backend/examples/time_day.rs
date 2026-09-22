//! Where does a golden day's replay actually spend its time? (gate work)
//!
//! ⚠ MEASURES, ASSERTS NOTHING. The gate's biggest row is one test wide, and
//! the explanations offered for it — JSON parsing, test-level parallelism —
//! were guesses. This times the phases so the next change is aimed at a number.
//!
//! ⚠ USES ONLY THE PUBLIC API. An earlier draft reached into `build_day_request`
//! and `AnswerTables` for a finer split and had to make them `pub` to compile.
//! Widening a crate's surface to hold a stopwatch is the wrong trade: the split
//! below is coarser and costs nothing to keep.
//!
//! ⚠ **IT ALSO PRINTS RSS PER PHASE**, because the fold's memory is now the
//! user-visible fault and its time is not (#1071): `health-auth`'s container
//! limit is 512Mi and a day's replay peaks at 614 MiB, so opening a historical
//! day OOM-kills the serving pod and the app 502s. The split below is what says
//! whether the bytes are Rust's or Lean's — 614-vs-466 between a heavy and a
//! light day says nothing about which side holds them.
//!
//! ⚠ RSS is read by shelling out to `ps`, which is crude and right for an
//! example: it is the SAME number the kernel's OOM killer acts on, where an
//! allocator's own accounting is not.
//!
//! ```text
//! cargo run --release --example time_day -- 2026-05-14-pippijn
//! ```

use anyhow::{Context, Result};
use backend::lean;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::Value;
use std::time::Instant;

/// Resident set size of this process (MiB), or 0 if `ps` cannot say.
///
/// ⚠ RESIDENT, not allocated. The OOM killer counts pages the process is
/// holding, so that is what a limit has to be compared against.
fn rss_mib() -> u64 {
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map_or(0, |kib| kib / 1024)
}

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// Price ONE `lean::serve` on a pre-dumped request, from a COLD process.
///
/// ⚠ **Cold is the whole point.** Inside a normal run the allocator already
/// holds an arena from earlier rounds, so a later call shows a +0 RSS delta and
/// says nothing about what a round costs. This reads bytes, calls once, and
/// stops.
///
/// `mode=day` prices parse + fold. Any other mode prices the PARSE ALONE:
/// `serveDispatchExport` runs `Json.parse` over the whole input before it looks
/// at `mode`, so an unknown one parses everything and folds nothing. The
/// difference between the two is what the ALGORITHM costs, as opposed to what
/// carrying the request costs.
///
/// ```text
/// cargo run --release --example time_day -- --serve-only /tmp/req.json day
/// cargo run --release --example time_day -- --serve-only /tmp/req.json nosuchmode
/// ```
fn serve_only(path: &str, mode: &str) -> Result<()> {
    let rss0 = rss_mib();
    let body = std::fs::read_to_string(path).context("reading the request")?;
    let wrapped = format!("{{\"mode\":\"{mode}\",{}", &body[1..]);
    let rss1 = rss_mib();
    let t = Instant::now();
    let reply = lean::serve(&wrapped).context("the one call")?;
    let ms = t.elapsed().as_millis();
    let rss2 = rss_mib();
    println!("request           {:>11} bytes", wrapped.len());
    println!("mode              {mode}");
    println!("RSS before        {rss0:>8} MiB");
    println!("RSS with bytes    {rss1:>8} MiB   (+{})", rss1 - rss0);
    println!(
        "RSS after serve   {rss2:>8} MiB   (+{})   in {ms} ms",
        rss2 - rss1
    );
    println!("reply             {:>11} bytes", reply.len());
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--serve-only") {
        let (Some(path), Some(mode)) = (args.get(2), args.get(3)) else {
            eprintln!("usage: time_day --serve-only <request.json> <mode>");
            std::process::exit(64);
        };
        return serve_only(path, mode);
    }
    // ⚠ SEVERAL FOLDS IN ONE PROCESS — the question the pod's OOM turns on.
    // If the allocator REUSES its arena, RSS plateaus and a second day is free;
    // if it ACCUMULATES, each fold adds and the second one is what dies. One
    // fold in isolation cannot tell those apart, and predicting it from a
    // single fold is how this was got wrong once already.
    if args.get(1).is_some_and(|a| a == "--serve-many") {
        let rss0 = rss_mib();
        println!("RSS cold          {rss0:>8} MiB");
        for (i, path) in args[2..].iter().enumerate() {
            let body = std::fs::read_to_string(path).context("reading the request")?;
            let wrapped = format!("{{\"mode\":\"day\",{}", &body[1..]);
            let before = rss_mib();
            let t = Instant::now();
            let _ = lean::serve(&wrapped).context("fold")?;
            let ms = t.elapsed().as_millis();
            let after = rss_mib();
            println!(
                "fold {:>2}  {:>28}   RSS {before:>4} -> {after:>4} MiB  (+{})  {ms} ms",
                i + 1,
                path.rsplit('/').next().unwrap_or(path),
                after.saturating_sub(before)
            );
        }
        return Ok(());
    }
    let name = std::env::args().nth(1).unwrap_or_default();
    if name.is_empty() {
        eprintln!("usage: cargo run --example time_day -- <YYYY-MM-DD-user>");
        std::process::exit(64);
    }
    let path = format!("{GOLDEN}/{name}.json");
    if !std::path::Path::new(&path).exists() {
        eprintln!("no corpus at {path}");
        std::process::exit(2);
    }

    let t = Instant::now();
    let text = std::fs::read_to_string(&path).context("reading the fixture")?;
    let read_ms = t.elapsed().as_millis();
    let bytes = text.len();

    let rss_read = rss_mib();
    let t = Instant::now();
    let fx: Value = serde_json::from_str(&text).context("parsing the fixture")?;
    let parse_ms = t.elapsed().as_millis();
    let rss_parse = rss_mib();

    let inputs = &fx["inputs"];
    let (date, user) = (&name[..10], &name[11..]);
    let rows = inputs.get("osmRowSet").context("no osmRowSet")?;

    let t = Instant::now();
    let cap = backend::head::capture(inputs, date, user).context("capture")?;
    let capture_ms = t.elapsed().as_millis();
    let rss_capture = rss_mib();

    let t = Instant::now();
    let rows_answerer = RowSetAnswerer::new(rows).context("opening the row set")?;
    let answerer_ms = t.elapsed().as_millis();
    // ⚠ SAMPLED, because it is not free and the phase table hid it: the row set
    // is the fixture's `osmRowSet` (tens of thousands of lines), and indexing it
    // is a gate cost (#1654), not a pod one — production answers from the mirror.
    let rss_answerer = rss_mib();

    // The recorded trace: the matcher reads and the seven answerer tables as
    // the day was blessed on. Without it the three matcher reads decline and
    // `annotateWalkMatches` bails per leg, so the phase table would describe a
    // fold whose largest consumer never ran (#1071).
    let t = Instant::now();
    let trace = backend::osm_trace::TraceAnswerer::from_fixture(
        &fx,
        &path,
        backend::osm_trace::Sections::ALL,
    )
    .map_err(|e| anyhow::anyhow!("osm trace: {e}"))?;
    let trace_ms = t.elapsed().as_millis();
    let rss_trace = rss_mib();

    let t = Instant::now();
    let mut answerer = backend::lean::Chain(&trace, rows_answerer);
    let folded = backend::fold::run_day(&cap, inputs, &mut answerer).context("fold")?;
    let fold_ms = t.elapsed().as_millis();
    let rss_fold = rss_mib();

    // One more call on the same request with every ask declined, to price the
    // fold apart from the answers it waits for.
    let body = serde_json::to_string(&folded.request)?;
    let wrapped = format!("{{\"mode\":\"day\",{}", &body[1..]);
    let t = Instant::now();
    let _ = lean::serve(&wrapped).context("one unanswered fold")?;
    let bare_fold_ms = t.elapsed().as_millis();

    let (osm_hits, osm_misses) = folded.osm_counts();
    println!("day {name}");
    println!("  fixture            {bytes:>11} bytes");
    println!("  read               {read_ms:>8} ms");
    println!("  parse              {parse_ms:>8} ms");
    println!("  head::capture      {capture_ms:>8} ms   (one lean::serve inside)");
    println!("  RowSetAnswerer     {answerer_ms:>8} ms");
    println!("  trace index        {trace_ms:>8} ms");
    println!(
        "  fold               {fold_ms:>8} ms   {} ask(s), {} declined",
        folded.asks.len(),
        folded.declined().len()
    );
    println!("  ---");
    println!("  request            {:>11} bytes", wrapped.len());
    println!(
        "  fold, all declined {bare_fold_ms:>8} ms   (parse + fold + emit, no waiting on answers)"
    );
    println!("  ---");
    println!("  RSS after read     {rss_read:>8} MiB   (Rust: the fixture text)");
    println!("  RSS after parse    {rss_parse:>8} MiB   (Rust: + the serde tree)");
    println!("  RSS after capture  {rss_capture:>8} MiB   (+ ONE lean::serve)");
    println!(
        "  RSS after row set  {rss_answerer:>8} MiB   (Rust: the fixture's osmRowSet index — GATE ONLY)"
    );
    println!("  RSS after trace    {rss_trace:>8} MiB   (the recorded answers, indexed)");
    println!(
        "  RSS after fold     {rss_fold:>8} MiB   (this process; the fold ran in verified_cli)"
    );
    println!("  ---");
    println!(
        "  matcher reads      {:>8} asked, {osm_misses} declined",
        osm_hits + osm_misses
    );
    if osm_hits + osm_misses > 0 && osm_hits == 0 {
        println!(
            "  ⚠ EVERY matcher read was DECLINED — the walk and road matchers did not run, so\n\
             \x20   the numbers above are a fold with its largest consumer switched off."
        );
    }
    println!("  ⚠ health-auth's container limit is 512 MiB.");
    Ok(())
}
