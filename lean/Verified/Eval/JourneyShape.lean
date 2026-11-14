import Verified.Eval.Journeys
/-!
# Journey reconstruction scoring

Does the day read as the right sequence of trips? This builds the pipeline's
journeys from the drawn legs and compares them with the narrative's
(`Verified.Eval.Journeys.groundTruthJourneys`); with `Verified.Eval.FloorGate` it
is the journey floor (`tests/golden/journey-baseline.json`).

## ⚠ A match is shape and coverage, and the second conjunct is the quiet one

A fragmented journey's first piece can carry the exact shape while spanning a
third of the trip; a third of the corpus's unmatched journeys do. So
`uncoveredS` and `slackS` come back beside the verdict.

## The end-clip is one minute, and only at the ends

A leg crossing the audited boundary can add an element to the shape (36 s of a
walk out of a station). Only ends are trimmed, since dropping an interior leg
merges its neighbours (`[walking, train, walking]` collapses to `[walking]`).
One minute, not a fraction of the window, which would swallow a real
disagreement (a 146 s walk where the pipeline ends the train early).

## Three rules the corpus cannot check

The one-second merge tolerance (no gap of exactly 1 s), the strict pause split
(no gap within 24 s of 300 s) and `bestOverlap`'s tie-break (no two journeys
tie) are silent on the corpus, so the `#guard`s are their only check.
`tests/corpus/journey.rs` runs the rest over the real corpus.
-/

namespace Verified.Eval.JourneyShape

open Verified.Eval.Journeys

/-! ## The pipeline's mode is a string

The narrative side is parsed to a `Mode`; the pipeline side is whatever the
serving path emitted, compared as canonical strings (`sleeping` reads as
`stationary`). Parsed, an unrecognised mode would be dropped, changing journey
boundaries, so these work on strings. -/

/-- `sleeping` folds to `stationary`; every other string keeps its name,
recognised or not. -/
def canonicalModeStr (m : String) : String :=
  if m == "sleeping" then "stationary" else m

def isMovementModeStr (m : String) : Bool :=
  match canonicalModeStr m with
  | "walking" | "cycling" | "driving" | "bus" | "train" | "plane" => true
  | _ => false

/-- A timetabled ride: the stay before it is a wait, not a visit. -/
def isRideModeStr (m : String) : Bool :=
  let c := canonicalModeStr m
  c == "train" || c == "bus" || c == "plane"

/-! ## The coverage allowance, without floats

The allowance is `max(COVERAGE_SLACK_FRAC * span, COVERAGE_SLACK_MIN_S)` with
`COVERAGE_SLACK_FRAC = 0.2`, exact in `Int`:

* The test: `u ≤ 0.2 * span` is `u ≤ span / 5`, since the double `0.2` is
  slightly above one fifth. The fraction overtakes the 240 s floor at
  `span ≥ 1200`, safe in floats too (`0.2 * 1200` is `240.00000000000003`).
* The report rounds (`(2 * span + 5) / 10`), which differs from the floor (1203
  reports 241, floors to 240), so the two are computed apart and the verdict
  uses the floor.
-/

/-- The span at which the fractional allowance overtakes the absolute one —
`0.2 * span ≥ 240`. -/
def COVERAGE_FRAC_FLOOR_S : Int := 1200
def COVERAGE_SLACK_MIN_S : Int := 240

/-- How much of a leg must fall inside the audited span to count toward the
shape: one minute, the scorer's resolution, since the minute expansion emits one
entry per top-of-minute. -/
def SHAPE_MIN_LEG_OVERLAP_S : Int := 60

/-- A drawn state as the referee sees it: its window and its mode, never its
place. -/
structure Drawn where
  startTs : Int
  endTs : Int
  mode : String
  deriving BEq, Repr, Inhabited

