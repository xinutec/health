//! `/api/share` answers one of TWO shapes, and the difference is absence.
//!
//! ⚠ WHY THIS IS A TEST AND NOT A COMMENT. The two shapes are spelled with
//! `Option<T>` + `skip_serializing_if = "Option::is_none"`, and what that pair
//! does is invisible in the struct: a reader sees `Option` and reasonably
//! expects `null`. dev-lint's wire extractor made exactly that mistake on
//! 2026-09-04 and reported four drifts against this handler, all false
//! (dev-lint a9a5edd). Serialising it is the only thing that settles it, so the
//! serialisation is pinned here rather than argued anywhere.
//!
//! The property both halves depend on: with no link the conditional keys are
//! ABSENT — the settings page renders its create button off `active: false`
//! alone — while a link nobody has opened yet carries an explicit
//! `lastAccessedAt: null`. Collapsing those two would make "no share" and
//! "unopened share" indistinguishable to the SPA.

use backend::routes::share::ShareStatus;
use serde_json::{Value, json};

#[test]
fn no_link_omits_every_conditional_key() {
    let v = serde_json::to_value(ShareStatus {
        active: false,
        token: None,
        url: None,
        days_back: None,
        created_at: None,
        last_accessed_at: None,
    })
    .expect("the status serialises");

    // Exact equality, not a field check: an EXTRA key here is the defect —
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
