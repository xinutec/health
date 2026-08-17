//! The host's parts, as a library so `tests/` can reach them.
//!
//! A binary crate has no importable surface, and this repo lints against
//! `#[cfg(test)]` inside `src/` (`rust-test-module-in-src`). `main.rs` is left
//! as a thin `fn main`.
//!
//! ⚠ `osm`'s `#[unsafe(no_mangle)]` entry points — what Lean's `@[extern]` resolves
//! against — are defined HERE now. `scripts/rust-host-check.sh` is what proves
//! they survive the link.

pub mod mirror;
pub mod osm;
