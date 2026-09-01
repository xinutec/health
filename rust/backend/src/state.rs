//! Shared application state.
//!
//! Deliberately thin, and it should stay that way. The TypeScript server this
//! replaced kept a velocity cache and the Lean tenant mode overrides in
//! module-level mutables; neither belongs here:
//!
//!   * the tenant overrides (`setVerifiedCoreOverride`) existed ONLY to drive
//!     the TS↔Lean A/B, so they were scaffolding to retire with the TS arm
//!     (#975) rather than state to carry across. ⚠ THAT RETIREMENT HAPPENED
//!     (2026-08-26) and this sentence stayed in the future tense until
//!     2026-09-01; the symbol survives nowhere but in this comment.
//!   * the velocity cache DID need a home, and this is it (#982). It is
//!     process-local on purpose: a deploy restarts the pod and that is the
//!     invalidation, which is why there is no version tag and no clear hook.
//!     `crate::velocity_cache` carries the note about what would have to come
//!     back if anything ever changed an answer without a restart.

use std::sync::Arc;

use sqlx::MySqlPool;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: MySqlPool,
    pub cfg: Arc<Config>,
    /// Computed days, keyed by `(user, date, tz, walkMatch)`. Shared across
    /// requests — that is the whole point, and it is why the single-flight in
    /// there matters.
    pub velocity: Arc<crate::velocity_cache::VelocityCache>,
    /// The freshest PhoneTrack fix per user, for ten seconds.
    pub latest_fix:
        Arc<crate::location_cache::LocationCache<Option<crate::location_cache::LatestFix>>>,
    /// The raw tail buffer per user, for ten seconds. Held WHOLE and filtered
    /// per request: `since` differs between callers, so caching the filtered
    /// answer would key on it and defeat the point.
    pub tail_points:
        Arc<crate::location_cache::LocationCache<Vec<crate::location_cache::TailPoint>>>,
    /// One client, reused. Every outbound call is bounded — a hung Nextcloud or
    /// Fitbit must not tie up a pod, and a per-call client would also throw away
    /// the connection pool on every request.
    /// In-flight Nextcloud Login Flow v2 handshakes, one per user.
    ///
    /// ⚠ Process-local and deliberately not persisted: a flow is meaningless
    /// across a restart, since the task polling for it is gone. A stored
    /// "pending" would be a lie nobody could clear.
    pub flows: Arc<crate::routes::nextcloud_connect::PendingFlows>,
    /// In-flight Fitbit OAuth handshakes: state token → (user, PKCE verifier).
    ///
    /// ⚠ Server-side, and single-use. The verifier must never reach the browser
    /// — PKCE exists so that whoever redeems the code proves they started the
    /// flow.
    pub oauth_states: Arc<crate::location_cache::LocationCache<(String, String)>>,
    /// Per-device Owntracks proxy state: recent fixes, last pushed profile,
    /// manual-hold deadline.
    pub owntracks: Arc<crate::routes::owntracks::ProxyState>,
    /// When this process started, for `/health?detail=1`'s uptime.
    ///
    /// ⚠ Process uptime, NOT pod age. They differ after a container restart
    /// inside the same pod, and the one that explains "why did my session
    /// vanish" is this one.
    pub started: std::time::Instant,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(pool: MySqlPool, cfg: Config, http: reqwest::Client) -> Self {
        Self {
            pool,
            cfg: Arc::new(cfg),
            http,
            velocity: Arc::new(crate::velocity_cache::VelocityCache::new()),
            latest_fix: Arc::new(crate::location_cache::LocationCache::new()),
            tail_points: Arc::new(crate::location_cache::LocationCache::new()),
            flows: Arc::new(crate::routes::nextcloud_connect::PendingFlows::new()),
            oauth_states: Arc::new(crate::location_cache::LocationCache::new()),
            owntracks: Arc::new(crate::routes::owntracks::ProxyState::new()),
            started: std::time::Instant::now(),
        }
    }
}
