//! A landmark table that answers empty names nothing, and counts as answered.
//!
//! An empty shaping reads as answered, so venue names vanish silently. Two
//! encoding mismatches between the Lean entry points, neither visible by shape:
//!
//! * `ServeEntry.tagsJson` writes a tag as a two-element array; reading it as a
//!   `{k, v}` object parses to no tags, so every answer is `[]`.
//! * `distanceM` crosses as an IEEE-754 bit string (`DayEntry.parsePoi`, `jBits`);
//!   a JSON number fails the fold's decode.
//!
//! So it asserts a named, tagged feature in range comes back as a landmark the
//! fold reads. ⚠ The fixture is synthetic: a tracked test carries no real
//! coordinate and venue.

use backend::lean::Answerer;
use backend::lean::Ask;
use backend::rowset_answerer::{OsmAnswerer, RowSource};
use serde_json::{Value, json};

/// The three rail reads, declined. These doubles exist to exercise the spatial
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

/// One tagged point POI and no lines, the common case. Both buckets answer
/// `Some`: a declined line side would pass this for the wrong reason.
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

fn ask() -> Ask {
    Ask {
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
    let row = OsmAnswerer::with_source(OneVenue)
        .answer(&ask())
        .expect("the answerer errored")
        .expect("the answerer DECLINED — it must answer when both buckets vouch");

    // Four elements: `[lat, lon, radius, answer]`. The three-element form
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
    // The tag that only survives if the pair decoded — a landmark keeps its
    // opening hours, and reading the pair wrongly loses this with the rest.
    assert_eq!(
        l.get("openingHours").and_then(Value::as_str),
        Some("Mo-Su 11:00-22:00")
    );

    // A bit-pattern string, because `DayEntry.parsePoi` reads it with
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

/// The enclosing-institution override needs `encloses` from the line side, so a
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
    let row = OsmAnswerer::with_source(Empty)
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
