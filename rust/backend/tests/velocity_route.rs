//! `/velocity`'s gate: who reaches it, and what it refuses before computing (#982).
//!
//! ⚠ NO DATABASE, so this cannot test a computed day — that is `day_corpus.rs`
//! offline and `backend day-mirror` against production. What it covers is
//! everything the route decides BEFORE any work happens, which is where a
//! mistake is both cheap to make and invisible:
//!
//!   * an unauthenticated request never reaches the handler at all;
//!   * a share recipient asking for a date outside their window is refused,
//!     and refused BEFORE a day is computed for them;
//!   * a malformed date or an unknown zone is a 400, not a plausible wrong day.

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
    // ⚠ A signing key is REQUIRED even for tests that never sign anything. Its
    // absence is its own refusal — `require_session` answers 500 rather than
    // "not logged in" — so a state without one would make every gate test
    // report that rule instead of the one it names.
    let mut cfg = Config::for_test();
    cfg.session_secret = Some("a-secret-at-least-16-chars".into());
    AppState::new(pool, cfg, reqwest::Client::new())
}

/// The real router, so the LAYER ORDER is under test too — that order is the
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
    // ⚠ FAILS LOUDLY rather than defaulting to null. A response body that did
    // not parse is a broken handler, and reading it as "no fields" would make
    // every field assertion below fail for the wrong reason — or pass, when the
    // assertion happens to be about something absent.
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
        user_id: "pippijn".into(),
        display_name: "pippijn".into(),
        share_viewer: Some(("2026-08-11".into(), "2026-08-17".into())),
    }
}

#[tokio::test]
async fn an_unauthenticated_request_never_reaches_the_handler() {
    backend::lean::init().expect("the Lean runtime must start");
    let (status, _) = get(app(), "/api/velocity?date=2026-08-14").await;
    // ⚠ 401 and not 500: the handler would need the database, so reaching it
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
    // ⚠ The window is echoed, so the client can say what IS visible rather than
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
    // ⚠ The POINT of this test is that it is NOT 403. A boundary date must be
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

    // ⚠ An unknown zone is REFUSED, not defaulted to UTC. A day rendered in the
    // wrong zone is a plausible, wrong day, and the caller asked for a specific
    // one.
    let (status, _) = get(
        app_as(viewer()),
        "/api/velocity?date=2026-08-14&tz=Mars/Olympus_Mons",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// The `/api` group's layer stack, with a POST route added.
///
/// ⚠ THIS EXISTS BECAUSE AN ABLATION CAME BACK CLEAN. Reversing the two layers
/// in `routes::router` changed no test, and that was honest: the group currently
/// holds one GET route, and for a GET the order genuinely does not matter — an
/// anonymous request is refused by `require_session` either way.
///
/// The order matters the moment a POST route lands. `require_may_proceed` reads
/// the session from the request extensions, and `require_session` is what puts
/// it there. Run them the wrong way round and a share viewer's POST is judged
/// before their session exists — it looks like an anonymous request, which is
/// not a share viewer, so it is ALLOWED, and `require_session` then attaches the
/// session and runs the route. A read-only link would be able to write.
///
/// ⚠ THIS MIRRORS THE REAL STACK RATHER THAN IMPORTING IT, AND THAT MEANS IT
/// DOES NOT PROTECT THE PRODUCTION ORDER. This comment used to claim it would
/// "go red if the production order is ever flipped". Measured 2026-08-22:
/// flipping the two layers in `routes::mod` failed ZERO of the eleven tests
/// here and in `auth_middleware.rs`, because every one of them builds its own
/// copy of the stack. A check that can pass for the wrong reason is worse than
/// none, because it silences the question.
///
/// What protects the order now is `require_may_proceed` FAILING CLOSED on a
/// missing session extension, which turns a misordering into an immediate 500
/// on every request — caught by `share_route.rs`'s anonymous test, which uses
/// the real router. What this file still tests is the RULE, which is worth
/// keeping.
fn api_stack_with_a_write_route(session: UserSession) -> axum::Router {
    axum::Router::new()
        .route("/api/settings", axum::routing::post(|| async { "ok" }))
        .layer(axum::middleware::from_fn(
            backend::auth::middleware::require_may_proceed,
        ))
        .layer(axum::middleware::from_fn(
            move |mut req: axum::extract::Request, next: axum::middleware::Next| {
                // Stands in for `require_session`: it establishes the session
                // BEFORE `require_may_proceed` gets to judge it, which is the
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
        user_id: "pippijn".into(),
        display_name: "pippijn".into(),
        share_viewer: None,
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
