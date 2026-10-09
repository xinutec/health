//! How the decoder's term families should balance, learned on the narrated
//! days and judged on days the search never saw.
//!
//! Each family of decoder terms — the base emission, geometric feasibility,
//! the gap term, rail evidence, line proximity, continuity, entry, the chain
//! context, the duration prior, segment evidence — carries a weight
//! (`EmissionFull.TermWeights`, `flags.termWeights`), `1` in the shipped model.
//! The days split in two by index; a coordinate search over the weights runs
//! on one half and is scored on the other, both ways round. The objective,
//! fixed before any run: matched journeys + leg modes + lines + stations, less
//! twice the phantom rides — the scoreboard's own counts (`decoderscore`).
//!
//! ```text
//! cargo run --release --example tune_weights
//! ```
//!
//! Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);

const FAMILIES: [&str; 10] = [
    "base",
    "geometric",
    "gap",
    "rail",
    "lineProximity",
    "continuity",
    "entry",
    "chain",
    "duration",
    "segmentEvidence",
];
/// The steps a coordinate tries, as factors on its current weight.
const STEPS: [f64; 4] = [0.5, 0.75, 1.33, 2.0];
const PASSES: usize = 2;
const THREADS: usize = 8;

struct Day {
    date: String,
    req: Value,
    rows: Vec<Value>,
}

/// The narrative's rows with unix times, as `decoderscore` takes them.
fn truth_rows(date: &str, tz: &str) -> Result<Vec<Value>> {
    let md = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md"))?;
    let r: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(
        &json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz }),
    )?)?)?;
    let zone = r["tz"].as_str().unwrap_or(tz).to_string();
    let mut rows = Vec::new();
    for row in r["rows"].as_array().into_iter().flatten() {
        let at = |d: &Value, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d.as_str()?, h.as_u64()?, m.as_u64()?),
                &zone,
            )
        };
        let (Some(a), Some(b)) = (
            at(&row["startDay"], &row["startHh"], &row["startMm"]),
            at(&row["endDay"], &row["endHh"], &row["endMm"]),
        ) else {
            anyhow::bail!("{date}: a row's civil time did not resolve in {zone}");
        };
        rows.push(json!({
            "startTs": a, "endTs": b, "status": row["status"],
            "provenance": row["provenance"], "truth": row["truth"],
        }));
    }
    Ok(rows)
}

