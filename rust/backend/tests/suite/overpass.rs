//! The Overpass client's response handling (#982 Tier 2).
//!
//! ⚠ THE CASE THAT MATTERS IS A MISSING `elements` KEY. Overpass omits it for a
//! query that matched nothing, and reading that as an error would turn "this
//! tile has no bus routes" into a tile FAILURE — which feeds the refusal that
//! decides whether the mirror may be rebuilt. A whole region could be declared
//! broken because part of it is genuinely empty.

use backend::overpass::elements;

#[test]
fn missing_elements_is_empty_not_an_error() {
    assert!(elements(r#"{"version":0.6}"#).unwrap().is_empty());
    assert!(elements(r#"{"elements":null}"#).unwrap().is_empty());
    assert!(elements(r#"{"elements":[]}"#).unwrap().is_empty());
}

#[test]
fn elements_are_returned_in_order() {
    // Member order is the route direction downstream, so the transport layer
    // must not reorder.
    let e = elements(r#"{"elements":[{"id":1},{"id":2},{"id":3}]}"#).unwrap();
    assert_eq!(e.len(), 3);
    assert_eq!(e[0]["id"], 1);
    assert_eq!(e[2]["id"], 3);
}

#[test]
fn a_non_array_elements_is_an_error_not_an_empty_mirror() {
    // ⚠ Refuse rather than default. An unreadable response that decoded to "no
    // elements" would look exactly like an empty region and silently shrink the
    // cache — the same class of defect as the DECIMAL columns reading as 0.0.
    assert!(elements(r#"{"elements":{"id":1}}"#).is_err());
    assert!(elements(r#"{"elements":42}"#).is_err());
    assert!(elements("not json").is_err());
    assert!(elements("").is_err());
}
