//! `GET /velocity`: a day, computed. This parses, calls and serialises; the
//! decisions are Lean's (cache lifetime `Verified.VelocityCache`, share access
//! `Verified.Share`, the future clip `Verified.Geo.DayState`, route fills
//! `Verified.Geo.RailRouteFill`) and the day is the head then the fold.
//!
//! # The clip is applied after the cache, per request
//!
//! The cached value is the full deterministic day; clipping before seating would
//! freeze the horizon, and a live day would assert a future already past.

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

/// Folds run one at a time per process: a day's working set is its OSM answers
/// as JSON trees, and two folds beside a previous one's arenas exceeded the
/// 512 MiB pod (killed at 428 and 472 MiB). The permit is taken on the
/// cache-miss path, so a seated day is served while another folds, and two
/// requests for one day share a fold through the cache's per-key lock.
static FOLD_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// Take the fold slot. `pub` for the test that proves there is exactly one.
pub async fn fold_slot() -> tokio::sync::SemaphorePermit<'static> {
    FOLD_SLOT
        .acquire()
        .await
        .expect("the fold semaphore is never closed")
}

/// Whether a fold could start right now without waiting.
pub fn fold_slot_free() -> bool {
    FOLD_SLOT.available_permits() > 0
}

/// One day's fold as production runs it: the slot, the compute, the heap
/// handed back. The route's cache-miss path and `backend velocity-many` both
/// come through here, so what the smoke job measures is what serves.
pub async fn fold_day(
    st: &AppState,
    user_id: &str,
    date: &str,
    tz: Option<&str>,
    walk_match: bool,
) -> Result<Value> {
    let _slot = fold_slot().await;
    let out = compute_with(st, user_id, date, tz, walk_match).await;
    // The fold's working set — inputs, OSM answers, the Lean payload — is
    // dropped by now; only the day's answer is still held. See `trim_heap`.
    crate::fold::trim_heap();
    out
}

/// `YYYY-MM-DD`, and nothing else.
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

    // The default date is today in UTC, not the viewer's date: changing it would
    // move which day a bare `/velocity` returns near midnight, a product call.
    let date = p
        .date
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    if !valid_date(&date) {
        return Ok(bad_request("date must be YYYY-MM-DD"));
    }
    // An unknown zone is refused rather than defaulted to UTC: a day rendered in
    // the wrong zone is a plausible, wrong day, and the caller asked for a
    // specific one.
    if let Some(tz) = p.tz.as_deref()
        && tz.parse::<chrono_tz::Tz>().is_err()
    {
        return Ok(bad_request("tz is not a known IANA timezone"));
    }
    let tz = p.tz.as_deref();
    let walk_match = p.walk_match.as_deref() != Some("0");

    // Share-viewers see only dates inside their window, and the check happens
    // before any work. `mayProceed` already stopped them writing; this is the
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
    // the date is resolved here and the decision is made there.
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
            fold_day(st, &session.user_id, &date, tz, walk_match)
        })
        .await?;

    // Per request, on the cached value. See the module note.
    let observed = cached.get("decodedThrough").and_then(Value::as_i64);
    let states = cached
        .get("states")
        .and_then(Value::as_array)
        .map(|s| lean::clip_future(s, now_s, observed))
        .transpose()?
        .unwrap_or_default();

    let mut out = cached;
    out["states"] = Value::Array(states);
    Ok(Json(out).into_response())
}

/// After a start, fold each user's today and yesterday once in the background,
/// warming the walk memo (`crate::walk_memo`) that a deploy's new code version
/// empties. One at a time through the fold slot; failures are logged.
pub async fn warm_recent(st: &AppState) {
    let users: Vec<String> = match sqlx::query_scalar("SELECT user_id FROM nc_tokens")
        .fetch_all(&st.pool)
        .await
    {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(error = %e, "walk memo warm-up: no user list");
            return;
        }
    };
    let now = chrono::Utc::now().timestamp();
    for user in users {
        let tz = crate::sync_state::get(&st.pool, &user, "home_tz")
            .await
            .ok()
            .flatten();
        // Yesterday is a calendar day back, not 86 400 seconds: across a clock
        // change a local day is 23 or 25 hours.
        let Ok(today) = timezone::local_date_at(now, tz.as_deref()) else {
            continue;
        };
        let Ok(today) = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d") else {
            continue;
        };
        for back in [0_u64, 1] {
            let Some(day) = today.checked_sub_days(chrono::Days::new(back)) else {
                continue;
            };
            let date = day.format("%Y-%m-%d").to_string();
            let t0 = std::time::Instant::now();
            let _slot = fold_slot().await;
            match compute(st, &user, &date, None).await {
                Ok(_) => tracing::info!(
                    %date,
                    ms = t0.elapsed().as_millis() as u64,
                    "walk memo warm-up: day folded"
                ),
                Err(e) => {
                    tracing::warn!(%date, error = %format!("{e:#}"), "walk memo warm-up failed")
                }
            }
        }
    }
}

