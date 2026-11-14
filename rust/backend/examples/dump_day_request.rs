//! Dump the fold request for one golden day, as the fold receives it.
//!
//! An example, not a `backend` verb: a production CLI should not read test
//! fixtures, and examples stay out of the image.
//!
//! ```text
//! cargo run --example dump_day_request -- 2026-05-14-$USER > /tmp/req.json
//! ```
//!
//! Exits 2 when the corpus (gitignored real data) is absent, so a caller can
//! tell that from a day that failed to build.

use anyhow::{Context, Result};
use backend::osm_trace::{Sections, TraceAnswerer};
use backend::rowset_answerer::RowSetAnswerer;

/// Print the day request a golden day builds.
#[derive(clap::Parser)]
struct Args {
    /// a golden day's stem, YYYY-MM-DD-user
    name: String,
}

fn main() -> Result<()> {
    let Args { name } = backend::argv::parse_or_exit();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    let path = format!("{root}/{name}.json");

    // Exit 2: the corpus is absent off this machine, which is not a failure.
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("dump_day_request: no golden day at {path}");
        std::process::exit(2);
    };

    let fx: serde_json::Value = serde_json::from_str(&text).context("the fixture parses")?;
    let inputs = &fx["inputs"];
    let (date, user) = (&name[..10], name[11..].to_string());
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;

    backend::lean::init()?;
    let cap = backend::head::capture(inputs, date, &user).context("head::capture")?;
    let trace =
        TraceAnswerer::from_fixture(&fx, &path, Sections::ALL).map_err(|e| anyhow::anyhow!(e))?;
    let mut answerer = backend::lean::Chain(
        trace,
        RowSetAnswerer::new(rows).context("the row set opens")?,
    );
    let converged =
        backend::fold::run_day(&cap, inputs, &mut answerer).context("folding the day")?;

    // A day whose fold had declined asks is refused: it would still produce a
    // request. Three tables decline on purpose, as in `tests/corpus/day.rs`:
    // `reverseGeocode` (Nominatim), `transitStops` (injected), and
    // `nearbyLandmarks` (declined where the row set cannot vouch).
    const DECLINED_ON_PURPOSE: [&str; 3] = ["reverseGeocode", "nearbyLandmarks", "transitStops"];
    let declined = converged.declined();
    let real_gaps: Vec<&backend::lean::Ask> = declined
        .iter()
        .filter(|m| !DECLINED_ON_PURPOSE.contains(&m.what.as_str()))
        // `bestPlace` with an empty coordinate key is the same deliberate decline.
        .filter(|m| !(m.what == "bestPlace" && m.key.ends_with('|')))
        .collect();
    if !real_gaps.is_empty() {
        for m in &real_gaps {
            eprintln!("dump_day_request: declined {}({})", m.what, m.key);
        }
        eprintln!("dump_day_request: this day is not a usable sentinel");
        std::process::exit(1);
    }
    println!("{}", serde_json::to_string(&converged.request)?);
    Ok(())
}
