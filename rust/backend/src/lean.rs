//! Calling the Lean decisions.
//!
//! The backend links `BackendEntry` and calls `health_backend_call` through the
//! C ABI, exactly as `day-shell` calls the day fold. What that buys is that the
//! rules in `Verified/Sync.lean` are the ones the running backend uses — not a
//! Rust paraphrase of them that drifts.
//!
//! # Initialisation happens once, and a failure here is fatal
//!
//! `OnceLock` rather than a lazy retry: if the Lean runtime cannot start, every
//! subsequent call would fail the same way, and a backend that limped on
//! answering "could not decide" per request is worse than one that refuses to
//! start. The `init` is therefore expected to be called from the entrypoint.
//!
//! # Blocking, from an async context
//!
//! These calls are microseconds of pure computation with no IO, so they run
//! directly rather than through `spawn_blocking` — the hop would cost more than
//! the work. That holds only while the exported functions stay pure and cheap;
//! anything here that grew a real workload would need revisiting.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

unsafe extern "C" {
    fn health_backend_init() -> i32;
    fn health_backend_json(input: *const c_char) -> *mut c_char;
    fn health_serve_json(input: *const c_char) -> *mut c_char;
    fn health_backend_free(p: *mut c_char);
}

static INIT: OnceLock<bool> = OnceLock::new();

/// Start the Lean runtime. Idempotent; call once at startup.
pub fn init() -> Result<()> {
    let ok = *INIT.get_or_init(|| {
        // SAFETY: called at most once, before any other entry point here.
        unsafe { health_backend_init() == 0 }
    });
    if ok {
        Ok(())
    } else {
        Err(anyhow!("Lean runtime failed to initialise"))
    }
}

/// One request/response round trip through the C ABI.
fn call_raw(request: &str) -> Result<String> {
    if !*INIT
        .get()
        .ok_or_else(|| anyhow!("lean::init() was never called"))?
    {
        return Err(anyhow!("Lean runtime failed to initialise"));
    }
    let c = CString::new(request).context("request contained a NUL byte")?;
    // SAFETY: `c` outlives the call; the returned pointer is a `strdup` the
    // shim hands over and this function frees before returning.
    let out = unsafe {
        let p = health_backend_json(c.as_ptr());
        if p.is_null() {
            return Err(anyhow!("Lean returned null"));
        }
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        health_backend_free(p);
        s
    };
    Ok(out)
}

/// A dispatch that failed inside Lean reports `{"error": …}`; surface it as one.
fn call_json<T: for<'de> Deserialize<'de>>(request: &serde_json::Value) -> Result<T> {
    let raw = call_raw(&request.to_string())?;
    if let Ok(e) = serde_json::from_str::<LeanError>(&raw) {
        return Err(anyhow!("lean: {}", e.error));
    }
    serde_json::from_str(&raw).with_context(|| format!("decoding lean response: {raw}"))
}

#[derive(Deserialize)]
struct LeanError {
    error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitAction {
    Proceed,
    Sleep { ms: i64 },
    Exhausted { resume_in_sec: i64 },
}

#[derive(Deserialize)]
struct RateLimitWire {
    kind: String,
    #[serde(default)]
    ms: Option<i64>,
    #[serde(default)]
    #[serde(rename = "resumeInSec")]
    resume_in_sec: Option<i64>,
}

/// See `Verified.Sync.decideRateLimitWait`.
pub fn decide_rate_limit_wait(
    remaining: i64,
    ms_until_reset: i64,
    max_wait_ms: i64,
) -> Result<RateLimitAction> {
    let w: RateLimitWire = call_json(&serde_json::json!({
        "op": "decideRateLimitWait",
        "remaining": remaining,
        "msUntilReset": ms_until_reset,
        "maxWaitMs": max_wait_ms,
    }))?;
    match w.kind.as_str() {
        "proceed" => Ok(RateLimitAction::Proceed),
        "sleep" => Ok(RateLimitAction::Sleep {
            ms: w.ms.ok_or_else(|| anyhow!("sleep without ms"))?,
        }),
        "exhausted" => Ok(RateLimitAction::Exhausted {
            resume_in_sec: w
                .resume_in_sec
                .ok_or_else(|| anyhow!("exhausted without resumeInSec"))?,
        }),
        other => Err(anyhow!("unknown rate-limit action: {other}")),
    }
}

#[derive(Deserialize)]
struct OptStr {
    value: Option<String>,
}

/// See `Verified.Sync.prevDayBounded`. `None` means stop the walk.
pub fn prev_day_bounded(date: &str, floor: &str) -> Result<Option<String>> {
    let r: OptStr = call_json(&serde_json::json!({
        "op": "prevDayBounded", "date": date, "floor": floor,
    }))?;
    Ok(r.value)
}

/// Why a backfill stream stopped for good. See
/// `Verified.Backfill.CompleteReason` — the three look identical in
/// `sync_state` and mean different things, so the reason is carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompleteReason {
    ReachedFloor,
    CursorUnusable,
    EmptyStreak,
}

impl CompleteReason {
    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "reachedFloor" => Self::ReachedFloor,
            "cursorUnusable" => Self::CursorUnusable,
            "emptyStreak" => Self::EmptyStreak,
            other => return Err(anyhow!("unknown complete reason: {other}")),
        })
    }
}

/// What an intraday stream does next. See `Verified.Backfill.Step`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackfillStep {
    /// Fetch this day, then call again with it as the cursor.
    Fetch { date: String },
    /// Stop for this run. Nothing durable is written.
    Pause,
    /// Stop for good, and record it.
    Complete { reason: CompleteReason },
}

