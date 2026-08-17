//! The lat/lon → IANA zone lookup (#982).
//!
//! ⚠ The coordinates here are public landmarks and coastlines with no time
//! attached to any of them. Nowhere anybody has been, and no (place, time) pair:
//! `tests/golden/ground-truth/` is where real locations live, and it is
//! gitignored for exactly that reason.
//!
//! What these guard is not the polygon data — that is `tzf-rs`'s problem — but
//! the three ways the wrapper around it can be wrong while looking right.

use backend::fitbit::tz_source::PolygonLookup;

/// ⚠ THE ARGUMENT ORDER. `tzf` takes longitude first and every other signature
/// in this codebase takes latitude first, so the swap lives in exactly one
/// function. Get it backwards and the lookup does not fail — it confidently
/// answers with a different continent's zone.
///
/// Greenwich is the case that makes a reversal visible: at (51.48, 0.0) the
/// swapped call is (0.0, 51.48), which is in the Indian Ocean off Somalia.
#[test]
fn latitude_comes_first() {
    let p = PolygonLookup::new();
    assert_eq!(p.zone(51.4779, -0.0015).as_deref(), Some("Europe/London"));
    // The reversed reading of the same numbers is nowhere near London, and is
    // asserted so a future refactor cannot quietly swap them back.
    assert_ne!(p.zone(-0.0015, 51.4779).as_deref(), Some("Europe/London"));
}

#[test]
fn ordinary_coordinates_resolve() {
    let p = PolygonLookup::new();
    for (lat, lon, want) in [
        (52.3676, 4.9041, "Europe/Amsterdam"),
        (48.8584, 2.2945, "Europe/Paris"),
        (40.6892, -74.0445, "America/New_York"),
        (35.6586, 139.7454, "Asia/Tokyo"),
        (-33.8568, 151.2153, "Australia/Sydney"),
    ] {
        assert_eq!(
            p.zone(lat, lon).as_deref(),
            Some(want),
            "({lat}, {lon}) should be {want}"
        );
    }
}

/// ⚠ THE OCEANS ARE COVERED, so a corrupt-but-in-range fix does NOT fall back.
///
/// This started as a test asserting that mid-Pacific yields `None`, and it
/// failed: `tzf` answers `Etc/GMT+8` there. The polygons include the nautical
/// zones, so a GPS glitch that drops the phone into an ocean produces a
/// confident zone name that is written into `tz` and reads like any other
/// answer. That is the behaviour, it matches the npm `tz-lookup` the TypeScript
/// uses, and it is asserted here so nobody re-derives the wrong expectation
/// from the `Option` in the signature.
#[test]
fn open_ocean_gets_a_nautical_zone_not_none() {
    let p = PolygonLookup::new();
    // Point Nemo, the oceanic pole of inaccessibility — the furthest point on
    // the planet from any land, and still inside a polygon.
    assert_eq!(
        p.zone(-48.876667, -123.393333).as_deref(),
        Some("Etc/GMT+8")
    );
    // The Gulf of Guinea, where the equator meets the prime meridian.
    assert_eq!(p.zone(0.0, 0.0).as_deref(), Some("Etc/GMT"));
}

/// `None` is reached only by a value that is not a coordinate at all.
///
/// `tzf` returns an EMPTY STRING for these rather than erroring. An empty string
/// reaching a `tz` column would look present, parse as no zone, and be invisible
/// to an `IS NULL` check — so the wrapper has to turn it into `None`, and this
/// is what proves it does.
#[test]
fn a_non_coordinate_is_none_not_an_empty_string() {
    let p = PolygonLookup::new();
    for (lat, lon, what) in [
        (91.0, 0.0, "latitude past the pole"),
        (-91.0, 0.0, "latitude past the other pole"),
        (0.0, 200.0, "longitude past the antimeridian"),
        (f64::NAN, f64::NAN, "NaN"),
        (1e9, 1e9, "absurd"),
    ] {
        let answer = p.zone(lat, lon);
        assert!(answer.is_none(), "{what} ({lat}, {lon}) gave {answer:?}");
        assert_ne!(
            answer.as_deref(),
            Some(""),
            "an empty string must never escape as a zone name"
        );
    }
}

/// The finder is expensive to build and cheap to query, which is the whole
/// reason it is a struct held for the run rather than a free function. If a
/// refactor ever makes `zone` rebuild it, this gets slow rather than wrong —
/// so this asserts the cheap thing works repeatedly, not a timing.
#[test]
fn one_finder_answers_many_queries() {
    let p = PolygonLookup::new();
    for _ in 0..1000 {
        assert_eq!(p.zone(52.3676, 4.9041).as_deref(), Some("Europe/Amsterdam"));
    }
}
