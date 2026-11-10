//! Calling the Lean decisions.
//!
//! Every function here is one request to `verified_cli serve` —
//! `{"mode":"backend","op":…}` for the decision table in `Verified/Session.lean`
//! and its siblings, `{"mode":…}` for the algorithm modes — typed on this side
//! so a caller never spells a wire shape. The process, the pool and the ask
//! protocol are [`crate::lean_worker`]; this module is the vocabulary.
//!
//! What that buys is that the rules the running backend uses ARE the ones in
//! Lean — not a Rust paraphrase of them that drifts.
//!
//! # `init` once, and a failure there is fatal
//!
//! If Lean cannot be spawned, every later call would fail the same way, and a
//! backend that limped on answering "could not decide" per request is worse
//! than one that refuses to start. `init` is therefore called from the
//! entrypoint, and it is what a test that needs Lean calls first.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::lean_worker::{Answerer, Ask, Called, Chain, NoAnswers};

/// Start the Lean process. Idempotent; call once at startup.
pub fn init() -> Result<()> {
    crate::lean_worker::init().context("starting verified_cli")
}

/// One decision: the request object goes out as `{"mode":"backend","req":…}`,
/// the reply body comes back as text.
///
/// Through [`serve`], so a traced run records the `backend` mode like any
/// other. The request is wrapped, not merged: some ops carry a `mode` of their
/// own, which merging would overwrite.
fn call_raw(request: &Value) -> Result<String> {
    let req = serde_json::json!({ "mode": "backend", "req": request });
    serve(&req.to_string())
}

/// A dispatch that failed inside Lean reports `{"error": …}`; surface it as one.
fn call_json<T: for<'de> Deserialize<'de>>(request: &Value) -> Result<T> {
    let raw = call_raw(request)?;
    if let Ok(e) = serde_json::from_str::<LeanError>(&raw) {
        return Err(anyhow!("lean: {}", e.error));
    }
    serde_json::from_str(&raw).with_context(|| format!("decoding lean response: {raw}"))
}

#[derive(Deserialize)]
struct LeanError {
    error: String,
}

/// One Google Health weigh-in. Mirrors `Verified.Weight.Weigh`.
///
/// `grams` is an integer end to end — Google stores it that way, and the
/// conversion to the `DECIMAL(5,2)` kilograms the table holds happens at the
/// write. Carrying it as a float through the FFI would round twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Weigh {
    pub date: String,
    pub grams: i64,
    /// RFC-3339, used ONLY to order two weigh-ins on the same civil date.
    pub ts: String,
}

/// What [`dedupe_weigh_ins`] answers: the delete boundary and the rows that
/// replace what it deletes.
#[derive(Debug, Deserialize)]
pub struct WeighPlan {
    /// The earliest covered day, or `None` for an empty fetch.
    ///
    /// ⚠ `None` MUST NOT be read as "replace everything". A Google outage, a
    /// revoked token and a scope change all return zero points, and treating
    /// that as a boundary would delete every weight row there is.
    #[serde(rename = "replaceFrom")]
    pub replace_from: Option<String>,
    pub kept: Vec<Weigh>,
}

/// See `Verified.Weight.dedupeByDate` / `replaceFrom`.
///
/// Both answers come from ONE call because they must come from the SAME dedup:
/// a boundary computed from one pass and rows from another can disagree about
/// which days are covered.
pub fn dedupe_weigh_ins(weigh_ins: &[Weigh]) -> Result<WeighPlan> {
    call_json(&serde_json::json!({
        "op": "dedupeWeighIns", "weighIns": weigh_ins,
    }))
}

#[derive(Deserialize)]
struct OptInt {
    value: Option<i64>,
}

/// `Verified.Civil.midnightUtc`: a `YYYY-MM-DD` as Unix seconds at UTC
/// midnight. An impossible date (30 February) or a non-date is refused, never
/// rolled over.
pub fn midnight_utc(date: &str) -> Result<i64> {
    let r: OptInt = call_json(&serde_json::json!({ "op": "midnightUtc", "date": date }))?;
    r.value
        .ok_or_else(|| anyhow!("not a calendar date: {date:?}"))
}

/// `Verified.VelocityCache.ttlMsFor`: how long a computed day may be reused,
/// plus the LRU bound the host enforces.
///
/// `today` must be the viewer's local civil date (`timezone::local_date_at`),
/// not UTC's: a UTC date is a well-formed argument asking a different question.
pub fn velocity_ttl_ms(date: &str, today: &str) -> Result<(i64, usize)> {
    #[derive(Deserialize)]
    struct Wire {
        value: i64,
        #[serde(rename = "maxEntries")]
        max_entries: i64,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "velocityTtlMs", "date": date, "today": today,
    }))?;
    Ok((w.value, usize::try_from(w.max_entries).unwrap_or(0)))
}

/// `Verified.VelocityCache.isFresh` — may this cached entry still be served?
pub fn velocity_cache_fresh(cached_at_ms: i64, now_ms: i64, ttl_ms: i64) -> Result<bool> {
    let w: BoolWire = call_json(&serde_json::json!({
        "op": "velocityCacheFresh",
        "cachedAtMs": cached_at_ms, "nowMs": now_ms, "ttlMs": ttl_ms,
    }))?;
    Ok(w.value)
}

/// `Verified.Share.dateInShareWindow` — may a share-viewer see this date?
///
/// ⚠ ONLY for a session that HAS a window. A session with no share-viewer is not
/// a viewer with an empty window; asking here about one would turn a missing
/// window into an admitted date.
pub fn date_in_share_window(date: &str, from: &str, to: &str) -> Result<bool> {
    let w: BoolWire = call_json(&serde_json::json!({
        "op": "dateInShareWindow", "date": date, "from": from, "to": to,
    }))?;
    Ok(w.value)
}

#[derive(Deserialize)]
struct BoolWire {
    value: bool,
}

/// `Verified.Session.splitSigned` — the `(value, signature)` framing of a signed
/// cookie.
///
/// ⚠ Splits on the LAST separator. The signature is base64url, which has no `.`,
/// so a value containing dots round-trips whole; splitting on the first would
/// verify a truncated value.
pub fn split_signed(signed: &str) -> Result<Option<(String, String)>> {
    #[derive(Deserialize)]
    struct Part {
        value: String,
        sig: String,
    }
    #[derive(Deserialize)]
    struct Wire {
        value: Option<Part>,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "splitSigned", "signed": signed }))?;
    Ok(w.value.map(|p| (p.value, p.sig)))
}

/// `Verified.Session.sessionIsValid` — INCLUSIVE at the boundary: a row expiring
/// exactly now is still valid.
pub fn session_is_valid(expires_at_ms: i64, now_ms: i64) -> Result<bool> {
    let w: BoolWire = call_json(&serde_json::json!({
        "op": "sessionIsValid", "expiresAtMs": expires_at_ms, "nowMs": now_ms,
    }))?;
    Ok(w.value)
}

/// `Verified.Session.mayProceed` — may this session do this?
///
/// ⚠ ANSWERS ONE QUESTION ONLY: whether a SHARE VIEWER is allowed this method on
/// this path. An unauthenticated request is not a share viewer, so this returns
/// `true` for one — and `true` here is not permission. The caller's own "is
/// there a session" gate must run first.
///
/// `hides_location`: the viewer's link has location turned off
/// (`Verified.Session.mayProceedSharing`). `path` must be the ORIGINAL request
/// path, `/api` included.
pub fn may_proceed(
    is_share_viewer: bool,
    hides_location: bool,
    method: &str,
    path: &str,
) -> Result<bool> {
    let w: BoolWire = call_json(&serde_json::json!({
        "op": "mayProceed", "isShareViewer": is_share_viewer,
        "hidesLocation": hides_location,
        "method": method, "path": path,
    }))?;
    Ok(w.value)
}

/// `Verified.Share.shareableDateRange`: the inclusive `[from, to]` a share with
/// this `days_back` may show, ending at `today`.
///
/// ⚠ `None` means SHARE DISABLED (`days_back ≤ 0`, or an unparseable `today`),
/// not "no window". Reading it as unrestricted inverts the rule.
pub fn shareable_date_range(today: &str, days_back: i64) -> Result<Option<(String, String)>> {
    #[derive(Deserialize)]
    struct Range {
        from: String,
        to: String,
    }
    #[derive(Deserialize)]
    struct Wire {
        value: Option<Range>,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "shareableDateRange", "today": today, "daysBack": days_back,
    }))?;
    Ok(w.value.map(|r| (r.from, r.to)))
}

/// `Verified.ApiWindow.validateDays`: the `days` query parameter. `None` out
/// means reject, not "use the default": `days=400` is a 400, not a narrowed
/// window.
///
/// `raw` is what JS `Number(...)` makes of the parameter: `None` only when
/// absent, `Some(NaN)` when unparseable, `Some(0.0)` for the empty string.
/// Mapping `""` to `None` would turn a rejection into a 30-day read.
pub fn validate_days(raw: Option<f64>) -> Result<Option<i64>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Option<i64>,
    }
    // NaN cannot cross JSON, so it is flagged rather than dropped — a dropped
    // NaN would arrive as absent and become the default.
    let is_nan = raw.is_some_and(f64::is_nan);
    let w: Wire = call_json(&serde_json::json!({
        "op": "validateDays",
        "days": raw.filter(|v| !v.is_nan()),
        "daysNaN": is_nan,
    }))?;
    Ok(w.value)
}

/// `Verified.ApiWindow.earliestVisible` — the earliest date a request may see.
///
/// ⚠ `share_from` is `None` for the OWNER. Passing an empty string instead
/// would compare against it and give the same answer by luck rather than by
/// rule.
pub fn earliest_visible(
    today: &str,
    days: i64,
    share_from: Option<&str>,
) -> Result<Option<String>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Option<String>,
    }
    let mut req = serde_json::json!({ "op": "earliestVisible", "today": today, "days": days });
    if let Some(f) = share_from {
        req["shareFrom"] = serde_json::json!(f);
    }
    let w: Wire = call_json(&req)?;
    Ok(w.value)
}

