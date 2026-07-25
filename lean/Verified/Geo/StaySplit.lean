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
