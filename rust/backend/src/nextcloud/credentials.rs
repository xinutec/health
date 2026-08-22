//! The Nextcloud app-password store. Port of `src/nextcloud/credentials.ts`.
//!
//! # Why there is no refresh here, and no lock either
//!
//! [`super::client`]'s Fitbit sibling holds a per-user mutex so that two callers
//! crossing the expiry boundary cannot both rotate a single-use refresh token.
//! None of that applies to an app password: it is a long-lived credential from
//! Nextcloud's Login Flow v2 with no expiry and nothing to rotate, sent as HTTP
//! Basic Auth on every request. The TypeScript's own header records that this
//! shape was CHOSEN to end a cross-pod refresh race — the auth pod and the sync
//! cron each noticing "expires soon" and the loser being told its refresh token
//! was already spent.
//!
//! So this module is CRUD and nothing else. Reads are one row by primary key.
//! Adding a cache here would reintroduce the coherence question that removing
//! the refresh answered.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// What every Nextcloud request needs to build an `Authorization` header.
#[derive(Debug, Clone)]
pub struct NcCredentials {
    pub login_name: String,
    pub app_password: String,
}

/// Why a Nextcloud call could not be made or did not succeed.
///
/// The first two are DURABLE, user-visible states rather than failures of this
/// run: both mean the user has to go and do something in a browser, and both
/// are what `/api/me` reports. They are separate variants rather than one
/// "unauthorised" because the remedies differ — one is "link an account", the
/// other is "your app password was revoked, link it again".
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

/// Load `user_id`'s credentials, refusing if absent or flagged.
///
/// ⚠ The `needs_reauth` check is here rather than at the call site on purpose:
/// a stored flag means the password is known-dead, and sending it anyway would
/// spend a Nextcloud brute-force-counter increment to learn what the row
/// already says.
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

/// Flag the credentials dead after Nextcloud answered 401.
///
/// ⚠ Failing to WRITE this must not be reported as the reason the request
/// failed. The 401 is the finding; a flag that did not persist means the next
/// run rediscovers it, which is a wasted call and not a wrong answer. The
/// caller logs and returns [`NcError::ReauthRequired`] either way.
pub async fn mark_needs_reauth(pool: &MySqlPool, user_id: &str) -> Result<()> {
    sqlx::query("UPDATE nc_credentials SET status = 'needs_reauth' WHERE user_id = ?")
        .bind(user_id)
        .execute(pool)
        .await
        .context("flagging nextcloud credentials needs_reauth")?;
    Ok(())
}

/// Store (or replace) a user's Nextcloud app password, marking them active.
///
/// ⚠ Upsert, and it must RESET `status` to `active`. A user relinking after a
/// revocation would otherwise land a fresh, working credential in a row still
/// flagged `needs_reauth`, and every later call would refuse it — a relink that
/// visibly succeeds and changes nothing.
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
