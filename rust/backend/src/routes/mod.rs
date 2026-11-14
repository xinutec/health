//! The HTTP surface of `health.xinutec.org`: the SPA shell, the static build
//! and every `/api` route.
//!
//! Handlers parse, call and serialise, nothing else (the crate rule in
//! `lib.rs`): a decision, even clamping a parameter, comes from Lean, as
//! `shareableDateRange` does.

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
pub mod site;
pub mod tables;
pub mod velocity;

pub fn router(state: AppState) -> Router {
    // ⚠ The layer order is the security boundary. Axum applies layers
    // bottom-up, so `require_session`, written below `require_may_proceed`,
    // runs first and puts the session where `require_may_proceed` reads it.
    // Reversed, a share viewer's POST would look anonymous and be allowed.
    // `require_may_proceed` refuses a missing session with a 500, and
    // `tests/suite/share_route.rs` asserts the order through this router.
    let api = Router::new()
        .route("/me", get(me::handler))
        .route("/velocity", get(velocity::handler))
        // The ten table reads. Every one of these is inside the authenticated
        // group; a share recipient reaches them too, and what they may see is
        // capped per endpoint rather than here (see `routes::tables`).
        .route("/activity", get(tables::activity))
        .route("/sleep", get(tables::sleep))
        .route("/day", get(tables::day))
        .route("/sleep/stages", get(tables::sleep_stages))
        .route("/heartrate/zones", get(tables::heartrate_zones))
        .route("/heartrate/intraday", get(tables::heartrate_intraday))
        .route("/heartrate/rest", get(tables::heartrate_rest))
        .route("/body", get(tables::body))
        .route("/body/before", get(tables::body_before))
        .route("/spo2", get(tables::spo2))
        .route("/hrv", get(tables::hrv))
        .route("/breathing", get(tables::breathing))
        .route("/temperature", get(tables::temperature))
        .route("/sync-state", get(tables::sync_state))
        // The live-map group. All three check the share window against today
        // rather than a requested date — see `routes::locations`.
        .route("/locations", get(locations::locations))
        .route("/location/latest", get(locations::latest))
        .route("/location/tail", get(locations::tail))
        // ⚠ `/telemetry` is the one write a share recipient may make: it only
        // logs what a recipient saw. `Verified.Session.mayProceed` names it.
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

    Router::new()
        // Liveness and readiness are outside the authenticated group. A probe
        // that needs a session cannot report a pod whose session table is
        // broken, which is exactly when the answer matters.
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Signing in cannot require being signed in. These three are the only
        // unauthenticated non-probe routes, and `/auth/callback` is where a
        // session is minted.
        .route("/login", get(oauth::login))
        .route("/auth/callback", get(oauth::callback))
        .route("/logout", axum::routing::post(oauth::logout))
        // Service-to-service, gated by a shared secret, not a session; an empty
        // token list rejects everything. Composed here so `DL-WIRE-ROUTE-DRIFT`
        // can resolve the route table. The phone authenticates with the URL
        // token plus Basic auth in the handler.
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
        // Unauthenticated: `/health` is curled when sign-in may be broken, and
        // `/version` shows a stale client in the footer.
        // dev-lint: allow-unauthenticated-route what an operator curls when sign-in is broken (above)
        .route("/health", get(site::health))
        // dev-lint: allow-unauthenticated-route the build sha, for the footer's stale-client check
        .route("/version", get(site::version))
        .with_state(state)
        // The SPA's routes are served the shell, so a deep link loads the app.
        // Listed, not a catch-all: a missing .js must 404, not become HTML.
        .route_service("/settings", index_html())
        .route_service("/settings/{*rest}", index_html())
        .route_service("/share/{token}", index_html())
        // The built Angular app, with the landing page when no build is present.
        .fallback_service(
            tower_http::services::ServeDir::new(public_dir())
                .fallback(axum::routing::get(site::fallback_page)),
        )
        // Runs over everything, including the API — see the note on why it
        // only ever touches text/html.
        .layer(axum::middleware::from_fn(site::html_must_revalidate))
        // Outermost (layers apply bottom-up), so it compresses every body.
        // Intraday heart rate is megabytes of repeated `user_id` and `tz`.
        // Content-negotiated, so a client without `Accept-Encoding` gets the
        // identity body.
        .layer(tower_http::compression::CompressionLayer::new())
}

/// Where the built frontend lives. `PUBLIC_DIR` overrides it so a dev run can
/// point at a local build without moving files around.
fn public_dir() -> String {
    std::env::var("PUBLIC_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "./public".to_string())
}

/// The SPA shell, for the routes Angular owns.
fn index_html() -> tower_http::services::ServeFile {
    tower_http::services::ServeFile::new(format!("{}/index.html", public_dir()))
}

/// Liveness: the process is up. No database, on purpose — a liveness probe that
/// touches the DB restarts a healthy pod when the database hiccups, which turns
/// one outage into two.
async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// Readiness: this pod can reach the database. `SELECT 1`, not a table read,
/// so a migrating table does not fail the probe.
async fn readyz(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let one: i64 = sqlx::query_scalar("SELECT 1").fetch_one(&st.pool).await?;
    Ok(Json(json!({ "status": "ok", "db": one })))
}
