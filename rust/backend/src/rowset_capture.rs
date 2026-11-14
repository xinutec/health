//! Recording what the answerer asked the mirror, as an `osmRowSet`, so a recent
//! day can become a gate. `osm_trace` records the matcher reads; this records
//! the rows the answerer serves its tables from.
//!
//! It wraps any [`RowSource`] and delegates, so it sees what production asked
//! and got. It converts `MirrorSource`'s positional rows to the fixture's object
//! form, so the proof is that the day replays the same, not that keys match.
//! Declines are recorded too (`RowSetSource::declined`): dropping them would
//! replay the day better than production and bless the gap away.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde_json::{Value, json};

use crate::rowset_answerer::{LinesByBucket, RowSource, decline_key};

/// Bits-as-decimal-string back to the double it came from.
fn unbits(v: Option<&Value>) -> Option<f64> {
    Some(f64::from_bits(v?.as_str()?.parse().ok()?))
}

/// `[[k, v], …]` back to an object.
fn tags_obj(v: Option<&Value>) -> Value {
    let mut m = serde_json::Map::new();
    for kv in v.and_then(Value::as_array).into_iter().flatten() {
        if let Some(a) = kv.as_array()
            && let (Some(k), Some(val)) = (a.first().and_then(Value::as_str), a.get(1))
        {
            m.insert(k.to_string(), val.clone());
        }
    }
    Value::Object(m)
}

/// What a capture accumulates, shared with the caller.
///
/// ⚠ `OsmAnswerer`'s `source` must stay private: a second `MirrorSource` built
/// on a runtime worker aborts the process. The caller reads this after the fold.
#[derive(Default)]
pub struct Recorded {
    /// Deduplicated by `(featureType, osmId)` — a day asks about ~90
    /// coordinates and the same way is near many of them.
    lines: BTreeMap<(String, i64), Value>,
    points: BTreeMap<(String, i64), Value>,
    all_names: Option<Vec<String>>,
    fetched_names: Vec<String>,
    rail_ways: Vec<Value>,
    stations: Option<Vec<Value>>,
    declined: Vec<String>,
    /// Geocodes the source answered, keyed `lat|lon|zoom` in plain decimals,
    /// the format the older fixtures use, so a captured section is diffable
    /// against them.
    geocodes: BTreeMap<String, Value>,
}

/// A [`RowSource`] that answers from `inner` and remembers everything.
pub struct RecordingSource<S: RowSource> {
    inner: S,
    rec: Arc<Mutex<Recorded>>,
}

impl<S: RowSource> RecordingSource<S> {
    /// The source, and the handle the caller keeps to read the result.
    pub fn new(inner: S) -> (Self, Arc<Mutex<Recorded>>) {
        let rec = Arc::new(Mutex::new(Recorded::default()));
        (
            Self {
                inner,
                rec: Arc::clone(&rec),
            },
            rec,
        )
    }

    fn rec(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.rec
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Recorded {
    /// How many map rows the source served — lines, points and rail ways.
    pub fn served_rows(&self) -> usize {
        self.lines.len() + self.points.len() + self.rail_ways.len()
    }

    /// The `osmRowSet` a fixture carries.
    pub fn row_set(&self) -> Value {
        json!({
            // Shape only: nothing reads it; emitted empty so captures diff
            // cleanly against older fixtures.
            "coverage": Value::Object(serde_json::Map::new()),
            "points": self.points.values().cloned().collect::<Vec<_>>(),
            "lines": self.lines.values().cloned().collect::<Vec<_>>(),
            "railLines": json!({
                "allNames": self.all_names.clone().unwrap_or_default(),
                "fetchedNames": self.fetched_names,
                "ways": self.rail_ways,
                "stations": self.stations.clone().unwrap_or_default(),
            }),
            "declined": self.declined,
        })
    }

    /// The `osmTrace.reverseGeocode` section, or `None` when the source
    /// answered no geocode. Absent (could not answer) and empty (asked, got
    /// nothing) grade differently.
    pub fn geocode_section(&self) -> Option<Value> {
        if self.geocodes.is_empty() {
            return None;
        }
        Some(Value::Object(
            self.geocodes
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ))
    }

    fn record_lines(&mut self, bucket: &str, rows: &[Value]) {
        for r in rows {
            let Some(a) = r.as_array() else { continue };
            let Some(osm_id) = a.first().and_then(Value::as_i64) else {
                continue;
            };
            let coords: Vec<Value> = a
                .get(3)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    let p = c.as_array()?;
                    Some(json!([unbits(p.first())?, unbits(p.get(1))?]))
                })
                .collect();
            self.lines.insert(
                (bucket.to_string(), osm_id),
                json!({
                    "osmId": osm_id,
                    "featureType": bucket,
                    "subtype": a.get(1).cloned().unwrap_or(Value::Null),
                    "name": a.get(2).cloned().unwrap_or(Value::Null),
                    "coords": coords,
                    "tags": tags_obj(a.get(4)),
                }),
            );
        }
    }

