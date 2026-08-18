//! `date_bounds_utc` against the TypeScript it was transliterated from (#982).
//!
//! The cases in `fixtures/date-bounds-ts.json` were produced by RUNNING
//! `dist/geo/timezone.js`, not by writing down what I believed it did — see
//! `fixtures/date-bounds-ts.mjs`, which regenerates them. That distinction is
//! the whole value here: this function reproduces two defects on purpose, and a
//! hand-written expectation would have encoded my reading of them rather than
//! their behaviour.

use backend::timezone::date_bounds_utc;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    date: String,
    tz: Option<String>,
    start_utc: i64,
    end_utc: i64,
}

#[test]
fn every_case_matches_the_typescript() {
    let raw = include_str!("fixtures/date-bounds-ts.json");
    let cases: Vec<Case> = serde_json::from_str(raw).expect("fixture parses");
    assert!(cases.len() >= 100, "fixture shrank: {} cases", cases.len());

    let mut checked = 0;
    for c in &cases {
        let got = date_bounds_utc(&c.date, c.tz.as_deref())
            .unwrap_or_else(|e| panic!("{} {:?}: {e}", c.date, c.tz));
        assert_eq!(
            (got.start_utc, got.end_utc),
            (c.start_utc, c.end_utc),
            "{} in {:?}",
            c.date,
            c.tz
        );
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}

/// ⚠ The two defects, pinned SO THEY CANNOT BE FIXED BY ACCIDENT.
///
/// Both are the TypeScript's and both are reproduced deliberately, because the
/// 35-day golden corpus is the only oracle for the pipeline this feeds and a
/// port that differs cannot be checked against it. If either assertion starts
/// failing, someone has improved the behaviour — which may well be right, but
/// it re-blesses the corpus and is not a silent change.
#[test]
fn the_inherited_defects_are_still_here() {
    // A half-hour zone truncates to the hour: Asia/Kolkata is +05:30, and the
    // offset applied is +05:00, so the day starts 30 minutes late.
    let kolkata = date_bounds_utc("2026-01-15", Some("Asia/Kolkata")).unwrap();
    let utc_midnight = 1_768_435_200;
    assert_eq!(
        utc_midnight - kolkata.start_utc,
        5 * 3600,
        "+05:30 is applied as +05:00"
    );

    // A spring-forward day is still exactly 86400 seconds, so it runs one hour
    // past the next local midnight rather than stopping at it. 2026-03-29 is
    // when Europe/London goes to BST.
    let dst = date_bounds_utc("2026-03-29", Some("Europe/London")).unwrap();
    assert_eq!(
        dst.end_utc - dst.start_utc,
        86_400,
        "the day is a fixed 24h, not the next local midnight"
    );
}
