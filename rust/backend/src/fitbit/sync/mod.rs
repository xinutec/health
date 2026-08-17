//! The per-stream Fitbit fetchers.
//!
//! Each module here fetches one endpoint and writes its rows. The split rule
//! from `lib.rs` applies per function rather than per file: a fetcher that only
//! moves bytes is Rust in full, and one carrying a rule hands that rule to
//! Lean and keeps the fetch.
//!
//! `daily` is the first kind — four streams, no decisions between them.

pub mod daily;
pub mod steps;
