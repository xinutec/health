//! `GET /me` — who this request is, and what it is connected to: the SPA's
//! first call, deciding which connect prompts to show and how far a share
//! link's date arrows may move.
//!
//! `fitbitLinked`/`nextcloudLinked` are legacy booleans for older SPA builds:
//! a revoked credential is `needs_reauth` yet `linked: true`. Narrowing them
//! would change what those builds render.
//!
//! `shareWindow` (share requests only, `null` for the owner) bounds the SPA's
//! day arrows. Not a security boundary: every endpoint enforces the window.

use axum::extract::State;
use axum::{Extension, Json};
use serde::Serialize;

use crate::auth::session::UserSession;
use crate::error::AppError;
use crate::lean;
use crate::state::AppState;

/// One connection's state, as the SPA's reauth banner reads it. `status` is
/// `Verified.connectionStatus`'s vocabulary, kept a `String` so Lean alone
/// decides which statuses exist.
#[derive(Serialize)]
pub struct ConnectionState {
    pub status: String,
}

#[derive(Serialize)]
pub struct Connections {
    pub nextcloud: ConnectionState,
}

/// The bounds a share recipient may navigate within. See the header.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareWindow {
    pub from: String,
    pub to: String,
    /// Whether this link shows the day's timeline and the map.
    pub location: bool,
}

/// `GET /me`'s answer. Field order is wire order (`preserve_order`).
/// `shareWindow` serialises an explicit `null` for the owner, which the SPA
/// tells apart from an older server's missing key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user_id: String,
    pub display_name: String,
    pub nextcloud_linked: bool,
    pub connections: Connections,
    pub share_window: Option<ShareWindow>,
}

/// Errors are `AppError`'s envelope, part of the wire contract;
/// `AppError::Other` logs the detail and answers generically.
pub async fn handler(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Result<Json<MeResponse>, AppError> {
    run(&st, &session).await
}

async fn run(st: &AppState, session: &UserSession) -> Result<Json<MeResponse>, AppError> {
    // `fetch_optional`, and no row is the `not_linked` answer. The read is
    // deliberately cheap — `/api/me` is on the SPA's critical path and the
    // status makes no round trip to the provider.
    let nc: Option<Option<String>> =
        sqlx::query_scalar("SELECT status FROM nc_credentials WHERE user_id = ?")
            .bind(&session.user_id)
            .fetch_optional(&st.pool)
            .await?;

    // Two absences collapse here: no row is `not_linked`, a row with NULL
    // status reads as `active`.
    let (nc_status, nc_linked) =
        lean::connection_status(nc.as_ref().map(|s| s.as_deref().unwrap_or("")))?;

    let share_window = session.share_viewer.as_ref().map(|(from, to)| ShareWindow {
        from: from.clone(),
        to: to.clone(),
        location: !session.hides_location,
    });

    Ok(Json(MeResponse {
        user_id: session.user_id.clone(),
        display_name: session.display_name.clone(),
        nextcloud_linked: nc_linked,
        connections: Connections {
            nextcloud: ConnectionState { status: nc_status },
        },
        share_window,
    }))
}
