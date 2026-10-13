//! The decoder's fitted parameters, every number of them, from the narrated
//! days: the four files a decode request's harness flags take
//! (`HSMM_SEG_EMISSION`, `HSMM_TRANS_FIT`, `HSMM_ENTRY_COUNTS`, and the speed
//! priors `HSMM_FITTED_PRIORS_DIR` wants per day).
//!
//! Every minute strictly inside a confirmed narrative row (`user`, `derived` or
//! `corroborated`; the first and last minute are left out because they hold the
//! next mode too) is a labelled minute, observed exactly as the decoder observes
//! it — the request's own `emissionDebug` rows, which carry the windowed speed,
//! the rail class, in-bed and the minute's position. Consecutive rows of one
//! mode join into a run; a run's net displacement is the decoder's own window
//! over it (`emissionDebug.segments`).
//!
//! The FORM is not fitted: which terms are on (`speedWindow`, `dispPosterior`,
//! `centreAnchor`, `noSelfMass`, …), the outlier range, the pseudo-counts, and
//! the parameters no narrated minute reaches (cycling, plane, the inert
//! beta-binomial) come from `--form <dir>` (the golden fits); every number the
//! narrated days do reach is replaced.
//!
//! ```text
//! cargo run --release --example fit_emissions -- --form <dir> --out <dir> [--loo <dir>] [--exclude <YYYY-MM-DD>]...
//! ```
//!
//! `--out` gets the fit over every day but `--exclude`: the four files, and
//! `decoder-params.json`, the one record the serving pod loads
//! (`backend::decoder_params`), with `decoder-form.json`'s settings and the
//! days it came from. `--loo` gets, per file, `<loo>/<file>/<date>.json` fitted
//! without that day — point `DECODER_PARAMS` (or a harness variable) at its
//! directory. Exit 2 when the corpus is absent.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Fit every decoder parameter on the narrated days.
#[derive(clap::Parser)]
struct Args {
    /// The golden fits directory the form (and the unreached parameters) comes from
    #[arg(long)]
    form: String,
    /// Where the fit over every day but `--exclude` is written
    #[arg(long)]
    out: String,
    /// Also write, per parameter file, one fit per narrated day without that day
    #[arg(long)]
    loo: Option<String>,
    /// A day to leave out of `--out`'s fit, `YYYY-MM-DD`; repeatable
    #[arg(long)]
    exclude: Vec<String>,
}

/// Fewer labelled values than this and a parameter keeps the form's value.
const MIN_N: usize = 30;
/// Fewer runs than this and a mode keeps the form's duration fit.
const MIN_RUNS: usize = 5;
/// A run's heart rate enters the between-run spread from this many minutes.
const MIN_RUN_HR: usize = 5;
/// The duration fit's variance floor (`Duration.fitDurationDistribution`'s).
const DUR_VAR_FLOOR: f64 = 4.0;
/// A listed place further than this from a lit stay is not where it was
/// (`Emissions.PLACE_RADIUS_M`).
const PLACE_RADIUS_M: f64 = 150.0;
/// A lit stay is placed from this many fixes.
const MIN_STAY_FIXES: usize = 3;
/// Pseudo-count per cell of a fitted chain row, so an unseen move is rare,
/// not impossible: one observation's worth, spread over the row.
const CHAIN_PSEUDO: f64 = 1.0 / 3.0;
/// A stopped vehicle is slower than this percentile of the stays.
const STAY_QUANTILE_PCT: usize = 95;
/// The standstill's spread is at least the windowed speed's resolution.
const STOP_STD_MIN: f64 = 0.1;
/// EM iterations for the mixtures (they settle in tens).
const EM_ITERS: usize = 200;
const EARTH_M_PER_DEG: f64 = 111_320.0;

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);

const MODES: [&str; 6] = [
    "stationary",
    "walking",
    "cycling",
    "driving",
    "train",
    "plane",
];

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

#[derive(Clone, Default)]
struct Minute {
    lit: bool,
    window_kmh: Option<f64>,
    /// Awake heart rate; an in-bed minute's belongs to its night (`Day::nights`).
    hr: Option<f64>,
    cls: usize,
    /// The route model covers the minute: a train here can be a named line;
    /// elsewhere only `unknown_rail`, which takes the mainline speed.
    covered: bool,
}

