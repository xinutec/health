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

## ⚠ `isJourneyMode` is NOT `Eval.Journeys.isMovementMode`, and NOT because one is wrong

They cover different vocabularies, and an earlier version of this note got that
wrong — it claimed `isMovementMode` "omits" `vehicle` and `boat` and that a real
day would therefore split a drawn journey in two. It cannot. `isMovementMode`
takes the ground-truth `Mode`, an INDUCTIVE whose constructors are
`sleeping | stationary | walking | cycling | driving | bus | train | plane`.
There is no `vehicle` and no `boat` to omit: a human audit cell says "driving",
never "vehicle", because `vehicle` is precisely the pipeline's own label for a
ride no pass could identify. It never reaches a served state.

This predicate answers the SERVED question instead, over `DayState.mode`, a
plain `String` from `WireVocab.DAY_STATE_MODES` — which does carry `vehicle` and
`boat`, both of them emitted (`SegmentPasses` refines an unidentified ride;
`RefineMode` names a waterway leg). Neither occurs in the 42-day corpus, so no
golden day can pin them, which is why the guards below do.

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
  let mut lastCity : Option String := none
  let close : Array Leg → Array Journey → Array Journey := fun r acc =>
    if h : r.size ≥ 2 then
      acc.push { startTs := r[0]!.startTs, endTs := r[r.size - 1]!.endTs, legs := r }
    else acc
  for s in states do
    -- ⚠ A CITY HEADER ENDS A RUN, because in the client it is a ROW and any
    -- non-travelling row ends one. The header appears before a state whose city
    -- is present and differs from the last one seen — tracked across ALL states,
    -- travelling or not, exactly as `buildRowsFromStates` tracks it.
    let header := s.city.isSome && s.city != lastCity
    if s.city.isSome then lastCity := s.city
    if header then
      out := close run out
      run := #[]
    if isJourneyMode s.mode then
      run := run.push (legOfState s)
    else
      out := close run out
      run := #[]
  return close run out

/-! ## Guards -/

private def st (a b : Int) (m : Mode) (way : Option String := none)
    (city : Option String := none) : DayState :=
  { startTs := a, endTs := b, mode := m, wayName := way, city := city }

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

-- ⚠ A CITY CHANGE SPLITS THE RUN, because the client draws a header row there
-- and any non-travelling row ends a journey. Two legs either side of the change
-- are two lone legs, so neither collapses.
#guard (servedJourneys #[st 0 60 "walking" none (some "Nijmegen"),
                         st 60 120 "train" none (some "Utrecht")]).size == 0
-- The same pair inside ONE city is one journey.
#guard (servedJourneys #[st 0 60 "walking" none (some "Nijmegen"),
                         st 60 120 "train" none (some "Nijmegen")]).size == 1
-- An ABSENT city is not a change: a leg crossing cities carries none
-- (`commonCity` returns nothing unless both ends agree), and it must not split
-- the run it sits in the middle of.
#guard (servedJourneys #[st 0 60 "walking" none (some "Nijmegen"),
                         st 60 120 "train" none none,
                         st 120 180 "walking" none (some "Nijmegen")]).size == 1
-- The FIRST city seen is not a change either — there is no header above the
-- first row of the day to break anything.
#guard (servedJourneys #[st 0 60 "walking" none (some "Nijmegen"),
                         st 60 120 "train" none (some "Nijmegen")])[0]!.legs.size == 2

end Verified.Geo.ServedJourneys
