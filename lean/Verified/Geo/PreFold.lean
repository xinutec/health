import Verified.Geo.SegmentMerge
import Verified.Geo.BiometricLabels
import Verified.Geo.ModeBiometrics
import Verified.Geo.Segments
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
    { s with refinedMode := some rMode
             refinedReason := some s!"re-classified as {rMode} by biometric signature" }

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

/-- The five, in the TS's order. Each consumes what the last produced; the order
is load-bearing in the same way the cascade's is, and for the same reason the
`revertIsolatedCadence` entry exists at all — it undoes the pass before it, so
swapping the two makes both no-ops. -/
def preFold (steps : List StepPoint) (hr : List HrPoint) (stats : List ModeStats)
    (segs : Array Seg) : Array Seg :=
  let stepPairs := steps.map fun p => (p.ts, p.steps)
  let hrPairs := hr.map fun p => (p.ts, p.bpm)
  let flipped := segs.map fun s => applyDecision s (correctModeFromCadence s steps)
  let reverted := revertIsolatedCadenceDrivesApplied flipped.toList
  let corrected := reverted.map fun s => applyDecision s (demoteJitterWalkToStationary s steps)
  let biometric := corrected.map (applyBiometricSignature hrPairs stepPairs stats)
  biometric.map enforcePhysicalConstraints

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
