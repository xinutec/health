//! The three live-map reads (#982).
//!
//! `/locations` is one day's fixes, `/location/latest` is the marker, and
//! `/location/tail` is the raw trajectory since the caller's last point. All
//! three come from PhoneTrack over Nextcloud, and all three share one error
//! taxonomy that is a product decision rather than plumbing.
//!
//! # Not-linked is NOT an error
//!
//! ⚠ An account with no Nextcloud link answers `[]`/`null` with a **200**, not
//! a failure. The frontend surfaces the "link your Nextcloud" call to action
//! from `/api/me`, and a 4xx here would instead fire the generic error banner
//! over a state that is merely unconfigured.
//!
//! ⚠ Reauth-required is different and gets a **409** with a structured
//! `nextcloud_reauth_required` code, because the client interceptor watches for
//! exactly that to raise the relink banner. Collapsing it into the not-linked
//! case would leave a user with a revoked app password looking at an empty map
//! and no way to learn why.
//!
//! Anything else is a **400**. That is the TypeScript's choice and it is odd —
//! a Nextcloud outage is not the caller's fault and 502 would describe it
//! better — but the client keys off the status, so it is preserved.
//!
//! # The share window is checked against TODAY, not the request
//!
//! ⚠ `/location/latest` and `/location/tail` answer about NOW. A share
//! recipient whose window ended last week must not see a live marker, so both
//! test TODAY against the window rather than any date in the request. There is
//! no date parameter to check on the tail at all, so a host that skipped this
//! would leak the owner's current position to every expired link.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::session::UserSession;
use crate::location_cache::{LatestFix, TailPoint};
use crate::nextcloud::credentials::NcError;
use crate::nextcloud::phonetrack::PhoneTrack;
use crate::state::AppState;
use crate::{lean, location_cache, row_json};

/// One fix as `/locations` serves it.
///
/// ⚠ Built by hand rather than derived, because EVERY float has to go through
/// `row_json::js_number_value`. A derived `Serialize` writes `120.0` where
/// JavaScript writes `120`, which is a different response for the same fix —
/// measured, 8,790 bytes across one day.
///
/// ⚠ Key order is the wire order and matches the TypeScript's object literal;
/// `preserve_order` is what makes that hold.
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

/// The shared refusal shape. `None` for the not-linked body means the caller
/// supplies it, since `/locations` answers `[]` and `/location/latest` `null`.
fn nc_error_response(e: &NcError, not_linked: Value, message: &'static str) -> Response {
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

/// `YYYY-MM-DD`, defaulting to today in UTC — the TypeScript's `dateParam`.
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
    // ⚠ AN UNSET `NC_BASE_URL` FALLS BACK TO THE DEFAULT — it does NOT mean
    // "not linked". `NC_BASE_URL` is in fact EMPTY on the serving pod today
    // (measured, 2026-08-22), and `src/config.ts` answers that with
    // `.default("https://dash.xinutec.org")` on the API path, which is why the
    // live map works in production.
    //
    // Treating unset as not-linked here — which is what this first did — would
    // have answered EVERY caller with an empty map and a 200, indistinguishable
    // from an account that genuinely has no Nextcloud. Nothing would have
    // failed; the map would just have been blank.
    //
    // ⚠ The SYNC path's `None` is a different question and keeps its meaning:
    // there, unset legitimately means "do not do PhoneTrack tz inference"
    // (health #1037). `DAY_NEXTCLOUD_BASE_URL` carries that same split.
    let base = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    PhoneTrack::open(st.http.clone(), &st.pool, &base, user_id).await
}

/// The marker, or `null`. ⚠ Hand-built for the same reason as [`wire_point`]:
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

/// One tail point. ⚠ Three keys only — the TypeScript projects the tail down to
/// `{lat, lon, ts}` and drops the rest.
fn tail_json(p: &TailPoint) -> Value {
    json!({
        "lat": row_json::js_number_value(p.lat),
        "lon": row_json::js_number_value(p.lon),
        "ts": p.ts,
    })
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
            // ⚠ `failed_devices` is NOT surfaced to the caller, matching the
            // TypeScript, which warns per device and answers 200 either way. It
            // IS logged with a count, so a short day can be explained after the
            // fact rather than looking like a quiet day.
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
    // ⚠ TODAY, not a requested date. See the module note.
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
        // ⚠ Yesterday AND today: a fix a minute after midnight would otherwise
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

    // ⚠ `Number(c.req.query("since") ?? 0)`: absent is 0, and anything
    // unparseable is NaN — against which EVERY `p.ts > since` is false, so the
    // TypeScript answers an empty tail rather than the whole buffer. Mapping a
    // bad value to 0 here would do the opposite and dump 2000 points.
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
                    return nc_error_response(&e, json!([]), "tail fetch failed");
                }
            }
        }
    };

    let Some(since) = since else {
        // NaN: every comparison is false, so the tail is empty.
        return Json(Vec::<Value>::new()).into_response();
    };
    let out: Vec<Value> = location_cache::tail_after(&buffered, since)
        .iter()
        .map(tail_json)
        .collect();
    Json(out).into_response()
}

fn internal(e: &anyhow::Error) -> Response {
    tracing::error!(error = %e, "location route failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "internal" })),
    )
        .into_response()
}
