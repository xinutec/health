//! A train ride's route on rails, and the fill that draws a route first
//! ridden today.
//!
//! A train leg is drawn on rails when its `<board> → <alight>[ · <line>]` label
//! has a `rail_route_cache` row. The nightly `refresh-rail-routes` pools three
//! weeks of rides per label; a label first ridden today would draw raw all day.
//! So a fold offers such a leg ([`offer`]), a background worker snaps it from
//! the day's fixes ([`geometry`]), and the next fold draws it on rails.
//!
//! * The nightly row wins: the fill only inserts where none exists.
//! * One snap at a time, through the fold slot: it holds up to
//!   [`RAIL_CORRIDOR_LINE_LIMIT`] ways, like a fold.
//! * A refusal is remembered for [`REFUSED_FOR`], or every fold would retry it.
//! * No Overpass from the serving pod.
//!
//! Only the serving process fills ([`start`]), so a measurement never writes
//! the cache.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::MySqlPool;

use crate::lean::FillCandidate;

/// Margin (m) around a train run's fixes when reading its rail corridor: wide
/// enough that the line and both stations fall inside the box even where the
/// fixes scatter off the track.
pub const RAIL_CORRIDOR_MARGIN_M: f64 = 1500.0;
/// The corridor read's row limit.
pub const RAIL_CORRIDOR_LINE_LIMIT: i64 = 12000;
/// How long a label the snap refused is left raw before it is tried again.
pub const REFUSED_FOR: Duration = Duration::from_secs(6 * 60 * 60);

/// `LINESTRING(lon lat, …)` → `[[latBits, lonBits], …]`, the form the rail
/// modes read. The axis swap is `mirror_source::parse_linestring_wkt`'s.
pub fn line_bits(wkt: &str) -> Vec<Value> {
    crate::mirror_source::parse_linestring_wkt(wkt)
        .into_iter()
        .map(|(lat, lon)| {
            serde_json::json!([
                crate::fold_payload::bits(lat),
                crate::fold_payload::bits(lon)
            ])
        })
        .collect()
}

/// `POINT(lon lat)` → `(lat, lon)`. ⚠ WKT is `lon lat`; swapped, no station
/// ever resolves.
pub fn parse_point_wkt(wkt: &str) -> Option<(f64, f64)> {
    let inner = wkt
        .trim()
        .strip_prefix("POINT(")
        .and_then(|s| s.strip_suffix(')'))?;
    let mut it = inner.split_whitespace();
    let lon: f64 = it.next()?.parse().ok()?;
    let lat: f64 = it.next()?.parse().ok()?;
    Some((lat, lon))
}

/// The corridor around a fix cloud, snapped: corridor-weighted first, then, if
/// the key names a line, between the stations over that line's ways (Lean's
/// `snapTrainSegmentOnLine` filters the same list). `None` leaves it raw.
pub async fn geometry(
    pool: &MySqlPool,
    key: &str,
    start_ts: f64,
    end_ts: f64,
    fixes: &[(f64, f64)],
) -> Result<Option<Vec<Value>>> {
    use sqlx::Row as _;

    if fixes.is_empty() {
        return Ok(None);
    }
    // The bbox the corridor is scanned over, padded like `corridorBox`.
    let (mut min_lat, mut max_lat) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY);
    for (la, lo) in fixes {
        min_lat = min_lat.min(*la);
        max_lat = max_lat.max(*la);
        min_lon = min_lon.min(*lo);
        max_lon = max_lon.max(*lo);
    }
    // A metres margin in degrees, longitude corrected for latitude, as
    // `corridorBox` does: a fixed degree pad narrows the corridor northward.
    let d_lat = RAIL_CORRIDOR_MARGIN_M / 111_320.0;
    let mid_lat = (min_lat + max_lat) / 2.0;
    let d_lon =
        RAIL_CORRIDOR_MARGIN_M / (111_320.0 * (mid_lat * std::f64::consts::PI / 180.0).cos());
    let (min_lat, max_lat) = (min_lat - d_lat, max_lat + d_lat);
    let (min_lon, max_lon) = (min_lon - d_lon, max_lon + d_lon);
    let poly = format!(
        "POLYGON(({min_lon} {min_lat},{max_lon} {min_lat},{max_lon} {max_lat},\
         {min_lon} {max_lat},{min_lon} {min_lat}))"
    );

    // `feature_type = 'railway'`, the mirror's bucket. `subtype` carries the
    // OSM value (rail, subway, station, …); filtering on subtype here would
    // drop the ways `isRailSubtype` is meant to judge.
    let line_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_lines \
         WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?",
    )
    .bind(&poly)
    .bind(RAIL_CORRIDOR_LINE_LIMIT)
    .fetch_all(pool)
    .await
    .context("querying the rail corridor")?;

    let mut lines: Vec<Value> = Vec::with_capacity(line_rows.len());
    for r in &line_rows {
        let wkt: String = r.try_get("wkt")?;
        let coords = line_bits(&wkt);
        if coords.len() < 2 {
            continue;
        }
        lines.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "coords": coords,
        }));
    }
    drop(line_rows);

    let station_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_points \
         WHERE feature_type = 'railway' \
           AND subtype IN ('station','halt','stop','subway_entrance','tram_stop') \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326))",
    )
    .bind(&poly)
    .fetch_all(pool)
    .await
    .context("querying rail stations")?;

    let mut stations: Vec<Value> = Vec::with_capacity(station_rows.len());
    for r in &station_rows {
        let wkt: String = r.try_get("wkt")?;
        let Some((lat, lon)) = parse_point_wkt(&wkt) else {
            continue;
        };
        stations.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "latBits": crate::fold_payload::bits(lat),
            "lonBits": crate::fold_payload::bits(lon),
        }));
    }

    // The snap is seconds of Lean on a blocking pipe: off the async threads.
    let (key, fixes) = (key.to_string(), fixes.to_vec());
    tokio::task::spawn_blocking(move || {
        for on_line in [false, true] {
            if let Some(path) =
                crate::lean::rail_snap(&key, start_ts, end_ts, &lines, &stations, &fixes, on_line)?
            {
                return Ok(Some(path));
            }
        }
        Ok(None)
    })
    .await
    .context("the rail snap task")?
}

