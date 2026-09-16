//! The three OSM callbacks return ROWS from a real mirror (#1627).
//!
//! `mirror_blocking_handle.rs` pins the refusal half against an unresolvable
//! host: it proves a read is ATTEMPTED. That says nothing about whether the
//! SQL, the bounding box or the subtype list are right — a query that runs and
//! legitimately returns nothing counts zero refusals and zero fails, and looks
//! perfect. This is the other half, and it is why #1619 survived: every gate
//! answers these callbacks from a captured trace, so `crate::mirror` is reached
//! by nothing.
//!
//! ⚠ **IT SKIPS WITHOUT A MIRROR, AND IT SAYS SO LOUDLY.** A silent skip is a
//! check that reports nothing and reads as a clean bill — the exact shape
//! `feedback_a_precondition_that_can_pass_wrongly` is about. The skip prints,
//! and the reason names what to run.
//!
//! ```text
//! scripts/prod-db.sh cargo nextest run --manifest-path rust/Cargo.toml \
//!   -p day-shell --test mirror_rows_come_back --no-capture
//! ```
//!
//! ⚠ ITS OWN FILE, for `mirror_async_guard.rs`'s reason: `POOL` is a `OnceLock`,
//! so the first call decides for the whole process and a file that configures a
//! real mirror cannot share a binary with one that configures a broken host.
//!
//! ⚠ **READ-ONLY.** Every query here is a `SELECT` against the OSM mirror
//! tables. It is still a production actor when pointed at production — it takes
//! a connection and a read lock like any other client.

/// A public landmark in central London, deliberately not a place the user goes.
/// The mirror is built around where he moves; this sits inside that area
/// without naming anywhere of his (#860).
const TRAFALGAR_SQUARE: (f64, f64) = (51.5080, -0.1281);

/// Metres around the point to ask for. Wide enough that a real mirror cannot
/// honestly answer nothing in central London, narrow enough to stay cheap.
const RADIUS_M: f64 = 250.0;

#[test]
fn the_three_callbacks_return_rows_from_a_real_mirror() {
    if std::env::var("DB_HOST").is_err() || std::env::var("DB_NAME").is_err() {
        eprintln!(
            "SKIPPED, not passed: no mirror configured (DB_HOST / DB_NAME unset).\n\
             This is the only check that proves rows come back from the OSM mirror;\n\
             run it with:  scripts/prod-db.sh cargo nextest run --manifest-path \
             rust/Cargo.toml -p day-shell --test mirror_rows_come_back --no-capture"
        );
        return;
    }
    assert!(
        day_shell::mirror::configured(),
        "DB_HOST and DB_NAME are set, so the mirror must report itself configured \
         — otherwise every assertion below passes at the absence check instead"
    );
    assert_eq!(day_shell::mirror::take_refusals(), 0);
    assert_eq!(day_shell::mirror::take_fails(), 0);

    // ⚠ THE PRODUCTION SHAPE, not a convenient one. The fold reaches these
    // callbacks on a `spawn_blocking` thread under a multi-thread runtime, with
    // the caller vouching for it. Calling them from plain sync code here would
    // take the private-runtime path and test something production never runs.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("test runtime");
    let handle = rt.handle().clone();
    let (lat, lon) = TRAFALGAR_SQUARE;

    let (walkable, buildings, drivable) = rt.block_on(async move {
        let h = handle.clone();
        tokio::task::spawn_blocking(move || {
            day_shell::mirror::with_blocking_handle(h, || {
                (
                    day_shell::mirror::walkable_roads(lat, lon, RADIUS_M),
                    day_shell::mirror::buildings_near(lat, lon, RADIUS_M),
                    day_shell::mirror::drivable_roads(lat, lon, RADIUS_M),
                )
            })
        })
        .await
        .expect("the blocking thread panicked")
    });

    // ⚠ EACH ONE NAMED SEPARATELY. A single "all three answered" assertion would
    // let two callbacks carry a third that is silently broken — which is the
    // failure mode this file exists for.
    assert!(
        !walkable.is_empty(),
        "walkable_roads answered nothing 250 m around a central-London square. \
         Either the mirror has no rows there, or WALKABLE_ROAD_SUBTYPES excludes \
         everything present, or the bbox is wrong"
    );
    assert!(
        !drivable.is_empty(),
        "drivable_roads answered nothing 250 m around a central-London square"
    );
    assert!(
        !buildings.is_empty(),
        "buildings_near answered nothing 250 m around a central-London square"
    );

    // ⚠ A RING IS AT LEAST A TRIANGLE. `buildings_near` already drops anything
    // shorter, so an empty or two-point ring arriving here would mean the WKT
    // parse produced something the filter could not see.
    for ring in &buildings {
        assert!(
            ring.len() >= 3,
            "a building outline came back with {} vertices",
            ring.len()
        );
    }

    // ⚠ AND THE COUNTERS MUST AGREE WITH THE ROWS. Rows plus a recorded failure
    // would mean one of the three fell back to empty while the others carried
    // the assertion — the exact shape the per-callback asserts above cannot see,
    // because an empty answer from a FAILED query is indistinguishable from an
    // honest one.
    assert_eq!(
        day_shell::mirror::take_refusals(),
        0,
        "a vouched thread must never refuse; a refusal here is #1619"
    );
    assert_eq!(
        day_shell::mirror::take_fails(),
        0,
        "all three queries answered, so none of them may have failed"
    );

    eprintln!(
        "mirror answered: {} walkable way(s), {} drivable way(s), {} building(s)",
        walkable.len(),
        drivable.len(),
        buildings.len()
    );
}
