import Verified.Geo.Match
import Verified.Geo.OsmCorridor
import Verified.Geo.WalkMatchAdapt

/-!
# `RoadMatchAdapt` — `RoadMatchAnnotate.Env.matcher`, backed by the real matcher

The road twin of `WalkMatchAdapt`, and it exists for the same reason: the pass
takes its matcher as an injected `Env` field, every caller so far has passed
`fun _ _ => none`, and the matcher it wants is already written —
`Verified.Geo.Match.qMatchRoadSegment`, the port of `matchRoadSegment`.

    Env.matcher       Array MPt → Array Way → Option (Array MPt)
    qMatchRoadSegment Array QPt → Array QWay → Array (Array QPt)
                        → Option QMatchResult

# Two differences from the walk adapter, both load-bearing

**Names cross.** `WalkMatchAdapt` drops them and says why: `WALK_QPROFILE`
charges nothing for a way change, so a walk way's name decides nothing. The road
profile is where that field came from — `ROAD_QPROFILE`'s way-switch penalty is
the turn prior — so dropping a name here would silently change the route. `Way`
carries one and `QWay` wants one, so it is a straight copy; `osmId` and
`subtype` are read by the corridor fetch upstream and by nothing the matcher
does, so they stop here.

**The result is `path`, not `coarsePath`.** `RoadMatchAnnotate` hands
`matchImprovesDisplay` the same line it draws (`road-match-annotate.ts:115`
passes `result.path`), unlike the walk pass, which gates on `coarsePath` and
draws the finer line (#369). `QMatchResult` has no `coarsePath` to confuse it
with — its second field is `routeDetail` — so this is one field, taken whole.

# Buildings

The road matcher gets none: `matchRoadSegment(fixes, { ways })` has no
impassable layer, because a vehicle on a mapped street does not need one and
`buildingsNear` is never read on a road leg. `#[]` here is the TS's absence, not
a shortcut.

# The quantisation, and where it is adjudicated

Same 1e-7° grid and the same `Math.round` rule as the walk arm — the conversions
are `WalkMatchAdapt`'s, imported rather than copied, because a second copy of a
rounding rule that disagrees with the first on negative ties is precisely the
defect that file's header exists to prevent (see also #957).

So, exactly as for the walk arm: wiring this is NOT expected to leave the day
gate unchanged, and the day gate compares exactly. `RoadMatchAnnotate.lean`'s
own header says the quantised arm is "measured and ceilinged against the TS
rather than bit-identical to it (#395 / #403)". Judge it with
`compare-match --gate`, and do not quiet a divergence by widening the
accepted-delta manifest — `deploy.sh:139`.
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
