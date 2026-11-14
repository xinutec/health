//! The per-pod cache in front of `/velocity`. A day takes 5–10 s to compute
//! and is deterministic for `(user, date, tz, walkMatch)`; the user revisits
//! days within a session.
//!
//! Reuse window and size are `Verified.VelocityCache` ([`Policy`]); this file
//! holds the map, eviction order and single-flight.
//!
//! Entries are serialised bytes, not `Value` trees (several times larger), and
//! every read and seat sweeps stale ones, or expired days stay pinned until
//! their key is read again.
//!
//! Per-pod, no invalidation: nothing changes an answer under a running pod, and
//! a deploy restarts it. Anything that would must add invalidation. Data the
//! `fetch_drain` adds meanwhile is absorbed by the five-minute window.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
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
    /// The day as JSON text. See the module note.
    body: Vec<u8>,
    cached_at_ms: i64,
    /// The window this entry was seated under: a live day's is shorter than a
    /// settled day's, and the sweep must judge each by its own.
    ttl_ms: i64,
}

/// The cache. One per process; `AppState` holds it behind an `Arc`.
#[derive(Default)]
pub struct VelocityCache {
    /// Insertion-ordered, oldest first, for "drop the oldest". A `Vec`: the
    /// bound is 32, so a linear scan is free.
    entries: Mutex<Vec<Entry>>,
    /// One lock per in-flight key. See [`VelocityCache::get_or_compute`].
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl VelocityCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop every entry past its own window. Freshness is Lean's, including that
    /// a future-stamped entry is stale; `now - cached_at < ttl` would keep it
    /// forever.
    fn sweep(entries: &mut Vec<Entry>, now_ms: i64) -> Result<()> {
        let mut i = 0;
        while i < entries.len() {
            if crate::lean::velocity_cache_fresh(
                entries[i].cached_at_ms,
                now_ms,
                entries[i].ttl_ms,
            )? {
                i += 1;
            } else {
                entries.remove(i);
            }
        }
        Ok(())
    }

    /// A fresh entry for `key`, bumped to most-recent. `None` on miss or stale.
    /// Sweeps first, so a read of one day releases every other day that has
    /// expired.
    fn take_fresh(&self, key: &str, now_ms: i64) -> Result<Option<Value>> {
        let mut entries = self.entries.lock().expect("velocity cache mutex");
        Self::sweep(&mut entries, now_ms)?;
        let Some(i) = entries.iter().position(|e| e.key == key) else {
            return Ok(None);
        };
        // LRU bump: move to the end, so this key is now the most recent.
        let e = entries.remove(i);
        let result = serde_json::from_slice(&e.body).context("cached day is not JSON")?;
        entries.push(e);
        Ok(Some(result))
    }

    fn seat(&self, key: &str, result: &Value, now_ms: i64, policy: Policy) -> Result<()> {
        let body = serde_json::to_vec(result).context("serialise the day for the cache")?;
        let mut entries = self.entries.lock().expect("velocity cache mutex");
        Self::sweep(&mut entries, now_ms)?;
        if let Some(i) = entries.iter().position(|e| e.key == key) {
            entries.remove(i);
        }
        // Evict from the front — oldest first — until there is room.
        while entries.len() >= policy.max_entries.max(1) {
            entries.remove(0);
        }
        entries.push(Entry {
            key: key.to_string(),
            body,
            cached_at_ms: now_ms,
            ttl_ms: policy.ttl_ms,
        });
        Ok(())
    }

    /// Read `key`, or compute it and seat the result.
    ///
    /// Single-flight by a per-key lock: a waiter re-reads the cache after
    /// acquiring it, so two tabs do not compute one day twice. A waiter
    /// recomputes rather than inheriting an error, bounded by the waiters.
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
        if let Some(hit) = self.take_fresh(key, now_ms)? {
            tracing::debug!(key, "velocity-cache HIT");
            return Ok(hit);
        }

        let lock = {
            let mut locks = self.locks.lock().expect("velocity lock map mutex");
            Arc::clone(locks.entry(key.to_string()).or_default())
        };
        let guard = lock.lock().await;

        // Re-read under the lock. The holder we just queued behind may have
        // seated exactly what this request wanted, and computing again would be
        // the parallel run the lock exists to prevent, merely serialised.
        let out = match self.take_fresh(key, now_ms)? {
            Some(hit) => {
                tracing::debug!(key, "velocity-cache JOIN");
                Ok(hit)
            }
            None => {
                tracing::debug!(key, "velocity-cache MISS");
                match compute().await {
                    // A day still being decoded seats nothing either: its
                    // decode lands within minutes, and a seated "decoding"
                    // would be served for the whole TTL after it had.
                    Ok(result) if result.get("decoding").and_then(Value::as_bool) == Some(true) => {
                        Ok(result)
                    }
                    Ok(result) => {
                        self.seat(key, &result, now_ms, policy)?;
                        Ok(result)
                    }
                    // A failed compute seats nothing. Caching an error would
                    // serve it for the whole TTL to requests that might have
                    // succeeded.
                    Err(e) => Err(e),
                }
            }
        };

        drop(guard);
        // Retire the slot only when nobody else holds it (count two: the map and
        // us), checked under the map lock so no joiner arrives in between.
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
