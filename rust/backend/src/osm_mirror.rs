//! The base OSM mirror's WRITE half — the Overpass fetch that fills
//! `osm_lines`, `osm_points` and `osm_coverage` (#1658).
//!
//! Port of the retired TypeScript `osm-local.ts`'s `fetchAndStore` half; the
//! READ half is [`crate::mirror_source`]. Until this existed nothing in the tree
//! wrote those three tables: the mirror was a dead snapshot of whatever the
//! TypeScript had left, and ground it had never fetched stayed blank for good.
//!
//! # Recovered, not reinvented
//!
//! The tag filters, the bucket precedence and the WKT shapes below are lifted
//! from `06346bd^:src/geo/osm-local.ts` rather than derived afresh. The rows
//! those queries wrote are STILL IN PRODUCTION, and a query of a different shape
//! would write rows that disagree with their neighbours — a mirror half-filled
//! by two different definitions of `highway` is worse than one half-empty.
//!
//! # A fetch is OUT OF BAND, and that is what lifts the TypeScript's box limit
//!
//! `ensureCovered` fetched INSIDE the velocity request, in a 512 MiB pod, which
//! is why buildings were pinned to a 500 m half-width — a 10 km box of London
//! footprints was a volume bomb on the serving path (#255). This runs in the
//! drain beside the pod ([`crate::fetch_drain`]), with no request waiting on it
//! and its own memory, so the box is sized to the QUESTION instead: see
//! [`half_width_for`], the one deliberate departure from the TypeScript.

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use sqlx::MySqlPool;

/// One degree of latitude, in metres.
///
/// ⚠ The MIRROR's constant, not the Kalman filter's `111_320`. Both exist and
/// they are not interchangeable: this one decides which queries count as
/// covered, and `Verified.Geo.OsmCoverage.METERS_PER_DEG_LAT` is its authority.
const METERS_PER_DEG_LAT: f64 = 111_000.0;

fn meters_per_deg_lon(lat: f64) -> f64 {
    METERS_PER_DEG_LAT * lat.to_radians().cos()
}

/// A fetched bounding box, in degrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

/// The default coverage-box half-width — 5 km, so one fetch covers a
/// neighbourhood rather than a few hundred metres of travel.
pub const DEFAULT_HALF_WIDTH_M: f64 = 5000.0;

/// The TypeScript's building half-width, kept as the FLOOR rather than the cap.
///
/// Buildings are dense enough that a 10 km box is millions of footprints, so a
/// building fetch still starts small — but see [`half_width_for`] for why it no
/// longer stops there.
pub const BUILDING_HALF_WIDTH_M: f64 = 500.0;

/// The largest box any one question may provoke, per bucket.
///
/// ⚠ A QUESTION LARGER THAN THIS IS REFUSED, not silently under-fetched.
/// [`crate::lean::osm_covered`] asks whether the search disc lies inside SOME
/// SINGLE box — boxes do not union — so a fetch smaller than the question leaves
/// that question uncovered, and it is asked again on the next fold, forever. A
/// visible refusal with a reason is the honest end of that.
///
/// The numbers are measured, not chosen: over the golden days of 2026-09 the
/// walk disc (`walkableRoads` and `buildingsNear`, which share it) had p50
/// 369 m, p95 940 m and max 1832 m, and no other lookup exceeded 800 m.
pub const MAX_HALF_WIDTH_M: f64 = 20_000.0;
pub const MAX_BUILDING_HALF_WIDTH_M: f64 = 2_500.0;

