import Verified.Geo.SegmentMerge
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

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- What this module computes and the segment record carries.

Declared in `Verified.Geo.SegmentMerge` rather than here, because `Seg` has a
field of this type and the segment record cannot import the module that fills
it in without a cycle. Named here so the pass reads as its own. -/
abbrev BiometricEnrichment := Verified.Geo.SegmentMerge.BiometricEnrichment

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

/-- How long a step row covers. A row's `ts` is the START of its minute, so the
    steps it carries were taken across `[ts, ts + STEP_MINUTE_S)`. -/
def STEP_MINUTE_S : Int := 60

/-- Does a step row's whole minute lie inside the window?

⚠ **CONTAINMENT, NOT MEMBERSHIP OF THE START INSTANT**, and the difference is a
real defect (#185). A segment ending at 18:54:12 shares twelve seconds with the
minute beginning 18:54; testing `sp.ts ≤ seg.endTs` charges it that whole
minute's steps. On 2026-06-24 that is what destroyed a five-minute shop stay:
the 82 steps belonged to the walk to the NEXT shop, they cleared
`STATIONARY_WALK_PEAK_CADENCE`, and `applyStationaryWalkThrough` relabelled the
stay as walking on the strength of a minute it barely touched.

Symmetric at the near end on purpose — a partial first minute is somebody
else's minute for the same reason a partial last one is. -/
def stepMinuteInside (sp : StepPoint) (seg : Seg) : Bool :=
  decide (sp.ts ≥ seg.startTs) && decide (sp.ts + STEP_MINUTE_S ≤ seg.endTs)

/-- Highest single per-minute step count inside the window. Unlike the mean,
    the peak survives a window that is slow overall but contains one
    unmistakable walking minute.

    ⚠ Counts only minutes the window WHOLLY contains — see `stepMinuteInside`. -/
def peakCadenceForSegment (seg : Seg) (stepPoints : List StepPoint) : Float :=
  stepPoints.foldl (fun peak sp =>
    if stepMinuteInside sp seg && decide (sp.steps > peak)
    then sp.steps else peak) 0

/-! ## Parity with Node/V8 (`lean/experiments/biometrics-window-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def approxO : Option Float → Option Float → Bool
  | none, none => true
  | some a, some b => approx a b
  | _, _ => false

private def T0 : Int := 1778457600
private def sg (startTs endTs : Int) (mode : String := "stationary") (pointCount : Int := 10) : Seg :=
  { startTs, endTs, mode, pointCount }
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

end Verified.Geo.BiometricWindows
