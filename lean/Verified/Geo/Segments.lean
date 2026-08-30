import Verified.Hsmm.FloatScore
import Verified.JsNum
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

/-- The kinematic features the scorers read from a window.

The last five fields are DEFAULTED because the scorers never read them: only
`extractFeatures` (which fills them) and `mergeWindows` (which splits stationary
runs on centroid distance, and sums `pointCount`) care. Defaulting keeps every
scorer guard written before the merging half was ported compiling unchanged. -/
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

/-! ## Window → segment assembly

The second half of `segments.ts`, and the half the module header used to defer:
`extractFeatures` → `mergeWindows` → `smoothSegments` → `findStays` →
`inferTransitGaps`, assembled by `classifySegments`. Unlike the scorers above,
the OUTPUT RECORDS are the answer here rather than a number a caller decides on,
so the whole rewrite ports — the same judgement made for `SegmentMerge`.

`extractFeatures` and `mergeWindows` are module-PRIVATE in the TS, so they are
reference-tested THROUGH `classifySegments`, which is the only caller. -/

/-! ### Constants (verbatim from segments.ts) -/
def STATIONARY_SPLIT_DIST_M : Float := 100
/-- How long a stretch must hold still to be CUT AS A STAY by the sparse-data
fallback. NOT `Verified.Geo.FocusPlaces.FOCUS_VISIT_MIN_S` (10 min), which asks
whether a dwell is worth mining. This is the HIGHER bar, and the floor #268's
swallowed shop stops fall under. Both were `STAY_MIN_DURATION_SEC` until #762. -/
def SEGMENT_STAY_MIN_S : Int := 15 * 60
def CLUSTER_RADIUS_M : Float := 150
def WINDOW_SEC : Int := 300
def MIN_SEGMENT_SEC : Int := 120
def TRANSIT_GAP_MIN_DURATION_S : Int := 3 * 60
def TRANSIT_GAP_MIN_DISTANCE_M : Float := 200
def SLOW_GAP_MAX_SPEED_KMH : Float := 1.5
def SLOW_GAP_MIN_DURATION_S : Int := 30 * 60

/-- A Kalman-filtered fix, as the classifier reads it. -/
structure FilteredPoint where
  ts : Int
  lat : Float
  lon : Float
  speed_kmh : Float
  bearing : Float
  deriving Inhabited, BEq

/-- The looser-accuracy point set stay detection may run on instead. -/
structure StayPoint where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- A classified stretch of track. `refinedReason` is a display sentence and
`refinedKinds` the machine-readable tags a later pass branches on — both ported,
since `inferTransitGaps` is where they are first written and the `toFixed` text
is reproducible (`Verified.JsNum`). -/
structure TrackSegment where
  startTs : Int
  endTs : Int
  mode : String
  confidence : Float
  confidenceMargin : Float
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  pointCount : Nat
  refinedReason : Option String := none
  refinedKinds : Array String := #[]
  deriving Inhabited, BEq, Repr

open Verified.JsNum (jsRound)

/-- The TS module's OWN `median` — ascending sort, mean of the middle pair when
even, `0` when empty. A private copy in the TS, so a private copy here. -/
private def median (xs : Array Float) : Float :=
  if xs.isEmpty then 0 else
  let s := (xs.toList.mergeSort (· ≤ ·)).toArray
  let mid := s.size / 2
  if s.size % 2 == 0 then (s[mid-1]! + s[mid]!) / 2 else s[mid]!

/-- SAMPLE variance (`n-1`), not population. Under two values → 0. -/
private def variance (xs : Array Float) : Float :=
  if xs.size < 2 then 0 else
  let mean := xs.foldl (· + ·) 0.0 / xs.size.toFloat
  xs.foldl (fun acc v => acc + (v - mean) * (v - mean)) 0.0 / (xs.size - 1).toFloat

/-- JS `x || 1`: a ZERO span reads as one second. Guards the division below —
two fixes sharing a timestamp would otherwise divide by zero. Negative spans are
truthy in JS and pass through unchanged, so this tests `== 0`, not `≤ 0`. -/
private def orOneSec (d : Int) : Float := if d == 0 then 1 else Float.ofInt d

