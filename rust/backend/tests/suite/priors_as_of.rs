//! The as-of-the-day prior through the real Lean op (`lean::priors_as_of` →
//! `Verified.Geo.VenuePrior.priorsAsOf`), not a Rust model of it: `bumpStats`'
//! insertion order is read back by `shapeScore` as the subtype-universe size.

use backend::lean::{self, WirePriorEvent, priors_as_of};

/// Per test, not once: nextest runs each in its own process, so a
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

/// A day before a venue was first visited must not know its subtype exists, or
/// an early dinner is scored with later knowledge.
#[test]
fn a_past_day_cannot_see_later_evidence() {
    boot();
    let v = priors_as_of(&evidence(), 5_000).unwrap();
    assert_eq!(v["totalVisits"], 2.0);
    assert_eq!(subtypes(&v), vec!["cafe"]);
}

/// Inclusive, and on the stay's start. A stay beginning exactly at the cut
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

/// Fractional weights survive the wire: soft attribution contributes `r` of a
/// visit, so `weight` rides as bit patterns.
#[test]
fn a_fractional_weight_crosses_intact() {
    boot();
    let mut e = ev("cafe", 1_000, 1, 10);
    e.weight_bits = 0.478f64.to_bits().to_string();
    let v = priors_as_of(&[e], 10_000).unwrap();
    assert_eq!(v["totalVisits"], 0.478);
}
