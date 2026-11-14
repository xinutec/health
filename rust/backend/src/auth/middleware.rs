//! Turning a request into a session, and refusing the ones that should be.
//!
//! The `session` cookie (the owner) is tried before `X-Share-Token` (a
//! read-only forwarded link), so a stale header cannot downgrade the owner.
//!
//! ⚠ This layer authenticates; it does not authorise. [`resolve`] answers who
//! is asking, possibly nobody. [`require_session`] turns nobody into 401, and
//! [`require_may_proceed`] asks `Verified.Session.mayProceed` whether this
//! session may use this method on this path. Kept separate so a route missing
//! one does not silently pass on the other.

use axum::extract::{OriginalUri, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde_json::json;

use crate::auth::session::UserSession;
use crate::auth::{session, share};
use crate::state::AppState;

/// The header a share recipient sends. Header names are case-insensitive, so
/// the spelling here is documentation.
pub const SHARE_HEADER: &str = "x-share-token";

/// Who is asking, and the session cookie to send back when it was just renewed.
/// A bad cookie or unknown token is `None`; a database failure is an error, or
/// an outage would silently sign everybody out.
pub async fn resolve(
    st: &AppState,
    jar: &CookieJar,
    headers: &HeaderMap,
    now_ms: i64,
    today: &str,
) -> anyhow::Result<Option<(UserSession, Option<String>)>> {
    let secret = st
        .cfg
        .session_secret
        .as_deref()
        // Unreachable through `serve`, which refuses to start without a key. An
        // error, not `None`: "not logged in" for everyone would look healthy.
        .ok_or_else(|| {
            anyhow::anyhow!("SESSION_SECRET is not set; this process cannot authenticate")
        })?;

    let policy = crate::lean::session_policy()?;
    if let Some(cookie) = jar.get(&policy.cookie_name)
        && let Some((s, renewed)) = session::get(&st.pool, secret, cookie.value(), now_ms).await?
    {
        return Ok(Some((s, renewed.then(|| cookie.value().to_string()))));
    }

    // Only reached when the cookie did not authenticate. See the module note.
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
    Ok(Some((s, None)))
}

/// 401 unless the request carries a session.
pub async fn require_session(
    State(st): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    let now_ms = chrono::Utc::now().timestamp_millis();
    // The share window uses today's date in UTC: the viewer's zone (the
    // route's `tz`) is unknown here, so near midnight it can be a day off.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    match resolve(&st, &jar, req.headers(), now_ms, &today).await {
        Err(e) => {
            // 500, not 401. A database that cannot be read is not a failed
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
        Ok(Some((s, renewed))) => {
            req.extensions_mut().insert(s);
            let mut res = next.run(req).await;
            // A renewed session's cookie goes back with a fresh `Max-Age`, so a
            // cookie set with a shorter one is not dropped while its row lives.
            if let Some(signed) = renewed
                && let Ok(policy) = crate::lean::session_policy()
                && let Ok(v) = format!(
                    "{}={signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={}",
                    policy.cookie_name, policy.cookie_max_age_s
                )
                .parse()
            {
                res.headers_mut().append(axum::http::header::SET_COOKIE, v);
            }
            res
        }
    }
}

/// 403 when a share viewer tries anything `Verified.Session.mayProceed` refuses.
///
/// ⚠ Mount after [`require_session`]. A request without a session is a 500
/// here: run first, a share viewer's POST would carry no session yet, read as
/// not a share viewer, and be allowed. Mounted correctly, `require_session` has
/// already answered 401.
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
    // The original path. Behind `nest("/api", …)` the request's own URI has
    // the prefix stripped, so `/api/telemetry` arrived here as `/telemetry` and
    // matched no rule written against full paths.
    let path = req
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| req.uri().path(), |o| o.0.path())
        .to_string();

    match crate::lean::may_proceed(is_share_viewer, session.hides_location, &method, &path) {
        // An error refuses. This asks Lean whether the request is allowed, so
        // a question that could not be answered must not be treated as a yes.
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "mayProceed could not be evaluated");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "auth_unavailable" })),
            )
                .into_response()
        }
        Ok(false) => {
            let error = if method == "GET" {
                "location_not_shared"
            } else {
                "read_only_share"
            };
            (StatusCode::FORBIDDEN, axum::Json(json!({ "error": error }))).into_response()
        }
        Ok(true) => next.run(req).await,
    }
}
