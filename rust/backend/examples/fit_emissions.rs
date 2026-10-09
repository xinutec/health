//! The decoder's per-mode emission and duration parameters, fitted on the
//! narrated days.
//!
//! Every minute strictly inside a confirmed narrative row (`user`, `derived` or
//! `corroborated`; the first and last minute are left out because they hold the
//! next mode too) is a labelled minute, observed exactly as the decoder observes
//! it — the request's own `emissionDebug` rows. Per mode: the share of minutes
//! with a fix, the speed and heart-rate Gaussians, and the zero-inflated
//! cadence; per mode, a moments-matched Gamma over the narrated run lengths.
//! Sleeping rows are left out: sleep has its own terms in the emission.
//!
//! ```text
//! cargo run --release --example fit_emissions -- [--exclude <YYYY-MM-DD>]... > /tmp/fit.json
//! ```
//!
//! The JSON is what a decode request's `flags.fittedPriors` takes; `--exclude`
//! leaves days out, for scoring a fit on days it never saw. Exit 2 when the
//! corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Fit the decoder's emission and duration parameters on the narrated days.
#[derive(clap::Parser)]
struct Args {
    /// A day to leave out of the fit, `YYYY-MM-DD`; repeatable
    #[arg(long)]
    exclude: Vec<String>,
    /// Also write `<dir>/<date>.json` for every narrated day: the fit made
    /// without that day, for `HSMM_FITTED_PRIORS_DIR`
    #[arg(long)]
    loo: Option<String>,
}

/// Fewer labelled minutes than this and a mode keeps the shipped parameters.
const MIN_MINUTES: usize = 30;
/// Fewer runs than this and a mode keeps the shipped duration fit.
const MIN_RUNS: usize = 5;

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);

#[derive(Default, Clone)]
struct Acc {
    minutes: usize,
    with_fix: usize,
    speed: Vec<f64>,
    hr: Vec<f64>,
    cadence: Vec<f64>,
    runs: Vec<f64>,
}

fn mean_std(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    let m = xs.iter().sum::<f64>() / n;
    let v = xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / n;
    (m, v.sqrt())
}

/// The decoder's mode for a narrated one: a bus rides in `driving`.
fn decoder_mode(m: &str) -> Option<&'static str> {
    Some(match m {
        "stationary" => "stationary",
        "walking" => "walking",
        "cycling" => "cycling",
        "driving" | "bus" => "driving",
        "train" => "train",
        "plane" => "plane",
        _ => return None,
    })
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    let Some(names) = backend::decode_fixture::fixture_names()? else {
        eprintln!("fit_emissions: no decoder corpus on this machine");
        std::process::exit(2);
    };
    // Each day's labelled minutes, gathered once: every fit is a sum over days.
    let mut per_day: BTreeMap<String, BTreeMap<&'static str, Acc>> = BTreeMap::new();
    for name in &names {
        let date = &name[..10];
        let Ok(md) = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md")) else {
            continue;
        };
        let fx = backend::decode_fixture::read(name)?;
        let tz = fx["meta"]["tz"]
            .as_str()
            .unwrap_or("Europe/London")
            .to_string();
        let gt: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(
            &json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz }),
        )?)?)?;
        let row_tz = gt["tz"].as_str().unwrap_or(&tz).to_string();

        let mut req = backend::decode_fixture::request(&fx)?;
        let start = req["observation"]["startUtc"]
            .as_i64()
            .context("startUtc")?;
        req["mode"] = json!("assemblesegments");
        req["emissionDebug"] = json!({ "fromTs": start, "toTs": start + 86_340 });
        let out: Value =
            serde_json::from_str(&backend::lean::serve(&serde_json::to_string(&req)?)?)?;
        let rows = out["emissionDebug"]
            .as_array()
            .context("no emissionDebug")?;
        let by_ts: BTreeMap<i64, &Value> = rows
            .iter()
            .filter_map(|r| Some((r["ts"].as_i64()?, r)))
            .collect();
        let acc = per_day.entry(date.to_string()).or_default();

        // Narrated runs: consecutive rows of one decoder mode join.
        let mut last: Option<(&'static str, i64, i64)> = None;
        for row in gt["rows"].as_array().into_iter().flatten() {
            let prov = row["provenance"].as_str().unwrap_or("");
            if !matches!(prov, "user" | "derived" | "corroborated") {
                last = None;
                continue;
            }
            let Some(mode) = row["truth"]["mode"].as_str().and_then(decoder_mode) else {
                last = None;
                continue;
            };
            let at = |day: &Value, hh: &Value, mm: &Value| -> Option<i64> {
                backend::timezone::wall_clock_to_unix(
                    &format!(
                        "{} {:02}:{:02}:00",
                        day.as_str()?,
                        hh.as_i64()?,
                        mm.as_i64()?
                    ),
                    &row_tz,
                )
            };
            let (Some(s), Some(e)) = (
                at(&row["startDay"], &row["startHh"], &row["startMm"]),
                at(&row["endDay"], &row["endHh"], &row["endMm"]),
            ) else {
                continue;
            };
            let a = acc.entry(mode).or_default();
            let mut t = s + 60;
            while t + 60 < e {
                if let Some(r) = by_ts.get(&t) {
                    a.minutes += 1;
                    if let Some(v) = r["speedKmh"].as_f64() {
                        a.with_fix += 1;
                        a.speed.push(v);
                    }
                    if let Some(h) = r["hr"].as_f64() {
                        a.hr.push(h);
                    }
                    if let Some(c) = r["cadence"].as_f64() {
                        a.cadence.push(c);
                    }
                }
                t += 60;
            }
            last = match last {
                Some((m, rs, re)) if m == mode && (s - re).abs() <= 60 => Some((m, rs, e)),
                Some((m, rs, re)) => {
                    acc.entry(m).or_default().runs.push(((re - rs) / 60) as f64);
                    Some((mode, s, e))
                }
                None => Some((mode, s, e)),
            };
        }
        if let Some((m, rs, re)) = last {
            acc.entry(m).or_default().runs.push(((re - rs) / 60) as f64);
        }
    }

    println!("{}", fit(&per_day, &args.exclude, true));
    if let Some(dir) = &args.loo {
        std::fs::create_dir_all(dir)?;
        for date in per_day.keys() {
            let fx = fit(&per_day, std::slice::from_ref(date), false);
            std::fs::write(format!("{dir}/{date}.json"), fx.to_string())?;
        }
        eprintln!("{} held-out fit(s) in {dir}", per_day.len());
    }
    Ok(())
}

