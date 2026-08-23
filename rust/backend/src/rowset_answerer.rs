//! Answering the day fold's misses from a pushed row set (#982).
//!
//! The converge loop asks this for a key the fold could not find. Here the
//! answer is computed from the rows a golden fixture carries, so a whole day
//! can be walked with no database — which is what makes the port checkable
//! before any of it runs against production.
//!
//! # The scoring is Lean's; this is the fan-out and the wire form
//!
//! `Verified.Geo.OsmSpatial` owns every distance, ordering and cap, and is
//! reached through the `osmspatial` serve mode. What is here is what that
//! deliberately does not do:
//!
//!   * **the feature-bucket filter** — the row set tags each row with a
//!     `featureType`, and Lean's `LineRow` has no such field on purpose;
//!   * **`nearbyWays`' fan-out** — FOUR line-bucket queries (highway, railway,
//!     waterway, aeroway) plus an aeroway POINT query, because OSM tags
//!     airports as both ways and nodes, flattened with the bucket as `type`;
//!   * **the wire form**, which is the whole reason the loop can append an
//!     answer without re-encoding it.
//!
//! # ⚠ The key parts are reused VERBATIM
//!
//! A miss arrives as the bit patterns the fold spelled it with, and the table
//! row starts with those same patterns. Parsing them to `f64` and re-encoding
//! would round-trip the float for nothing, and this port has already found one
//! place where a float round-trip through text disagreed with V8 by an ULP. The
//! parse below exists only to ASK the question; the answer is keyed by the
//! original strings.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::fitbit::tz_source::PolygonLookup;
use crate::fold_payload::{bits, default_radius_m};
use crate::lean::{self, Miss};

/// Where candidate rows come from, in the positional form `osmspatial` reads.
///
/// The two implementations differ in ONE way that matters: a fixture's row set
/// is complete by construction — it was extracted for these days — while a
/// live mirror is filled lazily and can only vouch for areas someone has
/// fetched. So a source may say it cannot answer.
///
/// ⚠ `None` MEANS DECLINE, NOT EMPTY. An empty row list is a real answer — "no
/// ways within the radius" — and returning one for an unfetched area is a claim
/// about the world. `converge` already counts a decline; it cannot count a lie.
pub trait RowSource {
    /// Line rows of one feature bucket near a point.
    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>>;
    /// Point rows of one feature bucket near a point.
    fn point_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>>;
}

/// Answers the fold's misses, whatever the rows come from.
///
/// The arms below are the part that must not be written twice: the bucket
/// fan-out, the wire form and the two tables that need no rows at all (`tzAt`,
/// `bestPlace`). Only the ROW SUPPLY differs between a fixture and a live
/// mirror, and that is what [`RowSource`] abstracts.
pub struct OsmAnswerer<S: RowSource> {
    source: S,
    /// The zone lookup, built lazily — `tzf-rs` decompresses its polygon set on
    /// construction, so a day that never asks for a zone must not pay for it.
    zones: Option<PolygonLookup>,
}

/// Answering from the row set a golden fixture carries.
///
/// A fixture's rows are complete by construction — extracted for exactly these
/// days — so this source never declines, and every `Ok(None)` a day reports
/// comes from a table with no arm rather than from missing rows.
pub type RowSetAnswerer<'a> = OsmAnswerer<RowSetSource<'a>>;

/// OSM points and lines from a fixture, each tagged with the feature bucket it
/// was fetched for.
pub struct RowSetSource<'a> {
    points: &'a [Value],
    lines: &'a [Value],
    /// Whether to drop rows that cannot be in range before shipping them.
    ///
    /// ⚠ Off only for `tests/rowset_prefilter.rs`, which exists to prove the
    /// filter changes no answer. There is no production reason to disable it,
    /// and a caller reaching for `new_unfiltered` outside that test is asking
    /// for 157,489 coordinate pairs per question.
    prefilter: bool,
}

impl<'a> OsmAnswerer<RowSetSource<'a>> {
    pub fn new(row_set: &'a Value) -> Result<Self> {
        Ok(Self {
            zones: None,
            source: RowSetSource::new(row_set)?,
        })
    }

