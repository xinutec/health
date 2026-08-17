//! Which zone a Fitbit wall clock was recorded in. Port of
//! `src/geo/fitbit-tz.ts`.
//!
//! # ⚠ THIS IS THE RUST HALF OF A PAIR, AND LEAN HOLDS THE SPECIFICATION
//!
//! `Verified.FitbitTz` states the rule: nearest fix in time, ties to the later
//! one, and fall back to the profile zone when there is no fix inside six
//! hours. It states it as a linear scan, which is obviously correct and far too
//! slow to run — a day of 1-second heart rate is 86 400 rows, and a sync window
//! can hold thousands of fixes.
//!
//! So this searches instead, and the two are checked against each other rather
//! than trusted separately: `tests/tz_source.rs` drives both over the same
//! inputs through the FFI. The specification is the arbiter. The failure being
//! guarded against is an off-by-one at the tie, which is exactly where a
//! hand-written binary search goes wrong and exactly what reading it will not
//! catch.
//!
//! # Where the polygons come from
//!
//! Turning a latitude and longitude into an IANA name needs the zone-boundary
//! polygons, which `Verified` cannot hold: it has no external data by design.
//! The caller supplies them as [`Lookup`], and [`PolygonLookup`] is the
//! production one. Keeping it behind the alias is what lets the tests below
//! drive the search with a stub instead of the real polygon set.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::timezone::wall_clock_to_unix;

/// How far in time a GPS fix may be from a wall clock and still speak for it.
/// Mirrors `Verified.FitbitTz.FIX_SEARCH_WINDOW_S`.
pub const FIX_SEARCH_WINDOW_S: i64 = 6 * 60 * 60;

/// Seed zone used only to turn a wall clock into an approximate instant so the
/// fixes can be searched.
///
/// ⚠ It is NOT a claim about where anybody is. The zone it seeds is the one
/// being inferred, so a couple of hours of error is inherent and immaterial
/// against a six-hour window — which is part of why the window is that wide.
/// Used only when the profile zone is missing too, which is the first-link case.
const SEED_FALLBACK_TZ: &str = "Europe/Amsterdam";

/// One GPS fix: an instant and where the phone was.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fix {
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
}

