//! The day fold's wire encoding.
//!
//! The fold takes one JSON object and the pipeline builds it. This encoding is
//! the interface to the verified core, so a host that gets it wrong asks a
//! different question and gets a confidently wrong day, not an error. Lookup
//! tables do not ride in it: the fold asks for those, and `lookup_rows` below
//! turns a fixture's recorded trace into the rows it will be answered with.
//!
//! ⚠ Floats cross as their bit pattern. `bits` renders an `f64` as the decimal
//! of its IEEE-754 payload, so the fold reads the pipeline's exact double.
//! Formatting the number instead (`{}`, `{:.6}`, `to_string`) silently changes
//! coordinate precision, where 1e-7° is what the match gate adjudicates.
//!
//! `tests/suite/fold_payload.rs` compares the encoding byte for byte against
//! frozen output of the original encoder: in mostly pass-through data, a wrong
//! field name is a well-formed request the fold answers anyway.

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

/// An `f64` as the decimal of its IEEE-754 bit pattern.
///
/// The inverse of `unbits`. NaN has many bit patterns and this keeps the one it
/// was handed: a transport, not a normaliser.
pub fn bits(x: f64) -> String {
    x.to_bits().to_string()
}

/// `bits`, but `null` survives as `null`.
///
/// ⚠ Absent and zero are different facts: a segment with no `refinedMode` is
/// not one refined to nothing.
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

/// `opt_str` for a value already looked up, rather than a key in a map.
///
/// Absent and `null` both encode as `null`, which Lean's `getObjValAs? String`
/// reads as `none`. The string "null" would parse as a place name.
fn opt_str_at(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => Value::String(s.clone()),
        _ => Value::Null,
    }
}

