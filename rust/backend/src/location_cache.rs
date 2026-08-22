//! The two ten-second caches behind the live map (#982).
//!
//! `/location/latest` and `/location/tail` both answer from PhoneTrack, and the
//! Map tab polls both. Without a cache each poll is a nested walk of one HTTP
//! call per device against Nextcloud, so the TypeScript keeps a per-user entry
//! for ten seconds and this does the same.
//!
//! ⚠ Process-local, like the velocity cache, and for the same reason: a deploy
//! restarts the pod and that is the invalidation. Ten seconds also means the
//! worst staleness is ten seconds, so there is nothing to invalidate by hand.
//!
//! # Why there is no single-flight here
//!
//! `velocity_cache` serialises concurrent misses because computing a day is
//! expensive enough that two of them at once matters. These are one bounded
//! HTTP walk, and the TypeScript does not serialise them either — two polls
//! landing together do two fetches and the second wins. Adding a lock would be
//! a behaviour change dressed as an optimisation, so it is left out.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

/// The live marker: the freshest fix, or `None` when there is none.
///
/// ⚠ The field order is the wire order — `preserve_order` is on, so serde emits
/// these in declaration order and the TypeScript emits them in the order it
/// writes the object literal. They must match.
#[derive(Clone, Debug, Serialize)]
pub struct LatestFix {
    pub lat: f64,
    pub lon: f64,
    pub ts: i64,
    pub accuracy: Option<f64>,
}

/// One buffered point for the raw tail. ⚠ Three fields only: the TypeScript
/// projects the tail down to `{lat, lon, ts}` and drops altitude, speed,
/// accuracy and battery. Carrying them through would be a bigger response than
/// production sends.
#[derive(Clone, Debug, Serialize)]
pub struct TailPoint {
    pub lat: f64,
    pub lon: f64,
    pub ts: i64,
}

struct Entry<T> {
    at_ms: i64,
    value: T,
}

/// Per-user, TTL'd, with no eviction.
///
/// ⚠ Unbounded in principle and bounded in practice by the user count — this is
/// keyed by user, not by user-and-date like the velocity cache, so it cannot
/// grow with time. If this app ever serves many users, that reasoning stops
/// holding and this needs the LRU the velocity cache already has.
pub struct LocationCache<T> {
    entries: Mutex<HashMap<String, Entry<T>>>,
}

impl<T: Clone> Default for LocationCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone> LocationCache<T> {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The cached value if it is still fresh.
    ///
    /// ⚠ Freshness is `Verified.LocationTail.cacheFresh`, which is the velocity
    /// cache's comparison — strict at the boundary, and a future timestamp is
    /// STALE rather than eternally fresh. A host that wrote `<=` here would
    /// serve an entry one millisecond past its promise, which is the direction
    /// that cannot be justified to a caller.
    pub fn get(&self, key: &str, now_ms: i64, ttl_ms: i64) -> Option<T> {
        let entries = self.entries.lock().ok()?;
        let e = entries.get(key)?;
        (e.at_ms <= now_ms && now_ms - e.at_ms < ttl_ms).then(|| e.value.clone())
    }

    pub fn put(&self, key: &str, now_ms: i64, value: T) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                key.to_string(),
                Entry {
                    at_ms: now_ms,
                    value,
                },
            );
        }
    }
}

/// The points a tail request answers with.
///
/// ⚠ Mirrors `Verified.LocationTail.tailAfter`, and is NOT a host call:
/// a tail buffer is thousands of points and shipping all of them across the FFI
/// per poll would cost more than the fetch it saves. `tests/location_tail.rs`
/// holds this against Lean's over a corpus, which is the only thing stopping
/// the two drifting.
///
/// Both halves invert without looking wrong. `>` is STRICT, so the point the
/// caller already has is not resent and drawn twice. The cap keeps the LAST
/// `TAIL_MAX_POINTS`, so a long buffer answers with the NEWEST — taking the
/// first would answer a live map with the stale head and never reach the
/// present, which reads as lag rather than as a bug.
pub fn tail_after(points: &[TailPoint], since: f64) -> Vec<TailPoint> {
    let kept: Vec<TailPoint> = points
        .iter()
        .filter(|p| (p.ts as f64) > since)
        .cloned()
        .collect();
    let max = crate::lean::TAIL_MAX_POINTS as usize;
    let drop = kept.len().saturating_sub(max);
    kept[drop..].to_vec()
}

/// How long a started OAuth handshake may take to come back.
///
/// ⚠ Ten minutes, matching the pending-login cookie. A shorter window strands a
/// user who stops to read the consent screen; a longer one keeps a redeemable
/// PKCE verifier alive after the person has walked away.
pub const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000;

impl<T: Clone> LocationCache<T> {
    /// Read and REMOVE an entry, if it is still fresh.
    ///
    /// ⚠ Single-use, which is the point for an OAuth state: a verifier that
    /// could be redeemed twice is a replayable authorisation. An expired entry
    /// is removed too, so a stale one cannot linger and be redeemed after a
    /// clock correction.
    pub fn take(&self, key: &str, now_ms: i64) -> Option<T> {
        let mut entries = self.entries.lock().ok()?;
        let e = entries.remove(key)?;
        (e.at_ms <= now_ms && now_ms - e.at_ms < OAUTH_STATE_TTL_MS).then_some(e.value)
    }
}
