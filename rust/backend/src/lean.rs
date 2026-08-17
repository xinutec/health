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
