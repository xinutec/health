//! Run the REAL segment classifier over a slice of one golden day (#185).
//!
//! ⚠ **IT EXISTS BECAUSE NOTHING ELSE REACHES THESE POINTS.** The chain is
//! `raw fixes → gpsquality → snapToPlace → kalman → classifySegments → segsRaw`,
//! and every surface that existed showed `segsRaw` — the fold's input, AFTER the
//! classifier. `backend head` prints the capture; `dump_day_request` prints the
//! fold request; both begin one stage too late. So "why did the classifier not
//! see this dwell" could only be answered by reasoning about what it PROBABLY
//! computed, and on 2026-09-21 five such answers in a row were wrong — duration,
//! step rate, spatial spread, window alignment, GPS cadence — while the two
//! questions put to the real code were answered immediately.
//!
//! `head::run` already computes the Kalman-smoothed points and hands them back;
//! this slices them by time and calls `head::classify_segments` on the slice.
//! Same classifier, same points, fewer of them.
//!
//! ```text
//! cargo run --example classify_window -- 2026-06-24-pippijn 18:40 19:10
//! cargo run --example classify_window -- 2026-06-24-pippijn          # whole day
//! ```
//!
//! ⚠ **A SLICE IS NOT A SUB-DAY.** `extractFeatures` tumbles its 300 s windows
//! from the FIRST point it is given, so slicing moves every window boundary
//! after it. That is the instrument's point — sweeping the slice is how the
//! boundary's effect is measured — but it means a slice's segments are not
//! "what the day would have said about this stretch".
//!
//! ⚠ EXIT 2 when the corpus is absent, as `dump_day_request` does: the fixtures
//! are gitignored, so their absence is the ordinary case off this machine.

use anyhow::{Context, Result};

fn hhmm(ts: i64) -> String {
    let secs = ts.rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// `HH:MM` on the fixture's own UTC day.
fn at(day_start: i64, s: &str) -> Result<i64> {
    let (h, m) = s.split_once(':').context("time must be HH:MM")?;
    Ok(day_start + h.parse::<i64>()? * 3600 + m.parse::<i64>()? * 60)
}

/// The stationary segments short enough to be an errand.
///
/// ⚠ SHORT ONES ONLY. A day at home is stationary at every phase and would
/// drown the signal; the claim is about dwells of roughly one window.
fn short_stays(segs: &[serde_json::Value]) -> Vec<Dwell> {
    segs.iter()
        .filter(|s| s["mode"] == "stationary")
        .filter_map(|s| Some((s["startTs"].as_i64()?, s["endTs"].as_i64()?)))
        .filter(|(a, b)| b - a < 15 * 60)
        .collect()
}

/// A dwell, as `(startTs, endTs)`.
type Dwell = (i64, i64);

/// Two phases naming the same dwell differ by seconds, not minutes.
fn near(a: &Dwell, b: &Dwell) -> bool {
    (a.0 - b.0).abs() < 150
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(name) = args.first() else {
        eprintln!("usage: classify_window <DAY> [FROM_HH:MM TO_HH:MM] [--sweep N]");
        std::process::exit(64);
    };
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    let path = format!("{root}/{name}.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("classify_window: no fixture at {path} — the golden corpus is gitignored.");
        std::process::exit(2);
    };
    let fx: serde_json::Value = serde_json::from_str(&text).context("fixture is not JSON")?;
    let date = fx["meta"]["date"]
        .as_str()
        .context("fixture has no meta.date")?;

    backend::lean::init()?;
    let head = backend::head::run(&fx["inputs"], date).context("running the head")?;

    // ⚠ `--sweep N` RE-PHASES, dropping the first k points of each run for k in
    // 0..N. That is the only handle on the tumble origin from outside
    // `extractFeatures`, and it reports the dwells findable at SOME phase but
    // not at the one the day actually has (#1694).
    //
    // ⚠ **ONE SWEEP PER RUN.** `extractLoop` starts each window at the first
    // point NOT YET CONSUMED, so a gap longer than a window RE-ANCHORS the
    // grid. Re-phasing from the day's start therefore says nothing past the
    // first gap: on 2026-06-24 a 123-minute gap (16:30:43 -> 18:33:48) anchors
    // the whole evening on the instant he left the house, and a day-wide sweep
    // moved nothing after it.
    if let Some(n) = args
        .iter()
        .position(|a| a == "--sweep")
        .and_then(|i| args.get(i + 1))
    {
        let n: usize = n.parse().context("--sweep takes a count")?;
        let mut runs: Vec<Vec<backend::head::Smoothed>> = vec![Vec::new()];
        for p in &head.points {
            if let Some(last) = runs.last().and_then(|r| r.last())
                && p.ts - last.ts > 300
            {
                runs.push(Vec::new());
            }
            runs.last_mut().expect("a run is open").push(*p);
        }

        let (mut base, mut extra): (Vec<Dwell>, Vec<Dwell>) = (vec![], vec![]);
        for run in &runs {
            for k in 0..n {
                if run.len() <= k + 2 {
                    break;
                }
                for w in short_stays(&backend::head::classify_segments(&run[k..], None)?) {
                    if k == 0 {
                        base.push(w);
                    } else if !base.iter().any(|b| near(&w, b))
                        // ⚠ AND AGAINST ITSELF, or the same dwell is counted
                        // once per phase that happens to find it.
                        && !extra.iter().any(|e| near(&w, e))
                    {
                        extra.push(w);
                    }
                }
            }
        }
        println!(
            "{name}\town-phase {}\tmissed-by-phase {}\truns {}",
            base.len(),
            extra.len(),
            runs.len()
        );
        for w in &extra {
            println!("   missed by phase:  {}-{}", hhmm(w.0), hhmm(w.1));
        }
        return Ok(());
    }

    // The fixture's UTC midnight, from its own first point rather than a parse.
    let day_start = head
        .points
        .first()
        .map_or(0, |p| p.ts - p.ts.rem_euclid(86_400));
    let (from, to) = match (args.get(1), args.get(2)) {
        (Some(a), Some(b)) => (at(day_start, a)?, at(day_start, b)?),
        _ => (i64::MIN, i64::MAX),
    };
    let slice: Vec<_> = head
        .points
        .iter()
        .filter(|p| p.ts >= from && p.ts <= to)
        .cloned()
        .collect();
    eprintln!("{} of {} point(s)", slice.len(), head.points.len());
    if slice.len() < 2 {
        eprintln!("classify_window: fewer than two points; the classifier emits nothing.");
        return Ok(());
    }

    // ⚠ `stay_pts` is None: `findStays` needs its own point series and this is
    // asking what the WINDOW CLASSIFIER said, which is the half under test.
    for s in backend::head::classify_segments(&slice, None)? {
        println!(
            "{}-{}  {:10}  lin {:>5}  pts {:>3}  avgSp {:>5}  {}",
            hhmm(s["startTs"].as_i64().unwrap_or(0)),
            hhmm(s["endTs"].as_i64().unwrap_or(0)),
            s["mode"].as_str().unwrap_or("?"),
            s["linearity"]
                .as_f64()
                .map_or("-".into(), |v| format!("{v:.2}")),
            s["pointCount"].as_i64().unwrap_or(0),
            s["avgSpeed"]
                .as_f64()
                .map_or("-".into(), |v| format!("{v:.1}")),
            s["refinedReason"].as_str().unwrap_or(""),
        );
    }
    Ok(())
}
