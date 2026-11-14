import Verified.Geo.WalkableRoute
/-!
# The drawn-path vertex

The one vertex shape of `EnrichedSegment`'s four derived polylines:
`snappedPath` (rail), `matchedPath` (streets), `walkMatchedPath` (walkable
network) and `walkSmoothedPath` (reconstruction). `ts` is `Float`:
`interpolateTimes` produces fractional timestamps the API serves unrounded. No
dependencies, so any module may import it.
-/

namespace Verified.Geo

/-- One vertex of a derived polyline, carrying an interpolated timestamp. -/
structure PathPt where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

/-- The positional part, where a caller wants a plain `Pt`. -/
def PathPt.pt (p : PathPt) : Verified.Geo.WalkableRoute.Pt := ⟨p.lat, p.lon⟩

end Verified.Geo