/// What a range stream does next. See `Verified.Backfill.RangeStep`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeBackfillStep {
    /// Fetch this inclusive window, then call again with `start` as the cursor.
    Fetch {
        start: String,
        end: String,
    },
    Pause,
    Complete {
        reason: CompleteReason,
    },
}

#[derive(Deserialize)]
struct StepWire {
    kind: String,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

impl StepWire {
    fn reason(&self) -> Result<CompleteReason> {
        CompleteReason::parse(
            self.reason
                .as_deref()
                .ok_or_else(|| anyhow!("complete without a reason"))?,
        )
    }
}

/// See `Verified.Backfill.decideStep`.
///
/// `cursor` is the OLDEST day already fetched; the answer names the day before
/// it. ⚠ `Complete` is DURABLE — it writes a flag that stops the stream being
/// walked again — so the caller must not treat a failed call as one. There is
/// no fallback here for the same reason [`decide_rate_limit_wait`]'s caller has
/// none: an undecidable step is a stop, not a guess.
pub fn decide_backfill_step(
    remaining: i64,
    empty_streak: i64,
    max_empty: i64,
    cursor: &str,
    floor: &str,
) -> Result<BackfillStep> {
    let w: StepWire = call_json(&serde_json::json!({
        "op": "decideBackfillStep",
        "remaining": remaining,
        "emptyStreak": empty_streak,
        "maxEmpty": max_empty,
        "cursor": cursor,
        "floor": floor,
    }))?;
    Ok(match w.kind.as_str() {
        "fetch" => BackfillStep::Fetch {
            date: w
                .date
                .clone()
                .ok_or_else(|| anyhow!("fetch without a date"))?,
        },
        "pause" => BackfillStep::Pause,
        "complete" => BackfillStep::Complete {
            reason: w.reason()?,
        },
        other => return Err(anyhow!("unknown backfill step: {other}")),
    })
}

/// See `Verified.Backfill.decideRangeStep`.
pub fn decide_range_backfill_step(
    remaining: i64,
    empty_streak: i64,
    max_empty: i64,
    window_days: i64,
    cursor: &str,
    floor: &str,
) -> Result<RangeBackfillStep> {
    let w: StepWire = call_json(&serde_json::json!({
        "op": "decideRangeBackfillStep",
        "remaining": remaining,
        "emptyStreak": empty_streak,
        "maxEmpty": max_empty,
        "windowDays": window_days,
        "cursor": cursor,
        "floor": floor,
    }))?;
    Ok(match w.kind.as_str() {
        "fetch" => RangeBackfillStep::Fetch {
            start: w
                .start
                .clone()
                .ok_or_else(|| anyhow!("fetch without a start"))?,
            end: w
                .end
                .clone()
                .ok_or_else(|| anyhow!("fetch without an end"))?,
        },
        "pause" => RangeBackfillStep::Pause,
        "complete" => RangeBackfillStep::Complete {
            reason: w.reason()?,
        },
        other => return Err(anyhow!("unknown range backfill step: {other}")),
    })
}

/// See `Verified.Backfill.orderByCursorRecency`.
///
/// `streams` is `(name, stored cursor)`; a `None` cursor takes `fallback` and
/// therefore sorts to the front.
pub fn order_by_cursor_recency(
    streams: &[(String, Option<String>)],
    fallback: &str,
) -> Result<Vec<String>> {
    let wire: Vec<serde_json::Value> = streams
        .iter()
        .map(|(name, cursor)| serde_json::json!({"name": name, "cursor": cursor}))
        .collect();
    let r: OptDays = call_json(&serde_json::json!({
        "op": "orderByCursorRecency", "streams": wire, "fallback": fallback,
    }))?;
    r.value
        .ok_or_else(|| anyhow!("orderByCursorRecency returned no order"))
}

#[derive(Deserialize)]
struct Kind {
    kind: String,
}

#[derive(Deserialize)]
struct IntValue {
    value: i64,
}

/// See `Verified.Sync.forwardWindow`. `None` means a date did not parse.
pub fn forward_window(
    today: &str,
    stored_cursor: Option<&str>,
) -> Result<Option<(String, String)>> {
    let r: OptWindow = call_json(&serde_json::json!({
        "op": "forwardWindow", "today": today, "storedCursor": stored_cursor,
    }))?;
    Ok(r.value.map(|w| (w.start, w.end)))
}

/// Whether a cached access token can still be used. See
/// `Verified.Token.decideTokenUse`.
pub fn token_needs_refresh(now_ms: i64, expires_at_ms: i64) -> Result<bool> {
    let k: Kind = call_json(&serde_json::json!({
        "op": "decideTokenUse", "nowMs": now_ms, "expiresAtMs": expires_at_ms,
    }))?;
    match k.kind.as_str() {
        "use" => Ok(false),
        "refresh" => Ok(true),
        other => Err(anyhow!("unknown token action: {other}")),
    }
}

/// What a refresh response means. See `Verified.Token.RefreshOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    /// 2xx — new tokens to persist.
    Rotated,
    /// 4xx — the refresh token is dead. ⚠ DURABLE: flips `needs_reauth`.
    ReauthRequired,
    /// Anything else, 3xx and 5xx included. Retry later; change nothing.
    Transient,
}

/// See `Verified.Token.classifyRefreshStatus`.
///
/// ⚠ A FAILED CALL MUST NOT BE READ AS `ReauthRequired`. That answer stops the
/// sync until somebody re-links the account by hand, so an undecidable status
/// is `Transient` — the outcome that changes nothing and retries.
pub fn classify_refresh_status(status: u16) -> Result<RefreshOutcome> {
    let k: Kind = call_json(&serde_json::json!({
        "op": "classifyRefreshStatus", "status": status,
    }))?;
    Ok(match k.kind.as_str() {
        "rotated" => RefreshOutcome::Rotated,
        "reauthRequired" => RefreshOutcome::ReauthRequired,
        "transient" => RefreshOutcome::Transient,
        other => return Err(anyhow!("unknown refresh outcome: {other}")),
    })
}

