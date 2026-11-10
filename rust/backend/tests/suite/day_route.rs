//! `/day`'s gate: what it answers before reading anything.
//!
//! ⚠ NO DATABASE, as in `velocity_route.rs`: a share recipient asking for a date
//! outside their window gets the empty day without a query, a date inside it
//! reaches the (dead) database, a malformed date is a 400, and a request with no
//! session never reaches the handler.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use backend::auth::session::UserSession;
use backend::config::Config;
use backend::state::AppState;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tower::ServiceExt;

/// A state whose pool can never answer.
fn state() -> AppState {
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
    AppState::new(pool, cfg, reqwest::Client::new())
}

/// The handler with a session already attached.
fn app_as(session: UserSession) -> axum::Router {
    axum::Router::new()
        .route("/api/day", axum::routing::get(backend::routes::tables::day))
        .layer(axum::middleware::from_fn(
            move |mut req: axum::extract::Request, next: axum::middleware::Next| {
                let s = session.clone();
                async move {
                    req.extensions_mut().insert(s);
                    next.run(req).await
                }
            },
        ))
        .with_state(state())
}

async fn get(app: axum::Router, uri: &str) -> (StatusCode, Vec<u8>) {
    let res = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, bytes.to_vec())
}

fn viewer() -> UserSession {
    UserSession {
        user_id: "user".into(),
        display_name: "user".into(),
        share_viewer: Some(("2026-08-11".into(), "2026-08-17".into())),
        hides_location: false,
    }
}

#[tokio::test]
async fn a_request_without_a_session_never_reaches_the_handler() {
    let (status, _) = get(backend::routes::router(state()), "/api/day?date=2026-08-14").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_share_viewer_outside_the_window_gets_an_empty_day_without_a_query() {
    backend::lean::init().expect("the Lean runtime must start");
    for date in ["2026-08-10", "2026-08-18", "2026-02-03"] {
        let (status, body) = get(app_as(viewer()), &format!("/api/day?date={date}")).await;
        assert_eq!(status, StatusCode::OK, "{date}");
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "activity": [], "sleep": [] }),
            "{date}"
        );
    }
}

#[tokio::test]
async fn a_date_inside_the_window_reaches_the_database() {
    backend::lean::init().expect("the Lean runtime must start");
    // ⚠ Not the empty day: the only way to show the boundary dates were
    // admitted is that the read then failed on the database it reached.
    for date in ["2026-08-11", "2026-08-17"] {
        let (status, _) = get(app_as(viewer()), &format!("/api/day?date={date}")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{date}");
    }
}

#[tokio::test]
async fn a_malformed_date_is_refused() {
    let (status, _) = get(app_as(viewer()), "/api/day?date=2026-2-3").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
