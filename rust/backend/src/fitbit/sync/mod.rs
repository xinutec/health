//! The per-stream Fitbit fetchers.
//!
//! Each module here fetches one endpoint and writes its rows. The split rule
//! from `lib.rs` applies per function rather than per file: a fetcher that only
//! moves bytes is Rust in full, and one carrying a rule hands that rule to
//! Lean and keeps the fetch.
//!
//! `daily` is the first kind — four streams, no decisions between them.
//!
//! # The one rule they share went to Lean
//!
//! Three of these walk a date range a day at a time, and the TypeScript writes
//! that walk out longhand in each file. It is now one call to
//! [`crate::lean::date_range_inclusive`], because the walk decides things: what
//! an unparseable endpoint means, and how wide a range is too wide to accept.
//! See `Verified.Sync.dateRangeInclusive` for both answers.

pub mod activity;
pub mod body;
pub mod daily;
pub mod heartrate;
pub mod hrv;
pub mod sleep;
pub mod steps;

/// How the caller answers "what zone was this wall clock recorded in?".
///
/// Forward sync passes an inference built from PhoneTrack and the Fitbit
/// profile; the backward backfill passes [`null_tz`], which writes `tz=NULL`
/// rows for the backfill CLI to fill in later. A closure rather than a mode
/// flag keeps that choice at the call site instead of inside the parsers.
///
/// It is asked PER WALL CLOCK and not per day, because the inference genuinely
/// can change within a day — a parser that resolved once would stamp a whole
/// day with the morning's zone.
/// ⚠ `Send + Sync` is load-bearing, not decoration. Every fetcher holds this
/// across an `await`, so without the bounds the resulting future is not `Send`
/// and cannot be spawned or awaited inside the run — which shows up as a wall
/// of errors pointing at the fetchers rather than at this line.
pub type TzSource<'a> = &'a (dyn Fn(&str, &str) -> Option<String> + Send + Sync + 'a);

/// The backfill's answer: nothing is known, so nothing is claimed.
pub fn null_tz(_date: &str, _time: &str) -> Option<String> {
    None
}

/// A date range wider than this is refused rather than walked.
///
/// Eleven years, which comfortably covers a full-history backfill from before
/// the account existed. It bounds the damage from a corrupt cursor; it is not a
/// truncation, and a request over it fails rather than syncing a prefix.
pub const MAX_RANGE_DAYS: i64 = 4000;

/// Split Fitbit's `2026-05-10T22:48:30.000` into its date and time halves.
///
/// Both the sleep log and its stages carry this shape, and the tz lookup wants
/// the two parts separately. Milliseconds are dropped, matching the TypeScript's
/// `.split(".")[0]`.
pub fn split_wall_clock(s: &str) -> (&str, &str) {
    match s.split_once('T') {
        Some((date, rest)) => (date, rest.split('.').next().unwrap_or(rest)),
        None => (s, ""),
    }
}
