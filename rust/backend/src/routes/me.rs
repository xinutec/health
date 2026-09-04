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
use axum::{Extension, Json};
use serde::Serialize;

use crate::auth::session::UserSession;
use crate::error::AppError;
use crate::lean;
use crate::state::AppState;

/// One connection's state, as the SPA's reauth banner reads it.
///
/// `status` is `Verified.connectionStatus`'s own vocabulary — `active`,
/// `needs_reauth`, `not_linked` — and is deliberately a `String` rather than an
/// enum: the value crosses from Lean, and narrowing it here would move the
/// decision about what statuses EXIST out of the module that decides it.
#[derive(Serialize)]
pub struct ConnectionState {
    pub status: String,
}

#[derive(Serialize)]
pub struct Connections {
    pub nextcloud: ConnectionState,
    pub fitbit: ConnectionState,
}

/// The bounds a share recipient may navigate within. See the header.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareWindow {
    pub from: String,
    pub to: String,
}

/// `GET /me`'s answer.
///
/// ⚠ FIELD ORDER IS WIRE ORDER — `preserve_order` is on and this matched the
/// TypeScript's object literal when it was a `json!`. serde emits struct fields
/// in declaration order, so reordering them here is a wire change.
///
/// ⚠ `shareWindow` is `Option` WITHOUT `skip_serializing_if`: the owner's
/// answer carries an explicit `null`, which is what the SPA distinguishes from
/// a share view. Omitting the key would read as "an older server" instead.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub user_id: String,
    pub display_name: String,
    pub fitbit_linked: bool,
    pub nextcloud_linked: bool,
    pub connections: Connections,
    pub share_window: Option<ShareWindow>,
}

/// ⚠ THE ERROR BODY IS `AppError`'s, not this module's. It used to build its own
/// `json!({"error": "internal"})`, which meant the handler had no wire type even
/// once its SUCCESS answer had one — the rule asks whether a handler builds JSON
/// by hand at all, and an error envelope the SPA reads is part of the contract.
/// `AppError::Other` logs the detail and answers generically, which is what the
/// hand-rolled arm was doing.
pub async fn handler(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Result<Json<MeResponse>, AppError> {
    run(&st, &session).await
}

async fn run(st: &AppState, session: &UserSession) -> Result<Json<MeResponse>, AppError> {
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

    let share_window = session.share_viewer.as_ref().map(|(from, to)| ShareWindow {
        from: from.clone(),
        to: to.clone(),
    });

    Ok(Json(MeResponse {
        user_id: session.user_id.clone(),
        display_name: session.display_name.clone(),
        fitbit_linked: fb_linked,
        nextcloud_linked: nc_linked,
        connections: Connections {
            nextcloud: ConnectionState { status: nc_status },
            fitbit: ConnectionState { status: fb_status },
        },
        share_window,
    }))
}
