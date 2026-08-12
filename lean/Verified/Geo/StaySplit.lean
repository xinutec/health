import Verified.Geo.SegmentMerge
import Verified.Geo.Worldline
/-!
# Stay-split evidence scorer (port of the pure leaf of `src/geo/stay-split.ts`)

`stay-split.ts` is a suite of `<T extends TrackSegment>` array transforms that
split/reassign segments over an in-stay gap — record orchestration that stays
shell — a note that is now SUPERSEDED: under the standing Lean/shell boundary
(pure record/array work belongs in Lean) those passes are in scope, and they sit
in the middle of the velocity pass order, so the pipeline cannot fold in Lean
without them. `shedVehiclePedestrianEdges` is the first of them, below.

Its original pure decision leaf is `scoreSplitEvidence`: the weighted
log-evidence (nats) that the user *left* during a gap, summed across step
density (the only direct movement signal), gap-anomaly ratio, HR, and
post-gap proximity. `> SPLIT_THRESHOLD_NATS` triggers a split.

All discrete branches + arithmetic, no transcendentals ⇒ EXACT (guarded at
≤1 ULP only because decimal literals like `5.3` are not the same double as the
summed `4.5 + 0.8`; the op sequence is replicated verbatim). UNPROVEN; pinned
by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.StaySplit

def SPLIT_THRESHOLD_NATS : Float := 2.5
def GAP_ANOMALY_MIN_PRE_FIXES : Int := 5

/-- The gap signals the split scorer weighs. -/
structure GapEvidence where
  gapDurationS : Float
  medianPriorGapS : Float
  preGapFixCount : Int
  stepsInGap : Float
  hrMeanInGap : Option Float
  hrSamplesInGap : Int
  postGapDistFromCentroidM : Float
  deriving Inhabited

/-- Weighted log-evidence (nats) that the user left during the gap. Positive →
    departure; negative → continued stay. -/
def scoreSplitEvidence (ev : GapEvidence) : Float := Id.run do
  let gapMin := ev.gapDurationS / 60
  if decide (gapMin ≤ 0) then return 0
  let stepsPerMin := ev.stepsInGap / gapMin
  -- Primary signal: biometric step density (the only direct movement evidence).
  let mut score : Float :=
    if decide (stepsPerMin > 20) then 3.5
    else if decide (stepsPerMin > 8) then 2.0
    else if decide (stepsPerMin > 3) then 0.5
    else if decide (stepsPerMin > 1) then -0.5
    else -2.0
  -- Supporting: gap-anomaly ratio, only amplifying a positive step signal.
  if decide (ev.preGapFixCount ≥ GAP_ANOMALY_MIN_PRE_FIXES) && decide (ev.medianPriorGapS > 0)
      && decide (score > 0) then
    let ratio := ev.gapDurationS / ev.medianPriorGapS
    if decide (ratio > 50) then score := score + 1.0
    else if decide (ratio > 10) then score := score + 0.5
  -- Supporting: HR elevation during the gap.
  match ev.hrMeanInGap with
  | some hr =>
    if decide (ev.hrSamplesInGap ≥ 3) then
      if decide (hr > 110) then score := score + 0.8
      else if decide (hr > 95) then score := score + 0.3
      else if decide (hr < 75) then score := score - 0.5
  | none => pure ()
  -- Counter-evidence: post-gap fix landed back on the cluster.
  if decide (ev.postGapDistFromCentroidM < 20) then score := score - 0.5
  return score

/-! ## Parity with Node/V8 (`lean/experiments/staysplit-refs.mts`) -/

private def approxS (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def ev (gap med : Float) (pre : Int) (steps : Float) (hr : Option Float) (hrS : Int) (post : Float) : GapEvidence :=
  ⟨gap, med, pre, steps, hr, hrS, post⟩

#guard approxS (scoreSplitEvidence (ev 1800 30 10 900 (some 120) 5 500)) 5.3       -- walkStrong
#guard approxS (scoreSplitEvidence (ev 3600 30 10 0 (some 60) 5 5)) (-3)           -- sittingSilent
#guard approxS (scoreSplitEvidence (ev 1200 60 10 80 (some 100) 5 300)) 1.3        -- ambiguousMid
#guard approxS (scoreSplitEvidence (ev 1800 30 10 45 none 0 300)) (-0.5)           -- fidget
#guard approxS (scoreSplitEvidence (ev 1800 30 10 300 (some 96) 4 300)) 3.3        -- clearMove
#guard approxS (scoreSplitEvidence (ev 0 30 10 100 (some 120) 5 300)) 0            -- zeroGap
#guard approxS (scoreSplitEvidence (ev 1800 120 10 500 none 0 300)) 2.5            -- mildAnomaly
#guard approxS (scoreSplitEvidence (ev 1800 30 3 500 none 0 300)) 2                -- fewPreFix

end Verified.Geo.StaySplit

/-! ## `shedVehiclePedestrianEdges`

A `train` leg whose edge fixes are really the walk to or from the platform.
Scanning inward from each end, the contiguous run of pedestrian-paced steps is
handed to the neighbouring walk — but only on FOUR independent signals, and only
if a real ride is left behind:

* pace  — every step in the run at ≤ `PEDESTRIAN_STEP_MAX_KMH`;
* time  — the run sustains ≥ `PEDESTRIAN_MIN_RUN_S`;
* space — it travels ≥ `PEDESTRIAN_MIN_RUN_NET_M` NET;
* body  — the wearer steps at ≥ `PEDESTRIAN_MIN_CADENCE_SPM` through it.

Precision over recall: with no step data at all the pass is inert.

TAIL runs before HEAD *within one iteration*, and HEAD re-reads the segment — so
on a leg shed at both ends the head test sees the already-shortened `endTs` and
measures its remaining ride against that. The `bothEndsShed` guard pins it.

UNPROVEN; pinned against Node/V8 (`lean/experiments/shed-edges-refs.mts`).
-/

namespace Shed

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint meanCadenceSpm PEDESTRIAN_STEP_MAX_KMH
  PEDESTRIAN_MIN_RUN_NET_M PEDESTRIAN_MIN_RUN_S PEDESTRIAN_MIN_CADENCE_SPM)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- A Kalman-filtered fix as this pass reads it. -/
structure PointF where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  deriving Inhabited, BEq, Repr

/-- Shedding must leave at least this much ride behind. -/
def MIN_REMAINING_RIDE_S : Int := 120

/-- `refinedMode ?? mode` — the TS `segMode`. -/
def segMode (s : Seg) : String := s.refinedMode.getD s.mode

/-- `Math.round` — halves go UP. Every value rounded here is non-negative. -/
def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-- The TS `median`: ascending sort, mean of the middle pair when even. -/
def median (values : Array Float) : Float :=
  if values.isEmpty then 0 else
  let sorted := (values.toList.mergeSort (· ≤ ·)).toArray
  let mid := sorted.size / 2
  if sorted.size % 2 == 0 then (sorted[mid - 1]! + sorted[mid]!) / 2 else sorted[mid]!

/-- Net-progress pace between consecutive fixes. A non-advancing pair reads as
infinitely fast, so it can never be mistaken for a pedestrian step. -/
private def stepKmh (a b : PointF) : Float :=
  let dt := b.ts - a.ts
  if dt > 0 then haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt * 3.6
  else 1.0 / 0.0

/-- The four-signal evidence bar for handing a run to a walk.

The `netM` bar's STRICTNESS (`<` vs `≤`) is unpinnable and no guard claims it:
separating them needs an input landing exactly on 120 m, and a haversine
distance is only ULP-close between V8 and Lean, so a knife-edge input could sit
on opposite sides in the two. The bar's VALUE is pinned by cases either side.
The `durS` bar has no such problem — it is a difference of integer seconds — and
`durExactlyAtBar` pins it. -/
private def qualifies (steps : List FeasibilityStepPoint) (from_ to : PointF) : Bool :=
  let durS := Float.ofInt (to.ts - from_.ts)
  let netM := haversineMeters from_.lat from_.lon to.lat to.lon
  if durS < PEDESTRIAN_MIN_RUN_S || netM < PEDESTRIAN_MIN_RUN_NET_M then false
  else match meanCadenceSpm steps from_.ts to.ts with
    | none => false
    | some c => c ≥ PEDESTRIAN_MIN_CADENCE_SPM

def sortedIn (points : Array PointF) (startTs endTs : Int) : Array PointF :=
  ((points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs).toList.mergeSort
    fun a b => a.ts ≤ b.ts).toArray

/-- Walk backwards from the last fix while every step is pedestrian-paced.

As with `netM`, the `≤ PEDESTRIAN_STEP_MAX_KMH` comparison's strictness sits on
a float distance and cannot be pinned; the CONSTANT is, by `paceCeiling` (a
probe moving it 9 → 10 fails that guard). -/
private def tailScanStart (fixes : Array PointF) : Nat := Id.run do
  let mut s := fixes.size - 1
  for _ in [0:fixes.size] do
    if s > 0 && stepKmh fixes[s - 1]! fixes[s]! ≤ PEDESTRIAN_STEP_MAX_KMH then s := s - 1
    else break
  return s

/-- Walk forwards from the first fix while every step is pedestrian-paced. -/
private def headScanEnd (fixes : Array PointF) : Nat := Id.run do
  let mut e := 0
  for _ in [0:fixes.size] do
    if e + 1 < fixes.size && stepKmh fixes[e]! fixes[e + 1]! ≤ PEDESTRIAN_STEP_MAX_KMH then e := e + 1
    else break
  return e

/--
Rebuild a walk over a new window from its OWN fixes.

`ridePrecedes` is true for the remainder that begins where a ride ends. The ride
owns its boundary fixes — the fix *at* the boundary is the one the vehicle
arrived on and its speed reading is the vehicle's — so the walk must not take
it. Without this the trailing walk inherits the ride's arrival speed and is
right back to claiming 34 km/h on foot.

Enrichment computed over the parent's window is not evidence about this stretch,
so the labels are cleared and `needsReenrich` set.
-/
def walkRemainder (seg : Seg) (startTs endTs : Int) (points : Array PointF)
    (ridePrecedes : Bool := false) : Seg :=
  let fixes := ((points.filter fun p =>
    (if ridePrecedes then p.ts > startTs else p.ts ≥ startTs) && p.ts < endTs).toList.mergeSort
      fun a b => a.ts ≤ b.ts).toArray
  let base : Seg :=
    { seg with
      startTs := startTs, endTs := endTs, pointCount := Int.ofNat fixes.size
      refinedMode := none, refinedReason := none, wayName := none, place := none
      needsReenrich := true }
  if fixes.size ≥ 2 then
    let speeds := fixes.map (·.speedKmh)
    let pathDist := (Array.range (fixes.size - 1)).foldl (init := (0 : Float)) fun acc k =>
      acc + haversineMeters fixes[k]!.lat fixes[k]!.lon fixes[k + 1]!.lat fixes[k + 1]!.lon
    let straight := haversineMeters fixes[0]!.lat fixes[0]!.lon
      fixes[fixes.size - 1]!.lat fixes[fixes.size - 1]!.lon
    { base with
      avgSpeed := jsRound (median speeds * 10) / 10
      maxSpeed := jsRound (speeds.foldl max speeds[0]! * 10) / 10
      -- The `min … 1` clamp is defensive only: a polyline's straight-line
      -- distance never exceeds its path length, so the ratio is ≤ 1 except for
      -- float noise on a perfectly straight run. Unpinnable; kept for fidelity.
      linearity := if pathDist > 0 then jsRound (min (straight / pathDist) 1 * 100) / 100 else 0 }
  else base

/-- Move a train leg's pedestrian-paced edge runs into the neighbouring walks. -/
def shedVehiclePedestrianEdges (segments : Array Seg) (points : Array PointF)
    (steps : List FeasibilityStepPoint) : Array Seg := Id.run do
  -- PROVABLY a short-circuit, not a decision: with no buckets `meanCadenceSpm`
  -- returns `none`, so `qualifies` refuses every run anyway. No guard can catch
  -- its removal. Kept as the TS has it.
  if steps.isEmpty then return segments
  let mut out := segments
  for i in [0:out.size] do
    if segMode out[i]! != "train" then continue
    -- TAIL → the following walk claims the run.
    if i + 1 < out.size then
      let cur := out[i]!
      let next := out[i + 1]!
      if segMode next == "walking" then
        let fixes := sortedIn points cur.startTs cur.endTs
        if fixes.size > 0 then
          let s := tailScanStart fixes
          -- s > 0: the scan stopped at a vehicle-paced step, so a ride remains.
          -- `s > 0` IS load-bearing (at s = 0 the claimed run is the whole leg,
          -- a real span that can otherwise pass — `scanReachesZeroWithRideLeft`).
          -- `s < size - 1` is PROVABLY dead: at s = size - 1 the run is one fix
          -- to itself, so `durS = 0 < PEDESTRIAN_MIN_RUN_S`. Asymmetric, and the
          -- asymmetry is the point.
          if s > 0 && s < fixes.size - 1 && qualifies steps fixes[s]! fixes[fixes.size - 1]! then
            -- The fix the ride arrived on stays with the ride.
            let boundary := fixes[s]!.ts
            if boundary - cur.startTs ≥ MIN_REMAINING_RIDE_S then
              out := out.set! i { cur with endTs := boundary }
              out := out.set! (i + 1) (walkRemainder next boundary next.endTs points true)
    -- HEAD → the preceding walk claims the run (the boarding-side mirror).
    if i > 0 then
      let prev := out[i - 1]!
      if segMode prev == "walking" then
        let host := out[i]!
        let fixes := sortedIn points host.startTs host.endTs
        if fixes.size > 0 then
          let e := headScanEnd fixes
          -- BOTH bounds are provably dead here, unlike the tail: at e = 0 the
          -- run is `fixes[0]` to itself and at e = size - 1 it is the whole leg
          -- ending at the last fix — the former gives `durS = 0`, and the
          -- latter cannot arise with a vehicle-paced step present.
          if e > 0 && e < fixes.size - 1 && qualifies steps fixes[0]! fixes[e]! then
            -- The fix the ride departs from stays with the ride.
            let boundary := fixes[e]!.ts
            if host.endTs - boundary ≥ MIN_REMAINING_RIDE_S then
              out := out.set! i { host with startTs := boundary }
              out := out.set! (i - 1) (walkRemainder prev prev.startTs boundary points false)
  return out


/-! ### Reference values

Pinned against Node/V8 (`lean/experiments/shed-edges-refs.mts`). Frame: metres
north of `51.52, -0.13`.
-/

section ShedGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320

private def fx (ts : Int) (metresNorth speedKmh : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }
#guard (fx 0 4400 0).lat == 51.559525691699605

private def sg (startTs endTs : Int) (mode : String := "train")
    (refinedMode : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode
    avgSpeed := 40, maxSpeed := 60, linearity := 0.9, pointCount := 5
    wayName := some "A → B · Victoria Line", place := some "Somewhere"
    refinedReason := some "inherited" }

/-- Steps at 80 spm — comfortably over `PEDESTRIAN_MIN_CADENCE_SPM`. -/
private def stepsAt (spm : Float) (from_ to : Int) : List FeasibilityStepPoint :=
  -- Buckets at `from, from+60, …` while STRICTLY below `to` — the TS loop is
  -- `for (t = from; t < to; t += 60)`, so a partial trailing minute still gets a
  -- bucket. Plain `(to-from)/60` truncates it away and drops the cadence below
  -- the bar on an exactly-at-the-bar case.
  (List.range (((to - from_) + 59) / 60).toNat).map fun k =>
    { ts := from_ + 60 * Int.ofNat k, steps := spm }

private def WALK_STEPS : List FeasibilityStepPoint := stepsAt 80 1200 1600

/-- A ride 1000→1200 (two 72 km/h steps), then a pedestrian tail 1200→1600 at
3.6 km/h covering 400 m net. -/
private def TAIL_FIXES : Array PointF :=
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71,
    fx 1300 4100 3.6, fx 1400 4200 3.7, fx 1500 4300 3.5, fx 1600 4400 3.6,
    fx 1700 4500 3.6, fx 1800 4600 3.4, fx 1900 4700 3.8]
private def TAIL_SEGS : Array Seg := #[sg 1000 1600, sg 1600 2000 "walking"]

private structure Row where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  wayName : String
  place : String
  reenrich : Bool
  deriving Inhabited, BEq, Repr

private def vw (segs : Array Seg) : Array Row :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode
      refinedMode := s.refinedMode.getD "", pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, linearity := s.linearity
      wayName := s.wayName.getD "", place := s.place.getD "", reenrich := s.needsReenrich }

private def run (segs : Array Seg := TAIL_SEGS) (pts : Array PointF := TAIL_FIXES)
    (steps : List FeasibilityStepPoint := WALK_STEPS) : Array Row :=
  vw (shedVehiclePedestrianEdges segs pts steps)

/-- The input, untouched. -/
private def PASS : Array Row := vw TAIL_SEGS

-- The tail run is handed to the following walk; the ride keeps its head. The
-- walk is REBUILT from its own fixes: labels cleared, flagged for re-enrichment,
-- kinematics recomputed (median speed 3.6, max 3.8, linearity 1).
#guard run == #[
  { startTs := 1000, endTs := 1200, mode := "train", refinedMode := "", pointCount := 5,
    avgSpeed := 40, maxSpeed := 60, linearity := 0.9,
    wayName := "A → B · Victoria Line", place := "Somewhere", reenrich := false },
  { startTs := 1200, endTs := 2000, mode := "walking", refinedMode := "", pointCount := 7,
    avgSpeed := 3.6, maxSpeed := 3.8, linearity := 1,
    wayName := "", place := "", reenrich := true }]