/// See `Verified.Token.expiryFromNow`. `None` for `expires_in` takes Fitbit's
/// documented eight-hour default.
pub fn expiry_from_now(now_ms: i64, expires_in_s: Option<i64>) -> Result<i64> {
    let r: IntValue = call_json(&serde_json::json!({
        "op": "expiryFromNow", "nowMs": now_ms, "expiresInS": expires_in_s,
    }))?;
    Ok(r.value)
}

#[derive(Deserialize)]
struct OptIndex {
    value: Option<usize>,
}

/// See `Verified.FitbitTz.nearestFix`.
///
/// ⚠ THE SPECIFICATION, NOT THE PRODUCTION PATH. It is a linear scan and the
/// backend binary-searches instead — 86 400 rows a day of 1-second heart rate
/// makes a JSON round trip per row untenable. This exists so
/// `tests/tz_source.rs` can drive both over the same inputs and compare.
pub fn nearest_fix_spec(times: &[i64], target: i64) -> Result<Option<usize>> {
    let r: OptIndex = call_json(&serde_json::json!({
        "op": "nearestFix", "times": times, "target": target,
    }))?;
    Ok(r.value)
}

/// What to stamp a Fitbit row with. See `Verified.FitbitTz.TzChoice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TzChoice {
    /// Use the account's profile zone, which may itself be absent.
    Profile,
    /// Look up the zone at this fix's coordinates.
    Fix { index: usize },
}

#[derive(Deserialize)]
struct TzChoiceWire {
    kind: String,
    #[serde(default)]
    index: Option<usize>,
}

/// See `Verified.FitbitTz.decideTz`. The specification half of the pair.
pub fn decide_tz_spec(times: &[i64], seed_utc: Option<i64>) -> Result<TzChoice> {
    let w: TzChoiceWire = call_json(&serde_json::json!({
        "op": "decideTz", "times": times, "seedUtc": seed_utc,
    }))?;
    Ok(match w.kind.as_str() {
        "profile" => TzChoice::Profile,
        "fix" => TzChoice::Fix {
            index: w.index.ok_or_else(|| anyhow!("fix without an index"))?,
        },
        other => return Err(anyhow!("unknown tz choice: {other}")),
    })
}

#[derive(Deserialize)]
struct OptDays {
    value: Option<Vec<String>>,
}

/// See `Verified.Sync.dateRangeInclusive`.
///
/// The Lean `none` becomes an `Err` rather than an empty range, and the two are
/// deliberately not the same answer: empty means the cursor is caught up, and
/// `none` means the request was malformed or absurdly large. Collapsing them is
/// exactly the TypeScript bug this replaced — an unparseable date syncing zero
/// days and reporting success.
pub fn date_range_inclusive(start: &str, end: &str, max_days: i64) -> Result<Vec<String>> {
    let r: OptDays = call_json(&serde_json::json!({
        "op": "dateRangeInclusive", "start": start, "end": end, "maxDays": max_days,
    }))?;
    r.value.ok_or_else(|| {
        anyhow!("refused date range {start}..{end}: unparseable, or wider than {max_days} days")
    })
}

#[derive(Deserialize)]
struct Window {
    start: String,
    end: String,
}

#[derive(Deserialize)]
struct OptChunks {
    value: Option<Vec<Window>>,
}

/// How many days of PhoneTrack history one request asks for.
/// Mirrors `Verified.Sync.TRACK_CHUNK_DAYS`.
pub const TRACK_CHUNK_DAYS: i64 = 7;

/// How many chunks one tz-inference window may be split into.
/// Mirrors `Verified.Sync.MAX_TRACK_CHUNKS`.
pub const MAX_TRACK_CHUNKS: i64 = 60;

