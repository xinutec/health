//! Running the day fold: one request, every lookup asked and answered (#1709).
//!
//! The fold is a pure function of its inputs and of the answers to the
//! questions it asks mid-run — the OSM tables, the zone at a coordinate, a
//! geocode. Those arrive here as asks on the worker's pipe and are answered by
//! whatever [`Answerer`] the caller supplies: the mirror in production, a golden
//! fixture's recorded trace and row set in a replay, nothing at all when a day
//! is being MEASURED for what it needs.
//!
//! There is no round loop. The converge loop this replaces re-sent a 1.5 MiB
//! request per round to discover, from a panic on stderr, which keys the fold
//! had wanted; the fold now says so on the pipe and gets the row back before it
//! moves on.

// The ledgered shape (standards.md §3): the one `unsafe` in this module is the
// glibc `malloc_trim` call in `trim_heap`. Conditional, because the block only
// exists on Linux/glibc and an `expect` with nothing to expect is itself a lint.
#![cfg_attr(
    all(target_os = "linux", target_env = "gnu"),
    expect(
        unsafe_code,
        reason = "glibc's malloc_trim: an FFI call with no preconditions"
    )
)]

use anyhow::{Context, Result};
use serde_json::Value;

use crate::fold_payload::build_day_request;
use crate::lean::{self, Answerer, Ask};

/// The three matcher reads' table names — see [`crate::osm_trace::MatcherRead`].
pub const OSM_READS: [&str; 3] = ["walkableRoads", "buildingsNear", "drivableRoads"];

/// What one fold produced.
#[derive(Debug)]
pub struct Folded {
    /// The fold's reply, as Lean wrote it.
    pub out: String,
    /// The request the fold received, in full — what a second host would need
    /// to be handed to answer the same day.
    pub request: Value,
    /// Every ask the fold made, in order, with whether it was answered.
    pub asks: Vec<(Ask, bool)>,
}

impl Folded {
    /// The asks nothing answered. A day with any of these ran with a DEFAULT
    /// in their place — an empty table, the home zone — and that is not the
    /// same day the mirror would have produced.
    pub fn declined(&self) -> Vec<Ask> {
        self.asks
            .iter()
            .filter(|(_, ok)| !ok)
            .map(|(a, _)| a.clone())
            .collect()
    }

    pub fn answered(&self) -> usize {
        self.asks.iter().filter(|(_, ok)| *ok).count()
    }

    /// `(answered, declined)` for one table.
    pub fn count(&self, what: &str) -> (u64, u64) {
        self.asks
            .iter()
            .filter(|(a, _)| a.what == what)
            .fold(
                (0, 0),
                |(h, m), (_, ok)| if *ok { (h + 1, m) } else { (h, m + 1) },
            )
    }

    /// `(answered, declined)` across the three matcher reads.
    pub fn osm_counts(&self) -> (u64, u64) {
        OSM_READS.iter().fold((0, 0), |(h, m), w| {
            let (a, d) = self.count(w);
            (h + a, m + d)
        })
    }

    /// Declines per table, for a report.
    pub fn declined_by_table(&self) -> std::collections::BTreeMap<String, usize> {
        let mut by: std::collections::BTreeMap<String, usize> = Default::default();
        for a in self.declined() {
            *by.entry(a.what).or_default() += 1;
        }
        by
    }
}

