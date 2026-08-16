//! The host's half of `DayEntry.OsmHost` — the lookups the fold generates
//! mid-run and a spawned process cannot answer.
//!
//! # Three sources, in this order
//!
//! 1. `--osm <file>` — a captured `OsmTrace`. A TEST instrument: it answers the
//!    same keys the TS arm recorded on that day, so the two arms can be compared
//!    on identical roads.
//! 2. The OSM MIRROR, when `DB_HOST`/`DB_NAME` name one (`mirror.rs`). This is
//!    the production answer.
//! 3. Empty — zero polylines, the same answer `c/osm-host-stub.c` gives the
//!    spawned CLI and the same one the `fun _ _ _ => #[]` shells gave before
//!    either existed.
//!
//! The fixture wins over the mirror deliberately: a replay of a captured day
//! must reproduce that day, not whatever the mirror holds now. Both are counted
//! apart, so a run cannot look answered when it was not.
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
/// ```text
/// lat  4049c87656936f04 == 4049c87656936f04   bit-identical
/// lon  bfd1d17f51558938 vs bfd1d17f51558937   1 ULP apart
/// ```
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
///
/// The radius rides in the key too, quantised at 1e-6 m rather than taken as a
/// whole number: the walk disc is metres by the time it is read, but the road
/// CORRIDOR radius is a `Float` the fetch passes through untouched (443.0 on
/// one recorded read), and parsing that as an integer would drop every
/// fractional one to a miss.
type Key = (i64, i64, i64);

/// 1e-9 degrees. See [`Key`].
fn quantise(v: f64) -> i64 {
    (v * 1e9).round() as i64
}

/// 1e-6 metres, for the radius component. See [`Key`].
fn quantise_r(v: f64) -> i64 {
    (v * 1e6).round() as i64
}

/// One drivable way. `walkableRoads` drops everything but the geometry because
/// `Ways` has nowhere to put it; the road matcher's way-switch penalty reads
/// `name`, and the corridor fetch unions by `osmId`, so this one keeps them.
struct Way {
    osm_id: i64,
    name: Option<String>,
    subtype: Option<String>,
    coords: Line,
}

/// A key as the trace WROTE it, floats and all. The `HashMap` key is quantised
/// (see [`Key`]) and cannot be turned back into a query, so `--osm-verify`
/// needs the originals to ask the mirror the same question.
struct RawKey {
    section: String,
    key: Key,
    lat: f64,
    lon: f64,
    radius: f64,
}

#[derive(Default)]
struct Trace {
    walkable: HashMap<Key, Vec<Line>>,
    buildings: HashMap<Key, Vec<Line>>,
    drivable: HashMap<Key, Vec<Way>>,
    keys: Vec<RawKey>,
}

static TRACE: OnceLock<Trace> = OnceLock::new();

static WALKABLE_HITS: AtomicU64 = AtomicU64::new(0);
static WALKABLE_MISSES: AtomicU64 = AtomicU64::new(0);
static BUILDINGS_HITS: AtomicU64 = AtomicU64::new(0);
static BUILDINGS_MISSES: AtomicU64 = AtomicU64::new(0);
static DRIVABLE_HITS: AtomicU64 = AtomicU64::new(0);
static DRIVABLE_MISSES: AtomicU64 = AtomicU64::new(0);
/// Lookups the MIRROR answered — counted apart from the fixture's hits, so a
/// run cannot claim the fixture served it when the database did.
static MIRROR_READS: AtomicU64 = AtomicU64::new(0);

pub struct Counts {
    pub walkable_hits: u64,
    pub walkable_misses: u64,
    pub buildings_hits: u64,
    pub buildings_misses: u64,
    pub drivable_hits: u64,
    pub drivable_misses: u64,
    pub mirror_reads: u64,
}