/// See `Verified.Sync.chunkRange`.
///
/// As with [`date_range_inclusive`], the Lean `none` is an `Err` and NOT an
/// empty list: empty means the span asks for nothing, `none` means it was
/// malformed or would take more requests than the bound allows.
///
/// ⚠ Adjacent chunks share an endpoint by design, so a fix on a boundary day is
/// fetched twice. See the Lean docstring for why that is kept.
pub fn chunk_range(
    start: &str,
    end: &str,
    days: i64,
    max_chunks: i64,
) -> Result<Vec<(String, String)>> {
    let r: OptChunks = call_json(&serde_json::json!({
        "op": "chunkRange", "start": start, "end": end,
        "days": days, "maxChunks": max_chunks,
    }))?;
    let chunks = r.value.ok_or_else(|| {
        anyhow!(
            "refused track range {start}..{end}: unparseable, \
             a non-positive step, or more than {max_chunks} chunks of {days} days"
        )
    })?;
    Ok(chunks.into_iter().map(|w| (w.start, w.end)).collect())
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

/// See `Verified.Civil.midnightUtc` — a `YYYY-MM-DD` as Unix SECONDS at UTC
/// midnight.
///
/// ⚠ Stricter than the `new Date(s)` the TypeScript used, and that is the
/// point. `new Date("2026-02-30")` yields the 2nd of March and
/// `new Date("nonsense")` yields `NaN`, whose `getTime()/1000` floors to `NaN`
/// and goes into a query string as the literal text `NaN`. Here both refuse.
pub fn midnight_utc(date: &str) -> Result<i64> {
    let r: OptInt = call_json(&serde_json::json!({ "op": "midnightUtc", "date": date }))?;
    r.value
        .ok_or_else(|| anyhow!("not a calendar date: {date:?}"))
}

#[derive(Deserialize)]
struct OptWindow {
    value: Option<Window>,
}

/// See `Verified.Sync.prevWindowBounded`. `None` means stop the walk.
pub fn prev_window_bounded(
    end: &str,
    window_days: i64,
    floor: &str,
) -> Result<Option<(String, String)>> {
    let r: OptWindow = call_json(&serde_json::json!({
        "op": "prevWindowBounded", "end": end, "windowDays": window_days, "floor": floor,
    }))?;
    Ok(r.value.map(|w| (w.start, w.end)))
}

/// One fetched bounding box of the local OSM mirror, for one feature bucket.
///
/// `fetched_at` is milliseconds, and `None` means a row written before fetch
/// times were tracked — treated as FRESH, not stale. See
/// `Verified.Geo.OsmCoverage`.
/// `Verified.VelocityCache.ttlMsFor` — how long a computed day may be reused,
/// plus the LRU bound the host enforces.
///
/// ⚠ `today` MUST be the viewer's local civil date (`timezone::local_date_at`),
/// not UTC's. Nothing on either side of this wire can check that: a UTC date is
/// a well-formed argument asking a different question, and the answer to it
/// looks exactly the same.
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
pub fn may_proceed(is_share_viewer: bool, method: &str, path: &str) -> Result<bool> {
    let w: BoolWire = call_json(&serde_json::json!({
        "op": "mayProceed", "isShareViewer": is_share_viewer,
        "method": method, "path": path,
    }))?;
    Ok(w.value)
}

/// `Verified.Share.shareableDateRange` — the inclusive `[from, to]` a share with
/// this `days_back` may show, ending at `today`.
///
/// ⚠ `None` means SHARE DISABLED, not "no window". It covers both `days_back ≤
/// 0` and a `today` that does not parse — the TypeScript produced NaN-shaped
/// garbage for the second, which formatted as `"NaN-NaN-NaN"`. A caller that
/// treats `None` as "unrestricted" has inverted the rule.
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

/// `Verified.ApiWindow.validateDays` — the `days` query parameter.
///
/// ⚠ `None` OUT MEANS REJECT, not "use the default". Zod's `.min`/`.max`
/// validate rather than clamp, so `days=400` is a 400 and not a narrowed window.
///
/// ⚠ `raw` must be what JS `Number(...)` makes of the parameter: `None` ONLY
/// when it was absent, `Some(NaN)` when present and unparseable, and
/// `Some(0.0)` for the empty string. Mapping `""` to `None` turns a rejection
/// into a 30-day read.
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

/// The session lifetime, and the cookie spelling that must agree with it.
pub struct SessionPolicy {
    pub ttl_ms: i64,
    pub cookie_max_age_s: i64,
    pub cookie_name: String,
}

/// `Verified.Session`'s constants. Fetched rather than restated so the row's TTL
/// and the cookie's `Max-Age` cannot drift — a cookie outliving its row is a
/// user who appears logged in and is not.
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

/// `Verified.Geo.OsmCoverage.decideCoverage` — may the mirror be read here?
///
/// `false` means nobody has fetched this area for this bucket, so a spatial
/// query over the mirror would return nothing and be indistinguishable from an
/// area with no features in it. The caller must DECLINE rather than answer.
///
/// ⚠ `coverage` is the rows for ONE feature bucket. Boxes are per-bucket, and
/// mixing them would report a highway fetch as covering the landmarks.
///
/// ⚠ `now_ms` is passed IN. Lean has no clock in a pure function, and giving it
/// one would make the staleness rule depend on when it was asked, which is what
/// makes it untestable. The host owns the clock; Lean owns the decision.
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

/// `Verified.Geo.RailRouteFill.unsnappedTrainRoutes` — which train legs of a
/// computed day want a background route fill.
///
/// ⚠ `segments` and `points` are already in the wire form the mode reads:
/// `[mode, refinedMode|null, startTs, endTs, wayName|null, hasSnappedPath]` and
/// `[ts, latBits, lonBits]`. `hasSnappedPath` is a BOOLEAN — shipping the
/// geometry to answer "is it drawn already" would put every snapped polyline of
/// the day on the wire to be discarded.
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

/// `Verified.Geo.DayState.clipInferredFuture` — never assert the future.
///
/// An inferred state extends to a survival horizon or the day end, which for
/// TODAY lies ahead of the current moment. This truncates one that straddles
/// `now_ts` and drops one wholly beyond it. Observed states pass through: real
/// data cannot be in the future.
///
/// ⚠ APPLY PER REQUEST, AFTER THE CACHE. The cached result is the full
/// deterministic day; `now` advances and the cached value does not, so clipping
/// before seating would freeze the horizon at whatever it was when the day was
/// computed.
///
/// ⚠ `states` must be the `day` mode's own state objects. They round-trip
/// through the SAME encoder they were emitted by, so a field this port does not
/// know about would be dropped — which is why `Day.stateJson` is shared rather
/// than restated.
pub fn clip_inferred_future(
    states: &[serde_json::Value],
    now_ts: i64,
) -> Result<Vec<serde_json::Value>> {
    #[derive(Deserialize)]
    struct Wire {
        states: Vec<serde_json::Value>,
    }
    let req = serde_json::json!({ "mode": "clipinferred", "states": states, "nowTs": now_ts });
    let out = serve(&req.to_string()).context("lean serve clipinferred")?;
    let v: serde_json::Value =
        serde_json::from_str(&out).context("clipinferred answer is not JSON")?;
    if let Some(e) = v.get("error") {
        anyhow::bail!("clipinferred: {e}");
    }
    let w: Wire = serde_json::from_value(v).context("clipinferred answer has no `states`")?;
    Ok(w.states)
}

/// `Verified.Geo.Velocity.watchBatterySeries` — the watch trace for one day.
///
/// ⚠ `rows` are `[ts|null, level, deviceVersion|null]` with the instant ALREADY
/// RESOLVED. `null` is a wall clock that did not resolve, and Lean drops it
/// rather than defaulting — a reading at a guessed instant draws a step that
/// never happened.
///
/// ⚠ ROW ORDER IS LOAD-BEARING. Two rows at the same instant keep the LATER one
/// in this slice, so a caller that sorts the result set changes which level is
/// drawn.
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

/// Ask the Lean algorithm mode table one question.
///
/// The request is the same object `verified_cli serve` reads off a line
/// (`{"mode": "focus", …}`), so this host and the subprocess ask an identical
/// question and any difference between their answers is transport rather than
/// intent. That is what makes the subprocess a usable oracle for this path.
pub fn serve(request: &str) -> Result<String> {
    init()?;
    let c = CString::new(request).context("request contains a NUL byte")?;
    // SAFETY: `init` has succeeded, the pointer is valid for the call, and the
    // result is copied out before it is freed — see the note in `shim.c` about
    // `lean_string_cstr` pointing into a heap object the caller must not keep.
    let out = unsafe {
        let p = health_serve_json(c.as_ptr());
        if p.is_null() {
            anyhow::bail!("lean serve returned null");
        }
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        health_backend_free(p);
        s
    };
    Ok(out)
}

/// One key the fold asked for and did not find in its answer tables.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Miss {
    /// The table: `nearbyWays`, `tzAt`, `nearbyStations`, `transitStops`, …
    pub what: String,
    /// The key as the fold spelled it — bit patterns joined by `|`.
    pub key: String,
}

