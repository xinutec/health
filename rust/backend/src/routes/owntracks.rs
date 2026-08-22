//! The Owntracks → PhoneTrack proxy, and the remote-config decision (#982).
//!
//! The phone posts every fix here on its way to PhoneTrack, and the response
//! carries a configuration patch telling it how hard to look for itself next
//! time. PhoneTrack stays the source of truth for location history — nothing is
//! duplicated here — but sitting in the path lets the decision use context the
//! phone cannot have: the user's mined places, and their recent trajectory.
//!
//! ⚠ THE FORWARD HAPPENS FIRST, AND ITS FAILURE IS FATAL TO THE REQUEST. Losing
//! a fix loses a piece of the timeline permanently; getting the config patch
//! wrong costs battery until the next fix, seconds later. So the proxy refuses
//! rather than answering with a patch it could not store the fix for.
//!
//! ⚠ Auth is the URL token plus the presence of Basic auth, checked BEFORE
//! anything upstream is touched. That protects Nextcloud's brute-force counters
//! and this process's own state maps from attacker-controlled growth.
//!
//! # Every response carries the full config, always
//!
//! There is no anti-flap timer, no per-device push memory, no "did this change"
//! dedup. The phone treats `setConfiguration` as idempotent, so pushing it every
//! time costs a few hundred bytes and means a state loss on EITHER side
//! recovers on the very next fix. State that can be lost is state that has to be
//! reasoned about; this design removes the question.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

use crate::lean;
use crate::state::AppState;

/// Owntracks payloads are tiny — a batched fix is well under 1 KB. Cap at 32 KB
/// so a misconfigured client cannot stream megabytes into the proxy.
const MAX_BODY_BYTES: usize = 32 * 1024;

/// How long a manual push pins the phone in Move mode.
///
/// ⚠ Ten minutes, and the reason is a specific day: 2026-06-07, home three
/// hours → demoted to Significant → a 14-minute gap walking out. The hold is
/// what stops stale "been here for hours" history overriding the one explicit
/// instruction the system ever receives.
const MANUAL_OVERRIDE_HOLD_SEC: i64 = 600;

/// Most distinct `(token, device)` keys retained.
///
/// ⚠ A cap, not a capacity estimate. One user populates one to three; a client
/// cycling device names would otherwise grow these maps without bound.
const MAX_STATE_KEYS: usize = 32;

#[derive(Deserialize, Debug)]
struct Location {
    lat: Option<f64>,
    lon: Option<f64>,
    tst: Option<i64>,
    vel: Option<f64>,
    acc: Option<f64>,
    cog: Option<f64>,
    t: Option<String>,
    m: Option<i64>,
}

/// Per-device proxy state. Process-local, and losing it is survivable by
/// construction — see the module note.
#[derive(Default)]
pub struct ProxyState {
    inner: Mutex<HashMap<String, DeviceState>>,
    /// Insertion order, for the LRU cap.
    order: Mutex<Vec<String>>,
}

#[derive(Default, Clone)]
struct DeviceState {
    history: Vec<StoredFix>,
    last_profile: Option<String>,
    manual_hold_until: i64,
}

#[derive(Clone)]
struct StoredFix {
    ts: i64,
    lat: f64,
    lon: f64,
    vel: Option<f64>,
    trigger: Option<String>,
    monitoring_mode: Option<i64>,
}

impl ProxyState {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &str) -> DeviceState {
        self.inner
            .lock()
            .ok()
            .and_then(|m| m.get(key).cloned())
            .unwrap_or_default()
    }

    /// Write back, promoting `key` to most-recently-used and evicting past the
    /// cap.
    fn put(&self, key: &str, st: DeviceState) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let Ok(mut order) = self.order.lock() else {
            return;
        };
        order.retain(|k| k != key);
        order.push(key.to_string());
        map.insert(key.to_string(), st);
        while order.len() > MAX_STATE_KEYS {
            let oldest = order.remove(0);
            map.remove(&oldest);
        }
    }
}

