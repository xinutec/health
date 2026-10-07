//! Dump the decode request for one frozen decoder day, as the decoder receives it.
//!
//! The instrument for a wrong line: add `"chainDebug": true` and feed it to
//! `verified_cli serve` to see every station pair the chain weighed, per leg,
//! with its duration and pass terms.
//!
//! ```text
//! cargo run --example dump_decode_request -- <YYYY-MM-DD>-$USER > /tmp/req.json
//! ```
//!
//! An example, not a `bin/backend` verb, for the reason `dump_day_request` gives:
//! the frozen days are a test artifact. Exit 2 when the corpus is absent.

use anyhow::Result;

/// Print the decode request a frozen decoder day builds.
#[derive(clap::Parser)]
struct Args {
    /// `<YYYY-MM-DD>-<user>`, a file in `tests/golden/decoded_days`
    name: String,
}

fn main() -> Result<()> {
    let args: Args = backend::argv::parse_or_exit();
    if backend::decode_fixture::fixture_names()?.is_none() {
        eprintln!("dump_decode_request: no decoder corpus on this machine");
        std::process::exit(2);
    }
    let file = if args.name.ends_with(".json") {
        args.name
    } else {
        format!("{}.json", args.name)
    };
    let fx = backend::decode_fixture::read(&file)?;
    println!("{}", backend::decode_fixture::request(&fx)?);
    Ok(())
}
