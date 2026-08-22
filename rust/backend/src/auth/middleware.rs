//! Turning a request into a session, and refusing the ones that should be (#982).
//!
//! Two ways in, tried in the TypeScript's order:
//!
//!   1. the `session` cookie — the owner on their own dashboard;
//!   2. `X-Share-Token` — a forwarded link, read-only, windowed.
//!
//! ⚠ THE COOKIE WINS, and the order is not arbitrary. If a session already
//! authenticated the request, the owner is using their own dashboard and share
//! auth is irrelevant — checking the header first would let the owner's own
//! browser downgrade itself to read-only by holding a stale header.
//!
//! # ⚠ This layer AUTHENTICATES. It does not authorise
//!
//! [`resolve`] answers "who is this", including "nobody". Refusing a request is
//! two further steps, and they are separate because they fail differently:
//! [`require_session`] turns "nobody" into 401, and [`require_may_proceed`] asks
//! `Verified.Session.mayProceed` whether this session may use this method on
//! this path — the rule that keeps a share recipient read-only.
//!
//! Collapsing them would mean a route that forgets one gets the other for free,
//! which reads as safety and is not: the missing one is silent.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde_json::json;

use crate::auth::session::UserSession;
use crate::auth::{session, share};
use crate::state::AppState;

/// The header a share recipient sends. Matches the TypeScript's `X-Share-Token`;
/// header names are case-insensitive, so the spelling here is documentation.
pub const SHARE_HEADER: &str = "x-share-token";

/// Who is asking, or `None`.
///
/// ⚠ A FAILED LOOKUP IS `None`, NOT AN ERROR — a bad cookie and an unknown token
/// are ordinary traffic, not faults. A DATABASE failure IS an error and
/// propagates: "the sessions table is unreachable" must not read as "you are
/// logged out", because that answer is indistinguishable from a correct one and
/// would silently sign everybody out during an outage.
pub async fn resolve(
    st: &AppState,
    jar: &CookieJar,
    headers: &HeaderMap,
    now_ms: i64,
    today: &str,
) -> anyhow::Result<Option<UserSession>> {
    let secret = st
        .cfg
        .session_secret
        .as_deref()
        // Unreachable through `serve`, which refuses to start without one. An
        // error rather than `None`: a process serving requests with no signing
        // key is a misconfiguration, and answering "not logged in" to every
        // request would look like a working server with no users.
        .ok_or_else(|| {
            anyhow::anyhow!("SESSION_SECRET is not set; this process cannot authenticate")
        })?;

    let policy = crate::lean::session_policy()?;
    if let Some(cookie) = jar.get(&policy.cookie_name)
        && let Some(s) = session::get(&st.pool, secret, cookie.value(), now_ms).await?
    {
        return Ok(Some(s));
    }

    // ⚠ Only reached when the cookie did NOT authenticate. See the module note.
    let Some(token) = headers.get(SHARE_HEADER).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    let Some(s) = share::resolve(&st.pool, token, today).await? else {
        return Ok(None);
    };
    // Bookkeeping, deliberately not fatal: a failed access bump must not fail
    // the read it accompanies. Logged rather than swallowed, so a table that
    // stopped accepting writes is visible.
    if let Err(e) = share::touch_last_accessed(&st.pool, token).await {
        tracing::warn!(error = %e, "share_tokens.last_accessed_at bump failed");
    }
    Ok(Some(s))
}

/// 401 unless the request carries a session.
pub async fn require_session(
    State(st): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    let now_ms = chrono::Utc::now().timestamp_millis();
    // ⚠ The share window is anchored on the OWNER's civil date, resolved in
    // UTC here because the recipient's zone is not known at this point — the
    // `tz` query parameter belongs to the route, not to authentication. The
    // TypeScript does the same (`new Date().toISOString().slice(0, 10)`), so a
    // link near midnight can differ by a day from what the viewer sees.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    match resolve(&st, &jar, req.headers(), now_ms, &today).await {
        Err(e) => {
            // ⚠ 500, NOT 401. A database that cannot be read is not a failed
            // login, and reporting it as one sends the user to a login page
            // that will also fail.
            tracing::error!(error = %format!("{e:#}"), "resolving the session failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "auth_unavailable" })),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "unauthorized" })),
        )
            .into_response(),
        Ok(Some(s)) => {
            req.extensions_mut().insert(s);
            next.run(req).await
        }
    }
}

/// 403 when a share viewer tries anything `Verified.Session.mayProceed` refuses.
///
/// ⚠ MOUNT AFTER [`require_session`], and this now FAILS CLOSED if you do not.
///
/// It used to pass an extension-less request through, on the reasoning that
/// "there is no session" is 401's job. That reasoning is sound and the
/// behaviour was still wrong, because it made the mounting order a silent
/// correctness condition: run this BEFORE `require_session` and a share
/// viewer's POST arrives with no extension yet, reads as not-a-share-viewer, is
/// ALLOWED, and then `require_session` attaches the session and runs the route.
/// A read-only link could write, and nothing anywhere would say so.
///
/// ⚠ That is not hypothetical laziness — it was MEASURED. Flipping the two
/// layers in `routes::mod` on 2026-08-22 failed ZERO of the eleven tests that
/// covered this, because the test that claimed to protect the order mirrored
/// the stack rather than importing it and so only ever tested its own copy.
///
/// Refusing here costs nothing in correct operation: mounted properly,
/// `require_session` has already answered 401 and this never sees a request
/// without a session. Mounted wrongly, EVERY request 500s immediately instead
/// of one class of request being quietly over-permitted.
pub async fn require_may_proceed(req: Request, next: Next) -> Response {
    let Some(session) = req.extensions().get::<UserSession>() else {
        tracing::error!(
            path = %req.uri().path(),
            "require_may_proceed ran with no session in the request extensions —              it is mounted BEFORE require_session, which would let a read-only              share link write"
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": "auth_misconfigured" })),
        )
            .into_response();
    };
    let is_share_viewer = session.share_viewer.is_some();
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();

    match crate::lean::may_proceed(is_share_viewer, &method, &path) {
        // ⚠ An error REFUSES. This asks Lean whether the request is allowed, so
        // a question that could not be answered must not be treated as a yes.
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "mayProceed could not be evaluated");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "auth_unavailable" })),
            )
                .into_response()
        }
        Ok(false) => (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": "read_only_share" })),
        )
            .into_response(),
        Ok(true) => next.run(req).await,
    }
}