#[derive(Clone)]
struct Run {
    mode: &'static str,
    minutes_long: f64,
    inner: Vec<Minute>,
    /// The decoder's window over the run: `(dispM, hours)`.
    window: Option<(f64, f64)>,
}

#[derive(Clone, Default)]
struct Day {
    runs: Vec<Run>,
    /// Mode changes between consecutive confirmed runs.
    changes: Vec<(&'static str, &'static str)>,
    /// Each night's in-bed heart-rate minutes, in order.
    nights: Vec<Vec<Option<f64>>>,
    /// Each lit stay's distance to the nearest listed place, metres.
    stay_dist: Vec<f64>,
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    let Some(names) = backend::decode_fixture::fixture_names()? else {
        eprintln!("fit_emissions: no decoder corpus on this machine");
        std::process::exit(2);
    };
    let form = Form::read(&args.form)?;
    // Each day is a full decode: read them over the Lean worker pool, as the
    // scoreboard does (`FIT_JOBS`, default 8).
    let jobs: usize = std::env::var("FIT_JOBS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let days: std::sync::Mutex<BTreeMap<String, Day>> = std::sync::Mutex::default();
    let failed: std::sync::Mutex<Vec<String>> = std::sync::Mutex::default();
    std::thread::scope(|scope| {
        for _ in 0..jobs.min(names.len()) {
            std::thread::Builder::new()
                .stack_size(256 * 1024 * 1024)
                .spawn_scoped(scope, || {
                    loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let Some(name) = names.get(i) else { break };
                        let date = &name[..10];
                        let Ok(md) = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md"))
                        else {
                            continue;
                        };
                        match read_day(name, date, &md) {
                            Ok(d) => {
                                days.lock().expect("days").insert(date.to_string(), d);
                            }
                            Err(e) => failed
                                .lock()
                                .expect("failed")
                                .push(format!("{date}: {e:#}")),
                        }
                    }
                })
                .expect("spawn a fit worker");
        }
    });
    let failed = failed.into_inner().expect("failed");
    anyhow::ensure!(failed.is_empty(), "days that did not read: {failed:?}");
    let days = days.into_inner().expect("days");
    write_fit(&form, &days, &args.exclude, &args.out, true)?;
    if let Some(dir) = &args.loo {
        for date in days.keys() {
            let tmp = format!("{dir}/.{date}");
            write_fit(&form, &days, std::slice::from_ref(date), &tmp, false)?;
            for f in FILES.into_iter().chain([RECORD]) {
                std::fs::create_dir_all(format!("{dir}/{f}"))?;
                std::fs::rename(format!("{tmp}/{f}.json"), format!("{dir}/{f}/{date}.json"))?;
            }
            std::fs::remove_dir(&tmp)?;
        }
        eprintln!("{} held-out fit(s) in {dir}", days.len());
    }
    Ok(())
}

/// The single record the serving pod loads (`DECODER_PARAMS`).
const RECORD: &str = "decoder-params";

const FILES: [&str; 4] = [
    "segment-emission",
    "transition-fit",
    "entry-counts",
    "speed-priors",
];