-- The HEAD mirror: pedestrian 1000→1400, then a ride. The preceding walk grows
-- backwards-compatibly to 1400 and the train starts there.
private def HEAD_FIXES : Array PointF :=
  #[fx 600 (-300) 3.5, fx 800 (-200) 3.6, fx 1000 0 3.6, fx 1100 100 3.6,
    fx 1200 200 3.7, fx 1300 300 3.5, fx 1400 400 3.6,
    fx 1500 2400 72, fx 1600 4400 71, fx 1800 6400 70]
#guard run #[sg 500 1000 "walking", sg 1000 1800] HEAD_FIXES (stepsAt 80 600 1500) == #[
  { startTs := 500, endTs := 1400, mode := "walking", refinedMode := "", pointCount := 6,
    avgSpeed := 3.6, maxSpeed := 3.7, linearity := 1,
    wayName := "", place := "", reenrich := true },
  { startTs := 1400, endTs := 1800, mode := "train", refinedMode := "", pointCount := 5,
    avgSpeed := 40, maxSpeed := 60, linearity := 0.9,
    wayName := "A → B · Victoria Line", place := "Somewhere", reenrich := false }]

-- THE FOUR SIGNALS, one at a time.
-- No step data at all: the pass is inert (precision over recall).
#guard run TAIL_SEGS TAIL_FIXES [] == PASS
-- Cadence below the bar: the body signal fails.
#guard run TAIL_SEGS TAIL_FIXES (stepsAt 30 1200 1600) == PASS
-- Cadence exactly AT the bar still qualifies (`≥`).
#guard (run TAIL_SEGS TAIL_FIXES (stepsAt 60 1200 1600)).size == 2
#guard (run TAIL_SEGS TAIL_FIXES (stepsAt 60 1200 1600))[0]!.endTs == 1200
-- Too SHORT in time (80 s < PEDESTRIAN_MIN_RUN_S).
#guard run #[sg 1000 1280, sg 1280 2000 "walking"]
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71, fx 1280 4200 3.6, fx 1700 4300 3.6]
  == vw #[sg 1000 1280, sg 1280 2000 "walking"]
-- Too little NET ground (110 m < PEDESTRIAN_MIN_RUN_NET_M).
#guard run TAIL_SEGS
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71,
    fx 1300 4030 1, fx 1400 4060 1, fx 1500 4090 1, fx 1600 4110 1] == PASS
-- A step just OVER the pace ceiling (9.36 km/h) stops the scan early, leaving a
-- claimed run too short to qualify. Raising the ceiling to 10 would shed.
#guard run TAIL_SEGS
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71,
    fx 1300 4100 3.6, fx 1400 4200 3.6, fx 1500 4460 9.4, fx 1600 4560 3.6] == PASS

-- STRUCTURAL GATES.
-- Under MIN_REMAINING_RIDE_S of ride would be left: refuse.
#guard run #[sg 1100 1600, sg 1600 2000 "walking"] == vw #[sg 1100 1600, sg 1600 2000 "walking"]
-- Exactly at the bar (1200 − 1080 = 120): allowed.
#guard (run #[sg 1080 1600, sg 1600 2000 "walking"])[0]!.endTs == 1200
-- Every step pedestrian-paced ⇒ the scan reaches 0: no ride to keep, so the
-- pass refuses rather than eating the whole leg.
#guard run TAIL_SEGS #[fx 1000 0 3.6, fx 1200 200 3.6, fx 1400 400 3.6, fx 1600 600 3.6] == PASS
-- No pedestrian tail at all: the scan never moves.
#guard run TAIL_SEGS #[fx 1000 0 70, fx 1200 4000 72, fx 1400 8000 71, fx 1600 12000 70] == PASS
-- The neighbour is not a walk, so there is nobody to hand the run to.
#guard run #[sg 1000 1600, sg 1600 2000 "stationary"] == vw #[sg 1000 1600, sg 1600 2000 "stationary"]
-- A non-train host is skipped entirely.
#guard run #[sg 1000 1600 "driving", sg 1600 2000 "walking"]
  == vw #[sg 1000 1600 "driving", sg 1600 2000 "walking"]
-- `segMode` is `refinedMode ?? mode`, so refinedMode decides on BOTH sides.
#guard (run #[sg 1000 1600 "driving" (some "train"), sg 1600 2000 "walking"])[0]!.endTs == 1200
#guard (run #[sg 1000 1600, sg 1600 2000 "stationary" (some "walking")])[1]!.pointCount == 7

-- BOTH ends shed on one leg, in ONE iteration. TAIL runs first and shortens the
-- leg to 1000–1400; HEAD then re-reads it, so its remaining-ride check is
-- against that 1400, not the original 1800.
#guard run
  #[sg 500 1000 "walking", sg 1000 1800, sg 1800 2200 "walking"]
  #[fx 600 (-300) 3.5, fx 800 (-200) 3.6, fx 1000 0 3.6, fx 1100 100 3.6, fx 1200 200 3.6,
    fx 1300 2200 72, fx 1400 4200 71,
    fx 1500 4300 3.6, fx 1600 4400 3.6, fx 1700 4500 3.6, fx 1800 4600 3.6, fx 1900 4700 3.6]
  (stepsAt 80 600 1900)
  == #[
  { startTs := 500, endTs := 1200, mode := "walking", refinedMode := "", pointCount := 4,
    avgSpeed := 3.6, maxSpeed := 3.6, linearity := 1,
    wayName := "", place := "", reenrich := true },
  { startTs := 1200, endTs := 1400, mode := "train", refinedMode := "", pointCount := 5,
    avgSpeed := 40, maxSpeed := 60, linearity := 0.9,
    wayName := "A → B · Victoria Line", place := "Somewhere", reenrich := false },
  { startTs := 1400, endTs := 2200, mode := "walking", refinedMode := "", pointCount := 5,
    avgSpeed := 3.6, maxSpeed := 3.6, linearity := 1,
    wayName := "", place := "", reenrich := true }]

-- GAPS THE FIRST PROBE PASS EXPOSED.
-- Cadence EXACTLY at the bar: the window is 400 s, so 400 steps over the seven
-- buckets give a mean of exactly 60 and `≥` admits it.
#guard (run TAIL_SEGS TAIL_FIXES
  ([(1200, 57), (1260, 57), (1320, 57), (1380, 57), (1440, 57), (1500, 57), (1560, 58)].map
    fun (t, v) => ({ ts := t, steps := v } : FeasibilityStepPoint)))[0]!.endTs == 1200
-- Steps exist but NONE overlap the run: `meanCadenceSpm` is `none`, which means
-- "no data", not "zero cadence" — and no data refuses.
#guard run TAIL_SEGS TAIL_FIXES (stepsAt 80 100 400) == PASS
-- The run lasts EXACTLY PEDESTRIAN_MIN_RUN_S (1200→1290 = 90 s).
#guard (run #[sg 1000 1290, sg 1290 2000 "walking"]
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71, fx 1290 4130 5.2, fx 1700 4200 3.6]
  (stepsAt 80 1200 1290))[0]!.endTs == 1200
-- Every step pedestrian-paced AND the cadence passes, so the scan reaches
-- s = 0. Only the `s > 0` guard stops the whole leg being eaten.
#guard run TAIL_SEGS
  #[fx 1000 0 3.6, fx 1200 200 3.6, fx 1400 400 3.6, fx 1600 600 3.6]
  (stepsAt 80 1000 1600) == PASS
-- Head side, neighbour is not a walk: nobody to hand the run to.
#guard run #[sg 500 1000 "stationary", sg 1000 1800] HEAD_FIXES (stepsAt 80 600 1500)
  == vw #[sg 500 1000 "stationary", sg 1000 1800]
-- Head side with EXACTLY MIN_REMAINING_RIDE_S left (1520 − 1400 = 120).
#guard (run #[sg 500 1000 "walking", sg 1000 1520] HEAD_FIXES (stepsAt 80 600 1500))[1]!.startTs == 1400
-- The rebuilt walk's avgSpeed is a MEDIAN, not a mean: one 40 km/h outlier
-- among six pedestrian readings must not drag it up (max still records it).
#guard (run TAIL_SEGS
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71, fx 1300 4100 3.6, fx 1400 4200 3.6,
    fx 1500 4300 3.6, fx 1600 4400 3.6, fx 1700 4500 3.6, fx 1800 4600 3.6, fx 1900 4700 40])[1]!
  == { startTs := 1200, endTs := 2000, mode := "walking", refinedMode := "", pointCount := 7,
       avgSpeed := 3.6, maxSpeed := 40, linearity := 1,
       wayName := "", place := "", reenrich := true }
-- The remainder gets exactly ONE fix, so the `≥ 2` guard leaves the parent's
-- kinematics alone rather than recomputing from a single point — but the labels
-- are still cleared and the re-enrich flag still set.
#guard (run #[sg 990 1000 "walking", sg 1000 1800]
  #[fx 950 (-50) 3.6, fx 1000 0 3.6, fx 1200 200 3.6, fx 1300 2200 72, fx 1400 4200 71]
  (stepsAt 80 950 1300))[0]!
  == { startTs := 990, endTs := 1200, mode := "walking", refinedMode := "", pointCount := 1,
       avgSpeed := 40, maxSpeed := 60, linearity := 0.9,
       wayName := "", place := "", reenrich := true }
-- The fix sitting EXACTLY on the host's endTs is load-bearing: without it the
-- run falls under the net-distance bar. Pins the INCLUSIVE window.
#guard (run TAIL_SEGS
  #[fx 1000 0 70, fx 1100 2000 72, fx 1200 4000 71, fx 1300 4050 1.8, fx 1400 4100 1.8,
    fx 1500 4110 0.4, fx 1600 4200 3.2])[0]!.endTs == 1200

-- The `s > 0` guard, ISOLATED. Where every step is pedestrian-paced the scan
-- reaches 0, but that alone cannot pin the guard: the boundary then lands on the
-- leg's own first fix, and MIN_REMAINING_RIDE_S refuses it anyway. Here the
-- first fix sits 150 s into the leg, so dropping `s > 0` WOULD shed — and eat
-- the entire ride.
#guard run TAIL_SEGS
  #[fx 1150 0 4.8, fx 1300 200 4.8, fx 1450 400 4.8, fx 1600 600 4.8]
  (stepsAt 80 1150 1600) == PASS

#guard run #[] #[] [] == #[]

end ShedGuards

end Shed

/-! ## `reassignWalkTailToVehicle`

A walking segment's vehicle-paced TRAILING run belongs to the road vehicle that
follows it. The shared boundary advances to where the sustained motion begins;
the segment COUNT is unchanged, only the boundary and the two segments'
recomputed stats move.

Three things here are easy to get wrong, and each is pinned:

1. `HANDOFF_VEHICLE_MODES` is `driving | bus | cycling` — a FOURTH vehicle-mode
   set in this repo. It INCLUDES bus (unlike `SegmentPasses.VEHICLE_MODES`) and
   EXCLUDES train and plane. Guards cover all five modes.
2. The walk side is tested on the RAW `mode`, the vehicle side on `segMode`
   (`refinedMode ?? mode`). Asymmetric, and observable both ways.
3. `stepKmh` here returns **0** for a non-advancing pair, where the sibling
   `Shed.stepKmh` returns **+∞** for the same shape. Each fails safe in its own
   direction: 0 can never clear a vehicle-pace floor, ∞ can never fall under a
   pedestrian-pace ceiling. The `zeroDtPair` guard reaches the pair with every
   later step vehicle-paced, so only the 0 stops the walk-back.

Two different windows appear in one function: the fix scan is `samplesInWindow`
(INCLUSIVE both ends) while the `stats` recompute is half-open `[start, end)`.

UNPROVEN; pinned against Node/V8 (`lean/experiments/walk-tail-refs.mts`).
-/

namespace Handoff

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF median jsRound segMode sortedIn)

/-- Per-step net-progress speed marking the tail as travelling, not walking —
above the 12 km/h walking ceiling so a real walk's GPS noise cannot reach it. -/
def HANDOFF_MOVE_KMH : Float := 15
/-- A sustained run, so one glitchy fix pair cannot move the boundary. -/
def HANDOFF_MIN_TAIL_STEPS : Nat := 2
/-- Net displacement floor — far below `splitWalksOnVehicleLeg`'s 400 m,
because the adjacent confirmed vehicle already corroborates the travel. -/
def HANDOFF_MIN_NET_DIST_M : Float := 80
/-- …and one unambiguously-motorised instant, as a second signal. -/
def HANDOFF_PEAK_KMH : Float := 20
/-- Keep a real walk on the near side rather than swallowing the segment. -/
def HANDOFF_MIN_WALK_REMAINDER_S : Int := 60
/-- The road-vehicle successors this pass will hand a run to. -/
def HANDOFF_VEHICLE_MODES : List String := ["driving", "bus", "cycling"]

/-- Net-progress pace between two fixes. A non-advancing pair reads as 0 — it
can never clear the vehicle floor, so the scan stops there.

The `≥ HANDOFF_MOVE_KMH` comparison's STRICTNESS is unpinnable: separating `≥`
from `>` needs a step landing exactly on 15 km/h, and that is a haversine
distance, only ULP-close between V8 and Lean. The CONSTANT is pinned, by a
12 km/h step that must not qualify. -/
private def stepKmh (a b : PointF) : Float :=
  let dt := b.ts - a.ts
  if dt > 0 then haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt * 3.6 else 0

/-- Walk back from the last fix over consecutive vehicle-paced steps, returning
the run's start index and its length in steps. -/
private def tailScan (fixes : Array PointF) : Nat × Nat := Id.run do
  let mut s := fixes.size - 1
  let mut n := 0
  for _ in [0:fixes.size] do
    if s > 0 && stepKmh fixes[s - 1]! fixes[s]! ≥ HANDOFF_MOVE_KMH then
      s := s - 1
      n := n + 1
    else break
  return (s, n)

/-- Recomputed speed stats over a HALF-OPEN `[startTs, endTs)` window — note
the exclusive end, unlike the inclusive `sortedIn` used for the scan. -/
private def stats (points : Array PointF) (startTs endTs : Int) : Nat × Float × Float :=
  let speeds := (points.filter fun p => p.ts ≥ startTs && p.ts < endTs).map (·.speedKmh)
  let mx : Float := if speeds.isEmpty then 0 else speeds.foldl max speeds[0]!
  (speeds.size, jsRound (median speeds * 10) / 10, jsRound (mx * 10) / 10)

private def roundStr (x : Float) : String := toString (jsRound x).toInt64.toInt

/-- Advance a walk→vehicle boundary over the walk's vehicle-paced tail. -/
def reassignWalkTailToVehicle (segments : Array Seg) (points : Array PointF) : Array Seg := Id.run do
  let mut segs := segments
  let mut out : Array Seg := #[]
  for i in [0:segs.size] do
    -- Read fresh: a previous iteration may have rewritten this slot as its
    -- successor, and the TS reads `segs[i]` the same way.
    let cur := segs[i]!
    let moved : Option (Seg × Seg) := Id.run do
      if i + 1 ≥ segs.size then return none
      let next := segs[i + 1]!
      -- RAW mode on the walk side, `segMode` on the vehicle side.
      if !(cur.mode == "walking" && HANDOFF_VEHICLE_MODES.contains (segMode next)) then return none
      let fixes := sortedIn points cur.startTs cur.endTs
      -- PROVABLY shadowed by `HANDOFF_MIN_TAIL_STEPS = 2`: with two fixes the
      -- scan can find at most ONE step, so the run is refused there anyway. No
      -- guard can catch relaxing this to `< 2`. Kept as the TS has it.
      if fixes.size < 3 then return none
      let (s, tailSteps) := tailScan fixes
      if tailSteps < HANDOFF_MIN_TAIL_STEPS then return none
      let last := fixes.size - 1
      let netDist := haversineMeters fixes[s]!.lat fixes[s]!.lon fixes[last]!.lat fixes[last]!.lon
      let peak := (Array.range (last - s + 1)).foldl (init := (0 : Float)) fun a k =>
        max a fixes[s + k]!.speedKmh
      let driveStart := fixes[s]!.ts
      if netDist < HANDOFF_MIN_NET_DIST_M || peak < HANDOFF_PEAK_KMH then return none
      if driveStart - cur.startTs < HANDOFF_MIN_WALK_REMAINDER_S then return none
      let (wc, wa, wm) := stats points cur.startTs driveStart
      let (vc, va, vm) := stats points driveStart next.endTs
      return some
        ({ cur with endTs := driveStart, avgSpeed := wa, maxSpeed := wm, pointCount := Int.ofNat wc },
         { next with
           startTs := driveStart, avgSpeed := va, maxSpeed := vm, pointCount := Int.ofNat vc
           refinedReason := some s!"walk→vehicle boundary: {roundStr netDist} m vehicle-paced run (peak {roundStr peak} km/h) reassigned from the preceding walk to this ride" })
    match moved with
    | none => out := out.push cur
    | some (c, n) =>
      out := out.push c
      segs := segs.set! (i + 1) n
  return out

/-! ### Reference values

Pinned against Node/V8 (`lean/experiments/walk-tail-refs.mts`).
-/

section HandoffGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def fx (ts : Int) (metresNorth speedKmh : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }
#guard (fx 0 2400 0).lat == 51.541559468199786

private def sg (startTs endTs : Int) (mode : String := "walking")
    (refinedMode : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode
    avgSpeed := 4, maxSpeed := 6, linearity := 0.5, pointCount := 7
    refinedReason := some "inherited" }

/-- Walk 1000–1200 at ~1.8 km/h, then a vehicle-paced run to 1600. -/
private def FIXES : Array PointF :=
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 600 22, fx 1400 1200 24,
    fx 1500 1800 23, fx 1600 2400 25, fx 1700 3000 26, fx 1800 3600 27, fx 1900 4200 28]
private def SEGS : Array Seg := #[sg 1000 1600, sg 1600 2000 "driving"]

private structure HRow where
  startTs : Int
  endTs : Int
  mode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  reason : String
  deriving Inhabited, BEq, Repr

private def hv (segs : Array Seg) : Array HRow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode, pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, reason := s.refinedReason.getD "" }

