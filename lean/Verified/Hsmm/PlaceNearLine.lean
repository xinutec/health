import Verified.Geo.OsmSpatial

/-!
# Is this place within walking distance of that line?

The decoder's hard constraint on place→line transitions. `buildTransitionMatrix`
HARD-ZEROES a transition from focus place P to train line L when P is not near a
station on L — you cannot board the Central Line from a flat two miles from any
Central Line station, and without this the trellis is free to say you did.

Port of `buildPlaceNearLine` in `src/cli/decode-day.ts`.

## ⚠ THIS WAS MISSING FROM THE RUST DECODE PATH ENTIRELY

Not ported wrongly — absent. `parseAssemble` reads `placeNearLine` as OPTIONAL
and an absent one is the empty set, which reads to the transition matrix as "no
place is near any line". That is not a softer constraint than the TypeScript's;
it is a DIFFERENT one, and it removes every hard zero rather than adding them.
The decode would have run, produced a plausible timeline, and allowed boardings
the TypeScript forbids (#982).

## The shell's half

`stationsOnLine` is an OSM query and stays out there. Which lines to ask about is
`Verified.Hsmm.Assemble.KNOWN_LINES`; how near counts is here.
-/

namespace Verified.Hsmm.PlaceNearLine

open Verified.Geo.OsmSpatial (haversineAt LEAN_EARTH_R)

/-- Walking distance to a station, in metres.

⚠ 400 m, and NOT the 300 m of {@link Verified.Geo.LineStations.MAX_DIST_M}.
The two measure different things: that one asks whether a station sits on a
line's track, this one asks whether a person would walk from their flat to the
station. A shared constant would make one of the two wrong. -/
def WALK_DIST_M : Float := 400

/-- A focus place, as the state space names it. -/
structure Place where
  id : Int
  lat : Float
  lon : Float
  deriving Repr, Inhabited, BEq

/-- A station serving some line. Only its position matters here. -/
structure Station where
  lat : Float
  lon : Float
  deriving Repr, Inhabited, BEq

/-- ⚠ HAVERSINE, at `LEAN_EARTH_R` (6 371 000 m) — the same formula and the same
radius as `decode-day.ts`'s own local copy. The equirectangular approximation
`Verified.Geo.LineStations` uses is fine for its purpose and is not this one:
at 400 m the two disagree by little, but "little" is all it takes to move a
place across a threshold that HARD-ZEROES a transition. -/
def distM (p : Place) (s : Station) : Float :=
  haversineAt LEAN_EARTH_R p.lat p.lon s.lat s.lon

/-- Is this place within walking distance of ANY station on the line? -/
def nearAnyStation (p : Place) (stations : Array Station) : Bool :=
  stations.any (fun s => distM p s ≤ WALK_DIST_M)

/-- The `"{placeId}|{lineName}"` keys for one line.

⚠ A LINE WITH NO STATIONS CONTRIBUTES NOTHING, which is the TypeScript's
`if (stations.length === 0) continue`. It reads the same as a line every place is
far from, and it must: an OSM gap is not evidence that nobody lives near the
Piccadilly Line. -/
def pairsForLine (places : Array Place) (line : String) (stations : Array Station)
    : Array String :=
  if stations.isEmpty then #[]
  else places.filterMap (fun p => if nearAnyStation p stations then some s!"{p.id}|{line}" else none)

/-- Every place/line pair within walking distance, over all the lines the shell
resolved stations for.

⚠ LINES OUTER, PLACES INNER — the TypeScript's loop order, kept so the emitted
order is the same one the consumer has always seen. The consumer builds a set
from it, so order cannot change a decode; a diff of the two arms reads far more
easily when it is stable. -/
def buildPlaceNearLine (places : Array Place) (lines : Array (String × Array Station))
    : Array String :=
  lines.foldl (fun acc (line, sts) => acc ++ pairsForLine places line sts) #[]

/-! ## Guards -/

private def P (id : Int) (lat lon : Float) : Place := ⟨id, lat, lon⟩
private def S (lat lon : Float) : Station := ⟨lat, lon⟩

-- A degree of latitude is 111 320 m at the equator by the flat approximation and
-- ~111 195 m by this haversine; the cases below are stated in what the haversine
-- itself measures, so they pin the formula rather than a conversion.
#guard (distM (P 1 51.5 (-0.1)) (S 51.5 (-0.1))) == 0.0

-- ⚠ THE BOUNDARY IS PINNED FROM BOTH SIDES, roughly a metre apart. A rule
-- tested only from the far side passes with the comparison reversed.
--
-- ⚠ The `≤` versus `<` of `WALK_DIST_M` itself is NOT pinned, and claiming it
-- were would be false precision: no pair of coordinates lands a haversine on
-- exactly 400.0, so the two comparisons are indistinguishable by any guard. It
-- is `≤` because the TypeScript's is.
#guard (distM (P 1 51.5 0) (S 51.50359 0) - 399.189787).abs < 1e-5   -- inside
#guard (distM (P 1 51.5 0) (S 51.50360 0) - 400.301736).abs < 1e-5   -- outside
#guard nearAnyStation (P 1 51.5 0) #[S 51.50359 0]
#guard !nearAnyStation (P 1 51.5 0) #[S 51.50360 0]

-- ANY station is enough: the first far one must not decide the answer.
#guard nearAnyStation (P 1 51.5 0) #[S 52.9 0, S 51.5 0]
#guard !nearAnyStation (P 1 51.5 0) #[S 52.9 0, S 50.1 0]

-- ⚠ NO STATIONS IS NO PAIRS, not "near nothing" and not an error.
#guard (pairsForLine #[P 1 51.5 0] "Central Line" #[]).isEmpty
#guard (pairsForLine #[] "Central Line" #[S 51.5 0]).isEmpty

-- The key is `id|line`, and the id renders as a bare integer.
#guard pairsForLine #[P 42 51.5 0] "Central Line" #[S 51.5 0] == #["42|Central Line"]

-- ⚠ A PLACE APPEARS ONCE PER LINE IT IS NEAR, and lines it is far from leave no
-- key at all — the absence IS the hard zero.
#guard buildPlaceNearLine #[P 1 51.5 0, P 2 52.9 0]
        #[("Central Line", #[S 51.5 0]), ("Circle Line", #[S 52.9 0])]
      == #["1|Central Line", "2|Circle Line"]

-- Lines outer, places inner.
#guard buildPlaceNearLine #[P 1 51.5 0, P 2 51.5 0]
        #[("A", #[S 51.5 0]), ("B", #[S 51.5 0])]
      == #["1|A", "2|A", "1|B", "2|B"]

#guard (buildPlaceNearLine #[P 1 51.5 0] #[]).isEmpty

end Verified.Hsmm.PlaceNearLine
