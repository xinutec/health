import Verified.Geo.SegmentMerge
import Verified.Geo.BiometricLabels
import Verified.Geo.ModeBiometrics
import Verified.Geo.Segments
import Verified.Geo.RefineMode
import Verified.JsNum
/-!
# The five corrections before the cascade (`src/geo/velocity.ts` 1063-1115)

`Verified.Geo.PassFold` starts at `physicallyCorrected`. Five stages earlier the
day is `enriched` — what came out of the OSM enrichment loop — and between the
two sit corrections that use the step counter, the per-user biometric signatures
and hard physical limits to overrule what GPS decided:

| TS                              | velocity pass          | direction                    |
| ------------------------------- | ---------------------- | ---------------------------- |
| `correctModeFromCadence`        | `cadenceCorrect`       | walking → driving            |
| `revertIsolatedCadenceDrives`   | `revertIsolatedCadence` | undoes the above            |
| `demoteJitterWalkToStationary`  | `jitterWalkToStay`     | walking → stationary         |
| `applyBiometricSignature`       | `biometricCorrect`     | whichever mode the LL prefers |
| `enforcePhysicalConstraints`    | `physicalConstraints`  | driving → train → plane      |

This module is the sequence, and only the sequence. Three of the five already
had Lean bodies serving the `LEAN_BIOLABELS` tenant, and the other two are
{@link Verified.Geo.ModeBiometrics.correctModeBySignature} and
{@link Verified.Geo.Segments.enforcePhysicalConstraints}. What did not exist was
the ORDER, the record rewrites around each decision, and therefore any way to
run them as one stage — which is what moves the chain's start five stages
earlier (#430).

## No OSM

Segments in, segments out, plus the step and HR series and the mined
`mode_biometrics` rows. Nothing here asks the mirror anything, which is why this
half of #430 is small: the enrichment stage upstream of it is not.

## The `biometricCorrect` arm is an ENVIRONMENT fact

`USE_BIOMETRIC_FACTOR` skips `applyBiometricSignature` entirely — the factor
scorer's candidate generator has already consulted the same signatures, and
running the pass on top would double-correct. The flag is unset in this repo, so
the corpus takes this pass, and this module is that arm. The same environment
fact decides `refineMode`'s arm (see {@link Verified.Geo.RefineMode}); it is
restated here because it bites here too.

Modelling the OTHER arm would mean modelling a pass that does nothing, so the
honest shape is a module that ports the arm that runs and says which one it is.

## Where the reason strings differ from the three biolabel passes

{@link Verified.Geo.BiometricLabels.applyDecision} APPENDS its fragment to any
existing `refinedReason` with `"; "`. The two passes added here REPLACE it —
`applyBiometricSignature` and the physical-constraint override both write a
whole string. That asymmetry is the TS's, and it is load-bearing: a segment the
cadence pass flipped and the signature pass then re-flipped keeps only the
second reason.
-/

namespace Verified.Geo.PreFold

open Verified.Geo.SegmentMerge (Seg effectiveMode)
open Verified.Geo.BiometricWindows (StepPoint HrPoint)
open Verified.Geo.ModeBiometrics (ModeStats correctModeBySignature gateCycling)
open Verified.Geo.BiometricLabels (applyDecision correctModeFromCadence
  revertIsolatedCadenceDrivesApplied demoteJitterWalkToStationary)

/-- `toFixed` for a reason string, as {@link Verified.Geo.BiometricLabels} does
it: a `none` yields a marker that cannot equal any TS output, so the call
DIVERGES loudly rather than inventing a spelling JS would not print. -/
private def fx (x : Float) (f : Nat) : String := (Verified.JsNum.toFixed x f).getD "?"

/--
`meanInWindow` — the arithmetic mean of a stream's values inside
`[startTs, endTs]`, INCLUSIVE both ends, `none` when the window caught nothing.

The TS also skips a `null` value before counting it. Both streams this is called
on (`HrPoint.bpm`, `StepPoint.steps`) declare a non-null `number`, so that arm
is unreachable from here and is not modelled — an `Option Float` parameter would
be a shape no caller can produce.

Summed in stream order, which is the TS's order, so both arms accumulate the
same Float rounding.
-/
def meanInWindow (stream : List (Int × Float)) (startTs endTs : Int) : Option Float :=
  let inside := stream.filter fun p => decide (p.1 ≥ startTs) && decide (p.1 ≤ endTs)
  if inside.isEmpty then none
  else some ((inside.foldl (fun acc p => acc + p.2) 0) / Float.ofNat inside.length)

/--
`applyBiometricSignature` — re-evaluate one segment against the user's per-mode
(HR, cadence, speed) signatures.

Synthetic gap segments carry `pointCount = 0` and have no observations to score
against, so they are skipped: this is the ONE guard that lives here rather than
in `correctModeBySignature`, because it is about the segment's provenance rather
than about the decision.

The cycling gate runs on the CORRECTED mode and takes precedence: a segment the
log-likelihood left alone can still be demoted out of `cycling`, and a segment
it flipped INTO a mode reads the gate's verdict rather than its own.
-/
def applyBiometricSignature (hr steps : List (Int × Float)) (stats : List ModeStats)
    (s : Seg) : Seg :=
  if s.pointCount == 0 then s else
  let obsHr := meanInWindow hr s.startTs s.endTs
  let obsCadence := meanInWindow steps s.startTs s.endTs
  let obsSpeed := some s.avgSpeed
  let currentMode := effectiveMode s
  let (rMode, rChanged) :=
    correctModeBySignature currentMode s.confidenceMargin obsHr obsCadence obsSpeed stats
  let correctedMode := if rChanged then rMode else currentMode
  let (gMode, gChanged) := gateCycling correctedMode obsCadence obsSpeed
  if gChanged then
    { s with refinedMode := some gMode
             refinedReason := some s!"cycling demoted to {gMode} — no hard cycling evidence" }
  else if !rChanged then s
  else
    -- A walk the body says was a sit is the GPS wandering: tagged, so the
    -- jitter consolidation can rejoin the stays it split (2026-09-30).
    { s with refinedMode := some rMode
             refinedReason := some s!"re-classified as {rMode} by biometric signature"
             refinedKinds :=
               if currentMode == "walking" && rMode == "stationary" then
                 Verified.Geo.SegmentMerge.addRefinedKind s.refinedKinds "gps-jitter"
               else s.refinedKinds }

/--
`physicalConstraints` — the hard-impossibility override, whole.

{@link Verified.Geo.Segments.enforcePhysicalConstraints} decides the mode;
what the call site adds is the record rewrite, and it is not the obvious one:
the TS writes the new mode into `mode` AND into `refinedMode`, so a downstream
consumer reading either sees the override. Reading `mode` (not `effectiveMode`)
is also the TS's — a leg some earlier pass refined to `driving` is not tested
against the driving ceiling here.
-/
def enforcePhysicalConstraints (s : Seg) : Seg :=
  let constrained := Verified.Geo.Segments.enforcePhysicalConstraints s.mode s.avgSpeed s.maxSpeed
  if constrained == s.mode then s
  else
    let reason :=
      if s.mode == "driving" then
        s!"physical-impossibility override (max {fx s.maxSpeed 0} km/h exceeds driving limit)"
      else
        s!"physical-impossibility override (avg {fx s.avgSpeed 0} km/h exceeds train limit)"
    { s with mode := constrained, refinedMode := some constrained, refinedReason := some reason }

/-- Neighbours further apart than this are not one ride. -/
def TRAIN_RUN_MAX_GAP_S : Int := 10 * 60

/-- Train, or any ground mode faster than a car can go. The second arm is for
the enrichment stage's "no rail evidence" demotion, which off the map mirror's
ground (France, 2026-10-01) turned a 291 km/h train window into "driving". -/
def movesLikeATrain (s : Seg) : Bool :=
  effectiveMode s == "train"
    || (effectiveMode s != "plane"
        && decide (s.maxSpeed > Verified.Geo.Segments.DRIVING_MAX_SPEED_KMH))

/--
A "plane" window flanked by train on both sides, at no more than a train can
average, is the same train: nobody boards a flight in the middle of a rail
journey. The raw classifier centres train on 120 km/h and plane on 500 km/h,
so a TGV at ~290 km/h (Paris → Hendaye, 2026-10-01) scored as plane in two
five-minute windows between train ones.

Both neighbours must be train and close: a flight's slower climb and descent
windows sit beside plane windows, not train ones, so a real flight is never
rewritten. The speed bound is `TRAIN_MAX_AVG_SPEED_KMH`, the ceiling above which
`enforcePhysicalConstraints` itself calls a train a plane.
-/
def planeInsideTrainRun (segs : Array Seg) : Array Seg :=
  segs.mapIdx fun i s =>
    let isTrainNear (o : Option Seg) (gap : Seg → Int) : Bool :=
      match o with
      | some n => movesLikeATrain n && decide (gap n ≤ TRAIN_RUN_MAX_GAP_S)
      | none => false
    if effectiveMode s != "plane"
        || decide (s.avgSpeed > Verified.Geo.Segments.TRAIN_MAX_AVG_SPEED_KMH) then s
    else if isTrainNear (if i == 0 then none else segs[i - 1]?) (fun p => s.startTs - p.endTs)
        && isTrainNear segs[i + 1]? (fun n => n.startTs - s.endTs) then
      { s with
        mode := "train"
        refinedMode := some "train"
        refinedReason := some
          s!"plane between train legs at train speed (avg {(Verified.JsNum.toFixed (Verified.JsNum.jsRound s.avgSpeed) 0).getD "?"} km/h) — one rail journey" }
    else s

/-- Adjacent: the next leg starts within this of the last one's end. -/
def NO_STOP_GAP_S : Int := 60

/--
A "driving" leg the map could say nothing about (`NO_OSM_CONTEXT`: no ways near
it at all) that starts where a train leg ended, with no stop between, is the
train going on: nobody changes from a train to a car without stopping. The TGV
south of Bordeaux (2026-10-01) ran 92 km/h on average, max 145, which reads as
a motorway by speed alone, and the map mirror did not yet cover the line.

Only without map evidence. Where the map has context the enrichment stage has
already decided between road and rail, and that stands. Left to right, so a
run of such legs continues the train leg by leg.
-/
def trainContinuesWithoutMap (segs : Array Seg) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  for s in segs do
    let continues :=
      effectiveMode s == "driving"
        && s.refinedReason == some Verified.Geo.RefineMode.NO_OSM_CONTEXT
        && (match out.back? with
            | some p => movesLikeATrain p && decide (s.startTs - p.endTs ≤ NO_STOP_GAP_S)
            | none => false)
    out := out.push (if continues then
      { s with
        mode := "train"
        refinedMode := some "train"
        refinedReason := some "no map context, and no stop since the train — the same rail journey" }
      else s)
  return out

/-- The five, in the TS's order. Each consumes what the last produced; the order
is load-bearing in the same way the cascade's is, and for the same reason the
`revertIsolatedCadence` entry exists at all — it undoes the pass before it, so
swapping the two makes both no-ops. `planeInsideTrainRun` and then
`trainContinuesWithoutMap` read their result. -/
def preFold (steps : List StepPoint) (hr : List HrPoint) (stats : List ModeStats)
    (segs : Array Seg) : Array Seg :=
  let stepPairs := steps.map fun p => (p.ts, p.steps)
  let hrPairs := hr.map fun p => (p.ts, p.bpm)
  let flipped := segs.map fun s => applyDecision s (correctModeFromCadence s steps)
  let reverted := revertIsolatedCadenceDrivesApplied flipped.toList
  let corrected := reverted.map fun s => applyDecision s (demoteJitterWalkToStationary s steps)
  let biometric := corrected.map (applyBiometricSignature hrPairs stepPairs stats)
  trainContinuesWithoutMap (planeInsideTrainRun (biometric.map enforcePhysicalConstraints))

/-! ## Guards

The three biolabel passes are guarded in their own module, one case per early
return. What is pinned here is what this module adds: the two record rewrites,
and the fact that the sequence composes in the TS's order. -/

section Guards

private def seg : Seg :=
  { startTs := 0, endTs := 600, mode := "driving", avgSpeed := 40, maxSpeed := 60,
    pointCount := 30, confidenceMargin := 0 }

/-! ### `enforcePhysicalConstraints` — the rewrite, not the decision -/

-- Below both ceilings: the record is returned untouched, `refinedMode` still absent.
#guard (enforcePhysicalConstraints seg).refinedMode == none

-- 320 km/h is not driving. Both `mode` and `refinedMode` carry the override.
#guard (enforcePhysicalConstraints { seg with maxSpeed := 320 }).mode == "train"
#guard (enforcePhysicalConstraints { seg with maxSpeed := 320 }).refinedMode == some "train"
#guard (enforcePhysicalConstraints { seg with maxSpeed := 320 }).refinedReason
  == some "physical-impossibility override (max 320 km/h exceeds driving limit)"

-- The train ceiling reads avgSpeed, and the reason says so.
#guard (enforcePhysicalConstraints { seg with mode := "train", avgSpeed := 420 }).mode == "plane"
#guard (enforcePhysicalConstraints { seg with mode := "train", avgSpeed := 420 }).refinedReason
  == some "physical-impossibility override (avg 420 km/h exceeds train limit)"

-- `mode`, not `effectiveMode`: a leg REFINED to driving is not tested here.
#guard (enforcePhysicalConstraints
  { seg with mode := "walking", refinedMode := some "driving", maxSpeed := 320 }).mode == "walking"

