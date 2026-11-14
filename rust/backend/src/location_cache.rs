//! The two ten-second caches behind the live map: `/location/latest` and
//! `/location/tail` are polled, and each miss walks Nextcloud once per device.
//! Process-local; ten seconds is the worst staleness. No single-flight: a miss
//! is one bounded HTTP walk, and two concurrent ones are harmless.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

/// The live marker: the freshest fix, or `None`. Field order is the wire order
/// (`preserve_order`).
#[derive(Clone, Debug, Serialize)]
pub struct LatestFix {
    pub lat: f64,
    pub lon: f64,
    pub ts: i64,
    pub accuracy: Option<f64>,
}

/// One buffered point for the raw tail. Three fields only: the tail is
/// projected down to `{lat, lon, ts}`, dropping altitude, speed, accuracy and
/// battery, which would only make the response bigger.
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

/// Per-user, TTL'd, with no eviction: keyed by user alone, so it cannot grow
/// with time. Many users would need the velocity cache's bound.
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

    /// The cached value if still fresh, by `Verified.LocationTail.cacheFresh`:
    /// strict at the boundary, and a future timestamp is stale.
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

/// The points a tail request answers with: `Verified.LocationTail.tailAfter`
/// re-implemented here, since shipping thousands of points to Lean per poll
/// costs more than the fetch. `tests/suite/location_tail.rs` holds the two
/// together. `>` is strict, so the caller's last point is not resent, and the
/// cap keeps the newest `TAIL_MAX_POINTS`, not the oldest.
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

/// How long a started OAuth handshake may take: ten minutes, as the pending-login
/// cookie. Long enough to read the consent screen, short enough not to leave a
/// PKCE verifier redeemable.
pub const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000;

impl<T: Clone> LocationCache<T> {
    /// Read and remove an entry if still fresh: single-use, so an OAuth verifier
    /// cannot be replayed. Expired entries are removed too.
    pub fn take(&self, key: &str, now_ms: i64) -> Option<T> {
        let mut entries = self.entries.lock().ok()?;
        let e = entries.remove(key)?;
        (e.at_ms <= now_ms && now_ms - e.at_ms < OAUTH_STATE_TTL_MS).then_some(e.value)
    }
}
