//! The pipeline head: raw PhoneTrack fixes → `segsRaw`, the day fold's only
//! input. Every stage is a `#guard`-pinned Lean mode via `lean::serve`; this
//! module is the sequencing, which fixes each stage gets and the filters
//! between.
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
//! Each golden fixture's `expected.statesOut` is this chain's last blessed
//! output, so it replays with no database: a regression oracle, not a
//! correctness one (the narratives grade that).
//!
//! ⚠ Compare the serialised text: `jq` parses to doubles (`25.0 == 25`). Every
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
    /// The accuracy (m) of the raw fix this was smoothed from, so the segmenter
    /// can tell a straight walk from a jump inside the noise (`linearity` reads
    /// 1.0 for a path that did not move). `None` is no report, never "perfect".
    pub accuracy: Option<f64>,
}

/// The accuracy ceiling for a fix to reach the Kalman filter, deliberately
/// loose: the filter already weights by accuracy², and harder pre-filtering
/// drops the anchors fast linear travel needs. Not `GpsQuality`'s 80 m
/// garbage-fix rule, which is a different job (one name per rule is enforced by
/// `scripts/rules-live-in-lean.sh`).
const KALMAN_ADMIT_ACCURACY_M: f64 = 200.0;

/// A `f64` on the Lean wire, as its bit pattern in a decimal string: JSON would
/// round it, and the Kalman recursion moves on a fix's seventh decimal.
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

/// One `lean::serve` call with the mode injected and an `error` reply refused:
/// Lean reports a malformed request as `{"error": …}` with exit 0, which would
/// otherwise read as an empty day.
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

/// `Verified.Geo.PlacePrior.snapToPlace` over the whole day in one call (not a
/// round trip per fix). The reply is positional, one row per input fix. With no
/// known places the fixes pass through.
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
                        // `KnownPlace.id` is a string in Lean and reaches no
                        // decision here, so the numeric row id crosses as text.
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
            // The flag decides, not the geometry. A fix already at a centroid
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
/// Drops rows (duplicate timestamps, innovation-gated fixes), so the output is
/// a subsequence and a length mismatch is meaningful rather than a bug.
pub fn kalman(pts: &[Fix]) -> Result<Vec<Smoothed>> {
    let mut req = Map::new();
    req.insert("pts".into(), fix_rows(pts));
    let out = ask("kalman", req)?;
    let rows = out
        .get("pts")
        .and_then(Value::as_array)
        .context("kalman reply has no pts")?;
    // Rejoined by timestamp: the filter's output is a subsequence of its input,
    // so each `ts` is an input's and the join is exact, keeping the accuracy
    // out of the filter.
    let acc_by_ts: std::collections::HashMap<i64, Option<f64>> =
        pts.iter().map(|p| (p.ts, p.accuracy)).collect();
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
                accuracy: a
                    .first()
                    .and_then(Value::as_i64)
                    .and_then(|ts| acc_by_ts.get(&ts).copied())
                    .flatten(),
            })
        })
        .collect()
}

/// The day's phone-battery trace at run boundaries, `(ts, level)`, from the
/// in-day fixes before the quality filters: a fix dropped for its position
/// still carries a valid battery reading.
pub type Battery = Vec<(i64, i64)>;

/// Everything the head produces from one day's inputs.
pub struct Head {
    /// The Kalman-smoothed track, as the observation tensor reads it.
    pub points: Vec<Smoothed>,
    /// In-day raw fixes, before any filter — the battery trace and `obs.rawFixes`.
    pub in_day: Vec<Fix>,
    /// Quality-filtered, accuracy-capped, but un-snapped: what the map draws.
    pub display_fixes: Vec<Fix>,
    /// The battery chart series.
    pub battery: Battery,
}

/// Run the head over one day's inputs, as `classification_inputs::load` writes
/// them or as a golden fixture carries them (the same bytes).
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
    let in_day_rows: Vec<&Value> = today
        .iter()
        .filter(|p| {
            p.get("ts")
                .and_then(Value::as_i64)
                .is_some_and(|ts| ts >= bounds.start_utc && ts < bounds.end_utc)
        })
        .collect();
    let in_day: Vec<Fix> = in_day_rows
        .iter()
        .filter_map(|p| parse_input_fix(p))
        .collect();

    // From the raw in-day rows, before the filters below. A fix dropped for an
    // incoherent position still reported a real battery level, and the chart is
    // about the phone rather than about where it was.
    let battery = battery_series(&in_day_rows, inputs.get("batteryTail"), bounds.end_utc)?;

    let cleaned = quality_filter(&in_day)?;

    let places = inputs
        .get("knownPlaces")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let usable = |p: &&Fix| p.accuracy.is_none_or(|a| a <= KALMAN_ADMIT_ACCURACY_M);
    // The cap reads the phone's reported accuracy, so it runs before the snap:
    // a snapped fix carries the place's radius instead, which let a few
    // network fixes 200–400 m out pass and serve a stay away from the café.
    let admitted: Vec<Fix> = cleaned.iter().filter(usable).copied().collect();
    let gps_points = snap_all(&admitted, places)?;
    // The admitted fixes, not the snapped ones: snapping is right for stay
    // detection but yanks a passing leg off the road.
    let display_fixes = admitted;

    let points = kalman(&gps_points)?;
    Ok(Head {
        points,
        in_day,
        display_fixes,
        battery,
    })
}

