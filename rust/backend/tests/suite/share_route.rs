//! Share management's gate, before any query (the pool never answers).
//!
//! A share recipient must not rotate, retune or revoke their link:
//! `require_may_proceed` reads the session `require_session` attaches, so the
//! order matters. `tests/velocity_route.rs` tests the rule on a stand-in; this
//! tests the real router.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use backend::config::Config;
use backend::state::AppState;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use tower::ServiceExt;

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

/// The real router, so the layer order is what is under test.
fn app() -> axum::Router {
    backend::routes::router(state())
}

/// Required before any request. `require_session` asks Lean for the session
/// policy, so without the host every one of these answers 500 — which looks
/// like a refusal and is not one.
fn init() {
    backend::lean::init().expect("the Lean runtime must start");
}

async fn status(app: axum::Router, method: &str, uri: &str) -> StatusCode {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("request");
    app.oneshot(req).await.expect("response").status()
}

/// The real router's layer order: a 401 means `/share` is authenticated and
/// `require_session` runs first. Misordered, `require_may_proceed` fails closed
/// with a 500.
#[tokio::test]
async fn anonymous_is_refused_before_the_handler() {
    init();
    for method in ["GET", "POST", "PATCH", "DELETE"] {
        let got = status(app(), method, "/api/share").await;
        assert_eq!(
            got,
            StatusCode::UNAUTHORIZED,
            "{method} /api/share without a session. A 500 here means \
             require_may_proceed ran first and found no session — the layer \
             order is inverted, and a read-only link could write."
        );
    }
}

/// A share recipient may not rotate, retune or revoke their link. The rule, not
/// the wiring: an authenticated share session needs a database. The wiring is
/// the test above.
#[tokio::test]
async fn a_share_viewer_may_not_write_to_share() {
    init();
    for method in ["POST", "PATCH", "DELETE"] {
        assert!(
            !backend::lean::may_proceed(true, false, method, "/api/share").expect("mayProceed"),
            "{method} /api/share must be refused for a share viewer"
        );
    }
    // …and the same session may still read it, which is what makes the refusal
    // a distinction rather than a blanket block.
    assert!(
        backend::lean::may_proceed(true, false, "GET", "/api/share").expect("mayProceed"),
        "a share viewer must still be able to read the share it was given"
    );
    // The owner is unrestricted on the same paths.
    for method in ["GET", "POST", "PATCH", "DELETE"] {
        assert!(
            backend::lean::may_proceed(false, false, method, "/api/share").expect("mayProceed"),
            "{method} /api/share must be allowed for the owner"
        );
    }
}