/-- Merge the drawn legs into journeys by `groundTruthJourneys`'s rules:
same-mode movement states join when they touch (`start ≤ prevEnd + 1`); a stay
or gap the day boards a ride from is its wait, however long; a stay walked or
driven away from ends the journey, as does a sleep. -/
def statesToJourneys (states : Array Drawn) : Array Journey := Id.run do
  let mut journeys : Array Journey := #[]
  let mut current : Array Leg := #[]
  let mut prevEnd : Option Int := none
  let mut pendingStay := false
  let mut pendingSleep := false
  let close (current : Array Leg) (journeys : Array Journey) : Array Journey :=
    match current[0]?, current.back? with
    | some first, some last =>
      journeys.push { startTs := first.startTs, endTs := last.endTs, legs := current }
    | _, _ => journeys
  for s in states do
    if let some p := prevEnd then
      if s.startTs - p > Verified.Eval.Journeys.ROW_MINUTE_S
          && !(current.back?.any fun l => isRideModeStr l.mode) then
        pendingStay := true
    prevEnd := some (max s.endTs (prevEnd.getD s.endTs))
    if !isMovementModeStr s.mode then
      pendingStay := true
      if s.mode == "sleeping" then pendingSleep := true
      continue
    if pendingSleep || (pendingStay && !isRideModeStr s.mode) then
      journeys := close current journeys
      current := #[]
    pendingStay := false
    pendingSleep := false
    let mode := canonicalModeStr s.mode
    let mut merged := false
    if let some last := current.back? then
      if last.mode == mode && s.startTs ≤ last.endTs + 1 then
        current := current.pop.push { last with endTs := s.endTs }
        merged := true
    if !merged then
      current := current.push { startTs := s.startTs, endTs := s.endTs, mode, line := none, board := none, alight := none }
  return close current journeys

/-- The trip's deduped mode shape: an interchange walk between two legs of one
vehicle kind is dropped first, then consecutive identical modes collapse. -/
def modeShape (j : Journey) : Array String := Id.run do
  let legs := j.legs
  let mut kept : Array String := #[]
  for hm_i : i in [0:legs.size] do
    have hb_i : i < legs.size := hm_i.upper
    let m := legs[i].mode
    if m == "walking" && i > 0 then
      if hn : i + 1 < legs.size then
        let prev := legs[i - 1].mode
        let next := legs[i+1].mode
        if prev == next && (prev == "train" || prev == "bus") then continue
    kept := kept.push m
  let mut shape : Array String := #[]
  for m in kept do
    if (shape.back?.map (· != m)).getD true then shape := shape.push m
  return shape

/-- The pipeline journey with the most temporal overlap, or none. One journey:
a trip split in two is graded on its larger half, so a coverage failure report
should say how many journeys touched the window. -/
def bestOverlap (gt : Journey) (pipeline : Array Journey) : Option Journey := Id.run do
  let mut best : Option Journey := none
  let mut bestOv : Int := 0
  for d in pipeline do
    let ov := max 0 (min gt.endTs d.endTs - max gt.startTs d.startTs)
    if ov > bestOv then
      bestOv := ov
      best := some d
  return best

structure ClippedLeg where
  mode : String
  overlapS : Int
  durationS : Int
  deriving BEq, Repr, Inhabited

structure Result where
  startTs : Int
  endTs : Int
  expectedShape : Array String
  /-- The reconstructed shape, or `none` when nothing overlapped. -/
  actualShape : Option (Array String)
  /-- Shape equality and coverage. Both conjuncts — see the module header. -/
  matched : Bool
  uncoveredS : Int
  slackS : Int
  /-- Where the best-overlapping journey starts and ends: `uncoveredS` cannot
  say which end is short, and the two need opposite fixes. -/
  matchStartTs : Option Int
  matchEndTs : Option Int
  clippedLegs : Array ClippedLeg
  deriving Inhabited

