import Verified.Geo.SegmentMerge
import Verified.Geo.Worldline
import Verified.JsNum
import Verified.Fix
/-!
# Re-cutting segments on evidence (port of `src/geo/stay-split.ts`, grown since)

Three passes of `PassFold`'s tail that move a boundary where the track alone
put it wrong, each in its own namespace, over the fix helpers in `Shed`:

* `FootArrival` — `claimStayArrivalFromWalk` (`stayArrivalClaim`), a walk's
  tail that is already the stay after it;
* `Dwell` — `splitWalksOnDwell` (`walkDwell`), the stops carved out of a walk by
  held position and steps;
* `StepDeparture` — `claimSteplessDepartures` (`staySteplessDeparture`), a walk's
  stepless head that is still the stay before it.

All discrete branches + arithmetic, no transcendentals ⇒ EXACT. UNPROVEN;
pinned by the `#guard`s.
-/

/-! ## `Shed` — the fix type and the helpers the passes share -/

namespace Shed

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- A Kalman-filtered fix as the passes read it. -/
abbrev PointF := Verified.SpeedFix

/-- `refinedMode ?? mode` — the TS `segMode`. -/
def segMode (s : Seg) : String := s.refinedMode.getD s.mode

open Verified.JsNum (jsRound)

/-- The TS `median`: ascending sort, mean of the middle pair when even. -/
def median (values : Array Float) : Float :=
  let sorted := (values.toList.mergeSort (· ≤ ·)).toArray
  if h : sorted.size = 0 then 0
  else if sorted.size % 2 == 0 then (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]) / 2
  else sorted[sorted.size / 2]

def sortedIn (points : Array PointF) (startTs endTs : Int) : Array PointF :=
  ((points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs).toList.mergeSort
    fun a b => a.ts ≤ b.ts).toArray

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
  if h2 : fixes.size ≥ 2 then
    let speeds := fixes.map (·.speedKmh)
    let pathDist := Id.run do
      let mut acc : Float := 0
      for h : k in [0:fixes.size - 1] do
        have hk : k < fixes.size - 1 := h.upper
        acc := acc + haversineMeters fixes[k].lat fixes[k].lon fixes[k + 1].lat fixes[k + 1].lon
      return acc
    let last := fixes[fixes.size - 1]
    let straight := haversineMeters fixes[0].lat fixes[0].lon last.lat last.lon
    { base with
      avgSpeed := jsRound (median speeds * 10) / 10
      maxSpeed := jsRound (speeds.foldl max fixes[0].speedKmh * 10) / 10
      -- The `min … 1` clamp is defensive only: a polyline's straight-line
      -- distance never exceeds its path length, so the ratio is ≤ 1 except for
      -- float noise on a perfectly straight run. Unpinnable; kept for fidelity.
      linearity := if pathDist > 0 then jsRound (min (straight / pathDist) 1 * 100) / 100 else 0 }
  else base

end Shed

/-! ## Walk→stay arrival boundary (`claimStayArrivalFromWalk`)

A walk's TAIL that is already standing at the stay after it goes to that stay. -/
namespace FootArrival

open Verified.Geo.SegmentMerge (Seg)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF segMode sortedIn walkRemainder median)
open Verified.JsNum (jsRound)

/-- Steps below this pace are standing, not walking. -/
def MARCH_STILL_KMH : Float := 2.5

private def stepKmh (fixes : Array PointF) (i j : Fin fixes.size) : Float :=
  let dt := fixes[j].ts - fixes[i].ts
  if dt > 0 then
    haversineMeters fixes[i].lat fixes[i].lon fixes[j].lat fixes[j].lon / Float.ofInt dt * 3.6
  else 0

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
private def arrivalIdx (fixes : Array PointF) : Nat :=
  if h0 : 0 < fixes.size then (go ⟨fixes.size - 1, by omega⟩).val else 0
where
  go (k : Fin fixes.size) : Fin fixes.size :=
    if hk : 0 < k.val then
      if stepKmh fixes ⟨k.val - 1, by omega⟩ k < MARCH_STILL_KMH then go ⟨k.val - 1, by omega⟩ else k
    else k
  termination_by k.val

