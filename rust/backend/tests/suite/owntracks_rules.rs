//! How often a phone is told to look for itself (#982).
//!
//! ⚠ It is NEVER told to stop looking. Pippijn's decision, 2026-09-23: a
//! missing journey is a hole in the record and a flat battery is not, so the
//! backend never pushes Significant mode. What it chooses is the locate
//! interval inside Move — and the night, when a still phone is asked once an
//! hour. These tests pin both halves.

use backend::lean::{self, OwntracksFix};

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

/// Ten minutes of standing still, in Move mode.
fn standstill() -> Vec<OwntracksFix> {
    (0..11)
        .map(|i| {
            let mut f = fix(1000 + i * 60, 51.5, -0.1);
            f.monitoring_mode = Some(2);
            f
        })
        .collect()
}

/// ⚠ A single fast fix escalates with NO history. Boarding a train must not
/// wait for a trajectory to accumulate.
#[test]
fn high_speed_escalates_on_one_fix() {
    init();
    let mut f = fix(1000, 51.5, -0.1);
    f.vel = Some(100.0);
    f.monitoring_mode = Some(1);
    let d = lean::owntracks_config(&[f], None, Some(12)).expect("decide");
    assert_eq!(d.profile, "transit-fast");
    assert_eq!(d.monitoring, 2);
    assert_eq!(d.move_mode_locator_interval, Some(10));
}

/// ⚠ THE STANDSTILL NEVER DEMOTES. Ten minutes still by day, with any
/// history: the phone keeps its Move profile. The rule that used to answer
/// "stationary" here cost a walk on 2026-06-07 and again on 2026-09-23.
#[test]
fn a_standstill_by_day_keeps_move_mode() {
    init();
    let d = lean::owntracks_config(&standstill(), Some("walking"), Some(12)).expect("decide");
    assert_eq!(d.profile, "walking");
    assert_eq!(d.monitoring, 2, "monitoring must stay Move");
}

/// ⚠ THE FIRST FIX PUTS THE PHONE IN MOVE. Every answer is a push, and the
/// old factory-default answer pushed Significant onto a walking phone after
/// every deploy.
#[test]
fn a_first_fix_pushes_move_mode() {
    init();
    let d = lean::owntracks_config(&[], None, None).expect("decide");
    assert_eq!(d.profile, "walking");
    assert_eq!(d.monitoring, 2);
    assert_eq!(d.move_mode_locator_interval, Some(30));
}

/// At night a still phone locates once an hour — still in Move mode.
#[test]
fn a_still_phone_at_night_locates_hourly() {
    init();
    let d = lean::owntracks_config(&standstill(), Some("walking"), Some(2)).expect("decide");
    assert_eq!(d.profile, "night");
    assert_eq!(d.monitoring, 2, "night is an interval, not a pause");
    assert_eq!(d.move_mode_locator_interval, Some(3600));
}

/// The window ends at 06:00 local: the same standstill at six is answered
/// with the day's cadence on the next fix that shows anything, and never
/// with another hour of silence.
#[test]
fn six_in_the_morning_is_not_night() {
    init();
    let mut history = standstill();
    history.push({
        let mut f = fix(1000 + 11 * 60, 51.5002, -0.1);
        f.monitoring_mode = Some(2);
        f
    });
    let d = lean::owntracks_config(&history, Some("night"), Some(6)).expect("decide");
    assert_ne!(d.move_mode_locator_interval, Some(3600));
}

/// A night walk seen at the hourly fix is answered with the walking cadence
/// at once: displacement counts as motion when `vel` is missing.
#[test]
fn motion_at_night_returns_to_walking_cadence() {
    init();
    let mut a = fix(1000, 51.5, -0.1);
    a.monitoring_mode = Some(2);
    let mut b = fix(1000 + 3600, 51.53, -0.1);
    b.monitoring_mode = Some(2);
    let d = lean::owntracks_config(&[a, b], Some("night"), Some(3)).expect("decide");
    assert_eq!(d.profile, "walking");
    assert_eq!(d.move_mode_locator_interval, Some(30));
}

/// ⚠ Walking pace WITHOUT straightness is a stationary phone's GPS noise, not a
/// walk: the profile is refined to nothing, so whatever was decided last holds.
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
    let d = lean::owntracks_config(&history, Some("transit"), Some(12)).expect("decide");
    assert_eq!(d.profile, "transit", "jitter must not read as a walk");
}
