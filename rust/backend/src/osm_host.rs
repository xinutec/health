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
