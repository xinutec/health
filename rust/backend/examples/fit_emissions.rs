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
//! `centreAnchor`, …), the outlier range, the pseudo-counts, and
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
/// The narrated platform waits are few (a stationary row with no place after a
/// walk and before a ride); this many fit the wait's duration, with the count
/// logged.
const MIN_WAITS: usize = 3;
/// A run's heart rate enters the between-run spread from this many minutes.
const MIN_RUN_HR: usize = 5;
/// The duration fit's variance floor.
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
    /// The one-minute span to the next minute (the pair tables).
    pair_kmh: Option<f64>,
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
    /// Each lit stay minute's squared distance from its stay's centre and its
    /// fix's squared reported accuracy, metres² (`fitCentreSigma`).
    stay_scatter: Vec<(f64, f64)>,
    /// The one-minute span across each boundary between adjacent runs, km/h.
    boundary: Vec<f64>,
    /// The same spans with the modes either side.
    boundary_by: Vec<(&'static str, &'static str, f64)>,
    /// Each narrated platform wait's length, minutes: a stationary row with no
    /// place after a walk and before a ride (`durationFits.wait`). A pause
    /// between two walks is the placeless stay's, not the platform's.
    waits: Vec<f64>,
    /// Each pass of a station inside a narrated ride, its slowest minute's
    /// speed (km/h) and whether the ride's line calls there (`journey.stops`).
    stops: Vec<(f64, bool)>,
    /// Each narrated ride's start on a covered minute: whether the generator
    /// vouches its line there (`trainLine`).
    line_vouched: Vec<bool>,
    /// The narrated legs' first minutes counted `[train and covered, train and
    /// not, other and covered, other and not]` (`trainLine`'s coverage terms).
    coverage: [f64; 4],
}

