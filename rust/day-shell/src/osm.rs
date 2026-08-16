//! The host's half of `DayEntry.OsmHost` — the lookups the fold generates
//! mid-run and a spawned process cannot answer.
//!
//! # Two sources, and only one of them is the destination
//!
//! Empty by default: zero polylines, the same answer `c/osm-host-stub.c` gives
//! the spawned CLI and the same one the `fun _ _ _ => #[]` shells gave before
//! either existed. The fold's output is then unchanged, which is what makes the
//! callback safe to have landed before it answers anything.
//!
//! With `--osm <file>`, a captured `OsmTrace` answers instead. That is a TEST
//! instrument. The production path reads the OSM mirror — `osm-local.ts` reads
//! it out of MariaDB — and is not written. The point of the fixture path is that
//! the matcher can be exercised end to end, against the same roads the TS arm
//! saw, before any of that exists.
//!
//! # Keys are matched as NUMBERS, never as strings
//!
//! The trace is keyed `` `${lat}|${lon}|${radiusM}` `` — JavaScript number
//! formatting, which is the shortest round-tripping decimal (Ryu/Grisu), an
//! algorithm this side has no reason to own a second copy of. `JsNum.toFixed`
//! exists in the Lean tree precisely because that class of thing has to be
//! exact, and it is 100 lines for the EASIER of the two.
//!
//! So the keys are parsed to `f64` once and matched by value. The fold's
//! coordinates come from the same request the capture came from, so exact
//! equality is the right comparison — and when it fails, that is a real finding
//! about the two arms disagreeing, not a lookup to paper over with a tolerance.
//!
//! # Misses are counted and reported
//!
//! An unanswered lookup returns empty, which is indistinguishable from "there
//! are no roads here" — the exact shape of failure this codebase keeps being
//! bitten by. So misses are tallied separately and printed. A run whose misses
//! are nonzero has NOT exercised the matcher, however green it looks.

use std::collections::HashMap;
use std::os::raw::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

extern "C" {
    fn health_shell_mk_bytes(p: *const u8, n: usize) -> *mut c_void;
    fn health_shell_dec(o: *mut c_void);
}

/// One polyline: a run of (lat, lon).
type Line = Vec<(f64, f64)>;

/// A lookup key as the trace spells it, reduced to numbers.
///
/// # Why the coordinate is quantised, and why that is not a tolerance
///
/// Keying on the raw bit patterns was the first attempt, and it MISSED one of
/// this day's four walkableRoads lookups:
///
///     lat  4049c87656936f04 == 4049c87656936f04   bit-identical
///     lon  bfd1d17f51558938 vs bfd1d17f51558937   1 ULP apart
///
/// That is not a bug in either arm. It is the divergence `Verified/Geo/
/// Kalman.lean` measured across 32 golden days — `lat` bit-identical, `lon`
/// off by <=1 ULP on ~0.5% of rows, because `metersToDegreesLon` calls
/// `Float.cos` and `metersToDegreesLat` does not, and this runtime's `cos`
/// and V8's disagree by 1 ULP on ~7.6% of latitudes.
///
/// So the arms genuinely compute a slightly different CENTRE for one corridor
/// sample. The quantisation below is to 1e-9 degrees — about 0.1 mm — against
/// a query whose radius is 537 METRES. It is not loosening a comparison of
/// answers; it is admitting that a disc's address is not a 17-digit quantity.
/// PRODUCTION IS UNAFFECTED EITHER WAY: a real host queries the mirror by
/// (lat, lon, radius) and gets the same roads at 0.1 mm either side. This only
/// matters when replaying against keys someone else's arithmetic wrote.
///
/// Exact and quantised hits are still counted apart, so the ULP divergence
/// stays visible rather than being absorbed here.
type Key = (i64, i64, i64);

/// 1e-9 degrees. See [`Key`].
fn quantise(v: f64) -> i64 {
    (v * 1e9).round() as i64
}

#[derive(Default)]
struct Trace {
    walkable: HashMap<Key, Vec<Line>>,
    buildings: HashMap<Key, Vec<Line>>,
}

static TRACE: OnceLock<Trace> = OnceLock::new();