/// `Verified.Session.renewedExpiry` — a used session's new expiry, or `None`
/// when it would move by an hour or less.
pub fn renewed_expiry(expires_at_ms: i64, now_ms: i64) -> Result<Option<i64>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Option<i64>,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "renewedExpiry", "expiresAtMs": expires_at_ms, "nowMs": now_ms,
    }))?;
    Ok(w.value)
}

/// The session lifetime, and the cookie spelling that must agree with it.
pub struct SessionPolicy {
    pub ttl_ms: i64,
    pub cookie_max_age_s: i64,
    pub cookie_name: String,
}

/// `Verified.Session`'s constants, fetched rather than restated.
pub fn session_policy() -> Result<SessionPolicy> {
    #[derive(Deserialize)]
    struct Wire {
        value: i64,
        #[serde(rename = "cookieMaxAgeS")]
        cookie_max_age_s: i64,
        #[serde(rename = "cookieName")]
        cookie_name: String,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "sessionTtlMs" }))?;
    Ok(SessionPolicy {
        ttl_ms: w.value,
        cookie_max_age_s: w.cookie_max_age_s,
        cookie_name: w.cookie_name,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoverageRow {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    pub fetched_at: Option<i64>,
}

#[derive(Deserialize)]
struct Covered {
    covered: bool,
}

/// `Verified.Geo.OsmCoverage.decideCoverage`: may the mirror be read here?
/// `false` means nobody fetched this area for this bucket, so a query would
/// return nothing indistinguishable from an empty area; the caller declines.
///
/// `coverage` holds one bucket's rows (boxes are per bucket). `now_ms` is passed
/// in: the host owns the clock, Lean the decision.
pub fn osm_covered(
    lat: f64,
    lon: f64,
    radius_m: f64,
    coverage: &[CoverageRow],
    now_ms: i64,
    has_local_data: bool,
) -> Result<bool> {
    let bits = |v: f64| serde_json::Value::String(v.to_bits().to_string());
    let rows: Vec<serde_json::Value> = coverage
        .iter()
        .map(|c| {
            serde_json::json!([
                bits(c.min_lat),
                bits(c.max_lat),
                bits(c.min_lon),
                bits(c.max_lon),
                c.fetched_at
            ])
        })
        .collect();
    let req = serde_json::json!({
        "mode": "osmcoverage",
        "lat": bits(lat), "lon": bits(lon), "radiusM": bits(radius_m),
        "coverage": rows, "nowMs": now_ms, "hasLocalData": has_local_data,
    });
    let out = serve(&req.to_string()).context("lean serve osmcoverage")?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("osmcoverage answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("osmcoverage: {e}");
    }
    let c: Covered = serde_json::from_value(v).context("osmcoverage answer has no `covered`")?;
    Ok(c.covered)
}

/// The tags whose NAMED features are places (`Verified.Geo.Landmarks.VENUE_TAGS`):
/// `(key, values)`, e.g. `("natural", ["beach"])`. The mirror's fetch asks once
/// per run and hands the list to [`crate::osm_mirror::parse_element`] and
/// [`crate::osm_mirror::overpass_query`]; the rule is Lean's.
pub fn venue_tags() -> Result<Vec<(String, Vec<String>)>> {
    #[derive(Deserialize)]
    struct Answer {
        tags: Vec<(String, Vec<String>)>,
    }
    let out = serve(&serde_json::json!({ "mode": "venuetags" }).to_string())
        .context("lean serve venuetags")?;
    let a: Answer = serde_json::from_str(&out).context("venuetags answer")?;
    Ok(a.tags)
}

/// One train leg the serving path should queue a route fill for.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FillCandidate {
    pub key: String,
    #[serde(rename = "startTs")]
    pub start_ts: i64,
    #[serde(rename = "endTs")]
    pub end_ts: i64,
    /// `(lat, lon)` bit patterns, pooled across legs sharing the key. Left as
    /// the wire spelling: the caller hands them to the corridor query, and
    /// parsing them here would round-trip a float for nothing.
    pub fixes: Vec<(String, String)>,
}

/// `Verified.Geo.RailRouteFill.unsnappedTrainRoutes`: the train legs of a
/// computed day that want a background route fill.
///
/// Wire forms: segments `[mode, refinedMode|null, startTs, endTs,
/// wayName|null, hasSnappedPath]`, points `[ts, latBits, lonBits]`.
/// `hasSnappedPath` is a boolean, so the day's polylines never cross.
pub fn unsnapped_train_routes(
    segments: &[serde_json::Value],
    points: &[serde_json::Value],
) -> Result<Vec<FillCandidate>> {
    #[derive(Deserialize)]
    struct Wire {
        candidates: Vec<FillCandidate>,
    }
    let req = serde_json::json!({
        "mode": "railfill", "segments": segments, "points": points,
    });
    let out = serve(&req.to_string()).context("lean serve railfill")?;
    let v: serde_json::Value = serde_json::from_str(&out).context("railfill answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("railfill: {e}");
    }
    let w: Wire = serde_json::from_value(v).context("railfill answer has no `candidates`")?;
    Ok(w.candidates)
}

/// `Verified.Geo.DayState.clipFuture`: never assert the future. Truncates a
/// state straddling `now_ts`, drops one wholly beyond it, and marks a state
/// starting at or after `observed_through` (the decode's horizon) inferred.
///
/// ⚠ Apply per request, after the cache: the cached day is fixed while `now`
/// moves, so clipping before caching would freeze the horizon.
///
/// `states` must be the `day` mode's own state objects: they round-trip
/// through the same encoder, so unknown fields survive.
pub fn clip_future(
    states: &[serde_json::Value],
    now_ts: i64,
    observed_through: Option<i64>,
) -> Result<Vec<serde_json::Value>> {
    #[derive(Deserialize)]
    struct Wire {
        states: Vec<serde_json::Value>,
    }
    let mut req = serde_json::json!({ "mode": "clipfuture", "states": states, "nowTs": now_ts });
    if let Some(t) = observed_through {
        req["observedThrough"] = serde_json::json!(t);
    }
    let out = serve(&req.to_string()).context("lean serve clipfuture")?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("clipfuture answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("clipfuture: {e}");
    }
    let w: Wire = serde_json::from_value(v).context("clipfuture answer has no `states`")?;
    Ok(w.states)
}

/// `Verified.Geo.Velocity.watchBatterySeries`: the watch trace for one day.
///
/// `rows` are `[ts|null, level, deviceVersion|null]` with the instant already
/// resolved; a `null` instant is dropped, not guessed. Row order matters: of
/// two rows at one instant, the later is kept.
pub fn watch_battery_series(
    rows: &[serde_json::Value],
    start_utc: i64,
    end_utc: i64,
) -> Result<Vec<(i64, i64)>> {
    #[derive(Deserialize)]
    struct Wire {
        series: Vec<(i64, i64)>,
    }
    let req = serde_json::json!({
        "mode": "watchbattery", "rows": rows,
        "startUtc": start_utc, "endUtc": end_utc,
    });
    let out = serve(&req.to_string()).context("lean serve watchbattery")?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("watchbattery answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("watchbattery: {e}");
    }
    let w: Wire = serde_json::from_value(v).context("watchbattery answer has no `series`")?;
    Ok(w.series)
}

/// Where a traced run records the modes it asked for: an absolute path fixed at
/// compile time, since test processes and gate rows run from different
/// directories.
const MODE_TRACE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/mode-trace.txt");

/// Whether this process records the modes it asks for. Read once.
static MODE_TRACE: OnceLock<bool> = OnceLock::new();

/// The modes this process has already recorded: each is written once per
/// process, so the cost in the fold's inner loop is one set lookup.
static MODE_SEEN: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// The mode of a request: a scan of its head for the hand-written requests,
/// which put `mode` first, else a full parse (a map-built request sorts its
/// keys, putting `mode` deep inside).
fn mode_of(request: &str) -> Option<String> {
    let mut n = request.len().min(8192);
    while n > 0 && !request.is_char_boundary(n) {
        n -= 1;
    }
    if let Some(mode) = mode_after_key(&request[..n]) {
        return Some(mode);
    }
    let v: serde_json::Value = serde_json::from_str(request).ok()?;
    v.get("mode")?.as_str().map(str::to_owned)
}

/// `"mode"` followed by a colon and a string literal, or nothing.
///
/// A mode name is `[a-z]+` in every arm of the table, so there are no escapes
/// to unpick here — a quote ends it.
fn mode_after_key(head: &str) -> Option<String> {
    let after = &head[head.find("\"mode\"")? + 6..];
    let after = after.trim_start().strip_prefix(':')?.trim_start();
    let body = after.strip_prefix('"')?;
    Some(body[..body.find('"')?].to_owned())
}

/// Record that something asked for this mode, if this run is tracing. At the
/// one point every caller funnels through, because several callers build the
/// mode name from a parameter that no source scan can follow.
fn record_mode(request: &str) {
    if !*MODE_TRACE.get_or_init(|| std::env::var_os("HEALTH_MODE_TRACE").is_some()) {
        return;
    }
    let Some(mode) = mode_of(request) else { return };
    let mut seen = MODE_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if !seen.insert(mode.clone()) {
        return;
    }
    drop(seen);
    let who = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "?".to_owned());
    // One `write_all` of a short line onto an append descriptor: atomic, where
    // `writeln!`'s two writes could interleave with other processes'.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(MODE_TRACE_PATH)
    {
        use std::io::Write;
        let _ = f.write_all(format!("{mode}\t{who}\n").as_bytes());
    }
}

/// Ask the Lean algorithm mode table one question.
///
/// The request is the same object `verified_cli serve` reads off a line
/// (`{"mode": "focus", …}`); the reply is the body of its `result`, verbatim.
/// A mode that asks the host something gets a decline — the day fold, which
/// does ask, goes through [`serve_with`].
pub fn serve(request: &str) -> Result<String> {
    record_mode(request);
    crate::lean_worker::call_plain(request)
}

