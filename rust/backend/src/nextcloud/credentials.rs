//! The Nextcloud app-password store: CRUD, one row by primary key, no refresh,
//! no lock and no cache. An app password from Login Flow v2 has no expiry and
//! nothing to rotate, which is what avoids a cross-pod refresh race.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// What every Nextcloud request needs to build an `Authorization` header.
#[derive(Debug, Clone)]
pub struct NcCredentials {
    pub login_name: String,
    pub app_password: String,
}

/// Why a Nextcloud call could not be made or did not succeed. The first two are
/// user-visible states `/api/me` reports, separate because the remedies differ:
/// link an account, or relink a revoked one.
#[derive(Debug, thiserror::Error)]
pub enum NcError {
    #[error("Nextcloud not linked")]
    NotLinked,

    #[error("Nextcloud app password no longer valid — relink required")]
    ReauthRequired,

    #[error("Nextcloud API {method} {path}: {status} {body}")]
    Api {
        method: &'static str,
        path: String,
        status: u16,
        body: String,
    },

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Load `user_id`'s credentials, refusing if absent or flagged: sending a
/// known-dead password spends a brute-force-counter increment.
pub async fn get(pool: &MySqlPool, user_id: &str) -> Result<NcCredentials, NcError> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT login_name, app_password, status FROM nc_credentials WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .context("reading nextcloud credentials")?;

    let (login_name, app_password, status) = row.ok_or(NcError::NotLinked)?;
    if status == "needs_reauth" {
        return Err(NcError::ReauthRequired);
    }
    Ok(NcCredentials {
        login_name,
        app_password,
    })
}

/// Flag the credentials dead after a 401. A failed write is not the request's
/// error: the next run rediscovers it. The caller returns
/// [`NcError::ReauthRequired`] either way.
pub async fn mark_needs_reauth(pool: &MySqlPool, user_id: &str) -> Result<()> {
    sqlx::query("UPDATE nc_credentials SET status = 'needs_reauth' WHERE user_id = ?")
        .bind(user_id)
        .execute(pool)
        .await
        .context("flagging nextcloud credentials needs_reauth")?;
    Ok(())
}

/// Store (or replace) a user's app password. ⚠ The upsert resets `status` to
/// `active`, or a relink after revocation would succeed and change nothing.
pub async fn store(
    pool: &MySqlPool,
    user_id: &str,
    login_name: &str,
    app_password: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO nc_credentials (user_id, login_name, app_password, status) \
         VALUES (?, ?, ?, 'active') \
         ON DUPLICATE KEY UPDATE login_name = VALUES(login_name), \
         app_password = VALUES(app_password), status = 'active'",
    )
    .bind(user_id)
    .bind(login_name)
    .bind(app_password)
    .execute(pool)
    .await?;
    Ok(())
}
