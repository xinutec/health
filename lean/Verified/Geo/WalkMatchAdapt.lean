import Verified.Geo.Match
import Verified.Geo.WalkAnnotate
import Verified.JsNum

/-!
# `WalkMatchAdapt` — `WalkAnnotate.Env.matcher`, backed by the real matcher

`WalkAnnotate` takes its matcher as an injected `Env` field, and every caller so
far has passed the shell `fun _ _ _ => none`. The matcher it wants exists:
`Verified.Geo.Match.qMatchWalkSegment`, which is the port of `matchWalkSegment`.
What kept them apart is that they speak different coordinate types.

    Env.matcher       Array MPt → Ways → Array Ring → Option MatchOut
    qMatchWalkSegment Array QPt → Array QWay → Array (Array QPt)
                        → Option QWalkMatchResult

`MPt` is `PathPt` — `lat`/`lon`/`ts` as `Float`. `QPt` is `la`/`lo` in 1e-7°
units and `ts` in epoch seconds, as `Int`. `MatchOut` and `QWalkMatchResult`
have the SAME two fields, so only the points need translating.

# The quantisation is `Math.round(x * 1e7)`, and that is not `toFixed(7)`

`quant-twin.ts`'s `quantPt` is the pinned rule:

    la: BigInt(Math.round(p.lat * 1e7))
    lo: BigInt(Math.round(p.lon * 1e7))
    ts: BigInt(Math.round(p.ts ?? 0))

`Math.round` is round-half-toward-+∞. It is tempting to reach for
`Verified.JsNum.toFixed`, which is also a 7-decimal JS rounding rule and is
already in this tree — and it is the WRONG one: `toFixed` strips the sign first
and takes ties on the magnitude, so it and `Math.round` disagree on every
negative tie. At London's longitudes that is not a hypothetical sign.

# What the round trip costs, and why that is the accepted cost

A coordinate returned by this matcher is a multiple of 1e-7°, so the drawn line
sits up to half a unit from the float arm's: 0.56 cm in latitude, 0.35 cm in
longitude at London's latitude (`map-match-core.ts`'s `CANDIDATE_TIE_UM` note
derives the same figures). That is the float↔quant deviation
`compare-match --gate` measures and adjudicates — over 35 days and 207 legs it
is 0.00–0.14 m on all but two legs.

⚠ SO WIRING THIS IS NOT EXPECTED TO LEAVE THE DAY GATE UNCHANGED, and the day
gate compares exactly. `RoadMatchAnnotate.lean`'s header says the same thing
about the road twin: the quantised arm is "measured and ceilinged against the TS
rather than bit-identical to it (#395 / #403)". Judge a change here with
`compare-match --gate`, and do NOT quiet a divergence by widening the
accepted-delta manifest — `deploy.sh:139`.

# Ways carry no names here, and that is correct for WALK

`QWay` has a `name`, used for the way-switch penalty. `Ways` is
`Array (Array Pt)` and has none to give. That is not a lossy shortcut:
`WALK_QPROFILE.wayContinuityNats = 0`, so the walk profile charges nothing for a
way change, and `Match.lean` says outright that the field is the ROAD turn prior
which "no walk guard exercises". `pedestrian-match.ts` never reads a name either.
The ROAD matcher does need them, which is why `RoadMatchAnnotate.Env` takes
`Array Way` with `osmId`/`name`/`subtype` and this one does not.
-/

namespace Verified.Geo.WalkMatchAdapt

open Verified.Geo (QPt QWay)
open Verified.Geo.WalkableRoute (Pt Ways)
open Verified.Geo.WalkEscape (Ring)
open Verified.Geo.WalkAnnotate (MatchOut)
open Verified.JsNum (jsRoundInt)

/-- 1e-7° per unit — `QPt`'s scale. -/
def SCALE : Float := 1e7

/-- `quantPt`. A way vertex has no timestamp; the TS spells that `p.ts ?? 0`. -/
def toQ (lat lon : Float) (ts : Float := 0) : QPt :=
  { la := jsRoundInt (lat * SCALE), lo := jsRoundInt (lon * SCALE), ts := jsRoundInt ts }

def pathPtToQ (p : Verified.Geo.PathPt) : QPt := toQ p.lat p.lon p.ts

/-- `Int → Float`, sign included.
⚠ NOT `i.toNat.toFloat`, which is the idiom used elsewhere in this tree and is
WRONG here: `Int.toNat` CLAMPS at zero, so every London longitude would come
back `0.0`. It is safe at those call sites because the values are durations and
counts; it is not safe for a coordinate. -/
def intToFloat (i : Int) : Float :=
  if i < 0 then -((-i).toNat.toFloat) else i.toNat.toFloat

/-- Back to floats. Exact for any `QPt` this codebase produces: `la / 1e7` is a
plain division, and the value it lands on is the one the TS twin's inverse lands
on too. -/
def fromQ (q : QPt) : Verified.Geo.PathPt :=
  { lat := intToFloat q.la / SCALE, lon := intToFloat q.lo / SCALE, ts := intToFloat q.ts }

def waysToQ (ways : Ways) : Array QWay :=
  ways.map fun w => { coords := w.map fun p => toQ p.lat p.lon, name := none }

def ringsToQ (rings : Array Ring) : Array (Array QPt) :=
  rings.map fun r => r.map fun p => toQ p.lat p.lon

/-- `WalkAnnotate.Env.matcher`, backed by `qMatchWalkSegment`. -/
def matcher (fixes : Array Verified.Geo.PathPt) (ways : Ways) (buildings : Array Ring) :
    Option MatchOut :=
  match Verified.Geo.qMatchWalkSegment (fixes.map pathPtToQ) (waysToQ ways) (ringsToQ buildings) with
  | none => none
  | some r => some { path := r.path.map fromQ, coarsePath := r.coarsePath.map fromQ }

/-! ## Specs

On literals, so these fail on a rule change rather than on a data change. The
values are the ones `quant-twin.ts`'s `quantPt` produces for the same inputs. -/

-- London, and the sign that makes the rounding rule matter.
#guard (toQ 51.5661113948718 (-0.2784117025641026)).la == 515661114
#guard (toQ 51.5661113948718 (-0.2784117025641026)).lo == -2784117

-- Ties go toward +∞, NOT away from zero. `toFixed` would give -1 for the second.
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

-- Names are dropped, deliberately — see the header.
#guard (waysToQ #[#[⟨51.5, -0.1⟩]])[0]!.name == none
#guard (waysToQ #[#[⟨51.5, -0.1⟩, ⟨51.6, -0.2⟩]])[0]!.coords.size == 2

-- No ways means nothing to match against, and the matcher says so rather than
-- inventing a line. This is the answer the shells gave, and the one the host
-- still gets whenever a lookup misses.
#guard matcher #[⟨51.5, -0.1, 100⟩, ⟨51.6, -0.2, 200⟩] #[] #[] == none

end Verified.Geo.WalkMatchAdapt