/// A field passed through UNENCODED.
///
/// Timestamps, counts and ids are not bit-encoded: JSON carries an integer
/// exactly. It also carries string keys (`routeKey`, the enum-ish `mode`
/// values), which is why this is `raw` and not `int`.
fn raw(o: &Map<String, Value>, k: &str) -> Value {
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
/// ⚠ Thirty fields, and the tail is the easy half to miss. A short encoding
/// is no parse error in Lean: absent fields take `Seg`'s defaults, and the fold
/// answers about a segment that has lost its enrichment.
pub fn encode_seg(seg: &Value) -> Value {
    let Some(o) = seg.as_object() else {
        return Value::Null;
    };
    json!({
        "startTs": raw(o, "startTs"),
        "endTs": raw(o, "endTs"),
        "mode": opt_str(o, "mode"),
        "refinedMode": opt_str(o, "refinedMode"),
        "confidence": num_bits(o, "confidence"),
        "confidenceMargin": num_bits(o, "confidenceMargin"),
        "avgSpeed": num_bits(o, "avgSpeed"),
        "maxSpeed": num_bits(o, "maxSpeed"),
        "linearity": num_bits(o, "linearity"),
        "pointCount": raw(o, "pointCount"),
        "place": opt_str(o, "place"),
        "city": opt_str(o, "city"),
        "wayName": opt_str(o, "wayName"),
        "refinedReason": opt_str(o, "refinedReason"),
        // Absent becomes `[]`, not `null`: Lean reads a list.
        "refinedKinds": o.get("refinedKinds").cloned().unwrap_or_else(|| json!([])),
        "centroidLat": num_bits(o, "centroidLat"),
        "centroidLon": num_bits(o, "centroidLon"),
        // `Option Int` in Lean: a non-numeric id is dropped, not coerced to
        // NaN.
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
/// `sleepFraction` is `bits`, not `opt_bits`: a segment with biometrics always
/// has one.
fn encode_biometrics(v: Option<&Value>) -> Value {
    let Some(b) = v.and_then(Value::as_object) else {
        return Value::Null;
    };
    json!({
        "hrMean": num_bits(b, "hrMean"),
        "hrMin": num_bits(b, "hrMin"),
        "hrMax": num_bits(b, "hrMax"),
        "hrStd": num_bits(b, "hrStd"),
        "sampleCount": raw(b, "sampleCount"),
        "overlapsSleep": b.get("overlapsSleep").cloned().unwrap_or(Value::Null),
        "sleepFraction": num_bits(b, "sleepFraction"),
        "stepsTotal": num_bits(b, "stepsTotal"),
    })
}

/// A `[ts, bits(lat), bits(lon)]` fixture list — the shape both cross-day
/// fixture arrays take.
fn fixes3(v: Option<&Value>) -> Value {
    arr_map(v, |o| {
        json!([raw(o, "ts"), num_bits(o, "lat"), num_bits(o, "lon")])
    })
}

/// A `[ts, bits(lat), bits(lon), optBits(accuracy)]` fixture list.
fn fixes4(v: Option<&Value>) -> Value {
    arr_map(v, |o| {
        json!([
            raw(o, "ts"),
            num_bits(o, "lat"),
            num_bits(o, "lon"),
            num_bits(o, "accuracy")
        ])
    })
}

/// Map over a JSON array of objects, skipping anything that is not one.
///
/// An absent array becomes `[]`, not `null`: every one of these fields is a
/// list on the Lean side.
fn arr_map<F: Fn(&Map<String, Value>) -> Value>(v: Option<&Value>, f: F) -> Value {
    Value::Array(
        v.and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_object).map(&f).collect())
            .unwrap_or_default(),
    )
}

/// The observation series and the cross-day tail, as `env` carries them.
///
/// `points` and `speedByTs` are the same source sent twice: the fold wants the
/// track and the speed lookup separately, and deriving one here would be this
/// encoder deciding something.
///
/// `sleep` and `rawSleep` differ: `sleep` is the projection the biometric
/// windows read, `rawSleep` the Fitbit windows before place attribution.
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
                raw(p, "ts"),
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
        arr_map(g("steps"), |s| json!([raw(s, "ts"), num_bits(s, "steps")])),
    );
    m.insert(
        "hr".into(),
        arr_map(g("hr"), |h| json!([raw(h, "ts"), num_bits(h, "bpm")])),
    );
    m.insert(
        "sleep".into(),
        arr_map(g("sleep"), |s| json!([raw(s, "startTs"), raw(s, "endTs")])),
    );
    m.insert(
        "speedByTs".into(),
        arr_map(g("points"), |p| {
            json!([raw(p, "ts"), num_bits(p, "speedKmh")])
        }),
    );
    m.insert("morningFixes".into(), fixes3(tg("morningRaw")));
    m.insert("prevEveningFixes".into(), fixes3(tg("prevEveningRaw")));
    m.insert(
        "rawSleep".into(),
        arr_map(tg("rawSleep"), |w| {
            json!([
                raw(w, "startTs"),
                raw(w, "endTs"),
                opt_str(w, "tz"),
                raw(w, "minutesAsleep")
            ])
        }),
    );
    m.insert(
        "dayEndTs".into(),
        tg("dayEndTs").cloned().unwrap_or_else(|| json!(0)),
    );
    // The empty-day arm's three. A fixture captured before they existed has
    // none, and the defaults are `null` for both strings (not "null") and 0 for
    // the start, which the fold never reads without a bracket.
    m.insert(
        "dayStartTs".into(),
        tg("dayStartTs").cloned().unwrap_or_else(|| json!(0)),
    );
    m.insert("dayTz".into(), opt_str_at(tg("dayTz")));
    m.insert("bracketPlace".into(), opt_str_at(tg("bracketPlace")));
    m
}

/// The mined `mode_biometrics` rows, as the eleven-tuple `env.modeStats` takes.
pub fn encode_mode_stats(v: Option<&Value>) -> Value {
    arr_map(v, |m| {
        json!([
            opt_str(m, "mode"),
            num_bits(m, "hrMean"),
            num_bits(m, "hrStd"),
            raw(m, "hrSampleCount"),
            num_bits(m, "cadenceMean"),
            num_bits(m, "cadenceStd"),
            raw(m, "cadenceSampleCount"),
            num_bits(m, "speedMean"),
            num_bits(m, "speedStd"),
            raw(m, "speedSampleCount"),
            raw(m, "sampleCount"),
        ])
    })
}

/// A required float field: `bits`, with a default when absent.
///
/// ⚠ Not [`num_bits`]: these fields are a number Lean always reads, whereas
/// `num_bits` keeps absent as `null`. The wrong one turns "unknown" into a
/// value or the reverse.
fn num_bits_or(o: &Map<String, Value>, k: &str, dflt: f64) -> Value {
    Value::String(bits(o.get(k).and_then(Value::as_f64).unwrap_or(dflt)))
}

