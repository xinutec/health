//! Wall-clock → UTC, where it can be wrong: the wall clock that never happened
//! and the one that happened twice. Legacy Fitbit rows' `ts_utc` depends on it.
//! Europe/London, at its real 2026 transitions (29 March 01:00 → 02:00, 25
//! October 02:00 → 01:00).

use backend::timezone::{parse_wall_clock, wall_clock_to_unix, wall_clock_to_utc_string};

#[test]
fn a_plain_winter_wall_clock_is_utc_in_london() {
    // GMT: the wall clock and UTC agree.
    assert_eq!(
        wall_clock_to_utc_string("2026-01-15 08:30:00", Some("Europe/London")).as_deref(),
        Some("2026-01-15 08:30:00")
    );
}

#[test]
fn a_summer_wall_clock_loses_the_bst_hour() {
    // BST is UTC+1, so 14:30 local is 13:30 UTC.
    assert_eq!(
        wall_clock_to_utc_string("2026-08-17 14:30:00", Some("Europe/London")).as_deref(),
        Some("2026-08-17 13:30:00")
    );
}

#[test]
fn a_zone_that_is_not_utc_offset_by_a_whole_hour() {
    // Half-hour zones catch an implementation that stores offsets as hours.
    assert_eq!(
        wall_clock_to_utc_string("2026-08-17 14:30:00", Some("Asia/Kolkata")).as_deref(),
        Some("2026-08-17 09:00:00")
    );
}

#[test]
fn an_absent_timezone_yields_nothing_rather_than_a_guess() {
    // The contract. A guess stored in a column declared to hold UTC is worse
    // than an absent value: nothing downstream can tell it was a guess.
    assert_eq!(wall_clock_to_utc_string("2026-08-17 14:30:00", None), None);
}

#[test]
fn a_malformed_wall_clock_yields_nothing() {
    assert_eq!(
        wall_clock_to_utc_string("not a timestamp", Some("Europe/London")),
        None
    );
    assert_eq!(wall_clock_to_utc_string("", Some("Europe/London")), None);
    assert_eq!(
        wall_clock_to_utc_string("2026-08-17 14:30:00", Some("Not/AZone")),
        None
    );
}

#[test]
fn both_separators_parse_and_a_suffix_is_ignored() {
    // The parse is unanchored: stored rows carry a `.000Z` suffix and must
    // still parse to the same wall clock.
    let a = parse_wall_clock("2026-08-17 14:30:00").expect("space form");
    let b = parse_wall_clock("2026-08-17T14:30:00").expect("T form");
    let c = parse_wall_clock("2026-08-17T14:30:00.000Z").expect("suffixed form");
    assert_eq!(a, b);
    assert_eq!(a, c);
}

#[test]
fn the_wall_clock_that_happened_twice_takes_the_later_instant() {
    // Autumn: 01:30 occurs twice (00:30 UTC on BST, 01:30 UTC on GMT). These
    // are stored rows' instants: choosing the earlier reading would silently
    // re-time rows already stored.
    assert_eq!(
        wall_clock_to_utc_string("2026-10-25 01:30:00", Some("Europe/London")).as_deref(),
        Some("2026-10-25 01:30:00")
    );
    assert_eq!(
        wall_clock_to_utc_string("2026-10-25 01:00:00", Some("Europe/London")).as_deref(),
        Some("2026-10-25 01:00:00")
    );
    // Either side of the ambiguity is unambiguous and must be untouched.
    assert_eq!(
        wall_clock_to_utc_string("2026-10-25 00:30:00", Some("Europe/London")).as_deref(),
        Some("2026-10-24 23:30:00"),
        "still BST"
    );
    assert_eq!(
        wall_clock_to_utc_string("2026-10-25 03:30:00", Some("Europe/London")).as_deref(),
        Some("2026-10-25 03:30:00"),
        "now GMT"
    );
    assert_eq!(
        wall_clock_to_utc_string("2026-10-25 00:30:00", Some("Europe/London")).as_deref(),
        Some("2026-10-24 23:30:00"),
        "still BST, and the previous UTC day"
    );
}

#[test]
fn the_wall_clock_that_never_happened_reads_on_the_post_transition_offset() {
    // Spring: 01:00–01:59 name no instant, yet must resolve (a null `ts_utc`
    // loses a real point) without searching. Production gives 00:30 UTC, not
    // the intuitive 01:30.
    assert!(
        wall_clock_to_unix("2026-03-29 01:30:00", "Europe/London").is_some(),
        "a nonexistent wall clock must still resolve"
    );
    for (wall, utc) in [
        ("2026-03-29 01:00:00", "2026-03-29 00:00:00"),
        ("2026-03-29 01:15:00", "2026-03-29 00:15:00"),
        ("2026-03-29 01:30:00", "2026-03-29 00:30:00"),
        ("2026-03-29 01:45:00", "2026-03-29 00:45:00"),
    ] {
        assert_eq!(
            wall_clock_to_utc_string(wall, Some("Europe/London")).as_deref(),
            Some(utc),
            "{wall} in the spring-forward gap"
        );
    }
    // Either side is unambiguous.
    assert_eq!(
        wall_clock_to_utc_string("2026-03-29 00:30:00", Some("Europe/London")).as_deref(),
        Some("2026-03-29 00:30:00"),
        "GMT"
    );
    assert_eq!(
        wall_clock_to_utc_string("2026-03-29 02:00:00", Some("Europe/London")).as_deref(),
        Some("2026-03-29 01:00:00"),
        "BST"
    );
    assert_eq!(
        wall_clock_to_utc_string("2026-03-29 03:30:00", Some("Europe/London")).as_deref(),
        Some("2026-03-29 02:30:00"),
        "BST"
    );
}

#[test]
fn the_fall_back_transition_stays_monotonic() {
    // Velocity work differentiates these timestamps, so a series that goes
    // backwards produces a negative interval and an infinite speed. Fall back
    // is safe under the later-instant reading, and this pins that.
    let mut prev: Option<i64> = None;
    for h in 0..5 {
        for m in [0, 15, 30, 45] {
            let s = format!("2026-10-25 {h:02}:{m:02}:00");
            let t = wall_clock_to_unix(&s, "Europe/London")
                .unwrap_or_else(|| panic!("{s} must resolve"));
            if let Some(p) = prev {
                assert!(t >= p, "{s} went backwards: {t} after {p}");
            }
            prev = Some(t);
        }
    }
}

#[test]
fn the_spring_forward_gap_is_not_monotonic_and_that_is_recorded_not_repaired() {
    // Asserts a known non-monotonicity: `00:45` → 00:45 UTC, then `01:00` →
    // 00:00. A device never reports a time inside the gap (its clock jumps
    // too), so such a row is corrupt on arrival. Do not "fix" this here.
    let before = wall_clock_to_unix("2026-03-29 00:45:00", "Europe/London").unwrap();
    let in_gap = wall_clock_to_unix("2026-03-29 01:00:00", "Europe/London").unwrap();
    assert!(
        in_gap < before,
        "the gap reading is expected to go backwards; if this now holds, the \
         reading changed and the stored ts_utc values changed with it"
    );
    assert_eq!(in_gap, before - 45 * 60, "exactly 45 minutes back");
}
