//! Walking legs whose displacement is smaller than their own GPS error (#185).
//!
//! ⚠ WHY: on 2026-09-06 a 3 h 34 m cinema stay was cut in two by a 2-minute
//! "walk" whose fixes were all 100 m accuracy and whose net displacement was
//! 0 m. A displacement inside the error radius is not evidence of movement, and
//! the segmentation layer appears to consult neither accuracy gate the pipeline
//! already has (`FocusPlaces.ACCURACY_FILTER_M` 200, `PlacePrior.
//! MIN_ACCURACY_TO_SNAP_M` 30).
//!
//! That day is not in the corpus and cannot be until #1660. So the question
//! this answers is whether the EXISTING 42 days carry the same shape — because
//! a fix nothing can grade is a fix nobody should ship.
//!
//! Reads fixtures only; no database, no network.
//!
//! ```text
//! cargo run --release --example jitter_walks
//! ```

use anyhow::Result;
use serde_json::Value;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

fn hav(a: f64, b: f64, c: f64, d: f64) -> f64 {
    let r = 6_371_000.0_f64;
    let (p1, p2) = (a.to_radians(), c.to_radians());
    let (dp, dl) = ((c - a).to_radians(), (d - b).to_radians());
    let x = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * r * x.sqrt().asin()
}

fn main() -> Result<()> {
    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();

    let mut hits = 0usize;
    let mut walks = 0usize;
    for name in &names {
        let fx: Value =
            serde_json::from_str(&std::fs::read_to_string(format!("{GOLDEN}/{name}"))?)?;
        // The blessed timeline is what a reader sees; the raw fixes are what it
        // was derived from.
        let states = fx
            .pointer("/expected/tsArm/capture/statesOut")
            .or_else(|| fx.pointer("/expected/statesOut"));
        let Some(states) = states.and_then(Value::as_array) else {
            continue;
        };
        let mut fixes: Vec<(i64, f64, f64, Option<f64>)> = Vec::new();
        for k in ["today", "morning", "priorEvening"] {
            for f in fx
                .pointer(&format!("/inputs/phonetrack/{k}"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let (Some(ts), Some(la), Some(lo)) =
                    (f["ts"].as_i64(), f["lat"].as_f64(), f["lon"].as_f64())
                {
                    fixes.push((ts, la, lo, f["accuracy"].as_f64()));
                }
            }
        }
        fixes.sort_by_key(|f| f.0);

        for s in states {
            if s["mode"].as_str() != Some("walking") {
                continue;
            }
            walks += 1;
            let (Some(a), Some(b)) = (s["startTs"].as_i64(), s["endTs"].as_i64()) else {
                continue;
            };
            let win: Vec<_> = fixes.iter().filter(|f| f.0 >= a && f.0 <= b).collect();
            if win.len() < 2 {
                continue;
            }
            let net = hav(
                win[0].1,
                win[0].2,
                win[win.len() - 1].1,
                win[win.len() - 1].2,
            );
            let mut acc: Vec<f64> = win.iter().filter_map(|f| f.3).collect();
            if acc.is_empty() {
                continue;
            }
            acc.sort_by(f64::total_cmp);
            let med = acc[acc.len() / 2];
            // ⚠ THE TEST IS NET AGAINST ACCURACY, not duration. Two legs on
            // 2026-09-06 covered 180 m and 222 m in five minutes and are
            // probably real; a duration floor would take them with it.
            if net < med {
                hits += 1;
                println!(
                    "{}  {:>5.1}m walk · net {:5.0} m · median accuracy {:5.0} m · {} fix(es)",
                    &name[..10],
                    (b - a) as f64 / 60.0,
                    net,
                    med,
                    win.len()
                );
            }
        }
    }
    println!(
        "\n{hits} of {walks} walking state(s) move less than their own GPS error, across {} day(s)",
        names.len()
    );
    Ok(())
}
