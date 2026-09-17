//! Several days through the SERVING path, in ONE process, with the mirror live
//! (health #1071).
//!
//! # Why this exists
//!
//! The Lean arena never returns memory to the OS, so a process's high-water is
//! set by the heaviest thing it has ever done and never comes back. That is
//! measurable — but only by doing several different days WITHOUT restarting,
//! which nothing could do before this.
//!
//! ⚠ **`time_day --serve-many` IS NOT THIS, AND THE DIFFERENCE IS THE WHOLE
//! POINT.** That tool configures no mirror, so the three OSM callbacks answer
//! EMPTY and `annotateWalkMatches` bails per leg. Its arms price the PARSE.
//! Production's peak includes the walk matcher, which #1632 measured at 22 s of
//! a 31.7 s fold — the term most likely to be ratcheting is exactly the one
//! `time_day` cannot see. This runs `routes::velocity::compute_with`, the same
//! function the HTTP route calls, against a real database.
//!
//! ⚠ An EXAMPLE, not a `bin/backend` verb, for `dump_day_request`'s reason: a
//! measurement harness should not ship in the production image.
//!
//! ⚠ **READ-ONLY, and it is still a production actor.** `compute_with` only
//! reads; `velocity_cache` is in-memory. Pointed at production it takes
//! connections and read locks like any client.
//!
//! ```text
//! scripts/prod-db.sh cargo run --example velocity_many -- pippijn \
//!   2026-08-12 2026-06-24 2026-06-15 2026-05-25 2026-08-12
//! ```
//!
//! Repeat a day at the END to prove the ratchet: if the high-water were a
//! function of the current day it would fall back; it does not.

use anyhow::{Context, Result};
use backend::{config::Config, db, fold_converge::rss_mib, lean, routes, state::AppState};

#[tokio::main]
async fn main() -> Result<()> {
    // ⚠ Same first move as `main`: the fold cannot decide anything without it.
    lean::init().context("starting the Lean runtime")?;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let [user, dates @ ..] = args.as_slice() else {
        eprintln!("usage: velocity_many <user> <YYYY-MM-DD>...");
        std::process::exit(64);
    };
    if dates.is_empty() {
        eprintln!("usage: velocity_many <user> <YYYY-MM-DD>...   (at least one date)");
        std::process::exit(64);
    }

    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let st = AppState::new(pool.clone(), cfg, reqwest::Client::new());

    println!("RSS before any fold   {:>5} MiB", rss_mib());
    let mut high = rss_mib();
    for (i, date) in dates.iter().enumerate() {
        let before = rss_mib();
        let t0 = std::time::Instant::now();
        // ⚠ The SAME entry point the HTTP route uses. Anything cheaper would
        // measure a path production does not take.
        let body = routes::velocity::compute_with(&st, user, date, None, true).await?;
        let ms = t0.elapsed().as_millis();
        let after = rss_mib();
        let states = body
            .get("states")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len);
        // ⚠ The HIGH-WATER is the quantity, not the current reading: a fold that
        // allocates and frees leaves the arena grown, and `after` alone would
        // hide that.
        high = high.max(after);
        println!(
            "fold {:>2}  {date}  RSS {before:>4} -> {after:>4} MiB  ({:+})  high {high:>4}  \
             {states:>3} state(s)  {ms:>6} ms",
            i + 1,
            after as i64 - before as i64,
        );
    }
    pool.close().await;
    println!("high-water            {high:>5} MiB");
    Ok(())
}
