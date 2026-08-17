//! The two backward walks. Port of `runIntradayBackfill` / `runRangeBackfill`
//! in `src/sync.ts`.
//!
//! # What is left here after Lean took the rules
//!
//! Both loops are now the same four lines: ask Lean what to do, do the IO it
//! named, fold the outcome into the streak, repeat. Every question that has a
//! right answer — fetch or stop, pause or complete, which day — is
//! `Verified.Backfill`, and everything here is the effect.
//!
//! That is worth saying plainly because the TypeScript's two loops are ~50
//! lines each and differ only in their unit, yet had drifted apart: one checked
//! the budget before the cursor, the other after, so a stream at the floor was
//! marked complete on one path and merely skipped on the other. Neither
//! behaviour was chosen. With the decision extracted the two are visibly the
//! same walk, and `Verified/Backfill.lean` records which reading won.
//!
//! # ⚠ `complete` is durable and `pause` is not
//!
//! `pause` writes nothing: the next scheduled run resumes from the same cursor.
//! `complete` sets `backfill_<stream>_complete`, and a stream that says it is
//! complete is never walked again until somebody clears that flag by hand. So a
//! FAILED decision must never be read as complete — the calls below propagate
//! rather than defaulting, for the same reason the rate-limit decision does.
//!
//! # The cursor advances even when a day fails, and that is deliberate
//!
//! A day whose fetch throws still moves the cursor past it. Otherwise a single
//! permanently-failing day is an infinite loop across every future run. What it
//! does NOT do is advance the empty streak — a transient 5xx is not evidence
//! that history has run out, and conflating the two once truncated a stream
//! after fourteen consecutive failures.

use std::future::Future;
use std::pin::Pin;

use anyhow::Result;
use sqlx::MySqlPool;

use crate::backfill::{DayResult, should_advance_empty_streak};
use crate::fitbit::client::FitbitClient;
use crate::fitbit::rate_limit::RateLimitExhausted;
use crate::lean::{self, BackfillStep, CompleteReason, RangeBackfillStep};
use crate::sync_state;

type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Earliest date any backfill may consider.
///
/// Fitbit's first consumer tracker shipped in 2008 and the API has no data for
/// anyone before 2010. Without a floor, a skip condition that always fires
/// walks the cursor backward indefinitely — which is how `-000026-02` reached
/// `sync_state`.
pub const BACKFILL_FLOOR_DATE: &str = "2010-01-01";

/// Consecutive empty days that mark an intraday stream complete.
pub const DEFAULT_MAX_EMPTY_DAYS: i64 = 14;

/// Consecutive empty windows that mark a range stream complete.
pub const DEFAULT_MAX_EMPTY_WINDOWS: i64 = 3;

/// The largest range Fitbit's daily-summary endpoints accept in one call.
pub const RANGE_WINDOW_DAYS: i64 = 30;

/// A stream the backfill walks one day at a time.
///
/// The closures are what the TypeScript's object literal held: `sync` fetches
/// one day and answers what happened to it, `skip_if` answers whether another
/// stream's stored data already proves the day empty. Boxed futures rather than
/// `async fn` in a trait because the orchestrator holds a heterogeneous list of
/// these and calls them through `dyn`.
///
/// ⚠ **`fetch` RETURNS A [`DayResult`], NOT A COUNT.** It has to, and the first
/// version of this type got it wrong: with a bare `u64` a day whose fetch threw
/// had two spellings available, `Ok(0)` or an error, and both were wrong.
/// `Ok(0)` says the day is EMPTY, which advances the streak that eventually
/// declares the stream complete — the 5xx-truncates-history bug
/// [`crate::backfill`] exists to prevent. An error would abort the user's whole
/// walk over one bad day. [`DayResult::Failed`] is the third answer, and it was
/// unconstructible until this signature admitted it.
pub struct DayStream<'a> {
    /// Stable; names the `sync_state` keys, so changing it restarts the walk.
    pub name: String,
    pub max_empty_days: i64,
    pub fetch:
        Box<dyn Fn(String) -> BoxFut<'a, Result<DayResult, RateLimitExhausted>> + Send + Sync + 'a>,
    /// Skip a day without spending a call. Counts toward the empty streak —
    /// a long run of skips terminates the walk exactly as a long run of empty
    /// fetches does. ⚠ Without that, a permanently-true condition walks the
    /// cursor backward forever; it is the bug the floor was added for.
    #[allow(clippy::type_complexity)]
    pub skip_if: Option<Box<dyn Fn(String) -> BoxFut<'a, Result<bool>> + Send + Sync + 'a>>,
}

/// A stream the backfill walks a window at a time — ~30× cheaper per day of
/// history, which is why the daily summaries use it.
pub struct RangeStream<'a> {
    pub name: String,
    pub max_empty_windows: i64,
    /// As [`DayStream::fetch`], over a window rather than a day.
    #[allow(clippy::type_complexity)]
    pub fetch: Box<
        dyn Fn(String, String) -> BoxFut<'a, Result<DayResult, RateLimitExhausted>>
            + Send
            + Sync
            + 'a,
    >,
}

fn cursor_key(name: &str) -> String {
    format!("backfill_{name}_cursor")
}

fn complete_key(name: &str) -> String {
    format!("backfill_{name}_complete")
}

/// Whether this stream has already finished, so the walk can be skipped whole.
async fn already_complete(pool: &MySqlPool, user_id: &str, name: &str) -> Result<bool> {
    Ok(sync_state::get(pool, user_id, &complete_key(name)).await? == Some("true".to_string()))
}

