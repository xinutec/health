//! `osm_coverage` decodes against a REAL mirror.
//!
//! ⚠ **NOTHING WITHOUT A DATABASE CAN SEE THIS FAIL.** sqlx's MySQL driver
//! refuses a `DECIMAL` column as an `f64` or a `String`, and `UNIX_TIMESTAMP`
//! returns one — so a query that reads the columns bare type-checks, passes
//! every offline test, and then decodes NOTHING against production.
//!
//! That failure is silent and total: zero boxes means every question is
//! uncovered, every OSM lookup declines, and every walk draws raw while the
//! fold reports success. It is the same shape as the loader that decoded 117
//! places to centroid 0.0 and printed OK.
//!
//! ⚠ **IT SKIPS WITHOUT A MIRROR, AND IT SAYS SO LOUDLY** — see
//! `mirror_rows_come_back.rs` for why a silent skip is worse than no check.
//!
//! ```text
//! scripts/prod-db.sh cargo nextest run --manifest-path rust/Cargo.toml \
//!   -p day-shell --test coverage_boxes_decode --no-capture
//! ```
//!
//! ⚠ **READ-ONLY.** One `SELECT` per bucket, and no decline is recorded: this
//! calls `boxes_for`, not `covered`. It is still a production actor when
//! pointed at production — it takes a connection and a read lock.

/// A public landmark in central London, deliberately not a place the user goes
/// — the mirror is built around where he moves, and this sits inside that area
/// without naming anywhere of his (#860). The same point
/// `mirror_rows_come_back.rs` asks about, so the two runs are comparable.
const LAT: f64 = 51.5080;
const LON: f64 = -0.1281;
const RADIUS_M: f64 = 250.0;

#[test]
fn the_coverage_table_decodes_against_a_real_mirror() {
    if std::env::var("DB_HOST").is_err() || std::env::var("DB_NAME").is_err() {
        eprintln!(
            "SKIPPED, not passed: no mirror configured (DB_HOST / DB_NAME unset).\n\
             This is the only check that proves osm_coverage decodes at all;\n\
             run it with:  scripts/prod-db.sh cargo nextest run --manifest-path \
             rust/Cargo.toml -p day-shell --test coverage_boxes_decode --no-capture"
        );
        return;
    }
    assert!(
        day_shell::mirror::configured(),
        "DB_HOST and DB_NAME are set, so the mirror must report itself configured"
    );
    // The gate asks Lean, and asking Lean before the runtime is up is a
    // SIGSEGV. Without this the decision below reads `false` for everything and
    // the report says nothing.
    assert!(day_shell::init_lean(), "the Lean runtime must come up");

    let highway = day_shell::coverage::boxes_for("highway")
        .expect("reading osm_coverage for highway must not fail");
    eprintln!("highway: {} box(es)", highway.len());
    assert!(
        !highway.is_empty(),
        "the highway bucket has no coverage boxes. Either the decode dropped \
         every row, or this mirror has never been fetched — and the first looks \
         exactly like the second from here, which is why the values are checked \
         below rather than only the count"
    );

    // ⚠ THE VALUES, not just the count. A decode that produced the right NUMBER
    // of rows with zeroed coordinates would satisfy a count and cover nothing
    // but the Gulf of Guinea.
    for b in &highway {
        assert!(
            b.min_lat > -90.0 && b.max_lat < 90.0 && b.min_lat < b.max_lat,
            "a box with latitudes {} .. {}",
            b.min_lat,
            b.max_lat
        );
        assert!(
            b.min_lon >= -180.0 && b.max_lon <= 180.0 && b.min_lon < b.max_lon,
            "a box with longitudes {} .. {}",
            b.min_lon,
            b.max_lon
        );
        assert!(
            b.min_lat != 0.0 || b.min_lon != 0.0,
            "a box cornered at (0, 0) is what a failed parse looks like"
        );
    }

    // The building bucket is the thin one this gate exists to fill (#1667):
    // it may legitimately be empty, so its COUNT is reported, not asserted.
    let building = day_shell::coverage::boxes_for("building")
        .expect("reading osm_coverage for building must not fail");
    eprintln!("building: {} box(es)", building.len());

    // ⚠ WHAT THE GATE ACTUALLY DECIDES, reported rather than asserted. Coverage
    // is a fact about the mirror on the day it is asked, not an invariant: the
    // point of printing it is that "building is uncovered here" and "the decode
    // is broken" are the two readings of a decline, and the assertions above
    // have already ruled the second out.
    //
    // `decision`, not `covered`: this must not write a queue row.
    for bucket in ["highway", "building"] {
        let poly = day_shell::mirror::bbox_polygon_wkt(LAT, LON, RADIUS_M, 0.0);
        let (by_boxes, has_local) =
            day_shell::coverage::decision(bucket, LAT, LON, RADIUS_M, &poly)
                .expect("the coverage table reads");
        eprintln!("{bucket}: covered={by_boxes} local_rows={has_local}");
    }
}
