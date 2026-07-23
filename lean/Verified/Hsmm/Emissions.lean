import Verified.Hsmm.FloatScore
/-!
# Emission log-likelihood (implementation-first port of `src/hmm/emissions.ts`)

`buildEmissionFn`'s per-(state, observation) log-probability, in Lean `Float`.
This is the BASE path: hand-tuned `MODE_PRIORS`, no learned emissions, no
presence-continuity, no per-place HR fit, no reacquire-robust widening. Those
refinements are follow-on bricks (each needs extra input plumbing); the base
path is what fires when their flags/inputs are absent.

UNPROVEN, per the implementation-first direction (see the strategic-direction
section of `docs/proposals/2026-07-verified-core-lean.md`). The accumulation is
ordered exactly as `emissions.ts` sums it (mode → gps → speed/plane → hr →
cadence → in-bed → place), and skipped factors add `0.0`, so the result is
bit-for-bit identical to TS — pinned by the `#guard`s below against values
computed from the real `buildEmissionFn`.
-/

namespace Verified.Hsmm.Emissions

open Verified.Hsmm.FloatScore

inductive Mode
  | stationary | walking | cycling | driving | train | plane | unknown
  deriving DecidableEq, BEq, Repr

structure ModePrior where
  gpsPresentProb : Float
  speedMean : Float
  speedStd : Float
  hrMean : Float
  hrStd : Float
  expectedZeroProb : Float
  cadencePositiveMean : Float
  cadencePositiveStd : Float

/-- `UNIFORM_GPS_PRESENT_PROB` in emissions.ts. -/
def uniformGpsPresentProb : Float := 0.85

/-- `MODE_PRIORS`. -/
def modePriors : Mode → ModePrior
  | .stationary => ⟨uniformGpsPresentProb, 0, 2, 70, 15, 0.99, 10, 20⟩
  | .walking    => ⟨uniformGpsPresentProb, 5, 2, 100, 20, 0.05, 100, 25⟩
  | .cycling    => ⟨uniformGpsPresentProb, 18, 6, 130, 20, 0.95, 30, 30⟩
  | .driving    => ⟨uniformGpsPresentProb, 40, 20, 75, 15, 0.99, 5, 10⟩
  | .train      => ⟨uniformGpsPresentProb, 50, 30, 75, 15, 0.99, 5, 10⟩
  | .plane      => ⟨uniformGpsPresentProb, 600, 200, 70, 15, 0.99, 5, 10⟩
  | .unknown    => ⟨uniformGpsPresentProb, 20, 200, 80, 100, 0.5, 50, 100⟩

/-- `MODE_PRIOR_LOG`: per-minute `log P(mode)`. -/
def modePriorLog : Mode → Float
  | .stationary => Float.log 0.7
  | .walking    => Float.log 0.1
  | .cycling    => Float.log 0.01
  | .driving    => Float.log 0.02
  | .train      => Float.log 0.05
  | .plane      => Float.log 0.005
  | .unknown    => Float.log 0.1

/-- `IN_BED_PROB_BY_MODE`. -/
def inBedProbByMode : Mode → Float
  | .stationary => 0.99
  | .walking    => 0.0001
  | .cycling    => 0.0001
  | .driving    => 0.0001
  | .train      => 0.1
  | .plane      => 0.3
  | .unknown    => 0.05

def PLACE_RADIUS_M : Float := 150
def PLACE_DISTANCE_FLOOR : Float := -3
def OFF_NETWORK_LOG_PRIOR : Float := -2
def HYPER_PLACE_HR_MEAN : Float := 70
def HYPER_PLACE_HR_STD : Float := 15
def ASLEEP_HR_MEAN : Float := 58
def ASLEEP_HR_STD : Float := 10

/-- Zero-inflated cadence log-pdf (`logCadencePdf`). -/
def logCadencePdf (cadence : Float) (prior : ModePrior) : Float :=
  if cadence == 0.0 then Float.log prior.expectedZeroProb
  else Float.log (1.0 - prior.expectedZeroProb)
       + logNormalPdf cadence prior.cadencePositiveMean prior.cadencePositiveStd

