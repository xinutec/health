//! May the mirror be read here? — the gate in front of the three `@[extern]`
//! OSM lookups (#1667).
//!
//! # The question this answers
//!
//! A spatial query over an area nobody has ever fetched returns no rows, and
//! that is byte-for-byte what an area with no roads in it returns. Reading the
//! mirror without asking first therefore turns "I have never looked here" into
//! "there is nothing here" — a claim about the world, which is health #976 and
//! the reason `Verified.Geo.OsmCoverage` exists.
//!
//! # ⚠ THE RULE IS NOT RESTATED HERE
//!
//! `decideCoverage`'s five rules — the conservative box, ONE row containing it
//! (boxes do NOT union), inclusive ends, staleness applied before containment, a
//! missing `fetchedAt` counting as FRESH — live in Lean and are reached through
//! `health_osm_covered`, the `@[export]` in `DayEntry.OsmHost`. This module
//! gathers the rows, asks, and records what came back. A second copy of the
//! decision in Rust is precisely the drift `scripts/rules-live-in-lean.sh`
//! refuses.
//!
//! # Recorded, not fetched
//!
//! An uncovered question is written to `osm_fetch_queue` and a job fetches it
//! later. Fetching inline would put an Overpass round trip inside a fold that
//! already costs ~27 s on a heavy day (health #1071) — the same trade
//! `MirrorSource` makes on the serving path, for the same reason.

#![expect(unsafe_code, reason = "FFI onto the Lean host library")]

use std::collections::HashMap;
use std::os::raw::c_void;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sqlx::Row;

// As in `osm.rs`: what is unchecked is the DECLARATION — that this symbol
// really has this signature in the linked Lean code.
//
// ⚠ `ask` is CONSUMED. Lean's calling convention has the callee own its boxed
// arguments, so the buffer must not be touched or freed afterwards.
unsafe extern "C" {
    fn health_osm_covered(lat: f64, lon: f64, radius_m: f64, ask: *mut c_void) -> u8;
}

/// `Int64::MIN`, which no real timestamp is — `OsmHost.NO_FETCH_TIME`.
///
/// ⚠ A row with no fetch time is FRESH, not stale: legacy data from before
/// fetch times were tracked. Sending `0` instead would make every one of them
/// older than the cutoff and re-fetch the whole mirror.
pub const NO_FETCH_TIME: i64 = i64::MIN;

/// One `osm_coverage` row, in the shape the ask wants.
///
/// `fetched_at_ms` is [`NO_FETCH_TIME`] for a row written before fetch times
/// were tracked — `Option` would be the natural Rust shape and the wire has no
/// room for one, so the sentinel is the shape on both sides.
#[derive(Clone, Copy)]
pub struct CoverageBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    pub fetched_at_ms: i64,
}

/// How long a bucket's boxes are reused before being read again.
///
/// ⚠ NOT a correctness knob, and deliberately short. The drain WRITES coverage
/// rows, and a long-lived server that cached them forever would keep declining
/// ground it had just been given — which would re-record the same keys and make
/// `asked_count` a count of the cache's age. A day's fold asks this hundreds of
/// times and the table is small, so one read per minute is the whole cost.
const BOXES_TTL: Duration = Duration::from_secs(60);

type Boxes = HashMap<String, (Instant, Vec<CoverageBox>)>;

fn boxes_cache() -> &'static Mutex<Boxes> {
    static C: OnceLock<Mutex<Boxes>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The ask buffer `health_osm_covered` decodes — see `DayEntry.OsmHost` for the
/// layout, which is defined THERE and read here.
///
/// ⚠ `pub` so a test can drive [`decide`] without a database. The encoder and
/// the decoder are two implementations of one layout, and the only way to know
/// they agree is to run a value through both.
pub fn encode_ask(has_local: bool, now_ms: i64, boxes: &[CoverageBox]) -> Vec<u8> {
    let mut b = Vec::with_capacity(13 + boxes.len() * 40);
    b.push(u8::from(has_local));
    b.extend_from_slice(&now_ms.to_le_bytes());
    b.extend_from_slice(&(boxes.len() as u32).to_le_bytes());
    for r in boxes {
        b.extend_from_slice(&r.min_lat.to_le_bytes());
        b.extend_from_slice(&r.max_lat.to_le_bytes());
        b.extend_from_slice(&r.min_lon.to_le_bytes());
        b.extend_from_slice(&r.max_lon.to_le_bytes());
        b.extend_from_slice(&r.fetched_at_ms.to_le_bytes());
    }
    b
}