private def hrun (segs : Array Seg := SEGS) (pts : Array PointF := FIXES) : Array HRow :=
  hv (reassignWalkTailToVehicle segs pts)

private def REASON : String :=
  "walk→vehicle boundary: 2297 m vehicle-paced run (peak 25 km/h) reassigned from the preceding walk to this ride"

-- The boundary advances to 1200; both segments' stats are recomputed from
-- their new windows and the vehicle gains a reason naming the evidence.
#guard hrun == #[
  { startTs := 1000, endTs := 1200, mode := "walking", pointCount := 2,
    avgSpeed := 3, maxSpeed := 3, reason := "inherited" },
  { startTs := 1200, endTs := 2000, mode := "driving", pointCount := 8,
    avgSpeed := 24.5, maxSpeed := 28, reason := REASON }]

-- HANDOFF_VEHICLE_MODES, member by member. bus and cycling are IN…
#guard (hrun #[sg 1000 1600, sg 1600 2000 "bus"])[0]!.endTs == 1200
#guard (hrun #[sg 1000 1600, sg 1600 2000 "cycling"])[0]!.endTs == 1200
-- …train and plane are OUT, unlike other vehicle-mode constants in this repo.
#guard hrun #[sg 1000 1600, sg 1600 2000 "train"] == hv #[sg 1000 1600, sg 1600 2000 "train"]
#guard hrun #[sg 1000 1600, sg 1600 2000 "plane"] == hv #[sg 1000 1600, sg 1600 2000 "plane"]
#guard hrun #[sg 1000 1600, sg 1600 2000 "walking"] == hv #[sg 1000 1600, sg 1600 2000 "walking"]
-- The vehicle side reads segMode, so a refinedMode promotion counts…
#guard (hrun #[sg 1000 1600, sg 1600 2000 "stationary" (some "driving")])[0]!.endTs == 1200
-- …while the WALK side reads the RAW mode, so a refinedMode-only walk is not
-- a walk here. The asymmetry is real and observable.
#guard hrun #[sg 1000 1600 "stationary" (some "walking"), sg 1600 2000 "driving"]
  == hv #[sg 1000 1600 "stationary" (some "walking"), sg 1600 2000 "driving"]
-- No successor at all.
#guard hrun #[sg 1000 1600] == hv #[sg 1000 1600]

-- THE GATES. Fewer than three fixes in the walk.
#guard hrun SEGS #[fx 1000 0 3, fx 1600 2400 25, fx 1700 3000 26] == hv SEGS
-- Only ONE vehicle-paced step: under HANDOFF_MIN_TAIL_STEPS.
#guard hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 150 4, fx 1600 2400 25, fx 1700 3000 26]
  == hv SEGS
-- EXACTLY two: at the bar, so it moves (and to a later boundary).
#guard (hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 150 4, fx 1400 800 22,
    fx 1600 2400 25, fx 1700 3000 26])[0]!.endTs == 1300
-- The run's NET displacement is under HANDOFF_MIN_NET_DIST_M.
#guard hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1210 150 22, fx 1220 175 24,
    fx 1230 160 25, fx 1600 170 26] == hv SEGS
-- No fix in the run reaches HANDOFF_PEAK_KMH.
#guard hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 600 19, fx 1400 1200 19,
    fx 1500 1800 19, fx 1600 2400 19] == hv SEGS
-- A peak of EXACTLY HANDOFF_PEAK_KMH clears it.
#guard (hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 600 20, fx 1400 1200 19,
    fx 1500 1800 19, fx 1600 2400 19])[0]!.endTs == 1200
-- The run would leave under HANDOFF_MIN_WALK_REMAINDER_S of walk.
#guard hrun #[sg 1150 1600, sg 1600 2000 "driving"] == hv #[sg 1150 1600, sg 1600 2000 "driving"]
-- Exactly at the bar (1200 − 1140 = 60): allowed. The walk keeps NO fixes, so
-- its recomputed stats are the empty-median 0, not its inherited 4/6.
#guard (hrun #[sg 1140 1600, sg 1600 2000 "driving"])[0]!
  == { startTs := 1140, endTs := 1200, mode := "walking", pointCount := 0,
       avgSpeed := 0, maxSpeed := 0, reason := "inherited" }

-- A non-advancing pair reads as 0 km/h, which can never clear the vehicle
-- floor, so the walk-back stops there. Every step AFTER it is vehicle-paced,
-- so were `stepKmh` to return +∞ (as the sibling pass does) the scan would run
-- on to 1200 and the boundary WOULD move.
#guard hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 600 22, fx 1400 1200 24,
    fx 1400 1800 23, fx 1500 2400 25] == hv SEGS

-- HANDOFF_MOVE_KMH's VALUE, isolated. The 1200→1300 step runs at 12 km/h —
-- above walking, below the 15 km/h vehicle floor. At 15 the walk-back stops
-- there (boundary 1300); lower the floor to 10 and it continues to 1200.
#guard hrun SEGS
  #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1300 433 12, fx 1400 1033 22,
    fx 1500 1633 23, fx 1600 2233 25]
  == #[{ startTs := 1000, endTs := 1300, mode := "walking", pointCount := 3,
         avgSpeed := 3, maxSpeed := 4, reason := "inherited" },
       { startTs := 1300, endTs := 2000, mode := "driving", pointCount := 4,
         avgSpeed := 22.5, maxSpeed := 25,
         reason := "walk→vehicle boundary: 1798 m vehicle-paced run (peak 25 km/h) reassigned from the preceding walk to this ride" }]

-- HANDOFF_MIN_NET_DIST_M's VALUE, isolated. Two short vehicle-paced steps cover
-- ~300 m net: over the 80 m floor, but a floor of 500 would refuse.
#guard hrun SEGS #[fx 1000 0 3, fx 1100 50 3, fx 1200 100 4, fx 1220 250 27, fx 1240 400 28]
  == #[{ startTs := 1000, endTs := 1200, mode := "walking", pointCount := 2,
         avgSpeed := 3, maxSpeed := 3, reason := "inherited" },
       { startTs := 1200, endTs := 2000, mode := "driving", pointCount := 3,
         avgSpeed := 27, maxSpeed := 28,
         reason := "walk→vehicle boundary: 300 m vehicle-paced run (peak 28 km/h) reassigned from the preceding walk to this ride" }]

#guard hrun #[] #[] == #[]

end HandoffGuards

end Handoff

/-! ## `reassignVehicleArrivalWalk`

The arrival-side mirror of `reassignWalkTailToVehicle`, but structurally
different in three ways:

1. `prev` is read from the OUTPUT array, not the input — it is whatever the
   previous iteration emitted, so an earlier rewrite is visible here.
2. When it acts it REWRITES that output element and does NOT push `cur`, so the
   phantom walk is DROPPED and the segment count SHRINKS. Every other pass so
   far preserved the count.
3. `prev` is matched on `segMode`, `next` on the RAW `mode` — the opposite
   pairing to the departure-side pass, and guarded both ways.

The precision gate is `tailParked`: three conjuncts (every residual fix within
`ARRIVAL_STAY_RADIUS_M` of the stay centroid, net progress ≤
`ARRIVAL_TAIL_MAX_NET_M`, median speed ≤ `ARRIVAL_TAIL_STATIONARY_KMH`). If the
residual WALKS — a real walk-in from the kerb — the pass leaves the segment
entirely alone: a mislabelled vehicle head is a smaller error than an eaten
walk. Each conjunct has its own guard.

UNPROVEN; pinned against Node/V8 (`lean/experiments/arrival-walk-refs.mts`).
-/

namespace Arrival

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF median jsRound segMode sortedIn)
open Handoff (HANDOFF_VEHICLE_MODES)

/-- Per-step net-progress speed marking the head as travelling. -/
def ARRIVAL_MOVE_KMH : Float := 15
/-- Require a sustained run, not one glitchy pair. -/
def ARRIVAL_MIN_HEAD_STEPS : Nat := 2
/-- Net displacement floor — corroborated by the adjacent vehicle. -/
def ARRIVAL_MIN_NET_DIST_M : Float := 80
/-- …and one unambiguously-motorised instant. -/
def ARRIVAL_PEAK_KMH : Float := 20
/-- The residual counts as parked only if every fix sits within this of the
stay's centroid… -/
def ARRIVAL_STAY_RADIUS_M : Float := 90
/-- …its net progress is negligible… -/
def ARRIVAL_TAIL_MAX_NET_M : Float := 45
/-- …and its median speed reads as a standstill, not walking. -/
def ARRIVAL_TAIL_STATIONARY_KMH : Float := 2.5

private def stepKmh (a b : PointF) : Float :=
  let dt := b.ts - a.ts
  if dt > 0 then haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt * 3.6 else 0

/-- Walk forward from the first fix over consecutive vehicle-paced steps. -/
private def headScan (fixes : Array PointF) : Nat × Nat := Id.run do
  let mut h := 0
  let mut n := 0
  for _ in [0:fixes.size] do
    if h + 1 < fixes.size && stepKmh fixes[h]! fixes[h + 1]! ≥ ARRIVAL_MOVE_KMH then
      h := h + 1
      n := n + 1
    else break
  return (h, n)

/-- Half-open `[startTs, endTs)` speed stats, as in the departure pass. -/
private def stats (points : Array PointF) (startTs endTs : Int) : Nat × Float × Float :=
  let speeds := (points.filter fun p => p.ts ≥ startTs && p.ts < endTs).map (·.speedKmh)
  let mx : Float := if speeds.isEmpty then 0 else speeds.foldl max speeds[0]!
  (speeds.size, jsRound (median speeds * 10) / 10, jsRound (mx * 10) / 10)

private def roundStr (x : Float) : String := toString (jsRound x).toInt64.toInt

/-- Dissolve a phantom walk that is really a vehicle's decelerating arrival. -/
def reassignVehicleArrivalWalk (segments : Array Seg) (points : Array PointF) : Array Seg := Id.run do
  let mut segs := segments
  let mut out : Array Seg := #[]
  for i in [0:segs.size] do
    let cur := segs[i]!
    -- `prev` is the last EMITTED segment, not `segs[i-1]`. The TS reads `out`,
    -- and this mirrors it — but the two are PROVABLY indistinguishable here, so
    -- no guard pins the choice. They can only diverge on the iteration right
    -- after a fold, and a fold requires `segs[i+1].mode == "stationary"`; that
    -- same segment is the next iteration's `cur`, which then fails the
    -- `cur.mode == "walking"` test either way.
    let prev? := out.back?
    let acted : Option (Seg × Seg) := Id.run do
      if i + 1 ≥ segs.size then return none
      let next := segs[i + 1]!
      match prev? with
      | none => return none
      | some prev =>
        -- segMode on the vehicle, RAW mode on the stay.
        if !(cur.mode == "walking" && HANDOFF_VEHICLE_MODES.contains (segMode prev)
             && next.mode == "stationary") then return none
        let fixes := sortedIn points cur.startTs cur.endTs
        -- PROVABLY shadowed by `ARRIVAL_MIN_HEAD_STEPS = 2`, exactly as in the
        -- departure pass: two fixes admit at most one step.
        if fixes.size < 3 then return none
        let (h, headSteps) := headScan fixes
        if headSteps < ARRIVAL_MIN_HEAD_STEPS then return none
        let headNet := haversineMeters fixes[0]!.lat fixes[0]!.lon fixes[h]!.lat fixes[h]!.lon
        let peak := (Array.range (h + 1)).foldl (init := (0 : Float)) fun a k => max a fixes[k]!.speedKmh
        if headNet < ARRIVAL_MIN_NET_DIST_M || peak < ARRIVAL_PEAK_KMH then return none
        let boundaryTs := fixes[h]!.ts
        -- Stay centroid, falling back to the walk's LAST fix when the stay has
        -- no fixes of its own.
        let stayFixes := sortedIn points next.startTs next.endTs
        let sc : Float × Float :=
          if stayFixes.isEmpty then (fixes[fixes.size - 1]!.lat, fixes[fixes.size - 1]!.lon)
          else
            let n := Float.ofNat stayFixes.size
            (stayFixes.foldl (fun a p => a + p.lat) 0 / n, stayFixes.foldl (fun a p => a + p.lon) 0 / n)
        let tail := fixes.extract h fixes.size
        -- The `≥ 2` here is PROVABLY a no-op: `tail` is `fixes[h:]`, so a
        -- single-element tail means `h` is the last index, and the distance
        -- from that fix to itself is 0 — the same value the `else` branch
        -- supplies. Kept as the TS has it.
        let tailNet :=
          if tail.size ≥ 2 then
            haversineMeters tail[0]!.lat tail[0]!.lon tail[tail.size - 1]!.lat tail[tail.size - 1]!.lon
          else 0
        let tailMedianKmh := median (tail.map (·.speedKmh))
        let tailParked :=
          tail.all (fun f => haversineMeters f.lat f.lon sc.1 sc.2 ≤ ARRIVAL_STAY_RADIUS_M)
          && tailNet ≤ ARRIVAL_TAIL_MAX_NET_M
          && tailMedianKmh ≤ ARRIVAL_TAIL_STATIONARY_KMH
        -- Precision over recall: a residual that WALKS is a real walk-in, and
        -- the segment is left entirely alone.
        if !tailParked then return none
        let (vc, va, vm) := stats points prev.startTs boundaryTs
        let (sc2, sa, sm) := stats points boundaryTs next.endTs
        let head := match prev.refinedReason with | some r => s!"{r}; " | none => ""
        return some
          ({ prev with
             endTs := boundaryTs, avgSpeed := va, maxSpeed := vm, pointCount := Int.ofNat vc
             refinedReason := some s!"{head}extended forward: absorbed the drive's decelerating arrival tail ({roundStr headNet} m, peak {roundStr peak} km/h) that segmentation glued onto the following walk" },
           { next with
             startTs := boundaryTs, avgSpeed := sa, maxSpeed := sm, pointCount := Int.ofNat sc2 })
    match acted with
    | none => out := out.push cur
    | some (p, n) =>
      -- The walk is DROPPED: `cur` is never pushed.
      out := out.set! (out.size - 1) p
      segs := segs.set! (i + 1) n
  return out

/-! ### Reference values

Pinned against Node/V8 (`lean/experiments/arrival-walk-refs.mts`).
-/

section ArrivalGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def fx (ts : Int) (metresNorth speedKmh : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }
#guard (fx 0 1200 0).lat == 51.530779734099895

private def sg (startTs endTs : Int) (mode : String) (avgSpeed maxSpeed : Float := 4)
    (refinedMode : Option String := none) (refinedReason : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode, refinedReason
    avgSpeed, maxSpeed, linearity := 0.5, pointCount := 7 }

private def DRIVE : Seg := sg 500 1000 "driving" 30 40
private def WALK : Seg := sg 1000 1600 "walking" 4 6
private def STAY : Seg := sg 1600 2200 "stationary" 4 6
private def SEGS : Array Seg := #[DRIVE, WALK, STAY]

private def FIXES : Array PointF :=
  #[fx 500 (-2000) 40, fx 700 (-1000) 38, fx 900 (-200) 30,
    fx 1000 0 25, fx 1100 600 22, fx 1200 1200 21,
    fx 1300 1210 1, fx 1400 1215 0.5, fx 1500 1212 0.4, fx 1600 1214 0.3,
    fx 1700 1213 0.2, fx 1800 1215 0.3, fx 1900 1212 0.1]

/-- Replace the parked residual with a real walk-in from the kerb. -/
private def walkInTail (medianKmh spread : Float) : Array PointF :=
  FIXES.extract 0 6 ++
  #[fx 1300 (1200 + spread) medianKmh, fx 1400 (1200 + 2 * spread) medianKmh,
    fx 1500 (1200 + 3 * spread) medianKmh, fx 1600 (1200 + 4 * spread) medianKmh,
    fx 1700 (1200 + 4 * spread) 0.2, fx 1800 (1200 + 4 * spread) 0.3,
    fx 1900 (1200 + 4 * spread) 0.1]

private structure ARow where
  startTs : Int
  endTs : Int
  mode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  reason : String
  deriving Inhabited, BEq, Repr

private def av (segs : Array Seg) : Array ARow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode, pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, reason := s.refinedReason.getD "" }

private def arun (segs : Array Seg := SEGS) (pts : Array PointF := FIXES) : Array ARow :=
  av (reassignVehicleArrivalWalk segs pts)

private def REASON : String :=
  "extended forward: absorbed the drive's decelerating arrival tail (1199 m, peak 25 km/h) that segmentation glued onto the following walk"

-- The drive absorbs its arrival tail, the residual folds into the stay, and the
-- phantom walk is DROPPED — three segments become TWO.
#guard arun == #[
  { startTs := 500, endTs := 1200, mode := "driving", pointCount := 5,
    avgSpeed := 30, maxSpeed := 40, reason := REASON },
  { startTs := 1200, endTs := 2200, mode := "stationary", pointCount := 8,
    avgSpeed := 0.4, maxSpeed := 21, reason := "" }]

-- WHO MAY PARTICIPATE. prev is matched on segMode, so a refinedMode promotion
-- counts (and the raw mode is left as it was).
#guard (arun #[sg 500 1000 "stationary" 30 40 (some "driving"), WALK, STAY]).size == 2
-- train is not in HANDOFF_VEHICLE_MODES.
#guard arun #[sg 500 1000 "train", WALK, STAY] == av #[sg 500 1000 "train", WALK, STAY]
-- next is matched on the RAW mode, so a refinedMode-only stay does NOT count.
#guard arun #[DRIVE, WALK, sg 1600 2200 "walking" 4 6 (some "stationary")]
  == av #[DRIVE, WALK, sg 1600 2200 "walking" 4 6 (some "stationary")]
#guard arun #[DRIVE, WALK, sg 1600 2200 "walking"] == av #[DRIVE, WALK, sg 1600 2200 "walking"]
#guard arun #[DRIVE, sg 1000 1600 "driving", STAY] == av #[DRIVE, sg 1000 1600 "driving", STAY]
-- No predecessor, and no successor.
#guard arun #[WALK, STAY] == av #[WALK, STAY]
#guard arun #[DRIVE, WALK] == av #[DRIVE, WALK]

