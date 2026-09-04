//! Share-link management (#982).
//!
//! One row per user. A share link hands an unauthenticated recipient read
//! access to the last N days, so these four handlers are the only place a user
//! can widen or close that.
//!
//! ⚠ THESE ARE THE FIRST WRITE ROUTES IN THIS ROUTER, which makes the layer
//! order in `routes::mod` load-bearing rather than theoretical. `require_session`
//! must run BEFORE `require_may_proceed`, because the latter reads the session
//! out of the request extensions to decide whether a share viewer may write.
//! Run the wrong way round, a recipient's POST is judged before their session
//! exists, looks anonymous, is therefore not a share viewer, and is allowed —
//! a read-only link that can rotate its owner's token.
//!
//! # `daysBack` CLAMPS here and REJECTS on a read
//!
//! ⚠ `?days=400` on `/activity` is an error; `daysBack: 400` here is silently
//! narrowed to 365. Same API, same domain, opposite behaviour — and both are
//! the TypeScript's. See `Verified.Share.clampShareDaysBack` against
//! `Verified.ApiWindow.validateDays`.
//!
//! ⚠ A non-number is a THIRD case, distinct from out-of-range: it is not
//! clamped, it is refused, and then POST and PATCH disagree about what to do
//! with the refusal. POST falls back to 7; PATCH answers 400. A host that
//! collapsed them would either reject a bodyless create or quietly retune a
//! live link to a week.
//!
//! # Rotation is DELETE + INSERT, in one transaction
//!
//! The old token's row is GONE, so a leaked link stops working immediately
//! rather than expiring. The transaction is what stops a concurrent read seeing
//! the gap in between and concluding the share was revoked.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use sqlx::mysql::MySqlRow;

use crate::auth::session::UserSession;
use crate::error::ErrorBody;
use crate::state::AppState;
use crate::{lean, row_json};

/// The default window when a create request says nothing usable.
///
/// ⚠ Seven days, and it is NOT `SHARE_DAYS_MIN`. A create with no body opens a
/// week of history, so a mistaken POST is not harmless.
const DEFAULT_DAYS_BACK: i64 = 7;

#[derive(serde::Deserialize)]
pub struct Body {
    #[serde(rename = "daysBack")]
    days_back: Option<Value>,
}

/// `daysBack` from a JSON body, as `clampShareDaysBack` sees it.
///
/// ⚠ `typeof value !== "number"` in the TypeScript, so a numeric STRING is not
/// a number: `{"daysBack": "7"}` is refused, not parsed. That is the opposite
/// of the query-parameter path, where everything arrives as a string and is
/// coerced. Accepting `"7"` here would be a kindness that production does not
/// extend.
fn days_back_of(body: Option<&Body>) -> Option<i64> {
    let v = body?.days_back.as_ref()?;
    // `Math.floor`, so toward negative infinity — and then clamped, which is
    // why the two rounding directions cannot be told apart downstream.
    let n = v.as_f64()?;
    n.is_finite().then(|| n.floor() as i64)
}

/// One share row, rendered as the TypeScript renders it.
///
/// ⚠ `createdAt` is `Date.toISOString()`, which is the same string
/// `JSON.stringify` produces for a Date — so this reuses the row renderer's
/// formatter rather than inventing a second one.
/// `GET`/`POST`/`PATCH /share`'s answer, in both of its shapes.
///
/// ⚠ ONE STRUCT FOR A TAGGED PAIR, and the tag is `active`. With no link the
/// other keys are ABSENT, not null — the settings page renders the create
/// button off `active: false` alone — so every optional carries
/// `skip_serializing_if`.
///
/// ⚠ `last_accessed_at` is `Option<Option<_>>` and that is not a typo. The
/// OUTER absence means "there is no link"; `Some(None)` means "a link nobody
/// has opened yet" and must serialize as an explicit `null`. Collapsing the two
/// would make an unopened link indistinguishable from no link at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_back: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_accessed_at: Option<Option<String>>,
}

impl ShareStatus {
    /// "You have no share link" — an ANSWER with a 200, not a 404.
    fn inactive() -> Self {
        Self {
            active: false,
            token: None,
            url: None,
            days_back: None,
            created_at: None,
            last_accessed_at: None,
        }
    }
}

