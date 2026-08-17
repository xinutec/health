//! The mirror read's two ports, pinned as a contract.
//!
//! `mirror.rs` reimplements three TS functions in Rust, and the whole value of
//! the reimplementation is that it asks the SAME question and reads the SAME
//! answer. Two pieces of that are pure and can be checked without a database:
//! the query box that goes into `ST_GeomFromText`, and the WKT the rows come
//! back as. Everything else needs a mirror, and `--osm-verify` is the check for
//! it — 13 keys against prod, 0 mismatched (#959).

use day_shell::mirror::{bbox_polygon_wkt, parse_linestring_wkt, placeholders};

/// `bboxPolygonWkt` — `osm-local.ts:843`. The exact string is the query, so a
/// formatting difference is a different query.
#[test]
fn the_query_box_is_a_closed_ring() {
    let w = bbox_polygon_wkt(51.5, -0.1, 537.0, 400.0);
    let inner: Vec<&str> = w
        .strip_prefix("POLYGON((")
        .and_then(|s| s.strip_suffix("))"))
        .expect("POLYGON((…)) shape")
        .split(',')
        .collect();
    assert_eq!(inner.len(), 5, "four corners and the repeated first: {w}");
    assert_eq!(inner[0], inner[4], "the ring must close: {w}");
}

/// The box widens with the radius, and by the margin as well as the radius —
/// `(radiusM + margin) / 111320`, not `radiusM / 111320`.
#[test]
fn the_margin_widens_the_box() {
    let tight = bbox_polygon_wkt(51.5, -0.1, 100.0, 0.0);
    let with_margin = bbox_polygon_wkt(51.5, -0.1, 100.0, 400.0);
    assert_ne!(tight, with_margin);
}

/// ⚠ WKT writes `lon lat`. Every consumer here wants `(lat, lon)`, and getting
/// this backwards puts London in the Indian Ocean.
#[test]
fn wkt_is_lon_lat_and_comes_back_lat_lon() {
    let pts = parse_linestring_wkt("LINESTRING(-0.2649138 51.5675888,-0.2649053 51.5675617)");
    assert_eq!(pts, vec![(51.5675888, -0.2649138), (51.5675617, -0.2649053)]);
}

/// `LINESTRING (…)` with a space is what some writers emit; both are accepted,
/// as the TS's case-insensitive regex accepts both.
#[test]
fn a_space_after_the_keyword_is_accepted() {
    assert_eq!(parse_linestring_wkt("LINESTRING (1 2)").len(), 1);
}

/// Not a linestring, and not a panic. A `POINT` row in a line table is corrupt
/// data, and the read's job is to drop it rather than to guess at it.
#[test]
fn anything_that_is_not_a_linestring_decodes_to_nothing() {
    assert!(parse_linestring_wkt("POINT(-0.1 51.5)").is_empty());
    assert!(parse_linestring_wkt("").is_empty());
    assert!(parse_linestring_wkt("LINESTRING(nonsense)").is_empty());
}

/// One placeholder per subtype. The subtype lists are constants in this crate,
/// but they still go through bound parameters — a list that is interpolated is
/// a list that can one day be interpolated from somewhere else.
#[test]
fn placeholders_are_one_per_value() {
    assert_eq!(placeholders(1), "?");
    assert_eq!(placeholders(3), "?,?,?");
    assert_eq!(placeholders(0), "");
}

/// An UNCONFIGURED mirror is absence, not failure — health #976.
///
/// `with_conn` counts every `None` it produces past the pool check, because all
/// of them (poisoned lock, unopenable connection, errored query) reach the
/// caller as an empty `Vec` that reads downstream as "no roads here". The pool
/// check itself is deliberately BEFORE the counter: with no `DB_HOST`/`DB_NAME`
/// there is no mirror to fail, and counting that would print
/// `⚠ MIRROR FAILED` on every fixture-only and stub run — training the reader
/// to ignore the one line that means a database fault.
///
/// ⚠ This pins the half that can be checked without a database. The other half
/// — that a real query error IS counted — needs a reachable-but-broken mirror
/// and is covered by running against prod, not here. Do not read this test as
/// evidence that failures are counted; it is evidence that non-failures are not.
#[test]
fn an_unconfigured_mirror_counts_no_failures() {
    // The three readers all route through `with_pool`. Without the env vars
    // `configured()` is false and each returns empty without touching a socket.
    assert!(
        !day_shell::mirror::configured(),
        "this test is only meaningful with no DB_HOST/DB_NAME in the environment; \
         if the suite ever runs against a real mirror, skip rather than adapt it"
    );
    let _ = day_shell::mirror::walkable_roads(51.5, -0.1, 100.0);
    let _ = day_shell::mirror::drivable_roads(51.5, -0.1, 100.0);
    let _ = day_shell::mirror::buildings_near(51.5, -0.1, 100.0);
    assert_eq!(
        day_shell::mirror::take_fails(),
        0,
        "absence was counted as failure — every fixture run would warn"
    );
}
