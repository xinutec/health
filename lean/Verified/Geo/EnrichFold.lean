import Verified.Geo.Enrich
import Verified.Geo.StayEnrich
-- For `Shed.PointF` — the Kalman fix as the day's `Env` carries it. Neither of
-- the two branches needs it; the LOOP does, because sampling the window is the
-- dispatch's job and not either branch's.
import Verified.Geo.StaySplit
/-!
# The OSM enrichment stage (port of the `enriched` loop, `src/geo/velocity.ts`
903-1054)

The loop between the split stage and the five corrections. It has exactly two
branches and both are already ported: {@link Verified.Geo.Enrich} is the moving
one and {@link Verified.Geo.StayEnrich} is the stationary one. What is here is
the DISPATCH — which branch a segment takes, what it is handed, and the three
ways a segment leaves the loop untouched.

With it the Lean day stops being two sub-chains (#430 B2). `classifySegments`'
output runs through {@link Verified.Geo.SplitFold} to here and out into
{@link Verified.Geo.PreFold}, and the enrichment stage is no longer a gap the
comparison has to step over.

## Three ways out without being enriched

All three are the TS's, and none of them is an error:

* `pointCount = 0` — a synthetic gap segment. Enriching it with road names would
  invent context from no GPS data at all.
* an empty window — the same refusal one step later, when the fixes exist but
  none of them fall inside this segment.
* a stationary segment the venue resolver declines to name, which
  {@link Verified.Geo.StayEnrich.enrichStay} returns unchanged.

The TS has a FOURTH: the `try` around the body turns any lookup failure into a
warning and an unenriched segment. That one is deliberately not ported. The Lean
arm's lookups are recorded tables which panic on a key the run never asked
about, and a miss is the finding — swallowing it here would turn a wiring
divergence into a segment that merely looks unenriched.

## `prev` is the loop's INPUT, not its output

`stationAtTrainAlight` reads `refinedSegments[i - 1]` — the segment as the split
stage left it, not as this loop enriched it. The difference is real: enrichment
writes `refinedMode`, and `effMode` prefers it, so a leg this loop had just
promoted to `train` would answer the question differently. The TS indexes the
input array, so this does too.

## What is NOT modelled

`ENRICH_CONCURRENCY` and the `mapLimit` it bounds. The segments are independent
— the TS's own comment says only wall-clock shape changes — so the concurrency
is a pool-pressure decision, not part of the computation.
-/

namespace Verified.Geo.EnrichFold

open Verified.Geo.SegmentMerge (Seg ResolvedPlace)
-- `Shed` is TOP-LEVEL, not nested under `StaySplit` — see `StaySplit.lean:109`.
open Shed (PointF)

/-- What the loop asks the world. All five are the caller's, and all five are
already answered somewhere in the fold's `Env` — this record exists to name the
subset the enrichment stage reads rather than to introduce new lookups. -/
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

/-- Run the enrichment stage over one day's segments. -/
def enrichFold (reads : Reads) (biom : Verified.Geo.StayEnrich.Biom)
    (places : List Verified.Geo.StayEnrich.NamedPlace)
    (points : Array PointF) (segs : Array Seg) : Array Seg :=
  segs.mapIdx fun i seg =>
    if seg.pointCount == 0 then seg else
    let segPoints := points.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs
    if segPoints.isEmpty then seg else
    if seg.mode == "stationary" then
      let n := Float.ofNat segPoints.size
      let cLat := (segPoints.foldl (fun acc p => acc + p.lat) 0) / n
      let cLon := (segPoints.foldl (fun acc p => acc + p.lon) 0) / n
      Verified.Geo.StayEnrich.enrichStay
        { stations := reads.stations
          -- The window and the zone are the SEGMENT's, so they are bound here
          -- rather than passed through the cascade: which coordinate to ask
          -- about is the cascade's decision, and the zone follows the
          -- coordinate.
          place := fun lat lon pref withStay =>
            reads.place lat lon pref
              (if withStay then some (seg.startTs, seg.endTs, reads.tzAt lat lon) else none) }
        biom places (if i == 0 then none else some segs[i - 1]!) seg cLat cLon
    else
      (Verified.Geo.Enrich.enrichMovingSegment reads.ways reads.geocode seg
        (segPoints.map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt))).getD seg

/-! ## Guards

The two branches are pinned in their own modules. What is pinned here is the
DISPATCH: which branch a segment takes, the three untouched exits, and that
`prev` comes from the input array. -/

