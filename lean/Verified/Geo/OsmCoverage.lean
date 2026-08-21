/-!
# Local OSM mirror coverage (implementation-first port of `src/geo/osm-local.ts`)

The gate in front of every OSM lookup. `covered` means the local mirror has
already been filled for this area and a spatial query over it is an ANSWER;
`needsFetch` means nobody has fetched here, and the same query would return
nothing while looking exactly like an area with no roads in it.

That distinction is the whole point of the module. A host that reads the mirror
without asking this first cannot tell "no ways here" from "not fetched here",
and the first is a claim — the shape health #976 is open about, and the trap
#982 records for the Rust answerer.

Five rules, each small and each easy to get silently wrong:

* the search CIRCLE is approximated by its bounding box, conservatively — at the
  corners the box is larger than the circle, which only over-demands coverage;
* ONE row must contain the whole box. Two rows that jointly cover it do not
  count: there is no union logic, and adding some would change the answer;
* boxes are INCLUSIVE at both ends;
* a row older than `COVERAGE_FRESH_DAYS` is dropped BEFORE the containment
  check, so a stale row cannot suppress a refresh;
* a row with no `fetchedAt` is FRESH, not stale — legacy data from before
  tracking. Treating it as stale would re-fetch the whole mirror.

`hasLocalData` short-circuits all of it, staleness included. That is a
deliberate trade — "the data might be stale" against "do not query a flaky
network when the answer is already local" — and it is what stops a trip to an
unfetched city looping on Overpass timeouts when an earlier visit already
brought the roads back as overflow.

Pure and total. The only transcendental is `cos` in `metersPerDegLon`, which
reaches a box edge and never a coordinate. UNPROVEN; pinned by the `#guard`s,
every one of which is what `src/geo/osm-local.ts` actually did under Node —
see `lean/experiments/osmcoverage-refs.mts`.
-/

namespace Verified.Geo.OsmCoverage

/-- One degree of latitude, in metres, everywhere. Deliberately NOT the
`111_320` the Kalman filter uses: this module's own constant is `111_000`, and
sharing one would change which queries count as covered. -/
def METERS_PER_DEG_LAT : Float := 111000

private def pi : Float := 3.141592653589793

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

/-- Is the search circle around `(lat, lon)` fully inside SOME single row? -/
def isPointCovered (lat lon radiusM : Float) (coverage : List CoverageRow) : Bool :=
  let dLat := radiusM / METERS_PER_DEG_LAT
  let dLon := radiusM / metersPerDegLon lat
  let qMinLat := lat - dLat
  let qMaxLat := lat + dLat
  let qMinLon := lon - dLon
  let qMaxLon := lon + dLon
  coverage.any fun c =>
    c.minLat <= qMinLat && c.maxLat >= qMaxLat && c.minLon <= qMinLon && c.maxLon >= qMaxLon

/-- `true` = covered, `false` = needs a fetch.

⚠ The staleness filter runs BEFORE containment, not after. A stale row that
happens to contain the box must NOT report covered, or the area never refreshes.
-/
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

Every expectation below is what `src/geo/osm-local.ts` produced under Node, not
a value reasoned to. Regenerate with `npx tsx lean/experiments/osmcoverage-refs.mts`
after any change to the TypeScript; a guard that stops matching means the port
and the original have diverged, which is the whole question. -/

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

-- `hasLocalData` short-circuits an EMPTY coverage list, and a STALE row.
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
-- ⚠ Two rows that JOINTLY cover the box, neither alone. There is no union.
#guard decideCoverage 51.5 (-0.1) 500 [west, east] NOW == false
-- A row exactly equal to the search bbox: inclusive at both ends.
#guard decideCoverage 51.5 (-0.1) 500 [exactRow] NOW == true
-- `isPointCovered` directly, including a high latitude where dLon >> dLat.
#guard isPointCovered 51.5 (-0.1) 500 [big] == true
#guard isPointCovered 51.5 (-0.1) 500 [exactRow] == true
#guard isPointCovered 70.0 20.0 500
  [{ minLat := 69.9, maxLat := 70.1, minLon := 19.9, maxLon := 20.1, fetchedAt := some (NOW - day) }] == true

end Verified.Geo.OsmCoverage
