//! The twelve `/api` reads that are a table and a window: eight last-N-days,
//! two single-day, two whole-table. Each is a select and its rows as JSON;
//! [`crate::row_json`] owns the rendering.
//!
//! A share recipient asking for a day outside their window gets `[]` and a 200
//! from the single-day reads (where `/velocity` gives a 403): the frontend pages
//! through days and treats an empty day as "nothing that day". The multi-day
//! reads are capped instead, `earliestVisible` folding the share's `from` into
//! the `date >=` bound.
//!
//! The SQL is written out per table: table names cannot be bound, and building
//! the string would defeat `DL-SQLX-SCHEMA-TRUTH`, which checks every literal
//! query against the schema.

use anyhow::{Context, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::auth::session::UserSession;
use crate::state::AppState;
use crate::{lean, row_json};

#[derive(Deserialize)]
pub struct DaysParams {
    days: Option<String>,
}

#[derive(Deserialize)]
pub struct DateParams {
    date: Option<String>,
}

/// JavaScript's `Number(s)`, the client contract for numeric parameters; `pub`
/// for `tests/suite/row_json.rs`. Unlike `s.parse::<f64>()`, it changes which
/// requests are answered:
///
///   * `Number("")` is `0`, so an empty `?days=` is rejected (below the
///     minimum), not the 30-day default;
///   * it trims, so `" 7 "` is 7;
///   * it reads unsigned hex, so `"0x10"` is 16 (`"-0x10"` is `NaN`).
///
/// Infinities become `NaN`, a rejection, kept out of Lean's integer conversion.
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    // Every NaN below is the contract, not a sentinel this function chose:
    // `js_number` implements JavaScript's `Number()`, whose "not a number"
    // answer is NaN, and the callers read NaN as the rejection.
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        // dev-lint: allow-nan-sentinel — the contract, not a sentinel; see the note above the first branch
        return u64::from_str_radix(rest, 16).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        // dev-lint: allow-nan-sentinel — the contract, not a sentinel; see the note above the first branch
        return u64::from_str_radix(rest, 8).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        // dev-lint: allow-nan-sentinel — the contract, not a sentinel; see the note above the first branch
        return u64::from_str_radix(rest, 2).map_or(f64::NAN, |v| v as f64);
    }
    match t.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        // dev-lint: allow-nan-sentinel — the contract, not a sentinel; see the note above the first branch
        _ => f64::NAN,
    }
}

/// The `date >= ?` bound for a days-back read. `None` means reject the request.
///
/// ⚠ Both rules here are Lean's, and the second is a security boundary:
/// `earliestVisible` takes the later of `today - days` and the share window's
/// start, so a recipient cannot widen their view by asking for more days.
fn since_date(session: &UserSession, raw: Option<&str>) -> Result<Option<String>> {
    let Some(days) = lean::validate_days(raw.map(js_number))? else {
        return Ok(None);
    };
    // Today in UTC, with no dependency on the server's timezone.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let share_from = session.share_viewer.as_ref().map(|(f, _)| f.as_str());
    let since = lean::earliest_visible(&today, days, share_from)?
        .context("earliestVisible refused today's date")?;
    Ok(Some(since))
}

