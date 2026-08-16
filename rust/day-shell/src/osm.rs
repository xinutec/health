//! The host's half of `DayEntry.OsmHost` — the two lookups the fold generates
//! mid-run and a spawned process cannot answer.
//!
//! # What these do TODAY, and why that is the useful thing
//!
//! They answer nothing: zero polylines, the same as `c/osm-host-stub.c` and the
//! same as the `fun _ _ _ => #[]` that stood here before either existed. So the
//! fold's output is unchanged and the day gate should not move — which is what
//! makes this safe to land.
//!
//! What they add is a COUNT. `DayEntry`'s `UNFED` says the matcher's reads are
//! "4.31 MiB/day the wire measurement deliberately left shell-side", and that
//! figure is the whole reason these are callbacks rather than request fields.
//! But nobody has ever seen the fold ASK: the shells returned empty before the
//! question could be recorded. Now every call lands here and is tallied, so the
//! next question — how many reads, over what area, per day — has an instrument
//! instead of an estimate.
//!
//! # Why the answers are built through C
//!
//! `lean_alloc_sarray` and `lean_dec` are `static inline` in `lean.h`. Rust
//! cannot link what has no symbol, so `shim.c` exposes the two it needs. The
//! LOOKUP stays here: this is where reading the OSM mirror belongs, and C is
//! only doing the object construction.

use std::os::raw::c_void;
use std::sync::atomic::{AtomicU64, Ordering};

extern "C" {
	fn health_shell_mk_bytes(p: *const u8, n: usize) -> *mut c_void;
	fn health_shell_dec(o: *mut c_void);
}

/// Calls the fold made, by lookup. Read with [`take_counts`].
static WALKABLE_ROADS: AtomicU64 = AtomicU64::new(0);
static BUILDINGS_NEAR: AtomicU64 = AtomicU64::new(0);

/// `(walkableRoads, buildingsNear)` since the last call, and reset.
pub fn take_counts() -> (u64, u64) {
	(WALKABLE_ROADS.swap(0, Ordering::Relaxed), BUILDINGS_NEAR.swap(0, Ordering::Relaxed))
}

/// A well-formed answer of zero polylines — a little-endian `u32` count of 0,
/// which is `OsmHost.decodePolylines`'s empty case and is pinned by a `#guard`
/// on the Lean side.
fn empty_answer() -> *mut c_void {
	// SAFETY: a 4-byte read from a live local; the callee copies it.
	unsafe { health_shell_mk_bytes([0u8; 4].as_ptr(), 4) }
}

/// SAFETY: called by Lean with an owned boxed `Int`, which we release. Returns
/// an owned `ByteArray` Lean takes ownership of.
#[no_mangle]
pub extern "C" fn health_osm_walkable_roads(_lat: f64, _lon: f64, radius_m: *mut c_void) -> *mut c_void {
	WALKABLE_ROADS.fetch_add(1, Ordering::Relaxed);
	unsafe { health_shell_dec(radius_m) };
	empty_answer()
}

/// SAFETY: as [`health_osm_walkable_roads`].
#[no_mangle]
pub extern "C" fn health_osm_buildings_near(_lat: f64, _lon: f64, radius_m: *mut c_void) -> *mut c_void {
	BUILDINGS_NEAR.fetch_add(1, Ordering::Relaxed);
	unsafe { health_shell_dec(radius_m) };
	empty_answer()
}
