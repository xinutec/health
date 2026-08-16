//! `day-shell` — the Lean day fold, called in-process instead of spawned.
//!
//! Reads a day request on stdin, writes the fold's answer on stdout. Without
//! `--osm` that is byte-for-byte what `verified_cli day` produces, and the two
//! are diffable on the same input — so "the host calls the real fold" is
//! checkable rather than asserted (`scripts/rust-host-check.sh`).
//!
//! # What the host is FOR, which is not what it first looked like
//!
//! Not speed, and not transport. `PassFold.Env`'s `walkEnv`/`roadEnv` fields are
//! CALLBACKS — `walkableRoads`, `buildingsNear`, `drivableRoads` — that the fold
//! generates mid-run. A spawned pure function cannot answer a query it invents
//! while running; a host sharing the process can. That is the whole difference,
//! and it is why the matcher shells could not be filled before this existed.
//!
//! The solvers themselves are NOT here and should not be: they are Lean
//! (`Verified.Geo.Match`, `WalkSmooth`, `WalkEscape`), already written, and the
//! rule is that as much as possible lives in Lean and Rust takes only what proof
//! would not help. Rust owns the process, the lookups and the IO.
//!
//! # State
//!
//! `walkEnv` and `roadEnv` are both wired WHOLE — every read and every solver
//! leaf. Nothing in `PassFold.Env` is a stub any more; what is still
//! link-dependent is the answer, since `verified_cli` links the empty stub and
//! a leg with no ways is skipped before any leaf runs.
//!
//! With `--osm`, on 2026-05-14: the building corrector and the reconstruction
//! draw BIT-IDENTICAL lines to the TS arm, and the matcher's own legs differ by
//! 0.46 and 0.54 cm — the 1e-7° quantisation, which is the class
//! `compare-match --gate` adjudicates and NOT something to widen a manifest
//! over (`deploy.sh:139`). `src/lean/day-decode.ts` still grafts the TS run's
//! geometry back and the TS arm still runs; that is the `LEAN_DAY=on` cutover
//! (#431), not a missing callback. See #952.
//!
//! `--repeat N` runs the same request N times in one process. That measures the
//! thing the round loop actually costs: the first call pays initialisation, the
//! rest pay only the fold, and the gap between them is what a shared process
//! buys over `converge`'s 2-7 spawns.

use day_shell::{mirror, osm};

use std::ffi::{CStr, CString};
use std::io::Read;
use std::os::raw::c_char;
use std::time::Instant;

extern "C" {
    fn health_shell_init() -> i32;
    fn health_shell_day(input: *const c_char) -> *mut c_char;
    fn health_shell_free(p: *mut c_char);
}

/// Safe wrapper over the shim. Copies the answer into a `String` and hands the
/// C buffer back immediately, so there is exactly one owner at any moment.
fn day(input: &CString) -> String {
    // SAFETY: `init` ran (checked by the caller below), `input` is a valid
    // NUL-terminated C string that outlives the call, and the returned pointer is
    // a `strdup`'d buffer this function frees before returning.
    unsafe {
        let p = health_shell_day(input.as_ptr());
        assert!(!p.is_null(), "health_shell_day returned NULL");
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        health_shell_free(p);
        s
    }
}

