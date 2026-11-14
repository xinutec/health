//! Latitude and longitude to an IANA zone, from the bundled polygon set, for
//! the stays the focus refresh and the rowset answerer label.

/// The production lat/lon → IANA lookup over `tzf-rs`'s bundled polygons. Older
/// stored rows came from a coarser lookup that can differ within a few km of a
/// border; a stored `tz` is never revisited.
pub struct PolygonLookup {
    finder: tzf_rs::DefaultFinder,
}

impl Default for PolygonLookup {
    fn default() -> Self {
        Self::new()
    }
}

impl PolygonLookup {
    /// Expensive — it decompresses the polygon set. Build one per process,
    /// never per user and never per row.
    pub fn new() -> Self {
        Self {
            finder: tzf_rs::DefaultFinder::new(),
        }
    }

    /// The IANA zone containing a coordinate, or `None` for a value that is not
    /// a coordinate (out of range, NaN). The polygons cover the oceans with
    /// `Etc/GMT±N`, so a corrupt in-range fix gets a confident zone, not the
    /// profile's. `tzf`'s empty string becomes `None`, which `IS NULL` can see.
    pub fn zone(&self, lat: f64, lon: f64) -> Option<String> {
        // ⚠ `tzf` takes longitude first; the swap happens here only. Reversed,
        // it silently answers another continent's zone.
        let name = self.finder.get_tz_name(lon, lat);
        (!name.is_empty()).then(|| name.to_string())
    }
}