/// [`serve`], answering the asks the mode makes mid-request.
pub fn serve_with(request: &str, answerer: &mut dyn Answerer) -> Result<Called> {
    record_mode(request);
    crate::lean_worker::call(request, answerer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum RowShape {
    #[serde(rename = "num")]
    Num,
    #[serde(rename = "str")]
    Str,
    #[serde(rename = "bigintStr")]
    BigintStr,
    #[serde(rename = "decimalStr")]
    DecimalStr,
    #[serde(rename = "dateIso")]
    DateIso,
    #[serde(rename = "dateTimeIso")]
    DateTimeIso,
}

/// `Verified.RowShape.shapeOf` for every column of a result set, in one call.
///
/// ⚠ `None` means REFUSE, not "render null". An unmapped SQL type is one whose
/// rendering nobody has checked against production, and the wrong guess is
/// invisible: a well-formed response carrying the wrong JSON type.
pub fn row_shapes(sql_types: &[&str]) -> Result<Vec<Option<RowShape>>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<Option<RowShape>>,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "rowShapes", "types": sql_types }))?;
    if w.value.len() != sql_types.len() {
        anyhow::bail!(
            "rowShapes: asked for {} column(s), got {}",
            sql_types.len(),
            w.value.len()
        );
    }
    Ok(w.value)
}

/// `Verified.RowShape.formatDateIso` — a DATE, as production ships it.
///
/// ⚠ NOT on the serving path. `crate::row_json` formats these inline, because a
/// day of intraday heart rate is thousands of values and a host call each would
/// be thousands of round trips. This exists so the test can hold that inline
/// formatter against Lean over a corpus.
pub fn format_date_iso(y: i64, m: i64, d: i64) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "formatIso", "parts": [y, m, d] }))?;
    Ok(w.value)
}

/// `Verified.RowShape.formatDateTimeIso`. See [`format_date_iso`] on why this is
/// not what serves.
pub fn format_date_time_iso(
    y: i64,
    m: i64,
    d: i64,
    h: i64,
    mi: i64,
    s: i64,
    ms: i64,
) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire =
        call_json(&serde_json::json!({ "op": "formatIso", "parts": [y, m, d, h, mi, s, ms] }))?;
    Ok(w.value)
}

/// `Verified.Civil.addDays date 1` — the exclusive end of a single day's window.
///
/// ⚠ Civil-calendar arithmetic, not `+86400`. The two agree except across a DST
/// boundary, which is exactly where a day's rows would go missing or double.
pub fn next_day(date: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "nextDay", "date": date }))?;
    Ok(w.value)
}

/// `Verified.LocationTail`'s constants, restated rather than fetched per poll;
/// `tests/suite/location_tail.rs` asserts each against Lean.
pub const TAIL_MAX_POINTS: i64 = 2000;
pub const LATEST_FIX_TTL_MS: i64 = 10_000;
pub const TAIL_TTL_MS: i64 = 10_000;

/// `Verified.LocationTail`'s constants, from Lean. Used by the test that pins
/// the consts above.
pub fn location_policy() -> Result<(i64, i64, i64)> {
    #[derive(Deserialize)]
    struct Wire {
        #[serde(rename = "tailMaxPoints")]
        tail_max_points: i64,
        #[serde(rename = "latestFixTtlMs")]
        latest_fix_ttl_ms: i64,
        #[serde(rename = "tailTtlMs")]
        tail_ttl_ms: i64,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "locationPolicy" }))?;
    Ok((w.tail_max_points, w.latest_fix_ttl_ms, w.tail_ttl_ms))
}

/// `Verified.LocationTail.tailAfter` — the REFERENCE tail, for the drift test.
pub fn tail_after_ref(tss: &[i64], since: i64) -> Result<Vec<i64>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<i64>,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "tailAfter", "tss": tss, "since": since }))?;
    Ok(w.value)
}

/// `Verified.Civil.addDays date (-1)`.
pub fn prev_day(date: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "prevDay", "date": date }))?;
    Ok(w.value)
}

/// `Verified.Connection.statusOf` — is a linked account working?
///
/// ⚠ `stored` is `None` for NO ROW. Passing an empty string instead would take
/// the fall-through and report a connection that does not exist as `active`.
pub fn connection_status(stored: Option<&str>) -> Result<(String, bool)> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
        linked: bool,
    }
    let mut req = serde_json::json!({ "op": "connectionStatus" });
    if let Some(s) = stored {
        req["stored"] = serde_json::json!(s);
    }
    let w: Wire = call_json(&req)?;
    Ok((w.value, w.linked))
}

/// `Verified.Share.buildShareUrl` — the link a recipient is sent.
pub fn build_share_url(base_url: &str, token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(
        &serde_json::json!({ "op": "buildShareUrl", "baseUrl": base_url, "token": token }),
    )?;
    Ok(w.value)
}

/// `Verified.Share.clampShareDaysBack`. Clamps, where [`validate_days`]
/// rejects: a share's `daysBack: 400` is narrowed to 365, a read's `?days=400`
/// is an error. `None` means not a finite number at all.
pub fn clamp_share_days_back(days_back: Option<i64>) -> Result<Option<i64>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Option<i64>,
    }
    let mut req = serde_json::json!({ "op": "clampShareDaysBack" });
    if let Some(d) = days_back {
        req["daysBack"] = serde_json::json!(d);
    }
    let w: Wire = call_json(&req)?;
    Ok(w.value)
}

/// `Verified.LogLine.oneLine`: flatten client text into one log field. The
/// security boundary of `/api/telemetry`; its Unicode rules live in Lean only.
pub fn one_line(raw: &str, max: i64) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "oneLine", "raw": raw, "max": max }))?;
    Ok(w.value)
}

/// `Verified.PhoneTrackPrefs.dateminDate` — which local day the map opens on.
///
/// ⚠ `hour` and `(y, m, d)` must ALREADY be local. Lean has no zone database.
pub fn phonetrack_datemin(y: i64, m: i64, d: i64, hour: i64) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(
        &serde_json::json!({ "op": "phonetrackDatemin", "y": y, "m": m, "d": d, "hour": hour }),
    )?;
    Ok(w.value)
}

/// `Verified.Login.validateReturnTo` — the open-redirect guard.
///
/// ⚠ Always answers a safe path, so callers redirect unconditionally. A host
/// that "optimised away" this call for an input that looks fine would be
/// deciding the security question itself.
pub fn validate_return_to(return_to: Option<&str>) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let mut req = serde_json::json!({ "op": "validateReturnTo" });
    if let Some(r) = return_to {
        req["returnTo"] = serde_json::json!(r);
    }
    let w: Wire = call_json(&req)?;
    Ok(w.value)
}

/// `Verified.Login.encodePending` — the pending-login cookie payload.
pub fn encode_pending(
    expires_at: i64,
    nonce: &str,
    retried: bool,
    return_to: Option<&str>,
) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let mut req = serde_json::json!({
        "op": "encodePending", "expiresAt": expires_at, "nonce": nonce, "retried": retried
    });
    if let Some(r) = return_to {
        req["returnTo"] = serde_json::json!(r);
    }
    let w: Wire = call_json(&req)?;
    Ok(w.value)
}

/// A decoded pending login.
pub struct Pending {
    pub expires_at: i64,
    pub nonce: String,
    /// Already sent back once for a missing `state`; a second miss is refused.
    pub retried: bool,
    pub return_to: Option<String>,
}

/// `Verified.Login.decodePending`. `None` when the payload is malformed.
pub fn decode_pending(raw: &str) -> Result<Option<Pending>> {
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "expiresAt")]
        expires_at: i64,
        nonce: String,
        retried: bool,
        #[serde(rename = "returnTo")]
        return_to: Option<String>,
    }
    #[derive(Deserialize)]
    struct Wire {
        value: Option<Inner>,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "decodePending", "raw": raw }))?;
    Ok(w.value.map(|i| Pending {
        expires_at: i.expires_at,
        nonce: i.nonce,
        retried: i.retried,
        return_to: i.return_to,
    }))
}

/// `Verified.Login.Callback` — what a callback may do with its pending login.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Callback {
    /// `state` matched: exchange the code.
    Accept,
    /// `state` was lost: drop the code and authorize again, once.
    Retry,
    Refuse,
}

/// `Verified.Login.acceptPending` — what may this callback do?
///
/// ⚠ `state` is `None` when Nextcloud DROPPED it, which is the normal case for
/// a browser with no NC session. Sending an empty string is treated the same:
/// retried once, never accepted.
pub fn accept_pending(
    expires_at: i64,
    nonce: &str,
    retried: bool,
    state: Option<&str>,
    now_ms: i64,
) -> Result<Callback> {
    #[derive(Deserialize)]
    struct Wire {
        value: Callback,
    }
    let mut req = serde_json::json!({
        "op": "acceptPending", "expiresAt": expires_at, "nonce": nonce,
        "retried": retried, "nowMs": now_ms
    });
    if let Some(s) = state {
        req["state"] = serde_json::json!(s);
    }
    let w: Wire = call_json(&req)?;
    Ok(w.value)
}

/// `Verified.Login.PENDING_TTL_MS`.
pub fn pending_ttl_ms() -> Result<i64> {
    #[derive(Deserialize)]
    struct Wire {
        value: i64,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "pendingTtlMs" }))?;
    Ok(w.value)
}

/// One metric's latest reading and the baseline behind it.
pub struct Stat {
    pub latest: f64,
    pub mean: f64,
    pub sd: f64,
    pub n: i64,
}

/// The raw recovery picture as of one morning.
pub struct RecoveryAsOf {
    pub as_of: String,
    pub sleep_hours: Option<f64>,
    pub hrv: Option<Stat>,
    pub resting_hr: Option<Stat>,
}

/// A `Float` that crossed as its IEEE-754 bit pattern.
///
/// ⚠ The pattern is a decimal STRING, not a number: it reaches 2^64, well past
/// the 2^53 JSON integers are exact to, so a bare number would be re-rounded on
/// the way through. See `ServeEntry`'s float-bit-transport note.
fn f64_from_bits_str(s: &str) -> Result<f64> {
    let bits: u64 = s
        .parse()
        .with_context(|| format!("{s:?} is not an IEEE-754 bit pattern"))?;
    Ok(f64::from_bits(bits))
}

