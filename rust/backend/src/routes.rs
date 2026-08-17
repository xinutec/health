//! The HTTP surface.
//!
//! ⚠ THIS IS NOT SERVING PRODUCTION AND MUST NOT BE POINTED AT IT YET. The
//! TypeScript `src/server.ts` owns every route; this is the axum skeleton the
//! `/api` port lands on, plus the two endpoints that need no logic at all.
//!
//! # Nothing in this file decides anything
//!
//! That is the standing rule for the crate (`lib.rs`), and routes are where it
//! erodes first: a handler that "just" clamps a query parameter has taken a
//! decision, and the next reader finds the rule here rather than in Lean. So a
//! handler in this file may parse, call, and serialise — nothing else. Where a
//! decision is needed it comes from `verified_cli`/the Lean host, the way
//! `shareableDateRange` now does.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::error::AppResult;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(state)
}

/// Liveness: the process is up. No database, on purpose — a liveness probe that
/// touches the DB restarts a healthy pod when the database hiccups, which turns
/// one outage into two.
async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// Readiness: this pod can serve, which means it can reach the database.
///
/// `SELECT 1` and not a table read: readiness is about the connection, and a
/// probe that reads a table starts failing when that table is migrating.
async fn readyz(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let one: i64 = sqlx::query_scalar("SELECT 1").fetch_one(&st.pool).await?;
    Ok(Json(json!({ "status": "ok", "db": one })))
}
