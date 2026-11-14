//! Session cookies: minting, signing, verifying, and the `sessions` table.
//!
//! The cookie is `<session-id>.<hmac>`: the id keys the table, the HMAC proves
//! this server issued it. Framing is `Verified.Session.splitSigned` (the last
//! separator), not a `split_once` here.

use anyhow::{Context, Result};
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sqlx::{MySqlPool, Row};
use subtle::ConstantTimeEq;

use crate::lean;

/// Who a request is from. `share_viewer` is the inclusive `[from, to]` window a
/// forwarded link may see; `None` is the owner.
#[derive(Debug, Clone, PartialEq)]
pub struct UserSession {
    pub user_id: String,
    pub display_name: String,
    pub share_viewer: Option<(String, String)>,
    /// The viewer's link has location turned off. Always `false` for the owner.
    pub hides_location: bool,
}

/// A fresh session id: 32 bytes of OS entropy, hex. ⚠ The OS CSPRNG or an
/// error, never a fallback: a predictable id would work.
pub fn mint_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).context("reading the OS CSPRNG for a session id")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A share token: 32 random bytes as base64url (43 characters, the shape every
/// issued link has; hex would be 64, filling `VARCHAR(64)`). The OS CSPRNG or an
/// error: a guessable token exposes location history.
pub fn mint_share_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).context("reading the OS CSPRNG for a share token")?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// `<value>.<base64url-hmac-sha256>`, unpadded, as every issued signature is.
pub fn sign_value(secret: &str, value: &str) -> String {
    let sig = mac(secret, value);
    format!(
        "{value}.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig)
    )
}

fn mac(secret: &str, value: &str) -> Vec<u8> {
    // `new_from_slice` accepts any key length for HMAC, so this cannot fail for
    // a reason the caller could act on.
    let mut m = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    m.update(value.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// The value inside a signed string, or `None` if we did not sign it. ⚠ Constant
/// time (`subtle::ConstantTimeEq`), after a separate length check: an early exit
/// leaks where the signature differs.
pub fn verify_value(secret: &str, signed: &str) -> Result<Option<String>> {
    let Some((value, sig)) = lean::split_signed(signed)? else {
        return Ok(None);
    };
    let Ok(given) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&sig) else {
        return Ok(None);
    };
    let expected = mac(secret, &value);
    if given.len() != expected.len() {
        return Ok(None);
    }
    if given.ct_eq(&expected).into() {
        Ok(Some(value))
    } else {
        Ok(None)
    }
}

/// Seat a new session and return the signed cookie value.
pub async fn create(
    pool: &MySqlPool,
    secret: &str,
    user_id: &str,
    display_name: &str,
    now_ms: i64,
) -> Result<String> {
    let id = mint_id()?;
    // The row's lifetime comes from Lean (`Verified.Session`).
    let ttl_ms = lean::session_policy()?.ttl_ms;
    let expires = expires_at(now_ms + ttl_ms)?;
    sqlx::query("INSERT INTO sessions (id, user_id, display_name, expires_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(user_id)
        .bind(display_name)
        .bind(&expires)
        .execute(pool)
        .await
        .context("seating a session")?;
    Ok(sign_value(secret, &id))
}

/// `YYYY-MM-DD HH:MM:SS` UTC, for a `DATETIME`. The pool pins the session zone
/// to UTC, so no conversion happens on the way in or out.
fn expires_at(ms: i64) -> Result<String> {
    Ok(chrono::DateTime::from_timestamp_millis(ms)
        .with_context(|| format!("{ms} is not a representable instant"))?
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

/// Who this cookie belongs to, and whether its session was just renewed (so the
/// cookie goes back with a fresh `Max-Age`). An expired row is deleted here.
pub async fn get(
    pool: &MySqlPool,
    secret: &str,
    signed: &str,
    now_ms: i64,
) -> Result<Option<(UserSession, bool)>> {
    let Some(id) = verify_value(secret, signed)? else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT user_id, display_name, expires_at FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_optional(pool)
        .await
        .context("reading a session")?;
    let Some(row) = row else {
        return Ok(None);
    };
    // Every decode errors rather than defaulting. A `display_name` that
    // silently became "" is a session that works and cannot say whose it is.
    let user_id: String = row.try_get("user_id").context("sessions.user_id")?;
    let display_name: String = row
        .try_get("display_name")
        .context("sessions.display_name")?;
    let expires: chrono::NaiveDateTime =
        row.try_get("expires_at").context("sessions.expires_at")?;

    if !lean::session_is_valid(expires.and_utc().timestamp_millis(), now_ms)? {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(&id)
            .execute(pool)
            .await
            .context("retiring an expired session")?;
        return Ok(None);
    }
    // A used session lasts a month from now (`Verified.Session.renewedExpiry`).
    let renewed = lean::renewed_expiry(expires.and_utc().timestamp_millis(), now_ms)?;
    if let Some(fresh_ms) = renewed {
        sqlx::query("UPDATE sessions SET expires_at = ? WHERE id = ?")
            .bind(expires_at(fresh_ms)?)
            .bind(&id)
            .execute(pool)
            .await
            .context("renewing a session")?;
    }
    Ok(Some((
        UserSession {
            user_id,
            display_name,
            share_viewer: None,
            hides_location: false,
        },
        renewed.is_some(),
    )))
}

/// Log out. A cookie that does not verify deletes nothing — and says so by
/// returning `false` rather than pretending.
pub async fn destroy(pool: &MySqlPool, secret: &str, signed: &str) -> Result<bool> {
    let Some(id) = verify_value(secret, signed)? else {
        return Ok(false);
    };
    let done = sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .context("destroying a session")?;
    Ok(done.rows_affected() > 0)
}

/// Sweep expired rows: [`get`] only retires sessions whose owner returns.
pub async fn cleanup_expired(pool: &MySqlPool, now_ms: i64) -> Result<u64> {
    let done = sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(expires_at(now_ms)?)
        .execute(pool)
        .await
        .context("sweeping expired sessions")?;
    Ok(done.rows_affected())
}
