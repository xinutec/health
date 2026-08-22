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
