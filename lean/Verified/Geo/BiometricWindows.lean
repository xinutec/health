import Verified.Hsmm.FloatScore
/-!
# Biometric window aggregations + the stay bridge

Ports the per-segment biometric reductions from `src/geo/biometrics.ts`
(`enrichSegmentWithBiometrics`, `stepsInWindow`, `cadenceForSegment`,
`peakCadenceForSegment`) and the decision core of
`src/geo/bridge-stays-biometrics.ts`.

Two conventions here are load-bearing and easy to get wrong, so both are
pinned by `#guard`s:

* **"No Fitbit data" is not "zero steps."** `stepsTotal` / `stepsInWindow`
  return `none` when the step series carries no rows for the segment's day at
  all, but `0` when rows exist for the day and simply none landed in the
  window. Downstream factors must stay OFF for the former and may treat the
  latter as real evidence.
* **Window boundaries.** Segment windows are INCLUSIVE at both ends, but the
  bridge's gap window is STRICTLY inside — a sample sitting exactly on a gap
  boundary belongs to the bracketing stay, not the gap.

`bridgeStaysWithBiometrics` in the TS both decides the merges and rebuilds the
segment records. Only the decision is ported: {@link bridgeStayRuns} returns
the merge PLAN as `[start, end)` index ranges over the input, and the shell
applies it (a merged segment is the first segment's fields with the last's
`endTs` and the summed `pointCount` — fully reconstructible from the range).
Same split as everywhere else in this port: decisions in Lean, record
sequencing in the shell.

Exactness: everything is arithmetic, comparison and counting ⇒ EXACT, except
`haversineMeters` (atan2) behind the co-location test, which is ≤1 ULP but
only ever compared against a 150 m threshold. UNPROVEN; pinned against Node/V8
(`lean/experiments/biometrics-window-refs.mts`).
-/

namespace Verified.Geo.BiometricWindows

open Verified.Hsmm.FloatScore (haversineMeters)

structure HrPoint where
  ts : Int
  bpm : Float
  deriving Inhabited, BEq

/-- One row from `steps_intraday`. The DB stores only non-zero minutes — a
    missing minute is implicit zero. -/
structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited, BEq

structure SleepStage where
  startTs : Int
  endTs : Int
  deriving Inhabited, BEq

/-- The minimum segment shape these reductions read. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : String := "stationary"
  pointCount : Nat := 0
  deriving Inhabited, BEq

structure BiometricEnrichment where
  hrMean : Option Float
  hrMin : Option Float
  hrMax : Option Float
  hrStd : Option Float
  /-- HR samples that fell inside the segment window. -/
  sampleCount : Nat
  overlapsSleep : Bool
  /-- Fraction of segment duration covered by sleep records (0–1). -/
  sleepFraction : Float
  /-- Total steps inside the segment; `none` when no step rows touched the
      window's DAY — distinct from zero steps actively recorded. -/
  stepsTotal : Option Float
  deriving Inhabited, BEq

/-- `Math.round(x * 10) / 10`. -/
private def round1 (x : Float) : Float := Float.floor (x * 10 + 0.5) / 10

/-- Whether the step series carries any row for this window's day at all. The
    TS tests `|sp.ts − startTs| < 86400`, i.e. within a day either side. -/
private def hasDayCoverage (stepPoints : List StepPoint) (startTs : Int) : Bool :=
  stepPoints.any (fun sp => decide ((sp.ts - startTs).natAbs < 86400))

