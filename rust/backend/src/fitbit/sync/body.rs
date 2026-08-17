//! Weight, BMI and body fat. Port of `src/fitbit/sync/body.ts`.
//!
//! # The TIME-SERIES, not the weight log
//!
//! This reads `/body/{resource}/date/{start}/{end}`, not `/body/log/weight/…`.
//! The log carries discrete weigh-in EVENTS, and an account whose weight is fed
//! in by a connected scale writes the daily series without ever writing a log
//! event — the 2026 finding was an empty log next to a series holding 1095
//! daily points back to 2023. The series is the canonical source; BMI and body
//! fat are sibling series merged in by date.
//!
//! Fitbit forward-fills the series (a value every day, carried from the last
//! measurement) and it is stored as given. That is the resolution the API
//! exposes, and thinning it here would be this code inventing a measurement
//! schedule Fitbit did not report.
//!
//! # ⚠ THE NIGHTLY SYNC DOES NOT CALL THIS, AND MUST NOT
//!
//! `src/sync.ts` omits body from both the forward pass and the range backfill,
//! deliberately: the Fitbit weight feed froze in April 2026 when the scale
//! started reporting through Health Connect to Google instead, so the values
//! here are forward-filled staleness. Running it nightly would re-clobber the
//! real figures the Google Health sync writes (#260).
//!
//! Its one caller is `src/cli/backfill-body.ts`, a manual historical fill. The
//! port keeps that shape — this module is called by hand or not at all.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;
use std::collections::BTreeMap;

use crate::fitbit::client::{FitbitClient, FitbitError};

/// One point of a body time-series. `value` is a STRING on the wire — Fitbit
/// sends `"72.4"`, not `72.4` — which is why [`positive_num`] parses rather
/// than compares.
#[derive(Deserialize)]
pub struct Point {
    #[serde(rename = "dateTime")]
    pub date_time: String,
    pub value: String,
}

/// A positive finite number, or `None`.
///
/// The series carries `"0"` — not a gap — for every day before the first
/// measurement, so zero means "not measured" and must not be stored as a body
/// mass of zero. One comparison, and it stays in Rust for the same reason the
/// steps filter does: it is a storage policy over a wire value, not a rule
/// anything downstream reasons about.
///
/// ⚠ THE PARSE IS NOT JAVASCRIPT'S. `Number(s)` accepts forms `f64::from_str`
/// rejects, and after trimming exactly one survives: `Number("0x10")` is 16
/// while this answers `None`. Fitbit sends decimal strings, so the difference is
/// unreachable from real data — recorded because "same behaviour" is a claim and
/// this is the extent of it. The leading/trailing space `Number` tolerates is
/// handled by the trim rather than left as a second divergence.
pub fn positive_num(s: &str) -> Option<f64> {
    let x: f64 = s.trim().parse().ok()?;
    (x.is_finite() && x > 0.0).then_some(x)
}

/// Fetch one body time-series resource.
///
/// A resource the account never recorded — body fat without a smart scale —
/// answers with an empty series or a 4xx, and both mean "no data" rather than a
/// failed sync. Swallowing that is what stops a missing scale from sinking the
/// weight series alongside it.
///
/// ⚠ RATE-LIMIT EXHAUSTION IS NOT SWALLOWED, and the TypeScript's bare `catch`
/// does swallow it. Under a spent budget that path reports "no data" for all
/// three resources and returns success, so the run looks complete and the
/// cursor advances past days that were never fetched. A deliberate divergence:
/// a spent budget is the caller's to handle, and it already has a resume path.
async fn body_series(
    client: &FitbitClient,
    pool_label: &str,
    access_token: &str,
    resource: &str,
    start: &str,
    end: &str,
) -> Result<Vec<Point>, FitbitError> {
    let body = match client
        .get_json(
            access_token,
            &format!("/1/user/-/body/{resource}/date/{start}/{end}.json"),
        )
        .await
    {
        Ok(b) => b,
        Err(e @ FitbitError::RateLimited(_)) => return Err(e),
        Err(e) => {
            tracing::warn!("[{pool_label}] body {resource} {start}..{end}: {e}");
            return Ok(Vec::new());
        }
    };
    let mut parsed: BTreeMap<String, Vec<Point>> =
        serde_json::from_str(&body).context("parsing body response")?;
    Ok(parsed
        .remove(&format!("body-{resource}"))
        .unwrap_or_default())
}

/// One `body` row: the three series merged for a date.
#[derive(Default)]
pub struct BodyRow {
    pub weight: Option<f64>,
    pub bmi: Option<f64>,
    pub fat: Option<f64>,
}

impl BodyRow {
    /// A date with nothing measured is not written. All three series are
    /// forward-filled zeros before the first measurement, so without this the
    /// backfill would write a row per day back to the account's creation.
    fn is_empty(&self) -> bool {
        self.weight.is_none() && self.bmi.is_none() && self.fat.is_none()
    }
}

/// Merge the three series by date.
///
/// A `BTreeMap` and not insertion order: the TypeScript's `Map` yields dates in
/// whatever order the weight series arrived, which is only incidentally sorted.
/// Every write is a keyed upsert so the order does not affect the result — it
/// affects whether two runs produce the same log, which is worth having.
pub fn merge_series(weight: &[Point], bmi: &[Point], fat: &[Point]) -> BTreeMap<String, BodyRow> {
    let mut by_date: BTreeMap<String, BodyRow> = BTreeMap::new();
    for p in weight {
        by_date.entry(p.date_time.clone()).or_default().weight = positive_num(&p.value);
    }
    for p in bmi {
        by_date.entry(p.date_time.clone()).or_default().bmi = positive_num(&p.value);
    }
    for p in fat {
        by_date.entry(p.date_time.clone()).or_default().fat = positive_num(&p.value);
    }
    by_date
}

/// Sync weight / BMI / body fat over a date range.
///
/// The three fetches run in SEQUENCE where the TypeScript ran them under
/// `Promise.all`. The rate budget is per-process state read before a call and
/// written from its response headers, so three concurrent calls decide their
/// waits against a count none of them has updated yet. Sequential costs two
/// round trips of latency on a job that runs on a timer, and buys an accurate
/// budget.
pub async fn sync_body(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    start_date: &str,
    end_date: &str,
) -> Result<usize, FitbitError> {
    let weight = body_series(
        client,
        user_id,
        access_token,
        "weight",
        start_date,
        end_date,
    )
    .await?;
    let bmi = body_series(client, user_id, access_token, "bmi", start_date, end_date).await?;
    let fat = body_series(client, user_id, access_token, "fat", start_date, end_date).await?;

    let by_date = merge_series(&weight, &bmi, &fat);

    let mut count = 0usize;
    for (date, v) in &by_date {
        if v.is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO body (user_id, date, weight_kg, bmi, body_fat_pct) VALUES (?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE weight_kg=VALUES(weight_kg), bmi=VALUES(bmi), \
             body_fat_pct=VALUES(body_fat_pct)",
        )
        .bind(user_id)
        .bind(date)
        .bind(v.weight)
        .bind(v.bmi)
        .bind(v.fat)
        .execute(pool)
        .await
        .context("writing body")?;
        count += 1;
    }

    tracing::info!("[{user_id}] Synced {count} body entries ({start_date}..{end_date})");
    Ok(count)
}
