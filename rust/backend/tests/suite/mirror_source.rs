//! Is the mirror's pre-filter box a SUPERSET of what Lean scores? (#982)
//!
//! `MirrorSource` selects candidates with `MBRIntersects` against a box and
//! hands every one of them to Lean, which does the distance, the ordering and
//! the cap. A row the box drops is a row Lean never sees, so the box is only
//! allowed to over-include — and the failure when it does not is silent: the
//! answer stays well-formed and names a nearest feature that is not the nearest.
//!
//! # The argument, and why it is not enough on its own
//!
//! The box half-width is `radiusM / min(111000, 111000·cos lat)` in both axes.
//! Lean's line window is a degree-space disc of radius `radiusM / (111320·cos
//! lat)`, which is smaller because 111320 > 111000; Lean's point window is a
//! metre circle of radius `radiusM`, and the box's half-widths work out to
//! `radiusM · 111195/111000` in latitude and `radiusM · 111195/111000` in
//! longitude, both above `radiusM`.
//!
//! That is a 0.18% margin resting on constants in different files, and the
//! corpus sits inside it: shrinking the box by 1% drops rows, by 0.1% does not.
//! `SUPERSET_MARGIN` exists because of that measurement. So this compares
//! ANSWERS on the corpus's real geometry at the coordinates the days actually
//! asked about, which is the same reason `rowset_prefilter.rs` exists.
//!
//! ⚠ With the margin in place this test no longer fires at a 1% shrink — it
//! takes about 5%. That is the margin working, not the test going blind; the
//! ablation to re-run when changing the box is "scale the half-width down until
//! answers change", and it should take roughly `SUPERSET_MARGIN` to do it.
//!
//! # ⚠ The reference arm is the FILTERED row set, not the unfiltered one
//!
//! `rowset_prefilter.rs` already proves `RowSetSource`'s own prefilter changes
//! no answer, and the unfiltered arm ships 157,489 coordinate pairs per
//! question. Comparing against the filtered arm is the same claim, transitively,
//! at a hundredth of the cost. If that test goes red this one's reference is no
//! longer trustworthy — fix that one first.
//!
//! Local-only: `tests/golden/` is gitignored and holds real places. Announces a
//! skip rather than passing quietly when it is absent.

use std::path::Path;

use backend::fold_converge::Answerer;
use backend::fold_payload::default_radius_m;
use backend::lean::Miss;
use backend::mirror_source::{MirrorSource, parse_linestring_wkt, tags_pairs};
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

/// The tables to re-ask, and the radius each one's key carries. `nearbyWays`
/// spells no radius — the answerer uses the default — so it is named here.
const TABLES: [&str; 3] = ["nearbyWays", "nearbyStations", "linesAtPoint"];

/// `MBRIntersects(geom, box)` for a POINT: the point is inside, inclusively.
fn point_in_box(b: [f64; 4], lat: f64, lon: f64) -> bool {
    lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]
}

/// `MBRIntersects(geom, box)` for a LINESTRING: the way's own minimum bounding
/// rectangle overlaps the box. ⚠ NOT "every vertex is inside" — a way that
/// crosses the box with both endpoints outside it intersects, and filtering on
/// vertices would drop exactly the long road the query point sits on.
fn line_meets_box(b: [f64; 4], coords: &[Value]) -> bool {
    let (mut min_lat, mut max_lat) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut any = false;
    for c in coords.iter().filter_map(Value::as_array) {
        let (Some(la), Some(lo)) = (
            c.first().and_then(Value::as_f64),
            c.get(1).and_then(Value::as_f64),
        ) else {
            // A malformed coordinate is not evidence the way is far away.
            return true;
        };
        any = true;
        min_lat = min_lat.min(la);
        max_lat = max_lat.max(la);
        min_lon = min_lon.min(lo);
        max_lon = max_lon.max(lo);
    }
    if !any {
        return true;
    }
    min_lat <= b[1] && max_lat >= b[0] && min_lon <= b[3] && max_lon >= b[2]
}