/// How wide a box to fetch for a question of this radius in this bucket.
///
/// ⚠ **THE ONE PLACE THIS DEPARTS FROM THE TYPESCRIPT**, and the departure is
/// forced. `fetchBboxAround` centred a FIXED half-width on the query point, so a
/// question whose radius exceeded it could never be satisfied by its own fetch —
/// on the serving path that merely meant the enrichment was skipped, but a drain
/// that re-queues the same key on every pass is an unbounded loop against a
/// two-slot public endpoint.
///
/// `MARGIN` is what keeps the answer stable against the difference between this
/// module's degree conversion and the one the coverage gate applies: the gate
/// converts the radius with `min(METERS_PER_DEG_LAT, metersPerDegLon)`, which is
/// the larger half-width of the two, so a box sized exactly to the radius can
/// come back a hair short.
pub fn half_width_for(bucket: &str, radius_m: f64) -> Result<f64> {
    const MARGIN: f64 = 1.10;
    let (floor_m, cap_m) = if bucket == "building" {
        (BUILDING_HALF_WIDTH_M, MAX_BUILDING_HALF_WIDTH_M)
    } else {
        (DEFAULT_HALF_WIDTH_M, MAX_HALF_WIDTH_M)
    };
    let want = (radius_m * MARGIN).max(floor_m);
    if want > cap_m {
        bail!(
            "a {bucket} question of radius {radius_m:.0} m needs a {want:.0} m half-width, \
             past the {cap_m:.0} m cap — fetching less would leave the question uncovered \
             and re-queued on every fold"
        );
    }
    Ok(want)
}

/// The box to fetch when `(lat, lon)` is uncovered: centred on the point,
/// extending `half_width_m` metres in each cardinal direction.
#[must_use]
pub fn fetch_bbox_around(lat: f64, lon: f64, half_width_m: f64) -> Bbox {
    let d_lat = half_width_m / METERS_PER_DEG_LAT;
    let d_lon = half_width_m / meters_per_deg_lon(lat);
    Bbox {
        min_lat: lat - d_lat,
        max_lat: lat + d_lat,
        min_lon: lon - d_lon,
        max_lon: lon + d_lon,
    }
}