fn main() {
    let repeat: usize = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|w| w[0] == "--repeat")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(1);

    let argv: Vec<String> = std::env::args().collect();

    // `--osm-verify <trace>` does not run a fold at all: it reads every key the
    // fixture holds from the MIRROR too and compares. That is how the Rust port
    // of the three mirror queries is checked (#959) — against what the TS arm
    // recorded for the same (lat, lon, radius), not against "it returned rows".
    if let Some(w) = argv.windows(2).find(|w| w[0] == "--osm-verify") {
        match osm::verify_against_mirror(&w[1]) {
            Ok(()) => return,
            Err(e) => {
                eprintln!("verify: {e}");
                std::process::exit(1);
            }
        }
    }

    // `--osm <file>` answers the fold's lookups from a captured day instead of
    // from the mirror. See `osm.rs`: a test instrument, and it WINS over the
    // mirror so that replaying a captured day reproduces that day.
    if let Some(w) = argv.windows(2).find(|w| w[0] == "--osm") {
        match osm::load_fixture(&w[1]) {
            Ok((roads, buildings)) => {
                eprintln!("osm: loaded {roads} walkableRoads / {buildings} buildingsNear keys")
            }
            Err(e) => {
                eprintln!("osm: {e}");
                std::process::exit(2);
            }
        }
    }

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    // A day request has no interior NULs; if one appears, that is a corrupt
    // request and not something to paper over by truncating at it.
    let input = CString::new(input).expect("request contains an interior NUL byte");

    let t_init = Instant::now();
    // SAFETY: called exactly once, before any other entry point in the shim.
    let rc = unsafe { health_shell_init() };
    assert_eq!(rc, 0, "Lean runtime initialisation failed");
    let init_ms = t_init.elapsed().as_secs_f64() * 1e3;

    let mut out = String::new();
    let mut per_call = Vec::with_capacity(repeat);
    for _ in 0..repeat {
        let t = Instant::now();
        out = day(&input);
        per_call.push(t.elapsed().as_secs_f64() * 1e3);
    }

    println!("{out}");

    // The fold's own lookups, which nothing could see before the host existed:
    // the shells answered empty before the question could be recorded.
    //
    // Hits and MISSES apart. An unanswered lookup returns empty, which is
    // indistinguishable from "there are no roads here" — so a run with misses
    // has not exercised the matcher however green it looks, and must say so.
    let c = osm::take_counts();
    eprintln!(
        "osm: walkableRoads={}/{} buildingsNear={}/{} drivableRoads={}/{} (hit/asked){}",
        c.walkable_hits,
        c.walkable_hits + c.walkable_misses,
        c.buildings_hits,
        c.buildings_hits + c.buildings_misses,
        c.drivable_hits,
        c.drivable_hits + c.drivable_misses,
        // A miss only MEANS something when there was something to hit. Without
        // `--osm` and without a mirror every lookup misses by design, and
        // warning about it there trains the reader to ignore the warning that
        // matters.
        if c.misses() > c.mirror_reads && (osm::have_trace() || mirror::configured()) {
            "  ⚠ MISSES"
        } else {
            ""
        }
    );
    // Separate line, and unconditional on being non-zero, because it is the one
    // fault the line above STRUCTURALLY cannot report (health #976). A failed
    // query still increments `MIRROR_READS`, so `misses() > mirror_reads` stays
    // false and `⚠ MISSES` never fires — a database that is down reads exactly
    // like a healthy day whose area has no roads. Every empty answer this run
    // gave is suspect, not just the failed ones: the fold cannot tell them
    // apart either, so it drew whatever it could from nothing.
    if c.mirror_fails > 0 {
        eprintln!(
            "osm: ⚠ MIRROR FAILED {} time(s) — empty answers this run are a database fault, \
             not coverage; the fold drew raw chords where roads exist",
            c.mirror_fails
        );
    }
    if c.asked() == 0 {
        // Distinct from a miss, and a different finding: the fold never reached
        // for a road at all. With `walkEnv`'s reads wired that should not happen
        // on a day with a walking leg, so zero here is a wiring failure rather
        // than a quiet day — `scripts/rust-host-check.sh` reds on it.
        eprintln!("osm: the fold made no lookups at all");
    }

    // To stderr, so stdout stays diffable against `verified_cli day`.
    if repeat > 1 {
        let first = per_call[0];
        let rest: f64 = per_call[1..].iter().sum::<f64>() / (repeat - 1) as f64;
        eprintln!("init={init_ms:.1}ms first={first:.1}ms mean-after-first={rest:.1}ms n={repeat}");
    } else {
        eprintln!("init={init_ms:.1}ms call={:.1}ms", per_call[0]);
    }
}