/// Ask Lean: do these boxes cover the disc?
///
/// ⚠ CALLS INTO LEAN FROM INSIDE A LEAN CALLBACK on the serving path — the fold
/// invoked the lookup that invoked this. `osmCovered` is pure, allocates only
/// its decode and runs on this same thread, so the nesting is an ordinary call
/// rather than a re-entrant task.
///
/// `ask` is handed over and not touched again.
pub fn decide(
    lat: f64,
    lon: f64,
    radius_m: f64,
    has_local: bool,
    now_ms: i64,
    boxes: &[CoverageBox],
) -> bool {
    if !crate::lean_ready() {
        // ⚠ A SIGSEGV OTHERWISE. `health_osm_covered` is Lean code, and calling
        // it before the runtime is up crashes the process rather than failing.
        // Declining is the conservative answer and it is LOUD: a process that
        // reads the mirror without Lean is misconfigured, and the alternative
        // reading — silently deciding "covered" — would answer from a mirror
        // whose coverage was never checked.
        eprintln!(
            "coverage: the Lean runtime is not up, so the gate cannot be asked \
             — declining. Call day_shell::init_lean() (or, in the backend, \
             lean::init()) before reaching the mirror."
        );
        return false;
    }
    let buf = encode_ask(has_local, now_ms, boxes);
    let ask = crate::osm::mk_bytes(&buf);
    // SAFETY: `ask` is a live Lean `ByteArray` this call takes ownership of, and
    // the three leading arguments are unboxed doubles.
    unsafe { health_osm_covered(lat, lon, radius_m, ask) != 0 }
}

/// The boxes fetched for one bucket, from the cache or from the table.
///
/// `None` is "the table could not be read", which is not "no boxes": the first
/// makes every question decline, the second makes them decline for a reason.
///
/// ⚠ `pub` so a test can read a REAL `osm_coverage` and check that it decodes.
/// Nothing here can be wrong in a way a database-free test would see — the
/// column types only refuse against real rows — and a silent decode failure
/// here declines the whole mirror.
pub fn boxes_for(bucket: &str) -> Option<Vec<CoverageBox>> {
    if let Ok(c) = boxes_cache().lock()
        && let Some((at, rows)) = c.get(bucket)
        && at.elapsed() < BOXES_TTL
    {
        return Some(rows.clone());
    }

    let bucket_owned = bucket.to_string();
    let rows = crate::mirror::with_pool(move |pool| {
        Box::pin(async move {
            // ⚠ **`CAST(… AS CHAR)`, NOT THE BARE COLUMN.** These are numeric
            // columns, and sqlx's MySQL driver refuses a `DECIMAL` as an `f64`
            // or a `String` — a failure that only appears against REAL rows, so
            // it passes every test without a database. `UNIX_TIMESTAMP` returns
            // `DECIMAL` for the same reason and needs the same treatment.
            //
            // Casting to text and parsing HERE also keeps the rounding in
            // `str::parse`, which is correctly rounded, rather than in MariaDB.
            // `MirrorSource::coverage_rows` reads the same table this way and
            // says what it cost to learn: the first Rust loader in this repo to
            // get it wrong decoded 117 places to centroid 0.0 and printed OK.
            let rows = sqlx::query(
                "SELECT CAST(min_lat AS CHAR) AS min_lat, \
                    CAST(max_lat AS CHAR) AS max_lat, \
                    CAST(min_lon AS CHAR) AS min_lon, \
                    CAST(max_lon AS CHAR) AS max_lon, \
                    CAST(UNIX_TIMESTAMP(fetched_at) AS SIGNED) AS fetched_s \
                 FROM osm_coverage WHERE feature_type = ?",
            )
            .bind(&bucket_owned)
            .fetch_all(pool)
            .await?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                // ⚠ A ROW THAT WILL NOT PARSE IS AN ERROR, never a row quietly
                // dropped. Dropping would shrink the coverage set, and a
                // shrunken coverage set declines ground that IS fetched — the
                // whole mirror would read as unfetched and every walk would
                // draw raw, with nothing to see it happen.
                let f = |n: &str| -> Result<f64, sqlx::Error> {
                    r.try_get::<String, _>(n)?
                        .trim()
                        .parse::<f64>()
                        .map_err(|e| sqlx::Error::Decode(Box::new(e)))
                };
                out.push(CoverageBox {
                    min_lat: f("min_lat")?,
                    max_lat: f("max_lat")?,
                    min_lon: f("min_lon")?,
                    max_lon: f("max_lon")?,
                    fetched_at_ms: r
                        .try_get::<Option<i64>, _>("fetched_s")?
                        .map_or(NO_FETCH_TIME, |s| s * 1000),
                });
            }
            Ok(out)
        })
    })?;

    if let Ok(mut c) = boxes_cache().lock() {
        c.insert(bucket.to_string(), (Instant::now(), rows.clone()));
    }
    Some(rows)
}

