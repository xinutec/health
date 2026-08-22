//! The per-pod cache in front of `/velocity` (#982).
//!
//! Computing a day is a Nextcloud fetch, a Kalman pass, segmentation, OSM
//! enrichment and biometric joins — 5–10 s on a data-rich day — and
//! deterministic for a given `(user, date, tz, walkMatch)`. The user revisits
//! the same day several times in a session, so repeat views read from here.
//!
//! # ⚠ Nothing here decides anything
//!
//! How long an entry may be reused, and how many to keep, are
//! `Verified.VelocityCache`. This is the map, the eviction order and the
//! single-flight — which request shares a computation with which is
//! concurrency, not policy. [`Policy`] is what the caller carries across from
//! Lean; it is never computed in this file.
//!
//! # Per-pod, cleared by restart
//!
//! No schema-version tag and no invalidation hook: a deploy restarts the pod
//! and that is the invalidation. The cost is a cold cache after each deploy.
//!
//! ⚠ **`invalidateVelocityCache` and its generation counter are NOT ported, and
//! that is a deletion rather than an omission.** In the TypeScript they existed
//! for one caller — the verified-core master toggle, which swapped the Lean core
//! for TS inside a live process. That toggle went with the TS arm (#975), and
//! with it the only thing that changed an answer without a restart. Anything
//! that later changes the pipeline's answer under a RUNNING pod has to bring
//! both back; this paragraph is the note that says so.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde_json::Value;

/// What Lean decided for this request. Carried, never computed here.
#[derive(Debug, Clone, Copy)]
pub struct Policy {
    /// `Verified.VelocityCache.ttlMsFor` — the window this key may be reused in.
    pub ttl_ms: i64,
    /// `Verified.VelocityCache.MAX_ENTRIES` — the LRU bound.
    pub max_entries: usize,
}

struct Entry {
    key: String,
    result: Value,
    cached_at_ms: i64,
}

/// The cache. One per process; `AppState` holds it behind an `Arc`.
#[derive(Default)]
pub struct VelocityCache {
    /// ⚠ Insertion-ordered, oldest first, because the eviction rule is "drop the
    /// oldest" and a `HashMap` has no oldest. A `Vec` rather than an ordered-map
    /// crate: the bound is 32, so a linear scan is free and the order is visible
    /// in the type instead of being a property of a dependency.
    entries: Mutex<Vec<Entry>>,
    /// One lock per in-flight key. See [`VelocityCache::get_or_compute`].
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl VelocityCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh entry for `key`, bumped to most-recent. `None` on miss or stale.
    ///
    /// ⚠ Freshness is Lean's — including the rule that an entry stamped in the
    /// FUTURE is stale. Plain `now - cached_at < ttl` reads a far-future entry
    /// as eternally fresh, which is the one staleness failure that never expires
    /// by itself.
    fn take_fresh(&self, key: &str, now_ms: i64, ttl_ms: i64) -> Result<Option<Value>> {
        let mut entries = self.entries.lock().expect("velocity cache mutex");
        let Some(i) = entries.iter().position(|e| e.key == key) else {
            return Ok(None);
        };
        if !crate::lean::velocity_cache_fresh(entries[i].cached_at_ms, now_ms, ttl_ms)? {
            // Drop it rather than leave it to be re-tested on every request.
            entries.remove(i);
            return Ok(None);
        }
        // LRU bump: move to the end, so this key is now the most recent.
        let e = entries.remove(i);
        let result = e.result.clone();
        entries.push(e);
        Ok(Some(result))
    }

    fn seat(&self, key: &str, result: &Value, now_ms: i64, max_entries: usize) {
        let mut entries = self.entries.lock().expect("velocity cache mutex");
        if let Some(i) = entries.iter().position(|e| e.key == key) {
            entries.remove(i);
        }
        // Evict from the front — oldest first — until there is room.
        while entries.len() >= max_entries.max(1) {
            entries.remove(0);
        }
        entries.push(Entry {
            key: key.to_string(),
            result: result.clone(),
            cached_at_ms: now_ms,
        });
    }

    /// Read `key`, or compute it and seat the result.
    ///
    /// # Single-flight, and the one way it differs from the TypeScript
    ///
    /// Two concurrent requests for the same key must not both run the compute —
    /// opening the dashboard in two tabs would otherwise fire two parallel OSM
    /// enrichment runs over the same rows. The TypeScript shares the PROMISE, so
    /// the second caller receives whatever the first produced, failure included.
    ///
    /// This takes a per-key lock instead, and the waiter re-reads the cache
    /// after acquiring it. Same guarantee about parallelism; the difference is
    /// on FAILURE, where a waiter recomputes rather than inheriting the first
    /// caller's error. That is the better answer for a transient fault and a
    /// worse one for a persistent it — bounded by the number of waiters, which
    /// is the number of tabs.
    pub async fn get_or_compute<F, Fut>(
        &self,
        key: &str,
        now_ms: i64,
        policy: Policy,
        compute: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value>>,
    {
        if let Some(hit) = self.take_fresh(key, now_ms, policy.ttl_ms)? {
            tracing::debug!(key, "velocity-cache HIT");
            return Ok(hit);
        }

        let lock = {
            let mut locks = self.locks.lock().expect("velocity lock map mutex");
            Arc::clone(locks.entry(key.to_string()).or_default())
        };
        let guard = lock.lock().await;

        // ⚠ RE-READ under the lock. The holder we just queued behind may have
        // seated exactly what this request wanted, and computing again would be
        // the parallel run the lock exists to prevent, merely serialised.
        let out = match self.take_fresh(key, now_ms, policy.ttl_ms)? {
            Some(hit) => {
                tracing::debug!(key, "velocity-cache JOIN");
                Ok(hit)
            }
            None => {
                tracing::debug!(key, "velocity-cache MISS");
                match compute().await {
                    Ok(result) => {
                        self.seat(key, &result, now_ms, policy.max_entries);
                        Ok(result)
                    }
                    // ⚠ A failed compute seats NOTHING. Caching an error would
                    // serve it for the whole TTL to requests that might have
                    // succeeded.
                    Err(e) => Err(e),
                }
            }
        };

        drop(guard);
        // Retire the slot only when nobody else holds it: the map's reference
        // plus ours is two, and a waiter that cloned under this same lock would
        // make it three. Checked while holding the map lock, so a joiner cannot
        // arrive between the count and the removal.
        {
            let mut locks = self.locks.lock().expect("velocity lock map mutex");
            if Arc::strong_count(&lock) == 2 {
                locks.remove(key);
            }
        }
        out
    }

    /// How many entries are seated. Test-only reach into the shape.
    pub fn len(&self) -> usize {
        self.entries.lock().expect("velocity cache mutex").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
