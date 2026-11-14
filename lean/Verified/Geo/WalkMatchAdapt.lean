import Verified.Geo.Match
import Verified.Geo.WalkAnnotate
import Verified.JsNum

/-!
# `WalkMatchAdapt` — `WalkAnnotate.Env.matcher`, backed by the real matcher

Bridges `WalkAnnotate`'s float `Env.matcher` to
`Verified.Geo.Match.qMatchWalkSegment`, which takes `QPt` (`la`/`lo` in 1e-7°
and `ts` in seconds, as `Int`). The results have the same two fields.

    Env.matcher       Array MPt → Ways → Array Ring → Option MatchOut
    qMatchWalkSegment Array QPt → Array QWay → Array (Array QPt)
                        → Option QWalkMatchResult

⚠ Quantisation is `jsRoundInt (x · 1e7)` (halves up), not `JsNum.toFixed`,
which rounds the magnitude and disagrees on every negative tie, i.e. London
longitudes. The round trip moves a point at most half a unit (≤0.56 cm). The corpus gates judge
this arm; do not widen an accepted delta to quiet a divergence.

Way names cannot move the line (`WALK_QPROFILE.wayContinuityNats = 0`). They
feed `QMatchResult.wayUm`, which names a walk by the ways its route ran along:
re-deriving that from the snapped line is unanswerable.
-/

namespace Verified.Geo.WalkMatchAdapt

open Verified.Geo (QPt QWay)
open Verified.Geo.WalkableRoute (Pt Ways)
open Verified.Geo.WalkEscape (Ring)
open Verified.Geo.WalkAnnotate (MatchOut)
open Verified.JsNum (jsRoundInt)

/-- 1e-7° per unit — `QPt`'s scale. -/
def SCALE : Float := 1e7

/-- `quantPt`. A way vertex has no timestamp, so it gets 0. -/
def toQ (lat lon : Float) (ts : Float := 0) : QPt :=
  { la := jsRoundInt (lat * SCALE), lo := jsRoundInt (lon * SCALE), ts := jsRoundInt ts }

def pathPtToQ (p : Verified.Geo.PathPt) : QPt := toQ p.lat p.lon p.ts

/-- `Int → Float`, sign included. ⚠ Not `i.toNat.toFloat`, which clamps at zero:
fine for durations elsewhere, `0.0` for every London longitude. -/
def intToFloat (i : Int) : Float :=
  if i < 0 then -((-i).toNat.toFloat) else i.toNat.toFloat

/-- Back to floats. Exact for any `QPt` this codebase produces: `la / 1e7` is a
plain division, the inverse of the quantisation. -/
def fromQ (q : QPt) : Verified.Geo.PathPt :=
  { lat := intToFloat q.la / SCALE, lon := intToFloat q.lo / SCALE, ts := intToFloat q.ts }

def waysToQ (ways : Array Verified.Geo.OsmCorridor.Way) : Array QWay :=
  ways.map fun w => { coords := w.coords.map fun p => toQ p.lat p.lon, name := w.name }

def ringsToQ (rings : Array Ring) : Array (Array QPt) :=
  rings.map fun r => r.map fun p => toQ p.lat p.lon

/-- `WalkAnnotate.Env.matcher`, backed by `qMatchWalkSegment`. `wayUm` crosses
untouched — integer units in, integer units out; only relative weight is read. -/
def matcher (fixes : Array Verified.Geo.PathPt) (ways : Array Verified.Geo.OsmCorridor.Way)
    (buildings : Array Ring) : Option MatchOut :=
  match Verified.Geo.qMatchWalkSegment (fixes.map pathPtToQ) (waysToQ ways) (ringsToQ buildings) with
  | none => none
  | some r => some { path := r.path.map fromQ, coarsePath := r.coarsePath.map fromQ,
                     wayUm := r.wayUm }

/-! ## Specs

On literals, so these fail on a rule change rather than on a data change. -/

-- London, and the sign that makes the rounding rule matter.
#guard (toQ 51.5661113948718 (-0.1784117025641026)).la == 515661114
#guard (toQ 51.5661113948718 (-0.1784117025641026)).lo == -1784117

-- Ties go toward +∞, not away from zero. `toFixed` would give -1 for the second.
#guard (toQ 0.00000005 0).la == 1
#guard (toQ (-0.00000005) 0).la == 0

-- A way vertex has no timestamp and quantises to 0, as `p.ts ?? 0`.
#guard (toQ 51.5 (-0.1)).ts == 0

-- The sign survives. This is the guard that fails if `Int.toNat.toFloat` creeps
-- back in: it would answer `0.0` and every London longitude would collapse.
#guard intToFloat (-2784117) == -2784117.0
#guard (fromQ ⟨515661114, -2784117, 0⟩).lon < 0

-- The round trip is the identity on anything already on the grid.
#guard fromQ (toQ 51.5 (-0.1)) == ({ lat := 51.5, lon := -0.1, ts := 0 } : Verified.Geo.PathPt)

-- Names survive for the identity report. An unnamed way stays unnamed rather
-- than becoming "".
#guard (waysToQ #[{ osmId := 0, coords := #[⟨51.5, -0.1⟩] }])[0]!.name == none
#guard (waysToQ #[{ osmId := 0, name := some "Queen's Walk",
                    coords := #[⟨51.5, -0.1⟩, ⟨51.6, -0.2⟩] }])[0]!.name == some "Queen's Walk"
#guard (waysToQ #[{ osmId := 0, coords := #[⟨51.5, -0.1⟩, ⟨51.6, -0.2⟩] }])[0]!.coords.size == 2

-- No ways means nothing to match against, and the matcher says so rather than
-- inventing a line. This is the answer the shells gave, and the one the host
-- still gets whenever a lookup misses.
#guard matcher #[⟨51.5, -0.1, 100⟩, ⟨51.6, -0.2, 200⟩] #[] #[] == none

end Verified.Geo.WalkMatchAdapt
