import Verified.Hsmm.Emissions
/-!
# Line-proximity factor

Emission term for `train @ L` at a GPS-present minute: a boost when the fix is
on L's corridor, a penalty when L is modelled but the fix is off it or nearer a
road. The caller resolves `lineModeled`, `lineNear` and road/rail distances.
Outputs are exact constants; pinned by the `#guard`s.
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

/-- The per-state verdict, from caller-resolved `isCovered`, `gpsPresent`, and
    for a named line `lineModeled`/`lineNear`. A placeholder line
    (`unknown_rail`, `unknown_metro`) scores the line-agnostic signals: no
    railway near the fix (`railNear`), else road nearer than rail. -/
def lineProximityFactor (s : State) (isCovered gpsPresent : Bool)
    (lineModeled lineNear : Bool) (roadDistM railDistM : Option Float)
    (railNear : Bool := true) : Float :=
  if s.mode != .train then 0.0
  else if isCovered then 0.0
  else match s.lineName with
    | none => 0.0
    | some line =>
      if Verified.Hsmm.Emissions.isPlaceholderLine line then
        if !gpsPresent then 0.0
        -- No railway within `NEAR_M`: pays as a named line off its own track,
        -- or an unnamed train rides along a road for free.
        else if !railNear then FAR_PENALTY
        else match roadDistM, railDistM with
          | some rd, some rl => if rd < rl then ROAD_NEARER_PENALTY else 0.0
          | _, _ => 0.0
      else if !gpsPresent then 0.0
      else scoreLineProximity lineModeled lineNear roadDistM railDistM

-- `scoreLineProximity`'s reference values:
#guard scoreLineProximity false false none none == 0
#guard scoreLineProximity true false none none == -2.5
#guard scoreLineProximity true true (some 200) (some 100) == 1.5   -- rail nearer → boost
#guard scoreLineProximity true true (some 100) (some 200) == -2.5  -- road nearer → penalty
#guard scoreLineProximity true true none none == 1.5

-- Wrapper decision branches:
private def tr (line : Option String) : State := ⟨.train, none, line⟩
#guard lineProximityFactor (tr (some "Jubilee")) false true true true none none == 1.5
#guard lineProximityFactor (tr (some "Jubilee")) false true true false none none == -2.5   -- far
#guard lineProximityFactor (tr (some "Jubilee")) true true true false none none == 0        -- covered
#guard lineProximityFactor ⟨.walking, none, none⟩ false true true false none none == 0      -- not train
#guard lineProximityFactor (tr none) false true true false none none == 0                   -- no line
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false (some 100) (some 200) == -2.5 -- road-nearer
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false (some 200) (some 100) == 0    -- rail-nearer
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false none none false == -2.5      -- no railway near
#guard lineProximityFactor (tr (some "unknown_rail")) false true false false (some 200) (some 100) false == -2.5
#guard lineProximityFactor (tr (some "Jubilee")) false true true true none none false == 1.5                -- named: its own track decides
#guard lineProximityFactor (tr (some "Jubilee")) false false true false none none == 0       -- gps null

end Verified.Hsmm.LineProximity