/// EM for the calling evidence: each pass's slowest-minute speed is stopped
/// (exponential) or moving (Gaussian), the stopped share by class. A share is
/// read by the rule of succession, as every share of a count in the record:
/// the calling class's EM share alone reaches 1, which would make a calling
/// station passed at speed impossible. Started from the pooled median split.
fn fit_stops(xs: &[(f64, bool)]) -> [f64; 5] {
    let mut sorted: Vec<f64> = xs.iter().map(|x| x.0).collect();
    sorted.sort_by(f64::total_cmp);
    let med = sorted[sorted.len() / 2];
    let (lo, hi): (Vec<f64>, Vec<f64>) = sorted.iter().partition(|&&v| v < med);
    let mean_of = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
    let (mut pc, mut pt) = (0.5, 0.5);
    let mut rate = 1.0 / mean_of(&lo).max(f64::MIN_POSITIVE);
    let mut mean = mean_of(&hi);
    let mut sd =
        (hi.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / hi.len().max(1) as f64).sqrt();
    let nc = xs.iter().filter(|x| x.1).count() as f64;
    let nt = xs.len() as f64 - nc;
    for _ in 0..500 {
        let f0 = |v: f64| rate * (-rate * v).exp();
        let f1 = |v: f64| {
            (-0.5 * ((v - mean) / sd).powi(2)).exp() / (sd * (2.0 * std::f64::consts::PI).sqrt())
        };
        let r: Vec<f64> = xs
            .iter()
            .map(|&(v, c)| {
                let pi = if c { pc } else { pt };
                let (a, b) = (pi * f0(v), (1.0 - pi) * f1(v));
                if a + b > 0.0 { a / (a + b) } else { 0.0 }
            })
            .collect();
        let sum_c: f64 = xs.iter().zip(&r).filter(|(x, _)| x.1).map(|(_, r)| r).sum();
        let sum_t: f64 = xs
            .iter()
            .zip(&r)
            .filter(|(x, _)| !x.1)
            .map(|(_, r)| r)
            .sum();
        pc = (sum_c + 1.0) / (nc + 2.0);
        pt = (sum_t + 1.0) / (nt + 2.0);
        let rs: f64 = r.iter().sum();
        rate = rs / xs.iter().zip(&r).map(|(x, r)| r * x.0).sum::<f64>();
        let w: f64 = r.iter().map(|r| 1.0 - r).sum();
        mean = xs.iter().zip(&r).map(|(x, r)| (1.0 - r) * x.0).sum::<f64>() / w;
        sd = (xs
            .iter()
            .zip(&r)
            .map(|(x, r)| (1.0 - r) * (x.0 - mean).powi(2))
            .sum::<f64>()
            / w)
            .sqrt();
    }
    [pc, pt, rate, mean, sd]
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
        /// The place the row names (a stay). A stationary row before a ride
        /// with no place, or whose place is that ride's board station, is a
        /// platform wait.
        place: Option<String>,
        /// A ride: the row's own mode is train or bus (the decoder's `driving`
        /// covers a bus; a wait is for a timetable, not a cab).
        ride: bool,
        /// A ride's narrated line and stations, for its passes (`journey.stops`).
        line: Option<String>,
        from: Option<String>,
        to: Option<String>,
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
                    place: row["truth"]["place"].as_str().map(str::to_owned),
                    ride: matches!(tm, "train" | "bus"),
                    line: row["truth"]["lineName"].as_str().map(str::to_owned),
                    from: row["truth"]["from"].as_str().map(str::to_owned),
                    to: row["truth"]["to"].as_str().map(str::to_owned),
                    s,
                    e,
                })
            }
            _ => None,
        });
    }
    // The platform waits: a stationary row before a ride, after a walk or the
    // ride before (a change), with no place or the ride's board station as its
    // place (several names ` / ` apart match any).
    let walk_or_ride =
        |r: &Option<Row>| -> bool { matches!(r, Some(r) if r.mode == Some("walking") || r.ride) };
    let ride = |r: &Option<Row>| -> bool { matches!(r, Some(r) if r.ride) };
    let at_board = |r: &Row, next: &Option<Row>| -> bool {
        match (&r.place, next) {
            (None, _) => true,
            (Some(p), Some(n)) => n.from.as_deref().is_some_and(|f| {
                p.split(" / ")
                    .any(|alt| alt.trim().eq_ignore_ascii_case(f.trim()))
            }),
            _ => false,
        }
    };
    let waits: Vec<f64> = (1..rows.len().saturating_sub(1))
        .filter_map(|i| match &rows[i] {
            Some(r)
                if r.mode == Some("stationary")
                    && !r.sleeping
                    && walk_or_ride(&rows[i - 1])
                    && ride(&rows[i + 1])
                    && at_board(r, &rows[i + 1]) =>
            {
                Some((r.e - r.s) as f64 / 60.0)
            }
            _ => None,
        })
        .collect();
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
        pair_kmh: r["pairKmh"].as_f64(),
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

    // The stations each narrated ride passes wholly inside it, its board and
    // alight stations left out: the decoder's `StationStops.passes`, as its
    // leg cell reads them.
    let same = |a: &str, b: &str| a.trim().eq_ignore_ascii_case(b.trim());
    let mut stops = Vec::new();
    for r in rows.iter().flatten().filter(|r| r.ride) {
        let Some(line) = &r.line else { continue };
        for p in out["stationPasses"].as_array().into_iter().flatten() {
            let (Some(first), Some(last), Some(v), Some(st)) = (
                p["firstTs"].as_i64(),
                p["lastTs"].as_i64(),
                p["speedKmh"].as_f64(),
                p["station"].as_str(),
            ) else {
                continue;
            };
            // Wholly inside the ride, after its first minute and before its
            // last, as the leg cell reads a pass (`Journey.stopTerm`).
            if first <= r.s || last >= r.e - 60 {
                continue;
            }
            if [&r.from, &r.to]
                .iter()
                .any(|x| x.as_deref().is_some_and(|x| same(x, st)))
            {
                continue;
            }
            let calls = p["calls"]
                .as_array()
                .is_some_and(|a| a.iter().any(|l| l.as_str().is_some_and(|l| same(l, line))));
            stops.push((v, calls));
        }
    }
    let mut line_vouched = Vec::new();
    for r in rows.iter().flatten().filter(|r| r.mode == Some("train")) {
        let Some(line) = &r.line else { continue };
        let Some(m) = by_ts.get(&(r.s - r.s.rem_euclid(60))) else {
            continue;
        };
        if m["covered"].as_bool() != Some(true) {
            continue;
        }
        line_vouched.push(
            m["linesAt"]
                .as_array()
                .is_some_and(|a| a.iter().any(|l| l.as_str().is_some_and(|l| same(l, line)))),
        );
    }
    let mut coverage = [0.0; 4];
    for r in rows.iter().flatten() {
        let Some(mode) = r.mode else { continue };
        {
            let Some(m) = by_ts.get(&(r.s - r.s.rem_euclid(60))) else {
                continue;
            };
            let cov = m["covered"].as_bool() == Some(true);
            coverage[match (mode == "train", cov) {
                (true, true) => 0,
                (true, false) => 1,
                (false, true) => 2,
                (false, false) => 3,
            }] += 1.0;
        }
    }
    let mut day = Day {
        waits,
        stops,
        line_vouched,
        coverage,
        ..Default::default()
    };
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
            if let Some(v) = by_ts.get(&(s - 60)).and_then(|r| r["pairKmh"].as_f64()) {
                day.boundary.push(v);
                day.boundary_by.push((spans[i - 1].0, mode, v));
            }
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
            // The scatter about the stay's own centre, with each fix's accuracy.
            let acc: Vec<f64> = (0..)
                .map(|k| r.s + 60 * k)
                .take_while(|t| *t < r.e)
                .filter_map(|t| by_ts.get(&t))
                .filter(|m| m["lat"].as_f64().is_some())
                .map(|m| m["accuracyM"].as_f64().unwrap_or(ACCURACY_DEFAULT_M))
                .collect();
            if fixes.len() >= MIN_STAY_FIXES {
                let n = fixes.len() as f64;
                let c = (
                    fixes.iter().map(|f| f.0).sum::<f64>() / n,
                    fixes.iter().map(|f| f.1).sum::<f64>() / n,
                );
                for (f, a) in fixes.iter().zip(&acc) {
                    let d = metres(c, *f);
                    day.stay_scatter.push((d * d, a * a));
                }
            }
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
    /// `decoder-form.json`: the record's settings no day fits (`maxD`, which
    /// fits the form takes).
    decoder: Value,
    /// `decoder-form.json`'s `poolUnobservedModes`: a mode no narrated minute
    /// reaches takes the pooled chains.
    pool_unobserved: bool,
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
        let decoder: Value = serde_json::from_str(&std::fs::read_to_string(&path).context(path)?)?;
        let pool_unobserved = decoder["poolUnobservedModes"].as_bool().unwrap_or(false);
        Ok(Form {
            files,
            decoder,
            pool_unobserved,
        })
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

