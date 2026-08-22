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

pub mod internal;
pub mod locations;
pub mod logging;
pub mod me;
pub mod nextcloud_connect;
pub mod oauth;
pub mod owntracks;
pub mod share;
pub mod tables;
pub mod velocity;

pub fn router(state: AppState) -> Router {
    // ⚠ THE LAYER ORDER IS THE SECURITY BOUNDARY, and axum applies layers
    // BOTTOM-UP: the last `.layer` runs FIRST. So `require_session` is written
    // below `require_may_proceed` and runs before it.
    //
    // ⚠ THE POST ROUTES HAVE LANDED, so this is live rather than latent.
    // `require_may_proceed` reads the session out of the request extensions and
    // `require_session` is what puts it there — run the wrong way round, a
    // share viewer's POST is judged before their session exists, looks
    // anonymous, is therefore NOT a share viewer, and is allowed. A read-only
    // link would be able to rotate, retune or revoke its owner's share.
    //
    // ⚠ THE ORDER IS NO LONGER PROTECTED BY CONVENTION ALONE.
    // `require_may_proceed` refuses outright when the session extension is
    // absent, so mounting these the wrong way round breaks EVERY request with a
    // 500 instead of quietly over-permitting one class of them.
    //
    // That guard exists because the previous protection did not work: flipping
    // these two on 2026-08-22 failed ZERO of the eleven tests that covered this,
    // since each mirrored the stack instead of importing it.
    // `tests/share_route.rs` now asserts it through THIS router.
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
        // ⚠ THE FIRST WRITE ROUTES HERE. The layer order below stops being
        // theoretical the moment these exist — see the note on it.
        // ⚠ `/telemetry` is the ONE write a share recipient may make — it
        // writes only to the log, and it is how anyone knows what a recipient
        // saw. `Verified.Session.mayProceed` names it explicitly, by EXACT path.
        .route("/telemetry", axum::routing::post(logging::telemetry))
        .route("/client-log", axum::routing::post(logging::client_log))
        .route(
            "/nextcloud/connect/init",
            axum::routing::post(nextcloud_connect::init),
        )
        .route("/nextcloud/connect/status", get(nextcloud_connect::status))
        .route(
            "/phonetrack/sync-filter",
            axum::routing::post(nextcloud_connect::sync_filter),
        )
        .route(
            "/share",
            get(share::get)
                .post(share::post)
                .patch(share::patch)
                .delete(share::delete),
        )
        .layer(axum::middleware::from_fn(
            crate::auth::middleware::require_may_proceed,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::middleware::require_session,
        ));

    // ⚠ Linking Fitbit needs a session ALREADY — it attaches an account to a
    // known user. `require_may_proceed` runs too, so a share recipient cannot
    // link their own Fitbit to the owner's account.
    let fitbit = Router::new()
        .route("/fitbit/auth", get(oauth::fitbit_auth))
        .route("/fitbit/callback", get(oauth::fitbit_callback))
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
        // ⚠ Signing IN cannot require being signed in. These three are the only
        // unauthenticated non-probe routes, and `/auth/callback` is where a
        // session is minted.
        .route("/login", get(oauth::login))
        .route("/auth/callback", get(oauth::callback))
        .route("/logout", axum::routing::post(oauth::logout))
        .merge(fitbit)
        // ⚠ Service-to-service, gated by a shared secret rather than a session.
        // An empty token list rejects everything, which is the default.
        //
        // ⚠ Composed HERE rather than behind a `router()` in that module, so
        // `DL-WIRE-ROUTE-DRIFT` can resolve the route table statically. A route
        // table nobody can check is how a path typo becomes a 404 in
        // production.
        // ⚠ The phone's own auth is the URL token plus Basic auth, checked in
        // the handler. No session: this comes from an Android app, not a
        // browser.
        .route(
            "/owntracks/{token}/{device}",
            axum::routing::post(owntracks::proxy),
        )
        .nest(
            "/internal",
            Router::new()
                .route("/places", get(internal::places))
                .route("/place/current", get(internal::place_current))
                .route("/recovery", get(internal::recovery))
                .route("/recovery/history", get(internal::recovery_history)),
        )
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
