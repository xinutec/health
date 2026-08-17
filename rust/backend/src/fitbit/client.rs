//! Thin Fitbit HTTP client. Port of `src/fitbit/client.ts`.
//!
//! Token management lives in [`super::tokens`]; rate-limit state lives here
//! because it is a per-PROCESS concern, not a per-user one — the budget is
//! charged against the application, so two users' calls draw on the same pool.
//!
//! # `logId` is a 64-bit integer and JavaScript could not hold it
//!
//! Fitbit sleep-log ids are ~7e18, past the 2^53 a JS `Number` represents
//! exactly. `JSON.parse` rounded them silently, and the same id then serialised
//! differently down different mariadb driver paths — leaving `sleep.log_id` and
//! `sleep_stages.sleep_log_id` unequal for one logical record and breaking the
//! `/api/sleep/stages` join. The TypeScript works around it by textually
//! quoting `"logId":<digits>` before parsing and reviving to `BigInt`.
//!
//! ⚠ That workaround does NOT come across, and its absence is the fix. `serde`
//! deserialises into `i64` directly, so the integer is never approximated and
//! there is nothing to repair. Porting the regex would carry a scar from a
//! language this code no longer runs in.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result};

use super::rate_limit::{
    MAX_INPROCESS_WAIT_MS, RateLimitAction, RateLimitExhausted, decide_rate_limit_wait,
};

/// Fitbit's starting budget per hour.
const INITIAL_BUDGET: i64 = 150;

/// Retries of a 429 before bailing, matching the TypeScript.
const MAX_429_RETRIES: u32 = 3;

/// Per-process rate-limit state, shared by every client in the process.
#[derive(Clone)]
pub struct RateLimitState {
    remaining: Arc<AtomicI64>,
    /// Unix milliseconds at which the budget resets.
    reset_at_ms: Arc<AtomicI64>,
}

impl Default for RateLimitState {
    fn default() -> Self {
        Self {
            remaining: Arc::new(AtomicI64::new(INITIAL_BUDGET)),
            reset_at_ms: Arc::new(AtomicI64::new(0)),
        }
    }
}

impl RateLimitState {
    pub fn remaining(&self) -> i64 {
        self.remaining.load(Ordering::Relaxed)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FitbitError {
    #[error(transparent)]
    RateLimited(#[from] RateLimitExhausted),

    #[error(transparent)]
    Token(#[from] super::tokens::TokenError),

    #[error("Fitbit API {path}: {status} {body}")]
    Api {
        path: String,
        status: u16,
        body: String,
    },

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub struct FitbitClient {
    pub http: reqwest::Client,
    pub rate: RateLimitState,
}

impl FitbitClient {
    pub fn new(http: reqwest::Client, rate: RateLimitState) -> Self {
        Self { http, rate }
    }

    /// GET a Fitbit path, honouring the rate budget.
    ///
    /// `access_token` is passed in rather than fetched here: the client is
    /// per-process and tokens are per-user, and having the client reach for a
    /// user's token is how a per-process object quietly acquires a current user.
    pub async fn get_json(&self, access_token: &str, path: &str) -> Result<String, FitbitError> {
        let mut retries = 0u32;
        loop {
            self.wait_for_budget().await?;

            let url = if path.starts_with("http") {
                path.to_string()
            } else {
                format!("https://api.fitbit.com{path}")
            };
            let res = self
                .http
                .get(&url)
                .bearer_auth(access_token)
                .send()
                .await
                .with_context(|| format!("GET {path}"))?;

            self.update_budget(res.headers());
            let status = res.status();

            if status.as_u16() == 429 {
                let wait_sec: i64 = res
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(3600);
                // A real 429 means the budget is already spent. Ride out a short
                // retry-after, but once the wait would pass the in-process cap
                // (or after 3 tries) bail cleanly so the cron resumes next tick
                // rather than overrunning the job deadline.
                if retries >= MAX_429_RETRIES || wait_sec * 1000 > MAX_INPROCESS_WAIT_MS {
                    return Err(RateLimitExhausted {
                        resume_in_sec: wait_sec,
                    }
                    .into());
                }
                retries += 1;
                tracing::info!("Rate limited, waiting {wait_sec}s (retry {retries}/3)");
                tokio::time::sleep(std::time::Duration::from_secs(wait_sec as u64)).await;
                continue;
            }

            let body = res
                .text()
                .await
                .with_context(|| format!("body of {path}"))?;
            if !status.is_success() {
                return Err(FitbitError::Api {
                    path: path.to_string(),
                    status: status.as_u16(),
                    body,
                });
            }
            return Ok(body);
        }
    }

    async fn wait_for_budget(&self) -> Result<(), RateLimitExhausted> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let until_reset = self.rate.reset_at_ms.load(Ordering::Relaxed) - now_ms;
        match decide_rate_limit_wait(self.rate.remaining(), until_reset, MAX_INPROCESS_WAIT_MS) {
            RateLimitAction::Proceed => Ok(()),
            RateLimitAction::Exhausted { resume_in_sec } => {
                Err(RateLimitExhausted { resume_in_sec })
            }
            RateLimitAction::Sleep { ms } => {
                tracing::info!(
                    "Rate limit low ({}), waiting {}s",
                    self.rate.remaining(),
                    (ms + 999) / 1000
                );
                tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
                Ok(())
            }
        }
    }

    fn update_budget(&self, headers: &reqwest::header::HeaderMap) {
        let num = |k: &str| -> Option<i64> { headers.get(k)?.to_str().ok()?.trim().parse().ok() };
        if let Some(remaining) = num("fitbit-rate-limit-remaining") {
            self.rate.remaining.store(remaining, Ordering::Relaxed);
        }
        if let Some(reset_sec) = num("fitbit-rate-limit-reset") {
            self.rate.reset_at_ms.store(
                chrono::Utc::now().timestamp_millis() + reset_sec * 1000,
                Ordering::Relaxed,
            );
        }
    }
}