/// The fit over every day but `exclude`; `verbose` prints the per-mode summary.
fn fit(
    per_day: &BTreeMap<String, BTreeMap<&'static str, Acc>>,
    exclude: &[String],
    verbose: bool,
) -> Value {
    let mut acc: BTreeMap<&'static str, Acc> = BTreeMap::new();
    let mut days = 0;
    for (date, modes) in per_day {
        if exclude.contains(date) {
            continue;
        }
        days += 1;
        for (m, a) in modes {
            let t = acc.entry(m).or_default();
            t.minutes += a.minutes;
            t.with_fix += a.with_fix;
            t.speed.extend_from_slice(&a.speed);
            t.hr.extend_from_slice(&a.hr);
            t.cadence.extend_from_slice(&a.cadence);
            t.runs.extend_from_slice(&a.runs);
        }
    }
    let mut priors = serde_json::Map::new();
    let mut fits = serde_json::Map::new();
    for (mode, a) in &acc {
        let (cad_pos, zero) = {
            let pos: Vec<f64> = a.cadence.iter().copied().filter(|c| *c > 0.0).collect();
            // `None`: no minute of this mode carried a step count.
            let z =
                (!a.cadence.is_empty()).then(|| 1.0 - pos.len() as f64 / a.cadence.len() as f64);
            (pos, z)
        };
        if verbose {
            eprintln!(
                "{mode:<11} {:5} min  fix {:5.1}%  speed {}  hr {}  steps zero {} pos {}  runs {}",
                a.minutes,
                100.0 * a.with_fix as f64 / a.minutes.max(1) as f64,
                if a.speed.is_empty() {
                    "-".into()
                } else {
                    let (m, s) = mean_std(&a.speed);
                    format!("{m:5.1} ± {s:4.1}")
                },
                if a.hr.is_empty() {
                    "-".into()
                } else {
                    let (m, s) = mean_std(&a.hr);
                    format!("{m:5.1} ± {s:4.1}")
                },
                zero.map_or_else(|| "-".to_string(), |z| format!("{:4.1}%", 100.0 * z)),
                if cad_pos.is_empty() {
                    "-".into()
                } else {
                    let (m, s) = mean_std(&cad_pos);
                    format!("{m:5.1} ± {s:4.1}")
                },
                a.runs.len(),
            );
        }
        if a.minutes >= MIN_MINUTES
            && a.speed.len() >= MIN_MINUTES
            && a.hr.len() >= MIN_MINUTES
            && cad_pos.len() >= 2
            && let Some(zero) = zero
        {
            let (sm, ss) = mean_std(&a.speed);
            let (hm, hs) = mean_std(&a.hr);
            let (cm, cs) = mean_std(&cad_pos);
            priors.insert(
                (*mode).into(),
                json!([
                    a.with_fix as f64 / a.minutes as f64,
                    sm,
                    ss.max(1.0),
                    hm,
                    hs.max(1.0),
                    zero,
                    cm,
                    cs.max(1.0)
                ]),
            );
        }
        if a.runs.len() >= MIN_RUNS {
            // `Duration.fitDurationDistribution`'s moments, variance floored the same.
            let n = a.runs.len() as f64;
            let m = a.runs.iter().sum::<f64>() / n;
            let v = (a.runs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (n - 1.0)).max(4.0);
            fits.insert((*mode).into(), json!([m * m / v, m / v]));
        }
    }
    if verbose {
        eprintln!("{days} narrated day(s) in the fit");
    }
    json!({ "modePriors": priors, "durationFits": fits })
}