/// One narrated day's labelled runs, nights, stays and mode changes.
fn read_day(name: &str, date: &str, md: &str) -> Result<Day> {
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
    let places: Vec<(f64, f64)> = req["places"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["lat"].as_f64()?, p["lon"].as_f64()?)))
        .collect();

    // The confirmed rows, in order, with their spans.
    struct Row {
        mode: Option<&'static str>,
        sleeping: bool,
        s: i64,
        e: i64,
    }
    let mut rows: Vec<Option<Row>> = Vec::new();
    for row in gt["rows"].as_array().into_iter().flatten() {
        let prov = row["provenance"].as_str().unwrap_or("");
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
        let span = at(&row["startDay"], &row["startHh"], &row["startMm"]).zip(at(
            &row["endDay"],
            &row["endHh"],
            &row["endMm"],
        ));
        let tm = row["truth"]["mode"].as_str().unwrap_or("");
        rows.push(match span {
            Some((s, e)) if matches!(prov, "user" | "derived" | "corroborated") && e > s => {
                Some(Row {
                    mode: decoder_mode(tm),
                    sleeping: tm == "sleeping",
                    s,
                    e,
                })
            }
            _ => None,
        });
    }
    // Runs: consecutive confirmed rows of one mode, a minute apart at most.
    let mut spans: Vec<(&'static str, i64, i64)> = Vec::new();
    let mut joinable = false;
    for r in &rows {
        let Some(r) = r else {
            joinable = false;
            continue;
        };
        let Some(m) = r.mode else {
            joinable = false;
            continue;
        };
        match spans.last_mut() {
            Some(last) if joinable && last.0 == m && (r.s - last.2).abs() <= 60 => last.2 = r.e,
            _ => spans.push((m, r.s, r.e)),
        }
        joinable = true;
    }

    let start = req["observation"]["startUtc"]
        .as_i64()
        .context("startUtc")?;
    req["mode"] = json!("assemblesegments");
    req["emissionDebug"] = json!({
        "fromTs": start, "toTs": start + 86_340,
        "segments": spans.iter().map(|&(_, s, e)| json!([s, e - 60])).collect::<Vec<_>>(),
    });
    let out: Value = serde_json::from_str(&backend::lean::serve(&serde_json::to_string(&req)?)?)?;
    let by_ts: BTreeMap<i64, &Value> = out["emissionDebug"]
        .as_array()
        .context("no emissionDebug")?
        .iter()
        .filter_map(|r| Some((r["ts"].as_i64()?, r)))
        .collect();
    let windows = out["segWindows"].as_array().cloned().unwrap_or_default();
    let minute = |r: &Value| Minute {
        lit: !r["lat"].is_null(),
        window_kmh: r["windowKmh"].as_f64(),
        hr: if r["inBed"].as_bool() == Some(true) {
            None
        } else {
            r["hr"].as_f64()
        },
        cls: r["obsClass"].as_u64().unwrap_or(0) as usize,
        covered: r["covered"].as_bool() == Some(true),
    };
    let inner = |s: i64, e: i64| -> Vec<Minute> {
        (1..)
            .map(|k| s + 60 * k)
            .take_while(|t| t + 60 < e)
            .filter_map(|t| by_ts.get(&t).map(|r| minute(r)))
            .collect()
    };

    let mut day = Day::default();
    for (i, &(mode, s, e)) in spans.iter().enumerate() {
        let window = windows
            .get(i)
            .and_then(|w| Some((w["dispM"].as_f64()?, w["hours"].as_f64()?)));
        day.runs.push(Run {
            mode,
            minutes_long: ((e - s) / 60) as f64,
            inner: inner(s, e),
            window,
        });
        if i > 0 && spans[i - 1].0 != mode && (s - spans[i - 1].2).abs() <= 60 {
            day.changes.push((spans[i - 1].0, mode));
        }
    }
    for r in rows.iter().flatten() {
        if r.sleeping {
            let night: Vec<Option<f64>> = (0..)
                .map(|k| r.s + 60 * k)
                .take_while(|t| *t < r.e)
                .filter_map(|t| by_ts.get(&t))
                .filter(|m| m["inBed"].as_bool() == Some(true))
                .map(|m| m["hr"].as_f64())
                .collect();
            day.nights.push(night);
        } else if r.mode == Some("stationary") {
            let fixes: Vec<(f64, f64)> = (0..)
                .map(|k| r.s + 60 * k)
                .take_while(|t| *t < r.e)
                .filter_map(|t| by_ts.get(&t))
                .filter_map(|m| Some((m["lat"].as_f64()?, m["lon"].as_f64()?)))
                .collect();
            if fixes.len() >= MIN_STAY_FIXES && !places.is_empty() {
                let n = fixes.len() as f64;
                let c = (
                    fixes.iter().map(|f| f.0).sum::<f64>() / n,
                    fixes.iter().map(|f| f.1).sum::<f64>() / n,
                );
                let near = places
                    .iter()
                    .map(|p| metres(c, *p))
                    .fold(f64::INFINITY, f64::min);
                day.stay_dist.push(near);
            }
        }
    }
    Ok(day)
}

fn metres(a: (f64, f64), b: (f64, f64)) -> f64 {
    let x = (b.1 - a.1) * EARTH_M_PER_DEG * a.0.to_radians().cos();
    let y = (b.0 - a.0) * EARTH_M_PER_DEG;
    x.hypot(y)
}

/// The four files' templates: the form, and the parameters no narrated minute
/// reaches.
struct Form {
    files: BTreeMap<&'static str, Value>,
    /// `decoder-form.json`: the record's settings no day fits (`maxD`,
    /// `dropUnknown`, the per-minute mode prior's scales).
    decoder: Value,
}