    /// As [`RowSetAnswerer::new`], with the prefilter off. Test-only — see the
    /// field's note.
    pub fn new_unfiltered(row_set: &'a Value) -> Result<Self> {
        let mut s = Self::new(row_set)?;
        s.source.prefilter = false;
        Ok(s)
    }
}

impl<S: RowSource> OsmAnswerer<S> {
    /// Answer from any source. The row-set constructor is
    /// [`RowSetAnswerer::new`]; this is what a live mirror uses, and what
    /// `tests/row_source.rs` uses to reach the decline path a fixture's
    /// complete row set can never produce.
    pub fn with_source(source: S) -> Self {
        Self {
            source,
            zones: None,
        }
    }
}

impl<'a> RowSetSource<'a> {
    fn new(row_set: &'a Value) -> Result<Self> {
        let o = row_set.as_object().context("osmRowSet is not an object")?;
        Ok(Self {
            prefilter: true,
            points: o
                .get("points")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            lines: o
                .get("lines")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        })
    }

    /// Degrees of longitude per metre at this latitude — `mPerDegAt`'s inverse,
    /// and the same conversion Lean's `queryLines` applies to the radius.
    fn deg_radius(lat: f64, radius_m: f64) -> f64 {
        // `mPerDegAt` in Verified.Geo.OsmSpatial: 111_320 * cos(lat).
        let m_per_deg = 111_320.0 * lat.to_radians().cos();
        if m_per_deg.abs() < 1.0 {
            // Near the pole the conversion degenerates; keep everything rather
            // than compute a filter that drops rows for a numeric reason.
            return f64::INFINITY;
        }
        radius_m / m_per_deg
    }

