//! Share management's gate (#982).
//!
//! ⚠ NO DATABASE. The pool here can never answer, so nothing below tests what a
//! share row becomes — that is what `backend rows-check` and the handlers'
//! own queries do. What IS tested is the part that must hold before any query
//! runs, and which is now real rather than hypothetical: **`/share` is the
//! first write route in this router**.
//!
//! A share recipient must not be able to rotate, retune or revoke the link they
//! were given. That is enforced by `require_may_proceed`, which reads the
//! session out of the request extensions — and `require_session` is what puts
//! it there. Mounted the wrong way round, a recipient's POST is judged before
//! their session exists, looks anonymous, is therefore NOT a share viewer, and
//! is ALLOWED. `tests/velocity_route.rs` has asserted that invariant against a
//! stand-in write route since before one existed; this asserts it against the
//! real thing.

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

/// The REAL router, so the layer order is what is under test.
fn app() -> axum::Router {
    backend::routes::router(state())
}

/// ⚠ REQUIRED before any request. `require_session` asks Lean for the session
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

/// ⚠ THE ONE THAT ACTUALLY EXERCISES THE REAL ROUTER'S LAYER ORDER.
///
/// A 401 here says two things: `/share` is inside the authenticated group at
/// all, and `require_session` runs FIRST. The second only became testable once
/// `require_may_proceed` started failing closed — before that, flipping the two
/// layers in `routes::mod` still produced a 401 here, and MEASURABLY failed
/// zero of the eleven tests covering this area.
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

/// A share recipient may not rotate, retune or revoke the link they were given.
///
/// ⚠ This tests the RULE, not the wiring: reaching `require_may_proceed`
/// through the real router needs an authenticated share session, which needs a
/// database this test does not have. The wiring is covered by
/// `anonymous_is_refused_before_the_handler` above, and by the fail-closed
/// refusal that makes a misordering break every request instead of one class.
#[tokio::test]
async fn a_share_viewer_may_not_write_to_share() {
    init();
    for method in ["POST", "PATCH", "DELETE"] {
        assert!(
            !backend::lean::may_proceed(true, method, "/api/share").expect("mayProceed"),
            "{method} /api/share must be refused for a share viewer"
        );
    }
    // …and the same session may still READ it, which is what makes the refusal
    // a distinction rather than a blanket block.
    assert!(
        backend::lean::may_proceed(true, "GET", "/api/share").expect("mayProceed"),
        "a share viewer must still be able to read the share it was given"
    );
    // The owner is unrestricted on the same paths.
    for method in ["GET", "POST", "PATCH", "DELETE"] {
        assert!(
            backend::lean::may_proceed(false, method, "/api/share").expect("mayProceed"),
            "{method} /api/share must be allowed for the owner"
        );
    }
}
