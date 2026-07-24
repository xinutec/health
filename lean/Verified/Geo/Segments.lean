import Verified.Hsmm.FloatScore
/-!
# Segment classification scoring cluster (port of the pure kernels in `src/geo/segments.ts`)

The motion-only classifier that turns a window's kinematic features into a mode
+ confidence. Ported here: `rangeScore` (the Gaussian match) and the six per-mode
scorers, `scoreWindow` (assemble + stable-sort desc), `normalizeScores`
(probability + margin), `roadSupportedConfidence`, `isStationaryIncoherent`, the
`pedestrianCoreDisplacementM` largest-pedestrian-run, and the
`enforcePhysicalConstraints` mode decision.

The window→segment *merging* (`mergeWindows` / `smoothSegments` / `findStays` /
`classifySegments`) sequences these over arrays and builds `TrackSegment`s — that
stays with the orchestrator for now; here we port the leaf math each pass calls.

`rangeScore` is `exp`-based ⇒ scores are ≤1-ULP (guarded relatively); the sort
ORDER of the modes — what actually classifies — is pinned EXACTLY. Displacement
reuses the shared `haversineMeters` (≤1 ULP). `roadSupportedConfidence` /
`isStationaryIncoherent` / `enforcePhysicalConstraints` are exact (arith +
`Math.round` + discrete). The `refinedReason` text (a `toFixed` display string)
stays shell — control flow uses `RefinedKind`, not the sentence. UNPROVEN;
pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.Segments

open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Constants (verbatim from segments.ts) -/
def MARGIN_MAX_FINITE : Float := 1000
def DRIVING_MAX_SPEED_KMH : Float := 250
def TRAIN_MAX_AVG_SPEED_KMH : Float := 400
def STAY_MAX_LINEARITY : Float := 0.7
def STAY_MAX_NET_DISPLACEMENT_M : Float := 90
def STAY_FLIP_DWELL_MIN_S : Float := 45 * 60
def STAY_FLIP_MIN_PACE_KMH : Float := 0.5
def PEDESTRIAN_CORE_MAX_STEP_KMH : Float := 15

/-- The kinematic features the scorers read from a window. -/
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

def scoreCycling (f : WindowFeatures) : Float := Id.run do
  let mut score := rangeScore f.medianSpeed 18 8
  score := score * rangeScore f.linearity 0.7 0.3
  score := score * rangeScore f.speedVariance 15 20
  if decide (f.maxSpeed > 50) then score := score * 0.1
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

/-- A `stationary` window whose fixes progress in a directed line over real
    distance is slow locomotion, not a stay — unless it is a dwell-scale window
    whose pedestrian core never reached locomotion pace (a departure tail). -/
def isStationaryIncoherent (linearity netDisplacementM coreDisplacementM durationS : Float) : Bool :=
  if decide (linearity ≤ STAY_MAX_LINEARITY) then false
  else if decide (netDisplacementM ≤ STAY_MAX_NET_DISPLACEMENT_M) then false
  else
    let corePaceKmh := if decide (durationS > 0) then (coreDisplacementM / durationS) * 3.6 else 0
    let dwellWithDepartureTail :=
      decide (durationS ≥ STAY_FLIP_DWELL_MIN_S) && decide (corePaceKmh < STAY_FLIP_MIN_PACE_KMH)
    !dwellWithDepartureTail

/-- A fix for the pedestrian-core scan: instant + position. -/
structure PedFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited

/-- Net displacement of a fix sequence's pedestrian core: split at every
    vehicle-paced step, take the largest resulting run, return its first→last
    great-circle distance. A departing ride's teleport tail is severed off. -/
def pedestrianCoreDisplacementM (fixes : Array PedFix) : Float := Id.run do
  if fixes.size < 2 then return 0
  let vehiclePaced := fun (a b : PedFix) =>
    let dt := b.ts - a.ts
    if decide (dt ≤ 0) then false
    else decide ((haversineMeters a.lat a.lon b.lat b.lon / dt.toNat.toFloat) * 3.6 ≥ PEDESTRIAN_CORE_MAX_STEP_KMH)
  let mut bestStart : Nat := 0
  let mut bestEnd : Nat := 0
  let mut runStart : Nat := 0
  for i in [1:fixes.size] do
    if vehiclePaced fixes[i-1]! fixes[i]! then
      if i - 1 - runStart > bestEnd - bestStart then
        bestStart := runStart
        bestEnd := i - 1
      runStart := i
  if fixes.size - 1 - runStart > bestEnd - bestStart then
    bestStart := runStart
    bestEnd := fixes.size - 1
  if bestEnd ≤ bestStart then return 0
  return haversineMeters fixes[bestStart]!.lat fixes[bestStart]!.lon fixes[bestEnd]!.lat fixes[bestEnd]!.lon

