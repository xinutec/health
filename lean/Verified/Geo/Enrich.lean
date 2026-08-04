import Verified.Geo.RefineMode
import Verified.Geo.Velocity
/-!
# OSM enrichment for a moving segment (port of `enrichMovingSegment`,
`src/geo/velocity.ts`)

Sample along the leg, aggregate the ways near it, refine the mode, name the road,
tag the city.

## Why this is in the fold at all

The enrichment STAGE runs once per moving segment, ~30 passes before the cascade.
That stage is not the fold's business. But `vehicleSplit` carves a hidden ride out
of a walk long after it, leaving two on-foot remainders whose inherited
enrichment was derived from a window that spanned the ride — the 2026-07-12 walk
down Upper Street labelled "Euston Road" because its parent had begun at King's
Cross, on the far side of a tube. `reenrichSplitWalks` sends those remainders back
through this function, so the fold needs it.

It reads `mode`, `avgSpeed` and `maxSpeed`, so a remainder's kinematics must be
recomputed BEFORE it is re-enriched — otherwise the cascade is handed the ride's
speeds and duly reaches the ride's conclusion about a walk. `walkRemainder` does
that, upstream in the same pass list.

## What is here and what stays shell

`nearbyWays` and `reverseGeocode` are lookups; the caller supplies them. Every
decision taken on their answers is here.

`computeRailRoadProximity` is NOT computed. The TS computes it and passes it to
`refineMode`, which forwards it to the FACTOR arm only — and the corpus takes the
legacy cascade (`USE_FACTOR_SCORER` is unset; see `RefineMode`). Computing a value
no reachable branch reads would be modelling the TS's shape rather than its
behaviour. If the flag ever goes on, this is one of the things that has to change,
and it is named here so that is a lookup rather than a search.

`biometricCtx` is not modelled for the same reason one level down: it is gated by
`USE_BIOMETRIC_FACTOR`, which is gated UNDER `USE_FACTOR_SCORER`.

UNPROVEN; pinned against Node/V8 (`lean/experiments/enrich-refs.mts`).
-/

namespace Verified.Geo.Enrich

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Factors (NearbyWay)
open Verified.Geo.RefineMode (sampleIdxs dedupNearestWays refineModeLegacyCascade
  rejectImplausibleDriving Plausible)

/-! ## City, from two reverse geocodes -/

/-- The Nominatim address fields `extractCity` reads. A projection of
`NominatimResult`, not the whole record: everything else in that response is read
by the venue namers, which are not in this path. -/
structure Address where
  stateDistrict : Option String := none
  city : Option String := none
  town : Option String := none
  village : Option String := none
  municipality : Option String := none
  deriving Inhabited, BEq, Repr

/-- Metro areas whose administrative subdivisions are not useful as timeline
headers — London's 33 boroughs all live inside Greater London and the user thinks
of them as "London". -/
def METROPOLITAN_AREAS : List String :=
  ["Greater London", "Greater Manchester", "Île-de-France"]

/-- Cities that ARE a subdivision of a metro and should display as the metro. 31
of London's boroughs return `Greater London` from Nominatim directly; these two
are historic cities in their own right and need saying. -/
def SUBDIVISION_TO_METRO : List (String × String) :=
  [("City of Westminster", "Greater London"), ("City of London", "Greater London")]

/-- Best "city" name from one reverse geocode. Nominatim fills exactly one of
`city` / `town` / `village` / `municipality` depending on admin level and
population, so they are walked in preference order. -/
def extractCity : Option Address → Option String
  | none => none
  | some a =>
    -- A recognised metro out-ranks the city: one London day under one header,
    -- rather than split into "City of Westminster" / "Greater London".
    if a.stateDistrict.any (METROPOLITAN_AREAS.contains ·) then a.stateDistrict
    else
      match a.city.orElse fun _ => a.town.orElse fun _ => a.village.orElse fun _ =>
          a.municipality with
      | none => none
      | some raw =>
        match SUBDIVISION_TO_METRO.find? (·.1 == raw) with
        | some (_, metro) => some metro
        | none => some raw

/-- The city two reverse-geocoded points AGREE on, else none. A walk inside one
city earns a city header; a drive between two cities stays untagged and reads as
a transit between groups. -/
def commonCity (a b : Option Address) : Option String :=
  let ca := extractCity a
  match ca with
  | none => none
  | some _ => if ca == extractCity b then ca else none

/-! ## The enrichment -/

/-- How many points along the leg are sampled for ways, so the OSM evidence
reflects the whole route rather than wherever the centroid happens to land. -/
def N_SAMPLES : Nat := 5

/-- Zoom for the endpoint reverse geocodes. City needs AREA-level truth, so this
is 16 rather than the building-level 18 the venue namers use. -/
def CITY_ZOOM : Int := 16

/-- `Math.round(n * 1000) / 1000` — a ~110 m grid. Raw endpoints never repeat
between days, so keying the city lookup on them paid live Nominatim on every
fresh compute; habitual endpoints now share one cell forever. The cost is a city
boundary crossing a cell, which the both-endpoints-must-agree rule absorbs. -/
def cityGrid (n : Float) : Float := Float.floor (n * 1000 + 0.5) / 1000

/-- A Kalman fix as this reads it: the leg's own points, in time order. -/
structure Pt where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- Enrich one moving segment from its OWN geometry.

