//! The day-input loaders' parsing decisions (#982).
//!
//! ⚠ NOTHING HERE TOUCHES A DATABASE, and that is a limit worth stating rather
//! than hiding: the queries are proven by `backend check` against production,
//! because no test in this crate executes SQL and "it compiles" says nothing
//! about a column name, a bind order, or the decode of a DECIMAL.
//!
//! What IS testable off a database is what the loader does with a blob it
//! cannot read — which is where a masking fallback would live.

use backend::classification_inputs::parse_hour_profile;
use serde_json::json;

#[test]
fn an_absent_hour_profile_is_empty_not_missing() {
    assert_eq!(parse_hour_profile(None), json!([]));
}

#[test]
fn an_unparseable_hour_profile_is_empty_rather_than_fatal() {
    // A mined blob is evidence. Losing it weakens the place picker; failing the
    // day over it would lose the day. The loader WARNS on both of these — the
    // default without the warning is the mask `dev-lint` refuses.
    assert_eq!(parse_hour_profile(Some("{not json")), json!([]));
    // ⚠ An OBJECT is not a profile either. Without the array check this hands a
    // map to a consumer that indexes it by hour.
    assert_eq!(parse_hour_profile(Some(r#"{"0":1}"#)), json!([]));
    assert_eq!(parse_hour_profile(Some("null")), json!([]));
}

#[test]
fn a_real_hour_profile_survives() {
    assert_eq!(parse_hour_profile(Some("[1,2,3]")), json!([1, 2, 3]));
}