/// Latitude and longitude to an IANA zone name.
///
/// Supplied by the caller because the polygons are external data. `None` for a
/// coordinate the lookup cannot place — mid-ocean, or a corrupt fix.
pub type Lookup<'a> = &'a (dyn Fn(f64, f64) -> Option<String> + Send + Sync + 'a);

/// The index of the fix closest in time to `target`, ties to the LATER one.
///
/// `times` must be sorted ascending. ⚠ The tie rule is not an implementation
/// detail: the TypeScript's search lands on the first index at or after the
/// target and steps back only when the earlier fix is STRICTLY closer, so an
/// exact tie keeps the later. It decides which zone a row on a travel day is
/// stamped with, and changing it would re-time rows already stored.
pub fn nearest_fix(times: &[i64], target: i64) -> Option<usize> {
    if times.is_empty() {
        return None;
    }
    // First index whose value is >= target, or times.len() if none is.
    let mut lo = 0usize;
    let mut hi = times.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if times[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    if lo == times.len() {
        // Every fix is before the target, so the last one is nearest. Step back
        // over any duplicates of it — the tie rule wants the LAST equal value,
        // and that is already the last index.
        return Some(times.len() - 1);
    }
    // `lo` is at or after the target. Among values equal to `times[lo]` the tie
    // rule wants the last, so walk forward over the duplicates.
    let mut best = lo;
    while best + 1 < times.len() && times[best + 1] == times[best] {
        best += 1;
    }
    if lo > 0 {
        let prev = times[lo - 1];
        // STRICTLY closer, so an exact tie keeps `best`, the later one.
        if (target - prev).abs() < (times[best] - target).abs() {
            // Among values equal to `prev`, the last is the one to take.
            let mut p = lo - 1;
            while p + 1 < times.len() && times[p + 1] == prev {
                p += 1;
            }
            return Some(p);
        }
    }
    Some(best)
}

/// A `TzSource` built from GPS fixes and the account's profile zone.
///
/// Forward sync builds one of these; the backward backfill uses
/// [`super::null_tz`] instead, so its rows go in with `tz=NULL` for the backfill
/// CLI to fill in later.
pub struct ForwardTzSource<'a> {
    /// Sorted ascending, once at construction, so each row costs a search.
    fixes: Vec<Fix>,
    times: Vec<i64>,
    profile_tz: Option<String>,
    lookup: Lookup<'a>,
    /// Memo keyed on coordinates rounded to ~100 m. Clustered fixes resolve to
    /// the same zone, and the polygon lookup is the expensive part.
    memo: Mutex<HashMap<(i64, i64), Option<String>>>,
}

impl<'a> ForwardTzSource<'a> {
    pub fn new(mut fixes: Vec<Fix>, profile_tz: Option<String>, lookup: Lookup<'a>) -> Self {
        fixes.sort_by_key(|f| f.ts);
        let times = fixes.iter().map(|f| f.ts).collect();
        Self {
            fixes,
            times,
            profile_tz,
            lookup,
            memo: Mutex::new(HashMap::new()),
        }
    }

    fn lookup_memoised(&self, lat: f64, lon: f64) -> Option<String> {
        // Three decimal places, ~100 m. Integer keys because floats are not
        // hashable and a rounded float compares badly.
        let key = ((lat * 1000.0).round() as i64, (lon * 1000.0).round() as i64);
        if let Some(hit) = self.memo.lock().ok()?.get(&key) {
            return hit.clone();
        }
        let value = (self.lookup)(lat, lon);
        if let Ok(mut m) = self.memo.lock() {
            m.insert(key, value.clone());
        }
        value
    }

    /// The inferred zone for one wall clock, or `None` when there is no signal.
    ///
    /// ⚠ `None` is a legitimate answer and not a failure. It writes `tz=NULL`,
    /// and the row's `ts_utc` stays null with it — a guessed instant in a column
    /// declared to hold UTC is worse than an absent one, because nothing
    /// downstream can tell it was a guess.
    pub fn for_wall_clock(&self, date: &str, time: &str) -> Option<String> {
        if self.fixes.is_empty() {
            return self.profile_tz.clone();
        }
        let seed_tz = self.profile_tz.as_deref().unwrap_or(SEED_FALLBACK_TZ);
        let Some(seed) = wall_clock_to_unix(&format!("{date} {time}"), seed_tz) else {
            // The wall clock did not parse. Choosing a fix from a nonsense
            // instant would be worse than answering with the profile zone.
            return self.profile_tz.clone();
        };
        let Some(i) = nearest_fix(&self.times, seed) else {
            return self.profile_tz.clone();
        };
        let fix = self.fixes[i];
        if (fix.ts - seed).abs() > FIX_SEARCH_WINDOW_S {
            return self.profile_tz.clone();
        }
        // ⚠ A fix the lookup cannot place falls back rather than answering
        // nothing: the profile zone is still a better answer than none.
        self.lookup_memoised(fix.lat, fix.lon)
            .or_else(|| self.profile_tz.clone())
    }
}

/// The production lat/lon → IANA lookup, backed by `tzf-rs`'s polygons.
///
/// # What "not here yet" used to mean, and what changed
///
/// This module's header said the polygon crate was "a dependency decision this
/// port has not made yet" and left [`Lookup`] caller-supplied. The decision is
/// made: `tzf-rs` with its bundled polygon set, so the image needs no data file
/// alongside the binary.
///
/// ⚠ **IT IS NOT THE SAME DATASET THE TYPESCRIPT USED.** `src/geo/fitbit-tz.ts`
/// calls the npm `tz-lookup`, which ships a deliberately coarsened
/// approximation of the tz shapefile; `tzf` carries the fuller polygons. They
/// agree in the interior of a zone and can disagree within a few kilometres of a
/// border. That is a real behaviour change in a port, it lands in a `tz` column
/// that is never revisited, and there is no differential check between them
/// because tz-lookup has no Rust binding to check against.
///
/// The lookup stays behind [`Lookup`] rather than being called directly from
/// [`ForwardTzSource`], so a test can substitute a stub and so the polygon set
/// is not a hidden dependency of the inference.
pub struct PolygonLookup {
    finder: tzf_rs::DefaultFinder,
}

impl Default for PolygonLookup {
    fn default() -> Self {
        Self::new()
    }
}

impl PolygonLookup {
    /// ⚠ EXPENSIVE — it decompresses the polygon set. Build one per process,
    /// never per user and never per row.
    pub fn new() -> Self {
        Self {
            finder: tzf_rs::DefaultFinder::new(),
        }
    }

    /// The IANA zone containing a coordinate, or `None` for one it cannot place.
    ///
    /// ⚠ **`None` IS RARER THAN IT LOOKS, AND THAT IS THE THING TO KNOW HERE.**
    /// The polygons cover the oceans too, with the nautical `Etc/GMT±N` zones,
    /// so almost every in-range coordinate gets an answer:
    ///
    /// ```text
    ///   (-48.88, -123.39)  the remotest point in the Pacific  ->  Etc/GMT+8
    ///   (0, 0)             the Gulf of Guinea                 ->  Etc/GMT
    ///   (91, 0) / NaN      not a coordinate                   ->  "" -> None
    /// ```
    ///
    /// So a GPS fix that is corrupt but still IN RANGE — a glitch dropping the
    /// phone into the Atlantic — does not fall back to the profile zone. It
    /// yields a confident `Etc/GMT+2` that is written into `tz` and looks like
    /// an ordinary answer. Measured, not assumed; the npm `tz-lookup` the
    /// TypeScript uses behaves the same way, so this is not a regression.
    ///
    /// `None` is therefore reached only by a value that is not a coordinate at
    /// all. The empty string `tzf` returns for those is translated here, because
    /// an empty string in a `tz` column would look present, parse as no zone,
    /// and be invisible to an `IS NULL` check.
    pub fn zone(&self, lat: f64, lon: f64) -> Option<String> {
        // ⚠ `tzf` takes LONGITUDE FIRST. Every other signature in this file
        // takes (lat, lon), so the swap happens exactly here and nowhere else.
        // Reversed, the lookup silently answers with a different continent's
        // zone rather than failing.
        let name = self.finder.get_tz_name(lon, lat);
        (!name.is_empty()).then(|| name.to_string())
    }
}
