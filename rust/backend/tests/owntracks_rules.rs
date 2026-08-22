//! How hard a phone is told to look for itself (#982).
//!
//! ⚠ Both directions of error cost the user something real, and they are NOT
//! symmetric. Staying in Move drains a battery. Demoting early loses the walk
//! that was about to start, and that walk cannot be recovered afterwards. Every
//! threshold leans that way, and these tests pin the lean.

use backend::lean::{self, GatingPlace, OwntracksFix};

fn init() {
    lean::init().expect("lean host");
}

fn fix(ts: i64, lat: f64, lon: f64) -> OwntracksFix {
    OwntracksFix {
        ts,
        lat,
        lon,
        vel: None,
        trigger: None,
        monitoring_mode: None,
    }
}

/// A place the user lingers at — the only kind demotion is allowed at.
fn home() -> GatingPlace {
    GatingPlace {
        lat: 51.5,
        lon: -0.1,
        avg_dwell_sec: 0.0,
        sleep_hours: 8.0,
    }
}

/// A shop: visited often, never for long.
fn shop() -> GatingPlace {
    GatingPlace {
        lat: 51.5,
        lon: -0.1,
        avg_dwell_sec: 1800.0,
        sleep_hours: 0.0,
    }
}

/// ⚠ A single fast fix escalates with NO history. Boarding a train must not
/// wait for a trajectory to accumulate.
#[test]
fn high_speed_escalates_on_one_fix() {
    init();
    let mut f = fix(1000, 51.5, -0.1);
    f.vel = Some(100.0);
    f.monitoring_mode = Some(1);
    let d = lean::owntracks_config(&[f], None, &[], false).expect("decide");
    assert_eq!(d.profile, "transit-fast");
    assert_eq!(d.monitoring, 2);
    assert_eq!(d.move_mode_locator_interval, Some(10));
}

/// ⚠ THE SUPERMARKET CASE. Sitting still for ten minutes at a place the user
/// does NOT linger at must not demote — they are about to walk out, and the
/// walk home is what would be lost.
#[test]
fn a_shop_does_not_earn_a_demotion() {
    init();
    // Ten minutes of standing still, in Move mode.
    let history: Vec<OwntracksFix> = (0..11)
        .map(|i| {
            let mut f = fix(1000 + i * 60, 51.5, -0.1);
            f.monitoring_mode = Some(2);
            f
        })
        .collect();

    let at_shop =
        lean::owntracks_config(&history, Some("walking"), &[shop()], false).expect("decide");
    assert_eq!(
        at_shop.profile, "walking",
        "a shop must not earn a demotion — the walk out would be lost"
    );

    let at_home =
        lean::owntracks_config(&history, Some("walking"), &[home()], false).expect("decide");
    assert_eq!(
        at_home.profile, "stationary",
        "at a place they linger, the same evidence SHOULD demote"
    );
}

/// ⚠ A manual push suppresses demotion. The person has just said what they
/// want; stale "been here for hours" history must not override the one explicit
/// instruction the system ever gets.
#[test]
fn a_manual_push_suppresses_demotion() {
    init();
    let history: Vec<OwntracksFix> = (0..11)
        .map(|i| {
            let mut f = fix(1000 + i * 60, 51.5, -0.1);
            f.monitoring_mode = Some(2);
            f
        })
        .collect();
    let held = lean::owntracks_config(&history, Some("walking"), &[home()], true).expect("decide");
    assert_eq!(
        held.profile, "walking",
        "the hold must beat the demotion evidence"
    );
}

/// ⚠ With NO places loaded, nothing qualifies and demotion is off. That is the
/// safe direction when the database is unavailable: a little battery rather
/// than a lost journey.
#[test]
fn no_places_means_no_demotion() {
    init();
    let history: Vec<OwntracksFix> = (0..11)
        .map(|i| {
            let mut f = fix(1000 + i * 60, 51.5, -0.1);
            f.monitoring_mode = Some(2);
            f
        })
        .collect();
    let d = lean::owntracks_config(&history, Some("walking"), &[], false).expect("decide");
    assert_eq!(d.profile, "walking");
}

/// The first fix for an unknown device resolves to the phone's factory default,
/// so the pushed config is a no-op rather than a change it did not need.
#[test]
fn a_first_fix_pushes_the_factory_default() {
    init();
    let d = lean::owntracks_config(&[], None, &[], false).expect("decide");
    assert_eq!(d.profile, "stationary");
    assert_eq!(d.monitoring, 1);
    assert_eq!(d.move_mode_locator_interval, None);
}

/// ⚠ Walking pace WITHOUT straightness is a stationary phone's GPS noise, not a
/// walk. Escalating on it would burn battery at a desk.
#[test]
fn wandering_at_walking_pace_is_not_walking() {
    init();
    // Four minutes of jitter around one point, in Move mode: some path length,
    // almost no net displacement.
    let mut history = Vec::new();
    for i in 0..9 {
        let mut f = fix(
            1000 + i * 30,
            51.5 + if i % 2 == 0 { 0.0003 } else { -0.0003 },
            -0.1,
        );
        f.monitoring_mode = Some(2);
        history.push(f);
    }
    let d = lean::owntracks_config(&history, Some("stationary"), &[], false).expect("decide");
    assert_eq!(d.profile, "stationary", "jitter must not read as a walk");
}