-- THE HEAD GATES.
#guard arun SEGS #[fx 500 (-2000) 40, fx 1000 0 25, fx 1200 1200 21, fx 1700 1213 0.2] == av SEGS
-- One vehicle-paced step only.
#guard arun SEGS (FIXES.extract 0 4 ++ #[fx 1100 600 22, fx 1200 610 1] ++ FIXES.extract 6 13) == av SEGS
-- The head's NET displacement is under ARRIVAL_MIN_NET_DIST_M.
#guard arun SEGS
  (FIXES.extract 0 4 ++ #[fx 1010 50 22, fx 1020 75 21, fx 1300 70 1, fx 1400 72 0.5,
                          fx 1500 71 0.4, fx 1600 73 0.3, fx 1700 72 0.2]) == av SEGS
-- No fix in the head reaches ARRIVAL_PEAK_KMH.
#guard arun SEGS
  (#[fx 500 (-2000) 40, fx 900 (-200) 19, fx 1000 0 19, fx 1100 600 19, fx 1200 1200 19]
   ++ FIXES.extract 6 13) == av SEGS

-- tailParked, ONE CONJUNCT AT A TIME.
-- A residual fix outside ARRIVAL_STAY_RADIUS_M of the stay centroid.
#guard arun SEGS (FIXES.extract 0 6 ++ #[fx 1300 1350 1] ++ FIXES.extract 7 13) == av SEGS
-- The residual's NET progress exceeds ARRIVAL_TAIL_MAX_NET_M.
#guard arun SEGS (walkInTail 1 15) == av SEGS
-- The residual MOVES at walking pace — a real walk-in from the kerb. Leaving it
-- alone is the whole point: a mislabelled vehicle head beats an eaten walk.
#guard arun SEGS (walkInTail 4.5 5) == av SEGS

-- The stay has NO fixes of its own, so the centroid falls back to the walk's
-- LAST fix. The fixture must stop BEFORE ts 1600: `sortedIn` is inclusive at
-- both ends, so a fix AT the stay's startTs is already one of its fixes and the
-- fallback never fires (my first attempt at this case made exactly that
-- mistake and pinned nothing).
#guard arun SEGS (FIXES.extract 0 9) == #[
  { startTs := 500, endTs := 1200, mode := "driving", pointCount := 5,
    avgSpeed := 30, maxSpeed := 40, reason := REASON },
  { startTs := 1200, endTs := 2200, mode := "stationary", pointCount := 4,
    avgSpeed := 0.8, maxSpeed := 21, reason := "" }]

-- ARRIVAL_MOVE_KMH's VALUE, isolated. The 1200→1300 step runs at 12 km/h:
-- above walking, below the 15 km/h floor, so the head scan stops at 1200 and
-- the residual then starts 341 m from the stay centroid — refused. Lower the
-- floor to 10 and the scan runs on to 1300, where the residual IS parked and
-- the fold happens.
#guard arun SEGS
  #[fx 500 (-2000) 40, fx 900 (-200) 30, fx 1000 0 25, fx 1100 600 22, fx 1200 1200 21,
    fx 1300 1533 12, fx 1400 1543 1, fx 1500 1540 0.4, fx 1600 1542 0.3, fx 1700 1541 0.2]
  == av SEGS

-- prev already carries a reason: the new one is APPENDED after "; ".
#guard (arun #[sg 500 1000 "driving" 30 40 none (some "bus route 38"), WALK, STAY])[0]!.reason
  == s!"bus route 38; {REASON}"

#guard arun #[] #[] == #[]

end ArrivalGuards

end Arrival

/-! ## `splitWalksOnVehicleLeg`

The only stay-split pass that GROWS the segment list: a walk hiding a ride
becomes `[walk?, driving, walk?]`. It searches every contiguous fix interval
(O(n²), n tiny) for the one that best looks like a ride, trims on-foot
shoulders off it, then refuses outright if the carve would butt against an
adjacent train.

Details the guards pin:

* The gate is the EFFECTIVE mode. A short urban car ride averages low, so the
  raw `mode` is often "walking" while OSM refinement has already called it
  `driving`. Gating on the raw mode made this pass carve a confirmed 14-minute
  car ride into a walk plus a 3-minute drive (2026-05-25, Fulton Road).
* Interval choice: most ground wins; on an EXACT tie the shorter duration wins,
  so flat departure fixes cannot pad the leg outward.
* SHOULDER TRIMMING CAN SHRINK THE LEG BELOW `VEHICLE_LEG_MIN_DURATION_S`. That
  bar applies to the SEARCH, not to the result. The `trimBelowMinDuration`
  guard keeps a 100 s ride — and records the resulting artefact, `avgSpeed`
  (net/dur) exceeding `maxSpeed` (a speed reading).
* `pointCount` uses an INCLUSIVE `[driveStart, driveEnd]` window — a THIRD
  convention in this one file (`sortedIn` inclusive, `stats` half-open).
  Deliberate: the boundary fixes are the ride's, so the flanking walks must not
  count them too.

Shell: the `VEHICLE_SPLIT_DEBUG` tracing.

UNPROVEN; pinned against Node/V8 (`lean/experiments/vehicle-leg-refs.mts`).
-/

namespace VehicleLeg

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF jsRound segMode sortedIn walkRemainder)

/-- A walk shorter than this is not searched at all. -/
def VEHICLE_LEG_MIN_SEGMENT_S : Int := 5 * 60
/-- Mean pace over the interval that marks it as a ride. -/
def VEHICLE_LEG_MOVE_KMH : Float := 15
/-- Net displacement floor — deliberately high: nothing corroborates a ride
hidden in the MIDDLE of a walk, so urban-canyon jitter must not trigger it.

PROVABLY DEAD as written, and no guard pins its value: clearing
`VEHICLE_LEG_MOVE_KMH` at `VEHICLE_LEG_MIN_DURATION_S` already forces
`netDist ≥ (15 / 3.6) × 120 = 500 m > 400`. The other two gates subsume it.
Kept as the TS has it — it documents intent and would bite if either changed. -/
def VEHICLE_LEG_MIN_DIST_M : Float := 400
/-- …sustained for at least this long. Applies to the SEARCH only. -/
def VEHICLE_LEG_MIN_DURATION_S : Int := 120
/-- …with one unambiguously-motorised instant. -/
def VEHICLE_LEG_PEAK_KMH : Float := 20
/-- A sub-minute residual walk is folded into the ride. -/
def VEHICLE_LEG_MIN_REMAINDER_S : Int := 60
/-- A carve butting this close to an adjacent train is boundary bleed. -/
def BLEED_S : Int := 90

private def isTrain (s : Option Seg) : Bool :=
  match s with | some x => segMode x == "train" | none => false

private def peakBetween (fixes : Array PointF) (a b : Nat) : Float :=
  (Array.range (b + 1 - a)).foldl (init := (0 : Float)) fun p k => max p fixes[a + k]!.speedKmh

private def stepKmh (fixes : Array PointF) (i j : Nat) : Float :=
  let dt := fixes[j]!.ts - fixes[i]!.ts
  if dt > 0 then
    haversineMeters fixes[i]!.lat fixes[i]!.lon fixes[j]!.lat fixes[j]!.lon / Float.ofInt dt * 3.6
  else 0

/-- The contiguous interval that best looks like a ride: most ground covered,
shorter duration breaking an exact tie. -/
private structure Cand where
  a : Nat
  b : Nat
  netDist : Float
  dur : Int
  deriving Inhabited

private def bestInterval (fixes : Array PointF) : Option Cand := Id.run do
  let mut best : Option Cand := none
  for a in [0:fixes.size - 1] do
    for b in [a + 1:fixes.size] do
      let dur := fixes[b]!.ts - fixes[a]!.ts
      if dur < VEHICLE_LEG_MIN_DURATION_S then continue
      let netDist := haversineMeters fixes[a]!.lat fixes[a]!.lon fixes[b]!.lat fixes[b]!.lon
      if netDist < VEHICLE_LEG_MIN_DIST_M then continue
      if netDist / Float.ofInt dur * 3.6 < VEHICLE_LEG_MOVE_KMH then continue
      if peakBetween fixes a b < VEHICLE_LEG_PEAK_KMH then continue
      match best with
      | none => best := some { a, b, netDist, dur }
      | some cur =>
        if netDist > cur.netDist || (netDist == cur.netDist && dur < cur.dur) then
          best := some { a, b, netDist, dur }
  return best

/-- Split each walking segment that hides a vehicle leg into
`[walk?, driving, walk?]`. -/
def splitWalksOnVehicleLeg (segments : Array Seg) (points : Array PointF) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  for i in [0:segments.size] do
    let seg := segments[i]!
    -- The EFFECTIVE mode: a leg already identified as a vehicle IS the ride.
    if segMode seg != "walking" || seg.endTs - seg.startTs < VEHICLE_LEG_MIN_SEGMENT_S then
      out := out.push seg
      continue
    let fixes := sortedIn points seg.startTs seg.endTs
    if fixes.size < 3 then
      out := out.push seg
      continue
    match bestInterval fixes with
    | none => out := out.push seg
    | some cand =>
      -- Trim on-foot shoulders the max-distance interval may have absorbed:
      -- shrink inward while the boundary step is not itself vehicle-paced.
      let mut a := cand.a
      let mut b := cand.b
      for _ in [0:fixes.size] do
        if a < b && stepKmh fixes a (a + 1) < VEHICLE_LEG_MOVE_KMH then a := a + 1 else break
      for _ in [0:fixes.size] do
        if b > a && stepKmh fixes (b - 1) b < VEHICLE_LEG_MOVE_KMH then b := b - 1 else break
      let netDist := haversineMeters fixes[a]!.lat fixes[a]!.lon fixes[b]!.lat fixes[b]!.lon
      let dur := fixes[b]!.ts - fixes[a]!.ts
      let peak := peakBetween fixes a b
      -- Boundaries: fold a sub-minute residual walk into the ride.
      let driveStart :=
        if fixes[a]!.ts - seg.startTs < VEHICLE_LEG_MIN_REMAINDER_S then seg.startTs else fixes[a]!.ts
      let driveEnd :=
        if seg.endTs - fixes[b]!.ts < VEHICLE_LEG_MIN_REMAINDER_S then seg.endTs else fixes[b]!.ts
      -- Train-bleed guard: a walk's tail accelerating into the next train (or
      -- its head decelerating out of the previous one) is the train boundary
      -- bleeding into the walk, not a separate ride.
      let nextTrain := isTrain (if i + 1 < segments.size then some segments[i + 1]! else none)
      let prevTrain := isTrain (if i > 0 then some segments[i - 1]! else none)
      if (nextTrain && seg.endTs - driveEnd < BLEED_S)
         || (prevTrain && driveStart - seg.startTs < BLEED_S) then
        out := out.push seg
      else
        let meanKmh := if dur > 0 then jsRound (netDist / Float.ofInt dur * 3.6 * 10) / 10 else 0
        let drivePart : Seg :=
          { seg with
            mode := "driving", refinedMode := none, wayName := none, place := none
            startTs := driveStart, endTs := driveEnd
            avgSpeed := meanKmh, maxSpeed := jsRound (peak * 10) / 10, linearity := 1
            -- INCLUSIVE window: `peakBetween` already counted the boundary
            -- fixes as the ride's, so the flanking walks must not.
            -- Filtering `points` rather than `fixes` is PROVABLY the same set —
            -- `[driveStart, driveEnd] ⊆ [seg.startTs, seg.endTs]`, and `fixes`
            -- is exactly `points` restricted to the latter — so no guard can
            -- separate them.
            pointCount := Int.ofNat (points.filter fun p => p.ts ≥ driveStart && p.ts ≤ driveEnd).size
            refinedReason := some s!"vehicle-leg split: {toString (jsRound netDist).toInt64.toInt} m net progress in {toString (jsRound (Float.ofInt dur / 60)).toInt64.toInt} min (peak {toString (jsRound peak).toInt64.toInt} km/h) inside a walking segment — a ride, not a walk" }
        if driveStart > seg.startTs then
          out := out.push (walkRemainder seg seg.startTs driveStart points false)
        out := out.push drivePart
        if driveEnd < seg.endTs then
          out := out.push (walkRemainder seg driveEnd seg.endTs points true)
  return out

/-! ### Reference values

Pinned against Node/V8 (`lean/experiments/vehicle-leg-refs.mts`).
-/

section VehicleLegGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def fx (ts : Int) (metresNorth speedKmh : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }
#guard (fx 0 3000 0).lat == 51.546949335249735

private def sg (startTs endTs : Int) (mode : String := "walking")
    (refinedMode : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode
    avgSpeed := 4, maxSpeed := 6, linearity := 0.5, pointCount := 9
    wayName := some "Some Footway", place := some "Somewhere" }

/-- A 20-minute "walk" with a 2 km ride buried in the middle. -/
private def FIXES : Array PointF :=
  #[fx 1000 0 4, fx 1150 100 4, fx 1300 200 5, fx 1450 1200 45, fx 1600 2200 42,
    fx 1750 2300 5, fx 1900 2400 4, fx 2050 2500 4, fx 2200 2600 4]
private def SEGS : Array Seg := #[sg 1000 2200]

private structure VRow where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  wayName : String
  place : String
  reenrich : Bool
  reason : String
  deriving Inhabited, BEq, Repr

private def vv (segs : Array Seg) : Array VRow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode
      refinedMode := s.refinedMode.getD "", pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, linearity := s.linearity
      wayName := s.wayName.getD "", place := s.place.getD ""
      reenrich := s.needsReenrich, reason := s.refinedReason.getD "" }

private def vrun (segs : Array Seg := SEGS) (pts : Array PointF := FIXES) : Array VRow :=
  vv (splitWalksOnVehicleLeg segs pts)

private def RIDE_REASON : String :=
  "vehicle-leg split: 1998 m net progress in 5 min (peak 45 km/h) inside a walking segment — a ride, not a walk"

private def preWalk : VRow :=
  { startTs := 1000, endTs := 1300, mode := "walking", refinedMode := "", pointCount := 2,
    avgSpeed := 4, maxSpeed := 4, linearity := 1, wayName := "", place := "",
    reenrich := true, reason := "" }
private def ride : VRow :=
  { startTs := 1300, endTs := 1600, mode := "driving", refinedMode := "", pointCount := 3,
    avgSpeed := 24, maxSpeed := 45, linearity := 1, wayName := "", place := "",
    reenrich := false, reason := RIDE_REASON }
private def postWalk : VRow :=
  { startTs := 1600, endTs := 2200, mode := "walking", refinedMode := "", pointCount := 3,
    avgSpeed := 4, maxSpeed := 5, linearity := 1, wayName := "", place := "",
    reenrich := true, reason := "" }

-- walk / driving / walk — the list GROWS from 1 to 3. The ride's inherited
-- on-foot enrichment (footway name, place) is cleared.
#guard vrun == #[preWalk, ride, postWalk]

-- THE GATE is the EFFECTIVE mode: a leg OSM already called driving IS the ride,
-- not a walk hiding one. Gating on the raw `mode` here was a real bug.
#guard vrun #[sg 1000 2200 "walking" (some "driving")] == vv #[sg 1000 2200 "walking" (some "driving")]
-- A refinedMode-only walk IS eligible, and the remainders keep the raw mode.
#guard vrun #[sg 1000 2200 "stationary" (some "walking")]
  == #[{ preWalk with mode := "stationary" }, ride, { postWalk with mode := "stationary" }]
-- Under VEHICLE_LEG_MIN_SEGMENT_S the pass does not look. The window must
-- otherwise CONTAIN a qualifying ride, or lowering the constant changes nothing
-- and the guard pins nothing.
#guard vrun #[sg 1000 1290] #[fx 1000 0 45, fx 1150 1000 45, fx 1290 2000 42]
  == vv #[sg 1000 1290]
-- …and exactly AT the bar it does, finding a ride. (A window that merely fails
-- to contain one cannot pin the constant — my first attempt made that mistake.)
#guard vrun #[sg 1000 1300] #[fx 1000 0 45, fx 1150 1000 45, fx 1300 2000 42]
  == #[{ ride with startTs := 1000, endTs := 1300 }]
#guard vrun SEGS #[fx 1000 0 4, fx 1600 2200 42] == vv SEGS

-- THE INTERVAL GATES.
#guard vrun SEGS
  #[fx 1000 0 4, fx 1150 100 4, fx 1300 200 5, fx 1450 500 45, fx 1600 550 42, fx 2200 600 4]
  == vv SEGS
#guard vrun SEGS #[fx 1000 0 4, fx 1100 2000 45, fx 2200 2050 4] == vv SEGS
#guard vrun SEGS
  #[fx 1000 0 4, fx 1300 200 5, fx 1600 600 8, fx 1900 1000 8, fx 2200 1400 8] == vv SEGS
#guard vrun SEGS
  #[fx 1000 0 4, fx 1150 100 4, fx 1300 200 5, fx 1450 1200 19, fx 1600 2200 19, fx 2200 2300 4]
  == vv SEGS

-- SHOULDER TRIMMING CAN SHRINK THE LEG BELOW THE SEARCH MINIMUM. The winning
-- interval spans 250 s; trimming the slow leading shoulder leaves 100 s, under
-- VEHICLE_LEG_MIN_DURATION_S, and it is kept. Note the artefact this records:
-- avgSpeed (net/dur) EXCEEDS maxSpeed (a speed reading).
#guard vrun SEGS
  #[fx 1000 0 4, fx 1150 100 4, fx 1300 200 5, fx 1400 2200 45, fx 2200 2300 4]
  == #[preWalk,
       { ride with
         endTs := 1400, pointCount := 2, avgSpeed := 71.9
         reason := "vehicle-leg split: 1998 m net progress in 2 min (peak 45 km/h) inside a walking segment — a ride, not a walk" },
       { postWalk with
         startTs := 1400, pointCount := 0, avgSpeed := 4, maxSpeed := 6, linearity := 0.5 }]