-- The override REPLACES an existing reason rather than appending to it.
#guard (enforcePhysicalConstraints { seg with maxSpeed := 320, refinedReason := some "earlier" }).refinedReason
  == some "physical-impossibility override (max 320 km/h exceeds driving limit)"

/-! ### `applyBiometricSignature` -/

-- A synthetic gap segment has nothing to score against.
#guard applyBiometricSignature [] [] [] { seg with pointCount := 0 } == { seg with pointCount := 0 }

-- No stats: `correctModeBySignature` returns unchanged and the gate does not fire.
#guard applyBiometricSignature [] [] [] seg == seg

-- The cycling gate fires without any stats at all — hard evidence, not likelihood.
-- 40 km/h is above the cycling band, so the demotion target is driving.
#guard (applyBiometricSignature [] [] [] { seg with mode := "cycling" }).refinedMode == some "driving"
#guard (applyBiometricSignature [] [] [] { seg with mode := "cycling" }).refinedReason
  == some "cycling demoted to driving — no hard cycling evidence"

-- A walk the body scores as a sit is GPS jitter, and says so for the jitter
-- consolidation (2026-09-30).
private def sitStats : List ModeStats :=
  [⟨"stationary", some 65, some 10, 100, some 0, some 5, 100, some 0.5, some 1, 100, 100⟩,
   ⟨"walking", some 95, some 10, 100, some 105, some 10, 100, some 5, some 1, 100, 100⟩]
