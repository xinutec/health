import Verified.Eval.GroundTruth
/-!
# Ground-truth journey structure (port of `groundTruthJourneys`, #1048)

The `score-decoder` gate compares ten counts per day against
`tests/golden/decoder-scoreboard.json`. Every one of them is computed from
JOURNEYS — a maximal run of consecutive movement legs — on the ground-truth side
and the decoder side. This is the ground-truth side, and it is what
`scoreJourneys`, `scoreStations` and `countPhantomRides` all rest on.

## ⚠ THE ROWS ARRIVE RESOLVED

`Verified.Eval.GroundTruth` stops at civil time, because resolving a wall clock
in a named zone needs the tz database. So this takes `JRow` — a row whose
`startTs`/`endTs` are already unix seconds — and the shell does the conversion
between the two. Measured 2026-08-31: the repo's resolver and the deleted
TypeScript's agree on all 790 instants of this corpus.

## The rules, and every one of them is load-bearing

A `correct` row and a `wrong` row BOTH contribute legs. The cell is always the
truth, so a `wrong` row is a real leg the pipeline is known to miss — excluding
it would silently drop the very legs the score exists to demand.
-/

namespace Verified.Eval.Journeys

open Verified.Eval.GroundTruth

/-- The audit rows are written to the minute, so a gap inside one minute between
two rows is rounding, not unaudited time. The rows' own resolution, not a
tuning number: what bounds a journey is a stay or unaudited time the day does
not board a ride from, or a sleep. -/
def ROW_MINUTE_S : Int := 60

/-- One contiguous stretch of one movement mode. -/
structure Leg where
  startTs : Int
  /-- Exclusive. -/
  endTs : Int
  /-- Canonical mode — sleeping folded to stationary; only movement modes
  appear as legs. -/
  mode : String
  /-- Transit line for train/bus legs; `none` otherwise or when unknown. -/
  line : Option String
  /-- Boarding / alighting station, from the cell's `From → To`. ⚠ Asserted
  only on DEFINITE rows — a `partial` cell's stations are approximate by
  declaration and must not convict a mismatch. -/
  board : Option String
  alight : Option String
  deriving BEq, Repr, Inhabited

/-- A maximal run of consecutive movement legs, bounded by a stay, a sleep, or
unaudited time. -/
structure Journey where
  startTs : Int
  endTs : Int
  legs : Array Leg
  deriving BEq, Repr, Inhabited

/-- A ground-truth row with its times already resolved to unix seconds. -/
structure JRow where
  startTs : Int
  endTs : Int
  status : Status
  truth : Option Truth
  deriving BEq, Repr, Inhabited

/-- Sleeping folds to stationary; everything else keeps its name. -/
def canonicalMode : Mode → String
  | .sleeping | .stationary => "stationary"
  | .walking => "walking" | .cycling => "cycling" | .driving => "driving"
  | .bus => "bus" | .train => "train" | .plane => "plane"

/-- A timetabled ride: the stay before it is a wait, not a visit. -/
def isRideMode (m : Mode) : Bool :=
  match canonicalMode m with
  | "train" | "bus" | "plane" => true
  | _ => false

/-- The same over a leg's canonical mode string. -/
def isRideModeStr (m : String) : Bool :=
  m == "train" || m == "bus" || m == "plane"

/-- Modes that count as MOVING — the legs a journey is made of. Stationary and
sleeping are not legs; they bound journeys instead. -/
def isMovementMode (m : Mode) : Bool :=
  match canonicalMode m with
  | "walking" | "cycling" | "driving" | "bus" | "train" | "plane" => true
  | _ => false

/-- A line is only meaningful for transit. A `· Line` suffix on a walk is not a
line and must not become one. -/
def lineOf (m : Mode) (lineName : Option String) : Option String :=
  match canonicalMode m with
  | "train" | "bus" => lineName
  | _ => none

/-- The journey a run of legs spans, or `none` for no legs. -/
private def closeRun (current : Array Leg) : Option Journey :=
  match current[0]?, current.back? with
  | some f, some l => some ⟨f.startTs, l.endTs, current⟩
  | _, _ => none