impl Form {
    fn read(dir: &str) -> Result<Form> {
        let mut files = BTreeMap::new();
        for f in FILES {
            let path = format!("{dir}/{f}.json");
            files.insert(
                f,
                serde_json::from_str(&std::fs::read_to_string(&path).context(path)?)?,
            );
        }
        let path = format!("{dir}/decoder-form.json");
        let decoder = serde_json::from_str(&std::fs::read_to_string(&path).context(path)?)?;
        Ok(Form { files, decoder })
    }
}

fn mean_std(xs: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    let m = xs.iter().sum::<f64>() / n;
    (
        m,
        (xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / n).sqrt(),
    )
}

/// A heart-rate random effect over groups of consecutive minutes: the pooled
/// within-group spread `σw`, its lag-1 correlation `ρ`, the minute-weighted
/// mean, and the between-group spread `τ` net of the sampling spread of a
/// group's mean (`σw²/nEff`). `None` under `MIN_N` minutes.
fn hr_effect(groups: &[Vec<Option<f64>>]) -> Option<(f64, f64, f64, f64)> {
    let (mut ss, mut df, mut lag, mut all) = (0.0, 0.0, 0.0, Vec::new());
    let mut means: Vec<(f64, f64)> = Vec::new();
    for g in groups {
        let xs: Vec<f64> = g.iter().flatten().copied().collect();
        if xs.len() < 2 {
            continue;
        }
        let m = xs.iter().sum::<f64>() / xs.len() as f64;
        ss += xs.iter().map(|x| (x - m) * (x - m)).sum::<f64>();
        df += xs.len() as f64 - 1.0;
        for w in g.windows(2) {
            if let (Some(a), Some(b)) = (w[0], w[1]) {
                lag += (a - m) * (b - m);
            }
        }
        all.extend_from_slice(&xs);
        if xs.len() >= MIN_RUN_HR {
            means.push((m, xs.len() as f64));
        }
    }
    if all.len() < MIN_N || df <= 0.0 || ss <= 0.0 {
        return None;
    }
    let s2 = ss / df;
    let rho = (lag / ss).clamp(0.0, 0.99);
    let mu = all.iter().sum::<f64>() / all.len() as f64;
    let w = (1.0 - rho) / (1.0 + rho);
    let between =
        means.iter().map(|(m, _)| (m - mu) * (m - mu)).sum::<f64>() / means.len().max(1) as f64;
    let sampling = means
        .iter()
        .map(|(_, n)| s2 / (n * w).max(1.0))
        .sum::<f64>()
        / means.len().max(1) as f64;
    Some((mu, (between - sampling).max(1.0).sqrt(), s2.sqrt(), rho))
}

/// A vehicle's windowed speeds split at `cut`: the share under it, their
/// spread about a standstill, and the moving rest's mean and spread.
/// Returns `(π, s0, μ, σ)`.
fn stop_split(xs: &[f64], cut: f64) -> (f64, f64, f64, f64) {
    let (stopped, moving): (Vec<f64>, Vec<f64>) = xs.iter().partition(|x| **x < cut);
    let pi = stopped.len() as f64 / xs.len() as f64;
    let s0 = if stopped.is_empty() {
        cut
    } else {
        (stopped.iter().map(|x| x * x).sum::<f64>() / stopped.len() as f64).sqrt()
    };
    let (mu, sd) = mean_std(&moving);
    (pi, s0.max(STOP_STD_MIN), mu, sd.max(1.0))
}

