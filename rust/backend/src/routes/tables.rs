//! The twelve `/api` reads that are a table and a window (#982).
//!
//! Eight are "the last N days of one table", two are "one day of one table",
//! and two are a whole table with no window at all.
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
    // ⚠ Every NaN below IS the contract, not a sentinel this function chose.
    // `js_number` reimplements JavaScript's `Number()`, whose "not a number"
    // answer is NaN; returning `Option<f64>` would make this stop mirroring the
    // oracle in `lean/experiments/apiwindow-refs.mts` that the doc above pins it
    // to, and the callers already read NaN as the rejection.
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        // dev-lint: allow-nan-sentinel
        return u64::from_str_radix(rest, 16).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        // dev-lint: allow-nan-sentinel
        return u64::from_str_radix(rest, 8).map_or(f64::NAN, |v| v as f64);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        // dev-lint: allow-nan-sentinel
        return u64::from_str_radix(rest, 2).map_or(f64::NAN, |v| v as f64);
    }
    match t.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        // dev-lint: allow-nan-sentinel
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

/// Keep the rows whose instant survived the repair, and SAY how many did not.
///
/// A row with neither a stored `_utc` nor a convertible zone cannot be placed on
/// a time axis at all, so it is dropped rather than served as a null a chart
/// would render as `NaN`. ⚠ The count is WARNED rather than swallowed: a
/// silently shorter series reads as a real statement about the day, when what it
/// actually says is that the server has no zone tables (#1532).
///
/// ⚠ Only for rows that ARE a position in time. A `sleep` row is mostly not —
/// see the note on [`SQL_SLEEP`], which keeps the night and nulls the instant.
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
// ⚠ THE WALL CLOCK DOES NOT SHIP, and the instant is REPAIRED rather than
// served beside it (#1532). `start_time`/`end_time` are the clock the watch
// showed, which `row_json` stamps with a `Z` they have not earned; `CONVERT_TZ`
// recovers the true instant from the wall clock and the zone whenever the stored
// `_utc` is missing, which is the same repair `/sleep/stages` makes.
//
// ⚠ AND A NULL SURVIVES HERE, where `/sleep/stages` drops the row. A stage point
// IS a position on a time axis and means nothing unplaced. A sleep row is mostly
// NOT time-axis data — efficiency, the minutes in each stage, whether it was the
// main sleep — so refusing the night to punish an unrecoverable instant would
// hide real data from the dashboard. The instant goes null; the night still
// shows.
//
// ⚠ THE REPAIR IS A NET, NOT A PATH. Measured against production 2026-09-12
// (`scripts/probe-served-instants.mjs`): all 1,270 sleep rows, all 37,780 stage
// rows and all 32,587,081 intraday heart-rate rows already carry a stored
// `_utc`, so the COALESCE reaches its second arm zero times today. It is here
// for a legacy row the backfill never touched, and for the case where it cannot
// help — `CONVERT_TZ` also returns NULL when the server has no zone tables, and
// that is why the fallback is written rather than assumed.
days_back_handler!(
    sleep,
    SQL_SLEEP,
    "SELECT log_id, date, \
     COALESCE(start_time_utc, CONVERT_TZ(start_time, tz, 'UTC')) AS start_time_utc, \
     COALESCE(end_time_utc, CONVERT_TZ(end_time, tz, 'UTC')) AS end_time_utc, \
     duration_ms, efficiency, minutes_asleep, minutes_awake, minutes_deep, \
     minutes_light, minutes_rem, minutes_wake, is_main_sleep, tz \
     FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date"
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

/// The two whole-table reads: no window, no date, just the user's rows.
///
/// ⚠ Neither has a share-window branch, and that is the TypeScript's behaviour
/// rather than an omission here. A share recipient reading `/devices` sees the
/// owner's watches and their last sync times; reading `/sync-state` sees the
/// owner's per-stream cursors. Both are metadata about the account rather than
/// about a date, so a date window has nothing to say about them — but it does
/// mean these two endpoints are NOT narrowed by a share, which is worth knowing
/// before a share link goes to someone new.
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

// ⚠ No ORDER BY in either, matching the TypeScript. Row order is whatever the
// storage engine returns; adding a sort here would be a nicer API and a
// different response.
whole_table_handler!(
    devices,
    SQL_DEVICES,
    "SELECT * FROM devices WHERE user_id = ?"
);
whole_table_handler!(
    sync_state,
    SQL_SYNC_STATE,
    "SELECT * FROM sync_state WHERE user_id = ?"
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
                Json(crate::error::ErrorBody {
                    error: "internal".to_string(),
                }),
            )
                .into_response()
        }
    }
}

