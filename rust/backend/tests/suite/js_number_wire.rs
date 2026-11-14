//! `JsNumber` must render exactly as `js_number_value` does, for every case the
//! encoder documents: routes move between the two, and a plain `f64` differs on
//! integral values and negative zero.

use backend::row_json::{JsNumber, js_number_value};

#[test]
fn the_newtype_and_the_encoder_agree_everywhere() {
    let cases = [
        120.0, // integral: `120`, not `120.0`
        -0.0,  // negative zero: `0`
        0.0,
        -1.0,
        51.531148, // a real latitude
        -0.119865, // a real longitude
        1e21,      // beyond the documented-exact range, but must still agree
        f64::NAN,  // `null`
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    for v in cases {
        let via_newtype = serde_json::to_string(&JsNumber(v)).expect("newtype serialises");
        let via_encoder = serde_json::to_string(&js_number_value(v)).expect("value serialises");
        assert_eq!(
            via_newtype, via_encoder,
            "JsNumber and js_number_value disagree on {v:?} — a route converted \
             between them would move bytes on the wire"
        );
    }
}

#[test]
fn and_a_plain_f64_does_not() {
    // The reason the newtype exists, pinned so it cannot quietly stop being true.
    assert_ne!(
        serde_json::to_string(&120.0_f64).unwrap(),
        serde_json::to_string(&JsNumber(120.0)).unwrap()
    );
}
