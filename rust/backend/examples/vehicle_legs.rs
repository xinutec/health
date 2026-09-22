//! Every vehicle leg the corpus produces, both failure directions at once (#328).
//!
//! ⚠ WHY THIS EXISTS: the bus/driving discriminator fails in BOTH directions —
//! a taxi promoted to `bus`, and a real bus left as `driving` — and the whole
//! population is twelve legs. A threshold moved to fix either direction moves
//! the other, so the ticket's standing instruction is to measure both whenever
//! it is touched. The table that established that was taken ad hoc on
//! 2026-09-11 and not preserved, so the baseline could not be reproduced when
//! the bus mirror's coverage came off the floor and the verdicts moved. This is
//! that table, kept.
//!
//! ⚠ IT LOADS THE OSM TRACE, and that is not optional. Without one the three
//! `@[extern]` callbacks answer empty and the road matcher bails per leg, so
//! every vehicle leg comes back unnamed and the route half of the question
//! cannot be asked at all (#1071, #1418).
//!
//! ⚠ **A FIXTURE REPLAY IS NOT THE LIVE ANSWER.** The golden day carries a
//! FROZEN `busRouteCache`, so this reports the discriminator against the route
//! coverage captured with the day, not today's. When the two disagree, that is
//! the cache, not the model — re-derive live with
//! `backend velocity <user> <date>` before concluding anything about the rule.
//!
//! An EXAMPLE, not a `bin/backend` verb, for `dump_day_request`'s reason: it
//! reads the gitignored golden corpus.
//!
//! ```text
//! cargo run --release --example vehicle_legs               # every golden day
//! cargo run --release --example vehicle_legs -- 2026-06-16-pippijn
//! ```
//!
//! Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::Value;

/// ⚠ The fold's own reply calls it `segs`. `segments` is `routes::velocity`'s
/// RENAME for the client, and reading that name here returned an empty array
/// and printed "0 ride leg(s)" over a day that has them — a reader fault that
/// looks exactly like a corpus with nothing in it.
const SEGS: &str = "segs";

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// The modes a ride can carry. `train` is here so a leg that MOVED between
/// classes is visible rather than silently leaving the table — the 06-15 bus
/// leg became a train leg between two readings of #328, and a filter on
/// `bus|driving` alone reports that as a disappearance.
const RIDE: [&str; 5] = ["bus", "driving", "train", "tram", "ferry"];

fn hhmm(ts: i64) -> String {
    let (h, m) = ((ts % 86400) / 3600, (ts % 3600) / 60);
    format!("{h:02}:{m:02}")
}

fn one(name: &str) -> Result<usize> {
    let path = format!("{GOLDEN}/{name}");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(0);
    };
    let fx: Value = serde_json::from_str(&text).context("parsing the fixture")?;
    let inputs = &fx["inputs"];
    let date = &name[..10];
    let user = name[11..].trim_end_matches(".json");

    let cap = backend::head::capture(inputs, date, user).context("capture")?;
    let rows = inputs.get("osmRowSet").context("no osmRowSet")?;
    let rows = RowSetAnswerer::new(rows).context("row set")?;
    // ⚠ A FIXTURE WITHOUT TRACE SECTIONS IS UNMEASURED, NOT ZERO, and it must
    // not take the table down with it: some captures predate the sections
    // (2026-08-12), which is a corpus gap rather than a product defect. Saying
    // so per day keeps the population honest — twelve legs is the whole of it,
    // and a day silently missing from the denominator is how a bar gets tuned
    // on less than it claims.
    let trace = match backend::osm_trace::TraceAnswerer::from_fixture(
        &fx,
        &path,
        backend::osm_trace::Sections::ALL,
    ) {
        Ok(t) if t.has_walk_capture() => t,
        Ok(_) => {
            println!("{date}  UNMEASURED — no walk reads captured");
            return Ok(0);
        }
        Err(e) => {
            println!("{date}  UNMEASURED — {e}");
            return Ok(0);
        }
    };
    let mut answerer = backend::lean::Chain(trace, rows);
    let conv = backend::fold::run_day(&cap, inputs, &mut answerer).context("fold")?;
    let out: Value = serde_json::from_str(&conv.out).context("the fold reply")?;

    if std::env::var_os("ALL_MODES").is_some() {
        let mut seen: Vec<&str> = out[SEGS]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["mode"].as_str())
            .collect();
        seen.sort_unstable();
        seen.dedup();
        eprintln!(
            "{date}: {} segment(s), modes {seen:?}",
            out[SEGS].as_array().map_or(0, Vec::len)
        );
    }
    let mut n = 0;
    for s in out[SEGS].as_array().into_iter().flatten() {
        let mode = s["mode"].as_str().unwrap_or("");
        if !RIDE.contains(&mode) {
            continue;
        }
        let (a, b) = (
            s["startTs"].as_i64().unwrap_or(0),
            s["endTs"].as_i64().unwrap_or(0),
        );
        // ⚠ `vehicleKind` and `mode` are DIFFERENT ANSWERS and the ticket turns
        // on their disagreeing: 06-16's real bus reads mode `driving` while
        // carrying kind `bus` and the right route. Print both, always.
        println!(
            "{date}  {:>7}  {:>5.1}m  {}-{}  kind={:<8} way={:<46} refined={}",
            mode,
            (b - a) as f64 / 60.0,
            hhmm(a),
            hhmm(b),
            s["vehicleKind"].as_str().unwrap_or("-"),
            format!("{:?}", s["wayName"].as_str().unwrap_or("-")),
            s["refinedMode"].as_str().unwrap_or("-"),
        );
        n += 1;
    }
    Ok(n)
}

fn main() -> Result<()> {
    if !std::path::Path::new(GOLDEN).exists() {
        eprintln!("vehicle_legs: no corpus at {GOLDEN}");
        std::process::exit(2);
    }
    let arg = std::env::args().nth(1);
    let mut names: Vec<String> = match &arg {
        Some(a) => vec![if a.ends_with(".json") {
            a.clone()
        } else {
            format!("{a}.json")
        }],
        None => std::fs::read_dir(GOLDEN)?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|f| f.ends_with(".json"))
            .collect(),
    };
    names.sort();

    let mut total = 0;
    for name in &names {
        total += one(name).with_context(|| name.clone())?;
    }

    // ⚠ The COUNT is part of the reading. Twelve legs is the whole population,
    // so a table that silently shrank is a segmentation change, not a quieter
    // corpus — and it invalidates any bar tuned on the previous one.
    println!("\n{total} ride leg(s) across {} day(s)", names.len());
    Ok(())
}