-- The ride reaches the segment's start, so there is no leading walk.
#guard vrun SEGS
  #[fx 1000 0 45, fx 1150 1000 45, fx 1300 2000 42, fx 1450 2100 5, fx 1600 2200 4, fx 2200 2300 4]
  == #[{ ride with startTs := 1000, endTs := 1300 },
       { postWalk with startTs := 1300, pointCount := 2, avgSpeed := 4.5 }]
-- A sub-minute leading residual is folded into the ride.
#guard vrun SEGS
  #[fx 1000 0 4, fx 1050 50 45, fx 1200 1050 45, fx 1400 2200 42, fx 1600 2300 5, fx 2200 2400 4]
  == #[{ ride with
         startTs := 1000, endTs := 1400, pointCount := 4, avgSpeed := 22.1
         reason := "vehicle-leg split: 2148 m net progress in 6 min (peak 45 km/h) inside a walking segment — a ride, not a walk" },
       { postWalk with
         startTs := 1400, pointCount := 1, avgSpeed := 4, maxSpeed := 6, linearity := 0.5 }]

-- THE TRAIN-BLEED GUARDS. A carve butting against the FOLLOWING train is
-- boarding bleed, not a ride…
-- A qualifying interval MUST exist, or the refusal proves nothing. Here
-- 1880→2130 clears every gate, and the residual 2200 − 2130 = 70 s sits between
-- a BLEED_S of 10 and one of 90 — so the constant's value is pinned too.
private def BLEED_FIXES : Array PointF :=
  #[fx 1000 0 4, fx 1300 200 5, fx 1880 2200 45, fx 2130 3300 42, fx 2200 3350 40]
#guard vrun #[sg 1000 2200, sg 2200 3000 "train"] BLEED_FIXES
  == vv #[sg 1000 2200, sg 2200 3000 "train"]
-- …and against the PRECEDING train is alighting bleed.
#guard vrun #[sg 200 1000 "train", sg 1000 2200]
  #[fx 1000 0 40, fx 1050 800 45, fx 1300 2000 42, fx 1600 2100 5, fx 2200 2200 4]
  == vv #[sg 200 1000 "train", sg 1000 2200]

-- AN EXACT netDist TIE between two intervals sharing a start fix and ending at
-- EQUIDISTANT points (+1500 m and −1500 m from the start), so the two
-- haversines are bit-equal rather than merely close. The TIGHTER interval must
-- win. The two ends also have to SURVIVE shoulder trimming — a first attempt
-- put both at the same coordinate, and the trim collapsed the longer interval
-- back onto the shorter one, so the case pinned nothing.
#guard vrun SEGS #[fx 1000 0 45, fx 1250 1500 45, fx 1300 (-1500) 45, fx 2200 (-1450) 4]
  == #[{ ride with
         startTs := 1000, endTs := 1250, pointCount := 2, avgSpeed := 21.6
         reason := "vehicle-leg split: 1498 m net progress in 4 min (peak 45 km/h) inside a walking segment — a ride, not a walk" },
       { postWalk with
         startTs := 1250, pointCount := 1, avgSpeed := 4, maxSpeed := 6, linearity := 0.5 }]
-- A train neighbour the carve does NOT butt against is fine.
#guard vrun #[sg 1000 2200, sg 2200 3000 "train"]
  == #[preWalk, ride, postWalk] ++ vv #[sg 2200 3000 "train"]
-- The bleed test reads the neighbour's EFFECTIVE mode too.
#guard vrun #[sg 1000 2200, sg 2200 3000 "stationary" (some "train")] BLEED_FIXES
  == vv #[sg 1000 2200, sg 2200 3000 "stationary" (some "train")]

#guard vrun #[] #[] == #[]

end VehicleLegGuards

end VehicleLeg

/-! ## `claimRideHeadFromStay`

The last stay-split pass, and the only one that deliberately INVENTS a segment.
GPS dies in the tunnel just after boarding, so segmentation sees no boundary
until the reacquire fixes cohere minutes into the ride: the stay swallows the
walk to the station, the platform wait, and the ride's head. Nothing false is
drawn (a stay renders as a dot), but the walk is missing and the ride's start is
a lie.

Anatomy, scanned from the dwell outward: **march** (a contiguous moving run) →
optional **wait** (standing) → **ride** (a vehicle-paced step after which the
fixes never return to the dwell).

## The dwell position is a TIME-WEIGHTED, component-wise median

Indoor GPS is sparse — a multi-hour dwell may be four fixes and a long gap while
the departing tail is a dense run — so a plain per-fix median lands in the TAIL.
Weighting each fix by how long its position HELD (until the next fix) puts the
dwell back in charge. The happy-path guard has 4 dwell fixes against 10 tail
fixes: an unweighted median would sit ~200 m away and
`MARCH_START_MAX_FROM_DWELL_M` would refuse the carve outright, so that guard
pins the weighting as well as the carve.

Component-wise means lat and lon are medianed INDEPENDENTLY, so the dwell point
need not be any actual fix. Reproduced as the TS has it.

Precision over recall throughout: without step data it is inert; a march that
never leaves the dwell, or ride evidence that returns to it, is left alone; and
the carve must leave a dwell-scale stay behind.

## Probe coverage

Complete over two passes. The first left EIGHT choices unpinned; the second
(fixtures under "Second probe pass" below) closed seven of them and proved the
eighth unpinnable:

* `holdS`'s `max(…, 1)` floor, `weightedMedian`'s `acc ≥ half` vs `>`, and the
  `/ 2` in `half` — pinned by the `southMarch` fixtures, which put the dwell's
  cumulative weight exactly on half.
* `MARCH_START_MAX_FROM_DWELL_M`, the `n < 8` floor and the `PEDESTRIAN_MIN_RUN_S`
  bar — pinned on BOTH sides by straddling pairs, so their values are fixed, not
  just their directions.
* the `fromDwell[w]` gate as a whole — pinned by `farMarch 160`.
* `w ≥ m` vs `w > m` — PROVABLY unpinnable, and documented at the site rather
  than left looking guarded. `w` only ever decreases from `m`, so `w ≥ m` holds
  exactly when `w = m`, and there the march spans a single fix: `durS = 0` and
  `netM = 0` fail the run bars immediately below. The check is a pure
  short-circuit. Kept as the TS has it.

Why the first pass could not reach four of these: the dwell tether is invisible
unless the step INTO the march is slower than `MARCH_STILL_KMH`. A march setting
out from far away is reached by a FAST step, so the backward scan runs straight
past it into the dwell and `fromDwell[w]` reads zero — the gate never decides.
Crossing a long indoor gap first is what makes it decide.

UNPROVEN; pinned against Node/V8 (`lean/experiments/ride-head-refs.mts`).
-/

namespace RideHead

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint meanCadenceSpm PEDESTRIAN_STEP_MAX_KMH
  PEDESTRIAN_MIN_RUN_NET_M PEDESTRIAN_MIN_RUN_S PEDESTRIAN_MIN_CADENCE_SPM)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF median jsRound segMode sortedIn walkRemainder)

/-- Per-step pace marking a stay-tail fix as the ride moving. -/
def RIDE_HEAD_STEP_KMH : Float := 15
/-- From the first ride step to the stay's last fix must displace a real
inter-station distance — a lone urban-canyon spike never qualifies. -/
def RIDE_HEAD_MIN_NET_M : Float := 250
/-- The march must set out from the stay itself. -/
def MARCH_START_MAX_FROM_DWELL_M : Float := 150
/-- After the first ride step the fixes must never come back within this of the
dwell mass — an errand-and-back means the user never left for good. -/
def DWELL_RETURN_RADIUS_M : Float := 120
/-- The carve must leave a real stay behind; a platform-length "stay" belongs to
the boarding-platform absorber, not here. -/
def RIDE_HEAD_MIN_REMAINING_STAY_S : Int := 600
/-- Steps below this pace are standing (the platform wait), not marching. -/
def MARCH_STILL_KMH : Float := 2.5

private def stepKmh (fixes : Array PointF) (i j : Nat) : Float :=
  let dt := fixes[j]!.ts - fixes[i]!.ts
  if dt > 0 then
    haversineMeters fixes[i]!.lat fixes[i]!.lon fixes[j]!.lat fixes[j]!.lon / Float.ofInt dt * 3.6
  else 0

private def stats (points : Array PointF) (startTs endTs : Int) : Nat × Float × Float :=
  let speeds := (points.filter fun p => p.ts ≥ startTs && p.ts < endTs).map (·.speedKmh)
  let mx : Float := if speeds.isEmpty then 0 else speeds.foldl max speeds[0]!
  (speeds.size, jsRound (median speeds * 10) / 10, jsRound (mx * 10) / 10)

/-- Median of `values` weighted by `holds`: the first value, in ascending order,
at which the cumulative weight reaches half the total. -/
private def weightedMedian (values holds : Array Float) : Float := Id.run do
  let order := (((Array.range values.size).map fun j => (values[j]!, holds[j]!)).toList.mergeSort
    fun a b => a.1 ≤ b.1).toArray
  let half := (order.foldl (fun s e => s + e.2) 0) / 2
  let mut acc : Float := 0
  for e in order do
    acc := acc + e.2
    if acc ≥ half then return e.1
  return order[order.size - 1]!.1

/-- Claim a ride's head — the station walk, the platform wait, and the first
tunnel-reacquire fixes — out of the STAY that precedes a train leg. -/
def claimRideHeadFromStay (segments : Array Seg) (points : Array PointF)
    (steps : List FeasibilityStepPoint) : Array Seg := Id.run do
  if steps.isEmpty then return segments
  let mut segs := segments
  let mut out : Array Seg := #[]
  for i in [0:segs.size] do
    let cur := segs[i]!
    let carved : Option (Seg × Seg × Seg) := Id.run do
      if i + 1 ≥ segs.size then return none
      let next := segs[i + 1]!
      if !(segMode cur == "stationary" && segMode next == "train") then return none
      let fixes := sortedIn points cur.startTs cur.endTs
      let n := fixes.size
      if n < 8 then return none
      -- How long each fix's position HELD, so the dwell outweighs a dense tail.
      let holdS := (Array.range n).map fun j =>
        if j < n - 1 then max (Float.ofInt (fixes[j + 1]!.ts - fixes[j]!.ts)) 1 else 1
      let dwellLat := weightedMedian (fixes.map (·.lat)) holdS
      let dwellLon := weightedMedian (fixes.map (·.lon)) holdS
      let fromDwell := fixes.map fun f => haversineMeters f.lat f.lon dwellLat dwellLon
      -- The closest any fix from j onward comes back to the dwell.
      let minAfter := Id.run do
        let mut m := fromDwell
        for k in [0:n - 1] do
          let j := n - 2 - k
          m := m.set! j (min m[j]! m[j + 1]!)
        return m
      -- The ride: first vehicle-paced step whose suffix never returns.
      let r := Id.run do
        for j in [1:n] do
          if stepKmh fixes (j - 1) j ≥ RIDE_HEAD_STEP_KMH && minAfter[j]! > DWELL_RETURN_RADIUS_M then
            return j
        return 0
      if r < 1 then return none
      let rideNetM :=
        haversineMeters fixes[r - 1]!.lat fixes[r - 1]!.lon fixes[n - 1]!.lat fixes[n - 1]!.lon
      if rideNetM < RIDE_HEAD_MIN_NET_M then return none
      -- March end: strip the standing platform wait off the pedestrian run.
      let mut m := r - 1
      for _ in [0:n] do
        if m > 0 && stepKmh fixes (m - 1) m < MARCH_STILL_KMH then m := m - 1 else break
      -- March start: the maximal contiguous moving run ending at m. The step
      -- INTO the dwell's last fix spans the still dwell (often a long indoor fix
      -- gap), so its pace is negligible and the scan stops there.
      let mut w := m
      for _ in [0:n] do
        if w > 0 && stepKmh fixes (w - 1) w ≥ MARCH_STILL_KMH then w := w - 1 else break
      -- PROVABLY unpinnable (probed at zero): `w` only decreases from `m`, so
      -- this fires exactly at `w = m`, where the march spans one fix and the
      -- `durS`/`netM` bars below refuse it anyway. A pure short-circuit.
      if w ≥ m then return none
      -- Four-signal walk evidence over the march, plus two placement gates.
      let durS := fixes[m]!.ts - fixes[w]!.ts
      let netM := haversineMeters fixes[w]!.lat fixes[w]!.lon fixes[m]!.lat fixes[m]!.lon
      let pedestrianPaced := (Array.range (m - w)).all fun k =>
        stepKmh fixes (w + k) (w + k + 1) ≤ PEDESTRIAN_STEP_MAX_KMH
      let cadenceOk := match meanCadenceSpm steps fixes[w]!.ts fixes[m]!.ts with
        | none => false
        | some c => c ≥ PEDESTRIAN_MIN_CADENCE_SPM
      if !pedestrianPaced || Float.ofInt durS < PEDESTRIAN_MIN_RUN_S
         || netM < PEDESTRIAN_MIN_RUN_NET_M || !cadenceOk
         || fromDwell[w]! > MARCH_START_MAX_FROM_DWELL_M
         || fixes[w]!.ts - cur.startTs < RIDE_HEAD_MIN_REMAINING_STAY_S then return none
      -- Carve: stay | walk (the march) | train (wait + reacquire fixes on).
      let walkStart := fixes[w]!.ts
      let rideStart := fixes[m]!.ts
      let (sc, sa, sm) := stats points cur.startTs walkStart
      let (tc, ta, tm) := stats points rideStart next.endTs
      let reason := s!"extended back over the boarding: claimed a {toString (jsRound netM).toInt64.toInt} m station walk + the ride's reacquire fixes out of the preceding stay"
      return some
        ({ cur with endTs := walkStart, avgSpeed := sa, maxSpeed := sm, pointCount := Int.ofNat sc },
         walkRemainder { cur with mode := "walking" } walkStart rideStart points false,
         { next with
           startTs := rideStart, avgSpeed := ta, maxSpeed := tm, pointCount := Int.ofNat tc
           refinedReason := some (match next.refinedReason with
             | some r => s!"{r}; {reason}"
             | none => reason) })
    match carved with
    | none => out := out.push cur
    | some (stay, walk, train) =>
      out := (out.push stay).push walk
      segs := segs.set! (i + 1) train
  return out

/-! ### Reference values

Pinned against Node/V8 (`lean/experiments/ride-head-refs.mts`).
-/

section RideHeadGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def fx (ts : Int) (metresNorth speedKmh : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }
#guard (fx 0 4000 0).lat == 51.55593244699964

private def sg (startTs endTs : Int) (mode : String := "stationary")
    (refinedMode : Option String := none) (refinedReason : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode, refinedReason
    avgSpeed := 0, maxSpeed := 1, linearity := 0.1, pointCount := 14 }

private def SEGS : Array Seg := #[sg 0 4000, sg 4000 6000 "train"]

/-- Four sparse dwell fixes, a 300 s march, a standing wait, then the ride. -/
private def FIXES : Array PointF :=
  #[fx 0 0 0, fx 1000 5 0, fx 2000 3 0, fx 3000 4 0,
    fx 3100 10 3.6, fx 3200 110 3.6, fx 3300 210 3.6, fx 3400 310 3.6,
    fx 3500 315 0.2, fx 3600 318 0.1,
    fx 3700 1000 25, fx 3800 2000 30, fx 3900 3000 32, fx 4000 4000 34]

private def stepsAt (spm : Float) (from_ to : Int) : List FeasibilityStepPoint :=
  (List.range (((to - from_) + 59) / 60).toNat).map fun k =>
    { ts := from_ + 60 * Int.ofNat k, steps := spm }
private def STEPS : List FeasibilityStepPoint := stepsAt 80 3100 3400

/-- Swap the march fixes, keeping dwell + wait + ride. -/
private def withMarch (march : Array PointF) : Array PointF :=
  FIXES.extract 0 4 ++ march ++ FIXES.extract 8 14

private structure RRow where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  reenrich : Bool
  reason : String
  deriving Inhabited, BEq, Repr

private def rv (segs : Array Seg) : Array RRow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode
      refinedMode := s.refinedMode.getD "", pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, linearity := s.linearity
      reenrich := s.needsReenrich, reason := s.refinedReason.getD "" }

private def rrun (segs : Array Seg := SEGS) (pts : Array PointF := FIXES)
    (st : List FeasibilityStepPoint := STEPS) : Array RRow :=
  rv (claimRideHeadFromStay segs pts st)

private def reasonM (m : String) : String :=
  s!"extended back over the boarding: claimed a {m} m station walk + the ride's reacquire fixes out of the preceding stay"
private def REASON : String := reasonM "300"

-- stay | walk | train — the stay is cut back, a walk is INVENTED, and the train
-- extends back over the platform wait and the reacquire fixes.
--
-- This guard ALSO pins the time-weighted dwell median: 4 dwell fixes against 10
-- tail fixes, so an unweighted median would sit ~200 m into the march and the
-- MARCH_START_MAX_FROM_DWELL_M gate would refuse the carve outright.
#guard rrun == #[
  { startTs := 0, endTs := 3100, mode := "stationary", refinedMode := "", pointCount := 4,
    avgSpeed := 0, maxSpeed := 0, linearity := 0.1, reenrich := false, reason := "" },
  { startTs := 3100, endTs := 3400, mode := "walking", refinedMode := "", pointCount := 3,
    avgSpeed := 3.6, maxSpeed := 3.6, linearity := 1, reenrich := true, reason := "" },
  { startTs := 3400, endTs := 6000, mode := "train", refinedMode := "", pointCount := 7,
    avgSpeed := 25, maxSpeed := 34, linearity := 0.1, reenrich := false, reason := REASON }]

