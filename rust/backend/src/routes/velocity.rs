//! `GET /velocity` — a day, computed (#982).
//!
//! The route the whole port was for. Everything it needs already exists; this
//! parses, calls, and serialises, and decides nothing:
//!
//!   * how long the answer may be cached — `Verified.VelocityCache`
//!   * whether a share recipient may see this date — `Verified.Share`
//!   * what to clip off the future — `Verified.Geo.DayState`
//!   * which train legs want a route fill — `Verified.Geo.RailRouteFill`
//!   * the day itself — the head, then the fold, then converge.
//!
//! # ⚠ The clip is applied AFTER the cache, per request
//!
//! The cached value is the full deterministic day. `now` advances and a cached
//! value does not, so clipping before seating would freeze the horizon at
//! whatever it was when the day was computed — and every later view of a live
//! day would assert a future that had already happened.

use anyhow::{Context, Result};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::session::UserSession;
use crate::state::AppState;
use crate::{classification_inputs, head, lean, mirror_source, timezone, velocity_cache};

#[derive(Deserialize)]
pub struct Params {
    date: Option<String>,
    tz: Option<String>,
    /// `walkMatch=0` disables pedestrian map-matching so the map can render the
    /// original smoothed and raw walks for an A/B comparison.
    #[serde(rename = "walkMatch")]
    walk_match: Option<String>,
}

/// `YYYY-MM-DD`, and nothing else. The TypeScript's `dateParam` regex.
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub async fn handler(
    State(st): State<AppState>,
    Extension(session): Extension<UserSession>,
    Query(p): Query<Params>,
) -> Response {
    match run(&st, &session, p).await {
        Ok(r) => r,
        Err(e) => map_error(&e),
    }
}

async fn run(st: &AppState, session: &UserSession, p: Params) -> Result<Response> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let now_s = now_ms / 1000;

    // ⚠ The default date is TODAY IN UTC, matching the TypeScript's
    // `new Date().toISOString().slice(0, 10)` — NOT the viewer's local date,
    // even though `tz` may say otherwise. Changing it would silently move which
    // day a bare `/velocity` returns for anyone east or west of UTC at the
    // boundary; that is a product decision, not a port detail.
    let date = p
        .date
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    if !valid_date(&date) {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    }
    // An unknown zone is REFUSED rather than defaulted to UTC: a day rendered in
    // the wrong zone is a plausible, wrong day, and the caller asked for a
    // specific one.
    if let Some(tz) = p.tz.as_deref()
        && tz.parse::<chrono_tz::Tz>().is_err()
    {
        return Ok(bad_request("tz is not a known IANA timezone"));
    }
    let tz = p.tz.as_deref();
    let walk_match = p.walk_match.as_deref() != Some("0");

    // ⚠ Share-viewers see only dates inside their window, and the check happens
    // BEFORE any work. `mayProceed` already stopped them writing; this is the
    // separate question of what they may read.
    if let Some((from, to)) = &session.share_viewer
        && !lean::date_in_share_window(&date, from, to)?
    {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "out_of_share_window", "from": from, "to": to })),
        )
            .into_response());
    }

    // The viewer's civil date decides whether this day is still in progress, and
    // therefore how long the answer may be reused. Lean has no zone database, so
    // the date is resolved here and the DECISION is made there.
    let today = timezone::local_date_at(now_s, tz)?;
    let (ttl_ms, max_entries) = lean::velocity_ttl_ms(&date, &today)?;

    let key = format!(
        "{}|{date}|{}|wm{}",
        session.user_id,
        tz.unwrap_or(""),
        u8::from(walk_match)
    );
    let policy = velocity_cache::Policy {
        ttl_ms,
        max_entries,
    };

    let cached = st
        .velocity
        .get_or_compute(&key, now_ms, policy, || {
            compute(st, &session.user_id, &date, tz)
        })
        .await?;

    // ⚠ PER REQUEST, on the cached value. See the module note.
    let states = cached
        .get("states")
        .and_then(Value::as_array)
        .map(|s| lean::clip_inferred_future(s, now_s))
        .transpose()?
        .unwrap_or_default();

    let mut out = cached;
    out["states"] = Value::Array(states);
    Ok(Json(out).into_response())
}