/// The mined places, six ways, as `env` carries them.
///
/// ⚠ One source list, six tuples, none redundant: each stage reads the columns
/// it needs and Lean indexes them positionally. The stay detector wants a
/// display name to snap to; the dwell continuation wants visit counts; the
/// enrichment stage wants the whole row. Five of six, or six in the wrong
/// order, is no decode error on the far side.
pub fn encode_places(known: Option<&Value>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "stayPlaces".into(),
        arr_map(known, |p| {
            json!([
                num_bits(p, "centroidLat"),
                num_bits(p, "centroidLon"),
                num_bits(p, "radiusM"),
                opt_str(p, "displayName")
            ])
        }),
    );
    m.insert(
        "dwellPlaces".into(),
        arr_map(known, |p| {
            json!([
                num_bits(p, "centroidLat"),
                num_bits(p, "centroidLon"),
                num_bits(p, "radiusM"),
                num_bits(p, "totalDwellSec"),
                // `null`, not 0: a place with no recorded visits is not a
                // place visited zero times.
                p.get("visitCount").cloned().unwrap_or(Value::Null),
                raw(p, "uniqueDays")
            ])
        }),
    );
    m.insert(
        "enrichPlaces".into(),
        arr_map(known, |p| {
            json!([
                raw(p, "id"),
                num_bits(p, "centroidLat"),
                num_bits(p, "centroidLon"),
                // Defaults to 50 m here and stays null in `stayPlaces` above.
                num_bits_or(p, "radiusM", 50.0),
                num_bits_or(p, "uniqueDays", 0.0),
                hour_profile(p.get("hourProfile")),
                opt_str(p, "displayName"),
                num_bits_or(p, "sleepHours", 0.0),
                opt_str(p, "amenityLabel")
            ])
        }),
    );
    m.insert(
        "knownPlaces".into(),
        arr_map(known, |p| {
            json!([
                raw(p, "id"),
                num_bits(p, "centroidLat"),
                num_bits(p, "centroidLon")
            ])
        }),
    );
    m.insert(
        "focusPlaceDays".into(),
        arr_map(known, |p| json!([raw(p, "id"), raw(p, "uniqueDays")])),
    );
    m.insert(
        "hsmmPlaces".into(),
        arr_map(known, |p| {
            json!([
                raw(p, "id"),
                opt_str(p, "displayName"),
                num_bits(p, "centroidLat"),
                num_bits(p, "centroidLon")
            ])
        }),
    );
    m
}

/// The 24-hour visit profile: every entry `bits`, or `null` for the whole
/// thing. ⚠ `null` means "no profile", which is not a profile of zeroes.
fn hour_profile(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        None => Value::Null,
        Some(hs) => Value::Array(hs.iter().map(|h| opt_bits(h.as_f64()).clone()).collect()),
    }
}

/// Metres of slack around `BUS_STOP_ANCHOR_M` when deciding a route is
/// reachable. The Lean gate is 120 m; the grid below is coarser than that on
/// purpose, so the kept set is a strict superset rather than a near-miss.
const BUS_REACH_LAT_CELL: f64 = 0.002;
/// ~277 m at London's latitude — wider than the lat cell because a degree of
/// longitude is shorter here, and erring wide is the safe direction.
const BUS_REACH_LON_CELL: f64 = 0.004;

/// The cells the day's fixes occupy, for {@link reachable_bus_routes}.
///
/// Quantised rather than compared pairwise: a day is ~850 fixes and the cache
/// is ~1000 routes of ~50 stops, so the honest pairwise test is ~42 M distance
/// computations per request. A cell lookup is O(1) and the cells are larger
/// than the matcher's radius, which is what makes dropping the rest sound.
fn fix_cells(points: Option<&Value>) -> std::collections::HashSet<(i64, i64)> {
    let mut cells = std::collections::HashSet::new();
    for p in points.and_then(Value::as_array).into_iter().flatten() {
        let (Some(la), Some(lo)) = (
            p.get("lat").and_then(Value::as_f64),
            p.get("lon").and_then(Value::as_f64),
        ) else {
            continue;
        };
        cells.insert((
            (la / BUS_REACH_LAT_CELL).floor() as i64,
            (lo / BUS_REACH_LON_CELL).floor() as i64,
        ));
    }
    cells
}

