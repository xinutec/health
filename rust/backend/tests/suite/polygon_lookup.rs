//! The lat/lon → IANA zone lookup's wrapper, not `tzf-rs`'s polygons.
//!
//! ⚠ Coordinates here are public landmarks and coastlines, never a (place,
//! time) pair: real locations live only in gitignored `tests/golden/`.

use backend::tz_lookup::PolygonLookup;

/// The argument order: `tzf` takes longitude first. Greenwich (51.48, 0.0)
/// swapped lands off Somalia, so a reversal shows.
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

/// The oceans are covered: mid-Pacific is `Etc/GMT+8`, not `None`, so a fix
/// glitched into an ocean gets a confident zone. Asserted so nobody expects
/// `None` from the signature.
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

/// `None` only for a non-coordinate: `tzf`'s empty string must become `None`,
/// or a `tz` column would hold "" that `IS NULL` misses.
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

/// The finder is expensive to build and cheap to query, hence a struct held for
/// the run; this checks repeated queries work, not timing.
#[test]
fn one_finder_answers_many_queries() {
    let p = PolygonLookup::new();
    for _ in 0..1000 {
        assert_eq!(p.zone(52.3676, 4.9041).as_deref(), Some("Europe/Amsterdam"));
    }
}