/// Compute one day. Only reached on a cache miss.
///
/// ⚠ `pub`, not `pub(crate)`, and the difference is not style: `backend` is a
/// separate BINARY crate from the library, so `pub(crate)` is invisible to it.
/// `backend velocity` calls this to run the ASSEMBLY against production — the
/// gate above it has tests, but nothing else anywhere proves this produces a
/// real response body.
pub async fn compute(st: &AppState, user_id: &str, date: &str, tz: Option<&str>) -> Result<Value> {
    let home_tz = crate::sync_state::get(&st.pool, user_id, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let display_tz = tz.unwrap_or(&home_tz);
    let bounds = timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    let base_url = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());

    // ⚠ PER-PHASE WALL CLOCK, and it ships in the response. The frontend's
    // `VelocityData.timing` reads it, and it is the only thing that says WHERE a
    // slow day went — the first production run of this route took 37.6 s, and
    // without this the answer would have been a guess.
    let mut timing = serde_json::Map::new();
    let mut phase = std::time::Instant::now();
    let mut mark = |timing: &mut serde_json::Map<String, Value>, name: &str| {
        timing.insert(name.into(), json!(phase.elapsed().as_millis() as u64));
        phase = std::time::Instant::now();
    };

    let inputs = classification_inputs::load(
        &st.pool,
        &st.http,
        &base_url,
        &classification_inputs::DayIdentity {
            user_id,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;
    mark(&mut timing, "load");

    let h = head::run(&inputs, date)?;
    let cap = head::capture(&inputs, date, user_id)?;
    mark(&mut timing, "head");

    let now_ms = chrono::Utc::now().timestamp_millis();
    // ⚠ Reset first. The counter is process-wide, so a previous request's
    // queries would otherwise be charged to this one.
    mirror_source::take_queries();
    mirror_source::take_db_nanos();
    crate::rowset_answerer::take_lean_nanos();
    let folded =
        mirror_source::converge_from_mirror(st.pool.clone(), cap, inputs.clone(), now_ms).await?;
    let mirror_queries = mirror_source::take_queries();
    // ⚠ The two halves of the fold, MEASURED. #1071 batched the queries on the
    // assumption that round trips dominated and the wall clock barely moved; the
    // per-query cost it reasoned from had been derived by dividing fold by
    // query count, which assumes the answer. These say which half is which.
    let db_ms = mirror_source::take_db_nanos() / 1_000_000;
    let lean_ms = crate::rowset_answerer::take_lean_nanos() / 1_000_000;
    mark(&mut timing, "fold");

    // ⚠ A day that converged with UNANSWERABLE keys was built from DEFAULTS for
    // them, and that is not the same day. It is not an error — three tables are
    // unanswerable by construction (`reverseGeocode`, `nearbyLandmarks`,
    // `transitStops`) — but it must be visible, because the response looks
    // identical either way.
    if !folded.unanswerable.is_empty() {
        let mut by_table: std::collections::BTreeMap<&str, usize> = Default::default();
        for m in &folded.unanswerable {
            *by_table.entry(m.what.as_str()).or_default() += 1;
        }
        tracing::info!(date, ?by_table, "day served with unanswered lookups");
    }

    let out: Value = serde_json::from_str(&folded.out).context("the fold's answer is not JSON")?;
    let segments = out.get("segs").cloned().unwrap_or_else(|| json!([]));

    // ⚠ Drawn geometry ships ONCE, in `episodes`. The segment-level path arrays
    // are pipeline intermediates `episodes` already consumed server-side; no
    // frontend code reads them, and on a data-rich day they duplicate every
    // polyline in the response — its dominant weight.
    let segments = strip_paths(segments);

    // The watch trace rides alongside rather than inside: a database hiccup
    // should cost the second line on a chart, not the day.
    let watch_battery = crate::fitbit::watch_battery::load(
        &st.pool,
        user_id,
        display_tz,
        bounds.start_utc,
        bounds.end_utc,
    )
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(error = %format!("{e:#}"), "watch battery load failed");
        Vec::new()
    });
    mark(&mut timing, "watchBattery");

    // ⚠ The rail-route fill is IDENTIFIED but not RUN. `unsnappedTrainRoutes`
    // names the legs whose route is missing; computing one is
    // `computeRailRoute`, two OSM corridor queries and a snapper that this port
    // does not have yet. Logging the count rather than silently doing nothing
    // is the difference between a known gap and a forgotten one: until the
    // worker exists, those legs draw raw until the nightly job runs (#363).
    if let Ok(candidates) = rail_fill_candidates(&out, &h)
        && !candidates.is_empty()
    {
        tracing::info!(
            date,
            count = candidates.len(),
            "train legs want a route fill; the fill worker is not ported yet (#363)"
        );
    }

    Ok(json!({
        "points": h.points.iter().map(|p| json!({
            "ts": p.ts, "lat": p.lat, "lon": p.lon,
            "speedKmh": p.speed_kmh, "bearing": p.bearing,
        })).collect::<Vec<_>>(),
        // ⚠ From `display_fixes`, which is PRE-SNAP: the cleaned track the
        // matchers actually consumed, so the overlay is an honest comparison
        // against the drawn line rather than a second copy of it.
        "rawFixes": h.display_fixes.iter().map(|f| json!({
            "ts": f.ts, "lat": f.lat, "lon": f.lon, "accuracy": f.accuracy,
        })).collect::<Vec<_>>(),
        "segments": segments,
        "states": out.get("states").cloned().unwrap_or_else(|| json!([])),
        "episodes": out.get("episodes").cloned().unwrap_or_else(|| json!([])),
        // `Battery` is already `(ts, level)` pairs — the chart's own shape.
        "battery": h.battery.iter().map(|(ts, l)| json!({ "ts": ts, "level": l })).collect::<Vec<_>>(),
        "watchBattery": watch_battery.iter().map(|(ts, l)| json!({ "ts": ts, "level": l })).collect::<Vec<_>>(),
        // ⚠ The fold's ROUND COUNT rides here too. It is the depth of the
        // dependency chain among the day's lookups, not a duration, and it is
        // what distinguishes a slow day from a deep one.
        "timing": timing_with(&timing, folded.rounds, folded.answered, mirror_queries, db_ms, lean_ms),
    }))
}

