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
  deriving DecidableEq, BEq, Repr, Inhabited

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
  /-- Rail line for a `train` state; `none` for non-train states. Unused by the
      emission (which never reads it) but part of the shared state identity that
      the transition matrix compares on. -/
  lineName : Option String := none
  deriving Inhabited

/-! ## A ride's head (#366)

The first minutes of a road ride can crawl — out of a car park, a queue at a
junction, a taxi in traffic. Per minute such a fix reads like standing still
(1.2 km/h scores 4 nats against `driving`), and the per-minute charge grows
with the crawl, so a ten-minute crawl decodes as a stay however clearly a
ride follows (2026-05-25 12:40 local). The head state carries `driving`'s
emission with its speed term widened to a mixture: half the cruising prior,
half a crawl. It is a separate STATE, not a τ-dependent emission, so the
proved trellis is untouched; the transitions confine it to the front of a
ride ({@link Verified.Hsmm.Transitions.isHardZero}) and the duration prior caps
it ({@link Verified.Hsmm.Assemble.durPriorBase}). Off unless the context asks
for it.

⚠ MEASURED 2026-09-29 AND NOT SHIPPED (`HSMM_RIDE_HEAD_MIN=10`, the live
scoreboard over the eleven frozen days). Priced per minute like `driving` the
head never decodes — the eleven days re-decode identically. Priced like a
stay it takes the 05-25 crawl (journeys 0 → 1) and undercuts every TRAIN
start: 05-15's Bakerloo and Jubilee hops and 06-16's line legs come out
`driving`, legLine 9 → 6, journeys 18 → 17, one more phantom. No pricing
between the two serves both: 05-25 needs at least 0.36 of the stay–driving
gap credited per minute and any credit above 0.25 beats `train`'s own prior.
What would restore fairness is a head for every ride mode (a platform wait
for `train`), so that the line evidence decides between them; not built. -/

def RIDE_HEAD_CRAWL_MEAN_KMH : Float := 3
def RIDE_HEAD_CRAWL_STD_KMH : Float := 3
def RIDE_HEAD_CRAWL_WEIGHT : Float := 0.5

/-- A line-name slot that names no line: the generator's `unknown_rail`
    fallback and a ride's head. Every reader of a train state's line treats
    both as "no line". -/
def isPlaceholderLine (l : String) : Bool := l == "unknown_rail" || l == "head"

/-- A ride's head: `driving` or `train` with the head mark in the `lineName`
    slot. For a train it is the platform wait before the ride, which is part
    of the ride by his convention (2026-09-27). -/
def isRideHead (s : State) : Bool :=
  (s.mode == .driving || s.mode == .train) && s.lineName == some "head"

/-- What the head adds to `driving`'s per-minute emission: the log of the crawl
    mixture over the cruising prior. 0 without a fix. -/
def rideHeadSpeedAdjust (mode : Mode) (speedKmh : Option Float) : Float :=
  match speedKmh with
  | none => 0.0
  | some v =>
    let p := modePriors mode
    let cruise := logNormalPdf v p.speedMean p.speedStd
    let crawl := logNormalPdf v RIDE_HEAD_CRAWL_MEAN_KMH RIDE_HEAD_CRAWL_STD_KMH
    Float.log ((1 - RIDE_HEAD_CRAWL_WEIGHT) * Float.exp cruise
      + RIDE_HEAD_CRAWL_WEIGHT * Float.exp crawl) - cruise

-- A crawling minute gains most of the 4 nats it lost; a cruising minute pays
-- the mixture's halving; no fix, nothing.
#guard (let a := rideHeadSpeedAdjust .driving (some 1.2); a > 2.8 && a < 3.0)
#guard Float.abs (rideHeadSpeedAdjust .driving (some 40) - Float.log 0.5) < 1e-6
#guard rideHeadSpeedAdjust .driving none == 0.0
-- A train's head at a standstill on the platform: most of the 50 ± 30 prior's
-- cost at 0 km/h comes back.
#guard (rideHeadSpeedAdjust .train (some 0)) > 1.5
#guard isRideHead ⟨.driving, none, some "head"⟩ == true
#guard isRideHead ⟨.driving, none, none⟩ == false
#guard isRideHead ⟨.train, none, some "head"⟩ == true
#guard isRideHead ⟨.train, none, some "Jubilee Line"⟩ == false
#guard isPlaceholderLine "head" && isPlaceholderLine "unknown_rail" && !isPlaceholderLine "Jubilee Line"

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
def emissionLogProb (s : State) (o : Observation) (placeCoord : Option (Float × Float))
    (priors : Mode → ModePrior := modePriors) : Float :=
  let prior := priors s.mode
  let pCad := match o.cadence with | none => 0.0 | some c => logCadencePdf c prior
  let pBed := if o.inBed then Float.log (inBedProbByMode s.mode) else 0.0
  modePriorLog s.mode
    + logBernoulli o.gps.isSome prior.gpsPresentProb
    + speedTerm s o prior
    + hrTerm s o prior
    + pCad
    + pBed
    + placeTerm s o placeCoord

