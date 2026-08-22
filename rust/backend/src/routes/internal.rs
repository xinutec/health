//! Service-to-service endpoints for the coach app (#982).
//!
//! Not part of `/api`: no session, no cookie. The caller passes the target
//! `?user=` and proves itself with a shared secret in `X-Service-Token`.
//!
//! ⚠ AN EMPTY TOKEN LIST REJECTS EVERYTHING, and that is the default. This
//! surface hands out another person's mined places and their recovery history,
//! so "no secret configured" must mean off rather than open.
//!
//! # What this deliberately does NOT answer
//!
//! ⚠ There is no readiness score here and there must not be. health does not
//! know what readiness means; coach composes it from these raw numbers. If both
//! scored it they would drift on what a bad day is, and the athlete would be
//! told two different things by two apps reading the same nights.
//!
//! # Why a PAST morning is anyone's business
//!
//! Coach's prediction-error ledger judges each logged session against what it
//! asked that day, and it asks for less when the athlete was under-recovered.
//! Without that, full compliance with an eased ask reads as falling short — a
//! badly slept night recorded as the athlete failing, which then holds their
//! progression back. `/recovery/history` is `/recovery` projected over a range,
//! not a new measurement.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::nextcloud::credentials::NcError;
use crate::state::AppState;
use crate::{lean, row_json};

const SERVICE_HEADER: &str = "x-service-token";

#[derive(Deserialize)]
pub struct UserParam {
    user: Option<String>,
}

#[derive(Deserialize)]
pub struct HistoryParams {
    user: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

/// ⚠ Constant-time comparison, and a length check first. A shared secret
/// compared with `==` leaks its prefix through timing to a caller who can
/// retry — which is exactly what an unauthenticated endpoint invites.
fn token_ok(st: &AppState, headers: &HeaderMap) -> bool {
    use subtle::ConstantTimeEq;
    let Some(given) = headers.get(SERVICE_HEADER).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    st.cfg
        .service_tokens
        .iter()
        .any(|t| t.len() == given.len() && bool::from(t.as_bytes().ct_eq(given.as_bytes())))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

fn oops(e: &anyhow::Error, what: &str) -> Response {
    tracing::error!(error = %format!("{e:#}"), "{what}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}

/// `?user=` — required, and bounded so it cannot be used to probe with
/// arbitrarily long keys.
fn user_of(raw: Option<&str>) -> Option<String> {
    raw.filter(|u| !u.is_empty() && u.len() <= 64)
        .map(str::to_string)
}

/// One mined place, as both endpoints read it.
struct Place {
    id: i64,
    display_name: Option<String>,
    amenity_label: Option<String>,
    amenity_kind: Option<String>,
    lat: f64,
    lon: f64,
    avg_dwell_sec: f64,
    unique_days: i64,
    last_seen_ts: Option<i64>,
}

/// ⚠ DECIMAL centroids and BIGINT dwell columns are coerced HERE, at the
/// boundary, exactly once. `avgDwellSec` divides a BIGINT by a count, and doing
/// that in SQL would round it to an integer before anyone saw the remainder.
async fn load_places(st: &AppState, user_id: &str) -> anyhow::Result<Vec<Place>> {
    let rows = sqlx::query(
        "SELECT id, CAST(centroid_lat AS CHAR) AS lat_s, CAST(centroid_lon AS CHAR) AS lon_s, \
         display_name, amenity_label, amenity_kind, total_dwell_sec, visit_count, \
         unique_days, last_seen_ts FROM focus_places WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&st.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let lat_s: String = r.try_get("lat_s")?;
        let lon_s: String = r.try_get("lon_s")?;
        let total_dwell: i64 = r.try_get("total_dwell_sec")?;
        let visits: i64 = r.try_get("visit_count")?;
        out.push(Place {
            // ⚠ UNSIGNED is a DISTINCT sqlx type — an unsigned column decoded
            // as i64 is REJECTED by `Type::compatible` at runtime, not coerced.
            // The try-then-fallback this replaced would have worked and hidden
            // the fact that the first attempt always failed.
            id: r.try_get::<u64, _>("id")? as i64,
            display_name: r.try_get("display_name")?,
            amenity_label: r.try_get("amenity_label")?,
            amenity_kind: r.try_get("amenity_kind")?,
            lat: lat_s.parse()?,
            lon: lon_s.parse()?,
            // ⚠ Zero visits is 0, not a division by zero.
            avg_dwell_sec: if visits > 0 {
                total_dwell as f64 / visits as f64
            } else {
                0.0
            },
            unique_days: r.try_get("unique_days")?,
            // ⚠ Also UNSIGNED, and nullable — both halves matter.
            last_seen_ts: r
                .try_get::<Option<u64>, _>("last_seen_ts")?
                .map(|v| v as i64),
        });
    }
    Ok(out)
}

/// `GET /internal/places?user=` — the picker's list.
pub async fn places(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<UserParam>,
) -> Response {
    if !token_ok(&st, &headers) {
        return unauthorized();
    }
    let Some(user) = user_of(p.user.as_deref()) else {
        return bad_request("user required");
    };
    match places_run(&st, &user).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => oops(&e, "/internal/places failed"),
    }
}

async fn places_run(st: &AppState, user: &str) -> anyhow::Result<Vec<Value>> {
    let places = load_places(st, user).await?;
    let mut out = Vec::with_capacity(places.len());
    for p in places {
        let proj = lean::place_projection(
            p.display_name.as_deref(),
            p.amenity_label.as_deref(),
            p.amenity_kind.as_deref(),
        )?;
        out.push(json!({
            "id": p.id,
            "label": proj.label,
            "displayName": p.display_name,
            "amenityLabel": p.amenity_label,
            // ⚠ `named` is not "has a label". A bare Stay has a label and is
            // not named, because several Stays are indistinguishable in a
            // picker.
            "named": proj.named,
            "category": proj.category,
            "centroid": {
                "lat": row_json::js_number_value(p.lat),
                "lon": row_json::js_number_value(p.lon),
            },
            "avgDwellSec": p.avg_dwell_sec.round() as i64,
            "uniqueDays": p.unique_days,
            "lastSeenTs": p.last_seen_ts,
        }));
    }
    Ok(out)
}

/// `GET /internal/place/current?user=` — where they are now, or null.
pub async fn place_current(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<UserParam>,
) -> Response {
    if !token_ok(&st, &headers) {
        return unauthorized();
    }
    let Some(user) = user_of(p.user.as_deref()) else {
        return bad_request("user required");
    };
    match place_current_run(&st, &user).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => match e.downcast_ref::<NcError>() {
            // ⚠ Not-linked is `null` with a 200: coach asks about users who may
            // never have connected Nextcloud, and that is not an error.
            Some(NcError::NotLinked) => Json(Value::Null).into_response(),
            Some(NcError::ReauthRequired) => (
                StatusCode::CONFLICT,
                Json(json!({ "error": "nextcloud_reauth_required" })),
            )
                .into_response(),
            _ => {
                tracing::error!(error = %format!("{e:#}"), user = %user, "/internal/place/current failed");
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "current place fetch failed" })),
                )
                    .into_response()
            }
        },
    }
}