/-- Features of one window's points. Requires `wp.size ≥ 2` (the caller skips
shorter windows), which is what makes the `[0]!` / `[size-1]!` reads total. -/
private def featuresOf (wp : Array FilteredPoint) : WindowFeatures :=
  let speeds := wp.map (·.speed_kmh)
  let n := wp.size
  let idx := List.range (n - 1)
  -- Heading change: absolute successive difference, wrapped into [0,180].
  let totalHeadingChange := idx.foldl (fun acc i =>
    let d := Float.abs (wp[i+1]!.bearing - wp[i]!.bearing)
    acc + (if d > 180 then 360 - d else d)) 0.0
  let duration := orOneSec (wp[n-1]!.ts - wp[0]!.ts)
  let straightLine := haversineMeters wp[0]!.lat wp[0]!.lon wp[n-1]!.lat wp[n-1]!.lon
  let pathDistance := idx.foldl (fun acc i =>
    acc + haversineMeters wp[i]!.lat wp[i]!.lon wp[i+1]!.lat wp[i+1]!.lon) 0.0
  let accelBursts := idx.foldl (fun acc i =>
    let dt := orOneSec (wp[i+1]!.ts - wp[i]!.ts)
    if Float.abs (speeds[i+1]! - speeds[i]!) / dt > 5.0 / 3.6 then acc + 1 else acc) 0
  let stops := speeds.foldl (fun acc s => if s < 1 then acc + 1 else acc) 0
  let centroidLat := wp.foldl (fun s p => s + p.lat) 0.0 / n.toFloat
  let centroidLon := wp.foldl (fun s p => s + p.lon) 0.0 / n.toFloat
  { startTs := wp[0]!.ts
    endTs := wp[n-1]!.ts
    centroidLat := centroidLat
    centroidLon := centroidLon
    medianSpeed := median speeds
    maxSpeed := speeds.foldl (fun m s => max m s) speeds[0]!
    speedVariance := variance speeds
    headingChangeRate := totalHeadingChange / duration
    linearity := if pathDistance > 0 then min (straightLine / pathDistance) 1 else 0
    accelerationBursts := Float.ofNat accelBursts
    stopFraction := Float.ofNat stops / Float.ofNat speeds.size
    netDisplacement := straightLine
    boundingRadius := wp.foldl (fun m p => max m (haversineMeters centroidLat centroidLon p.lat p.lon)) 0.0
    pointCount := n }

/-- Advance to the first index at or after `i` whose fix falls outside the
window. Fuelled rather than `partial`: the fuel is the point count, which bounds
the scan. -/
private def scanWindowEnd (points : Array FilteredPoint) (endTs : Int) : Nat → Nat → Nat
  | 0, i => i
  | fuel+1, i => if i < points.size && points[i]!.ts < endTs then scanWindowEnd points endTs fuel (i+1) else i

/-- Fixed-width tumbling windows, each starting at the first fix not yet
consumed. A window holding fewer than two fixes is DROPPED, not emitted.

Fuelled by the point count: each step consumes at least one point whenever
`windowSec > 0` (the first fix always satisfies `ts < ts + windowSec`), so the
fuel can only over-provide. At `windowSec ≤ 0` the TS loops forever; here the
fuel runs out and the recursion terminates, which is the one deliberate
difference and is unreachable from `classifySegments` (`WINDOW_SEC = 300`). -/
private def extractLoop (points : Array FilteredPoint) (windowSec : Int) :
    Nat → Nat → Array WindowFeatures → Array WindowFeatures
  | 0, _, acc => acc
  | fuel+1, windowStart, acc =>
    if windowStart < points.size then
      let startTs := points[windowStart]!.ts
      let windowEnd := scanWindowEnd points (startTs + windowSec) points.size windowStart
      let wp := (points.toList.drop windowStart).take (windowEnd - windowStart) |>.toArray
      let acc := if wp.size < 2 then acc else acc.push (featuresOf wp)
      extractLoop points windowSec fuel windowEnd acc
    else acc

def extractFeatures (points : Array FilteredPoint) (windowSec : Int) : Array WindowFeatures :=
  if points.size < 2 then #[] else extractLoop points windowSec points.size 0 #[]

