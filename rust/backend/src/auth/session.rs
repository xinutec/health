//! Session cookies: minting, signing, verifying, and the `sessions` table.
//!
//! # The cookie is `<session-id>.<hmac>`
//!
//! The id is what the table is keyed by; the signature is what stops a client
//! inventing one. Neither half is secret-bearing on its own — the id is a
//! random 32 bytes and the HMAC proves this server issued it.
//!
//! ⚠ The FRAMING of that string is `Verified.Session.splitSigned`, not a
//! `split_once` here. It splits on the LAST separator, because the signature is
//! base64url and carries no dot, so a value containing dots round-trips. That is
//! three lines, which is exactly the size at which a wrong one survives review.

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
}

/// A fresh session id: 32 bytes of OS entropy, hex.
///
/// ⚠ `getrandom` and not a seeded generator. A session id is the whole of the
/// bearer's claim, so the only acceptable source is the OS CSPRNG — and a
/// failure to read it must be an ERROR rather than a fallback, because the
/// fallback would be a predictable id that works.
pub fn mint_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).context("reading the OS CSPRNG for a session id")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `<value>.<base64url-hmac-sha256>` — the TypeScript's `signValue`.
///
/// ⚠ base64url with NO PADDING. Node's `digest("base64url")` omits `=`, so
/// padding here would produce a signature that never matches one issued before
/// the port.
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

/// The value inside a signed string, or `None` if it was not signed by us.
///
/// ⚠ CONSTANT TIME. A comparison that returns on the first differing byte tells
/// an attacker where it differed, one request at a time, and a signature is
/// exactly the thing that makes that worth doing. `subtle::ConstantTimeEq`
/// rather than `==`, and the length check is separate because lengths differing
/// is not a secret.
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
    // ⚠ The row's lifetime comes from Lean, and the cookie's `Max-Age` comes
    // from the SAME call. A cookie outliving its row is a user who appears
    // logged in and is not.
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

/// Who this cookie belongs to, or `None`.
///
/// ⚠ An EXPIRED row is deleted on the way past. The sweep below only reaches
/// sessions whose owner never returns; this is what retires the ones that do.
pub async fn get(
    pool: &MySqlPool,
    secret: &str,
    signed: &str,
    now_ms: i64,
) -> Result<Option<UserSession>> {
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
    // ⚠ Every decode errors rather than defaulting. A `display_name` that
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
    Ok(Some(UserSession {
        user_id,
        display_name,
        share_viewer: None,
    }))
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

/// Sweep expired rows.
///
/// The lazy retirement in [`get`] only touches sessions whose owner comes back;
/// a dormant user's row is never looked at again, so without this the table
/// grows monotonically.
pub async fn cleanup_expired(pool: &MySqlPool, now_ms: i64) -> Result<u64> {
    let done = sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(expires_at(now_ms)?)
        .execute(pool)
        .await
        .context("sweeping expired sessions")?;
    Ok(done.rows_affected())
}
