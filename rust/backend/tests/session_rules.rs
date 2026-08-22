//! Session and share-viewer rules through the linked Lean host (#982).
//!
//! `Verified.Session`'s `#guard`s settle the rules; the framing cases among them
//! are what `verifyValue` returned under Node. These re-ask them across the
//! wire, because the crate links a PREBUILT static library and an op added to
//! `BackendEntry.lean` is invisible until `BackendEntry:static` is rebuilt.
//!
//! ⚠ The HMAC, the CSPRNG and the constant-time compare are NOT tested here
//! because they are not here. They are the host's, and there is nothing to prove
//! about them beyond that they were asked for.

use backend::lean;

#[test]
fn a_signed_value_splits_on_the_last_separator() {
    lean::init().expect("the Lean runtime must start");

    assert_eq!(
        lean::split_signed("abc.SIG").unwrap(),
        Some(("abc".into(), "SIG".into()))
    );
    // ⚠ THE CASE THE RULE EXISTS FOR. Splitting on the FIRST dot would hand the
    // verifier "a" and check it against "b.c.SIG" — a well-formed comparison of
    // the wrong bytes.
    assert_eq!(
        lean::split_signed("a.b.c.SIG").unwrap(),
        Some(("a.b.c".into(), "SIG".into()))
    );
    // An empty value is a value; it fails at the signature, not at the split.
    assert_eq!(
        lean::split_signed(".SIG").unwrap(),
        Some((String::new(), "SIG".into()))
    );
    // A trailing separator leaves an empty signature, which cannot verify.
    assert_eq!(
        lean::split_signed("abc.").unwrap(),
        Some(("abc".into(), String::new()))
    );
    assert_eq!(lean::split_signed("abcdef").unwrap(), None);
    assert_eq!(lean::split_signed("").unwrap(), None);
}

#[test]
fn a_session_expiring_exactly_now_is_still_valid() {
    lean::init().expect("the Lean runtime must start");
    assert!(lean::session_is_valid(1_000, 999).unwrap());
    // ⚠ Inclusive. Flipping this logs a user out a millisecond early for no
    // observable reason — the sort of boundary that gets changed by tidying.
    assert!(lean::session_is_valid(1_000, 1_000).unwrap());
    assert!(!lean::session_is_valid(1_000, 1_001).unwrap());
}

#[test]
fn a_share_viewer_may_read_everything_and_write_nothing() {
    lean::init().expect("the Lean runtime must start");
    let viewer = |m: &str, p: &str| lean::may_proceed(true, m, p).unwrap();

    assert!(viewer("GET", "/api/velocity"));
    assert!(!viewer("POST", "/api/settings"));
    assert!(!viewer("PUT", "/api/settings"));
    assert!(!viewer("DELETE", "/api/share"));
    assert!(!viewer("PATCH", "/api/settings"));
    // ⚠ A verb nobody has thought of yet is REFUSED. The test is "not GET",
    // not a list of writing verbs, so the API can grow without opening a hole.
    assert!(!viewer("PROPFIND", "/api/velocity"));
}

#[test]
fn telemetry_is_the_one_path_a_share_viewer_may_post_to_and_it_is_exact() {
    lean::init().expect("the Lean runtime must start");
    // It writes to the LOG, not the database, so it is outside the rule's
    // subject rather than an exception to it — and it is the only way to know
    // what a share recipient saw.
    assert!(lean::may_proceed(true, "POST", "/api/telemetry").unwrap());
    // ⚠ EXACT, not a prefix. A route mounted underneath is a different route,
    // and prefix-matching here would open every one of them.
    assert!(!lean::may_proceed(true, "POST", "/api/telemetry/bulk").unwrap());
    assert!(!lean::may_proceed(true, "POST", "/api/telemetryX").unwrap());
}

#[test]
fn the_owner_is_unrestricted() {
    lean::init().expect("the Lean runtime must start");
    assert!(lean::may_proceed(false, "POST", "/api/settings").unwrap());
    assert!(lean::may_proceed(false, "DELETE", "/api/share").unwrap());
}

#[test]
fn the_cookie_lifetime_matches_the_rows() {
    lean::init().expect("the Lean runtime must start");
    let p = lean::session_policy().expect("the policy crosses");
    assert_eq!(p.ttl_ms, 7 * 24 * 60 * 60 * 1000);
    assert_eq!(p.cookie_name, "session");
    // ⚠ The cookie must not outlive the row. A browser still sending a cookie
    // whose row has expired is a user who appears logged in and is not, and the
    // two numbers live in different places precisely often enough to drift.
    assert_eq!(
        p.cookie_max_age_s * 1000,
        p.ttl_ms,
        "the cookie's Max-Age and the session row's TTL must be the same window"
    );
}
