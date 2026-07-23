import Verified.Hsmm.Emissions
/-!
# Line-proximity factor (implementation-first port of `line-proximity-factor.ts`)

Emission term for `train @ L`: at a GPS-present minute, boost when the fix sits
on L's track corridor, penalise when L is modelled but the fix is off it (or is
road-nearer-than-rail). The route-graph spatial queries (`edgesNear`,
`linesInGraph`) stay caller-side and are passed in as resolved facts
(`lineModeled`, `lineNear`, road/rail distances); this module is the pure
decision. All outputs are exact rational constants, so parity is exact `==`.
Bit-exact with TS, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.LineProximity

open Verified.Hsmm.Emissions (Mode State)

def NEAR_BOOST : Float := 1.5
def FAR_PENALTY : Float := -2.5
def ROAD_NEARER_PENALTY : Float := -2.5

/-- `scoreLineProximity`: the pure decision over proximity facts. -/
def scoreLineProximity (lineModeled lineNear : Bool) (roadDistM railDistM : Option Float) : Float :=
  if !lineModeled then 0.0
  else if !lineNear then FAR_PENALTY
  else match roadDistM, railDistM with
    | some rd, some rl => if rd < rl then ROAD_NEARER_PENALTY else NEAR_BOOST
    | _, _ => NEAR_BOOST

/-- `buildLineProximityFactor`'s per-state verdict. Facts resolved by the caller:
    `isCovered` (train-generator window), `gpsPresent`, and — for a named line —
    `lineModeled` / `lineNear` from the route graph. `unknown_rail` scores only
    the line-agnostic road-nearer signal. -/
def lineProximityFactor (s : State) (isCovered gpsPresent : Bool)
    (lineModeled lineNear : Bool) (roadDistM railDistM : Option Float) : Float :=
  if s.mode != .train then 0.0
  else if isCovered then 0.0
  else match s.lineName with
    | none => 0.0
    | some line =>
      if line == "unknown_rail" then
        if !gpsPresent then 0.0
        else match roadDistM, railDistM with
          | some rd, some rl => if rd < rl then ROAD_NEARER_PENALTY else 0.0
          | _, _ => 0.0
      else if !gpsPresent then 0.0
      else scoreLineProximity lineModeled lineNear roadDistM railDistM

-- Parity with the real `scoreLineProximity` (Node/V8):
#guard scoreLineProximity false false none none == 0
#guard scoreLineProximity true false none none == -2.5
#guard scoreLineProximity true true (some 200) (some 100) == 1.5   -- rail nearer → boost
#guard scoreLineProximity true true (some 100) (some 200) == -2.5  -- road nearer → penalty
#guard scoreLineProximity true true none none == 1.5

-- Wrapper decision branches (constants match the TS routing):
private def tr (line : Option String) : State := ⟨.train, none, line⟩
#guard lineProximityFactor (tr (some "Jubilee")) false true true true none none == 1.5
#guard lineProximityFactor (tr (some "Jubilee")) false true true false none none == -2.5   -- far
#guard lineProximityFactor (tr (some "Jubilee")) true true true false none none == 0        -- covered
#guard lineProximityFactor ⟨.walking, none, none⟩ false true true false none none == 0      -- not train
#guard lineProximityFactor (tr none) false true true false none none == 0                   -- no line
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false (some 100) (some 200) == -2.5 -- road-nearer
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false (some 200) (some 100) == 0    -- rail-nearer
#guard lineProximityFactor (tr (some "Jubilee")) false false true false none none == 0       -- gps null

end Verified.Hsmm.LineProximity