/// Fold one day.
pub fn run_day(cap: &Value, inputs: &Value, answerer: &mut dyn Answerer) -> Result<Folded> {
    let split = std::env::var_os("FOLD_SPLIT").is_some();
    let rss_0 = if split { rss_mib() } else { 0 };
    let t_build = std::time::Instant::now();
    let req = build_day_request(cap, inputs).context("building the day request")?;
    let body = serde_json::to_string(&req).context("serialising the request")?;
    // The fold takes `{"mode": "day", …}`; the request object IS the rest.
    let wrapped = format!("{{\"mode\":\"day\",{}", &body[1..]);
    let build_ms = t_build.elapsed().as_millis();

    let t_serve = std::time::Instant::now();
    let c = lean::serve_with(&wrapped, answerer).context("the day fold")?;
    let serve_ms = t_serve.elapsed().as_millis();

    let folded = Folded {
        out: c.body,
        request: req,
        asks: c.asks,
    };
    if split {
        // ⚠ Per-phase RSS is THIS process's, and the fold now runs in another:
        // what grows here is the request and the answers, not the Lean heap.
        // The worker's own size is what `ps` on its pid says (#1071).
        let declined = folded.declined().len();
        eprintln!(
            "  fold: build {build_ms}ms · serve {serve_ms}ms · body {} KiB · {} ask(s), \
             {declined} declined · RSS {rss_0} -> {} MiB",
            wrapped.len() / 1024,
            folded.asks.len(),
            rss_mib()
        );
        let mut by: std::collections::BTreeMap<&str, (u64, u64)> = Default::default();
        for (a, ok) in &folded.asks {
            let e = by.entry(a.what.as_str()).or_default();
            if *ok {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
        for (what, (h, m)) in by {
            eprintln!("    {what}: {h} answered, {m} declined");
        }
    }
    Ok(folded)
}

/// Resident set size of this process (MiB), or 0 if nothing can say.
///
/// ⚠ `/proc` FIRST, because `ps` READ ZERO IN THE CONTAINER (#1071): the
/// serving image is alpine, whose busybox `ps` does not take `-o rss= -p`.
/// Give the heap a fold freed back to the kernel, and say what that moved.
///
/// ⚠ Measured from the node, 2026-09-25, with folds already running ONE AT A
/// TIME: a fresh pod folded two heavy days and the backend kept 191–389 MiB of
/// anonymous memory at idle — glibc's arenas hold what a fold freed — and the
/// third fold was OOM-killed at 403 MiB backend plus a 100 MiB Lean worker
/// (#1071). `malloc_trim(0)` walks every arena and returns the free top and
/// every wholly free page; it costs milliseconds against a fold that costs
/// seconds. Linux/glibc only: no pod runs anywhere else, and macOS's allocator
/// has no equivalent — there this logs the same figure twice.
pub fn trim_heap() {
    let before = rss_mib();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        unsafe extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        // SAFETY: glibc's `malloc_trim` has no preconditions; it releases only
        // memory the allocator already holds as free.
        unsafe {
            malloc_trim(0);
        }
    }
    let after = rss_mib();
    tracing::info!(before_mib = before, after_mib = after, "fold heap trimmed");
}

/// This process's own cgroup, as the kernel accounts it: `(peak MiB, oom kills)`
/// from `/sys/fs/cgroup/memory.peak` and `memory.events`. `None` off cgroup v2
/// (macOS, a bare shell). In a pod this is the container's cgroup, i.e. the
/// number the OOM killer judges — `rss_mib` is one process's share of it and
/// misses the Lean workers beside it (#1071).
pub fn cgroup_memory() -> Option<(u64, u64)> {
    let peak = std::fs::read_to_string("/sys/fs/cgroup/memory.peak")
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?
        / (1024 * 1024);
    let oom = std::fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("oom_kill "))
                .and_then(|n| n.trim().parse::<u64>().ok())
        })
        .unwrap_or(0);
    Some((peak, oom))
}

/// `/proc/self/statm` needs no fork and exists on every Linux; `ps` stays as
/// the macOS fallback.
pub fn rss_mib() -> u64 {
    if let Ok(s) = std::fs::read_to_string("/proc/self/statm")
        && let Some(pages) = s.split_whitespace().nth(1)
        && let Ok(n) = pages.parse::<u64>()
    {
        return n * page_size() / (1024 * 1024);
    }
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map_or(0, |kib| kib / 1024)
}

/// The page size, without `libc`: Linux is the only platform `/proc` exists
/// on, and its `getconf` answers what `sysconf` would.
fn page_size() -> u64 {
    std::process::Command::new("getconf")
        .arg("PAGESIZE")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(4096)
}
