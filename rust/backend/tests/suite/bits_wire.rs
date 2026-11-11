//! A float off the Lean wire is the decimal of its bit pattern, and nothing else.

use backend::lean::Bits;

#[test]
fn a_bit_pattern_decodes_to_its_float() {
    let b: Bits = serde_json::from_str(&format!("\"{}\"", 1.5f64.to_bits())).unwrap();
    assert_eq!(b.0.to_bits(), 1.5f64.to_bits());
    assert_eq!(
        backend::fold_payload::bits(b.0),
        1.5f64.to_bits().to_string()
    );
}

/// The defect this type exists for: a malformed string read as `0` became a
/// fix at (0, 0), in the decoder, with nothing said.
#[test]
fn a_malformed_bit_pattern_fails_the_decode() {
    for bad in ["\"\"", "\"1.5\"", "\"-1\"", "\"x\"", "1.5"] {
        assert!(
            serde_json::from_str::<Bits>(bad).is_err(),
            "{bad} must not decode"
        );
    }
}
