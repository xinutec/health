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

// --- which mirrors a retry may use (#1153) ---------------------------------

use backend::overpass::attempt_urls;

#[test]
fn the_first_attempt_tries_every_mirror() {
    let urls = attempt_urls(0);
    assert_eq!(urls.len(), 2);
    assert!(urls[0].contains("overpass-api.de"));
    assert!(urls[1].contains("kumi.systems"));
}

#[test]
fn a_retry_skips_the_mirror_that_has_never_answered() {
    // ⚠ NOT a preference — `kumi.systems` has produced zero successful tiles in
    // every measurement taken of it (2026-09-12 from isis: connects in 0.15 s,
    // never answers; re-probed 2026-09-14: TCP connect in 0.02 s, then 25 s and
    // zero bytes). What it reliably does is spend FALLBACK_TIMEOUT_MS. Paying
    // that a second time for a tile buys nothing, and the retry exists to be
    // cheap enough that the nightly can afford it.
    for attempt in 1..4 {
        let urls = attempt_urls(attempt);
        assert_eq!(urls.len(), 1, "attempt {attempt}");
        assert!(urls[0].contains("overpass-api.de"));
    }
}