/// `Verified.Recovery.recoveryAsOf` — three streams, judged as of `day`.
///
/// ⚠ Answers numbers only. Composing a readiness score is the CALLER's job and
/// must stay there, or the two apps drift on what a bad day means.
pub fn recovery_as_of(
    day: &str,
    hrv: &[(String, Option<f64>)],
    rhr: &[(String, Option<f64>)],
    sleep: &[(String, Option<f64>)],
) -> Result<RecoveryAsOf> {
    #[derive(Deserialize)]
    struct WireStat {
        #[serde(rename = "latestBits")]
        latest_bits: String,
        #[serde(rename = "meanBits")]
        mean_bits: String,
        #[serde(rename = "sdBits")]
        sd_bits: String,
        n: i64,
    }
    #[derive(Deserialize)]
    struct Wire {
        #[serde(rename = "asOf")]
        as_of: String,
        #[serde(rename = "sleepHoursBits")]
        sleep_hours_bits: Option<String>,
        hrv: Option<WireStat>,
        #[serde(rename = "restingHr")]
        resting_hr: Option<WireStat>,
    }

    let ser = |xs: &[(String, Option<f64>)]| -> Vec<serde_json::Value> {
        xs.iter()
            .map(|(d, v)| serde_json::json!({ "date": d, "value": v }))
            .collect()
    };
    let w: Wire = call_json(&serde_json::json!({
        "op": "recoveryAsOf", "day": day,
        "hrv": ser(hrv), "rhr": ser(rhr), "sleep": ser(sleep),
    }))?;

    let stat = |s: Option<WireStat>| -> Result<Option<Stat>> {
        match s {
            None => Ok(None),
            Some(s) => Ok(Some(Stat {
                latest: f64_from_bits_str(&s.latest_bits)?,
                mean: f64_from_bits_str(&s.mean_bits)?,
                sd: f64_from_bits_str(&s.sd_bits)?,
                n: s.n,
            })),
        }
    };
    Ok(RecoveryAsOf {
        as_of: w.as_of,
        sleep_hours: w
            .sleep_hours_bits
            .as_deref()
            .map(f64_from_bits_str)
            .transpose()?,
        hrv: stat(w.hrv)?,
        resting_hr: stat(w.resting_hr)?,
    })
}

/// `Verified.Recovery.spanIsAnswerable` — is this range answerable in one call?
pub fn recovery_span_ok(from: &str, to: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Wire {
        value: bool,
    }
    let w: Wire = call_json(&serde_json::json!({ "op": "recoverySpan", "from": from, "to": to }))?;
    Ok(w.value)
}

/// How the place picker renders one mined place.
pub struct PlaceProjection {
    pub label: String,
    pub named: bool,
    pub category: Option<String>,
}

/// `placeLabel` / `isNamedPlace` / `categoryOfSubtype`, in one call.
///
/// ⚠ `label` and `named` answer DIFFERENT questions. A bare "Stay" has a label
/// so the row renders, and is not `named` so a picker can hide it — several
/// Stays are indistinguishable to a person choosing between them.
pub fn place_projection(
    display_name: Option<&str>,
    amenity_label: Option<&str>,
    amenity_kind: Option<&str>,
) -> Result<PlaceProjection> {
    #[derive(Deserialize)]
    struct Wire {
        label: String,
        named: bool,
        category: Option<String>,
    }
    let mut req = serde_json::json!({ "op": "placeProjection" });
    if let Some(v) = display_name {
        req["displayName"] = serde_json::json!(v);
    }
    if let Some(v) = amenity_label {
        req["amenityLabel"] = serde_json::json!(v);
    }
    if let Some(v) = amenity_kind {
        req["amenityKind"] = serde_json::json!(v);
    }
    let w: Wire = call_json(&req)?;
    Ok(PlaceProjection {
        label: w.label,
        named: w.named,
        category: w.category,
    })
}

/// A focus place, as the presence selector reads it.
pub struct PresencePlace {
    pub id: i64,
    pub display_name: Option<String>,
    pub amenity_label: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

/// The place the user is standing in.
pub struct CurrentPlace {
    pub id: i64,
    pub label: String,
    pub display_name: Option<String>,
    pub amenity_label: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub distance_m: f64,
}

/// `Verified.Geo.CurrentPlace.pickCurrentPlace` — nearest within 100 m.
///
/// ⚠ Coordinates cross as IEEE-754 bit patterns: the seventh decimal of a fix
/// moves which place wins, and a JSON number would be re-rounded on the way.
pub fn pick_current_place(
    lat: f64,
    lon: f64,
    places: &[PresencePlace],
) -> Result<Option<CurrentPlace>> {
    #[derive(Deserialize)]
    struct Inner {
        id: i64,
        label: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
        #[serde(rename = "amenityLabel")]
        amenity_label: Option<String>,
        #[serde(rename = "centroidLatBits")]
        lat_bits: String,
        #[serde(rename = "centroidLonBits")]
        lon_bits: String,
        #[serde(rename = "distanceMBits")]
        distance_bits: String,
    }
    #[derive(Deserialize)]
    struct Wire {
        value: Option<Inner>,
    }
    let wire_places: Vec<serde_json::Value> = places
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "displayName": p.display_name,
                "amenityLabel": p.amenity_label,
                "latBits": p.lat.to_bits().to_string(),
                "lonBits": p.lon.to_bits().to_string(),
            })
        })
        .collect();
    let w: Wire = call_json(&serde_json::json!({
        "op": "pickCurrentPlace",
        "latBits": lat.to_bits().to_string(),
        "lonBits": lon.to_bits().to_string(),
        "places": wire_places,
    }))?;
    Ok(match w.value {
        None => None,
        Some(i) => Some(CurrentPlace {
            id: i.id,
            label: i.label,
            display_name: i.display_name,
            amenity_label: i.amenity_label,
            lat: f64_from_bits_str(&i.lat_bits)?,
            lon: f64_from_bits_str(&i.lon_bits)?,
            distance_m: f64_from_bits_str(&i.distance_bits)?,
        }),
    })
}

/// One retained GPS fix, as the owntracks decision reads it.
pub struct OwntracksFix {
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
    pub vel: Option<f64>,
    pub trigger: Option<String>,
    pub monitoring_mode: Option<i64>,
}

/// What to tell the phone.
pub struct OwntracksConfig {
    pub profile: String,
    pub monitoring: i64,
    pub move_mode_locator_interval: Option<i64>,
}

/// `Verified.Owntracks.decideRemoteConfig` — how hard the phone should look.
///
/// ⚠ Takes the WHOLE pruned history: the decision is about a trajectory, not a
/// fix. Coordinates cross as IEEE-754 bit patterns because the straightness
/// ratio divides two haversine distances, and a re-rounded coordinate can move
/// it across the walking threshold.
/// `local_hour` is the hour of the day where the phone is, 0–23 in the user's
/// home zone; `None` when no zone could be resolved, which the rules read as
/// daytime.
pub fn owntracks_config(
    history: &[OwntracksFix],
    prev_profile: Option<&str>,
    local_hour: Option<u32>,
) -> Result<OwntracksConfig> {
    #[derive(Deserialize)]
    struct Wire {
        profile: String,
        monitoring: i64,
        #[serde(rename = "moveModeLocatorInterval")]
        interval: Option<i64>,
    }
    let wire_history: Vec<serde_json::Value> = history
        .iter()
        .map(|f| {
            serde_json::json!({
                "ts": f.ts,
                "latBits": f.lat.to_bits().to_string(),
                "lonBits": f.lon.to_bits().to_string(),
                "velBits": f.vel.map(|v| v.to_bits().to_string()),
                "trigger": f.trigger,
                "monitoringMode": f.monitoring_mode,
            })
        })
        .collect();
    let mut req = serde_json::json!({
        "op": "owntracksConfig",
        "history": wire_history,
        "localHour": local_hour,
    });
    if let Some(p) = prev_profile {
        req["prevProfile"] = serde_json::json!(p);
    }
    let w: Wire = call_json(&req)?;
    Ok(OwntracksConfig {
        profile: w.profile,
        monitoring: w.monitoring,
        move_mode_locator_interval: w.interval,
    })
}

/// How long a device's OwnTracks fix history is kept, in seconds.
pub fn owntracks_history_max_age_sec() -> i64 {
    600
}

/// `Verified.PresenceLog.computeRow`: one day's decoded segments rolled up.
/// `None` is an answer: a day with nothing over a minute has no row.
///
/// Segments must arrive in the decoder's order: a tie on minutes keeps the
/// place seen first.
pub struct PresenceRow {
    pub dominant_place_id: Option<i64>,
    pub dominant_fraction: f64,
    pub end_of_day_place_id: Option<i64>,
    pub end_of_day_ts: Option<i64>,
    pub end_of_day_posterior: f64,
}

pub fn presence_row(segments: &serde_json::Value) -> Result<Option<PresenceRow>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Option<Inner>,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "dominantPlaceId")]
        dominant_place_id: Option<i64>,
        #[serde(rename = "dominantFractionBits")]
        dominant_fraction_bits: String,
        #[serde(rename = "endOfDayPlaceId")]
        end_of_day_place_id: Option<i64>,
        #[serde(rename = "endOfDayTs")]
        end_of_day_ts: Option<i64>,
        #[serde(rename = "endOfDayPosteriorBits")]
        end_of_day_posterior_bits: String,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "presenceRow",
        "segments": segments,
    }))?;
    // Fractions cross as bit patterns, so the DECIMAL column gets the exact
    // ratio.
    let bits = |s: &str| -> Result<f64> {
        Ok(f64::from_bits(s.parse::<u64>().with_context(|| {
            format!("presenceRow: {s:?} is not a bit pattern")
        })?))
    };
    Ok(match w.value {
        None => None,
        Some(v) => Some(PresenceRow {
            dominant_place_id: v.dominant_place_id,
            dominant_fraction: bits(&v.dominant_fraction_bits)?,
            end_of_day_place_id: v.end_of_day_place_id,
            end_of_day_ts: v.end_of_day_ts,
            end_of_day_posterior: bits(&v.end_of_day_posterior_bits)?,
        }),
    })
}

/// `Verified.Geo.LineStations.lineNamesMatching` — every mirror line name whose
/// text contains this line's base token.
///
/// ⚠ The caller feeds the result straight into an indexed `name IN (…)`. Doing
/// the same match in SQL as `LIKE '%base%'` cannot use the name index and scans
/// every railway row; that is the whole reason this step is separate.
pub fn line_names_matching(line: &str, all_names: &[String]) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<String>,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "lineNamesMatching",
        "line": line,
        "allNames": all_names,
    }))?;
    Ok(w.value)
}

