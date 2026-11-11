//! Nextcloud: credentials, a thin HTTP client, and the PhoneTrack fetch.
//!
//! Ports of `src/nextcloud/{credentials,client,phonetrack}.ts`.
//!
//! # Nothing here goes to Lean, with one exception that did
//!
//! By the split rule in [`crate::lib`](crate): these modules read a row, build
//! an `Authorization` header, and walk a session/device tree. None of it
//! decides anything.
//!
//! The exception is how a date range becomes a set of requests: what a
//! `YYYY-MM-DD` means as an instant (`Verified.Civil.midnightUtc`), and how wide
//! a window one request may ask for (the day's own window).

pub mod client;
pub mod credentials;
pub mod phonetrack;
