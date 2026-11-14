import Verified.Geo.Match
import Verified.Geo.OsmCorridor
import Verified.Geo.WalkMatchAdapt

/-!
# `RoadMatchAdapt` — `RoadMatchAnnotate.Env.matcher`, backed by the real matcher

The road counterpart of `WalkMatchAdapt`, bridging to
`Verified.Geo.Match.qMatchRoadSegment`.

    Env.matcher       Array MPt → Array Way → Option (Array MPt)
    qMatchRoadSegment Array QPt → Array QWay → Array (Array QPt)
                        → Option QMatchResult

Unlike the walk adapter, way names cross: `ROAD_QPROFILE`'s way-switch penalty
is the turn prior, so dropping them would change the route. The result is
`path`, the line both drawn and gated (`QMatchResult` has no `coarsePath`).
There is no building layer (`#[]`): a vehicle on a street needs none.

The 1e-7° conversions are `WalkMatchAdapt`'s, imported so the negative-tie
rounding has one copy. The corpus gates judge this arm; do not widen an
accepted delta to quiet a divergence.
-/

namespace Verified.Geo.RoadMatchAdapt

open Verified.Geo (QPt QWay)
open Verified.Geo.OsmCorridor (Way)
open Verified.Geo.DisplayGate (MPt)
open Verified.Geo.WalkMatchAdapt (toQ fromQ pathPtToQ)

def waysToQ (ways : Array Way) : Array QWay :=
  ways.map fun w => { coords := w.coords.map fun p => toQ p.lat p.lon, name := w.name }

/-- `RoadMatchAnnotate.Env.matcher`, backed by `qMatchRoadSegment`. -/
def matcher (fixes : Array MPt) (ways : Array Way) : Option (Array MPt) :=
  (Verified.Geo.qMatchRoadSegment (fixes.map pathPtToQ) (waysToQ ways) #[]).map
    fun r => r.path.map fromQ

/-! ## Specs

On literals, so these fail on a rule change rather than on a data change. -/

-- The name survives, because the road profile charges for changing way.
#guard (waysToQ #[{ osmId := 1, name := some "Marylebone Road", coords := #[⟨51.5, -0.1⟩] }])[0]!.name
  == some "Marylebone Road"
#guard (waysToQ #[{ osmId := 1, coords := #[⟨51.5, -0.1⟩] }])[0]!.name == none

-- `osmId` and `subtype` stop here — nothing in `QWay` reads them.
#guard (waysToQ #[{ osmId := 42, subtype := some "primary", coords := #[⟨51.5, -0.1⟩, ⟨51.6, -0.2⟩] }])[0]!.coords.size == 2

-- Same grid as the walk arm, on the London sign that makes the rule matter.
#guard (waysToQ #[{ osmId := 1, coords := #[⟨51.5661113948718, -0.1784117025641026⟩] }])[0]!.coords[0]!.lo
  == -1784117

-- No ways is nothing to match against, and the matcher says so rather than
-- inventing a line. This is the answer the shell gave.
#guard matcher #[⟨51.5, -0.1, 100⟩, ⟨51.6, -0.2, 200⟩] #[] == none

end Verified.Geo.RoadMatchAdapt