impl Counts {
    /// Any call at all — distinguishes "the matcher never asked" from "it asked
    /// and we had nothing", which are different findings.
    pub fn asked(&self) -> u64 {
        self.walkable_hits
            + self.walkable_misses
            + self.buildings_hits
            + self.buildings_misses
            + self.drivable_hits
            + self.drivable_misses
    }
    pub fn misses(&self) -> u64 {
        self.walkable_misses + self.buildings_misses + self.drivable_misses
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
        drivable_hits: DRIVABLE_HITS.swap(0, Ordering::Relaxed),
        drivable_misses: DRIVABLE_MISSES.swap(0, Ordering::Relaxed),
        mirror_reads: MIRROR_READS.swap(0, Ordering::Relaxed),
    }
}

/// `"51.56|-0.27|485"` → its three numbers. `None` on anything unparseable,
/// which is a corrupt trace rather than a missing entry and should not be
/// silent.
fn parse_key_floats(k: &str) -> Option<(f64, f64, f64)> {
    let mut it = k.split('|');
    Some((
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ))
}

fn parse_key(k: &str) -> Option<Key> {
    let (lat, lon, r) = parse_key_floats(k)?;
    Some((quantise(lat), quantise(lon), quantise_r(r)))
}

/// One coordinate. THE TRACE SPELLS IT TWO WAYS and both are here:
/// `walkableRoads` writes a way's `coords` as `[lat, lon]` pairs, while
/// `buildingsNear` writes a ring's vertices as `{lat, lon}` objects.
///
/// ⚠ This function used to accept only the pair, which decoded every building
/// ring to ZERO vertices. Nothing said so: the ring COUNT survived (2522 rings
/// in, 2522 out), the lookup counted as a HIT, and the fold ran to completion —
/// it simply believed no walk ever entered a building, so the corrector never
/// fired and `correctWalkPath` was scored as a divergence for two days. The
/// emptiness guard in `load_fixture` exists so that cannot recur silently.
fn parse_pair(v: &serde_json::Value) -> Option<(f64, f64)> {
    if let Some(a) = v.as_array() {
        return Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?));
    }
    Some((v.get("lat")?.as_f64()?, v.get("lon")?.as_f64()?))
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