/// `YYYY-MM-DD` and nothing else. Absent defaults to today in UTC.
fn parse_date(raw: Option<&str>) -> Option<String> {
    let Some(s) = raw else {
        return Some(chrono::Utc::now().format("%Y-%m-%d").to_string());
    };
    let b = s.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    ok.then(|| s.to_string())
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// `[]` with a 200, not a 403 — see the module note on why the two window
/// refusals differ.
fn empty() -> Response {
    Json(Value::Array(Vec::new())).into_response()
}

/// Keep the rows whose instant survived the repair, and warn how many did not:
/// a row with neither `_utc` nor a convertible zone cannot be placed on a time
/// axis and would chart as `NaN`. Only for time-axis rows; [`SQL_SLEEP`] keeps
/// the night and nulls the instant.
fn placed_rows(rows: Vec<sqlx::mysql::MySqlRow>, what: &str) -> Vec<sqlx::mysql::MySqlRow> {
    let total = rows.len();
    let placed: Vec<_> = rows
        .into_iter()
        .filter(|r| {
            r.try_get_raw("ts_utc")
                .map(|v| !sqlx::ValueRef::is_null(&v))
                .unwrap_or(false)
        })
        .collect();
    if placed.len() != total {
        tracing::warn!(
            "{what}: {} of {total} row(s) have no instant and no convertible zone — \
             dropped from the chart",
            total - placed.len()
        );
    }
    placed
}

/// True when a share recipient may not see this single date.
fn outside_share_window(session: &UserSession, date: &str) -> Result<bool> {
    match &session.share_viewer {
        None => Ok(false),
        Some((from, to)) => Ok(!lean::date_in_share_window(date, from, to)?),
    }
}

/// Every days-back handler is this with one literal query, expanded per handler
/// because `DL-SQLX-SCHEMA-TRUTH` cannot check a query passed as `&str`.
macro_rules! days_back_handler {
    ($name:ident, $sql_const:ident, $sql:expr) => {
        /// The query this endpoint serves, exported so `backend rows-check` can
        /// verify the rendering of these exact rows against production.
        pub const $sql_const: &str = $sql;

        pub async fn $name(
            State(st): State<AppState>,
            Extension(session): Extension<UserSession>,
            Query(p): Query<DaysParams>,
        ) -> Response {
            let run = async {
                let Some(since) = since_date(&session, p.days.as_deref())? else {
                    return Ok(bad_request("days must be an integer between 1 and 365"));
                };
                let rows = sqlx::query($sql)
                    .bind(&session.user_id)
                    .bind(&since)
                    .fetch_all(&st.pool)
                    .await?;
                Ok::<_, anyhow::Error>(Json(row_json::rows_to_json(&rows)?).into_response())
            };
            match run.await {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!(error = %e, endpoint = stringify!($name), "days-back read failed");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(crate::error::ErrorBody { error: "internal".to_string() }),
                    )
                        .into_response()
                }
            }
        }
    };
}

days_back_handler!(
    activity,
    SQL_ACTIVITY,
    "SELECT * FROM daily_activity WHERE user_id = ? AND date >= ? ORDER BY date"
);
// The wall clock does not ship; the instant is repaired from it and the zone
// with `CONVERT_TZ` where the stored `_utc` is missing, as `/sleep/stages`
// does. Unlike a stage point, a night with an unrecoverable instant still
// shows, with a null instant: most of a sleep row is not time-axis data. Every
// production row carries `_utc`, so the repair is a net for legacy rows, and
// `CONVERT_TZ` itself returns NULL without the server's zone tables.
macro_rules! sql_sleep_select {
    () => {
        "SELECT log_id, date, \
         COALESCE(start_time_utc, CONVERT_TZ(start_time, tz, 'UTC')) AS start_time_utc, \
         COALESCE(end_time_utc, CONVERT_TZ(end_time, tz, 'UTC')) AS end_time_utc, \
         duration_ms, efficiency, minutes_asleep, minutes_awake, minutes_deep, \
         minutes_light, minutes_rem, minutes_wake, is_main_sleep, tz \
         FROM sleep"
    };
}
days_back_handler!(
    sleep,
    SQL_SLEEP,
    concat!(
        sql_sleep_select!(),
        " WHERE user_id = ? AND date >= ? ORDER BY date"
    )
);
// The second sort key is load-bearing: the frontend renders zones in the
// order they arrive, and dropping it would order them by whatever the storage
// engine returns.
days_back_handler!(
    heartrate_zones,
    SQL_HEARTRATE_ZONES,
    "SELECT * FROM heart_rate_zones WHERE user_id = ? AND date >= ? ORDER BY date, zone_name"
);
days_back_handler!(
    body,
    SQL_BODY,
    "SELECT * FROM body WHERE user_id = ? AND date >= ? ORDER BY date"
);
/// `GET /body/before?days=N`: the window `/body?days=N` covers and the last
/// weight and body fat before it, so the chart can estimate the first day. A
/// share viewer gets none: what precedes the window is what the link hides.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyBefore {
    pub since: String,
    pub weight: Option<Reading>,
    pub body_fat: Option<Reading>,
}

#[derive(serde::Serialize)]
pub struct Reading {
    pub date: String,
    pub value: f64,
}

fn reading(row: Option<sqlx::mysql::MySqlRow>) -> Result<Option<Reading>> {
    row.map(|r| {
        Ok(Reading {
            date: r.try_get("d")?,
            value: r.try_get("v")?,
        })
    })
    .transpose()
}