/-- Collapse a run of windows into one segment. Confidence and margin are the
per-window posteriors AVERAGED (the TS calls this "close enough for a
heuristic"); `avgSpeed` is the MEDIAN of the per-window medians, not a mean. -/
private def flushSeg (windows : Array WindowFeatures) (scores : Array (List ModeScore))
    (segStart endIdx : Nat) (mode : String) : TrackSegment :=
  let segW := ((windows.toList.drop segStart).take (endIdx - segStart)).toArray
  let segS := ((scores.toList.drop segStart).take (endIdx - segStart)).toArray
  let norms := segS.map normalizeScores
  let avgConfidence := norms.foldl (fun s n => s + n.2.1) 0.0 / norms.size.toFloat
  let avgMargin := norms.foldl (fun s n => s + n.2.2) 0.0 / norms.size.toFloat
  let avgLinearity := segW.foldl (fun s w => s + w.linearity) 0.0 / segW.size.toFloat
  { startTs := segW[0]!.startTs
    endTs := segW[segW.size-1]!.endTs
    mode := mode
    confidence := jsRound (avgConfidence * 100) / 100
    confidenceMargin := jsRound (avgMargin * 100) / 100
    avgSpeed := jsRound (median (segW.map (·.medianSpeed)) * 10) / 10
    maxSpeed := jsRound ((segW.foldl (fun m w => max m w.maxSpeed) segW[0]!.maxSpeed) * 10) / 10
    linearity := jsRound (avgLinearity * 100) / 100
    pointCount := segW.foldl (fun s w => s + w.pointCount) 0 }

/-- Merge consecutive same-mode windows into segments.

Two things force a cut: a mode change, and — for stationary runs only — a new
window whose centroid is more than `STATIONARY_SPLIT_DIST_M` from the run's
POINT-WEIGHTED running centroid. Without the second, "stationary at A, then
stationary at B 280 m away" collapses into one stay. -/
def mergeWindows (windows : Array WindowFeatures) (scores : Array (List ModeScore)) : Array TrackSegment :=
  if windows.isEmpty then #[] else Id.run do
    let mut segments : Array TrackSegment := #[]
    let mut currentMode := (scores[0]!).head!.mode
    let mut segStart := 0
    for i in [1:windows.size+1] do
      let newMode : Option String := if i < windows.size then some (scores[i]!).head!.mode else none
      let mut locationSplit := false
      if i < windows.size && currentMode == "stationary" && newMode == some "stationary" then
        let segW := ((windows.toList.drop segStart).take (i - segStart)).toArray
        let totalPts := Float.ofNat (segW.foldl (fun s w => s + w.pointCount) 0)
        let cLat := segW.foldl (fun s w => s + w.centroidLat * Float.ofNat w.pointCount) 0.0 / totalPts
        let cLon := segW.foldl (fun s w => s + w.centroidLon * Float.ofNat w.pointCount) 0.0 / totalPts
        let next := windows[i]!
        if haversineMeters cLat cLon next.centroidLat next.centroidLon > STATIONARY_SPLIT_DIST_M then
          locationSplit := true
      if newMode != some currentMode || locationSplit || i == windows.size then
        segments := segments.push (flushSeg windows scores segStart i currentMode)
        if i < windows.size then
          currentMode := (scores[i]!).head!.mode
          segStart := i
    return segments

/-- Absorb sub-`minDurationSec` segments into their predecessor. A 10-second
"driving" segment between two walks is noise, not a car ride.

The TS mutates the last kept element in place and copies everything else, so the
absorbed segment's mode, confidence and linearity are DISCARDED — only its end,
point count and peak speed survive. -/
def smoothSegments (segments : Array TrackSegment) (minDurationSec : Int) : Array TrackSegment :=
  if segments.size ≤ 1 then segments else Id.run do
    let mut result : Array TrackSegment := #[segments[0]!]
    for i in [1:segments.size] do
      let seg := segments[i]!
      if seg.endTs - seg.startTs < minDurationSec && result.size > 0 then
        let j := result.size - 1
        let prev := result[j]!
        result := result.set! j { prev with
          endTs := seg.endTs
          pointCount := prev.pointCount + seg.pointCount
          maxSpeed := max prev.maxSpeed seg.maxSpeed }
      else
        result := result.push seg
    return result

/-- `samplesInWindow`: INCLUSIVE at both ends, the pipeline-wide convention. -/
private def stayPointsInWindow (pts : Array StayPoint) (s e : Int) : Array StayPoint :=
  pts.filter (fun p => p.ts ≥ s && p.ts ≤ e)

/-- A closed cluster becomes a stay only with ≥ 2 fixes spanning ≥ the minimum
duration. A lone outlier fix therefore evaporates instead of splitting the stay
around it. -/
private def emitStay (cluster : Array StayPoint) : Option TrackSegment :=
  if cluster.size < 2 then none else
  let sc := (cluster.toList.mergeSort (fun a b => a.ts ≤ b.ts)).toArray
  let first := sc[0]!
  let last := sc[sc.size-1]!
  if last.ts - first.ts < SEGMENT_STAY_MIN_S then none else
  some { startTs := first.ts, endTs := last.ts, mode := "stationary"
         confidence := 0.9, confidenceMargin := MARGIN_MAX_FINITE
         avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := sc.size }

/-- Time-ordered trajectory segmentation over the stretches no classified
segment covers. A fix within `CLUSTER_RADIUS_M` of the running cluster centroid
joins it; one beyond closes the cluster and opens a new one.

The centroid is a RUNNING MEAN updated per join, so a slow drift stays one
cluster — the reason this replaced a day-wide median that collapsed multi-stop
days into a single phantom stay. -/
def findStays (points : Array StayPoint) (existing : Array TrackSegment) : Array TrackSegment :=
  if points.isEmpty then #[] else Id.run do
    let sorted := (existing.toList.mergeSort (fun a b => a.startTs ≤ b.startTs)).toArray
    let firstTs := points[0]!.ts
    let lastTs := points[points.size-1]!.ts
    let mut gaps : Array (Int × Int) := #[]
    if sorted.isEmpty then
      gaps := #[(firstTs, lastTs)]
    else
      if sorted[0]!.startTs - firstTs ≥ SEGMENT_STAY_MIN_S then
        gaps := gaps.push (firstTs, sorted[0]!.startTs)
      for i in [0:sorted.size-1] do
        let gapStart := sorted[i]!.endTs
        let gapEnd := sorted[i+1]!.startTs
        if gapEnd - gapStart ≥ SEGMENT_STAY_MIN_S then gaps := gaps.push (gapStart, gapEnd)
      let lastSegEnd := sorted[sorted.size-1]!.endTs
      if lastTs - lastSegEnd ≥ SEGMENT_STAY_MIN_S then gaps := gaps.push (lastSegEnd, lastTs)
    let mut stays : Array TrackSegment := #[]
    for (gs, ge) in gaps do
      let inGap := ((stayPointsInWindow points gs ge).toList.mergeSort (fun a b => a.ts ≤ b.ts)).toArray
      if inGap.size ≥ 2 then
        let mut cluster : Array StayPoint := #[]
        let mut cLat := 0.0
        let mut cLon := 0.0
        for p in inGap do
          if cluster.isEmpty then
            cluster := #[p]; cLat := p.lat; cLon := p.lon
          else if haversineMeters cLat cLon p.lat p.lon ≤ CLUSTER_RADIUS_M then
            cluster := cluster.push p
            -- Running mean: the divisor is the size AFTER the push.
            cLat := cLat + (p.lat - cLat) / Float.ofNat cluster.size
            cLon := cLon + (p.lon - cLon) / Float.ofNat cluster.size
          else
            if let some s := emitStay cluster then stays := stays.push s
            cluster := #[p]; cLat := p.lat; cLon := p.lon
        if let some s := emitStay cluster then stays := stays.push s
    return stays

private def lastPointAtOrBefore (points : Array FilteredPoint) (ts : Int) : Option FilteredPoint := Id.run do
  let mut result : Option FilteredPoint := none
  for p in points do
    if p.ts ≤ ts then result := some p else break
  return result

private def firstPointAtOrAfter (points : Array FilteredPoint) (ts : Int) : Option FilteredPoint :=
  points.find? (fun p => p.ts ≥ ts)

/-- Synthesise a segment across a GPS blackout the user clearly moved through —
the underground / Faraday-cage case, where the classifier sees "stationary at A"
then "stationary at B" with nothing between.

Mode comes from the implied straight-line speed, with two deliberate
departures from naive banding: a gap bordered by something rail-shaped upgrades
to `train` rather than `driving` (a tube interchange is not a sudden car ride),
and a sub-walking-pace gap over half an hour becomes `unknown` rather than
fabricating a walk at 0.1 km/h. -/
def inferTransitGaps (segments : Array TrackSegment) (points : Array FilteredPoint) : Array TrackSegment :=
  if segments.size < 2 || points.size < 2 then segments else Id.run do
    let mut result : Array TrackSegment := #[]
    for i in [0:segments.size] do
      let seg := segments[i]!
      result := result.push seg
      if i + 1 < segments.size then
        let next := segments[i+1]!
        let gapDuration := next.startTs - seg.endTs
        if gapDuration ≥ TRANSIT_GAP_MIN_DURATION_S then
          match lastPointAtOrBefore points seg.endTs, firstPointAtOrAfter points next.startTs with
          | some lastBefore, some firstAfter =>
            let distanceM := haversineMeters lastBefore.lat lastBefore.lon firstAfter.lat firstAfter.lon
            if distanceM ≥ TRANSIT_GAP_MIN_DISTANCE_M then
              let speedKmh := (distanceM / Float.ofInt gapDuration) * 3.6
              -- Rail-shaped: the classifier said so, OR the geometry says so —
              -- rail is straighter than road (motorway tops out ~0.91, tube 0.99).
              let looksLikeRail := fun (s : TrackSegment) =>
                s.mode == "train" || s.mode == "plane" || (s.linearity > 0.95 && s.maxSpeed > 60)
              let neighbouringTransit := looksLikeRail seg || looksLikeRail next
              let honestUnknown := speedKmh < SLOW_GAP_MAX_SPEED_KMH && gapDuration ≥ SLOW_GAP_MIN_DURATION_S
              let inferredMode :=
                if honestUnknown then "unknown"
                else if speedKmh < 7 then "walking"
                else if speedKmh ≥ 120 then "train"
                else if neighbouringTransit then "train"
                else "driving"
              let km := (Verified.JsNum.toFixed (distanceM / 1000) 1).getD ""
              let min := (Verified.JsNum.toFixed (jsRound (Float.ofInt gapDuration / 60)) 0).getD ""
              let reason :=
                if honestUnknown then
                  s!"no GPS coverage for {min} min ({km} km between endpoints — sub-walking pace)"
                else s!"inferred from GPS gap ({km} km in {min} min)"
              result := result.push
                { startTs := seg.endTs, endTs := next.startTs, mode := inferredMode
                  confidence := if honestUnknown then 0.1 else 0.3
                  confidenceMargin := if honestUnknown then 1 else 1.2
                  avgSpeed := if honestUnknown then 0 else jsRound (speedKmh * 10) / 10
                  maxSpeed := if honestUnknown then 0 else jsRound (speedKmh * 10) / 10
                  linearity := if honestUnknown then 0 else 1
                  pointCount := 0
                  refinedReason := some reason
                  -- `unknown` is not a mode claim, so it carries no kind.
                  refinedKinds := if honestUnknown then #[] else #["gps-gap-inferred"] }
          | _, _ => pure ()
    return result

/-- Classify a Kalman-filtered track into transport-mode segments.

`stayPoints` is the optional looser-accuracy set: indoor fixes are usually
filtered out of the movement pipeline but are still evidence that you were
somewhere. Absent, the movement fixes double as stay evidence. -/
def classifySegments (points : Array FilteredPoint)
    (stayPoints : Option (Array StayPoint) := none) : Array TrackSegment :=
  let windows := extractFeatures points WINDOW_SEC
  let classified :=
    if windows.isEmpty then #[]
    else smoothSegments (mergeWindows windows (windows.map scoreWindow)) MIN_SEGMENT_SEC
  let sps := stayPoints.getD (points.map (fun p => ⟨p.ts, p.lat, p.lon⟩))
  let stays := findStays sps classified
  let ordered := (((classified ++ stays).toList).mergeSort (fun a b => a.startTs ≤ b.startTs)).toArray
  inferTransitGaps ordered points

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

/-! ### Window → segment assembly, pinned through `classifySegments`

Whole `TrackSegment` records compared, not selected fields: the rounded values
(`Math.round(x*100)/100`) are computed the same way on both sides, so they are
bit-equal, and comparing the record means a field nobody thought about cannot
drift silently. -/

private def fp (ts : Int) (lat lon spd : Float) (brg : Float := 0) : FilteredPoint :=
  ⟨ts, lat, lon, spd, brg⟩

-- A steady northward walk, 8 fixes a minute apart: one window, one segment.
private def walkPts : Array FilteredPoint :=
  (Array.range 8).map (fun i => fp (Int.ofNat i * 60) (51.5 + Float.ofNat i * 0.0007) (-0.1) 4.5 10)
#guard classifySegments walkPts == #[
  { startTs := 0, endTs := 420, mode := "walking", confidence := 0.75, confidenceMargin := 4.1,
    avgSpeed := 4.5, maxSpeed := 4.5, linearity := 1, pointCount := 8 }]

-- THE `locationSplit` BRANCH: two stationary clusters 280 m apart. Same mode
-- throughout, so only the point-weighted centroid test can separate them —
-- without it these collapse into one stay at neither place.
private def twoStayPts : Array FilteredPoint :=
  (Array.range 6).map (fun i => fp (Int.ofNat i * 60) 51.5 (-0.1) 0.2) ++
  (Array.range 6).map (fun i => fp (360 + Int.ofNat i * 60) 51.5025 (-0.1) 0.2)
#guard classifySegments twoStayPts == #[
  { startTs := 0, endTs := 240, mode := "stationary", confidence := 1, confidenceMargin := 1000,
    avgSpeed := 0.2, maxSpeed := 0.2, linearity := 0, pointCount := 5 },
  { startTs := 300, endTs := 660, mode := "stationary", confidence := 0.94, confidenceMargin := 504.83,
    avgSpeed := 0.2, maxSpeed := 0.2, linearity := 0.5, pointCount := 7 }]