/// `Verified.Geo.LineStations.filterStationsByLineProximity` — the stations a
/// line's track passes within 300 m of.
///
/// ⚠ Coordinates cross as IEEE-754 BIT PATTERNS in both directions. The rule
/// compares a computed distance against a 300 m threshold, and a re-rounded
/// coordinate moves which stations a line is held to serve.
///
/// ⚠ ORDER IS PRESERVED and is part of the answer — downstream journey
/// resolution reads positional relationships out of this list.
pub fn filter_stations_by_line_proximity(
    stations: &[serde_json::Value],
    ways: &[serde_json::Value],
) -> Result<Vec<serde_json::Value>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<serde_json::Map<String, serde_json::Value>>,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "filterStationsByLineProximity",
        "stations": stations,
        "ways": ways,
    }))?;
    // Back to the shape `fold_payload::stations_on_line` writes and
    // `DayEntry.parseLineStation` reads: `[name, latBits, lonBits]`.
    Ok(w.value
        .into_iter()
        .map(|m| {
            serde_json::json!([
                m.get("name").cloned().unwrap_or_default(),
                m.get("latBits").cloned().unwrap_or_default(),
                m.get("lonBits").cloned().unwrap_or_default(),
            ])
        })
        .collect())
}

/// `Verified.Geo.Landmarks.shapeLandmarks`: the venues near a stay, which name
/// it.
///
/// ⚠ Scored rows arrive under `rows`, with `distanceM` as a bit pattern.
/// Reading either wrongly yields an empty list, which claims "no venues here"
/// instead of declining.
pub fn shape_landmarks(
    points: &serde_json::Value,
    lines: &serde_json::Value,
) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<serde_json::Map<String, serde_json::Value>>,
    }

    let feats = |v: &serde_json::Value, is_point: bool| -> Vec<serde_json::Value> {
        v.get("rows")
            .and_then(serde_json::Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        serde_json::json!({
                            "name": r.get("name").and_then(serde_json::Value::as_str),
                            // Already `[[k, v], …]` from the scored row.
                            "tags": r.get("tags").cloned().unwrap_or_else(|| serde_json::json!([])),
                            "distBits": r
                                .get("distanceM")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("0"),
                            "encloses": r
                                .get("encloses")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false),
                            "isPoint": is_point,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };

    let w: Wire = call_json(&serde_json::json!({
        "op": "shapeLandmarks",
        "points": feats(points, true),
        "lines": feats(lines, false),
    }))?;

    let out: Vec<serde_json::Value> = w
        .value
        .into_iter()
        .map(|m| {
            let d = m
                .get("distanceMBits")
                .and_then(serde_json::Value::as_str)
                .and_then(|s| s.parse::<u64>().ok())
                .map(f64::from_bits)
                .unwrap_or(f64::INFINITY);
            let mut o = serde_json::Map::new();
            o.insert("name".into(), m.get("name").cloned().unwrap_or_default());
            o.insert("type".into(), m.get("type").cloned().unwrap_or_default());
            o.insert(
                "subtype".into(),
                m.get("subtype").cloned().unwrap_or_default(),
            );
            // A bit-pattern string, as `DayEntry.parsePoi` reads it (`jBits`);
            // a JSON number fails the fold's decode.
            o.insert(
                "distanceM".into(),
                serde_json::Value::String(crate::fold_payload::bits(d)),
            );
            // `enclosing` is always present, as the recorded traces carry it;
            // only `openingHours` is conditional.
            o.insert(
                "enclosing".into(),
                serde_json::Value::Bool(
                    m.get("enclosing")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                ),
            );
            // Inside an open space's outline (`Landmarks.ENCLOSING_OPEN_SPACES`):
            // only when true, so the recorded traces, which never carry it,
            // read the same.
            if m.get("inside").and_then(serde_json::Value::as_bool) == Some(true) {
                o.insert("inside".into(), serde_json::Value::Bool(true));
            }
            if let Some(h) = m.get("openingHours").and_then(serde_json::Value::as_str) {
                o.insert("openingHours".into(), serde_json::Value::String(h.into()));
            }
            serde_json::Value::Object(o)
        })
        .collect();
    Ok(serde_json::Value::Array(out))
}

/// One focus cluster's amenity vote: `Verified.Geo.FocusMining.mineCluster`.
///
/// The whole vote crosses in one call: its three gates read each other's
/// leavings (and an exact tie keeps the first name seen), so a call per gate
/// would move those tie-breaks to this side.
///
/// `landmarks` on each stay and on `centroid` are `shape_landmarks` output,
/// passed back with the raw `openingHours` for Lean to resolve per stay.
pub struct MinedCluster {
    pub amenity_label: Option<String>,
    pub amenity_kind: Option<String>,
    /// Which gate refused, when one did. `None` with no label means no stay
    /// ever cast a vote — silence, not a refusal.
    pub refusal: Option<String>,
    pub attributed: Vec<AttributedStay>,
}

pub struct AttributedStay {
    pub subtype: String,
    pub duration_sec: f64,
    pub local_hour: i64,
    /// When the stay started, so a prior can be taken as of a past day. A plain
    /// unix second, not float bits.
    pub start_unix: i64,
}

/// One stay's contribution: its window, its resolved local hour, and the
/// venues near it.
#[derive(Clone)]
pub struct MineStay {
    pub start_ts: i64,
    pub end_ts: i64,
    pub local_hour: i64,
    pub duration_sec: i64,
    /// `(dayOfWeek, minuteOfDay)` across the stay, from
    /// `timezone::local_stay_samples`. Lean resolves opening hours over these.
    pub samples: Vec<(u32, u32)>,
    pub landmarks: serde_json::Value,
}

/// The cron's gate-1 constants. They cross as bit patterns: `minFraction` is
/// compared against a computed ratio.
pub const MINE_MIN_WEIGHT_SEC: f64 = 60.0 * 30.0;
pub const MINE_MIN_FRACTION: f64 = 0.5;

pub fn mine_cluster(stays: &[MineStay], centroid: &serde_json::Value) -> Result<MinedCluster> {
    #[derive(Deserialize)]
    struct Wire {
        value: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "amenityLabel")]
        amenity_label: Option<String>,
        #[serde(rename = "amenityKind")]
        amenity_kind: Option<String>,
        refusal: Option<String>,
        attributed: Vec<WireStay>,
    }
    #[derive(Deserialize)]
    struct WireStay {
        subtype: String,
        #[serde(rename = "durationSecBits")]
        duration_sec_bits: String,
        #[serde(rename = "localHour")]
        local_hour: i64,
        // Required: a stay defaulted to 0 would date to 1970, and an as-of
        // prior would include it in every day.
        #[serde(rename = "startUnix")]
        start_unix: i64,
    }

    let stays_json: Vec<serde_json::Value> = stays
        .iter()
        .map(|s| {
            serde_json::json!({
                "startTs": s.start_ts,
                "endTs": s.end_ts,
                "localHour": s.local_hour,
                "durationSec": s.duration_sec,
                "samples": s.samples.iter().map(|(d, m)| vec![*d, *m]).collect::<Vec<_>>(),
                "landmarks": s.landmarks,
            })
        })
        .collect();

    let w: Wire = call_json(&serde_json::json!({
        "op": "mineCluster",
        "stays": stays_json,
        "centroidLandmarks": centroid,
        "minWeightBits": crate::fold_payload::bits(MINE_MIN_WEIGHT_SEC),
        "minFractionBits": crate::fold_payload::bits(MINE_MIN_FRACTION),
    }))?;

    Ok(MinedCluster {
        amenity_label: w.value.amenity_label,
        amenity_kind: w.value.amenity_kind,
        refusal: w.value.refusal,
        attributed: w
            .value
            .attributed
            .into_iter()
            .map(|a| {
                Ok(AttributedStay {
                    subtype: a.subtype,
                    duration_sec: f64::from_bits(a.duration_sec_bits.parse::<u64>().with_context(
                        || {
                            format!(
                                "mineCluster: {:?} is not a bit pattern",
                                a.duration_sec_bits
                            )
                        },
                    )?),
                    local_hour: a.local_hour,
                    start_unix: a.start_unix,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

/// Aggregate every cluster's attributed stays into the venue-type prior blob:
/// `Verified.Geo.VenuePrior.minePriors`. Returns the JSON stored in
/// `venue_type_priors.priors_json`: `{bySubtype: {k: {visits, dwell[],
/// hours[]}}, byCategory, totalVisits}`.
///
/// A full recompute, so a re-mine is reproducible from the stays alone. Keys
/// keep first-seen order, which `shapeScore` reads back. Counts are written as
/// JSON numbers, the column's form.
#[derive(Deserialize)]
struct WirePriorsBlob {
    #[serde(rename = "bySubtype")]
    by_subtype: Vec<(String, WirePriorStats)>,
    #[serde(rename = "byCategory")]
    by_category: Vec<(String, WirePriorStats)>,
    #[serde(rename = "totalVisitsBits")]
    total_visits_bits: String,
    /// The evidence behind the aggregate, so a past day can be re-aggregated as
    /// it stood then. Absent in `priorsAsOf`'s reply, which answers from it.
    #[serde(default)]
    events: Vec<WirePriorEvent>,
}

/// One unit of mined evidence, as `Verified.Geo.VenuePrior.PriorEvent` spells
/// it. `weight` rides as bits (soft attribution makes it fractional); the rest
/// are integers the shell already holds as integers.
#[derive(Deserialize, Serialize, Clone)]
pub struct WirePriorEvent {
    pub subtype: String,
    #[serde(rename = "startUnix")]
    pub start_unix: i64,
    pub dwell: u32,
    pub hour: u32,
    #[serde(rename = "weightBits")]
    pub weight_bits: String,
}

#[derive(Deserialize)]
struct WirePriorStats {
    visits: String,
    dwell: Vec<String>,
    hours: Vec<String>,
}

/// Bit-pattern wire blob → the JSON-numbers blob `venue_type_priors` holds.
/// Needs `serde_json`'s `preserve_order` (on in `Cargo.toml`): the default map
/// would sort the keys and lose first-seen order.
fn wire_priors_to_json(w: &WirePriorsBlob) -> Result<serde_json::Value> {
    let bits = |s: &str| -> Result<f64> {
        Ok(f64::from_bits(s.parse::<u64>().with_context(|| {
            format!("priors blob: {s:?} is not a bit pattern")
        })?))
    };
    let nums = |xs: &[String]| -> Result<Vec<serde_json::Value>> {
        xs.iter().map(|x| Ok(serde_json::json!(bits(x)?))).collect()
    };
    let table = |t: &[(String, WirePriorStats)]| -> Result<serde_json::Value> {
        let mut m = serde_json::Map::new();
        for (k, s) in t {
            m.insert(
                k.clone(),
                serde_json::json!({
                    "visits": bits(&s.visits)?,
                    "dwell": nums(&s.dwell)?,
                    "hours": nums(&s.hours)?,
                }),
            );
        }
        Ok(serde_json::Value::Object(m))
    };
    Ok(serde_json::json!({
        "bySubtype": table(&w.by_subtype)?,
        "byCategory": table(&w.by_category)?,
        "totalVisits": bits(&w.total_visits_bits)?,
        // Alongside the aggregate, which a reader without event support uses.
        "events": w.events,
    }))
}

/// Re-aggregate stored evidence as it stood at `as_of_unix`. The aggregation
/// is Lean's, not a second copy here.
pub fn priors_as_of(events: &[WirePriorEvent], as_of_unix: i64) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Wire {
        value: WirePriorsBlob,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "priorsAsOf",
        "events": events,
        "asOfUnix": as_of_unix,
    }))?;
    wire_priors_to_json(&w.value)
}

pub fn mine_priors(attributed: &[AttributedStay]) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Wire {
        value: WirePriorsBlob,
    }

    let stays: Vec<serde_json::Value> = attributed
        .iter()
        .map(|a| {
            serde_json::json!({
                "subtype": a.subtype,
                "durationSecBits": crate::fold_payload::bits(a.duration_sec),
                "localHour": a.local_hour,
                "startUnix": a.start_unix,
            })
        })
        .collect();

    let w: Wire = call_json(&serde_json::json!({
        "op": "minePriors",
        "attributed": stays,
    }))?;

    wire_priors_to_json(&w.value)
}

/// What `mine_priors_soft` reports beside the blob: whether soft attribution
/// grows the effective sample size far past the hard count.
pub struct SoftMineReport {
    /// Σ responsibilities over every candidate of every stay — whole visits'
    /// worth of evidence, excluding `other` mass.
    pub ess: f64,
    pub stays_total: u64,
    /// Stays with at least one candidate venue (the rest teach nothing).
    pub stays_teaching: u64,
    /// Mean `other` mass over teaching stays — sanity vs the referee's
    /// measured ~0.083 truth-not-in-candidates base rate.
    pub mean_other: f64,
}

/// The soft twin of `mine_priors` (`Verified.Geo.VenuePrior.minePriorsSoft`).
/// Takes `mine_cluster`'s per-stay wire, so its population is the one the
/// mining job mines.
pub fn mine_priors_soft(stays: &[MineStay]) -> Result<(serde_json::Value, SoftMineReport)> {
    #[derive(Deserialize)]
    struct Wire {
        value: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        priors: WirePriorsBlob,
        #[serde(rename = "essBits")]
        ess_bits: String,
        #[serde(rename = "staysTotal")]
        stays_total: u64,
        #[serde(rename = "staysTeaching")]
        stays_teaching: u64,
        #[serde(rename = "meanOtherBits")]
        mean_other_bits: String,
    }

    let stays_json: Vec<serde_json::Value> = stays
        .iter()
        .map(|s| {
            serde_json::json!({
                "startTs": s.start_ts,
                "endTs": s.end_ts,
                "localHour": s.local_hour,
                "durationSec": s.duration_sec,
                "samples": s.samples.iter().map(|(d, m)| vec![*d, *m]).collect::<Vec<_>>(),
                "landmarks": s.landmarks,
            })
        })
        .collect();

    let w: Wire = call_json(&serde_json::json!({
        "op": "minePriorsSoft",
        "stays": stays_json,
    }))?;

    let bits = |s: &str| -> Result<f64> {
        Ok(f64::from_bits(s.parse::<u64>().with_context(|| {
            format!("minePriorsSoft: {s:?} is not a bit pattern")
        })?))
    };
    let report = SoftMineReport {
        ess: bits(&w.value.ess_bits)?,
        stays_total: w.value.stays_total,
        stays_teaching: w.value.stays_teaching,
        mean_other: bits(&w.value.mean_other_bits)?,
    };
    Ok((wire_priors_to_json(&w.value.priors)?, report))
}

/// The `focus` mode's answer, decoded.
///
/// ⚠ `mined` stays `Value`. The caller reads a dozen optional fields off each
/// cluster (`sleepFitbitH`, `sleepH`, the stay tuples); a struct here would be a
/// second schema to hold in step with Lean's, for no checking the caller does
/// not already do per field.
pub struct FocusPlaces {
    /// One mined cluster per entry, exactly as Lean emitted it.
    pub mined: Vec<serde_json::Value>,
    /// Cluster id -> display name.
    pub names: std::collections::HashMap<i64, String>,
    /// One per mined cluster, IN ORDER: the existing row it continues, if any.
    pub assignments: Vec<Option<i64>>,
    /// Existing rows this mining says are gone.
    pub deleted: Vec<i64>,
}

/// Mine focus places from a point history: the `focus` serve mode.
/// `clusters` is empty on purpose: the mode accepts built clusters only for
/// fixture tests, and mining builds its own from points.
pub fn focus_places(
    points: &[(i64, f64, f64, Option<f64>)],
    sleep_windows: &[[i64; 2]],
    old: &[serde_json::Value],
) -> Result<FocusPlaces> {
    let req = serde_json::json!({
        "mode": "focus",
        "points": points.iter().map(|(ts, lat, lon, acc)| serde_json::json!([
            ts,
            crate::fold_payload::bits(*lat),
            crate::fold_payload::bits(*lon),
            match acc { Some(a) => serde_json::json!(crate::fold_payload::bits(*a)),
                        None => serde_json::Value::Null },
        ])).collect::<Vec<_>>(),
        "sleepWindows": sleep_windows,
        "clusters": [],
        "old": old,
    });
    let out = serve(&serde_json::to_string(&req)?)?;
    let focus: serde_json::Value =
        serde_json::from_str(&out).context("focus mode answer is not JSON")?;
    if let Some(e) = focus.get("error") {
        anyhow::bail!("focus mode: {e}");
    }
    let mined: Vec<serde_json::Value> = focus
        .get("mined")
        .and_then(|v| v.as_array())
        .context("focus mode answer has no `mined`")?
        .clone();
    let names: std::collections::HashMap<i64, String> = focus
        .get("names")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some((p.first()?.as_i64()?, p.get(1)?.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let assignments: Vec<Option<i64>> = focus
        .pointer("/identity/assignments")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(serde_json::Value::as_i64).collect())
        .unwrap_or_default();
    let deleted: Vec<i64> = focus
        .pointer("/identity/deleted")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
        .unwrap_or_default();
    // One assignment per mined cluster, or a cluster is paired with the wrong
    // existing row.
    if assignments.len() != mined.len() {
        anyhow::bail!(
            "focus mode returned {} identity assignment(s) for {} cluster(s)",
            assignments.len(),
            mined.len()
        );
    }
    Ok(FocusPlaces {
        mined,
        names,
        assignments,
        deleted,
    })
}

/// A route relation's own track between two points (`RailSnap.snapOnRelation`),
/// as the `{lat, lon}` list `rail_route_cache` stores, with the fixes' median
/// distance to it (m); `None` when the relation does not join them.
pub fn relation_route(
    start_ts: f64,
    end_ts: f64,
    ways: &[serde_json::Value],
    board: (f64, f64),
    alight: (f64, f64),
    fixes: &[(f64, f64)],
) -> Result<Option<(f64, Vec<serde_json::Value>)>> {
    let pt = |(la, lo): (f64, f64)| {
        serde_json::json!([crate::fold_payload::bits(la), crate::fold_payload::bits(lo)])
    };
    let req = serde_json::json!({
        "mode": "relationroute",
        "ways": ways,
        "board": pt(board),
        "alight": pt(alight),
        "startTsBits": crate::fold_payload::bits(start_ts),
        "endTsBits": crate::fold_payload::bits(end_ts),
        "fixes": fixes.iter().map(|&f| pt(f)).collect::<Vec<_>>(),
    });
    let out = serve(&serde_json::to_string(&req)?)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("relationroute answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("relationroute: {e}");
    }
    let Some(path) = v.get("path").and_then(|p| p.as_array()) else {
        return Ok(None);
    };
    let geom = path
        .iter()
        .filter_map(|p| {
            let a = p.as_array()?;
            let f = |i: usize| -> Option<f64> {
                Some(f64::from_bits(a.get(i)?.as_str()?.parse::<u64>().ok()?))
            };
            Some(serde_json::json!({ "lat": f(0)?, "lon": f(1)? }))
        })
        .collect::<Vec<_>>();
    let median = v
        .get("medianM")
        .and_then(|m| m.as_str()?.parse::<u64>().ok())
        .map_or(f64::INFINITY, f64::from_bits);
    Ok(if geom.is_empty() {
        None
    } else {
        Some((median, geom))
    })
}

/// One train leg snapped onto its rail corridor: the `railsnap` mode over
/// `Verified.Geo.RailSnap`, which builds the graph from the raw ways itself.
///
/// `on_line` selects the fallback, `snapTrainSegmentOnLine`: route over only
/// the named line's ways, leaning on the label. The corridor form declines
/// below 12 fixes, since a thin cloud cannot evidence a corridor.
///
/// `Ok(None)` means leave it raw, never a guessed path.
pub fn rail_snap(
    way_name: &str,
    start_ts: f64,
    end_ts: f64,
    lines: &[serde_json::Value],
    stations: &[serde_json::Value],
    fixes: &[(f64, f64)],
    on_line: bool,
) -> Result<Option<Vec<serde_json::Value>>> {
    let req = serde_json::json!({
        "mode": "railsnap",
        "segment": {
            "startTsBits": crate::fold_payload::bits(start_ts),
            "endTsBits": crate::fold_payload::bits(end_ts),
            "wayName": way_name,
        },
        "lines": lines,
        "stations": stations,
        "fixes": fixes.iter().map(|(la, lo)| serde_json::json!([
            crate::fold_payload::bits(*la), crate::fold_payload::bits(*lo)
        ])).collect::<Vec<_>>(),
        "onLine": on_line,
    });
    let out = serve(&serde_json::to_string(&req)?)?;
    let v: serde_json::Value = serde_json::from_str(&out).context("railsnap answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("railsnap: {e}");
    }
    // `path: null` is a refusal, a normal answer (unresolved stations, a thin
    // cloud); an `error` is a malformed request.
    let Some(path) = v.get("path").and_then(|p| p.as_array()) else {
        return Ok(None);
    };
    // Emitted as `[latBits, lonBits, tsBits]`; the cache stores `{lat, lon}`.
    let geom = path
        .iter()
        .filter_map(|p| {
            let a = p.as_array()?;
            let f = |i: usize| -> Option<f64> {
                Some(f64::from_bits(a.get(i)?.as_str()?.parse::<u64>().ok()?))
            };
            Some(serde_json::json!({ "lat": f(0)?, "lon": f(1)? }))
        })
        .collect::<Vec<_>>();
    Ok(if geom.is_empty() { None } else { Some(geom) })
}

/// One day's HSMM decode, as segments: the `assemblesegments` mode. The model
/// is built in Lean from raw `edges`/`nodes`/`obs`/`places`, and the state
/// table never crosses: grouping into segments happens there.
///
/// `Ok(None)` is the degenerate case Lean reports (no viable path), an answer
/// distinct from an error.
pub fn assemble_segments(input: &serde_json::Value) -> Result<Option<serde_json::Value>> {
    Ok(assemble_response(input)?.map(|v| v["segments"].clone()))
}

/// The whole `assemblesegments` answer — `segments`, `best`,
/// `longestJourneyMin` — or `None` when the decode is degenerate. The decode
/// corpus reads the longest journey against the journey bound.
pub fn assemble_response(input: &serde_json::Value) -> Result<Option<serde_json::Value>> {
    let mut req = input.clone();
    req.as_object_mut()
        .context("assemblesegments input is not an object")?
        .insert("mode".into(), serde_json::json!("assemblesegments"));
    let out = serve(&serde_json::to_string(&req)?)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("assemblesegments answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("assemblesegments: {e}");
    }
    if v.get("degenerate").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(None);
    }
    v.get("segments")
        .context("assemblesegments answer has no `segments`")?;
    Ok(Some(v))
}

// ---------------------------------------------------------------------------
// The decoder's place/line hard constraint.

/// `Verified.Hsmm.Assemble.KNOWN_LINES`: the train lines the state space is
/// built from. Asked, not restated, so the shell resolves stations for exactly
/// the lines the model has states for.
pub fn known_lines() -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<String>,
    }
    let raw = serve(&serde_json::json!({ "mode": "knownlines" }).to_string())?;
    let w: Wire = decode_serve(&raw, "knownlines")?;
    Ok(w.value)
}