/// The search range for a stay's position spread, metres.
const CENTRE_SIGMA_MIN_M: u16 = 5;
const CENTRE_SIGMA_MAX_M: u16 = 300;
/// A fix with no reported accuracy carries the decoder's default.
const ACCURACY_DEFAULT_M: f64 = 10.0;

/// EM steps for the outlier fits.
const EM_STEPS: usize = 100;

fn normal_pdf(x: f64, mu: f64, sd: f64) -> f64 {
    let z = (x - mu) / sd;
    (-0.5 * z * z).exp() / (sd * (2.0 * std::f64::consts::PI).sqrt())
}

/// The outlier share `ε` of `xs` against the density `f`, uniform over
/// 0–`u_max` beside it, by EM. Returns `(ε, responsibilities)`.
fn outlier_share(xs: &[f64], u_max: f64, f: &dyn Fn(f64) -> f64) -> (f64, Vec<f64>) {
    let mut eps = 0.01;
    let mut r = vec![0.0; xs.len()];
    for _ in 0..EM_STEPS {
        for (ri, &x) in r.iter_mut().zip(xs) {
            let o = eps / u_max;
            *ri = o / (o + (1.0 - eps) * f(x));
        }
        eps = (r.iter().sum::<f64>() / xs.len() as f64).clamp(1e-6, 0.5);
    }
    (eps, r)
}