/// Call the fold and collect the keys it could not answer.
///
/// # Why the misses come back on stderr
///
/// `DayEntry`'s `hit` uses `panic!`, which in Lean PRINTS AND CONTINUES: the
/// round runs to the end naming every key it reached, rather than stopping at
/// the first. The rest of that round's output is poisoned by the defaults it
/// read and is thrown away — only the key set is kept. That is what makes the
/// converge loop possible at all, and it is why this cannot simply read a field
/// off the response.
///
/// ⚠ FD 2 IS REDIRECTED TO A TEMPORARY FILE, not to a pipe. A pipe has a 64 KiB
/// buffer and nothing draining it during the call, so a day with enough misses
/// would deadlock inside Lean rather than return a long list. A file has no
/// such limit and the call is synchronous, so there is nothing to drain.
///
/// ⚠ FD 2 IS PROCESS-WIDE, so this SERIALISES. Two callers redirecting at once
/// means one captures the other's misses or loses its own — and the failure does
/// not look like a race, it looks like convergence: the fold appears to re-ask a
/// key that was already answered, because the answer went to the other caller's
/// file. This comment used to say "not thread-safe, and it cannot be", with the
/// sequential walk as the argument. That argument held for production and NOT
/// for the tests, which `cargo test` runs on parallel threads in one process —
/// `fold_converge_corpus` has two, and they raced. It surfaced only under a
/// loaded gate, where the windows overlap; three unloaded runs "refuted" it.
///
/// The lock is free where the walk really is sequential, so making the guarantee
/// true costs nothing and removes a landmine that a documented precondition
/// could not.
pub fn serve_capturing_misses(request: &str) -> Result<(String, Vec<Miss>)> {
    use std::io::{Read, Seek};
    use std::os::fd::AsRawFd;

    static FD2: Mutex<()> = Mutex::new(());
    // Poisoning is not a reason to stop: the guard protects fd 2, and a previous
    // caller panicking mid-serve leaves the fd restored (that happens before the
    // `?`). Refusing here would turn one failed day into every later day failing.
    let _fd2 = FD2.lock().unwrap_or_else(|e| e.into_inner());

    init()?;

    let mut sink = tempfile::tempfile().context("creating the stderr capture file")?;
    // SAFETY: `dup`/`dup2` on fd 2 with a live fd. The original is restored
    // below on every path, including the error one.
    let saved = unsafe { libc::dup(2) };
    if saved < 0 {
        anyhow::bail!("could not duplicate stderr");
    }
    let redirect = unsafe { libc::dup2(sink.as_raw_fd(), 2) };
    if redirect < 0 {
        unsafe { libc::close(saved) };
        anyhow::bail!("could not redirect stderr");
    }

    let answer = serve(request);

    // Restore BEFORE inspecting the result, so a failure below still leaves the
    // process able to report itself.
    unsafe {
        libc::dup2(saved, 2);
        libc::close(saved);
    }

    let out = answer?;
    sink.rewind().context("rewinding the stderr capture")?;
    let mut text = String::new();
    sink.read_to_string(&mut text)
        .context("reading the stderr capture")?;
    Ok((out, misses_in(&text)))
}

/// Every key a round asked for, deduplicated.
///
/// ⚠ ANCHORED ON THE TAIL of the message, not on the first `)`. A line name is
/// a key and line names contain brackets — `Northern Line (Charing Cross
/// Branch) Southbound`. Stopping at the first one answers a DIFFERENT key,
/// which the loop then believes it has handled; the TypeScript records two days
/// that converged wrongly that way before its own parser was anchored.
pub fn misses_in(stderr: &str) -> Vec<Miss> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(i) = line.find("uncaptured ") else {
            continue;
        };
        let rest = &line[i + "uncaptured ".len()..];
        let Some(end) = rest.rfind(") — re-capture required") else {
            continue;
        };
        let head = &rest[..end];
        let Some(open) = head.find('(') else {
            continue;
        };
        let m = Miss {
            what: head[..open].to_string(),
            key: head[open + 1..].to_string(),
        };
        if seen.insert(m.clone()) {
            out.push(m);
        }
    }
    out
}

