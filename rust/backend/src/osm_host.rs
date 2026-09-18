//! Keep `day-shell`'s OSM entry points in the link.
//!
//! ⚠ THIS MODULE EXISTS SOLELY FOR ITS SIDE EFFECT ON THE LINKER, and deleting
//! it as dead code breaks the binary in a way that only shows at link time.
//!
//! `ServeEntry` imports `DayEntry`, whose `OsmHost` declares three `@[extern]`
//! lookups. `day-shell` defines them as `#[unsafe(no_mangle)]`, but Rust links
//! an rlib only when something references it — and nothing here calls
//! `day-shell`'s Rust API, so the crate was dropped and the three symbols came
//! out undefined:
//!
//! ```text
//! "_health_osm_walkable_roads", referenced from:
//!     _lp_verified_DayEntry_OsmHost_walkableRoads in libverified_DayEntry.a
//! ```
//!
//! The alternative — letting `c/osm-host-stub.c` satisfy them — is worse than a
//! link error and is what `build.rs` filters the stub out to prevent: it answers
//! every lookup with zero polylines, so the day fold decodes with no map and
//! reports success.
//!
//! `#[used]` rather than a call, because there is nothing to call: the fold
//! invokes these, not us. Taking their addresses is the whole point.

use std::ffi::c_void;

/// ⚠ The three do NOT share a signature, and that is not an oversight here:
/// the two that take a boxed Lean `Int` radius are `unsafe` and consume it,
/// while `drivable_roads` takes a plain `f64`. Forcing them into one array type
/// would need a cast that says they are interchangeable, which they are not.
#[used]
static WALKABLE: unsafe extern "C" fn(f64, f64, *mut c_void) -> *mut c_void =
    day_shell::osm::health_osm_walkable_roads;

#[used]
static BUILDINGS: unsafe extern "C" fn(f64, f64, *mut c_void) -> *mut c_void =
    day_shell::osm::health_osm_buildings_near;

#[used]
static DRIVABLE: extern "C" fn(f64, f64, f64) -> *mut c_void =
    day_shell::osm::health_osm_drivable_roads;

/// Load a golden fixture's captured OSM trace so the fold's walk pass can
/// actually run in THIS process.
///
/// ⚠ **Without a trace the three callbacks above answer empty, and empty is not
/// a neutral answer**: `annotateWalkMatches` bails on `ways.isEmpty` and the leg
/// keeps its raw drawing, so a harness that never loads one measures the walk
/// pass by not running it. That was true of every backend corpus gate until
/// 2026-09-08 (#1418) — they were green across a change that renamed 104 of 239
/// corpus walking rows.
///
/// Loading REPLACES: call it per day, and read the miss counters afterwards to
/// find out whether the fixture actually answered what the fold asked for.
pub fn load_trace(fixture_path: &str) -> Result<(usize, usize), String> {
    day_shell::osm::load_fixture(fixture_path)
}

/// [`load_trace`] with sections withheld, for attributing a measured change to
/// ONE of the three rather than to "the trace". A withheld section answers
/// empty — the same thing a trace-less process sees — so every arm runs
/// identical code and only the answer differs.
pub fn load_trace_sections(
    fixture_path: &str,
    walkable: bool,
    buildings: bool,
    drivable: bool,
) -> Result<(usize, usize), String> {
    day_shell::osm::load_fixture_sections(fixture_path, walkable, buildings, drivable)
}

/// [`load_trace_sections`] on a fixture the caller has already parsed.
///
/// ⚠ Prefer this wherever the document is in hand. The path forms re-read and
/// re-parse it: a golden day is ~28 MB and costs **370 MiB and 470 ms** to
/// parse, and a caller asking for a trace is by definition already holding the
/// same tree (#1654).
pub fn load_trace_value_sections(
    fixture: &serde_json::Value,
    label: &str,
    walkable: bool,
    buildings: bool,
    drivable: bool,
) -> Result<(usize, usize), String> {
    day_shell::osm::load_value_sections(fixture, label, walkable, buildings, drivable)
}

/// Hit/miss counts for the three callbacks since the last call, and RESET.
///
/// ⚠ A gate that loads a trace should assert on these rather than trusting the
/// load: a fixture whose keys the fold never spells answers zero questions and
/// looks exactly like no fixture at all.
pub fn take_counts() -> day_shell::osm::Counts {
    day_shell::osm::take_counts()
}

/// Begin recording what the mirror answers, for capturing a new golden day
/// (#1660). See `day_shell::osm::start_capture`.
pub fn start_capture() {
    day_shell::osm::start_capture();
}

/// The recorded `osmTrace` sections, and STOP recording.
///
/// ⚠ Only the three this crate's callbacks answer — `walkableRoads`,
/// `buildingsNear`, `drivableRoads`. A fixture's `osmTrace` has seven more that
/// come from the ANSWERER, and a capture that shipped these three alone would
/// replay with the road and walk matchers fed and everything else missing.
pub fn take_capture() -> serde_json::Value {
    day_shell::osm::take_capture()
}

/// What a capture was taken under, for stamping into a fixture's `meta` (#1660).
///
/// ⚠ **A FIXTURE THAT DOES NOT RECORD THESE CANNOT NOTICE THEM MOVING.** Each
/// one changes what the mirror is ASKED or what it may return, and none of them
/// is part of any key a fixture holds — so a change to one alters production
/// and alters nothing a gate replays. #1071 records that for
/// `ROAD_CORRIDOR_MARGIN_M`; #328 is the same fault from the other side, a
/// fixture asserting a verdict production had already stopped producing.
#[must_use]
pub fn capture_inputs() -> serde_json::Value {
    serde_json::json!({
        "roadCorridorMarginM": day_shell::mirror::road_corridor_margin_m(),
        "candidateLimit": crate::mirror_source::CANDIDATE_LIMIT,
    })
}

/// Refuse a fixture captured under inputs this build no longer uses.
///
/// ⚠ **ABSENT IS NOT A MISMATCH.** The 42 fixtures captured before this existed
/// carry no stamp, and they must keep working — refusing them would be claiming
/// they were taken under something they never recorded. Only a stamp that is
/// PRESENT and DIFFERENT is a refusal, which is the case the check exists for.
pub fn check_capture_inputs(meta: &serde_json::Value) -> Result<(), String> {
    let Some(stamped) = meta
        .get("captureInputs")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(());
    };
    let now = capture_inputs();
    let mut moved: Vec<String> = Vec::new();
    for (k, was) in stamped {
        let is = now.get(k);
        if is != Some(was) {
            moved.push(format!(
                "{k}: captured under {was}, this build uses {}",
                is.map_or("(nothing of that name)".to_string(), ToString::to_string)
            ));
        }
    }
    if moved.is_empty() {
        return Ok(());
    }
    Err(format!(
        "this fixture was captured under different inputs and replaying it would \
         compare the wrong things — {}. Re-capture the day, or restore the constant; \
         do NOT bless around it, because every gate stays green either way (#1071)",
        moved.join("; ")
    ))
}