/// Compute one day, on a cache miss. `pub` for the `backend velocity` binary
/// (a separate crate), the one proof this assembles a real response.
pub async fn compute(st: &AppState, user_id: &str, date: &str, tz: Option<&str>) -> Result<Value> {
    compute_with(st, user_id, date, tz, true).await
}

/// [`compute`] with the pedestrian matcher switchable: `walk_match = false` is
/// `?walkMatch=0`, the raw baseline. It reaches the fold as `env.walkMatch`; in
/// the cache key alone, the A/B would compare a value with itself.
pub async fn compute_with(
    st: &AppState,
    user_id: &str,
    date: &str,
    tz: Option<&str>,
    walk_match: bool,
) -> Result<Value> {
    let home_tz = crate::sync_state::home_tz(&st.pool, user_id).await?;
    let display_tz = tz.unwrap_or(&home_tz);
    let bounds = timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    let base_url = st
        .cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());

    // Per-phase wall clock, shipped in the response (`VelocityData.timing`):
    // the only record of where a slow day went.
    let mut timing = serde_json::Map::new();
    let mut phase = std::time::Instant::now();
    let mut mark = |timing: &mut serde_json::Map<String, Value>, name: &str| {
        timing.insert(name.into(), json!(phase.elapsed().as_millis() as u64));
        // RSS printed, never shipped: a memory figure in `timing` would change
        // the served shape and the generated TS types.
        if std::env::var_os("FOLD_SPLIT").is_some() {
            eprintln!("  phase {name}: RSS {} MiB", crate::fold::rss_mib());
        }
        phase = std::time::Instant::now();
    };

    // Where the stored decode had data to, read before the decode itself, so a
    // decode written in between only marks more as a guess. Only short of the
    // day's end: a finished day's states past midnight are observed.
    let decoded_through = crate::decode_freshness::decoded_through(&st.pool, user_id, date)
        .await?
        .filter(|t| *t < bounds.end_utc);
    let (inputs, load_split) = classification_inputs::load_timed(
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
    // Carried in `inputs` rather than through four shared signatures that would
    // each need a default; written only when the raw baseline was asked for, so
    // every other request is unchanged.
    let mut inputs = inputs;
    if !walk_match && let Some(o) = inputs.as_object_mut() {
        o.insert("walkMatch".into(), json!(false));
    }
    let inputs = inputs;
    // A day whose stored decode does not stand for these inputs is queued for
    // the decode worker; this read serves what is stored. Judged on the home
    // zone's day, as `decode-day` records it.
    if let Ok(home) = timezone::date_bounds_utc(date, Some(&home_tz)) {
        backend_queue_if_stale(&st.pool, user_id, date, home.end_utc, &inputs).await;
    }
    mark(&mut timing, "load");
    for (name, ms) in load_split {
        timing.insert(format!("load.{name}"), json!(ms));
    }

    let h = head::run(&inputs, date)?;
    // A day never decoded is being decoded (it was queued above): its track
    // and batteries now, its states when the worker has written them.
    if inputs.get("hsmmDecode").is_none_or(Value::is_null) {
        return Ok(json!({
            "points": h.points.iter().map(|p| json!({
                "ts": p.ts, "lat": p.lat, "lon": p.lon,
                "speedKmh": p.speed_kmh, "bearing": p.bearing,
            })).collect::<Vec<_>>(),
            "rawFixes": h.display_fixes.iter().map(|f| json!({
                "ts": f.ts, "lat": f.lat, "lon": f.lon, "accuracy": f.accuracy,
            })).collect::<Vec<_>>(),
            "segments": [], "states": [], "episodes": [], "journeys": [],
            "battery": h.battery.iter().map(|(ts, l)| json!({ "ts": ts, "level": l })).collect::<Vec<_>>(),
            "decoding": true,
        }));
    }
    let cap = head::capture(&inputs, date, user_id)?;
    mark(&mut timing, "head");

    let now_ms = chrono::Utc::now().timestamp_millis();
    // Reset first. The counter is process-wide, so a previous request's
    // queries would otherwise be charged to this one.
    mirror_source::take_queries();
    mirror_source::take_db_nanos();
    crate::rowset_answerer::take_lean_nanos();
    crate::fold::LEDGER.take();
    let folded =
        mirror_source::fold_from_mirror(st.pool.clone(), cap, inputs.clone(), now_ms).await?;
    let mirror_queries = mirror_source::take_queries();
    let db_ms = mirror_source::take_db_nanos() / 1_000_000;
    let lean_ms = crate::rowset_answerer::take_lean_nanos() / 1_000_000;
    // The host side of every ask, by label (`fold.<label>` ms, `.n` count) —
    // see `fold::Ledger`. Read beside `lean.ask.<table>.wait`, never summed
    // with it: `answer.<table>` is inside that wait.
    let mut ledger = serde_json::Map::new();
    for (label, (n, nanos)) in crate::fold::LEDGER.take() {
        if nanos > 0 {
            ledger.insert(format!("fold.{label}"), json!(nanos / 1_000_000));
        }
        ledger.insert(format!("fold.{label}.n"), json!(n));
    }

    // `walkableRoads`, `buildingsNear` and `drivableRoads` answer empty when the
    // mirror refuses, and empty is a legitimate answer, so a fully refused fold
    // still makes a well-formed day with every walk a raw chord. Served, not an
    // error, but logged. Only here can it be checked: every gate answers from a
    // captured trace with no mirror, so the count is zero for the wrong reason.
    mark(&mut timing, "fold");

    // A day whose asks were declined was built from defaults for them; not an
    // error (unfetched ground is queued for the drain) but logged, since the
    // response looks identical.
    let by_table = folded.declined_by_table();
    if !by_table.is_empty() {
        tracing::info!(date, ?by_table, "day served with declined lookups");
    }

    let out: Value = serde_json::from_str(&folded.out).context("the fold's answer is not JSON")?;
    // Where the fold's time went inside Lean: stages, passes, and per lookup
    // kind the wait and the parse. They overlap, so read side by side.
    if let Some(lt) = out.get("leanTiming").and_then(Value::as_object) {
        for (k, v) in lt {
            timing.insert(format!("lean.{k}"), v.clone());
        }
    }
    timing.append(&mut ledger);
    let segments = out.get("segs").cloned().unwrap_or_else(|| json!([]));

    // Drawn geometry ships once, in `episodes`: the segment path arrays are
    // intermediates no frontend reads and would double the response.
    let segments = strip_paths(segments);

    // The watch trace rides alongside rather than inside: a database hiccup
    // should cost the second line on a chart, not the day.
    let watch_battery = crate::watch_battery::load(
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

    // A train leg whose label has no route yet is offered to the fill, which
    // draws it from today's fixes for the next fold (`crate::rail_route`).
    match rail_fill_candidates(&out, &h) {
        Ok(candidates) => crate::rail_route::offer(candidates),
        Err(e) => tracing::warn!(date, error = %format!("{e:#}"), "rail fill scan failed"),
    }

    Ok(json!({
        "points": h.points.iter().map(|p| json!({
            "ts": p.ts, "lat": p.lat, "lon": p.lon,
            "speedKmh": p.speed_kmh, "bearing": p.bearing,
        })).collect::<Vec<_>>(),
        // From `display_fixes`, which is pre-snap: the cleaned track the
        // matchers actually consumed, so the overlay is an honest comparison
        // against the drawn line rather than a second copy of it.
        "rawFixes": h.display_fixes.iter().map(|f| json!({
            "ts": f.ts, "lat": f.lat, "lon": f.lon, "accuracy": f.accuracy,
        })).collect::<Vec<_>>(),
        "segments": segments,
        "states": out.get("states").cloned().unwrap_or_else(|| json!([])),
        // Past this the states are the decoder's guess for minutes it had no
        // data for; the per-request clip marks them (`DayState.clipFuture`).
        "decodedThrough": decoded_through,
        // Decoded, not forwarded. See `decode_episode_bits` — the fold's
        // bit-string coordinates hung the Android app for a full day.
        "episodes": decode_episode_bits(out.get("episodes").cloned().unwrap_or_else(|| json!([]))),
        // The timeline's collapsible journeys, assembled server-side.
        "journeys": out.get("journeys").cloned().unwrap_or_else(|| json!([])),
        // `Battery` is already `(ts, level)` pairs — the chart's own shape.
        "battery": h.battery.iter().map(|(ts, l)| json!({ "ts": ts, "level": l })).collect::<Vec<_>>(),
        "watchBattery": watch_battery.iter().map(|(ts, l)| json!({ "ts": ts, "level": l })).collect::<Vec<_>>(),
        // The fold's ask count rides here too: how many lookups the day
        // made and how many were answered, which is what distinguishes a slow
        // day from a deep one.
        "timing": timing_with(
            &timing, folded.asks.len(), folded.answered(), mirror_queries, db_ms, lean_ms,
        ),
    }))
}

/// The phase timings plus the fold's cost; `asks` and `answered` are counts of
/// lookups made and answered by the mirror.
fn timing_with(
    t: &serde_json::Map<String, Value>,
    asks: usize,
    answered: usize,
    mirror_queries: u64,
    db_ms: u64,
    lean_ms: u64,
) -> Value {
    let mut out = t.clone();
    out.insert("asks".into(), json!(asks));
    out.insert("answered".into(), json!(answered));
    // The denominator for `fold`. Measured from a laptop, that duration is
    // dominated by round trips over an SSH tunnel; with the count beside it the
    // two can be compared against an in-cluster run instead of guessed at.
    out.insert("mirrorQueries".into(), json!(mirror_queries));
    // The two halves of `fold`, so nobody divides it by the query count and
    // calls the result a per-query cost. `fold` minus these two is the fold's
    // own work.
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

/// Decode the fold's bit-string coordinates into the numbers the client's wire
/// type declares.
///
/// ⚠ The client must never see a bit string: Leaflet read one as a latitude
/// and spun the WebView's compositor at a full core. Numbers pass through, and
/// what does not parse is left rather than zeroed (a zero draws a line to the
/// Gulf of Guinea).
pub fn decode_episode_bits(episodes: Value) -> Value {
    fn bits(v: &Value) -> Option<f64> {
        v.as_str()?.parse::<u64>().ok().map(f64::from_bits)
    }
    let Value::Array(eps) = episodes else {
        return episodes;
    };
    Value::Array(
        eps.into_iter()
            .map(|mut ep| {
                if let Some(pts) = ep.get_mut("points").and_then(Value::as_array_mut) {
                    for p in pts.iter_mut() {
                        for key in ["lat", "lon", "ts"] {
                            let Some(slot) = p.get_mut(key) else { continue };
                            let Some(f) = bits(slot) else { continue };
                            // A whole `ts` ships as an integer, matching `points`.
                            *slot = if key == "ts" && f.fract() == 0.0 && f.is_finite() {
                                json!(f as i64)
                            } else {
                                json!(f)
                            };
                        }
                    }
                }
                ep
            })
            .collect(),
    )
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

/// The two Nextcloud states are not failures: an unlinked account has no
/// location data (an empty timeline, 200), and a token needing reauth is a 409
/// with a structured error so the SPA shows its reconnect banner.
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

/// `decode_freshness::queue_if_stale` at the horizon these inputs reach.
async fn backend_queue_if_stale(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    day_end_utc: i64,
    inputs: &Value,
) {
    let horizon = crate::decode_freshness::horizon(
        day_end_utc,
        inputs
            .pointer("/biometrics/stepsThrough")
            .and_then(Value::as_i64),
        chrono::Utc::now().timestamp(),
    );
    crate::decode_freshness::queue_if_stale(pool, user_id, date, horizon).await;
}
