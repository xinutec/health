//! Dump the fold request for one golden day, as the fold receives it (#975).
//!
//! ⚠ THIS REPLACES `DAY_REQ_DUMP=… pnpm run day-gate`. That was the only way to
//! get the request `scripts/rust-host-check.sh` feeds to both arms, and it ran
//! `src/cli/compare-day.ts` to do it — so deleting the TypeScript backend would
//! have taken the host-equivalence check down with it, silently, by turning it
//! into a permanent SKIP.
//!
//! ⚠ AN EXAMPLE, NOT A `bin/backend` VERB. The golden corpus is a test artifact,
//! and a production CLI that reads test fixtures is the wrong shape — it would
//! ship in the image and invite use against real data. `cargo run --example`
//! builds with the crate, uses the library, and stays out of the release.
//!
//! ⚠ IT PRINTS THE FINAL ROUND'S REQUEST, not the first. The fold converges over
//! several rounds, each carrying more answer tables than the last; the bytes a
//! second host must reproduce are the ones the last round saw.
//!
//! ```text
//! cargo run --example dump_day_request -- 2026-05-14-pippijn > /tmp/req.json
//! ```
//!
//! Exit 2 when the corpus is absent — the same contract `rust-host-check.sh`
//! already reads from the old day gate, so the caller's SKIP path is unchanged.

use anyhow::{Context, Result};
use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;

fn main() -> Result<()> {
    let name = std::env::args().nth(1).unwrap_or_default();
    if name.is_empty() {
        eprintln!("usage: dump_day_request <YYYY-MM-DD-user>   (a golden day's stem)");
        std::process::exit(64);
    }
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    let path = format!("{root}/{name}.json");

    // ⚠ EXIT 2, NOT 1, WHEN THE CORPUS IS MISSING. `tests/golden/days` is
    // gitignored — it carries real coordinates, places and biometrics — so its
    // absence is the ordinary case off this machine and must be told apart from
    // a day that failed to build. The caller turns 2 into a loud skip.
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("dump_day_request: no golden day at {path}");
        std::process::exit(2);
    };

    let fx: serde_json::Value = serde_json::from_str(&text).context("the fixture parses")?;
    let inputs = &fx["inputs"];
    let (date, user) = (&name[..10], name[11..].to_string());
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;

    backend::lean::init()?;
    let cap = backend::head::capture(inputs, date, &user).context("head::capture")?;
    let mut answerer = RowSetAnswerer::new(rows).context("the row set opens")?;
    let converged = converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer)
        .context("converging the day")?;

    // ⚠ A DAY THAT DID NOT CONVERGE ON COMPLETE DATA IS NOT A SENTINEL. It would
    // still produce a request and both arms would still agree on it, so the
    // check would pass — on a day whose fold never got its answers.
    //
    // ⚠ BUT THREE TABLES ARE DECLINED ON PURPOSE and must not count: the same
    // list `tests/day_corpus.rs` holds, and for the same reason — `reverseGeocode`
    // is a Nominatim call over coordinates the pipeline DERIVES (#1076),
    // `transitStops` is injected rather than computed from rows, and
    // `nearbyLandmarks` declines where the row set cannot vouch for a coordinate.
    // A first pass here refused this day over one of them, which would have made
    // the sentinel unavailable for a gap that is not one.
    const DECLINED_ON_PURPOSE: [&str; 3] = ["reverseGeocode", "nearbyLandmarks", "transitStops"];
    let real_gaps: Vec<&backend::lean::Miss> = converged
        .unanswerable
        .iter()
        .filter(|m| !DECLINED_ON_PURPOSE.contains(&m.what.as_str()))
        // `bestPlace` with an empty coordinate key is the same deliberate decline.
        .filter(|m| !(m.what == "bestPlace" && m.key.ends_with('|')))
        .collect();
    if !real_gaps.is_empty() {
        for m in &real_gaps {
            eprintln!("dump_day_request: unanswered {}({})", m.what, m.key);
        }
        eprintln!("dump_day_request: this day is not a usable sentinel");
        std::process::exit(1);
    }
    println!("{}", serde_json::to_string(&converged.request)?);
    Ok(())
}
