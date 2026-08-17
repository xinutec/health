//! Shared application state.
//!
//! Deliberately thin, and it should stay that way. `src/server.ts` keeps a
//! velocity cache and the Lean tenant mode overrides in module-level mutables;
//! neither belongs here:
//!
//!   * the tenant overrides (`setVerifiedCoreOverride`) exist ONLY to drive the
//!     TS↔Lean A/B, so they are scaffolding that is retired with the TS arm
//!     (#975), not state to carry across.
//!   * the velocity cache is a real optimisation and will need a home, but it
//!     is keyed on a computation that now happens in Lean, so where it lives is
//!     a decision for when that route moves rather than now.

use std::sync::Arc;

use sqlx::MySqlPool;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    pub cfg: Arc<Config>,
    /// One client, reused. Every outbound call is bounded — a hung Nextcloud or
    /// Fitbit must not tie up a pod, and a per-call client would also throw away
    /// the connection pool on every request.
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(pool: MySqlPool, cfg: Config, http: reqwest::Client) -> Self {
        Self {
            pool,
            cfg: Arc::new(cfg),
            http,
        }
    }
}
