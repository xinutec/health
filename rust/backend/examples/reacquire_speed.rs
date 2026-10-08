//! Minutes whose speed a post-gap fix decides.
//!
//! A fix that lands after a gap carries the smoother's speed ACROSS the gap —
//! the displacement rate, up to twice it (`Kalman.VELOCITY_OBSERVABILITY_FACTOR`)
//! — not the speed inside the minute it lands in. The observation tensor folds
//! it into the minute's mean with the fixes beside it, so the minute after a
//! change of train reads as neither a ride nor a walk and `unknown` takes it.
//! Two tables, from the frozen decoder days alone:
//!
//!   * the speed jump against both neighbours by the gap before a fix, which is
//!     where the threshold comes from (the jump appears at 45 s and stays until
//!     the filter's reset);
//!   * every minute where such a fix exceeds the rest of its minute by 30 km/h,
//!     with its date and UTC time, to set beside the scoreboard's misses.
//!
//! Dropping those fixes from the mean was measured and refuted: the gap's
//! displacement is real motion with nowhere else to go (the gap terms begin at
//! 180 s), and without it tunnel minutes decode as walks. What this counts is
//! the shape the next form has to carry, not a filter to apply.
//!
//! ```text
//! cargo run --release --example reacquire_speed
//! ```
//!
//! Exit 2 when the corpus is absent.

use anyhow::Result;

/// The gap after which a fix's speed is the gap's, not its minute's.
const GAP_S: i64 = 45;
/// How far above the rest of its minute a post-gap fix must sit to be listed.
const EXCESS_KMH: f64 = 30.0;
/// A neighbour this close in time is one the speed should agree with.
const NEIGHBOUR_S: i64 = 30;

const BINS: [(i64, i64); 8] = [
    (0, 20),
    (20, 30),
    (30, 45),
    (45, 60),
    (60, 90),
    (90, 120),
    (120, 300),
    (300, i64::MAX),
];

struct Pt {
    ts: i64,
    speed: f64,
}

/// Nearest-rank: the value at the q-th share of the sorted list; `None` of nothing.
fn quantile(xs: &mut [f64], q: f64) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(f64::total_cmp);
    let i = ((q * xs.len() as f64) as usize).min(xs.len() - 1);
    Some(xs[i])
}

/// A quantile for the table: blank where the bin is empty.
fn cell(v: Option<f64>) -> String {
    v.map_or_else(|| "     —".to_string(), |x| format!("{x:6.1}"))
}

fn hhmm(ts: i64) -> String {
    let s = ts.rem_euclid(86_400);
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

fn main() -> Result<()> {
    let Some(names) = backend::decode_fixture::fixture_names()? else {
        eprintln!("reacquire_speed: no decoder corpus on this machine");
        std::process::exit(2);
    };
    let mut jump_prev: Vec<Vec<f64>> = vec![Vec::new(); BINS.len()];
    let mut jump_next: Vec<Vec<f64>> = vec![Vec::new(); BINS.len()];
    let mut minutes = 0usize;
    let mut hits: Vec<String> = Vec::new();
    for name in &names {
        let fx = backend::decode_fixture::read(name)?;
        let mut pts: Vec<Pt> = fx["inputs"]["points"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some(Pt {
                    ts: p["ts"].as_i64()?,
                    speed: p["speed_kmh"].as_f64()?,
                })
            })
            .collect();
        pts.sort_by_key(|p| p.ts);
        let date = &name[..10];

        for i in 1..pts.len() {
            let gap = pts[i].ts - pts[i - 1].ts;
            let Some(b) = BINS.iter().position(|(lo, hi)| (*lo..*hi).contains(&gap)) else {
                continue;
            };
            jump_prev[b].push((pts[i].speed - pts[i - 1].speed).abs());
            if let Some(n) = pts.get(i + 1)
                && n.ts - pts[i].ts < NEIGHBOUR_S
            {
                jump_next[b].push((pts[i].speed - n.speed).abs());
            }
        }

        // Per minute: the post-gap fixes against the rest.
        let mut i = 0;
        while i < pts.len() {
            let minute = pts[i].ts.div_euclid(60);
            let mut j = i;
            while j < pts.len() && pts[j].ts.div_euclid(60) == minute {
                j += 1;
            }
            minutes += 1;
            let (mut post, mut rest): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
            for (k, p) in pts[i..j].iter().enumerate() {
                let gap = if i + k == 0 {
                    0
                } else {
                    p.ts - pts[i + k - 1].ts
                };
                if gap >= GAP_S { &mut post } else { &mut rest }.push(p.speed);
            }
            if let (Some(top), false) = (post.iter().copied().reduce(f64::max), rest.is_empty()) {
                let Some(others) = quantile(&mut rest, 0.5) else {
                    unreachable!("rest is not empty")
                };
                if top > others + EXCESS_KMH {
                    let all: Vec<f64> = pts[i..j].iter().map(|p| p.speed).collect();
                    let mean = all.iter().sum::<f64>() / all.len() as f64;
                    hits.push(format!(
                        "  {date} {}Z  post-gap {top:3.0} km/h, the rest {others:3.0}, minute mean {mean:3.0}  ({} fixes)",
                        hhmm(minute * 60),
                        j - i
                    ));
                }
            }
            i = j;
        }
    }

    println!(
        "gap before a fix (s)   fixes   |Δv| vs previous: median  p90   |Δv| vs next within {NEIGHBOUR_S} s: median  p90"
    );
    for (b, (lo, hi)) in BINS.iter().enumerate() {
        let n = jump_prev[b].len();
        let hi = if *hi == i64::MAX {
            "inf".to_string()
        } else {
            hi.to_string()
        };
        println!(
            "{lo:>4}-{hi:<5} {n:7}   {} {}          {} {}  (n={})",
            cell(quantile(&mut jump_prev[b], 0.5)),
            cell(quantile(&mut jump_prev[b], 0.9)),
            cell(quantile(&mut jump_next[b], 0.5)),
            cell(quantile(&mut jump_next[b], 0.9)),
            jump_next[b].len()
        );
    }
    println!(
        "\n{} of {minutes} fix-minutes on {} days have a fix ≥ {GAP_S} s after the one before it that exceeds the rest of the minute by {EXCESS_KMH:.0} km/h:",
        hits.len(),
        names.len()
    );
    for h in &hits {
        println!("{h}");
    }
    Ok(())
}