async fn place_current_run(st: &AppState, user: &str) -> anyhow::Result<Value> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let yesterday = lean::prev_day(&today)?;
    let next = lean::next_day(&today)?;
    let base = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let pt = crate::nextcloud::phonetrack::PhoneTrack::open(st.http.clone(), &st.pool, &base, user)
        .await?;
    // ⚠ Yesterday too, so a fix just after midnight is not the only point in
    // the window — the same reason `/location/latest` widens it.
    let fetched = pt.fetch_range(&st.pool, &yesterday, &next).await?;
    let Some(last) = fetched.points.last() else {
        return Ok(Value::Null);
    };

    let places: Vec<lean::PresencePlace> = load_places(st, user)
        .await?
        .into_iter()
        .map(|p| lean::PresencePlace {
            id: p.id,
            display_name: p.display_name,
            amenity_label: p.amenity_label,
            lat: p.lat,
            lon: p.lon,
        })
        .collect();

    Ok(
        match lean::pick_current_place(last.lat, last.lon, &places)? {
            None => Value::Null,
            Some(cp) => json!({
                "id": cp.id,
                "label": cp.label,
                "displayName": cp.display_name,
                "amenityLabel": cp.amenity_label,
                "centroidLat": row_json::js_number_value(cp.lat),
                "centroidLon": row_json::js_number_value(cp.lon),
                "distanceM": row_json::js_number_value(cp.distance_m),
            }),
        },
    )
}

