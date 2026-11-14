//! The two endpoints that write to the log and nowhere else: `/telemetry`
//! (what a person did in the browser) and `/client-log` (what broke). Both
//! answer 204; the client neither reads nor retries.
//!
//! ⚠ The client writes into evidence: a newline in any field it sends would
//! forge lines, so every such field goes through `Verified.LogLine.oneLine`
//! (called, not reimplemented), this file's security boundary.
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
const MAX_LABEL: usize = 160;
/// Most code points of `kind`, `path` or `at`.
const MAX_FIELD: usize = 200;
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

/// One client-sent field, flattened to a single line of at most `max` code
/// points.
fn flat(raw: &str, max: usize) -> anyhow::Result<String> {
    lean::one_line(raw, i64::try_from(max)?)
}

/// The log line for one telemetry event, or `None` for a non-object element.
/// Every client-sent field is flattened; an error means the line must not be
/// written.
pub fn telemetry_line(user_id: &str, actor: &str, event: &Value) -> anyhow::Result<Option<String>> {
    let Some(obj) = event.as_object() else {
        return Ok(None);
    };
    let field = |k: &str, max: usize| flat(&js_string(obj.get(k)), max);
    let kind = field("kind", MAX_FIELD)?;
    let path = field("path", MAX_FIELD)?;
    let label = field("label", MAX_LABEL)?;
    let at = field("at", MAX_FIELD)?;
    let at = if at.is_empty() { "0".to_string() } else { at };
    Ok(Some(format!(
        "client-event user={user_id} actor={actor} kind={kind} path={path} label={label} at={at}"
    )))
}

/// The log line for one `/client-log` body: `event` and the serialised `data`,
/// both flattened (JSON escapes `\n` but not U+2028 or bidi overrides).
pub fn client_log_line(user_id: &str, body: &Value) -> anyhow::Result<String> {
    let event = flat(
        &truncate_utf16(&js_string(body.get("event")), MAX_EVENT_NAME),
        MAX_EVENT_NAME,
    )?;
    let data = match body.get("data") {
        None => String::new(),
        Some(v) => match serde_json::to_string(v) {
            Ok(s) => flat(&truncate_utf16(&s, MAX_DATA), MAX_DATA)?,
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
    Ok(if data.is_empty() {
        format!("[client/{user_id}] {event}")
    } else {
        format!("[client/{user_id}] {event} {data}")
    })
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
        match telemetry_line(&session.user_id, actor, raw) {
            Ok(Some(line)) => tracing::info!("{line}"),
            // A non-object element is skipped, not rejected: one malformed
            // event must not discard the batch around it.
            Ok(None) => {}
            // Refuse the line rather than log unflattened client text.
            Err(e) => tracing::error!(error = %e, "oneLine failed; dropping a telemetry event"),
        }
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

    match client_log_line(&session.user_id, &body) {
        Ok(line) => tracing::info!("{line}"),
        Err(e) => tracing::error!(error = %e, "oneLine failed; dropping a client-log line"),
    }
    StatusCode::NO_CONTENT.into_response()
}