/// The tag filters that land in each bucket, verbatim from the TypeScript.
///
/// ⚠ ONE FETCH BRINGS BOTH SHAPES. `railway` asks for stations (nodes) AND rail
/// lines (ways) in the same query, because the bucket is the OSM tag namespace
/// rather than a geometry kind — which is also why a caller cannot know in
/// advance whether a bucket writes to `osm_points`, `osm_lines` or both.
fn filters_for(feature_type: &str) -> Option<&'static [&'static str]> {
    Some(match feature_type {
        "railway" => &[
            r#"node["railway"~"^(station|subway_entrance|halt|stop|tram_stop)$"]"#,
            r#"way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]"#,
        ],
        "highway" => &[
            r#"way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|footway|cycleway|path|pedestrian|track)$"]"#,
        ],
        "aeroway" => &[r#"node["aeroway"]"#, r#"way["aeroway"]"#],
        "waterway" => &[r#"way["waterway"]"#],
        "transit_stop" => &[r#"node["highway"~"^(bus_stop|traffic_signals)$"]"#],
        "landmark" => &[
            r#"node["amenity"]"#,
            r#"node["shop"]"#,
            r#"node["tourism"]"#,
            r#"node["leisure"]"#,
            r#"way["amenity"]"#,
            r#"way["shop"]"#,
            r#"way["tourism"]"#,
            r#"way["leisure"]"#,
        ],
        "building" => &[r#"way["building"]"#],
        _ => return None,
    })
}

/// Every bucket this module can fetch. The drain walks them in this order.
pub const BUCKETS: [&str; 7] = [
    "highway",
    "railway",
    "landmark",
    "transit_stop",
    "building",
    "waterway",
    "aeroway",
];

/// The Overpass query body for one bucket over a box.
///
/// ⚠ Overpass writes a bbox `(south, west, north, east)`, which is
/// `(minLat, minLon, maxLat, maxLon)` — not the `(lon, lat)` order WKT uses
/// three functions away in this same file.
///
/// `venue_tags` is [`crate::lean::venue_tags`]: the landmark fetch also asks for
/// the NAMED features with those tags, which [`parse_element`] files as
/// landmarks.
pub fn overpass_query(
    feature_type: &str,
    bbox: &Bbox,
    venue_tags: &[(String, Vec<String>)],
) -> Result<String> {
    let Some(filters) = filters_for(feature_type) else {
        bail!("no Overpass filter is defined for feature_type={feature_type}");
    };
    let mut filters: Vec<String> = filters.iter().map(|f| (*f).to_string()).collect();
    if feature_type == "landmark" {
        for (key, values) in venue_tags.iter().filter(|(_, vs)| !vs.is_empty()) {
            for kind in ["node", "way"] {
                filters.push(format!(
                    r#"{kind}["{key}"~"^({})$"]["name"]"#,
                    values.join("|")
                ));
            }
        }
    }
    let b = format!(
        "{},{},{},{}",
        bbox.min_lat, bbox.min_lon, bbox.max_lat, bbox.max_lon
    );
    let stanzas = filters
        .iter()
        .map(|f| format!("  {f}({b});"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "[out:json][timeout:25];\n(\n{stanzas}\n);\nout tags geom;"
    ))
}

/// Tag precedence for the bucket a fetched element lands in.
///
/// ⚠ ORDER IS THE RULE, not a list. A way tagged both `highway` and `railway`
/// buckets under the FIRST match, and railway wins because the rail signal is
/// rarer and more informative. A plain building falls through to `building`
/// only because every venue tag above it missed — a building that is also a shop
/// was already kept as a landmark.
const FEATURE_TYPE_RULES: [(&str, &str); 7] = [
    ("aeroway", "aeroway"),
    ("railway", "railway"),
    ("highway", "highway"),
    ("waterway", "waterway"),
    ("amenity", "landmark"),
    ("shop", "landmark"),
    ("tourism", "landmark"),
];

/// The rest of the precedence list. Split only because a fixed-size array is
/// clearer than a slice here and `leisure`/`building` are the two that need the
/// comment above to be read first.
const FEATURE_TYPE_RULES_TAIL: [(&str, &str); 2] =
    [("leisure", "landmark"), ("building", "building")];

/// Highway-tagged NODES that are furniture rather than road.
///
/// ⚠ Their own bucket, so a road-way lookup never mixes with them: a vehicle
/// dwelling repeatedly AT bus stops is a bus, and dwelling at signals is any
/// road vehicle, which is the evidence #328's discriminator reads.
const TRANSIT_STOP_HIGHWAY_SUBTYPES: [&str; 2] = ["bus_stop", "traffic_signals"];

/// One parsed OSM element, ready for `osm_points` or `osm_lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feature {
    pub osm_id: i64,
    pub osm_type: String,
    pub feature_type: String,
    pub subtype: Option<String>,
    pub name: Option<String>,
    pub tags_json: String,
    /// `POINT(lon lat)` or `LINESTRING(lon lat, …)`.
    pub geom_wkt: String,
}

impl Feature {
    /// Which table this row belongs in. A node is a point, a way is a line.
    #[must_use]
    pub fn is_point(&self) -> bool {
        self.osm_type == "node"
    }
}

/// Translate one Overpass element, or `None` when it carries no tag we bucket
/// or no usable geometry.
///
/// ⚠ A RELATION IS DROPPED. `out tags geom` returns them for some filters and
/// neither geometry table can hold one; the TypeScript dropped them too, so a
/// mirror written here matches the rows already in production.
#[must_use]
///
/// `venue_tags` is [`crate::lean::venue_tags`]: a NAMED feature with one of
/// those tags and no venue tag of its own is a landmark — a hotel mapped as the
/// building alone (2026-10-01), a beach (2026-10-03).
pub fn parse_element(el: &Value, venue_tags: &[(String, Vec<String>)]) -> Option<Feature> {
    let kind = el.get("type")?.as_str()?;
    let id = el.get("id")?.as_i64()?;
    let empty = Map::new();
    let tags = el.get("tags").and_then(Value::as_object).unwrap_or(&empty);
    let tag = |k: &str| tags.get(k).and_then(Value::as_str);

    // Furniture first: these carry `highway=` and must not land in the road
    // bucket. Nodes only — a way tagged `highway=bus_stop` is not a stop.
    let (feature_type, subtype) = if kind == "node"
        && tag("highway").is_some_and(|h| TRANSIT_STOP_HIGHWAY_SUBTYPES.contains(&h))
    {
        ("transit_stop", tag("highway"))
    } else {
        let hit = FEATURE_TYPE_RULES
            .iter()
            .chain(FEATURE_TYPE_RULES_TAIL.iter())
            .find(|(t, _)| tag(t).is_some());
        // A venue rule that spoke keeps the element (a shop with a footprint is
        // the shop); otherwise a named feature with a venue tag is a landmark,
        // and that is the only way a `natural=` element is kept at all.
        let spoke = hit.is_some_and(|(_, ft)| *ft == "landmark");
        let venue = tag("name").and(
            venue_tags
                .iter()
                .find(|(k, vs)| tag(k).is_some_and(|v| vs.iter().any(|x| x == v))),
        );
        match (spoke, venue, hit) {
            (false, Some((k, _)), _) => ("landmark", tag(k)),
            (_, _, Some(h)) => (h.1, tag(h.0)),
            (_, _, None) => return None,
        }
    };

    let geom_wkt = match kind {
        "node" => {
            let (lat, lon) = (el.get("lat")?.as_f64()?, el.get("lon")?.as_f64()?);
            format!("POINT({lon} {lat})")
        }
        "way" => {
            let pts = el.get("geometry")?.as_array()?;
            // ⚠ A single-vertex way is DROPPED, not stored: `LINESTRING` with one
            // point is invalid and MariaDB rejects the whole 500-row batch.
            if pts.len() < 2 {
                return None;
            }
            let coords = pts
                .iter()
                .map(|p| {
                    let lat = p.get("lat")?.as_f64()?;
                    let lon = p.get("lon")?.as_f64()?;
                    Some(format!("{lon} {lat}"))
                })
                .collect::<Option<Vec<_>>>()?
                .join(",");
            format!("LINESTRING({coords})")
        }
        _ => return None,
    };

    Some(Feature {
        osm_id: id,
        osm_type: kind.to_string(),
        feature_type: feature_type.to_string(),
        subtype: subtype.map(str::to_string),
        // ⚠ `ref` is the fallback, and it is what names a motorway: the A41 has
        // no `name`. Dropping it would leave every trunk road anonymous.
        name: tag("name").or_else(|| tag("ref")).map(str::to_string),
        tags_json: Value::Object(tags.clone()).to_string(),
        geom_wkt,
    })
}

/// How many rows go into one INSERT. The TypeScript's number.
const UPSERT_BATCH: usize = 500;

/// Bulk-upsert features into one geometry table. Returns rows written.
///
/// ⚠ `feature_type` FOLLOWS THE PARSE on a duplicate key. `parse_element` files
/// an element from its tags alone, whichever bucket's query returned it, so a
/// re-fetch that files a row differently is a rule that changed (or OSM that
/// did), and the row must move with it: the Gare Montparnasse halls were
/// fetched as buildings on 2026-10-01, `building=train_station` joined the venue
/// tags on 10-03, and the landmark fetch that returned them left them buildings
/// — invisible to every landmark reader (#1891).
///
/// ⚠ WRITTEN OUT TWICE, points and lines, for `DL-SQLX-SCHEMA-TRUTH`'s reason:
/// SQL that reaches the driver through a variable cannot be checked against the
/// schema, and a table name is not something to parameterise.
pub async fn upsert_features(pool: &MySqlPool, features: &[Feature]) -> Result<u64> {
    let mut written = 0;
    for chunk in features.chunks(UPSERT_BATCH) {
        let (points, lines): (Vec<_>, Vec<_>) = chunk.iter().partition(|f| f.is_point());
        written += upsert_points(pool, &points).await?;
        written += upsert_lines(pool, &lines).await?;
    }
    Ok(written)
}

/// The `(?, ?, ?, ?, ?, ?, ST_GeomFromText(?, 4326))` tuples for `n` rows.
fn value_tuples(n: usize) -> String {
    std::iter::repeat_n("(?, ?, ?, ?, ?, ?, ST_GeomFromText(?, 4326))", n)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Bind one feature's seven columns, in the order [`value_tuples`] writes them.
fn bind_feature<'q>(
    q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    f: &'q Feature,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    q.bind(f.osm_id)
        .bind(&f.osm_type)
        .bind(&f.feature_type)
        .bind(&f.subtype)
        .bind(&f.name)
        .bind(&f.tags_json)
        .bind(&f.geom_wkt)
}

async fn upsert_points(pool: &MySqlPool, features: &[&Feature]) -> Result<u64> {
    if features.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "INSERT INTO osm_points (osm_id, osm_type, feature_type, subtype, name, tags_json, geom) \
         VALUES {} ON DUPLICATE KEY UPDATE feature_type = VALUES(feature_type), \
         subtype = VALUES(subtype), name = VALUES(name), \
         tags_json = VALUES(tags_json), geom = VALUES(geom)",
        value_tuples(features.len())
    );
    // ⚠ `AssertSqlSafe`: audited — the only interpolation is the fixed
    // `(?, …)` tuple run, whose length comes from `features.len()`. Every
    // VALUE is bound.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for f in features {
        q = bind_feature(q, f);
    }
    let out = q.execute(pool).await.context("upserting osm_points")?;
    Ok(out.rows_affected())
}

async fn upsert_lines(pool: &MySqlPool, features: &[&Feature]) -> Result<u64> {
    if features.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "INSERT INTO osm_lines (osm_id, osm_type, feature_type, subtype, name, tags_json, geom) \
         VALUES {} ON DUPLICATE KEY UPDATE feature_type = VALUES(feature_type), \
         subtype = VALUES(subtype), name = VALUES(name), \
         tags_json = VALUES(tags_json), geom = VALUES(geom)",
        value_tuples(features.len())
    );
    // ⚠ `AssertSqlSafe`: see [`upsert_points`].
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for f in features {
        q = bind_feature(q, f);
    }
    let out = q.execute(pool).await.context("upserting osm_lines")?;
    Ok(out.rows_affected())
}