/// Is there ANY row of this bucket in the area the reader would read?
///
/// ⚠ `osm_lines` ONLY, unlike `MirrorSource`'s two-table probe. These three
/// callbacks read `osm_lines` and nothing else, so points in the area would
/// license a read of a table that still has nothing — which is the manufactured
/// emptiness this gate exists to stop.
fn has_local_data(bucket: &str, poly: &str) -> bool {
    let bucket_owned = bucket.to_string();
    let poly_owned = poly.to_string();
    let probed = crate::mirror::with_pool(move |pool| {
        Box::pin(async move {
            let hit = sqlx::query(
                "SELECT 1 FROM osm_lines WHERE feature_type = ? \
                 AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT 1",
            )
            .bind(&bucket_owned)
            .bind(&poly_owned)
            .fetch_optional(pool)
            .await?;
            Ok(hit.is_some())
        })
    });
    match probed {
        Some(v) => v,
        // ⚠ SAID OUT LOUD. `with_pool` already counted the failure, but a probe
        // that could not run is not a probe that found nothing: treating the two
        // alike would decline ground that has data, and the decline would look
        // exactly like honest unfetched ground in the queue.
        None => {
            eprintln!("coverage: the local-data probe for {bucket} could not run");
            false
        }
    }
}

/// Note that this question went unanswered, so a drain can fetch it.
///
/// ⚠ BEST EFFORT, and never a reason to fail a fold — see `fetch_queue`.
fn record(bucket: &str, lat: f64, lon: f64, radius_m: f64) {
    let kind = crate::fetch_queue::queue_kind(bucket);
    let key = crate::fetch_queue::queue_key(lat, lon, radius_m);
    crate::mirror::with_pool(move |pool| {
        Box::pin(async move {
            crate::fetch_queue::record(pool, &kind, &key).await;
            Ok(())
        })
    });
}

/// The gate's DECISION, with no side effect: `(by_boxes, has_local_data)`.
///
/// ⚠ SPLIT OUT FROM [`covered`] SO IT CAN BE ASKED WITHOUT RECORDING. A
/// diagnostic that had to write a queue row to find out what the gate thinks
/// would change the thing it was inspecting, and a test that ran it would fill
/// production's queue with questions nobody asked.
///
/// `None` when the coverage table itself could not be read — which is not "no
/// boxes": nothing is known, so nothing may be claimed.
#[must_use]
pub fn decision(
    bucket: &str,
    lat: f64,
    lon: f64,
    radius_m: f64,
    poly: &str,
) -> Option<(bool, bool)> {
    let boxes = boxes_for(bucket)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);

    if decide(lat, lon, radius_m, false, now_ms, &boxes) {
        return Some((true, false));
    }
    if std::env::var_os("OSM_LOG").is_some() {
        eprintln!(
            "coverage: {bucket} ({lat:.7}, {lon:.7}, {radius_m}) not in any of \
             {} box(es); probing for local data",
            boxes.len()
        );
    }
    // ⚠ ASKED THROUGH LEAN AGAIN rather than returning `true` here.
    // `hasLocalData` short-circuits staleness as well as containment, and that
    // trade is a rule — it belongs in `decideCoverage`, not in a `||` on this
    // line.
    let local = has_local_data(bucket, poly);
    Some((
        local && decide(lat, lon, radius_m, true, now_ms, &boxes),
        local,
    ))
}

/// May `bucket` be read at `(lat, lon)` within `radius_m`, and if not, record
/// that it was wanted.
///
/// ⚠ THE TWO ARGUMENTS ASK ABOUT DIFFERENT AREAS, on purpose.
///
/// `radius_m` is the QUESTION's radius, raw. It is what the coverage boxes were
/// sized against (`osm_mirror::half_width_for` fetches `radius_m * 1.10`) and
/// what the queue key records, so asking about anything else would demand
/// coverage the drain never produces and re-queue the key on every fold.
///
/// `poly` is the box the READ will actually use, query margin included, because
/// the local-data probe is asking "is there anything where I am about to look".
pub fn covered(bucket: &str, lat: f64, lon: f64, radius_m: f64, poly: &str) -> bool {
    match decision(bucket, lat, lon, radius_m, poly) {
        Some((true, _)) => true,
        Some((false, _)) => {
            record(bucket, lat, lon, radius_m);
            false
        }
        // The coverage table could not be read. Nothing is recorded either:
        // a queue entry written because the DATABASE was unreachable is a
        // fetch nobody wanted, and this will be re-asked on the next fold.
        None => false,
    }
}
