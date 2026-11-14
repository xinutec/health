import Verified.Geo.OsmSpatial

/-!
# Is this place within walking distance of that line?

`buildTransitionMatrix` hard-zeroes focus place P → train line L when P is not
near a station on L: nobody boards a line two miles from its stations.

⚠ An absent `placeNearLine` parses as the empty set, "no place near any line",
which removes every hard zero: a plausible timeline with forbidden boardings.

`stationsOnLine` is an OSM query in Rust; the lines are
`Verified.Hsmm.Assemble.KNOWN_LINES`; how near counts is here.
-/

namespace Verified.Hsmm.PlaceNearLine

open Verified.Geo.OsmSpatial (haversineAt LEAN_EARTH_R)

/-- Walking distance to a station, in metres. Not
{@link Verified.Geo.LineStations.MAX_DIST_M}'s 300 m, which asks whether a
station is on a track, not whether someone walks there. -/
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

/-- Haversine, at `LEAN_EARTH_R` (6 371 000 m), not `LineStations`'
equirectangular approximation: a small difference can move a place across a
threshold that hard-zeroes a transition. -/
def distM (p : Place) (s : Station) : Float :=
  haversineAt LEAN_EARTH_R p.lat p.lon s.lat s.lon

/-- Is this place within walking distance of any station on the line? -/
def nearAnyStation (p : Place) (stations : Array Station) : Bool :=
  stations.any (fun s => distM p s ≤ WALK_DIST_M)

/-- The `"{placeId}|{lineName}"` keys for one line. A line with no stations
contributes nothing, as if every place were far: an OSM gap is no evidence. -/
def pairsForLine (places : Array Place) (line : String) (stations : Array Station)
    : Array String :=
  if stations.isEmpty then #[]
  else places.filterMap (fun p => if nearAnyStation p stations then some s!"{p.id}|{line}" else none)

/-- Every place/line pair within walking distance, lines outer, places inner.
The consumer builds a set; the stable order keeps diffs readable. -/
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

-- The boundary is pinned from both sides, about a metre apart. `≤` vs `<` at
-- exactly 400.0 is not: no coordinates land a haversine there.
#guard (distM (P 1 51.5 0) (S 51.50359 0) - 399.189787).abs < 1e-5   -- inside
#guard (distM (P 1 51.5 0) (S 51.50360 0) - 400.301736).abs < 1e-5   -- outside
#guard nearAnyStation (P 1 51.5 0) #[S 51.50359 0]
#guard !nearAnyStation (P 1 51.5 0) #[S 51.50360 0]

-- Any station is enough: the first far one must not decide the answer.
#guard nearAnyStation (P 1 51.5 0) #[S 52.9 0, S 51.5 0]
#guard !nearAnyStation (P 1 51.5 0) #[S 52.9 0, S 50.1 0]

-- No stations is no pairs, not "near nothing" and not an error.
#guard (pairsForLine #[P 1 51.5 0] "Central Line" #[]).isEmpty
#guard (pairsForLine #[] "Central Line" #[S 51.5 0]).isEmpty

-- The key is `id|line`, and the id renders as a bare integer.
#guard pairsForLine #[P 42 51.5 0] "Central Line" #[S 51.5 0] == #["42|Central Line"]

-- A place appears once per line it is near, and lines it is far from leave no
-- key at all — the absence is the hard zero.
#guard buildPlaceNearLine #[P 1 51.5 0, P 2 52.9 0]
        #[("Central Line", #[S 51.5 0]), ("Circle Line", #[S 52.9 0])]
      == #["1|Central Line", "2|Circle Line"]

-- Lines outer, places inner.
#guard buildPlaceNearLine #[P 1 51.5 0, P 2 51.5 0]
        #[("A", #[S 51.5 0]), ("B", #[S 51.5 0])]
      == #["1|A", "2|A", "1|B", "2|B"]

#guard (buildPlaceNearLine #[P 1 51.5 0] #[]).isEmpty

end Verified.Hsmm.PlaceNearLine
