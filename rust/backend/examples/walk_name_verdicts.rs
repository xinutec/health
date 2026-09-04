//! Judge a replayed day's walk NAMES against the ground-truth narrative (#445).
//!
//! ⚠ WHY THIS EXISTS: no gate can see the pipeline's `wayName` under served
//! ways. `truth_corpus` reads `wayName` but replays with the OSM externs
//! answering EMPTY (nothing loads a trace into the backend test process), so
//! the walk pass bails before the matcher on every leg. `walk_gate` replays
//! WITH ways but scores `routeCorr` from the drawn GEOMETRY
//! (`onNamedWayFraction`), never reading the pipeline's `wayName`. Both were
//! green across a change that renames walks — measured 2026-09-04, not
//! assumed. This example is the missing comparison, over the day-shell
//! replay's output (`day-shell --osm <fixture> < <request>`).
//!
//! An EXAMPLE, not a `bin/backend` verb, for `dump_day_request`'s reason: it
//! reads the gitignored golden corpus, and a production CLI that reads test
//! fixtures is the wrong shape.
//!
//! ```text
//! cargo run --example walk_name_verdicts -- 2026-06-16-pippijn /tmp/out.json
//! ```
//!
//! Prints one JSON row per enforceable named-walk truth window: the window,
//! every overlapping walking leg, and whether the DOMINANT (largest-overlap)
//! leg's `wayName` equals the truth's. Exit 2 when the corpus is absent.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

/// `walk_gate::named_walk_windows`, duplicated deliberately: an example cannot
/// import from a test file, and lifting the fn into the library would put
/// referee plumbing on the production path.
fn named_walk_windows(date: &str, tz: &str) -> Result<Vec<(i64, i64, String)>> {
    let path = format!(
        "{}/../../tests/golden/ground-truth/{date}.md",
        env!("CARGO_MANIFEST_DIR")
    );
    let Ok(md) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let req = json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz });
    let reply = backend::lean::serve(&req.to_string()).context("groundtruth serve")?;
    let r: Value = serde_json::from_str(&reply).context("groundtruth reply")?;
    let zone = r["tz"].as_str().unwrap_or(tz).to_string();
    let mut out = Vec::new();
    for row in r["rows"].as_array().map_or(&[][..], Vec::as_slice) {
        if row["enforceable"].as_bool() != Some(true) {
            continue;
        }
        let truth = &row["truth"];
        if truth["mode"].as_str() != Some("walking") {
            continue;
        }
        let Some(way) = truth["wayName"].as_str() else {
            continue;
        };
        let stamp = |d: Option<&str>, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d?, h.as_u64()?, m.as_u64()?),
                &zone,
            )
        };
        let (Some(a), Some(b)) = (
            stamp(row["startDay"].as_str(), &row["startHh"], &row["startMm"]),
            stamp(row["endDay"].as_str(), &row["endHh"], &row["endMm"]),
        ) else {
            continue;
        };
        out.push((a, b, way.to_string()));
    }
    Ok(out)
}

fn main() -> Result<()> {
    let stem = std::env::args().nth(1).unwrap_or_default();
    let timeline_path = std::env::args().nth(2).unwrap_or_default();
    if stem.is_empty() || timeline_path.is_empty() {
        bail!("usage: walk_name_verdicts <YYYY-MM-DD-user> <timeline.json>");
    }
    let fixture_path = format!(
        "{}/../../tests/golden/days/{stem}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let Ok(fx_text) = std::fs::read_to_string(&fixture_path) else {
        eprintln!("SKIPPED: no fixture at {fixture_path}");
        std::process::exit(2);
    };
    let fx: Value = serde_json::from_str(&fx_text).context("fixture parse")?;
    let tz = fx
        .pointer("/meta/tz")
        .and_then(Value::as_str)
        .unwrap_or("Europe/London");
    let date = stem.split('-').take(3).collect::<Vec<_>>().join("-");

    let tl_text = std::fs::read_to_string(&timeline_path).context("timeline read")?;
    let tl: Value = serde_json::from_str(&tl_text).context("timeline parse")?;
    // The FINAL timeline: `states` is post-finalMerge, the rows that ship.
    let states = tl
        .get("states")
        .and_then(Value::as_array)
        .context("timeline has no states")?;
    let walks: Vec<(i64, i64, Option<String>)> = states
        .iter()
        .filter(|s| {
            s.get("refinedMode")
                .or_else(|| s.get("mode"))
                .and_then(Value::as_str)
                == Some("walking")
        })
        .filter_map(|s| {
            Some((
                s.get("startTs")?.as_i64()?,
                s.get("endTs")?.as_i64()?,
                s.get("wayName").and_then(Value::as_str).map(str::to_owned),
            ))
        })
        .collect();

    for (a, b, way) in named_walk_windows(&date, tz)? {
        let over: Vec<&(i64, i64, Option<String>)> =
            walks.iter().filter(|(s, e, _)| *e > a && *s < b).collect();
        // The dominant leg: the one covering the most of the window.
        let dom = over
            .iter()
            .max_by_key(|(s, e, _)| (*e).min(b) - (*s).max(a));
        let agree = dom.is_some_and(|(_, _, n)| n.as_deref() == Some(way.as_str()));
        println!(
            "{}",
            json!({
                "date": date,
                "window": [a, b],
                "truth": way,
                "legs": over.iter().map(|(s, e, n)| json!([s, e, n])).collect::<Vec<_>>(),
                "agree": agree,
            })
        );
    }
    Ok(())
}
