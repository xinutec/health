//! The host's parts, as a library so they can be TESTED.
//!
//! `day-shell` is a binary — its job is to be a process the Lean fold can call
//! out from. But a binary crate has no importable surface, and this repo lints
//! against `#[cfg(test)]` modules inside `src/` (`rust-test-module-in-src`), for
//! the same reason the TS half tests public APIs: a test that reaches into a
//! private helper pins the implementation rather than the contract.
//!
//! So the two modules live here and `main.rs` is a thin `fn main`. What that
//! makes testable from `tests/` is the part worth pinning — the WKT parse and
//! the query box, which are ports of TS functions and have to stay ports.
//!
//! ⚠ `osm`'s `#[no_mangle] extern "C"` entry points are what Lean's
//! `@[extern]` declarations resolve against, and they are DEFINED HERE now
//! rather than in the binary. The binary still links this crate, so the symbols
//! are still in the final link — and `scripts/rust-host-check.sh` is what proves
//! it, by requiring the host's output to match the spawned CLI byte for byte and
//! the fold to have made at least one lookup. A dropped symbol would be an
//! undefined-symbol link error, not a quiet wrong answer.

pub mod mirror;
pub mod osm;
