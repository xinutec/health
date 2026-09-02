//! The sync run: what `dist/sync.js` does, per user, top to bottom.
//!
//! Port of the module body of `src/sync.ts`. Every stream fetcher, both
//! backfill walks and the rate-limit policy already exist; this is the order
//! they happen in and the error handling between them.
//!
//! # Two passes, and they use DIFFERENT timezone sources
//!
//! The forward pass syncs `[cursor, today]` with a real [`ForwardTzSource`]
//! built from PhoneTrack fixes and the Fitbit profile zone, so its rows land
//! with a `tz` and a `ts_utc`. The backward backfill uses [`sync::null_tz`] and
//! writes `tz=NULL` for the Phase 3 backfill CLI to fill in later.
//!
//! ⚠ That asymmetry is deliberate and must not be tidied away. The backfill
//! walks years; the PhoneTrack history that would place those days does not
//! reach back that far, so inferring from the fixes that DO exist would stamp
//! 2019 with where the phone was last week. A NULL says "not known", which is
//! recoverable. A wrong zone in a column declared to hold one is not.
//!
//! # What a failure means at each level, from narrowest to widest
//!
//!   * One stream throws → logged, the run continues. Fitbit degrades one
//!     endpoint at a time and a 500 on SpO2 is no reason to skip sleep.
//!   * The budget is exhausted → the whole user stops, and the process still
//!     exits 0. This is the EXPECTED ending of a deep backfill: the cursors are
//!     parked where they stopped and the next tick resumes there.
//!   * One user throws anything else → logged, the next user runs.
//!
//! ⚠ The exhausted case must NOT be caught per stream. It means the budget for
//! the run is gone, so every remaining stream would hit the same wall — and
//! swallowing it would let the backfill walk advance cursors past days nothing
//! fetched. [`try_stream`] re-raises it and only it.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

use super::backfill_runner::{
    self, DEFAULT_MAX_EMPTY_DAYS, DEFAULT_MAX_EMPTY_WINDOWS, DayStream, RangeStream,
};
use super::client::{FitbitClient, FitbitError, RateLimitState};
use super::rate_limit::RateLimitExhausted;
use super::sync::{self, MAX_RANGE_DAYS, TzSource};
use super::tokens::TokenStore;
use super::tz_source::{Fix, ForwardTzSource, Lookup};
use crate::backfill::DayResult;
use crate::lean;
use crate::sync_state;

/// Which passes a run performs.
///
/// # The two halves carry VERY different risk, and that is the whole reason
/// this is a choice rather than always [`Passes::All`]
///
/// [`Passes::Forward`] writes idempotent upserts over a window the live cron
/// has just written, and touches one piece of shared state: `last_sync_date`.
/// That cursor SELF-HEALS — [`crate::lean::forward_window`] always reaches back
/// `SYNC_OVERLAP_DAYS`, so even a wrongly-advanced one is re-covered on the next
/// tick. Nothing it does is hard to undo, which makes it safe to run beside the
/// scheduled job for comparison.
///
/// ⚠ The backfill is not like that, and the danger is NOT the row writes. It is
/// `backfill_<stream>_complete`: durable, never revisited, and a wrongly-set one
/// stops history being filled with no symptom at all. A run that sets one
/// wrongly looks exactly like a run that finished its work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Passes {
    /// Forward only. Stops before ANY backfill state is read or written —
    /// including the legacy-key migration, which writes under the same prefix.
    Forward,
    /// Forward, then both backward walks. What the scheduled job does.
    All,
}