/// A Gaussian with an outlier share uniform over 0–`u_max`, by EM: `(μ, σ, ε)`.
fn robust_gauss(xs: &[f64], u_max: f64, sd_floor: f64) -> (f64, f64, f64) {
    let (mut mu, mut sd) = mean_std(xs);
    sd = sd.max(sd_floor);
    let mut eps = 0.01;
    for _ in 0..EM_STEPS {
        let (e, r) = outlier_share(xs, u_max, &|x| normal_pdf(x, mu, sd));
        eps = e;
        let w: f64 = r.iter().map(|ri| 1.0 - ri).sum();
        mu = xs.iter().zip(&r).map(|(x, ri)| (1.0 - ri) * x).sum::<f64>() / w;
        let var = xs
            .iter()
            .zip(&r)
            .map(|(x, ri)| (1.0 - ri) * (x - mu) * (x - mu))
            .sum::<f64>()
            / w;
        sd = var.sqrt().max(sd_floor);
    }
    (mu, sd, eps)
}

/// An exponential with an outlier share uniform over 0–`u_max`, by EM: `(mean, ε)`.
fn robust_exp(xs: &[f64], u_max: f64) -> (f64, f64) {
    let mut m = xs.iter().sum::<f64>() / xs.len() as f64;
    let mut eps = 0.01;
    for _ in 0..EM_STEPS {
        let (e, r) = outlier_share(xs, u_max, &|x| (-x / m).exp() / m);
        eps = e;
        let w: f64 = r.iter().map(|ri| 1.0 - ri).sum();
        m = xs.iter().zip(&r).map(|(x, ri)| (1.0 - ri) * x).sum::<f64>() / w;
    }
    (m, eps)
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
/// over `0–uMax` km/h — `SegmentEmission.dispScoreWith`'s form, by EM.
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
    // `STOPS_DUMP=<file>`: the station passes inside narrated rides, one
    // `[speedKmh, calls]` per line, for reading the population.
    if verbose && let Ok(path) = std::env::var("STOPS_DUMP") {
        let rows: Vec<String> = used
            .iter()
            .flat_map(|d| d.stops.iter())
            .map(|(v, c)| format!("[{v}, {c}]"))
            .collect();
        std::fs::write(&path, rows.join("\n"))?;
    }

    // Segment emission.
    let mut se = form.files["segment-emission"].clone();
    let u_max = se["uMaxKmh"].as_f64().unwrap_or(300.0);
    // With `fitStops`, a train's calling evidence (`StopCalls`): the narrated
    // rides' station passes as one stopped-or-moving mixture with a calling
    // and a through share, by EM.
    if form.decoder["fitStops"].as_bool() == Some(true) {
        let xs: Vec<(f64, bool)> = used.iter().flat_map(|d| d.stops.iter().copied()).collect();
        let nc = xs.iter().filter(|x| x.1).count();
        if nc >= MIN_N && xs.len() - nc >= MIN_N {
            let p = fit_stops(&xs);
            se["journey"]["stops"] = json!({
                "piCall": round4(p[0]), "piThrough": round4(p[1]), "rate": round4(p[2]),
                "mean": round4(p[3]), "sd": round4(p[4]),
            });
            log.push(format!(
                "stops: {nc} calling and {} through passes; stopped share {:.3} calling, {:.3} through; stopped rate {:.4}/kmh, moving {:.1} ± {:.1} km/h",
                xs.len() - nc, p[0], p[1], p[2], p[3], p[4]
            ));
        }
    }
    // With `fitTrainLine`, the share of a narrated ride's start, on a covered
    // minute, that the generator's vouched lines take: whether it vouches the
    // ride's own line there, by the rule of succession.
    if form.decoder["fitTrainLine"].as_bool() == Some(true) {
        let xs: Vec<bool> = used
            .iter()
            .flat_map(|d| d.line_vouched.iter().copied())
            .collect();
        if xs.len() >= MIN_N {
            let k = xs.iter().filter(|x| **x).count();
            let q = (k as f64 + 1.0) / (xs.len() as f64 + 2.0);
            let n = used.iter().fold([0.0; 4], |mut a, d| {
                for (x, y) in a.iter_mut().zip(d.coverage) {
                    *x += y;
                }
                a
            });
            let share = |k: f64, of: f64| (k + 1.0) / (of + 2.0);
            let (tr, ot) = (n[0] + n[1], n[2] + n[3]);
            let covered = (share(n[0], tr) / share(n[2], ot)).ln();
            let uncovered = (share(n[1], tr) / share(n[3], ot)).ln();
            se["trainLine"] = json!({
                "vouchedShare": round4(q), "covered": round4(covered), "uncovered": round4(uncovered),
            });
            log.push(format!(
                "train line: {k} of {} narrated starts vouched; share {q:.4}; coverage {} of {tr} train starts, {} of {ot} others: covered {covered:+.3}, uncovered {uncovered:+.3}",
                xs.len(), n[0], n[2]
            ));
        }
    }
    // With `fitCentreSigma`, a stay's fixes scatter about its centre as a 2-D
    // Gaussian of variance σ² + the fix's accuracy² per axis: σ by maximum
    // likelihood over every narrated stay's lit minutes (the centre score's
    // `withPositions` weight, hand-set at `PLACE_RADIUS_M` without it).
    if form.decoder["fitCentreSigma"].as_bool() == Some(true) {
        let pts: Vec<(f64, f64)> = used
            .iter()
            .flat_map(|d| d.stay_scatter.iter().copied())
            .collect();
        if pts.len() >= MIN_N {
            let ll = |s: f64| -> f64 {
                pts.iter()
                    .map(|(d2, a2)| {
                        let v = s * s + a2;
                        -(2.0 * std::f64::consts::PI * v).ln() - d2 / (2.0 * v)
                    })
                    .sum()
            };
            let sigma = (CENTRE_SIGMA_MIN_M..=CENTRE_SIGMA_MAX_M)
                .map(f64::from)
                .max_by(|a, b| ll(*a).total_cmp(&ll(*b)))
                .unwrap_or(f64::from(CENTRE_SIGMA_MAX_M));
            se["centreSigmaM"] = json!(sigma);
            log.push(format!("stay scatter: σ {sigma} m ({} minutes)", pts.len()));
        }
    }
    // The span across a boundary by the modes either side (measurement only).
    {
        let mut by: BTreeMap<(String, String), Vec<f64>> = BTreeMap::new();
        for d in &used {
            for (a, b, v) in &d.boundary_by {
                let key = if a < b {
                    (a.to_string(), b.to_string())
                } else {
                    (b.to_string(), a.to_string())
                };
                by.entry(key).or_default().push(*v);
            }
        }
        for ((a, b), mut vs) in by {
            vs.sort_by(f64::total_cmp);
            let n = vs.len();
            let mean = vs.iter().sum::<f64>() / n as f64;
            let fast = vs.iter().filter(|v| **v > 20.0).count();
            log.push(format!(
                "boundary {a}–{b}: {n} spans, mean {mean:.1} km/h, median {:.1}, over 20 km/h {fast}",
                vs[n / 2]
            ));
        }
    }
    // The span across a boundary: exponential, its mean the narrated
    // boundaries'.
    {
        let b: Vec<f64> = used
            .iter()
            .flat_map(|d| d.boundary.iter().copied())
            .collect();
        if b.len() >= MIN_N {
            let (mean, eps) = robust_exp(&b, u_max);
            se["pairBoundaryMeanKmh"] = json!(round4(mean));
            se["pairBoundaryEps"] = json!(round4(eps));
            log.push(format!(
                "boundary pairs: {} spans, mean {mean:.2} km/h, outliers {:.2}%",
                b.len(),
                100.0 * eps
            ));
        }
    }
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
        let mut cls = vec![vec![0.0f64; 3]; 3];
        for r in of(m) {
            for w in r.inner.windows(2) {
                cls[w[0].cls][w[1].cls] += 1.0;
            }
        }
        if se["obsChain"][m].is_array() && cls.iter().flatten().sum::<f64>() >= MIN_N as f64 {
            se["obsChain"][m] = json!(chain_rows(&cls));
        }
    }
    // A mode no narrated minute reaches (cycling, a plane) takes the chains
    // pooled over every narrated minute: the population is the honest prior for
    // a mode with no data of its own. Without them it paid nothing for where
    // its fixes fall, so a train's tail along the tracks read as a bicycle.
    if form.pool_unobserved {
        let mut cls = vec![vec![0.0f64; 3]; 3];
        for r in &runs {
            for w in r.inner.windows(2) {
                cls[w[0].cls][w[1].cls] += 1.0;
            }
        }
        for m in MODES {
            if !se["obsChain"][m].is_array() {
                se["obsChain"][m] = json!(chain_rows(&cls));
            }
        }
        log.push("pooled chains for the modes with no narrated minutes".into());
    }
    let nights: Vec<Vec<Option<f64>>> =
        used.iter().flat_map(|d| d.nights.iter().cloned()).collect();
    if let Some((mu, tau, sw, rho)) = hr_effect(&nights) {
        // The night's level drifts: the fifth number is the spread of the
        // lag-1 differences between consecutive in-bed minutes, the draw each
        // difference is under `SleepParams.diffSd`.
        let (mut dsq, mut dn) = (0.0f64, 0usize);
        for night in &nights {
            for w in night.windows(2) {
                if let (Some(a), Some(b)) = (w[0], w[1]) {
                    dsq += (b - a) * (b - a);
                    dn += 1;
                }
            }
        }
        let diff_sd = if dn > 0 {
            (dsq / dn as f64).sqrt()
        } else {
            0.0
        };
        se["asleep"] = json!([
            round4(mu),
            round4(tau),
            round4(sw),
            round4(rho),
            round4(diff_sd)
        ]);
        log.push(format!(
            "asleep: {mu:.1} bpm, τ {tau:.2}, σw {sw:.2}, ρ {rho:.3}, lag-1 spread {diff_sd:.3} over {dn} pairs ({} nights)",
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
    // The decoder scores the span from each minute to the next inside a
    // segment; an inner minute's next is inside the row too.
    let speeds_where = |rs: &[&Run], keep: &dyn Fn(&Minute) -> bool| -> Vec<f64> {
        rs.iter()
            .flat_map(|r| {
                r.inner
                    .iter()
                    .filter(|m| keep(m))
                    .filter_map(|m| m.pair_kmh)
            })
            .collect()
    };
    let speeds = |rs: &[&Run]| speeds_where(rs, &|_| true);
    for m in ["stationary", "walking"] {
        let xs = speeds(&of(m));
        if xs.len() >= MIN_N && sp["modePriors"][m].is_array() {
            // A fix that jumped is an outlier share, not spread.
            let (mu, sd, eps) = robust_gauss(&xs, u_max, 1.0);
            sp["modePriors"][m][1] = json!(round4(mu));
            sp["modePriors"][m][2] = json!(round4(sd));
            se["speedEps"][m] = json!(round4(eps));
            log.push(format!(
                "speed {m}: {mu:.2} ± {sd:.2} km/h, outliers {:.2}% ({} min)",
                100.0 * eps,
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
        if key != "mainline" {
            let f = |x: f64| (1.0 - pi) * normal_pdf(x, mu, sd) + pi * normal_pdf(x, 0.0, sstop);
            let (eps, _) = outlier_share(&xs, u_max, &f);
            se["speedEps"][key] = json!(round4(eps));
            log.push(format!("speed {key}: outliers {:.2}%", 100.0 * eps));
        }
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
    groups.push((
        "wait",
        used.iter().flat_map(|d| d.waits.iter().copied()).collect(),
    ));
    for (m, ls) in groups {
        let enough = if m == "wait" {
            ls.len() >= MIN_WAITS
        } else {
            ls.len() >= MIN_RUNS
        };
        if enough && (sp["durationFits"][m].is_array() || m == "mainline" || m == "wait") {
            let n = ls.len() as f64;
            let mean = ls.iter().sum::<f64>() / n;
            let var =
                (ls.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / n).max(DUR_VAR_FLOOR);
            // The wait carries its floor: the shortest narrated wait, whole
            // minutes. The narrator folds a shorter pause into the walk, which a
            // Gamma by moments from a handful of rows cannot say by itself.
            sp["durationFits"][m] = if m == "wait" {
                let floor = ls.iter().copied().fold(f64::INFINITY, f64::min).floor();
                json!([
                    round4(mean * mean / var),
                    (mean / var * 1e5).round() / 1e5,
                    floor
                ])
            } else {
                json!([round4(mean * mean / var), (mean / var * 1e5).round() / 1e5])
            };
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
