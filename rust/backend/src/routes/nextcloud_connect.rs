//! Linking a Nextcloud account, and pointing PhoneTrack's map at today (#982).
//!
//! # Login Flow v2 is a THREE-party handshake
//!
//! Nextcloud's Login Flow v2 exists so a long-lived app password never passes
//! through this server's hands as a user secret. `POST init` asks Nextcloud for
//! a login URL and a poll token; the user opens that URL and approves in their
//! own browser; meanwhile this server polls the endpoint until Nextcloud hands
//! back the app password, which is stored and used for every later API call.
//!
//! ⚠ THE POLL RUNS IN THE BACKGROUND, so `init` returns immediately with a URL
//! the user must open. `status` is how the SPA learns the outcome. That makes
//! this the only genuinely STATEFUL pair of endpoints in the port: there is an
//! in-flight flow per user that outlives the request that started it.
//!
//! ⚠ The state is PROCESS-LOCAL and deliberately not persisted. A flow is
//! meaningless across a restart — the poll goroutine is gone, so a row saying
//! "pending" would be a lie no one could clear. A restart mid-link means the
//! user presses connect again, which is the correct recovery and needs no code.
//!
//! ⚠ A new `init` REPLACES any previous flow for that user. Two tabs racing
//! would otherwise leave a poll running against a token nobody will read.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::session::UserSession;
use crate::error::ErrorBody;
use crate::nextcloud::credentials::NcError;
use crate::state::AppState;
use crate::{lean, timezone};

/// How often to ask Nextcloud whether the user has approved yet.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
/// How long to keep asking. ⚠ A bound, not a formality: without it a user who
/// closes the tab leaves a task polling this server's upstream forever.
const POLL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// What a flow has come to.
#[derive(Clone, Debug)]
pub enum FlowResult {
    Pending,
    Ready { login_name: String },
    Failed { error: String },
}

/// In-flight Login Flow v2 state, one per user.
#[derive(Default)]
pub struct PendingFlows {
    flows: Mutex<HashMap<String, FlowResult>>,
}

impl PendingFlows {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(&self, user_id: &str, r: FlowResult) {
        if let Ok(mut f) = self.flows.lock() {
            f.insert(user_id.to_string(), r);
        }
    }

    /// Read the outcome, REMOVING it unless it is still pending.
    ///
    /// ⚠ Terminal states are read once. The SPA polls this, and leaving a
    /// `failed` behind would make the next attempt appear to fail instantly.
    fn take(&self, user_id: &str) -> Option<FlowResult> {
        let mut f = self.flows.lock().ok()?;
        match f.get(user_id)? {
            FlowResult::Pending => Some(FlowResult::Pending),
            _ => f.remove(user_id),
        }
    }
}

#[derive(Deserialize)]
struct Initiation {
    login: String,
    poll: Poll,
}

#[derive(Deserialize)]
struct Poll {
    token: String,
    endpoint: String,
}

#[derive(Deserialize)]
struct Approved {
    #[serde(rename = "loginName")]
    login_name: String,
    #[serde(rename = "appPassword")]
    app_password: String,
}

fn base_url(st: &AppState) -> String {
    st.cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string())
}

/// `POST /nextcloud/connect/init` — start the handshake.
pub async fn init(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    let url = format!("{}/index.php/login/v2", base_url(&st));
    let res = st
        .http
        .post(&url)
        // Nextcloud logs this against the created app password, so the user can
        // see what they authorised.
        .header("User-Agent", "health.xinutec.org")
        .send()
        .await;

    let initiation: Initiation = match res {
        Ok(r) if r.status().is_success() => match r.json().await {
            Ok(i) => i,
            Err(e) => {
                tracing::error!(error = %e, "NC login-flow init: unparseable response");
                return upstream_failed();
            }
        },
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            tracing::error!(user = %session.user_id, %status, %body, "NC login-flow init failed");
            return upstream_failed();
        }
        Err(e) => {
            tracing::error!(error = %e, "NC login-flow init: request failed");
            return upstream_failed();
        }
    };

    let login_url = initiation.login.clone();
    st.flows.set(&session.user_id, FlowResult::Pending);

    // ⚠ Detached, and it must be: `init` answers with a URL the user has not
    // opened yet, so the poll necessarily outlives this request.
    let flows = st.flows.clone();
    let http = st.http.clone();
    let pool = st.pool.clone();
    let user_id = session.user_id.clone();
    tokio::spawn(async move {
        let outcome = poll_until_approved(&http, &initiation).await;
        match outcome {
            Ok(creds) => {
                if let Err(e) = crate::nextcloud::credentials::store(
                    &pool,
                    &user_id,
                    &creds.login_name,
                    &creds.app_password,
                )
                .await
                {
                    tracing::error!(error = %format!("{e:#}"), user = %user_id, "storing NC credentials failed");
                    flows.set(
                        &user_id,
                        FlowResult::Failed {
                            error: "storing credentials failed".into(),
                        },
                    );
                    return;
                }
                tracing::info!(user = %user_id, login_name = %creds.login_name, "NC login-flow complete");
                flows.set(
                    &user_id,
                    FlowResult::Ready {
                        login_name: creds.login_name,
                    },
                );
            }
            Err(e) => {
                tracing::warn!(user = %user_id, error = %e, "NC login-flow failed");
                flows.set(&user_id, FlowResult::Failed { error: e });
            }
        }
    });

    Json(json!({ "loginUrl": login_url })).into_response()
}

