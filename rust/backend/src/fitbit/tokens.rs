//! Fitbit OAuth tokens: load, refresh, persist.
//!
//! Port of `src/fitbit/token-manager.ts`.
//!
//! # The refresh must be serialised per user, and here that is a lock
//!
//! The TypeScript holds a `Map<userId, {tokens, refreshPromise}>` and hands the
//! in-flight promise to every concurrent caller, so N requests crossing the
//! expiry boundary produce ONE POST to `/oauth2/token`. That matters for more
//! than round-trips: Fitbit ROTATES the refresh token, so two simultaneous
//! refreshes race and the loser persists a token that is already dead.
//!
//! Rust gets the same guarantee from a per-user `Mutex` held across the refresh.
//! Simpler than the promise-sharing dance and stronger: the second caller waits
//! and then re-reads the cache, so it uses the winner's token rather than
//! issuing its own request.
//!
//! ⚠ The TypeScript's own comment says this bug is LATENT — `sync.ts` calls per
//! user sequentially today. It is preserved anyway because the port is not the
//! place to decide that a guard was unnecessary.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::MySqlPool;
use tokio::sync::Mutex;

use crate::lean;

// ⚠ THE SKEW AND THE DEFAULT EXPIRY ARE NOT HERE ANY MORE. Both live in
// `Verified/Token.lean` with their boundaries guarded, because both decide
// whether a token is usable and a wrong answer is invisible until a request
// fails with it.

#[derive(Debug, Clone)]
pub struct FitbitTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Active,
    NeedsReauth,
    NotLinked,
}

impl ConnectionStatus {
    /// The wire spelling `/api/me` already returns. The frontend reads these
    /// strings, so they are not the port's to rename.
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionStatus::Active => "active",
            ConnectionStatus::NeedsReauth => "needs_reauth",
            ConnectionStatus::NotLinked => "not_linked",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("Fitbit not linked")]
    NotLinked,

    /// The refresh token is dead — invalid, expired, revoked or throttled. The
    /// DB status is flipped so `/api/me` surfaces it; the user must relink.
    #[error("Fitbit refresh rejected ({status}): {body}")]
    ReauthRequired { status: u16, body: String },

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// One user's cached tokens, behind the lock that serialises their refresh.
/// `None` means "not loaded yet", not "not linked" — the DB says which.
type UserSlot = Arc<Mutex<Option<FitbitTokens>>>;

/// Per-user token cache with a refresh lock.
#[derive(Clone, Default)]
pub struct TokenStore {
    inner: Arc<Mutex<HashMap<String, UserSlot>>>,
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// The per-user slot, created on first use. The outer lock is held only long
    /// enough to hand out the inner one, so one user's refresh never blocks
    /// another's.
    async fn slot(&self, user_id: &str) -> UserSlot {
        let mut map = self.inner.lock().await;
        map.entry(user_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }

    /// Drop a user's cached tokens — after a relink, where the DB row has moved
    /// under us.
    pub async fn invalidate(&self, user_id: &str) {
        if let Some(slot) = self.inner.lock().await.get(user_id) {
            *slot.lock().await = None;
        }
    }

    /// A valid access token, refreshing if it is within the skew of expiry.
    ///
    /// The lock spans the whole check-and-refresh, so a second caller arriving
    /// mid-refresh waits and then sees the fresh token rather than starting a
    /// second rotation.
    pub async fn get_valid(
        &self,
        pool: &MySqlPool,
        http: &reqwest::Client,
        user_id: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<FitbitTokens, TokenError> {
        let slot = self.slot(user_id).await;
        let mut held = slot.lock().await;

        if held.is_none() {
            *held = Some(load_from_db(pool, user_id).await?);
        }
        let current = held.as_ref().expect("just loaded").clone();

        if !lean::token_needs_refresh(
            Utc::now().timestamp_millis(),
            current.expires_at.timestamp_millis(),
        )? {
            return Ok(current);
        }

        let refreshed = refresh(pool, http, user_id, &current, client_id, client_secret).await?;
        *held = Some(refreshed.clone());
        Ok(refreshed)
    }
}

async fn load_from_db(pool: &MySqlPool, user_id: &str) -> Result<FitbitTokens, TokenError> {
    let row: Option<(String, String, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT access_token, refresh_token, expires_at, status FROM tokens WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .context("reading fitbit tokens")?;

    let (access_token, refresh_token, expires_at, status) = row.ok_or(TokenError::NotLinked)?;
    if status == "needs_reauth" {
        return Err(TokenError::ReauthRequired {
            status: 0,
            body: "stored: needs_reauth".to_string(),
        });
    }
    Ok(FitbitTokens {
        access_token,
        refresh_token,
        expires_at,
    })
}

async fn refresh(
    pool: &MySqlPool,
    http: &reqwest::Client,
    user_id: &str,
    current: &FitbitTokens,
    client_id: &str,
    client_secret: &str,
) -> Result<FitbitTokens, TokenError> {
    let res = http
        .post("https://api.fitbit.com/oauth2/token")
        .basic_auth(client_id, Some(client_secret))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh_token.as_str()),
        ])
        .send()
        .await
        .context("posting fitbit token refresh")?;