/-- C4.2 reacquire-robust speed widening (`USE_REACQUIRE_ROBUST_SPEED`): widen the
    STATIONARY speed-emission σ on minutes shortly after GPS reacquisition, decaying
    as the Kalman filter settles (`exp(−age/τ)`), and scaled down near rail track
    (`1 − exp(−railDist²/2σ²)` — a reacquire fix ON the line is a real ride, not
    indoor scatter). `none` age → base σ (the widening only fires when the caller
    has resolved a reacquire age for a stationary state). ULP-close via `exp`. -/
def REACQ_WIDEN : Float := 2.5
def REACQ_TAU_MIN : Float := 3
def REACQ_RAIL_SIGMA_M : Float := 100
/-- The shortest gap after which the smoother RESETS (`Kalman`: 600 s with a
displacement), so its first fix reads near zero whatever the motion. Under it
the artefact is the gap's momentum — speed ABOVE the prior, never below. -/
def REACQ_RESET_GAP_MIN : Float := 10

/-- The widening decays over the gap's own length, at most `REACQ_TAU_MIN`: after a
one-minute gap the smoother's speed settles within a minute (the four fixes
after it read 29, 16, 9, 7 km/h), after a long blackout it takes the full
three. `none` is the long-gap decay. -/
def reacquireWidenedSpeedStd (baseSpeedStd : Float) (reacquireAgeMin railDistM : Option Float)
    (gapMin : Option Float := none) : Float :=
  match reacquireAgeMin with
  | none => baseSpeedStd
  | some age =>
    let railScale := match railDistM with
      | none => 1.0
      | some rd => 1.0 - Float.exp (-(rd * rd) / (2 * REACQ_RAIL_SIGMA_M * REACQ_RAIL_SIGMA_M))
    let tau := match gapMin with
      | some g => min REACQ_TAU_MIN (max 1.0 g)
      | none => REACQ_TAU_MIN
    baseSpeedStd * (1 + REACQ_WIDEN * railScale * Float.exp (-age / tau))

private def approxE (a b : Float) : Bool := Float.abs (a - b) < 1e-6

#guard reacquireWidenedSpeedStd 15 none none == 15               -- no reacquire → base σ
#guard reacquireWidenedSpeedStd 15 (some 0) none == 52.5         -- fresh reacquire, no rail info → ×3.5
#guard reacquireWidenedSpeedStd 15 (some 0) (some 0) == 15       -- on the track → no widening
#guard approxE (reacquireWidenedSpeedStd 15 (some 3) none) 28.795479043929088
#guard approxE (reacquireWidenedSpeedStd 15 (some 0) (some 100)) 29.75510026077625
#guard approxE (reacquireWidenedSpeedStd 15 (some 2) (some 50)) 17.262303815715864
-- After a one-minute gap the widening is gone two minutes later; a long gap keeps the slow decay.
#guard approxE (reacquireWidenedSpeedStd 2 (some 2) none (some 1)) (2 * (1 + 2.5 * Float.exp (-2)))
#guard approxE (reacquireWidenedSpeedStd 2 (some 2) none (some 58)) (2 * (1 + 2.5 * Float.exp (-2 / 3)))

-- Parity with the real `buildEmissionFn` (base path; values from Node/V8):
private def g (lat lon spd : Float) : Gps := ⟨lat, lon, spd⟩
private def obs (gps : Option Gps) (hr cad : Option Float) (inBed : Bool) : Observation := ⟨gps, hr, cad, inBed⟩
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩
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
