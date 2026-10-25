import Verified.Geo.Enrich
import Verified.Geo.StayEnrich
-- For `Shed.PointF`, the Kalman fix as the day's `Env` carries it.
import Verified.Geo.StaySplit
/-!
# Naming one stay from its own fixes

What is left of the OSM enrichment loop (`src/geo/velocity.ts`'s `enriched`):
the stationary branch for ONE stay, with the window's centroid and scatter
computed here, and the record of lookups it reads. `walkDwell` names a stop it
carved out of a walk with it ({@link Verified.Geo.StayEnrich.enrichStay}), so a
carved stop is elected and named by the same rules as every other stay.
-/

namespace Verified.Geo.EnrichFold

open Verified.Geo.SegmentMerge (Seg ResolvedPlace)
-- `Shed` is TOP-LEVEL, not nested under `StaySplit`.
open Shed (PointF)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- What the passes ask the world, each already answered in the fold's `Env`. -/
structure Reads where
  /-- `osm.nearbyWays(lat, lon)`. -/
  ways : Float → Float → Array Verified.Geo.Factors.NearbyWay
  /-- `osm.reverseGeocode(lat, lon, zoom)`, narrowed to the address. -/
  geocode : Float → Float → Int → Option Verified.Geo.Enrich.Address
  /-- `osm.nearbyStations(lat, lon, radiusM)`. -/
  stations : Float → Float → Float → Array Verified.Geo.TubeHop.NearbyStation
  /-- `bestPlace` composed with `placeLabel` and `extractCity`. The stay window
  is `(startUnix, endUnix, tz)` when there is one and `none` for the two arms
  that pass none — the resolver takes a different path on each, so they are not
  the same question asked with a default. -/
  place : Float → Float → Bool → Option (Int × Int × String) → Option ResolvedPlace
  /-- `tzLookup(lat, lon)`, asked at the coordinate being NAMED rather than at
  the segment's own centroid — the snap arm names a stay at the mined place's
  stored coordinates and resolves the zone there too. -/
  tzAt : Float → Float → String

/-- Name ONE stay from its own fixes (Home and Work outright, a residence at its
place, the rest at the naming coordinate), with its `focusPlaceId`. A window
with no fixes comes back unchanged. -/
def nameStay (reads : Reads) (biom : Verified.Geo.StayEnrich.Biom)
    (places : List Verified.Geo.StayEnrich.NamedPlace)
    (points : Array PointF) (prev : Option Seg) (seg : Seg) : Seg :=
  let segPoints := points.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs
  if segPoints.isEmpty then seg else
  let n := Float.ofNat segPoints.size
  let cLat := (segPoints.foldl (fun acc p => acc + p.lat) 0) / n
  let cLon := (segPoints.foldl (fun acc p => acc + p.lon) 0) / n
  -- How precisely the day's fixes locate him, which the naming coordinate
  -- weighs against the elected place's own σ: the RMS scatter of the fixes
  -- about their mean, inflated by how little of the stay they observed. A
  -- six-hour stay indoors with three fixes (2026-06-02 at the clinic) is
  -- three moments GPS got through, near a window or a door, not where he sat;
  -- their scatter (34 m) says nothing about the other 368 minutes. Dividing
  -- by √(observed fraction) leaves a stay with a fix a minute at its scatter
  -- and sends a sparse one back to the place.
  let scatterM := Float.sqrt ((segPoints.foldl (fun acc p =>
    let d := haversineMeters cLat cLon p.lat p.lon
    acc + d * d) 0) / n)
  let minutes := max 1.0 (Float.ofInt (seg.endTs - seg.startTs) / 60)
  let observed := min 1.0 (n / minutes)
  -- Floored BEFORE the inflation: three coincident fixes have no scatter and
  -- would otherwise inflate to nothing.
  let spreadM := max scatterM Verified.Geo.StayEnrich.SPREAD_FLOOR_M / Float.sqrt observed
  Verified.Geo.StayEnrich.enrichStay
    { stations := reads.stations
      -- The window and the zone are the SEGMENT's, so they are bound here
      -- rather than passed through the cascade: which coordinate to ask about
      -- is the cascade's decision, and the zone follows the coordinate.
      place := fun lat lon pref withStay =>
        reads.place lat lon pref
          (if withStay then some (seg.startTs, seg.endTs, reads.tzAt lat lon) else none) }
    biom places prev seg cLat cLon spreadM

end Verified.Geo.EnrichFold
