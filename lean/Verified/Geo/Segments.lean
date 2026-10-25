import Verified.Geo.ModeBiometrics
import Verified.Hsmm.FloatScore
import Verified.Fix
/-!
# Window mode scoring (port of the pure kernels in `src/geo/segments.ts`)

The motion-only scorers that turn a window's kinematic features into a mode +
confidence: `rangeScore` (the Gaussian match) and the six per-mode scorers,
`scoreWindow` (assemble + stable-sort desc), `normalizeScores` (probability +
margin) and `roadSupportedConfidence`.

`rangeScore` is `exp`-based ⇒ scores are ≤1-ULP (guarded relatively); the sort
ORDER of the modes — what actually classifies — is pinned EXACTLY.
`roadSupportedConfidence` is exact. UNPROVEN; pinned by the `#guard`s against
Node/V8.
-/

namespace Verified.Geo.Segments

open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Constants (verbatim from segments.ts) -/
def MARGIN_MAX_FINITE : Float := 1000

/-- The kinematic features the scorers read from a window.

The defaulted fields are not read by the scorers. -/
structure WindowFeatures where
  medianSpeed : Float
  maxSpeed : Float
  speedVariance : Float
  headingChangeRate : Float
  linearity : Float
  accelerationBursts : Float
  stopFraction : Float
  netDisplacement : Float
  boundingRadius : Float
  startTs : Int := 0
  endTs : Int := 0
  centroidLat : Float := 0
  centroidLon : Float := 0
  pointCount : Nat := 0
  /-- Whether this window MOVED FARTHER THAN ITS OWN GPS ERROR, so `linearity`
      means something (#185).

      ⚠ `linearity` is a net/path ratio and reads 1.0 — maximally directed — for
      any path with one effective hop, so a fix landing elsewhere inside the
      noise outscores a genuine walk, which wanders. Measured 2026-09-06: a
      2-minute leg, 3 fixes at 100 m accuracy, 89 m net, scored 1.0000 against
      0.52 and 0.65 for the real walks that day.

      ⚠ DEFAULT `true` — "assume measurable" — because no caller that omits it
      should change behaviour, and because a window with no accuracy reported is
      not thereby suspect.

      ⚠ It does NOT alter `linearity` itself. Doing that broke 41 of 42 corpus
      days: a STATIONARY window is unresolvable by definition, and mode is
      classified FROM these features. This is a separate fact for the one
      consumer that needs it. -/
  directionResolvable : Bool := true
  deriving Inhabited

/-- A mode with its raw score. -/
structure ModeScore where
  mode : String
  score : Float
  deriving Inhabited

/-! ## Scorers -/

/-- Gaussian match: how well `value` sits near `ideal` within `tolerance`. -/
def rangeScore (value ideal tolerance : Float) : Float :=
  Float.exp (-0.5 * ((value - ideal) / tolerance) ^ 2)

def scoreStationary (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 0 1.5
  score := score * (1 + f.stopFraction)
  if decide (f.boundingRadius < 30) then score := score * 3
  if decide (f.boundingRadius < 15) then score := score * 3
  if decide (f.netDisplacement < 20) then score := score * 2
  if decide (f.maxSpeed > 20) && decide (f.netDisplacement > 200) then score := score * 0.1
  return score

def scoreWalking (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 4 3
  score := score * rangeScore f.linearity 0.5 0.4
  score := score * (1 + f.headingChangeRate * 0.5)
  if decide (f.maxSpeed > 15) then score := score * 0.1
  if decide (f.boundingRadius < 30) then score := score * 0.1
  if decide (f.netDisplacement < 30) then score := score * 0.2
  return score

/-- ⚠ **THE LOW-SPEED FLOOR IS WHY A WALK STOPS READING AS A RIDE (#1659).**
Every other locomotion scorer has one — `scoreDriving` below `10`, `scoreTrain`
below `30` — and cycling had none, while `scoreWalking` carries a `maxSpeed > 15`
veto that a SINGLE GPS spike trips. So a spiky walk lost a factor of ten on the
right answer and nothing on the wrong one, and seven walks over two weeks were
classified as cycling at 4.5-7.0 km/h.

The bar is `ModeBiometrics.CYCLING_MIN_SPEED_KMH`, IMPORTED rather than
restated. -/
def scoreCycling (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 18 8
  score := score * rangeScore f.linearity 0.7 0.3
  score := score * rangeScore f.speedVariance 15 20
  if decide (f.maxSpeed > 50) then score := score * 0.1
  if decide (f.medianSpeed < Verified.Geo.ModeBiometrics.CYCLING_MIN_SPEED_KMH) then
    score := score * 0.1
  return score

def scoreDriving (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 60 35
  score := score * (1 + f.accelerationBursts * 0.3)
  score := score * rangeScore f.linearity 0.7 0.3
  if decide (f.medianSpeed < 10) then score := score * 0.1
  return score

def scoreTrain (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 120 60
  score := score * rangeScore f.linearity 0.95 0.1
  score := score * rangeScore f.speedVariance 5 15
  score := score * rangeScore f.headingChangeRate 0.5 2
  if decide (f.medianSpeed < 30) then score := score * 0.1
  return score

def scorePlane (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 500 300
  score := score * rangeScore f.linearity 0.99 0.05
  score := score * rangeScore f.speedVariance 2 10
  if decide (f.medianSpeed < 150) then score := score * 0.01
  return score

/-- Stable insert of `x` into a descending-by-score list: `x` lands before the
    first element it strictly outscores, so equal-scored earlier entries keep
    their order — matching V8's stable `sort((a,b)=>b.score-a.score)`. -/
private def insertDesc (x : ModeScore) : List ModeScore → List ModeScore
  | [] => [x]
  | y :: ys => if decide (x.score > y.score) then x :: y :: ys else y :: insertDesc x ys

/-- The six mode scores, sorted by score descending (stable). -/
def scoreWindow (f : WindowFeatures) : List ModeScore :=
  let scores : List ModeScore := [
    ⟨"stationary", scoreStationary f⟩, ⟨"walking", scoreWalking f⟩,
    ⟨"cycling", scoreCycling f⟩, ⟨"driving", scoreDriving f⟩,
    ⟨"train", scoreTrain f⟩, ⟨"plane", scorePlane f⟩]
  scores.foldl (fun acc x => insertDesc x acc) []

/-- Normalise sorted mode scores into `(mode, probability, margin)`: share-of-
    total for the top mode, and its ratio over the runner-up (capped). -/
def normalizeScores (scores : List ModeScore) : String × Float × Float :=
  match scores with
  | [] => ("stationary", 0, 1)
  | top :: rest =>
    let sum := scores.foldl (fun a s => a + s.score) 0
    if sum == 0 then (top.mode, 0, 1)
    else
      let probability := top.score / sum
      let runnerUp := match rest with | r :: _ => r.score | [] => 0
      let margin := if decide (runnerUp > 0) then min (top.score / runnerUp) MARGIN_MAX_FINITE
                    else MARGIN_MAX_FINITE
      (top.mode, probability, margin)

/-- Temper a `driving` segment's confidence by how much of its track hugged a
    drivable road. Non-driving or `none` fraction ⇒ unchanged. `Math.round` to
    two decimals. -/
def roadSupportedConfidence (mode : String) (confidence : Float) (roadCorridorFraction : Option Float) : Float :=
  match roadCorridorFraction with
  | none => confidence
  | some fr =>
    if mode != "driving" then confidence
    else
      let support := 0.5 + min 0.5 (max 0 fr)
      Float.floor (confidence * support * 100 + 0.5) / 100

/-! ## Parity with Node/V8 (`lean/experiments/segments-refs.mts`) -/

private def base : WindowFeatures :=
  { medianSpeed := 0, maxSpeed := 0, speedVariance := 0, headingChangeRate := 0, linearity := 0,
    accelerationBursts := 0, stopFraction := 0, netDisplacement := 0, boundingRadius := 0 }
private def wfStationary : WindowFeatures :=
  { base with medianSpeed := 0.5, maxSpeed := 2, boundingRadius := 10, netDisplacement := 5, stopFraction := 0.8 }
private def wfWalking : WindowFeatures :=
  { base with medianSpeed := 4.5, maxSpeed := 7, linearity := 0.5, headingChangeRate := 0.3,
              boundingRadius := 120, netDisplacement := 200 }
private def wfTrain : WindowFeatures :=
  { base with medianSpeed := 120, maxSpeed := 160, linearity := 0.96, speedVariance := 5,
              headingChangeRate := 0.4, netDisplacement := 5000, boundingRadius := 3000 }
private def wfDriving : WindowFeatures :=
  { base with medianSpeed := 55, maxSpeed := 90, linearity := 0.72, speedVariance := 30,
              accelerationBursts := 3, headingChangeRate := 1.5, netDisplacement := 3000, boundingRadius := 2000 }

private def approxRel (a b : Float) : Bool :=
  Float.abs (a - b) ≤ 1e-9 * max (Float.abs a) (Float.abs b) + 1e-12

-- Mode ORDER pinned exactly; top score / normalise fields ≤1 ULP (relative).
--
-- ⚠ **THESE NUMBERS CANNOT BE REGENERATED.** `segments-refs.mts` produced them
-- and went with the TypeScript (#975), so touching one is a deliberate choice,
-- not a re-derivation. Take a new value from the evaluator's BIT PATTERN:
-- `toString` on a Float gives six decimals and `approxRel` compares at 1e-9.
--
-- ⚠ **A CHANGE TO ANY SCORER MOVES EVERY SLOW WINDOW HERE**, stationary
-- fixtures included. `normalizeScores` is share-of-total, so each scorer sits
-- in the DENOMINATOR of every confidence — expect the ORDER beneath the winner
-- and the confidence figures to move together, and the winner not to.
#guard (scoreWindow wfStationary).map (·.mode) == ["stationary", "walking", "driving", "cycling", "train", "plane"]
#guard approxRel (scoreWindow wfStationary).head!.score 30.649086792579197
#guard (scoreWindow wfWalking).map (·.mode) == ["walking", "driving", "cycling", "stationary", "train", "plane"]
#guard approxRel (scoreWindow wfWalking).head!.score 1.1341381842555036
#guard (scoreWindow wfTrain).map (·.mode) == ["train", "driving", "plane", "cycling", "stationary", "walking"]
#guard approxRel (scoreWindow wfTrain).head!.score 0.9937694906233948
#guard (scoreWindow wfDriving).map (·.mode) == ["driving", "train", "cycling", "plane", "walking", "stationary"]
#guard approxRel (scoreWindow wfDriving).head!.score 1.876536109320096

/-- ⚠ **THE ONE-FIELD PERTURBATION, and it FAILED before #1659's fix.**
`wfWalking` is this file's own walking window (median 4.5, max 7). Only
`maxSpeed` moves, so a single GPS spike is the WHOLE cause — no cycling day has
to exist for this to be pinned, which matters because the corpus has none. -/
private def wfWalkingWithSpike : WindowFeatures := { wfWalking with maxSpeed := 32 }
#guard (scoreWindow wfWalkingWithSpike).head!.mode == "walking"

#guard match normalizeScores (scoreWindow wfWalking) with
  | (m, p, mg) => m == "walking" && approxRel p 0.9590390156211506 && approxRel mg 49.79553227544871
#guard match normalizeScores (scoreWindow wfStationary) with
  | (m, p, mg) => m == "stationary" && approxRel p 0.9997834232822996 && mg == 1000
#guard match normalizeScores (scoreWindow wfDriving) with
  | (m, p, mg) => m == "driving" && approxRel p 0.9953900869184644 && approxRel mg 215.966224361806
-- The train window was the one `segments-refs.mts` GENERATED and nothing pinned:
-- `scoreWindow wfTrain` had a guard, `normalizeScores` of it did not, so the
-- margin here was unconstrained while its three neighbours were. Values from the
-- refs against the production TS, 2026-08-17.
#guard match normalizeScores (scoreWindow wfTrain) with
  | (m, p, mg) => m == "train" && approxRel p 0.8601206941870266 && approxRel mg 6.288316014717662

#guard roadSupportedConfidence "driving" 0.9 (some 1.0) == 0.9
#guard roadSupportedConfidence "driving" 0.9 (some 0.0) == 0.45
#guard roadSupportedConfidence "driving" 0.88 (some 0.3) == 0.7
#guard roadSupportedConfidence "driving" 0.9 none == 0.9
#guard roadSupportedConfidence "train" 0.9 (some 0.0) == 0.9

end Verified.Geo.Segments
