//! The host's parts, as a library so `tests/` can reach them.
//!
//! A binary crate has no importable surface, and this repo lints against
//! `#[cfg(test)]` inside `src/` (`rust-test-module-in-src`). `main.rs` is left
//! as a thin `fn main`.
//!
//! ⚠ `osm`'s `#[unsafe(no_mangle)]` entry points — what Lean's `@[extern]` resolves
//! against — are defined HERE now. `scripts/rust-host-check.sh` is what proves
//! they survive the link.

#![expect(unsafe_code, reason = "FFI onto the Lean host library")]

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

// `unsafe extern` and not plain `extern`: what is unchecked is the
// DECLARATION — see the same block in `osm.rs`.
unsafe extern "C" {
    fn health_shell_init() -> i32;
}

/// Has SOMETHING brought the Lean runtime up in this process?
///
/// ⚠ NOT THE SAME QUESTION AS "did `init_lean` run". `backend` links this crate
/// and starts Lean through its OWN shim (`health_backend_init`, which
/// initialises `ServeEntry` and transitively `DayEntry`), so the runtime is up
/// in that process while this crate's initialiser never ran. Calling
/// `lean_initialize` a second time to find out is not an option — so the two
/// paths both report here, and code that needs Lean ASKS rather than assumes.
static LEAN_READY: AtomicBool = AtomicBool::new(false);

/// Record that the Lean runtime is up, for a host that started it its own way.
///
/// ⚠ `backend::lean::init` calls this. Without it, every mirror read in the
/// backend would decline at the coverage gate — Lean would be running and this
/// crate would have no way to know.
pub fn mark_lean_ready() {
    LEAN_READY.store(true, Ordering::Relaxed);
}

/// Whether a Lean entry point may be called at all. See [`LEAN_READY`].
#[must_use]
pub fn lean_ready() -> bool {
    LEAN_READY.load(Ordering::Relaxed)
}

/// Bring the Lean runtime up through THIS crate's shim. Idempotent; `true` on
/// success.
///
/// ⚠ REQUIRED BEFORE ANY LEAN ENTRY POINT, including `coverage::decide`, which
/// CALLS an `@[export]`ed function rather than answering one. Skipping it is a
/// SIGSEGV, not an error — `--osm-verify` and the mirror tests reach the gate
/// without folding anything, and each has to say so.
pub fn init_lean() -> bool {
    static DONE: OnceLock<bool> = OnceLock::new();
    // SAFETY: the shim's contract is "once, before anything else", which is
    // exactly what `OnceLock` provides.
    let ok = *DONE.get_or_init(|| unsafe { health_shell_init() } == 0);
    if ok {
        mark_lean_ready();
    }
    ok
}

pub mod coverage;
pub mod fetch_queue;
pub mod mirror;
pub mod osm;