/-- Build the ground-truth leg and journey structure from resolved audit rows.

⚠ SIX RULES, and each exists because something went wrong without it:

1. **Unaudited time between rows (beyond the rows' minute) is a stay the
   narrator did not write**, and rule 3 decides it — except straight after a
   ride, where it is the platform the day alights onto (05-15's and 06-17's two
   minutes between the train and the walk out). The audit tables are SPARSE —
   they need not list every stay — so two trips hours apart with no stay row
   between them would otherwise concatenate into one impossible demand.
2. **`unclear`, or a cell that did not parse, flushes.** It cannot assert
   continuity, so it cannot hold a journey together.
3. **A stay (or unaudited time) the day boards a RIDE from is the wait for
   it — a pause, however long and whatever it is called; a stay the day walks
   or drives away from bounds the journey; a sleep bounds it.** A platform
   wait does not split a journey — the narrator writes it as a stationary row,
   placeless or named after the station (05-18's one minute "@ Baker Street"
   between two trains), and the signal has waits of four to fourteen minutes.
   No place name is read: a visit is what the day leaves on foot. (Until
   2026-10-20 the test was a five-minute length, the TypeScript's guess; a
   name-based rule was tried the same day and merged the decoder's unnamed
   visits where the narrator's were split.)
4. **Stations come only from DEFINITE rows** (`correct`/`wrong`). A `partial`
   cell's `From → To` is approximate by declaration.
5. **Rows naming the same mode, line and station pair within 60 s EXTEND the
   leg** rather than adding another. One physical ride can span several audit
   rows when the pipeline lies about leg boundaries (a correct head row plus
   wrong tail rows); counting them separately would demand the FRAGMENTATION as
   the truth shape.
6. **A journey needs at least one DEFINITE leg to be emitted.** A `partial` row
   EXTENDS a journey — the mode is right, only a detail like the line is
   imperfect — but a run of only-partial movement is too uncertain to assert. -/
def groundTruthJourneys (rows : Array JRow) : Array Journey := Id.run do
  let mut journeys : Array Journey := #[]
  let mut current : Array Leg := #[]
  let mut hasDefinite := false
  -- The last ROW's end, pauses included: a stay covers its minutes.
  let mut lastRowEnd : Option Int := none
  -- A stay (or unaudited time) since the last leg, and whether a sleep: what it
  -- bounds is decided by the movement row after it (rules 1 and 3).
  let mut pendingStay := false
  let mut pendingSleep := false
  for row in rows do
    -- Rule 1: unaudited time between rows is an unwritten stay — after a ride,
    -- the platform it alights onto.
    if let some prevEnd := lastRowEnd then
      if row.startTs - prevEnd > ROW_MINUTE_S
          && !(current.back?.any fun l => isRideModeStr l.mode) then
        pendingStay := true
    lastRowEnd := some (max row.endTs (lastRowEnd.getD row.endTs))
    match row.truth with
    | none =>
      -- Rule 2, the unparsed half.
      if hasDefinite then
        if let some j := closeRun current then journeys := journeys.push j
      current := #[]; hasDefinite := false
    | some b =>
      if row.status == .unclear then
        -- Rule 2, the unclear half.
        if hasDefinite then
          if let some j := closeRun current then journeys := journeys.push j
        current := #[]; hasDefinite := false
      else if !isMovementMode b.mode then
        -- Rule 3: remembered; the next movement row says what it was.
        pendingStay := true
        if b.mode == .sleeping then pendingSleep := true
      else
        -- Rule 3, decided: a sleep, or a stay the day does not ride away
        -- from, bounds; the stay before a ride is its wait.
        if pendingSleep || (pendingStay && !isRideMode b.mode) then
          if hasDefinite then
            if let some j := closeRun current then journeys := journeys.push j
          current := #[]; hasDefinite := false
        pendingStay := false
        pendingSleep := false
        let definite := row.status == .correct || row.status == .wrong
        -- Rule 4.
        let (from_, to) := if definite then (b.trainFrom, b.trainTo) else (none, none)
        let cmode := canonicalMode b.mode
        let cline := lineOf b.mode b.lineName
        -- Rule 5.
        let extend :=
          match current.back? with
          | some last =>
            row.startTs - last.endTs ≥ 0 && row.startTs - last.endTs ≤ 60
              && cmode == last.mode && cline == last.line
              && from_.isSome && from_ == last.board && to == last.alight
          | none => false
        if extend then
          if let some last := current.back? then
            current := current.pop.push { last with endTs := row.endTs }
        else
          current := current.push
            ⟨row.startTs, row.endTs, cmode, cline, from_, to⟩
        if definite then hasDefinite := true
  -- Rule 6, at the end.
  if hasDefinite then
    if let some j := closeRun current then journeys := journeys.push j
  return journeys

/-! ## Witnesses

Synthetic, because the real narratives are gitignored (#860). The SHAPES are
not: the recovered TypeScript was run over the corpus first and produced 92
journeys and 228 legs, and the Lean port reproduces both exactly, every leg
field included. These pin the six rules individually so a failure names one.
-/

section Witnesses

private def w (s e : Int) (st : Status) (m : Mode)
    (line from_ to : Option String := none) : JRow :=
  { startTs := s, endTs := e, status := st,
    truth := some { mode := m, lineName := line, trainFrom := from_, trainTo := to } }

/-- A stay at a place: a visit. -/
private def wp (s e : Int) (place : String) : JRow :=
  { startTs := s, endTs := e, status := .correct,
    truth := some { mode := .stationary, place := some place } }

private def shape (js : Array Journey) : List (Int × Int × List String) :=
  (js.map fun j => (j.startTs, j.endTs, (j.legs.map (·.mode)).toList)).toList

-- Two adjacent movement rows are ONE journey.
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 100 200 .correct .train])
       == [(0, 200, ["walking", "train"])]

-- ⚠ RULE 1 — unaudited time is an unwritten stay. The tables are SPARSE, so two
-- trips hours apart with no stay row between them would otherwise become one
-- impossible demand; the day walks away from the gap, so it bounds...
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 1000 1100 .correct .walking])
       == [(0, 100, ["walking"]), (1000, 1100, ["walking"])]
