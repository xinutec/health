//! `lean::rail_snap` — the `railsnap` mode's production caller (#1424).
//!
//! # Why this exists
//!
//! `rail_snap` is called from one place, `main.rs`'s train-leg snapper, and
//! until now from no test at all. #1003's two-hop check measured that: the arm
//! is dispatched, the function is live in production, and every gate was blind
//! to it. A production path no gate can see is a worse defect than an unused
//! one, so what this wants is a TEST, not another caller.
//!
//! # The geography is INVENTED, and has to be
//!
//! #860: no tracked test may carry real coordinates or place names. A straight
//! synthetic corridor is also the better instrument here — it makes the two
//! refusals below unambiguous, where a real corridor would leave "did it refuse,
//! or did my fixture just not resolve" open.
//!
//! ⚠ ONE `#[test]`, for the reason `tests/lean_ffi.rs` gives: `lean::init()`
//! starts a runtime and several tests racing on it would flake.

use backend::fold_payload::bits;
use serde_json::json;

/// A point on the wire: `[latBits, lonBits]`, as `parseSnapPt` reads it.
fn pt(lat: f64, lon: f64) -> serde_json::Value {
    json!([bits(lat), bits(lon)])
}

/// A synthetic corridor: 11 collinear points running north from the origin.
fn corridor() -> Vec<serde_json::Value> {
    (0..11).map(|i| pt(f64::from(i) * 0.001, 0.0)).collect()
}

/// Stations at the two ends of that corridor, named so nothing reads as a real
/// place.
fn stations() -> Vec<serde_json::Value> {
    vec![
        json!({ "name": "Alpha Halt", "subtype": "station",
                "latBits": bits(0.0), "lonBits": bits(0.0) }),
        json!({ "name": "Beta Halt", "subtype": "station",
                "latBits": bits(0.010), "lonBits": bits(0.0) }),
    ]
}

/// `n` fixes strung along the corridor, offset by ~1 m so they are a cloud
/// around the line rather than the line itself.
fn cloud(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let t = i as f64 / (n.max(2) - 1) as f64;
            (t * 0.010, 0.00001)
        })
        .collect()
}

#[test]
fn rail_snap_routes_a_leg_and_refuses_the_two_ways_it_should() {
    backend::lean::init().expect("the Lean runtime must start");

    let lines = vec![json!({
        "name": "Test Line", "subtype": "rail", "coords": corridor()
    })];

    // ── 1. The corridor form routes a leg ────────────────────────────────────
    // 12 fixes is exactly `minCloudFixes`, so this is the first cloud thick
    // enough to evidence a corridor.
    let path = backend::lean::rail_snap(
        "Alpha Halt → Beta Halt",
        1_000.0,
        2_000.0,
        &lines,
        &stations(),
        &cloud(12),
        false,
    )
    .expect("a well-formed request must not error");

    let path = path.expect("12 fixes along a named corridor must route");
    assert!(
        path.len() >= 2,
        "a route between two stations is at least two points, got {path:?}"
    );
    // It routed along the corridor, not off it: every returned point sits on
    // the meridian the corridor was built on.
    for p in &path {
        let lon = p["lon"].as_f64().expect("each point carries a lon");
        assert!(
            lon.abs() < 1e-6,
            "the corridor is at lon 0; the route left it at {lon}"
        );
    }

    // ── 2. A thin cloud REFUSES, and a refusal is not an error ───────────────
    // `minCloudFixes` is 12 and its comment is the contract: a thin cloud cannot
    // evidence a corridor. `Ok(None)` distinguishes that from a malformed
    // request, which `rail_snap` turns into `Err` — so this asserts the
    // DISTINCTION, not merely the absence of a path.
    let thin = backend::lean::rail_snap(
        "Alpha Halt → Beta Halt",
        1_000.0,
        2_000.0,
        &lines,
        &stations(),
        &cloud(11),
        false,
    )
    .expect("a thin cloud is a refusal, never an error");
    assert!(thin.is_none(), "11 fixes is below the floor, got {thin:?}");

    // ── 3. The two entry points are NOT interchangeable ──────────────────────
    // `snapTrainSegmentOnLine` takes no cloud at all and leans on the line name
    // instead, so it answers where the corridor form just refused — with ZERO
    // fixes. Without a ` · Line` suffix it has nothing to lean on and refuses.
    let on_line = backend::lean::rail_snap(
        "Alpha Halt → Beta Halt · Test Line",
        1_000.0,
        2_000.0,
        &lines,
        &stations(),
        &[],
        true,
    )
    .expect("the on-line form must answer");
    assert!(
        on_line.is_some(),
        "the line name is the disambiguator; an empty cloud is not a refusal here"
    );

    let unnamed_line = backend::lean::rail_snap(
        "Alpha Halt → Beta Halt",
        1_000.0,
        2_000.0,
        &lines,
        &stations(),
        &[],
        true,
    )
    .expect("a missing line name is a refusal, never an error");
    assert!(
        unnamed_line.is_none(),
        "with no ` · Line` the on-line form has nothing to route over"
    );

    // ── 4. A leg that begins and ends at one station is not a journey ────────
    let same = backend::lean::rail_snap(
        "Alpha Halt → Alpha Halt",
        1_000.0,
        2_000.0,
        &lines,
        &stations(),
        &cloud(12),
        false,
    )
    .expect("board == alight is a refusal, never an error");
    assert!(same.is_none(), "board and alight are the same station");
}