/-- Per-segment HR stats, sleep overlap and step total. -/
def enrichSegmentWithBiometrics (seg : Seg) (hrPoints : List HrPoint) (sleepStages : List SleepStage)
    (stepPoints : List StepPoint := []) : BiometricEnrichment := Id.run do
  let segDuration := seg.endTs - seg.startTs
  let inWindow := (hrPoints.filter (fun p =>
    decide (p.ts ≥ seg.startTs) && decide (p.ts ≤ seg.endTs))).map (·.bpm)
  let mut hrMean : Option Float := none
  let mut hrMin : Option Float := none
  let mut hrMax : Option Float := none
  let mut hrStd : Option Float := none
  if !inWindow.isEmpty then
    let n := Float.ofNat inWindow.length
    let mean := (inWindow.foldl (fun a b => a + b) 0) / n
    let variance := (inWindow.foldl (fun s b => s + (b - mean) ^ 2) 0) / n
    hrMean := some (round1 mean)
    hrMin := some (inWindow.foldl (fun a b => min a b) (inWindow.headD 0))
    hrMax := some (inWindow.foldl (fun a b => max a b) (inWindow.headD 0))
    hrStd := some (round1 (Float.sqrt variance))
  -- Sleep overlap: sum of intersections, normalised by segment duration.
  let mut overlapsSleep := false
  let mut sleepFraction : Float := 0
  if segDuration > 0 then
    let overlapSec := sleepStages.foldl (fun acc st =>
      let s := max seg.startTs st.startTs
      let e := min seg.endTs st.endTs
      if e > s then acc + (e - s) else acc) 0
    if overlapSec > 0 then
      overlapsSleep := true
      sleepFraction := min 1 (Float.ofInt overlapSec / Float.ofInt segDuration)
  -- Steps: each row is one minute starting at `ts`.
  let mut stepsTotal : Option Float := none
  if !stepPoints.isEmpty then
    let inWin := stepPoints.filter (fun sp =>
      decide (sp.ts ≥ seg.startTs) && decide (sp.ts ≤ seg.endTs))
    -- Presence of rows for the day implies the Fitbit was on, so an empty
    -- window means zero steps rather than no data.
    if !inWin.isEmpty || hasDayCoverage stepPoints seg.startTs then
      stepsTotal := some (inWin.foldl (fun a sp => a + sp.steps) 0)
  return ⟨hrMean, hrMin, hrMax, hrStd, inWindow.length, overlapsSleep, sleepFraction, stepsTotal⟩

/-- Total steps whose per-minute rows fall inside `[startTs, endTs]`, or
    `none` when the series carries no rows for that day at all. -/
def stepsInWindow (stepPoints : List StepPoint) (startTs endTs : Int) : Option Float :=
  if stepPoints.isEmpty then none
  else
    let inWin := stepPoints.filter (fun sp => decide (sp.ts ≥ startTs) && decide (sp.ts ≤ endTs))
    if !inWin.isEmpty || hasDayCoverage stepPoints startTs then
      some (inWin.foldl (fun a sp => a + sp.steps) 0)
    else none

/-- Steps per minute over a segment's window; zero under 30 s (the
    denominator is too small to mean anything). -/
def cadenceForSegment (seg : Seg) (stepPoints : List StepPoint) : Float :=
  let durationSec := seg.endTs - seg.startTs
  if durationSec < 30 then 0
  else
    let total := (stepPoints.filter (fun sp =>
      decide (sp.ts ≥ seg.startTs) && decide (sp.ts ≤ seg.endTs))).foldl (fun a sp => a + sp.steps) 0
    (total / Float.ofInt durationSec) * 60

/-- Highest single per-minute step count inside the window. Unlike the mean,
    the peak survives a window that is slow overall but contains one
    unmistakable walking minute. -/
def peakCadenceForSegment (seg : Seg) (stepPoints : List StepPoint) : Float :=
  stepPoints.foldl (fun peak sp =>
    if decide (sp.ts ≥ seg.startTs) && decide (sp.ts ≤ seg.endTs) && decide (sp.steps > peak)
    then sp.steps else peak) 0

/-! ## The stay bridge -/

/-- Two stays whose centroids are within this count as "the same place".
    Matches `CLUSTER_RADIUS_M` in `findStays` so the bridge can heal a stay
    that fragmented during a brief gap. -/
def COLOCATION_RADIUS_M : Float := 150
/-- Longest gap the bridge will consider: a toilet break, a short queue, or
    signal loss while still sitting. Longer needs stronger evidence than HR
    and steps alone can provide. -/
def MAX_GAP_SEC : Int := 10 * 60
/-- Mean HR at or below which the user is at rest. -/
def RESTING_HR_MAX : Float := 90
/-- Below this many HR samples across the gap, a low mean might be a
    one-sample artifact, so the pair is left unmerged. -/
def MIN_HR_SAMPLES_IN_GAP : Nat := 3
/-- Mean HR above which stays are never merged — catches exercise at a fixed
    place (gym, home workout) where the centroid is stable but the user was
    actively moving. -/
def MAX_MERGE_HR_MEAN : Float := 130

/-- Does biometric evidence over the gap support the user being at rest?
    Samples are taken STRICTLY inside: one on a boundary timestamp belongs to
    a bracketing stay, not to the gap. -/
