//! The day-input loaders' parsing decisions (#982).
//!
//! ⚠ NOTHING HERE TOUCHES A DATABASE, and that is a limit worth stating rather
//! than hiding: the queries are proven by `backend check` against production,
//! because no test in this crate executes SQL and "it compiles" says nothing
//! about a column name, a bind order, or the decode of a DECIMAL.
//!
//! What IS testable off a database is what the loader does with a blob it
//! cannot read — which is where a masking fallback would live.

use backend::classification_inputs::{next_date_string, parse_hour_profile, parse_stops};
use serde_json::Value;

#[test]
fn an_absent_hour_profile_is_null_not_empty() {
    // ⚠ null, NOT []. `hourProfileMatch` tests for null to mean "no
    // time-of-day signal"; an empty array is a profile asserting every hour is
    // equally unlikely.
    assert_eq!(parse_hour_profile(None), Value::Null);
    // The TS guard is `if (!s) return null`, and "" is falsy there.
    assert_eq!(parse_hour_profile(Some("")), Value::Null);
}

#[test]
fn a_real_hour_profile_is_comma_separated_per_mille_integers() {
    // ⚠ THIS IS THE FORMAT, and the first version of the loader got it wrong.
    // `serializeHourProfile` writes `round(f * 1000)` joined by commas into a
    // VARCHAR — reading it as JSON made every one of production's 117 profiles
    // decode to empty while the loader reported success.
    //
    // Taken from a real stored value rather than invented, because inventing
    // one is what produced the JSON tests this replaces.
    let stored = "59,58,56,55,53,52,49,44,32,25,22,21,22,24,27,29,31,32,36,45,52,57,58,61";
    let got = parse_hour_profile(Some(stored));
    let arr = got.as_array().expect("a 24-bucket profile");
    assert_eq!(arr.len(), 24);
    assert_eq!(arr[0].as_f64(), Some(0.059));
    assert_eq!(arr[23].as_f64(), Some(0.061));
}

#[test]
fn a_profile_of_the_wrong_length_is_rejected_whole() {
    // 23 buckets is not a profile missing an hour — it is a value written by
    // something that is not `serializeHourProfile`. The TS rejects on length
    // before looking at any bucket, and so does this.
    assert_eq!(parse_hour_profile(Some("1,2,3")), Value::Null);
    let twenty_five = (0..25).map(|_| "1").collect::<Vec<_>>().join(",");
    assert_eq!(parse_hour_profile(Some(&twenty_five)), Value::Null);
}

#[test]
fn a_non_numeric_bucket_voids_the_profile_rather_than_zeroing_it() {
    // A mined blob is evidence, so a corrupt one must read as "no evidence",
    // never as "this hour is impossible" — which is what a per-bucket default
    // of 0 would have claimed.
    let mut buckets = vec!["1"; 24];
    buckets[7] = "not-a-number";
    assert_eq!(parse_hour_profile(Some(&buckets.join(","))), Value::Null);
}

#[test]
fn an_empty_bucket_is_zero_because_that_is_what_number_does() {
    // ⚠ NOT a Rust decision. JS `Number("")` is 0, so `parseHourProfile` reads
    // `1,,1,…` as a zero bucket rather than voiding the row, and this has to
    // agree with the reader the writer was built against. `str::parse` errors
    // on "", so the case is handled before parsing.
    let mut buckets = vec!["1"; 24];
    buckets[3] = "";
    let got = parse_hour_profile(Some(&buckets.join(",")));
    let arr = got.as_array().expect("a 24-bucket profile");
    assert_eq!(arr[3].as_f64(), Some(0.0));
    assert_eq!(arr[2].as_f64(), Some(0.001));
}

// ---------------------------------------------------------------------------
// The mirror caches' drop rule (#982, second tranche)
// ---------------------------------------------------------------------------

#[test]
fn a_route_with_fewer_than_two_stops_is_no_answer() {
    // ⚠ This is the rule, not a size guard. The matcher anchors a leg's FIRST
    // and LAST fix to a route's stops, so a one-stop route cannot be matched
    // against at all — keeping it would put a row in the candidate set that no
    // input can ever select, which reads as "considered and rejected".
    assert_eq!(parse_stops("[]"), None);
    assert_eq!(parse_stops(r#"[{"name":"only"}]"#), None);
    assert!(parse_stops(r#"[{"name":"a"},{"name":"b"}]"#).is_some());
}

#[test]
fn a_corrupt_stops_blob_drops_the_route_rather_than_the_day() {
    // Bus and rail-stop naming are ADDITIVE evidence: the cost of a bad row is
    // an unnamed leg, and the cost of throwing is a timeline nobody can see.
    // The TypeScript makes the same call in `parseBusRouteRow`.
    assert_eq!(parse_stops("{not json"), None);
    // An OBJECT is not a stop list. Without the array check this hands a map to
    // a consumer that walks it by index.
    assert_eq!(parse_stops(r#"{"a":1,"b":2}"#), None);
    assert_eq!(parse_stops("null"), None);
}

#[test]
fn the_stop_array_is_passed_through_verbatim() {
    // ⚠ ORDER IS THE ROUTE'S DIRECTION. The matcher reads it to tell an
    // outbound leg from an inbound one, so this must not be normalised,
    // sorted, or re-keyed on the way through.
    let raw = r#"[{"name":"first","lat":1.5},{"name":"second","lat":2.5},{"name":"third"}]"#;
    assert_eq!(parse_stops(raw), Some(serde_json::from_str(raw).unwrap()));
}

// ---------------------------------------------------------------------------
// The sleep windows' second date
// ---------------------------------------------------------------------------

#[test]
fn the_evening_night_is_filed_under_tomorrow() {
    // A sleep row is filed under the date it ENDS on, so the night starting
    // tonight is stored under tomorrow. Getting this wrong loses the evening
    // window silently — the day still renders, just without a night.
    assert_eq!(next_date_string("2026-06-16").unwrap(), "2026-06-17");
    // Month and year ends, because "+1 day" written as string arithmetic is
    // where this would break and it would break on 12 days a year.
    assert_eq!(next_date_string("2026-06-30").unwrap(), "2026-07-01");
    assert_eq!(next_date_string("2026-12-31").unwrap(), "2027-01-01");
    // A leap year, since 2026 is not one and a test written only against it
    // would pass on a February that does not exist.
    assert_eq!(next_date_string("2024-02-28").unwrap(), "2024-02-29");
    assert_eq!(next_date_string("2026-02-28").unwrap(), "2026-03-01");
}

#[test]
fn a_date_that_is_not_a_date_is_an_error_not_a_guess() {
    // The date reaches this from a request path. Defaulting it would query a
    // day nobody asked about and return that day's sleep as this day's.
    assert!(next_date_string("not-a-date").is_err());
    assert!(next_date_string("2026-13-01").is_err());
    assert!(next_date_string("").is_err());
}