/-- Per-ground-truth-journey reconstruction outcome. -/
def journeyShapeResults (gtJourneys pipelineJourneys : Array Journey) : Array Result :=
  gtJourneys.map fun gt =>
    let overlapOf (s e : Int) : Int := min gt.endTs e - max gt.startTs s
    let mtch := bestOverlap gt pipelineJourneys
    let expectedShape := modeShape gt
    -- Compare structure over the audited span only: the ground truth asserts
    -- nothing outside its rows, so a pipeline leg entirely beyond the window
    -- must not fail the match.
    let clipped : Option (Array Leg) := mtch.map fun m => Id.run do
      let inSpan := m.legs.filter (fun l => overlapOf l.startTs l.endTs > 0)
      let mut lo := 0
      let mut hi := inSpan.size
      let thin := fun (l : Leg) => decide (overlapOf l.startTs l.endTs < SHAPE_MIN_LEG_OVERLAP_S)
      while lo < hi && (inSpan[lo]?.map thin).getD false do
        lo := lo + 1
      while hi > lo && (inSpan[hi-1]?.map thin).getD false do
        hi := hi - 1
      return (inSpan.extract lo hi)
    let actualShape : Option (Array String) :=
      match mtch, clipped with
      | some m, some cs => if cs.size > 0 then some (modeShape { m with legs := cs }) else none
      | _, _ => none
    let overlap := match mtch with
      | none => 0
      | some m => max 0 (min gt.endTs m.endTs - max gt.startTs m.startTs)
    let uncovered := gt.endTs - gt.startTs - overlap
    let spanS := gt.endTs - gt.startTs
    -- The floor decides the verdict, the rounded value only gets reported —
    -- see the note above the constants.
    let slackTest := if spanS ≥ COVERAGE_FRAC_FLOOR_S then spanS / 5 else COVERAGE_SLACK_MIN_S
    let slackReported :=
      if spanS ≥ COVERAGE_FRAC_FLOOR_S then (2 * spanS + 5) / 10 else COVERAGE_SLACK_MIN_S
    let covered := uncovered ≤ slackTest
    { startTs := gt.startTs, endTs := gt.endTs, expectedShape, actualShape,
      matched := (match actualShape with
        | some a => a == expectedShape && covered
        | none => false),
      uncoveredS := uncovered, slackS := slackReported,
      matchStartTs := mtch.map (·.startTs), matchEndTs := mtch.map (·.endTs),
      clippedLegs := (clipped.getD #[]).map fun l =>
        { mode := l.mode, overlapS := max 0 (overlapOf l.startTs l.endTs),
          durationS := l.endTs - l.startTs } }


/-! ## Witnesses

⚠ Synthetic only: small integer times and the eight mode words, nothing from a
real day. They pin the branches by hand, so a failure names the rule.
-/

section Witnesses

private def sj (xs : List (Int × Int × String)) : Array Journey :=
  statesToJourneys (xs.map fun (s, e, m) => ({ startTs := s, endTs := e, mode := m } : Drawn)).toArray

-- A stay before a ride is its wait (one journey), however long; the day walking
-- away from a stay makes it a visit (two); a sleep ends it.
#guard (sj [(0, 100, "walking"), (100, 160, "stationary"), (160, 260, "train")]).size == 1
#guard (sj [(0, 100, "walking"), (100, 3000, "stationary"), (3000, 3100, "train")]).size == 1
#guard (sj [(0, 100, "walking"), (100, 160, "stationary"), (160, 260, "walking")]).size == 2
#guard (sj [(0, 100, "walking"), (100, 160, "stationary"), (160, 260, "walking"), (260, 360, "train")]).size == 2
#guard (sj [(0, 100, "walking"), (100, 200, "sleeping"), (200, 300, "train")]).size == 2
-- Time no state covers is a stay nobody drew: it bounds unless a ride follows.
#guard (sj [(0, 100, "walking"), (1000, 1100, "walking")]).size == 2
#guard (sj [(0, 100, "walking"), (1000, 1100, "train")]).size == 1
#guard (sj [(0, 100, "train"), (1000, 1100, "walking")]).size == 1

private def leg (s e : Int) (m : String) : Leg :=
  { startTs := s, endTs := e, mode := m, line := none, board := none, alight := none }

private def jr (s e : Int) (ls : List Leg) : Journey :=
  { startTs := s, endTs := e, legs := ls.toArray }

/-! ### statesToJourneys -/

-- A non-movement state before a ride is a pause, not a journey boundary: what
-- splits a journey is a stay the day leaves on foot, a sleep, or uncovered
-- time.
#guard (sj [(0, 100, "stationary"), (100, 200, "walking")]).size == 1
#guard (sj [(0, 100, "stationary"), (0, 100, "sleeping")]).size == 0
#guard (sj []).size == 0
-- Touching same-mode states merge, and the tolerance is exactly one second.
#guard ((sj [(0, 100, "walking"), (100, 200, "walking")])[0]!).legs.size == 1
#guard ((sj [(0, 100, "walking"), (101, 200, "walking")])[0]!).legs.size == 1
#guard ((sj [(0, 100, "walking"), (102, 200, "walking")])[0]!).legs.size == 2
#guard ((sj [(0, 100, "walking"), (100, 200, "walking")])[0]!).legs[0]!.endTs == 200
-- Different modes never merge, however close.
#guard ((sj [(0, 100, "walking"), (100, 200, "train")])[0]!).legs.size == 2
-- `sleeping` folds to `stationary` and so is not a leg; an unknown mode is not
-- a movement mode either, and is dropped rather than becoming one.
#guard (sj [(0, 100, "teleporting")]).size == 0
-- Uncovered time beyond the rows' minute is a stay; inside it is rounding.
#guard (sj [(0, 100, "walking"), (160, 260, "walking")]).size == 1
#guard (sj [(0, 100, "walking"), (161, 260, "walking")]).size == 2
#guard (sj [(0, 100, "walking"), (160, 260, "walking")])[0]!.endTs == 260
#guard (sj [(0, 100, "walking"), (401, 500, "walking")])[0]!.endTs == 100
-- The journey's bounds are its first leg's start and its last leg's end.
#guard (sj [(10, 100, "walking"), (100, 250, "train")])[0]!.startTs == 10
#guard (sj [(10, 100, "walking"), (100, 250, "train")])[0]!.endTs == 250

/-! ### modeShape -/

#guard modeShape (jr 0 100 [leg 0 50 "walking", leg 50 100 "walking"]) == #["walking"]
#guard modeShape (jr 0 100 [leg 0 50 "walking", leg 50 100 "train"]) == #["walking", "train"]
#guard modeShape (jr 0 0 []) == #[]
-- The interchange walk. A walk between two legs of the same vehicle kind is
-- smoothed away, and the two vehicle legs it separated then dedupe together.
#guard modeShape (jr 0 300 [leg 0 100 "train", leg 100 200 "walking", leg 200 300 "train"])
    == #["train"]
#guard modeShape (jr 0 300 [leg 0 100 "bus", leg 100 200 "walking", leg 200 300 "bus"])
    == #["bus"]
-- Only for the same vehicle: train → walk → bus is a real three-leg trip.
#guard modeShape (jr 0 300 [leg 0 100 "train", leg 100 200 "walking", leg 200 300 "bus"])
    == #["train", "walking", "bus"]
-- Only for a vehicle: a walk between two drives is not an interchange.
#guard modeShape (jr 0 300 [leg 0 100 "driving", leg 100 200 "walking", leg 200 300 "driving"])
    == #["driving", "walking", "driving"]
-- And never at an end — the walk to and from the station is the trip.
#guard modeShape (jr 0 200 [leg 0 100 "walking", leg 100 200 "train"]) == #["walking", "train"]
#guard modeShape (jr 0 400 [leg 0 100 "walking", leg 100 200 "train",
                            leg 200 300 "walking", leg 300 400 "train"])
    == #["walking", "train"]

