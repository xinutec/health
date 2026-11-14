//! Google OAuth 2.0: a stored refresh token, obtained once by consent, mints
//! short-lived access tokens server-side. Google does not rotate the refresh
//! token, so concurrent refreshes are merely wasteful: no lock, cache or
//! persistence.

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
    /// Read the credentials, or `None` unless all three are set and non-empty:
    /// the weight sync is inert without Google, and an empty secret would come
    /// back as a 400 that reads like a revoked grant.
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

    // Both conditions: Google can answer 200 without `access_token`, and an
    // empty bearer would fail later as a 401 that reads like a revoked grant.
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
