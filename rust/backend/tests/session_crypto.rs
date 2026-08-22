//! The signing half of auth (#982) — the part that is NOT in Lean.
//!
//! # ⚠ The expected signatures come from Node, not from this implementation
//!
//! Every string below was printed by `lean/experiments/session-refs.mts` calling
//! the production `signValue`. That matters because the failure modes here are
//! all silent: `digest("base64url")` is UNPADDED, so a port that pads produces a
//! perfectly well-formed signature that never matches; HMACing the wrong bytes
//! produces the same shape as HMACing the right ones.
//!
//! ⚠ The cutover is clean, so the Rust service does NOT have to accept a cookie
//! the TypeScript minted. These are not a compatibility requirement — they are
//! the only available oracle for whether this HMAC is the one anyone intended.

use backend::auth::session::{mint_id, sign_value, verify_value};

/// The fixed test secret from `session-refs.mts`. Nothing in production uses it.
const SECRET: &str = "a-test-secret-not-used-anywhere";

#[test]
fn the_signature_is_the_one_node_produces() {
    backend::lean::init().expect("the Lean runtime must start");

    assert_eq!(
        sign_value(SECRET, "abc"),
        "abc.YjuLlBXrSg3AQ23dC-FViq8v9lRoeJ9ESI2tFifobOg"
    );
    // An empty value still signs, and the separator is still there.
    assert_eq!(
        sign_value(SECRET, ""),
        ".Gwy8Vn-Udg7RoBWLlBnuCbCfqomk6ukwlgH4H6oC_aY"
    );
    // ⚠ A value containing dots: the signature covers the WHOLE value.
    assert_eq!(
        sign_value(SECRET, "a.b.c"),
        "a.b.c.rz4iZ2vhkfcX3itWuB-78c1muFA3QJViF28h2mU1bqs"
    );
    // A realistic session id — 32 bytes, hex.
    assert_eq!(
        sign_value(
            SECRET,
            "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb"
        ),
        "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb.\
         P6vgTzR2l-vaYntrhnpF0XZHtEunxWqISWkBAkCGVlA"
    );
}

#[test]
fn the_signature_is_unpadded_base64url() {
    backend::lean::init().expect("the Lean runtime must start");
    let signed = sign_value(SECRET, "abc");
    let sig = signed.rsplit_once('.').expect("there is a separator").1;
    // ⚠ SHA-256 is 32 bytes, which is not a multiple of 3, so padded base64
    // would end in `=`. This is the assertion that catches a padded port even
    // if the reference strings above were ever regenerated wrongly.
    assert!(!sig.contains('='), "Node's base64url is unpadded: {sig}");
    // base64url uses `-` and `_`, never `+` or `/`.
    assert!(!sig.contains('+') && !sig.contains('/'), "{sig}");
    assert_eq!(sig.len(), 43, "32 bytes unpadded is 43 characters");
}

#[test]
fn a_signed_value_verifies_and_a_tampered_one_does_not() {
    backend::lean::init().expect("the Lean runtime must start");

    for v in ["abc", "", "a.b.c"] {
        assert_eq!(
            verify_value(SECRET, &sign_value(SECRET, v))
                .unwrap()
                .as_deref(),
            Some(v),
            "round trip for {v:?}"
        );
    }

    // A different secret.
    assert_eq!(
        verify_value(SECRET, &sign_value("some-other-secret", "abc")).unwrap(),
        None
    );
    // No separator at all.
    assert_eq!(verify_value(SECRET, "abcdef").unwrap(), None);
    assert_eq!(verify_value(SECRET, "").unwrap(), None);
    // A signature that is not base64 at all.
    assert_eq!(verify_value(SECRET, "abc.not-a-signature!!").unwrap(), None);

    // ⚠ THE CASE THE FRAMING RULE EXISTS FOR. `a.b.c` signs to
    // `a.b.c.<sig>`; a verifier splitting on the FIRST dot would check `a`
    // against `b.c.<sig>` and reject a cookie it issued itself.
    let signed = sign_value(SECRET, "a.b.c");
    assert_eq!(
        verify_value(SECRET, &signed).unwrap().as_deref(),
        Some("a.b.c")
    );

    // ⚠ A signature of the RIGHT LENGTH with the wrong bytes — the case a
    // length-only comparison waves through.
    let sig = signed.rsplit_once('.').unwrap().1;
    let mut flipped: Vec<char> = sig.chars().collect();
    flipped[0] = if flipped[0] == 'A' { 'B' } else { 'A' };
    let forged = format!("a.b.c.{}", flipped.iter().collect::<String>());
    assert_eq!(forged.len(), signed.len());
    assert_eq!(verify_value(SECRET, &forged).unwrap(), None);
}

#[test]
fn a_session_id_is_thirty_two_bytes_of_entropy_and_never_repeats() {
    let a = mint_id().expect("the OS CSPRNG answers");
    assert_eq!(a.len(), 64, "32 bytes, hex");
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));

    // ⚠ Not a randomness test — it cannot be one. This catches the failure that
    // actually happens: a generator seeded once, or a buffer that is never
    // refilled, hands back the same id for every session.
    let ids: std::collections::HashSet<String> =
        (0..64).map(|_| mint_id().expect("mints")).collect();
    assert_eq!(ids.len(), 64, "every session id must be distinct");
    assert!(!ids.contains(&a));
    // All-zero is what an unread buffer looks like.
    assert!(!ids.contains(&"0".repeat(64)));
}
