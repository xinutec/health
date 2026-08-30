//! The application error type, with an axum `IntoResponse` so handlers can `?`.
//!
//! These status shapes are INHERITED and are not free to change: the frontend
//! already branches on them, so an edit here is a client-visible API change
//! even though nothing in this file mentions a client. They came from the
//! TypeScript server the port replaced and match the sibling repos'.
//!
//! ⚠ `Other` is the only variant whose text is NOT shown. Everything else names
//! something the caller can act on; an unexpected failure names nothing useful
//! and its detail belongs in the log, not in a response body a browser renders.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not authenticated")]
    Unauthorized,

    #[error("not found")]
    NotFound,

    /// The client sent something unacceptable — a bad date, an unknown
    /// timezone, a malformed body.
    #[error("{0}")]
    BadRequest(String),

    /// Nextcloud is not linked for this user. Distinct from `Unauthorized`
    /// because the remedy is different: link an account, not log in.
    #[error("nextcloud not linked")]
    NcNotLinked,

    #[error("nextcloud app password no longer valid — relink required")]
    NcReauthRequired,

    /// A service outside health failed in a way worth naming. 502 rather than
    /// 500 because nothing here is broken.
    #[error("{0}")]
    Upstream(String),

    /// Anything unexpected → 500, generic body, detail logged.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Other(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::NcNotLinked => (StatusCode::CONFLICT, self.to_string()),
            AppError::NcReauthRequired => (StatusCode::CONFLICT, self.to_string()),
            AppError::Upstream(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
            AppError::Other(e) => {
                // Logged whole, answered generically: the log is ours and the
                // response is the caller's, and an unexpected failure names
                // nothing a caller can act on.
                tracing::error!("unhandled: {e:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