/// A mode's net displacement: lognormal `(μ, σ)` with a share `ε` spread evenly
/// over `0–uMax` km/h — `SegmentEmission.dispScore`'s form, by EM.
fn disp_mixture(mode: &str, ws: &[(f64, f64)], u_max: f64) -> Option<(f64, f64, f64)> {
    if ws.len() < MIN_RUNS {
        return None;
    }
    // `(log x, the main density's Jacobian to metres, the flat density)`.
    let pts: Vec<(f64, f64, f64)> = ws
        .iter()
        .map(|&(disp, hours)| {
            let dist = disp.max(1.0);
            if mode == "stationary" {
                (dist.ln(), 1.0 / dist, 1.0 / (u_max * hours * 1000.0))
            } else {
                let v = dist / 1000.0 / hours;
                (
                    v.ln(),
                    1.0 / (v * hours * 1000.0),
                    1.0 / (u_max * hours * 1000.0),
                )
            }
        })
        .collect();
    let (mut mu, mut sg) = {
        let l: Vec<f64> = pts.iter().map(|p| p.0).collect();
        mean_std(&l)
    };
    sg = sg.max(0.1);
    let mut eps: f64 = 0.05;
    for _ in 0..EM_ITERS {
        let r: Vec<f64> = pts
            .iter()
            .map(|&(l, jac, flat)| {
                let main = (-(l - mu) * (l - mu) / (2.0 * sg * sg)).exp()
                    / (sg * (2.0 * std::f64::consts::PI).sqrt())
                    * jac;
                let a = (1.0 - eps) * main;
                let b = eps * flat;
                if a + b > 0.0 { a / (a + b) } else { 0.0 }
            })
            .collect();
        let n: f64 = r.iter().sum();
        if n <= 0.0 {
            return None;
        }
        mu = pts.iter().zip(&r).map(|(p, r)| r * p.0).sum::<f64>() / n;
        sg = (pts
            .iter()
            .zip(&r)
            .map(|(p, r)| r * (p.0 - mu) * (p.0 - mu))
            .sum::<f64>()
            / n)
            .sqrt()
            .max(0.1);
        eps = (1.0 - n / pts.len() as f64).max(1e-4);
    }
    Some((mu, sg, eps))
}

/// A chain's rows from transition counts, with `CHAIN_PSEUDO` per cell.
fn chain_rows(counts: &[Vec<f64>]) -> Vec<Vec<f64>> {
    counts
        .iter()
        .map(|row| {
            let k = row.len() as f64;
            let n: f64 = row.iter().sum::<f64>() + CHAIN_PSEUDO * k;
            row.iter().map(|c| round4((c + CHAIN_PSEUDO) / n)).collect()
        })
        .collect()
}

fn round4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

