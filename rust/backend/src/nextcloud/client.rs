//! Thin Nextcloud HTTP client. Port of `src/nextcloud/client.ts`.
//!
//! Basic Auth with the stored app password on every request, plus the
//! `OCS-APIRequest` header Nextcloud requires for its OCS endpoints.
//!
//! # It holds a user, unlike the Fitbit client
//!
//! [`crate::fitbit::client::FitbitClient`] is per-PROCESS and takes an access
//! token per call, because Fitbit's rate budget is charged against the
//! application and a client that reached for a user's token would quietly
//! acquire a current user. Nextcloud has no such shared budget and its
//! credentials are per-user by construction, so binding the user here is honest
//! rather than a shortcut — and it is what lets [`super::phonetrack`] resolve
//! the credentials ONCE for a multi-week walk instead of per chunk.

use anyhow::Context;
use sqlx::MySqlPool;

use super::credentials::{self, NcCredentials, NcError};

pub struct NextcloudClient {
    http: reqwest::Client,
    base_url: String,
    user_id: String,
    creds: NcCredentials,
}

impl NextcloudClient {
    /// Resolve the user's credentials and bind a client to them.
    ///
    /// Fails with [`NcError::NotLinked`] or [`NcError::ReauthRequired`] before
    /// any HTTP happens — the pre-flight the TypeScript's `openPhoneTrack` does
    /// explicitly, moved into construction so it cannot be skipped.
    pub async fn connect(
        http: reqwest::Client,
        pool: &MySqlPool,
        base_url: &str,
        user_id: &str,
    ) -> Result<Self, NcError> {
        let creds = credentials::get(pool, user_id).await?;
        Ok(Self {
            http,
            // A trailing slash would produce `//index.php`, which Nextcloud
            // serves but which breaks any later exact-match on the path.
            base_url: base_url.trim_end_matches('/').to_string(),
            user_id: user_id.to_string(),
            creds,
        })
    }

    /// GET a path and return the raw body.
    ///
    /// `pool` is taken per call and not held, solely so a 401 can flag the row.
    ///
    /// ⚠ An EMPTY body is `Ok(None)` and not a parse error. Several PhoneTrack
    /// endpoints answer 200 with nothing at all, and `serde_json` on `""` fails
    /// with a message about JSON that would send a reader looking for a
    /// malformed response that does not exist.
    pub async fn get(&self, pool: &MySqlPool, path: &str) -> Result<Option<String>, NcError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        let res = self
            .http
            .get(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("OCS-APIRequest", "true")
            .send()
            .await
            .with_context(|| format!("GET {path}"))?;

        let status = res.status();
        if status.as_u16() == 401 {
            // The app password was revoked in Nextcloud's Security settings, or
            // its user database no longer says yes. Durable state, not a
            // retryable blip — so it is recorded before the error is returned.
            if let Err(e) = credentials::mark_needs_reauth(pool, &self.user_id).await {
                tracing::warn!("could not flag {} needs_reauth: {e:#}", self.user_id);
            }
            return Err(NcError::ReauthRequired);
        }

        let body = res
            .text()
            .await
            .with_context(|| format!("body of GET {path}"))?;
        if !status.is_success() {
            return Err(NcError::Api {
                method: "GET",
                path: path.to_string(),
                status: status.as_u16(),
                body,
            });
        }
        Ok(if body.is_empty() { None } else { Some(body) })
    }

    /// GET and deserialise, treating an empty body as absent.
    pub async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        pool: &MySqlPool,
        path: &str,
    ) -> Result<Option<T>, NcError> {
        match self.get(pool, path).await? {
            None => Ok(None),
            Some(body) => {
                Ok(Some(serde_json::from_str(&body).with_context(|| {
                    format!("decoding the response to GET {path}")
                })?))
            }
        }
    }
}
