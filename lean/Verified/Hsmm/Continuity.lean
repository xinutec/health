import Verified.Hsmm.Emissions
/-!
# Presence-continuity emission bonus (implementation-first port of `continuityLogLikelihood`)

Phase 3 of presence-continuity (`USE_CONTINUITY_CONTINUATION`, ON in the served
decode cron): a per-no-fix-minute log-bonus to the stationary state matching the
prior day's end-of-day place, decaying with hours-since-last-fix and scaled by the
prior posterior — silenced once today's most-recent fix contradicts the prior
place (>`CONTRADICTION_RADIUS_M`). This carries a multi-day no-data stay (e.g. a
hospital) to the prior place with decaying confidence.

Pure factor; `haversine`/`exp`/`log` make the fired bonus ULP-close (`approx`),
the gated-zero branches exact. UNPROVEN; pinned by the `#guard`s.
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

-- Parity with the real `continuityLogLikelihood` (Node/V8).
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
