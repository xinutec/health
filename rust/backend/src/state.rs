//! Shared application state, kept thin. The velocity cache is process-local:
//! a deploy restart is its invalidation (see `crate::velocity_cache`).

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
    /// The raw tail buffer per user, for ten seconds. Held whole and filtered
    /// per request: `since` differs between callers, so caching the filtered
    /// answer would key on it and defeat the point.
    pub tail_points:
        Arc<crate::location_cache::LocationCache<Vec<crate::location_cache::TailPoint>>>,
    /// In-flight Nextcloud Login Flow v2 handshakes, one per user. Not
    /// persisted: the polling task dies with the process.
    pub flows: Arc<crate::routes::nextcloud_connect::PendingFlows>,
    /// Per-device Owntracks proxy state: recent fixes, last pushed profile,
    /// manual-hold deadline.
    pub owntracks: Arc<crate::routes::owntracks::ProxyState>,
    /// When this process started, for `/health?detail=1`: process uptime, not
    /// pod age, which explains a vanished session after a container restart.
    pub started: std::time::Instant,
    /// One client, reused: every outbound call is bounded, so a hung Nextcloud
    /// cannot tie up the pod, and the connection pool survives across requests.
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
            owntracks: Arc::new(crate::routes::owntracks::ProxyState::new()),
            started: std::time::Instant::now(),
        }
    }
}
