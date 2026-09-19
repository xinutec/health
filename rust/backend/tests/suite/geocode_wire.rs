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