def gapLooksStationary (gapStart gapEnd : Int) (hr : List HrPoint) (steps : List StepPoint) : Bool :=
  let hrInGap := hr.filter (fun p => decide (p.ts > gapStart) && decide (p.ts < gapEnd))
  if hrInGap.length < MIN_HR_SAMPLES_IN_GAP then false
  else
    let hrMean := (hrInGap.foldl (fun s p => s + p.bpm) 0) / Float.ofNat hrInGap.length
    if decide (hrMean > RESTING_HR_MAX) then false
    else
      let stepSum := (steps.filter (fun p =>
        decide (p.ts > gapStart) && decide (p.ts < gapEnd))).foldl (fun s p => s + p.steps) 0
      stepSum == 0

/-- Mean HR inside `[startTs, endTs]` (inclusive), or `none` with no samples. -/
def meanHrInWindow (startTs endTs : Int) (hr : List HrPoint) : Option Float :=
  let inWin := hr.filter (fun p => decide (p.ts ≥ startTs) && decide (p.ts ≤ endTs))
  if inWin.isEmpty then none
  else some ((inWin.foldl (fun s p => s + p.bpm) 0) / Float.ofNat inWin.length)

/--
The merge PLAN for consecutive stationary stays at the same place, as
`[start, end)` index ranges over `segments`. Non-stationary segments and
unmergeable stays yield singleton ranges, so concatenating the ranges always
reproduces the input exactly once.

Two shapes are handled:

1. **Gap-bridging** — the toilet-break case. Two stays with a no-GPS gap
   between them merge only when HR and steps confirm the user stayed put.
2. **Co-location merge** — consecutive stays with no gap (e.g. the middle
   minutes were reclassified from walking to stationary by a biometric pass).
   Merge unless the combined window shows exercise-grade HR.

`centroids` is a parallel array; a `none` entry blocks merging at that index.
-/
def bridgeStayRuns (segments : List Seg) (centroids : List (Option (Float × Float)))
    (hr : List HrPoint) (steps : List StepPoint) : List (Nat × Nat) := Id.run do
  let segs := segments.toArray
  let cents := centroids.toArray
  let mut runs : Array (Nat × Nat) := #[]
  let mut i := 0
  while i < segs.size do
    let cur := segs[i]!
    if cur.mode != "stationary" then
      runs := runs.push (i, i + 1)
      i := i + 1
      continue
    -- Walk forward over the maximal co-located stationary run starting at i.
    let mut j := i + 1
    let mut extendedEnd := cur.endTs
    while j < segs.size && segs[j]!.mode == "stationary" do
      let next := segs[j]!
      match cents[i]!, cents[j]! with
      | some (aLat, aLon), some (bLat, bLon) =>
        if decide (haversineMeters aLat aLon bLat bLon > COLOCATION_RADIUS_M) then break
        let gapStart := extendedEnd
        let gapEnd := next.startTs
        let gapSec := gapEnd - gapStart
        if gapSec > MAX_GAP_SEC then break
        if gapSec > 0 then
          -- A true signal gap: require positive evidence the user stayed put.
          if !gapLooksStationary gapStart gapEnd hr steps then break
        else
          -- Back-to-back: only the segment-level HR check. Exercise-grade HR
          -- means the user was likely moving even though the geometry agrees.
          match meanHrInWindow cur.startTs next.endTs hr with
          | some m => if decide (m > MAX_MERGE_HR_MEAN) then break
          | none => pure ()
        extendedEnd := next.endTs
        j := j + 1
      | _, _ => break
    let stop := if j > i + 1 then j else i + 1
    runs := runs.push (i, stop)
    i := stop
  return runs.toList

/-! ## Parity with Node/V8 (`lean/experiments/biometrics-window-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def approxO : Option Float → Option Float → Bool
  | none, none => true
  | some a, some b => approx a b
  | _, _ => false

private def T0 : Int := 1778457600
private def sg (startTs endTs : Int) (mode : String := "stationary") (pointCount : Nat := 10) : Seg :=
  ⟨startTs, endTs, mode, pointCount⟩
private def hp (ts : Int) (bpm : Float) : HrPoint := ⟨ts, bpm⟩
private def sp (ts : Int) (steps : Float) : StepPoint := ⟨ts, steps⟩

private def s1 : Seg := sg (T0 + 3600) (T0 + 7200)

/-! ### `enrichSegmentWithBiometrics` -/

#guard match enrichSegmentWithBiometrics s1 [] [] [] with
       | r => r.hrMean == none && r.sampleCount == 0 && r.overlapsSleep == false
              && r.sleepFraction == 0 && r.stepsTotal == none