/// `Verified.Hsmm.PlaceNearLine.buildPlaceNearLine`: the `"{placeId}|{line}"`
/// keys the transition matrix hard-zeroes. `lines` pairs a line with its
/// stations as `[latBits, lonBits]`; the 400 m rule is Lean's.
///
/// ⚠ An empty set is not neutral: it removes every hard zero, permitting
/// impossible boardings while still producing a plausible timeline.
pub fn place_near_line(
    places: &[(i64, f64, f64)],
    lines: &[(String, Vec<(f64, f64)>)],
) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct Wire {
        value: Vec<String>,
    }
    let b = crate::fold_payload::bits;
    let places: Vec<serde_json::Value> = places
        .iter()
        .map(|(id, lat, lon)| serde_json::json!([id, b(*lat), b(*lon)]))
        .collect();
    let lines: Vec<serde_json::Value> = lines
        .iter()
        .map(|(name, stations)| {
            serde_json::json!([
                name,
                stations
                    .iter()
                    .map(|(lat, lon)| serde_json::json!([b(*lat), b(*lon)]))
                    .collect::<Vec<_>>()
            ])
        })
        .collect();
    let raw = serve(
        &serde_json::json!({ "mode": "placenearline", "places": places, "lines": lines })
            .to_string(),
    )?;
    let w: Wire = decode_serve(&raw, "placenearline")?;
    Ok(w.value)
}

