//! Everything the browser needs that is not the API (#982).
//!
//! The built Angular app, the two unauthenticated status endpoints, and the
//! SPA fallback. No decisions here — it is entirely plumbing, and it is the
//! part of the old TypeScript server that had nothing to port but itself.

use axum::Json;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;

use crate::state::AppState;

#[derive(Deserialize)]
pub struct HealthParams {
    detail: Option<String>,
}

/// `GET /health` — `ok` as plain text, or a JSON picture with `?detail=1`.
///
/// ⚠ Unauthenticated, and it stays that way: this is what an operator curls
/// when the dashboard is broken, which is exactly when a login might be too.
/// Nothing here names a user or a place — counts, a latency and a date.
pub async fn health(
    State(st): State<AppState>,
    axum::extract::Query(p): axum::extract::Query<HealthParams>,
) -> Response {
    if p.detail.is_none() {
        return "ok".into_response();
    }

    let started = std::time::Instant::now();
    let mut db_ok = false;
    let mut focus_places: Option<i64> = None;
    let mut osm_cache: Option<i64> = None;
    let mut last_sync: Option<String> = None;

    // ⚠ One failed probe fails the WHOLE detail block rather than reporting
    // some counts and a silent gap. A partial answer here reads as a healthy
    // system with an empty table.
    match probe(&st).await {
        Ok((fp, oc, ls)) => {
            focus_places = Some(fp);
            osm_cache = Some(oc);
            last_sync = ls;
            db_ok = true;
        }
        Err(e) => tracing::error!(error = %format!("{e:#}"), "/health detail failed"),
    }

    Json(json!({
        "ok": db_ok,
        "dbLatencyMs": if db_ok { started.elapsed().as_millis() as i64 } else { -1 },
        "focusPlacesCount": focus_places,
        "osmCacheCount": osm_cache,
        "lastSyncDate": last_sync,
        "uptimeSec": st.started.elapsed().as_secs() as i64,
    }))
    .into_response()
}

async fn probe(st: &AppState) -> anyhow::Result<(i64, i64, Option<String>)> {
    let fp: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM focus_places")
        .fetch_one(&st.pool)
        .await?;
    let oc: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM osm_cache")
        .fetch_one(&st.pool)
        .await?;
    let ls: Option<String> = sqlx::query(
        "SELECT value FROM sync_state WHERE key_name = 'last_sync_date' \
         ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(&st.pool)
    .await?
    .map(|r| r.try_get("value"))
    .transpose()?;
    Ok((fp, oc, ls))
}

/// `GET /version` — the commit the running image was built from.
///
/// ⚠ Deliberately OUTSIDE `/api`: the UI footer reads it to make a stale client
/// or a half-finished rollout visible at a glance, and a version endpoint that
/// needs a session cannot answer when the session is what is broken.
pub async fn version() -> Response {
    Json(json!({
        "sha": std::env::var("GIT_SHA").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "dev".into()),
    }))
    .into_response()
}

/// ⚠ HTML MUST REVALIDATE, and shipping without saying so cost a deploy nobody
/// could see.
///
/// With no `Cache-Control` at all a client falls back to HEURISTIC caching from
/// `Last-Modified` and may keep the document indefinitely without asking again.
/// Measured on the `messages` viewer 2026-08-14: an Android WebView fetched the
/// whole API and never once requested `main-*.js`, so the phone ran a build
/// several deploys old for hours. The symptom is "the change did not deploy",
/// which sends you to CI, the image and the rollout — all of them correct.
///
/// `no-cache` means "ask first", not "never keep": the ETag still turns the
/// usual case into a 304 with no body.
///
/// ⚠ ONLY text/html, AND ONLY when nothing has already spoken. This layer sees
/// every response including the API's, so an `else` branch stamping `immutable`
/// on whatever was left would put a year-long cache on JSON — the same bug
/// pointing the other way.
pub async fn html_must_revalidate(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut res = next.run(req).await;
    if res.headers().contains_key(header::CACHE_CONTROL) {
        return res;
    }
    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if is_html {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, "no-cache".parse().expect("literal"));
    }
    res
}

/// The landing page shown when no Angular build is present.
///
/// ⚠ A fallback for a broken image, not a feature. It says which build state
/// the pod is in rather than showing a blank page, which is the difference
/// between "the deploy is wrong" and "the app is broken".
pub async fn fallback_page() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<h1>Health Dashboard</h1><p>No frontend build is present in this image.</p>\
         <p><a href=\"/login\">Sign in with Nextcloud</a></p>",
    )
        .into_response()
}
