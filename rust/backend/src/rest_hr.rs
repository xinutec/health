//! Heart rate awake and at rest, per local day — the host side of
//! `Verified.RestHr`: read the day's samples, step minutes and sleep stages,
//! ask Lean, keep the answer.
//!
//! A day holds ~38,000 heart-rate samples, so a 30-day window is over a million
//! rows. A finished day does not change once synced, so its answer is kept for
//! the life of the process; today and yesterday are always recomputed, because
//! the watch can still be catching up.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use sqlx::{MySqlPool, Row};

type Key = (String, String, String);

static CACHE: OnceLock<Mutex<HashMap<Key, Value>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<Key, Value>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|t| t.and_utc().timestamp())
}

fn at(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|t| t.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

/// One day: `{"date"}` plus, when the day is measurable, `median`, `p25`,
/// `p75`, `p05`, `p95` and `restMinutes`.
pub async fn day(pool: &MySqlPool, user: &str, date: &str, tz: &str) -> Result<Value> {
    let key = (user.to_string(), tz.to_string(), date.to_string());
    if let Some(v) = cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&key)
    {
        return Ok(v.clone());
    }
    let b = crate::timezone::date_bounds_utc(date, Some(tz))?;
    // The spike filter reads 30 s either side, so fetch a minute beyond.
    let (lo, hi) = (at(b.start_utc - 60), at(b.end_utc + 60));
    let samples: Vec<(i64, i64)> = sqlx::query(
        "SELECT CAST(ts_utc AS CHAR) AS t, bpm FROM heart_rate_intraday \
         WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ? ORDER BY ts_utc",
    )
    .bind(user)
    .bind(&lo)
    .bind(&hi)
    .fetch_all(pool)
    .await
    .context("reading heart_rate_intraday")?
    .iter()
    .filter_map(|r| {
        Some((
            unix(&r.get::<String, _>("t"))?,
            i64::from(r.get::<i16, _>("bpm")),
        ))
    })
    .collect();
    let steps: Vec<i64> = sqlx::query(
        "SELECT CAST(ts_utc AS CHAR) AS t FROM steps_intraday \
         WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ? AND steps > 0",
    )
    .bind(user)
    .bind(&lo)
    .bind(&hi)
    .fetch_all(pool)
    .await
    .context("reading steps_intraday")?
    .iter()
    .filter_map(|r| unix(&r.get::<String, _>("t")).map(|s| s.div_euclid(60)))
    .collect();
    // A night that began the evening before still covers this day's morning,
    // so the read starts a day early.
    let sleep: Vec<(i64, i64)> = sqlx::query(
        "SELECT CAST(ts_utc AS CHAR) AS t, duration_seconds AS d FROM sleep_stages \
         WHERE user_id = ? AND ts_utc >= ? AND ts_utc < ? AND stage NOT IN ('wake', 'awake')",
    )
    .bind(user)
    .bind(at(b.start_utc - 86_400))
    .bind(&hi)
    .fetch_all(pool)
    .await
    .context("reading sleep_stages")?
    .iter()
    .filter_map(|r| {
        let s = unix(&r.get::<String, _>("t"))?;
        Some((s, s + i64::from(r.get::<i32, _>("d"))))
    })
    .filter(|&(s, e)| e > b.start_utc && s < b.end_utc)
    .collect();
    let req = json!({
        "mode": "resthr", "samples": samples, "steps": steps, "sleep": sleep,
        "dayStart": b.start_utc, "dayEnd": b.end_utc,
    })
    .to_string();
    let reply = tokio::task::spawn_blocking(move || crate::lean::serve(&req))
        .await
        .context("the Lean call panicked")??;
    let reply: Value = serde_json::from_str(&reply).context("resthr reply is not JSON")?;
    if let Some(e) = reply.get("error") {
        anyhow::bail!("resthr {date}: {e}");
    }
    let mut row = Map::new();
    row.insert("date".into(), json!(date));
    if let Some(d) = reply.get("day").and_then(Value::as_object) {
        row.extend(d.clone());
    }
    let row = Value::Object(row);
    let settled = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .is_ok_and(|d| d < chrono::Utc::now().date_naive() - chrono::Duration::days(1));
    if settled {
        cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, row.clone());
    }
    Ok(row)
}

/// Every day from `first` to `last` inclusive, oldest first.
pub async fn days(
    pool: &MySqlPool,
    user: &str,
    first: chrono::NaiveDate,
    last: chrono::NaiveDate,
    tz: &str,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut d = first;
    while d <= last {
        out.push(day(pool, user, &d.format("%Y-%m-%d").to_string(), tz).await?);
        d += chrono::Duration::days(1);
    }
    Ok(out)
}

/// The zone a user's days are bounded in: their home zone.
pub async fn home_tz(pool: &MySqlPool, user: &str) -> Result<String> {
    Ok(crate::sync_state::get(pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/London".into()))
}
