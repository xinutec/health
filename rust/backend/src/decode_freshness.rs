//! Whether a day's stored decode still stands for its inputs, and the queue a
//! stale day waits in.
//!
//! A decode records `inputs_through`: the earliest of the day's end, the
//! watch's last sync (the step stream is complete only up to it) and the moment
//! it ran. It is stale once the inputs reach further — today as fixes arrive,
//! a past day when the watch syncs the steps it had not yet sent — and missing
//! when no row carries the current `CLASSIFIER_VERSION`. A served read of such a
//! day queues it (`osm_fetch_queue`, kind `decode`); `watch-decode-queue`
//! decodes what the reads asked for, then the newest stale day it holds.
use anyhow::{Context, Result};
use sqlx::MySqlPool;

use crate::classification_inputs::CLASSIFIER_VERSION;

/// The queue kind a stale day waits under.
pub const QUEUE_KIND: &str = "decode";

pub fn queue_key(user_id: &str, date: &str) -> String {
    format!("{user_id}|{date}")
}

pub fn parse_key(key: &str) -> Option<(String, String)> {
    let (user, date) = key.split_once('|')?;
    Some((user.to_string(), date.to_string()))
}

/// The instant a day's inputs are complete to: the earliest of its end, the
/// watch's last sync (no sync on record: nothing lags behind `now`) and `now`.
pub fn horizon(day_end_utc: i64, steps_through: Option<i64>, now: i64) -> i64 {
    day_end_utc.min(steps_through.unwrap_or(now)).min(now)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// The stored decode saw everything the inputs hold.
    Current,
    /// A decode at the current version that saw less than the inputs hold, or
    /// one written before decodes recorded what they saw.
    Stale,
    /// No decode at the current version.
    Missing,
}

/// The stored decode against the inputs' `horizon`.
pub async fn freshness(
    pool: &MySqlPool,
    user_id: &str,
    date: &str,
    horizon: i64,
) -> Result<Freshness> {
    let row: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT inputs_through FROM decoded_days \
         WHERE user_id = ? AND date = ? AND classifier_version = ?",
    )
    .bind(user_id)
    .bind(date)
    .bind(CLASSIFIER_VERSION)
    .fetch_optional(pool)
    .await
    .with_context(|| format!("reading decoded_days.inputs_through for {user_id} {date}"))?;
    Ok(match row {
        None => Freshness::Missing,
        Some(None) => Freshness::Stale,
        Some(Some(t)) if t < horizon => Freshness::Stale,
        Some(Some(_)) => Freshness::Current,
    })
}

/// Queue the day when its decode does not stand. ⚠ Errors are logged, not
/// returned: the read serves the day either way, and the next read asks again.
pub async fn queue_if_stale(pool: &MySqlPool, user_id: &str, date: &str, horizon: i64) {
    match freshness(pool, user_id, date, horizon).await {
        Ok(Freshness::Current) => {}
        Ok(_) => crate::fetch_queue::record(pool, QUEUE_KIND, &queue_key(user_id, date)).await,
        Err(e) => eprintln!("decode queue: could not judge {user_id} {date}: {e:#}"),
    }
}
