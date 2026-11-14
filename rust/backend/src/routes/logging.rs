//! The two endpoints that write to the log and nowhere else: `/telemetry`
//! (what a person did in the browser) and `/client-log` (what broke). Both
//! answer 204; the client neither reads nor retries.
//!
//! ⚠ The client writes into evidence: a newline in a label would forge lines,
//! so `Verified.LogLine.oneLine` (called, not reimplemented) is this file's
//! security boundary.
//!
//! `actor=` beside `user=`: a share recipient's session carries the owner's
//! id, and a log that silently attributes their clicks to the owner lies.
//!
//! A per-batch cap stops a log flood, a per-label cap a bloated line. Events
//! past the cap are dropped silently.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::Value;

use crate::auth::session::UserSession;
use crate::error::ErrorBody;
use crate::lean;
use crate::state::AppState;

/// Most events one POST may log.
const MAX_EVENTS: usize = 100;
/// Most code points one label may contribute to a line.
const MAX_LABEL: i64 = 160;
/// Most UTF-16 units of `event` a client-log line may carry.
const MAX_EVENT_NAME: usize = 100;
/// Most UTF-16 units of serialised `data`.
const MAX_DATA: usize = 4000;

/// `"owner"` or `"share"`.
fn actor_of(session: &UserSession) -> &'static str {
    if session.share_viewer.is_some() {
        "share"
    } else {
        "owner"
    }
}

/// Truncate to `max_units` UTF-16 code units, as the client counts `event` and
/// `data` (`oneLine`'s cap counts code points). Where the cut would split a
/// surrogate pair this stops one character early, since a `String` cannot
/// hold a lone surrogate.
fn truncate_utf16(s: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > max_units {
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

/// `String(x ?? "")` for a JSON value: missing and `null` become `""`, numbers
/// render by the wire's number rule.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n
            .as_f64()
            .map(|f| match crate::row_json::js_number_value(f) {
                Value::Number(x) => x.to_string(),
                other => other.to_string(),
            })
            .unwrap_or_default(),
        // `String([1,2])` is "1,2" and `String({})` is "[object Object]". Neither
        // is worth reproducing for a log field nobody sends objects in; they are
        // rendered as JSON so the line still says what arrived.
        Some(other) => other.to_string(),
    }
}

/// `POST /telemetry` — what a person did. Always 204.
pub async fn telemetry(
    State(_st): State<AppState>,
    Extension(session): Extension<UserSession>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(Json(body)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "invalid json".to_string(),
            }),
        )
            .into_response();
    };
    let Some(events) = body.as_array() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "expected array".to_string(),
            }),
        )
            .into_response();
    };

    let actor = actor_of(&session);
    for raw in events.iter().take(MAX_EVENTS) {
        // A non-object element is skipped, not rejected. One malformed event
        // must not discard the batch around it.
        let Some(obj) = raw.as_object() else { continue };
        let kind = js_string(obj.get("kind"));
        let path = js_string(obj.get("path"));
        let at = js_string(obj.get("at"));
        // The flattening. See the module note on why this is a boundary.
        let label = match lean::one_line(&js_string(obj.get("label")), MAX_LABEL) {
            Ok(l) => l,
            Err(e) => {
                // Refuse to log the line rather than log an unflattened label:
                // the whole point is that this text cannot be trusted raw.
                tracing::error!(error = %e, "oneLine failed; dropping a telemetry event");
                continue;
            }
        };
        let at = if at.is_empty() { "0".to_string() } else { at };
        tracing::info!(
            "client-event user={} actor={actor} kind={kind} path={path} label={label} at={at}",
            session.user_id
        );
    }
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /client-log` — what broke. Always 204.
pub async fn client_log(
    State(_st): State<AppState>,
    Extension(session): Extension<UserSession>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(Json(body)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "invalid json".to_string(),
            }),
        )
            .into_response();
    };
    // An array is accepted here while `/telemetry` requires one, deliberately
    // kept: a client sending one gets a 204 and a log line.
    if !body.is_object() && !body.is_array() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "expected object".to_string(),
            }),
        )
            .into_response();
    }

    let event = truncate_utf16(&js_string(body.get("event")), MAX_EVENT_NAME);
    let data = body.get("data");
    let data_str = match data {
        None => String::new(),
        Some(v) => match serde_json::to_string(v) {
            Ok(s) => truncate_utf16(&s, MAX_DATA),
            // Loud: a value just parsed should re-serialise, and a silent ""
            // would hide lost data. The line still goes out, incomplete.
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "client-log data could not be re-serialised; the line below is MISSING its data"
                );
                String::new()
            }
        },
    };

    // ⚠ Not flattened: `/client-log` can still inject newlines into the log.
    // Flattening would change what production logs, so it is recorded here
    // rather than fixed.
    if data_str.is_empty() {
        tracing::info!("[client/{}] {event}", session.user_id);
    } else {
        tracing::info!("[client/{}] {event} {data_str}", session.user_id);
    }
    StatusCode::NO_CONTENT.into_response()
}