private def driftWalk : Seg :=
  { seg with mode := "walking", avgSpeed := 1.7, maxSpeed := 6 }
#guard (applyBiometricSignature [(0, 64), (300, 66)] [(0, 2)] sitStats driftWalk).refinedMode
  == some "stationary"
#guard (applyBiometricSignature [(0, 64), (300, 66)] [(0, 2)] sitStats driftWalk).refinedKinds
  == #["gps-jitter"]

/-! ### `planeInsideTrainRun` -/

private def tr (a b : Int) (avg : Float := 290) : Seg :=
  { seg with startTs := a, endTs := b, mode := "train", avgSpeed := avg }
private def pl (a b : Int) (avg : Float := 290) : Seg :=
  { seg with startTs := a, endTs := b, mode := "plane", avgSpeed := avg }

-- The TGV: a plane window between train windows is the train.
#guard (planeInsideTrainRun #[tr 0 600, pl 600 900, tr 900 1500]).map (·.mode)
  == #["train", "train", "train"]
-- A flight: the climb window sits beside cruise, not beside a train.
#guard (planeInsideTrainRun #[tr 0 600, pl 600 900 290, pl 900 1500 800]).map (·.mode)
  == #["train", "plane", "plane"]
-- Above what a train can average it stays a plane, whatever its neighbours.
#guard (planeInsideTrainRun #[tr 0 600, pl 600 900 450, tr 900 1500]).map (·.mode)
  == #["train", "plane", "train"]
