//! `encode_seg` against frozen reference output (`fixtures/encode-seg-ts.json`,
//! the retired encoder over corpus segments), not hand-written expectations.
//!
//! Lean's `Seg` defaults absent fields, so a short encoding is answered as a
//! well-formed segment that lost its enrichment: whole objects are compared.

use backend::fold_payload::encode_seg;
use serde_json::Value;

#[test]
fn every_captured_segment_encodes_as_the_typescript_does() {
    let raw = include_str!("../fixtures/encode-seg-ts.json");
    let cases: Vec<Value> = serde_json::from_str(raw).expect("fixture parses");
    assert!(
        cases.len() >= 100,
        "fixture shrank to {} segments — regenerate it",
        cases.len()
    );

    let mut checked = 0usize;
    for (i, case) in cases.iter().enumerate() {
        let input = case.get("in").expect("case has an input");
        let want = case.get("out").expect("case has an expected encoding");
        let got = encode_seg(input);
        assert_eq!(
            &got,
            want,
            "segment {i} encodes differently\n  in: {}",
            serde_json::to_string(input).unwrap_or_default()
        );
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}

/// The float encoding, pinned on its own: a decimal coordinate instead of its
/// bit pattern is a silent precision change that would look like an algorithm
/// divergence.
#[test]
fn floats_cross_as_their_bit_pattern() {
    use backend::fold_payload::bits;
    assert_eq!(bits(0.0), "0");
    assert_eq!(bits(1.0), "4607182418800017408");
    // Real literals, computed independently: an expected value computed by
    // the function under test passes whatever it does.
    assert_eq!(bits(-0.176_252_1), "13818890208280377371");
    assert_eq!(bits(51.523_456_789_012_3), "4632448099209369256");
    // Negative zero is a distinct pattern, and a formatter would erase it.
    assert_eq!(bits(-0.0), "9223372036854775808");
    assert_ne!(bits(-0.0), bits(0.0));
    // Round trip through the inverse.
    let x = 51.523_456_789_012_34_f64;
    assert_eq!(f64::from_bits(bits(x).parse().unwrap()), x);
}