/-- The walk `cur` gives its standing tail to the stay `next`: the shortened
    walk and the grown stay, or `none` when the tail is not a held position. -/
private def footArrival (cur next : Seg) (points : Array PointF) : Option (Seg × Seg) := Id.run do
      if !(segMode cur == "walking" && segMode next == "stationary") then return none
      let fixes := sortedIn points cur.startTs cur.endTs
      if fixes.size < 4 then return none
      let k := arrivalIdx fixes
      let run := fixes.extract k fixes.size
      if run.size < 2 then return none
      let some first := run[0]? | return none
      let some last := run.back? | return none
      let arrivalTs := first.ts
      let durS := last.ts - arrivalTs
      if durS < FOOT_ARRIVAL_MIN_DWELL_S then return none
      let cLat := (run.foldl (fun s p => s + p.lat) 0) / Float.ofNat run.size
      let cLon := (run.foldl (fun s p => s + p.lon) 0) / Float.ofNat run.size
      let spreadM := run.foldl (fun m p => max m (haversineMeters cLat cLon p.lat p.lon)) 0
      if spreadM > FOOT_ARRIVAL_SPREAD_MAX_M then return none
      if arrivalTs - cur.startTs < FOOT_ARRIVAL_MIN_WALK_REMAINDER_S then return none
      if cur.endTs - arrivalTs ≤ 0 then return none
      let movedS := cur.endTs - arrivalTs
      -- `jsRound … .toInt64.toInt`, not `Float.round`: the latter stays a Float
      -- and `s!` renders it "3.000000", where the TS arm's `Math.round` prints
      -- "3". The reason string is compared field-for-field by the day gate, so
      -- the formatting IS the parity.
      let reason := s!"arrival boundary moved back {movedS} s: the walk's tail held position within {toString (jsRound spreadM).toInt64.toInt} m for {durS} s"
      -- `walkRemainder` is the family's rebuild: it recomputes pointCount /
      -- avgSpeed / maxSpeed / linearity over the new window and clears the
      -- enrichment derived from the old one. By hand the walk would keep an
      -- avgSpeed the standing tail dragged down — the very seconds this pass
      -- has just taken away from it.
      -- `walkRemainder` recomputes the kinematics over the new window, which is
      -- what this pass wants — the seconds it removes are the standing ones
      -- that dragged the average down. But it also clears the enrichment and
      -- flags `needsReenrich`, and that is wrong here: its own callers carve a
      -- remainder whose MODE is genuinely in question, while trimming an
      -- arrival changes the window and never what the segment IS. Forcing the
      -- re-derivation made a shortened leg come back `cycling` on 2026-04-29,
      -- and `repairVehicleHandoff` absorbed 27 minutes of it into the adjacent
      -- train as an impossible vehicle hand-off.
      --
      -- The NAME is a different matter: the shorter walk is a shorter stretch
      -- of street, and the name it carries was derived from a line drawn
      -- through the part it overran onto. `needsRename` asks `reenrich` for
      -- that and for nothing else.
      let rebuilt := walkRemainder cur cur.startTs arrivalTs points
      let walk := { rebuilt with refinedMode := cur.refinedMode, wayName := cur.wayName, needsReenrich := false, needsRename := true, refinedReason := some reason }
      -- The stay keeps its enrichment (same place, entered earlier) but its
      -- window grew, so its sample-derived fields are recomputed over it.
      let stayFixes := points.filter fun p => p.ts ≥ arrivalTs && p.ts < next.endTs
      let staySpeeds := stayFixes.map (·.speedKmh)
      let stay :=
        if staySpeeds.isEmpty then { next with startTs := arrivalTs, pointCount := 0 }
        else
          let avg := jsRound (median staySpeeds * 10) / 10
          let mx := jsRound ((staySpeeds.foldl max (staySpeeds[0]?.getD 0)) * 10) / 10
          { next with startTs := arrivalTs, pointCount := Int.ofNat stayFixes.size, avgSpeed := avg, maxSpeed := mx }
      return some (walk, stay)

