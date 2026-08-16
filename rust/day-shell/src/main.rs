//! `day-shell` — the Lean day fold, called in-process instead of spawned.
//!
//! Reads a day request on stdin and writes the fold's answer on stdout, which is
//! byte-for-byte what `verified_cli day` does. That is the point: the two are
//! diffable on the same input, so "the host calls the real fold" is something
//! you can check rather than something this comment asserts.
//!
//! # What it is evidence FOR, and what it is not
//!
//! It proves the transport can go: the fold links into a foreign host, the
//! runtime initialises, and a real day round-trips. It does NOT yet delete
//! anything. `PassFold.Env.walkEnv`/`.roadEnv` are still declared shells, so the
//! answer still carries no matched or smoothed geometry and `src/lean/
//! day-decode.ts` still grafts the TS run's back. Deleting the TS arm needs
//! those two solvers HERE — that is the ~6k lines #952 sizes, and none of it is
//! written.
//!
//! `--repeat N` runs the same request N times in one process. That measures the
//! thing the round loop actually costs: the first call pays initialisation, the
//! rest pay only the fold, and the gap between them is what a shared process
//! buys over `converge`'s 2-7 spawns.

mod osm;

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

	let mut input = String::new();
	std::io::stdin().read_to_string(&mut input).expect("read stdin");
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

	// The fold's own lookups, which nothing could see before the host existed —
	// the shells answered empty before the question could be recorded. Zero here
	// means the matcher never asked, which is what the remaining five stubbed
	// `walkEnv` leaves currently guarantee: `matcher` returns `none`, so nothing
	// downstream of it ever reaches for a road or a building.
	let (roads, buildings) = osm::take_counts();
	eprintln!("osm: walkableRoads={roads} buildingsNear={buildings}");

	// To stderr, so stdout stays diffable against `verified_cli day`.
	if repeat > 1 {
		let first = per_call[0];
		let rest: f64 = per_call[1..].iter().sum::<f64>() / (repeat - 1) as f64;
		eprintln!("init={init_ms:.1}ms first={first:.1}ms mean-after-first={rest:.1}ms n={repeat}");
	} else {
		eprintln!("init={init_ms:.1}ms call={:.1}ms", per_call[0]);
	}
}
