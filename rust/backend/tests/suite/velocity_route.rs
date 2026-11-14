//! `/velocity`'s gate: what the route decides before any work. No database, so
//! computed days are `corpus/day.rs` and `backend day-mirror`. Covered here:
//!
//!   * an unauthenticated request never reaches the handler;
//!   * a share recipient's out-of-window date is refused before computing;
//!   * a malformed date or unknown zone is a 400, not a plausible wrong day.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use backend::auth::session::UserSession;
use backend::config::Config;
use backend::state::AppState;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tower::ServiceExt;

/// A state whose pool can never answer, so any test that gets past the gate
/// fails loudly rather than reaching a real database.
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
    // A signing key even for tests that sign nothing: without one
    // `require_session` answers 500, masking the rule each test names.
    let mut cfg = Config::for_test();
    cfg.session_secret = Some("a-secret-at-least-16-chars".into());
    AppState::new(pool, cfg, reqwest::Client::new())
}

/// The real router, so the layer order is under test too — that order is the
/// security boundary, and a test that mounted the handler directly would prove
/// nothing about it.
fn app() -> axum::Router {
    backend::routes::router(state())
}

/// The router with a session already attached, to reach the handler's own
/// checks without a login.
fn app_as(session: UserSession) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/velocity",
            axum::routing::get(backend::routes::velocity::handler),
        )
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

async fn get(app: axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let res = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    // An unparseable body is a broken handler, not "no fields".
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "the response body is not JSON ({e}): {}",
            String::from_utf8_lossy(&bytes)
        )
    });
    (status, body)
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
async fn an_unauthenticated_request_never_reaches_the_handler() {
    backend::lean::init().expect("the Lean runtime must start");
    let (status, _) = get(app(), "/api/velocity?date=2026-08-14").await;
    // 401 and not 500: the handler would need the database, so reaching it
    // would show up as a pool error. This asserts the gate ran first.
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn liveness_is_outside_the_authenticated_group() {
    backend::lean::init().expect("the Lean runtime must start");
    // A probe that needed a session could not report a pod whose session table
    // is broken — which is exactly when the answer matters.
    let (status, body) = get(app(), "/healthz").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn a_share_viewer_is_refused_outside_the_window_before_any_work() {
    backend::lean::init().expect("the Lean runtime must start");

    let (status, body) = get(app_as(viewer()), "/api/velocity?date=2026-08-18").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "out_of_share_window");
    // The window is echoed, so the client can say what is visible rather than
    // just that this is not.
    assert_eq!(body["from"], "2026-08-11");
    assert_eq!(body["to"], "2026-08-17");

    let (status, body) = get(app_as(viewer()), "/api/velocity?date=2026-08-10").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "before the window too");
    assert_eq!(body["error"], "out_of_share_window");
}

#[tokio::test]
async fn a_date_inside_the_window_gets_past_the_gate_and_hits_the_dead_database() {
    backend::lean::init().expect("the Lean runtime must start");
    // The point of this test is that it is not 403. A boundary date must be
    // admitted, and the only way to show it was admitted is that the request
    // then failed on the database it was allowed to reach.
    for date in ["2026-08-11", "2026-08-14", "2026-08-17"] {
        let (status, _) = get(app_as(viewer()), &format!("/api/velocity?date={date}")).await;
        assert_ne!(
            status,
            StatusCode::FORBIDDEN,
            "{date} is inside the share window and must be admitted"
        );
    }
}

#[tokio::test]
async fn a_malformed_date_or_an_unknown_zone_is_refused_rather_than_guessed() {
    backend::lean::init().expect("the Lean runtime must start");

    for bad in [
        "2026-8-14",
        "not-a-date",
        "2026-08-14T00:00:00Z",
        "20260814",
    ] {
        let (status, _) = get(app_as(viewer()), &format!("/api/velocity?date={bad}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "date={bad}");
    }

    // An unknown zone is refused, not defaulted to UTC. A day rendered in the
    // wrong zone is a plausible, wrong day, and the caller asked for a specific
    // one.
    let (status, _) = get(
        app_as(viewer()),
        "/api/velocity?date=2026-08-14&tz=Mars/Olympus_Mons",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// The `/api` group's layer stack, with a POST route added, to test the share
/// viewer's write rule; with only GETs, layer order cannot show. This builds its
/// own stack, so the production order is asserted by `share_route.rs` through
/// the real router.
fn api_stack_with_a_write_route(session: UserSession) -> axum::Router {
    axum::Router::new()
        .route("/api/settings", axum::routing::post(|| async { "ok" }))
        .layer(axum::middleware::from_fn(
            backend::auth::middleware::require_may_proceed,
        ))
        .layer(axum::middleware::from_fn(
            move |mut req: axum::extract::Request, next: axum::middleware::Next| {
                // Stands in for `require_session`: it establishes the session
                // before `require_may_proceed` gets to judge it, which is the
                // property under test.
                let s = session.clone();
                async move {
                    req.extensions_mut().insert(s);
                    next.run(req).await
                }
            },
        ))
}

#[tokio::test]
async fn a_share_viewers_write_is_refused_only_because_the_session_is_established_first() {
    backend::lean::init().expect("the Lean runtime must start");

    let res = api_stack_with_a_write_route(viewer())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::FORBIDDEN,
        "a read-only share must not be able to write"
    );

    // The owner through the same stack, so the refusal above is about the share
    // window and not about the stack refusing everything.
    let owner = UserSession {
        user_id: "user".into(),
        display_name: "user".into(),
        share_viewer: None,
        hides_location: false,
    };
    let res = api_stack_with_a_write_route(owner)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
