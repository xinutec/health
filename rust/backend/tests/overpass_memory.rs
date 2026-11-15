//! What parsing an Overpass answer costs in memory. A dense city box (95k ways,
//! 53 MB of JSON) parsed as a `Value` tree peaked at 914 MB and OOM-killed the
//! 1 GiB fetch sidecar on every start. Its own binary: the count is global.

// The ledgered shape (standards.md §3): a counting allocator is `unsafe impl`.
#![expect(unsafe_code, reason = "a GlobalAlloc that forwards to System")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards to `System`; the counters only observe.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static A: Counting = Counting;

/// A box of short residential ways, shaped like Overpass's `out tags geom`.
fn dense_box(ways: usize) -> String {
    let mut s = String::from(r#"{"version":0.6,"elements":["#);
    for i in 0..ways {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            r#"{{"type":"way","id":{i},"tags":{{"highway":"residential","name":"Road {i}","maxspeed":"20 mph"}},"geometry":["#
        ));
        for k in 0..5 {
            if k > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                r#"{{"lat":51.{:07},"lon":-0.{:07}}}"#,
                i * 7 + k,
                i * 3 + k
            ));
        }
        s.push_str("]}");
    }
    s.push_str("]}");
    s
}

#[test]
fn parsing_a_dense_box_costs_a_few_times_its_body() {
    let body = dense_box(20_000);
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let features = backend::osm_mirror::features_from_body(&body, &[]).expect("parses");
    let peak = PEAK.load(Ordering::Relaxed) - base;
    assert_eq!(features.len(), 20_000);
    // Typed it is ~5x here; a `Value` tree was ~25x.
    assert!(
        peak < 8 * body.len(),
        "parsing {} bytes peaked at {peak} bytes ({:.1}x)",
        body.len(),
        peak as f64 / body.len() as f64
    );
}
