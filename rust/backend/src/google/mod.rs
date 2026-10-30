//! Google Health: OAuth, the weight feed, and the reconciliation it drives.
//!
//! Ports of `src/google/{oauth,health,body}.ts` (#260, #982).
//!
//! # Why weight comes from here and not from Fitbit
//!
//! The scale reaches Google, not Fitbit: Hume → Health Connect → Google Health.
//! The legacy Fitbit weight feed was a FORWARD-FILLED daily series, and it froze
//! in Apr 2026 when that path died — leaving a flat line in the `body` table
//! that looks exactly like a stable weight rather than like missing data.
//!
//! ⚠ This is why the Fitbit sync, while it ran, never wrote body: it would have
//! overwritten these real measurements nightly with Fitbit's stale
//! carry-forward, and the result would still have looked like data.

pub mod archive;
pub mod body;
pub mod exercise;
pub mod health;
pub mod oauth;
pub mod probe;
pub mod routes;
pub mod run;
pub mod source;
pub mod sync;
