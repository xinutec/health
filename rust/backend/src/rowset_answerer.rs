//! Answering the day fold's asks from a pushed row set (a golden fixture's, or
//! the mirror's), so a day folds with no database.
//!
//! `Verified.Geo.OsmSpatial` owns every distance, ordering and cap; this side
//! does what it does not: the feature-bucket filter, `nearbyWays`' fan-out
//! (four line buckets plus aeroway points, flattened with the bucket as
//! `type`), and the wire form. Key parts are reused verbatim as the fold's bit
//! patterns, since a float round-tripped through text can differ by an ULP.

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::fold_payload::{bits, default_radius_m};
use crate::lean::{self, Ask};
use crate::tz_lookup::PolygonLookup;

/// Line rows grouped by the feature bucket they came from.
///
/// The bucket becomes each way's `type` downstream, so it travels with its
/// rows; a list positional by request order would mislabel ways whenever the
/// database returned an `IN` list in another order.
pub type LinesByBucket = Vec<(String, Vec<Value>)>;

/// Where candidate rows come from, in the positional form `osmspatial` reads. A
/// fixture is complete; a live mirror vouches only for fetched areas.
///
/// ⚠ `None` means decline, not empty. An empty list claims "no ways here",
/// which for an unfetched area is a lie the fold cannot count.
pub trait RowSource {
    /// The walkable ways within a disc as the fold reads them. `None` declines;
    /// only the mirror answers (a replay uses its recorded trace).
    fn walkable_roads(&mut self, _lat: f64, _lon: f64, _radius_m: f64) -> Result<Option<Value>> {
        Ok(None)
    }

    /// As [`walkable_roads`](Self::walkable_roads), for the road matcher.
    fn drivable_roads(&mut self, _lat: f64, _lon: f64, _radius_m: f64) -> Result<Option<Value>> {
        Ok(None)
    }

    /// Building outlines within a disc, as rings of bit-pattern pairs.
    fn buildings_near(&mut self, _lat: f64, _lon: f64, _radius_m: f64) -> Result<Option<Value>> {
        Ok(None)
    }

    /// Line rows of one feature bucket near a point.
    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>>;
    /// Line rows of several buckets in one query, grouped by bucket. The bucket
    /// is returned, never inferred, since it becomes every way's `type`. `None`
    /// if any bucket cannot be vouched for. The default is the plain loop, so
    /// batched and looped paths cannot drift.
    fn line_rows_multi(
        &mut self,
        buckets: &[&str],
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<LinesByBucket>> {
        let mut out = Vec::with_capacity(buckets.len());
        for b in buckets {
            let Some(rows) = self.line_rows(b, lat, lon, radius_m)? else {
                return Ok(None);
            };
            out.push(((*b).to_string(), rows));
        }
        Ok(Some(out))
    }

    /// Point rows of one feature bucket near a point.
    fn point_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>>;

    /// Every distinct railway line name. A line's track is every name containing
    /// its base token, and `LIKE '%base%'` cannot use the index, so the match
    /// runs against this list and the fetch stays an indexed `name IN (…)`.
    fn rail_line_names(&mut self) -> Result<Option<Vec<String>>>;

    /// The geometry of the named railway ways, as `[[latBits, lonBits], …]`.
    fn rail_ways_named(&mut self, names: &[String]) -> Result<Option<Vec<Value>>>;

    /// Every railway station point, as `{name, latBits, lonBits}`.
    ///
    /// Order is part of the answer: the proximity filter keeps input order
    /// and journey resolution reads positions out of the result.
    fn rail_stations(&mut self) -> Result<Option<Vec<Value>>>;

    /// One reverse geocode in `osmTrace.reverseGeocode`'s shape, or `None`.
    /// Declining is the default: a geocode is a Nominatim call, and the corpus
    /// replay grades a day only against its recorded trace.
    fn geocode(&mut self, _lat: f64, _lon: f64, _zoom: i64) -> Result<Option<Value>> {
        Ok(None)
    }
}

/// Answers the fold's misses from any row source: the bucket fan-out, the wire
/// form and the row-free tables (`tzAt`, `bestPlace`) are written once.
pub struct OsmAnswerer<S: RowSource> {
    source: S,
}

/// The zone lookup, built once per process: `tzf-rs` takes ~190 ms to
/// decompress its polygons.
static ZONES: std::sync::OnceLock<PolygonLookup> = std::sync::OnceLock::new();

/// Answering from a golden fixture's row set, complete by construction: it
/// declines only where the capture recorded a decline.
pub type RowSetAnswerer<'a> = OsmAnswerer<RowSetSource<'a>>;

/// OSM points and lines from a fixture, each tagged with the feature bucket it
/// was fetched for.
pub struct RowSetSource<'a> {
    points: &'a [Value],
    lines: &'a [Value],
    /// The rail-line set a fixture carries (`railLines`), when it has one.
    rail: Option<&'a serde_json::Map<String, Value>>,
    /// Whether to drop rows that cannot be in range before shipping them.
    ///
    /// Off only for `tests/suite/rowset_prefilter.rs`, which proves the filter
    /// changes no answer; unfiltered, a question ships a whole bucket.
    prefilter: bool,
    /// The questions the mirror declined when this row set was captured, so a
    /// replay reproduces gaps as well as rows (else a fixture day beats
    /// production). Absent means no record; such fixtures answer everything.
    declined: std::collections::HashSet<String>,
}

