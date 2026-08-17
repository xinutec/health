//! Intraday steps. Port of `src/fitbit/sync/steps.ts`.
//!
//! # Why this one does NOT go to Lean, stated rather than assumed
//!
//! The split rule is *does this decide anything?*, and applying it honestly
//! here says Rust. Two halves, and neither belongs across the boundary:
//!
//!   * The filter is `value > 0`. Dropping zero-step minutes is a STORAGE
//!     policy with a documented reason — most minutes of a day are zero, so
//!     keeping them costs ~5× the rows for no information, and absence means
//!     zero. One comparison, proved by reading it. Shipping 1 440 rows a day
//!     through a JSON boundary to apply `> 0` would buy nothing and cost a
//!     round trip per day.
//!   * The `ts_utc` derivation needs the IANA zone database, which
//!     `Verified` deliberately does not have — its whole point is that a spec
//!     there means what it says, with no `IO` and no external data. So the tz
//!     work lives in [`crate::timezone`] on `chrono-tz` and cannot move.
//!
//! ⚠ This is NOT a general licence. `decideRateLimitWait` and the cursor walk
//! did move, because they are rules about budgets and dates that a wrong line
//! silently breaks. The question is asked per function.
//!
//! # The upsert preserves rather than overwrites, in three different ways
//!
//! Fitbit's intraday endpoint occasionally serves a LESS complete response for
//! a day already stored, so a plain overwrite loses data that was correct. The
//! column rules are the TypeScript's and each is deliberate.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use crate::fitbit::client::{FitbitClient, FitbitError};
use crate::timezone::wall_clock_to_utc_string;

/// Below this remaining budget the day loop stops, leaving the rest to the next
/// run. Higher than the client's own floor so this exits before reaching it.
const STEPS_BUDGET_FLOOR: i64 = 10;

#[derive(Deserialize)]
struct IntradayPoint {
    time: String,
    value: i64,
}

#[derive(Deserialize)]
struct Intraday {
    dataset: Vec<IntradayPoint>,
}

#[derive(Deserialize)]
struct StepsResponse {
    #[serde(rename = "activities-steps-intraday")]
    intraday: Option<Intraday>,
}

/// One row of `steps_intraday`, shaped for the insert.
pub struct StepsRow {
    pub ts: String,
    pub steps: i64,
    pub tz: Option<String>,
    pub ts_utc: Option<String>,
}

/// The pure part: a response and a per-minute tz, as rows.
///
/// `tz_for` is the caller's inference — forward sync passes one derived from
/// PhoneTrack and the Fitbit profile, and the backward backfill passes one that
/// always answers `None`, which writes `tz=NULL` rows for the backfill CLI to
/// fill in later. Taking it as a closure keeps that choice at the call site
/// rather than smuggling a mode flag in here.
pub fn parse_steps_dataset(
    body: &str,
    date: &str,
    tz_for: &dyn Fn(&str, &str) -> Option<String>,
) -> Result<Vec<StepsRow>> {
    let parsed: StepsResponse = serde_json::from_str(body).context("parsing steps response")?;
    let Some(intraday) = parsed.intraday else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for p in intraday.dataset {
        // Absence implies zero; see the header.
        if p.value <= 0 {
            continue;
        }
        let ts = format!("{date} {}", p.time);
        let tz = tz_for(date, &p.time);
        let ts_utc = wall_clock_to_utc_string(&ts, tz.as_deref());
        rows.push(StepsRow {
            ts,
            steps: p.value,
            tz,
            ts_utc,
        });
    }
    Ok(rows)
}

/// Sync intraday steps across a date range, one Fitbit call per day.
pub async fn sync_steps_intraday(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    dates: &[String],
    tz_for: &dyn Fn(&str, &str) -> Option<String>,
) -> Result<usize, FitbitError> {
    let mut total = 0usize;
    for date in dates {
        if client.rate.remaining() <= STEPS_BUDGET_FLOOR {
            tracing::info!("[{user_id}] Steps intraday paused, rate limit low");
            break;
        }
        let body = client
            .get_json(
                access_token,
                &format!("/1/user/-/activities/steps/date/{date}/1d/1min.json"),
            )
            .await?;
        let rows = parse_steps_dataset(&body, date, tz_for)?;
        if rows.is_empty() {
            continue;
        }
        for r in &rows {
            sqlx::query(
                // GREATEST on `steps`: a later sync returning a SMALLER count
                // for a minute already stored must not overwrite it.
                // COALESCE on `tz` and `ts_utc`: the first non-null sticks, so a
                // backfill that later learns the zone can fill a null but a
                // null cannot erase a known one. The backfill CLI writes
                // `ts_utc` directly, bypassing this.
                "INSERT INTO steps_intraday (user_id, ts, steps, tz, ts_utc) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE steps = GREATEST(steps, VALUES(steps)), \
                 tz = COALESCE(tz, VALUES(tz)), ts_utc = COALESCE(ts_utc, VALUES(ts_utc))",
            )
            .bind(user_id)
            .bind(&r.ts)
            .bind(r.steps)
            .bind(&r.tz)
            .bind(&r.ts_utc)
            .execute(pool)
            .await
            .context("writing steps_intraday")?;
        }
        total += rows.len();
        tracing::info!(
            "[{user_id}] Synced {} steps intraday minutes for {date}",
            rows.len()
        );
    }
    Ok(total)
}
