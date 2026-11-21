//! `softvenue` through the Lean worker: habits learned from lone café visits
//! name the café on a high street over a nearer shop, and every query's
//! probabilities sum to one. The decision is `Verified.Geo.SoftVenue`; the risk
//! here is the wire both ways.

use backend::lean;
use serde_json::{Value, json};

fn visit(cands: Value) -> Value {
    json!({ "startUnix": 0, "bucket": 2, "hours": [[10, 60]], "cands": cands })
}

#[test]
fn habits_learned_from_lone_visits_name_the_cafe_on_a_high_street() {
    lean::init().expect("the Lean runtime must start");
    let lone = visit(json!([{ "name": "Cafe", "subtype": "cafe", "distanceM": 4 }]));
    let street = visit(json!([
        { "name": "Cafe", "subtype": "cafe", "distanceM": 14 },
        { "name": "Shop", "subtype": "convenience", "distanceM": 5 },
    ]));
    let mut visits = vec![lone; 20];
    visits.push(street.clone());
    let req = json!({ "mode": "softvenue", "visits": visits, "query": [street] });
    let reply: Value =
        serde_json::from_str(&lean::serve(&req.to_string()).expect("softvenue answers"))
            .expect("the reply parses");
    let post = reply["posteriors"][0]
        .as_array()
        .expect("one query's posterior");
    let p = |c: &Value| c["p"].as_f64().expect("a probability");
    let top = post
        .iter()
        .max_by(|a, b| p(a).total_cmp(&p(b)))
        .expect("candidates");
    assert_eq!(top["name"], "Cafe");
    let sum: f64 = post.iter().filter_map(|c| c["p"].as_f64()).sum();
    assert!((sum - 1.0).abs() < 1e-9, "probabilities sum to {sum}");
    assert!(!reply["events"].as_array().expect("events").is_empty());
}
