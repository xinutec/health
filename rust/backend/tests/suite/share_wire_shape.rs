//! `/api/share` answers one of two shapes, and the difference is absence: with
//! no link the conditional keys are absent (the page renders off
//! `active: false`), while an unopened link has an explicit
//! `lastAccessedAt: null`. `Option` with `skip_serializing_if` reads like
//! `null` in the struct, so serialisation is pinned here.

use backend::routes::share::ShareStatus;
use serde_json::{Value, json};

#[test]
fn no_link_omits_every_conditional_key() {
    let v = serde_json::to_value(ShareStatus {
        active: false,
        token: None,
        url: None,
        days_back: None,
        share_location: None,
        created_at: None,
        last_accessed_at: None,
    })
    .expect("the status serialises");

    // Exact equality, not a field check: an extra key here is the defect —
    // `{"active": false, "token": null}` would have the SPA render a share it
    // cannot show.
    assert_eq!(v, json!({ "active": false }));
}

#[test]
fn an_unopened_link_carries_an_explicit_null() {
    let v = serde_json::to_value(ShareStatus {
        active: true,
        token: Some("tok".into()),
        url: Some("https://example/s/tok".into()),
        days_back: Some(7),
        share_location: Some(false),
        created_at: Some("2026-01-01T00:00:00Z".into()),
        last_accessed_at: Some(None),
    })
    .expect("the status serialises");

    assert_eq!(
        v["lastAccessedAt"],
        Value::Null,
        "Some(None) is a link nobody opened, and must be null rather than absent"
    );
    assert_eq!(
        v["token"], "tok",
        "a present Option serialises as its value"
    );
    assert_eq!(v["daysBack"], 7, "rename_all reaches the multi-word field");
}