pub async fn body_before(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DaysParams>,
) -> Response {
    let run = async {
        let Some(since) = since_date(&session, p.days.as_deref())? else {
            return Ok(bad_request("days must be an integer between 1 and 365"));
        };
        let (weight, body_fat) = if session.share_viewer.is_some() {
            (None, None)
        } else {
            // CAST and DATE_FORMAT in SQL: a `DECIMAL` and a `DATE` decode
            // through sqlx only by accident of the row in hand.
            let weight = sqlx::query(
                "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, CAST(weight_kg AS DOUBLE) AS v \
                 FROM body WHERE user_id = ? AND date < ? AND weight_kg IS NOT NULL \
                 ORDER BY date DESC LIMIT 1",
            )
            .bind(&session.user_id)
            .bind(&since)
            .fetch_optional(&st.pool)
            .await?;
            let body_fat = sqlx::query(
                "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d, CAST(body_fat_pct AS DOUBLE) AS v \
                 FROM body WHERE user_id = ? AND date < ? AND body_fat_pct IS NOT NULL \
                 ORDER BY date DESC LIMIT 1",
            )
            .bind(&session.user_id)
            .bind(&since)
            .fetch_optional(&st.pool)
            .await?;
            (reading(weight)?, reading(body_fat)?)
        };
        Ok::<_, anyhow::Error>(
            Json(BodyBefore {
                since,
                weight,
                body_fat,
            })
            .into_response(),
        )
    };
    match run.await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, endpoint = "body_before", "read failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

/// Heart rate awake and at rest per day (`crate::rest_hr`), over the
/// requested window. At most 90 days: each uncached day reads ~38,000 samples.
pub async fn heartrate_rest(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DaysParams>,
) -> Response {
    let run = async {
        let Some(since) = since_date(&session, p.days.as_deref())? else {
            return Ok(bad_request("days must be an integer between 1 and 365"));
        };
        let today = chrono::Utc::now().date_naive();
        let first = chrono::NaiveDate::parse_from_str(&since, "%Y-%m-%d")?
            .max(today - chrono::Duration::days(89));
        let tz = crate::sync_state::home_tz(&st.pool, &session.user_id).await?;
        let rows = crate::rest_hr::days(&st.pool, &session.user_id, first, today, &tz).await?;
        Ok::<_, anyhow::Error>(Json(rows).into_response())
    };
    match run.await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, endpoint = "heartrate_rest", "read failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

days_back_handler!(
    spo2,
    SQL_SPO2,
    "SELECT * FROM spo2_daily WHERE user_id = ? AND date >= ? ORDER BY date"
);
days_back_handler!(
    hrv,
    SQL_HRV,
    "SELECT * FROM hrv_daily WHERE user_id = ? AND date >= ? ORDER BY date"
);
days_back_handler!(
    breathing,
    SQL_BREATHING,
    "SELECT * FROM breathing_rate WHERE user_id = ? AND date >= ? ORDER BY date"
);
days_back_handler!(
    temperature,
    SQL_TEMPERATURE,
    "SELECT * FROM skin_temperature WHERE user_id = ? AND date >= ? ORDER BY date"
);

/// The two whole-table reads, with no share-window branch: a recipient sees the
/// owner's watches and sync cursors, metadata about the account, not a date.
/// Worth knowing before a share link goes to someone new.
macro_rules! whole_table_handler {
    ($name:ident, $sql_const:ident, $sql:literal) => {
        /// The query this endpoint serves, exported for `backend rows-check`.
        pub const $sql_const: &str = $sql;

        pub async fn $name(
            State(st): State<AppState>,
            Extension(session): Extension<UserSession>,
        ) -> Response {
            let run = async {
                let rows = sqlx::query($sql)
                    .bind(&session.user_id)
                    .fetch_all(&st.pool)
                    .await?;
                Ok::<_, anyhow::Error>(Json(row_json::rows_to_json(&rows)?).into_response())
            };
            match run.await {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!(error = %e, endpoint = stringify!($name), "whole-table read failed");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(crate::error::ErrorBody { error: "internal".to_string() }),
                    )
                        .into_response()
                }
            }
        }
    };
}

// No ORDER BY: row order is whatever the storage engine returns, and a sort
// here would be a different response.
whole_table_handler!(
    sync_state,
    SQL_SYNC_STATE,
    "SELECT * FROM sync_state WHERE user_id = ?"
);

