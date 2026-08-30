//! A mirror query that ERRORS is counted, not silently answered empty (#976).
//!
//! `with_pool` turns every failure into `None` and every caller turns that into
//! an empty `Vec`, so a database that is down produces byte-for-byte the same
//! answer as an area with genuinely no roads. `FAILS` is the only thing that
//! separates them, and the summary line that warns the reader is driven by it.
//!
//! ⚠ **THIS IS THE INCREMENT #976 RECORDED AS UNPROVEN.** Its body said: "The
//! test pins that NON-failures are not counted. It does NOT show that a real
//! query error IS counted — that needs a reachable-but-broken mirror, which no
//! local harness has. The increment is by inspection only." A lazy pool pointed
//! at a closed port IS that harness: `connect_lazy_with` dials nothing until a
//! query runs, so the failure lands in `rt.block_on(f(pool))` as a genuine
//! `sqlx::Error` — the same arm a wrong `DB_NAME` or a dead `health-db` takes in
//! production.
//!
//! ⚠ **Port 1 on LOOPBACK, deliberately.** An unresolvable hostname would test
//! DNS instead, and a firewalled remote address would hang for the pool's whole
//! acquire timeout. Nothing here touches the network.
//!
//! ⚠ **AND THIS TEST'S DURATION FOUND A PRODUCTION FAULT.** The first run took
//! **30.0 s**, not the milliseconds a refused loopback connection costs — sqlx
//! retries within its acquire timeout, whose default is 30 s. The fold asks the
//! mirror ~275 times for one day, so a configured-but-down mirror would have
//! held a day for over two hours before falling back to raw chords. `mirror.rs`
//! now sets the timeout explicitly. Do not "fix" this test by shrinking the
//! timeout further: the number is a production choice and the test simply
//! inherits it.
//!
//! ⚠ **ITS OWN FILE**, for the reason `mirror_async_guard.rs` gives: `POOL` is a
//! `OnceLock`, so the first call decides for the whole process whether a mirror
//! is configured, and `mirror_port.rs` asserts the opposite. Cargo builds each
//! file under `tests/` as its own binary, so they cannot collide.
//!
//! ⚠ **NOT inside a runtime.** The async guard would refuse first and count its
//! own failure, and this test would pass having never reached a query at all —
//! the exact "green for the wrong reason" shape #976 is about.

/// Loopback, with nothing listening. Refused immediately.
const DEAD_HOST: &str = "127.0.0.1";
const DEAD_PORT: &str = "1";

#[test]
fn a_failed_query_is_counted_and_answers_empty() {
    // SAFETY: single-threaded test binary, set before any mirror call.
    unsafe {
        std::env::set_var("DB_HOST", DEAD_HOST);
        std::env::set_var("DB_PORT", DEAD_PORT);
        std::env::set_var("DB_NAME", "nowhere");
    }

    assert!(
        day_shell::mirror::configured(),
        "a query is only reachable once a mirror is configured; without that the \
         readers return empty at the earlier absence check and this test would \
         pass for the wrong reason"
    );
    assert_eq!(
        day_shell::mirror::take_fails(),
        0,
        "configuring a mirror must not itself count as a failure — absence and \
         breakage are the distinction this counter exists to draw"
    );

    // Sync context on purpose: inside a runtime the async guard refuses first
    // and this never reaches a query.
    let ways = day_shell::mirror::walkable_roads(51.5, -0.1, 100.0);

    assert!(
        ways.is_empty(),
        "a failed query must answer empty like every other failure here — the \
         fold draws raw chords rather than aborting a day"
    );
    assert_eq!(
        day_shell::mirror::take_fails(),
        1,
        "a query that ERRORED must be counted. Zero here is the whole defect: \
         a database fault would be indistinguishable from an area with no roads, \
         and the osm summary line would report coverage instead of breakage"
    );
}