section Guards

open Verified.Geo.TubeHop (NearbyStation)

/-- Binary-exact, so a guard fails on the window rather than on the rounding of
a mean — the same choice {@link Verified.Geo.SplitFold} makes and for the same
reason. -/
private def LAT : Float := 51.5
private def LON : Float := -0.5

private def pt (ts : Int) (lat lon : Float) : PointF := { ts, lat, lon, speedKmh := 0 }

private def POINTS : Array PointF := #[pt 0 LAT LON, pt 60 LAT LON, pt 120 LAT LON]

/-- Reports the coordinate and both flags, so a guard can pin the QUESTION the
dispatch asked and not only the name that came back. -/
private def spy : Reads :=
  { ways := fun _ _ => #[]
    geocode := fun _ _ _ => none
    stations := fun _ _ _ => #[]
    place := fun lat lon pref stay =>
      some { label := s!"{fx lat}|{fx lon}|{pref}|{stay.isSome}", city := none }
    tzAt := fun _ _ => "Europe/London" }
  where fx (x : Float) : String := (Verified.JsNum.toFixed x 3).getD "?"

private def stay : Seg :=
  { startTs := 0, endTs := 120, mode := "stationary", pointCount := 3 }

private def run (segs : Array Seg) : Array Seg := enrichFold spy {} [] POINTS segs

-- A stay with no mined place is named by the resolver, at the day's centroid,
-- WITH a window — the no-winner arm.
#guard (run #[stay])[0]!.place == some "51.500|-0.500|false|true"

-- The centroid is the MEAN of the fixes in the window, not the first of them and
-- not the segment's own coordinates. Pinned here because nothing downstream
-- would catch a wrong one on a synthetic day: the branches take whatever they
-- are handed. On a real day the recorded lookup tables do catch it — a 0.01°
-- perturbation aborts the day gate on an uncaptured `tzAt` key — but that is the
-- corpus's finding, not this module's, and this is where it belongs.
--
-- Read to three decimals rather than compared as doubles: 51.6 is not exact in
-- binary and its mean with 51.5 is not either, so a guard on the raw double
-- would be a guard on the last bit. What is under test is WHICH fixes enter the
-- mean, and the rendering leaves exactly that visible.
private def OFFSET : Array PointF := #[pt 0 51.5 (-0.5), pt 120 51.6 (-0.25)]
#guard (enrichFold spy {} [] OFFSET #[stay])[0]!.place == some "51.550|-0.375|false|true"
-- Only the fixes INSIDE the window count towards it.
private def SPILL : Array PointF := OFFSET.push (pt 600 52.0 0.0)
#guard (enrichFold spy {} [] SPILL #[stay])[0]!.place == some "51.550|-0.375|false|true"

-- A synthetic gap segment is left alone even though its window has fixes.
#guard (run #[{ stay with pointCount := 0 }])[0]!.place == none
-- So is a segment whose window holds none — the fixes exist, just not here.
#guard (run #[{ stay with startTs := 600, endTs := 900 }])[0]!.place == none
-- ... and a resolver with no answer leaves the stay unnamed rather than
-- naming it nothing.
#guard (enrichFold { spy with place := fun _ _ _ _ => none } {} [] POINTS #[stay])[0]!.place == none

/-! ### The branch, and where `prev` comes from -/

private def STATION : NearbyStation :=
  { name := "Finchley Road", lat := some LAT, lon := some LON, distanceM := 10 }

private def withStation : Reads := { spy with stations := fun _ _ _ => #[STATION] }

private def train : Seg := { stay with mode := "train", startTs := -120, endTs := 0 }

-- A stay right after a train is at the station, so the alight arm reads the
-- PRECEDING element of the array it was handed.
#guard (enrichFold withStation {} [] POINTS #[train, stay])[1]!.place == some "Finchley Road"
-- The first segment has no predecessor, so the same stay alone is not.
#guard (enrichFold withStation {} [] POINTS #[stay])[0]!.place == some "51.500|-0.500|false|true"

-- A moving segment takes the other branch entirely: no place is written, and
-- `refinedMode` is — including from a resolver that would have named a stay.
private def walk : Seg := { stay with mode := "walking", avgSpeed := 4 }
#guard (run #[walk])[0]!.place == none
#guard (run #[walk])[0]!.refinedMode == some "walking"

end Guards

end Verified.Geo.EnrichFold