/// The three recovery streams, from `since` forward.
async fn load_recovery(
    st: &AppState,
    user: &str,
    since: &str,
) -> anyhow::Result<(
    Vec<(String, Option<f64>)>,
    Vec<(String, Option<f64>)>,
    Vec<(String, Option<f64>)>,
)> {
    let hrv_rows = sqlx::query(
        "SELECT date, CAST(daily_rmssd AS CHAR) AS v FROM hrv_daily \
         WHERE user_id = ? AND date >= ?",
    )
    .bind(user)
    .bind(since)
    .fetch_all(&st.pool)
    .await?;
    let rhr_rows = sqlx::query(
        "SELECT date, resting_heart_rate AS v FROM daily_activity \
         WHERE user_id = ? AND date >= ?",
    )
    .bind(user)
    .bind(since)
    .fetch_all(&st.pool)
    .await?;
    // ⚠ MAIN SLEEP ONLY. A nap counted as the night would drag the baseline
    // down and read as a bad night's sleep.
    let sleep_rows = sqlx::query(
        "SELECT date, minutes_asleep AS v FROM sleep \
         WHERE user_id = ? AND date >= ? AND is_main_sleep = 1",
    )
    .bind(user)
    .bind(since)
    .fetch_all(&st.pool)
    .await?;

    let date_of = |r: &sqlx::mysql::MySqlRow| -> anyhow::Result<String> {
        let d: chrono::NaiveDate = r.try_get("date")?;
        Ok(d.format("%Y-%m-%d").to_string())
    };

    let mut hrv = Vec::with_capacity(hrv_rows.len());
    for r in &hrv_rows {
        let v: Option<String> = r.try_get("v")?;
        hrv.push((date_of(r)?, v.map(|s| s.parse()).transpose()?));
    }
    let mut rhr = Vec::with_capacity(rhr_rows.len());
    for r in &rhr_rows {
        let v: Option<i64> = r.try_get("v")?;
        rhr.push((date_of(r)?, v.map(|x| x as f64)));
    }
    let mut sleep = Vec::with_capacity(sleep_rows.len());
    for r in &sleep_rows {
        let v: Option<i64> = r.try_get("v")?;
        // ⚠ HOURS, not minutes — the field coach reads is `sleepHours`.
        sleep.push((date_of(r)?, v.map(|x| x as f64 / 60.0)));
    }
    Ok((hrv, rhr, sleep))
}

fn stat_json(s: Option<lean::Stat>) -> Value {
    match s {
        None => Value::Null,
        Some(s) => json!({
            "latest": row_json::js_number_value(s.latest),
            "mean": row_json::js_number_value(s.mean),
            "sd": row_json::js_number_value(s.sd),
            // ⚠ `n` is how a caller knows whether to trust a z-score at all.
            // With one reading it is 0 and the mean is that reading.
            "n": s.n,
        }),
    }
}

fn as_of_json(r: &lean::RecoveryAsOf) -> Value {
    json!({
        "asOf": r.as_of,
        "sleepHours": r.sleep_hours.map_or(Value::Null, row_json::js_number_value),
        "hrv": stat_json(r.hrv.as_ref().map(|s| lean::Stat {
            latest: s.latest, mean: s.mean, sd: s.sd, n: s.n,
        })),
        "restingHr": stat_json(r.resting_hr.as_ref().map(|s| lean::Stat {
            latest: s.latest, mean: s.mean, sd: s.sd, n: s.n,
        })),
    })
}

/// `GET /internal/recovery?user=` — this morning.
pub async fn recovery(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<UserParam>,
) -> Response {
    if !token_ok(&st, &headers) {
        return unauthorized();
    }
    let Some(user) = user_of(p.user.as_deref()) else {
        return bad_request("user required");
    };
    match recovery_run(&st, &user).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => oops(&e, "/internal/recovery failed"),
    }
}

async fn recovery_run(st: &AppState, user: &str) -> anyhow::Result<Value> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let since = lean::earliest_visible(&today, 28, None)?
        .ok_or_else(|| anyhow::anyhow!("could not compute the baseline floor"))?;
    let (hrv, rhr, sleep) = load_recovery(st, user, &since).await?;
    let r = lean::recovery_as_of(&today, &hrv, &rhr, &sleep)?;
    Ok(as_of_json(&r))
}

/// `GET /internal/recovery/history?user=&from=&to=` — the same, per day.
pub async fn recovery_history(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<HistoryParams>,
) -> Response {
    if !token_ok(&st, &headers) {
        return unauthorized();
    }
    let Some(user) = user_of(p.user.as_deref()) else {
        return bad_request("user required");
    };
    let (Some(from), Some(to)) = (p.from.as_deref(), p.to.as_deref()) else {
        return bad_request("from and to required (YYYY-MM-DD)");
    };
    // ⚠ REFUSED, not truncated. Answering a decade-wide request with 400 days
    // would look complete to a caller who asked for more.
    match lean::recovery_span_ok(from, to) {
        Ok(false) => return bad_request("range is backwards, malformed, or wider than 400 days"),
        Err(e) => return oops(&e, "judging the recovery span"),
        Ok(true) => {}
    }
    match recovery_history_run(&st, &user, from, to).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => oops(&e, "/internal/recovery/history failed"),
    }
}

async fn recovery_history_run(
    st: &AppState,
    user: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<Vec<Value>> {
    // ⚠ Reaches a baseline further back than the RANGE does: every day in it
    // needs a full 28 days behind it, or the earliest days would be judged
    // against a baseline that thins out towards the start.
    let floor = lean::earliest_visible(from, 28, None)?
        .ok_or_else(|| anyhow::anyhow!("could not compute the baseline floor"))?;
    let (hrv, rhr, sleep) = load_recovery(st, user, &floor).await?;

    let mut out = Vec::new();
    let mut day = from.to_string();
    loop {
        let r = lean::recovery_as_of(&day, &hrv, &rhr, &sleep)?;
        out.push(as_of_json(&r));
        if day == to {
            break;
        }
        day = lean::next_day(&day)?;
    }
    Ok(out)
}
