import Verified.Hsmm.Emissions
/-!
# Entry / initial priors

`initialLogProb` is uniform `0`. `entryLogProb` fires once per segment: for
`stationary @ knownPlace`, the hour-of-day arrival rate
`log(24 · hourProfile[hourLocal])` (floored) plus the visit weight
`log(nPlaces · weight)` (fallback `1/(10·nPlaces)`). The caller resolves the
per-place data. UNPROVEN; bit-exact, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Entry

open Verified.Hsmm.Emissions (Mode State)

/-- `HOUR_PROFILE_FLOOR`. -/
def HOUR_PROFILE_FLOOR : Float := 0.001

-- The literals the entry prior reads, once each: in a branch a literal is
-- converted on every call, and the prior runs per state per minute.
private def ZERO : Float := 0
private def ONE : Float := 1
private def TEN : Float := 10
private def HOURS : Float := 24

/-- `buildInitialStatePrior`: uniform `0` today. -/
def initialStateLogProb (_s : State) : Float := 0.0

/-- The per-segment-entry log-prior. `profile` is `s.placeId`'s hour profile
    (`none` if absent or off); `visitWeight` its raw weight (`none` → the
    fallback). The visit term needs `nPlaces > 0` (a weights map). -/
def entryLogProb (s : State) (hourLocal : Nat) (useHourProfiles : Bool)
    (profile : Option (Array Float)) (nPlaces : Nat) (visitWeight : Option Float) : Float :=
  if s.mode != .stationary || s.placeId.isNone then ZERO
  else
    let p1 :=
      if useHourProfiles then
        match profile with
        | some pr =>
          if pr.size == 24 then
            -- Hours are 0–23; one off the profile reads as never visited.
            let v := (pr[hourLocal]?).getD ZERO
            let f := if v > HOUR_PROFILE_FLOOR then v else HOUR_PROFILE_FLOOR
            Float.log (HOURS * f)
          else ZERO
        | none => ZERO
      else ZERO
    let p2 :=
      if nPlaces > 0 then
        let fallback := ONE / (TEN * Verified.FloatConst.natToFloat nPlaces)
        Float.log (Verified.FloatConst.natToFloat nPlaces * visitWeight.getD fallback)
      else ZERO
    p1 + p2

-- `buildEntryPrior` / `buildInitialStatePrior`'s reference values.
private def prof : Array Float := ((Array.range 24).map (fun i => (i.toFloat + 1) / 300)).set! 3 0.0005
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩

#guard entryLogProb (stt .stationary (some 5)) 14 true (some prof) 2 (some 0.3) == -0.32850406697203594
#guard entryLogProb (stt .stationary (some 5)) 3 true (some prof) 2 (some 0.3) == -4.240527072400182
#guard entryLogProb (stt .walking none) 14 true (some prof) 2 none == 0
#guard entryLogProb (stt .stationary (some 9)) 14 true none 2 none == -2.3025850929940455
#guard initialStateLogProb (stt .stationary (some 5)) == 0

end Verified.Hsmm.Entry
