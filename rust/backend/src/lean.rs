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
use serde::Deserialize;

unsafe extern "C" {
    fn health_backend_init() -> i32;
    fn health_backend_json(input: *const c_char) -> *mut c_char;
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