/// The key a decline is recorded under: method, bucket and question, at full
/// precision so it matches the question actually asked.
pub fn decline_key(method: &str, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> String {
    format!("{method}|{bucket}|{lat}|{lon}|{radius_m}")
}

impl<'a> OsmAnswerer<RowSetSource<'a>> {
    pub fn new(row_set: &'a Value) -> Result<Self> {
        Ok(Self {
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
    /// The venues near a point from this answerer's source. `source` stays
    /// private: the mirror may only be touched from a blocking thread
    /// (`with_mirror_answerer`), and one built on a runtime worker aborts.
    pub fn nearby_landmarks(&mut self, lat: f64, lon: f64) -> Result<Option<Value>> {
        nearby_landmarks(&mut self.source, lat, lon)
    }

    /// The ways near a point — the free [`nearby_ways`] against this answerer's
    /// own row source. Same reason as above: `source` is private and must stay
    /// so, because the mirror may only be touched from a blocking thread.
    pub fn nearby_ways(&mut self, lat: f64, lon: f64) -> Result<Option<Vec<Value>>> {
        nearby_ways(&mut self.source, lat, lon)
    }

    /// The stations serving a line as `[name, latBits, lonBits]`, from the
    /// fold's own code. `Ok(None)` is "could not answer"; `Ok(Some(vec![]))` is
    /// a line with no stations. Flattening them puts every place off a line.
    pub fn stations_serving(&mut self, line: &str) -> Result<Option<Vec<Value>>> {
        let Some(answer) = self.stations_on_line(line)? else {
            return Ok(None);
        };
        Ok(Some(
            answer
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ))
    }
}

impl<S: RowSource> OsmAnswerer<S> {
    /// Answer from any source: a live mirror, or a test reaching the decline
    /// path a fixture cannot produce. Fixtures use [`RowSetAnswerer::new`].
    pub fn with_source(source: S) -> Self {
        Self { source }
    }
}

impl<'a> RowSetSource<'a> {
    fn new(row_set: &'a Value) -> Result<Self> {
        let o = row_set.as_object().context("osmRowSet is not an object")?;
        Ok(Self {
            prefilter: true,
            declined: o
                .get("declined")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            rail: o.get("railLines").and_then(Value::as_object),
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

    /// Rows of one bucket in `osmspatial`'s positional form. `coords` stay
    /// `(lat, lon)`, as `lineDistDeg` reads them; swapped, distances are wrong
    /// but plausible.
    fn line_rows(&self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Vec<Value> {
        // Exact: Lean compares a degree-space distance against the radius in
        // degrees, so a way whose box misses the degree box cannot be in range
        // (`tests/suite/rowset_prefilter.rs`). Unfiltered, one question ships a
        // whole bucket.
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
                // Position 4, the tag map, from which `nearbyLandmarks` spawns a
                // landmark per key. A four-element row parses with an empty map,
                // which silently loses every building tag.
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
                    coords,
                    tags
                ])
            })
            .collect()
    }

    fn point_rows(&self, bucket: &str, lat: f64, lon: f64, radius_m: f64) -> Vec<Value> {
        // Points are filtered in metres: `queryPoints` scores with
        // `haversineAt`, so a generous lat/lon box is used, which can only
        // over-include.
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
                // A point with no lat/lon encodes as the NaN bit pattern, which
                // `bits` transports exactly; the array is positional and the
                // peer expects a number here.
                // dev-lint: allow-nan-sentinel
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

/// Answering from a fixture's rows declines only where the capture recorded a
/// mirror decline (`declined`). Elsewhere the set is complete by construction,
/// so "no rows near here" is a real answer.
impl RowSource for RowSetSource<'_> {
    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        if self
            .declined
            .contains(&decline_key("line_rows", bucket, lat, lon, radius_m))
        {
            return Ok(None);
        }
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
        if self
            .declined
            .contains(&decline_key("point_rows", bucket, lat, lon, radius_m))
        {
            return Ok(None);
        }
        Ok(Some(RowSetSource::point_rows(
            self, bucket, lat, lon, radius_m,
        )))
    }

    fn rail_line_names(&mut self) -> Result<Option<Vec<String>>> {
        // Absent is a decline: a fixture captured before `railLines` existed
        // cannot answer, and an empty list would say the line has no track.
        let Some(rail) = self.rail else {
            return Ok(None);
        };
        Ok(Some(
            rail.get("allNames")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        ))
    }

    fn rail_ways_named(&mut self, names: &[String]) -> Result<Option<Vec<Value>>> {
        let Some(rail) = self.rail else {
            return Ok(None);
        };
        let want: std::collections::HashSet<&str> = names.iter().map(String::as_str).collect();
        Ok(Some(
            rail.get("ways")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|w| {
                    w.get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|n| want.contains(n))
                })
                .map(|w| {
                    Value::Array(
                        w.get("coords")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|c| {
                                let a = c.as_array()?;
                                Some(json!([
                                    bits(a.first()?.as_f64()?),
                                    bits(a.get(1)?.as_f64()?)
                                ]))
                            })
                            .collect(),
                    )
                })
                .collect(),
        ))
    }

    fn rail_stations(&mut self) -> Result<Option<Vec<Value>>> {
        let Some(rail) = self.rail else {
            return Ok(None);
        };
        Ok(Some(
            rail.get("stations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|st| {
                    Some(json!({
                        "name": st.get("name")?.as_str()?,
                        "latBits": bits(st.get("lat")?.as_f64()?),
                        "lonBits": bits(st.get("lon")?.as_f64()?),
                    }))
                })
                .collect(),
        ))
    }
}