/// Run one sync over every linked user.
///
/// Returns `Ok(())` when the run finished OR when the budget ran out — both are
/// healthy endings for a scheduled job. It fails only when something structural
/// did: the user list could not be read, or Lean could not answer.
pub async fn run(
    pool: &MySqlPool,
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    nextcloud_base_url: Option<&str>,
    lookup: Lookup<'_>,
    passes: Passes,
) -> Result<()> {
    let users: Vec<(String,)> = sqlx::query_as("SELECT user_id FROM tokens")
        .fetch_all(pool)
        .await
        .context("listing users with Fitbit tokens")?;

    if users.is_empty() {
        tracing::info!("No users with Fitbit tokens. Authorize via /fitbit/auth first.");
        return Ok(());
    }
    tracing::info!("Found {} user(s) with Fitbit tokens", users.len());

    google_weight(pool, http).await;
    google_streams(pool, http).await;

    // ⚠ ONE client and ONE token store for the whole run, not one per user. The
    // Fitbit budget is charged against the APPLICATION, so a per-user client
    // would give each user a fresh optimistic 150 and the second user would
    // spend a budget the first had already used.
    let client = FitbitClient::new(http.clone(), RateLimitState::default());
    let tokens = TokenStore::new();

    // Said once, loudly, because the difference is invisible in the per-stream
    // output that follows: a forward-only run looks like a complete one that
    // happened to have nothing left to backfill.
    match passes {
        Passes::Forward => {
            tracing::info!("FORWARD PASS ONLY — no backfill state will be read or written")
        }
        Passes::All => tracing::info!("forward pass, then both backward walks"),
    }

    for (user_id,) in users {
        tracing::info!("=== Syncing: {user_id} ===");
        match sync_one_user(
            pool,
            &client,
            &tokens,
            http,
            client_id,
            client_secret,
            nextcloud_base_url,
            lookup,
            &user_id,
            passes,
        )
        .await
        {
            Ok(()) => tracing::info!(
                "[{user_id}] Done. Rate limit remaining: {}",
                client.rate.remaining()
            ),
            Err(e) => match e.downcast_ref::<RateLimitExhausted>() {
                // Expected, not a fault. Whatever was fetched is committed and
                // every cursor is parked; the next tick picks up exactly there.
                Some(r) => tracing::info!(
                    "[{user_id}] Rate budget spent for this run; resumes in ~{}s",
                    r.resume_in_sec
                ),
                None => tracing::error!("[{user_id}] Sync failed: {e:#}"),
            },
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn sync_one_user(
    pool: &MySqlPool,
    client: &FitbitClient,
    tokens: &TokenStore,
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    nextcloud_base_url: Option<&str>,
    lookup: Lookup<'_>,
    user_id: &str,
    passes: Passes,
) -> Result<()> {
    let token = tokens
        .get_valid(pool, http, user_id, client_id, client_secret)
        .await?;
    let access = token.access_token.as_str();

    // ⚠ `today` is computed ONCE and threaded through both passes. Reading the
    // clock again per stream would let a run that straddles midnight sync
    // different windows for different streams and then store a cursor that
    // matches none of them.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let stored = sync_state::get(pool, user_id, "last_sync_date").await?;
    let (window_start, window_end) = lean::forward_window(&today, stored.as_deref())?
        .ok_or_else(|| anyhow::anyhow!("could not derive a forward window from {today:?}"))?;

    tracing::info!("[{user_id}] Forward sync: {window_start} → {window_end}");

    let tz = build_tz_source(
        pool,
        client,
        http,
        access,
        nextcloud_base_url,
        lookup,
        user_id,
        &window_start,
        &window_end,
    )
    .await;
    let tz_for: TzSource<'_> = match &tz {
        Some(source) => &|date, time| source.for_wall_clock(date, time),
        None => &sync::null_tz,
    };

    forward_pass(
        pool,
        client,
        access,
        user_id,
        &window_start,
        &window_end,
        tz_for,
    )
    .await?;

    // ⚠ ONLY after the forward pass returned. The cursor is a claim that
    // everything up to `window_end` has been fetched, and writing it before the
    // fetches would turn a mid-pass exhaustion into permanently skipped days.
    sync_state::set(pool, user_id, "last_sync_date", &window_end).await?;
    tracing::info!(
        "[{user_id}] Forward sync done. Rate limit: {}",
        client.rate.remaining()
    );

    // ⚠ The return is BEFORE the legacy-key migration, not just before the
    // walks. That migration writes `backfill_hr_intraday_*`, so returning after
    // it would make "forward only" false in exactly the namespace the promise
    // is about.
    if passes == Passes::Forward {
        tracing::info!("[{user_id}] forward pass complete; backfill skipped by request");
        return Ok(());
    }

    migrate_legacy_backfill_keys(pool, user_id).await?;
    backfill_pass(pool, client, access, user_id, &window_start).await
}

/// Reconcile weight against Google Health, if it is configured.
///
/// # Why it runs FIRST, and why it cannot fail the run
///
/// It shares nothing with the Fitbit passes — no token, no rate budget, no
/// cursor — and the whole job is one page plus ~150 idempotent row writes. So it
/// goes first, where a spent Fitbit budget cannot starve it: the deep backfill
/// can consume the hour, and weight would then never be reconciled on a busy
/// day. Matching `sync.ts`, which puts it above the user loop for the same
/// reason.
///
/// ⚠ INERT without `GH_CLIENT_ID` / `GH_CLIENT_SECRET` / `GH_REFRESH_TOKEN` and
/// `GH_USER_ID`, and that silence is deliberate — the sync runs on hosts where
/// Google is not set up. It is logged at DEBUG rather than WARN so it does not
/// cry wolf, which does mean a credential that goes missing looks like a host
/// that never had one.
/// The streams `google::source` says Google owns, beyond weight.
///
/// ⚠ FAILS SOFT, like `google_weight`. Google being unreachable must not take
/// down the Fitbit streams that still run in the same job — those are the ones
/// with a September deadline, and losing a night of them to an unrelated outage
/// is the worse trade.
///
/// ⚠ The user is the one Google is configured for, not every Fitbit user.
/// `GH_USER_ID` names it, and there is exactly one.
async fn google_streams(pool: &MySqlPool, http: &reqwest::Client) {
    let (Some(creds), Ok(user_id)) = (
        crate::google::oauth::GoogleCreds::from_env(),
        std::env::var("GH_USER_ID"),
    ) else {
        tracing::debug!("google streams: not configured, skipping");
        return;
    };
    let token = match crate::google::oauth::access_token(http, &creds).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("google streams: no access token: {e:#}");
            return;
        }
    };
    if !crate::google::source::fitbit_still_owns("breathing_rate") {
        match crate::google::sync::sync_breathing_rate(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google breathing_rate: {n} day(s)"),
            Err(e) => tracing::error!("[{user_id}] google breathing_rate failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("hrv_daily") {
        match crate::google::sync::sync_hrv_daily(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google hrv_daily: {n} day(s)"),
            Err(e) => tracing::error!("[{user_id}] google hrv_daily failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("skin_temperature") {
        match crate::google::sync::sync_skin_temperature(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google skin_temperature: {n} night(s)"),
            Err(e) => tracing::error!("[{user_id}] google skin_temperature failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("spo2_daily") {
        match crate::google::sync::sync_spo2_daily(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google spo2_daily: {n} day(s)"),
            Err(e) => tracing::error!("[{user_id}] google spo2_daily failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("heart_rate_intraday") {
        match crate::google::sync::sync_heart_rate_intraday(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google heart_rate_intraday: {n} sample(s)"),
            Err(e) => tracing::error!("[{user_id}] google heart_rate_intraday failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("sleep") {
        match crate::google::sync::sync_sleep(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google sleep: {n} session(s)"),
            Err(e) => tracing::error!("[{user_id}] google sleep failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("hrv_intraday") {
        match crate::google::sync::sync_hrv_intraday(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google hrv_intraday: {n} sample(s)"),
            Err(e) => tracing::error!("[{user_id}] google hrv_intraday failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("heart_rate_zones") {
        match crate::google::sync::sync_heart_rate_zones(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google heart_rate_zones: {n} row(s)"),
            Err(e) => tracing::error!("[{user_id}] google heart_rate_zones failed: {e:#}"),
        }
    }
    if !crate::google::source::fitbit_still_owns("steps_intraday") {
        match crate::google::sync::sync_steps_intraday(pool, http, &token, &user_id).await {
            Ok(n) => tracing::info!("[{user_id}] google steps_intraday: {n} minute(s)"),
            Err(e) => tracing::error!("[{user_id}] google steps_intraday failed: {e:#}"),
        }
    }
    // ⚠ NOT GATED ON THE ROSTER, and deliberately so. `daily_activity` is the
    // one table whose COLUMNS need different owners — Fitbit is the only source
    // there has ever been for `minutes_sedentary` and `active_score`, so
    // flipping the owner would switch those off while they still work. The
    // writer gates itself on a DATE instead, and the two never overlap.
    match crate::google::sync::sync_daily_activity(pool, http, &token, &user_id).await {
        Ok(n) => tracing::info!("[{user_id}] google daily_activity: {n} day(s)"),
        Err(e) => tracing::error!("[{user_id}] google daily_activity failed: {e:#}"),
    }
}

async fn google_weight(pool: &MySqlPool, http: &reqwest::Client) {
    let (Some(creds), Some(user_id)) = (
        crate::google::oauth::GoogleCreds::from_env(),
        std::env::var("GH_USER_ID").ok().filter(|s| !s.is_empty()),
    ) else {
        tracing::debug!("google weight: not configured, skipping");
        return;
    };

    match crate::google::body::run_google_weight_sync(pool, http, &creds, &user_id, true).await {
        Ok(r) => tracing::info!(
            "[{user_id}] google weight: {} weigh-in(s) over {} day(s), {} stale row(s) replaced, {} → {}",
            r.fetched,
            r.days,
            r.deleted_stale,
            r.earliest.as_deref().unwrap_or("-"),
            r.latest.as_deref().unwrap_or("-")
        ),
        // Logged, never propagated: weight has no bearing on whether the Fitbit
        // ingestion should run, and failing the whole job over it would stop
        // heart rate and sleep for a reason unrelated to either.
        Err(e) => tracing::error!("[{user_id}] google weight sync failed: {e:#}"),
    }
}

/// Run one stream, logging and continuing on anything but exhaustion.
async fn try_stream<F>(user_id: &str, name: &str, f: F) -> Result<()>
where
    F: Future<Output = Result<usize, FitbitError>>,
{
    match f.await {
        Ok(n) => {
            tracing::debug!("[{user_id}] {name}: {n} row(s)");
            Ok(())
        }
        // ⚠ The ONLY error that propagates. See the module header.
        Err(FitbitError::RateLimited(e)) => Err(e.into()),
        Err(e) => {
            tracing::error!("[{user_id}] {name} sync failed: {e:#}");
            Ok(())
        }
    }
}

async fn forward_pass(
    pool: &MySqlPool,
    client: &FitbitClient,
    access: &str,
    user_id: &str,
    start: &str,
    end: &str,
    tz_for: TzSource<'_>,
) -> Result<()> {
    // The per-day endpoints take an explicit list; the walk that builds it is
    // Lean's, so an unparseable bound refuses here rather than syncing zero days
    // and reporting success.
    let dates = lean::date_range_inclusive(start, end, MAX_RANGE_DAYS)?;

    try_stream(user_id, "devices", async {
        sync::daily::sync_devices(client, pool, access, user_id).await
    })
    .await?;
    try_stream(user_id, "activity", async {
        sync::activity::sync_activity(client, pool, access, user_id, &dates).await
    })
    .await?;
    if crate::google::source::fitbit_still_owns("sleep") {
        try_stream(user_id, "sleep", async {
            sync::sleep::sync_sleep(client, pool, access, user_id, start, end, tz_for).await
        })
        .await?;
    }
    if crate::google::source::fitbit_still_owns("heart_rate_zones") {
        try_stream(user_id, "HR zones", async {
            sync::heartrate::sync_heart_rate_zones(client, pool, access, user_id, start, end).await
        })
        .await?;
    }
    // ⚠ WEIGHT IS ABSENT ON PURPOSE. Fitbit's weight feed is forward-filled and
    // froze in Apr 2026 — the real values come from the Google Health API now
    // (#260). Re-adding `sync_body` here would clobber them nightly with
    // Fitbit's stale carry-forward. `sync::body` exists for the Google path and
    // for a historical re-read, not for this pass.
    if crate::google::source::fitbit_still_owns("heart_rate_intraday") {
        try_stream(user_id, "HR intraday", async {
            sync::heartrate::sync_heart_rate_intraday(client, pool, access, user_id, &dates, tz_for)
                .await
        })
        .await?;
    }
    if crate::google::source::fitbit_still_owns("steps_intraday") {
        try_stream(user_id, "steps intraday", async {
            sync::steps::sync_steps_intraday(client, pool, access, user_id, &dates, tz_for).await
        })
        .await?;
    }
    if crate::google::source::fitbit_still_owns("spo2_daily") {
        try_stream(user_id, "SpO2", async {
            sync::daily::sync_spo2_daily(client, pool, access, user_id, start, end).await
        })
        .await?;
    }
    // ⚠ THE DAILY PAIR ONLY. `hrv_intraday` below is a SEPARATE stream with its
    // own roster entry, still owned by Fitbit — gating both here on one name
    // would switch off a stream Google has no writer for.
    if crate::google::source::fitbit_still_owns("hrv_daily") {
        try_stream(user_id, "HRV", async {
            sync::hrv::sync_hrv(client, pool, access, user_id, start, end).await
        })
        .await?;
    }
    if crate::google::source::fitbit_still_owns("hrv_intraday") {
        try_stream(user_id, "HRV intraday", async {
            sync::hrv::sync_hrv_intraday(client, pool, access, user_id, &dates).await
        })
        .await?;
    }
    // ⚠ THE ROSTER DECIDES, not this call site. `google::source` owns the
    // question of which API serves each stream; asking it here is what keeps
    // "where does breathing rate come from?" answerable from one list instead
    // of by finding every branch (#260).
    if crate::google::source::fitbit_still_owns("breathing_rate") {
        try_stream(user_id, "breathing", async {
            sync::daily::sync_breathing_rate(client, pool, access, user_id, start, end).await
        })
        .await?;
    }
    // ⚠ A WRAPPING `if`, NOT AN EARLY RETURN. Temperature is the last stream in
    // this pass today, so `return Ok(())` would read as equivalent — and would
    // silently skip whatever stream is appended after it once this one is
    // Google's. The gate must bound the call it guards, not the rest of the
    // function.
    if crate::google::source::fitbit_still_owns("skin_temperature") {
        try_stream(user_id, "temperature", async {
            sync::daily::sync_temperature(client, pool, access, user_id, start, end).await
        })
        .await?;
    }
    Ok(())
}

/// Whether `date` has any stored heart-rate row.
///
/// Both steps and HRV skip days this answers `false` for, and the two reasons
/// differ: steps because a day with no HR row is a day the tracker was off, HRV
/// because it only exists on days with a main sleep period, which always have
/// HR. Either way it converts an API call into an indexed lookup.
///
/// ⚠ A skip counts toward the empty streak. Without that a permanently-true
/// condition walks the cursor backward forever — see [`backfill_runner`].
async fn has_heart_rate(pool: &MySqlPool, user_id: &str, date: &str) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM heart_rate_intraday WHERE user_id = ? AND ts >= ? AND ts <= ? LIMIT 1",
    )
    .bind(user_id)
    .bind(format!("{date} 00:00:00"))
    .bind(format!("{date} 23:59:59"))
    .fetch_optional(pool)
    .await
    .context("probing for a stored heart-rate row")?;
    Ok(row.is_some())
}

async fn backfill_pass(
    pool: &MySqlPool,
    client: &FitbitClient,
    access: &str,
    user_id: &str,
    default_start: &str,
) -> Result<()> {
    // ⚠ Activity and sleep RIDE ALONG on heart rate's walk rather than having
    // cursors of their own. Their per-day fetch is cheap and they are only
    // meaningfully empty at the daily level, which HR's streak already
    // captures. A failure in either does NOT fail the day: the return value
    // that drives the streak is heart rate's alone, because that is the stream
    // whose emptiness means history has run out.
    // ⚠ NOT gated on the roster, unlike the forward pass, and deliberately so
    // for three reasons at once: this walk is the CURSOR DRIVER the sleep and
    // activity ride-alongs depend on; it touches only historical days, which
    // Google's writer (high-water mark forward) never will; and the two sources
    // were measured bit-identical (google-compare-intraday, 2026-09-02), so
    // even an overlap writes the same value. Gating it here would silently
    // stall the other two streams' backfill.
    let hr = DayStream {
        name: "hr_intraday".to_string(),
        max_empty_days: DEFAULT_MAX_EMPTY_DAYS,
        fetch: Box::new(move |date: String| {
            Box::pin(async move {
                let dates = [date.clone()];
                let result = day_result(
                    user_id,
                    "hr_intraday",
                    sync::heartrate::sync_heart_rate_intraday(
                        client,
                        pool,
                        access,
                        user_id,
                        &dates,
                        &sync::null_tz,
                    )
                    .await,
                )?;

                ride_along(user_id, &format!("backfill activity {date}"), async {
                    sync::activity::sync_activity(client, pool, access, user_id, &dates).await
                })
                .await?;
                ride_along(user_id, &format!("backfill sleep {date}"), async {
                    sync::sleep::sync_sleep(
                        client,
                        pool,
                        access,
                        user_id,
                        &date,
                        &date,
                        &sync::null_tz,
                    )
                    .await
                })
                .await?;

                Ok(result)
            })
        }),
        skip_if: None,
    };

    let steps = DayStream {
        name: "steps_intraday".to_string(),
        max_empty_days: DEFAULT_MAX_EMPTY_DAYS,
        fetch: Box::new(move |date: String| {
            Box::pin(async move {
                let dates = [date];
                day_result(
                    user_id,
                    "steps_intraday",
                    sync::steps::sync_steps_intraday(
                        client,
                        pool,
                        access,
                        user_id,
                        &dates,
                        &sync::null_tz,
                    )
                    .await,
                )
            })
        }),
        skip_if: Some(Box::new(move |date: String| {
            Box::pin(async move { has_heart_rate(pool, user_id, &date).await.map(|hit| !hit) })
        })),
    };

    let hrv = DayStream {
        name: "hrv_intraday".to_string(),
        max_empty_days: DEFAULT_MAX_EMPTY_DAYS,
        fetch: Box::new(move |date: String| {
            Box::pin(async move {
                let dates = [date];
                day_result(
                    user_id,
                    "hrv_intraday",
                    sync::hrv::sync_hrv_intraday(client, pool, access, user_id, &dates).await,
                )
            })
        }),
        skip_if: Some(Box::new(move |date: String| {
            Box::pin(async move { has_heart_rate(pool, user_id, &date).await.map(|hit| !hit) })
        })),
    };

    let day_streams = [hr, steps, hrv];
    let names: Vec<String> = day_streams.iter().map(|s| s.name.clone()).collect();
    for name in backfill_runner::order_streams(pool, user_id, &names, default_start).await? {
        let stream = day_streams
            .iter()
            .find(|s| s.name == name)
            .expect("order_streams returns the names it was given");
        backfill_runner::run_intraday_backfill(&client.rate, pool, user_id, stream, default_start)
            .await?;
    }

    // The daily summaries were only ever forward-synced, so their history starts
    // at the first forward sync. Each walks back in 30-day windows — one cheap
    // range call per window — under its own cursor, so each stops at its own
    // earliest data rather than at the shallowest stream's.
    //
    // ⚠ Weight is absent here for the same reason it is absent from the forward
    // pass: Fitbit's feed would overwrite the Google Health values (#260).
    let range_streams = [
        range_stream(user_id, "hrv", move |s: String, e: String| {
            Box::pin(async move {
                if !crate::google::source::fitbit_still_owns("hrv_daily") {
                    return Ok(0);
                }
                sync::hrv::sync_hrv(client, pool, access, user_id, &s, &e).await
            })
        }),
        // ⚠ The BACKFILL walk needs the same gate as the forward pass. Gating
        // one and not the other leaves a stream that stops arriving but keeps
        // being back-filled, which reads as an intermittent fault rather than a
        // source change.
        range_stream(user_id, "breathing", move |s: String, e: String| {
            Box::pin(async move {
                if !crate::google::source::fitbit_still_owns("breathing_rate") {
                    return Ok(0);
                }
                sync::daily::sync_breathing_rate(client, pool, access, user_id, &s, &e).await
            })
        }),
        range_stream(user_id, "spo2", move |s: String, e: String| {
            Box::pin(async move {
                if !crate::google::source::fitbit_still_owns("spo2_daily") {
                    return Ok(0);
                }
                sync::daily::sync_spo2_daily(client, pool, access, user_id, &s, &e).await
            })
        }),
        range_stream(user_id, "temperature", move |s: String, e: String| {
            Box::pin(async move {
                if !crate::google::source::fitbit_still_owns("skin_temperature") {
                    return Ok(0);
                }
                sync::daily::sync_temperature(client, pool, access, user_id, &s, &e).await
            })
        }),
        range_stream(user_id, "hr_zones", move |s: String, e: String| {
            Box::pin(async move {
                sync::heartrate::sync_heart_rate_zones(client, pool, access, user_id, &s, &e).await
            })
        }),
    ];
    let names: Vec<String> = range_streams.iter().map(|s| s.name.clone()).collect();
    for name in backfill_runner::order_streams(pool, user_id, &names, default_start).await? {
        let stream = range_streams
            .iter()
            .find(|s| s.name == name)
            .expect("order_streams returns the names it was given");
        backfill_runner::run_range_backfill(&client.rate, pool, user_id, stream, default_start)
            .await?;
    }
    Ok(())
}

/// One-time and idempotent: move the pre-2026-05-10 single-stream backfill keys
/// into the per-stream namespace they became.
///
/// The legacy `backfill_cursor` / `backfill_complete` drove what is now
/// `hr_intraday`, so that is where they land. ⚠ It only writes when the new key
/// is ABSENT: a later run must not drag a live cursor back to where the legacy
/// one stopped.
async fn migrate_legacy_backfill_keys(pool: &MySqlPool, user_id: &str) -> Result<()> {
    for (legacy, current) in [
        ("backfill_cursor", "backfill_hr_intraday_cursor"),
        ("backfill_complete", "backfill_hr_intraday_complete"),
    ] {
        let Some(value) = sync_state::get(pool, user_id, legacy).await? else {
            continue;
        };
        if sync_state::get(pool, user_id, current).await?.is_none() {
            tracing::info!("[{user_id}] adopting legacy {legacy} as {current}");
            sync_state::set(pool, user_id, current, &value).await?;
        }
    }
    Ok(())
}

/// Build the forward pass's timezone source, or `None` when there is no signal.
///
/// Two independent inputs, and losing either is survivable:
///   * PhoneTrack fixes place the phone in time — the good answer.
///   * The Fitbit profile zone is the fallback for any wall clock with no fix
///     within six hours.
///
/// `None` when BOTH are missing, which makes the forward pass write `tz=NULL`
/// exactly as the backfill does. That is the honest answer for a first link
/// where nothing is known yet.
#[allow(clippy::too_many_arguments)]
async fn build_tz_source<'a>(
    pool: &MySqlPool,
    client: &FitbitClient,
    http: &reqwest::Client,
    access: &str,
    nextcloud_base_url: Option<&str>,
    lookup: Lookup<'a>,
    user_id: &str,
    start: &str,
    end: &str,
) -> Option<ForwardTzSource<'a>> {
    let mut fixes: Vec<Fix> = Vec::new();
    if let Some(base) = nextcloud_base_url {
        match crate::nextcloud::phonetrack::PhoneTrack::open(http.clone(), pool, base, user_id)
            .await
        {
            Ok(pt) => match pt.fetch_span(pool, start, end).await {
                Ok(fetched) => {
                    // ⚠ NAMED, not swallowed. A non-zero count means the fix set
                    // is a subset of the window, so every zone inferred from it
                    // may fall back to the profile without anything looking
                    // wrong. See `nextcloud::phonetrack`'s header.
                    if fetched.failed_devices > 0 {
                        tracing::warn!(
                            "[{user_id}] tz inference is running on a PARTIAL fix set: \
                             {} of {} device(s) failed",
                            fetched.failed_devices,
                            pt.device_count()
                        );
                    }
                    fixes = fetched
                        .points
                        .into_iter()
                        .map(|p| Fix {
                            ts: p.ts,
                            lat: p.lat,
                            lon: p.lon,
                        })
                        .collect();
                }
                Err(e) => tracing::warn!(
                    "[{user_id}] PhoneTrack fetch for tz inference failed: {e:#}. \
                     Falling back to the profile zone."
                ),
            },
            Err(e) => tracing::warn!(
                "[{user_id}] PhoneTrack unavailable for tz inference: {e:#}. \
                 Falling back to the profile zone."
            ),
        }
    }

    let profile_tz = match client.get_json(access, "/1/user/-/profile.json").await {
        Ok(body) => serde_json::from_str::<ProfileResponse>(&body)
            .ok()
            .and_then(|p| p.user.timezone),
        Err(e) => {
            tracing::warn!(
                "[{user_id}] Fitbit profile fetch failed: {e:#}. \
                 Forward-sync rows may get tz=NULL."
            );
            None
        }
    };

    if fixes.is_empty() && profile_tz.is_none() {
        tracing::warn!("[{user_id}] no timezone signal at all — forward rows will carry tz=NULL");
        return None;
    }
    tracing::info!(
        "[{user_id}] tz source: {} fix(es), profile {}",
        fixes.len(),
        profile_tz.as_deref().unwrap_or("unknown")
    );
    Some(ForwardTzSource::new(fixes, profile_tz, lookup))
}

#[derive(serde::Deserialize)]
struct ProfileResponse {
    user: ProfileUser,
}

#[derive(serde::Deserialize)]
struct ProfileUser {
    timezone: Option<String>,
}

/// A range stream, with the boilerplate its five instances share.
fn range_stream<'a, F>(user_id: &'a str, name: &'a str, fetch: F) -> RangeStream<'a>
where
    F: Fn(
            String,
            String,
        )
            -> std::pin::Pin<Box<dyn Future<Output = Result<usize, FitbitError>> + Send + 'a>>
        + Send
        + Sync
        + 'a,
{
    RangeStream {
        name: name.to_string(),
        max_empty_windows: DEFAULT_MAX_EMPTY_WINDOWS,
        fetch: Box::new(move |s, e| {
            let fut = fetch(s, e);
            Box::pin(async move { day_result(user_id, name, fut.await) })
        }),
    }
}

/// Turn a fetcher's answer into the three-way outcome the walk needs.
///
/// ⚠ THE THREE CASES ARE NOT INTERCHANGEABLE, and collapsing any two is the bug
/// this whole shape exists to prevent:
///   * `Ok(n)` → the call succeeded. `n == 0` means the day is genuinely empty
///     and history may have run out.
///   * exhausted → the budget for the RUN is spent. Stop; resume next tick.
///   * anything else → THIS DAY failed. Logged, reported as
///     [`DayResult::Failed`], and the walk continues — a transient 5xx is not
///     evidence that history has ended, and fourteen of them in a row must not
///     mark the stream complete.
fn day_result(
    user_id: &str,
    name: &str,
    r: Result<usize, FitbitError>,
) -> Result<DayResult, RateLimitExhausted> {
    match r {
        Ok(points) => Ok(DayResult::Ok {
            points: points as u64,
        }),
        Err(FitbitError::RateLimited(e)) => Err(e),
        Err(e) => {
            tracing::error!("[{user_id}] backfill {name} failed: {e:#}");
            Ok(DayResult::Failed)
        }
    }
}

/// A stream that rides along on another's walk: its result does not drive the
/// streak, so only exhaustion needs to leave.
async fn ride_along(
    user_id: &str,
    name: &str,
    f: impl Future<Output = Result<usize, FitbitError>>,
) -> Result<(), RateLimitExhausted> {
    match f.await {
        Ok(_) => Ok(()),
        Err(FitbitError::RateLimited(e)) => Err(e),
        Err(e) => {
            tracing::error!("[{user_id}] {name} failed: {e:#}");
            Ok(())
        }
    }
}