-- Boundary timestamps are INCLUSIVE, so the 3600 and 7200 samples count and
-- the 3000/9000 ones do not.
#guard match enrichSegmentWithBiometrics s1
         [hp (T0 + 3000) 200, hp (T0 + 3600) 60, hp (T0 + 5000) 72, hp (T0 + 7200) 81, hp (T0 + 9000) 200] [] [] with
       | r => approxO r.hrMean (some 71) && approxO r.hrMin (some 60) && approxO r.hrMax (some 81)
              && approxO r.hrStd (some 8.6) && r.sampleCount == 3
#guard match enrichSegmentWithBiometrics s1 [hp (T0 + 5000) 77] [] [] with
       | r => approxO r.hrMean (some 77) && approxO r.hrStd (some 0) && r.sampleCount == 1
#guard match enrichSegmentWithBiometrics s1 [] [⟨T0 + 5400, T0 + 9000⟩] [] with
       | r => r.overlapsSleep && approx r.sleepFraction 0.5
-- Overlap beyond the segment is clamped to 1.
#guard match enrichSegmentWithBiometrics s1 [] [⟨T0, T0 + 20000⟩] [] with
       | r => r.overlapsSleep && r.sleepFraction == 1
#guard match enrichSegmentWithBiometrics s1 [] [] [sp (T0 + 3600) 30, sp (T0 + 4000) 45, sp (T0 + 9000) 100] with
       | r => approxO r.stepsTotal (some 75)
-- Rows exist for the day but none in the window ⇒ zero, not "no data".
#guard match enrichSegmentWithBiometrics s1 [] [] [sp (T0 + 20000) 50] with
       | r => r.stepsTotal == some 0
-- Rows only from another day ⇒ no data at all.
#guard match enrichSegmentWithBiometrics s1 [] [] [sp (T0 + 500000) 50] with
       | r => r.stepsTotal == none
-- A zero-length segment can still carry HR, but no sleep fraction.
#guard match enrichSegmentWithBiometrics (sg T0 T0) [hp T0 65] [⟨T0 - 10, T0 + 10⟩] [] with
       | r => approxO r.hrMean (some 65) && r.sampleCount == 1
              && r.overlapsSleep == false && r.sleepFraction == 0

/-! ### `stepsInWindow` -/

#guard (stepsInWindow [] T0 (T0 + 3600)).isNone
#guard stepsInWindow [sp (T0 + 60) 20, sp (T0 + 120) 30] T0 (T0 + 3600) == some 50
#guard stepsInWindow [sp T0 20, sp (T0 + 3600) 30] T0 (T0 + 3600) == some 50
#guard stepsInWindow [sp (T0 + 40000) 20] T0 (T0 + 3600) == some 0
#guard (stepsInWindow [sp (T0 + 200000) 20] T0 (T0 + 3600)).isNone
-- The day-coverage test is strict: exactly 86400 away is a different day.
#guard (stepsInWindow [sp (T0 + 86400) 20] T0 (T0 + 3600)).isNone
#guard stepsInWindow [sp (T0 + 86399) 20] T0 (T0 + 3600) == some 0

/-! ### Cadence -/

private def steps1 : List StepPoint :=
  [sp (T0 + 3600) 30, sp (T0 + 3660) 90, sp (T0 + 3720) 60, sp (T0 + 20000) 500]

#guard approx (cadenceForSegment (sg (T0 + 3600) (T0 + 7200)) steps1) 3
#guard approx (cadenceForSegment (sg (T0 + 3600) (T0 + 3780)) steps1) 60
-- Under 30 s the denominator is meaningless, so the answer is 0.
#guard cadenceForSegment (sg (T0 + 3600) (T0 + 3629)) steps1 == 0
#guard approx (cadenceForSegment (sg (T0 + 3600) (T0 + 3630)) steps1) 60
#guard cadenceForSegment (sg (T0 + 50000) (T0 + 53600)) steps1 == 0
#guard peakCadenceForSegment (sg (T0 + 3600) (T0 + 7200)) steps1 == 90
#guard peakCadenceForSegment (sg (T0 + 50000) (T0 + 53600)) steps1 == 0

/-! ### `gapLooksStationary` / `meanHrInWindow` -/

#guard gapLooksStationary (T0 + 3600) (T0 + 3900)
       [hp (T0 + 3700) 62, hp (T0 + 3750) 63, hp (T0 + 3800) 64] [sp (T0 + 3700) 0] == true
