//! Auth by share token — the read-only path a forwarded link takes (#982).
//!
//! A recipient sends `X-Share-Token`. If it matches a row, the request runs AS
//! THE OWNER with a date window attached, and everything downstream sees an
//! ordinary session. What stops it being a full login is
//! `Verified.Session.mayProceed`, which refuses any non-GET.
//!
//! # ⚠ Every failure here means NO SESSION, never a session with no window
//!
//! An absent token, an unknown token, a revoked one, a `days_back` of zero: all
//! of them leave the request unauthenticated, and the caller's own "is there a
//! session" gate refuses it. The shape to avoid is a session whose window failed
//! to resolve — that is an unrestricted viewer wearing a recipient's name, and
//! it is why [`crate::lean::shareable_date_range`] returning `None` is treated as
//! "share disabled" rather than "no restriction".

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

use crate::auth::session::UserSession;
use crate::lean;

/// One `share_tokens` row.
pub struct ShareRow {
    pub user_id: String,
    pub days_back: i64,
}

/// Look a token up. `None` for unknown or revoked — rotation is DELETE +
/// INSERT, so a leaked old token stops working the moment it is rotated.
pub async fn by_token(pool: &MySqlPool, token: &str) -> Result<Option<ShareRow>> {
    let row = sqlx::query("SELECT user_id, days_back FROM share_tokens WHERE token = ?")
        .bind(token)
        .fetch_optional(pool)
        .await
        .context("reading share_tokens")?;
    let Some(row) = row else {
        return Ok(None);
    };
    // ⚠ Errors rather than defaulting. A `days_back` that silently became 0
    // would read as "share disabled" and lock the recipient out of a working
    // link; one that became 7 would invent a window nobody granted.
    Ok(Some(ShareRow {
        user_id: row.try_get("user_id").context("share_tokens.user_id")?,
        days_back: row.try_get("days_back").context("share_tokens.days_back")?,
    }))
}

/// Note that a link was used. Best-effort by design: the TypeScript fires this
/// and forgets, and a failed bookkeeping write must not fail the read it
/// accompanies.
///
/// ⚠ Returns the error rather than swallowing it, so the caller decides to
/// ignore it. A function that swallows its own failure cannot be tested for
/// having tried.
pub async fn touch_last_accessed(pool: &MySqlPool, token: &str) -> Result<()> {
    sqlx::query("UPDATE share_tokens SET last_accessed_at = ? WHERE token = ?")
        .bind(
            chrono::Utc::now()
                .naive_utc()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        )
        .bind(token)
        .execute(pool)
        .await
        .context("bumping share_tokens.last_accessed_at")?;
    Ok(())
}

/// Resolve a share token to a session, or `None`.
///
/// `today` is the most recent date the recipient may see, already resolved in
/// the viewer's zone — the same argument `Verified.VelocityCache` needs and for
/// the same reason: Lean has no zone database.
///
/// ⚠ The display name is the OWNER's user id, matching the TypeScript. The
/// frontend prefixes "Shared with you"; the backend does not pretend the
/// recipient is someone else.
pub async fn resolve(pool: &MySqlPool, token: &str, today: &str) -> Result<Option<UserSession>> {
    let Some(row) = by_token(pool, token).await? else {
        return Ok(None);
    };
    let Some((from, to)) = lean::shareable_date_range(today, row.days_back)? else {
        // `days_back <= 0` — degenerate, and treated as revoked.
        return Ok(None);
    };
    Ok(Some(UserSession {
        display_name: row.user_id.clone(),
        user_id: row.user_id,
        share_viewer: Some((from, to)),
    }))
}