/// The phase timings plus what the fold cost, as the response carries them.
///
/// ⚠ `rounds` is not a duration. It is the DEPTH of the dependency chain among
/// the day's lookups — how many times an answer decided the next question — and
/// it is what tells a slow day from a deep one.
fn timing_with(
    t: &serde_json::Map<String, Value>,
    rounds: u32,
    answered: usize,
    mirror_queries: u64,
    db_ms: u64,
    lean_ms: u64,
) -> Value {
    let mut out = t.clone();
    out.insert("rounds".into(), json!(rounds));
    out.insert("answered".into(), json!(answered));
    // ⚠ The DENOMINATOR for `fold`. Measured from a laptop, that duration is
    // dominated by round trips over an SSH tunnel; with the count beside it the
    // two can be compared against an in-cluster run instead of guessed at.
    out.insert("mirrorQueries".into(), json!(mirror_queries));
    // ⚠ The two halves of `fold`, so nobody has to divide it by the query count
    // and call the result a per-query cost — which is what #1071 did, and it was
    // wrong. `fold` minus these two is the fold's own work.
    out.insert("foldDbMs".into(), json!(db_ms));
    out.insert("foldLeanMs".into(), json!(lean_ms));
    out.insert("foldDbMs".into(), json!(db_ms));
    out.insert("foldLeanMs".into(), json!(lean_ms));
    Value::Object(out)
}

/// The train legs whose route is missing, in `railfill`'s wire form.
fn rail_fill_candidates(out: &Value, h: &head::Head) -> Result<Vec<lean::FillCandidate>> {
    let segs = out.get("segs").and_then(Value::as_array);
    let Some(segs) = segs else {
        return Ok(Vec::new());
    };
    let wire: Vec<Value> = segs
        .iter()
        .map(|s| {
            json!([
                s.get("mode").and_then(Value::as_str).unwrap_or(""),
                s.get("refinedMode").cloned().unwrap_or(Value::Null),
                s.get("startTs").cloned().unwrap_or(json!(0)),
                s.get("endTs").cloned().unwrap_or(json!(0)),
                s.get("wayName").cloned().unwrap_or(Value::Null),
                // A boolean, not the path — see the mode's note.
                !s.get("snappedPath").unwrap_or(&Value::Null).is_null(),
            ])
        })
        .collect();
    let points: Vec<Value> = h
        .points
        .iter()
        .map(|p| {
            json!([
                p.ts,
                p.lat.to_bits().to_string(),
                p.lon.to_bits().to_string()
            ])
        })
        .collect();
    lean::unsnapped_train_routes(&wire, &points)
}

/// Remove the three per-segment path arrays. See the caller's note.
fn strip_paths(segments: Value) -> Value {
    let Value::Array(segs) = segments else {
        return segments;
    };
    Value::Array(
        segs.into_iter()
            .map(|mut s| {
                if let Some(o) = s.as_object_mut() {
                    o.remove("snappedPath");
                    o.remove("matchedPath");
                    o.remove("walkMatchedPath");
                }
                s
            })
            .collect(),
    )
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// ⚠ The two Nextcloud states are NOT failures and must not read as one.
///
/// An unlinked account has no PhoneTrack source at all, so the honest answer is
/// an EMPTY timeline with a 200 — the day genuinely has no location data. A
/// token needing reauth is a 409 with a structured error, so the SPA can render
/// its reconnect banner instead of "No timeline data available", which is what a
/// bare failure would produce and which tells the user nothing they can act on.
fn map_error(e: &anyhow::Error) -> Response {
    let text = format!("{e:#}");
    if text.contains("NextcloudNotLinked") {
        return Json(json!({ "points": [], "segments": [], "states": [] })).into_response();
    }
    if text.contains("NextcloudReauthRequired") {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "nextcloud_reauth_required" })),
        )
            .into_response();
    }
    tracing::error!(error = %text, "/velocity failed");
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "velocity computation failed" })),
    )
        .into_response()
}