/// The row set reduced to what the mirror's `SELECT` would return.
fn inside_the_box(row_set: &Value, b: [f64; 4]) -> Value {
    let points: Vec<Value> = row_set["points"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .filter(|r| {
                    let (Some(la), Some(lo)) = (r["lat"].as_f64(), r["lon"].as_f64()) else {
                        return true;
                    };
                    point_in_box(b, la, lo)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let lines: Vec<Value> = row_set["lines"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .filter(|r| match r["coords"].as_array() {
                    Some(cs) => line_meets_box(b, cs),
                    None => true,
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    json!({ "points": points, "lines": lines })
}

#[test]
fn the_mirrors_candidate_box_holds_everything_lean_scores() {
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
    names.truncate(3);

    let mut compared = 0usize;
    let mut per_table: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();

    for name in &names {
        let Ok(raw) = std::fs::read_to_string(format!("{golden}/{name}")) else {
            continue;
        };
        let fx: Value = serde_json::from_str(&raw).expect("fixture parses");
        let Some(rs) = fx["inputs"].get("osmRowSet") else {
            continue;
        };

        for table in TABLES {
            // Real query points: the coordinates the day's own track visited,
            // read off the recorded trace so they are places something actually
            // asked about rather than points chosen to pass.
            let keys: Vec<String> = fx["inputs"]["osmTrace"][table]
                .as_object()
                .map(|o| o.keys().take(5).cloned().collect())
                .unwrap_or_default();

            for k in keys {
                let p: Vec<&str> = k.split('|').collect();
                let (Some(Ok(la)), Some(Ok(lo))) = (
                    p.first().map(|s| s.parse::<f64>()),
                    p.get(1).map(|s| s.parse::<f64>()),
                ) else {
                    continue;
                };
                // ⚠ The radius comes from the KEY where the key spells one.
                // `nearbyStations` is recorded at 400 m on this corpus and the
                // default is 200 — testing the default would test a box the day
                // never asked for.
                let radius = match p.get(2).and_then(|s| s.parse::<f64>().ok()) {
                    Some(r) => r,
                    None if table == "nearbyWays" => default_radius_m::NEARBY_WAYS,
                    None => continue,
                };
                let key = if table == "nearbyWays" {
                    format!("{}|{}", la.to_bits(), lo.to_bits())
                } else {
                    format!("{}|{}|{}", la.to_bits(), lo.to_bits(), radius.to_bits())
                };
                let miss = Miss {
                    what: table.to_string(),
                    key,
                };

                let reduced = inside_the_box(rs, MirrorSource::candidate_box(la, lo, radius));
                let boxed = RowSetAnswerer::new(&reduced)
                    .expect("reduced row set")
                    .answer(&miss)
                    .expect("answers")
                    .expect("answerable");
                let all = RowSetAnswerer::new(rs)
                    .expect("row set")
                    .answer(&miss)
                    .expect("answers")
                    .expect("answerable");

                // ⚠ The message names the table and the day rather than the
                // coordinate — but the assertion prints both ANSWERS, which
                // carry street names. That is unavoidable when the comparison
                // is the answer, and it is why this test is gated on a corpus
                // that only exists locally: both health repos are public.
                assert_eq!(
                    boxed, all,
                    "{name}: {table} — the candidate box dropped a row Lean scored"
                );
                compared += 1;
                *per_table.entry(table).or_default() += 1;
            }
        }
    }

    // ⚠ Every table must have been reached. A run that compared 30 `nearbyWays`
    // and no points would say nothing about the metre-circle half of the claim,
    // which is the thinner of the two margins.
    for table in TABLES {
        assert!(
            per_table.get(table).copied().unwrap_or(0) > 0,
            "{table} was never compared — the box's {table} window is untested"
        );
    }
    assert!(
        compared >= 12,
        "only {compared} comparison(s) — too few to say the box is a superset"
    );
    eprintln!("{compared} query point(s) across {per_table:?}: the box changes no answer");
}

#[test]
fn a_way_that_crosses_the_box_with_both_ends_outside_is_kept() {
    // The `line_meets_box` guard above, asserted directly: this is the case a
    // vertex-membership filter gets wrong, and it is the common one — a query
    // point on a long road.
    let b = [51.0, 51.1, -0.1, 0.1];
    let crossing = json!([[50.0, 0.0], [52.0, 0.0]]);
    assert!(line_meets_box(b, crossing.as_array().unwrap()));
    let elsewhere = json!([[40.0, 0.0], [41.0, 0.0]]);
    assert!(!line_meets_box(b, elsewhere.as_array().unwrap()));
}

#[test]
fn a_linestring_parses_to_lat_lon_pairs_and_drops_what_it_cannot_read() {
    // WKT writes `lon lat`; every consumer wants `(lat, lon)`.
    assert_eq!(
        parse_linestring_wkt("LINESTRING(4.9 52.37,4.91 52.38)"),
        vec![(52.37, 4.9), (52.38, 4.91)]
    );
    assert_eq!(
        parse_linestring_wkt("LINESTRING (4.9 52.37)"),
        vec![(52.37, 4.9)]
    );
    // A pair that does not parse is dropped, not turned into NaN.
    assert_eq!(
        parse_linestring_wkt("LINESTRING(4.9 52.37,x y,4.91 52.38)"),
        vec![(52.37, 4.9), (52.38, 4.91)]
    );
    // Anything that is not a LINESTRING yields nothing rather than guessing.
    assert!(parse_linestring_wkt("POINT(4.9 52.37)").is_empty());
    assert!(parse_linestring_wkt("").is_empty());
}

#[test]
fn tags_come_back_as_string_pairs_and_a_non_string_value_is_dropped() {
    assert_eq!(tags_pairs(None).unwrap(), json!([]));
    assert_eq!(
        tags_pairs(Some(r#"{"railway":"station","name":"X"}"#)).unwrap(),
        json!([["railway", "station"], ["name", "X"]])
    );
    // ⚠ Dropped, not stringified. Lean reads both halves with `getStr?`, so a
    // numeric tag would fail the whole request — and inventing `"7"` for it
    // would put a tag in the row that OSM did not write.
    assert_eq!(
        tags_pairs(Some(r#"{"a":"b","n":7,"o":{"k":"v"}}"#)).unwrap(),
        json!([["a", "b"]])
    );
    // A JSON scalar where an object was expected is empty, not an error: the
    // column is free-form and a row with no usable tags is a row with no tags.
    assert_eq!(tags_pairs(Some("null")).unwrap(), json!([]));
    assert!(tags_pairs(Some("not json")).is_err());
}