-- WHO MAY PARTICIPATE.
#guard rrun SEGS FIXES [] == rv SEGS
#guard rrun #[sg 0 4000 "walking", sg 4000 6000 "train"] == rv #[sg 0 4000 "walking", sg 4000 6000 "train"]
#guard rrun #[sg 0 4000, sg 4000 6000 "driving"] == rv #[sg 0 4000, sg 4000 6000 "driving"]
-- Both sides read segMode, so refinedMode promotions count.
#guard (rrun #[sg 0 4000 "walking" (some "stationary"), sg 4000 6000 "driving" (some "train")]).size == 3
#guard rrun #[sg 0 4000] == rv #[sg 0 4000]
-- Fewer than 8 fixes in the stay.
#guard rrun SEGS (FIXES.extract 0 3 ++ FIXES.extract 10 14) == rv SEGS

-- THE RIDE TEST. No vehicle-paced step at all.
#guard rrun SEGS
  (FIXES.extract 0 10 ++ #[fx 3700 330 3, fx 3800 350 3, fx 3900 370 3, fx 4000 390 3]) == rv SEGS
-- AN ERRAND AND BACK: there IS a fast step, but the fixes afterwards come back
-- inside DWELL_RETURN_RADIUS_M — the user never left for good.
#guard rrun SEGS
  (FIXES.extract 0 10 ++ #[fx 3700 1000 25, fx 3800 500 25, fx 3900 80 25, fx 4000 50 3]) == rv SEGS
-- A ride net BETWEEN 250 and 2000: carves at the real bar, and would be
-- refused if the bar were raised — so the constant's VALUE is pinned.
#guard (rrun SEGS
  (FIXES.extract 0 10 ++ #[fx 3700 800 25, fx 3800 850 5, fx 3900 870 5, fx 4000 880 5])).size == 3
-- The ride's net displacement is under RIDE_HEAD_MIN_NET_M.
#guard rrun SEGS
  (FIXES.extract 0 10 ++ #[fx 3700 500 25, fx 3800 520 3, fx 3900 540 3, fx 4000 560 3]) == rv SEGS

-- THE MARCH. No march at all: the fixes step straight from dwell into the wait.
#guard rrun SEGS
  (FIXES.extract 0 4 ++ #[fx 3100 5 0.1, fx 3200 6 0.1, fx 3300 7 0.1, fx 3400 8 0.1]
   ++ FIXES.extract 8 14) == rv SEGS
-- A step in the march ABOVE the pedestrian ceiling.
#guard rrun SEGS (withMarch #[fx 3100 10 3.6, fx 3200 110 3.6, fx 3300 210 3.6, fx 3400 610 14.4])
  == rv SEGS
-- Too short in time, and too short in net ground.
#guard rrun SEGS (withMarch #[fx 3320 10 3.6, fx 3340 40 5.4, fx 3370 80 4.8, fx 3400 130 6]) == rv SEGS
#guard rrun SEGS (withMarch #[fx 3100 10 1, fx 3200 40 1, fx 3300 70 1, fx 3400 100 1]) == rv SEGS
-- Cadence below the bar, and no cadence data over the march window at all.
#guard rrun SEGS FIXES (stepsAt 30 3100 3400) == rv SEGS
#guard rrun SEGS FIXES (stepsAt 80 100 400) == rv SEGS
-- The march sets out from somewhere ELSE, beyond MARCH_START_MAX_FROM_DWELL_M.
#guard rrun SEGS (withMarch #[fx 3100 200 3.6, fx 3200 300 3.6, fx 3300 400 3.6, fx 3400 500 3.6])
  == rv SEGS

-- RIDE_HEAD_MIN_REMAINING_STAY_S needs its OWN geometry: simply moving the
-- stay's startTs also drops the early dwell fixes, which moves the time-weighted
-- dwell mass into the march and refuses for the wrong reason. Here one
-- long-held dwell fix still outweighs the whole 420 s tail, and the march opens
-- exactly 600 s after the stay's start.
private def BAR_FIXES : Array PointF :=
  #[fx 0 0 0, fx 600 10 6, fx 660 110 6, fx 720 210 6, fx 780 310 6,
    fx 840 315 0.3, fx 900 1000 41, fx 960 2000 40, fx 1020 3000 42]
private def BAR_STEPS : List FeasibilityStepPoint := stepsAt 80 600 780
#guard (rrun #[sg 0 1100, sg 1100 3000 "train"] BAR_FIXES BAR_STEPS).size == 3
#guard (rrun #[sg 0 1100, sg 1100 3000 "train"] BAR_FIXES BAR_STEPS)[0]!.endTs == 600
-- One second under the bar: refused.
-- The dwell fix must be INSIDE the shifted window, or the dwell mass moves into
-- the march and the refusal is for the wrong reason.
private def BAR_FIXES1 : Array PointF := #[fx 1 0 0] ++ BAR_FIXES.extract 1 9
#guard rrun #[sg 1 1100, sg 1100 3000 "train"] BAR_FIXES1 BAR_STEPS
  == rv #[sg 1 1100, sg 1100 3000 "train"]

-- The train already carries a reason: the new one is APPENDED after "; ".
#guard (rrun #[sg 0 4000, sg 4000 6000 "train" none (some "Victoria Line")])[2]!.reason
  == s!"Victoria Line; {REASON}"

#guard rrun #[] #[] [] == #[]

/-! #### Second probe pass

The eight choices the first pass left unpinned. Each needed a case that reaches
its gate with every OTHER gate satisfied — the recurring failure above was a
fixture that refused for the wrong reason.

The shared skeleton is a dwell at the frame origin, a LONG indoor gap, a
pedestrian march, a standing wait, and a two-fix ride. That gap is the crux and
is why the first pass could not pin the dwell tether at all: a march setting out
from far away is reached by a FAST step, so the backward scan runs on past it
into the dwell and `fromDwell[w]` reads zero. Crossing 600 s of stillness first
makes the step into the march slower than `MARCH_STILL_KMH`, so `w` stays put
and the tether is the only thing deciding.
-/

/-- Dwell → 600 s gap → 200 m march → wait → ride, the march opening `startM`
north of the dwell. `startM` moves nothing but `fromDwell[w]`. -/
private def farMarch (startM : Float) : Array PointF :=
  #[fx 0 0 0, fx 1200 0 0,
    fx 1800 startM 3.6, fx 1900 (startM + 100) 3.6, fx 2000 (startM + 200) 3.6,
    fx 2100 (startM + 205) 0.2, fx 2200 (startM + 1100) 30, fx 2300 (startM + 2300) 34]
private def FAR_SEGS : Array Seg := #[sg 0 2300, sg 2300 4000 "train"]
private def FAR_STEPS : List FeasibilityStepPoint := stepsAt 80 1800 2000

private def FAR_CARVED : Array RRow :=
  #[{ startTs := 0, endTs := 1800, mode := "stationary", refinedMode := "", pointCount := 2,
      avgSpeed := 0, maxSpeed := 0, linearity := 0.1, reenrich := false, reason := "" },
    { startTs := 1800, endTs := 2000, mode := "walking", refinedMode := "", pointCount := 2,
      avgSpeed := 3.6, maxSpeed := 3.6, linearity := 1, reenrich := true, reason := "" },
    { startTs := 2000, endTs := 4000, mode := "train", refinedMode := "", pointCount := 4,
      avgSpeed := 16.8, maxSpeed := 34, linearity := 0.1, reenrich := false, reason := reasonM "200" }]

-- MARCH_START_MAX_FROM_DWELL_M: a straddling pair, so the VALUE is pinned and
-- not merely its side. Nothing differs between these but where the march opens.
#guard rrun FAR_SEGS (farMarch 140) FAR_STEPS == FAR_CARVED
#guard rrun FAR_SEGS (farMarch 160) FAR_STEPS == rv FAR_SEGS

-- The `n < 8` floor. Drop ONE dwell fix and the same anatomy — same march, same
-- ride, same dwell position, every other gate still clear — is refused.
#guard rrun FAR_SEGS ((farMarch 140).extract 0 1 ++ (farMarch 140).extract 2 8) FAR_STEPS
  == rv FAR_SEGS

/-- The march stretched over `durS` seconds of 150 m ground — clear of
`PEDESTRIAN_MIN_RUN_NET_M` either way, so only the duration bar is in play. -/
private def marchOver (durS : Int) : Array PointF :=
  #[fx 0 0 0, fx 1200 0 0,
    fx 1800 140 5.4, fx (1800 + durS / 2) 215 5.4, fx (1800 + durS) 290 5.4,
    fx (1900 + durS) 295 0.2, fx (2000 + durS) 1200 32, fx (2100 + durS) 2400 34]
private def marchOverSegs (durS : Int) : Array Seg :=
  #[sg 0 (2100 + durS), sg (2100 + durS) 4000 "train"]

-- PEDESTRIAN_MIN_RUN_S. The `marchTooBrief` case above also fails the net bar
-- (its 120 m reads 119.9 through the haversine); these clear it by 30 m and
-- straddle the 90 s bar alone.
#guard rrun (marchOverSegs 80) (marchOver 80) (stepsAt 80 1800 1880) == rv (marchOverSegs 80)
#guard rrun (marchOverSegs 100) (marchOver 100) (stepsAt 80 1800 1900) == #[
  { startTs := 0, endTs := 1800, mode := "stationary", refinedMode := "", pointCount := 2,
    avgSpeed := 0, maxSpeed := 0, linearity := 0.1, reenrich := false, reason := "" },
  { startTs := 1800, endTs := 1900, mode := "walking", refinedMode := "", pointCount := 2,
    avgSpeed := 5.4, maxSpeed := 5.4, linearity := 1, reenrich := true, reason := "" },
  { startTs := 1900, endTs := 4000, mode := "train", refinedMode := "", pointCount := 4,
    avgSpeed := 18.7, maxSpeed := 34, linearity := 0.1, reenrich := false, reason := reasonM "150" }]

/-- The march runs SOUTH, so anything pushing the weighted median PAST the dwell
lands on the ride's far end and the tether refuses. Shared by the two fixtures
that perturb how `half` is computed. -/
private def southMarch (head : Array PointF) (lastGapS : Int) : Array PointF :=
  head ++ #[fx 1800 (-140) 5.4, fx 1850 (-215) 5.4, fx 1900 (-290) 5.4,
            fx 2000 (-295) 0.2, fx 2100 1200 53, fx (2100 + lastGapS) 2400 20]
private def SOUTH_STEPS : List FeasibilityStepPoint := stepsAt 80 1800 1900

private def southCarved (stayCount : Int) (trainEnd : Int) (stayMax : Float) : Array RRow :=
  #[{ startTs := 0, endTs := 1800, mode := "stationary", refinedMode := "", pointCount := stayCount,
      avgSpeed := 0, maxSpeed := stayMax, linearity := 0.1, reenrich := false, reason := "" },
    { startTs := 1800, endTs := 1900, mode := "walking", refinedMode := "", pointCount := 2,
      avgSpeed := 5.4, maxSpeed := 5.4, linearity := 1, reenrich := true, reason := "" },
    { startTs := 1900, endTs := trainEnd, mode := "train", refinedMode := "", pointCount := 4,
      avgSpeed := 12.7, maxSpeed := 53, linearity := 0.1, reenrich := false, reason := reasonM "150" }]