-- A neighbour beyond the gap is a different journey.
#guard (planeInsideTrainRun #[tr 0 600, pl 1300 1600, tr 1600 2200]).map (·.mode)
  == #["train", "plane", "train"]
-- A neighbour demoted to "driving" for want of map data still moves like a
-- train when no car could match it (the second Hendaye window, 2026-10-01).
#guard (planeInsideTrainRun #[{ tr 0 600 with refinedMode := some "driving", maxSpeed := 293 },
    pl 600 900, tr 900 1500]).map effectiveMode == #["driving", "train", "train"]
#guard (planeInsideTrainRun #[{ tr 0 600 with refinedMode := some "driving", maxSpeed := 120 },
    pl 600 900, tr 900 1500]).map effectiveMode == #["driving", "plane", "train"]
-- At the edges there is only one neighbour, which is not enough.
#guard (planeInsideTrainRun #[pl 0 300, tr 300 900]).map (·.mode) == #["plane", "train"]

/-! ### `trainContinuesWithoutMap` -/

private def dr (a b : Int) (why : Option String := some Verified.Geo.RefineMode.NO_OSM_CONTEXT) : Seg :=
  { seg with startTs := a, endTs := b, mode := "driving", avgSpeed := 92, maxSpeed := 145,
             refinedMode := some "driving", refinedReason := why }

