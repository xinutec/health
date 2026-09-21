//! A vouched-for thread ASKS the mirror; an unvouched one refuses.
//!
//! This is health #1619's regression test. Production reached the three OSM
//! callbacks on a `spawn_blocking` thread, where blocking is legal — but
//! `with_pool` only asked `Handle::try_current()`, which reads the same there as
//! on a runtime worker where blocking deadlocks. So it refused, answered empty,
//! and every walking leg on every served day kept its raw drawing.
//!
//! ⚠ **THE TWO OUTCOMES ARE INDISTINGUISHABLE BY THE ANSWER.** A refusal and a
//! query against an unreachable host both return an empty `Vec` and both count a
//! failure. `take_refusals` is the only thing that separates them, and that is
//! why this test can exist at all — asserting on emptiness would pass without
//! the fix.
//!
//! ⚠ ITS OWN FILE for the reason `mirror_async_guard.rs` gives: `POOL` is a
//! `OnceLock`, so the first call decides for the whole process, and that file
//! pins the OPPOSITE case.

/// A host that cannot resolve. `connect_lazy_with` dials nothing until a query
/// runs, and the query here is expected to fail — what is under test is whether
/// it is ATTEMPTED. Nothing reaches the network beyond a failed DNS lookup.
const UNRESOLVABLE: &str = "mirror-blocking-handle.invalid";

#[test]
fn a_vouched_thread_asks_and_an_unvouched_one_refuses() {
    // SAFETY: single-threaded test binary, set before any mirror call.
    unsafe {
        std::env::set_var("DB_HOST", UNRESOLVABLE);
        std::env::set_var("DB_NAME", "health");
    }
    assert!(
        day_shell::mirror::configured(),
        "without a configured mirror both arms return empty at the earlier \
         absence check and this test passes for the wrong reason"
    );
    assert_eq!(day_shell::mirror::take_refusals(), 0);
    assert_eq!(day_shell::mirror::take_fails(), 0);

    // ⚠ MULTI-THREAD, because that is what production runs and because
    // `spawn_blocking` on a current-thread runtime would not reproduce the
    // thread this is about.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("test runtime");

    // ── the production arm: a blocking thread whose caller vouched for it ──
    let handle = rt.handle().clone();
    let ways = rt.block_on(async move {
        let h = handle.clone();
        tokio::task::spawn_blocking(move || {
            day_shell::mirror::with_blocking_handle(h, || {
                day_shell::mirror::walkable_roads(51.5, -0.1, 100.0)
            })
        })
        .await
        .expect("the blocking thread panicked")
    });

    assert!(
        ways.is_none(),
        "the host does not resolve, so the read declines — it does not answer \
         that there is nothing there (#1667)"
    );
    assert_eq!(
        day_shell::mirror::take_refusals(),
        0,
        "a vouched thread must ASK. A refusal here is the #1619 defect: the read \
         never reaches the database and the fold draws every walk raw"
    );
    assert_eq!(
        day_shell::mirror::take_fails(),
        1,
        "and the attempt must be counted a failure — it asked and got nothing"
    );

    // ── the control: the same call on the same runtime, unvouched ──
    // ⚠ NOT a different runtime or a different thread. The only thing varying is
    // whether the caller vouched, which is the axis under test.
    let ways = rt.block_on(async {
        tokio::task::spawn_blocking(|| day_shell::mirror::walkable_roads(51.5, -0.1, 100.0))
            .await
            .expect("the blocking thread panicked")
    });

    assert!(ways.is_none());
    assert_eq!(
        day_shell::mirror::take_refusals(),
        1,
        "nobody vouched, so it must refuse rather than block on a runtime it was \
         not given"
    );
    assert_eq!(day_shell::mirror::take_fails(), 1);
}