/// Drop bus routes the day cannot possibly have travelled.
///
/// Sound by the matcher's own gate: `Verified.Geo.Bus.bestPairFor` needs a
/// stop within `BUS_STOP_ANCHOR_M` (120 m) of both the board and alight fix,
/// and `Env.busFixes` is `env.points`, the array probed here. Grid cells are
/// ~222 m x ~277 m and a stop counts if any of the nine cells around it holds
/// a fix, so every route within 120 m of a fix survives.
///
/// Worth doing because `busRouteCache` is about half the request, and Lean's
/// `Json.parse` costs ~20x the text in heap.
///
/// ⚠ With no fixes the input is returned unfiltered: a silent empty cache would
/// read downstream as a day with no bus service.
pub fn reachable_bus_routes(bus_routes: Option<&Value>, points: Option<&Value>) -> Option<Value> {
    let cells = fix_cells(points);
    let all = bus_routes?.as_array()?;
    if cells.is_empty() {
        return bus_routes.cloned();
    }
    let near = |s: &Value| -> bool {
        let (Some(la), Some(lo)) = (
            s.get("lat").and_then(Value::as_f64),
            s.get("lon").and_then(Value::as_f64),
        ) else {
            // A stop with no coordinate cannot be shown unreachable, so it is
            // kept. Erring towards the larger set is the only safe direction.
            return true;
        };
        let (ci, cj) = (
            (la / BUS_REACH_LAT_CELL).floor() as i64,
            (lo / BUS_REACH_LON_CELL).floor() as i64,
        );
        (-1..=1).any(|di| (-1..=1).any(|dj| cells.contains(&(ci + di, cj + dj))))
    };
    let kept: Vec<Value> = all
        .iter()
        .filter(|r| {
            r.get("stops")
                .and_then(Value::as_array)
                .is_none_or(|ss| ss.iter().any(near))
        })
        .cloned()
        .collect();
    // ⚠ Stderr: `dump_day_request` and `replay-corpus-states.sh` write the
    // request to stdout.
    eprintln!(
        "busRouteCache: {} of {} route(s) reachable from {} fix cell(s)",
        kept.len(),
        all.len(),
        cells.len()
    );
    Some(Value::Array(kept))
}

/// A route's stop list: `[optStr(name), bits(lat), bits(lon), seq]`.
///
/// Shared by the bus and rail caches — the same four columns in the same order,
/// which is why one helper serves both rather than two that could drift.
fn stops(v: Option<&Value>) -> Value {
    arr_map(v, |s| {
        json!([
            opt_str(s, "name"),
            num_bits(s, "lat"),
            num_bits(s, "lon"),
            raw(s, "seq")
        ])
    })
}

/// The route and decode caches, as `env` carries them.
///
/// ⚠ `railRouteCache` holds its geometry as a JSON string inside the row, and
/// a row that does not parse is an error, not a skip. A corrupt row silently
/// becoming "this route does not exist" would score a day against a route set
/// with something missing; an empty polyline is a route that goes nowhere, a
/// dropped row a route nobody offered, and only an error says the cache is
/// broken.
pub fn encode_caches(
    hsmm_decode: Option<&Value>,
    rail_routes: Option<&Value>,
    bus_routes: Option<&Value>,
    rail_stops: Option<&Value>,
) -> Result<Map<String, Value>> {
    let mut m = Map::new();

    m.insert(
        "hmmDecode".into(),
        arr_map(hsmm_decode, |h| {
            json!({
                "startTs": raw(h, "startTs"),
                "endTs": raw(h, "endTs"),
                "mode": opt_str(h, "mode"),
                "lineName": opt_str(h, "lineName"),
                // `?? null`: an absent place id is unknown, not place zero.
                "placeId": h.get("placeId").cloned().unwrap_or(Value::Null),
            })
        }),
    );

    let mut routes = Vec::new();
    for row in rail_routes.and_then(Value::as_array).into_iter().flatten() {
        let r = row
            .as_object()
            .context("railRouteCache row is not an object")?;
        let geom_str = r
            .get("geometryJson")
            .and_then(Value::as_str)
            .context("railRouteCache row has no geometryJson string")?;
        let geom: Value = serde_json::from_str(geom_str).with_context(|| {
            format!(
                "railRouteCache row {} has unparseable geometryJson",
                r.get("routeKey").and_then(Value::as_str).unwrap_or("?")
            )
        })?;
        routes.push(json!([
            raw(r, "routeKey"),
            arr_map(Some(&geom), |p| json!([
                num_bits(p, "lat"),
                num_bits(p, "lon")
            ]))
        ]));
    }
    m.insert("railRouteCache".into(), Value::Array(routes));

    m.insert(
        "busRouteCache".into(),
        arr_map(bus_routes, |b| {
            json!({
                "routeRef": raw(b, "routeRef"),
                "routeName": opt_str(b, "routeName"),
                "osmRelationId": raw(b, "osmRelationId"),
                "stops": stops(b.get("stops")),
            })
        }),
    );

    m.insert(
        "railStops".into(),
        arr_map(rail_stops, |r| {
            json!({
                "lineRef": opt_str(r, "lineRef"),
                "lineName": opt_str(r, "lineName"),
                "osmRelationId": raw(r, "osmRelationId"),
                "routeType": raw(r, "routeType"),
                "stops": stops(r.get("stops")),
            })
        }),
    );

    Ok(m)
}

