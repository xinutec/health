//! A landmark table that ANSWERS EMPTY names nothing, and counts as answered.
//!
//! This is the shape of #1054. `nearbyLandmarks` is what puts a venue name on a
//! timeline instead of a bare "stationary". When the shaping returned an empty
//! list, every count in the converge loop still read as answered, the stay
//! still rendered, and two venue names a day silently vanished — measured
//! against production on a day where all six asks answered and all six were
//! empty.
//!
//! ⚠ The fixture here is SYNTHETIC on purpose (#860): a tracked test must not
//! carry a real coordinate and a real venue, which together record where
//! someone was. The defect does not need real data to reproduce — it is an
//! encoding mismatch, and it fires on any tagged feature at any coordinate.
//!
//! ⚠ The two defects this pins are both ENCODING mismatches between the two
//! Lean entry points, and neither is detectable by shape:
//!
//! * `ServeEntry.tagsJson` writes a tag pair as a two-element ARRAY, and
//!   `BackendEntry`'s shaping read it as a `{k, v}` OBJECT. Both are
//!   well-formed JSON. A feature whose tags parse to nothing spawns no
//!   landmark, so the answer was `[]` for every stay everywhere.
//! * `distanceM` crosses as an IEEE-754 BIT PATTERN in a string, which is what
//!   `DayEntry.parsePoi` reads with `jBits`. Emitting a JSON number instead
//!   fails the fold's decode with "String expected" — and that one is only
//!   REACHABLE once the shaping stops being empty, which is how it hid behind
//!   the first.
//!
//! So the assertion is not "the call succeeded": it is that a named, tagged
//! feature within the radius comes back AS a landmark, spelled the way the fold
//! reads it.

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

/// The stay's coordinate, and a venue 20-odd metres from it. Invented.
const LAT: f64 = 51.5;
const LON: f64 = -0.1;
const VENUE_LAT: f64 = 51.500_2;
const VENUE_LON: f64 = -0.1;

/// One tagged point POI and no lines — a node-mapped venue, the common case.
///
/// ⚠ Answers `Some` for BOTH buckets. Either returning `None` declines the
/// whole table, and a decline is loud where an empty answer is not; this test
/// would pass for the wrong reason if the line side declined.
struct OneVenue;

impl RowSource for OneVenue {
    declines_rail!();
    fn line_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(Some(vec![]))
    }

    fn point_rows(
        &mut self,
        _bucket: &str,
        _lat: f64,
        _lon: f64,
        _radius_m: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        // The positional form `MirrorSource::point_rows` emits: osm_id,
        // subtype, name, latBits, lonBits, tags — the tags as `[[k, v], …]`.
        Ok(Some(vec![json!([
            1_000_000_001_i64,
            "restaurant",
            "The Invented Arms",
            VENUE_LAT.to_bits().to_string(),
            VENUE_LON.to_bits().to_string(),
            [
                ["amenity", "restaurant"],
                ["opening_hours", "Mo-Su 11:00-22:00"]
            ]
        ])]))
    }
}

fn ask() -> Miss {
    Miss {
        what: "nearbyLandmarks".into(),
        key: format!(
            "{}|{}|{}",
            LAT.to_bits(),
            LON.to_bits(),
            100.0_f64.to_bits()
        ),
    }
}

#[test]
fn a_tagged_venue_in_range_becomes_a_landmark() {
    let (table, row) = OsmAnswerer::with_source(OneVenue)
        .answer(&ask())
        .expect("the answerer errored")
        .expect("the answerer DECLINED — it must answer when both buckets vouch");
    assert_eq!(table, "nearbyLandmarks");

    // ⚠ FOUR elements: `[lat, lon, radius, answer]`. The three-element form
    // `nearbyWays` uses is a different row, and the fold reads it as malformed.
    let parts = row.as_array().expect("the row is not an array");
    assert_eq!(parts.len(), 4, "row arity: {row}");

    let found = parts[3].as_array().expect("the answer is not an array");
    assert!(
        !found.is_empty(),
        "SHAPED NOTHING from a named, tagged venue 22 m away — this is the \
         empty answer that claims 'no venues here' (#1054). Answer: {row}"
    );

    let l = &found[0];
    assert_eq!(
        l.get("name").and_then(Value::as_str),
        Some("The Invented Arms")
    );
    assert_eq!(l.get("type").and_then(Value::as_str), Some("amenity"));
    assert_eq!(l.get("subtype").and_then(Value::as_str), Some("restaurant"));
    // The tag that only survives if the PAIR decoded — a landmark keeps its
    // opening hours, and reading the pair wrongly loses this with the rest.
    assert_eq!(
        l.get("openingHours").and_then(Value::as_str),
        Some("Mo-Su 11:00-22:00")
    );

    // ⚠ A BIT-PATTERN STRING, because `DayEntry.parsePoi` reads it with
    // `jBits`. A JSON number here fails the fold's decode outright.
    let d = l
        .get("distanceM")
        .and_then(Value::as_str)
        .expect("distanceM is not a string — the fold reads it with `jBits`");
    let metres = f64::from_bits(d.parse::<u64>().expect("distanceM is not u64 bits"));
    assert!(
        (10.0..40.0).contains(&metres),
        "distance decoded to {metres} m, which is not where the venue was put"
    );
}

/// The enclosing-institution override needs `encloses` from the LINE side, so a
/// point-only source must still answer rather than decline.
#[test]
fn no_venues_in_range_is_an_empty_answer_not_a_decline() {
    struct Empty;
    impl RowSource for Empty {
        declines_rail!();
        fn line_rows(
            &mut self,
            _b: &str,
            _la: f64,
            _lo: f64,
            _r: f64,
        ) -> anyhow::Result<Option<Vec<Value>>> {
            Ok(Some(vec![]))
        }
        fn point_rows(
            &mut self,
            _b: &str,
            _la: f64,
            _lo: f64,
            _r: f64,
        ) -> anyhow::Result<Option<Vec<Value>>> {
            Ok(Some(vec![]))
        }
    }
    let (_, row) = OsmAnswerer::with_source(Empty)
        .answer(&ask())
        .expect("errored")
        .expect("declined");
    assert!(
        row.as_array().expect("not an array")[3]
            .as_array()
            .expect("answer not an array")
            .is_empty()
    );
}