/// Ask until Nextcloud says yes, the deadline passes, or it says something
/// unrecoverable.
///
/// ⚠ A 404 is the NORMAL not-yet answer from this endpoint, not an error.
async fn poll_until_approved(
    http: &reqwest::Client,
    init: &Initiation,
) -> Result<Approved, String> {
    let deadline = std::time::Instant::now() + POLL_DEADLINE;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("login flow timed out".into());
        }
        let res = http
            .post(&init.poll.endpoint)
            .form(&[("token", &init.poll.token)])
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {
                return r
                    .json::<Approved>()
                    .await
                    .map_err(|e| format!("login flow: unparseable approval: {e}"));
            }
            // Still waiting for the user.
            Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {}
            Ok(r) => return Err(format!("login flow: upstream said {}", r.status())),
            Err(e) => return Err(format!("login flow: {e}")),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn upstream_failed() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": "nextcloud_init_failed" })),
    )
        .into_response()
}

/// `GET /nextcloud/connect/status` — has the user approved yet?
pub async fn status(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
) -> Response {
    let body = match st.flows.take(&session.user_id) {
        // ⚠ `idle` is not `failed`. No flow means none was started (or the
        // outcome was already collected), and the SPA renders the connect
        // button rather than an error.
        None => json!({ "state": "idle" }),
        Some(FlowResult::Pending) => json!({ "state": "pending" }),
        Some(FlowResult::Ready { login_name }) => {
            json!({ "state": "ready", "loginName": login_name })
        }
        Some(FlowResult::Failed { error }) => json!({ "state": "failed", "error": error }),
    };
    Json(body).into_response()
}

#[derive(Deserialize)]
pub struct TzParams {
    tz: Option<String>,
}

/// `POST /phonetrack/sync-filter` — point PhoneTrack's map at the current day.
///
/// ⚠ "Current day" is not the calendar day. Before 06:00 local the window still
/// starts yesterday, because a night out belongs to the evening it began —
/// `Verified.PhoneTrackPrefs`.
pub async fn sync_filter(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<TzParams>,
) -> Response {
    // An unknown zone is refused rather than defaulted: silently using UTC
    // would move the 06:00 boundary and the caller would never know.
    let tz = p.tz.as_deref().unwrap_or("UTC");
    if tz.parse::<chrono_tz::Tz>().is_err() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "tz is not a known IANA timezone".to_string(),
            }),
        )
            .into_response();
    }

    match sync_filter_run(&st, &session.user_id, tz).await {
        Ok(datemin) => Json(SyncFilterResponse { ok: true, datemin }).into_response(),
        Err(e) => match e.downcast_ref::<NcError>() {
            // ⚠ 412, not 409: "you never linked an account" is a precondition
            // the user can satisfy, and the SPA shows the connect prompt.
            Some(NcError::NotLinked) => (
                StatusCode::PRECONDITION_FAILED,
                Json(ErrorBody {
                    error: "nextcloud_not_linked".to_string(),
                }),
            )
                .into_response(),
            Some(NcError::ReauthRequired) => (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "nextcloud_reauth_required".to_string(),
                }),
            )
                .into_response(),
            _ => {
                tracing::error!(error = %format!("{e:#}"), user = %session.user_id, "sync-filter failed");
                (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody {
                        error: "phonetrack sync-filter failed".to_string(),
                    }),
                )
                    .into_response()
            }
        },
    }
}

/// `POST /phonetrack/sync-filter`'s answer.
///
/// ⚠ `datemin` is an `i64` epoch second, and that is why this needed no special
/// number handling: integers are exact in both serde and `JSON.stringify`. A
/// FLOAT column would not be — see `row_json::js_number_value`, and #1404 for
/// the routes that carry them.
#[derive(Serialize)]
pub struct SyncFilterResponse {
    pub ok: bool,
    pub datemin: i64,
}

async fn sync_filter_run(st: &AppState, user_id: &str, tz: &str) -> anyhow::Result<i64> {
    let now = chrono::Utc::now().timestamp();
    let local_date = timezone::local_date_at(now, Some(tz))?;
    let local_hour = timezone::local_hour_of(now, tz)?;
    let (y, m, d) = parse_ymd(&local_date)?;
    let start_date = lean::phonetrack_datemin(y, m, d, i64::from(local_hour))?;
    let datemin = timezone::date_bounds_utc(&start_date, Some(tz))?.start_utc;

    let client = crate::nextcloud::client::NextcloudClient::connect(
        st.http.clone(),
        &st.pool,
        &base_url(st),
        user_id,
    )
    .await?;
    // ⚠ `applyfilters` must be the literal STRING "true". PhoneTrack's frontend
    // compares it with `!==  'true'`, so "1" or a JSON boolean silently turns
    // the filter off — verified against its source, not guessed.
    let values = json!({
        "applyfilters": "true",
        "datemin": datemin.to_string(),
        "timestampmin": datemin.to_string(),
    });
    client
        .put(
            &st.pool,
            "/index.php/apps/phonetrack/saveOptionValues",
            &json!({ "values": values }),
        )
        .await?;
    Ok(datemin)
}

fn parse_ymd(date: &str) -> anyhow::Result<(i64, i64, i64)> {
    let mut it = date.split('-');
    let y = it.next().and_then(|s| s.parse().ok());
    let m = it.next().and_then(|s| s.parse().ok());
    let d = it.next().and_then(|s| s.parse().ok());
    match (y, m, d) {
        (Some(y), Some(m), Some(d)) => Ok((y, m, d)),
        _ => anyhow::bail!("not a YYYY-MM-DD date: {date}"),
    }
}