/-! ### bestOverlap -/

#guard (bestOverlap (jr 0 100 []) #[]) == none
-- Zero overlap is not a match: touching at a boundary picks nothing.
#guard (bestOverlap (jr 0 100 []) #[jr 100 200 []]) == none
#guard (bestOverlap (jr 0 100 []) #[jr 200 300 []]) == none
#guard (bestOverlap (jr 0 100 []) #[jr 50 200 []]) == some (jr 50 200 [])
-- The largest overlap wins…
#guard (bestOverlap (jr 0 100 []) #[jr 90 200 [], jr 20 200 []]) == some (jr 20 200 [])
-- …and a tie keeps the first, because the comparison is strictly greater.
#guard (bestOverlap (jr 0 100 []) #[jr 0 50 [], jr 50 100 []]) == some (jr 0 50 [])

/-! ### journeyShapeResults -/

private def one (gt : Journey) (pipe : List Journey) : Result :=
  (journeyShapeResults #[gt] pipe.toArray)[0]!

private def walkTrainWalk : Journey :=
  jr 0 1800 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1800 "walking"]

-- An exact reconstruction matches.
#guard (one walkTrainWalk [walkTrainWalk]).matched
#guard (one walkTrainWalk [walkTrainWalk]).expectedShape == #["walking", "train", "walking"]
#guard (one walkTrainWalk [walkTrainWalk]).actualShape == some #["walking", "train", "walking"]
#guard (one walkTrainWalk [walkTrainWalk]).uncoveredS == 0
-- Nothing overlapping: no shape, no match, and the whole span uncovered.
#guard (one walkTrainWalk []).actualShape == none
#guard !(one walkTrainWalk []).matched
#guard (one walkTrainWalk []).uncoveredS == 1800
#guard (one walkTrainWalk []).matchStartTs == none
-- Shape alone is not a match. This fragment has the identical shape and
-- covers a third of the trip, which shape-only scoring passes.
private def fragment : Journey :=
  jr 0 600 [leg 0 100 "walking", leg 100 500 "train", leg 500 600 "walking"]