impl<S: RowSource> OsmAnswerer<S> {
    /// The stations a named rail line serves: match the name (Lean), fetch the
    /// geometry (SQL), filter by proximity (Lean). A line matching nothing gets
    /// an empty list, not a decline, which the fold would re-ask forever.
    fn stations_on_line(&mut self, line: &str) -> Result<Option<Value>> {
        let Some(all_names) = self.source.rail_line_names()? else {
            return Ok(None);
        };
        let matched = crate::lean::line_names_matching(line, &all_names)?;
        if matched.is_empty() {
            return Ok(Some(json!([line, []])));
        }
        let Some(ways) = self.source.rail_ways_named(&matched)? else {
            return Ok(None);
        };
        if ways.is_empty() {
            return Ok(Some(json!([line, []])));
        }
        let Some(stations) = self.source.rail_stations()? else {
            return Ok(None);
        };
        let served = crate::lean::filter_stations_by_line_proximity(&stations, &ways)?;
        Ok(Some(json!([line, served])))
    }
}

/// Nanoseconds spent in Lean scoring rows, the other half of the fold's cost
/// beside [`crate::mirror_source::take_db_nanos`]: measured, so the fold's
/// time is not guessed to be the database's.
static LEAN_NANOS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Read the accumulated Lean scoring time and reset it.
pub fn take_lean_nanos() -> u64 {
    LEAN_NANOS.swap(0, std::sync::atomic::Ordering::Relaxed)
}

