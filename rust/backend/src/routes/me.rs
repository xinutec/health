//! `GET /me` — who this request is, and what it is connected to (#982).
//!
//! The SPA's first call. It decides which "connect your account" prompts to
//! show, and — for a share link — how far the date arrows may move.
//!
//! # Two spellings of the same fact, on purpose
//!
//! ⚠ `fitbitLinked`/`nextcloudLinked` are LEGACY booleans kept for older SPA
//! builds, and they are not the same question as `connections.*.status`. A
//! revoked credential is `needs_reauth` AND `linked: true`, so an old build
//! shows "connected" for an account that cannot fetch anything. Narrowing the
//! boolean to `active` would be more truthful and would change what those
//! builds render, so the port keeps the TypeScript's answer.
//!
//! # `shareWindow` is how a recipient learns their own bounds
//!
//! ⚠ Present ONLY for a share-token request, `null` for the owner. The SPA
//! clamps its previous/next-day arrows to it. It is not a security boundary —
//! every endpoint enforces the window itself — but a host that omitted it would
//! leave a recipient clicking into days that answer empty with no explanation.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{Value, json};

use crate::auth::session::UserSession;
use crate::lean;
use crate::state::AppState;

pub async fn handler(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    match run(&st, &session).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "/me failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal" })),
            )
                .into_response()
        }
    }
}

async fn run(st: &AppState, session: &UserSession) -> anyhow::Result<Response> {
    // ⚠ `fetch_optional`, and NO row is the `not_linked` answer. Both reads are
    // deliberately cheap — `/api/me` is on the SPA's critical path and neither
    // status makes a round trip to the provider.
    let nc: Option<Option<String>> =
        sqlx::query_scalar("SELECT status FROM nc_credentials WHERE user_id = ?")
            .bind(&session.user_id)
            .fetch_optional(&st.pool)
            .await?;
    let fb: Option<Option<String>> =
        sqlx::query_scalar("SELECT status FROM tokens WHERE user_id = ?")
            .bind(&session.user_id)
            .fetch_optional(&st.pool)
            .await?;

    // ⚠ TWO levels of absence collapse here, and they mean different things:
    // no ROW is `not_linked`, while a row with a NULL status takes the
    // fall-through and reads as `active`. `Option<Option<String>>` keeps them
    // apart until this line, which is the only place the distinction is made.
    let (nc_status, nc_linked) =
        lean::connection_status(nc.as_ref().map(|s| s.as_deref().unwrap_or("")))?;
    let (fb_status, fb_linked) =
        lean::connection_status(fb.as_ref().map(|s| s.as_deref().unwrap_or("")))?;

    let share_window = match &session.share_viewer {
        None => Value::Null,
        Some((from, to)) => json!({ "from": from, "to": to }),
    };

    // ⚠ Key order is the wire order — `preserve_order` is on, and this matches
    // the TypeScript's object literal.
    Ok(Json(json!({
        "userId": session.user_id,
        "displayName": session.display_name,
        "fitbitLinked": fb_linked,
        "nextcloudLinked": nc_linked,
        "connections": {
            "nextcloud": { "status": nc_status },
            "fitbit": { "status": fb_status },
        },
        "shareWindow": share_window,
    }))
    .into_response())
}
