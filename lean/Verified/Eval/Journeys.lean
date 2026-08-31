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

/-- A stay shorter than this is absorbed into a journey as a pause; this long or
longer ends it. Also the tolerance for unaudited time between rows. -/
def JOURNEY_PAUSE_MAX_S : Int := 5 * 60

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

/-- Build the ground-truth leg and journey structure from resolved audit rows.

⚠ SIX RULES, and each exists because something went wrong without it:

1. **A time GAP between rows longer than a pause flushes.** The audit tables are
   SPARSE — they need not list every stay — so two trips hours apart with no
   stay row between them would otherwise concatenate into one impossible demand.
2. **`unclear`, or a cell that did not parse, flushes.** It cannot assert
   continuity, so it cannot hold a journey together.
3. **A non-movement row of `JOURNEY_PAUSE_MAX_S`+ flushes; a shorter one is
   absorbed.** A platform wait does not split a journey.
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
  for row in rows do
    -- Rule 1: unaudited time between rows.
    if current.size > 0 then
      let prevEnd := current[current.size - 1]!.endTs
      if row.startTs - prevEnd > JOURNEY_PAUSE_MAX_S then
        if hasDefinite then
          journeys := journeys.push
            ⟨current[0]!.startTs, current[current.size - 1]!.endTs, current⟩
        current := #[]
        hasDefinite := false
    match row.truth with
    | none =>
      -- Rule 2, the unparsed half.
      if hasDefinite && current.size > 0 then
        journeys := journeys.push ⟨current[0]!.startTs, current[current.size-1]!.endTs, current⟩
      current := #[]; hasDefinite := false
    | some b =>
      if row.status == .unclear then
        -- Rule 2, the unclear half.
        if hasDefinite && current.size > 0 then
          journeys := journeys.push ⟨current[0]!.startTs, current[current.size-1]!.endTs, current⟩
        current := #[]; hasDefinite := false
      else if !isMovementMode b.mode then
        -- Rule 3.
        if row.endTs - row.startTs ≥ JOURNEY_PAUSE_MAX_S then
          if hasDefinite && current.size > 0 then
            journeys := journeys.push ⟨current[0]!.startTs, current[current.size-1]!.endTs, current⟩
          current := #[]; hasDefinite := false
      else
        let definite := row.status == .correct || row.status == .wrong
        -- Rule 4.
        let (from_, to) := if definite then (b.trainFrom, b.trainTo) else (none, none)
        let cmode := canonicalMode b.mode
        let cline := lineOf b.mode b.lineName
        -- Rule 5.
        let extend :=
          if current.size > 0 then
            let last := current[current.size - 1]!
            row.startTs - last.endTs ≥ 0 && row.startTs - last.endTs ≤ 60
              && cmode == last.mode && cline == last.line
              && from_.isSome && from_ == last.board && to == last.alight
          else false
        if extend then
          let i := current.size - 1
          current := current.set! i { current[i]! with endTs := row.endTs }
        else
          current := current.push
            ⟨row.startTs, row.endTs, cmode, cline, from_, to⟩
        if definite then hasDefinite := true
  -- Rule 6, at the end.
  if hasDefinite && current.size > 0 then
    journeys := journeys.push ⟨current[0]!.startTs, current[current.size-1]!.endTs, current⟩
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

private def shape (js : Array Journey) : List (Int × Int × List String) :=
  (js.map fun j => (j.startTs, j.endTs, (j.legs.map (·.mode)).toList)).toList

-- Two adjacent movement rows are ONE journey.
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 100 200 .correct .train])
       == [(0, 200, ["walking", "train"])]

-- ⚠ RULE 1 — unaudited time. The tables are SPARSE, so a gap longer than a
-- pause is time we cannot assert continuity across. Without this, two trips
-- hours apart with no stay row between them become one impossible demand.
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking, w 1000 1100 .correct .walking])
       == [(0, 100, ["walking"]), (1000, 1100, ["walking"])]

-- ⚠ RULE 2 — `unclear` cannot hold a journey together.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 200 .unclear .walking, w 200 300 .correct .walking])
       == [(0, 100, ["walking"]), (200, 300, ["walking"])]

-- ...and neither can a cell that did not parse.
#guard shape (groundTruthJourneys #[w 0 100 .correct .walking,
        { startTs := 100, endTs := 200, status := .correct, truth := none },
        w 200 300 .correct .walking])
       == [(0, 100, ["walking"]), (200, 300, ["walking"])]

-- ⚠ RULE 3 — a BRIEF stay is absorbed as an in-journey pause (a platform wait
-- does not split a trip)...
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 200 .correct .stationary, w 200 300 .correct .train])
       == [(0, 300, ["walking", "train"])]

-- ...and a LONG one ends it. 300 s is `JOURNEY_PAUSE_MAX_S` exactly, and the
-- test is `≥`, so this is the boundary rather than a value near it.
#guard shape (groundTruthJourneys
        #[w 0 100 .correct .walking, w 100 400 .correct .stationary, w 400 500 .correct .train])
       == [(0, 100, ["walking"]), (400, 500, ["train"])]

-- Sleeping folds to stationary, so it bounds a journey like any other stay.
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

-- ...and beyond 60 s it is a second leg even for the same pair.
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
