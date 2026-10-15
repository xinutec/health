//! The decoder parameter record laid on a decode request (`backend::decoder_params`).

use backend::decoder_params::apply;
use serde_json::json;

#[test]
fn the_record_fills_what_the_request_leaves_unset() {
    let mut req = json!({ "flags": { "reacquireRobust": true, "transFit": { "own": 1 } } });
    apply(
        &mut req,
        &json!({ "segEmission": { "rho": 0.8 }, "transFit": { "fitted": 1 }, "maxD": 1440,
                 "entryCounts": { "n": 1 }, "provenance": { "days": 43 } }),
    );
    assert_eq!(req["flags"]["segEmission"], json!({ "rho": 0.8 }));
    assert_eq!(
        req["flags"]["transFit"],
        json!({ "own": 1 }),
        "the request's own wins"
    );
    assert_eq!(req["flags"]["entryCounts"], json!({ "n": 1 }));
    assert_eq!(req["flags"]["reacquireRobust"], json!(true));
    assert_eq!(req["maxD"], json!(1440));
    assert!(
        req["flags"]["provenance"].is_null(),
        "provenance is not a flag"
    );
}
