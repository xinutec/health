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

/// ⚠ NEXTCLOUD DROPS `state` for a browser with no NC session. That callback is
/// never trusted (RFC 6749 §10.12): with `state` empty nothing ties its code to
/// this browser, so anyone's code would sign it in. It is retried ONCE, and the
/// retry finds Nextcloud signed in, so `state` comes back. Refusing it outright
/// would strand a cookie-less browser, which is what stranded fleetwatch's
/// WebView.
#[test]
fn a_dropped_state_is_retried_once_never_trusted() {
    use lean::Callback::{Accept, Refuse, Retry};
    init();
    let payload =
        lean::encode_pending(2000, "the-nonce", false, Some("/your-day")).expect("encode");
    let pd = lean::decode_pending(&payload)
        .expect("decode")
        .expect("some");
    assert_eq!(pd.nonce, "the-nonce");
    assert!(!pd.retried);
    assert_eq!(pd.return_to.as_deref(), Some("/your-day"));
    let again = lean::encode_pending(2000, "fresh", true, Some("/your-day")).expect("encode");
    assert!(
        lean::decode_pending(&again)
            .expect("decode")
            .expect("some")
            .retried
    );

    // NC returned nothing, or an empty string: retried, never accepted.
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", false, None, 1000).expect("judge"),
        Retry
    );
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", false, Some(""), 1000).expect("judge"),
        Retry
    );
    // A second miss is refused.
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", true, None, 1000).expect("judge"),
        Refuse
    );
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", true, Some(""), 1000).expect("judge"),
        Refuse
    );
    // Returned and matching, on the first try or the retry.
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", false, Some("the-nonce"), 1000).expect("judge"),
        Accept
    );
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", true, Some("the-nonce"), 1000).expect("judge"),
        Accept
    );
    // ⚠ Returned and WRONG is a refusal.
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", false, Some("other"), 1000).expect("judge"),
        Refuse
    );
    // Expired.
    assert_eq!(
        lean::accept_pending(2000, "the-nonce", false, Some("the-nonce"), 2001).expect("judge"),
        Refuse
    );
}

/// ⚠ `returnTo` is encoded LAST so a `|` inside a query string cannot shift the
/// fields. A format that put it in the middle would let a crafted `return_to`
/// rewrite the expiry.
#[test]
fn a_pipe_in_the_return_path_cannot_shift_the_fields() {
    init();
    let payload = lean::encode_pending(1234, "n", false, Some("/x?a=1|2|3")).expect("encode");
    let pd = lean::decode_pending(&payload)
        .expect("decode")
        .expect("some");
    assert_eq!(pd.expires_at, 1234);
    assert_eq!(pd.nonce, "n");
    assert_eq!(pd.return_to.as_deref(), Some("/x?a=1|2|3"));
}

/// The proof both code exchanges demand is made only by a present `state` equal
/// to the stored one.
#[test]
fn the_proof_is_made_only_by_a_present_matching_state() {
    use backend::routes::oauth::StateMatched;
    assert!(StateMatched::check("n0nce", "n0nce").is_some());
    assert!(StateMatched::check("", "").is_none());
    assert!(StateMatched::check("", "n0nce").is_none());
    assert!(StateMatched::check("nonce", "n0nce").is_none());
    assert!(StateMatched::check("n0nc", "n0nce").is_none());
}
