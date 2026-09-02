//! The decoder scoreboard, replayed against the blessed counts (#1048).
//!
//! ```text
//!   decoded_days fixture (frozen decode) ─┐
//!   ground-truth narrative ── groundtruth ┴─ decoderscore → ten counts
//!                                            vs tests/golden/decoder-scoreboard.json
//! ```
//!
//! # What this does and does not prove
//!
//! The `expected` block of each `decoded_days` fixture is the TypeScript
//! decoder's FROZEN output — this harness does not decode. Agreement therefore
//! proves the SCORING pipeline (`statesToMinutes`-family, `decoderJourneys`,
//! `scoreStations`, `countPhantomRides`, the journey counters) reproduces the
//! blessed counts from the same decoded segments; it says nothing about the
//! decoder itself. The decode half needs the pre/post-boundary shell chain and
//! is the other item on #1048.
//!
//! ⚠ The corpora are gitignored; this announces a skip rather than passing
//! quietly when they are absent.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};

const DECODED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/decoded_days"
);
const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);
const BASELINE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/decoder-scoreboard.json"
);

const FIELDS: [&str; 10] = [
    "journeysExpected",
    "journeysMatched",
    "legModeScorable",
    "legModeMatching",
    "legLineScorable",
    "legLineMatching",
    "stationsAsserted",
    "stationsMatching",
    "stationsMissing",
    "phantomRides",
];

/// The narrative's rows for a day, times resolved to unix seconds, provenance
/// kept — the decoderscore mode's phantom count needs it.
fn ground_truth_rows(date: &str, tz: &str) -> Vec<Value> {
    let md = std::fs::read_to_string(format!("{NARRATIVES}/{date}.md"))
        .unwrap_or_else(|e| panic!("{date}: narrative unreadable: {e}"));
    let req = json!({ "mode": "groundtruth", "markdown": md, "date": date, "tz": tz });
    let reply = backend::lean::serve(&req.to_string())
        .unwrap_or_else(|e| panic!("{date}: the narrative parser must answer: {e:#}"));
    let r: Value = serde_json::from_str(&reply).expect("the parser reply parses");
    assert!(r.get("error").is_none(), "{date}: parser refused: {r}");
    let zone = r["tz"].as_str().unwrap_or(tz).to_string();

    let mut rows = Vec::new();
    for row in r["rows"].as_array().map_or(&[][..], Vec::as_slice) {
        let stamp = |d: &Value, h: &Value, m: &Value| -> Option<i64> {
            backend::timezone::wall_clock_to_unix(
                &format!("{} {:02}:{:02}:00", d.as_str()?, h.as_u64()?, m.as_u64()?),
                &zone,
            )
        };
        let (Some(a), Some(b)) = (
            stamp(&row["startDay"], &row["startHh"], &row["startMm"]),
            stamp(&row["endDay"], &row["endHh"], &row["endMm"]),
        ) else {
            panic!("{date}: a row's civil time did not resolve in {zone}");
        };
        rows.push(json!({
            "startTs": a, "endTs": b, "status": row["status"],
            "provenance": row["provenance"], "truth": row["truth"],
        }));
    }
    rows
}

#[test]
fn the_blessed_scoreboard_reproduces_from_the_frozen_decodes() {
    if !Path::new(DECODED).is_dir() || !Path::new(NARRATIVES).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {DECODED}; see this file's header.");
        return;
    }
    let blessed: BTreeMap<String, Value> = serde_json::from_str(
        &std::fs::read_to_string(BASELINE).expect("the blessed scoreboard is tracked"),
    )
    .expect("the blessed scoreboard parses");
    assert!(!blessed.is_empty(), "the blessed scoreboard is empty");

    let mut failures: Vec<String> = Vec::new();
    let mut scored = 0usize;
    for (date, want) in &blessed {
        let path = format!("{DECODED}/{date}-pippijn.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            failures.push(format!("{date}: blessed but no decoded fixture at {path}"));
            continue;
        };
        let fx: Value = serde_json::from_str(&text).expect("a decoded fixture parses");
        let tz = fx["meta"]["tz"].as_str().unwrap_or("Europe/London");
        let segs: Vec<Value> = fx["expected"]
            .as_array()
            .expect("expected segments")
            .iter()
            .map(|s| {
                json!({
                    "startTs": s["startTs"], "endTs": s["endTs"], "mode": s["mode"],
                    "lineName": s["lineName"],
                    "board": s.get("boardStation").cloned().unwrap_or(Value::Null),
                    "alight": s.get("alightStation").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();

        let rows = ground_truth_rows(date, tz);
        let req = json!({ "mode": "decoderscore", "rows": rows, "segs": segs });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{date}: decoderscore must answer: {e:#}"));
        let got: Value = serde_json::from_str(&reply).expect("the score reply parses");
        assert!(
            got.get("error").is_none(),
            "{date}: decoderscore refused: {got}"
        );

        for f in FIELDS {
            // ⚠ Both sides must CARRY the field — a typo'd name would compare
            // None == None and read as agreement.
            assert!(
                want.get(f).is_some() && got.get(f).is_some(),
                "{date}: {f} absent on a side — the comparison would be vacuous"
            );
            if got.get(f) != want.get(f) {
                failures.push(format!(
                    "{date}: {f}: lean {} vs blessed {}",
                    got.get(f).unwrap_or(&Value::Null),
                    want.get(f).unwrap_or(&Value::Null)
                ));
            }
        }
        scored += 1;
    }

    eprintln!(
        "{scored}/{} blessed days rescored, {} field mismatch(es)",
        blessed.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert_eq!(
        scored,
        blessed.len(),
        "some blessed day was skipped, which is not a pass"
    );
}
