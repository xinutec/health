//! `nominatim::Geocode` must round-trip every geocode the corpus already holds
//! (#1076).
//!
//! # Why a real-data test and not another mock
//!
//! The client being ported writes into `osmTrace.reverseGeocode`, a section the
//! TypeScript filled from Nominatim and the Lean fold reads by field name. A
//! hand-written sample proves only that the struct matches what I believed the
//! shape was. The 42 golden days carry **795 answers the TypeScript actually
//! recorded**, which is the only evidence available that the port's wire shape
//! is the one already on disk.
//!
//! Round-trip rather than parse: parsing succeeds while silently dropping a
//! field serde does not know about, and a dropped field is exactly how a
//! re-capture would come back subtly poorer than the day it replaced.
//!
//! Local-only, and announces a skip: the corpus is gitignored (#860).

use std::path::Path;

use backend::nominatim::Geocode;
use serde_json::Value;

#[test]
fn every_recorded_geocode_round_trips_through_the_ported_shape() {
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    if !Path::new(golden).is_dir() {
        eprintln!("SKIPPED: no corpus at {golden}");
        return;
    }
    let mut names: Vec<String> = std::fs::read_dir(golden)
        .expect("golden dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();

    let (mut days, mut answers) = (0usize, 0usize);
    let mut broken: Vec<String> = Vec::new();

    for name in &names {
        let Ok(raw) = std::fs::read_to_string(format!("{golden}/{name}")) else {
            continue;
        };
        let fx: Value = serde_json::from_str(&raw).expect("fixture parses");
        let Some(section) = fx["inputs"]["osmTrace"]["reverseGeocode"].as_object() else {
            continue;
        };
        days += 1;
        for (key, recorded) in section {
            answers += 1;
            // ⚠ The KEY is a coordinate and this repo is public (#860). A
            // failure names the day and the key's ZOOM, never its position.
            let zoom = key.rsplit('|').next().unwrap_or("?");
            match serde_json::from_value::<Geocode>(recorded.clone()) {
                Ok(parsed) => {
                    let back = serde_json::to_value(&parsed).expect("a geocode encodes");
                    if &back != recorded {
                        broken.push(format!("{name} zoom {zoom}: re-encoded differently"));
                    }
                }
                Err(e) => broken.push(format!("{name} zoom {zoom}: {e}")),
            }
        }
    }

    assert!(
        broken.is_empty(),
        "{} of {answers} recorded geocode(s) do not round-trip:\n  {}",
        broken.len(),
        broken.join("\n  ")
    );
    // ⚠ A test that parses nothing passes. The corpus is present by the check
    // above, so zero answers means the section moved, not that all is well.
    assert!(
        answers > 0,
        "the corpus is present but holds no reverseGeocode answers — the section moved"
    );
    eprintln!("{answers} recorded geocode(s) across {days} day(s) round-trip");
}

/// A source that declines everything spatial but HAS one geocode to hand — the
/// shape `MirrorSource` takes once it can reach `osm_cache` (#1076).
struct OneGeocode(serde_json::Value);

impl backend::rowset_answerer::RowSource for OneGeocode {
    fn line_rows(&mut self, _: &str, _: f64, _: f64, _: f64) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn point_rows(
        &mut self,
        _: &str,
        _: f64,
        _: f64,
        _: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn rail_line_names(&mut self) -> anyhow::Result<Option<Vec<String>>> {
        Ok(None)
    }
    fn rail_ways_named(&mut self, _: &[String]) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn rail_stations(&mut self) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn geocode(&mut self, _: f64, _: f64, _: i64) -> anyhow::Result<Option<Value>> {
        Ok(Some(self.0.clone()))
    }
}

/// Declines everything, including the geocode — the default, and what every
/// corpus replay must keep doing.
struct DeclinesAll;

impl backend::rowset_answerer::RowSource for DeclinesAll {
    fn line_rows(&mut self, _: &str, _: f64, _: f64, _: f64) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn point_rows(
        &mut self,
        _: &str,
        _: f64,
        _: f64,
        _: f64,
    ) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn rail_line_names(&mut self) -> anyhow::Result<Option<Vec<String>>> {
        Ok(None)
    }
    fn rail_ways_named(&mut self, _: &[String]) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn rail_stations(&mut self) -> anyhow::Result<Option<Vec<Value>>> {
        Ok(None)
    }
}

/// One Nominatim answer, in the shape both the cache and a fixture carry.
fn sample() -> Value {
    serde_json::json!({
        "displayName": "Trafalgar Square, London, England, United Kingdom",
        "type": "square",
        "category": "highway",
        "address": {
            "road": "Trafalgar Square",
            "house_number": "1",
            "neighbourhood": "Covent Garden",
            "city": "London",
            "country_code": "gb"
        }
    })
}

/// ⚠ THE CLAIM THE WIRING RESTS ON. A geocode that reaches the fold from a live
/// cache and one that reaches it from a recorded fixture section must be the
/// SAME BYTES — otherwise a day graded on the corpus and the same day served
/// would differ for a reason no gate can see (#1071 records that shape for
/// `ROAD_CORRIDOR_MARGIN_M`).
///
/// Both paths are driven here and compared: the answerer's live row against
/// `build_day_request`'s encoding of the identical answer at the identical
/// coordinate.
#[test]
fn a_live_geocode_and_a_recorded_one_are_the_same_row() {
    use backend::lean::Answerer;
    use backend::lean::Ask;
    use backend::rowset_answerer::OsmAnswerer;

    // A coordinate with a negative longitude, because that is where the two
    // roundings and the two key formats both bite.
    let (lat, lon, zoom) = (51.508_039_f64, -0.128_069_f64, 18_i64);
    let key = format!("{}|{}|{zoom}", lat.to_bits(), lon.to_bits());

    let mut live = OsmAnswerer::with_source(OneGeocode(sample()));
    let answered = live
        .answer(&Ask {
            what: "reverseGeocode".into(),
            key: key.clone(),
        })
        .expect("the arm runs")
        .expect("a source with a geocode answers");

    // The recorded path: a fixture section keyed in PLAIN DECIMALS — the format
    // the TypeScript wrote — through the encoder the request builder uses.
    let section = serde_json::json!({
        format!("{lat}|{lon}|{zoom}"): sample(),
    });
    let recorded = backend::fold_payload::geocode_table(Some(&section));
    let recorded_row = recorded[0].clone();

    assert_eq!(
        answered, recorded_row,
        "the live row and the recorded row must agree"
    );
}

/// ⚠ THE DEFAULT MUST DECLINE. Every corpus replay answers `reverseGeocode`
/// from its own fixture; a source that started guessing would grade a day
/// against answers its fixture does not carry.
#[test]
fn a_source_with_no_geocode_declines_rather_than_answering_nothing_is_there() {
    use backend::lean::Answerer;
    use backend::lean::Ask;
    use backend::rowset_answerer::OsmAnswerer;

    let mut plain = OsmAnswerer::with_source(DeclinesAll);
    let out = plain
        .answer(&Ask {
            what: "reverseGeocode".into(),
            key: format!("{}|{}|16", 51.5_f64.to_bits(), (-0.12_f64).to_bits()),
        })
        .expect("the arm runs");
    assert!(
        out.is_none(),
        "declining is the default; answering would be a claim about the world"
    );
}
