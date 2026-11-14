//! The application error type, with an axum `IntoResponse` so handlers can `?`.
//! The status shapes are a client contract (the frontend branches on them),
//! shared with the sibling repos.
//!
//! ⚠ `Other`'s text is never shown: an unexpected failure's detail goes to the
//! log, not a body a browser renders.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

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

/// Every error answer's body, as a struct so the wire has a type
/// (dl-wire-untyped-response), shared by every route returning `AppError`.
#[derive(Serialize)]
pub struct ErrorBody {
    pub error: String,
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
        (status, Json(ErrorBody { error: message })).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
