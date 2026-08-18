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
use std::sync::OnceLock;

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
