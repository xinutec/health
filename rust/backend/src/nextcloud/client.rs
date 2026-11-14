//! Thin Nextcloud HTTP client: Basic Auth with the stored app password, plus
//! the `OCS-APIRequest` header OCS endpoints require. It binds one user's
//! credentials, resolved once, so [`super::phonetrack`] can page a multi-week
//! walk without re-reading them.

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
    /// Resolve the user's credentials and bind a client to them; fails with
    /// [`NcError::NotLinked`] or [`NcError::ReauthRequired`] before any HTTP.
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

    /// GET a path and return the raw body. `pool` is per call, to flag the row
    /// on a 401. An empty body is `Ok(None)`: PhoneTrack answers 200 with nothing.
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

    /// PUT a JSON body, for PhoneTrack preference writes. A 401 flags the row as
    /// on reads, so a revoked password prompts a relink.
    pub async fn put(
        &self,
        pool: &MySqlPool,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<Option<String>, NcError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };

        let res = self
            .http
            .put(&url)
            .basic_auth(&self.creds.login_name, Some(&self.creds.app_password))
            .header("OCS-APIRequest", "true")
            .json(body)
            .send()
            .await
            .with_context(|| format!("PUT {path}"))?;

        let status = res.status();
        if status.as_u16() == 401 {
            if let Err(e) = credentials::mark_needs_reauth(pool, &self.user_id).await {
                tracing::warn!("could not flag {} needs_reauth: {e:#}", self.user_id);
            }
            return Err(NcError::ReauthRequired);
        }

        let body_text = res
            .text()
            .await
            .with_context(|| format!("body of PUT {path}"))?;
        if !status.is_success() {
            return Err(NcError::Api {
                method: "PUT",
                path: path.to_string(),
                status: status.as_u16(),
                body: body_text,
            });
        }
        Ok(if body_text.is_empty() {
            None
        } else {
            Some(body_text)
        })
    }
}