-- The `/ 2` in `half`. A 400 m southern outlier holding just over a QUARTER of
-- the total time: the median stays at the dwell, but a quartile would land on
-- the outlier and read the march as setting out 540 m from the "dwell".
#guard rrun #[sg 0 2200, sg 2200 4000 "train"]
  (southMarch #[fx 0 (-400) 2, fx 700 0 0, fx 1400 0 0] 100) SOUTH_STEPS
  == southCarved 3 4000 2

-- `acc ≥ half` at an EXACT tie: the dwell holds 2100 s of a 4200 s total, so
-- the cumulative weight lands on half to the second. Under `>` the median falls
-- through to the ride's first fix, 1340 m away, and the tether refuses.
#guard rrun #[sg 0 4199, sg 4199 6000 "train"]
  (southMarch #[fx 0 0 0, fx 1200 0 0] 2099) SOUTH_STEPS
  == southCarved 2 6000 0

-- `holdS`'s `max(…, 1)` floor. The same tie, but one unit of the dwell's weight
-- now comes from a DUPLICATE timestamp: without the floor that fix holds for
-- zero seconds, the tie breaks the other way, and the carve is refused.
#guard rrun #[sg 0 4200, sg 4200 6000 "train"]
  (southMarch #[fx 0 0 0, fx 0 0 0, fx 1200 0 0] 2100) SOUTH_STEPS
  == southCarved 3 6000 0

end RideHeadGuards

end RideHead

/-! ## Walk→stay arrival boundary (`claimStayArrivalFromWalk`)

The pedestrian mirror of `RideHead`: that namespace carves a ride's HEAD out of
the stay before it, this one gives a walk's TAIL to the stay after it. -/
namespace FootArrival

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF segMode sortedIn walkRemainder median jsRound)
open RideHead (MARCH_STILL_KMH stepKmh)

/-- Noise floor on the trailing still run, NOT the discriminator: the run is
anchored at the walk's LAST fix, so a pause at a crossing cannot qualify —
the walking that follows one breaks the run before it reaches the end. -/
def FOOT_ARRIVAL_MIN_DWELL_S : Int := 60
/-- Above this the tail is slow movement, not a held position, and where the
walk ended is no longer readable from it. Observed arrivals sit at 1–9 m. -/
def FOOT_ARRIVAL_SPREAD_MAX_M : Float := 30
/-- Never annihilate the walk: a correction leaving no walk behind is a
reclassification, which is not this pass's decision. -/
def FOOT_ARRIVAL_MIN_WALK_REMAINDER_S : Int := 60

/-- Index of the first fix of the trailing run of standing fixes. -/
private def arrivalIdx (fixes : Array PointF) : Nat := Id.run do
  let mut k := fixes.size - 1
  while k > 0 do
    if stepKmh fixes (k - 1) k < MARCH_STILL_KMH then k := k - 1 else break
  return k

/-- Move a walk→stay boundary back to the moment the walking actually stopped.

`segments.ts` classifies in 300 s windows, so the window straddling an arrival
is scored whole and its walking half carries the verdict; the stay starts up to
a window late. Only ever moves the boundary BACK, and only when the walk's own
tail is a held position. Marks the shortened walk `needsReenrich` — a walk
trimmed of its arrival can belong to a different street than the one it
overran onto. -/
def claimStayArrivalFromWalk (segments : Array Seg) (points : Array PointF) : Array Seg := Id.run do
  let mut segs := segments
  let mut out : Array Seg := #[]
  for i in [0:segs.size] do
    let cur := segs[i]!
    let moved : Option (Seg × Seg) := Id.run do
      if i + 1 ≥ segs.size then return none
      let next := segs[i + 1]!
      if !(segMode cur == "walking" && segMode next == "stationary") then return none
      let fixes := sortedIn points cur.startTs cur.endTs
      if fixes.size < 4 then return none
      let k := arrivalIdx fixes
      let run := fixes.extract k fixes.size
      if run.size < 2 then return none
      let arrivalTs := run[0]!.ts
      let durS := run[run.size - 1]!.ts - arrivalTs
      if durS < FOOT_ARRIVAL_MIN_DWELL_S then return none
      let cLat := (run.foldl (fun s p => s + p.lat) 0) / Float.ofNat run.size
      let cLon := (run.foldl (fun s p => s + p.lon) 0) / Float.ofNat run.size
      let spreadM := run.foldl (fun m p => max m (haversineMeters cLat cLon p.lat p.lon)) 0
      if spreadM > FOOT_ARRIVAL_SPREAD_MAX_M then return none
      if arrivalTs - cur.startTs < FOOT_ARRIVAL_MIN_WALK_REMAINDER_S then return none
      if cur.endTs - arrivalTs ≤ 0 then return none
      let movedS := cur.endTs - arrivalTs
      let reason := s!"arrival boundary moved back {movedS} s: the walk's tail held position within {Float.round spreadM} m for {durS} s"
      -- `walkRemainder` is the family's rebuild: it recomputes pointCount /
      -- avgSpeed / maxSpeed / linearity over the new window and clears the
      -- enrichment derived from the old one. By hand the walk would keep an
      -- avgSpeed the standing tail dragged down — the very seconds this pass
      -- has just taken away from it.
      let rebuilt := walkRemainder cur cur.startTs arrivalTs points
      let walk := { rebuilt with refinedReason := some reason }
      -- The stay keeps its enrichment (same place, entered earlier) but its
      -- window grew, so its sample-derived fields are recomputed over it.
      let stayFixes := points.filter fun p => p.ts ≥ arrivalTs && p.ts < next.endTs
      let staySpeeds := stayFixes.map (·.speedKmh)
      let stay :=
        if staySpeeds.isEmpty then { next with startTs := arrivalTs, pointCount := 0 }
        else
          let avg := jsRound (median staySpeeds * 10) / 10
          let mx := jsRound ((staySpeeds.foldl max staySpeeds[0]!) * 10) / 10
          { next with startTs := arrivalTs, pointCount := Int.ofNat stayFixes.size, avgSpeed := avg, maxSpeed := mx }
      return some (walk, stay)
    match moved with
    | some (walk, stay) =>
      out := out.push walk
      segs := segs.set! (i + 1) stay
    | none => out := out.push cur
  return out


/-! ### Guards — pinned against V8 on the same construction
`tests/stay-arrival-claim.test.ts` builds. -/
namespace FootArrivalGuards

open Verified.Geo.SegmentMerge (Seg)
open Shed (PointF)

private def T0 : Int := 1000000
private def ORIGIN : Float := 51.0
private def northM (m : Float) : Float := ORIGIN + m / 111195

private def fx (ts : Int) (m : Float) : PointF := ⟨ts, northM m, 0, 0⟩

/-- 10 min walking at ~5.5 km/h (a fix every 28 s, 43 m a step), then a held
position jittering within `spread` m for `dwellS`. -/
private def arrivalDay (dwellS : Int) (spread : Float := 4) : Array PointF := Id.run do
  let mut pts : Array PointF := #[]
  let mut m : Float := 0
  let mut ts : Int := T0
  while ts < T0 + 600 do
    pts := pts.push (fx ts m)
    m := m + 43
    ts := ts + 28
  let arrival := ts
  let mut j : Nat := 0
  while ts ≤ arrival + dwellS do
    pts := pts.push (fx ts (if j % 2 == 0 then m else m + spread))
    ts := ts + 28
    j := j + 1
  return pts

private def walkSeg (endTs : Int) : Seg := { startTs := T0, endTs, mode := "walking" }
private def staySeg (startTs : Int) : Seg := { startTs, endTs := startTs + 3600, mode := "stationary" }

/-- The walk runs to T0+784; the walking stops at T0+616. -/
private def dayFor (dwellS : Int) (spread : Float := 4) : Array Seg × Array PointF :=
  let pts := arrivalDay dwellS spread
  let walkEnd := pts[pts.size - 1]!.ts + 28
  (#[walkSeg walkEnd, staySeg walkEnd], pts)

private def runOn (dwellS : Int) (spread : Float := 4) : Array Seg :=
  let (segs, pts) := dayFor dwellS spread
  FootArrival.claimStayArrivalFromWalk segs pts

-- The boundary lands on the first standing fix, not on the segmenter's window
-- edge: 1000616, where HEAD left it at 1000784 (168 s late).
#guard (runOn 140)[0]!.endTs == 1000616
#guard (runOn 140)[0]!.needsReenrich == true
-- Time is moved, never dropped: the stay picks up exactly what the walk gave up.
#guard (runOn 140)[1]!.startTs == (runOn 140)[0]!.endTs
#guard (runOn 140)[0]!.startTs == 1000000

-- A 56 s pause is under the noise floor and does not move anything.
#guard (runOn 56)[0]!.endTs == ((dayFor 56).1)[0]!.endTs
#guard (runOn 56)[0]!.needsReenrich == false
-- A tail that drifts 80 m is slow movement, not an arrival.
#guard (runOn 140 80)[0]!.endTs == ((dayFor 140 80).1)[0]!.endTs

-- Only a walk followed by a STAY is eligible.
#guard
  let (segs, pts) := dayFor 140
  let toTrain := #[segs[0]!, { segs[1]! with mode := "train" }]
  (FootArrival.claimStayArrivalFromWalk toTrain pts)[0]!.endTs == segs[0]!.endTs

end FootArrivalGuards

end FootArrival

/-! ## `splitStaysOnEvidence`

A stay is one segment because the GPS never moved — but a phone that sits in a
pocket through a walk to the shops and back looks exactly like a phone on a
table, so `findStays` swallows the errand. This pass re-reads each stay's own fix
sequence and asks, at every gap long enough to hide a departure, whether the
BIOMETRICS say the wearer left: step density above all, with the gap's anomaly
against the run's own rhythm, HR elevation and post-gap proximity as supporting
signals (`scoreSplitEvidence`, at the top of this file).

Where the evidence carries, the stay is cut and an explicit `unknown` segment is
emitted BETWEEN the sub-stays — the honest "no coverage here" rather than two
stays that `mergeAdjacent` would quietly stitch back together. The sub-stays
inherit the parent's metadata so the place label survives the split; the
`unknown` inherits NOTHING, being built from scratch.

Three details worth naming, each pinned by its own case:

* the run centroid is a RUNNING MEAN over the sub-run so far — not the last fix,
  not the segment's centroid — so the proximity counter-evidence is measured
  against where the wearer has actually been sitting;
* a long gap that does NOT split still joins `priorGapsInRun`, raising the median
  the NEXT gap is judged against: one unexplained silence makes the next silence
  less anomalous;
* the step and HR windows are STRICT at both ends, so a sample landing exactly on
  a bracketing fix belongs to neither side.

Unlike almost every sibling pass in this file, entry is gated on the RAW
`seg.mode`, not `segMode` — a refinement in either direction is ignored.

UNPROVEN; pinned against Node/V8 (`lean/experiments/split-stays-refs.mts`).
-/

namespace Stays

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF median jsRound sortedIn)
open Verified.Geo.StaySplit (scoreSplitEvidence SPLIT_THRESHOLD_NATS)

/-- An HR sample as this pass reads it. -/
structure HrPoint where
  ts : Int
  bpm : Float
  deriving Inhabited, BEq, Repr

/-- The biometric side-channels the split scorer weighs. -/
structure SplitContext where
  hr : Array HrPoint := #[]
  steps : Array FeasibilityStepPoint := #[]
  deriving Inhabited

/-- Shorter in-stay gaps are ordinary GPS jitter and are never scored. -/
def MIN_GAP_TO_EVALUATE_S : Int := 15 * 60

/-- Walk the fixes in time order, accumulating into sub-runs; close a run when
the gap to the next fix scores above `SPLIT_THRESHOLD_NATS`. -/
def splitByEvidence (fixes : Array PointF) (ctx : SplitContext) : Array (Array PointF) := Id.run do
  let mut runs : Array (Array PointF) := #[#[fixes[0]!]]
  let mut priorGaps : Array Float := #[]
  let mut cLat := fixes[0]!.lat
  let mut cLon := fixes[0]!.lon
  for i in [1:fixes.size] do
    let prev := fixes[i - 1]!
    let cur := fixes[i]!
    let gapS := cur.ts - prev.ts
    -- Only a gap long enough to hide a departure is worth scoring.
    let split :=
      if gapS < MIN_GAP_TO_EVALUATE_S then false
      else
        let inGap (ts : Int) : Bool := ts > prev.ts && ts < cur.ts
        let stepsInGap := ctx.steps.foldl (fun s p => if inGap p.ts then s + p.steps else s) 0
        let hrInGap := ctx.hr.filter fun h => inGap h.ts
        let score := scoreSplitEvidence
          { gapDurationS := Float.ofInt gapS
            medianPriorGapS := if priorGaps.isEmpty then 0 else median priorGaps
            preGapFixCount := Int.ofNat runs[runs.size - 1]!.size
            stepsInGap
            hrMeanInGap :=
              if hrInGap.isEmpty then none
              else some ((hrInGap.foldl (fun s h => s + h.bpm) 0) / Float.ofNat hrInGap.size)
            hrSamplesInGap := Int.ofNat hrInGap.size
            postGapDistFromCentroidM := haversineMeters cLat cLon cur.lat cur.lon }
        score > SPLIT_THRESHOLD_NATS
    if split then
      runs := runs.push #[cur]
      priorGaps := #[]
      cLat := cur.lat
      cLon := cur.lon
    else
      -- Joined: the gap enters the run's rhythm whether it was scored or not.
      let run := runs[runs.size - 1]!.push cur
      runs := runs.set! (runs.size - 1) run
      priorGaps := priorGaps.push (Float.ofInt gapS)
      cLat := cLat + (cur.lat - cLat) / Float.ofNat run.size
      cLon := cLon + (cur.lon - cLon) / Float.ofNat run.size
  return runs

/-- Re-evaluate `findStays` output: split a stay wherever the biometrics say the
wearer left mid-stay, recording the uncovered interval as an `unknown` segment. -/
def splitStaysOnEvidence (segments : Array Seg) (points : Array PointF)
    (ctx : SplitContext) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  for seg in segments do
    let segFixes := sortedIn points seg.startTs seg.endTs
    let subRuns :=
      if seg.mode != "stationary" || seg.pointCount < 2 || segFixes.size < 2 then #[]
      else splitByEvidence segFixes ctx
    if subRuns.size ≤ 1 then
      out := out.push seg
    else
      for i in [0:subRuns.size] do
        let run := subRuns[i]!
        out := out.push
          { seg with
            startTs := run[0]!.ts, endTs := run[run.size - 1]!.ts
            pointCount := Int.ofNat run.size }
        if i < subRuns.size - 1 then
          let gapStart := run[run.size - 1]!.ts
          let gapEnd := subRuns[i + 1]![0]!.ts
          let mins := toString (jsRound (Float.ofInt (gapEnd - gapStart) / 60)).toInt64.toInt
          out := out.push
            { startTs := gapStart, endTs := gapEnd, mode := "unknown"
              confidence := 0.1, confidenceMargin := 1
              avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := 0
              refinedReason := some s!"no GPS coverage for {mins} min (mid-stay departure inferred from biometric / fix-density evidence)" }
  return out

end Stays

section StaysGuards

open Stays
open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint)
open Shed (PointF)

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def fx (ts : Int) (metresNorth : Float) : PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh := 0 }

private def stay : Seg :=
  { startTs := 0, endTs := 100000, mode := "stationary"
    confidence := 0.8, confidenceMargin := 2
    avgSpeed := 0, maxSpeed := 1, linearity := 0.1, pointCount := 9, place := some "Home" }
private def STAY : Array Seg := #[stay]

/-- `n` step buckets of `spm` each, one per minute from `from_`. -/
private def stepsFrom (spm : Float) (from_ : Int) (n : Nat) : Array FeasibilityStepPoint :=
  (Array.range n).map fun k => { ts := from_ + 60 * Int.ofNat k, steps := spm }
private def hrFrom (bpm : Float) (from_ : Int) (n : Nat) : Array HrPoint :=
  (Array.range n).map fun k => { ts := from_ + 60 * Int.ofNat k, bpm }

/-- Four dense fixes, a `gapS` silence, then three more. -/
private def acrossGap (gapS : Int) : Array PointF :=
  #[fx 0 0, fx 300 0, fx 600 0, fx 900 0,
    fx (900 + gapS) 500, fx (1200 + gapS) 500, fx (1500 + gapS) 500]

private structure SRow where
  startTs : Int
  endTs : Int
  mode : String
  pointCount : Int
  confidence : Float
  confidenceMargin : Float
  place : String
  reason : String
  deriving Inhabited, BEq, Repr

private def sv (segs : Array Seg) : Array SRow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode, pointCount := s.pointCount
      confidence := s.confidence, confidenceMargin := s.confidenceMargin
      place := s.place.getD "", reason := s.refinedReason.getD "" }

private def srun (segs : Array Seg := STAY) (pts : Array PointF := #[])
    (steps : Array FeasibilityStepPoint := #[]) (hr : Array HrPoint := #[]) : Array SRow :=
  sv (splitStaysOnEvidence segs pts { hr, steps })

private def gapReason (mins : String) : String :=
  s!"no GPS coverage for {mins} min (mid-stay departure inferred from biometric / fix-density evidence)"

/-- A sub-stay of the parent: inherits its confidence, margin and place. -/
private def sub (startTs endTs : Int) (pc : Int) : SRow :=
  { startTs, endTs, mode := "stationary", pointCount := pc
    confidence := 0.8, confidenceMargin := 2, place := "Home", reason := "" }
/-- The interleaved gap: built from scratch, so it inherits NOTHING. -/
private def gap (startTs endTs : Int) (mins : String) : SRow :=
  { startTs, endTs, mode := "unknown", pointCount := 0
    confidence := 0.1, confidenceMargin := 1, place := "", reason := gapReason mins }

-- 800 steps over the 30 min silence = 26.7/min, unambiguous walking: the stay
-- is cut and an `unknown` segment records the uncovered half hour.
#guard srun STAY (acrossGap 1800) (stepsFrom 100 960 8)
  == #[sub 0 900 4, gap 900 2700 "30", sub 2700 3300 3]
-- The same silence with no steps at all: sitting quietly, left alone.
#guard srun STAY (acrossGap 1800) == sv STAY

-- WHO PARTICIPATES. `seg.mode` is read RAW, so a refinement in EITHER direction
-- is ignored — unlike almost every sibling pass in this file.
#guard srun #[{ stay with mode := "walking" }] (acrossGap 1800) (stepsFrom 100 960 8)
  == sv #[{ stay with mode := "walking" }]
#guard srun #[{ stay with mode := "walking", refinedMode := some "stationary" }]
    (acrossGap 1800) (stepsFrom 100 960 8)
  == sv #[{ stay with mode := "walking", refinedMode := some "stationary" }]
#guard (srun #[{ stay with refinedMode := some "walking" }] (acrossGap 1800) (stepsFrom 100 960 8)).size == 3
-- The segment's own pointCount gates entry, whatever its fixes say.
#guard srun #[{ stay with pointCount := 1 }] (acrossGap 1800) (stepsFrom 100 960 8)
  == sv #[{ stay with pointCount := 1 }]
#guard (srun #[{ stay with pointCount := 2 }] (acrossGap 1800) (stepsFrom 100 960 8)).size == 3
-- …and the window must actually hold two fixes.
#guard srun #[{ stay with endTs := 100 }] (acrossGap 1800) (stepsFrom 100 960 8)
  == sv #[{ stay with endTs := 100 }]

-- MIN_GAP_TO_EVALUATE_S is a floor, not a strict bar: exactly 900 s is scored
-- (and splits), 899 s is joined without ever being looked at.
#guard srun STAY (acrossGap 900) (stepsFrom 100 960 8)
  == #[sub 0 900 4, gap 900 1800 "15", sub 1800 2400 3]
#guard srun STAY (acrossGap 899) (stepsFrom 100 960 8) == sv STAY

-- SPLIT_THRESHOLD_NATS is strict. 10 steps/min (2.0) with a 20x anomalous gap
-- (+0.5) lands on 2.5 EXACTLY and is refused; three elevated HR samples (+0.3)
-- clear it.
private def NEAR_BAR : Array PointF :=
  #[fx 0 0, fx 60 0, fx 120 0, fx 180 0, fx 240 0, fx 1440 500, fx 1740 500]
#guard srun STAY NEAR_BAR (stepsFrom 10 300 20) == sv STAY
#guard srun STAY NEAR_BAR (stepsFrom 10 300 20) (hrFrom 100 300 3)
  == #[sub 0 240 5, gap 240 1440 "20", sub 1440 1740 2]
-- The HR window is STRICT at both ends and needs three samples: pushing one of
-- the three onto the boundary fix drops the count to two and loses the +0.3.
#guard srun STAY NEAR_BAR (stepsFrom 10 300 20)
    #[{ ts := 240, bpm := 100 }, { ts := 360, bpm := 100 }, { ts := 420, bpm := 100 }]
  == sv STAY
-- The step window is strict too: 1200 steps sitting exactly ON the bracketing
-- fixes are not in the gap, and the score falls back to sitting.
#guard srun STAY (acrossGap 1800) #[{ ts := 900, steps := 600 }, { ts := 2700, steps := 600 }]
  == sv STAY

-- The run centroid is a RUNNING MEAN over the sub-run. The run sits at 0, 0, 0,
-- 0 and then 75 m, so its mean is 15 m: the post-gap fix at 25 m is 10 m from
-- that mean, close enough to spend the -0.5 and land the score on 2.5 exactly.
-- Measured from the LAST fix (50 m) or the FIRST (25 m) there is no penalty and
-- the stay splits.
#guard srun STAY
    #[fx 0 0, fx 60 0, fx 120 0, fx 180 0, fx 240 75, fx 3840 25, fx 4140 25]
    (stepsFrom 10 300 60)
  == sv STAY

-- A long gap that does NOT split still joins the run's rhythm, raising the
-- median the NEXT gap is judged against from 60 s to 430 s — so the second
-- silence, 60x the original rhythm on the un-updated median, is no longer
-- anomalous enough to carry a 10 steps/min run over the bar.
#guard srun STAY
    #[fx 0 0, fx 60 0, fx 120 0, fx 920 0, fx 2120 500, fx 5720 1000, fx 6020 1000]
    (stepsFrom 10 2160 60)
  == sv STAY

-- Two splits: three sub-stays, two `unknown` segments. The second gap is
-- 1830 s, so its minutes round HALF UP to 31.
#guard srun STAY
    #[fx 0 0, fx 300 0, fx 900 0, fx 2700 500, fx 3000 500, fx 4830 1000, fx 5130 1000]
    (stepsFrom 100 960 8 ++ stepsFrom 100 3060 30)
  == #[sub 0 900 3, gap 900 2700 "30", sub 2700 3000 2, gap 3000 4830 "31", sub 4830 5130 2]

-- A synthetic stay whose window holds NO fixes at all. The guard keeping it out
-- is PROTECTIVE rather than decisive: `splitByEvidence` reads `fixes[0]` before
-- its loop, which throws in the TS on an empty array. No `#guard` can pin it —
-- for any array of fewer than two fixes the loop never runs, so the result is a
-- single run and `subRuns.size ≤ 1` passes the segment through regardless.
-- Reproduced as the TS has it.
#guard srun #[{ stay with startTs := 50000, endTs := 60000 }] (acrossGap 1800) (stepsFrom 100 960 8)
  == sv #[{ stay with startTs := 50000, endTs := 60000 }]

-- The gap's HIGH end is strict too, and here it decides: a 300-step bucket
-- sitting exactly on the post-gap fix would lift 9.5 steps/min to 24.5 and
-- carry the score from 2.5 to 4.0.
#guard srun STAY NEAR_BAR (stepsFrom 10 300 20 ++ #[{ ts := 1440, steps := 300 }]) == sv STAY

-- A split starts a FRESH rhythm: `priorGaps` is cleared, so the new run's 60 s
-- cadence — not the old run's 800 s one — is what the next silence is judged
-- against. Carry the old gaps over and the median rises to 800, the anomaly
-- boost is lost, and this stay splits once instead of twice.
#guard srun STAY
    #[fx 0 0, fx 800 0, fx 1600 0, fx 2400 0, fx 3200 0, fx 4000 0,
      fx 5800 500, fx 5860 500, fx 5920 500, fx 5980 500, fx 6040 500,
      fx 9640 1000, fx 9940 1000]
    (stepsFrom 100 4060 8 ++ stepsFrom 10 6060 60)
  == #[sub 0 4000 6, gap 4000 5800 "30", sub 5800 6040 5, gap 6040 9640 "60", sub 9640 9940 2]

-- …and the centroid is reset to the new run's first fix. The second run sits at
-- 1000 m and the final fix lands 10 m from it — close enough for the -0.5 that
-- holds the score at 2.5. Left un-reset the centroid would still be dragging up
-- from the old run at 800 m, 210 m away, and this would split a second time.
#guard srun STAY
    #[fx 0 0, fx 60 0, fx 120 0, fx 180 0,
      fx 1980 1000, fx 2040 1000, fx 2100 1000, fx 2160 1000, fx 2220 1000,
      fx 5820 1010, fx 6120 1010]
    (stepsFrom 100 240 8 ++ stepsFrom 10 2240 60)
  == #[sub 0 180 4, gap 180 1980 "30", sub 1980 6120 7]