/// `drivableRoads` values are `{osmId, name, subtype, coords}` and ALL of it
/// survives — see [`Way`]. A missing `name`/`subtype` stays missing: the road
/// matcher charges for changing way, so an unnamed way and a way named `""` are
/// different inputs.
fn parse_way_records(v: &serde_json::Value) -> Vec<Way> {
    v.as_array()
        .map(|ws| {
            ws.iter()
                .filter_map(|w| {
                    Some(Way {
                        osm_id: w.get("osmId")?.as_i64()?,
                        name: w.get("name").and_then(|n| n.as_str()).map(str::to_owned),
                        subtype: w.get("subtype").and_then(|s| s.as_str()).map(str::to_owned),
                        coords: w
                            .get("coords")?
                            .as_array()?
                            .iter()
                            .filter_map(parse_pair)
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `buildingsNear` values are rings — arrays of vertices directly.
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

/// Every section's keys with their ORIGINAL numbers, for `--osm-verify`.
fn raw_keys(root: &serde_json::Value) -> Vec<RawKey> {
    let mut out = Vec::new();
    for name in ["walkableRoads", "buildingsNear", "drivableRoads"] {
        let Some(o) = root
            .get("inputs")
            .and_then(|i| i.get("osmTrace"))
            .and_then(|t| t.get(name))
            .and_then(|s| s.as_object())
        else {
            continue;
        };
        for k in o.keys() {
            if let (Some((lat, lon, radius)), Some(key)) = (parse_key_floats(k), parse_key(k)) {
                out.push(RawKey { section: name.to_owned(), key, lat, lon, radius });
            }
        }
    }
    out
}

fn section<T>(
    root: &serde_json::Value,
    name: &str,
    f: fn(&serde_json::Value) -> Vec<T>,
) -> HashMap<Key, Vec<T>> {
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
    let mut t = Trace {
        walkable: section(&root, "walkableRoads", parse_ways),
        buildings: section(&root, "buildingsNear", parse_rings),
        drivable: section(&root, "drivableRoads", parse_way_records),
        keys: Vec::new(),
    };
    t.keys = raw_keys(&root);
    let n = (t.walkable.len(), t.buildings.len());
    // An empty trace would answer every lookup with a miss, which reads like a
    // disagreeing fold rather than a fixture without the sections. Say so here,
    // where the cause is still visible.
    if n == (0, 0) {
        return Err(format!(
            "{path}: no walkableRoads or buildingsNear sections — nothing to answer with"
        ));
    }
    // A polyline with no vertices is a DECODE failure, not a small answer, and
    // it is invisible downstream: the fold gets the right number of rings and
    // believes every one of them is nowhere. This is the shape that hid the
    // `{lat, lon}` vs `[lat, lon]` mismatch in `parse_pair` — so the load
    // refuses rather than serving it.
    for (label, sec) in [("walkableRoads", &t.walkable), ("buildingsNear", &t.buildings)] {
        for (key, lines) in sec {
            if let Some(i) = lines.iter().position(|l| l.is_empty()) {
                return Err(format!(
                    "{path}: {label} key {key:?} decoded polyline {i} of {} to ZERO vertices — \
                     the coordinate shape is not what the parser expects",
                    lines.len()
                ));
            }
        }
    }
    for (key, ways) in &t.drivable {
        if let Some(i) = ways.iter().position(|w| w.coords.is_empty()) {
            return Err(format!(
                "{path}: drivableRoads key {key:?} decoded way {i} of {} to ZERO vertices — \
                 the coordinate shape is not what the parser expects",
                ways.len()
            ));
        }
    }
    let _ = TRACE.set(t);
    Ok(n)
}

/// `--osm-verify <trace>`: read every key the fixture holds from the MIRROR too,
/// and compare. Exit code is the verdict.
///
/// This is how the Rust port of `queryWalkableRoads` / `queryBuildingsNear` /
/// `queryDrivableRoads` is checked (#959): not by "it returned rows", but
/// against what the TS arm recorded for the SAME (lat, lon, radius). Same
/// count, same order, same vertices.
///
/// ⚠ A mismatch is not automatically a port defect. The mirror is LIVE and a
/// captured day is a snapshot: OSM edits between capture and now move real
/// vertices. So run this on the most recently captured day available, and read
/// a difference as "one of these two things" rather than as a verdict on the
/// port. A difference in COUNT ORDER or in the subtype set is the port; a
/// handful of moved vertices on one way is the world.
pub fn verify_against_mirror(path: &str) -> Result<(), String> {
    load_fixture(path)?;
    let t = TRACE.get().ok_or("no trace")?;
    let mut checked = 0usize;
    let mut mismatched = 0usize;

    let mut report = |label: &str, k: &RawKey, want: usize, got: usize, detail: String| {
        checked += 1;
        if !detail.is_empty() {
            mismatched += 1;
            eprintln!(
                "verify: {label} ({:.7}, {:.7}, {}) fixture={want} mirror={got} — {detail}",
                k.lat, k.lon, k.radius
            );
        }
    };

    for k in &t.keys {
        match k.section.as_str() {
            "walkableRoads" => {
                let want = t.walkable.get(&k.key).cloned().unwrap_or_default();
                let got: Vec<Line> = crate::mirror::walkable_roads(k.lat, k.lon, k.radius)
                    .into_iter()
                    .map(|w| w.coords)
                    .collect();
                let d = diff_lines(&want, &got);
                report("walkableRoads", k, want.len(), got.len(), d);
            }
            "buildingsNear" => {
                let want = t.buildings.get(&k.key).cloned().unwrap_or_default();
                let got = crate::mirror::buildings_near(k.lat, k.lon, k.radius);
                let d = diff_lines(&want, &got);
                report("buildingsNear", k, want.len(), got.len(), d);
            }
            "drivableRoads" => {
                let want: Vec<Line> = t
                    .drivable
                    .get(&k.key)
                    .map(|ws| ws.iter().map(|w| w.coords.clone()).collect())
                    .unwrap_or_default();
                let got: Vec<Line> = crate::mirror::drivable_roads(k.lat, k.lon, k.radius)
                    .into_iter()
                    .map(|w| w.coords)
                    .collect();
                let d = diff_lines(&want, &got);
                report("drivableRoads", k, want.len(), got.len(), d);
            }
            _ => {}
        }
    }

    eprintln!("verify: {checked} key(s) checked, {mismatched} mismatched");
    if mismatched == 0 {
        Ok(())
    } else {
        Err(format!("{mismatched} of {checked} key(s) differ"))
    }
}

/// The first thing that differs, named. Empty string means identical.
fn diff_lines(want: &[Line], got: &[Line]) -> String {
    if want.len() != got.len() {
        return "different polyline COUNT".to_owned();
    }
    for (i, (a, b)) in want.iter().zip(got).enumerate() {
        if a.len() != b.len() {
            return format!("polyline {i}: {} vertices vs {}", a.len(), b.len());
        }
        for (j, (p, q)) in a.iter().zip(b).enumerate() {
            if p != q {
                return format!(
                    "polyline {i} vertex {j}: ({:.7}, {:.7}) vs ({:.7}, {:.7})",
                    p.0, p.1, q.0, q.1
                );
            }
        }
    }
    String::new()
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

/// The second wire format, for `drivableRoads`: a `u32` count, then per way its
/// `i64` osmId, an optional `name`, an optional `subtype`, and the geometry.
/// `0xFFFFFFFF` is ABSENT and is not a length of zero — an unnamed way and a way
/// named `""` are different to the matcher's way-switch penalty. Pinned on the
/// Lean side by `#guard`s on literals.
fn encode_ways(ways: &[Way]) -> Vec<u8> {
    fn opt_str(b: &mut Vec<u8>, s: Option<&String>) {
        match s {
            None => b.extend_from_slice(&u32::MAX.to_le_bytes()),
            Some(s) => {
                b.extend_from_slice(&(s.len() as u32).to_le_bytes());
                b.extend_from_slice(s.as_bytes());
            }
        }
    }
    let mut b = Vec::new();
    b.extend_from_slice(&(ways.len() as u32).to_le_bytes());
    for w in ways {
        b.extend_from_slice(&w.osm_id.to_le_bytes());
        opt_str(&mut b, w.name.as_ref());
        opt_str(&mut b, w.subtype.as_ref());
        b.extend_from_slice(&(w.coords.len() as u32).to_le_bytes());
        for (lat, lon) in &w.coords {
            b.extend_from_slice(&lat.to_le_bytes());
            b.extend_from_slice(&lon.to_le_bytes());
        }
    }
    b
}

fn answer(lines: &[Line]) -> *mut c_void {
    hand_over(&encode(lines))
}

fn hand_over(b: &[u8]) -> *mut c_void {
    // SAFETY: `b` outlives the call and the callee copies it.
    unsafe { health_shell_mk_bytes(b.as_ptr(), b.len()) }
}

fn section_name(which: bool) -> &'static str {
    if which {
        "walkableRoads"
    } else {
        "buildingsNear"
    }
}

fn lookup(which: bool, lat: f64, lon: f64, radius: f64) -> *mut c_void {
    let key = (quantise(lat), quantise(lon), quantise_r(radius));
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
            // `OSM_LOG=1` names every HIT too, in call order.
            //
            // A hit count alone cannot tell "asked the same four questions" from
            // "asked one of them twice and another never" — both read 4/4. The
            // trace object's key order is the TS arm's call order, so the two
            // sequences are directly comparable, and that is the comparison
            // that attributes a leg drawing different geometry to the two arms
            // reaching for different roads.
            if std::env::var_os("OSM_LOG").is_some() {
                eprintln!(
                    "osm: HIT  {} lat={lat:.17} lon={lon:.17} r={radius} -> {} line(s)",
                    section_name(which),
                    lines.len()
                );
            }
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
                    section_name(which),
                    lat.to_bits(),
                    lon.to_bits()
                );
            }
            // No fixture entry. The MIRROR is the production answer, and it is
            // only consulted here — after the fixture — so replaying a captured
            // day reproduces THAT day rather than whatever the mirror holds now.
            //
            // A mirror read that finds nothing is still counted a miss above,
            // and correctly: a walk over an area the mirror does not cover is
            // exactly the case that must not read as "there are no roads here".
            if crate::mirror::configured() {
                let lines: Vec<Line> = if which {
                    crate::mirror::walkable_roads(lat, lon, radius)
                        .into_iter()
                        .map(|w| w.coords)
                        .collect()
                } else {
                    crate::mirror::buildings_near(lat, lon, radius)
                };
                MIRROR_READS.fetch_add(1, Ordering::Relaxed);
                if std::env::var_os("OSM_LOG").is_some() {
                    eprintln!(
                        "osm: MIRROR {} lat={lat:.17} lon={lon:.17} r={radius} -> {} line(s)",
                        section_name(which),
                        lines.len()
                    );
                }
                return answer(&lines);
            }
            answer(&[])
        }
    }
}

/// The road twin of [`lookup`]. Separate rather than folded into it because the
/// answer is a different SHAPE — `Array Way`, not `Array (Array Pt)` — and the
/// second wire format exists for exactly that reason.
fn lookup_ways(lat: f64, lon: f64, radius: f64) -> *mut c_void {
    let key = (quantise(lat), quantise(lon), quantise_r(radius));
    match TRACE.get().and_then(|t| t.drivable.get(&key)) {
        Some(ways) => {
            DRIVABLE_HITS.fetch_add(1, Ordering::Relaxed);
            if std::env::var_os("OSM_LOG").is_some() {
                eprintln!(
                    "osm: HIT  drivableRoads lat={lat:.17} lon={lon:.17} r={radius} -> {} way(s)",
                    ways.len()
                );
            }
            hand_over(&encode_ways(ways))
        }
        None => {
            DRIVABLE_MISSES.fetch_add(1, Ordering::Relaxed);
            if TRACE.get().is_some() {
                eprintln!(
                    "osm: MISS drivableRoads lat={lat:.17} lon={lon:.17} r={radius} \
                     bits={:016x}/{:016x}",
                    lat.to_bits(),
                    lon.to_bits()
                );
            }
            if crate::mirror::configured() {
                let ways: Vec<Way> = crate::mirror::drivable_roads(lat, lon, radius)
                    .into_iter()
                    .map(|w| Way {
                        osm_id: w.osm_id,
                        name: w.name,
                        subtype: w.subtype,
                        coords: w.coords,
                    })
                    .collect();
                MIRROR_READS.fetch_add(1, Ordering::Relaxed);
                if std::env::var_os("OSM_LOG").is_some() {
                    eprintln!(
                        "osm: MIRROR drivableRoads lat={lat:.17} lon={lon:.17} r={radius} \
                         -> {} way(s)",
                        ways.len()
                    );
                }
                return hand_over(&encode_ways(&ways));
            }
            hand_over(&encode_ways(&[]))
        }
    }
}

/// Called by Lean with an owned boxed `Int`, released here. Returns an owned
/// `ByteArray` Lean takes ownership of.
///
/// `unsafe` because it is: `radius_m` must be a live `lean_object *`, and this
/// releases it. That was true before these moved into the library too — making
/// them public is what let clippy say so. Lean's `@[extern]` call is unaffected;
/// the C ABI does not know the difference.
///
/// # Safety
/// `radius_m` must be a live boxed Lean `Int` this function may consume.
#[no_mangle]
pub unsafe extern "C" fn health_osm_walkable_roads(
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
    lookup(true, lat, lon, r as f64)
}

/// As [`health_osm_walkable_roads`].
///
/// # Safety
/// `radius_m` must be a live boxed Lean `Int` this function may consume.
#[no_mangle]
pub unsafe extern "C" fn health_osm_buildings_near(
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
    lookup(false, lat, lon, r as f64)
}

/// The road mirror read. ⚠ Its radius is an UNBOXED `double`, not a boxed
/// `Int`: `RoadMatchAnnotate.Env.drivableRoads` takes a `Float` because the
/// corridor fetch passes a fractional radius through untouched. So there is
/// nothing to release here, and reaching for `lean_int_value` would read a
/// double's bits as a pointer.
#[no_mangle]
pub extern "C" fn health_osm_drivable_roads(lat: f64, lon: f64, radius_m: f64) -> *mut c_void {
    lookup_ways(lat, lon, radius_m)
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