/// How one column's value is rendered into JSON — `Verified.RowShape.Shape`.
///
/// ⚠ The variants carry the wire tags Lean emits; renaming one breaks the
/// interface at runtime rather than at compile time.
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
#[allow(clippy::too_many_arguments)]
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

/// `Verified.LocationTail`'s constants.
///
/// ⚠ Restated here as consts rather than fetched per request: they are compile
/// time constants in Lean too, and a host call per poll would cost more than the
/// value is worth. `tests/location_tail.rs` asserts each against Lean, so a
/// change there fails a test rather than silently disagreeing.
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

/// `Verified.Share.clampShareDaysBack`.
///
/// ⚠ CLAMPS, and is the mirror of [`validate_days`], which REJECTS. Two
/// day-window parameters in one API with opposite behaviour, both faithful to
/// the TypeScript: `?days=400` on a read is an ERROR, while `daysBack: 400` on
/// a share is silently narrowed to 365.
///
/// `None` in or out means "not a finite number at all" — NOT "out of range".
/// The caller decides what to do with that: create defaults, update rejects.
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

/// `Verified.LogLine.oneLine` — flatten client text into one log field.
///
/// ⚠ THE SECURITY BOUNDARY of `/api/telemetry`, and called per label rather
/// than reimplemented here. The rule depends on Unicode category tables derived
/// from V8; a second copy in Rust would be a second thing to keep in step with
/// them, for a path that handles at most 100 labels per request.
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
pub fn encode_pending(expires_at: i64, nonce: &str, return_to: Option<&str>) -> Result<String> {
    #[derive(Deserialize)]
    struct Wire {
        value: String,
    }
    let mut req =
        serde_json::json!({ "op": "encodePending", "expiresAt": expires_at, "nonce": nonce });
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
    pub return_to: Option<String>,
}

/// `Verified.Login.decodePending`. `None` when the payload is malformed.
pub fn decode_pending(raw: &str) -> Result<Option<Pending>> {
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "expiresAt")]
        expires_at: i64,
        nonce: String,
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
        return_to: i.return_to,
    }))
}

