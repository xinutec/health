//! The GPS track of a recorded workout, into `exercise_routes`.
//!
//! Google serves a session's route as a TCX document, one request per session
//! (`GET …/dataTypes/exercise/dataPoints/{id}:exportExerciseTcx?alt=media`,
//! `location.readonly`); `exercise_sessions.has_gps` says which have one. The
//! document is kept whole in `tcx`, with two census counts beside it.
//!
//! A route belongs to its session, so it is no roster stream and the freshness
//! census does not watch it. A refusal is stored (`http_status`, `tcx` NULL) so
//! each session is asked once, not every day against the quota.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// What the export answered for one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Export {
    /// A 2xx with the document.
    Tcx(String),
    /// A 4xx: the session has no route to export, or the request is refused.
    /// Recorded, never retried.
    Refused(u16),
}

/// The export URL for one session's point id.
#[must_use]
pub fn export_url(point_id: &str) -> String {
    format!(
        "{}/users/me/dataTypes/exercise/dataPoints/{point_id}:exportExerciseTcx?alt=media",
        super::health::BASE
    )
}

/// How many `<Trackpoint>` elements a TCX document has, by substring count (a
/// census figure): `<Trackpoint>` and `<Trackpoint ` both count.
#[must_use]
pub fn trackpoints(tcx: &str) -> usize {
    tcx.matches("<Trackpoint>").count() + tcx.matches("<Trackpoint ").count()
}

/// How many trackpoints carry a `<Position>` (a latitude and longitude). A
/// watch loses the fix under cover and keeps recording time and heart rate, so
/// this is at most [`trackpoints`] and usually less.
#[must_use]
pub fn positions(tcx: &str) -> usize {
    tcx.matches("<Position>").count()
}

/// Fetch one session's TCX. `Err` is a transport failure or a 5xx, worth
/// another day; a 4xx is [`Export::Refused`].
pub async fn fetch_tcx(
    http: &reqwest::Client,
    access_token: &str,
    point_id: &str,
) -> Result<Export> {
    let res = http
        .get(export_url(point_id))
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("GET exportExerciseTcx for {point_id}"))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .with_context(|| format!("body of the TCX export for {point_id}"))?;
    if status.is_success() {
        Ok(Export::Tcx(body))
    } else if status.is_client_error() {
        tracing::warn!(
            "exportExerciseTcx {point_id}: HTTP {} {}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        );
        Ok(Export::Refused(status.as_u16()))
    } else {
        anyhow::bail!(
            "exportExerciseTcx {point_id}: HTTP {} {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        )
    }
}

/// Sessions with GPS and no `exercise_routes` row yet, oldest first.
pub async fn sessions_without_route(pool: &MySqlPool, user_id: &str) -> Result<Vec<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT s.point_id FROM exercise_sessions s \
         LEFT JOIN exercise_routes r ON r.user_id = s.user_id AND r.point_id = s.point_id \
         WHERE s.user_id = ? AND s.has_gps = 1 AND r.point_id IS NULL \
         ORDER BY s.start_utc",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("listing sessions without a route")?;
    Ok(ids)
}

/// What one sync did: `(routes stored, refusals recorded)`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Synced {
    pub stored: usize,
    pub refused: usize,
    pub trackpoints: usize,
}

/// Fetch and store the route of every GPS session that has none, once: an edit
/// replaces the session row, not its route. `limit` bounds a run; `None` takes
/// every missing session, as the daily sync does.
pub async fn sync_routes(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
    limit: Option<usize>,
) -> Result<Synced> {
    let mut ids = sessions_without_route(pool, user_id).await?;
    if let Some(n) = limit {
        ids.truncate(n);
    }
    let mut out = Synced::default();
    for id in &ids {
        let (status, tcx) = match fetch_tcx(http, access_token, id).await? {
            Export::Tcx(t) => (200i32, Some(t)),
            Export::Refused(s) => (i32::from(s), None),
        };
        let (tp, pos) = tcx
            .as_deref()
            .map(|t| (trackpoints(t), positions(t)))
            .unzip();
        sqlx::query(
            "INSERT INTO exercise_routes \
             (user_id, point_id, fetched_at, http_status, bytes, trackpoints, positions, tcx) \
             VALUES (?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(id)
        .bind(status)
        .bind(tcx.as_deref().map_or(0, |t| t.len() as i64))
        .bind(tp.map(|n| n as i64))
        .bind(pos.map(|n| n as i64))
        .bind(&tcx)
        .execute(pool)
        .await
        .with_context(|| format!("writing exercise_routes for {id}"))?;
        if tcx.is_some() {
            out.stored += 1;
            out.trackpoints += tp.unwrap_or(0);
        } else {
            out.refused += 1;
        }
    }
    tracing::info!(
        "[{user_id}] google exercise_routes: {} stored ({} trackpoints), {} refused, of {} without a route",
        out.stored,
        out.trackpoints,
        out.refused,
        ids.len()
    );
    Ok(out)
}
