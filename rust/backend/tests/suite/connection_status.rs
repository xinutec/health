//! Whether an account reads as linked (#982).
//!
//! ⚠ Production could not test this. Both connections are `active` on the real
//! account, so the parity run in `backend rows-check` exercises exactly one of
//! the three branches. The other two — and the fall-through that makes them
//! interesting — are only covered here.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

/// ⚠ ABSENCE is the only thing that reads as `not_linked`. Everything else,
/// including a status nobody has taught this about, reads as a WORKING
/// connection — so a future migration adding `revoked` would report a dead
/// credential to the user as fine until someone changes `Verified.Connection`.
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

/// ⚠ A revoked credential is still `linked: true` to the legacy boolean, so an
/// older SPA build shows "connected" for an account that cannot fetch anything.
/// The typed `connections` object is what carries the distinction; narrowing
/// the boolean would be more truthful and would change what those builds show.
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