    fn record_points(&mut self, bucket: &str, rows: &[Value]) {
        for r in rows {
            let Some(a) = r.as_array() else { continue };
            let Some(osm_id) = a.first().and_then(Value::as_i64) else {
                continue;
            };
            // A point with no coordinates travels as NaN bits, which JSON
            // turns into a missing key that `RowSetSource` keeps. Drop it: it
            // answers no proximity question.
            let (Some(lat), Some(lon)) = (unbits(a.get(3)), unbits(a.get(4))) else {
                continue;
            };
            if !lat.is_finite() || !lon.is_finite() {
                continue;
            }
            self.points.insert(
                (bucket.to_string(), osm_id),
                json!({
                    "osmId": osm_id,
                    "featureType": bucket,
                    "subtype": a.get(1).cloned().unwrap_or(Value::Null),
                    "name": a.get(2).cloned().unwrap_or(Value::Null),
                    "lat": lat,
                    "lon": lon,
                    "tags": tags_obj(a.get(5)),
                }),
            );
        }
    }
}

impl<S: RowSource> RowSource for RecordingSource<S> {
    // The three matcher reads forward. The trait default declines, which
    // would decline every read during capture. `RecordingAnswerer` records the
    // answers; a `None` here replays as absence.
    fn walkable_roads(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        self.inner.walkable_roads(lat, lon, radius_m)
    }

    fn drivable_roads(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        self.inner.drivable_roads(lat, lon, radius_m)
    }

    fn buildings_near(&mut self, lat: f64, lon: f64, radius_m: f64) -> Result<Option<Value>> {
        self.inner.buildings_near(lat, lon, radius_m)
    }

    fn line_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        let got = self.inner.line_rows(bucket, lat, lon, radius_m)?;
        match &got {
            Some(rows) => self.rec().record_lines(bucket, rows),
            None => self
                .rec()
                .declined
                .push(decline_key("line_rows", bucket, lat, lon, radius_m)),
        }
        Ok(got)
    }

    /// Overridden because `MirrorSource` answers four buckets in one query;
    /// the default would ask the mirror a different question than production.
    fn line_rows_multi(
        &mut self,
        buckets: &[&str],
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<LinesByBucket>> {
        let got = self.inner.line_rows_multi(buckets, lat, lon, radius_m)?;
        match &got {
            Some(by_bucket) => {
                for (bucket, rows) in by_bucket {
                    self.rec().record_lines(bucket, rows);
                }
            }
            None => {
                // The mirror declines a whole batch when it cannot vouch for
                // one bucket, so the replay declines each bucket.
                for b in buckets {
                    self.rec()
                        .declined
                        .push(decline_key("line_rows", b, lat, lon, radius_m));
                }
                self.rec().declined.push(decline_key(
                    "line_rows_multi",
                    &buckets.join(","),
                    lat,
                    lon,
                    radius_m,
                ));
            }
        }
        Ok(got)
    }

    fn point_rows(
        &mut self,
        bucket: &str,
        lat: f64,
        lon: f64,
        radius_m: f64,
    ) -> Result<Option<Vec<Value>>> {
        let got = self.inner.point_rows(bucket, lat, lon, radius_m)?;
        match &got {
            Some(rows) => self.rec().record_points(bucket, rows),
            None => self
                .rec()
                .declined
                .push(decline_key("point_rows", bucket, lat, lon, radius_m)),
        }
        Ok(got)
    }

    fn rail_line_names(&mut self) -> Result<Option<Vec<String>>> {
        let got = self.inner.rail_line_names()?;
        if let Some(names) = &got {
            self.rec().all_names = Some(names.clone());
        }
        Ok(got)
    }

    /// Re-asked one name at a time: the production answer is flattened
    /// coordinates, while a fixture's `railLines.ways` is `{name, coords}` per
    /// way, filtered by name on replay. N queries instead of one, on a path run
    /// once per captured day.
    fn rail_ways_named(&mut self, names: &[String]) -> Result<Option<Vec<Value>>> {
        let got = self.inner.rail_ways_named(names)?;
        if got.is_some() {
            for name in names {
                if self.rec().fetched_names.iter().any(|n| n == name) {
                    continue;
                }
                self.rec().fetched_names.push(name.clone());
                let one = std::slice::from_ref(name);
                if let Some(ways) = self.inner.rail_ways_named(one)? {
                    for w in ways {
                        let coords: Vec<Value> = w
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| {
                                let p = c.as_array()?;
                                Some(json!([unbits(p.first())?, unbits(p.get(1))?]))
                            })
                            .collect();
                        if !coords.is_empty() {
                            self.rec()
                                .rail_ways
                                .push(json!({"name": name, "coords": coords}));
                        }
                    }
                }
            }
        }
        Ok(got)
    }

    /// Forwarded: `RowSource` declines geocodes by default, which would make a
    /// capture look like a day without geocodes.
    fn geocode(&mut self, lat: f64, lon: f64, zoom: i64) -> Result<Option<Value>> {
        let found = self.inner.geocode(lat, lon, zoom)?;
        if let Some(answer) = &found {
            // Plain decimals, as older fixtures have: `fold_payload::geocode_table`
            // converts on the way in, and bits would parse to ~4.6e18.
            self.rec()
                .geocodes
                .insert(format!("{lat}|{lon}|{zoom}"), answer.clone());
        }
        Ok(found)
    }

    fn rail_stations(&mut self) -> Result<Option<Vec<Value>>> {
        let got = self.inner.rail_stations()?;
        if let Some(rows) = &got {
            self.rec().stations = Some(
                rows.iter()
                    .filter_map(|st| {
                        let o = st.as_object()?;
                        Some(json!({
                            "name": o.get("name")?.as_str()?,
                            "lat": unbits(o.get("latBits"))?,
                            "lon": unbits(o.get("lonBits"))?,
                        }))
                    })
                    .collect(),
            );
        }
        Ok(got)
    }
}