/// The numbers in a trace key, `lat|lon[|radius]`.
///
/// An unparseable part becomes NaN, not an error, as `Number("x")` does, and
/// the key encodes as a NaN bit pattern.
fn key_nums(k: &str) -> Vec<f64> {
    k.split('|')
        .filter(|s| !s.is_empty())
        // The NaN is the PARITY, not a sentinel — see the note above: it is what
        // `Number("x")` yields on the other side, and it survives as a bit
        // pattern. An Option here would diverge from the oracle this mirrors.
        // dev-lint: allow-nan-sentinel
        .map(|s| s.parse::<f64>().unwrap_or(f64::NAN))
        .collect()
}

/// `[latBits, lonBits, radiusBits, answer]` from a trace section.
///
/// The default radius is not a widening: the trace keys on the radius the
/// caller passed, and several callers omit it, while the Lean fold always
/// passes one. Filling it in records the effective argument, so `lat|lon` and
/// `lat|lon|100` are the same question.
fn table3<F: Fn(&Value) -> Value>(section: Option<&Value>, dflt: f64, map: F) -> Value {
    let mut out = Vec::new();
    for (k, v) in section.and_then(Value::as_object).into_iter().flatten() {
        let n = key_nums(k);
        if n.len() < 2 {
            continue;
        }
        out.push(json!([
            bits(n[0]),
            bits(n[1]),
            bits(if n.len() >= 3 { n[2] } else { dflt }),
            map(v)
        ]));
    }
    Value::Array(out)
}

/// `[latBits, lonBits, answer]`, for the one lookup that takes no radius.
///
/// Exactly two key parts, where [`table3`] takes two or more: `nearbyWays`
/// never passes a radius, so a three-part key is a different question, skipped
/// rather than truncated into this one.
fn table2<F: Fn(&Value) -> Value>(section: Option<&Value>, map: F) -> Value {
    let mut out = Vec::new();
    for (k, v) in section.and_then(Value::as_object).into_iter().flatten() {
        let n = key_nums(k);
        if n.len() != 2 {
            continue;
        }
        out.push(json!([bits(n[0]), bits(n[1]), map(v)]));
    }
    Value::Array(out)
}

/// One mined visit-shape prior.
fn venue_stats(v: &Value) -> Value {
    let Some(o) = v.as_object() else {
        return Value::Null;
    };
    let list = |k: &str| {
        Value::Array(
            o.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|x| opt_bits(x.as_f64())).collect())
                .unwrap_or_default(),
        )
    };
    json!({ "visits": num_bits(o, "visits"), "dwell": list("dwell"), "hours": list("hours") })
}

/// The mined visit-shape priors, or `null`.
///
/// ⚠ `null` is "no evidence about any venue", and `rankVenues` drops the shape
/// term; an empty object would turn a dropped term into a uniform one.
pub fn encode_venue_priors(v: Option<&Value>) -> Value {
    let Some(o) = v.and_then(Value::as_object) else {
        return Value::Null;
    };
    let entries = |k: &str| {
        Value::Array(
            o.get(k)
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .map(|(kk, vv)| json!([kk, venue_stats(vv)]))
                        .collect()
                })
                .unwrap_or_default(),
        )
    };
    json!({
        "bySubtype": entries("bySubtype"),
        "byCategory": entries("byCategory"),
        "totalVisits": num_bits(o, "totalVisits"),
    })
}

/// The default radii, in metres, of lookups whose callers omit one.
///
/// ⚠ They decide whether a recorded answer is found or missed. Changing one
/// does not change what the mirror was asked, only which recorded answer the
/// fold is offered.
pub mod default_radius_m {
    pub const NEARBY_WAYS: f64 = 50.0;
    pub const NEARBY_STATIONS: f64 = 200.0;
    pub const NEARBY_LANDMARKS: f64 = 100.0;
    pub const LINES_AT_POINT: f64 = 100.0;
    pub const NEARBY_TRANSIT_STOPS: f64 = 50.0;
}

/// Map a JSON array through a per-element encoder, `[]` when absent.
fn list_of<F: Fn(&Map<String, Value>) -> Value>(v: &Value, f: F) -> Value {
    arr_map(Some(v), f)
}

