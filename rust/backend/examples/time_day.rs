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
//! ```text
//! cargo run --release --example time_day -- 2026-05-14-pippijn
//! ```

use anyhow::{Context, Result};
use backend::fold_converge::converge;
use backend::lean;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::Value;
use std::time::Instant;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

fn main() -> Result<()> {
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

    let t = Instant::now();
    let fx: Value = serde_json::from_str(&text).context("parsing the fixture")?;
    let parse_ms = t.elapsed().as_millis();

    let inputs = &fx["inputs"];
    let (date, user) = (&name[..10], &name[11..]);
    let rows = inputs.get("osmRowSet").context("no osmRowSet")?;

    let t = Instant::now();
    let cap = backend::head::capture(inputs, date, user).context("capture")?;
    let capture_ms = t.elapsed().as_millis();

    let t = Instant::now();
    let mut answerer = RowSetAnswerer::new(rows).context("opening the row set")?;
    let answerer_ms = t.elapsed().as_millis();

    let t = Instant::now();
    let conv = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer).context("converge")?;
    let converge_ms = t.elapsed().as_millis();

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
    Ok(())
}
