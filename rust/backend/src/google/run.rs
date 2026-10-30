//! The sync job's entry: weight, then every stream of the roster, for the one
//! user the Google account belongs to (`GH_USER_ID`).
//!
//! Every stream FAILS SOFT: one unreachable endpoint is logged and the rest
//! run. There is no cursor and no rate budget — each writer reads its own
//! high-water mark.
use sqlx::MySqlPool;

/// Run the whole ingestion once.
///
/// ⚠ INERT without `GH_CLIENT_ID` / `GH_CLIENT_SECRET` / `GH_REFRESH_TOKEN`
/// and `GH_USER_ID`, and that silence is deliberate — the sync runs on hosts
/// where Google is not set up. It is logged at DEBUG rather than WARN so it
/// does not cry wolf, which does mean a credential that goes missing looks
/// like a host that never had one.
pub async fn run(pool: &MySqlPool, http: &reqwest::Client) {
    weight(pool, http).await;
    streams(pool, http).await;
}

/// Reconcile weight against Google Health. One page plus ~150 idempotent row
/// writes; first, so nothing can starve it.
async fn weight(pool: &MySqlPool, http: &reqwest::Client) {
    let (Some(creds), Some(user_id)) = (
        super::oauth::GoogleCreds::from_env(),
        std::env::var("GH_USER_ID").ok().filter(|s| !s.is_empty()),
    ) else {
        tracing::debug!("google weight: not configured, skipping");
        return;
    };
    match super::body::run_google_weight_sync(pool, http, &creds, &user_id, true).await {
        Ok(r) => tracing::info!(
            "[{user_id}] google weight: {} weigh-in(s) over {} day(s), {} with body fat, {} stale row(s) replaced, {} → {}",
            r.fetched,
            r.days,
            r.fat_days,
            r.deleted_stale,
            r.earliest.as_deref().unwrap_or("-"),
            r.latest.as_deref().unwrap_or("-")
        ),
        Err(e) => tracing::error!("[{user_id}] google weight sync failed: {e:#}"),
    }
}

/// The streams of `source::STREAMS` beyond weight, in one pass.
async fn streams(pool: &MySqlPool, http: &reqwest::Client) {
    let (Some(creds), Ok(user_id)) = (
        super::oauth::GoogleCreds::from_env(),
        std::env::var("GH_USER_ID"),
    ) else {
        tracing::debug!("google streams: not configured, skipping");
        return;
    };
    let token = match super::oauth::access_token(http, &creds).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("google streams: no access token: {e:#}");
            return;
        }
    };
    match super::sync::sync_breathing_rate(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google breathing_rate: {n} day(s)"),
        Err(e) => tracing::error!("[{user_id}] google breathing_rate failed: {e:#}"),
    }
    match super::sync::sync_hrv_daily(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google hrv_daily: {n} day(s)"),
        Err(e) => tracing::error!("[{user_id}] google hrv_daily failed: {e:#}"),
    }
    match super::sync::sync_skin_temperature(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google skin_temperature: {n} night(s)"),
        Err(e) => tracing::error!("[{user_id}] google skin_temperature failed: {e:#}"),
    }
    match super::sync::sync_spo2_daily(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google spo2_daily: {n} day(s)"),
        Err(e) => tracing::error!("[{user_id}] google spo2_daily failed: {e:#}"),
    }
    match super::sync::sync_spo2_intraday(pool, http, &token, &user_id, None).await {
        Ok(n) => tracing::info!("[{user_id}] google spo2_intraday: {n} reading(s)"),
        Err(e) => tracing::error!("[{user_id}] google spo2_intraday failed: {e:#}"),
    }
    match super::exercise::sync_exercise(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google exercise_sessions: {n} session(s)"),
        Err(e) => tracing::error!("[{user_id}] google exercise_sessions failed: {e:#}"),
    }
    // The routes ride with the sessions: a GPS session with no stored track
    // is asked once (routes.rs).
    match super::routes::sync_routes(pool, http, &token, &user_id, None).await {
        Ok(s) if s.stored + s.refused == 0 => {}
        Ok(s) => tracing::info!(
            "[{user_id}] google exercise_routes: {} stored, {} refused",
            s.stored,
            s.refused
        ),
        Err(e) => tracing::error!("[{user_id}] google exercise_routes failed: {e:#}"),
    }
    for (data_type, _, _) in super::archive::ARCHIVE_TYPES {
        match super::archive::archive_points(pool, http, &token, &user_id, data_type, None).await {
            Ok((_, n)) => tracing::info!("[{user_id}] google_points {data_type}: {n} new"),
            Err(e) => tracing::error!("[{user_id}] google_points {data_type} failed: {e:#}"),
        }
    }
    match super::sync::sync_heart_rate_intraday(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google heart_rate_intraday: {n} sample(s)"),
        Err(e) => tracing::error!("[{user_id}] google heart_rate_intraday failed: {e:#}"),
    }
    match super::sync::sync_sleep(pool, http, &token, &user_id, None, false).await {
        Ok(n) => tracing::info!("[{user_id}] google sleep: {n} session(s)"),
        Err(e) => tracing::error!("[{user_id}] google sleep failed: {e:#}"),
    }
    match super::sync::sync_hrv_intraday(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google hrv_intraday: {n} sample(s)"),
        Err(e) => tracing::error!("[{user_id}] google hrv_intraday failed: {e:#}"),
    }
    match super::sync::sync_heart_rate_zones(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google heart_rate_zones: {n} row(s)"),
        Err(e) => tracing::error!("[{user_id}] google heart_rate_zones failed: {e:#}"),
    }
    match super::sync::sync_steps_intraday(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google steps_intraday: {n} minute(s)"),
        Err(e) => tracing::error!("[{user_id}] google steps_intraday failed: {e:#}"),
    }
    match super::sync::sync_paired_devices(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google paired devices: {n} battery reading(s)"),
        Err(e) => tracing::error!("[{user_id}] google paired devices failed: {e:#}"),
    }
    match super::sync::sync_daily_activity(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google daily_activity: {n} day(s)"),
        Err(e) => tracing::error!("[{user_id}] google daily_activity failed: {e:#}"),
    }
}
