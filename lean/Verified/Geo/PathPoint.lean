import Verified.Geo.WalkableRoute
/-!
# The drawn-path vertex

`EnrichedSegment` carries four derived polylines — `snappedPath` (rail track),
`matchedPath` (street network), `walkMatchedPath` (walkable network) and
`walkSmoothedPath` (MAP reconstruction). All four are `SnappedPoint[]` in the
TS: one shape, declared once in `src/geo/rail-snap.ts`.

The Lean port grew a separate vertex record per module, and they diverged on
one field: `ts` came out `Int` where a module only ever compared timestamps, and
`Float` where it read the interpolation. `Float` is the faithful one —
`interpolateTimes` divides a span by a distance ratio and the result reaches the
API unrounded, so an `Int` vertex is a projection that silently rounds a value
production serves.

This is the single vertex every pass in the fold agrees on. It has no
dependencies so that any module may import it.
-/

namespace Verified.Geo

/-- One vertex of a derived polyline, carrying an interpolated timestamp
(`SnappedPoint` in `src/geo/rail-snap.ts`). -/
structure PathPt where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

/-- The positional part, where a caller wants a plain `Pt`. -/
def PathPt.pt (p : PathPt) : Verified.Geo.WalkableRoute.Pt := ⟨p.lat, p.lon⟩

end Verified.Geo
