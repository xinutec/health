//! A missing static file is a 404, not the no-build page (#1489).
//!
//! ⚠ THIS EXISTS BECAUSE THE WRONG ANSWER WAS A 200, WHICH IS INVISIBLE.
//! Measured against production 2026-09-08: `GET /media/nope.woff2` on
//! health.xinutec.org answered **200 text/html** — the "no frontend build is
//! present in this image" page — across every host in
//! `nixos-config/frontdoor.json`. A browser handed HTML where it asked for a
//! font renders broken icons and reports nothing at all. The failure is silent
//! on both sides: a 200 is not an error to the client, and not a log line on
//! the server.
//!
//! ⚠ THE ROUTING WAS ALREADY RIGHT, AND THE TEST IS AIMED UNDER IT.
//! `routes/mod.rs` lists the SPA's routes by hand with a comment saying exactly
//! why — *"a typo'd .css or .js must still 404, or a missing asset silently
//! becomes an HTML page"*. That decision stands. What defeated it was
//! `ServeDir`'s fallback answering 200 to any path it was reached by, so these
//! assert the SERVED RESPONSE rather than the route table, which would have
//! passed throughout the bug.
//!
//! ⚠ NO DATABASE, deliberately — the harness is `tests/compression.rs`'s: a
//! lazy pool pointed at a port nothing listens on, so nothing here depends on
//! data. It also means a build-less test environment, which is why the
//! assertions below are about ASSET paths and the root, and not about
//! `/settings`: see the dropped fifth case at the bottom.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use backend::config::Config;
use backend::state::AppState;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tower::ServiceExt;

fn app() -> axum::Router {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy_with(
            MySqlConnectOptions::new()
                .host("127.0.0.1")
                .port(1)
                .database("nowhere"),
        );
    let mut cfg = Config::for_test();
    cfg.session_secret = Some("a-secret-at-least-16-chars".into());
    // The REAL router, so what is under test is the mounted stack.
    backend::routes::router(AppState::new(pool, cfg, reqwest::Client::new()))
}

async fn get(uri: &str) -> (StatusCode, Option<String>) {
    let res = app()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("router answered");
    let status = res.status();
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_string());
    (status, content_type)
}

#[tokio::test]
async fn a_missing_font_is_not_answered_with_html() {
    let (status, content_type) = get("/media/nope.woff2").await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "the production symptom exactly"
    );
    // ⚠ THE CONTENT TYPE IS HALF THE ASSERTION. A 404 that still carried
    // `text/html` would be the same wrong body under a better status, and the
    // browser-side symptom — a font parsed from an HTML page — would survive.
    let ct = content_type.unwrap_or_default();
    assert!(
        !ct.starts_with("text/html"),
        "a missing font answered {ct:?}, which is the no-build page again"
    );
}

#[tokio::test]
async fn a_missing_script_is_a_404() {
    let (status, _) = get("/nope.js").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn an_unknown_route_without_an_extension_is_a_404() {
    // No catch-all SPA shell is mounted here, so there is nothing this should
    // legitimately resolve to.
    let (status, _) = get("/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_root_still_explains_itself() {
    // ⚠ NOT symmetry with the cases above, and not negotiable: a build-less
    // deployment has to account for itself to whoever opens it, and
    // `tests/compression.rs` leans on this body as the largest the router
    // produces without a database.
    let (status, content_type) = get("/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.unwrap_or_default().starts_with("text/html"),
        "the root must still answer the explanation page"
    );
}

// ⚠ A FIFTH CASE WAS WRITTEN AND DROPPED: *a declared SPA route is not a 404*.
// With no frontend build in the test environment, `/settings` legitimately
// 404s, so the assertion would have described the environment rather than the
// code — and it would have failed on a correct router. The hand-listed SPA
// routes in `routes/mod.rs` are covered by their own presence, not by this.
