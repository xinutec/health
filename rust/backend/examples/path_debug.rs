//! The decoder's score of its own path against an alternative, term by term.
//!
//! For every segment of the decoded path, and of that path with the caller's
//! segments written over it: the transition in, the entry prior, the summed
//! per-minute emissions and the duration term (`Assemble.durAt`, which holds
//! the segment-level emissions) — the instrument for a boundary the decode did
//! not place: which term paid for leaving it out. The numbers are the model's
//! own (`pathDebug` on `assemblesegments`), composed as `Spec.scoreAux`.
//!
//! ```text
//! cargo run --release --example path_debug -- <YYYY-MM-DD>-$USER <alt.json>
//! ```
//!
//! `alt.json`: `[{"startTs": n, "endTs": n, "state": "<stateKey>"}]`, each
//! written over `[startTs, endTs)`. Printed: the segments of both paths within
//! an hour of the alternative, and both totals.
//!
//! Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};

/// Score the decoded path of a frozen decoder day against an alternative.
#[derive(clap::Parser)]
struct Args {
    /// `<YYYY-MM-DD>-<user>`, a file in `tests/golden/decoded_days`
    name: String,
    /// The alternative segments, a JSON array
    alt: std::path::PathBuf,
}

/// An hour either side of the alternative: the segments it touches.
const MARGIN_S: i64 = 3600;

fn hhmm(ts: i64) -> String {
    let s = ts.rem_euclid(86_400);
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

fn num(v: &Value) -> String {
    v.as_f64()
        .map_or_else(|| "      -∞".to_string(), |x| format!("{x:8.1}"))
}

fn print_rows(label: &str, rows: &[Value], from: i64, to: i64) {
    println!("{label}");
    println!(
        "  start–end      d    trans    entry     emit      dur (prior  segEm)    total  state"
    );
    for r in rows {
        let (s, e) = (
            r["startTs"].as_i64().unwrap_or(0),
            r["endTs"].as_i64().unwrap_or(0),
        );
        if e < from || s > to {
            continue;
        }
        println!(
            "  {}–{} {:4} {} {} {} {} {} {} {}  {}",
            hhmm(s),
            hhmm(e),
            r["d"].as_i64().unwrap_or(0),
            num(&r["trans"]),
            num(&r["entry"]),
            num(&r["emit"]),
            num(&r["dur"]),
            num(&r["durPrior"]),
            num(&r["segEm"]),
            num(&r["total"]),
            r["state"].as_str().unwrap_or("?")
        );
    }
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    if backend::decode_fixture::fixture_names()?.is_none() {
        eprintln!("path_debug: no decoder corpus on this machine");
        std::process::exit(2);
    }
    let file = if args.name.ends_with(".json") {
        args.name
    } else {
        format!("{}.json", args.name)
    };
    let alt: Value = serde_json::from_str(
        &std::fs::read_to_string(&args.alt).with_context(|| args.alt.display().to_string())?,
    )?;
    let span = alt
        .as_array()
        .context("alt is an array")?
        .iter()
        .filter_map(|a| Some((a["startTs"].as_i64()?, a["endTs"].as_i64()?)))
        .fold((i64::MAX, i64::MIN), |(lo, hi), (s, e)| {
            (lo.min(s), hi.max(e))
        });
    let fx = backend::decode_fixture::read(&file)?;
    let mut req = backend::decode_fixture::request(&fx)?;
    let o = req.as_object_mut().context("request is an object")?;
    o.insert("mode".into(), json!("assemblesegments"));
    o.insert("pathDebug".into(), json!({ "alt": alt }));
    let out: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(&req)?)?)?;
    if let Some(e) = out.get("error").filter(|e| !e.is_null()) {
        anyhow::bail!("pathDebug: {e}");
    }
    let rows = |k: &str| out[k].as_array().map_or(&[][..], Vec::as_slice);
    let (from, to) = (span.0 - MARGIN_S, span.1 + MARGIN_S);
    print_rows("decoded", rows("decoded"), from, to);
    print_rows("alternative", rows("alt"), from, to);
    let (dt, at) = (
        out["decodedTotal"].as_f64().unwrap_or(f64::NEG_INFINITY),
        out["altTotal"].as_f64().unwrap_or(f64::NEG_INFINITY),
    );
    println!(
        "decoded {dt:.1}  alternative {at:.1}  alternative − decoded {:.1}",
        at - dt
    );
    Ok(())
}
