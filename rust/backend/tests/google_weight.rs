//! The Google Health weight feed and its dedup (#260, #982).
//!
//! ⚠ ONE `#[test]`, for the reason `lean_ffi.rs` gives: `health_backend_init`
//! starts a process-global runtime and cargo does not serialise tests within a
//! binary. The page-parsing half needs no runtime, but splitting it across two
//! files to gain nothing would just be a second place to look.
//!
//! The masses below are plausible-but-invented numbers. No real measurements.

use backend::google::health::parse_page;
use backend::lean::{self, Weigh};

fn w(date: &str, grams: i64, ts: &str) -> Weigh {
    Weigh {
        date: date.to_string(),
        grams,
        ts: ts.to_string(),
    }
}

#[test]
fn the_weight_feed_and_its_dedup() {
    // ---- the wire shape ------------------------------------------------------
    let page = r#"{
      "dataPoints": [
        {"weight": {"weightGrams": 67300,
                    "sampleTime": {"physicalTime": "2026-08-01T07:12:00Z",
                                   "civilTime": {"date": {"year": 2026, "month": 8, "day": 1}}}}},
        {"weight": {"weightGrams": "68150",
                    "sampleTime": {"physicalTime": "2026-08-02T07:05:00Z",
                                   "civilTime": {"date": {"year": 2026, "month": 8, "day": 2}}}}}
      ],
      "nextPageToken": "abc"
    }"#;
    let (points, next) = parse_page(page).unwrap();
    assert_eq!(points.len(), 2);
    assert_eq!(points[0], w("2026-08-01", 67300, "2026-08-01T07:12:00Z"));
    // ⚠ THE QUOTED FORM. Google's JSON mapping for int64 quotes some values, and
    // a plain `i64` field silently fails to decode it — dropping the point as
    // malformed rather than erroring.
    assert_eq!(points[1].grams, 68150);
    assert_eq!(next.as_deref(), Some("abc"));

    // Single-digit months and days are zero-padded, or the date sorts wrongly
    // as a string and the dedup groups the wrong points together.
    let padded = r#"{"dataPoints":[{"weight":{"weightGrams":1,
        "sampleTime":{"physicalTime":"x","civilTime":{"date":{"year":2026,"month":1,"day":2}}}}}]}"#;
    assert_eq!(parse_page(padded).unwrap().0[0].date, "2026-01-02");

    // An absent `physicalTime` is an empty ts, not a dropped point: the civil
    // date is what places it, and that is present.
    let no_ts = r#"{"dataPoints":[{"weight":{"weightGrams":70000,
        "sampleTime":{"civilTime":{"date":{"year":2026,"month":8,"day":3}}}}}]}"#;
    assert_eq!(parse_page(no_ts).unwrap().0[0].ts, "");

    // A point that cannot name a day or a mass is skipped — it could not be
    // placed without inventing one of them.
    let unusable = r#"{"dataPoints":[
        {"weight":{"sampleTime":{"civilTime":{"date":{"year":2026,"month":8,"day":4}}}}},
        {"weight":{"weightGrams":70000,"sampleTime":{"physicalTime":"2026-08-04T07:00:00Z"}}},
        {"weight":{"weightGrams":70000}},
        {}
      ]}"#;
    assert!(parse_page(unusable).unwrap().0.is_empty());

    // An empty page is empty, and an EMPTY token is the end rather than a token.
    let (empty, none) = parse_page(r#"{"dataPoints":[],"nextPageToken":""}"#).unwrap();
    assert!(empty.is_empty());
    assert_eq!(none, None, "an empty token must terminate the walk");
    assert!(parse_page("{}").unwrap().0.is_empty());
    assert!(parse_page("not json").is_err());

    // ---- the dedup, through the FFI -----------------------------------------
    lean::init().expect("lean runtime");

    let plan = lean::dedupe_weigh_ins(&[
        w("2026-08-01", 67000, "2026-08-01T07:00:00Z"),
        w("2026-08-01", 68000, "2026-08-01T19:00:00Z"),
        w("2026-08-03", 66500, "2026-08-03T07:00:00Z"),
    ])
    .unwrap();
    assert_eq!(plan.kept.len(), 2, "one row per civil date");
    assert_eq!(
        plan.kept[0].grams, 68000,
        "the LATEST weigh-in wins the day"
    );
    assert_eq!(
        plan.replace_from.as_deref(),
        Some("2026-08-01"),
        "the boundary is the earliest covered day"
    );
    assert_eq!(
        plan.kept
            .iter()
            .map(|k| k.date.as_str())
            .collect::<Vec<_>>(),
        ["2026-08-01", "2026-08-03"],
        "sorted ascending regardless of arrival order"
    );

    // Arrival order does not change the answer.
    let reversed = lean::dedupe_weigh_ins(&[
        w("2026-08-01", 68000, "2026-08-01T19:00:00Z"),
        w("2026-08-01", 67000, "2026-08-01T07:00:00Z"),
    ])
    .unwrap();
    assert_eq!(reversed.kept[0].grams, 68000);

    // A timestamped weigh-in beats an untimestamped one on the same day, both
    // ways round — an empty ts sorts below every real one.
    for pair in [
        [
            w("2026-08-01", 111, ""),
            w("2026-08-01", 222, "2026-08-01T07:00:00Z"),
        ],
        [
            w("2026-08-01", 222, "2026-08-01T07:00:00Z"),
            w("2026-08-01", 111, ""),
        ],
    ] {
        assert_eq!(lean::dedupe_weigh_ins(&pair).unwrap().kept[0].grams, 222);
    }

    // ⚠ THE GUARD THAT MATTERS MOST. An empty fetch names NO boundary, so the
    // caller deletes nothing. A Google outage, a revoked token and a scope
    // change all return zero points, and reading that as "replace from the
    // beginning of time" would empty the weight history.
    let nothing = lean::dedupe_weigh_ins(&[]).unwrap();
    assert_eq!(nothing.replace_from, None);
    assert!(nothing.kept.is_empty());
}
