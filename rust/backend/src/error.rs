//! The application error type, with an axum `IntoResponse` so handlers can `?`.
//!
//! Shapes match `src/server.ts`'s error handling and the sibling repos' — the
//! frontend already reads these statuses, and the port must not quietly change
//! what a client sees.
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
                // Logged whole, answered generically. `src/server.ts` does the
                // same and for the same reason.
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