static WALKABLE_HITS: AtomicU64 = AtomicU64::new(0);
static WALKABLE_MISSES: AtomicU64 = AtomicU64::new(0);
static BUILDINGS_HITS: AtomicU64 = AtomicU64::new(0);
static BUILDINGS_MISSES: AtomicU64 = AtomicU64::new(0);

pub struct Counts {
    pub walkable_hits: u64,
    pub walkable_misses: u64,
    pub buildings_hits: u64,
    pub buildings_misses: u64,
}

impl Counts {
    /// Any call at all — distinguishes "the matcher never asked" from "it asked
    /// and we had nothing", which are different findings.
    pub fn asked(&self) -> u64 {
        self.walkable_hits + self.walkable_misses + self.buildings_hits + self.buildings_misses
    }
    pub fn misses(&self) -> u64 {
        self.walkable_misses + self.buildings_misses
    }
}

/// Whether a captured trace was loaded — see the miss reporting in `main`.
pub fn have_trace() -> bool {
    TRACE.get().is_some()
}

pub fn take_counts() -> Counts {
    Counts {
        walkable_hits: WALKABLE_HITS.swap(0, Ordering::Relaxed),
        walkable_misses: WALKABLE_MISSES.swap(0, Ordering::Relaxed),
        buildings_hits: BUILDINGS_HITS.swap(0, Ordering::Relaxed),
        buildings_misses: BUILDINGS_MISSES.swap(0, Ordering::Relaxed),
    }
}

/// `"51.56|-0.27|485"` → the numeric key. `None` on anything unparseable, which
/// is a corrupt trace rather than a missing entry and should not be silent.
fn parse_key(k: &str) -> Option<Key> {
    let mut it = k.split('|');
    let lat: f64 = it.next()?.parse().ok()?;
    let lon: f64 = it.next()?.parse().ok()?;
    let r: i64 = it.next()?.parse().ok()?;
    Some((quantise(lat), quantise(lon), r))
}

