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
    // ⚠ THE GATE IS LEAN CODE. Every mirror read now asks `decideCoverage`
    // through `@[export]`, so a test that reaches the mirror without the
    // runtime up does not fail — it SIGSEGVs, which is how this line came to
    // be here rather than by being foreseen.
    assert!(day_shell::init_lean(), "the Lean runtime must come up");
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
    //
    // ⚠ AND EACH IS CHECKED AGAINST WHAT THE MIRROR ACTUALLY HOLDS. A callback
    // may now DECLINE (#1667), and a decline is right or wrong depending on the
    // coverage gate's own reading of the same ground — so the gate is asked
    // first, with `decision`, which does not record. Asserting "rings come
    // back" outright would be asserting a fact about the mirror's CONTENTS, and
    // that fact went stale: the building layer is the thinnest in the mirror
    // and does not reach this square today.
    let poly = day_shell::mirror::bbox_polygon_wkt(lat, lon, RADIUS_M, 0.0);
    let gate = |bucket: &str| -> bool {
        day_shell::coverage::decision(bucket, lat, lon, RADIUS_M, &poly)
            .expect("the coverage table reads")
            .0
    };

    // Highway is the covered layer here, so both way readers must ANSWER.
    assert!(
        gate("highway"),
        "the highway bucket is uncovered at a central-London square, so this \
         run can say nothing about whether the way readers work. Either the \
         mirror lost its coverage or the gate is broken"
    );
    let walkable = walkable.expect(
        "walkable_roads DECLINED over ground the gate calls covered — the \
         reader and the gate disagree about the same bucket",
    );
    let drivable = drivable.expect("drivable_roads DECLINED over covered ground");
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

    // ⚠ BUILDINGS: THE ANSWER MUST MATCH THE GATE, whichever way the gate goes.
    // That is the check this file can still make honestly — not "there are
    // buildings here", which depends on what has been fetched, but "the reader
    // declines exactly when the ground is uncovered and answers otherwise".
    let buildings = match (gate("building"), buildings) {
        (true, Some(b)) => {
            assert!(
                !b.is_empty(),
                "the building bucket is covered here, so a read that finds \
                 nothing means the query or the bbox is wrong"
            );
            b
        }
        (false, None) => {
            eprintln!(
                "buildings_near declined: the building bucket does not cover \
                 this square. That is the honest answer and the reason #1667 \
                 exists — before it, this read claimed there were no buildings."
            );
            Vec::new()
        }
        (true, None) => panic!("buildings_near DECLINED over covered ground"),
        (false, Some(_)) => panic!(
            "buildings_near ANSWERED over uncovered ground — the read got past \
             the gate, which is the defect the gate was added to stop"
        ),
    };

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