`none` when the leg has no points. The TS's caller guards that case before
calling and leaves such a leg alone, so the two agree: nothing is written.

Note what is unconditional and what is not. `refinedMode`, `refinedReason` and
`wayName` are always written — including `wayName := none`, which is the pass
CLEARING an inherited label it can no longer justify. `city` and
`roadCorridorFraction` are written only when the new answer is present, matching
the TS's conditional spread; a leg that fails to resolve a city keeps whatever it
had rather than being blanked. -/
def enrichMovingSegment
    (waysLookup : Float → Float → Array NearbyWay)
    (geocode : Float → Float → Int → Option Address)
    (seg : Seg) (segPoints : Array Pt) : Option Seg :=
  if segPoints.size == 0 then none else
  let n := segPoints.size
  let sampleCount := min N_SAMPLES n
  -- Asked ONCE per sample, read twice below. The TS's `wayResults`.
  let wayResults := (sampleIdxs n sampleCount).map fun i =>
    let p := segPoints[i]!
    waysLookup p.lat p.lon
  let aggregated := dedupNearestWays wayResults
  -- `computeRoadNearestFraction` reads only distance/type/subtype, so the ways
  -- narrow to its record. Per SAMPLE, not per deduped way: the fraction counts
  -- how many sample POINTS had a road nearer than any rail.
  let roadCorridorFraction := Verified.Geo.Velocity.computeRoadNearestFraction
    (wayResults.toList.map fun ways => ways.toList.map fun w =>
      ({ distanceM := w.distanceM, type := w.type, subtype := w.subtype } :
        Verified.Geo.RailRoadProximity.NearbyWay))
  let first := segPoints[0]!
  let last := segPoints[n - 1]!
  let startPlace := geocode (cityGrid first.lat) (cityGrid first.lon) CITY_ZOOM
  let endPlace := geocode (cityGrid last.lat) (cityGrid last.lon) CITY_ZOOM
  let refined := refineModeLegacyCascade seg.mode seg.avgSpeed aggregated
  let plausible := rejectImplausibleDriving
    ({ mode := refined.mode, wayName := refined.wayName } : Plausible) seg.maxSpeed aggregated
  let movingCity := commonCity startPlace endPlace
  some { seg with
    -- Temper motion-only confidence by the corridor evidence: a "driving" leg
    -- the GPS shows off any road is ambiguous (could be rail), so it should not
    -- read a confident 100% car.
    confidence := Verified.Geo.Segments.roadSupportedConfidence plausible.mode seg.confidence
      roadCorridorFraction
    refinedMode := some plausible.mode
    refinedReason := some (plausible.reason.getD refined.reason)
    wayName := plausible.wayName
    -- TRUTHINESS, not presence: the TS spreads `movingCity ? {city} : {}`, so an
    -- empty name leaves the existing one standing.
    city := match movingCity with | some c => if c == "" then seg.city else some c
                                  | none => seg.city
    roadCorridorFraction := roadCorridorFraction.orElse fun _ => seg.roadCorridorFraction }

/-! ## Parity with Node/V8 (values from `lean/experiments/enrich-refs.mts`) -/

section EnrichGuards

private def addr (sd c t v m : Option String) : Address :=
  { stateDistrict := sd, city := c, town := t, village := v, municipality := m }
private def N : Option String := none

#guard extractCity none == N
-- The metro out-ranks the city.
#guard extractCity (some (addr (some "Greater London") (some "City of Westminster") N N N))
  == some "Greater London"
-- An unrecognised state_district falls through to the city cascade.
#guard extractCity (some (addr (some "Gelderland") N (some "Arnhem") N N)) == some "Arnhem"
-- The two boroughs that need the explicit mapping.
#guard extractCity (some (addr N (some "City of London") N N N)) == some "Greater London"
#guard extractCity (some (addr N (some "Amsterdam") N N N)) == some "Amsterdam"
-- Preference order, and the honest blank when none of the four is present.
#guard extractCity (some (addr N N N (some "Otterlo") N)) == some "Otterlo"
#guard extractCity (some (addr N N N N (some "Ede"))) == some "Ede"
#guard extractCity (some (addr N N N N N)) == N

private def london : Option Address := some (addr (some "Greater London") N N N N)
private def arnhem : Option Address := some (addr N (some "Arnhem") N N N)
#guard commonCity london london == some "Greater London"
#guard commonCity london arnhem == N
#guard commonCity london none == N
#guard commonCity none none == N

-- `Math.round` is round-half-toward-+∞, which is NOT symmetric about zero: the
-- .0005 case rounds up on both signs, so a southern-hemisphere or western
-- coordinate lands on a different cell edge than its mirror.
#guard cityGrid 51.5024999 == 51.502
#guard cityGrid 51.5025 == 51.503
#guard cityGrid (-0.1235) == -0.123
#guard cityGrid (-0.1236) == -0.124

-- Evenly spaced sampling, including the degenerate runs the TS guards with
-- `Math.max(1, sampleCount - 1)`.
#guard sampleIdxs 9 5 == #[0, 2, 4, 6, 8]
#guard sampleIdxs 10 5 == #[0, 2, 4, 6, 9]
#guard sampleIdxs 3 3 == #[0, 1, 2]
#guard sampleIdxs 1 1 == #[0]

end EnrichGuards

end Verified.Geo.Enrich
