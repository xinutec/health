//! The auth layer's REFUSALS (#982).
//!
//! `session_rules.rs` covers what Lean decides. This covers what the HTTP layer
//! does with those answers, and specifically the two failures that are dangerous
//! because they look like ordinary ones:
//!
//!   * a database that cannot be read must be 500, NOT 401. "You are logged out"
//!     is indistinguishable from a correct answer, so an outage would silently
//!     sign everybody out and send them to a login page that also fails;
//!   * an authorisation question that could not be EVALUATED must refuse. A
//!     `mayProceed` that errored and was treated as a yes is an open door.
//!
//! ⚠ NO DATABASE HERE. The pool is built lazily against a port nothing listens
//! on, which is precisely what makes the first case reachable in a unit test.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use axum::{Router, middleware};
use backend::auth::session::UserSession;
use backend::config::Config;
use backend::state::AppState;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tower::ServiceExt;

/// An `AppState` whose pool can never answer. Built lazily on purpose — sqlx
/// opens no socket until a query runs, so construction succeeds and the FIRST
/// QUERY is what fails, which is the shape a real outage has.
fn state_with_a_dead_database(secret: Option<&str>) -> AppState {
    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        // ⚠ Without this the suite pays sqlx's 30-SECOND default acquire
        // timeout on every test that reaches the pool. The question here is
        // which STATUS an unreachable database produces, not how long the wait
        // is, so the wait is cut to the shortest thing that still reaches the
        // failure path.
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy_with(
            MySqlConnectOptions::new()
                .host("127.0.0.1")
                // Port 1 — nothing listens, and it is not a port anything in this
                // repo could be running on by accident.
                .port(1)
                .database("nowhere"),
        );
    // `Config::from_env` reads the process environment, which a test must not
    // depend on; this builds the one field the layer uses.
    let mut cfg = Config::for_test();
    cfg.session_secret = secret.map(str::to_string);
    AppState::new(pool, cfg, reqwest::Client::new())
}

fn app(st: AppState) -> Router {
    Router::new()
        .route("/api/velocity", get(|| async { "ok" }))
        .route("/api/settings", post(|| async { "ok" }))
        .layer(middleware::from_fn_with_state(
            st.clone(),
            backend::auth::middleware::require_session,
        ))
        .with_state(st)
}

#[tokio::test]
async fn a_database_that_cannot_be_read_is_500_and_not_401() {
    backend::lean::init().expect("the Lean runtime must start");
    let st = state_with_a_dead_database(Some("a-secret-at-least-16-chars"));

    // ⚠ A VALIDLY SIGNED cookie, and that is the whole setup. A bad signature is
    // refused by the HMAC before any query, so it would produce a 401 that says
    // nothing about the database — the first version of this test asserted
    // otherwise and went red for exactly that reason. Only a cookie that
    // verifies reaches the `sessions` lookup, which is where the outage is.
    let cookie = format!(
        "session={}",
        backend::auth::session::sign_value("a-secret-at-least-16-chars", "deadbeef")
    );
    let res = app(st)
        .oneshot(
            Request::builder()
                .uri("/api/velocity")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "an unreachable database must not report itself as a failed login"
    );
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn a_request_with_no_credentials_at_all_is_401() {
    backend::lean::init().expect("the Lean runtime must start");
    let st = state_with_a_dead_database(Some("a-secret-at-least-16-chars"));

    // No cookie and no share header: refused without a query, so the dead
    // database is never reached and this is a real 401.
    let res = app(st)
        .oneshot(
            Request::builder()
                .uri("/api/velocity")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_process_with_no_signing_key_refuses_rather_than_logging_everyone_out() {
    backend::lean::init().expect("the Lean runtime must start");
    let st = state_with_a_dead_database(None);

    let res = app(st)
        .oneshot(
            Request::builder()
                .uri("/api/velocity")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // ⚠ NOT 401. A server with no signing key that answers "not logged in" to
    // every request looks like a working server that simply has no users.
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

/// A router with a session already established, so `require_may_proceed` can be
/// exercised without a database.
fn proceed_app(session: Option<UserSession>) -> Router {
    Router::new()
        .route("/api/velocity", get(|| async { "ok" }))
        .route("/api/settings", post(|| async { "ok" }))
        .route("/api/telemetry", post(|| async { "ok" }))
        .layer(middleware::from_fn(
            backend::auth::middleware::require_may_proceed,
        ))
        .layer(middleware::from_fn(
            move |mut req: axum::extract::Request, next: axum::middleware::Next| {
                let session = session.clone();
                async move {
                    if let Some(s) = session {
                        req.extensions_mut().insert(s);
                    }
                    next.run(req).await
                }
            },
        ))
}

fn share_viewer() -> UserSession {
    UserSession {
        user_id: "pippijn".into(),
        display_name: "pippijn".into(),
        share_viewer: Some(("2026-08-11".into(), "2026-08-17".into())),
    }
}

fn owner() -> UserSession {
    UserSession {
        user_id: "pippijn".into(),
        display_name: "pippijn".into(),
        share_viewer: None,
    }
}

async fn status(session: Option<UserSession>, method: &str, path: &str) -> StatusCode {
    proceed_app(session)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn a_share_viewer_reads_but_cannot_write() {
    backend::lean::init().expect("the Lean runtime must start");
    assert_eq!(
        status(Some(share_viewer()), "GET", "/api/velocity").await,
        StatusCode::OK
    );
    assert_eq!(
        status(Some(share_viewer()), "POST", "/api/settings").await,
        StatusCode::FORBIDDEN
    );
    // The one path that writes only to the log — it is how anyone knows what a
    // share recipient saw.
    assert_eq!(
        status(Some(share_viewer()), "POST", "/api/telemetry").await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_owner_is_unrestricted_and_an_anonymous_request_is_not_this_layers_problem() {
    backend::lean::init().expect("the Lean runtime must start");
    assert_eq!(
        status(Some(owner()), "POST", "/api/settings").await,
        StatusCode::OK
    );
    // ⚠ No session: PASSES here. "There is no session" is 401's job, and
    // answering 403 would tell an anonymous caller the path exists and is
    // merely forbidden.
    assert_eq!(status(None, "POST", "/api/settings").await, StatusCode::OK);
}
