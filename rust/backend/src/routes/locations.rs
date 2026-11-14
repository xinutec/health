//! The three live-map reads, from PhoneTrack over Nextcloud: `/locations` (one
//! day's fixes), `/location/latest` (the marker) and `/location/tail` (the
//! trajectory since the caller's last point).
//!
//! Errors are a product decision: not linked is `[]`/`null` with a 200, since
//! the frontend prompts linking from `/api/me` and a 4xx would raise the
//! generic error banner. Reauth-required is a 409 `nextcloud_reauth_required`,
//! which the client turns into the relink banner. Anything else is a 400; the
//! client keys off it.
//!
//! `/location/latest` and `/location/tail` check the share window against
//! today, not the request: the tail has no date, and an expired link must not
//! see the owner's current position.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::session::UserSession;
use crate::error::ErrorBody;
use crate::location_cache::{LatestFix, TailPoint};
use crate::nextcloud::credentials::NcError;
use crate::nextcloud::phonetrack::PhoneTrack;
use crate::state::AppState;
use crate::{lean, location_cache, row_json};

/// One fix as `/locations` serves it, built by hand so every float goes through
/// `row_json::js_number_value` (`120`, not `120.0`). Key order is the wire
/// order (`preserve_order`).
fn wire_point(p: &crate::nextcloud::phonetrack::RawTrackPoint) -> Value {
    json!({
        "ts": p.ts,
        "lat": row_json::js_number_value(p.lat),
        "lon": row_json::js_number_value(p.lon),
        "altitude": row_json::js_number_opt(p.altitude),
        "speed": row_json::js_number_opt(p.speed),
        "accuracy": row_json::js_number_opt(p.accuracy),
        "battery": row_json::js_number_opt(p.battery),
    })
}

#[derive(Deserialize)]
pub struct DateParams {
    date: Option<String>,
}

#[derive(Deserialize)]
pub struct TailParams {
    since: Option<String>,
}

/// The shared refusal shape; the caller supplies the typed not-linked body
/// (`[]` or `null`), since dl-wire-untyped-response checks each handler's
/// own body.
fn nc_error_response<T: Serialize>(e: &NcError, not_linked: T, message: &'static str) -> Response {
    match e {
        NcError::NotLinked => Json(not_linked).into_response(),
        NcError::ReauthRequired => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "nextcloud_reauth_required" })),
        )
            .into_response(),
        _ => (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response(),
    }
}

/// `YYYY-MM-DD`, defaulting to today in UTC.
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

fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// True when a share recipient may not see this date.
async fn outside_window(session: &UserSession, date: &str) -> anyhow::Result<bool> {
    match &session.share_viewer {
        None => Ok(false),
        Some((from, to)) => Ok(!lean::date_in_share_window(date, from, to)?),
    }
}

/// Open PhoneTrack for this user.
async fn open(st: &AppState, user_id: &str) -> Result<PhoneTrack, NcError> {
    // An unset `NC_BASE_URL` (as on the serving pod) uses the default; it does
    // not mean "not linked", which would serve every caller a blank map. The
    // sync path's `None` means something else: skip PhoneTrack tz inference.
    let base = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    PhoneTrack::open(st.http.clone(), &st.pool, &base, user_id).await
}

/// The marker, or `null`. Hand-built for the same reason as [`wire_point`]:
/// a derived `Serialize` writes `17.0` where JavaScript writes `17`.
fn fix_json(fix: Option<&LatestFix>) -> Value {
    match fix {
        None => Value::Null,
        Some(f) => json!({
            "lat": row_json::js_number_value(f.lat),
            "lon": row_json::js_number_value(f.lon),
            "ts": f.ts,
            "accuracy": row_json::js_number_opt(f.accuracy),
        }),
    }
}

/// One point of `/location/tail`: `{lat, lon, ts}`. `JsNumber`, so coordinates
/// print as `row_json` does (`js_number_wire.rs` pins it).
#[derive(Serialize)]
pub struct TailPointOut {
    pub lat: row_json::JsNumber,
    pub lon: row_json::JsNumber,
    pub ts: i64,
}

fn tail_json(p: &TailPoint) -> TailPointOut {
    TailPointOut {
        lat: row_json::JsNumber(p.lat),
        lon: row_json::JsNumber(p.lon),
        ts: p.ts,
    }
}

