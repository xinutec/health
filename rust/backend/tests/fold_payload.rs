//! `encode_seg` against the TypeScript that produced the wire format (#982).
//!
//! # The oracle is the TypeScript's OUTPUT, not my reading of its source
//!
//! `fixtures/encode-seg-ts.json` was produced by running
//! `dist/lean/fold-payload.js`'s `encodeSeg` over segments from the golden
//! corpus's fold captures — see `fixtures/encode-seg-ts.mjs`. Writing the
//! expectations by hand would have encoded my reading, and my first attempt at
//! this function stopped at `wayName`, fifteen fields early, because that is
//! where the first screenful of the TypeScript ends.
//!
//! # Why a short encoding is worse than a malformed one
//!
//! Lean's `Seg` defaults every absent field, so a request missing
//! `walkSmoothedPath` or `biometrics` is not rejected — the fold answers a
//! well-formed question about a segment that has quietly lost its enrichment.
//! There is no error to notice, which is why this compares whole objects rather
//! than spot-checking fields.

use backend::fold_payload::encode_seg;
use serde_json::Value;

#[test]
fn every_captured_segment_encodes_as_the_typescript_does() {
    let raw = include_str!("fixtures/encode-seg-ts.json");
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

/// ⚠ The float encoding is the whole reason this wire format exists, so it is
/// pinned independently of any captured segment.
///
/// A coordinate rendered as a decimal instead of its bit pattern is a silent
/// precision change, and 1e-7° is exactly the quantisation `compare-match`
/// already adjudicates — so the failure would look like an algorithm
/// divergence rather than a transport bug.
#[test]
fn floats_cross_as_their_bit_pattern() {
    use backend::fold_payload::bits;
    assert_eq!(bits(0.0), "0");
    assert_eq!(bits(1.0), "4607182418800017408");
    // ⚠ A REAL LITERAL, computed independently. The first version of this
    // assertion compared `bits(x)` against an expression that evaluated to
    // `bits(x)`, so it passed no matter what the function did — the exact shape
    // of check this file exists to argue against.
    assert_eq!(bits(-0.176_252_1), "13818890208280377371");
    assert_eq!(bits(51.523_456_789_012_3), "4632448099209369256");
    // Negative zero is a distinct pattern, and a formatter would erase it.
    assert_eq!(bits(-0.0), "9223372036854775808");
    assert_ne!(bits(-0.0), bits(0.0));
    // Round trip through the inverse `day-serve.ts` uses.
    let x = 51.523_456_789_012_34_f64;
    assert_eq!(f64::from_bits(bits(x).parse().unwrap()), x);
}