/// The venues near a point, shaped: `nearbyLandmarks` at the default radius,
/// shared by serving and `refresh-focus-places`. `Ok(None)` means could not
/// answer, not "no venues".
pub fn nearby_landmarks(source: &mut dyn RowSource, lat: f64, lon: f64) -> Result<Option<Value>> {
    let radius = crate::fold_payload::default_radius_m::NEARBY_LANDMARKS;
    let r = crate::fold_payload::bits(radius);
    let Some(point_rows) = source.point_rows("landmark", lat, lon, radius)? else {
        return Ok(None);
    };
    let Some(line_rows) = source.line_rows("landmark", lat, lon, radius)? else {
        return Ok(None);
    };
    let lat_s = crate::fold_payload::bits(lat);
    let lon_s = crate::fold_payload::bits(lon);
    let points = spatial("queryPoints", &lat_s, &lon_s, &r, point_rows)?;
    let lines = spatial("queryLines", &lat_s, &lon_s, &r, line_rows)?;
    Ok(Some(crate::lean::shape_landmarks(&points, &lines)?))
}

/// The ways near a point: the five-query `nearbyWays` fan-out, shared with
/// `decode-day`. Any bucket the source cannot vouch for declines the whole
/// answer, or a coordinate would lose its aerodromes.
pub fn nearby_ways(source: &mut dyn RowSource, lat: f64, lon: f64) -> Result<Option<Vec<Value>>> {
    let radius = default_radius_m::NEARBY_WAYS;
    let r = bits(radius);
    let lat_s = bits(lat);
    let lon_s = bits(lon);
    let mut ways = Vec::new();
    // One query for the four line buckets, with the bucket coming back as a
    // column; inferred, every way would get the same label.
    let Some(by_bucket) = source.line_rows_multi(
        &["highway", "railway", "waterway", "aeroway"],
        lat,
        lon,
        radius,
    )?
    else {
        return Ok(None);
    };
    for (bucket, rows) in by_bucket {
        let v = spatial("queryLines", &lat_s, &lon_s, &r, rows)?;
        push_ways(&mut ways, &bucket, &v);
    }
    // OSM tags airports as nodes as well as ways; dropping this loses aerodrome
    // markers and terminals, and the result would still look complete.
    let Some(rows) = source.point_rows("aeroway", lat, lon, radius)? else {
        return Ok(None);
    };
    let v = spatial("queryPoints", &lat_s, &lon_s, &r, rows)?;
    push_ways(&mut ways, "aeroway", &v);
    Ok(Some(ways))
}

