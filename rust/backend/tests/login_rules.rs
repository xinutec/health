//! The two sign-in guards (#982).
//!
//! Both are small, both are security boundaries, and both fail in ways nobody
//! would notice from the outside: an open redirect looks like a working login,
//! and a pending-login check that is too strict looks like an account that
//! simply cannot sign in.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

/// ⚠ THE OPEN-REDIRECT GUARD. `/login?return_to=//evil.com` sends the browser
/// off-site AFTER a successful login, when the user has every reason to trust
/// what they are looking at.
#[test]
fn return_to_refuses_anything_that_leaves_the_site() {
    init();
    let hostile = [
        // Protocol-relative: looks like a path, is not.
        "//evil.com",
        // ⚠ Some browsers normalise `\` to `/`, so this BECOMES the case above
        // inside the browser and not inside a naive check.
        "/\\evil.com",
        "https://evil.com",
        "http://evil.com",
        "javascript:alert(1)",
        // Whitespace and control characters are refused rather than escaped.
        "/a b",
        "/a\nb",
        "/<script>",
        "",
    ];
    for raw in hostile {
        assert_eq!(
            lean::validate_return_to(Some(raw)).expect("validateReturnTo"),
            "/",
            "return_to={raw:?} must not survive"
        );
    }
    assert_eq!(lean::validate_return_to(None).expect("absent"), "/");
}

/// Ordinary internal paths still work — otherwise the guard would be a blanket
/// block and the reconnect banner it exists for would stop functioning.
#[test]
fn return_to_keeps_internal_paths() {
    init();
    for ok in ["/your-day", "/your-day?date=2026-08-22", "/settings", "/"] {
        assert_eq!(
            lean::validate_return_to(Some(ok)).expect("validateReturnTo"),
            ok,
            "return_to={ok:?} should be kept"
        );
    }
}

/// ⚠ NEXTCLOUD DROPS `state` for a browser with no NC session, and the login
/// must still complete. A server that required `state` could not sign in a
/// cookie-less browser AT ALL — that is what stranded fleetwatch's WebView.
#[test]
fn a_dropped_state_still_completes_the_login() {
    init();
    let payload = lean::encode_pending(2000, "the-nonce", Some("/your-day")).expect("encode");
    let pd = lean::decode_pending(&payload)
        .expect("decode")
        .expect("some");
    assert_eq!(pd.nonce, "the-nonce");
    assert_eq!(pd.return_to.as_deref(), Some("/your-day"));

    // NC returned nothing, or an empty string: the cookie stands alone.
    assert!(lean::accept_pending(2000, "the-nonce", None, 1000).expect("accept"));
    assert!(lean::accept_pending(2000, "the-nonce", Some(""), 1000).expect("accept"));
    // Returned and matching.
    assert!(lean::accept_pending(2000, "the-nonce", Some("the-nonce"), 1000).expect("accept"));
    // ⚠ Returned and WRONG is a refusal — the check still bites when NC honours
    // the parameter.
    assert!(!lean::accept_pending(2000, "the-nonce", Some("other"), 1000).expect("accept"));
    // Expired.
    assert!(!lean::accept_pending(2000, "the-nonce", Some("the-nonce"), 2001).expect("accept"));
}

/// ⚠ `returnTo` is encoded LAST so a `|` inside a query string cannot shift the
/// fields. A format that put it in the middle would let a crafted `return_to`
/// rewrite the expiry.
#[test]
fn a_pipe_in_the_return_path_cannot_shift_the_fields() {
    init();
    let payload = lean::encode_pending(1234, "n", Some("/x?a=1|2|3")).expect("encode");
    let pd = lean::decode_pending(&payload)
        .expect("decode")
        .expect("some");
    assert_eq!(pd.expires_at, 1234);
    assert_eq!(pd.nonce, "n");
    assert_eq!(pd.return_to.as_deref(), Some("/x?a=1|2|3"));
}