/-- Move a walk→stay boundary back to the moment the walking actually stopped.
    See `footArrival` for the evidence; this is the pass over the segments. -/
def claimStayArrivalFromWalk (segments : Array Seg) (points : Array PointF) : Array Seg := Id.run do
  let mut segs : Vector Seg segments.size := ⟨segments, rfl⟩
  let mut out : Array Seg := #[]
  for h : i in [0:segments.size] do
    let cur := segs[i]
    if h1 : i + 1 < segments.size then
      match footArrival cur segs[i + 1] points with
      | some (walk, stay) =>
        out := out.push walk
        segs := segs.set (i + 1) stay
      | none => out := out.push cur
    else out := out.push cur
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
-- It does NOT force re-derivation: that redoes the MODE too, and a shortened
-- leg came back `cycling` on 2026-04-29 and was absorbed into a train.
#guard (runOn 140)[0]!.needsReenrich == false
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

/-! ## `splitWalksOnDwell`

A walk that stops for a few minutes — a shop, a queue, a bench — and carries on
is one walking segment, because the tumbling grid finds a dwell shorter than
about two windows only when it happens to dominate one (#1694). Re-phasing the
grid was measured four ways and lost confirmed rows every time; the dwell is
found from the walk's own fixes instead.

A run of fixes that holds position — every fix within `DWELL_RADIUS_M` of the
run's running mean — for at least `DWELL_MIN_S`, with a walk of at least
`DWELL_MIN_REMAINDER_S` left on both sides, becomes a stay of its own. The
step counter is the veto, not the evidence: a run whose cadence reads
`DWELL_WALKING_CADENCE` or more is a GPS that froze while the wearer walked
on, and is left alone; no step data at all lets the GPS decide.

Runs LATE in the cascade, after every rail and vehicle carver: in the split
stage (measured 2026-09-23) a held position next to a train was the platform
wait, and carving it moved the train's edge and lost four confirmed rail
rows. A walk with a train on either side is left alone.

The stay is named the way the enrichment stage names every stay — a mined
place elected from the run's own fixes, then the venue resolver at the naming
coordinate; the remainders are `walkRemainder`s, rebuilt
over their own windows but keeping the walk's name and refinement — a stop
taken out of a walk does not change which street it was. A boundary fix
belongs to the stay on both sides. The second remainder is
searched again, so a walk with two stops yields two.

Entry is on the effective mode (`segMode`): by this point refinements are the
truth about a leg. -/

namespace Dwell

open Verified.Geo.SegmentMerge (Seg ResolvedPlace)
open Verified.Geo.Worldline (FeasibilityStepPoint meanCadenceSpm)
open Verified.Hsmm.FloatScore (haversineMeters)
open Shed (PointF segMode sortedIn walkRemainder)
open Verified.JsNum (jsRound)

/-- Names a carved stop: the segment goes in with its window, centroid and
kinematics and comes back with `place`, `city` and `focusPlaceId` — the
enrichment stage's own stationary branch, so the stop is elected and named
like any other stay. -/
abbrev Namer := Seg → Seg

/-- A held position must last this long to be a stop rather than a crossing. -/
def DWELL_MIN_S : Int := 240
/-- How far a fix may sit from the run's mean and still be "here". Observed
    foot arrivals hold within 1–9 m; a shop's aisles are wider than a kerb.
    ⚠ BOTH THRESHOLDS WERE SWEPT on the corpus (2026-09-26, health #1694).
    40 m is inert: across 45 days it moves one stop's start by a minute on a
    day with no narrative, and clears no confirmed row — so 30 stands. 180 s
    is NOT free: with either radius it turns a confirmed walk into a shop stop
    (2026-06-22 10:34Z) and breaks the 2026-07-06 Work stay, whose GPS wander
    a later pass used to absorb as a walk and no longer can once a stop is
    carved out of it. Four minutes stands. -/
def DWELL_RADIUS_M : Float := 30
/-- A dwell at a walk's edge is the arrival and departure passes' business. -/
def DWELL_MIN_REMAINDER_S : Int := 60
/-- Cadence at or above which the run was walked through, not stood in. -/
def DWELL_WALKING_CADENCE : Float := 40
/-- Next to a train, a stop is carved only when the stretch between it and the
    train was itself WALKED — at least this long, at `PEDESTRIAN_MIN_CADENCE_SPM`.
    A platform wait sits against its train; a shop is reached on foot. 05-12's
    Lidl stop (#185, 2026-09-30) came after four minutes at ~100 steps/min from
    the Wembley Park train and was refused by the old blanket rule. -/
def DWELL_TRAIN_SIDE_WALK_S : Int := 120

/-- End (exclusive) of the longest run from `i` whose fixes all stay within
    `DWELL_RADIUS_M` of the run's running mean. -/
private def runEnd (fixes : Array PointF) (i : Fin fixes.size) : Nat := Id.run do
  let mut cLat := fixes[i].lat
  let mut cLon := fixes[i].lon
  let mut n : Nat := 1
  let mut e := i.val + 1
  for hm_j : j in [i.val + 1:fixes.size] do
    let p := fixes[j]
    if haversineMeters cLat cLon p.lat p.lon > DWELL_RADIUS_M then break
    n := n + 1
    cLat := cLat + (p.lat - cLat) / Float.ofNat n
    cLon := cLon + (p.lon - cLon) / Float.ofNat n
    e := j + 1
  return e

/-- The first dwell in a walk's fixes: `(first, last)` indices, inclusive. -/
private def findDwell (fixes : Array PointF) (steps : List FeasibilityStepPoint)
    (segStart segEnd : Int) (admit : Int → Int → Bool) :
    Option (Fin fixes.size × Fin fixes.size) := Id.run do
  for hm_i : i in [0:fixes.size] do
    let fi : Fin fixes.size := ⟨i, hm_i.upper⟩
    let e := runEnd fixes fi
    if he : e - 1 < fixes.size then
      let last : Fin fixes.size := ⟨e - 1, he⟩
      if e - i ≥ 3 then
        let ds := fixes[fi].ts
        let de := fixes[last].ts
        if de - ds ≥ DWELL_MIN_S && ds - segStart ≥ DWELL_MIN_REMAINDER_S
            && segEnd - de ≥ DWELL_MIN_REMAINDER_S then
          let walked := match meanCadenceSpm steps ds de with
            | some c => c ≥ DWELL_WALKING_CADENCE
            | none => false
          if !walked && admit ds de then return some (fi, last)
  return none

/-- Cut one walk at its first dwell; the trailing remainder is cut again. -/
private def cutWalk (seg : Seg) (points : Array PointF) (steps : List FeasibilityStepPoint)
    (name : Namer) (trainBefore trainAfter : Bool) : Nat → Array Seg
  | 0 => #[seg]
  | fuel + 1 =>
    let fixes := sortedIn points seg.startTs seg.endTs
    -- The stretch between a train and the stop must have been walked: at
    -- least `DWELL_TRAIN_SIDE_WALK_S` long, and its `DWELL_TRAIN_SIDE_WALK_S`
    -- next to the STOP at pedestrian cadence. Not the whole stretch's mean: its
    -- train end is the exit (escalators, a barrier, steps barely counted), and
    -- 06-16's pharmacy, reached after four brisk minutes, averaged 53 spm with
    -- the minute and a half out of Wembley Park in it.
    let walkedSide := fun (a b : Int) (stopAtEnd : Bool) =>
      let (wa, wb) := if stopAtEnd then (b - DWELL_TRAIN_SIDE_WALK_S, b) else (a, a + DWELL_TRAIN_SIDE_WALK_S)
      decide (b - a ≥ DWELL_TRAIN_SIDE_WALK_S) &&
        (meanCadenceSpm steps wa wb).any (fun c => decide (c ≥ Verified.Geo.Worldline.PEDESTRIAN_MIN_CADENCE_SPM))
    -- Only the LAST stop before a train can be its platform wait. One with a
    -- later stop between it and the train is not against the train at all,
    -- and, read to the train, the later sits pulled the cadence under the bar:
    -- the hour in Gare Montparnasse (2026-10-01) came out one 46-minute walk
    -- with no stop in it.
    let anotherStopAfter := fun (de : Int) =>
      (findDwell (fixes.filter (·.ts > de)) steps de seg.endTs (fun _ _ => true)).isSome
    let admit := fun (ds de : Int) =>
      (!trainBefore || walkedSide seg.startTs ds true)
        && (!trainAfter || anotherStopAfter de || walkedSide de seg.endTs false)
    match findDwell fixes steps seg.startTs seg.endTs admit with
    | none => #[seg]
    | some (a, b) =>
      let ds := fixes[a].ts
      let de := fixes[b].ts
      let run := fixes.extract a.val (b.val + 1)
      let cLat := (run.foldl (fun s p => s + p.lat) 0) / Float.ofNat run.size
      let cLon := (run.foldl (fun s p => s + p.lon) 0) / Float.ofNat run.size
      let spreadM := run.foldl (fun m p => max m (haversineMeters cLat cLon p.lat p.lon)) 0
      let stay : Seg := name
        { startTs := ds, endTs := de, mode := "stationary"
          confidence := 0.9, confidenceMargin := 1000
          avgSpeed := 0, maxSpeed := 0, linearity := 0, pointCount := Int.ofNat (b.val + 1 - a.val)
          centroidLat := some cLat, centroidLon := some cLon
          displayTz := seg.displayTz
          refinedReason := some s!"stop inside a walk: held position within {toString (jsRound spreadM).toInt64.toInt} m for {de - ds} s"
          refinedKinds := #["walk-dwell"] }
      -- The remainders keep the walk's NAME and refinement: a stop taken out
      -- of a walk changes its window and never which street it was, and a
      -- name re-derived over the shorter window picked the neighbouring street
      -- on 2026-06-24 and lost a confirmed row. Only the kinematics are
      -- rebuilt, as the foot-arrival trim does.
      let keep (r : Seg) : Seg :=
        { r with wayName := seg.wayName, refinedMode := seg.refinedMode, place := seg.place
                 needsReenrich := false, needsRename := false }
      let before := keep (walkRemainder seg seg.startTs ds points false)
      let after := keep (walkRemainder seg de seg.endTs points true)
      #[before, stay] ++ cutWalk after points steps name false trainAfter fuel

/-- Carve every held position of `DWELL_MIN_S` or more out of each walking
    segment as a stay of its own. Next to a train only a stop REACHED ON FOOT
    from it is carved (`DWELL_TRAIN_SIDE_WALK_S`): a held position against the
    train is its platform wait, which the rail passes own. -/
def splitWalksOnDwell (segments : Array Seg) (points : Array PointF)
    (steps : List FeasibilityStepPoint) (name : Namer) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  for hm_i : i in [0:segments.size] do
    let seg := segments[i]
    let nextTrain := if h1 : i + 1 < segments.size then segMode segments[i + 1] == "train" else false
    let prevTrain := if h0 : 0 < i then segMode (segments[i - 1]'(by have h1 : i < segments.size := hm_i.upper; omega)) == "train" else false
    if segMode seg != "walking" then out := out.push seg
    else out := out ++ cutWalk seg points steps name prevTrain nextTrain points.size
  return out

end Dwell

/-! ## `claimSteplessDepartures`

A walk that leaves a stay begins at its first STEPPED minute. Where the walk's
head carries no minute of `STEPLESS_MAX_SPM` steps or more — and the stay before
it had step data, so the watch was counting — the head is still the stay: GPS
wander out of a building reads as a slow walk the watch never saw (2026-07-15:
zero steps 12:43–12:50 after the hospital, then a walk from 12:53, served as a
walk from 12:45). The stay is extended to that minute; the walk keeps its name.
Absent steps INSIDE the walk nothing moves: no stepped minute is no evidence of
where walking began. -/

namespace StepDeparture

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Worldline (FeasibilityStepPoint)
open Shed (PointF segMode walkRemainder)

/-- A minute with fewer steps than this is not walking. -/
def STEPLESS_MAX_SPM : Float := 20
/-- The stepless head must last this long to be claimed. -/
def STEPLESS_MIN_S : Int := 180
/-- And leave at least this much walk. -/
def STEPLESS_MIN_REMAINDER_S : Int := 60

/-- Start of the first minute overlapping `[a, b)` with `STEPLESS_MAX_SPM`
    steps or more. -/
def firstStepped (steps : List FeasibilityStepPoint) (a b : Int) : Option Int :=
  steps.foldl (fun m s =>
    if decide (s.ts + 60 > a) && decide (s.ts < b) && decide (s.steps ≥ STEPLESS_MAX_SPM) then
      some (match m with | some x => min x s.ts | none => s.ts)
    else m) none

/-- Move each stay → walk boundary to the walk's first stepped minute. -/
def claimSteplessDepartures (segments : Array Seg) (points : Array PointF)
    (steps : List FeasibilityStepPoint) : Array Seg := Id.run do
  if steps.isEmpty then return segments
  let mut out := segments
  for i in [0:segments.size] do
    if i + 1 < out.size then
      let stay := out[i]!
      let walk := out[i + 1]!
      if segMode stay == "stationary" && segMode walk == "walking" then
        let stayCounted := steps.any fun s => decide (s.ts + 60 > stay.startTs) && decide (s.ts < walk.startTs)
        match firstStepped steps walk.startTs walk.endTs with
        | some t0 =>
          let t := max t0 walk.startTs
          if stayCounted && t - walk.startTs ≥ STEPLESS_MIN_S
              && walk.endTs - t ≥ STEPLESS_MIN_REMAINDER_S then
            let rest := walkRemainder walk t walk.endTs points false
            out := (out.set! i { stay with endTs := t }).set! (i + 1)
              { rest with wayName := walk.wayName, refinedMode := walk.refinedMode
                          place := walk.place, needsReenrich := false, needsRename := false }
        | none => pure ()
  return out

end StepDeparture

section DwellGuards

open Dwell
open Shed (PointF)
open Verified.Geo.SegmentMerge (Seg)

private def dLat0 : Float := 51.52
private def dLon0 : Float := -0.13
private def dMlat : Float := 1 / 111320
/-- A fix `m` metres north of the origin. -/
private def dfx (ts : Int) (m : Float) (spd : Float := 4) : PointF :=
  { ts, lat := dLat0 + m * dMlat, lon := dLon0, speedKmh := spd }

-- North at 1.5 m/s for 5 min, held within 3 m for 5 min, north again for 10
-- min: one walk becomes walk | stay | walk, the stay spanning exactly the held
-- fixes. 45 m between walking fixes, so no two of them sit inside the radius.
private def STOP : Array PointF :=
  (Array.range 10).map (fun i => dfx (Int.ofNat i * 30) (Float.ofNat i * 45)) ++
  (Array.range 11).map (fun i => dfx (300 + Int.ofNat i * 30) (450 + (if i % 2 == 0 then 0 else 3)) 0.5) ++
  (Array.range 20).map (fun i => dfx (630 + Int.ofNat i * 30) (495 + Float.ofNat i * 45))
private def WALK : Seg := { startTs := 0, endTs := 1200, mode := "walking" }
private def unnamed : Namer := id
private def cut := splitWalksOnDwell #[WALK] STOP [] unnamed
#guard cut.map (fun s => (s.mode, s.startTs, s.endTs)) ==
  #[("walking", 0, 300), ("stationary", 300, 600), ("walking", 600, 1200)]
-- 19, not 20: `walkRemainder` counts `[startTs, endTs)`, its family's convention.
#guard (cut.map (·.pointCount)) == #[10, 11, 19]

-- The same stop walked THROUGH at 60 steps a minute: a frozen GPS, left alone.
private def marching : Array Verified.Geo.Worldline.FeasibilityStepPoint :=
  (Array.range 20).map fun i => { ts := Int.ofNat i * 60, steps := 60 }
#guard (splitWalksOnDwell #[WALK] STOP marching.toList unnamed).size == 1

-- The stop is named through the injected namer, which sees the carved stay
-- itself — window and centroid — and hands back its place and identity.
private def shopAlpha : Namer := fun s =>
  { s with place := some "Shop Alpha", city := some "Townsville", focusPlaceId := some 7 }
#guard ((splitWalksOnDwell #[WALK] STOP [] shopAlpha)[1]!).place == some "Shop Alpha"
#guard ((splitWalksOnDwell #[WALK] STOP [] shopAlpha)[1]!).focusPlaceId == some 7
#guard ((splitWalksOnDwell #[WALK] STOP [] shopAlpha)[1]!).startTs == 300

-- A walk with a train on either side is left alone: its held position is a
-- platform wait, and the rail absorbers own it.
private def TRAIN : Seg := { startTs := 1200, endTs := 2400, mode := "train" }
#guard (splitWalksOnDwell #[WALK, TRAIN] STOP [] unnamed).size == 2

-- TWO stops before a train (2026-10-01, Gare Montparnasse): the first has the
-- second between it and the train, so it is no platform wait and is carved
-- however slow the walk on; the second is the last before the train and needs
-- the stretch to it walked.
private def TWO_STOPS : Array PointF :=
  (Array.range 10).map (fun i => dfx (Int.ofNat i * 30) (Float.ofNat i * 45)) ++
  (Array.range 11).map (fun i => dfx (300 + Int.ofNat i * 30) (450 + (if i % 2 == 0 then 0 else 3)) 0.5) ++
  (Array.range 10).map (fun i => dfx (630 + Int.ofNat i * 30) (495 + Float.ofNat i * 45)) ++
  (Array.range 11).map (fun i => dfx (930 + Int.ofNat i * 30) (945 + (if i % 2 == 0 then 0 else 3)) 0.5) ++
  (Array.range 10).map (fun i => dfx (1260 + Int.ofNat i * 30) (990 + Float.ofNat i * 45))
private def WALK2 : Seg := { startTs := 0, endTs := 1560, mode := "walking" }
private def TRAIN2 : Seg := { startTs := 1560, endTs := 3000, mode := "train" }
private def modes (segs : Array Seg) : Array (String × Int × Int) :=
  segs.map fun s => (s.mode, s.startTs, s.endTs)
#guard modes (splitWalksOnDwell #[WALK2, TRAIN2] TWO_STOPS [] unnamed) ==
  #[("walking", 0, 300), ("stationary", 300, 600), ("walking", 600, 1560), ("train", 1560, 3000)]
-- Walked from the second stop to the train: it is a stop too.
private def toTrain : List Verified.Geo.Worldline.FeasibilityStepPoint :=
  (List.range 5).map fun i => { ts := 1260 + Int.ofNat i * 60, steps := 100 }
#guard modes (splitWalksOnDwell #[WALK2, TRAIN2] TWO_STOPS toTrain unnamed) ==
  #[("walking", 0, 300), ("stationary", 300, 600), ("walking", 600, 930),
    ("stationary", 930, 1230), ("walking", 1230, 1560), ("train", 1560, 3000)]

-- A held position under four minutes is a crossing, not a stop.
private def BRIEF : Array PointF :=
  (Array.range 10).map (fun i => dfx (Int.ofNat i * 30) (Float.ofNat i * 45)) ++
  (Array.range 5).map (fun i => dfx (300 + Int.ofNat i * 30) 450 0.5) ++
  (Array.range 20).map (fun i => dfx (450 + Int.ofNat i * 30) (495 + Float.ofNat i * 45))
#guard (splitWalksOnDwell #[{ WALK with endTs := 1020 }] BRIEF [] unnamed).size == 1

-- Not a walk: untouched.
#guard splitWalksOnDwell #[{ WALK with mode := "driving" }] STOP [] unnamed == #[{ WALK with mode := "driving" }]

end DwellGuards
