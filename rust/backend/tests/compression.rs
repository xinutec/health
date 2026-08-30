//! Responses are compressed when the client asks, and only then.
//!
//! ⚠ THIS EXISTS BECAUSE THE FEATURE WAS NOT COMPILED IN AND NOTHING SAID SO.
//! Measured against production 2026-08-30:
//! `/api/heartrate/intraday?date=2026-08-30` returned **2,556,228 bytes** for
//! one half-finished day, with `encodedBodySize == decodedBodySize` — no
//! encoding was negotiated at all, because `tower-http` was built with only
//! `fs` and `trace`. The body is 18,656 rows each repeating `user_id` and `tz`
//! verbatim, so it is mostly one constant.
//!
//! ⚠ The failure was SILENT IN EVERY DIRECTION. Every response was correct,
//! every status was right, no test failed and no log said anything; the only
//! symptom was bytes on a wire nobody was measuring. A missing Cargo feature
//! cannot fail loudly, so the assertion has to be about the SERVED RESPONSE
//! rather than about the dependency — checking the feature list would pass on a
//! router that never mounted the layer.
//!
//! ⚠ NO DATABASE, deliberately: the pool cannot answer, so this uses the SPA
//! fallback page, which is the largest body the real router will produce
//! without a query. That keeps the test about the layer stack and not about
//! data.

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

async fn get(accept_encoding: Option<&str>) -> (StatusCode, Option<String>, usize) {
    let mut req = Request::builder().uri("/").method("GET");
    if let Some(enc) = accept_encoding {
        req = req.header(header::ACCEPT_ENCODING, enc);
    }
    let res = app()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .expect("router answered");
    let status = res.status();
    let encoding = res
        .headers()
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap().to_string());
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .expect("body read");
    (status, encoding, body.len())
}

#[tokio::test]
async fn gzip_is_served_when_the_client_asks() {
    let (status, encoding, _) = get(Some("gzip")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        encoding.as_deref(),
        Some("gzip"),
        "the compression layer is not mounted — see this file's header"
    );
}

#[tokio::test]
async fn brotli_is_served_when_the_client_asks() {
    let (status, encoding, _) = get(Some("br")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding.as_deref(), Some("br"));
}

/// ⚠ THE HALF THAT MAKES THE CHANGE SAFE. Compression is content-negotiated, so
/// a caller that sends no `Accept-Encoding` must still get an identity body —
/// that is why mounting this layer cannot break an existing client, only fail
/// to help one. Asserting it here means the claim in `routes/mod.rs` is checked
/// rather than merely written down.
#[tokio::test]
async fn identity_is_served_when_the_client_does_not_ask() {
    let (status, encoding, len) = get(None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding, None, "an unasking client was sent an encoding");
    assert!(len > 0, "identity body was empty");
}