#guard (one walkTrainWalk [fragment]).actualShape == some #["walking", "train", "walking"]
#guard (one walkTrainWalk [fragment]).expectedShape == (one walkTrainWalk [fragment]).actualShape.getD #[]
#guard !(one walkTrainWalk [fragment]).matched
#guard (one walkTrainWalk [fragment]).uncoveredS == 1200
#guard (one walkTrainWalk [fragment]).slackS == 360
-- The allowance: a 1800 s span gets 360 s, so 300 s short still covers.
private def slightlyShort : Journey :=
  jr 0 1500 [leg 0 300 "walking", leg 300 1200 "train", leg 1200 1500 "walking"]
#guard (one walkTrainWalk [slightlyShort]).uncoveredS == 300
#guard (one walkTrainWalk [slightlyShort]).matched
-- The end clip. A leg reaching under a minute into the span is trimmed at an
-- end, so 36 s of a walk adds no third element to the shape.
private def spillingWalk : Journey :=
  jr 0 1830 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1770 "walking",
             leg 1770 1830 "driving"]
#guard (one (jr 0 1800 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1800 "walking"])
    [spillingWalk]).actualShape == some #["walking", "train", "walking"]
#guard (one walkTrainWalk [spillingWalk]).matched
-- A leg reaching a full minute in is kept, and the shape then differs.
private def spillingLonger : Journey :=
  jr 0 1900 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1740 "walking",
             leg 1740 1900 "driving"]
#guard (one walkTrainWalk [spillingLonger]).actualShape
    == some #["walking", "train", "walking", "driving"]
#guard !(one walkTrainWalk [spillingLonger]).matched
-- And only at the ends. A sub-minute interior leg is kept, because dropping
-- it would merge its neighbours through the dedupe, collapsing
-- [walking,train,walking] into [walking].
private def shortInterior : Journey :=
  jr 0 1800 [leg 0 890 "walking", leg 890 920 "train", leg 920 1800 "walking"]
#guard (one (jr 0 1800 [leg 0 900 "walking", leg 900 1800 "walking"]) [shortInterior]).actualShape
    == some #["walking", "train", "walking"]
-- clippedLegs report how much of each leg the ground truth was talking about.
#guard (one walkTrainWalk [spillingLonger]).clippedLegs.size == 4
#guard ((one walkTrainWalk [spillingLonger]).clippedLegs[3]!).overlapS == 60
#guard ((one walkTrainWalk [spillingLonger]).clippedLegs[3]!).durationS == 160
-- The ends of the best-overlapping journey, which `uncoveredS` cannot give.
#guard (one walkTrainWalk [fragment]).matchStartTs == some 0
#guard (one walkTrainWalk [fragment]).matchEndTs == some 600
-- The floor allowance applies below 1200 s and the fraction above it.
#guard (one (jr 0 600 []) []).slackS == 240
#guard (one (jr 0 1200 []) []).slackS == 240
#guard (one (jr 0 1205 []) []).slackS == 241
-- Math.round, not a floor: a 1203 s span reports 241 while flooring to 240.
#guard (one (jr 0 1203 []) []).slackS == 241
-- Every ground-truth journey gets exactly one result, in order.
#guard (journeyShapeResults #[jr 0 100 [], jr 200 300 []] #[]).size == 2
#guard (journeyShapeResults #[] #[jr 0 100 []]).size == 0

end Witnesses

end Verified.Eval.JourneyShape