/// `Verified.Login.acceptPending` — may this callback complete the login?
///
/// ⚠ `state` is `None` when Nextcloud DROPPED it, which is the normal case for
/// a browser with no NC session. Sending an empty string is treated the same.
pub fn accept_pending(
    expires_at: i64,
    nonce: &str,
    state: Option<&str>,
    now_ms: i64,
) -> Result<bool> {
    #[derive(Deserialize)]
    struct Wire {
        value: bool,
    }
    let mut req = serde_json::json!({
        "op": "acceptPending", "expiresAt": expires_at, "nonce": nonce, "nowMs": now_ms
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

/// A mined place, as the long-stay gate reads it.
///
/// ⚠ Passed in RAW so Lean decides whether the phone is somewhere it may be
/// demoted. A host that computed the boolean itself would own the decision that
/// costs a walk home when it is wrong.
pub struct GatingPlace {
    pub lat: f64,
    pub lon: f64,
    pub avg_dwell_sec: f64,
    pub sleep_hours: f64,
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
pub fn owntracks_config(
    history: &[OwntracksFix],
    prev_profile: Option<&str>,
    places: &[GatingPlace],
    manual_hold_active: bool,
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
    let wire_places: Vec<serde_json::Value> = places
        .iter()
        .map(|p| {
            serde_json::json!({
                "latBits": p.lat.to_bits().to_string(),
                "lonBits": p.lon.to_bits().to_string(),
                "dwellBits": p.avg_dwell_sec.to_bits().to_string(),
                "sleepBits": p.sleep_hours.to_bits().to_string(),
            })
        })
        .collect();
    let mut req = serde_json::json!({
        "op": "owntracksConfig",
        "history": wire_history,
        "places": wire_places,
        "manualHoldActive": manual_hold_active,
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

/// `Verified.Owntracks.HISTORY_MAX_AGE_SEC`.
pub fn owntracks_history_max_age_sec() -> i64 {
    600
}

/// `Verified.PresenceLog.computeRow` — one day's decoded segments rolled up.
///
/// ⚠ `None` is an ANSWER, not an error: a day that decoded nothing, or whose
/// segments all round to under a minute, has no row rather than a row claiming
/// 0% of nothing.
///
/// ⚠ The segments must arrive in the order the decoder emitted them. A tie on
/// minutes keeps the place seen FIRST, because the TypeScript accumulates into a
/// JS `Map` and iterates it in insertion order. Sorting on the way in would
/// change which place a day is attributed to.
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
    // ⚠ Fractions cross as IEEE-754 BIT PATTERNS. `dominant_fraction` is a ratio
    // of two integer minute counts and lands in a DECIMAL column; a re-rounded
    // value would differ from the TypeScript's in the last place and the two
    // arms' rows would not compare equal.
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

/// `Verified.Geo.Landmarks.shapeLandmarks` — the venues near a stay.
///
/// ⚠ This is what names a timeline entry. While this went unanswered, a served
/// day lost venue names silently: the stay still rendered, as "stationary" with
/// no place, which is why no test caught it (#1054).
///
/// ⚠ The scored rows arrive under `rows`, and their `distanceM` is an IEEE-754
/// BIT PATTERN. Reading either wrongly yields an empty shaping — which claims
/// "no venues here" rather than declining, and is worse than the gap it closes.
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
            // ⚠ A BIT-PATTERN STRING, not a JSON number. `DayEntry.parsePoi`
            // reads this field with `jBits`, and the trace-fed path encodes it
            // the same way (`fold_payload`'s `num_bits`). Emitting a number here
            // fails the fold's decode outright with "String expected" — which
            // is the loud failure, and only reachable once the shaping stopped
            // returning an empty list for every stay (#1054).
            o.insert(
                "distanceM".into(),
                serde_json::Value::String(crate::fold_payload::bits(d)),
            );
            // ⚠ `enclosing` is ALWAYS present, including `false` — the recorded
            // trace carries it that way. Only `openingHours` is conditional,
            // matching the TypeScript's spread.
            o.insert(
                "enclosing".into(),
                serde_json::Value::Bool(
                    m.get("enclosing")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                ),
            );
            if let Some(h) = m.get("openingHours").and_then(serde_json::Value::as_str) {
                o.insert("openingHours".into(), serde_json::Value::String(h.into()));
            }
            serde_json::Value::Object(o)
        })
        .collect();
    Ok(serde_json::Value::Array(out))
}

/// One focus cluster's amenity vote — `Verified.Geo.FocusMining.mineCluster`.
///
/// The whole vote crosses in ONE call, deliberately. The three gates read each
/// other's leavings (the near-field exemption is built by the same pass that
/// builds the tally, and an exact tie keeps the first name seen), so splitting
/// it into a call per gate would put those tie-breaks on this side of the FFI —
/// which is the half that drifted while nothing compared it (#1003).
///
/// `landmarks` on each stay and on `centroid` are `shape_landmarks` OUTPUT,
/// passed straight back: the raw `openingHours` tag rides along so Lean can
/// resolve it against that stay's `samples`.
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
}

/// One stay's contribution: its window, its resolved local hour, and the
/// venues near it.
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

/// The cron's gate-1 constants. ⚠ Cross as bit patterns like every other float
/// here: `minFraction` is compared with `<` against a computed ratio, and a
/// re-rounded 0.5 moves that boundary.
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
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

/// Aggregate every cluster's attributed stays into the venue-type prior blob —
/// `Verified.Geo.VenuePrior.minePriors`.
///
/// Returns the JSON that goes into `venue_type_priors.priors_json`, in the
/// TypeScript's shape: `{bySubtype: {k: {visits, dwell[], hours[]}}, byCategory,
/// totalVisits}`.
///
/// ⚠ A FULL RECOMPUTE, never incremental — a re-mine after a gate change has to
/// be reproducible from the stays alone.
///
/// ⚠ KEY ORDER is first-seen order, carried deliberately. Lean accumulates into
/// an insertion-ordered association list and the TypeScript into a JS object,
/// which is the same order for string keys, so the two arms produce the same
/// TEXT and not merely the same numbers.
///
/// ⚠ Counts cross as bit patterns but are written as JSON NUMBERS, because that
/// is what the column holds and what `rankVenues` reads back. They are
/// integer-valued, so V8 renders `1` where `serde_json` renders `1.0`: the
/// values parse identically and nothing compares the two arms byte-for-byte,
/// but do not "verify" this blob with a text diff against a TypeScript-written
/// row — it would report a difference that is not one
/// (`reference_jq_cannot_check_serialisation_parity`).
pub fn mine_priors(attributed: &[AttributedStay]) -> Result<serde_json::Value> {
    #[derive(Deserialize)]
    struct Wire {
        value: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(rename = "bySubtype")]
        by_subtype: Vec<(String, WireStats)>,
        #[serde(rename = "byCategory")]
        by_category: Vec<(String, WireStats)>,
        #[serde(rename = "totalVisitsBits")]
        total_visits_bits: String,
    }
    #[derive(Deserialize)]
    struct WireStats {
        visits: String,
        dwell: Vec<String>,
        hours: Vec<String>,
    }

    let stays: Vec<serde_json::Value> = attributed
        .iter()
        .map(|a| {
            serde_json::json!({
                "subtype": a.subtype,
                "durationSecBits": crate::fold_payload::bits(a.duration_sec),
                "localHour": a.local_hour,
            })
        })
        .collect();

    let w: Wire = call_json(&serde_json::json!({
        "op": "minePriors",
        "attributed": stays,
    }))?;

    let bits = |s: &str| -> Result<f64> {
        Ok(f64::from_bits(s.parse::<u64>().with_context(|| {
            format!("minePriors: {s:?} is not a bit pattern")
        })?))
    };
    let nums = |xs: &[String]| -> Result<Vec<serde_json::Value>> {
        xs.iter().map(|x| Ok(serde_json::json!(bits(x)?))).collect()
    };
    // ⚠ This relies on `serde_json`'s `preserve_order` feature, which
    // `backend/Cargo.toml` enables for exactly this reason — the default `Map`
    // is a `BTreeMap` and would SORT the keys, silently discarding the
    // first-seen order the doc comment above promises. The blob would still
    // hold the right numbers, so nothing would fail; it would just stop being
    // the same text the TypeScript wrote.
    let table = |t: &[(String, WireStats)]| -> Result<serde_json::Value> {
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
        "bySubtype": table(&w.value.by_subtype)?,
        "byCategory": table(&w.value.by_category)?,
        "totalVisits": bits(&w.value.total_visits_bits)?,
    }))
}

/// One train leg snapped onto its rail corridor — the `railsnap` serve mode
/// over `Verified.Geo.RailSnap`.
///
/// ⚠ THE WHOLE SNAP CROSSES, not just the shortest path. `RailSnap.lean` holds
/// `buildRailGraph`, `edgeWeight`, `bridgeGaps`, `nearestVertex` and the vertex
/// fusion (123 guards); the production TypeScript builds the graph itself and
/// asks Lean only for `dijkstraC`. Handing over raw ways keeps all of that on
/// the Lean side rather than growing a second implementation here (#1003).
///
/// `on_line` selects the fallback: `snapTrainSegmentOnLine` routes over ONLY the
/// named line's ways with no fix cloud, which is what `computeRailRoute` reaches
/// for when the corridor snap refuses. The two are NOT interchangeable — the
/// corridor form declines below 12 fixes because a thin cloud cannot evidence a
/// corridor, and the line form leans on the label instead.
///
/// `Ok(None)` means LEAVE IT RAW. Never a guessed path.
#[allow(clippy::too_many_arguments)]
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
    // ⚠ `path: null` is the REFUSAL and is a normal answer — a leg whose
    // stations do not resolve, or whose cloud is too thin. Distinct from an
    // `error`, which is a malformed request.
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

