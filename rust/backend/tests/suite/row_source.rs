//! A source that cannot vouch for an area must make the answerer DECLINE.
//!
//! This is why [`backend::rowset_answerer::RowSource`] returns an `Option`
//! rather than a `Vec`. A fixture's row set is complete by construction, so it
//! never exercises the path; a live mirror is filled lazily and will, on the
//! first day that reaches an unfetched area.
//!
//! ⚠ The failure this guards is silent and looks like success. An answerer that
//! turned "cannot vouch" into an empty row list would answer `nearbyWays` with
//! "no roads near here" — a CLAIM about the world — and the fold would build a
//! day on it without one error. `converge` counts a decline; it cannot count a
//! lie. Same shape as #976.

use backend::fold_converge::Answerer;
use backend::lean::Miss;
use backend::rowset_answerer::{OsmAnswerer, RowSource};
use serde_json::{Value, json};

/// The three rail reads, declined. These doubles exist to exercise the SPATIAL
/// decline paths; a rail read they cannot vouch for must decline for the same
/// reason, not answer an empty list.
macro_rules! declines_rail {
    () => {
        fn rail_line_names(&mut self) -> anyhow::Result<Option<Vec<String>>> {
            Ok(None)
        }
        fn rail_ways_named(&mut self, _: &[String]) -> anyhow::Result<Option<Vec<Value>>> {
            Ok(None)
        }
        fn rail_stations(&mut self) -> anyhow::Result<Option<Vec<Value>>> {
            Ok(None)
        }
    };
}

/// Vouches for nothing, ever.
struct NeverCovered;

impl RowSource for NeverCovered {
    declines_rail!();
    fn line_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn point_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
}

/// Vouches for LINES only. Exists because `nearbyWays` is five queries — four
/// line buckets and an aeroway POINT query — and a test that only checks the
/// table declines cannot say WHICH of the five did it.
///
/// ⚠ This is not hypothetical tidiness. Ablated 2026-08-22 by making the line
/// path swallow a decline into an empty list: the earlier version of this file
/// still passed, because the aeroway point query declined a moment later. The
/// test was right about the table and blind about the reason.
struct LinesOnly;

impl RowSource for LinesOnly {
    declines_rail!();
    fn line_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(Some(Vec::new()))
    }
    fn point_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
}

/// Vouches for POINTS only — the mirror image of [`LinesOnly`].
struct PointsOnly;

impl RowSource for PointsOnly {
    declines_rail!();
    fn line_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn point_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(Some(Vec::new()))
    }
}

/// Vouches for every area, and finds nothing in all of them.
struct CoveredButEmpty;

impl RowSource for CoveredButEmpty {
    declines_rail!();
    fn line_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(Some(Vec::new()))
    }
    fn point_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(Some(Vec::new()))
    }
}

/// A coordinate key in the spelling the fold uses: bit patterns joined by `|`.
fn miss(what: &str, lat: f64, lon: f64, radius: Option<f64>) -> Miss {
    let mut key = format!("{}|{}", lat.to_bits(), lon.to_bits());
    if let Some(r) = radius {
        key.push('|');
        key.push_str(&r.to_bits().to_string());
    }
    Miss {
        what: what.to_string(),
        key,
    }
}

#[test]
fn a_source_that_cannot_vouch_declines_every_row_backed_table() {
    let mut a = OsmAnswerer::with_source(NeverCovered);
    for (what, radius) in [
        ("nearbyWays", None),
        ("nearbyStations", Some(500.0)),
        ("linesAtPoint", Some(500.0)),
    ] {
        let got = a
            .answer(&miss(what, 51.5, -0.1, radius))
            .unwrap_or_else(|e| panic!("{what}: {e:#}"));
        assert!(
            got.is_none(),
            "{what} answered {got:?} from a source that vouches for nothing"
        );
    }
}

#[test]
fn nearby_ways_declines_on_either_half_of_its_fan_out() {
    // ⚠ EACH HALF SEPARATELY. `nearbyWays` is ONE table built from five
    // queries; answering with four of them would report the aerodrome-free
    // version of a coordinate as if it were complete. Checking only that the
    // table declines cannot tell the two paths apart, and the point path
    // covered for the line path when this was first written.
    let mut lines_only = OsmAnswerer::with_source(LinesOnly);
    assert!(
        lines_only
            .answer(&miss("nearbyWays", 51.5, -0.1, None))
            .expect("the call succeeds")
            .is_none(),
        "nearbyWays answered while the aeroway POINT query could not be vouched for"
    );

    let mut points_only = OsmAnswerer::with_source(PointsOnly);
    assert!(
        points_only
            .answer(&miss("nearbyWays", 51.5, -0.1, None))
            .expect("the call succeeds")
            .is_none(),
        "nearbyWays answered while the LINE buckets could not be vouched for"
    );
}

#[test]
fn covered_but_empty_is_an_answer_not_a_decline() {
    // The other half, and why this cannot collapse to "no rows means decline":
    // an area that HAS been fetched and genuinely holds no railway is a real,
    // empty answer, and declining it would make the fold re-ask forever.
    let mut a = OsmAnswerer::with_source(CoveredButEmpty);
    let (table, row) = a
        .answer(&miss("linesAtPoint", 51.5, -0.1, Some(500.0)))
        .expect("the call succeeds")
        .expect("an empty area is still an answer");
    assert_eq!(table, "linesAtPoint");
    assert_eq!(
        row.as_array().and_then(|a| a.get(3)),
        Some(&json!([])),
        "an empty area should answer with no line names"
    );
}

#[test]
fn tables_that_need_no_rows_are_unaffected_by_the_source() {
    // `bestPlace` is pure tzdata; it reads no row, so a source that vouches for
    // nothing must not suppress it.
    let mut a = OsmAnswerer::with_source(NeverCovered);
    let key = format!(
        "{}|{}|1777452714|1777456248|Europe/London",
        51.5f64.to_bits(),
        (-0.1f64).to_bits()
    );
    let got = a
        .answer(&Miss {
            what: "bestPlace".into(),
            key,
        })
        .expect("the call succeeds");
    assert!(
        got.is_some(),
        "bestPlace needs no rows and must survive a source that has none"
    );
}