/// Record that a stream has run out of history, and why.
///
/// The reason is logged rather than stored: `sync_state` holds one flag, and
/// three different findings collapsing into `true` is precisely why the walk
/// used to be hard to diagnose.
async fn mark_complete(
    pool: &MySqlPool,
    user_id: &str,
    name: &str,
    reason: CompleteReason,
) -> Result<()> {
    match reason {
        CompleteReason::ReachedFloor => {
            tracing::info!("[{user_id}] {name}: reached the backfill floor {BACKFILL_FLOOR_DATE}");
        }
        CompleteReason::EmptyStreak => {
            tracing::info!(
                "[{user_id}] {name}: history exhausted — enough consecutive empty steps"
            );
        }
        // ⚠ Not a normal ending. The stream is stopped because its cursor
        // cannot name a day, which means something wrote a bad value; marking
        // it complete is the guard against compounding that, not a finding
        // about the data.
        CompleteReason::CursorUnusable => {
            tracing::warn!(
                "[{user_id}] {name}: stored cursor does not name a day — stopping rather than \
                 walking from it"
            );
        }
    }
    sync_state::set(pool, user_id, &complete_key(name), "true").await
}

/// Walk one intraday stream backwards until Lean says to stop.
pub async fn run_intraday_backfill(
    client: &FitbitClient,
    pool: &MySqlPool,
    user_id: &str,
    stream: &DayStream<'_>,
    default_start: &str,
) -> Result<()> {
    let name = &stream.name;
    if already_complete(pool, user_id, name).await? {
        tracing::info!("[{user_id}] {name}: backfill already complete");
        return Ok(());
    }

    let mut cursor = sync_state::get(pool, user_id, &cursor_key(name))
        .await?
        .unwrap_or_else(|| default_start.to_string());
    let mut empty_streak = 0i64;

    loop {
        let step = lean::decide_backfill_step(
            client.rate.remaining(),
            empty_streak,
            stream.max_empty_days,
            &cursor,
            BACKFILL_FLOOR_DATE,
        )?;
        let date = match step {
            BackfillStep::Pause => {
                tracing::info!(
                    "[{user_id}] {name}: paused at {cursor}, {} calls left",
                    client.rate.remaining()
                );
                return Ok(());
            }
            BackfillStep::Complete { reason } => {
                return mark_complete(pool, user_id, name, reason).await;
            }
            BackfillStep::Fetch { date } => date,
        };

        // A skip is a cheap DB lookup standing in for an API call, and it
        // counts as an empty day rather than as nothing having happened.
        let skipped = match &stream.skip_if {
            Some(skip) => skip(date.clone()).await?,
            None => false,
        };

        if skipped {
            empty_streak += 1;
        } else {
            // ⚠ Exhaustion propagates. It means the budget for the whole run is
            // spent, not that this day failed, and swallowing it here would
            // advance the cursor past a day nothing ever fetched. A day that
            // merely FAILED comes back as `DayResult::Failed` and the walk goes
            // on — see the note on `DayStream::fetch`.
            let result = (stream.fetch)(date.clone()).await?;
            if should_advance_empty_streak(&result) {
                empty_streak += 1;
            } else {
                empty_streak = 0;
            }
        }

        sync_state::set(pool, user_id, &cursor_key(name), &date).await?;
        cursor = date;
    }
}

/// Walk one range stream backwards until Lean says to stop.
///
/// The same shape as the intraday walk at a coarser unit, and now visibly so.
pub async fn run_range_backfill(
    client: &FitbitClient,
    pool: &MySqlPool,
    user_id: &str,
    stream: &RangeStream<'_>,
    default_start: &str,
) -> Result<()> {
    let name = &stream.name;
    if already_complete(pool, user_id, name).await? {
        tracing::info!("[{user_id}] {name}: backfill already complete");
        return Ok(());
    }

    let mut cursor = sync_state::get(pool, user_id, &cursor_key(name))
        .await?
        .unwrap_or_else(|| default_start.to_string());
    let mut empty_streak = 0i64;

    loop {
        let step = lean::decide_range_backfill_step(
            client.rate.remaining(),
            empty_streak,
            stream.max_empty_windows,
            RANGE_WINDOW_DAYS,
            &cursor,
            BACKFILL_FLOOR_DATE,
        )?;
        let (start, end) = match step {
            RangeBackfillStep::Pause => {
                tracing::info!(
                    "[{user_id}] {name}: paused at {cursor}, {} calls left",
                    client.rate.remaining()
                );
                return Ok(());
            }
            RangeBackfillStep::Complete { reason } => {
                return mark_complete(pool, user_id, name, reason).await;
            }
            RangeBackfillStep::Fetch { start, end } => (start, end),
        };

        let result = (stream.fetch)(start.clone(), end.clone()).await?;
        if should_advance_empty_streak(&result) {
            empty_streak += 1;
        } else {
            empty_streak = 0;
        }

        // The cursor is the OLDEST day now covered, not the newest — the next
        // window is measured back from it.
        sync_state::set(pool, user_id, &cursor_key(name), &start).await?;
        cursor = start;
    }
}

/// Order streams so the one with the most recent cursor is walked first.
///
/// Reads each stream's stored cursor and hands the pairs to Lean. An unstarted
/// stream has none, takes the fallback, and therefore goes first — otherwise a
/// deep backfill through 2024 starves every newly-deployed stream for many runs.
pub async fn order_streams(
    pool: &MySqlPool,
    user_id: &str,
    names: &[String],
    fallback: &str,
) -> Result<Vec<String>> {
    let mut pairs = Vec::with_capacity(names.len());
    for name in names {
        let cursor = sync_state::get(pool, user_id, &cursor_key(name)).await?;
        pairs.push((name.clone(), cursor));
    }
    lean::order_by_cursor_recency(&pairs, fallback)
}