/// Record that a box has been fetched for a bucket, under `vocab` when the
/// bucket's boxes are keyed by one ([`vocab_for`]).
///
/// ⚠ WRITTEN LAST, after the rows are in. A coverage row is a PROMISE that the
/// area can be answered from the mirror; writing it before the features would
/// make a crash mid-insert look like a fetched area with no roads in it, which
/// is the shape #976 is about.
pub async fn record_coverage(
    pool: &MySqlPool,
    feature_type: &str,
    bbox: &Bbox,
    vocab: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO osm_coverage (min_lat, max_lat, min_lon, max_lon, feature_type, vocab) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(bbox.min_lat)
    .bind(bbox.max_lat)
    .bind(bbox.min_lon)
    .bind(bbox.max_lon)
    .bind(feature_type)
    .bind(vocab)
    .execute(pool)
    .await
    .context("recording an osm_coverage box")?;
    Ok(())
}

/// The queue's key vocabulary, from the crate that owns the queue. Re-exported
/// so this module reads as one thing: the drain below is its only other caller.
pub use crate::fetch_queue::{parse_queue_key, queue_key, queue_kind};

/// The bucket a queue `kind` names, or `None` when it is not one of ours.
#[must_use]
pub fn bucket_of(kind: &str) -> Option<&str> {
    let b = kind.strip_prefix("osm_")?;
    BUCKETS.contains(&b).then_some(b)
}

