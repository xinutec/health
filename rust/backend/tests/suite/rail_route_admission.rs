//! `rail_route::Admission` — which offered labels the same-day fill takes.

use std::time::{Duration, Instant};

use backend::rail_route::{Admission, REFUSED_FOR};

#[test]
fn a_label_is_taken_once_until_it_is_done() {
    let mut a = Admission::default();
    let t = Instant::now();
    assert!(a.admit("A → B · L", t));
    // A second fold offers the same leg while the first is queued.
    assert!(!a.admit("A → B · L", t));
    // Another label is independent.
    assert!(a.admit("B → C", t));
    a.finish("A → B · L", false, t);
    assert!(a.admit("A → B · L", t));
}

#[test]
fn a_refused_label_waits_its_time_and_is_then_tried_again() {
    let mut a = Admission::default();
    let t = Instant::now();
    assert!(a.admit("A → B", t));
    a.finish("A → B", true, t);
    assert!(!a.admit("A → B", t + REFUSED_FOR - Duration::from_secs(1)));
    assert!(a.admit("A → B", t + REFUSED_FOR));
}

#[test]
fn a_fill_clears_an_earlier_refusal() {
    let mut a = Admission::default();
    let t = Instant::now();
    a.admit("A → B", t);
    a.finish("A → B", true, t);
    let later = t + REFUSED_FOR;
    assert!(a.admit("A → B", later));
    a.finish("A → B", false, later);
    assert!(a.admit("A → B", later));
}
