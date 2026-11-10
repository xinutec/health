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
//! The exception is how a date range becomes a set of requests. The TypeScript
//! spelled that as a `for` loop over a mutated `Date`, three lines with two
//! decisions hidden in them — what `new Date("YYYY-MM-DD")` means as an instant,
//! and how wide a window one request may ask for. The first moved to
//! `Verified.Civil.midnightUtc`; the second is the day's own window.

pub mod client;
pub mod credentials;
pub mod phonetrack;
