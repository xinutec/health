//! The HSMM decode, replayed from the frozen fixtures (#1048's last item).
//!
//! ```text
//!   decoded_days inputs ── the decode_one chain, fixture-fed ── assemblesegments
//!                                                              vs the fixture's `expected`
//! ```
//!
//! This is the half `decoder_scoreboard.rs` deliberately does not do: the
//! LIVE Lean decode of each day's raw materials, gated against the segments
//! the TypeScript decoder was blessed to produce. Together they close #1048's
//! gate list: a decoder change that shifts any day's segments fails HERE, and
//! one that degrades journey structure fails the scoreboard.
//!
//! # The chain is `decode_one`'s, re-sourced
//!
//! Every request field comes from the fixture the way `decode_one` builds it
//! from the DB (main.rs) — same cleaners, same wire shapes, same flags
//! semantics (`decodeFlags` recorded per fixture; all eleven are v2). The
//! boxes are NOT re-applied: the captured row sets already carry exactly what
//! fed the blessed decode.
//!
//! ⚠ Announces a skip when the corpus is absent rather than passing quietly.

use std::path::Path;

use serde_json::{Value, json};

const DECODED: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/decoded_days"
);

/// `LINESTRING(lon lat, …)` → `[[latBits, lonBits], …]` — main.rs's parser,
/// which is private to the binary.
fn linestring_bits(wkt: &str) -> Vec<Value> {
    let Some(inner) = wkt
        .trim()
        .strip_prefix("LINESTRING(")
        .and_then(|s| s.strip_suffix(')'))
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .filter_map(|pair| {
            let mut it = pair.split_whitespace();
            let lon: f64 = it.next()?.parse().ok()?;
            let lat: f64 = it.next()?.parse().ok()?;
            Some(json!([
                backend::fold_payload::bits(lat),
                backend::fold_payload::bits(lon)
            ]))
        })
        .collect()
}

fn tag_pairs(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_object).map_or_else(Vec::new, |m| {
        m.iter()
            .filter_map(|(k, val)| val.as_str().map(|s| json!([k, s])))
            .collect()
    })
}

#[test]
fn every_frozen_decode_still_decodes() {
    // ⚠ The trellis decode of a full 1440-minute day overflows the 2 MiB
    // default test-thread stack; production decodes on the binary's main
    // thread. Same work, roomier stack.
    std::thread::Builder::new()
        .name("hsmm-decode-corpus".into())
        .stack_size(256 * 1024 * 1024)
        .spawn(run_corpus)
        .expect("spawn")
        .join()
        .expect("the corpus thread must not panic");
}

