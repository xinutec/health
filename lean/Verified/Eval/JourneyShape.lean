import Verified.Eval.Journeys
/-!
# Journey reconstruction scoring (port of `src/eval/journey-score.ts`, #1048)

The gate's referee for the DRAWN timeline: does the day read as the right
sequence of trips? `Verified.Eval.Journeys.groundTruthJourneys` builds the
narrative side; this builds the PIPELINE side from the drawn state legs and
compares the two.

Together with `Verified.Eval.FloorGate` this is everything the journey floor
(`tests/golden/journey-baseline.json`) needs — that file has had no reader since
#975.

## ⚠ A MATCH IS SHAPE **AND** COVERAGE, and the second conjunct is the quiet one

Echoing the deduped mode shape is not enough. When a journey fragments — a
dark-tube ride drawn as walk + stay + walk + short train — the FIRST fragment
can carry the identical shape `[walking, train, walking]` while spanning a third
of the trip. Measured 2026-08-11: five of the corpus's fifteen unmatched
journeys reconstruct their exact expected shape and fail on coverage instead,
one of them an enforced regression nobody could attribute (#752). So
`uncoveredS` and `slackS` come back beside the verdict rather than being
recomputed by whoever reads it.

## ⚠ THE END-CLIP IS ONE MINUTE, AND ONLY AT THE ENDS

A leg crossing the audited boundary used to be kept whole however little of it
fell inside, which is how 2026-06-24 failed (#810): the walk out of the station
contributes THIRTY-SIX SECONDS to a 21-minute window and still added a third
element to the shape, against a ground truth with no row for it at all. One
corpus case clips to two seconds.

Trimming only at the ENDS is load-bearing, not caution. Dropping an INTERIOR leg
MERGES its neighbours, because `modeShape` dedupes consecutive modes — measured
on 2026-06-22, where a sub-minute train between two walks was the difference
between `[walking, train, walking]` and a collapsed `[walking]`, turning a
matching journey into a regression. Trimming an end can never join two legs.

And the bound stays at one minute rather than a fraction of the window or the
coverage slack: either would also swallow 2026-04-29's 146 s walk, where the
pipeline genuinely ends the train a quarter of the way into the audited span —
a real disagreement that must keep failing.

## The evidence, and the three rules the CORPUS cannot check

Checked differentially against the recovered TypeScript over the real corpus by
`rust/backend/tests/journey_corpus.rs`: 28 days, 92 ground-truth journeys, every
field of every result plus the pipeline journeys themselves — **920 comparisons,
0 disagreements.** Eight ablations of this file; five move that count
(interchange smoothing 13, the end clip 8, coverage-as-a-conjunct 4, clipping
interiors 3, the 240 s floor 46).

⚠ **THREE ARE SILENT ON THE CORPUS, and each is silent for a MEASURED reason
rather than an assumed one** — a silent ablation is a question, not a pass
(see the `#guard`s, which catch all three):

* **The one-second merge tolerance.** Of 411 consecutive state pairs, 221 abut
  exactly and the rest leave 8 s or more. **A gap of exactly 1 occurs zero
  times**, so `≤ last.endTs + 1` and `≤ last.endTs` cannot be told apart here.
* **The pause split being strict.** Of 216 consecutive leg pairs, **none has a
  gap within 24 s of the 300 s boundary** (the nearest is 324), so `>` and `≥`
  agree on every one.
* **`bestOverlap`'s tie-break.** Of the 92 graded journeys, 89 are touched by
  exactly one pipeline journey and 3 by two — **and no two ever tie**, so
  first-wins and last-wins agree.

Not structurally unreachable, just absent from these 42 days: a fixture with a
one-second seam or a 300 s gap would exercise them. Until one exists the
witnesses are the only thing holding those three rules.
-/

namespace Verified.Eval.JourneyShape

open Verified.Eval.Journeys

/-! ## ⚠ THE PIPELINE'S MODE IS A STRING

`Journeys.canonicalMode` and `isMovementMode` take a `Mode`, because the
narrative side comes from a parser that already decided which of eight words a
cell used. The pipeline side did not: `statesToJourneys` receives whatever the
serving path emitted, and the TypeScript compared canonical STRINGS
(`m === "sleeping" ? "stationary" : m`). Parsing to `Option Mode` here would
DROP an unrecognised mode where the original kept it and simply failed to match
— which changes journey boundaries, not just a comparison. So these two work on
strings, and the `Mode` versions stay for the narrative side. -/

/-- `sleeping` folds to `stationary`; every other string keeps its name,
recognised or not. -/
def canonicalModeStr (m : String) : String :=
  if m == "sleeping" then "stationary" else m

def isMovementModeStr (m : String) : Bool :=
  match canonicalModeStr m with
  | "walking" | "cycling" | "driving" | "bus" | "train" | "plane" => true
  | _ => false

/-! ## The coverage allowance, without floats

The original is `Math.max(COVERAGE_SLACK_FRAC * span, COVERAGE_SLACK_MIN_S)` with
`COVERAGE_SLACK_FRAC = 0.2` — a Float, compared against an integer `uncovered`
and then `Math.round`ed for the report. Both are reproduced exactly in `Int`,
and the reasoning is written down because "close enough" is not a port.

* **The TEST.** `u ≤ 0.2 * span` for integer `u` is `u ≤ ⌊0.2 * span⌋`. The
  double `0.2` is slightly ABOVE one fifth, so `0.2 * n ≥ n / 5` always and
  `⌊0.2 * n⌋ = n / 5` exactly. The fraction wins over the 240 s floor iff
  `span ≥ 1200`, and that boundary is safe in floats too: `0.2 * 1200` evaluates
  to `240.00000000000003`, above the floor rather than below it.
* **The REPORT.** `Math.round` is not the floor. `Math.round(span / 5)` is
  `(2 * span + 5) / 10` in integers for positive spans, which is where the two
  differ — a span of 1203 reports 241 and floors to 240. Reported and tested
  values are therefore computed separately, and the verdict uses the floor.
-/

/-- The span at which the fractional allowance overtakes the absolute one —
`0.2 * span ≥ 240`. -/
def COVERAGE_FRAC_FLOOR_S : Int := 1200
def COVERAGE_SLACK_MIN_S : Int := 240

/-- How much of a leg must fall INSIDE the audited span to count toward the
reconstructed shape.

One minute, because that is the resolution this scorer works at: the minute
expansion emits one entry per top-of-minute, so a leg contributing less is below
what the comparison can see. Counting it reads structure out of rounding. ⚠ This
is a floor on VISIBILITY, not a tolerance — see the module header. -/
def SHAPE_MIN_LEG_OVERLAP_S : Int := 60

/-- Merge the drawn state legs into journeys.

Consecutive states of the same canonical movement mode join when they touch
(`start ≤ prevEnd + 1`); non-movement states are skipped entirely, and a gap
longer than `pauseMaxS` between legs ends the journey.

⚠ SKIPPING a stay is not the same as BREAKING on one: a two-minute stay inside a
trip leaves the legs either side more than `pauseMaxS`… only if it really is
that long. The gap test is on the LEGS' times, so a short stay is absorbed and a
long one splits, without this needing to look at the stay at all. -/
def statesToJourneys (states : Array (Int × Int × String))
    (pauseMaxS : Int := JOURNEY_PAUSE_MAX_S) : Array Journey := Id.run do
  let mut legs : Array Leg := #[]
  for (startTs, endTs, m) in states do
    if !isMovementModeStr m then continue
    let mode := canonicalModeStr m
    let mut merged := false
    if legs.size > 0 then
      let last := legs[legs.size - 1]!
      if last.mode == mode && startTs ≤ last.endTs + 1 then
        legs := legs.set! (legs.size - 1) { last with endTs }
        merged := true
    if !merged then
      legs := legs.push { startTs, endTs, mode, line := none, board := none, alight := none }
  let mut journeys : Array Journey := #[]
  let mut current : Array Leg := #[]
  for leg in legs do
    if current.size > 0 then
      let last := current[current.size - 1]!
      if leg.startTs - last.endTs > pauseMaxS then
        journeys := journeys.push { startTs := current[0]!.startTs, endTs := last.endTs, legs := current }
        current := #[]
    current := current.push leg
  if current.size > 0 then
    journeys := journeys.push
      { startTs := current[0]!.startTs, endTs := current[current.size - 1]!.endTs, legs := current }
  return journeys

/-- The trip's deduped mode shape.

An INTERCHANGE WALK — a walk between two legs of the same vehicle kind — is
smoothed away first, then consecutive identical modes collapse (including the
two vehicle legs the dropped walk now leaves adjacent). -/
def modeShape (j : Journey) : Array String := Id.run do
  let legs := j.legs
  let mut kept : Array String := #[]
  for i in [0:legs.size] do
    let m := legs[i]!.mode
    if m == "walking" && i > 0 && i < legs.size - 1 then
      let prev := legs[i-1]!.mode
      let next := legs[i+1]!.mode
      if prev == next && (prev == "train" || prev == "bus") then continue
    kept := kept.push m
  let mut shape : Array String := #[]
  for m in kept do
    if shape.size == 0 || shape[shape.size - 1]! != m then shape := shape.push m
  return shape

/-- The pipeline journey with the most temporal overlap, or none.

⚠ ONE journey, which is a real limitation of the comparison rather than of the
pipeline: if a trip was split in two, this grades the larger half and calls the
other half uncovered. A caller reporting a coverage failure should say how many
pipeline journeys touched the window. -/
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
  /-- ⚠ Shape equality AND coverage. Both conjuncts — see the module header. -/
  matched : Bool
  uncoveredS : Int
  slackS : Int
  /-- Where the best-overlapping journey actually starts and ends.
  `uncoveredS` says a journey is SHORT and cannot say at WHICH END, and the two
  readings need opposite fixes: a pipeline that under-reconstructs, or a
  narrative window including dwell the pipeline rightly excludes. -/
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
    -- Compare structure over the AUDITED span only: the ground truth asserts
    -- nothing outside its rows, so a pipeline leg entirely beyond the window
    -- must not fail the match.
    let clipped : Option (Array Leg) := mtch.map fun m => Id.run do
      let inSpan := m.legs.filter (fun l => overlapOf l.startTs l.endTs > 0)
      let mut lo := 0
      let mut hi := inSpan.size
      while lo < hi && overlapOf inSpan[lo]!.startTs inSpan[lo]!.endTs < SHAPE_MIN_LEG_OVERLAP_S do
        lo := lo + 1
      while hi > lo && overlapOf inSpan[hi-1]!.startTs inSpan[hi-1]!.endTs < SHAPE_MIN_LEG_OVERLAP_S do
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
    -- ⚠ The floor decides the verdict, the rounded value only gets reported —
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

⚠ SYNTHETIC ONLY (#860): times are small integers and modes are the eight mode
words, so nothing here carries a real day. The SHAPES come from the corpus
incidents named in the module header.

The port is checked differentially against the recovered TypeScript over the
real corpus by `rust/backend/tests/journey_corpus.rs`; these pin the branches by
hand so a failure names the rule rather than a day.
-/

section Witnesses

private def sj (xs : List (Int × Int × String)) : Array Journey :=
  statesToJourneys xs.toArray

private def leg (s e : Int) (m : String) : Leg :=
  { startTs := s, endTs := e, mode := m, line := none, board := none, alight := none }

private def jr (s e : Int) (ls : List Leg) : Journey :=
  { startTs := s, endTs := e, legs := ls.toArray }

/-! ### statesToJourneys -/

-- Non-movement states are SKIPPED, not journey boundaries in themselves: what
-- splits a journey is the gap between the legs either side.
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
-- A gap LONGER than the pause ends the journey; exactly the pause does not.
#guard (sj [(0, 100, "walking"), (400, 500, "walking")]).size == 1
#guard (sj [(0, 100, "walking"), (401, 500, "walking")]).size == 2
#guard (sj [(0, 100, "walking"), (400, 500, "walking")])[0]!.endTs == 500
#guard (sj [(0, 100, "walking"), (401, 500, "walking")])[0]!.endTs == 100
-- The journey's bounds are its first leg's start and its last leg's end.
#guard (sj [(10, 100, "walking"), (100, 250, "train")])[0]!.startTs == 10
#guard (sj [(10, 100, "walking"), (100, 250, "train")])[0]!.endTs == 250

/-! ### modeShape -/

#guard modeShape (jr 0 100 [leg 0 50 "walking", leg 50 100 "walking"]) == #["walking"]
#guard modeShape (jr 0 100 [leg 0 50 "walking", leg 50 100 "train"]) == #["walking", "train"]
#guard modeShape (jr 0 0 []) == #[]
-- ⚠ THE INTERCHANGE WALK. A walk BETWEEN two legs of the SAME vehicle kind is
-- smoothed away, and the two vehicle legs it separated then dedupe together.
#guard modeShape (jr 0 300 [leg 0 100 "train", leg 100 200 "walking", leg 200 300 "train"])
    == #["train"]
#guard modeShape (jr 0 300 [leg 0 100 "bus", leg 100 200 "walking", leg 200 300 "bus"])
    == #["bus"]
-- Only for the SAME vehicle: train → walk → bus is a real three-leg trip.
#guard modeShape (jr 0 300 [leg 0 100 "train", leg 100 200 "walking", leg 200 300 "bus"])
    == #["train", "walking", "bus"]
-- Only for a VEHICLE: a walk between two drives is not an interchange.
#guard modeShape (jr 0 300 [leg 0 100 "driving", leg 100 200 "walking", leg 200 300 "driving"])
    == #["driving", "walking", "driving"]
-- ⚠ AND NEVER AT AN END — the walk to and from the station is the trip.
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
-- The LARGEST overlap wins…
#guard (bestOverlap (jr 0 100 []) #[jr 90 200 [], jr 20 200 []]) == some (jr 20 200 [])
-- …and a tie keeps the FIRST, because the comparison is strictly greater.
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
-- ⚠ SHAPE ALONE IS NOT A MATCH. This fragment has the IDENTICAL shape and
-- covers a third of the trip — the #752 case, which shape-only scoring passes.
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
-- ⚠ THE END CLIP. A leg reaching under a minute into the span is trimmed at an
-- END — the #810 case, where 36 s of a walk added a third element to the shape.
private def spillingWalk : Journey :=
  jr 0 1830 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1770 "walking",
             leg 1770 1830 "driving"]
#guard (one (jr 0 1800 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1800 "walking"])
    [spillingWalk]).actualShape == some #["walking", "train", "walking"]
#guard (one walkTrainWalk [spillingWalk]).matched
-- A leg reaching a FULL minute in is kept, and the shape then differs.
private def spillingLonger : Journey :=
  jr 0 1900 [leg 0 300 "walking", leg 300 1500 "train", leg 1500 1740 "walking",
             leg 1740 1900 "driving"]
#guard (one walkTrainWalk [spillingLonger]).actualShape
    == some #["walking", "train", "walking", "driving"]
#guard !(one walkTrainWalk [spillingLonger]).matched
-- ⚠ AND ONLY AT THE ENDS. A sub-minute INTERIOR leg is kept, because dropping it
-- would MERGE its neighbours through the dedupe — the 2026-06-22 case, where
-- that turned [walking,train,walking] into a collapsed [walking].
private def shortInterior : Journey :=
  jr 0 1800 [leg 0 890 "walking", leg 890 920 "train", leg 920 1800 "walking"]
#guard (one (jr 0 1800 [leg 0 900 "walking", leg 900 1800 "walking"]) [shortInterior]).actualShape
    == some #["walking", "train", "walking"]
-- clippedLegs report how much of each leg the ground truth was talking about.
#guard (one walkTrainWalk [spillingLonger]).clippedLegs.size == 4
#guard ((one walkTrainWalk [spillingLonger]).clippedLegs[3]!).overlapS == 60
#guard ((one walkTrainWalk [spillingLonger]).clippedLegs[3]!).durationS == 160
-- The ENDS of the best-overlapping journey, which `uncoveredS` cannot give.
#guard (one walkTrainWalk [fragment]).matchStartTs == some 0
#guard (one walkTrainWalk [fragment]).matchEndTs == some 600
-- The floor allowance applies below 1200 s and the fraction above it.
#guard (one (jr 0 600 []) []).slackS == 240
#guard (one (jr 0 1200 []) []).slackS == 240
#guard (one (jr 0 1205 []) []).slackS == 241
-- ⚠ Math.round, not a floor: a 1203 s span reports 241 while flooring to 240.
#guard (one (jr 0 1203 []) []).slackS == 241
-- Every ground-truth journey gets exactly one result, in order.
#guard (journeyShapeResults #[jr 0 100 [], jr 200 300 []] #[]).size == 2
#guard (journeyShapeResults #[] #[jr 0 100 []]).size == 0

end Witnesses

end Verified.Eval.JourneyShape