#guard srun #[] #[] == #[]

end StaysGuards

/-! ## `splitWalksOnEvidence`

The Cleveland-Clinic shape (#245): an hour sitting indoors, where jittery GPS
never settles, followed by the real ten-minute walk out — segmented as ONE
walking segment, because the jitter looks like movement all the way through. The
fix is to stop asking the GPS and ask the STEP COUNTER: bucket cadence per
minute across the segment and carve the low-cadence edge runs out as sits.

The boundary search is the whole algorithm, and it is deliberately NOT "the
first minute below a threshold". A real indoor sit is not contiguous zeros — the
clinic hour has isolated fidget spikes, a walk to the consult room, reception —
so a threshold walk would cut the sit at the first spike. Instead the sit → walk
boundary is the first minute `b` that BOTH carries real steps itself and opens a
forward window averaging sustained-walking cadence, while everything before `b`
averages at sitting level. A lone spike fails the window; the walk onset passes
immediately. The suffix search mirrors it.

Carving fires only when what remains still looks like a walk; otherwise the
segment is left whole for the demotion pass to judge. This one handles only the
MIXED case, where a real walk hides inside the same segment as a real sit.

The sits come out with their GPS motion stats ZEROED — they are jitter
artifacts, and the zero is the claim being made about them.

Entry is on the RAW `seg.mode` again, not `segMode`.

Two arithmetic details that a port gets wrong by default:

* the bucket index is a FLOOR division and the row may precede the segment, so
  a row 30 s early lands in bucket −1 and is dropped. Lean's `/` on `Int` is
  floor division for a positive divisor and would do here, but `Int.tdiv` — and
  the `/` of C, Rust and most other languages — truncates toward zero and would
  file that row under bucket 0. Written as `Int.fdiv` so the intent survives the
  next port.
* `Math.ceil` sets the bucket count, so the last bucket can extend past `endTs`.

Shell: the `WALK_SPLIT_DEBUG` tracing.

UNPROVEN; pinned against Node/V8 (`lean/experiments/split-walks-refs.mts`).
-/

namespace Walks

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint)
open Shed (PointF)
open Stays (SplitContext)

/-- Only walks at least this long are evaluated. -/
def MIN_SEGMENT_S : Int := 20 * 60
/-- Mean cadence at or below which an edge run is a sit — between stay-split's
"at-place fidgeting" and "ambiguous" bands. -/
def SIT_MEAN_MAX : Float := 5
/-- Forward-looking window (minutes) whose mean must reach `CORE_MIN_CADENCE`
for a minute to count as the start of sustained walking. -/
def ONSET_WINDOW_MIN : Nat := 6
/-- The boundary minute itself must carry this many steps: the window alone
would anchor the boundary a few zero-step minutes early, because it "sees" the
walk before it starts. -/
def ONSET_MIN_CADENCE : Float := 10
/-- An edge sit must be at least this long to be carved. -/
def MIN_SIT_S : Int := 15 * 60
/-- After carving, the remaining core must still look like a walk. -/
def CORE_MIN_CADENCE : Float := 40
def CORE_MIN_S : Int := 3 * 60
/-- A step row must exist in or shortly after the segment to prove the stream
was alive: without it, zero steps is absence of data, not evidence of sitting. -/
def FRESHNESS_S : Int := 30 * 60

/-- Carve long low-cadence edge runs out of a "walking" segment as sits. -/
def splitWalksOnEvidence (segments : Array Seg) (points : Array PointF)
    (ctx : SplitContext) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  for seg in segments do
    let carved : Array Seg := Id.run do
      if seg.mode != "walking" || seg.endTs - seg.startTs < MIN_SEGMENT_S then return #[]
      -- Freshness. PROVABLY a no-op for the result and kept for intent: every
      -- row that can reach the cadence buckets lies inside this window, so a
      -- stale stream yields an all-zero cadence, which no boundary can match.
      if !(ctx.steps.any fun s => s.ts ≥ seg.startTs && s.ts ≤ seg.endTs + FRESHNESS_S) then
        return #[]
      -- Per-minute cadence, bucketed from the segment start.
      let totalMin := (((seg.endTs - seg.startTs) + 59) / 60).toNat
      let mut cadence : Array Float := Array.replicate totalMin 0
      for s in ctx.steps do
        let k := Int.fdiv (s.ts - seg.startTs) 60
        if k ≥ 0 && k < Int.ofNat totalMin then
          cadence := cadence.modify k.toNat (· + s.steps)
      let meanOf (from_ to : Nat) : Float :=
        if to ≤ from_ then 0
        else ((Array.range (to - from_)).foldl (fun s j => s + cadence[from_ + j]!) 0)
          / Float.ofNat (to - from_)
      let minSitMin := ((MIN_SIT_S + 59) / 60).toNat
      -- Prefix: the FIRST minute that both steps and opens a walking window,
      -- with everything before it averaging at sitting level.
      let mut prefixMin : Nat := 0
      for b in [minSitMin:totalMin] do
        if cadence[b]! ≥ ONSET_MIN_CADENCE
            && meanOf b (min totalMin (b + ONSET_WINDOW_MIN)) ≥ CORE_MIN_CADENCE
            && meanOf 0 b ≤ SIT_MEAN_MAX then
          prefixMin := b
          break
      -- Suffix: mirrored — the LAST minute whose backward window still walks.
      let mut suffixMin : Nat := 0
      let eStart := totalMin - minSitMin
      for k in [0:eStart] do
        let e := eStart - k
        -- Probed at zero, and I could not construct a case: a suffix boundary
        -- at `e ≤ prefixMin` needs a walking-cadence window inside a stretch
        -- the prefix search already judged to average sitting level, and the
        -- prefix's FORWARD window at `e - ONSET_WINDOW_MIN` is that very same
        -- window — so the prefix claims the boundary first unless the two
        -- differ in their onset-minute test alone. Not proven unreachable;
        -- kept as the TS has it, and it would refuse via `coreS` regardless.
        if e ≤ prefixMin then break
        -- `e - ONSET_WINDOW_MIN` is Nat subtraction, i.e. the TS `Math.max(0, …)`.
        if cadence[e - 1]! ≥ ONSET_MIN_CADENCE
            && meanOf (e - ONSET_WINDOW_MIN) e ≥ CORE_MIN_CADENCE
            && meanOf e totalMin ≤ SIT_MEAN_MAX then
          suffixMin := totalMin - e
          break
      if prefixMin == 0 && suffixMin == 0 then return #[]
      -- What is left in the middle must still be a walk.
      let coreToMin := totalMin - suffixMin
      let coreS := min seg.endTs (seg.startTs + Int.ofNat coreToMin * 60)
        - (seg.startTs + Int.ofNat prefixMin * 60)
      if coreS < CORE_MIN_S then return #[]
      -- An empty core would divide by zero here, as it does in the TS; `coreS`
      -- has already refused that case.
      let coreCad := cadence.extract prefixMin coreToMin
      let coreMean := (coreCad.foldl (· + ·) 0) / Float.ofNat coreCad.size
      if coreMean < CORE_MIN_CADENCE then return #[]
      let b1 := seg.startTs + Int.ofNat prefixMin * 60
      let b2 := min seg.endTs (seg.startTs + Int.ofNat coreToMin * 60)
      let countIn (from_ to : Int) : Int :=
        Int.ofNat (points.filter fun p => p.ts ≥ from_ && p.ts < to).size
      -- The TS interpolates SIT_MEAN_MAX, which JS renders as `5`.
      let sitPart (from_ to : Int) (minutes : Nat) : Seg :=
        { seg with
          mode := "stationary", startTs := from_, endTs := to
          avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := countIn from_ to
          refinedReason := some s!"steps-aware walk split: ≤ 5 steps/min mean for {minutes} min inside a walking segment — a sit, not a walk" }
      let mut parts : Array Seg := #[]
      if prefixMin > 0 then parts := parts.push (sitPart seg.startTs b1 prefixMin)
      parts := parts.push { seg with startTs := b1, endTs := b2, pointCount := countIn b1 b2 }
      if suffixMin > 0 then parts := parts.push (sitPart b2 seg.endTs suffixMin)
      return parts
    out := if carved.isEmpty then out.push seg else out ++ carved
  return out

end Walks

section WalksGuards

open Walks
open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint)
open Shed (PointF)
open Stays (SplitContext)

private def wfx (ts : Int) : PointF := { ts, lat := 51.52, lon := -0.13, speedKmh := 1 }

private def walk : Seg :=
  { startTs := 0, endTs := 1800, mode := "walking"
    confidence := 0.8, confidenceMargin := 2
    avgSpeed := 3, maxSpeed := 6, linearity := 0.7, pointCount := 40, place := some "Clinic" }

/-- `n` copies of `v` — a run of per-minute cadences. -/
private def rep (n : Nat) (v : Float) : Array Float := Array.replicate n v
/-- One step row per minute from the segment start, INCLUDING the zeros. -/
private def perMin (cadence : Array Float) : Array FeasibilityStepPoint :=
  (Array.range cadence.size).map fun k => { ts := 60 * Int.ofNat k, steps := cadence[k]! }
/-- A fix every 5 minutes across a `mins`-long segment. -/
private def fixesEvery5 (mins : Nat) : Array PointF :=
  (Array.range (mins / 5 + 1)).map fun k => wfx (300 * Int.ofNat k)

private structure WRow where
  startTs : Int
  endTs : Int
  mode : String
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  place : String
  reason : String
  deriving Inhabited, BEq, Repr

private def wv (segs : Array Seg) : Array WRow :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode, pointCount := s.pointCount
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed, linearity := s.linearity
      place := s.place.getD "", reason := s.refinedReason.getD "" }

private def wrun (segs : Array Seg) (pts : Array PointF)
    (steps : Array FeasibilityStepPoint) : Array WRow :=
  wv (splitWalksOnEvidence segs pts { steps })

private def sitReason (mins : String) : String :=
  s!"steps-aware walk split: ≤ 5 steps/min mean for {mins} min inside a walking segment — a sit, not a walk"
/-- A carved sit: motion stats zeroed, place inherited. -/
private def sit (startTs endTs : Int) (pc : Int) (mins : String) : WRow :=
  { startTs, endTs, mode := "stationary", pointCount := pc
    avgSpeed := 0, maxSpeed := 0, linearity := 0, place := "Clinic", reason := sitReason mins }
/-- The surviving walking core: everything but the window is the parent's. -/
private def core (startTs endTs : Int) (pc : Int) : WRow :=
  { startTs, endTs, mode := "walking", pointCount := pc
    avgSpeed := 3, maxSpeed := 6, linearity := 0.7, place := "Clinic", reason := "" }

/-- 20 min of sitting, then a 10 min walk out — the clinic shape. -/
private def CLINIC : Array Float := rep 20 0 ++ rep 10 60

-- The shape the pass exists for.
#guard wrun #[walk] (fixesEvery5 30) (perMin CLINIC) == #[sit 0 1200 4 "20", core 1200 1800 2]
-- Mirrored: the walk comes first and the sit is carved off the back.
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 10 60 ++ rep 20 0))
  == #[core 0 600 2, sit 600 1800 4 "20"]
-- Both ends: three segments out.
#guard wrun #[{ walk with endTs := 3000 }] (fixesEvery5 50) (perMin (rep 20 0 ++ rep 10 60 ++ rep 20 0))
  == #[sit 0 1200 4 "20", core 1200 1800 2, sit 1800 3000 4 "20"]
-- No sit at all: a walk right through is left alone.
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 30 60)) == wv #[walk]

-- WHO PARTICIPATES: `seg.mode` is read RAW here too.
#guard wrun #[{ walk with mode := "stationary", refinedMode := some "walking" }]
    (fixesEvery5 30) (perMin CLINIC)
  == wv #[{ walk with mode := "stationary", refinedMode := some "walking" }]
#guard (wrun #[{ walk with refinedMode := some "stationary" }] (fixesEvery5 30) (perMin CLINIC)).size == 2
-- The duration bar is a floor: exactly 20 min is evaluated, one second under
-- is not.
#guard wrun #[{ walk with endTs := 1200 }] (fixesEvery5 20) (perMin (rep 15 0 ++ rep 5 60))
  == #[sit 0 900 3 "15", core 900 1200 1]
#guard wrun #[{ walk with endTs := 1199 }] (fixesEvery5 20) (perMin (rep 15 0 ++ rep 5 60))
  == wv #[{ walk with endTs := 1199 }]
-- FRESHNESS: with the step stream dead around the segment, zero steps is
-- absence of data. (Documented above as provably result-neutral: an unfresh
-- stream also leaves the cadence all zero, which no boundary matches.)
#guard wrun #[walk] (fixesEvery5 30) #[{ ts := -600, steps := 900 }] == wv #[walk]

-- THE SIT MUST BE LONG ENOUGH. The prefix search opens at minute 15, so a
-- 15 min sit carves and a 14 min one cannot: at b = 15 the walk's own first
-- minute is already inside the "sit" mean and lifts it over the bar.
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 15 0 ++ rep 15 100))
  == #[sit 0 900 3 "15", core 900 1800 3]
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 14 0 ++ rep 16 100)) == wv #[walk]

-- A LONE FIDGET SPIKE inside the sit does not move the boundary: minute 20
-- carries 100 steps but its forward window averages 33, under the
-- sustained-walking bar, so the boundary waits for the real onset at 25 — where
-- the spike has diluted into a prefix mean of 4, just inside the sitting bar.
#guard wrun #[{ walk with endTs := 2100 }] (fixesEvery5 35)
    (perMin (rep 20 0 ++ #[100] ++ rep 4 0 ++ rep 10 100))
  == #[sit 0 1500 5 "25", core 1500 2100 2]

-- THE ONSET MINUTE itself must carry steps: exactly 10 is enough, 9 pushes the
-- boundary a minute later.
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 20 0 ++ #[10] ++ rep 9 100))
  == #[sit 0 1200 4 "20", core 1200 1800 2]
#guard wrun #[walk] (fixesEvery5 30) (perMin (rep 20 0 ++ #[9] ++ rep 9 100))
  == #[sit 0 1260 5 "21", core 1260 1800 1]
-- Two rows in the same minute ACCUMULATE: 6 + 6 clears a bar neither would.
#guard wrun #[walk] (fixesEvery5 30)
    (perMin (rep 20 0 ++ #[0] ++ rep 9 100) ++ #[{ ts := 1200, steps := 6 }, { ts := 1230, steps := 6 }])
  == #[sit 0 1200 4 "20", core 1200 1800 2]

-- THE CARVED CORE MUST STILL BE A WALK. A 3 min core survives; 2 min is under
-- the floor and the segment is left intact.
#guard wrun #[{ walk with endTs := 1980 }] (fixesEvery5 33)
    (perMin (rep 15 0 ++ rep 3 200 ++ rep 15 0))
  == #[sit 0 900 3 "15", core 900 1080 1, sit 1080 1980 3 "15"]
#guard wrun #[{ walk with endTs := 1920 }] (fixesEvery5 32)
    (perMin (rep 15 0 ++ rep 2 200 ++ rep 15 0))
  == wv #[{ walk with endTs := 1920 }]
-- …and it must average sustained-walking cadence. A trailing lull too short to
-- carve stays INSIDE the core and drags its mean under the bar.
#guard wrun #[{ walk with endTs := 1740 }] (fixesEvery5 29)
    (perMin (rep 15 0 ++ rep 6 100 ++ rep 8 0))
  == #[sit 0 900 3 "15", core 900 1740 3]
#guard wrun #[{ walk with endTs := 1860 }] (fixesEvery5 31)
    (perMin (rep 15 0 ++ rep 6 100 ++ rep 10 0))
  == wv #[{ walk with endTs := 1860 }]

-- Rows outside the segment's own minutes are not bucketed. The row 30 s BEFORE
-- the start is the one that matters: floor division puts it in bucket -1, while
-- truncation toward zero would put 900 steps into the sit's first minute.
#guard wrun #[walk] (fixesEvery5 30)
    (perMin CLINIC ++ #[{ ts := -30, steps := 900 }, { ts := 1800, steps := 900 }])
  == #[sit 0 1200 4 "20", core 1200 1800 2]

-- The onset window's LENGTH, from the short side. Four minutes at 50 average
-- 50 — walking — but stretched over six they average 33, so the boundary waits
-- for the minute after, where the window reaches past the lull into the real
-- walk. A shorter window would open the walk a minute early.
#guard wrun #[{ walk with endTs := 2160 }] (fixesEvery5 36)
    (perMin (rep 20 0 ++ rep 4 50 ++ rep 2 0 ++ rep 10 100))
  == #[sit 0 1260 5 "21", core 1260 2160 3]

-- A segment that does not end on a minute boundary: the bucket count is a
-- CEILING, so the last bucket runs 30 s past `endTs` — and the core's end is
-- clamped back to `endTs`, not to that overhanging bucket.
#guard wrun #[{ walk with endTs := 1830 }] (fixesEvery5 30) (perMin CLINIC)
  == #[sit 0 1200 4 "20", core 1200 1830 3]

#guard wrun #[] #[] #[] == #[]

end WalksGuards