fn run_corpus() {
    if !Path::new(DECODED).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {DECODED}; see this file's header.");
        return;
    }
    let mut names: Vec<String> = std::fs::read_dir(DECODED)
        .expect("decoded dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "the decoded corpus is empty");

    let mut failures: Vec<String> = Vec::new();
    for name in &names {
        let fx: Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{DECODED}/{name}")).expect("fixture readable"),
        )
        .expect("fixture parses");
        let (meta, inputs) = (&fx["meta"], &fx["inputs"]);
        let (date, tz) = (
            meta["date"].as_str().expect("date"),
            meta["tz"].as_str().expect("tz"),
        );
        let bounds = backend::timezone::date_bounds_utc(date, Some(tz)).expect("bounds");

        // The day's fixes, cleaned ONCE like the serving path.
        let fixes: Vec<backend::lean::GpsFix> = inputs["points"]
            .as_array()
            .expect("points")
            .iter()
            .map(|p| backend::lean::GpsFix {
                ts: p["ts"].as_i64().expect("ts"),
                lat: p["lat"].as_f64().expect("lat"),
                lon: p["lon"].as_f64().expect("lon"),
                speed_kmh: p["speed_kmh"].as_f64().expect("speed_kmh"),
            })
            .collect();
        let cleaned = backend::lean::drop_gps_outliers(&fixes).expect("outlier drop");

        // The route graph, from the captured raw rows.
        let ways: Vec<Value> = inputs["rawOsmLines"]
            .as_array()
            .expect("rawOsmLines")
            .iter()
            .filter_map(|l| {
                let geom = linestring_bits(l["geom"].as_str()?);
                if geom.len() < 2 {
                    return None;
                }
                Some(json!({
                    "id": format!("{}:{}", l["osm_type"].as_str()?, l["osm_id"].as_str()?),
                    "geometry": geom,
                    "name": l.get("name").cloned().unwrap_or(Value::Null),
                    "subtype": l.get("subtype").cloned().unwrap_or(Value::Null),
                    "tags": tag_pairs(l.get("tags_json")),
                }))
            })
            .collect();
        let stops: Vec<Value> = inputs["rawOsmPoints"]
            .as_array()
            .expect("rawOsmPoints")
            .iter()
            .filter_map(|p| {
                Some(json!({
                    "latBits": backend::fold_payload::bits(p["lat"].as_f64()?),
                    "lonBits": backend::fold_payload::bits(p["lon"].as_f64()?),
                    "name": p.get("name").cloned().unwrap_or(Value::Null),
                    "tags": tag_pairs(p.get("tags_json")),
                }))
            })
            .collect();
        let (edges, nodes) = backend::lean::build_wire_graph(&ways, &stops).expect("wire graph");

        // Sparse proximity: fixture `[ts, {railDistM, roadDistM}]` →
        // wire `[ts, road, rail]` — the ORDER the parser documents.
        let proximity: Vec<Value> = inputs["proximityByMinute"]
            .as_array()
            .expect("proximityByMinute")
            .iter()
            .map(|e| {
                let (ts, d) = (&e[0], &e[1]);
                json!([ts, d["roadDistM"], d["railDistM"]])
            })
            .collect();

        // Continuity: object coord + long field name → array coord + wire name.
        let continuity = match &inputs["continuityContext"] {
            Value::Null => Value::Null,
            c => {
                let coord = match c.get("priorPlaceCoord") {
                    Some(Value::Object(o)) => {
                        let f = |k: &str| -> f64 {
                            o.get(k)
                                .and_then(|v| {
                                    v.as_f64()
                                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                                })
                                .expect("coord component")
                        };
                        json!([f("lat"), f("lon")])
                    }
                    _ => Value::Null,
                };
                json!({
                    "priorPlaceId": c["priorPlaceId"],
                    "priorPlaceCoord": coord,
                    "hoursSince": c["hoursSinceLastConfirmedFix"],
                    "priorPosterior": c["priorPosterior"],
                })
            }
        };

        let flags = &inputs["decodeFlags"];
        assert!(
            flags.is_object(),
            "{name}: a v1 fixture with no recorded decodeFlags — decide its flags before gating it"
        );

        let req = json!({
            "observation": {
                "startUtc": bounds.start_utc,
                "points": cleaned.iter().map(|p| json!({
                    "ts": p.ts, "lat": p.lat, "lon": p.lon, "speedKmh": p.speed_kmh
                })).collect::<Vec<_>>(),
                "hr": inputs["hr"],
                "steps": inputs["steps"],
                "sleep": inputs["sleep"],
                "localCtx": backend::timezone::local_ctx_table(bounds.start_utc, tz).expect("localCtx"),
                "proximity": proximity,
                "imputeCadence": flags["imputeCadence"],
            },
            "edges": edges,
            "nodes": nodes,
            // Captured rows name the COLUMNS; the wire names the CONCEPTS —
            // the same mapping decode_places does for the serving path.
            "places": inputs["places"].as_array().expect("places").iter().map(|p| json!({
                "id": p["id"], "name": p["displayName"], "lat": p["lat"], "lon": p["lon"],
                "hourProfile": p.get("hourProfile").cloned().unwrap_or(Value::Null),
                "dwell": p["totalDwellSec"],
            })).collect::<Vec<_>>(),
            "placeNearLine": inputs["placeNearLine"],
            "railStopRelations": inputs.get("railStopRelations").cloned().unwrap_or(Value::Null),
            "continuity": continuity,
            "flags": {
                "reacquireRobust": flags["reacquireRobustSpeed"],
                "segEvidence": flags["segmentEvidence"],
                "chainContext": flags["chainContext"],
            },
            "date": date,
            "tz": tz,
        });

        let Some(segments) = backend::lean::assemble_segments(&req).expect("assemble answers")
        else {
            failures.push(format!("{name}: the decode is DEGENERATE — no viable path"));
            continue;
        };
        let got = backend::row_json::render_segments(&segments).expect("segments render");
        let got = got.as_array().cloned().unwrap_or_default();
        let want = fx["expected"].as_array().expect("expected").clone();

        if got.len() != want.len() {
            failures.push(format!(
                "{name}: {} segments vs {} expected",
                got.len(),
                want.len()
            ));
            continue;
        }
        for (i, (g, w)) in got.iter().zip(want.iter()).enumerate() {
            // Compare the fields the fixture stores; the render may carry more.
            for f in [
                "startTs",
                "endTs",
                "mode",
                "placeId",
                "lineName",
                "boardStation",
                "alightStation",
            ] {
                let (gv, wv) = (g.get(f), w.get(f));
                // An absent render field vs an explicit null in the fixture is
                // the same claim.
                let norm = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
                if norm(gv) != norm(wv) {
                    failures.push(format!(
                        "{name}: segment {i} differs on {f}: lean {} vs blessed {}",
                        norm(gv),
                        norm(wv)
                    ));
                }
            }
        }
    }

    eprintln!(
        "{} decoded day(s) replayed, {} failure(s)",
        names.len(),
        failures.len()
    );
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
