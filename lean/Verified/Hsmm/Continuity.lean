import Verified.Hsmm.Emissions
/-!
# Presence-continuity emission bonus

For each no-fix minute, a log-bonus to the stationary state at the prior day's
end place, decaying with hours since the last fix and scaled by the prior
posterior, silenced once a fix today lies beyond `CONTRADICTION_RADIUS_M`. It
carries a multi-day dark stay (a hospital) at the prior place. Always on: the
decode request always carries the seed.

`haversine`/`exp`/`log` make a fired bonus ULP-close; zero branches are exact.
UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Continuity

open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.FloatScore (haversineMeters)

def CONTRADICTION_RADIUS_M : Float := 1500
def EMISSION_STRENGTH : Float := 0.1
def TAU_HOURS : Float := 24

/-- Prior-day end-of-day continuation seed. -/
structure ContinuityContext where
  priorPlaceId : Option Int
  priorPlaceCoord : Option (Float × Float)
  hoursSinceLastConfirmedFix : Float
  priorPosterior : Float

/-- Per-minute continuity bonus for the matching stationary state on a no-fix
    minute. `prevFix` is the observation's most-recent fix coords (for the
    contradiction gate). -/
def continuityLogLikelihood (s : State) (gpsPresent : Bool) (prevFix : Option (Float × Float))
    (ctx : Option ContinuityContext) : Float :=
  match ctx with
  | none => 0.0
  | some c =>
    match c.priorPlaceId with
    | none => 0.0
    | some ppid =>
      if s.mode != .stationary then 0.0
      else if s.placeId != some ppid then 0.0
      else if gpsPresent then 0.0
      else
        let contradicted := match c.priorPlaceCoord, prevFix with
          | some (plat, plon), some (flat, flon) =>
            decide (haversineMeters flat flon plat plon > CONTRADICTION_RADIUS_M)
          | _, _ => false
        if contradicted then 0.0
        else
          let decay := Float.exp (-(max 0 c.hoursSinceLastConfirmedFix) / TAU_HOURS)
          let post := max 0 (min 1 c.priorPosterior)
          let w := decay * post
          if w <= 0 then 0.0 else Float.log (1 + EMISSION_STRENGTH * w)

-- `continuityLogLikelihood`'s reference values.
private def approxK (a b : Float) : Bool := Float.abs (a - b) < 1e-6
private def ctx : ContinuityContext := ⟨some 5, some (51.52, -0.13), 3, 0.95⟩
private def near : Option (Float × Float) := some (51.521, -0.131)
private def far : Option (Float × Float) := some (51.60, -0.30)

#guard approxK (continuityLogLikelihood ⟨.stationary, some 5, none⟩ false near (some ctx)) 0.08050771253789446
#guard continuityLogLikelihood ⟨.stationary, some 5, none⟩ false near none == 0            -- no ctx
#guard continuityLogLikelihood ⟨.walking, none, none⟩ false near (some ctx) == 0           -- not stationary
#guard continuityLogLikelihood ⟨.stationary, some 7, none⟩ false near (some ctx) == 0      -- different place
#guard continuityLogLikelihood ⟨.stationary, some 5, none⟩ true near (some ctx) == 0       -- gps present
#guard continuityLogLikelihood ⟨.stationary, some 5, none⟩ false far (some ctx) == 0       -- contradicted
#guard continuityLogLikelihood ⟨.stationary, some 5, none⟩ false near (some ⟨some 5, some (51.52, -0.13), 3, 0⟩) == 0  -- w=0
#guard approxK (continuityLogLikelihood ⟨.stationary, some 5, none⟩ false near (some ⟨some 5, some (51.52, -0.13), 0, 0.95⟩)) 0.09075436326846412

end Verified.Hsmm.Continuity