-- ...where a gap the day boards a train from is the unwritten wait for it, and
-- a gap straight after a ride is the platform it alights onto...
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 1000 1100 .correct .train])
       == [(0, 1100, ["walking", "train"])]
#guard shape (groundTruthJourneys #[w 0 100 .correct .train, w 220 320 .correct .walking])
       == [(0, 320, ["train", "walking"])]
-- ...and a gap inside the minute is rounding (09:15 → 09:16).
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 160 260 .correct .walking])
       == [(0, 260, ["walking", "walking"])]

-- ⚠ RULE 2 — `unclear` cannot hold a journey together.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 200 .unclear .walking, w 200 300 .correct .walking])
       == [(0, 100, ["walking"]), (200, 300, ["walking"])]

-- ...and neither can a cell that did not parse.
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking,
        { startTs := 100, endTs := 200, status := .correct, truth := none },
        w 200 300 .correct .walking])
       == [(0, 100, ["walking"]), (200, 300, ["walking"])]

-- ⚠ RULE 3 — the stay before a RIDE is its wait, an in-journey pause (a
-- platform wait does not split a trip), however long and whatever it is
-- called (05-18's minute "@ Baker Street" between two trains)...
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 200 .correct .stationary, w 200 300 .correct .train])
       == [(0, 300, ["walking", "train"])]
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 2000 .correct .stationary, w 2000 2100 .correct .train])
       == [(0, 2100, ["walking", "train"])]
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .train, wp 100 160 "Baker Street", w 160 260 .correct .train])
       == [(0, 260, ["train", "train"])]

