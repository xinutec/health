//! The decoder's per-minute emissions over a window of one frozen decoder day.
//!
//! For each minute: the observation the tensor holds, the state the decode
//! chose, and the best-scoring state of every mode with its emission and entry
//! log-probabilities — the instrument for a minute that went to the wrong mode,
//! as `dump_decode_request` with `chainDebug` is for a wrong line. The numbers
//! are the model's own (`Assemble.emitAt`, `entryAt`), not a re-derivation.
//!
//! ```text
//! cargo run --release --example emission_debug -- <YYYY-MM-DD>-$USER <fromTs> <toTs>
//! ```
//!
//! Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Print the decoder's emissions over `[from, to]` of a frozen decoder day.
#[derive(clap::Parser)]
struct Args {
    /// `<YYYY-MM-DD>-<user>`, a file in `tests/golden/decoded_days`
    name: String,
    /// Window start, unix seconds
    from: i64,
    /// Window end, unix seconds
    to: i64,
}

fn hhmm(ts: i64) -> String {
    let s = ts.rem_euclid(86_400);
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

fn num(v: &Value) -> String {
    v.as_f64()
        .map_or_else(|| "   -".to_string(), |x| format!("{x:4.0}"))
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    if backend::decode_fixture::fixture_names()?.is_none() {
        eprintln!("emission_debug: no decoder corpus on this machine");
        std::process::exit(2);
    }
    let file = if args.name.ends_with(".json") {
        args.name
    } else {
        format!("{}.json", args.name)
    };
    let fx = backend::decode_fixture::read(&file)?;
    let mut req = backend::decode_fixture::request(&fx)?;
    let o = req.as_object_mut().context("request is an object")?;
    o.insert("mode".into(), json!("assemblesegments"));
    o.insert(
        "emissionDebug".into(),
        json!({ "fromTs": args.from, "toTs": args.to }),
    );
    let out: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(&req)?)?)?;
    if let Some(e) = out.get("error") {
        anyhow::bail!("assemblesegments: {e}");
    }
    let rows = out["emissionDebug"]
        .as_array()
        .context("no emissionDebug in the answer")?;
    println!(
        "minute  speed cad  hr  prev→next fix   decoded                     best of each mode (emit / entry)"
    );
    for r in rows {
        let ts = r["ts"].as_i64().unwrap_or(0);
        let gap = match (r["prevFixTs"].as_i64(), r["nextFixTs"].as_i64()) {
            (Some(p), Some(n)) => format!("{:>5}s", n - p),
            _ => "     -".to_string(),
        };
        // The best state per mode: the mode is the key's first word.
        let mut best: BTreeMap<String, (f64, f64, String)> = BTreeMap::new();
        for s in r["states"].as_array().into_iter().flatten() {
            let key = s["state"].as_str().unwrap_or("");
            // `stateKey`: `mode|detail` — a stay's place, a ride's line.
            let mode = key.split('|').next().unwrap_or(key).to_string();
            let emit = s["emit"].as_f64().unwrap_or(f64::NEG_INFINITY);
            let entry = s["entry"].as_f64().unwrap_or(f64::NEG_INFINITY);
            let e = best
                .entry(mode)
                .or_insert((f64::NEG_INFINITY, 0.0, String::new()));
            if emit > e.0 {
                *e = (emit, entry, key.to_string());
            }
        }
        let mut bests: Vec<String> = best
            .iter()
            .filter(|(m, _)| m.as_str() != "train")
            .map(|(m, (e, n, k))| {
                if k == m {
                    format!("{m} {e:6.1}/{n:5.1}")
                } else {
                    format!("{k} {e:6.1}/{n:5.1}")
                }
            })
            .collect();
        // Every line's train state, best first: the line decides a ride, so
        // one "best train" hides the one that was vouched.
        let mut trains: Vec<(f64, f64, &str)> = r["states"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| {
                let key = s["state"].as_str()?;
                let line = key.strip_prefix("train|")?;
                Some((s["emit"].as_f64()?, s["entry"].as_f64()?, line))
            })
            .collect();
        trains.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (e, n, line) in trains.iter().take(4) {
            bests.push(format!("train|{line} {e:6.1}/{n:5.1}"));
        }
        let vouched = if r["covered"].as_bool() == Some(true) {
            let lines: Vec<&str> = r["linesAt"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!("vouched {}", lines.join(","))
        } else {
            "unvouched".to_string()
        };
        println!(
            "{}Z {} {} {}  {}  {:<27} {:<28} {}",
            hhmm(ts),
            num(&r["speedKmh"]),
            num(&r["cadence"]),
            num(&r["hr"]),
            gap,
            r["decoded"].as_str().unwrap_or("-"),
            vouched,
            bests.join("  ")
        );
    }
    Ok(())
}
