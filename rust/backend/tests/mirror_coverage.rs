//! A low-coverage mirror refresh must REFUSE, on both arms (health #1134).
//!
//! ⚠ THIS DRIVES THE REAL PATH. The rule is Lean's, and these go through the
//! same `lean::may_rebuild` FFI call the CronJob makes — not a re-implementation
//! of the arithmetic here, which would test its own copy.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY, for the reason `lean_ffi.rs` gives:
//! `health_backend_init` starts a process-global runtime and cargo does not
//! serialise the tests inside one binary, so several racing on initialisation
//! flake in a way that reads as a Lean bug. Written as five at first, and all
//! five failed with `lean::init() was never called`.
//!
//! The numbers are production readings, not invented ones:
//!
//!     bus   2/18   the 2026-08-24 05:30 run that exited 0 saying `994 -> 994`
//!     rail 10/18   the 2026-08-25 dry run, 441 relations against 268 cached
//!                  — over the floor, and it PASSES; see the section on it
//!     rail 15/18   a healthy dry run, 2026-08-29
//!     bus  16/18   a healthy dry run, 2026-08-29

use backend::lean;

#[test]
fn a_low_coverage_refresh_is_refused_on_both_arms() {
    lean::init().expect("the Lean runtime must start");

    // ---- the run that started #1134 ----------------------------------------
    let v = lean::may_rebuild("bus", 112, 16, 18, 994).expect("the rule answers");
    assert!(!v.may_write, "2 of 18 tiles is not a refresh");
    let why = v.refusal.expect("a refusal names itself");
    assert!(why.contains("2/18"), "{why}");
    assert!(why.contains("stale"), "{why}");

    // ---- ⚠ AND THE RAIL CASE #1134 CITES IS **NOT** REFUSED -----------------
    // 10 of 18 is 56%, over the floor, so this writes — and that is correct now
    // even though the task records it as a defect. Its harm was LOSS, not
    // staleness: `rail_stops_cache` had no `tile_key`, so a 56% run DELETEd the
    // whole table and rewrote only what it found, dropping the 8 failed tiles'
    // relations while the count went 268 -> 441 and read like a healthy refresh.
    // Both caches carry a `tile_key` since 2026-08-25, so a partial run replaces
    // only the tiles that answered and nothing is dropped.
    //
    // Asserted rather than left unsaid, because a coverage floor is the WRONG
    // instrument for that half and quietly assuming it fixed both would be the
    // same mistake in a new place.
    let v = lean::may_rebuild("rail", 441, 8, 18, 268).expect("the rule answers");
    assert!(v.may_write, "10 of 18 is 56%, above the floor — it writes");
    assert!(
        !v.full_rebuild,
        "and NOT as a full rebuild: 8 tiles did not answer"
    );

    // ---- the other half: flakiness stays green -----------------------------
    // Or the alarm cries wolf and gets muted.
    let rail = lean::may_rebuild("rail", 484, 3, 18, 436).expect("the rule answers");
    assert!(rail.may_write, "15 of 18 is a refresh");
    assert!(rail.refusal.is_none(), "a passing run names no refusal");
    let bus = lean::may_rebuild("bus", 650, 2, 18, 996).expect("the rule answers");
    assert!(bus.may_write, "16 of 18 is a refresh");
    assert!(bus.refusal.is_none(), "a passing run names no refusal");

    // ---- ⚠ AN EMPTY CACHE BOOTSTRAPS ---------------------------------------
    // The first draft refused on the fraction alone, which would have left an
    // empty cache empty for ever. The harm named is a cache left mostly STALE;
    // with nothing in it there is nothing to be stale.
    let boot = lean::may_rebuild("bus", 12, 17, 18, 0).expect("the rule answers");
    assert!(
        boot.may_write,
        "1 of 18 into an EMPTY cache still populates it"
    );

    // ---- ⚠ THE BOUNDARY, both sides ----------------------------------------
    // A check only at 2/18 passes with the comparison written either way round.
    let at = lean::may_rebuild("bus", 100, 9, 18, 994).expect("the rule answers");
    assert!(at.may_write, "9 of 18 is exactly the floor and passes");
    let under = lean::may_rebuild("bus", 100, 10, 18, 994).expect("the rule answers");
    assert!(!under.may_write, "8 of 18 is under the floor");

    // ---- a complete run is still authoritative -----------------------------
    // The coverage check must not have taken `fullRebuild` away from it: a
    // per-tile delete cannot reach the `tile_key IS NULL` rows written before
    // the column existed, so only a full rebuild retires them.
    for mode in ["rail", "bus"] {
        let v = lean::may_rebuild(mode, 500, 0, 18, 400).expect("the rule answers");
        assert!(v.may_write, "{mode}: 18 of 18 writes");
        assert!(
            v.full_rebuild,
            "{mode}: 18 of 18 is authoritative for the bbox"
        );
    }
}