/// The transit stops near a point, as `[{subtype, distanceM}]`, from the
/// `transit_stop` feature type. One query, so no partial answer.
pub fn nearby_transit_stops(
    source: &mut dyn RowSource,
    lat: f64,
    lon: f64,
    radius: f64,
) -> Result<Option<Value>> {
    let Some(rows) = source.point_rows("transit_stop", lat, lon, radius)? else {
        return Ok(None);
    };
    let answer = spatial("queryPoints", &bits(lat), &bits(lon), &bits(radius), rows)?;
    // `{rows: [...]}`, not a bare array: read as one, it shapes nothing and
    // answers `[]`, claiming there is no transit here.
    let shaped: Vec<Value> = answer
        .get("rows")
        .and_then(Value::as_array)
        .context("osmspatial queryPoints answered without `rows`")?
        .iter()
        .map(|r| {
            json!({
                // Two fields only: `Bus.TransitStop` is `{subtype, distanceM}`
                // and Lean's parser reads exactly those.
                "subtype": r.get("subtype").cloned().unwrap_or(Value::Null),
                "distanceM": r.get("distanceM").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Some(Value::Array(shaped)))
}

/// One `osmspatial` call. Source-independent: the rows are already in the wire
/// form, and every distance, ordering and cap below this point is Lean's.
fn spatial(op: &str, lat: &str, lon: &str, radius: &str, rows: Vec<Value>) -> Result<Value> {
    let req = json!({
        "mode": "osmspatial", "op": op,
        "lat": lat, "lon": lon, "radiusM": radius,
        "rows": rows,
    });
    // Serialisation is inside the timer: a `nearbyWays` query ships thousands
    // of coordinate pairs, and that cost belongs to this half.
    let t0 = std::time::Instant::now();
    let body = serde_json::to_string(&req)?;
    let out = lean::serve(&body);
    LEAN_NANOS.fetch_add(
        t0.elapsed().as_nanos() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    let out = out?;
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

impl<S: RowSource> crate::lean::Answerer for OsmAnswerer<S> {
    fn answer(&mut self, miss: &Ask) -> Result<Option<Value>> {
        // The whole answer — SQL, shaping, scoring, the coverage gate — under
        // `answer.<table>`, so the fold's ledger can be read beside Lean's own
        // `ask.<table>.wait`: what is left between the two is the pipe.
        let t0 = std::time::Instant::now();
        let out = self.answer_inner(miss);
        crate::fold::LEDGER.charge(
            &format!("answer.{}", miss.what),
            t0.elapsed().as_nanos() as u64,
        );
        out
    }
}

impl<S: RowSource> OsmAnswerer<S> {
    fn answer_inner(&mut self, miss: &Ask) -> Result<Option<Value>> {
        // Before the coordinate-key guard: `stationsOnLine` is keyed by a
        // bare line name with no `|`, so `key_parts` would drop it.
        if miss.what == "stationsOnLine" {
            return self.stations_on_line(&miss.key);
        }
        // The three matcher reads, keyed `latBits|lonBits|radiusBits`. A row
        // set carries no arm for them — a replay answers them from the recorded
        // trace — so only a source that implements them (the mirror) does.
        if crate::fold::OSM_READS.contains(&miss.what.as_str()) {
            let p = key_parts(&miss.key);
            let (Some(lat), Some(lon), Some(r)) = (
                p.first().map(|s| key_f64(s)).transpose()?,
                p.get(1).map(|s| key_f64(s)).transpose()?,
                p.get(2).map(|s| key_f64(s)).transpose()?,
            ) else {
                return Ok(None);
            };
            return match miss.what.as_str() {
                "walkableRoads" => self.source.walkable_roads(lat, lon, r),
                "drivableRoads" => self.source.drivable_roads(lat, lon, r),
                _ => self.source.buildings_near(lat, lon, r),
            };
        }
        let p = key_parts(&miss.key);
        if p.len() < 2 {
            // Not a coordinate key, and not a table with an arm.
            return Ok(None);
        }
        let (lat, lon) = (p[0], p[1]);
        // Parsed only to ask the question; the wire row is keyed by the
        // original strings.
        let flat = key_f64(lat)?;
        let flon = key_f64(lon)?;

        match miss.what.as_str() {
            // Four buckets plus the aeroway points (aerodromes are also OSM
            // nodes), via the `nearby_ways` that `decode-day` shares. `lat`/`lon`
            // go back as the fold's bit-pattern strings.
            "nearbyWays" => {
                let Some(ways) = nearby_ways(&mut self.source, flat, flon)? else {
                    return Ok(None);
                };
                Ok(Some(json!([lat, lon, Value::Array(ways)])))
            }

            // Complete in Lean end to end: `NearbyStation` already carries the
            // fields the table holds, so there is no shaping here.
            "nearbyStations" => {
                let r = p.get(2).copied().unwrap_or("0");
                let Some(rows) = self.source.point_rows("railway", flat, flon, key_f64(r)?)? else {
                    return Ok(None);
                };
                let v = spatial("nearbyStations", lat, lon, r, rows)?;
                let rows = v.get("rows").cloned().unwrap_or_else(|| json!([]));
                Ok(Some(json!([lat, lon, r, rows])))
            }

            "linesAtPoint" => {
                let r = p.get(2).copied().unwrap_or("0");
                let Some(rows) = self.source.line_rows("railway", flat, flon, key_f64(r)?)? else {
                    return Ok(None);
                };
                let v = spatial("linesAtPoint", lat, lon, r, rows)?;
                let names = v.get("names").cloned().unwrap_or_else(|| json!([]));
                Ok(Some(json!([lat, lon, r, names])))
            }

            // The venue-local zone at a coordinate, from `tzf-rs`. No zone
            // (mid-ocean) is declined: "UTC" would be a claim.
            "tzAt" => {
                let finder = ZONES.get_or_init(PolygonLookup::new);
                match finder.zone(flat, flon) {
                    Some(tz) => Ok(Some(json!([lat, lon, tz]))),
                    None => Ok(None),
                }
            }

            // The venue-local clock of a naming question: `[dayIdx, minute]` per
            // stay minute plus the midpoint hour, from the key. An empty zone is
            // declined: the fold also asks before `tzAt` resolves, and a UTC
            // answer would add a row scored against the wrong clock.
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
                Ok(Some(json!([
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
                ])))
            }

            // Venues near a stay, from points and building outlines; either
            // declining declines the answer. The spatial answer is `{rows}`, and
            // read as a bare array it claims "no venues" for every stay.
            "nearbyLandmarks" => {
                // The same `nearby_landmarks` the focus cron calls.
                let r = bits(default_radius_m::NEARBY_LANDMARKS);
                let Some(shaped) = nearby_landmarks(&mut self.source, flat, flon)? else {
                    return Ok(None);
                };
                // Four elements, `[lat, lon, RADIUS, answer]`: the three-element
                // form reads as malformed and the fold produces no states. The
                // radius comes from the key, so a non-default ask is honoured.
                let key_radius = p.get(2).map_or_else(|| r.clone(), |s| (*s).to_string());
                Ok(Some(json!([lat, lon, key_radius, shaped])))
            }

            // Stops and entrances near a dwell, for `annotateBusEvidence`, at
            // the key's radius (`Bus.TRANSIT_QUERY_RADIUS_M`).
            "transitStops" => {
                let radius = match p.get(2) {
                    Some(s) => key_f64(s)?,
                    None => crate::fold_payload::default_radius_m::NEARBY_TRANSIT_STOPS,
                };
                let Some(shaped) = nearby_transit_stops(&mut self.source, flat, flon, radius)?
                else {
                    return Ok(None);
                };
                let key_radius = p.get(2).map_or_else(|| bits(radius), |s| (*s).to_string());
                Ok(Some(json!([lat, lon, key_radius, shaped])))
            }

            // Not computed from rows: only a source with a geocode cache
            // answers. `fold_payload::encode_geocode` encodes this and the
            // recorded section alike.
            "reverseGeocode" => {
                // The zoom is a plain integer in the key, not a bit pattern;
                // parsed as bits it would ask for zoom 8.9e-323.
                let zoom = p
                    .get(2)
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(crate::fold_payload::NOMINATIM_DEFAULT_ZOOM as i64);
                let Some(found) = self.source.geocode(flat, flon, zoom)? else {
                    return Ok(None);
                };
                Ok(Some(json!([
                    lat,
                    lon,
                    zoom,
                    crate::fold_payload::encode_geocode(&found)
                ])))
            }

            // Everything else is declined.
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
            // An absent subtype is the empty string, not null.
            "subtype": match g("subtype") { Value::String(s) => Value::String(s), _ => Value::String(String::new()) },
            "name": g("name"),
            "distanceM": g("distanceM"),
        }));
    }
}

/// A key part as the `f64` its bit pattern spells. The fold writes keys from
/// bit patterns, so one that is not is a fold defect: asking the mirror at
/// (0, 0) instead would record "nothing here" as an answer.
fn key_f64(bits_str: &str) -> Result<f64> {
    Ok(f64::from_bits(bits_str.parse::<u64>().with_context(
        || format!("a key part {bits_str:?} is not an IEEE-754 bit pattern"),
    )?))
}
