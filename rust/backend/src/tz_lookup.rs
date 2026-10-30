//! Latitude and longitude to an IANA zone, from the bundled polygon set.
//!
//! The only piece of the Fitbit wall-clock inference that outlived the Web API:
//! a fix's zone, for the stays the focus refresh and the rowset answerer label.

/// The production lat/lon → IANA lookup, backed by `tzf-rs`'s polygons —
/// bundled, so the image needs no data file alongside the binary.
///
/// ⚠ **IT IS NOT THE SAME DATASET THE TYPESCRIPT USED.** `fitbit-tz.ts`
/// calls the npm `tz-lookup`, which ships a deliberately coarsened
/// approximation of the tz shapefile; `tzf` carries the fuller polygons. They
/// agree in the interior of a zone and can disagree within a few kilometres of a
/// border. That is a real behaviour change in a port, it lands in a `tz` column
/// that is never revisited, and there is no differential check between them
/// because tz-lookup has no Rust binding to check against.
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