    let status = res.status();
    let body = res.text().await.context("reading refresh response")?;

    // ⚠ THE CLASSIFICATION IS LEAN'S, not `status.is_client_error()`. 4xx flips
    // a DURABLE, user-visible flag: `/api/me` surfaces `needs_reauth` and the
    // sync stops until somebody re-links by hand. 5xx is Fitbit having a bad
    // minute, and 3xx is neither — `res.ok` covers 200–299 only, so the
    // TypeScript falls through a redirect to its generic throw. All three
    // boundaries are guarded in `Verified/Token.lean`.
    match lean::classify_refresh_status(status.as_u16())? {
        lean::RefreshOutcome::Rotated => {}
        lean::RefreshOutcome::ReauthRequired => {
            mark_reauth_required(pool, user_id).await?;
            return Err(TokenError::ReauthRequired {
                status: status.as_u16(),
                body,
            });
        }
        lean::RefreshOutcome::Transient => {
            return Err(TokenError::Other(anyhow::anyhow!(
                "Fitbit token refresh failed: {status} {body}"
            )));
        }
    }

    #[derive(serde::Deserialize)]
    struct RefreshBody {
        access_token: String,
        refresh_token: String,
        expires_in: Option<i64>,
    }
    let data: RefreshBody =
        serde_json::from_str(&body).context("parsing fitbit refresh response")?;
    // The expiry, and the eight-hour default when Fitbit omits `expires_in`,
    // are Lean's too — a wrong default hands out a token already past its life.
    let expires_at_ms = lean::expiry_from_now(Utc::now().timestamp_millis(), data.expires_in)?;
    let expires_at = DateTime::from_timestamp_millis(expires_at_ms)
        .ok_or_else(|| anyhow::anyhow!("refresh expiry out of range: {expires_at_ms}"))?;
    let tokens = FitbitTokens {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at,
    };
    persist(pool, user_id, &tokens).await?;
    tracing::info!("Fitbit token refreshed for user={user_id} (expires {expires_at})");
    Ok(tokens)
}

async fn persist(pool: &MySqlPool, user_id: &str, t: &FitbitTokens) -> Result<()> {
    sqlx::query(
        "UPDATE tokens SET access_token = ?, refresh_token = ?, expires_at = ?, status = 'active' \
         WHERE user_id = ?",
    )
    .bind(&t.access_token)
    .bind(&t.refresh_token)
    .bind(t.expires_at)
    .bind(user_id)
    .execute(pool)
    .await
    .context("persisting refreshed fitbit tokens")?;
    Ok(())
}

async fn mark_reauth_required(pool: &MySqlPool, user_id: &str) -> Result<()> {
    sqlx::query("UPDATE tokens SET status = 'needs_reauth' WHERE user_id = ?")
        .bind(user_id)
        .execute(pool)
        .await
        .context("marking fitbit reauth required")?;
    Ok(())
}

/// What `/api/me` reports about a user's Fitbit link.
pub async fn connection_status(pool: &MySqlPool, user_id: &str) -> Result<ConnectionStatus> {
    let row: Option<(String,)> = sqlx::query_as("SELECT status FROM tokens WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .context("reading fitbit connection status")?;
    Ok(match row {
        None => ConnectionStatus::NotLinked,
        Some((s,)) if s == "needs_reauth" => ConnectionStatus::NeedsReauth,
        Some(_) => ConnectionStatus::Active,
    })
}
