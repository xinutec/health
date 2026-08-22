//! Fitbit ingestion — the current Web API, in Rust.
//!
//! # Why the CURRENT API and not Google Health
//!
//! Pippijn, 2026-08-17: *"Keep the current Fitbit web API and rewrite it in
//! Rust. We'll migrate afterwards."*
//!
//! Fitbit's Web API is decommissioned in September 2026 (#260), so there was a
//! real choice: port what exists, or skip it and write the Google Health
//! ingestion directly. Porting first wins because doing both migrations at once
//! means a failure could be either one — and afterwards the Google switch is a
//! change of one HTTP client inside a Rust codebase rather than a rewrite.
//!
//! ⚠ THIS DOES NOT MOVE THE SHUTDOWN DATE. #260 stays open and still due.

pub mod backfill_runner;
pub mod client;
pub mod rate_limit;
pub mod run;
pub mod sync;
pub mod tokens;
pub mod tz_source;
pub mod watch_battery;
