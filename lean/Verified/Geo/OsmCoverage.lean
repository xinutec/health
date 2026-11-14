import Verified.FloatConst
/-!
# Local OSM mirror coverage

The gate in front of every OSM lookup: `covered` means the mirror holds this
area and an empty answer means no features; `needsFetch` means nobody fetched
here, so an empty answer would be a false claim.

* The search circle is approximated by its bounding box (over-demanding).
* One row must contain the whole box; there is no union of rows.
* Boxes are inclusive at both ends.
* Rows older than `COVERAGE_FRESH_DAYS` are dropped before containment.
* A row with no `fetchedAt` (legacy) is fresh, or the whole mirror refetches.

`hasLocalData` short-circuits all of it, staleness included, so a city already
brought back as overflow does not loop on Overpass timeouts. The host reads a
landmark box only under its fetch vocabulary (`osm_mirror::coverage_rows`)
and never asks `hasLocalData` for landmarks (`mirror_source`).

Pure and total; `cos` reaches only a box edge. UNPROVEN; pinned by the
`#guard`s.
-/

namespace Verified.Geo.OsmCoverage

/-- One degree of latitude, in metres, everywhere. Deliberately not the
`111_320` the Kalman filter uses: this module's own constant is `111_000`, and
sharing one would change which queries count as covered. -/
def METERS_PER_DEG_LAT : Float := 111000

open Verified.FloatConst (pi)

/-- Metres per degree of longitude at a latitude. -/
def metersPerDegLon (lat : Float) : Float :=
  111000 * Float.cos (lat * pi / 180)

/-- How recent a coverage row must be to count. Six months: stations and major
roads change slowly, and new venues are picked up the first time anyone queries
near them after the TTL expires. -/
def COVERAGE_FRESH_DAYS : Int := 180

/-- A fetched bounding box. `fetchedAt` is milliseconds, and `none` means a row
written before fetch times were tracked. -/
structure CoverageRow where
  minLat : Float
  maxLat : Float
  minLon : Float
  maxLon : Float
  fetchedAt : Option Int := none
  deriving Repr, Inhabited

/-- Is the search circle around `(lat, lon)` fully inside some single row? -/
def isPointCovered (lat lon radiusM : Float) (coverage : List CoverageRow) : Bool :=
  let dLat := radiusM / METERS_PER_DEG_LAT
  let dLon := radiusM / metersPerDegLon lat
  let qMinLat := lat - dLat
  let qMaxLat := lat + dLat
  let qMinLon := lon - dLon
  let qMaxLon := lon + dLon
  coverage.any fun c =>
    c.minLat <= qMinLat && c.maxLat >= qMaxLat && c.minLon <= qMinLon && c.maxLon >= qMaxLon

/-- `true` = covered, `false` = needs a fetch. Staleness filters before
containment, or a stale containing row would block every refresh. -/
def decideCoverage
    (lat lon radiusM : Float) (coverage : List CoverageRow)
    (nowMs : Int) (hasLocalData : Bool := false) : Bool :=
  if hasLocalData then true
  else
    let cutoffMs := nowMs - COVERAGE_FRESH_DAYS * 86400000
    let fresh := coverage.filter fun c =>
      match c.fetchedAt with
      | none => true
      | some t => t > cutoffMs
    isPointCovered lat lon radiusM fresh

/-! ## Guards

Expectations are recorded answers; a mismatch means the behaviour changed. -/

private def NOW : Int := 1700000000000
private def day : Int := 86400000

private def big : CoverageRow :=
  { minLat := 51.0, maxLat := 52.0, minLon := -1.0, maxLon := 1.0, fetchedAt := some (NOW - day) }
private def staleRow : CoverageRow :=
  { big with fetchedAt := some (NOW - (COVERAGE_FRESH_DAYS + 1) * day) }
private def legacy : CoverageRow := { big with fetchedAt := none }
private def dLat500 : Float := 500 / 111000
private def dLon500 : Float := 500 / metersPerDegLon 51.5
private def exactRow : CoverageRow :=
  { minLat := 51.5 - dLat500, maxLat := 51.5 + dLat500,
    minLon := -0.1 - dLon500, maxLon := -0.1 + dLon500, fetchedAt := some (NOW - day) }
private def west : CoverageRow :=
  { minLat := 51.0, maxLat := 52.0, minLon := -1.0, maxLon := -0.1, fetchedAt := some (NOW - day) }
private def east : CoverageRow :=
  { minLat := 51.0, maxLat := 52.0, minLon := -0.1, maxLon := 1.0, fetchedAt := some (NOW - day) }

-- `hasLocalData` short-circuits an empty coverage list, and a stale row.
#guard decideCoverage 51.5 (-0.1) 500 [] NOW true == true
#guard decideCoverage 51.5 (-0.1) 500 [staleRow] NOW true == true
-- No rows at all.
#guard decideCoverage 51.5 (-0.1) 500 [] NOW == false
-- One fresh containing row; the same row stale; the same row with no fetch time.
#guard decideCoverage 51.5 (-0.1) 500 [big] NOW == true
#guard decideCoverage 51.5 (-0.1) 500 [staleRow] NOW == false
#guard decideCoverage 51.5 (-0.1) 500 [legacy] NOW == true
-- A radius that pokes outside the row.
#guard decideCoverage 51.5 (-0.1) 500000 [big] NOW == false
-- Two rows that jointly cover the box, neither alone. There is no union.
#guard decideCoverage 51.5 (-0.1) 500 [west, east] NOW == false
-- A row exactly equal to the search bbox: inclusive at both ends.
#guard decideCoverage 51.5 (-0.1) 500 [exactRow] NOW == true
-- `isPointCovered` directly, including a high latitude where dLon >> dLat.
#guard isPointCovered 51.5 (-0.1) 500 [big] == true
#guard isPointCovered 51.5 (-0.1) 500 [exactRow] == true
#guard isPointCovered 70.0 20.0 500
  [{ minLat := 69.9, maxLat := 70.1, minLon := 19.9, maxLon := 20.1, fetchedAt := some (NOW - day) }] == true

end Verified.Geo.OsmCoverage
