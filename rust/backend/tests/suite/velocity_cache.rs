//! `/velocity`'s cache policy and the share window, asked through the linked
//! Lean host (#982).
//!
//! # Why this exists as well as the `#guard`s
//!
//! `Verified.VelocityCache` pins its own arithmetic at build time, and that
//! settles whether the RULE is right. It says nothing about whether this
//! process can reach it: the Rust crate links a PREBUILT static library, so an
//! op added to `BackendEntry.lean` is invisible until `lake build
//! BackendEntry:static` has run, and the symptom is an honest-looking
//! `unknown op` that reads as a broken op rather than an absent one.
//!
//! So these re-ask a few of the guard cases across the wire. A failure here is
//! about the link or the JSON, never about the decision.

use backend::lean;
use backend::timezone::local_date_at;

/// `Verified.VelocityCache.TTL_MS` and `LIVE_TTL_MS`, restated so a change to
/// either is a two-file edit rather than a silent drift.
const TTL_MS: i64 = 5 * 60 * 1000;
const LIVE_TTL_MS: i64 = 60 * 1000;

#[test]
fn a_day_in_progress_gets_the_short_window_and_a_settled_one_does_not() {
    lean::init().expect("the Lean runtime must start");

    let (live, max_entries) = lean::velocity_ttl_ms("2026-08-22", "2026-08-22").expect("live day");
    assert_eq!(live, LIVE_TTL_MS);
    let (settled, _) = lean::velocity_ttl_ms("2026-08-21", "2026-08-22").expect("settled day");
    assert_eq!(settled, TTL_MS);
    // ⚠ A FUTURE date is settled, not live. It is not the day in progress, and
    // giving it the short window would recompute an empty day every minute.
    let (future, _) = lean::velocity_ttl_ms("2026-08-23", "2026-08-22").expect("future day");
    assert_eq!(future, TTL_MS);

    assert_eq!(max_entries, 32, "the LRU bound crosses with the TTL");
}

#[test]
fn freshness_is_strict_at_the_bound_and_refuses_an_entry_from_the_future() {
    lean::init().expect("the Lean runtime must start");

    assert!(lean::velocity_cache_fresh(1000, 1000, TTL_MS).unwrap());
    assert!(lean::velocity_cache_fresh(1000, 1000 + TTL_MS - 1, TTL_MS).unwrap());
    // Exactly at the TTL is STALE — the direction that cannot serve something
    // older than the window promises.
    assert!(!lean::velocity_cache_fresh(1000, 1000 + TTL_MS, TTL_MS).unwrap());

    // ⚠ The one failure that would never expire by itself: an entry stamped in
    // the future reads as eternally fresh under plain subtraction.
    assert!(!lean::velocity_cache_fresh(5000, 4999, TTL_MS).unwrap());
}

#[test]
fn the_share_window_is_inclusive_at_both_ends() {
    lean::init().expect("the Lean runtime must start");

    let win = |d: &str| lean::date_in_share_window(d, "2026-08-11", "2026-08-17").unwrap();
    assert!(win("2026-08-11"), "the first day of the window is visible");
    assert!(win("2026-08-17"), "the last day of the window is visible");
    assert!(win("2026-08-14"));
    assert!(!win("2026-08-10"));
    assert!(!win("2026-08-18"));
}

#[test]
fn liveness_is_decided_on_the_viewers_local_date_not_utc() {
    lean::init().expect("the Lean runtime must start");

    // An instant where the two DISAGREE, which is the only kind that tests
    // anything: London is on BST (+01:00) in August, so 23:30 UTC is already
    // 00:30 the NEXT day there. The viewer has rolled over and UTC has not.
    let instant = 1787527800; // 2026-08-23T23:30:00Z = 2026-08-24 00:30 London
    let utc = local_date_at(instant, None).expect("UTC date");
    let london = local_date_at(instant, Some("Europe/London")).expect("London date");
    assert_ne!(
        utc, london,
        "this instant must straddle local midnight or the test proves nothing"
    );

    // ⚠ The whole point: the viewer is already on the 24th, so THAT is the day
    // in progress. Deciding on the UTC date would freeze their evening's
    // timeline for the last hour of the day.
    let (by_london, _) = lean::velocity_ttl_ms(&london, &london).unwrap();
    assert_eq!(by_london, LIVE_TTL_MS);
    let (by_utc, _) = lean::velocity_ttl_ms(&london, &utc).unwrap();
    assert_eq!(
        by_utc, TTL_MS,
        "passing the UTC date asks a different question and gets a plausible answer"
    );
}
