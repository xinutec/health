//! The day fold's wire encoding — port of `src/lean/fold-payload.ts` (#982).
//!
//! The fold takes one JSON object and the pipeline builds it. Under
//! `LEAN_DAY=solo` — which the decode CronJob runs — this encoding IS the
//! interface between the TypeScript pipeline and the verified core, so a Rust
//! host that gets it wrong asks a different question and gets a confidently
//! wrong day rather than an error.
//!
//! # Floats cross as their BIT PATTERN, and that is the point
//!
//! `bits` renders an `f64` as the decimal of its IEEE-754 payload, so the
//! double the fold reads is the double the pipeline had — not a rendering of
//! it. Anything that formats the number instead (`{}`, `{:.6}`, `to_string` on
//! the value) is a silent precision change on coordinates, where 1e-7° is the
//! quantisation the match gate already adjudicates.
//!
//! # Verified against the TypeScript's own output, not against my reading
//!
//! `tests/fold_payload.rs` compares this to `dist/lean/fold-payload.js`'s
//! encoding of the same captured day, byte for byte. That matters more here
//! than in most ports: the shape is 25 keys of mostly-pass-through data where a
//! wrong field name produces a well-formed request the fold answers anyway.

use serde_json::{Map, Value, json};

/// An `f64` as the decimal of its IEEE-754 bit pattern.
///
/// The inverse of `day-serve.ts`'s `unbits`. ⚠ NaN has many bit patterns and
/// this preserves whichever one it was handed, exactly as the TypeScript's
/// `DataView` round trip does — it is a transport, not a normaliser.
pub fn bits(x: f64) -> String {
    x.to_bits().to_string()
}

/// `bits`, but `null` survives as `null`.
///
/// ⚠ Absent and zero are different facts here. A segment with no `refinedMode`
/// is not a segment refined to nothing, and encoding one as the other is the
/// class of defect the activity-summary port already paid for.
pub fn opt_bits(x: Option<f64>) -> Value {
    match x {
        Some(v) => Value::String(bits(v)),
        None => Value::Null,
    }
}

/// A JSON number field as `bits`, or `null` when absent or null.
fn num_bits(o: &Map<String, Value>, k: &str) -> Value {
    opt_bits(o.get(k).and_then(Value::as_f64))
}

/// A JSON field passed through as a string, or `null` when absent or null.
fn opt_str(o: &Map<String, Value>, k: &str) -> Value {
    match o.get(k) {
        Some(Value::String(s)) => Value::String(s.clone()),
        _ => Value::Null,
    }
}

/// An integer field, passed through unchanged.
///
/// Timestamps and counts are NOT bit-encoded: they are integers on both sides
/// and JSON carries them exactly.
fn int(o: &Map<String, Value>, k: &str) -> Value {
    o.get(k).cloned().unwrap_or(Value::Null)
}

/// A `{lat, lon, ts}` path as the fold's triples of bit patterns, or `null`.
fn path(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        None => Value::Null,
        Some(pts) => Value::Array(
            pts.iter()
                .map(|p| {
                    let o = p.as_object();
                    let g = |k: &str| {
                        o.and_then(|o| o.get(k))
                            .and_then(Value::as_f64)
                            .map(bits)
                            .map_or(Value::Null, Value::String)
                    };
                    json!([g("lat"), g("lon"), g("ts")])
                })
                .collect(),
        ),
    }
}

