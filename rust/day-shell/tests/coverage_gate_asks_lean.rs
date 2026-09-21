//! The coverage gate's ask reaches Lean, and the two sides of the wire agree.
//!
//! ⚠ **THIS IS THE ONLY CHECK THAT THE LAYOUT IS ONE LAYOUT.** `encode_ask`
//! writes the buffer and `DayEntry.OsmHost.decodeCoverageAsk` reads it, in two
//! languages, from one prose description. Lean's own `#guard`s pin the decoder
//! against literal bytes and Rust's types pin the encoder, and neither can
//! notice the two drifting apart — only a value run through both can.
//!
//! The cases are `Verified.Geo.OsmCoverage`'s rules, asked from this side: one
//! row must contain the whole disc, staleness is applied before containment, a
//! row with no fetch time is FRESH, and `hasLocalData` short-circuits the lot.
//!
//! ⚠ NO DATABASE. `decide` is the pure half of the gate on purpose; the half
//! that reads `osm_coverage` and records a decline needs a mirror and is covered
//! by the other `mirror_*` tests.

use day_shell::coverage::{CoverageBox, NO_FETCH_TIME, decide};

/// 2026-09-21T00:00:00Z, so "stale" and "fresh" are stated rather than relative.
const NOW_MS: i64 = 1_789_948_800_000;
const DAY_MS: i64 = 86_400_000;

/// A box around central London, 51..52 N and -1..1 E.
fn big_box(fetched_at_ms: i64) -> CoverageBox {
    CoverageBox {
        min_lat: 51.0,
        max_lat: 52.0,
        min_lon: -1.0,
        max_lon: 1.0,
        fetched_at_ms,
    }
}

fn ask(radius_m: f64, has_local: bool, boxes: &[CoverageBox]) -> bool {
    assert!(day_shell::init_lean(), "the Lean runtime must come up");
    decide(51.5, 0.0, radius_m, has_local, NOW_MS, boxes)
}

#[test]
fn a_disc_inside_a_fresh_box_is_covered() {
    assert!(
        ask(100.0, false, &[big_box(NOW_MS - DAY_MS)]),
        "a 100 m disc well inside a box fetched yesterday"
    );
}

#[test]
fn a_disc_wider_than_the_box_is_not() {
    assert!(
        !ask(500_000.0, false, &[big_box(NOW_MS - DAY_MS)]),
        "a 500 km disc is not inside a one-degree box, and there is no partial \
         credit — the whole search circle must fit in ONE row"
    );
}

#[test]
fn no_rows_at_all_is_not_covered() {
    assert!(
        !ask(100.0, false, &[]),
        "ground nobody has fetched. This is the case the three OSM callbacks \
         used to answer EMPTY for (#1667), which reads as 'there is nothing here'"
    );
}

#[test]
fn a_stale_box_does_not_cover_even_though_it_contains() {
    // ⚠ The ORDER is the rule: staleness is applied BEFORE containment. A box
    // that contains the disc but is past the 180-day TTL must not suppress the
    // refresh, or the area never updates.
    assert!(
        !ask(100.0, false, &[big_box(NOW_MS - 181 * DAY_MS)]),
        "181 days old"
    );
    assert!(
        ask(100.0, false, &[big_box(NOW_MS - 179 * DAY_MS)]),
        "179 days old — the same box on the other side of the TTL"
    );
}

#[test]
fn a_row_with_no_fetch_time_is_fresh() {
    // Legacy data from before fetch times were tracked. Treating the sentinel
    // as a timestamp would make it `Int64::MIN` milliseconds — older than every
    // cutoff — and re-fetch the entire mirror.
    assert!(ask(100.0, false, &[big_box(NO_FETCH_TIME)]));
}

#[test]
fn local_data_short_circuits_everything() {
    // The deliberate trade `OsmCoverage` documents: "the data might be stale"
    // against "do not query a flaky network when the answer is already here".
    assert!(
        ask(500_000.0, true, &[]),
        "no rows, a disc no box could contain, and it is still covered"
    );
    assert!(
        ask(100.0, true, &[big_box(NOW_MS - 10_000 * DAY_MS)]),
        "and staleness is short-circuited too, not just containment"
    );
}

#[test]
fn two_boxes_that_jointly_contain_the_disc_do_not_cover_it() {
    // ⚠ THERE IS NO UNION. This is why the writer sizes a fetch to the question
    // rather than to a grid: a disc straddling two adjacent boxes is uncovered,
    // however completely the pair enclose it.
    let west = CoverageBox {
        min_lat: 51.0,
        max_lat: 52.0,
        min_lon: -1.0,
        max_lon: 0.0,
        fetched_at_ms: NOW_MS,
    };
    let east = CoverageBox {
        min_lon: 0.0,
        max_lon: 1.0,
        ..west
    };
    assert!(
        !ask(100.0, false, &[west, east]),
        "the disc sits on the seam at lon 0"
    );
    assert!(
        ask(100.0, false, &[big_box(NOW_MS)]),
        "the same disc, in one box that contains it"
    );
}