-- The TGV south of Bordeaux: unmapped "driving" straight after the train.
#guard (trainContinuesWithoutMap #[tr 0 600, dr 600 1800, dr 1800 2400]).map effectiveMode
  == #["train", "train", "train"]
-- The map said road: the enrichment's verdict stands.
#guard (trainContinuesWithoutMap #[tr 0 600, dr 600 1800 (some "on motorway")]).map effectiveMode
  == #["train", "driving"]
-- A stop between (a gap past a minute) is a change of vehicle.
#guard (trainContinuesWithoutMap #[tr 0 600, dr 700 1800]).map effectiveMode
  == #["train", "driving"]
-- No train before it, nothing to continue.
#guard (trainContinuesWithoutMap #[dr 0 600]).map effectiveMode == #["driving"]

/-! ### `meanInWindow` -/

-- INCLUSIVE both ends.
#guard meanInWindow [(0, 10), (600, 20)] 0 600 == some 15
#guard meanInWindow [(0, 10), (601, 20)] 0 600 == some 10
-- An empty catch is `none`, not zero — the two mean different things to the veto.
#guard meanInWindow [(0, 10)] 100 200 == none

/-! ### The sequence -/

-- Order: `revertIsolatedCadence` undoes `cadenceCorrect`, so a lone walking leg
-- with no steps and no driving neighbour comes out of the pair unflipped —
-- flipped by the first, reverted by the second. Running them the other way round
-- would leave the flip standing, which is the whole point of pinning it here.
private def walk : Seg :=
  { startTs := 0, endTs := 600, mode := "walking", avgSpeed := 4, maxSpeed := 6,
    linearity := 0.9, pointCount := 30, confidenceMargin := 0 }
private def zeroSteps : List StepPoint :=
  [⟨0, 0⟩, ⟨300, 0⟩, ⟨600, 0⟩, ⟨900, 0⟩]

#guard ((preFold zeroSteps [] [] #[walk])[0]!).refinedMode == some "walking"
-- …and it still carries the tag the flip left, which is how the revert is
-- distinguished from "never flipped" (`isCadenceFlip` also tests `refinedMode`).
#guard ((preFold zeroSteps [] [] #[walk])[0]!).refinedKinds == #["low-cadence"]

-- With a real drive either side the flip STANDS, so the same input decides the
-- other way — the pair is context-sensitive, not a no-op.
private def drive : Seg := { seg with startTs := 700, endTs := 1300 }
#guard ((preFold zeroSteps [] [] #[drive, walk, drive])[1]!).refinedMode == some "driving"

end Guards

end Verified.Geo.PreFold