/// A `[lat, lon]` pair as the trace writes coordinates.
fn parse_pair(v: &serde_json::Value) -> Option<(f64, f64)> {
    let a = v.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

/// `walkableRoads` values are `{coords, name, osmId, subtype}` and only `coords`
/// survives: the Lean side wants `Ways = Array (Array Pt)`, plain geometry. The
/// dropped fields are real, and are why `drivableRoads` — which needs `osmId`,
/// `name` and `subtype` — is NOT served through this format.
fn parse_ways(v: &serde_json::Value) -> Vec<Line> {
    v.as_array()
        .map(|ws| {
            ws.iter()
                .filter_map(|w| {
                    w.get("coords")?
                        .as_array()
                        .map(|c| c.iter().filter_map(parse_pair).collect())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `buildingsNear` values are rings — arrays of `[lat, lon]` directly.
fn parse_rings(v: &serde_json::Value) -> Vec<Line> {
    v.as_array()
        .map(|rs| {
            rs.iter()
                .filter_map(|r| {
                    r.as_array()
                        .map(|c| c.iter().filter_map(parse_pair).collect())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn section(
    root: &serde_json::Value,
    name: &str,
    f: fn(&serde_json::Value) -> Vec<Line>,
) -> HashMap<Key, Vec<Line>> {
    root.get("inputs")
        .and_then(|i| i.get("osmTrace"))
        .and_then(|t| t.get(name))
        .and_then(|s| s.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| Some((parse_key(k)?, f(v))))
                .collect()
        })
        .unwrap_or_default()
}

/// Load a captured day. Call before the fold runs; later calls are ignored.
pub fn load_fixture(path: &str) -> Result<(usize, usize), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let t = Trace {
        walkable: section(&root, "walkableRoads", parse_ways),
        buildings: section(&root, "buildingsNear", parse_rings),
    };
    let n = (t.walkable.len(), t.buildings.len());
    // An empty trace would answer every lookup with a miss, which reads like a
    // disagreeing fold rather than a fixture without the sections. Say so here,
    // where the cause is still visible.
    if n == (0, 0) {
        return Err(format!(
            "{path}: no walkableRoads or buildingsNear sections — nothing to answer with"
        ));
    }
    let _ = TRACE.set(t);
    Ok(n)
}

/// Encode polylines in `DayEntry.OsmHost`'s wire format: a little-endian `u32`
/// count, then per line a `u32` point count and that many `(f64 lat, f64 lon)`.
/// Pinned on the Lean side by `#guard`s on literals.
fn encode(lines: &[Line]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + lines.iter().map(|l| 4 + l.len() * 16).sum::<usize>());
    b.extend_from_slice(&(lines.len() as u32).to_le_bytes());
    for l in lines {
        b.extend_from_slice(&(l.len() as u32).to_le_bytes());
        for (lat, lon) in l {
            b.extend_from_slice(&lat.to_le_bytes());
            b.extend_from_slice(&lon.to_le_bytes());
        }
    }
    b
}

fn answer(lines: &[Line]) -> *mut c_void {
    let b = encode(lines);
    // SAFETY: `b` outlives the call and the callee copies it.
    unsafe { health_shell_mk_bytes(b.as_ptr(), b.len()) }
}

fn lookup(which: bool, lat: f64, lon: f64, radius: i64) -> *mut c_void {
    let key = (quantise(lat), quantise(lon), radius);
    let found = TRACE.get().and_then(|t| {
        if which {
            t.walkable.get(&key)
        } else {
            t.buildings.get(&key)
        }
    });
    let (hits, misses) = if which {
        (&WALKABLE_HITS, &WALKABLE_MISSES)
    } else {
        (&BUILDINGS_HITS, &BUILDINGS_MISSES)
    };
    match found {
        Some(lines) => {
            hits.fetch_add(1, Ordering::Relaxed);
            answer(lines)
        }
        None => {
            misses.fetch_add(1, Ordering::Relaxed);
            // Named, because a miss is a finding about the two arms asking
            // different questions, and a count alone cannot be chased.
            //
            // Only when a trace IS loaded. With no `--osm`, every lookup misses
            // by design and naming them is noise that buries the real ones.
            if TRACE.get().is_some() {
                eprintln!(
                    "osm: MISS {} lat={lat:.17} lon={lon:.17} r={radius} bits={:016x}/{:016x}",
                    if which {
                        "walkableRoads"
                    } else {
                        "buildingsNear"
                    },
                    lat.to_bits(),
                    lon.to_bits()
                );
            }
            answer(&[])
        }
    }
}

/// Called by Lean with an owned boxed `Int`, released here. Returns an owned
/// `ByteArray` Lean takes ownership of.
#[no_mangle]
pub extern "C" fn health_osm_walkable_roads(
    lat: f64,
    lon: f64,
    radius_m: *mut c_void,
) -> *mut c_void {
    // SAFETY: `radius_m` is the boxed argument this callee owns. Read before the
    // release, since the release may free it.
    let r = unsafe {
        let v = lean_int_value(radius_m);
        health_shell_dec(radius_m);
        v
    };
    lookup(true, lat, lon, r)
}

/// As [`health_osm_walkable_roads`].
#[no_mangle]
pub extern "C" fn health_osm_buildings_near(
    lat: f64,
    lon: f64,
    radius_m: *mut c_void,
) -> *mut c_void {
    // SAFETY: as above.
    let r = unsafe {
        let v = lean_int_value(radius_m);
        health_shell_dec(radius_m);
        v
    };
    lookup(false, lat, lon, r)
}

/// A Lean `Int` small enough to be a tagged scalar, as an `i64`.
///
/// Lean boxes an `Int` as `(value << 1) | 1` when it fits, and every radius here
/// is metres — hundreds. A genuinely big `Int` would be a heap object and this
/// would be wrong, so it is checked rather than assumed: a non-scalar answers
/// `-1`, which matches no captured key and is therefore counted as a MISS and
/// reported, instead of silently reading a pointer as a number.
///
/// SAFETY: `o` must be a live `lean_object *`.
unsafe fn lean_int_value(o: *mut c_void) -> i64 {
    let bits = o as usize;
    if bits & 1 == 1 {
        ((bits as isize) >> 1) as i64
    } else {
        -1
    }
}