/// The bucket whose boxes depend on the venue-tag vocabulary.
pub const VOCAB_BUCKET: &str = "landmark";

/// A short, stable name for a venue-tag vocabulary: 64-bit FNV-1a of the tags
/// in their served order, as 16 hex digits.
///
/// ⚠ THE VOCABULARY IS PART OF A LANDMARK BOX'S IDENTITY, like its bucket. A
/// box fetched when `VENUE_TAGS` lacked `building=train_station` holds no
/// station buildings, and the gate cannot tell that from "there are none": the
/// day would be served without them for `COVERAGE_FRESH_DAYS`. So the box is
/// recorded with the vocabulary that fetched it, and a read under another one
/// does not see it — the next fold declines, the drain fetches, the old row
/// keeps its date (#1891, 2026-10-03).
/// Bumped when what a landmark fetch FILES changes without the tag list
/// changing — a parse or upsert rule — so the boxes fetched under the old
/// filing stop counting. 2: `feature_type` follows the parse on a duplicate key.
pub const FILING_VERSION: u8 = 2;

#[must_use]
pub fn venue_vocab(venue_tags: &[(String, Vec<String>)]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: &[u8]| {
        for &x in b {
            h ^= u64::from(x);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    eat(&[FILING_VERSION]);
    for (k, vs) in venue_tags {
        eat(k.as_bytes());
        eat(b"=");
        for v in vs {
            eat(v.as_bytes());
            eat(b",");
        }
        eat(b";");
    }
    format!("{h:016x}")
}

/// The vocabulary a bucket's boxes are read and written under: the venue
/// vocabulary for [`VOCAB_BUCKET`], none for every other bucket.
#[must_use]
pub fn vocab_for<'a>(bucket: &str, venue_vocab: &'a str) -> Option<&'a str> {
    (bucket == VOCAB_BUCKET).then_some(venue_vocab)
}

