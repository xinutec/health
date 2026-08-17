//! Google OAuth 2.0: a stored refresh token for a short-lived access token.
//!
//! Port of `src/google/oauth.ts`.
//!
//! The refresh token is obtained once through user consent and stored as a
//! secret; this mints access tokens server-side with no phone in the loop.
//!
//! # ⚠ Google does NOT rotate the refresh token, and Fitbit does
//!
//! So this needs none of [`crate::fitbit::tokens`]'s machinery — no per-user
//! mutex, no cached expiry, no persistence. Two concurrent refreshes here are
//! merely wasteful; the same two against Fitbit leave one caller holding a token
//! that is already dead. Copying that structure over would suggest a hazard that
//! does not exist here.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;

/// The three secrets a refresh needs.
#[derive(Debug, Clone)]
pub struct GoogleCreds {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
}

impl GoogleCreds {
    /// Read the credentials, or `None` when Google is not configured.
    ///
    /// ⚠ `None` rather than an error, and ALL THREE are required together. The
    /// weight sync is inert without them by design — the sync job runs on hosts
    /// where Google is not set up — but a PARTIAL set is a misconfiguration
    /// rather than a choice, and returning `Some` with an empty secret would
    /// turn it into a 400 from Google that reads like a revoked grant.
    pub fn from_env() -> Option<Self> {
        let get = |k: &str| match std::env::var(k) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        };
        Some(GoogleCreds {
            client_id: get("GH_CLIENT_ID")?,
            client_secret: get("GH_CLIENT_SECRET")?,
            refresh_token: get("GH_REFRESH_TOKEN")?,
        })
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Exchange the refresh token for an access token.
pub async fn access_token(http: &reqwest::Client, creds: &GoogleCreds) -> Result<String> {
    let res = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", creds.refresh_token.as_str()),
        ])
        .send()
        .await
        .context("POST oauth2.googleapis.com/token")?;

    let status = res.status();
    let body = res.text().await.context("body of the token response")?;
    let parsed: TokenResponse =
        serde_json::from_str(&body).context("decoding the token response")?;

    // ⚠ BOTH conditions, as the TypeScript does. Google can answer 200 with no
    // `access_token` on some error shapes, and taking the status alone would
    // hand an empty bearer to the next request — which fails as a 401 and reads
    // like a revoked grant rather than a malformed token response.
    match parsed.access_token {
        Some(t) if status.is_success() && !t.is_empty() => Ok(t),
        _ => Err(anyhow!(
            "google token {}: {} {}",
            status.as_u16(),
            parsed.error.unwrap_or_default(),
            parsed.error_description.unwrap_or_default()
        )),
    }
}
