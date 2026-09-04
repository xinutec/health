//! The two endpoints that write to the log and nowhere else (#982).
//!
//! `/telemetry` records what a person did — navigations and taps the browser
//! sees and the API does not. `/client-log` records what broke. Neither stores
//! anything: these are LOGS, not data, and both answer 204 because the client
//! neither reads the response nor retries.
//!
//! # ⚠ The log is evidence, and the client can write to it
//!
//! A label is verbatim UI text placed into a line as `label=…`. A newline
//! inside it forges WHOLE LINES, including further `client-event` lines
//! attributed to someone else — so the flattening in
//! `Verified.LogLine.oneLine` is the security boundary of this file, not
//! tidiness. It is called rather than reimplemented, because it depends on
//! Unicode tables derived from V8.
//!
//! # ⚠ `user=` and `actor=` are different questions
//!
//! A share recipient's session carries the OWNER's user id — that is how the
//! link grants read access. Logging `user=` alone would attribute a stranger's
//! clicks to the owner, which is worse than not logging them: a gap in a log is
//! visible, a lie in one is not.
//!
//! # The caps
//!
//! A per-batch cap so one POST cannot become a log flood, and a per-label cap
//! so one event cannot bloat a line. ⚠ Events past the cap are DROPPED
//! silently, matching the TypeScript — a client sending 200 events is told
//! nothing about the 100 that vanished.

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

/// `"owner"` or `"share"` — the TypeScript's `actorOf`.
fn actor_of(session: &UserSession) -> &'static str {
    if session.share_viewer.is_some() {
        "share"
    } else {
        "owner"
    }
}

/// `String.prototype.slice(0, n)`, which counts UTF-16 CODE UNITS.
///
/// ⚠ NOT code points — unlike `oneLine`'s cap, which does. The TypeScript uses
/// two different truncations in the same file and this is the faithful one for
/// `event` and `data`.
///
/// ⚠ ONE DELIBERATE DIVERGENCE. JavaScript will cut a surrogate PAIR in half
/// and emit a lone surrogate; a Rust `String` cannot hold one, so this stops at
/// the last whole character instead. The difference is at most one character at
/// the very end of an over-long log field, and the alternative is unrepresentable
/// rather than merely different.
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

/// `String(x ?? "")` for a JSON value, as the TypeScript coerces it.
///
/// ⚠ A missing field and an explicit `null` both become `""`, and a NUMBER
/// becomes its JS rendering — which is why this goes through the same number
/// rule the wire uses rather than through `serde_json`'s.
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
        // ⚠ A non-object element is SKIPPED, not rejected. One malformed event
        // must not discard the batch around it.
        let Some(obj) = raw.as_object() else { continue };
        let kind = js_string(obj.get("kind"));
        let path = js_string(obj.get("path"));
        let at = js_string(obj.get("at"));
        // ⚠ The flattening. See the module note on why this is a boundary.
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
    // ⚠ An ARRAY is refused here while `/telemetry` requires one. `typeof [] is
    // "object"` in JavaScript, so the TypeScript's `typeof body !== "object"`
    // ACCEPTS an array — reproduced rather than tightened, since a client
    // sending one currently gets a 204 and a log line.
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
            // ⚠ LOUD, not silent. This is a value that just came off the wire as
            // JSON, so re-serialising it should be impossible to fail — which is
            // exactly why a quiet empty string here would be the wrong answer:
            // the log would show an event with no data and nothing would say the
            // data had been lost rather than absent. The line still goes out,
            // because dropping a diagnostic report over its payload would be
            // worse than reporting it incomplete.
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "client-log data could not be re-serialised; the line below is MISSING its data"
                );
                String::new()
            }
        },
    };

    // ⚠ NOT flattened. This matches the TypeScript, and it means `/client-log`
    // can still inject newlines into the log where `/telemetry` cannot. It is
    // the same class of hole the flattening exists to close; closing it here
    // would change what production logs, so it is recorded rather than fixed.
    if data_str.is_empty() {
        tracing::info!("[client/{}] {event}", session.user_id);
    } else {
        tracing::info!("[client/{}] {event} {data_str}", session.user_id);
    }
    StatusCode::NO_CONTENT.into_response()
}
