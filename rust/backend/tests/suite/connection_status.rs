//! Whether an account reads as linked. Production has both connections
//! `active`, so only this covers the other branches.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

/// Only absence reads as `not_linked`; any other status, including one nobody
/// taught `Verified.Connection`, reads as working.
#[test]
fn unknown_statuses_fall_through_to_active() {
    init();
    let cases: &[(Option<&str>, &str, bool)] = &[
        (None, "not_linked", false),
        (Some("needs_reauth"), "needs_reauth", true),
        (Some("active"), "active", true),
        // The fall-through, spelled out.
        (Some(""), "active", true),
        (Some("revoked"), "active", true),
        // Case-sensitive: only the exact string counts as broken.
        (Some("NEEDS_REAUTH"), "active", true),
    ];
    for (stored, want_status, want_linked) in cases {
        let (status, linked) = lean::connection_status(*stored).expect("status");
        assert_eq!(status, *want_status, "stored={stored:?}");
        assert_eq!(linked, *want_linked, "stored={stored:?}");
    }
}

/// A revoked credential is still `linked: true` to the legacy boolean that
/// older SPA builds read; `connections` carries the distinction.
#[test]
fn the_legacy_boolean_counts_needs_reauth_as_linked() {
    init();
    let (status, linked) = lean::connection_status(Some("needs_reauth")).expect("status");
    assert_eq!(status, "needs_reauth");
    assert!(
        linked,
        "the legacy flag deliberately does not distinguish this"
    );
}