-- A sample exactly on the closing boundary does not count, leaving only two.
#guard gapLooksStationary (T0 + 3600) (T0 + 3900)
       [hp (T0 + 3700) 62, hp (T0 + 3800) 64, hp (T0 + 3900) 61] [] == false
#guard gapLooksStationary (T0 + 3600) (T0 + 3900)
       [hp (T0 + 3700) 120, hp (T0 + 3750) 130, hp (T0 + 3800) 125] [] == false
#guard gapLooksStationary (T0 + 3600) (T0 + 3900)
       [hp (T0 + 3700) 62, hp (T0 + 3750) 63, hp (T0 + 3800) 64] [sp (T0 + 3700) 40] == false
#guard (meanHrInWindow T0 (T0 + 100) []).isNone
#guard approxO (meanHrInWindow T0 (T0 + 100) [hp T0 60, hp (T0 + 100) 80]) (some 70)

/-! ### `bridgeStayRuns` -/

private def HOME : Option (Float × Float) := some (51.5205, -0.1275)
/-- ~13 m from HOME. -/
private def NEAR : Option (Float × Float) := some (51.5206, -0.1276)
/-- ~1.7 km from HOME. -/
private def FAR : Option (Float × Float) := some (51.53, -0.14)

private def quietHr : List HrPoint := [hp (T0 + 3700) 62, hp (T0 + 3750) 63, hp (T0 + 3800) 64]
private def zeroSteps : List StepPoint := [sp (T0 + 3700) 0, sp (T0 + 3800) 0]
private def gapPair : List Seg := [sg T0 (T0 + 3600), sg (T0 + 3900) (T0 + 7200)]

-- Quiet HR and no steps across a 5-minute gap: the stays are one stay.
#guard bridgeStayRuns gapPair [HOME, NEAR] quietHr zeroSteps == [(0, 2)]
-- Each of the five refusal paths, independently.
#guard bridgeStayRuns gapPair [HOME, NEAR]
       [hp (T0 + 3700) 62, hp (T0 + 3800) 64, hp (T0 + 3900) 61] zeroSteps == [(0, 1), (1, 2)]
#guard bridgeStayRuns gapPair [HOME, NEAR]
       [hp (T0 + 3700) 120, hp (T0 + 3750) 130, hp (T0 + 3800) 125] zeroSteps == [(0, 1), (1, 2)]
#guard bridgeStayRuns gapPair [HOME, NEAR] quietHr [sp (T0 + 3700) 40] == [(0, 1), (1, 2)]
#guard bridgeStayRuns gapPair [HOME, FAR] quietHr zeroSteps == [(0, 1), (1, 2)]
#guard bridgeStayRuns gapPair [HOME, none] quietHr zeroSteps == [(0, 1), (1, 2)]
-- A gap longer than MAX_GAP_SEC is never bridged on biometrics alone.
#guard bridgeStayRuns [sg T0 (T0 + 3600), sg (T0 + 4400) (T0 + 7200)] [HOME, NEAR] quietHr zeroSteps
       == [(0, 1), (1, 2)]
-- Back-to-back co-located stays merge on the segment-level HR check alone...
#guard bridgeStayRuns [sg T0 (T0 + 3600), sg (T0 + 3600) (T0 + 7200)] [HOME, NEAR] [] [] == [(0, 2)]
-- ...unless the combined window shows exercise-grade HR.
#guard bridgeStayRuns [sg T0 (T0 + 3600), sg (T0 + 3600) (T0 + 7200)] [HOME, NEAR]
       [hp (T0 + 100) 150, hp (T0 + 200) 160] [] == [(0, 1), (1, 2)]
-- Non-stationary segments pass through and break the run.
#guard bridgeStayRuns [sg T0 (T0 + 3600), sg (T0 + 3600) (T0 + 5400) "walking",
                       sg (T0 + 5400) (T0 + 7200)] [HOME, NEAR, NEAR] [] []
       == [(0, 1), (1, 2), (2, 3)]
-- A three-way run collapses to a single range.
#guard bridgeStayRuns [sg T0 (T0 + 1800), sg (T0 + 1800) (T0 + 3600), sg (T0 + 3600) (T0 + 5400)]
       [HOME, NEAR, NEAR] [] [] == [(0, 3)]
#guard bridgeStayRuns [sg T0 (T0 + 3600)] [HOME] [] [] == [(0, 1)]
#guard bridgeStayRuns [] [] [] [] == []

end Verified.Geo.BiometricWindows
