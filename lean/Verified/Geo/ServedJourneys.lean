import Verified.Geo.DayState
import Verified.Geo.RailAbsorbers
import Verified.Geo.EpisodeGeometry
import Verified.Eval.Journeys

/-!
# Journeys assembled from the SERVED day states

The timeline draws a run of consecutive travelling rows as one collapsible
journey. That folding lives in the frontend today (`coalesceJourneys`,
`timeline.component.ts`), which makes it a backend rule the client re-derives —
the class #339 tracks. This module is the backend's answer, so #230 can delete
the client's copy.

## The rule is the SERVING rule, not the scorer's

`Verified.Eval.Journeys.groundTruthJourneys` also groups legs into journeys, and
it is NOT the same rule: it absorbs a stay shorter than `JOURNEY_PAUSE_MAX_S`
into the journey as a pause. The timeline does not — any non-travelling row
ends the run, because a visit between two transit legs is the thing the reader
is looking at.

Both are right for their own question. The scorer asks "was this one trip?";
the timeline asks "what should collapse into one row?". So this module shares
the `Journey`/`Leg` TYPE with the scorer and keeps the serving rule, rather
than defining a third journey type for the same day.

## ⚠ `isJourneyMode` is NOT `Eval.Journeys.isMovementMode`

They disagree, and the corpus cannot show it. `isMovementMode` omits `vehicle`
and `boat`; the timeline treats both as travel (`modes.ts`, `moving: true`), and
the pipeline EMITS both — `SegmentPasses` refines an unidentified ride to
`vehicle`, and `RefineMode` names a waterway leg `boat`. Neither mode occurs in
the 42-day corpus, so a gate cannot tell the two predicates apart; a real day
with an unidentified ride would split one drawn journey into two.

So the predicate here is derived from the drawn-line list rather than restated:
`EpisodeGeometry.MOVING_MODES` plus `train`, which that list omits ONLY because
rail geometry is built in an earlier branch from the route cache rather than
from fixes.
-/

namespace Verified.Geo.ServedJourneys

open Verified.Geo.DayState (DayState Mode)
open Verified.Eval.Journeys (Leg Journey)
open Verified.Geo.RailAbsorbers (parseRailWayName)

/-- Whether a served state is a leg of a journey rather than something that ends
one. Derived from the drawn-line list so the two cannot drift apart: a mode that
draws as a track is a mode that travels. -/
def isJourneyMode (m : Mode) : Bool :=
  Verified.Geo.EpisodeGeometry.MOVING_MODES.contains m || m == "train"

/-- Stations and line come from the way-name label, and ONLY for transit. A road
name containing an arrow is not a station pair, and a `· Line` suffix on a walk
is not a line — the same rule `Eval.Journeys.lineOf` applies one field over. -/
def legOfState (s : DayState) : Leg :=
  let transit := s.mode == "train" || s.mode == "bus"
  let triple := if transit then parseRailWayName s.wayName else none
  { startTs := s.startTs
    endTs := s.endTs
    mode := s.mode
    line := triple.bind (·.line)
    board := triple.map (·.board)
    alight := triple.map (·.alight) }

/-- Fold each run of two or more consecutive travelling states into one journey.

A LONE travelling state is not a journey: the timeline leaves it as its own row,
because collapsing one leg hides its way-name behind a click and buys nothing.
That is why the threshold is two and not one. -/
def servedJourneys (states : Array DayState) : Array Journey := Id.run do
  let mut out : Array Journey := #[]
  let mut run : Array Leg := #[]
  let close : Array Leg → Array Journey → Array Journey := fun r acc =>
    if h : r.size ≥ 2 then
      acc.push { startTs := r[0]!.startTs, endTs := r[r.size - 1]!.endTs, legs := r }
    else acc
  for s in states do
    if isJourneyMode s.mode then
      run := run.push (legOfState s)
    else
      out := close run out
      run := #[]
  return close run out

/-! ## Guards -/

private def st (a b : Int) (m : Mode) (way : Option String := none) : DayState :=
  { startTs := a, endTs := b, mode := m, wayName := way }

private def TRAIN_LABEL : String := "Euston Square → King's Cross St Pancras · Circle Line"

-- Two consecutive travelling states collapse into one journey spanning both.
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "train"]).size == 1
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "train"])[0]!.startTs == 0
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "train"])[0]!.endTs == 120
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "train"])[0]!.legs.size == 2

-- A LONE travelling state is not a journey.
#guard (servedJourneys #[st 0 60 "walking"]).size == 0
#guard (servedJourneys #[st 0 60 "stationary", st 60 120 "walking", st 120 180 "stationary"]).size == 0

-- A stay between two runs ENDS the first — the timeline's rule, and the one
-- place it parts company with the scorer, which would absorb a short stay.
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "train",
                         st 120 180 "stationary",
                         st 180 240 "walking", st 240 300 "bus"]).size == 2

-- A run that reaches the end of the day still closes.
#guard (servedJourneys #[st 0 60 "stationary", st 60 120 "walking", st 120 180 "train"]).size == 1

-- ⚠ THE DIVERGENCE THIS MODULE EXISTS TO AVOID. `vehicle` travels, so it joins
-- the run rather than splitting it in two. `Eval.Journeys.isMovementMode` would
-- split here, and no corpus day would catch it.
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "vehicle", st 120 180 "walking"]).size == 1
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "vehicle", st 120 180 "walking"])[0]!.legs.size == 3
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "boat", st 120 180 "walking"]).size == 1

-- `unknown` is a GPS gap, not travel: it ends a run like any stay.
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "unknown", st 120 180 "walking"]).size == 0
-- Sleeping ends one too.
#guard (servedJourneys #[st 0 60 "walking", st 60 120 "sleeping", st 120 180 "walking"]).size == 0

-- A transit leg carries its stations and line; a walk carrying the same label
-- carries none of it.
#guard (legOfState (st 0 60 "train" (some TRAIN_LABEL))).board == some "Euston Square"
#guard (legOfState (st 0 60 "train" (some TRAIN_LABEL))).alight == some "King's Cross St Pancras"
#guard (legOfState (st 0 60 "train" (some TRAIN_LABEL))).line == some "Circle Line"
#guard (legOfState (st 0 60 "walking" (some TRAIN_LABEL))).board == none
#guard (legOfState (st 0 60 "walking" (some TRAIN_LABEL))).line == none

-- A train label with no line suffix still names both stations (#810's 16 legs).
#guard (legOfState (st 0 60 "train" (some "Euston Square → King's Cross St Pancras"))).line == none
#guard (legOfState (st 0 60 "train" (some "Euston Square → King's Cross St Pancras"))).board
  == some "Euston Square"

end Verified.Geo.ServedJourneys
