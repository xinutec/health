//! Every coordinate the capture names must also carry its zone (#1054).
//!
//! # The bug this exists for
//!
//! `stays.ts` resolves a consolidated stay's centre, computes
//! `tzLookup(cLat, cLon)` there, and passes the zone INSIDE the `bestPlace`
//! query record. It never reaches `recordTz`, which only `velocity.ts` calls.
//! The Lean fold asks `Env.tzAt` at that same centre as a SEPARATE lookup, found
//! nothing in the recorded table, and aborted the whole day — 2026-08-09 sat red
//! in the day gate on it.
//!
//! ⚠ It looked like an algorithmic divergence for four rounds of investigation.
//! It was not: both arms compute the same centre, and the fold's coordinate
//! equals the TS `bestPlace` key EXACTLY. Only the recording was incomplete. The
//! cheap check that would have said so immediately is this one — does every
//! question the capture records have every answer the fold will ask for?
//!
//! Local-only, and announces a skip: the corpus is gitignored.

use std::path::Path;

use serde_json::Value;

fn bits(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(Value::as_f64).map(f64::to_bits)
}

#[test]
fn every_best_place_question_has_a_zone_recorded_at_the_same_point() {
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

    let (mut checked, mut asked) = (0usize, 0usize);
    let mut missing: Vec<String> = Vec::new();

    for name in &names {
        let Ok(raw) = std::fs::read_to_string(format!("{golden}/{name}")) else {
            continue;
        };
        let fx: Value = serde_json::from_str(&raw).expect("fixture parses");
        let Some(cap) = fx["expected"].get("tsArm").and_then(|a| a.get("capture")) else {
            continue;
        };
        checked += 1;
        let empty = Vec::new();
        let bp = cap
            .get("bestPlace")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let tz = cap.get("tzAt").and_then(Value::as_array).unwrap_or(&empty);

        for q in bp {
            asked += 1;
            let (Some(qlat), Some(qlon)) = (bits(q, "lat"), bits(q, "lon")) else {
                continue;
            };
            // ⚠ BIT equality, not proximity. The fold's table is keyed on the
            // IEEE pattern, so a zone recorded a hair away is not an answer —
            // it is the same miss with a friendlier appearance.
            let found = tz
                .iter()
                .any(|e| bits(e, "lat") == Some(qlat) && bits(e, "lon") == Some(qlon));
            if !found {
                missing.push(format!("{name}: bestPlace point has no tzAt entry"));
            }
        }
    }

    if checked == 0 {
        eprintln!("SKIPPED: no fixture carries a frozen TS arm — run `day-gate --freeze`");
        return;
    }
    eprintln!("{checked} fixture(s), {asked} bestPlace question(s) checked");
    assert!(
        missing.is_empty(),
        "the capture names a point it records no zone for — the fold asks tzAt \
         there and aborts the day:\n  {}",
        missing.join("\n  ")
    );
}
