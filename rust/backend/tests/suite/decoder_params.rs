//! The decoder parameter record laid on a decode request (`backend::decoder_params`).

use backend::decoder_params::apply;
use serde_json::{Value, json};

fn record() -> Value {
    json!({ "segEmission": { "rho": 0.8 }, "transFit": { "fitted": 1 }, "maxD": 1440,
            "entryCounts": { "n": 1 }, "fittedPriors": { "p": 1 },
            "provenance": { "days": 43 } })
}

#[test]
fn the_record_fills_what_the_request_leaves_unset() {
    let mut req = json!({ "flags": { "unknownBelow": 0.5, "transFit": { "own": 1 } } });
    apply(&mut req, &record()).unwrap();
    assert_eq!(req["flags"]["segEmission"], json!({ "rho": 0.8 }));
    assert_eq!(
        req["flags"]["transFit"],
        json!({ "own": 1 }),
        "the request's own wins"
    );
    assert_eq!(req["flags"]["entryCounts"], json!({ "n": 1 }));
    assert_eq!(req["flags"]["unknownBelow"], json!(0.5));
    assert_eq!(req["maxD"], json!(1440));
    assert!(
        req["flags"]["provenance"].is_null(),
        "provenance is not a flag"
    );
}

#[test]
fn a_record_missing_a_key_is_refused_by_name() {
    for k in [
        "segEmission",
        "transFit",
        "entryCounts",
        "fittedPriors",
        "maxD",
    ] {
        let mut params = record();
        params.as_object_mut().unwrap().remove(k);
        let err = apply(&mut json!({ "flags": {} }), &params).unwrap_err();
        assert_eq!(err.to_string(), format!("the decoder record has no {k}"));
    }
}
