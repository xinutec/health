import Verified.Hsmm.Emissions
/-!
# Entry / initial priors (implementation-first port of `entry-prior.ts` + `initial-state.ts`)

`initialLogProb` is uniform `0` today. `entryLogProb` fires once per segment
(not per minute): for a `stationary @ knownPlace` it adds the hour-of-day arrival
rate `log(24 · hourProfile[hourLocal])` (floored) and the visit-frequency weight
`log(nPlaces · weight)` (with a `1/(10·nPlaces)` fallback). Per-place data is
passed resolved (profile for the state's place, weight lookup) — the caller owns
the maps, exactly as `buildHsmmModel` resolves them. UNPROVEN; bit-exact with TS,
pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Entry

open Verified.Hsmm.Emissions (Mode State)

/-- `HOUR_PROFILE_FLOOR`. -/
def HOUR_PROFILE_FLOOR : Float := 0.001

/-- `buildInitialStatePrior`: uniform `0` today. -/
def initialStateLogProb (_s : State) : Float := 0.0

/-- `buildEntryPrior`'s per-segment-entry log-prior.
    `profile` = the hour profile resolved for `s.placeId` (`none` if absent or
    the feature is off); `visitWeight` = the raw weight lookup for `s.placeId`
    (`none` → the `1/(10·nPlaces)` fallback). `nPlaces > 0` gates the visit term
    (it is `0` exactly when the weights map is absent). -/
def entryLogProb (s : State) (hourLocal : Nat) (useHourProfiles : Bool)
    (profile : Option (Array Float)) (nPlaces : Nat) (visitWeight : Option Float) : Float :=
  if s.mode != .stationary || s.placeId.isNone then 0.0
  else
    let p1 :=
      if useHourProfiles then
        match profile with
        | some pr =>
          if pr.size == 24 then
            let v := pr[hourLocal]!
            let f := if v > HOUR_PROFILE_FLOOR then v else HOUR_PROFILE_FLOOR
            Float.log (24 * f)
          else 0.0
        | none => 0.0
      else 0.0
    let p2 :=
      if nPlaces > 0 then
        let fallback := 1.0 / (10.0 * nPlaces.toFloat)
        Float.log (nPlaces.toFloat * visitWeight.getD fallback)
      else 0.0
    p1 + p2

-- Parity with the real `buildEntryPrior` / `buildInitialStatePrior` (Node/V8).
private def prof : Array Float := ((Array.range 24).map (fun i => (i.toFloat + 1) / 300)).set! 3 0.0005
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩

#guard entryLogProb (stt .stationary (some 5)) 14 true (some prof) 2 (some 0.3) == -0.32850406697203594
#guard entryLogProb (stt .stationary (some 5)) 3 true (some prof) 2 (some 0.3) == -4.240527072400182
#guard entryLogProb (stt .walking none) 14 true (some prof) 2 none == 0
#guard entryLogProb (stt .stationary (some 9)) 14 true none 2 none == -2.3025850929940455
#guard initialStateLogProb (stt .stationary (some 5)) == 0

end Verified.Hsmm.Entry