    /// Rows of one bucket, in the `osmspatial` mode's positional form.
    ///
    /// ⚠ `coords` stay `(lat, lon)`. Lean's `lineDistDeg` reads `c.1` as the
    /// latitude and hands `(c.2, c.1)` to a distance that takes x = lon first,
    /// so the pair order here matches the fixture's and must not be "fixed".
    /// Swapping it produces distances that are wrong but entirely plausible.
    fn line_rows(&self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Vec<Value> {
        // ⚠ EXACT, not approximate. Lean compares `lineDistDeg` — a DEGREE-space
        // distance — against `radiusM / mPerDegAt(lat)`, so a way whose own
        // bounding box misses that same degree-space box cannot contain a point
        // inside the radius. Filtering here therefore drops only rows Lean would
        // have scored out, and `tests/rowset_prefilter.rs` checks that claim by
        // comparing answers rather than trusting this paragraph.
        //
        // It exists because the unfiltered version ships an entire bucket per
        // question: 26,812 highway rows and 157,489 coordinate pairs for ONE
        // coordinate, which is the shape of the mirror's job done without its
        // index.
        let d = if self.prefilter {
            Self::deg_radius(lat, radius_m)
        } else {
            f64::INFINITY
        };
        self.lines
            .iter()
            .filter_map(Value::as_object)
            .filter(|r| r.get("featureType").and_then(Value::as_str) == Some(bucket))
            .filter(|r| {
                let Some(cs) = r.get("coords").and_then(Value::as_array) else {
                    return true;
                };
                let mut min_lat = f64::INFINITY;
                let mut max_lat = f64::NEG_INFINITY;
                let mut min_lon = f64::INFINITY;
                let mut max_lon = f64::NEG_INFINITY;
                for c in cs.iter().filter_map(Value::as_array) {
                    let (Some(la), Some(lo)) = (
                        c.first().and_then(Value::as_f64),
                        c.get(1).and_then(Value::as_f64),
                    ) else {
                        // A malformed coordinate is not evidence the way is far
                        // away, so the row is kept and Lean decides.
                        return true;
                    };
                    min_lat = min_lat.min(la);
                    max_lat = max_lat.max(la);
                    min_lon = min_lon.min(lo);
                    max_lon = max_lon.max(lo);
                }
                min_lat <= lat + d && max_lat >= lat - d && min_lon <= lon + d && max_lon >= lon - d
            })
            .map(|r| {
                let coords: Vec<Value> = r
                    .get("coords")
                    .and_then(Value::as_array)
                    .map(|cs| {
                        cs.iter()
                            .filter_map(Value::as_array)
                            .filter_map(|c| Some((c.first()?.as_f64()?, c.get(1)?.as_f64()?)))
                            .map(|(lat, lon)| json!([bits(lat), bits(lon)]))
                            .collect()
                    })
                    .unwrap_or_default();
                json!([
                    r.get("osmId").cloned().unwrap_or(Value::Null),
                    r.get("subtype")
                        .cloned()
                        .unwrap_or(Value::String(String::new())),
                    r.get("name").cloned().unwrap_or(Value::Null),
                    coords
                ])
            })
            .collect()
    }

    fn point_rows(&self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Vec<Value> {
        // ⚠ POINTS ARE FILTERED IN METRES, not degrees. `queryPoints` scores
        // with `haversineAt`, so the degree box above would be the wrong shape
        // here — a generous latitude/longitude box is used instead, which can
        // only over-include.
        let d = if self.prefilter {
            Self::deg_radius(lat, radius_m).max(radius_m / 110_000.0) * 1.5
        } else {
            f64::INFINITY
        };
        self.points
            .iter()
            .filter_map(Value::as_object)
            .filter(|r| r.get("featureType").and_then(Value::as_str) == Some(bucket))
            .filter(|r| {
                let (Some(la), Some(lo)) = (
                    r.get("lat").and_then(Value::as_f64),
                    r.get("lon").and_then(Value::as_f64),
                ) else {
                    return true;
                };
                (la - lat).abs() <= d && (lo - lon).abs() <= d
            })
            .map(|r| {
                let tags: Vec<Value> = r
                    .get("tags")
                    .and_then(Value::as_object)
                    .map(|t| t.iter().map(|(k, v)| json!([k, v])).collect())
                    .unwrap_or_default();
                json!([
                    r.get("osmId").cloned().unwrap_or(Value::Null),
                    r.get("subtype")
                        .cloned()
                        .unwrap_or(Value::String(String::new())),
                    r.get("name").cloned().unwrap_or(Value::Null),
                    bits(r.get("lat").and_then(Value::as_f64).unwrap_or(f64::NAN)),
                    bits(r.get("lon").and_then(Value::as_f64).unwrap_or(f64::NAN)),
                    tags
                ])
            })
            .collect()
    }
}

/// Answering from a fixture's rows never declines: the set was extracted for
/// these days, so "no rows near here" is a real answer rather than a gap.
impl RowSource for RowSetSource<'_> {
    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        Ok(Some(RowSetSource::line_rows(
            self, bucket, lat, lon, radius_m,
        )))
    }

    fn point_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        Ok(Some(RowSetSource::point_rows(
            self, bucket, lat, lon, radius_m,
        )))
    }
}

/// One `osmspatial` call. Source-independent: the rows are already in the wire
/// form, and every distance, ordering and cap below this point is Lean's.
fn spatial(op: &str, lat: &str, lon: &str, radius: &str, rows: Vec<Value>) -> Result<Value> {
    let req = json!({
        "mode": "osmspatial", "op": op,
        "lat": lat, "lon": lon, "radiusM": radius,
        "rows": rows,
    });
    let out = lean::serve(&serde_json::to_string(&req)?)?;
    let v: Value = serde_json::from_str(&out).context("osmspatial answer is not JSON")?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        bail!("osmspatial {op}: {e}");
    }
    Ok(v)
}

/// The bit-pattern parts of a miss key, verbatim.
fn key_parts(key: &str) -> Vec<&str> {
    key.split('|').filter(|s| !s.is_empty()).collect()
}