/// One segment in the shape `Day.parseSeg` reads.
///
/// ⚠ THIRTY FIELDS, and the tail of the list is the easy half to miss — my
/// first attempt stopped at `wayName` because that is where the first screen
/// of the TypeScript ends. A short encoding is not a parse error on the Lean
/// side: absent fields take `Seg`'s defaults, so the fold answers a
/// well-formed question about a segment that has lost its enrichment.
pub fn encode_seg(seg: &Value) -> Value {
    let Some(o) = seg.as_object() else {
        return Value::Null;
    };
    json!({
        "startTs": int(o, "startTs"),
        "endTs": int(o, "endTs"),
        "mode": opt_str(o, "mode"),
        "refinedMode": opt_str(o, "refinedMode"),
        "confidence": num_bits(o, "confidence"),
        "confidenceMargin": num_bits(o, "confidenceMargin"),
        "avgSpeed": num_bits(o, "avgSpeed"),
        "maxSpeed": num_bits(o, "maxSpeed"),
        "linearity": num_bits(o, "linearity"),
        "pointCount": int(o, "pointCount"),
        "place": opt_str(o, "place"),
        "city": opt_str(o, "city"),
        "wayName": opt_str(o, "wayName"),
        "refinedReason": opt_str(o, "refinedReason"),
        // Absent becomes `[]`, not `null`: Lean reads a list and the TypeScript
        // spreads or substitutes an empty array.
        "refinedKinds": o.get("refinedKinds").cloned().unwrap_or_else(|| json!([])),
        "centroidLat": num_bits(o, "centroidLat"),
        "centroidLon": num_bits(o, "centroidLon"),
        // ⚠ `string | number` in TypeScript, `Option Int` in Lean. A
        // non-numeric id would become NaN, so it is DROPPED rather than
        // coerced — the TypeScript's own choice, kept.
        "focusPlaceId": focus_place_id(o.get("focusPlaceId")),
        "needsReenrich": o.get("needsReenrich").and_then(Value::as_bool).unwrap_or(false),
        "needsRename": o.get("needsRename").and_then(Value::as_bool).unwrap_or(false),
        "vehicleKind": opt_str(o, "vehicleKind"),
        "roadCorridorFraction": num_bits(o, "roadCorridorFraction"),
        "displayTz": opt_str(o, "displayTz"),
        "snappedPath": path(o.get("snappedPath")),
        "matchedPath": path(o.get("matchedPath")),
        "walkMatchedPath": path(o.get("walkMatchedPath")),
        "walkSmoothedPath": path(o.get("walkSmoothedPath")),
        "biometrics": encode_biometrics(o.get("biometrics")),
    })
}

/// `string | number | undefined` → `Option Int`. Anything not a number is
/// dropped rather than coerced to NaN.
fn focus_place_id(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        Some(Value::String(s)) => s
            .parse::<f64>()
            .ok()
            .filter(|f| !f.is_nan())
            .and_then(serde_json::Number::from_f64)
            .map_or(Value::Null, Value::Number),
        _ => Value::Null,
    }
}

/// The per-segment biometric summary, or `null` when the segment carries none.
///
/// ⚠ `sleepFraction` is `bits`, NOT `optBits` — the TypeScript reads it
/// unconditionally, so a segment with biometrics always has one.
fn encode_biometrics(v: Option<&Value>) -> Value {
    let Some(b) = v.and_then(Value::as_object) else {
        return Value::Null;
    };
    json!({
        "hrMean": num_bits(b, "hrMean"),
        "hrMin": num_bits(b, "hrMin"),
        "hrMax": num_bits(b, "hrMax"),
        "hrStd": num_bits(b, "hrStd"),
        "sampleCount": int(b, "sampleCount"),
        "overlapsSleep": b.get("overlapsSleep").cloned().unwrap_or(Value::Null),
        "sleepFraction": num_bits(b, "sleepFraction"),
        "stepsTotal": num_bits(b, "stepsTotal"),
    })
}

/// A `[ts, bits(lat), bits(lon)]` fixture list — the shape both cross-day
/// fixture arrays take.
fn fixes3(v: Option<&Value>) -> Value {
    arr_map(v, |o| {
        json!([int(o, "ts"), num_bits(o, "lat"), num_bits(o, "lon")])
    })
}

