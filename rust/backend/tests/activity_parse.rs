//! The daily activity summary's optional fields (#982).
//!
//! ⚠ THIS FILE EXISTS BECAUSE A PRODUCTION RUN FAILED. The parser required
//! `floors`, Fitbit omits it for a tracker with no altimeter, and the whole
//! activity stream was lost for three days — steps, calories, distance and every
//! active-minute band — over an absent stair count.
//!
//! Synthetic fixtures had not caught it, and could not have: they were written
//! from the shape Fitbit sends for a device that HAS the field. That is the
//! general lesson worth more than the fix — a fixture built from one device's
//! response encodes that device's capabilities as if they were the API's.

use backend::fitbit::sync::activity::parse_activity_summary;

/// A complete response, as a device with every sensor sends it.
const FULL: &str = r#"{
  "summary": {
    "steps": 8421, "caloriesOut": 2310.5, "activityCalories": 812.0,
    "distances": [
      {"activity": "total", "distance": 6.42},
      {"activity": "tracker", "distance": 6.40},
      {"activity": "loggedActivities", "distance": 0.0}
    ],
    "floors": 12, "elevation": 36.5,
    "sedentaryMinutes": 620, "lightlyActiveMinutes": 210,
    "fairlyActiveMinutes": 35, "veryActiveMinutes": 18,
    "restingHeartRate": 54, "activeScore": -1
  }
}"#;

#[test]
fn a_complete_summary_reports_nothing_absent() {
    let r = parse_activity_summary(FULL).unwrap();
    assert_eq!(r.steps, Some(8421));
    assert_eq!(r.calories_total, Some(2310.5));
    assert_eq!(r.floors, Some(12));
    assert_eq!(r.resting_heart_rate, Some(54));
    // Only the `total` entry is the day's figure, not the first or the sum.
    assert_eq!(r.distance_km, Some(6.42));
    assert!(r.absent.is_empty(), "nothing missing: {:?}", r.absent);
}

/// ⚠ THE REGRESSION. A tracker without an altimeter sends no `floors` and no
/// `elevation`. Everything else must still be stored.
#[test]
fn a_tracker_without_an_altimeter_still_stores_its_day() {
    let body = r#"{
      "summary": {
        "steps": 8421, "caloriesOut": 2310.5, "activityCalories": 812.0,
        "distances": [{"activity": "total", "distance": 6.42}],
        "sedentaryMinutes": 620, "lightlyActiveMinutes": 210,
        "fairlyActiveMinutes": 35, "veryActiveMinutes": 18,
        "activeScore": -1
      }
    }"#;
    let r = parse_activity_summary(body).expect("an absent field must not lose the day");
    assert_eq!(r.steps, Some(8421), "the day's steps survive");
    assert_eq!(r.distance_km, Some(6.42));
    assert_eq!(r.floors, None, "absent is NULL, not zero");
    assert_eq!(r.elevation_m, None);
    assert_eq!(r.absent, ["floors", "elevation"]);
}

/// `restingHeartRate` is legitimately absent on a day with too little coverage
/// to compute one, so it must NOT be reported as a gap — a warning that fires on
/// ordinary days trains the reader to ignore it.
#[test]
fn an_absent_resting_heart_rate_is_not_reported_as_a_gap() {
    let body = FULL.replace(r#""restingHeartRate": 54,"#, "");
    let r = parse_activity_summary(&body).unwrap();
    assert_eq!(r.resting_heart_rate, None);
    assert!(r.absent.is_empty(), "must not be listed: {:?}", r.absent);
}

/// ⚠ Zero distance and unknown distance are different facts. Fitbit sends a
/// `total` entry reading 0 for a day spent still, so an ABSENT breakdown means
/// the API did not say — and writing 0.0 would manufacture a day of no movement
/// out of a gap in the response.
#[test]
fn an_absent_distance_is_none_and_a_still_day_is_zero() {
    let no_distances = r#"{"summary": {"steps": 100, "caloriesOut": 1.0, "activityCalories": 1.0,
      "floors": 0, "elevation": 0.0, "sedentaryMinutes": 1, "lightlyActiveMinutes": 1,
      "fairlyActiveMinutes": 1, "veryActiveMinutes": 1, "activeScore": -1}}"#;
    let r = parse_activity_summary(no_distances).unwrap();
    assert_eq!(r.distance_km, None, "not reported is not zero");
    assert!(r.absent.contains(&"distances"));

    // A breakdown with no `total` entry is equally not a claim of zero.
    let no_total = r#"{"summary": {"steps": 100, "caloriesOut": 1.0, "activityCalories": 1.0,
      "distances": [{"activity": "tracker", "distance": 1.5}],
      "floors": 0, "elevation": 0.0, "sedentaryMinutes": 1, "lightlyActiveMinutes": 1,
      "fairlyActiveMinutes": 1, "veryActiveMinutes": 1, "activeScore": -1}}"#;
    assert_eq!(parse_activity_summary(no_total).unwrap().distance_km, None);

    // A genuinely still day DOES carry a total, and it is zero — a fact.
    let still = r#"{"summary": {"steps": 0, "caloriesOut": 1500.0, "activityCalories": 0.0,
      "distances": [{"activity": "total", "distance": 0}],
      "floors": 0, "elevation": 0.0, "sedentaryMinutes": 1440, "lightlyActiveMinutes": 0,
      "fairlyActiveMinutes": 0, "veryActiveMinutes": 0, "activeScore": -1}}"#;
    let r = parse_activity_summary(still).unwrap();
    assert_eq!(r.distance_km, Some(0.0), "zero reported IS zero");
    assert_eq!(r.steps, Some(0));
    assert!(r.absent.is_empty());
}

/// An empty summary is not an error — every column is nullable — but it must
/// say so loudly rather than writing a row of silent NULLs.
#[test]
fn an_empty_summary_stores_nulls_and_names_every_gap() {
    let r = parse_activity_summary(r#"{"summary": {}}"#).unwrap();
    assert_eq!(r.steps, None);
    assert_eq!(
        r.absent.len(),
        11,
        "every field but restingHeartRate: {:?}",
        r.absent
    );
    assert!(r.absent.contains(&"steps"));
}

/// Refusal is reserved for a body with no summary at all — there is then no day
/// to write, as opposed to a day with holes in it.
#[test]
fn a_body_without_a_summary_refuses() {
    for body in [
        "not json",
        "{}",
        r#"{"summary": null}"#,
        r#"{"activities": []}"#,
    ] {
        assert!(parse_activity_summary(body).is_err(), "must refuse: {body}");
    }
}
