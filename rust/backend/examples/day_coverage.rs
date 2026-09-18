//! Is this day INSIDE the OSM mirror's coverage? (#1153, and every recent day)
//!
//! ⚠ WHY: the corpus was captured around places already mirrored, so a day that
//! leaves that area reads as an ALGORITHM defect — blank places, unnamed ways,
//! bare line names — when the mirror simply holds nothing there. The two want
//! completely different fixes (fetch more tiles vs change the code), and
//! nothing distinguished them. 2026-09-06 asked 178 OSM queries and got 74 rows
//! each; 2026-09-15 asked 134 and got 659 each. That ratio is the symptom; this
//! is the test.
//!
//! One query. `osm_coverage` is ~1k boxes, so it is fetched whole and the fixes
//! are tested locally — the prod tunnel is latency-bound and a query per fix
//! would be thousands of round trips.
//!
//! ⚠ PRINTS NO COORDINATES. Health's repositories are public and a fix is a
//! real place he was; the output is fractions and counts only.
//!
//! ```text
//! scripts/prod-db.sh cargo run --release --example day_coverage -- pippijn 2026-09-06
//! ```

use anyhow::{Context, Result};
use backend::{classification_inputs, config::Config, db, sync_state};
use sqlx::Row;

/// The local hour a fix falls in, for the histogram. ⚠ LOCAL, not UTC: the
/// ground-truth files and every blessed row are written in the day's display
/// zone, so a UTC histogram would lay an hour's blame on the wrong hour.
fn local_hour(ts: i64, tz: &str) -> i64 {
    backend::timezone::local_hour_of(ts, tz).map_or(-1, i64::from)
}

struct Bbox {
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
}

impl Bbox {
    fn holds(&self, lat: f64, lon: f64) -> bool {
        lat >= self.min_lat && lat <= self.max_lat && lon >= self.min_lon && lon <= self.max_lon
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (Some(user), Some(date)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: day_coverage <user> <date> [display-tz]");
        std::process::exit(64);
    };

    // ⚠ The timezone helpers are Lean, so the runtime has to be up before the
    // first `date_bounds_utc` — the binary does this in `main`, an example must
    // do it itself, and the failure ("lean::init() was never called") names the
    // call rather than the omission.
    backend::lean::init().context("starting the Lean runtime")?;

    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url()).await.context("connecting")?;
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let display_tz = args.get(3).map_or(home_tz.as_str(), String::as_str);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date}"))?;
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let inputs = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;

    // Every fix the day has, from the same `phonetrack` the fold reads.
    //
    // ⚠ `today` is not the whole day the FOLD sees: `morning` and
    // `priorEvening` bracket it, and a trip that starts before local midnight
    // is carried in those. Testing only `today` would report coverage for a
    // window narrower than the one the matcher asks about.
    let rows: Vec<(f64, f64, i64)> = ["today", "morning", "priorEvening"]
        .iter()
        .flat_map(|k| inputs["phonetrack"][k].as_array().into_iter().flatten())
        .filter_map(|f| Some((f["lat"].as_f64()?, f["lon"].as_f64()?, f["ts"].as_i64()?)))
        .collect();
    let fixes: Vec<(f64, f64)> = rows.iter().map(|(a, b, _)| (*a, *b)).collect();
    let stamps: Vec<i64> = rows.iter().map(|(_, _, t)| *t).collect();
    if fixes.is_empty() {
        println!("{date}: no fixes — nothing to test");
        pool.close().await;
        return Ok(());
    }

    let rows = sqlx::query(
        "SELECT feature_type, \
            CAST(min_lat AS CHAR) AS min_lat, CAST(max_lat AS CHAR) AS max_lat, \
            CAST(min_lon AS CHAR) AS min_lon, CAST(max_lon AS CHAR) AS max_lon \
         FROM osm_coverage",
    )
    .fetch_all(&pool)
    .await
    .context("reading osm_coverage")?;
    pool.close().await;

    let mut by_type: std::collections::BTreeMap<String, Vec<Bbox>> =
        std::collections::BTreeMap::new();
    for r in rows {
        let g = |n: &str| -> Result<f64> { Ok(r.try_get::<String, _>(n)?.trim().parse::<f64>()?) };
        by_type
            .entry(r.try_get::<String, _>("feature_type")?)
            .or_default()
            .push(Bbox {
                min_lat: g("min_lat")?,
                max_lat: g("max_lat")?,
                min_lon: g("min_lon")?,
                max_lon: g("max_lon")?,
            });
    }

    println!(
        "{date}: {} fix(es), osm_coverage has {} feature type(s)",
        fixes.len(),
        by_type.len()
    );
    // ⚠ WHEN, not just how much. A day that is 66% covered is not uniformly
    // two-thirds described — it is fully described at home and BLANK for the
    // hours spent somewhere new, which is what makes the failure read as an
    // intermittent algorithm bug (#1658). The histogram names the hours to stop
    // diagnosing: on 2026-09-06 they are the Watford afternoon.
    if let Some(boxes) = by_type.get("highway") {
        let mut uncovered: std::collections::BTreeMap<i64, usize> =
            std::collections::BTreeMap::new();
        for ((la, lo), ts) in fixes.iter().zip(stamps.iter()) {
            if !boxes.iter().any(|b| b.holds(*la, *lo)) {
                *uncovered.entry(local_hour(*ts, display_tz)).or_default() += 1;
            }
        }
        if !uncovered.is_empty() {
            let hours: Vec<String> = uncovered
                .iter()
                .map(|(h, n)| format!("{h:02}:00 x{n}"))
                .collect();
            println!("  highway-UNCOVERED by local hour: {}", hours.join(", "));
        }
    }
    for (ft, boxes) in &by_type {
        let covered = fixes
            .iter()
            .filter(|(la, lo)| boxes.iter().any(|b| b.holds(*la, *lo)))
            .count();
        // ⚠ A FRACTION, not a verdict. Partial coverage is the interesting
        // case: the commute is mirrored and the destination is not, which is
        // exactly the shape that reads as an intermittent algorithm bug.
        println!(
            "  {ft:<16} {covered:>5}/{:<5} fix(es) covered  {:5.1}%   ({} box(es))",
            fixes.len(),
            100.0 * covered as f64 / fixes.len() as f64,
            boxes.len(),
        );
    }
    Ok(())
}
