//! The pipeline head: raw PhoneTrack fixes → `segsRaw`, without Node.
//!
//! `segsRaw` is the day fold's ONLY input, and every stage that produces it —
//! GPS quality control, place-snap, the Kalman smoother, segmentation — has a
//! `#guard`-pinned Lean twin reachable through `lean::serve`. What was missing
//! was the sequencing: which fixes each stage is handed, in what order, and
//! with which filter between them. That lived in `src/geo/velocity.ts` and is
//! what this module ports (#982).
//!
//! ```text
//!   inputs.phonetrack.today
//!     → in-day window                       (bounds from the display tz)
//!     → gpsquality   (Lean)                 drop incoherent runs
//!     → snap         (Lean, batched)        pull fixes onto known centroids
//!     → accuracy ≤ 200 m
//!     → kalman       (Lean)                 smooth; emits speed + bearing
//!     → segments     (Lean)                 classify → segsRaw
//! ```
//!
//! ## The parity target is free
//!
//! Each golden fixture carries the frozen TypeScript head as
//! `expected.tsArm.capture.segsRaw`, computed from the same `inputs` this
//! module reads. So the whole chain checks against 42 real days with no DB and
//! no Node — see `tests/head_corpus.rs`.
//!
//! ⚠ COMPARE THE SERIALISED TEXT. `jq` parses both sides to doubles, so
//! `25.0 == 25` and a keyed diff calls a rendering difference clean. Every
//! float leaving this module goes through [`js_num`].

use anyhow::{Context, Result, anyhow};
use serde_json::{Map, Value, json};

use crate::classification_inputs::js_num;
use crate::lean;

/// A raw PhoneTrack fix, as the head passes it between stages.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fix {
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
    pub accuracy: Option<f64>,
}

/// A smoothed point: the Kalman filter's output, and the segmenter's input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Smoothed {
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
    pub speed_kmh: f64,
    pub bearing: f64,
}

/// The accuracy ceiling for a fix to reach the Kalman filter at all.
///
/// Deliberately loose. The filter weights each measurement by its accuracy²
/// variance, so a noisy fix already contributes little; pre-filtering harder
/// throws away anchors that matter most on fast linear travel, where even a
/// 150 m fix pins a smooth path. See the note in `velocity.ts`.
const ACCURACY_CEILING_M: f64 = 200.0;

/// A `f64` on the Lean wire: its IEEE-754 bit pattern as a decimal string.
///
/// JSON cannot carry a Float unrounded — Lean's printer emits six decimals and
/// JS `JSON.parse` re-rounds past 2^53 — and the Kalman recursion moves on the
/// seventh decimal of a fix. The TS twin is `src/lean/float-bits.ts`.
fn bits(v: f64) -> Value {
    Value::String(v.to_bits().to_string())
}

/// Inverse of [`bits`]. A non-numeric string is a malformed reply, not a zero.
fn unbits(v: &Value) -> Result<f64> {
    let s = v
        .as_str()
        .ok_or_else(|| anyhow!("expected a float bit pattern as a string, got {v}"))?;
    let u: u64 = s
        .parse()
        .with_context(|| format!("{s:?} is not a float bit pattern"))?;
    Ok(f64::from_bits(u))
}

fn opt_bits(v: Option<f64>) -> Value {
    match v {
        None => Value::Null,
        Some(x) => bits(x),
    }
}

fn unbits_opt(v: &Value) -> Result<Option<f64>> {
    if v.is_null() {
        return Ok(None);
    }
    unbits(v).map(Some)
}