/// Every fresh coverage box for one bucket, so a drain can ask the same gate
/// the serving path asks. `vocab` is [`vocab_for`] the bucket: when `Some`,
/// only boxes recorded under it count.
///
/// ⚠ `CAST(… AS CHAR)` then `str::parse`, for [`crate::mirror_source`]'s
/// reason: these columns are `DECIMAL(9,6)` and sqlx will not hand a DECIMAL
/// back as an `f64`. The first loader in this crate to get that wrong decoded
/// 117 places to centroid 0.0 and still printed OK.
pub async fn coverage_rows(
    pool: &MySqlPool,
    feature_type: &str,
    vocab: Option<&str>,
) -> Result<Vec<crate::lean::CoverageRow>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT CAST(min_lat AS CHAR) AS min_lat, CAST(max_lat AS CHAR) AS max_lat, \
            CAST(min_lon AS CHAR) AS min_lon, CAST(max_lon AS CHAR) AS max_lon, \
            CAST(UNIX_TIMESTAMP(fetched_at) AS SIGNED) AS fetched_s \
         FROM osm_coverage WHERE feature_type = ? AND (? IS NULL OR vocab = ?)",
    )
    .bind(feature_type)
    .bind(vocab)
    .bind(vocab)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading osm_coverage for {feature_type}"))?;
    rows.iter()
        .map(|r| {
            let f = |name: &str| -> Result<f64> {
                r.try_get::<String, _>(name)
                    .with_context(|| format!("osm_coverage.{name} is not a string"))?
                    .trim()
                    .parse::<f64>()
                    .with_context(|| format!("osm_coverage.{name} does not parse"))
            };
            Ok(crate::lean::CoverageRow {
                min_lat: f("min_lat")?,
                max_lat: f("max_lat")?,
                min_lon: f("min_lon")?,
                max_lon: f("max_lon")?,
                // A row with no fetch time is FRESH, not stale — see
                // `decideCoverage`. Mapping it to 0 re-fetches the whole mirror.
                fetched_at: r.try_get::<Option<i64>, _>("fetched_s")?.map(|s| s * 1000),
            })
        })
        .collect()
}