/// A fixture's recorded trace as `(table, key, row)` triples — the rows the
/// fold's asks are answered with, keyed as the fold spells the ask.
///
/// The row shapes are the ones `DayEntry`'s `entry2`/`entry3`/… parsers read,
/// and the key is derived FROM the row so the two cannot disagree: three-key
/// tables spell `row[0]|row[1]|row[2]`, two-key tables `row[0]|row[1]`,
/// `reverseGeocode` `lat|lon|zoom`, `bestPlace` `lat|lon|start|end|tz`, and
/// `stationsOnLine` the bare line name.
pub fn lookup_rows(
    trace: Option<&Value>,
    tz_at: Option<&Value>,
    best: Option<&Value>,
) -> Result<Vec<(String, String, Value)>> {
    let tables = encode_lookups(trace, tz_at, best)?;
    let mut out = Vec::new();
    let Some(o) = tables.as_object() else {
        return Ok(out);
    };
    for (what, rows) in o {
        let key_len = match what.as_str() {
            "nearbyWays" | "tzAt" => 2,
            "stationsOnLine" => 1,
            "bestPlace" => 5,
            _ => 3,
        };
        for row in rows.as_array().into_iter().flatten() {
            let parts: Vec<String> = row
                .as_array()
                .into_iter()
                .flatten()
                .take(key_len)
                .map(|p| match p {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            if parts.len() < key_len {
                anyhow::bail!("{what}: a row shorter than its key: {row}");
            }
            out.push((what.clone(), parts.join("|"), row.clone()));
        }
    }
    Ok(out)
}

pub fn encode_lookups(
    trace: Option<&Value>,
    tz_at: Option<&Value>,
    best: Option<&Value>,
) -> Result<Value> {
    let t = trace.and_then(Value::as_object);
    let sec = |k: &str| t.and_then(|t| t.get(k));

    Ok(json!({
        "nearbyStations": table3(sec("nearbyStations"), default_radius_m::NEARBY_STATIONS, |v| {
            list_of(v, |s| json!({
                "name": raw(s, "name"),
                "subtype": raw(s, "subtype"),
                "distanceM": num_bits(s, "distanceM"),
                "lat": num_bits(s, "lat"),
                "lon": num_bits(s, "lon"),
            }))
        }),
        // The answer is a bare string list, passed through as-is.
        "linesAtPoint": table3(sec("linesAtPoint"), default_radius_m::LINES_AT_POINT, Value::clone),
        "transitStops": table3(sec("nearbyTransitStops"), default_radius_m::NEARBY_TRANSIT_STOPS, |v| {
            list_of(v, |s| json!({
                "subtype": raw(s, "subtype"),
                "distanceM": num_bits(s, "distanceM"),
            }))
        }),
        "nearbyWays": table2(sec("nearbyWays"), |v| {
            list_of(v, |w| json!({
                "type": raw(w, "type"),
                "subtype": raw(w, "subtype"),
                "name": opt_str(w, "name"),
                "distanceM": num_bits(w, "distanceM"),
            }))
        }),
        "stationsOnLine": stations_on_line(sec("stationsOnLine")),
        // Not from the trace: `tzAt` is a direct `tzLookup` import in the
        // pipeline, so the fold capture carries it separately.
        "tzAt": arr_map(tz_at, |q| json!([
            num_bits(q, "lat"),
            num_bits(q, "lon"),
            raw(q, "tz")
        ])),
        "reverseGeocode": geocode_table(sec("reverseGeocode")),
        "nearbyLandmarks": table3(sec("nearbyLandmarks"), default_radius_m::NEARBY_LANDMARKS, |v| {
            list_of(v, |l| {
                let mut o = json!({
                    "name": raw(l, "name"),
                    "type": raw(l, "type"),
                    "subtype": raw(l, "subtype"),
                    "distanceM": num_bits(l, "distanceM"),
                    "openingHours": opt_str(l, "openingHours"),
                    // A missing flag is false, not null.
                    "enclosing": l.get("enclosing") == Some(&Value::Bool(true)),
                });
                // Inside an open space's outline: only when true, so a day
                // with no open space encodes exactly as it always has.
                if l.get("inside") == Some(&Value::Bool(true)) {
                    o["inside"] = Value::Bool(true);
                }
                o
            })
        }),
        // The stay context of each naming question, not its answer: Lean
        // computes the label; what it cannot compute is the venue-local clock.
        // The only table derived rather than passed through; see
        // `timezone::local_stay_samples`.
        "bestPlace": best_place(best)?,
    }))
}

/// `[latBits, lonBits, startTs, endTs, tz, staySamples, midpointHour]`.
///
/// The tz stays in the key though nothing downstream reads it: the derived
/// fields were resolved against it, and dropping it would let two zones share
/// a spelling.
///
/// The midpoint is floored; an instant and its floor lie in the same hour,
/// so the hour cannot change.
fn best_place(section: Option<&Value>) -> Result<Value> {
    let mut out = Vec::new();
    for q in section.and_then(Value::as_array).into_iter().flatten() {
        let o = q.as_object().context("bestPlace entry is not an object")?;
        let start = o
            .get("startTs")
            .and_then(Value::as_i64)
            .context("bestPlace entry has no startTs")?;
        let end = o
            .get("endTs")
            .and_then(Value::as_i64)
            .context("bestPlace entry has no endTs")?;
        let tz = o
            .get("tz")
            .and_then(Value::as_str)
            .context("bestPlace entry has no tz")?;
        let samples = crate::timezone::local_stay_samples(start, end, tz)?;
        let hour = crate::timezone::local_hour_of((start + end) / 2, tz)?;
        out.push(json!([
            num_bits(o, "lat"),
            num_bits(o, "lon"),
            start,
            end,
            tz,
            samples
                .iter()
                .map(|(d, m)| json!([d, m]))
                .collect::<Vec<_>>(),
            hour
        ]));
    }
    Ok(Value::Array(out))
}

/// `[line, [[name, latBits, lonBits], …]]` — keyed by LINE NAME, not by
/// coordinate, so there is no key parsing and no radius.
fn stations_on_line(section: Option<&Value>) -> Value {
    Value::Array(
        section
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(line, v)| {
                        json!([
                            line,
                            list_of(v, |s| json!([
                                raw(s, "name"),
                                num_bits(s, "lat"),
                                num_bits(s, "lon")
                            ]))
                        ])
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// `reverseGeocode`'s `zoom = 18` default, so a key that omitted it records the
/// EFFECTIVE argument rather than a blank.
pub const NOMINATIM_DEFAULT_ZOOM: f64 = 18.0;

/// `[latBits, lonBits, zoom, address|null]`.
///
/// ⚠ The zoom crosses as a plain integer, unlike every other numeric: it is a
/// literal the caller writes. So this table cannot reuse `table3`, which would
/// bit-encode the zoom and miss every key.
///
/// Public so a test can hold the answerer's live rows against it.
pub fn geocode_table(section: Option<&Value>) -> Value {
    let mut out = Vec::new();
    for (k, v) in section.and_then(Value::as_object).into_iter().flatten() {
        let n = key_nums(k);
        if n.len() < 2 {
            continue;
        }
        // An integer on the wire: `16.0` would be refused by Lean's `getInt?`.
        let zoom = if n.len() >= 3 {
            n[2]
        } else {
            NOMINATIM_DEFAULT_ZOOM
        };
        let zoom = if zoom.fract() == 0.0 && zoom.is_finite() {
            json!(zoom as i64)
        } else {
            json!(zoom)
        };
        out.push(json!([
            bits(n[0]),
            bits(n[1]),
            zoom,
            if v.is_null() {
                Value::Null
            } else {
                encode_geocode(v)
            }
        ]));
    }
    Value::Array(out)
}

/// One Nominatim answer, flattened: the three top-level fields plus the address
/// components the naming cascade reads.
///
/// Public because the answerer encodes here too: a geocode from a live cache
/// and one from a recorded section must be the same bytes, so there is one
/// encoder.
pub fn encode_geocode(v: &Value) -> Value {
    let Some(o) = v.as_object() else {
        return Value::Null;
    };
    let empty = Map::new();
    let a = o
        .get("address")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    json!({
        "displayName": raw(o, "displayName"),
        "type": raw(o, "type"),
        "category": raw(o, "category"),
        "amenity": opt_str(a, "amenity"),
        "tourism": opt_str(a, "tourism"),
        "leisure": opt_str(a, "leisure"),
        "shop": opt_str(a, "shop"),
        "building": opt_str(a, "building"),
        // snake_case in, camelCase out: Nominatim keeps OSM's spelling.
        "houseNumber": opt_str(a, "house_number"),
        "road": opt_str(a, "road"),
        "pedestrian": opt_str(a, "pedestrian"),
        "neighbourhood": opt_str(a, "neighbourhood"),
        "suburb": opt_str(a, "suburb"),
        "stateDistrict": opt_str(a, "state_district"),
        "city": opt_str(a, "city"),
        "town": opt_str(a, "town"),
        "village": opt_str(a, "village"),
        "municipality": opt_str(a, "municipality"),
    })
}

/// The day's segments in the decoder dump `var` names, one
/// `{name, segments}` line per fixture; `None` when the variable is unset or
/// the dump has no line for the day.
fn decoder_head_segments(inputs: &Map<String, Value>, var: &str) -> Result<Option<Value>> {
    let Ok(path) = std::env::var(var) else {
        return Ok(None);
    };
    let date = inputs
        .get("identity")
        .and_then(|v| v.get("date"))
        .and_then(Value::as_str)
        .with_context(|| format!("{var}: the inputs carry no identity.date"))?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("{var}: reading {path}"))?;
    for line in text.lines() {
        let row: Value =
            serde_json::from_str(line).with_context(|| format!("{var}: a line is not JSON"))?;
        if row["name"].as_str().is_some_and(|n| n.starts_with(date)) {
            return Ok(Some(row["segments"].clone()));
        }
    }
    // A day the dump does not hold (no narrative to score) folds on its stored decode.
    Ok(None)
}

/// The whole fold request: `{trace, env}`.
///
/// Key order does not matter to Lean, which reads by name, but the byte
/// comparison with the frozen fixtures needs it; `preserve_order` emits it as
/// written here.
pub fn build_day_request(cap: &Value, inputs: &Value) -> Result<Value> {
    let c = cap.as_object().context("capture is not an object")?;
    let i = inputs.as_object().context("inputs is not an object")?;

    let mut env = Map::new();
    env.insert(
        "homeTz".into(),
        i.get("homeTz").cloned().unwrap_or(Value::Null),
    );
    // Only when the caller set it: Lean defaults an absent `walkMatch` to true,
    // so the gates and the CLIs keep the production draw without the field.
    if let Some(wm) = i.get("walkMatch") {
        env.insert("walkMatch".into(), wm.clone());
    }

    let obs = c.get("obs").context("capture has no obs")?;
    for (k, v) in encode_obs_and_tail(obs, c.get("tail")) {
        env.insert(k, v);
    }
    for (k, v) in encode_places(i.get("knownPlaces")) {
        env.insert(k, v);
    }
    env.insert(
        "venuePriors".into(),
        encode_venue_priors(i.get("venuePriors")),
    );
    // The filter sits here, not in `encode_caches`: `fold_env` pins that
    // encoder whole against the frozen fixtures, so an optimisation belongs one
    // level up, visible at the call site and with its own test.
    let bus_reachable = reachable_bus_routes(i.get("busRouteCache"), obs.get("points"));
    // The decoder heads the fold on every day it has decoded: its segments are
    // the day, and Lean runs only the naming tail over them (`DayEntry`,
    // `decoderHead`). A day without a stored decode at this
    // `CLASSIFIER_VERSION` (today, or a day the re-decode has not reached)
    // folds through the cascade.
    //
    // `FOLD_DECODER_HEAD=<dump>` puts an arm's decode (the scoreboard's
    // `DECODE_DUMP_OUT`) in the stored one's place, to measure a decoder change
    // on the served day before it ships.
    let decoder_head = decoder_head_segments(i, "FOLD_DECODER_HEAD")?;
    if decoder_head.is_some() {
        eprintln!("⚠ FOLD_DECODER_HEAD — an arm's decode heads this fold, not the stored one");
    }
    let stored = i
        .get("hsmmDecode")
        .filter(|d| d.as_array().is_some_and(|a| !a.is_empty()));
    let decode = decoder_head.as_ref().or(stored);
    if decode.is_some() {
        env.insert("decoderHead".into(), Value::Bool(true));
    }
    for (k, v) in encode_caches(
        decode,
        i.get("railRouteCache"),
        bus_reachable.as_ref().or_else(|| i.get("busRouteCache")),
        i.get("railStopsCache"),
    )? {
        env.insert(k, v);
    }
    // A train's stations, as the decoder's chain resolved them, onto the decode
    // `encode_caches` wrote; here and not in it, since `fold_env` pins that
    // encoder against frozen fixtures that never carried them.
    if let (Some(Value::Array(out)), Some(Value::Array(src))) = (env.get_mut("hmmDecode"), decode) {
        for (o, h) in out.iter_mut().zip(src) {
            if let (Some(o), Some(h)) = (o.as_object_mut(), h.as_object()) {
                for k in ["boardStation", "alightStation"] {
                    o.insert(k.into(), opt_str(h, k));
                }
                for k in ["boardTs", "alightTs"] {
                    o.insert(k.into(), h.get(k).cloned().unwrap_or(Value::Null));
                }
            }
        }
    }
    Ok(json!({ "trace": false, "env": env }))
}