/-- Physical-impossibility mode override: driving above the driving speed limit
    is high-speed rail; a train above the train limit is a plane. Returns the
    resulting mode (the `refinedReason` display string stays shell). -/
def enforcePhysicalConstraints (mode : String) (avgSpeed maxSpeed : Float) : String :=
  if mode == "driving" && decide (maxSpeed > DRIVING_MAX_SPEED_KMH) then "train"
  else if mode == "train" && decide (avgSpeed > TRAIN_MAX_AVG_SPEED_KMH) then "plane"
  else mode

/-! ## Parity with Node/V8 (`lean/experiments/segments-refs.mts`) -/

private def base : WindowFeatures :=
  ⟨0, 0, 0, 0, 0, 0, 0, 0, 0⟩
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
#guard (scoreWindow wfStationary).map (·.mode) == ["stationary", "walking", "cycling", "driving", "train", "plane"]
#guard approxRel (scoreWindow wfStationary).head!.score 30.649086792579197
#guard (scoreWindow wfWalking).map (·.mode) == ["walking", "cycling", "driving", "stationary", "train", "plane"]
#guard approxRel (scoreWindow wfWalking).head!.score 1.1341381842555036
#guard (scoreWindow wfTrain).map (·.mode) == ["train", "driving", "plane", "cycling", "stationary", "walking"]
#guard approxRel (scoreWindow wfTrain).head!.score 0.9937694906233948
#guard (scoreWindow wfDriving).map (·.mode) == ["driving", "train", "cycling", "plane", "walking", "stationary"]
#guard approxRel (scoreWindow wfDriving).head!.score 1.876536109320096

#guard match normalizeScores (scoreWindow wfWalking) with
  | (m, p, mg) => m == "walking" && approxRel p 0.8634051835758314 && approxRel mg 7.792590923803349
#guard match normalizeScores (scoreWindow wfStationary) with
  | (m, p, mg) => m == "stationary" && approxRel p 0.999650345935714 && mg == 1000
#guard match normalizeScores (scoreWindow wfDriving) with
  | (m, p, mg) => m == "driving" && approxRel p 0.9953900869184644 && approxRel mg 215.966224361806

#guard roadSupportedConfidence "driving" 0.9 (some 1.0) == 0.9
#guard roadSupportedConfidence "driving" 0.9 (some 0.0) == 0.45
#guard roadSupportedConfidence "driving" 0.88 (some 0.3) == 0.7
#guard roadSupportedConfidence "driving" 0.9 none == 0.9
#guard roadSupportedConfidence "train" 0.9 (some 0.0) == 0.9

#guard isStationaryIncoherent 0.9 400 400 600 == true
#guard isStationaryIncoherent 0.5 400 400 600 == false
#guard isStationaryIncoherent 0.9 50 50 600 == false
#guard isStationaryIncoherent 0.9 408 408 9000 == false

private def approxA (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def march : Array PedFix := #[
  ⟨0, 51.5000, -0.1000⟩, ⟨60, 51.5005, -0.1000⟩, ⟨120, 51.5010, -0.1000⟩, ⟨180, 51.5015, -0.1000⟩]
private def stayTail : Array PedFix := #[
  ⟨0, 51.5000, -0.1000⟩, ⟨60, 51.5001, -0.1000⟩, ⟨120, 51.5002, -0.1000⟩, ⟨180, 51.6000, -0.1000⟩]
#guard approxA (pedestrianCoreDisplacementM march) 166.79238996684444
#guard approxA (pedestrianCoreDisplacementM stayTail) 22.238985328859922

#guard enforcePhysicalConstraints "driving" 100 320 == "train"
#guard enforcePhysicalConstraints "train" 420 500 == "plane"
#guard enforcePhysicalConstraints "driving" 60 90 == "driving"

end Verified.Geo.Segments