-- `smoothSegments`: a lone 90 km/h fix between two walks is under
-- MIN_SEGMENT_SEC. Its MODE is discarded but its maxSpeed survives into the
-- predecessor — 90 on a segment labelled walking is the TS behaviour, pinned.
private def blipPts : Array FilteredPoint :=
  (Array.range 6).map (fun i => fp (Int.ofNat i * 60) (51.5 + Float.ofNat i * 0.0007) (-0.1) 4.5 10) ++
  #[fp 360 51.512 (-0.1) 90 10] ++
  (Array.range 6).map (fun i => fp (420 + Int.ofNat i * 60) (51.52 + Float.ofNat i * 0.0007) (-0.1) 4.5 10)
#guard classifySegments blipPts == #[
  { startTs := 0, endTs := 720, mode := "walking", confidence := 0.7, confidenceMargin := 3.28,
    avgSpeed := 4.5, maxSpeed := 90, linearity := 1, pointCount := 13 }]

-- `findStays` proper: a dwell in the uncovered stretch between two DIFFERENTLY
-- classified runs. The two runs must disagree on mode — same-mode runs merge
-- into one segment and leave no gap, so the fixture would pin nothing.
private def movePts : Array FilteredPoint :=
  (Array.range 6).map (fun i => fp (Int.ofNat i * 60) (51.5 + Float.ofNat i * 0.0007) (-0.1) 4.5 10) ++
  (Array.range 6).map (fun i => fp (7200 + Int.ofNat i * 60) (51.6 + Float.ofNat i * 0.012) (-0.1) 60 10)