/// One day's HSMM decode, model and all, returned as SEGMENTS — the
/// `assemblesegments` serve mode.
///
/// ⚠ THE MODEL IS BUILT IN LEAN, not marshalled to it. `parseAssemble` takes
/// raw `edges`/`nodes`/`obs`/`places` and calls `buildRouteGraphModel` and
/// `buildCoverage` itself, so nothing here constructs a route graph.
///
/// ⚠ That is the whole point of this mode and of #411: the production
/// TypeScript uses the `hsmm` mode instead and ships the QUANTISED TENSORS —
/// 33-40 MiB per day to decode 1440 minutes, measured over the 11 decode
/// fixtures. The reply either way is ~1440 integers. Porting decode-day onto
/// this path deletes that payload rather than reimplementing it.
///
/// ⚠ `assembledecode` HAS NEVER BEEN THE SERVING PATH. `Verified.Hsmm.Assemble`
/// has 14 guards and no production day behind it, so the first real comparison
/// against the `hsmm` arm is this port's actual cost — not the wiring.
///
/// ⚠ NOT the `assembledecode` mode, which returns state INDICES with no state
/// table — enough to measure a decode, not enough to persist one. The grouping
/// into segments happens in Lean so the state table never crosses and no
/// consumer can reimplement `groupStates` against it.
///
/// `Ok(None)` is the DEGENERATE case Lean reports explicitly (no viable path),
/// which is distinct from an error and must not be flattened into one — a day
/// with no decodable path is a real answer, a malformed request is not.
pub fn assemble_segments(input: &serde_json::Value) -> Result<Option<serde_json::Value>> {
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
    let segs = v
        .get("segments")
        .context("assemblesegments answer has no `segments`")?;
    Ok(Some(segs.clone()))
}

/// Raw OSM rows → the `{edges, nodes}` the assemble modes consume, via
/// `Verified.Hsmm.RouteGraph.buildWireGraph`.
///
/// ⚠ EVERY DECISION IS LEAN'S. `isUnderground`, `parseLineMemberships`, the
/// 5-dp `nodeKey` that fuses junctions, and the 150 m station merge all happen
/// there. This side supplies rows with the WKT parsed — a format concern — and
/// nothing else.
///
/// ⚠ The TypeScript's `RouteGraph` additionally carries a cell index and
/// per-edge `lengthM`. Those are NOT sent: `buildRouteGraphModel` rebuilds them
/// on the far side, so shipping them would be shipping a second copy of an
/// index the receiver constructs anyway.
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
// The two Overpass mirrors (#982 Tier 2).
//
// ⚠ EVERY DECISION BELOW IS LEAN'S. These wrappers move bytes and nothing else:
// the region, the tiles, the query text, which relations survive, and whether
// the run may write are all decided in `Verified.Geo.Osm*`. Adding a `if
// routes.is_empty()` here would be re-deciding in Rust something that has a
// guard in Lean.

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

/// ⚠ THE TILE KEY IS 4 DECIMAL PLACES OF THE SOUTH-WEST CORNER, matching
/// `tileKey` in `refresh-bus-routes.ts`. It is stored on every row the tile
/// produced and is what lets a partial run replace only the tiles that
/// answered — so a change of precision here orphans every existing row.
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

/// The Overpass QL for one tile. `mode` is `"rail"` or `"bus"`.
///
/// ⚠ THE COORDINATES ARE RENDERED HERE because Lean has no shortest-round-trip
/// float renderer to match `${bbox.minLat}` with. That is safe for a query
/// string Overpass parses and would NOT be safe for `stops_json`, which is
/// compared row for row.
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
    // ⚠ FIELD ORDER IS THE SERIALISED ORDER and it must stay `name, lat, lon,
    // seq`: `stops_json` is compared against the TypeScript arm's, and
    // `JSON.stringify` follows the object literal. `serde` follows declaration
    // order, so this declaration IS the wire format.
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
///
/// ⚠ THE RAW BODY GOES TO LEAN. Narrowing it here first would mean parsing 5 MB
/// twice and keeping a second definition of what an Overpass element is.
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

/// May this run write, and if not, why not.
#[derive(Debug, Clone)]
pub struct RebuildVerdict {
    pub may_write: bool,
    /// Bus only: whether the run is authoritative for the whole bbox.
    pub full_rebuild: bool,
    pub refusal: Option<String>,
}

/// ⚠ THE TWO ARMS ANSWER DIFFERENTLY AND NEITHER IS RIGHT — #1134. Ported as
/// they stand so the parity diff against the TypeScript still works.
pub fn may_rebuild(
    mode: &str,
    found: usize,
    tile_failures: usize,
    tiles_total: usize,
    existing: i64,
) -> Result<RebuildVerdict> {
    let v: serde_json::Value = call_json(&serde_json::json!({
        "op": "mayRebuild",
        "mode": mode,
        "found": found,
        "tileFailures": tile_failures,
        "tilesTotal": tiles_total,
        "existing": existing,
    }))?;
    let val = v.get("value").context("mayRebuild returned no value")?;
    Ok(RebuildVerdict {
        may_write: val
            .get("mayWrite")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        full_rebuild: val
            .get("fullRebuild")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        refusal: val
            .get("refusal")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
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