structure Gps where
  lat : Float
  lon : Float
  speedKmh : Float

structure Observation where
  gps : Option Gps
  hr : Option Float
  cadence : Option Float
  inBed : Bool

structure State where
  mode : Mode
  placeId : Option Int

/-- Speed / GPS-null-plane term. -/
private def speedTerm (s : State) (o : Observation) (prior : ModePrior) : Float :=
  match o.gps with
  | some g => logNormalPdf g.speedKmh prior.speedMean prior.speedStd
  | none => if s.mode == .plane then -8.0 else 0.0

/-- HR term with the base-path mean/std selection (asleep / hyper-place for a
    known stationary place; per-mode prior otherwise). -/
private def hrTerm (s : State) (o : Observation) (prior : ModePrior) : Float :=
  match o.hr with
  | none => 0.0
  | some hr =>
    let knownPlace := s.mode == .stationary && s.placeId.isSome
    let hrMean := if knownPlace then (if o.inBed then ASLEEP_HR_MEAN else HYPER_PLACE_HR_MEAN) else prior.hrMean
    let hrStd := if knownPlace then (if o.inBed then ASLEEP_HR_STD else HYPER_PLACE_HR_STD) else prior.hrStd
    logNormalPdf hr hrMean hrStd

/-- Place-distance term. `placeCoord` is the resolved centroid for `s.placeId`
    (`none` if the state has no place, or its id was not in the place map). -/
private def placeTerm (s : State) (o : Observation) (placeCoord : Option (Float × Float)) : Float :=
  if s.mode == .stationary then
    match o.gps with
    | none => 0.0
    | some g =>
      match s.placeId with
      | none => OFF_NETWORK_LOG_PRIOR
      | some _ =>
        match placeCoord with
        | none => 0.0
        | some (plat, plon) =>
          let z := haversineMeters g.lat g.lon plat plon / PLACE_RADIUS_M
          let raw := 0.0 - 0.5 * z * z
          if raw > PLACE_DISTANCE_FLOOR then raw else PLACE_DISTANCE_FLOOR
  else 0.0

/-- The base-path emission log-probability, summed in `emissions.ts` order. -/
def emissionLogProb (s : State) (o : Observation) (placeCoord : Option (Float × Float)) : Float :=
  let prior := modePriors s.mode
  let pCad := match o.cadence with | none => 0.0 | some c => logCadencePdf c prior
  let pBed := if o.inBed then Float.log (inBedProbByMode s.mode) else 0.0
  modePriorLog s.mode
    + logBernoulli o.gps.isSome prior.gpsPresentProb
    + speedTerm s o prior
    + hrTerm s o prior
    + pCad
    + pBed
    + placeTerm s o placeCoord

-- Parity with the real `buildEmissionFn` (base path; values from Node/V8):
private def g (lat lon spd : Float) : Gps := ⟨lat, lon, spd⟩
private def obs (gps : Option Gps) (hr cad : Option Float) (inBed : Bool) : Observation := ⟨gps, hr, cad, inBed⟩
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid⟩
private def place5 : Option (Float × Float) := some (51.52, -0.13)

#guard emissionLogProb (stt .stationary (some 5)) (obs (some (g 51.5201 (-0.1301) 0)) (some 70) (some 0) false)
  place5 == -5.7721301172670145
#guard emissionLogProb (stt .walking none) (obs (some (g 51.53 (-0.12) 5)) (some 100) (some 100) false)
  none == -12.180968195475526
#guard emissionLogProb (stt .stationary none) (obs (some (g 51.5201 (-0.1301) 0)) (some 70) none false)
  none == -7.758268321508008
#guard emissionLogProb (stt .plane none) (obs none (some 70) none false)
  none == -18.8224260857408
#guard emissionLogProb (stt .train none) (obs (some (g 51.7 0.1 90)) (some 75) none true)
  none == -14.29684983410841
#guard emissionLogProb (stt .stationary (some 5)) (obs (some (g 51.7 0.4 0)) (some 70) (some 0) false)
  place5 == -8.768318657361508

end Verified.Hsmm.Emissions
