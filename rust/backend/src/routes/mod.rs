//! The HTTP surface.
//!
//! ⚠ THIS IS NOT SERVING PRODUCTION AND MUST NOT BE POINTED AT IT YET. The
//! TypeScript `src/server.ts` owns every route; this is the axum skeleton the
//! `/api` port lands on, plus the two endpoints that need no logic at all.
//!
//! ⚠ Pointing this at production is also #413's re-bless, and that is a
//! DECISION rather than a deploy step. `/velocity` answers from the OSM mirror
//! through Lean rather than MariaDB's `ORDER BY ST_Distance … LIMIT 50`.
//!
//! ⚠ Whether that changes served labels is UNMEASURED. #413 records 0 of 315
//! timeline states differing for the oracle swap alone; step 4 separately
//! predicts 9 queries where `LIMIT 50` displacement loses a named street, which
//! is the part this source removes. Read the diff against those predictions —
//! do not assume either that nothing moves or that everything does.
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

pub mod locations;
pub mod me;
pub mod tables;
pub mod velocity;

pub fn router(state: AppState) -> Router {
    // ⚠ THE LAYER ORDER IS THE SECURITY BOUNDARY, and axum applies layers
    // BOTTOM-UP: the last `.layer` runs FIRST. So `require_session` is written
    // below `require_may_proceed` and runs before it.
    //
    // ⚠ REVERSING THEM IS HARMLESS TODAY AND WILL NOT BE. Measured, not assumed:
    // flipping the two changes no test, because this group holds one GET route
    // and an anonymous GET is refused by `require_session` either way.
    //
    // It bites the moment a POST route lands here. `require_may_proceed` reads
    // the session out of the request extensions and `require_session` is what
    // puts it there — run the wrong way round, a share viewer's POST is judged
    // before their session exists, looks anonymous, is therefore NOT a share
    // viewer, and is allowed. A read-only link would be able to write.
    //
    // `tests/velocity_route.rs` mirrors this stack with a write route so the
    // invariant has a test before the route that needs it exists.
    let api = Router::new()
        .route("/me", get(me::handler))
        .route("/velocity", get(velocity::handler))
        // The ten table reads. Every one of these is inside the authenticated
        // group; a share recipient reaches them too, and what they may see is
        // capped per endpoint rather than here (see `routes::tables`).
        .route("/activity", get(tables::activity))
        .route("/sleep", get(tables::sleep))
        .route("/sleep/stages", get(tables::sleep_stages))
        .route("/heartrate/zones", get(tables::heartrate_zones))
        .route("/heartrate/intraday", get(tables::heartrate_intraday))
        .route("/body", get(tables::body))
        .route("/spo2", get(tables::spo2))
        .route("/hrv", get(tables::hrv))
        .route("/breathing", get(tables::breathing))
        .route("/temperature", get(tables::temperature))
        .route("/devices", get(tables::devices))
        .route("/sync-state", get(tables::sync_state))
        // ⚠ The live-map group. All three check the share window against TODAY
        // rather than a requested date — see `routes::locations`.
        .route("/locations", get(locations::locations))
        .route("/location/latest", get(locations::latest))
        .route("/location/tail", get(locations::tail))
        .layer(axum::middleware::from_fn(
            crate::auth::middleware::require_may_proceed,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::middleware::require_session,
        ));

    Router::new()
        // ⚠ Liveness and readiness are OUTSIDE the authenticated group. A probe
        // that needs a session cannot report a pod whose session table is
        // broken, which is exactly when the answer matters.
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .nest("/api", api)
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