/// `GET /locations?date=` — one day of fixes.
pub async fn locations(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<DateParams>,
) -> Response {
    let Some(date) = parse_date(p.date.as_deref()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "date must be YYYY-MM-DD" })),
        )
            .into_response();
    };
    match outside_window(&session, &date).await {
        Ok(true) => return Json(Value::Array(Vec::new())).into_response(),
        Ok(false) => {}
        Err(e) => return internal(&e),
    }

    let next = match lean::next_day(&date) {
        Ok(n) => n,
        Err(e) => return internal(&e),
    };

    let fetched = async {
        let pt = open(&st, &session.user_id).await?;
        pt.fetch_range(&st.pool, &date, &next).await
    }
    .await;

    match fetched {
        Ok(f) => {
            // `failed_devices` is not surfaced to the caller, which gets a 200
            // either way. It is logged with a count, so a short day can be
            // explained after the fact rather than looking like a quiet day.
            if f.failed_devices > 0 {
                tracing::warn!(
                    user = %session.user_id, date = %date, failed_devices = f.failed_devices,
                    "locations: answering with a SUBSET — some devices failed"
                );
            }
            let out: Vec<Value> = f.points.iter().map(wire_point).collect();
            Json(out).into_response()
        }
        Err(e) => {
            if !matches!(e, NcError::NotLinked) {
                tracing::error!(user = %session.user_id, date = %date, error = %e, "/locations failed");
            }
            nc_error_response(&e, json!([]), "locations fetch failed")
        }
    }
}

/// `GET /location/latest` — the marker.
pub async fn latest(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    let today = today_utc();
    // Today, not a requested date. See the module note.
    match outside_window(&session, &today).await {
        Ok(true) => return Json(Value::Null).into_response(),
        Ok(false) => {}
        Err(e) => return internal(&e),
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(fix) = st
        .latest_fix
        .get(&session.user_id, now_ms, lean::LATEST_FIX_TTL_MS)
    {
        return Json(fix_json(fix.as_ref())).into_response();
    }

    let (yesterday, next) = match (lean::prev_day(&today), lean::next_day(&today)) {
        (Ok(y), Ok(n)) => (y, n),
        _ => return internal(&anyhow::anyhow!("date arithmetic failed for {today}")),
    };

    let fetched = async {
        let pt = open(&st, &session.user_id).await?;
        // Yesterday and today: a fix a minute after midnight would otherwise
        // be the only point in the window and a quiet night would answer null.
        pt.fetch_range(&st.pool, &yesterday, &next).await
    }
    .await;

    match fetched {
        Ok(f) => {
            // Points come back ascending, so the freshest is last.
            let fix = f.points.last().map(|p| LatestFix {
                lat: p.lat,
                lon: p.lon,
                ts: p.ts,
                accuracy: p.accuracy,
            });
            st.latest_fix.put(&session.user_id, now_ms, fix.clone());
            Json(fix_json(fix.as_ref())).into_response()
        }
        Err(e) => {
            if !matches!(e, NcError::NotLinked) {
                tracing::error!(user = %session.user_id, error = %e, "/location/latest failed");
            }
            nc_error_response(&e, Value::Null, "latest fix fetch failed")
        }
    }
}

/// `GET /location/tail?since=` — every raw fix after `since`.
pub async fn tail(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<TailParams>,
) -> Response {
    let today = today_utc();
    match outside_window(&session, &today).await {
        Ok(true) => return Json(Value::Array(Vec::new())).into_response(),
        Ok(false) => {}
        Err(e) => return internal(&e),
    }

    // `since` absent is 0; unparseable is NaN, which no `p.ts` exceeds, so the
    // tail is empty rather than all 2000 points.
    let since = match p.since.as_deref() {
        None => Some(0.0_f64),
        Some(s) => {
            let n = crate::routes::tables::js_number(s);
            if n.is_nan() { None } else { Some(n) }
        }
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let buffered = match st
        .tail_points
        .get(&session.user_id, now_ms, lean::TAIL_TTL_MS)
    {
        Some(points) => points,
        None => {
            let (yesterday, next) = match (lean::prev_day(&today), lean::next_day(&today)) {
                (Ok(y), Ok(n)) => (y, n),
                _ => return internal(&anyhow::anyhow!("date arithmetic failed for {today}")),
            };
            let fetched = async {
                let pt = open(&st, &session.user_id).await?;
                pt.fetch_range(&st.pool, &yesterday, &next).await
            }
            .await;
            match fetched {
                Ok(f) => {
                    let points: Vec<TailPoint> = f
                        .points
                        .into_iter()
                        .map(|p| TailPoint {
                            lat: p.lat,
                            lon: p.lon,
                            ts: p.ts,
                        })
                        .collect();
                    st.tail_points.put(&session.user_id, now_ms, points.clone());
                    points
                }
                Err(e) => {
                    if !matches!(e, NcError::NotLinked) {
                        tracing::error!(user = %session.user_id, error = %e, "/location/tail failed");
                    }
                    return nc_error_response(&e, Vec::<TailPointOut>::new(), "tail fetch failed");
                }
            }
        }
    };

    let Some(since) = since else {
        // NaN: every comparison is false, so the tail is empty.
        return Json(Vec::<TailPointOut>::new()).into_response();
    };
    let out: Vec<TailPointOut> = location_cache::tail_after(&buffered, since)
        .iter()
        .map(tail_json)
        .collect();
    Json(out).into_response()
}

fn internal(e: &anyhow::Error) -> Response {
    tracing::error!(error = %e, "location route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: "internal".to_string(),
        }),
    )
        .into_response()
}
