//! WHICH consumer asks the reverseGeocode keys a day cannot answer? (#1076)
//!
//! ⚠ WHY: #1076 is written as "only the AREA NAME needs the client", and the
//! corpus says otherwise. `reverseGeocode` has three consumers and they are not
//! the same size:
//!
//! ```text
//!   Enrich.extractCity   zoom 16, snapped to the 1e-3 cityGrid  — the CITY of a leg
//!   BestPlace AREA_ZOOM  zoom 16, unsnapped                     — the area name
//!   BestPlace DETAIL     zoom 18                                — the venue namer
//! ```
//!
//! The grid snap is what tells the first two apart, and it is reliable: the city
//! lookup rounds to ~110 m (`Enrich.cityGrid`) precisely so habitual endpoints
//! share a cell, while a stay centroid never lands on that grid by accident.
//!
//! ⚠ **THE TWO KEY FORMATS ARE NOT INTERCHANGEABLE, and reading one as the other
//! silently mis-bins everything.** A golden fixture's `osmTrace.reverseGeocode`
//! is keyed in PLAIN DECIMALS — the TypeScript wrote it — while the fold's own
//! miss key is the DECIMAL STRING OF THE IEEE-754 BIT PATTERN (`Wire.fBits`).
//! Parsing a bit pattern as a decimal yields ~4.6e18, and every huge float is an
//! exact integer, so the grid test says "gridded" for EVERY key and the area
//! branch reads as asking nothing. A first version of this did exactly that.
//! [`coord`] decides by the presence of a `.` rather than guessing, and a key it
//! cannot read is counted as unreadable instead of binned.
//!
//! Point it at a CAPTURED fixture to see what a recent day cannot answer, or at
//! a golden day to see the shape the TypeScript filled.
//!
//! ⚠ PRINTS NO COORDINATES. Health's repositories are public and a geocode key
//! is a real place he stood (#860): counts and consumer names only.
//!
//! ```text
//! cargo run --release --example geocode_gap -- /tmp/2026-09-15-pippijn.json
//! ```

use anyhow::{Context, Result};
use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;

/// `Enrich.cityGrid` is `round(n * 1000) / 1000`, so a city key lands exactly on
/// the 1e-3 lattice and nothing else does.
fn on_city_grid(v: f64) -> bool {
    (v * 1000.0 - (v * 1000.0).round()).abs() < 1e-6
}

/// One coordinate out of a key part, in EITHER format — see the module header.
///
/// ⚠ The `.` decides, rather than "try one and fall back". A bit pattern parses
/// perfectly well as an f64, so a fallback would never fire and the
/// misinterpretation would be invisible.
fn coord(part: &str) -> Option<f64> {
    if part.contains('.') {
        part.parse::<f64>().ok()
    } else {
        part.parse::<u64>().ok().map(f64::from_bits)
    }
    .filter(|v| v.is_finite() && v.abs() <= 180.0)
}

/// Split one `reverseGeocode` key into the consumer that asked it.
fn consumer(key: &str) -> &'static str {
    let p: Vec<&str> = key.split('|').collect();
    let (Some(lat), Some(lon)) = (
        p.first().copied().and_then(coord),
        p.get(1).copied().and_then(coord),
    ) else {
        return "UNREADABLE KEY";
    };
    match p.get(2).copied().unwrap_or("18") {
        "18" => "BestPlace DETAIL (zoom 18)",
        "16" if on_city_grid(lat) && on_city_grid(lon) => "Enrich.extractCity (zoom 16, gridded)",
        "16" => "BestPlace AREA (zoom 16)",
        _ => "other zoom",
    }
}

fn main() -> Result<()> {
    let path = std::env::args().nth(1).unwrap_or_default();
    if path.is_empty() {
        eprintln!("usage: geocode_gap <fixture.json>");
        std::process::exit(64);
    }
    let text = std::fs::read_to_string(&path).with_context(|| format!("reading {path}"))?;
    let fx: serde_json::Value = serde_json::from_str(&text).context("the fixture parses")?;
    let inputs = &fx["inputs"];
    let date = inputs["identity"]["date"].as_str().unwrap_or_default();
    let user = inputs["identity"]["userId"]
        .as_str()
        .unwrap_or("pippijn")
        .to_string();
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;

    backend::lean::init()?;
    let cap = backend::head::capture(inputs, date, &user).context("head::capture")?;
    let mut answerer = RowSetAnswerer::new(rows).context("the row set opens")?;
    let converged = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer)
        .context("converging the day")?;

    let mut by_consumer: std::collections::BTreeMap<&str, usize> =
        std::collections::BTreeMap::new();
    let mut other: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for m in &converged.unanswerable {
        if m.what == "reverseGeocode" {
            *by_consumer.entry(consumer(&m.key)).or_default() += 1;
        } else {
            *other.entry(m.what.clone()).or_default() += 1;
        }
    }

    let geo: usize = by_consumer.values().sum();
    println!("{date}: {} unanswered key(s)", converged.unanswerable.len());
    println!("\n  reverseGeocode {geo}, by consumer:");
    for (c, n) in &by_consumer {
        println!("    {c:<40} {n}");
    }
    if by_consumer.is_empty() {
        println!("    (none)");
    }
    if !other.is_empty() {
        println!("\n  other tables:");
        for (w, n) in &other {
            println!("    {w:<40} {n}");
        }
    }
    Ok(())
}