private def dwellPts : Array StayPoint :=
  (Array.range 20).map (fun i => ⟨1200 + Int.ofNat i * 180, 51.55, -0.1⟩)
#guard classifySegments movePts (some (movePts.map (fun p => ⟨p.ts, p.lat, p.lon⟩) ++ dwellPts)) == #[
  { startTs := 0, endTs := 240, mode := "walking", confidence := 0.75, confidenceMargin := 4.1,
    avgSpeed := 4.5, maxSpeed := 4.5, linearity := 1, pointCount := 5 },
  { startTs := 240, endTs := 1200, mode := "driving", confidence := 0.3, confidenceMargin := 1.2,
    avgSpeed := 40.5, maxSpeed := 40.5, linearity := 1, pointCount := 0,
    refinedReason := some "inferred from GPS gap (10.8 km in 16 min)",
    refinedKinds := #["gps-gap-inferred"] },
  { startTs := 1200, endTs := 4620, mode := "stationary", confidence := 0.9, confidenceMargin := 1000,
    avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := 20 },
  { startTs := 4620, endTs := 7200, mode := "driving", confidence := 0.3, confidenceMargin := 1.2,
    avgSpeed := 15, maxSpeed := 15, linearity := 1, pointCount := 0,
    refinedReason := some "inferred from GPS gap (10.7 km in 43 min)",
    refinedKinds := #["gps-gap-inferred"] },
  { startTs := 7200, endTs := 7440, mode := "driving", confidence := 0.55, confidenceMargin := 1.24,
    avgSpeed := 60, maxSpeed := 60, linearity := 1, pointCount := 5 }]

private def gapSeg (s e : Int) (mode : String) (lin maxS : Float) : TrackSegment :=
  { startTs := s, endTs := e, mode := mode, confidence := 0.9, confidenceMargin := 3,
    avgSpeed := 4, maxSpeed := maxS, linearity := lin, pointCount := 5 }

-- 8 km across a 12-minute blackout: vehicle-speed, no rail neighbour → driving.
private def fastPts : Array FilteredPoint :=
  #[fp 0 51.5 (-0.1) 4, fp 60 51.5 (-0.1) 4, fp 780 51.572 (-0.1) 4, fp 840 51.572 (-0.1) 4]
#guard (inferTransitGaps #[gapSeg 0 60 "stationary" 0.5 5, gapSeg 780 840 "stationary" 0.5 5] fastPts)[1]! ==
  { startTs := 60, endTs := 780, mode := "driving", confidence := 0.3, confidenceMargin := 1.2,
    avgSpeed := 40, maxSpeed := 40, linearity := 1, pointCount := 0,
    refinedReason := some "inferred from GPS gap (8.0 km in 12 min)",
    refinedKinds := #["gps-gap-inferred"] }

-- 250 m across 40 minutes: sub-walking pace over the half-hour bar, so `unknown`
-- rather than a fabricated 0.4 km/h walk. Carries NO refinedKind — it is not a
-- mode claim — and zeroes speed and linearity.
private def slowPts : Array FilteredPoint :=
  #[fp 0 51.5 (-0.1) 0, fp 60 51.5 (-0.1) 0, fp 2460 51.5023 (-0.1) 0, fp 2520 51.5023 (-0.1) 0]
#guard (inferTransitGaps #[gapSeg 0 60 "stationary" 0.5 5, gapSeg 2460 2520 "stationary" 0.5 5] slowPts)[1]! ==
  { startTs := 60, endTs := 2460, mode := "unknown", confidence := 0.1, confidenceMargin := 1,
    avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := 0,
    refinedReason := some "no GPS coverage for 40 min (0.3 km between endpoints — sub-walking pace)",
    refinedKinds := #[] }

-- The rail-continuity arm: the SAME 38 km/h gap that would read `driving` above
-- becomes `train` because a bordering segment is rail. A tube interchange is not
-- a sudden car ride through London.
private def railPts : Array FilteredPoint :=
  #[fp 0 51.5 (-0.1) 40, fp 60 51.5 (-0.1) 40, fp 660 51.5570 (-0.1) 40, fp 720 51.5570 (-0.1) 40]
#guard (inferTransitGaps #[gapSeg 0 60 "train" 0.99 80, gapSeg 660 720 "stationary" 0.5 5] railPts)[1]! ==
  { startTs := 60, endTs := 660, mode := "train", confidence := 0.3, confidenceMargin := 1.2,
    avgSpeed := 38, maxSpeed := 38, linearity := 1, pointCount := 0,
    refinedReason := some "inferred from GPS gap (6.3 km in 10 min)",
    refinedKinds := #["gps-gap-inferred"] }

/-! ### `smoothSegments` and `findStays`

Both were reached only TRANSITIVELY, through the `classifySegments` guards above,
so they were pinned on whatever inputs that one fixture happens to produce and
independently nowhere (#1003). Values from `segments-refs.mts` against the
production TS. -/

private def sSeg (startTs endTs : Int) (mode : String) (maxSpeed : Float) (pointCount : Nat) : TrackSegment :=
  { startTs, endTs, mode, confidence := 0.8, confidenceMargin := 5,
    avgSpeed := 4, maxSpeed, linearity := 0.5, pointCount }

-- The 60 s middle segment is under the 120 s floor and is absorbed. End, point
-- count and peak speed move; the absorbed segment's MODE is discarded — that
-- discard is the whole content of the merge branch, and a port that kept the
-- shorter segment's mode would still produce the right segment COUNT.
#guard smoothSegments #[sSeg 0 300 "walking" 6 10, sSeg 300 360 "driving" 80 4, sSeg 360 900 "walking" 5 20] 120
  == #[{ sSeg 0 360 "walking" 80 14 with }, { sSeg 360 900 "walking" 5 20 with }]
-- Two consecutive shorts fold into the SAME predecessor, not into each other.
#guard smoothSegments #[sSeg 0 300 "walking" 6 10, sSeg 300 350 "driving" 80 4, sSeg 350 400 "cycling" 25 3] 120
  == #[{ sSeg 0 400 "walking" 80 17 with }]
-- A lone segment is returned untouched whatever the floor (the `≤ 1` early out).
#guard smoothSegments #[sSeg 0 30 "walking" 6 2] 120 == #[sSeg 0 30 "walking" 6 2]
#guard smoothSegments #[sSeg 0 300 "walking" 6 10, sSeg 300 900 "driving" 80 20] 120
  == #[sSeg 0 300 "walking" 6 10, sSeg 300 900 "driving" 80 20]

private def stay (startTs endTs : Int) (pointCount : Nat) : TrackSegment :=
  { startTs, endTs, mode := "stationary", confidence := 0.9,
    confidenceMargin := MARGIN_MAX_FINITE, avgSpeed := 0, maxSpeed := 0,
    linearity := 0, pointCount }

-- No classified segments ⇒ one gap spanning every point.
#guard findStays #[⟨0, 51.5, -0.1⟩, ⟨300, 51.5, -0.1⟩, ⟨600, 51.5001, -0.1⟩,
                   ⟨900, 51.5, -0.1⟩, ⟨1200, 51.5, -0.1⟩] #[] == #[stay 0 1200 5]
-- ⚠ TWO stays, not one spanning both. Two places ~1.1 km apart: the fix beyond
-- CLUSTER_RADIUS_M closes the first cluster and opens a second. Collapsing these
-- into a single stay anchored between them is the exact regression trajectory
-- segmentation replaced, and it is invisible in a fixture with one cluster.
#guard findStays #[⟨0, 51.5, -0.1⟩, ⟨450, 51.5, -0.1⟩, ⟨900, 51.5, -0.1⟩,
                   ⟨1200, 51.51, -0.1⟩, ⟨1700, 51.51, -0.1⟩, ⟨2200, 51.51, -0.1⟩] #[]
  == #[stay 0 900 3, stay 1200 2200 3]
-- Spans 600 s, under SEGMENT_STAY_MIN_S: no stay at all.
#guard findStays #[⟨0, 51.5, -0.1⟩, ⟨300, 51.5, -0.1⟩, ⟨600, 51.5, -0.1⟩] #[] == #[]
-- An existing segment splits the day; the stretch it covers is not searched.
#guard findStays #[⟨0, 51.5, -0.1⟩, ⟨450, 51.5, -0.1⟩, ⟨900, 51.5, -0.1⟩,
                   ⟨1000, 51.52, -0.1⟩, ⟨2000, 51.53, -0.1⟩,
                   ⟨2100, 51.54, -0.1⟩, ⟨2700, 51.54, -0.1⟩, ⟨3300, 51.54, -0.1⟩]
                 #[sSeg 1000 2000 "walking" 6 5]
  == #[stay 0 900 3, stay 2100 3300 3]

end Verified.Geo.Segments