/// `appendBatteryTail (batterySeries pts) tail dayEndTs` in one call, so a
/// caller cannot ship the untailed series. The tail is the first reading after
/// the day ends; it sets the slope drawn to midnight, and without it the series
/// ends at its last reading.
pub fn battery_series(rows: &[&Value], tail: Option<&Value>, day_end_ts: i64) -> Result<Battery> {
    let mut req = Map::new();
    req.insert(
        "points".into(),
        Value::Array(
            rows.iter()
                .map(|p| {
                    json!([
                        p.get("ts").cloned().unwrap_or(Value::Null),
                        // Absent and null both mean no reading and must arrive
                        // as null, not a zero level; the corpus never omits the
                        // key, so `battery_drops_a_missing_reading` holds it.
                        match p.get("battery") {
                            None => Value::Null,
                            Some(b) => b.clone(),
                        }
                    ])
                })
                .collect(),
        ),
    );
    req.insert(
        "tail".into(),
        match tail {
            None | Some(Value::Null) => Value::Null,
            Some(t) => json!([
                t.get("ts").cloned().unwrap_or(Value::Null),
                t.get("level").cloned().unwrap_or(Value::Null)
            ]),
        },
    );
    req.insert("dayEndTs".into(), json!(day_end_ts));
    let out = ask("battery", req)?;
    out.get("series")
        .and_then(Value::as_array)
        .context("battery reply has no series")?
        .iter()
        .map(|r| {
            let a = r.as_array().context("a battery row is not an array")?;
            Ok((
                a.first()
                    .and_then(Value::as_i64)
                    .context("a battery row has no ts")?,
                a.get(1)
                    .and_then(Value::as_i64)
                    .context("a battery row has no level")?,
            ))
        })
        .collect()
}

/// A PhoneTrack row from the loader's JSON. A row missing a coordinate is not a
/// fix.
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

/// The head's output in the shape `fold_payload::build_day_request` reads, so
/// the corpus checks capture and encoding together. Only the fields the fold
/// reads: `segsRaw`, `modeStats`, `obs` and `tail`.
///
/// An empty day without a decode is refused: it needs `tail.bracketPlace`, a
/// mirror lookup this has no adapter for, and omitting it would quietly fold a
/// different day. No golden day is empty.
pub fn capture(inputs: &Value, date: &str, user: &str) -> Result<Value> {
    let head = run(inputs, date)?;
    let tz = inputs
        .pointer("/identity/displayTz")
        .and_then(Value::as_str)
        .unwrap_or("UTC");
    let bounds = crate::timezone::date_bounds_utc(date, Some(tz))?;

    // A stored decode heads the fold and names the stay by its place; only the
    // cascade needs the bracket's name.
    let decoded = inputs
        .get("hsmmDecode")
        .and_then(Value::as_array)
        .is_some_and(|d| !d.is_empty());
    if head.points.is_empty() && !decoded {
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

    // The pipeline's points keep the raw fix's ts, so its reported accuracy
    // rides along by ts from the raw rows (the pipeline does not carry it).
    let accuracy: std::collections::HashMap<i64, f64> = ["priorEvening", "today", "morning"]
        .iter()
        .flat_map(|k| {
            inputs
                .pointer(&format!("/phonetrack/{k}"))
                .and_then(Value::as_array)
                .map_or(&[] as &[Value], Vec::as_slice)
                .iter()
        })
        .filter_map(|p| Some((p.get("ts")?.as_i64()?, p.get("accuracy")?.as_f64()?)))
        .collect();
    let mut obs = Map::new();
    obs.insert(
        "points".into(),
        Value::Array(
            head.points
                .iter()
                .map(|p| {
                    json!({ "ts": p.ts, "lat": js_num(p.lat), "lon": js_num(p.lon),
                            "speedKmh": js_num(p.speed_kmh),
                            "accuracyM": accuracy.get(&p.ts).map_or(Value::Null, |a| js_num(*a)) })
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
