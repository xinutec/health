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
use backend::fold_converge::converge;
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
    let mut answerer = RowSetAnswerer::new(rows).context("opening the row set")?;
    let answerer_ms = t.elapsed().as_millis();

    let t = Instant::now();
    let conv = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer).context("converge")?;
    let converge_ms = t.elapsed().as_millis();
    let rss_converge = rss_mib();

    // The final round's request is what every round approximates: earlier ones
    // carry fewer answer tables, so this is the UPPER bound on per-round size.
    let body = serde_json::to_string(&conv.request)?;
    let t = Instant::now();
    let wrapped = format!("{{\"mode\":\"day\",{}", &body[1..]);
    let wrap_ms = t.elapsed().as_millis();

    // One more call on the settled request, to price a single fold apart from
    // the loop around it.
    let t = Instant::now();
    let _ = lean::serve(&wrapped).context("one settled fold")?;
    let one_fold_ms = t.elapsed().as_millis();
    let rss_fold = rss_mib();

    println!("day {name}");
    println!("  fixture            {bytes:>11} bytes");
    println!("  read               {read_ms:>8} ms");
    println!("  parse              {parse_ms:>8} ms");
    println!("  head::capture      {capture_ms:>8} ms   (one lean::serve inside)");
    println!("  RowSetAnswerer     {answerer_ms:>8} ms");
    println!(
        "  converge           {converge_ms:>8} ms   over {} rounds",
        conv.rounds
    );
    println!("  ---");
    println!("  final request      {:>11} bytes", wrapped.len());
    println!("  prepend-mode copy  {wrap_ms:>8} ms   (a full copy of the above)");
    println!("  ONE settled fold   {one_fold_ms:>8} ms   (parse + fold + emit, in Lean)");
    println!(
        "  => {} rounds x ~{} ms is {} ms of the {} ms converge",
        conv.rounds,
        one_fold_ms,
        conv.rounds as u128 * one_fold_ms,
        converge_ms
    );
    println!("  ---");
    println!("  RSS after read     {rss_read:>8} MiB   (Rust: the fixture text)");
    println!("  RSS after parse    {rss_parse:>8} MiB   (Rust: + the serde tree)");
    println!("  RSS after capture  {rss_capture:>8} MiB   (+ ONE lean::serve)");
    println!(
        "  RSS after converge {rss_converge:>8} MiB   (+ {} rounds)",
        conv.rounds
    );
    println!("  RSS after one fold {rss_fold:>8} MiB   (+ one more)");
    println!("  ⚠ health-auth's container limit is 512 MiB.");
    Ok(())
}
