//! A remembered walk is the drawn walk (#1921).
//!
//! The fold keys each walk's drawn result by a hash of what the drawing reads
//! and, on a later fold, takes it from the host instead of drawing it. That is
//! only correct if the key misses nothing the drawing reads. Here a day is
//! replayed twice through an in-memory store: the first replay draws every walk
//! and hands each result over, the second takes every walk from the store. The
//! two days must be identical, and the second must actually have skipped the
//! drawing — otherwise the test would pass on a store nobody read.
//!
//! The days are the golden fixtures, which live only on the machine that
//! captures them; without them this says so and checks nothing.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// The fixture for `date`, whoever's day it is: `<date>-<user>.json`.
fn fixture(date: &str) -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden/days");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{date}-")) && n.ends_with(".json"))
        })
}

/// The day as `backend day` replays it, and its walk-drawing time.
fn replay(path: &Path) -> (Value, u64) {
    let day = path
        .file_stem()
        .and_then(|s| s.to_str())
        .expect("a fixture name");
    let text = std::fs::read_to_string(path).expect("reading the fixture");
    let parsed: Value = serde_json::from_str(&text).expect("parsing the fixture");
    let inputs = parsed.get("inputs").expect("inputs");
    let cap = backend::head::capture(inputs, &day[..10], &day[11..]).expect("capture");
    let rows = inputs.get("osmRowSet").expect("osmRowSet");
    let trace = backend::osm_trace::TraceAnswerer::from_fixture(
        &parsed,
        path.to_str().unwrap(),
        backend::osm_trace::Sections::ALL,
    )
    .expect("trace");
    let mut answerer = backend::lean::Chain(
        trace,
        backend::rowset_answerer::RowSetAnswerer::new(rows).expect("rows"),
    );
    let r = backend::fold::run_day(&cap, inputs, &mut answerer).expect("the fold");
    let mut out: Value = serde_json::from_str(&r.out).expect("the fold's answer");
    let walk_ms = out
        .get("leanTiming")
        .and_then(|t| t.get("pass.walkMatch"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    // Timing is the one thing that is meant to differ.
    if let Some(o) = out.as_object_mut() {
        o.remove("leanTiming");
    }
    (out, walk_ms)
}

#[test]
fn a_remembered_walk_is_the_drawn_walk() {
    let dates = ["2026-10-03", "2026-09-30", "2026-07-16"];
    let paths: Vec<PathBuf> = dates.iter().filter_map(|d| fixture(d)).collect();
    if paths.len() != dates.len() {
        eprintln!("walk memo: the golden fixtures are not here — nothing checked");
        return;
    }
    backend::walk_memo::init_in_memory();
    for (day, path) in dates.iter().zip(&paths) {
        backend::walk_memo::take_mem_stats();
        let (drawn, drawn_ms) = replay(path);
        let first = backend::walk_memo::take_mem_stats();
        let (remembered, remembered_ms) = replay(path);
        let second = backend::walk_memo::take_mem_stats();
        assert!(
            drawn == remembered,
            "{day}: the day with remembered walks differs from the day that drew them"
        );
        // The store was READ, counted rather than timed: the first replay
        // missed every walk and offered each; the second was served every
        // one and offered none.
        assert!(
            first.puts > 0 && first.served == 0 && first.missed == first.puts,
            "{day}: the first replay should draw and offer every walk, got {first:?}"
        );
        assert!(
            second.served == first.puts && second.missed == 0 && second.puts == 0,
            "{day}: the second replay should be served every walk it drew, got {second:?}"
        );
        eprintln!(
            "walk memo {day}: {} walk(s) drawn in {drawn_ms} ms, remembered in {remembered_ms} ms",
            first.puts
        );
    }
}