fn share_json(st: &AppState, row: &MySqlRow) -> anyhow::Result<ShareStatus> {
    let token: String = row.try_get("token")?;
    let days_back: i64 = row.try_get("days_back")?;
    let created: chrono::NaiveDateTime = row.try_get_unchecked("created_at")?;
    let last: Option<chrono::NaiveDateTime> = row.try_get_unchecked("last_accessed_at")?;
    Ok(ShareStatus {
        active: true,
        url: Some(lean::build_share_url(&st.cfg.public_base_url, &token)?),
        token: Some(token),
        days_back: Some(days_back),
        created_at: Some(row_json::format_date_time_iso(created)),
        last_accessed_at: Some(last.map(row_json::format_date_time_iso)),
    })
}

async fn fetch(st: &AppState, user_id: &str) -> anyhow::Result<Option<MySqlRow>> {
    Ok(sqlx::query("SELECT * FROM share_tokens WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&st.pool)
        .await?)
}

fn oops(e: &anyhow::Error) -> Response {
    tracing::error!(error = %e, "share route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: "internal".to_string(),
        }),
    )
        .into_response()
}

/// `GET /share` — the current link, or `{active: false}`.
pub async fn get(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    match fetch(&st, &session.user_id).await {
        Err(e) => oops(&e),
        // ⚠ `{active: false}` and a 200, not a 404. "You have no share link" is
        // an answer, and the settings page renders it as the create button.
        Ok(None) => Json(ShareStatus::inactive()).into_response(),
        Ok(Some(row)) => match share_json(&st, &row) {
            Ok(v) => Json(v).into_response(),
            Err(e) => oops(&e),
        },
    }
}

/// `POST /share` — create or ROTATE. The previous token stops working.
pub async fn post(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    body: Option<Json<Body>>,
) -> Response {
    let requested = days_back_of(body.as_ref().map(|Json(b)| b));
    let days_back = match lean::clamp_share_days_back(requested) {
        Ok(d) => d.unwrap_or(DEFAULT_DAYS_BACK),
        Err(e) => return oops(&e),
    };

    match rotate(&st, &session.user_id, days_back).await {
        Err(e) => oops(&e),
        Ok(row) => match share_json(&st, &row) {
            Ok(v) => Json(v).into_response(),
            Err(e) => oops(&e),
        },
    }
}

/// DELETE + INSERT in ONE transaction.
///
/// ⚠ The transaction is not ceremony. Without it a concurrent read lands
/// between the two statements, finds no row, and tells the user their share is
/// revoked — which is exactly the moment they are looking at the settings page.
async fn rotate(st: &AppState, user_id: &str, days_back: i64) -> anyhow::Result<MySqlRow> {
    let token = crate::auth::session::mint_share_token()?;
    let mut tx = st.pool.begin().await?;
    sqlx::query("DELETE FROM share_tokens WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO share_tokens (user_id, token, days_back) VALUES (?, ?, ?)")
        .bind(user_id)
        .bind(&token)
        .bind(days_back)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    fetch(st, user_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("share row vanished immediately after insert"))
}

/// `PATCH /share` — retune the window WITHOUT rotating, so the link keeps
/// working.
pub async fn patch(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    body: Option<Json<Body>>,
) -> Response {
    let requested = days_back_of(body.as_ref().map(|Json(b)| b));
    // ⚠ REJECTS where POST defaults. A PATCH is aimed at a live link, and
    // quietly retuning it to seven days because the body was malformed would
    // change what a recipient can see without anyone asking for it.
    let days_back = match lean::clamp_share_days_back(requested) {
        Err(e) => return oops(&e),
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: "daysBack must be a number in [1, 365]".to_string(),
                }),
            )
                .into_response();
        }
        Ok(Some(d)) => d,
    };

    let updated = async {
        sqlx::query("UPDATE share_tokens SET days_back = ? WHERE user_id = ?")
            .bind(days_back)
            .bind(&session.user_id)
            .execute(&st.pool)
            .await?;
        fetch(&st, &session.user_id).await
    }
    .await;

    match updated {
        Err(e) => oops(&e),
        // ⚠ 404 rather than creating one. An update to a share that does not
        // exist is a mistake worth reporting, not an invitation to open access.
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "no_active_share".to_string(),
            }),
        )
            .into_response(),
        Ok(Some(row)) => match share_json(&st, &row) {
            Ok(v) => Json(v).into_response(),
            Err(e) => oops(&e),
        },
    }
}

/// `DELETE /share` — revoke. 204, and idempotent: revoking a share that is
/// already gone is a success, because the caller's intent is satisfied.
pub async fn delete(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    match sqlx::query("DELETE FROM share_tokens WHERE user_id = ?")
        .bind(&session.user_id)
        .execute(&st.pool)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => oops(&anyhow::Error::from(e)),
    }
}
