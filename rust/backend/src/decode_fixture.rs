//! The frozen decode corpus, read back into the request `assemblesegments`
//! takes.
//!
//! ```text
//!   tests/golden/decoded_days/<date>-<user>.json ── request ──┬── hsmm_decode_corpus (exact)
//!                                                             └── decode-bench (timed)
//! ```
//!
//! ⚠ ONE BUILDER FOR BOTH READERS. The gate replays each day and compares its
//! segments with the blessed decode; the bench times the decoder on the same
//! request. A second copy of this builder in the bench would time a request
//! nothing proves is the gated one.
//!
//! Every field comes from the fixture the way `decode_one` builds it from the
//! DB (main.rs) — same cleaners, same wire shapes, same flags semantics
//! (`decodeFlags` recorded per fixture). The boxes are NOT re-applied: the
//! captured row sets already carry exactly what fed the blessed decode.
//!
//! ⚠ The corpus is gitignored and holds REAL LOCATION DATA. Nothing here
//! prints a coordinate, and nothing that reads it should.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::{Value, json};

/// Where the corpus lives, relative to this crate.
pub fn corpus_dir() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden/decoded_days"
    ))
}

/// The fixture file names, sorted; `None` when the corpus is not checked out.
pub fn fixture_names() -> Result<Option<Vec<String>>> {
    let dir = corpus_dir();
    if !dir.is_dir() {
        return Ok(None);
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    Ok(Some(names))
}

/// One fixture, parsed.
pub fn read(name: &str) -> Result<Value> {
    let path = corpus_dir().join(name);
    let raw =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("{name} is not JSON"))
}

/// `tags_json` as stored → `[[k, v], …]`, the pair shape the wire reads.
fn tag_pairs(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_object).map_or_else(Vec::new, |m| {
        m.iter()
            .filter_map(|(k, val)| val.as_str().map(|s| json!([k, s])))
            .collect()
    })
}

/// The `assemblesegments` request the fixture's day was decoded from.
pub fn request(fx: &Value) -> Result<Value> {
    let (meta, inputs) = (&fx["meta"], &fx["inputs"]);
    let date = meta["date"].as_str().context("meta.date")?;
    let tz = meta["tz"].as_str().context("meta.tz")?;
    let bounds = crate::timezone::date_bounds_utc(date, Some(tz))?;

    // The day's fixes, cleaned ONCE like the serving path.
    let fixes: Vec<crate::lean::GpsFix> = inputs["points"]
        .as_array()
        .context("inputs.points")?
        .iter()
        .map(|p| {
            Ok(crate::lean::GpsFix {
                ts: p["ts"].as_i64().context("point ts")?,
                lat: p["lat"].as_f64().context("point lat")?,
                lon: p["lon"].as_f64().context("point lon")?,
                speed_kmh: p["speed_kmh"].as_f64().context("point speed_kmh")?,
            })
        })
        .collect::<Result<_>>()?;
    let cleaned = crate::lean::drop_gps_outliers(&fixes)?;

    // The route graph, from the captured raw rows.
    let ways: Vec<Value> = inputs["rawOsmLines"]
        .as_array()
        .context("inputs.rawOsmLines")?
        .iter()
        .filter_map(|l| {
            let geom: Vec<Value> = crate::mirror_source::parse_linestring_wkt(l["geom"].as_str()?)
                .into_iter()
                .map(|(lat, lon)| {
                    json!([
                        crate::fold_payload::bits(lat),
                        crate::fold_payload::bits(lon)
                    ])
                })
                .collect();
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
        .context("inputs.rawOsmPoints")?
        .iter()
        .filter_map(|p| {
            Some(json!({
                "latBits": crate::fold_payload::bits(p["lat"].as_f64()?),
                "lonBits": crate::fold_payload::bits(p["lon"].as_f64()?),
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "tags": tag_pairs(p.get("tags_json")),
            }))
        })
        .collect();
    let (edges, nodes) = crate::lean::build_wire_graph(&ways, &stops)?;

    // Sparse proximity: fixture `[ts, {railDistM, roadDistM}]` →
    // wire `[ts, road, rail]` — the ORDER the parser documents.
    let proximity: Vec<Value> = inputs["proximityByMinute"]
        .as_array()
        .context("inputs.proximityByMinute")?
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
                    let f = |k: &str| -> Result<f64> {
                        o.get(k)
                            .and_then(|v| {
                                v.as_f64()
                                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                            })
                            .with_context(|| format!("priorPlaceCoord.{k}"))
                    };
                    json!([f("lat")?, f("lon")?])
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
    anyhow::ensure!(
        flags.is_object(),
        "a v1 fixture with no recorded decodeFlags — decide its flags before gating it"
    );

    let places = inputs["places"]
        .as_array()
        .context("inputs.places")?
        .iter()
        // Captured rows name the COLUMNS; the wire names the CONCEPTS —
        // the same mapping decode_places does for the serving path.
        .map(|p| {
            json!({
                "id": p["id"], "name": p["displayName"], "lat": p["lat"], "lon": p["lon"],
                "hourProfile": p.get("hourProfile").cloned().unwrap_or(Value::Null),
                "dwell": p["totalDwellSec"],
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "observation": {
            "startUtc": bounds.start_utc,
            "points": cleaned.iter().map(|p| json!({
                "ts": p.ts, "lat": p.lat, "lon": p.lon, "speedKmh": p.speed_kmh
            })).collect::<Vec<_>>(),
            "hr": inputs["hr"],
            "steps": inputs["steps"],
            "sleep": inputs["sleep"],
            "localCtx": crate::timezone::local_ctx_table(bounds.start_utc, tz)?,
            "proximity": proximity,
            "imputeCadence": flags["imputeCadence"],
        },
        "edges": edges,
        "nodes": nodes,
        "places": places,
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
    }))
}
