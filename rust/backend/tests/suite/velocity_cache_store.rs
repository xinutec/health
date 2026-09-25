//! The `/velocity` cache's mechanics (#982).
//!
//! `tests/velocity_cache.rs` covers the POLICY — Lean's TTL, freshness and
//! window. This covers the parts the host owns: the LRU order, eviction, and
//! the single-flight that stops two tabs firing two OSM enrichment runs over
//! the same rows.
//!
//! ⚠ These call Lean for freshness, because the cache does. So they need the
//! runtime up even though nothing here is a decision.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use backend::velocity_cache::{Policy, VelocityCache};
use serde_json::{Value, json};

const TTL: i64 = 5 * 60 * 1000;

fn policy(max_entries: usize) -> Policy {
    Policy {
        ttl_ms: TTL,
        max_entries,
    }
}

async fn put(c: &VelocityCache, key: &str, now: i64, p: Policy, v: Value) -> Value {
    c.get_or_compute(key, now, p, || async { Ok(v) })
        .await
        .expect("computes")
}

#[tokio::test]
async fn a_fresh_entry_is_served_without_recomputing() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = VelocityCache::new();
    let runs = Arc::new(AtomicUsize::new(0));

    for _ in 0..3 {
        let runs = Arc::clone(&runs);
        let got = c
            .get_or_compute("k", 1_000, policy(8), || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"day": 1}))
            })
            .await
            .unwrap();
        assert_eq!(got, json!({"day": 1}));
    }
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "two of three were cache hits"
    );
}

#[tokio::test]
async fn an_entry_past_its_ttl_is_recomputed() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = VelocityCache::new();

    assert_eq!(put(&c, "k", 1_000, policy(8), json!(1)).await, json!(1));
    // One millisecond inside the window: still the first answer.
    assert_eq!(
        put(&c, "k", 1_000 + TTL - 1, policy(8), json!(2)).await,
        json!(1)
    );
    // Exactly at the TTL is stale — the bound is strict.
    assert_eq!(
        put(&c, "k", 1_000 + TTL, policy(8), json!(3)).await,
        json!(3)
    );
}

#[tokio::test]
async fn the_oldest_entry_is_evicted_at_the_bound() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = VelocityCache::new();
    let p = policy(3);

    for (i, k) in ["a", "b", "c"].iter().enumerate() {
        put(&c, k, 1_000 + i as i64, p, json!(*k)).await;
    }
    assert_eq!(c.len(), 3);

    // A fourth key drops "a", the oldest.
    put(&c, "d", 1_004, p, json!("d")).await;
    assert_eq!(c.len(), 3, "the bound holds");
    // "a" recomputes; "b", "c" and "d" are still seated.
    assert_eq!(put(&c, "a", 1_005, p, json!("a2")).await, json!("a2"));
    assert_eq!(put(&c, "c", 1_006, p, json!("miss")).await, json!("c"));
    assert_eq!(put(&c, "d", 1_007, p, json!("miss")).await, json!("d"));
}

#[tokio::test]
async fn reading_a_key_makes_it_the_most_recent() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = VelocityCache::new();
    let p = policy(3);

    for k in ["a", "b", "c"] {
        put(&c, k, 1_000, p, json!(k)).await;
    }
    // ⚠ Touch "a", so the oldest is now "b". Without the LRU bump the next
    // insert would evict the key the user is actually looking at.
    assert_eq!(put(&c, "a", 1_001, p, json!("miss")).await, json!("a"));

    put(&c, "d", 1_002, p, json!("d")).await;
    assert_eq!(put(&c, "a", 1_003, p, json!("miss")).await, json!("a"));
    assert_eq!(put(&c, "b", 1_004, p, json!("b2")).await, json!("b2"));
}

#[tokio::test]
async fn a_failed_compute_seats_nothing() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = VelocityCache::new();

    let err = c
        .get_or_compute("k", 1_000, policy(8), || async {
            Err(anyhow::anyhow!("nextcloud is down"))
        })
        .await;
    assert!(err.is_err());
    assert_eq!(c.len(), 0, "an error must not occupy the cache for a TTL");

    // The next request gets a real answer rather than the cached failure.
    assert_eq!(
        put(&c, "k", 1_001, policy(8), json!("ok")).await,
        json!("ok")
    );
}

#[tokio::test]
async fn concurrent_requests_for_one_key_compute_it_once() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = Arc::new(VelocityCache::new());
    let runs = Arc::new(AtomicUsize::new(0));

    // ⚠ The compute SLEEPS, so the second task is guaranteed to arrive while
    // the first is still running. Without that the test could pass by finishing
    // before the race it exists to exercise.
    let tasks: Vec<_> = (0..4)
        .map(|_| {
            let c = Arc::clone(&c);
            let runs = Arc::clone(&runs);
            tokio::spawn(async move {
                c.get_or_compute("same", 1_000, policy(8), || async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                    Ok(json!("computed once"))
                })
                .await
                .unwrap()
            })
        })
        .collect();

    for t in tasks {
        assert_eq!(t.await.unwrap(), json!("computed once"));
    }
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "two tabs must not fire two OSM enrichment runs over the same rows"
    );
}

#[tokio::test]
async fn different_keys_do_not_block_each_other() {
    backend::lean::init().expect("the Lean runtime must start");
    let c = Arc::new(VelocityCache::new());

    // By CONSTRUCTION, not by the clock: x's compute waits for a signal that
    // only y's compute sends. If a per-key lock serialised different days, y
    // could not start until x returned, x could not return until y ran, and
    // the join below would time out. The bound is a hang guard, not a latency
    // figure — a loaded machine cannot make it red.
    let gate = Arc::new(tokio::sync::Notify::new());
    let x = {
        let (c, gate) = (Arc::clone(&c), Arc::clone(&gate));
        tokio::spawn(async move {
            c.get_or_compute("x", 1_000, policy(8), || async {
                gate.notified().await;
                Ok(json!("x done"))
            })
            .await
            .unwrap()
        })
    };
    let y = {
        let (c, gate) = (Arc::clone(&c), Arc::clone(&gate));
        tokio::spawn(async move {
            c.get_or_compute("y", 1_000, policy(8), || async {
                gate.notify_one();
                Ok(json!("y done"))
            })
            .await
            .unwrap()
        })
    };
    let both = async { (x.await.unwrap(), y.await.unwrap()) };
    let (vx, vy) = tokio::time::timeout(std::time::Duration::from_secs(5), both)
        .await
        .expect("a per-key lock must not serialise DIFFERENT days: x never got y's signal");
    assert_eq!((vx, vy), (json!("x done"), json!("y done")));
}

/// ⚠ An expired entry is released by ANY traffic, not only by a read of its own
/// key. Thirty-two parsed days pinned the serving pod at its memory limit
/// (2026-09-25) while every one of them was long past its window.
#[tokio::test]
async fn expired_entries_are_swept_by_traffic_on_other_keys() {
    backend::lean::init().expect("lean host");
    let c = VelocityCache::new();
    let p = policy(32);
    put(&c, "a", 1_000, p, json!({"day": "a"})).await;
    put(&c, "b", 1_000, p, json!({"day": "b"})).await;
    assert_eq!(c.len(), 2);
    // A read of a THIRD key, past both windows: both are gone, and the miss
    // that seats "c" leaves only "c".
    let v = put(&c, "c", 1_000 + TTL + 1, p, json!({"day": "c"})).await;
    assert_eq!(v, json!({"day": "c"}));
    assert_eq!(
        c.len(),
        1,
        "the two expired days must not outlive their window"
    );
}