/// The fit over every day but `exclude`, written as the four files into `dir`.
fn write_fit(
    form: &Form,
    days: &BTreeMap<String, Day>,
    exclude: &[String],
    dir: &str,
    verbose: bool,
) -> Result<()> {
    let used: Vec<&Day> = days
        .iter()
        .filter(|(d, _)| !exclude.contains(d))
        .map(|(_, d)| d)
        .collect();
    let runs: Vec<&Run> = used.iter().flat_map(|d| d.runs.iter()).collect();
    let of = |m: &str| -> Vec<&Run> { runs.iter().copied().filter(|r| r.mode == m).collect() };
    let mut log = Vec::new();

    // Segment emission.
    let mut se = form.files["segment-emission"].clone();
    let u_max = se["uMaxKmh"].as_f64().unwrap_or(300.0);
    let awake = |rs: &[&Run]| -> Vec<Vec<Option<f64>>> {
        rs.iter()
            .map(|r| r.inner.iter().map(|m| m.hr).collect())
            .collect()
    };
    if let Some((_, _, sw, rho)) = hr_effect(&awake(&runs)) {
        se["sigmaW"] = json!(round4(sw));
        se["rho"] = json!(round4(rho));
        log.push(format!("heart rate: σw {sw:.2}, ρ {rho:.3}"));
    }
    let mut taus = Vec::new();
    for m in MODES {
        if let Some((mu, tau, _, _)) = hr_effect(&awake(&of(m)))
            && se["modes"][m].is_array()
        {
            se["modes"][m][0] = json!(round4(mu));
            taus.push(tau);
        }
    }
    if !taus.is_empty() {
        let tau = (taus.iter().map(|t| t * t).sum::<f64>() / taus.len() as f64).sqrt();
        for m in MODES {
            if se["modes"][m].is_array() {
                se["modes"][m][1] = json!(round4(tau));
            }
        }
        log.push(format!("between-run τ {tau:.2} (pooled)"));
    }
    for m in MODES {
        let ws: Vec<(f64, f64)> = of(m).iter().filter_map(|r| r.window).collect();
        if se["disp"][m].is_array()
            && let Some((mu, sg, eps)) = disp_mixture(m, &ws, u_max)
        {
            se["disp"][m] = json!([round4(mu), round4(sg), round4(eps)]);
            log.push(format!(
                "disp {m}: μ {mu:.3} σ {sg:.3} ε {eps:.4} ({} runs)",
                ws.len()
            ));
        }
        let (mut c, mut cls) = ([[0.0f64; 2]; 2], vec![vec![0.0f64; 3]; 3]);
        for r in of(m) {
            for w in r.inner.windows(2) {
                c[usize::from(w[0].lit)][usize::from(w[1].lit)] += 1.0;
                cls[w[0].cls][w[1].cls] += 1.0;
            }
        }
        if se["fixMarkov"][m].is_array() && c[1][0] + c[1][1] > 0.0 && c[0][0] + c[0][1] > 0.0 {
            let p11 = c[1][1] / (c[1][0] + c[1][1]);
            let p01 = c[0][1] / (c[0][0] + c[0][1]);
            se["fixMarkov"][m] = json!([round4(p11), round4(p01)]);
        }
        if se["obsChain"][m].is_array() && cls.iter().flatten().sum::<f64>() >= MIN_N as f64 {
            se["obsChain"][m] = json!(chain_rows(&cls));
        }
    }
    let nights: Vec<Vec<Option<f64>>> =
        used.iter().flat_map(|d| d.nights.iter().cloned()).collect();
    if let Some((mu, tau, sw, rho)) = hr_effect(&nights) {
        se["asleep"] = json!([round4(mu), round4(tau), round4(sw), round4(rho)]);
        log.push(format!(
            "asleep: {mu:.1} bpm, τ {tau:.2}, σw {sw:.2}, ρ {rho:.3} ({} nights)",
            nights.len()
        ));
    }
    let dists: Vec<f64> = used
        .iter()
        .flat_map(|d| d.stay_dist.iter().copied())
        .collect();
    let far: Vec<f64> = dists
        .iter()
        .copied()
        .filter(|d| *d > PLACE_RADIUS_M)
        .collect();
    if !far.is_empty() && se["unlistedCentre"].is_number() {
        let h = (far.iter().map(|d| d * d).sum::<f64>() / far.len() as f64).sqrt();
        se["unlistedCentre"] = json!(h.round());
        log.push(format!(
            "unlisted stays: {} of {} beyond {PLACE_RADIUS_M} m, bandwidth {h:.0} m",
            far.len(),
            dists.len()
        ));
    }

    // Transitions.
    let mut tf = form.files["transition-fit"].clone();
    let mut counts: BTreeMap<(&str, &str), f64> = BTreeMap::new();
    for d in &used {
        for &(a, b) in &d.changes {
            *counts.entry((a, b)).or_default() += 1.0;
        }
    }
    for a in MODES {
        let total: f64 = MODES
            .iter()
            .map(|b| counts.get(&(a, *b)).unwrap_or(&0.0) + 1.0)
            .sum();
        for b in MODES {
            tf[a][b] =
                json!(((counts.get(&(a, b)).unwrap_or(&0.0) + 1.0) / total * 1e5).round() / 1e5);
        }
    }
    log.push(format!(
        "transitions: {} mode changes",
        counts.values().sum::<f64>()
    ));

    // Entry counts.
    let mut ec = form.files["entry-counts"].clone();
    if !dists.is_empty() {
        ec["newShare"] = json!(round4(far.len() as f64 / dists.len() as f64));
    }

    // Speed priors: the windowed speed per mode; a vehicle's as stopped-or-moving.
    let mut sp = form.files["speed-priors"].clone();
    let speeds_where = |rs: &[&Run], keep: &dyn Fn(&Minute) -> bool| -> Vec<f64> {
        rs.iter()
            .flat_map(|r| {
                r.inner
                    .iter()
                    .filter(|m| keep(m))
                    .filter_map(|m| m.window_kmh)
            })
            .collect()
    };
    let speeds = |rs: &[&Run]| speeds_where(rs, &|_| true);
    for m in ["stationary", "walking"] {
        let xs = speeds(&of(m));
        if xs.len() >= MIN_N && sp["modePriors"][m].is_array() {
            let (mu, sd) = mean_std(&xs);
            sp["modePriors"][m][1] = json!(round4(mu));
            sp["modePriors"][m][2] = json!(round4(sd.max(1.0)));
            log.push(format!(
                "speed {m}: {mu:.2} ± {sd:.2} km/h ({} min)",
                xs.len()
            ));
        }
    }
    // A stopped vehicle reads as a stay does: a minute under the stays' 95th
    // percentile of windowed speed. (A free mixture fitted by EM puts the
    // standstill's spread at 2 km/h on the Tube, and a train then takes the
    // slow platform minutes: lines −3, stations −3 against this definition.)
    let stop_cut = {
        let mut st = speeds(&of("stationary"));
        st.sort_by(f64::total_cmp);
        st.get(st.len() * STAY_QUANTILE_PCT / 100)
            .copied()
            .unwrap_or(0.0)
    };
    log.push(format!(
        "a stop: under {stop_cut:.2} km/h (the stays' 95th percentile)"
    ));
    let trains = of("train");
    for (key, xs) in [
        ("driving", speeds(&of("driving"))),
        ("train", speeds_where(&trains, &|m| m.covered)),
        ("mainline", speeds_where(&trains, &|m| !m.covered)),
    ] {
        if xs.len() < MIN_N {
            continue;
        }
        let (pi, sstop, mu, sd) = stop_split(&xs, stop_cut);
        if key == "mainline" {
            sp["mainlineSpeed"] = json!([round4(mu), round4(sd)]);
        } else {
            sp["modePriors"][key][1] = json!(round4(mu));
            sp["modePriors"][key][2] = json!(round4(sd));
        }
        sp["speedStop"][key] = json!([round4(pi), round4(sstop)]);
        log.push(format!(
            "speed {key}: stopped {:.0}% (σ {sstop:.2}), moving {mu:.1} ± {sd:.1} km/h ({} min)",
            100.0 * pi,
            xs.len()
        ));
    }
    // A train run is the mainline's when most of its minutes are off the route
    // model (the decoder can only call those `unknown_rail`); its length is
    // fitted apart: a TGV and a Tube hop are not one distribution.
    let mainline_run = |r: &Run| {
        let off = r.inner.iter().filter(|m| !m.covered).count();
        2 * off > r.inner.len()
    };
    let lengths = |rs: Vec<&Run>| -> Vec<f64> {
        rs.iter()
            .map(|r| r.minutes_long)
            .filter(|l| *l > 0.0)
            .collect()
    };
    let mut groups: Vec<(&str, Vec<f64>)> = MODES
        .iter()
        .filter(|m| **m != "train")
        .map(|m| (*m, lengths(of(m))))
        .collect();
    groups.push((
        "train",
        lengths(
            trains
                .iter()
                .copied()
                .filter(|r| !mainline_run(r))
                .collect(),
        ),
    ));
    groups.push((
        "mainline",
        lengths(trains.iter().copied().filter(|r| mainline_run(r)).collect()),
    ));
    for (m, ls) in groups {
        if ls.len() >= MIN_RUNS && (sp["durationFits"][m].is_array() || m == "mainline") {
            let n = ls.len() as f64;
            let mean = ls.iter().sum::<f64>() / n;
            let var =
                (ls.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / n).max(DUR_VAR_FLOOR);
            sp["durationFits"][m] =
                json!([round4(mean * mean / var), (mean / var * 1e5).round() / 1e5]);
            log.push(format!(
                "duration {m}: {} runs, mean {mean:.1} min, sd {:.1}",
                ls.len(),
                var.sqrt()
            ));
        }
    }

    std::fs::create_dir_all(dir)?;
    for (f, v) in [
        ("segment-emission", &se),
        ("transition-fit", &tf),
        ("entry-counts", &ec),
        ("speed-priors", &sp),
    ] {
        std::fs::write(format!("{dir}/{f}.json"), serde_json::to_string_pretty(v)?)?;
    }
    // The one record (`backend::decoder_params`): the four, the form's settings,
    // and which days the numbers came from.
    let mut record = form.decoder.clone();
    record["segEmission"] = se.clone();
    record["transFit"] = tf.clone();
    record["entryCounts"] = ec.clone();
    record["fittedPriors"] = sp.clone();
    record["provenance"] = json!({
        "fitter": "examples/fit_emissions",
        "days": days.keys().filter(|d| !exclude.contains(d)).collect::<Vec<_>>(),
        "heldOut": exclude,
    });
    // ONE LINE: the record travels as an environment value, and
    // `scripts/prod-db.sh` mirrors the pod's environment line by line.
    std::fs::write(
        format!("{dir}/{RECORD}.json"),
        serde_json::to_string(&record)?,
    )?;
    if verbose {
        for l in &log {
            eprintln!("{l}");
        }
        eprintln!(
            "{} narrated day(s) in the fit, {} runs",
            used.len(),
            runs.len()
        );
    }
    Ok(())
}