/// One day's ten counts under `weights`.
fn score_day(day: &Day, weights: &Value) -> Result<Value> {
    let mut req = day.req.clone();
    req["flags"]["termWeights"] = weights.clone();
    let Some(segments) = backend::lean::assemble_segments(&req)? else {
        return Ok(json!({}));
    };
    let rendered = backend::row_json::render_segments(&segments)?;
    let segs: Vec<Value> = rendered
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            json!({
                "startTs": s["startTs"], "endTs": s["endTs"], "mode": s["mode"],
                "lineName": s["lineName"],
                "board": s.get("boardStation").cloned().unwrap_or(Value::Null),
                "alight": s.get("alightStation").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let got: Value = serde_json::from_str(&backend::lean::serve(
        &json!({ "mode": "decoderscore", "rows": day.rows, "segs": segs }).to_string(),
    )?)?;
    anyhow::ensure!(
        got.get("error").is_none(),
        "{}: decoderscore refused: {got}",
        day.date
    );
    Ok(got)
}

/// The summed counts over `days` and the objective. A weighting that drives a
/// day's score out of the verified trellis's integer envelope is not a model
/// the decoder can run: it scores `−∞`, and the search moves on.
fn evaluate(days: &[&Day], weights: &Value) -> Result<(f64, BTreeMap<String, i64>)> {
    match evaluate_checked(days, weights) {
        Err(e) if format!("{e:#}").contains("exceeds envelope") => {
            Ok((f64::NEG_INFINITY, BTreeMap::new()))
        }
        r => r,
    }
}

fn evaluate_checked(days: &[&Day], weights: &Value) -> Result<(f64, BTreeMap<String, i64>)> {
    let chunks: Vec<Vec<&Day>> = (0..THREADS)
        .map(|t| {
            days.iter()
                .enumerate()
                .filter(|(i, _)| i % THREADS == t)
                .map(|(_, d)| *d)
                .collect()
        })
        .collect();
    let results: Vec<Result<Vec<Value>>> = std::thread::scope(|s| {
        let handles: Vec<_> = chunks
            .iter()
            .map(|chunk| {
                std::thread::Builder::new()
                    .stack_size(256 * 1024 * 1024)
                    .spawn_scoped(s, move || {
                        chunk.iter().map(|d| score_day(d, weights)).collect()
                    })
                    .expect("spawn")
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("a scoring thread panicked"))
            .collect()
    });
    let mut tot: BTreeMap<String, i64> = BTreeMap::new();
    for r in results {
        for got in r? {
            for (k, v) in got.as_object().into_iter().flatten() {
                *tot.entry(k.clone()).or_default() += v.as_i64().unwrap_or(0);
            }
        }
    }
    let g = |k: &str| tot.get(k).copied().unwrap_or(0) as f64;
    let obj =
        g("journeysMatched") + g("legModeMatching") + g("legLineMatching") + g("stationsMatching")
            - 2.0 * g("phantomRides");
    Ok((obj, tot))
}

fn line(tag: &str, obj: f64, t: &BTreeMap<String, i64>) -> String {
    let g = |k: &str| t.get(k).copied().unwrap_or(0);
    format!(
        "{tag:<28} objective {obj:6.1}  journeys {}  legMode {}  legLine {}  stations {}  phantoms {}",
        g("journeysMatched"),
        g("legModeMatching"),
        g("legLineMatching"),
        g("stationsMatching"),
        g("phantomRides")
    )
}

/// Coordinate search from all-ones on `train`.
fn tune(train: &[&Day]) -> Result<Value> {
    let mut w: BTreeMap<&str, f64> = FAMILIES.iter().map(|f| (*f, 1.0)).collect();
    let as_json = |w: &BTreeMap<&str, f64>| json!(w);
    let (mut best, t) = evaluate(train, &as_json(&w))?;
    eprintln!("  {}", line("start", best, &t));
    for pass in 0..PASSES {
        let mut moved = false;
        for fam in FAMILIES {
            let here = w[fam];
            for step in STEPS {
                let mut cand = w.clone();
                cand.insert(fam, here * step);
                let (obj, t) = evaluate(train, &as_json(&cand))?;
                if obj > best {
                    best = obj;
                    w = cand;
                    moved = true;
                    eprintln!("  {}", line(&format!("pass {pass} {fam} ×{step}"), obj, &t));
                }
            }
        }
        if !moved {
            break;
        }
    }
    Ok(as_json(&w))
}

fn main() -> Result<()> {
    let Some(names) = backend::decode_fixture::fixture_names()? else {
        eprintln!("tune_weights: no decoder corpus on this machine");
        std::process::exit(2);
    };
    let mut days = Vec::new();
    for name in &names {
        let date = name[..10].to_string();
        if !std::path::Path::new(&format!("{NARRATIVES}/{date}.md")).exists() {
            continue;
        }
        let fx = backend::decode_fixture::read(name)?;
        let tz = fx["meta"]["tz"]
            .as_str()
            .unwrap_or("Europe/London")
            .to_string();
        let req = backend::decode_fixture::request(&fx).context("request")?;
        let rows = truth_rows(&date, &tz)?;
        days.push(Day { date, req, rows });
    }
    let (a, b): (Vec<&Day>, Vec<&Day>) = {
        let a = days
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 == 0)
            .map(|(_, d)| d)
            .collect();
        let b = days
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, d)| d)
            .collect();
        (a, b)
    };
    let ones = json!(
        FAMILIES
            .iter()
            .map(|f| (*f, 1.0))
            .collect::<BTreeMap<_, _>>()
    );
    for (name, train, test) in [("A→B", &a, &b), ("B→A", &b, &a)] {
        eprintln!("fold {name}: tuning on {} day(s)", train.len());
        let w = tune(train)?;
        let (o0, t0) = evaluate(test, &ones)?;
        let (o1, t1) = evaluate(test, &w)?;
        println!("fold {name} weights {w}");
        println!(
            "{}",
            line(&format!("fold {name} held-out shipped"), o0, &t0)
        );
        println!("{}", line(&format!("fold {name} held-out tuned"), o1, &t1));
    }
    Ok(())
}
