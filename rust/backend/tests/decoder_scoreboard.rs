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
/// The ten counts for one day's segments against its narrative.
fn score(date: &str, tz: &str, segs: Vec<Value>) -> Value {
    let rows = ground_truth_rows(date, tz);
    let req = json!({ "mode": "decoderscore", "rows": rows, "segs": segs });
    let reply = backend::lean::serve(&req.to_string())
        .unwrap_or_else(|e| panic!("{date}: decoderscore must answer: {e:#}"));
    let got: Value = serde_json::from_str(&reply).expect("the score reply parses");
    assert!(
        got.get("error").is_none(),
        "{date}: decoderscore refused: {got}"
    );
    got
}

/// The scoreboard's view of a segment list, frozen or live.
fn scoreboard_segs(segs: &[Value]) -> Vec<Value> {
    segs.iter()
        .map(|s| {
            json!({
                "startTs": s["startTs"], "endTs": s["endTs"], "mode": s["mode"],
                "lineName": s["lineName"],
                "board": s.get("boardStation").cloned().unwrap_or(Value::Null),
                "alight": s.get("alightStation").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// `SCOREBOARD_LIVE=1`: the same ten counts for TODAY'S Lean decode of each
/// blessed day, printed beside the blessed ones with totals. Report-only — the
/// referee for an emissions change (#366): a decoder arm that shifts segments
/// fails `hsmm_decode_corpus` by design, and this says whether the shift is
/// an improvement against the narratives before anything is re-blessed.
#[test]
fn the_live_decode_scores_against_the_narratives() {
    if std::env::var("SCOREBOARD_LIVE").is_err() {
        eprintln!("SCOREBOARD_LIVE unset — the live arm is opt-in.");
        return;
    }
    if !Path::new(DECODED).is_dir() || !Path::new(NARRATIVES).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {DECODED}; see this file's header.");
        return;
    }
    std::thread::Builder::new()
        .name("scoreboard-live".into())
        .stack_size(256 * 1024 * 1024)
        .spawn(live_arm)
        .expect("spawn")
        .join()
        .expect("the live arm must not panic");
}

fn live_arm() {
    let blessed: BTreeMap<String, Value> = serde_json::from_str(
        &std::fs::read_to_string(BASELINE).expect("the blessed scoreboard is tracked"),
    )
    .expect("the blessed scoreboard parses");
    let mut tot_live: BTreeMap<&str, i64> = BTreeMap::new();
    let mut tot_blessed: BTreeMap<&str, i64> = BTreeMap::new();
    eprintln!(
        "scoreboard-live: date        journeys  legMode  legLine  stations  phantom   (live | blessed)"
    );
    for (date, want) in &blessed {
        let name = format!("{date}-pippijn.json");
        let fx = backend::decode_fixture::read(&name).expect("fixture parses");
        let tz = fx["meta"]["tz"].as_str().unwrap_or("Europe/London");
        let req = backend::decode_fixture::request(&fx).unwrap_or_else(|e| panic!("{name}: {e:#}"));
        let Some(segments) = backend::lean::assemble_segments(&req).expect("assemble answers")
        else {
            eprintln!("scoreboard-live: {date}  DEGENERATE decode");
            continue;
        };
        let rendered = backend::row_json::render_segments(&segments).expect("segments render");
        let live = score(
            date,
            tz,
            scoreboard_segs(rendered.as_array().map_or(&[][..], Vec::as_slice)),
        );
        let g = |v: &Value, f: &str| v.get(f).and_then(Value::as_i64).unwrap_or(0);
        for f in FIELDS {
            *tot_live.entry(f).or_default() += g(&live, f);
            *tot_blessed.entry(f).or_default() += g(want, f);
        }
        eprintln!(
            "scoreboard-live: {date}  {:>2}/{:<2}|{:>2}/{:<2}  {:>2}/{:<3}|{:>2}/{:<3} {:>2}/{:<2}|{:>2}/{:<2} {:>2}/{:<2}|{:>2}/{:<2}  {:>2}|{:<2}",
            g(&live, "journeysMatched"),
            g(&live, "journeysExpected"),
            g(want, "journeysMatched"),
            g(want, "journeysExpected"),
            g(&live, "legModeMatching"),
            g(&live, "legModeScorable"),
            g(want, "legModeMatching"),
            g(want, "legModeScorable"),
            g(&live, "legLineMatching"),
            g(&live, "legLineScorable"),
            g(want, "legLineMatching"),
            g(want, "legLineScorable"),
            g(&live, "stationsMatching"),
            g(&live, "stationsAsserted"),
            g(want, "stationsMatching"),
            g(want, "stationsAsserted"),
            g(&live, "phantomRides"),
            g(want, "phantomRides"),
        );
    }
    eprintln!(
        "scoreboard-live: TOTAL  journeys {}|{}  legMode {}|{}  legLine {}|{}  stations {}|{}  phantom {}|{}   (live | blessed)",
        tot_live["journeysMatched"],
        tot_blessed["journeysMatched"],
        tot_live["legModeMatching"],
        tot_blessed["legModeMatching"],
        tot_live["legLineMatching"],
        tot_blessed["legLineMatching"],
        tot_live["stationsMatching"],
        tot_blessed["stationsMatching"],
        tot_live["phantomRides"],
        tot_blessed["phantomRides"],
    );
}

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
        let segs = scoreboard_segs(fx["expected"].as_array().expect("expected segments"));

        let got = score(date, tz, segs);

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