/// Which offered labels the fill takes: not one already queued or being
/// snapped (a second fold of the day offers the same leg while the first
/// waits), and not one refused less than [`REFUSED_FOR`] ago.
#[derive(Default)]
pub struct Admission {
    pending: HashSet<String>,
    refused: HashMap<String, Instant>,
}

impl Admission {
    /// Take `key` now? Taking it marks it pending.
    pub fn admit(&mut self, key: &str, now: Instant) -> bool {
        if self
            .refused
            .get(key)
            .is_some_and(|at| now.saturating_duration_since(*at) < REFUSED_FOR)
        {
            return false;
        }
        self.pending.insert(key.to_string())
    }

    /// `key` is done; `refused` when it was left raw or failed.
    pub fn finish(&mut self, key: &str, refused: bool, now: Instant) {
        self.pending.remove(key);
        if refused {
            self.refused.insert(key.to_string(), now);
        } else {
            self.refused.remove(key);
        }
    }
}

/// The fill's queue and its admission.
struct Fill {
    tx: tokio::sync::mpsc::UnboundedSender<FillCandidate>,
    admission: Mutex<Admission>,
}

static FILL: OnceLock<Fill> = OnceLock::new();

/// Start the fill's worker. Called once, where the server starts.
pub fn start(pool: MySqlPool) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<FillCandidate>();
    if FILL
        .set(Fill {
            tx,
            admission: Mutex::new(Admission::default()),
        })
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        while let Some(c) = rx.recv().await {
            let t0 = Instant::now();
            let outcome = {
                let _slot = crate::routes::velocity::fold_slot().await;
                fill_one(&pool, &c).await
            };
            let refused = match outcome {
                Ok(Some(points)) => {
                    tracing::info!(
                        key = %c.key,
                        points,
                        ms = t0.elapsed().as_millis() as u64,
                        "rail route filled"
                    );
                    false
                }
                Ok(None) => {
                    tracing::info!(key = %c.key, fixes = c.fixes.len(), "rail route refused, left raw");
                    true
                }
                Err(e) => {
                    tracing::warn!(key = %c.key, error = %format!("{e:#}"), "rail route fill failed");
                    true
                }
            };
            let fill = FILL.get().expect("set before the worker started");
            lock(&fill.admission).finish(&c.key, refused, Instant::now());
        }
    });
}

/// Queue the legs a fold found with no route. A no-op until [`start`].
pub fn offer(candidates: Vec<FillCandidate>) {
    let Some(fill) = FILL.get() else {
        return;
    };
    let now = Instant::now();
    for c in candidates {
        if !lock(&fill.admission).admit(&c.key, now) {
            continue;
        }
        let key = c.key.clone();
        if fill.tx.send(c).is_err() {
            lock(&fill.admission).finish(&key, false, now);
        }
    }
}

/// Snap one label and insert it where no row exists; the points written, or
/// `None` when the snap refused.
async fn fill_one(pool: &MySqlPool, c: &FillCandidate) -> Result<Option<usize>> {
    let fixes: Vec<(f64, f64)> = c
        .fixes
        .iter()
        .filter_map(|(la, lo)| {
            Some((
                f64::from_bits(la.parse().ok()?),
                f64::from_bits(lo.parse().ok()?),
            ))
        })
        .collect();
    let Some(geom) = geometry(pool, &c.key, c.start_ts as f64, c.end_ts as f64, &fixes).await?
    else {
        return Ok(None);
    };
    if geom.len() < 2 {
        return Ok(None);
    }
    // Not `INSERT IGNORE`: that also swallows a key too long for the column,
    // truncating it into a row no leg's label ever matches.
    sqlx::query(
        "INSERT INTO rail_route_cache (route_key, geometry_json) VALUES (?, ?) \
         ON DUPLICATE KEY UPDATE route_key = route_key",
    )
    .bind(&c.key)
    .bind(serde_json::to_string(&geom)?)
    .execute(pool)
    .await
    .with_context(|| format!("inserting rail route {}", c.key))?;
    Ok(Some(geom.len()))
}

/// A poisoned lock still holds a usable admission: each update is one set or
/// map operation, so a panic cannot leave one half-written.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
