//! The as-of-the-day prior, end to end through the real Lean op (#1405).
//!
//! ⚠ NOT A MOCK OF THE AGGREGATION. These call `lean::priors_as_of`, which
//! crosses the FFI into `Verified.Geo.VenuePrior.priorsAsOf`. A Rust-side
//! reimplementation would encode what I believe the aggregation does, and the
//! whole reason the cut lives in Lean is that `bumpStats`' insertion order is
//! read back by `shapeScore` as the subtype-universe size.

use backend::lean::{self, WirePriorEvent, priors_as_of};

/// ⚠ Per test, not once: nextest runs each in its own process, so a
/// `OnceLock` guard in one says nothing about another.
fn boot() {
    lean::init().expect("the Lean runtime must start");
}

fn ev(subtype: &str, start_unix: i64, dwell: u32, hour: u32) -> WirePriorEvent {
    WirePriorEvent {
        subtype: subtype.into(),
        start_unix,
        dwell,
        hour,
        // 1.0
        weight_bits: 1.0f64.to_bits().to_string(),
    }
}

/// Two subtypes, the second seen only later.
fn evidence() -> Vec<WirePriorEvent> {
    vec![
        ev("cafe", 1_000, 1, 10),
        ev("cafe", 2_000, 2, 11),
        ev("restaurant", 9_000, 2, 19),
    ]
}

fn subtypes(v: &serde_json::Value) -> Vec<String> {
    v["bySubtype"]
        .as_object()
        .expect("bySubtype is an object")
        .keys()
        .cloned()
        .collect()
}

#[test]
fn a_cut_after_everything_is_the_whole_prior() {
    boot();
    let v = priors_as_of(&evidence(), 10_000).unwrap();
    assert_eq!(v["totalVisits"], 3.0);
    let mut s = subtypes(&v);
    s.sort();
    assert_eq!(s, vec!["cafe", "restaurant"]);
}

/// ⚠ THE WHOLE POINT, IN ONE ASSERTION. A day before the restaurant was ever
/// visited must not know the subtype exists — that is the anachronism the
/// ticket is named for, where a May dinner was scored against September.
#[test]
fn a_past_day_cannot_see_later_evidence() {
    boot();
    let v = priors_as_of(&evidence(), 5_000).unwrap();
    assert_eq!(v["totalVisits"], 2.0);
    assert_eq!(subtypes(&v), vec!["cafe"]);
}

/// ⚠ INCLUSIVE, and on the stay's START. A stay beginning exactly at the cut
/// counts; keying on its end would make a long stay vanish from its own day.
#[test]
fn the_cut_includes_a_stay_starting_on_it() {
    boot();
    assert_eq!(
        priors_as_of(&evidence(), 2_000).unwrap()["totalVisits"],
        2.0
    );
    assert_eq!(
        priors_as_of(&evidence(), 1_999).unwrap()["totalVisits"],
        1.0
    );
}

/// No evidence yet is an empty prior, not an error and not a crash — the venue
/// scorer treats absent priors as zero evidence everywhere.
#[test]
fn a_cut_before_everything_is_empty() {
    boot();
    let v = priors_as_of(&evidence(), 0).unwrap();
    assert_eq!(v["totalVisits"], 0.0);
    assert!(subtypes(&v).is_empty());
}

/// ⚠ FRACTIONAL WEIGHTS SURVIVE THE WIRE. Soft attribution contributes `r` of a
/// visit, and `weight` is the one field that rides as bit patterns for exactly
/// that reason — a JSON number would be a second rounding nobody asked for.
#[test]
fn a_fractional_weight_crosses_intact() {
    boot();
    let mut e = ev("cafe", 1_000, 1, 10);
    e.weight_bits = 0.478f64.to_bits().to_string();
    let v = priors_as_of(&[e], 10_000).unwrap();
    assert_eq!(v["totalVisits"], 0.478);
}
