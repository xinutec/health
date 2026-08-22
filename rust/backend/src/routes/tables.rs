//! The ten `/api` reads that are a table and a window (#982).
//!
//! Eight are "the last N days of one table", two are "one day of one table".
//! Each is a single line in `src/routes/api.ts` — `selectAll()`, `c.json(rows)`
//! — and the port is almost entirely about not changing the response. See
//! [`crate::row_json`] for what the driver and `JSON.stringify` were measured to
//! produce; nothing about the rendering is decided here.
//!
//! # Two windows, two different refusals
//!
//! ⚠ A share recipient asking for a date outside their window gets `[]` and a
//! **200** from the single-day endpoints, while `/velocity` gives them a 403.
//! That is the TypeScript's behaviour and it is preserved deliberately: the
//! frontend paging through days treats a 200 with no rows as "nothing that day"
//! and keeps rendering, and turning that into an error would break paging at
//! the window edge rather than at the request.
//!
//! ⚠ The multi-day endpoints have no such branch at all. They are capped
//! instead, by `earliestVisible` folding the share's `from` into the `date >=`
//! bound — so a recipient asking for 365 days gets their window and no error.
//!
//! # Why the SQL is written out ten times
//!
//! One parameterised `SELECT * FROM {table}` would be shorter and would defeat
//! `DL-SQLX-SCHEMA-TRUTH`, the lint that keeps every query in this repo a
//! literal a reader can grep for. Table names cannot be bound as parameters
//! anyway, so the alternative is string-building a query — which is the thing
//! the lint exists to stop.

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

/// `Number(s)`, as `z.coerce.number()` calls it.
///
/// ⚠ `pub` so `tests/row_json.rs` can hold it against the zod outputs measured
/// in `lean/experiments/apiwindow-refs.mts`. Integration tests are a separate
/// crate, so `pub(crate)` would be invisible to them.
///
/// ⚠ Not `s.parse::<f64>()`. Three of these differences change which requests
/// are answered, and all three were measured against zod itself — see the
/// `daysParam` section of `lean/experiments/apiwindow-refs.mts`:
///
///   * `Number("")` is `0`, NOT `NaN`. An empty `?days=` is therefore a
///     rejection (0 is below the minimum) and not the 30-day default. A host
///     that treated empty as absent would silently answer a malformed request.
///   * `Number` TRIMS, so `" 7 "` is 7.
///   * `Number` reads non-decimal literals, so `"0x10"` is a valid 16-day
///     window. Unsigned only — JS gives `NaN` for `"-0x10"`, as does this.
///
/// Infinities become `NaN` here, which is a rejection. `Number("Infinity")` is
/// `Infinity` in JS and zod then rejects it as non-integral, so the request is
/// refused either way — but arriving as `NaN` keeps it out of the integer
/// conversion in Lean rather than relying on it.
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(rest, 16).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return u64::from_str_radix(rest, 8).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return u64::from_str_radix(rest, 2).map_or(f64::NAN, |v| v as f64);
    }
    match t.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => f64::NAN,
    }
}

/// The `date >= ?` bound for a days-back read. `None` means REJECT the request.
///
/// ⚠ Both rules here are Lean's, and the second is a security boundary:
/// `earliestVisible` takes the LATER of `today - days` and the share window's
/// start, so a recipient cannot widen their view by asking for more days.
fn since_date(session: &UserSession, raw: Option<&str>) -> Result<Option<String>> {
    let Some(days) = lean::validate_days(raw.map(js_number))? else {
        return Ok(None);
    };
    // ⚠ TODAY IN UTC. The TypeScript builds a local `Date`, shifts it with the
    // local `setDate`, then reads it back with `toISOString` — so its window
    // depends on the server's timezone and is only correct because the pod runs
    // with TZ unset. This is that same window without the ambient variable.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let share_from = session.share_viewer.as_ref().map(|(f, _)| f.as_str());
    let since = lean::earliest_visible(&today, days, share_from)?
        .context("earliestVisible refused today's date")?;
    Ok(Some(since))
}

/// `YYYY-MM-DD` and nothing else — the TypeScript's `dateParam` regex. Absent
/// defaults to today in UTC.
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

/// ⚠ `[]` with a 200, NOT a 403 — see the module note on why the two window
/// refusals differ.
fn empty() -> Response {
    Json(Value::Array(Vec::new())).into_response()
}

/// True when a share recipient may not see this single date.
fn outside_share_window(session: &UserSession, date: &str) -> Result<bool> {
    match &session.share_viewer {
        None => Ok(false),
        Some((from, to)) => Ok(!lean::date_in_share_window(date, from, to)?),
    }
}

/// Every days-back handler is this, with one literal query substituted.
///
/// ⚠ The query is expanded INTO each handler rather than passed to a shared
/// function taking `&str`. `DL-SQLX-SCHEMA-TRUTH` resolves literals and macro
/// fragments and checks the columns and bind arity against the replayed schema;
/// a `&'static str` parameter defeats it, and a query nobody checks is a
/// renamed column away from a runtime 500.
macro_rules! days_back_handler {
    ($name:ident, $sql_const:ident, $sql:literal) => {
        /// The query this endpoint serves, exported so `backend rows-check` can
        /// verify the RENDERING of these exact rows against production.
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
                        Json(json!({ "error": "internal" })),
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
days_back_handler!(
    sleep,
    SQL_SLEEP,
    "SELECT * FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date"
);
// ⚠ The second sort key is load-bearing: the frontend renders zones in the
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

/// `GET /sleep/stages?date=` — the stages of that date's MAIN sleep.
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
                Json(json!({ "error": "internal" })),
            )
                .into_response()
        }
    }
}

async fn sleep_stages_run(st: &AppState, session: &UserSession, p: DateParams) -> Result<Response> {
    let Some(date) = parse_date(p.date.as_deref()) else {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    };
    if outside_share_window(session, &date)? {
        return Ok(empty());
    }

    // ⚠ No ORDER BY, matching `executeTakeFirst()`. A day with two rows flagged
    // main sleep resolves arbitrarily in both implementations; inventing a sort
    // here would make this port disagree with production on exactly the days
    // where the data is already wrong.
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

    let rows = sqlx::query(
        "SELECT * FROM sleep_stages WHERE user_id = ? AND sleep_log_id = ? ORDER BY ts",
    )
    .bind(&session.user_id)
    .bind(log_id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(row_json::rows_to_json(&rows)?).into_response())
}

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
                Json(json!({ "error": "internal" })),
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
    // ⚠ A HALF-OPEN range on the WALL-CLOCK `ts`, not on `ts_utc`. The two
    // differ by the offset, and reading the UTC column instead would shift the
    // day's boundaries by an hour for anyone not on UTC. `[date, nextDay)` is
    // what the TypeScript asks for; the strings compare against a DATETIME the
    // same way there and here.
    let next = lean::next_day(&date)?;
    let rows = sqlx::query(
        "SELECT * FROM heart_rate_intraday WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts",
    )
    .bind(&session.user_id)
    .bind(&date)
    .bind(&next)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(row_json::rows_to_json(&rows)?).into_response())
}
