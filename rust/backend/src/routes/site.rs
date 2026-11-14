//! Everything the browser needs that is not the API.
//!
//! The built Angular app, the two unauthenticated status endpoints, and the
//! SPA fallback. No decisions here: it is entirely plumbing.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
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
/// Unauthenticated, since it is curled when sign-in may be broken; it names no
/// user or place.
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

    // One failed probe fails the whole detail block rather than reporting
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

/// `GET /version` — the commit the running image was built from. Outside
/// `/api` and sessionless, so the footer can show a stale client even when the
/// session is what is broken.
pub async fn version() -> Response {
    Json(json!({
        "sha": std::env::var("GIT_SHA").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "dev".into()),
    }))
    .into_response()
}

/// ⚠ HTML must revalidate. With no `Cache-Control` a client caches
/// heuristically and may never re-ask: a WebView ran a build several deploys
/// old, which looks like a failed deploy. `no-cache` still allows a 304 via ETag.
///
/// Only text/html, and only when nothing has spoken: this layer sees API
/// responses too. Files are decided by [`cache_for`].
pub async fn html_must_revalidate(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    if res.headers().contains_key(header::CACHE_CONTROL) {
        return res;
    }
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if let Some(value) = cache_for(&path, content_type, res.status()) {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
}

/// What a response that said nothing about caching should say: the page
/// revalidates; a file (a dot in the last segment) is `immutable` when its name
/// carries a content hash, else revalidates; errors and API answers are left.
pub fn cache_for(path: &str, content_type: &str, status: StatusCode) -> Option<&'static str> {
    if content_type.starts_with("text/html") {
        return Some("no-cache");
    }
    if status.is_client_error() || status.is_server_error() {
        return None;
    }
    let name = path.rsplit('/').next().unwrap_or("");
    if !name.contains('.') {
        return None;
    }
    Some(if is_content_hashed(name) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    })
}

/// A name carrying its content hash (`main-7GNM4EPX.js`, a font's `-ABCD1234`):
/// a new build is a new name, so it may be cached for ever.
fn is_content_hashed(name: &str) -> bool {
    let Some((stem, _ext)) = name.rsplit_once('.') else {
        return false;
    };
    let Some((_, hash)) = stem.rsplit_once('-') else {
        return false;
    };
    hash.len() == 8
        && hash
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

/// The landing page shown at the root when no Angular build is present, so a
/// broken image says which build state it is in.
///
/// Every other path is a 404, or a missing font or script would get a 200
/// HTML page, an error neither side reports. The root stays 200:
/// `tests/suite/compression.rs` uses this body.
pub async fn fallback_page(uri: axum::http::Uri) -> Response {
    if uri.path() != "/" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<h1>Health Dashboard</h1><p>No frontend build is present in this image.</p>\
         <p><a href=\"/login\">Sign in with Nextcloud</a></p>",
    )
        .into_response()
}