/// ⚠ Constant-time, and a length check first. These tokens are SECRETS — a
/// PhoneTrack session token is write access to someone's location history — and
/// an unauthenticated endpoint that leaks a prefix through timing invites
/// exactly the retry loop that exploits it. `contains` would be shorter and
/// would compare byte-by-byte with an early exit.
fn token_permitted(st: &AppState, given: &str) -> bool {
    use subtle::ConstantTimeEq;
    st.cfg
        .owntracks_tokens
        .iter()
        .any(|t| t.len() == given.len() && bool::from(t.as_bytes().ct_eq(given.as_bytes())))
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

/// `POST /owntracks/:token/:device`.
pub async fn proxy(
    State(st): State<AppState>,
    Path((token, device)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // ⚠ Both checks happen before ANY upstream call or state write.
    if !headers.contains_key(header::AUTHORIZATION) {
        return err(StatusCode::UNAUTHORIZED, "authorization required");
    }
    if !token_permitted(&st, &token) {
        return err(StatusCode::FORBIDDEN, "token not permitted");
    }
    if body.len() > MAX_BODY_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "payload too large");
    }
    let Ok(raw) = std::str::from_utf8(&body) else {
        return err(StatusCode::BAD_REQUEST, "invalid json");
    };
    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return err(StatusCode::BAD_REQUEST, "invalid json");
    };

    // ⚠ FORWARD FIRST. A fix that does not reach PhoneTrack is gone; a config
    // patch that is a few seconds late is not. Basic auth and User-Agent are
    // passed through so PhoneTrack authorises and attributes the real client.
    let base = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| crate::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let url = format!("{base}/apps/phonetrack/log/owntracks/{token}/{device}");
    let mut req = st.http.post(&url).body(body.clone());
    for h in [
        header::AUTHORIZATION,
        header::CONTENT_TYPE,
        header::USER_AGENT,
    ] {
        if let Some(v) = headers.get(&h) {
            req = req.header(h, v);
        }
    }
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, %token, "owntracks proxy: PhoneTrack POST failed");
            return err(StatusCode::BAD_GATEWAY, "upstream unreachable");
        }
    };
    if !upstream.status().is_success() {
        let status = upstream.status();
        tracing::warn!(%status, %token, "owntracks proxy: PhoneTrack rejected the fix");
        return err(StatusCode::BAD_GATEWAY, "upstream rejected");
    }

    // ⚠ Only messages with a full position contribute. A ping without
    // coordinates tells the decision nothing and would otherwise land in the
    // history as a fix at (0, 0).
    // ⚠ Every message that fails to parse is COUNTED AND LOGGED, not quietly
    // skipped. The fix is already stored upstream at this point, so a silent
    // drop here would leave the decision reading a shorter history than the
    // phone actually reported — which looks exactly like a phone that went
    // quiet, and would demote it.
    let mut unparsed = 0usize;
    let messages: Vec<Location> = match &payload {
        Value::Array(a) => a
            .iter()
            .filter_map(|m| match serde_json::from_value::<Location>(m.clone()) {
                Ok(loc) => Some(loc),
                Err(_) => {
                    unparsed += 1;
                    None
                }
            })
            .collect(),
        other => match serde_json::from_value::<Location>(other.clone()) {
            Ok(loc) => vec![loc],
            Err(_) => {
                unparsed += 1;
                Vec::new()
            }
        },
    };
    if unparsed > 0 {
        tracing::warn!(
            %device,
            unparsed,
            "owntracks: message(s) did not parse — the decision below sees a SHORTER history \
             than the phone reported"
        );
    }
    let new_fixes: Vec<StoredFix> = messages
        .iter()
        .filter_map(|m| match (m.lat, m.lon, m.tst) {
            (Some(lat), Some(lon), Some(ts)) => Some(StoredFix {
                ts,
                lat,
                lon,
                vel: m.vel,
                trigger: m.t.clone(),
                monitoring_mode: m.m,
            }),
            _ => None,
        })
        .collect();

    // ⚠ Best-effort, and deliberately after the forward: a database hiccup must
    // not cost the fix or the mode decision. Duplicates are ignored because
    // Owntracks re-POSTs.
    persist_motion(&st, &device, &messages).await;

    let now_ts = new_fixes
        .last()
        .map(|f| f.ts)
        .unwrap_or_else(|| chrono::Utc::now().timestamp());

    let key = format!("{token}/{device}");
    let mut dev = st.owntracks.get(&key);
    dev.history.extend(new_fixes);
    let cutoff = now_ts - lean::owntracks_history_max_age_sec();
    dev.history.retain(|f| f.ts >= cutoff);

    // ⚠ A manual push stamps the hold BEFORE the decision reads it, so the very
    // fix that asks for high frequency is already protected from demotion.
    if dev
        .history
        .last()
        .and_then(|f| f.trigger.as_deref())
        .is_some_and(|t| t == "u")
    {
        dev.manual_hold_until = now_ts + MANUAL_OVERRIDE_HOLD_SEC;
    }
    let manual_hold_active = dev.manual_hold_until > now_ts;

    let places = load_gating_places(&st, &device).await.unwrap_or_else(|e| {
        // ⚠ An empty list means "nowhere qualifies", so the gate refuses to
        // demote. That is the safe direction: a little extra battery rather
        // than a lost walk.
        tracing::warn!(error = %format!("{e:#}"), %device, "owntracks: gating places unavailable — demotion is off this fix");
        Vec::new()
    });

    let fixes: Vec<lean::OwntracksFix> = dev
        .history
        .iter()
        .map(|f| lean::OwntracksFix {
            ts: f.ts,
            lat: f.lat,
            lon: f.lon,
            vel: f.vel,
            trigger: f.trigger.clone(),
            monitoring_mode: f.monitoring_mode,
        })
        .collect();

    let decision = match lean::owntracks_config(
        &fixes,
        dev.last_profile.as_deref(),
        &places,
        manual_hold_active,
    ) {
        Ok(d) => d,
        Err(e) => {
            // The fix IS stored upstream, so this is not a lost fix — but we
            // have nothing to tell the phone, and inventing a profile here would
            // be this file deciding.
            tracing::error!(error = %format!("{e:#}"), "owntracks: the decision could not be made");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "decision unavailable");
        }
    };

    // One line per POST, so the proxy is debuggable from `kubectl logs` without
    // instrumenting the phone.
    tracing::info!(
        "owntracks {}/{} hist={} longStayPlaces={} hold={} {}->{} monitoring={} interval={}",
        &token[..token.len().min(6)],
        device,
        dev.history.len(),
        places.len(),
        if manual_hold_active { "y" } else { "n" },
        dev.last_profile.as_deref().unwrap_or("init"),
        decision.profile,
        decision.monitoring,
        decision
            .move_mode_locator_interval
            .map_or("-".to_string(), |i| i.to_string()),
    );

    dev.last_profile = Some(decision.profile.clone());
    st.owntracks.put(&key, dev);

    // ⚠ PhoneTrack's own response body is PRESERVED and our command appended.
    // It carries the "you are your own friend" location echo Owntracks needs to
    // draw the user's marker on its in-app map; replacing it would blank that.
    let mut out: Vec<Value> = match upstream.text().await {
        Ok(t) if !t.trim().is_empty() => match serde_json::from_str::<Value>(&t) {
            Ok(Value::Array(a)) => a,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let mut configuration = serde_json::Map::new();
    configuration.insert("_type".into(), json!("configuration"));
    configuration.insert("monitoring".into(), json!(decision.monitoring));
    if let Some(i) = decision.move_mode_locator_interval {
        configuration.insert("moveModeLocatorInterval".into(), json!(i));
    }
    out.push(json!({
        "_type": "cmd",
        "action": "setConfiguration",
        "configuration": Value::Object(configuration),
    }));
    Json(out).into_response()
}

/// One motion witness row.
struct MotionRow {
    ts: i64,
    lat: f64,
    lon: f64,
    cog: Option<i64>,
    vel: Option<i64>,
    acc: Option<i64>,
}

/// The motion witness for PDR (#296). Best-effort by design.
async fn persist_motion(st: &AppState, device: &str, messages: &[Location]) {
    let rows: Vec<MotionRow> = messages
        .iter()
        .filter_map(|m| match (m.lat, m.lon, m.tst) {
            (Some(lat), Some(lon), Some(ts)) => Some(MotionRow {
                ts,
                lat,
                lon,
                // ⚠ Owntracks sends -1 for "no heading". Storing that as a
                // bearing would be a FABRICATED direction — health #394 is the
                // same defect elsewhere in the pipeline — so it becomes NULL.
                cog: m.cog.filter(|c| *c >= 0.0).map(|c| c.round() as i64),
                vel: m.vel.map(|v| v.round() as i64),
                acc: m.acc.map(|a| a.round() as i64),
            }),
            _ => None,
        })
        .collect();
    for MotionRow {
        ts,
        lat,
        lon,
        cog,
        vel,
        acc,
    } in rows
    {
        if let Err(e) = sqlx::query(
            "INSERT IGNORE INTO motion_log (user_id, ts, lat, lon, cog, vel, acc) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device)
        .bind(ts)
        .bind(lat)
        .bind(lon)
        .bind(cog)
        .bind(vel)
        .bind(acc)
        .execute(&st.pool)
        .await
        {
            tracing::warn!(error = %e, "motion_log persist failed");
        }
    }
}

/// The user's mined places, in the shape the long-stay gate needs.
///
/// ⚠ `device` IS the user id, by Owntracks-config convention. A multi-user
/// setup would need a token→user table; this is written down because the
/// assumption is invisible at the call site.
async fn load_gating_places(st: &AppState, device: &str) -> anyhow::Result<Vec<lean::GatingPlace>> {
    let rows = sqlx::query(
        "SELECT CAST(centroid_lat AS CHAR) AS lat_s, CAST(centroid_lon AS CHAR) AS lon_s, \
         total_dwell_sec, visit_count, sleep_hours FROM focus_places WHERE user_id = ?",
    )
    .bind(device)
    .fetch_all(&st.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let lat_s: String = r.try_get("lat_s")?;
        let lon_s: String = r.try_get("lon_s")?;
        let total: i64 = r.try_get("total_dwell_sec")?;
        let visits: i64 = r.try_get("visit_count")?;
        let sleep: Option<i64> = r.try_get("sleep_hours")?;
        out.push(lean::GatingPlace {
            lat: lat_s.parse()?,
            lon: lon_s.parse()?,
            avg_dwell_sec: if visits > 0 {
                total as f64 / visits as f64
            } else {
                0.0
            },
            sleep_hours: sleep.unwrap_or(0) as f64,
        });
    }
    Ok(out)
}