/// A `[ts, bits(lat), bits(lon), optBits(accuracy)]` fixture list.
fn fixes4(v: Option<&Value>) -> Value {
    arr_map(v, |o| {
        json!([
            int(o, "ts"),
            num_bits(o, "lat"),
            num_bits(o, "lon"),
            num_bits(o, "accuracy")
        ])
    })
}

/// Map over a JSON array of objects, skipping anything that is not one.
///
/// An absent array becomes `[]`, not `null`: every one of these fields is a
/// list on the Lean side, and the TypeScript spells the same default with
/// `?? []`.
fn arr_map<F: Fn(&Map<String, Value>) -> Value>(v: Option<&Value>, f: F) -> Value {
    Value::Array(
        v.and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_object).map(&f).collect())
            .unwrap_or_default(),
    )
}

/// The observation series and the cross-day tail, as `env` carries them.
///
/// ⚠ `points` and `speedByTs` are the SAME source read twice, and both are
/// sent: the fold wants the track and the speed lookup separately, and
/// deriving one from the other here would be this encoder deciding something.
///
/// ⚠ `sleep` and `rawSleep` are NOT the same list. `sleep` is the projection
/// the biometric windows read; `rawSleep` is the Fitbit windows before place
/// attribution — same rows, different fields, and neither derives the other.
pub fn encode_obs_and_tail(obs: &Value, tail: Option<&Value>) -> Map<String, Value> {
    let o = obs.as_object();
    let g = |k: &str| o.and_then(|o| o.get(k));
    let t = tail.and_then(Value::as_object);
    let tg = |k: &str| t.and_then(|t| t.get(k));

    let mut m = Map::new();
    m.insert(
        "points".into(),
        arr_map(g("points"), |p| {
            json!([
                int(p, "ts"),
                num_bits(p, "lat"),
                num_bits(p, "lon"),
                num_bits(p, "speedKmh")
            ])
        }),
    );
    m.insert("rawFixes".into(), fixes4(g("rawFixes")));
    m.insert("displayFixes".into(), fixes4(g("displayFixes")));
    m.insert(
        "steps".into(),
        arr_map(g("steps"), |s| json!([int(s, "ts"), num_bits(s, "steps")])),
    );
    m.insert(
        "hr".into(),
        arr_map(g("hr"), |h| json!([int(h, "ts"), num_bits(h, "bpm")])),
    );
    m.insert(
        "sleep".into(),
        arr_map(g("sleep"), |s| json!([int(s, "startTs"), int(s, "endTs")])),
    );
    m.insert(
        "speedByTs".into(),
        arr_map(g("points"), |p| {
            json!([int(p, "ts"), num_bits(p, "speedKmh")])
        }),
    );
    m.insert("morningFixes".into(), fixes3(tg("morningRaw")));
    m.insert("prevEveningFixes".into(), fixes3(tg("prevEveningRaw")));
    m.insert(
        "rawSleep".into(),
        arr_map(tg("rawSleep"), |w| {
            json!([
                int(w, "startTs"),
                int(w, "endTs"),
                opt_str(w, "tz"),
                int(w, "minutesAsleep")
            ])
        }),
    );
    m.insert(
        "dayEndTs".into(),
        tg("dayEndTs").cloned().unwrap_or_else(|| json!(0)),
    );
    m
}

/// The mined `mode_biometrics` rows, as the eleven-tuple `env.modeStats` takes.
pub fn encode_mode_stats(v: Option<&Value>) -> Value {
    arr_map(v, |m| {
        json!([
            opt_str(m, "mode"),
            num_bits(m, "hrMean"),
            num_bits(m, "hrStd"),
            int(m, "hrSampleCount"),
            num_bits(m, "cadenceMean"),
            num_bits(m, "cadenceStd"),
            int(m, "cadenceSampleCount"),
            num_bits(m, "speedMean"),
            num_bits(m, "speedStd"),
            int(m, "speedSampleCount"),
            int(m, "sampleCount"),
        ])
    })
}