/// One `lean::serve` call, with the mode injected and an `error` reply refused.
///
/// The Lean side reports a malformed request as `{"error": …}` with a zero exit
/// status, so a caller that only checked for transport failure would read the
/// error object as an empty result — an empty day, silently.
fn ask(mode: &str, mut request: Map<String, Value>) -> Result<Map<String, Value>> {
    request.insert("mode".into(), Value::String(mode.into()));
    let body = Value::Object(request).to_string();
    let reply = lean::serve(&body).with_context(|| format!("lean serve {mode}"))?;
    let parsed: Value = serde_json::from_str(&reply)
        .with_context(|| format!("lean serve {mode} returned non-JSON: {reply:.200}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| anyhow!("lean serve {mode} returned {parsed:.200}, not an object"))?;
    if let Some(e) = obj.get("error") {
        anyhow::bail!("lean serve {mode}: {e}");
    }
    Ok(obj.clone())
}

fn fix_rows(pts: &[Fix]) -> Value {
    Value::Array(
        pts.iter()
            .map(|p| json!([p.ts, bits(p.lat), bits(p.lon), opt_bits(p.accuracy)]))
            .collect(),
    )
}

fn parse_fix_rows(v: &Value) -> Result<Vec<Fix>> {
    let rows = v.as_array().context("expected an array of fixes")?;
    rows.iter()
        .map(|r| {
            let a = r.as_array().context("a fix row is not an array")?;
            Ok(Fix {
                ts: a
                    .first()
                    .and_then(Value::as_i64)
                    .context("a fix row has no ts")?,
                lat: unbits(a.get(1).context("a fix row has no lat")?)?,
                lon: unbits(a.get(2).context("a fix row has no lon")?)?,
                accuracy: unbits_opt(a.get(3).unwrap_or(&Value::Null))?,
            })
        })
        .collect()
}

/// `Verified.Geo.GpsQuality.qualityFilterGps` — drop physically-incoherent runs
/// (underground cell-tower garbage) before anything reasons from them.
///
/// Drop-only: every returned fix is a copy of an input fix.
pub fn quality_filter(pts: &[Fix]) -> Result<Vec<Fix>> {
    let mut req = Map::new();
    req.insert("pts".into(), fix_rows(pts));
    let out = ask("gpsquality", req)?;
    parse_fix_rows(out.get("pts").context("gpsquality reply has no pts")?)
}

/// `Verified.Geo.PlacePrior.snapToPlace` over the whole day in ONE call.
///
/// ⚠ BATCHED ON PURPOSE. The TypeScript calls `snapToPlace` per fix inside a
/// `.map`; a bridge round trip per fix would be thousands of calls for one day
/// where every other tenant makes one. The reply is positional — one row per
/// input fix, same order — so it zips straight back on.
///
/// With no known places the TS `.map` never runs, so the fixes pass through
/// untouched; this mirrors that rather than asking Lean to snap against an
/// empty table.
pub fn snap_all(pts: &[Fix], places: &[Value]) -> Result<Vec<Fix>> {
    if places.is_empty() {
        return Ok(pts.to_vec());
    }
    let mut req = Map::new();
    req.insert("op".into(), Value::String("snap".into()));
    req.insert(
        "fixes".into(),
        Value::Array(
            pts.iter()
                .map(|p| json!([bits(p.lat), bits(p.lon), opt_bits(p.accuracy)]))
                .collect(),
        ),
    );
    req.insert(
        "places".into(),
        Value::Array(
            places
                .iter()
                .map(|p| {
                    let num = |k: &str| p.get(k).and_then(Value::as_f64);
                    json!([
                        opt_bits(num("centroidLat")),
                        opt_bits(num("centroidLon")),
                        opt_bits(num("radiusM")),
                        // `KnownPlace.id` is a string on the Lean side; the
                        // loader's is the numeric `focus_places` row id. It
                        // reaches no decision here — `snapToPlace` returns
                        // coordinates — so it crosses as its own text.
                        match p.get("id") {
                            None | Some(Value::Null) => Value::Null,
                            Some(Value::String(s)) => Value::String(s.clone()),
                            Some(other) => Value::String(other.to_string()),
                        },
                    ])
                })
                .collect(),
        ),
    );
    let out = ask("head", req)?;
    let rows = out
        .get("snapped")
        .and_then(Value::as_array)
        .context("snap reply has no snapped array")?;
    if rows.len() != pts.len() {
        anyhow::bail!(
            "snap returned {} rows for {} fixes; the reply is positional",
            rows.len(),
            pts.len()
        );
    }
    pts.iter()
        .zip(rows)
        .map(|(p, r)| {
            let a = r.as_array().context("a snap row is not an array")?;
            let moved = a
                .get(3)
                .and_then(Value::as_bool)
                .context("a snap row has no snapped flag")?;
            // ⚠ The FLAG decides, not the geometry. A fix already at a centroid
            // snaps without moving, so inferring it from whether the coordinates
            // changed would silently call that a non-snap.
            if !moved {
                return Ok(*p);
            }
            Ok(Fix {
                ts: p.ts,
                lat: unbits(a.first().context("a snap row has no lat")?)?,
                lon: unbits(a.get(1).context("a snap row has no lon")?)?,
                accuracy: unbits_opt(a.get(2).unwrap_or(&Value::Null))?,
            })
        })
        .collect()
}

/// `Verified.Geo.Kalman.filterGpsTrack` — the raw-GPS smoother.
///
/// DROPS rows (duplicate timestamps, innovation-gated fixes), so the output is
/// a subsequence and a length mismatch is meaningful rather than a bug.
pub fn kalman(pts: &[Fix]) -> Result<Vec<Smoothed>> {
    let mut req = Map::new();
    req.insert("pts".into(), fix_rows(pts));
    let out = ask("kalman", req)?;
    let rows = out
        .get("pts")
        .and_then(Value::as_array)
        .context("kalman reply has no pts")?;
    rows.iter()
        .map(|r| {
            let a = r.as_array().context("a kalman row is not an array")?;
            Ok(Smoothed {
                ts: a
                    .first()
                    .and_then(Value::as_i64)
                    .context("a kalman row has no ts")?,
                lat: unbits(a.get(1).context("a kalman row has no lat")?)?,
                lon: unbits(a.get(2).context("a kalman row has no lon")?)?,
                speed_kmh: unbits(a.get(3).context("a kalman row has no speed")?)?,
                bearing: unbits(a.get(4).context("a kalman row has no bearing")?)?,
            })
        })
        .collect()
}

/// `Verified.Geo.Segments.classifySegments` — the step whose output IS
/// `segsRaw`.
///
/// `stay_pts` is `None` only when there is no separate stay set; that is the
/// segmenter's own default (double the movement fixes up as stay evidence) and
/// is NOT the same as passing an empty array.
pub fn classify_segments(pts: &[Smoothed], stay_pts: Option<&[Fix]>) -> Result<Vec<Value>> {
    let mut req = Map::new();
    req.insert("op".into(), Value::String("segments".into()));
    req.insert(
        "pts".into(),
        Value::Array(
            pts.iter()
                .map(|p| {
                    json!([
                        p.ts,
                        bits(p.lat),
                        bits(p.lon),
                        bits(p.speed_kmh),
                        bits(p.bearing)
                    ])
                })
                .collect(),
        ),
    );
    req.insert(
        "stayPts".into(),
        match stay_pts {
            None => Value::Null,
            Some(s) => Value::Array(
                s.iter()
                    .map(|p| json!([p.ts, bits(p.lat), bits(p.lon)]))
                    .collect(),
            ),
        },
    );
    let out = ask("head", req)?;
    let rows = out
        .get("segs")
        .and_then(Value::as_array)
        .context("segments reply has no segs")?;
    rows.iter().map(seg_json).collect()
}

/// One Lean segment in the shape the fold reads — the TypeScript's own.
///
/// Two differences from the wire row, both required for byte parity with the
/// frozen `segsRaw`: floats come back as bit patterns and have to render the
/// way `JSON.stringify` renders them, and the two refinement fields are
/// OPTIONAL in TypeScript. Lean has no `undefined`, so it sends `null` and `[]`
/// where the TS omits the key; emitting them would add fields to every segment
/// of every day.
fn seg_json(row: &Value) -> Result<Value> {
    let f = |k: &str| -> Result<Value> {
        Ok(js_num(unbits(
            row.get(k)
                .with_context(|| format!("a segment has no {k}"))?,
        )?))
    };
    let i = |k: &str| -> Result<Value> {
        Ok(json!(
            row.get(k)
                .and_then(Value::as_i64)
                .with_context(|| format!("a segment has no {k}"))?
        ))
    };
    let mut out = Map::new();
    out.insert("startTs".into(), i("startTs")?);
    out.insert("endTs".into(), i("endTs")?);
    out.insert(
        "mode".into(),
        Value::String(
            row.get("mode")
                .and_then(Value::as_str)
                .context("a segment has no mode")?
                .to_string(),
        ),
    );
    out.insert("confidence".into(), f("confidence")?);
    out.insert("confidenceMargin".into(), f("confidenceMargin")?);
    out.insert("avgSpeed".into(), f("avgSpeed")?);
    out.insert("maxSpeed".into(), f("maxSpeed")?);
    out.insert("linearity".into(), f("linearity")?);
    out.insert("pointCount".into(), i("pointCount")?);
    if let Some(r) = row.get("refinedReason").and_then(Value::as_str) {
        out.insert("refinedReason".into(), Value::String(r.to_string()));
    }
    match row.get("refinedKinds").and_then(Value::as_array) {
        Some(k) if !k.is_empty() => {
            out.insert("refinedKinds".into(), Value::Array(k.clone()));
        }
        _ => {}
    }
    Ok(Value::Object(out))
}

/// Everything the head produces from one day's inputs.
pub struct Head {
    /// The day fold's only input.
    pub segs_raw: Vec<Value>,
    /// The Kalman-smoothed track, as the observation tensor reads it.
    pub points: Vec<Smoothed>,
    /// In-day raw fixes, before any filter — the battery trace and `obs.rawFixes`.
    pub in_day: Vec<Fix>,
    /// Quality-filtered, accuracy-capped, but UN-snapped: what the map draws.
    pub display_fixes: Vec<Fix>,
}

/// Run the head over one day's `ClassificationInputs`.
///
/// `inputs` is the JSON the loader produces — `classification_inputs::load` in
/// this crate, or a golden fixture's `inputs`, which are the same bytes.
pub fn run(inputs: &Value, date: &str) -> Result<Head> {
    let tz = inputs
        .pointer("/identity/displayTz")
        .and_then(Value::as_str)
        .unwrap_or("UTC");
    let bounds = crate::timezone::date_bounds_utc(date, Some(tz))?;

    let today = inputs
        .pointer("/phonetrack/today")
        .and_then(Value::as_array)
        .context("inputs have no phonetrack.today")?;
    let in_day: Vec<Fix> = today
        .iter()
        .filter_map(parse_input_fix)
        .filter(|p| p.ts >= bounds.start_utc && p.ts < bounds.end_utc)
        .collect();

    let cleaned = quality_filter(&in_day)?;

    let places = inputs
        .get("knownPlaces")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let snapped = snap_all(&cleaned, places)?;

    let usable = |p: &&Fix| p.accuracy.is_none_or(|a| a <= ACCURACY_CEILING_M);
    let gps_points: Vec<Fix> = snapped.iter().filter(usable).copied().collect();
    // ⚠ From `cleaned`, NOT `snapped`. Place-snap pulls a fix near a known
    // cluster onto its centroid — right for stay detection, but on a leg that
    // merely PASSES home it yanks the drawn line off the road. The renderer
    // wants where the phone actually was.
    let display_fixes: Vec<Fix> = cleaned.iter().filter(usable).copied().collect();

    let points = kalman(&gps_points)?;
    // The stay set is the SAME accuracy-capped snapped fixes the smoother got,
    // but un-smoothed and carrying no velocity: `findStays` wants where the
    // phone reported being, and the Kalman's velocity coupling would smear a
    // stationary cluster. Note this is `Some(...)` even when empty — passing
    // `None` would make the segmenter double the movement fixes up as stay
    // evidence, which is a different day.
    let segs_raw = classify_segments(&points, Some(&gps_points))?;

    Ok(Head {
        segs_raw,
        points,
        in_day,
        display_fixes,
    })
}

/// A PhoneTrack row from the loader's JSON. A row missing a coordinate is not a
/// fix; the TS reads `p.ts`/`p.lat`/`p.lon` off a typed row and never sees one.
fn parse_input_fix(v: &Value) -> Option<Fix> {
    Some(Fix {
        ts: v.get("ts")?.as_i64()?,
        lat: v.get("lat")?.as_f64()?,
        lon: v.get("lon")?.as_f64()?,
        accuracy: match v.get("accuracy") {
            None | Some(Value::Null) => None,
            Some(a) => Some(a.as_f64()?),
        },
    })
}

/// The head's output in the shape `fold_payload::build_day_request` reads.
///
/// That function was written against `FOLD_CAPTURE` files — the TypeScript
/// pipeline recording what it handed the fold — and is already verified field
/// by field against them. So the last step to a Node-free day is not a second
/// encoder but the same one, fed a capture this crate computed. The frozen
/// `expected.tsArm.capture` on each fixture is then the oracle for BOTH halves
/// at once.
///
/// Only the fields the fold reads are produced: `segsRaw`, `modeStats`, `obs`,
/// `tail`, and the two answer tables, which start empty because a serving
/// caller has no recorded trace to seed them from — the converge loop fills
/// them by asking. The capture's other keys (`segsSplit`, `statesOut`, …) are
/// the TypeScript's own intermediate boundaries, recorded for the day gate to
/// compare; nothing downstream of `build_day_request` reads them.
///
/// ⚠ AN EMPTY DAY IS REFUSED RATHER THAN APPROXIMATED. When a day observes
/// nothing, `tail.bracketPlace` carries the resolved NAME of the cross-day
/// bracket centroid, and resolving it is a mirror `bestPlace` lookup this
/// function has no adapter for. Omitting the field silently would produce a
/// well-formed request for a different day — the exact defect #1055 fixed, in
/// which the inference simply stopped happening. No golden day is empty, so
/// this path is unexercised by the corpus and says so instead of guessing.
pub fn capture(inputs: &Value, date: &str, user: &str) -> Result<Value> {
    let head = run(inputs, date)?;
    let tz = inputs
        .pointer("/identity/displayTz")
        .and_then(Value::as_str)
        .unwrap_or("UTC");
    let bounds = crate::timezone::date_bounds_utc(date, Some(tz))?;

    if head.segs_raw.is_empty() && head.points.is_empty() {
        let bracket = inputs.get("emptyDayBracket");
        if bracket.is_some_and(|b| !b.is_null()) {
            anyhow::bail!(
                "{date} observes nothing and has a cross-day bracket, so the day needs \
                 tail.bracketPlace — a bestPlace lookup this path cannot make"
            );
        }
    }

    let biom = |k: &str| -> &[Value] {
        inputs
            .pointer(&format!("/biometrics/{k}"))
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    };
    let pick = |rows: &[Value], keys: [&str; 2]| -> Value {
        Value::Array(
            rows.iter()
                .map(|r| {
                    let mut o = Map::new();
                    for k in keys {
                        o.insert(k.into(), r.get(k).cloned().unwrap_or(Value::Null));
                    }
                    Value::Object(o)
                })
                .collect(),
        )
    };

    let mut obs = Map::new();
    obs.insert(
        "points".into(),
        Value::Array(
            head.points
                .iter()
                .map(|p| {
                    json!({ "ts": p.ts, "lat": js_num(p.lat), "lon": js_num(p.lon),
                            "speedKmh": js_num(p.speed_kmh) })
                })
                .collect(),
        ),
    );
    obs.insert("rawFixes".into(), accuracy_rows(&head.in_day));
    obs.insert("displayFixes".into(), accuracy_rows(&head.display_fixes));
    obs.insert("steps".into(), pick(biom("steps"), ["ts", "steps"]));
    obs.insert("hr".into(), pick(biom("hr"), ["ts", "bpm"]));
    obs.insert("sleep".into(), pick(biom("sleep"), ["startTs", "endTs"]));

    let plain = |k: &str| -> Value {
        Value::Array(
            inputs
                .pointer(&format!("/phonetrack/{k}"))
                .and_then(Value::as_array)
                .map_or(&[] as &[Value], Vec::as_slice)
                .iter()
                .map(|p| {
                    json!({ "ts": p.get("ts").cloned().unwrap_or(Value::Null),
                            "lat": p.get("lat").cloned().unwrap_or(Value::Null),
                            "lon": p.get("lon").cloned().unwrap_or(Value::Null) })
                })
                .collect(),
        )
    };

    let mut tail = Map::new();
    tail.insert("morningRaw".into(), plain("morning"));
    tail.insert("prevEveningRaw".into(), plain("priorEvening"));
    tail.insert(
        "rawSleep".into(),
        Value::Array(
            inputs
                .get("sleepWindows")
                .and_then(Value::as_array)
                .map_or(&[] as &[Value], Vec::as_slice)
                .iter()
                .map(|w| {
                    let g = |k: &str| w.get(k).cloned().unwrap_or(Value::Null);
                    json!({ "startTs": g("startTs"), "endTs": g("endTs"),
                            "tz": g("tz"), "minutesAsleep": g("minutesAsleep") })
                })
                .collect(),
        ),
    );
    tail.insert("dayEndTs".into(), json!(bounds.end_utc));
    tail.insert("dayStartTs".into(), json!(bounds.start_utc));
    tail.insert("dayTz".into(), Value::String(tz.to_string()));

    Ok(json!({
        "date": date,
        "user": user,
        "segsRaw": head.segs_raw,
        "modeStats": inputs.get("modeBiometrics").cloned().unwrap_or(json!([])),
        "obs": Value::Object(obs),
        "tzAt": [],
        "bestPlace": [],
        "tail": Value::Object(tail),
    }))
}

/// `{ts, lat, lon, accuracy}` rows — `obs.rawFixes` and `obs.displayFixes`.
fn accuracy_rows(pts: &[Fix]) -> Value {
    Value::Array(
        pts.iter()
            .map(|p| {
                json!({ "ts": p.ts, "lat": js_num(p.lat), "lon": js_num(p.lon),
                        "accuracy": match p.accuracy {
                            None => Value::Null,
                            Some(a) => js_num(a),
                        } })
            })
            .collect(),
    )
}
