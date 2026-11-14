//! A missing static file is a 404, not the no-build page: a 200 HTML answer to
//! a font request is an error neither side reports. These assert served
//! responses, not the route table, since `ServeDir`'s fallback is what answered
//! 200. No database (`tests/compression.rs`' lazy pool) and no frontend build,
//! so SPA routes like `/settings` are not asserted here.

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
    // The real router, so what is under test is the mounted stack.
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
    // The content type is half the assertion. A 404 that still carried
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
async fn the_page_is_asked_for_again_every_time() {
    // The page names the bundle; with only `Last-Modified` a WebView keeps it as
    // fresh for a tenth of its age. The build-less root is the page this harness
    // can reach; a deep link needs a build, and the fleet probe asks that one.
    let res = app()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .expect("router answered");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap()),
        Some("no-cache")
    );
}

#[tokio::test]
async fn the_root_still_explains_itself() {
    // The root stays 200: a build-less deployment explains itself, and
    // `tests/compression.rs` uses this body.
    let (status, content_type) = get("/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.unwrap_or_default().starts_with("text/html"),
        "the root must still answer the explanation page"
    );
}

// No "a declared SPA route is not a 404" case: without a frontend build
// `/settings` correctly 404s here.

#[test]
fn only_a_content_hashed_file_is_cached_for_good() {
    // An icon, the manifest and the service worker's files keep their names
    // across builds: unmarked, a WebView keeps them on heuristics, and a year of
    // `immutable` would pin the old one on every phone.
    use backend::routes::site::cache_for;
    let ok = StatusCode::OK;
    assert_eq!(cache_for("/", "text/html", ok), Some("no-cache"));
    assert_eq!(
        cache_for("/main-JLBKO2QH.js", "text/javascript", ok),
        Some("public, max-age=31536000, immutable")
    );
    for path in ["/icon.svg", "/manifest.webmanifest", "/ngsw-worker.js"] {
        assert_eq!(
            cache_for(path, "image/svg+xml", ok),
            Some("no-cache"),
            "{path}"
        );
    }
    // An API answer and an error are not this middleware's to decide.
    assert_eq!(
        cache_for("/api/heartrate/intraday", "application/json", ok),
        None
    );
    assert_eq!(
        cache_for("/media/nope.woff2", "text/plain", StatusCode::NOT_FOUND),
        None
    );
}
