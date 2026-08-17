//! Calling the mirror from inside a tokio runtime REFUSES rather than aborts.
//!
//! The mirror moved from the `mysql` crate to sqlx (health #982). sqlx is async
//! and this path is deliberately synchronous — the fold reaches it through a
//! Lean callback, which has no `await` to hand an answer back through — so
//! every query is `block_on`ed at the boundary.
//!
//! `block_on` PANICS inside an async context: "cannot start a runtime from
//! within a runtime". That would abort the whole process. Every other failure
//! mode here answers empty and counts a miss, so a crash would be the single
//! path that behaves differently, and it is the one the Rust backend (#982)
//! will hit first — axum handlers are async everywhere.
//!
//! So `with_pool` checks `Handle::try_current()` and refuses. This pins that.
//!
//! ⚠ ITS OWN FILE, and not because it is tidier. `POOL` is a `OnceLock`, so the
//! first call decides for the whole process whether a mirror is configured. This
//! test must set `DB_HOST`/`DB_NAME` to get PAST the unconfigured early-out,
//! while `mirror_port.rs` asserts they are absent. Cargo builds each file under
//! `tests/` as its own binary, so the two cannot collide — in one file they
//! would, and the loser would depend on test ordering.

/// A host that cannot resolve. The pool is built with `connect_lazy_with`, so
/// nothing is dialled until a query runs — and the guard returns before that,
/// which is the whole point. Nothing here touches the network.
const UNRESOLVABLE: &str = "mirror-async-guard.invalid";

#[test]
fn calling_from_inside_a_runtime_refuses_instead_of_panicking() {
    // SAFETY: single-threaded test binary, set before any mirror call.
    unsafe {
        std::env::set_var("DB_HOST", UNRESOLVABLE);
        std::env::set_var("DB_NAME", "health");
    }
    assert!(
        day_shell::mirror::configured(),
        "the guard is only reachable once a mirror is configured; without that \
         the readers return empty at the earlier absence check and this test \
         would pass for the wrong reason"
    );
    // Absence must not have been counted on the way here.
    assert_eq!(day_shell::mirror::take_fails(), 0);

    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test runtime");

    // The call that used to abort the process. Inside `block_on`, so
    // `Handle::try_current()` is `Ok` exactly as it would be in an axum handler.
    let (ways, buildings) = rt.block_on(async {
        (
            day_shell::mirror::walkable_roads(51.5, -0.1, 100.0),
            day_shell::mirror::buildings_near(51.5, -0.1, 100.0),
        )
    });

    assert!(
        ways.is_empty(),
        "a refused read must answer empty, as every other failure does"
    );
    assert!(buildings.is_empty());
    assert_eq!(
        day_shell::mirror::take_fails(),
        2,
        "a refusal IS a failure — the caller got no roads. Counting it zero would \
         hide an async caller behind a summary line identical to a healthy one"
    );
}