/// The stage query, as a zero-arg macro so it can reach two places and stay ONE
/// literal.
///
/// ⚠ NOT a `const` read at the query site. `DL-SQLX-SCHEMA-TRUTH` resolves a
/// literal, a `concat!`, or a crate-local zero-arg macro — a `const` path is
/// opaque to it, so `sqlx::query(SQL_SLEEP_STAGES)` would be UNCHECKED SQL. The
/// macro gives the parity harness something to compare against without trading
/// the schema check away.
macro_rules! sql_sleep_stages {
    () => {
        "SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, stage, \
         duration_seconds, tz FROM sleep_stages \
         WHERE user_id = ? AND sleep_log_id = ? ORDER BY 1"
    };
}
pub(crate) use sql_sleep_stages;

/// The stage query this endpoint serves, exported so `backend rows-check` can
/// verify the RENDERING of these exact rows against production.
///
/// ⚠ The mirror in `rows_check` DID drift, for a day, when the `#1532` repair
/// landed in the route and not in the copy — which is why there is a const to
/// compare against at all.
pub const SQL_SLEEP_STAGES: &str = sql_sleep_stages!();

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

    // ⚠ THE WALL CLOCK DOES NOT SHIP, and the instant is REPAIRED rather than
    // served nullable (#1532). `sleep_stages.ts` is the clock the watch showed,
    // which `row_json` renders with a `Z` it has not earned — one wire carrying
    // two meanings under one suffix. Dropping it costs nothing, because a row
    // missing `ts_utc` is not missing information: `ts` and `tz` determine the
    // instant exactly, which is what `CONVERT_TZ` does here.
    //
    // ⚠ `CONVERT_TZ` RETURNS NULL when the server's zone tables are absent, and
    // that is handled rather than assumed: such a row stays NULL, falls into the
    // filter below and is REPORTED. The COALESCE only reaches it when `ts_utc`
    // is already null, so an ordinary row cannot be harmed by a missing table.
    let rows = sqlx::query(sql_sleep_stages!())
        .bind(&session.user_id)
        .bind(log_id)
        .fetch_all(&st.pool)
        .await?;

    let placed = placed_rows(rows, "sleep stages");
    Ok(Json(row_json::rows_to_json(&placed)?).into_response())
}

/// One day of per-minute heart rate, as a zero-arg macro for the same reason as
/// [`sql_sleep_stages`]: one literal, two readers, and still lint-checked.
///
/// ⚠ THE WINDOW IS ON THE WALL CLOCK and the PAYLOAD IS THE INSTANT — they are
/// deliberately different columns. `[date, nextDay)` against `ts` is what "his
/// Tuesday" means; running the bound against `ts_utc` would shift the day's
/// edges by the offset for anyone not living in UTC. What SHIPS is the instant,
/// because `row_json` stamps a `Z` on `ts` that it has not earned (#1532), and
/// `tz`, because that is what turns the instant back into the clock he saw.
///
/// ⚠ `CONVERT_TZ` RETURNS NULL when the server has no zone tables. Such a row
/// keeps a null instant, is dropped by [`placed_rows`] and is REPORTED. The
/// COALESCE only reaches it when `ts_utc` is already null, so an ordinary row
/// cannot be harmed by a missing table.
macro_rules! sql_heartrate_intraday {
    () => {
        "SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, bpm, tz \
         FROM heart_rate_intraday \
         WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts"
    };
}
pub(crate) use sql_heartrate_intraday;

/// The query this endpoint serves, exported so `backend rows-check` can verify
/// the RENDERING of these exact rows against production.
pub const SQL_HEARTRATE_INTRADAY: &str = sql_heartrate_intraday!();

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
