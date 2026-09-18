//! Recording what the answerer asked the mirror, as an `osmRowSet` (#1660).
//!
//! ⚠ **WHY: nothing has written one since the TypeScript went (#975).** The
//! corpus froze at 2026-08-13, so no recent day could become a gate — and
//! recent days are where the defects are (#1658, #1659). `capture_trace` did
//! the three `@[extern]` callback sections; this is the other half, the rows
//! the ANSWERER serves its seven tables from.
//!
//! It wraps any [`RowSource`] and delegates, so the capture sees exactly what
//! production asked and got, rather than a second copy of the queries.
//!
//! ⚠ **THE TWO SIDES ARE DIFFERENT SHAPES and that is where a wrong fixture
//! comes from.** `MirrorSource` answers in `osmspatial`'s POSITIONAL form —
//! `[osmId, subtype, name, coords(bits), tags]` — while a fixture's
//! `osmRowSet.lines` holds OBJECTS with plain floats and a `featureType` the
//! positional form does not carry. This converts, which means the proof cannot
//! be "the keys match": it has to be that the DAY comes out the same.
//!
//! ⚠ **AND IT RECORDS THE DECLINES.** Where the mirror cannot vouch for an area
//! it answers `None`, and a row set that dropped that would replay the day
//! better than production runs it — 108 keys on 2026-09-06, the whole of
//! #1658's defect, blessed away. See `RowSetSource::declined`.

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

/// What a capture accumulates. Shared with the caller, which is the whole
/// reason it is split out.
///
/// ⚠ `OsmAnswerer`'s `source` is PRIVATE AND MUST STAY SO — handing it out
/// would let a caller build a second `MirrorSource` on a runtime worker, which
/// aborts the process. So the recorder does not need an accessor on the
/// answerer: it shares this, and the caller reads it once the fold is done.
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
    /// The `osmRowSet` a fixture carries.
    pub fn row_set(&self) -> Value {
        json!({
            // ⚠ Kept for shape only: nothing reads it, and the DECLINES below
            // are what actually reproduce a gap. Emitting an empty list rather
            // than omitting it keeps a captured fixture diffable against the 42
            // the TypeScript made.
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
            // ⚠ A point with no coordinates travels as the NaN bit pattern, and
            // `serde_json` cannot hold a NaN — it would serialise as `null` and
            // come back as a MISSING key, which `RowSetSource` reads as "keep
            // this row" rather than "this row is nowhere". Drop it instead: a
            // row that cannot say where it is answers no proximity question.
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

    /// ⚠ NOT LEFT TO THE DEFAULT. The trait's default composes `line_rows` per
    /// bucket, which would record correctly — but `MirrorSource` OVERRIDES this
    /// with one query for four buckets, and a wrapper that fell back to the
    /// default would ask the mirror a different question than production does.
    /// The point of wrapping is to see what production sees.
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
                // ⚠ A batched decline is a decline for EVERY bucket in it — the
                // mirror declines the whole answer when it cannot vouch for one
                // — so the replay has to decline each of them individually, and
                // it will be asked individually if anything ever stops batching.
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

    /// ⚠ **THE NAMES HAVE TO BE RE-ASKED ONE AT A TIME, and that is not an
    /// oversight.** This returns bare coordinate arrays — the geometry of ALL
    /// the named ways, flattened — while a fixture's `railLines.ways` is
    /// `{name, coords}` per way, and `RowSetSource` filters it BY NAME. A
    /// capture that recorded the flat answer could not label it, and a replay
    /// would match nothing and answer every rail question empty.
    ///
    /// So the recorded mapping is built with one call per name. That is N
    /// queries where production makes one; it is a CAPTURE path, run once per
    /// day being captured, and correctness is worth more than its round trips.
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
