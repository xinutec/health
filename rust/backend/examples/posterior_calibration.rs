//! How well the decoder's confidence predicts whether it is right.
//!
//! Each narrated day decodes with `flags.posterior` on, so every segment carries
//! its mode's posterior mass (`Verified.Hsmm.Posterior`). Every minute inside a
//! confirmed narrative row (`user`, `derived` or `corroborated`) is a labelled
//! minute: the decoded segment's mode is right or wrong against it, and its
//! confidence is the prediction. Printed: a reliability table by confidence
//! band, the Brier score, and for every decoded ride inside narrated time
//! whether a narrated ride overlaps it (a phantom if none) and its confidence.
//!
//! ```text
//! cargo run --release --example posterior_calibration [-- <YYYY-MM-DD>...]
//! ```
//!
//! Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);
const BANDS: usize = 10;

/// Measure how well the decoder's confidence predicts whether it is right.
#[derive(clap::Parser)]
struct Args {
    /// Days to measure, `YYYY-MM-DD`; every narrated day when none
    days: Vec<String>,
}

/// The decoder's word for a narrated mode: a bus rides in `driving`, sleep is
/// a stay.
fn decoder_mode(m: &str) -> Option<&'static str> {
    Some(match m {
        "stationary" | "sleeping" => "stationary",
        "walking" => "walking",
        "cycling" => "cycling",
        "driving" | "bus" => "driving",
        "train" => "train",
        "plane" => "plane",
        _ => return None,
    })
}

/// The narrative's confirmed rows as `(start, end, decoder mode)`, unix seconds.
fn truth(date: &str, tz: &str) -> Result<Vec<(i64, i64, &'static str)>> {
    let md = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md"))?;
    let gt: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(
        &json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz }),
    )?)?)?;
    let zone = gt["tz"].as_str().unwrap_or(tz).to_string();
    let mut out = Vec::new();
    for row in gt["rows"].as_array().into_iter().flatten() {
        if !matches!(
            row["provenance"].as_str(),
            Some("user" | "derived" | "corroborated")
        ) {
            continue;
        }
        let Some(mode) = row["truth"]["mode"].as_str().and_then(decoder_mode) else {
            continue;
        };
        let at = |d: &Value, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d.as_str()?, h.as_u64()?, m.as_u64()?),
                &zone,
            )
        };
        if let (Some(a), Some(b)) = (
            at(&row["startDay"], &row["startHh"], &row["startMm"]),
            at(&row["endDay"], &row["endHh"], &row["endMm"]),
        ) {
            out.push((a, b, mode));
        }
    }
    Ok(out)
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    let only = args.days;
    let Some(names) = backend::decode_fixture::fixture_names()? else {
        eprintln!("posterior_calibration: no decoder corpus on this machine");
        std::process::exit(2);
    };
    // Per band: labelled minutes, right ones, summed confidence.
    let mut n = [0usize; BANDS];
    let mut right = [0usize; BANDS];
    let mut conf = [0f64; BANDS];
    let mut brier = 0f64;
    let mut total = 0usize;
    // Decoded rides inside narrated time: (confidence, a narrated ride overlaps).
    let mut rides: Vec<(f64, bool)> = Vec::new();
    for name in &names {
        let date = &name[..10];
        if !only.is_empty() && !only.iter().any(|o| o == date) {
            continue;
        }
        if !std::path::Path::new(&format!("{NARRATIVES}/{date}.md")).exists() {
            continue;
        }
        let fx = backend::decode_fixture::read(name)?;
        let tz = fx["meta"]["tz"].as_str().unwrap_or("Europe/London");
        let rows = truth(date, tz)?;
        let mut req = backend::decode_fixture::request(&fx).context("request")?;
        req["mode"] = json!("assemblesegments");
        req["flags"]["posterior"] = json!(true);
        let started = std::time::Instant::now();
        let out: Value =
            serde_json::from_str(&backend::lean::serve(&serde_json::to_string(&req)?)?)?;
        let ms = started.elapsed().as_millis();
        let segs = out["segments"]
            .as_array()
            .with_context(|| format!("{date}: no segments: {out}"))?;
        let mut day_n = 0;
        for s in segs {
            let (Some(a), Some(b), Some(mode), Some(c)) = (
                s["startTs"].as_i64(),
                s["endTs"].as_i64(),
                s["mode"].as_str(),
                s["confidence"].as_f64(),
            ) else {
                continue;
            };
            if matches!(mode, "train" | "driving" | "cycling" | "plane") {
                let narrated = rows.iter().filter(|(ra, rb, _)| *ra < b && a < *rb);
                let (mut any, mut ride) = (false, false);
                for (_, _, m) in narrated {
                    any = true;
                    ride |= matches!(*m, "train" | "driving" | "cycling" | "plane");
                }
                if any {
                    rides.push((c, ride));
                }
            }
            let mut t = a;
            while t < b {
                if let Some(&(_, _, m)) = rows.iter().find(|(ra, rb, _)| *ra <= t && t < *rb) {
                    let ok = m == mode;
                    let k = ((c * BANDS as f64) as usize).min(BANDS - 1);
                    n[k] += 1;
                    right[k] += usize::from(ok);
                    conf[k] += c;
                    brier += (c - f64::from(u8::from(ok))).powi(2);
                    total += 1;
                    day_n += 1;
                }
                t += 60;
            }
        }
        eprintln!("{date}: {day_n} labelled minute(s), decode + posterior {ms} ms");
    }
    println!("band        minutes  mean conf  accuracy");
    for k in 0..BANDS {
        if n[k] == 0 {
            continue;
        }
        println!(
            "{:.1}–{:.1}  {:9}  {:9.3}  {:8.3}",
            k as f64 / BANDS as f64,
            (k + 1) as f64 / BANDS as f64,
            n[k],
            conf[k] / n[k] as f64,
            right[k] as f64 / n[k] as f64
        );
    }
    println!(
        "{total} labelled minutes, Brier {:.4}",
        brier / total.max(1) as f64
    );
    println!("decoded rides by confidence: real (a narrated ride overlaps) | phantom");
    for k in 0..BANDS {
        let (lo, hi) = (k as f64 / BANDS as f64, (k + 1) as f64 / BANDS as f64);
        let inb = rides
            .iter()
            .filter(|(c, _)| *c >= lo && (*c < hi || k == BANDS - 1));
        let (real, phantom) = inb.fold(
            (0, 0),
            |(r, p), (_, ok)| if *ok { (r + 1, p) } else { (r, p + 1) },
        );
        if real + phantom > 0 {
            println!("{lo:.1}–{hi:.1}  {real:5} | {phantom:5}");
        }
    }
    Ok(())
}
