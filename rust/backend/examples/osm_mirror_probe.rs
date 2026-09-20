//! Fetch one box from Overpass and report what the mirror WOULD write — without
//! a database and without writing anything (#1658).
//!
//!     cargo run --release -p backend --example osm_mirror_probe -- \
//!       <bucket> <lat> <lon> <radius-m>
//!
//! # Why this exists
//!
//! The write half's unit tests are synthetic by necessity: these repos are
//! PUBLIC, and a captured Overpass response is a list of real street names at
//! real coordinates on a day he was there (#860). So the shapes are pinned in
//! `tests/suite/osm_mirror.rs` against invented elements, and the question
//! "does a REAL response from a REAL uncovered area parse" is answered here, by
//! running it, rather than by a fixture anyone can read.
//!
//! ⚠ IT PRINTS A CENSUS, NOT THE ROWS. Same reason. Counts per bucket and per
//! subtype say whether the parse works; the names would say where he went.
//!
//! ⚠ NO WRITES AND NO POOL. `backend fetch-osm --dry-run` reports what the
//! queue holds; this reports what one fetch would yield. Neither touches the
//! mirror, and this one does not even open the database.

use anyhow::{Context, Result, bail};
use backend::osm_mirror;
use std::collections::BTreeMap;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [bucket, lat, lon, radius] = args.as_slice() else {
        bail!("usage: osm_mirror_probe <bucket> <lat> <lon> <radius-m>");
    };
    let lat: f64 = lat.parse().context("lat is not a number")?;
    let lon: f64 = lon.parse().context("lon is not a number")?;
    let radius_m: f64 = radius.parse().context("radius is not a number")?;

    let half_width_m = osm_mirror::half_width_for(bucket, radius_m)?;
    let bbox = osm_mirror::fetch_bbox_around(lat, lon, half_width_m);
    let query = osm_mirror::overpass_query(bucket, &bbox)?;
    println!("{bucket}: question r={radius_m:.0} m -> box half-width {half_width_m:.0} m");

    let client = reqwest::Client::new();
    backend::overpass::wait_for_slot(&client, 120).await;
    let t0 = std::time::Instant::now();
    let body = match backend::overpass::fetch_attempt(
        &client,
        &query,
        backend::overpass::MIRROR_TIMEOUT_MS,
        0,
    )
    .await
    {
        backend::overpass::Outcome::Ok(b) => b,
        backend::overpass::Outcome::Permanent { status } => {
            bail!("Overpass refused: HTTP {status}")
        }
        backend::overpass::Outcome::AllFailed { errors, .. } => bail!("{}", errors.join("; ")),
    };
    let elapsed = t0.elapsed();

    let elements = backend::overpass::elements(&body)?;
    let features: Vec<_> = elements
        .iter()
        .filter_map(osm_mirror::parse_element)
        .collect();

    // ⚠ THE DROPPED COUNT IS THE INTERESTING ONE. Every element Overpass
    // returned that `parse_element` refused is either furniture we do not
    // bucket or a shape the geometry tables cannot hold — and a query whose
    // filters and whose parser disagree drops most of what it paid for.
    println!(
        "{} bytes in {:.1}s · {} element(s) -> {} feature(s), {} dropped",
        body.len(),
        elapsed.as_secs_f64(),
        elements.len(),
        features.len(),
        elements.len() - features.len(),
    );

    let mut by_bucket: BTreeMap<(&str, bool), usize> = BTreeMap::new();
    let mut by_subtype: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut named = 0usize;
    for f in &features {
        *by_bucket
            .entry((f.feature_type.as_str(), f.is_point()))
            .or_default() += 1;
        *by_subtype
            .entry((
                f.feature_type.clone(),
                f.subtype.clone().unwrap_or_else(|| "(none)".into()),
            ))
            .or_default() += 1;
        if f.name.is_some() {
            named += 1;
        }
    }
    for ((b, is_point), n) in &by_bucket {
        let table = if *is_point { "osm_points" } else { "osm_lines" };
        println!("  {b:<14} -> {table:<11} {n:>6}");
    }
    for ((b, st), n) in &by_subtype {
        println!("    {b}/{st:<24} {n:>6}");
    }
    println!("  named (name or ref): {named} of {}", features.len());
    Ok(())
}