-- ...a stay the day walks away from ends it, however short, named or not —
-- also a wait the day walks away from to the platform (06-12's Victoria
-- forecourt): without geometry, the referee cannot tell it from Home, and a
-- rule that waited for the ride merged every trip that begins at a visit.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, wp 100 160 "Home", w 160 260 .correct .walking])
       == [(0, 100, ["walking"]), (160, 260, ["walking"])]
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 160 .correct .stationary, w 160 260 .correct .walking])
       == [(0, 100, ["walking"]), (160, 260, ["walking"])]
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, wp 100 160 "Home", w 160 260 .correct .walking,
          w 260 360 .correct .train])
       == [(0, 100, ["walking"]), (160, 360, ["walking", "train"])]

-- ...and so does a sleep.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 200 .correct .sleeping, w 200 300 .correct .train])
       == [(0, 100, ["walking"]), (200, 300, ["train"])]

-- Sleeping folds to stationary in its canonical mode; it bounds a journey.
#guard canonicalMode .sleeping == "stationary"
#guard !isMovementMode .sleeping && !isMovementMode .stationary
#guard isMovementMode .walking && isMovementMode .train && isMovementMode .plane

-- ⚠ RULE 4 — stations are asserted ONLY by definite rows. A `partial` cell's
-- `From → To` is approximate by declaration and must not convict a mismatch.
#guard ((groundTruthJourneys #[w 0 100 .correct .train none (some "A") (some "B"),
                               w 500 600 .correct .walking])[0]!.legs[0]!).board == some "A"
#guard ((groundTruthJourneys #[w 0 100 .«partial» .train none (some "A") (some "B"),
                               w 100 200 .correct .walking])[0]!.legs[0]!).board == none

-- A line belongs to transit only. A `· Line` suffix on a walk is not a line.
#guard lineOf .train (some "Metropolitan") == some "Metropolitan"
#guard lineOf .bus (some "38") == some "38"
#guard lineOf .walking (some "Metropolitan") == none

-- ⚠ RULE 5 — one physical ride can span several audit rows when the pipeline
-- lies about leg boundaries. Rows naming the same mode, line and station pair
-- within 60 s EXTEND the leg; counting them separately would demand the
-- FRAGMENTATION as the truth shape.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .train (some "Met") (some "A") (some "B"),
          w 130 200 .wrong .train (some "Met") (some "A") (some "B")])
       == [(0, 200, ["train"])]

-- ...but a different station pair is a different leg, however close in time.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .train (some "Met") (some "A") (some "B"),
          w 130 200 .correct .train (some "Met") (some "B") (some "C")])
       == [(0, 200, ["train", "train"])]

-- ...and beyond 60 s it is a second leg even for the same pair — with a stop
-- row between, or with unaudited time, which before a ride is its wait (rule 1).
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .train (some "Met") (some "A") (some "B"),
          w 100 200 .correct .stationary,
          w 200 300 .correct .train (some "Met") (some "A") (some "B")])
       == [(0, 300, ["train", "train"])]
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .train (some "Met") (some "A") (some "B"),
          w 200 300 .correct .train (some "Met") (some "A") (some "B")])
       == [(0, 300, ["train", "train"])]

-- ⚠ RULE 6 — a journey needs at least one DEFINITE leg. A `partial` row
-- EXTENDS a journey (the mode is right, only a detail is imperfect) but a run
-- of only-partial movement is too uncertain to assert at all.
#guard shape (groundTruthJourneys #[w 0 100 .«partial» .walking]) == []
#guard shape (groundTruthJourneys #[w 0 100 .«partial» .walking, w 100 200 .correct .train])
       == [(0, 200, ["walking", "train"])]

-- A `wrong` row is a REAL leg the pipeline is known to miss, and it seeds a
-- journey exactly like a `correct` one. Dropping it would silently remove the
-- legs the score exists to demand.
#guard shape (groundTruthJourneys #[w 0 100 .wrong .walking]) == [(0, 100, ["walking"])]

#guard groundTruthJourneys #[] == #[]

end Witnesses

end Verified.Eval.Journeys