impl<S: RowSource> crate::fold_converge::Answerer for OsmAnswerer<S> {
    fn answer(&mut self, miss: &Miss) -> Result<Option<(String, Value)>> {
        let p = key_parts(&miss.key);
        if p.len() < 2 {
            // Not a coordinate key — `stationsOnLine` is keyed by line name.
            return Ok(None);
        }
        let (lat, lon) = (p[0], p[1]);
        // ⚠ Parsed ONLY to ask the question. The wire row is keyed by the
        // original strings, so the float never round-trips back to text.
        let flat = f64::from_bits(lat.parse().unwrap_or(0));
        let flon = f64::from_bits(lon.parse().unwrap_or(0));

        match miss.what.as_str() {
            // ⚠ FOUR buckets plus the aeroway POINTS, flattened with the bucket
            // as `type`. Dropping the point query loses aerodrome markers and
            // terminals, which OSM tags as nodes rather than ways — and the
            // result would still be a well-formed, slightly emptier answer.
            "nearbyWays" => {
                let r = bits(default_radius_m::NEARBY_WAYS);
                let mut ways = Vec::new();
                // ⚠ ANY bucket the source cannot vouch for declines the WHOLE
                // answer. `nearbyWays` is one table built from five queries, so
                // answering with four of them would report the aerodrome-free
                // version of a coordinate as if it were complete.
                for bucket in ["highway", "railway", "waterway", "aeroway"] {
                    let Some(rows) =
                        self.source
                            .line_rows(bucket, flat, flon, default_radius_m::NEARBY_WAYS)?
                    else {
                        return Ok(None);
                    };
                    let v = spatial("queryLines", lat, lon, &r, rows)?;
                    push_ways(&mut ways, bucket, &v);
                }
                let Some(rows) =
                    self.source
                        .point_rows("aeroway", flat, flon, default_radius_m::NEARBY_WAYS)?
                else {
                    return Ok(None);
                };
                let v = spatial("queryPoints", lat, lon, &r, rows)?;
                push_ways(&mut ways, "aeroway", &v);
                Ok(Some((
                    "nearbyWays".into(),
                    json!([lat, lon, Value::Array(ways)]),
                )))
            }

            // Complete in Lean end to end: `NearbyStation` already carries the
            // fields the table holds, so there is no shaping here.
            "nearbyStations" => {
                let r = p.get(2).copied().unwrap_or("0");
                let Some(rows) = self
                    .source
                    .point_rows("railway", flat, flon, radius_of(r))?
                else {
                    return Ok(None);
                };
                let v = spatial("nearbyStations", lat, lon, r, rows)?;
                let rows = v.get("rows").cloned().unwrap_or_else(|| json!([]));
                Ok(Some(("nearbyStations".into(), json!([lat, lon, r, rows]))))
            }

            "linesAtPoint" => {
                let r = p.get(2).copied().unwrap_or("0");
                let Some(rows) = self.source.line_rows("railway", flat, flon, radius_of(r))? else {
                    return Ok(None);
                };
                let v = spatial("linesAtPoint", lat, lon, r, rows)?;
                let names = v.get("names").cloned().unwrap_or_else(|| json!([]));
                Ok(Some(("linesAtPoint".into(), json!([lat, lon, r, names]))))
            }

            // The venue-local zone at a coordinate. Not in the row set at all —
            // `tzAt` is a direct `tzLookup` import in the pipeline, which is why
            // `RecordingOsmAdapter` never saw it and the capture carries it
            // separately. Answered from `tzf-rs`, the same polygon set the
            // forward sync already uses.
            //
            // ⚠ A coordinate with no zone is DECLINED rather than answered with
            // a default. Mid-ocean returns nothing, and "UTC" would be a claim
            // about where the phone was.
            "tzAt" => {
                let finder = self.zones.get_or_insert_with(PolygonLookup::new);
                match finder.zone(flat, flon) {
                    Some(tz) => Ok(Some(("tzAt".into(), json!([lat, lon, tz])))),
                    None => Ok(None),
                }
            }

            // The venue-local CLOCK of a naming question — `[dayIdx, minute]`
            // per minute of the stay, plus the hour at its midpoint. Not an
            // answer to "what is this place": Lean computes the label, and what
            // it cannot compute is tzdata. `fold_payload::best_place` derives
            // the same two fields from a recorded capture; this derives them
            // from the key, which is what a serving caller has.
            //
            // ⚠ AN EMPTY ZONE IS DECLINED. The fold asks this table once before
            // `tzAt` has resolved the stay's zone and again after, so the blank
            // spelling is a question asked too early rather than a stay with no
            // zone — measured on 2026-04-29, where all 8 spans are asked twice
            // and the TypeScript recorded every one at `Europe/Amsterdam`.
            // Answering the blank one with UTC would put a second row on the
            // table for the same stay, keyed differently and scored against the
            // wrong clock.
            "bestPlace" => {
                let (Some(start), Some(end), Some(tz)) = (
                    p.get(2).and_then(|s| s.parse::<i64>().ok()),
                    p.get(3).and_then(|s| s.parse::<i64>().ok()),
                    p.get(4),
                ) else {
                    return Ok(None);
                };
                if tz.is_empty() {
                    return Ok(None);
                }
                let samples = crate::timezone::local_stay_samples(start, end, tz)?;
                let hour = crate::timezone::local_hour_of((start + end) / 2, tz)?;
                Ok(Some((
                    "bestPlace".into(),
                    json!([
                        lat,
                        lon,
                        start,
                        end,
                        tz,
                        samples
                            .iter()
                            .map(|(d, m)| json!([d, m]))
                            .collect::<Vec<_>>(),
                        hour
                    ]),
                )))
            }

            // ⚠ EVERYTHING ELSE IS DECLINED, and the reasons are NOT the same.
            // This comment used to justify `transitStops` alone, which read as
            // if the whole catch-all had been adjudicated; it had not, and that
            // is how a missing arm came to be filed as a missing lookup
            // (#1054, corrected 2026-08-22).
            //
            // `transitStops` — declined on purpose. `Verified/Geo/Bus.lean`
            // records stop resolution as INJECTED, modelled as an ordinary
            // function rather than computed from rows, so there is nothing here
            // to compute it from. An empty answer would be a coordinate with no
            // transit stops near it, which is a claim; declining is not.
            //
            // `nearbyLandmarks` — unported, and the reason is SPECIFIC: the
            // `osmspatial` scored-row ops return `{osmId, subtype, name,
            // distanceM, encloses}` and NO TAG MAP. `shapeLandmarks` spawns one
            // landmark per tag key (amenity/tourism/leisure/shop/place), so a
            // single `subtype` string cannot feed it — the table is not a
            // shaping gap, it is a gap in what the spatial op carries.
            //
            // ⚠ MEASURED COST, 2026-08-23: while this declines, a served day
            // loses 2 of 8 venue names against production — "Honest Burgers",
            // "Royal Free Hospital". The stay still renders, as "stationary"
            // with no place, which is why nothing else caught it.
            //
            // ⚠ AN ARM WAS TRIED AND REVERTED THE SAME DAY. It read the spatial
            // answer as an array when it is `{rows: [...]}`, so it shaped
            // nothing and answered `[]` for every stay — an EMPTY answer, which
            // claims "no venues here", where declining claims nothing. The day
            // came back with zero states. `Verified/Geo/Landmarks.lean` is the
            // correct shaping rule and is kept; what it still needs is a row
            // source that carries tags.
            //
            // `reverseGeocode` — never answerable from rows at all. It is a
            // Nominatim call, permanently delegated to the captured trace, and
            // its keys are coordinates the pipeline DERIVES.
            _ => Ok(None),
        }
    }
}

/// Flatten one bucket's scored rows into `nearbyWays` entries.
fn push_ways(out: &mut Vec<Value>, bucket: &str, answer: &Value) {
    for row in answer
        .get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let o = row.as_object();
        let g = |k: &str| o.and_then(|o| o.get(k)).cloned().unwrap_or(Value::Null);
        out.push(json!({
            "type": bucket,
            // The TypeScript writes `f.subtype ?? ""`, so an absent subtype is
            // the empty string rather than null.
            "subtype": match g("subtype") { Value::String(s) => Value::String(s), _ => Value::String(String::new()) },
            "name": g("name"),
            "distanceM": g("distanceM"),
        }));
    }
}

/// A radius key part, as metres.
fn radius_of(bits_str: &str) -> f64 {
    f64::from_bits(bits_str.parse().unwrap_or(0))
}