/// `GET /day?date=` — that date's `daily_activity` row and its sleep rows, in
/// the shapes `/activity` and `/sleep` serve. The Today page's summary reads its
/// day from here, so a day older than the Trends window still shows.
pub async fn day(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DateParams>,
) -> Response {
    match day_run(&st, &session, p).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "day read failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

async fn day_run(st: &AppState, session: &UserSession, p: DateParams) -> Result<Response> {
    let Some(date) = parse_date(p.date.as_deref()) else {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    };
    if outside_share_window(session, &date)? {
        return Ok(Json(json!({ "activity": [], "sleep": [] })).into_response());
    }
    let activity = sqlx::query("SELECT * FROM daily_activity WHERE user_id = ? AND date = ?")
        .bind(&session.user_id)
        .bind(&date)
        .fetch_all(&st.pool)
        .await?;
    let sleep = sqlx::query(concat!(
        sql_sleep_select!(),
        " WHERE user_id = ? AND date = ?"
    ))
    .bind(&session.user_id)
    .bind(&date)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(json!({
        "activity": row_json::rows_to_json(&activity)?,
        "sleep": row_json::rows_to_json(&sleep)?,
    }))
    .into_response())
}

/// `GET /sleep/stages?date=` — the stages of that date's main sleep.
pub async fn sleep_stages(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DateParams>,
) -> Response {
    match sleep_stages_run(&st, &session, p).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "sleep stages read failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

/// The stage query as a zero-arg macro, so `rows_check` shares the literal and
/// `DL-SQLX-SCHEMA-TRUTH` still checks it (a `const` is opaque to the lint).
macro_rules! sql_sleep_stages {
    () => {
        "SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, stage, \
         duration_seconds, tz FROM sleep_stages \
         WHERE user_id = ? AND sleep_log_id = ? ORDER BY 1"
    };
}
pub(crate) use sql_sleep_stages;

async fn sleep_stages_run(st: &AppState, session: &UserSession, p: DateParams) -> Result<Response> {
    let Some(date) = parse_date(p.date.as_deref()) else {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    };
    if outside_share_window(session, &date)? {
        return Ok(empty());
    }

    // No ORDER BY: a day with two rows flagged main sleep is bad data that no
    // sort would make right.
    let log = sqlx::query(
        "SELECT log_id FROM sleep WHERE user_id = ? AND date = ? AND is_main_sleep = 1 LIMIT 1",
    )
    .bind(&session.user_id)
    .bind(&date)
    .fetch_optional(&st.pool)
    .await?;
    let Some(log) = log else {
        return Ok(empty());
    };
    let log_id: i64 = log.try_get("log_id").context("sleep.log_id")?;

    // The wall clock does not ship: `ts` and `tz` give the instant exactly,
    // through `CONVERT_TZ` where `ts_utc` is missing.
    //
    // ⚠ `CONVERT_TZ` returns NULL when the server's zone tables are absent; such
    // a row stays NULL, is filtered below and reported. Only rows already
    // missing `ts_utc` can reach it.
    let rows = sqlx::query(sql_sleep_stages!())
        .bind(&session.user_id)
        .bind(log_id)
        .fetch_all(&st.pool)
        .await?;

    let placed = placed_rows(rows, "sleep stages");
    Ok(Json(row_json::rows_to_json(&placed)?).into_response())
}

/// One day of per-minute heart rate, as a zero-arg macro like
/// [`sql_sleep_stages`]. The window is on the wall clock (`[date, nextDay)`
/// against `ts`, the user's own day), and the payload is the instant plus `tz`.
/// A row without `ts_utc` whose zone cannot convert is dropped by
/// [`placed_rows`] and reported.
macro_rules! sql_heartrate_intraday {
    () => {
        "SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, bpm, tz \
         FROM heart_rate_intraday \
         WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts"
    };
}
pub(crate) use sql_heartrate_intraday;

/// `GET /heartrate/intraday?date=` — one day of per-minute heart rate.
pub async fn heartrate_intraday(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DateParams>,
) -> Response {
    match heartrate_intraday_run(&st, &session, p).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "intraday heart rate read failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

async fn heartrate_intraday_run(
    st: &AppState,
    session: &UserSession,
    p: DateParams,
) -> Result<Response> {
    let Some(date) = parse_date(p.date.as_deref()) else {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    };
    if outside_share_window(session, &date)? {
        return Ok(empty());
    }
    let next = lean::next_day(&date)?;
    let rows = sqlx::query(sql_heartrate_intraday!())
        .bind(&session.user_id)
        .bind(&date)
        .bind(&next)
        .fetch_all(&st.pool)
        .await?;
    let placed = placed_rows(rows, "heart rate intraday");
    Ok(Json(row_json::rows_to_json(&placed)?).into_response())
}
