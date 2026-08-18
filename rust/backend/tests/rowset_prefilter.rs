//! Does the row-set prefilter change any ANSWER? (#982)
//!
//! `RowSetAnswerer` drops rows before shipping them to Lean, because asking
//! about one coordinate otherwise sends an entire feature bucket — 26,812
//! highway rows and 157,489 coordinate pairs on a single London day.
//!
//! # ⚠ Why this test exists rather than the argument in the source
//!
//! The argument is that the filter is EXACT: Lean compares a degree-space
//! distance against `radiusM / mPerDegAt(lat)`, so a way whose own bounding box
//! misses that same box cannot hold a point inside the radius. That argument is
//! probably right, and "probably right" is exactly how a prefilter silently
//! deletes data — the result stays well-formed, just quietly emptier, and the
//! fold answers it without complaint.
//!
//! So this compares ANSWERS, filtered against unfiltered, on real query points
//! taken from the corpus. Local-only, and announces a skip.

use std::path::Path;

use backend::fold_converge::Answerer;
use backend::lean::Miss;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::Value;

/// The unfiltered answer, computed the slow way this test exists to replace.
fn unfiltered(row_set: &Value, miss: &Miss) -> Value {
    let mut slow = RowSetAnswerer::new_unfiltered(row_set).expect("row set");
    slow.answer(miss)
        .expect("answers")
        .expect("nearbyWays is answerable")
        .1
}

#[test]
fn the_prefilter_changes_no_answer() {
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    if !Path::new(golden).is_dir() {
        eprintln!("SKIPPED: no corpus at {golden}");
        return;
    }
    backend::lean::init().expect("the Lean runtime must start");

    let mut names: Vec<String> = std::fs::read_dir(golden)
        .expect("golden dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names.truncate(3); // three days is plenty; each carries thousands of rows

    let mut compared = 0usize;
    for name in &names {
        let Ok(raw) = std::fs::read_to_string(format!("{golden}/{name}")) else {
            continue;
        };
        let fx: Value = serde_json::from_str(&raw).expect("fixture parses");
        let Some(rs) = fx["inputs"].get("osmRowSet") else {
            continue;
        };

        // Real query points: the coordinates the day's own track visited, taken
        // from the recorded trace's keys so they are places something actually
        // asked about rather than points I chose.
        let keys: Vec<String> = fx["inputs"]["osmTrace"]["nearbyWays"]
            .as_object()
            .map(|o| o.keys().take(4).cloned().collect())
            .unwrap_or_default();

        for k in keys {
            let mut parts = k.split('|');
            let (Some(la), Some(lo)) = (parts.next(), parts.next()) else {
                continue;
            };
            let (Ok(la), Ok(lo)) = (la.parse::<f64>(), lo.parse::<f64>()) else {
                continue;
            };
            let miss = Miss {
                what: "nearbyWays".to_string(),
                key: format!("{}|{}", la.to_bits(), lo.to_bits()),
            };

            let mut fast = RowSetAnswerer::new(rs).expect("row set");
            let got = fast
                .answer(&miss)
                .expect("answers")
                .expect("nearbyWays is answerable")
                .1;
            assert_eq!(
                got,
                unfiltered(rs, &miss),
                "{name}: the prefilter changed the answer at {k}"
            );
            compared += 1;
        }
    }

    assert!(
        compared >= 6,
        "only {compared} comparison(s) — too few to say the filter is harmless"
    );
    eprintln!("{compared} query point(s): filtered and unfiltered agree");
}
