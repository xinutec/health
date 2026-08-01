import Verified.Geo.Segments
/-!
# Bridging co-located stays on biometric evidence (port of
`src/geo/bridge-stays-biometrics.ts`)

The 2026-05-22 Pizza Union case (#185): GPS shows three separate stays at the
same coordinates because a brief no-fix gap falls mid-meal. HR (resting) and
steps (zero) over that gap say the rider never actually moved, so the three are
one stay.

Conservative by design. Missing HR over the gap, ANY steps in it, or an elevated
mean all leave the pair unmerged. This is positive evidence that the rider
stayed put — not an assumption that a gap may be filled.

## Two shapes, two different tests

* **gapSec > 0** — a true signal gap, the original case. Requires `gapLooksStationary`:
  at least `MIN_HR_SAMPLES_IN_GAP` samples STRICTLY inside the gap, a mean at or
  below `RESTING_HR_MAX`, and zero steps.
* **gapSec ≤ 0** — back-to-back stays, e.g. a middle stretch a biometric pass
  reclassified from walking to stationary. Only the segment-level check: merge
  unless the combined window's mean HR exceeds `MAX_MERGE_HR_MEAN`, which catches
  exercise at a fixed place (a gym) where the centroid is stable but the rider
  was working hard.

Note which HR window each uses: the gap arm looks STRICTLY INSIDE the gap
(`>`/`<`, so a sample on a boundary belongs to the bracketing stay), while the
back-to-back arm uses `samplesInWindow`'s INCLUSIVE bounds over the combined
span. Both are guarded.

## Co-location is measured from the RUN'S FIRST STAY

`haversineMeters (centroids[i]) (centroids[j])` — `i` is the index the run
started at, never the running end. A chain of stays each within 150 m of its
predecessor but drifting away from the first therefore stops merging when it
leaves the FIRST stay's radius, not when a step exceeds it. That is what stops a
slow drift down a street from collapsing into one place, and it is pinned below.

## Deviations from the TS

* `haversineMeters` is a private copy here because it is a private copy THERE.
  It is not `Verified.Hsmm.FloatScore.haversineMeters`: that one associates the
  final product as `((c1*c2)*s)*s` while this TS writes
  `c1 * c2 * Math.sin(dLon/2)**2`, i.e. `(c1*c2)*(s*s)`. A 1-ULP difference that
  can only matter within a ULP of the 150 m threshold — but the port is of THIS
  file, so it keeps THIS association.
* `x ** 2` is written `x * x`. V8 special-cases an integer exponent of 2 to
  exactly that.

Exactness: sums, one division per mean, one `atan2` per pair. UNPROVEN; pinned
against Node/V8 (`lean/experiments/bridge-stays-refs.mts`).
-/

namespace Verified.Geo.BridgeStays

open Verified.Geo.Segments (TrackSegment)

/-! ## Inputs -/

structure HrPoint where
  ts : Int
  bpm : Float
  deriving Inhabited, BEq, Repr

structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited, BEq, Repr

/-! ## Constants -/

/-- Two stays whose centroids sit within this radius (m) are "the same place".
Matches `CLUSTER_RADIUS_M` in `findStays`, so the bridge can heal a stay that
fragmented during a brief gap. -/
def COLOCATION_RADIUS_M : Float := 150

/-- Longest gap (s) the bridge will consider. ~10 minutes covers a toilet break,
a short queue, or signal loss while still sitting; longer needs stronger
evidence than HR + steps can give. -/
def MAX_GAP_SEC : Int := 10 * 60

/-- Mean HR (bpm) at or below which the rider is at rest. -/
def RESTING_HR_MAX : Float := 90

/-- Fewest HR samples across the gap worth acting on — below this a low mean
might be a one-sample artefact. -/
def MIN_HR_SAMPLES_IN_GAP : Nat := 3

/-- Mean HR above which stays are never merged. Catches exercise at a fixed
place. 130 bpm is a moderate jog; sedentary activity sits well below. -/
def MAX_MERGE_HR_MEAN : Float := 130

/-! ## Helpers -/

/-- See the module header: deliberately NOT `FloatScore.haversineMeters`. -/
private def haversineMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let R := 6371000.0
  let pi := 3.141592653589793
  let dLat := (lat2 - lat1) * pi / 180.0
  let dLon := (lon2 - lon1) * pi / 180.0
  let sLat := Float.sin (dLat / 2.0)
  let sLon := Float.sin (dLon / 2.0)
  let a := sLat * sLat + Float.cos (lat1 * pi / 180.0) * Float.cos (lat2 * pi / 180.0) * (sLon * sLon)
  R * 2.0 * Float.atan2 (Float.sqrt a) (Float.sqrt (1.0 - a))

/-- Mean of an array, or `none` when empty. -/
private def meanOf (xs : Array Float) : Option Float :=
  if xs.isEmpty then none else some (xs.foldl (· + ·) 0 / Float.ofNat xs.size)

/-- Does biometric evidence over `(gapStart, gapEnd)` support the rider being at
rest? STRICTLY inside — a sample on a boundary timestamp belongs to the
bracketing stay, not to the gap. -/
private def gapLooksStationary (gapStart gapEnd : Int) (hr : Array HrPoint)
    (steps : Array StepPoint) : Bool :=
  let hrInGap := hr.filter fun p => p.ts > gapStart && p.ts < gapEnd
  if hrInGap.size < MIN_HR_SAMPLES_IN_GAP then false
  else
    let hrMean := (hrInGap.map (·.bpm)).foldl (· + ·) 0 / Float.ofNat hrInGap.size
    if hrMean > RESTING_HR_MAX then false
    else
      let stepsInGap := steps.filter fun p => p.ts > gapStart && p.ts < gapEnd
      (stepsInGap.map (·.steps)).foldl (· + ·) 0 == 0

/-- Mean HR over `[startTs, endTs]`, INCLUSIVE both ends (`samplesInWindow`'s
convention), or `none` when there are no samples. -/
private def meanHrInWindow (startTs endTs : Int) (hr : Array HrPoint) : Option Float :=
  meanOf ((hr.filter fun p => p.ts >= startTs && p.ts <= endTs).map (·.bpm))

/-! ## The pass -/

/-- Should the run starting at `i` (currently ending at `extended`) absorb the
stay at `j`? Factored out so the two arms read as the two cases they are. -/
private def absorbs (extended next : TrackSegment) (cI cJ : Option (Float × Float))
    (hr : Array HrPoint) (steps : Array StepPoint) : Bool :=
  match cI, cJ with
  | some (laI, loI), some (laJ, loJ) =>
    if haversineMeters laI loI laJ loJ > COLOCATION_RADIUS_M then false
    else
      let gapSec := next.startTs - extended.endTs
      if gapSec > MAX_GAP_SEC then false
      else if gapSec > 0 then gapLooksStationary extended.endTs next.startTs hr steps
      else
        match meanHrInWindow extended.startTs next.endTs hr with
        | some m => !(m > MAX_MERGE_HR_MEAN)
        | none => true
  | _, _ => false

/--
Merge consecutive stationary stays at the same place; pass everything else
through unchanged. Returns a new array — the input is not mutated.

The inner walk is fuelled by the remaining segment count. The TS `while` is
bounded by the same quantity (`j` only ever increases, and the loop stops at
`segments.length`), so the fuel is never the binding constraint.
-/
def bridgeStaysWithBiometrics (segments : Array TrackSegment)
    (centroids : Array (Option (Float × Float))) (hr : Array HrPoint)
    (steps : Array StepPoint) : Array TrackSegment :=
  let rec extend (i : Nat) (extended : TrackSegment) (j : Nat) :
      Nat → TrackSegment × Nat
    | 0 => (extended, j)
    | fuel + 1 =>
      if h : j < segments.size then
        let next := segments[j]
        if next.mode != "stationary" then (extended, j)
        else if absorbs extended next (centroids[i]!) (centroids[j]!) hr steps then
          extend i { extended with endTs := next.endTs,
                                   pointCount := extended.pointCount + next.pointCount } (j + 1) fuel
        else (extended, j)
      else (extended, j)
  let rec go (i : Nat) (acc : Array TrackSegment) : Nat → Array TrackSegment
    | 0 => acc
    | fuel + 1 =>
      if h : i < segments.size then
        let cur := segments[i]
        if cur.mode != "stationary" then go (i + 1) (acc.push cur) fuel
        else
          let (extended, j) := extend i cur (i + 1) segments.size
          -- The TS `i = j > i + 1 ? j : i + 1` — identical, since `extend`
          -- returns `j = i + 1` exactly when nothing was absorbed.
          go (if j > i + 1 then j else i + 1) (acc.push extended) fuel
      else acc
  go 0 #[] segments.size

/-! ## Guards -/

private def stay (startTs endTs : Int) (pointCount : Nat := 10) : TrackSegment :=
  { startTs := startTs, endTs := endTs, mode := "stationary", confidence := 0.9,
    confidenceMargin := 2, avgSpeed := 0.2, maxSpeed := 1, linearity := 0.1,
    pointCount := pointCount }

private def walking (startTs endTs : Int) : TrackSegment :=
  { stay startTs endTs 5 with mode := "walking", avgSpeed := 4.5, maxSpeed := 6 }

/-- Pizza Union: two stays either side of a 5-minute no-fix gap, same table. -/
private def pizza : Array TrackSegment := #[stay 0 1200 40, stay 1500 3000 50]
private def sameSpot : Array (Option (Float × Float)) :=
  #[some (51.5200, -0.0800), some (51.5200, -0.0800)]

/-- Resting HR through the gap, no steps: the merge case. -/
private def restingHr : Array HrPoint :=
  #[⟨1250, 68⟩, ⟨1300, 66⟩, ⟨1350, 70⟩, ⟨1400, 67⟩]
private def noSteps : Array StepPoint := #[⟨1260, 0⟩, ⟨1320, 0⟩]

#guard (bridgeStaysWithBiometrics pizza sameSpot restingHr noSteps).size == 1
#guard (bridgeStaysWithBiometrics pizza sameSpot restingHr noSteps)[0]!.endTs == 3000
-- pointCount accumulates across the merge; every other field is the FIRST stay's.
#guard (bridgeStaysWithBiometrics pizza sameSpot restingHr noSteps)[0]!.pointCount == 90
#guard (bridgeStaysWithBiometrics pizza sameSpot restingHr noSteps)[0]!.startTs == 0

-- ANY step in the gap refuses the merge, however low the HR.
#guard (bridgeStaysWithBiometrics pizza sameSpot restingHr #[⟨1260, 0⟩, ⟨1320, 12⟩]).size == 2
-- Too few samples to believe: 2 < MIN_HR_SAMPLES_IN_GAP.
#guard (bridgeStaysWithBiometrics pizza sameSpot #[⟨1250, 68⟩, ⟨1300, 66⟩] noSteps).size == 2
-- No HR at all over the gap is NOT evidence of rest.
#guard (bridgeStaysWithBiometrics pizza sameSpot #[] noSteps).size == 2
-- Elevated mean: the rider was doing something.
#guard (bridgeStaysWithBiometrics pizza sameSpot
  #[⟨1250, 95⟩, ⟨1300, 96⟩, ⟨1350, 94⟩] noSteps).size == 2
-- Samples ON the boundaries do not count — strictly inside only, so these three
-- leave just one interior sample and the merge is refused.
#guard (bridgeStaysWithBiometrics pizza sameSpot
  #[⟨1200, 60⟩, ⟨1300, 60⟩, ⟨1500, 60⟩] noSteps).size == 2

-- 280 m apart is not the same place, whatever the biometrics say.
#guard (bridgeStaysWithBiometrics pizza
  #[some (51.5200, -0.0800), some (51.5225, -0.0800)] restingHr noSteps).size == 2
-- A missing centroid cannot be compared, so it cannot merge.
#guard (bridgeStaysWithBiometrics pizza #[some (51.52, -0.08), none] restingHr noSteps).size == 2
-- Beyond MAX_GAP_SEC even perfect evidence is not enough.
#guard (bridgeStaysWithBiometrics #[stay 0 1200, stay 2000 3000] sameSpot
  #[⟨1300, 60⟩, ⟨1400, 60⟩, ⟨1500, 60⟩] noSteps).size == 2

/-! ### The back-to-back arm — no gap, so only the combined-window HR test -/

private def backToBack : Array TrackSegment := #[stay 0 1200 40, stay 1200 2400 50]

#guard (bridgeStaysWithBiometrics backToBack sameSpot #[] #[]).size == 1
-- No HR at all still merges here: `combinedMean === null` does NOT break, which
-- is the OPPOSITE of the gap arm's treatment of missing HR.
#guard (bridgeStaysWithBiometrics backToBack sameSpot #[] #[])[0]!.endTs == 2400
-- Exercise at a fixed place: stable centroid, 140 bpm — left as two stays.
#guard (bridgeStaysWithBiometrics backToBack sameSpot
  #[⟨600, 140⟩, ⟨1800, 140⟩] #[]).size == 2
-- Sedentary across the whole span merges.
#guard (bridgeStaysWithBiometrics backToBack sameSpot #[⟨600, 70⟩, ⟨1800, 72⟩] #[]).size == 1

/-! ### Pass-through and run structure -/

-- A non-stationary segment is emitted untouched and breaks any run.
#guard (bridgeStaysWithBiometrics #[stay 0 1200 40, walking 1200 1500, stay 1500 3000 50]
  #[some (51.52, -0.08), some (51.52, -0.08), some (51.52, -0.08)] restingHr noSteps).size == 3
#guard (bridgeStaysWithBiometrics #[] #[] #[] #[]).size == 0
#guard (bridgeStaysWithBiometrics #[walking 0 600] #[none] #[] #[]).size == 1

-- THE DRIFT GUARD. Three back-to-back stays, each ~110 m from the last but the
-- third ~220 m from the FIRST. Co-location is measured from the run's first
-- stay, so the third does NOT join — a slow drift down a street stays separate.
#guard (bridgeStaysWithBiometrics #[stay 0 600 10, stay 600 1200 10, stay 1200 1800 10]
  #[some (51.5200, -0.0800), some (51.5210, -0.0800), some (51.5220, -0.0800)] #[] #[]).size == 2

end Verified.Geo.BridgeStays