/// One fix as the HSMM sees it, on the wire as `[ts, latBits, lonBits, speedBits]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpsFix {
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
    pub speed_kmh: f64,
    /// The fix's reported horizontal accuracy in metres, when the capture
    /// carries it.
    pub accuracy_m: Option<f64>,
}

/// `Verified.Hsmm.GpsOutliers.dropGpsOutliers`: the physically impossible fixes,
/// removed before anything looks at the day. It runs before both halves of the
/// decode, so the tensor and the rail/road distances describe the same fixes.
pub fn drop_gps_outliers(points: &[GpsFix]) -> Result<Vec<GpsFix>> {
    #[derive(Deserialize)]
    struct Wire {
        pts: Vec<(i64, String, String, String)>,
    }
    let pts: Vec<serde_json::Value> = points
        .iter()
        .map(|p| {
            serde_json::json!([
                p.ts,
                crate::fold_payload::bits(p.lat),
                crate::fold_payload::bits(p.lon),
                crate::fold_payload::bits(p.speed_kmh)
            ])
        })
        .collect();
    let raw = serve(&serde_json::json!({ "mode": "gpsoutliers", "pts": pts }).to_string())?;
    let w: Wire = decode_serve(&raw, "gpsoutliers")?;
    // The wire carries what the filter reads; the accuracy rides back by ts.
    let accuracy: std::collections::HashMap<i64, f64> = points
        .iter()
        .filter_map(|p| Some((p.ts, p.accuracy_m?)))
        .collect();
    Ok(w.pts
        .into_iter()
        .map(|(ts, lat, lon, speed)| GpsFix {
            ts,
            lat: f64::from_bits(lat.parse().unwrap_or(0)),
            lon: f64::from_bits(lon.parse().unwrap_or(0)),
            speed_kmh: f64::from_bits(speed.parse().unwrap_or(0)),
            accuracy_m: accuracy.get(&ts).copied(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Per-minute rail/road proximity: two calls because the middle is an OSM
// lookup. Every decision is `Verified.Hsmm.RailRoadProximity`'s; this side runs
// `nearby_ways` and carries bytes.

/// One location the shell must ask OSM about. The bit-pattern strings are its
/// identity (Lean joins on them) and go back verbatim.
#[derive(Debug, Clone)]
pub struct ProximityQuery {
    lat_bits: String,
    lon_bits: String,
}

impl ProximityQuery {
    pub fn lat(&self) -> f64 {
        f64::from_bits(self.lat_bits.parse().unwrap_or(0))
    }
    pub fn lon(&self) -> f64 {
        f64::from_bits(self.lon_bits.parse().unwrap_or(0))
    }
}

/// The minutes of a day that had a fix, and the distinct locations they reduce
/// to. `minutes` is OPAQUE — hand it back to [`proximity_table`] untouched.
#[derive(Debug, Clone)]
pub struct ProximityPlan {
    pub minutes: serde_json::Value,
    pub queries: Vec<ProximityQuery>,
}

/// `Verified.Hsmm.RailRoadProximity.minuteMedians` + `distinctQueryPoints`.
///
/// `points` are `(ts, lat, lon)`; the speed a `GpsPoint` also carries plays no
/// part in bucketing or in the median, so it is not sent.
pub fn proximity_queries(
    start_utc: i64,
    end_utc: i64,
    points: &[(i64, f64, f64)],
) -> Result<ProximityPlan> {
    #[derive(Deserialize)]
    struct Wire {
        minutes: serde_json::Value,
        queries: Vec<Vec<String>>,
    }
    let pts: Vec<serde_json::Value> = points
        .iter()
        .map(|(ts, lat, lon)| {
            serde_json::json!([
                ts,
                crate::fold_payload::bits(*lat),
                crate::fold_payload::bits(*lon)
            ])
        })
        .collect();
    let raw = serve(
        &serde_json::json!({
            "mode": "proximityqueries",
            "startUtc": start_utc,
            "endUtc": end_utc,
            "pts": pts,
        })
        .to_string(),
    )?;
    let w: Wire = decode_serve(&raw, "proximityqueries")?;
    let queries = w
        .queries
        .into_iter()
        .map(|q| match q.as_slice() {
            [lat, lon] => Ok(ProximityQuery {
                lat_bits: lat.clone(),
                lon_bits: lon.clone(),
            }),
            _ => Err(anyhow!("proximityqueries: a query is not [lat, lon]")),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ProximityPlan {
        minutes: w.minutes,
        queries,
    })
}

/// One answered query: the location as [`ProximityQuery`] spelled it, and the
/// `nearbyWays` rows there. A declined query has no answer at all: an empty
/// `ways` would claim "nothing within 300 m".
#[derive(Debug, Clone)]
pub struct ProximityAnswer {
    query: ProximityQuery,
    ways: Vec<serde_json::Value>,
}

impl ProximityAnswer {
    pub fn new(query: &ProximityQuery, ways: Vec<serde_json::Value>) -> Self {
        Self {
            query: query.clone(),
            ways,
        }
    }
}

/// The sparse `[minuteTs, road, rail]` table `assemblesegments` reads as
/// `observation.proximity`, plus the number of fix-bearing minutes no answer
/// covered.
///
/// ⚠ THE TABLE IS OPAQUE HERE ON PURPOSE. It goes into the assemble request
/// unread; a `Vec<(i64, f64, f64)>` on this side would be a second decode of
/// numbers that only Lean compares.
pub fn proximity_table(
    minutes: &serde_json::Value,
    answers: &[ProximityAnswer],
) -> Result<(serde_json::Value, usize)> {
    #[derive(Deserialize)]
    struct Wire {
        proximity: serde_json::Value,
        unanswered: usize,
    }
    let answers: Vec<serde_json::Value> = answers
        .iter()
        .map(|a| {
            serde_json::json!({
                "lat": a.query.lat_bits,
                "lon": a.query.lon_bits,
                "ways": a.ways,
            })
        })
        .collect();
    let raw = serve(
        &serde_json::json!({
            "mode": "proximitytable",
            "minutes": minutes,
            "answers": answers,
        })
        .to_string(),
    )?;
    let w: Wire = decode_serve(&raw, "proximitytable")?;
    Ok((w.proximity, w.unanswered))
}

/// A `serve` reply, with Lean's `{"error": …}` surfaced as one.
fn decode_serve<T: for<'de> Deserialize<'de>>(raw: &str, what: &str) -> Result<T> {
    let v: serde_json::Value =
        serde_json::from_str(raw).with_context(|| format!("{what} answer is not JSON"))?;
    if let Some(e) = v.get("error").and_then(serde_json::Value::as_str) {
        anyhow::bail!("{what}: {e}");
    }
    serde_json::from_value(v).with_context(|| format!("decoding {what}: {raw}"))
}

/// Raw OSM rows → the `{edges, nodes}` the assemble modes read, via
/// `Verified.Hsmm.RouteGraph.buildWireGraph`. Every decision (underground,
/// line memberships, junction fusion, the 150 m station merge) is Lean's; this
/// side parses WKT.
pub fn build_wire_graph(
    ways: &[serde_json::Value],
    stops: &[serde_json::Value],
) -> Result<(serde_json::Value, serde_json::Value)> {
    #[derive(Deserialize)]
    struct Wire {
        edges: serde_json::Value,
        nodes: serde_json::Value,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "buildWireGraph",
        "ways": ways,
        "stops": stops,
    }))?;
    Ok((w.edges, w.nodes))
}

// ---------------------------------------------------------------------------
// The two Overpass mirrors. Every decision (region, tiles, query, which
// relations survive, whether a run may write) is `Verified.Geo.Osm*`'s; these
// wrappers move bytes.

/// One tile of the mirror's grid, as Lean computed it.
#[derive(Debug, Clone)]
pub struct MirrorTile {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

/// The mirror's plan: where the user lives, and the tiles to ask about.
#[derive(Debug, Clone)]
pub struct MirrorPlan {
    pub bbox: MirrorTile,
    pub tiles: Vec<MirrorTile>,
    /// How many metropolitan regions the focus places fell into. Reported so a
    /// run says which of them it chose to mirror.
    pub region_count: i64,
    pub place_count: i64,
}

/// The tile key: the south-west corner to 4 decimal places, stored on every row
/// the tile produced so a partial run replaces only the tiles that answered.
/// ⚠ Changing the precision orphans every existing row.
pub fn tile_key(t: &MirrorTile) -> String {
    format!("{:.4},{:.4}", t.min_lat, t.min_lon)
}

fn tile_from(v: &serde_json::Value) -> Result<MirrorTile> {
    let g = |k: &str| -> Result<f64> {
        let s = v
            .get(k)
            .and_then(|x| x.as_str())
            .with_context(|| format!("a tile has no {k}"))?;
        Ok(f64::from_bits(s.parse::<u64>().with_context(|| {
            format!("a tile's {k} is {s:?}, not a bit pattern")
        })?))
    };
    Ok(MirrorTile {
        min_lat: g("minLat")?,
        max_lat: g("maxLat")?,
        min_lon: g("minLon")?,
        max_lon: g("maxLon")?,
    })
}

/// Cluster the recent focus places, take the home metro, and tile it.
///
/// `None` when there are no places to bound — "nothing to mirror", which the
/// crons treat as a clean exit rather than an error.
pub fn mirror_region(
    points: &[(f64, f64)],
    max_gap_km: f64,
    max_cell_deg: f64,
    margin_m: f64,
) -> Result<Option<MirrorPlan>> {
    let pts: Vec<Vec<String>> = points
        .iter()
        .map(|(lat, lon)| vec![lat.to_bits().to_string(), lon.to_bits().to_string()])
        .collect();
    let v: serde_json::Value = call_json(&serde_json::json!({
        "op": "mirrorRegion",
        "points": pts,
        "maxGapKmBits": max_gap_km.to_bits().to_string(),
        "maxCellDegBits": max_cell_deg.to_bits().to_string(),
        "marginMBits": margin_m.to_bits().to_string(),
    }))?;
    let val = v.get("value").context("mirrorRegion returned no value")?;
    if val.is_null() {
        return Ok(None);
    }
    let tiles = val
        .get("tiles")
        .and_then(|t| t.as_array())
        .context("mirrorRegion returned no tiles")?
        .iter()
        .map(tile_from)
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(MirrorPlan {
        bbox: tile_from(val.get("bbox").context("mirrorRegion returned no bbox")?)?,
        tiles,
        region_count: val.get("regionCount").and_then(|x| x.as_i64()).unwrap_or(0),
        place_count: val.get("placeCount").and_then(|x| x.as_i64()).unwrap_or(0),
    }))
}

/// The Overpass QL for one tile. `mode` is `"rail"` or `"bus"`. Coordinates are
/// rendered here (Lean has no shortest round-trip float printer); fine for a
/// query string.
pub fn overpass_query(mode: &str, t: &MirrorTile) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let w: Wire = call_json(&serde_json::json!({
        "op": "overpassQuery",
        "mode": mode,
        "minLat": t.min_lat.to_string(),
        "minLon": t.min_lon.to_string(),
        "maxLat": t.max_lat.to_string(),
        "maxLon": t.max_lon.to_string(),
    }))?;
    Ok(w.value)
}

/// A stop, as Lean resolved it. `seq` is the position in the route direction.
#[derive(Debug, Clone, Serialize)]
pub struct RouteStop {
    // Declaration order is the serialised order of `stops_json`: `name, lat,
    // lon, seq`.
    pub name: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub seq: i64,
}

/// One extracted relation. The rail and bus arms differ in which of `line_ref` /
/// `route_ref` may be absent; see the Lean modules.
#[derive(Debug, Clone)]
pub struct ExtractedRoute {
    pub osm_relation_id: i64,
    /// Rail only: subway | train | light_rail | tram.
    pub route_type: Option<String>,
    /// `ref` — required for bus, optional for rail.
    pub route_ref: Option<String>,
    pub route_name: Option<String>,
    pub stops: Vec<RouteStop>,
}

/// Parse one tile's Overpass response and keep the relations worth mirroring.
/// The raw body goes to Lean, which owns what an element is.
pub fn extract_routes(mode: &str, body: &str) -> Result<Vec<ExtractedRoute>> {
    let elements = crate::overpass::elements(body)?;
    let v: serde_json::Value = call_json(&serde_json::json!({
        "op": "extractRoutes",
        "mode": mode,
        "elements": elements,
    }))?;
    let arr = v
        .get("value")
        .and_then(|x| x.as_array())
        .context("extractRoutes returned no array")?;
    arr.iter()
        .map(|r| {
            let stops = r
                .get("stops")
                .and_then(|s| s.as_array())
                .context("a route has no stops")?
                .iter()
                .map(|s| {
                    let f = |k: &str| -> Result<f64> {
                        let t = s
                            .get(k)
                            .and_then(|x| x.as_str())
                            .with_context(|| format!("a stop has no {k}"))?;
                        Ok(f64::from_bits(t.parse::<u64>().with_context(|| {
                            format!("a stop's {k} is {t:?}, not a bit pattern")
                        })?))
                    };
                    Ok(RouteStop {
                        name: s.get("name").and_then(|x| x.as_str()).map(str::to_string),
                        lat: f("lat")?,
                        lon: f("lon")?,
                        seq: s.get("seq").and_then(|x| x.as_i64()).unwrap_or(0),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ExtractedRoute {
                osm_relation_id: r
                    .get("osmRelationId")
                    .and_then(|x| x.as_i64())
                    .context("a route has no osmRelationId")?,
                route_type: r
                    .get("routeType")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                route_ref: r
                    .get("routeRef")
                    .or_else(|| r.get("lineRef"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                route_name: r
                    .get("routeName")
                    .or_else(|| r.get("lineName"))
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                stops,
            })
        })
        .collect()
}

/// Is too much of a route mirror's area stale? `None` when it is fresh enough;
/// otherwise the sentence the run fails with (`Verified.Geo.OsmMirrorRefresh`).
///
/// `stale_tiles` of `tiles_total` planned tiles have not answered in
/// `stale_days` days; `existing` is the cache's row count.
pub fn mirror_staleness(
    existing: i64,
    stale_tiles: usize,
    tiles_total: usize,
    stale_days: i64,
) -> Result<Option<String>> {
    let v: serde_json::Value = call_json(&serde_json::json!({
        "op": "mirrorStaleness",
        "existing": existing,
        "staleTiles": stale_tiles,
        "tilesTotal": tiles_total,
        "staleDays": stale_days,
    }))?;
    let val = v
        .get("value")
        .context("mirrorStaleness returned no value")?;
    Ok(val
        .get("refusal")
        .and_then(|x| x.as_str())
        .map(str::to_string))
}

/// The circuit breaker's state, opaque to Rust — Lean owns its shape.
#[derive(Debug, Clone)]
pub struct BreakerState {
    inner: serde_json::Value,
    pub open: bool,
}

impl BreakerState {
    pub fn new() -> Self {
        BreakerState {
            inner: serde_json::json!({ "failures": [], "openUntilMs": 0 }),
            open: false,
        }
    }
}

impl Default for BreakerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Step the breaker. `event` is `"failure"`, `"success"`, or `"check"`.
pub fn breaker_step(st: &BreakerState, event: &str, now_ms: u64) -> Result<BreakerState> {
    let v: serde_json::Value = call_json(&serde_json::json!({
        "op": "breaker",
        "event": event,
        "nowMs": now_ms,
        "state": st.inner,
    }))?;
    let val = v.get("value").context("breaker returned no value")?;
    Ok(BreakerState {
        inner: val
            .get("state")
            .cloned()
            .context("breaker returned no state")?,
        open: val.get("open").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}
