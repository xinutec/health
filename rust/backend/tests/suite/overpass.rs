//! The Overpass client's response handling. Overpass omits `elements` for an
//! empty result; read as an error, a genuinely empty tile would count against
//! the region and block a mirror rebuild.

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
    // Refuse rather than default. An unreadable response that decoded to "no
    // elements" would look exactly like an empty region and silently shrink the
    // cache — the same class of defect as the DECIMAL columns reading as 0.0.
    assert!(elements(r#"{"elements":{"id":1}}"#).is_err());
    assert!(elements(r#"{"elements":42}"#).is_err());
    assert!(elements("not json").is_err());
    assert!(elements("").is_err());
}

// --- which mirrors a retry may use ----------------------------------------

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
    // `kumi.systems` has never answered a tile in any measurement, only spent
    // FALLBACK_TIMEOUT_MS, so the retry skips it.
    for attempt in 1..4 {
        let urls = attempt_urls(attempt);
        assert_eq!(urls.len(), 1, "attempt {attempt}");
        assert!(urls[0].contains("overpass-api.de"));
    }
}

// --- a ban must not be retried ------------------------------------

use backend::overpass::Outcome;

// `Outcome::may_retry` is the production predicate, called here rather than
// restated. Written out again as a local `matches!`, these tests would pass
// whatever the tile loop actually does — including the opposite of this.

#[test]
fn a_throttled_tile_may_be_retried() {
    // 504 and 429 are the server talking. It has not stopped taking our
    // packets: a run can lose 15 tiles to 504s while other tiles in the same
    // window answer normally.
    let throttled = Outcome::AllFailed {
        errors: vec!["https://overpass-api.de/api/interpreter returned 504".into()],
        answered: true,
    };
    assert!(throttled.may_retry());
}

#[test]
fn a_banned_tile_is_not_retried() {
    // During a ban every connection is refused at once, `/api/status` included,
    // so `wait_for_slot` returns 0 and an unpaced retry would double the load.
    let banned = Outcome::AllFailed {
        errors: vec!["https://overpass-api.de/api/interpreter: error sending request".into()],
        answered: false,
    };
    assert!(!banned.may_retry());
}

#[test]
fn a_success_or_a_permanent_refusal_is_not_retried() {
    assert!(!Outcome::Ok("{}".into()).may_retry());
    assert!(!Outcome::Permanent { status: 400 }.may_retry());
}
