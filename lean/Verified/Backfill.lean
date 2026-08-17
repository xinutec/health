import Verified.Sync

/-!
# Backfill orchestration — what a stream does next

`src/sync.ts` walks each stream backwards through history, and the walk is
almost entirely rules: when to fetch, when to give up for this run, and when a
stream has reached the end of its own history. The IO around it is three lines —
read a cursor, call a fetcher, write a cursor back.

Those rules were spread across two ~50-line loops that differ only in their unit
(a day, a 30-day window), and the difference in behaviour between them was
accidental rather than intended. Here each is one total function from the state
to the next step, so the two can be compared by reading them side by side.

## Why "complete" is the dangerous answer

`pause` is free — the next scheduled run picks up where this one stopped.
`complete` is DURABLE: it writes `backfill_<stream>_complete = true`, and a
stream that says it is complete is never walked again without someone clearing
that flag by hand. Every path to it below is therefore about the DATA (the floor
is reached, the cursor cannot name a day, the history has run out) and never
about this run's circumstances.

⚠ A rate-limited run must never conclude a stream is complete. That is the
failure `shouldAdvanceEmptyStreak` already guards at the day level — a transient
5xx counted as an empty day truncated history after 14 of them — and the same
mistake at the stream level is what `pause` exists to prevent.

## One ordering difference from the TypeScript, deliberate

The TypeScript checks the budget BEFORE the cursor on entry, and AFTER it inside
the loop, so a stream whose cursor sits at the floor is marked complete on one
path and merely skipped on the other. That asymmetry is a consequence of where
the `while` condition sits, not a decision anybody made.

Here the data questions are always asked first. A cursor at the floor means the
stream IS complete, and how much budget is left has no bearing on whether that
is true.
-/

namespace Verified.Backfill

/-- Below this remaining call budget a backfill stops for this run.

Higher than the per-stream fetch floors so a stream stops between days rather
than part-way through one, and higher than the client's own floor so the walk
ends before the client starts refusing calls. -/
def BACKFILL_BUDGET_FLOOR : Int := 15

/-- Consecutive empty days that mark an intraday stream complete. -/
def DEFAULT_MAX_EMPTY_DAYS : Int := 14

/-- Consecutive empty windows that mark a range stream complete. Far lower than
the day count because a window is 30 days: three empty windows is 90 days with
nothing in them. -/
def DEFAULT_MAX_EMPTY_WINDOWS : Int := 3

/-- The largest range Fitbit's daily-summary endpoints accept in one call. -/
def RANGE_WINDOW_DAYS : Int := 30

/-- Why a stream stopped for good. Carried so the caller can log which of the
three it was — they look identical in `sync_state` and mean different things. -/
inductive CompleteReason where
  /-- The walk reached the earliest date the backfill may consider. -/
  | reachedFloor
  /-- The stored cursor does not name a day. ⚠ This is the runaway-cursor
  case: rather than compounding a malformed value, stop. -/
  | cursorUnusable
  /-- Enough consecutive empty days or windows that the history has run out. -/
  | emptyStreak
  deriving Repr, DecidableEq

/-- What an intraday stream should do next. -/
inductive Step where
  /-- Fetch this day, then call again with it as the cursor. -/
  | fetch (date : String)
  /-- Stop for this run. The cursor stays where it is; nothing is written. -/
  | pause
  /-- Stop for good, and record it. -/
  | complete (reason : CompleteReason)
  deriving Repr, DecidableEq

/-- What a range stream should do next. -/
inductive RangeStep where
  /-- Fetch this inclusive `[start, end]` window, then call again with `start`
  as the cursor. -/
  | fetch (start : String) (endDate : String)
  | pause
  | complete (reason : CompleteReason)
  deriving Repr, DecidableEq

/-- The next step for an intraday stream.

`cursor` is the OLDEST day already fetched — so the day to fetch is the one
before it. On a stream's first run the caller passes the forward sync's start
date, which has been fetched by the forward pass.

The order of the questions is the specification, and it is the one thing to read
carefully: data first, then history, then this run's budget. -/
def decideStep (remaining emptyStreak maxEmpty : Int) (cursor floor : String) : Step :=
  match Verified.Civil.parseDate cursor with
  | none => .complete .cursorUnusable
  | some _ =>
    match Verified.Sync.prevDayBounded cursor floor with
    | none => .complete .reachedFloor
    | some prev =>
      if emptyStreak ≥ maxEmpty then .complete .emptyStreak
      else if remaining ≤ BACKFILL_BUDGET_FLOOR then .pause
      else .fetch prev

/-- The next step for a range stream. The same shape at a coarser unit.

Two bounded steps rather than one: the window ENDS the day before the cursor,
and then spans `windowDays` back from there. Both can hit the floor, and both
answers are `reachedFloor`. -/
def decideRangeStep (remaining emptyStreak maxEmpty windowDays : Int)
    (cursor floor : String) : RangeStep :=
  match Verified.Civil.parseDate cursor with
  | none => .complete .cursorUnusable
  | some _ =>
    match Verified.Sync.prevDayBounded cursor floor with
    | none => .complete .reachedFloor
    | some windowEnd =>
      match Verified.Sync.prevWindowBounded windowEnd windowDays floor with
      | none => .complete .reachedFloor
      | some (s, e) =>
        if emptyStreak ≥ maxEmpty then .complete .emptyStreak
        else if remaining ≤ BACKFILL_BUDGET_FLOOR then .pause
        else .fetch s e

/-- Order streams so the one whose cursor is most recent goes first.

A freshly-deployed stream has no cursor and takes `fallback` — typically today —
so it sorts to the front and catches up before the streams already digging
through 2024. Without this, one deep backfill starves every newer stream for
many scheduled runs.

Stable, and that matters: two streams at the same cursor keep their declared
order, so the priority between them is a property of the list the caller wrote
rather than of the sort. Compared lexicographically, exact for `YYYY-MM-DD`. -/
def orderByCursorRecency (streams : List (String × Option String)) (fallback : String)
    : List String :=
  let keyed := streams.map (fun (name, cursor) => (name, cursor.getD fallback))
  (keyed.mergeSort (fun a b => a.2 ≥ b.2)).map Prod.fst

/-! ## Guards

Both sides of every boundary. `complete` is durable, so its edges are the ones
that matter most. -/

private def FLOOR : String := "2010-01-01"

-- The ordinary step: fetch the day before the cursor.
#guard decideStep 150 0 14 "2026-08-17" FLOOR == .fetch "2026-08-16"
#guard decideStep 150 13 14 "2026-08-17" FLOOR == .fetch "2026-08-16"
-- Month and leap rollovers come from `Civil`.
#guard decideStep 150 0 14 "2026-03-01" FLOOR == .fetch "2026-02-28"
#guard decideStep 150 0 14 "2024-03-01" FLOOR == .fetch "2024-02-29"

-- The budget boundary is `≤`: exactly at the floor is a pause, one above fetches.
#guard decideStep 15 0 14 "2026-08-17" FLOOR == .pause
#guard decideStep 16 0 14 "2026-08-17" FLOOR == .fetch "2026-08-16"
#guard decideStep 0 0 14 "2026-08-17" FLOOR == .pause

-- The streak boundary is `≥`: exactly at the maximum completes.
#guard decideStep 150 14 14 "2026-08-17" FLOOR == .complete .emptyStreak
#guard decideStep 150 15 14 "2026-08-17" FLOOR == .complete .emptyStreak

-- ⚠ A SPENT BUDGET NEVER COMPLETES A STREAM. Both conditions hold here and the
-- streak wins, because the streak is a statement about the data and the budget
-- is a statement about this run.
#guard decideStep 0 14 14 "2026-08-17" FLOOR == .complete .emptyStreak
-- And with the streak not met, a spent budget only ever pauses.
#guard decideStep 0 13 14 "2026-08-17" FLOOR == .pause

-- The floor is exclusive and beats both the streak and the budget, because a
-- stream at the floor is complete whatever else is true.
#guard decideStep 150 0 14 "2010-01-02" FLOOR == .complete .reachedFloor
#guard decideStep 150 0 14 "2010-01-01" FLOOR == .complete .reachedFloor
#guard decideStep 0 0 14 "2010-01-02" FLOOR == .complete .reachedFloor
#guard decideStep 0 20 14 "2010-01-02" FLOOR == .complete .reachedFloor

-- ⚠ The runaway cursor, reported as its own reason rather than as the floor.
#guard decideStep 150 0 14 "-000026-02" FLOOR == .complete .cursorUnusable
#guard decideStep 150 0 14 "not-a-date" FLOOR == .complete .cursorUnusable
#guard decideStep 150 0 14 "2026-2-3" FLOOR == .complete .cursorUnusable
#guard decideStep 150 0 14 "2026-02-30" FLOOR == .complete .cursorUnusable
#guard decideStep 150 0 14 "" FLOOR == .complete .cursorUnusable
-- A spent budget does not hide it: the cursor is unusable either way.
#guard decideStep 0 0 14 "not-a-date" FLOOR == .complete .cursorUnusable

-- The window ends the day BEFORE the cursor and spans 30 inclusive days back.
#guard decideRangeStep 150 0 3 30 "2026-08-17" FLOOR == .fetch "2026-07-18" "2026-08-16"
#guard decideRangeStep 150 0 3 1 "2026-08-17" FLOOR == .fetch "2026-08-16" "2026-08-16"
-- Straddling the floor clamps the start up rather than reaching 2009.
#guard decideRangeStep 150 0 3 30 "2010-01-20" FLOOR == .fetch FLOOR "2010-01-19"
-- Same boundaries as the day walk, at window granularity.
#guard decideRangeStep 15 0 3 30 "2026-08-17" FLOOR == .pause
#guard decideRangeStep 16 0 3 30 "2026-08-17" FLOOR == .fetch "2026-07-18" "2026-08-16"
#guard decideRangeStep 150 3 3 30 "2026-08-17" FLOOR == .complete .emptyStreak
#guard decideRangeStep 0 3 3 30 "2026-08-17" FLOOR == .complete .emptyStreak
#guard decideRangeStep 0 2 3 30 "2026-08-17" FLOOR == .pause
#guard decideRangeStep 150 0 3 30 "2010-01-02" FLOOR == .complete .reachedFloor
#guard decideRangeStep 150 0 3 30 "2010-01-01" FLOOR == .complete .reachedFloor
#guard decideRangeStep 150 0 3 30 "garbage" FLOOR == .complete .cursorUnusable
-- A window count below one cannot make progress, so it is the floor answer
-- rather than a fetch of nothing.
#guard decideRangeStep 150 0 3 0 "2026-08-17" FLOOR == .complete .reachedFloor

-- Most recent cursor first.
#guard orderByCursorRecency
  [("hr", some "2024-03-01"), ("steps", some "2026-08-01"), ("hrv", some "2025-01-01")]
  "2026-08-17" == ["steps", "hrv", "hr"]
-- ⚠ A stream with no cursor takes the fallback and sorts to the FRONT — the
-- whole point, so a newly-deployed stream is not starved by a deep backfill.
#guard orderByCursorRecency
  [("hr", some "2024-03-01"), ("steps", none)] "2026-08-17" == ["steps", "hr"]
-- Stable: equal cursors keep their declared order, both ways round.
#guard orderByCursorRecency
  [("a", some "2026-01-01"), ("b", some "2026-01-01")] "2026-08-17" == ["a", "b"]
#guard orderByCursorRecency
  [("b", some "2026-01-01"), ("a", some "2026-01-01")] "2026-08-17" == ["b", "a"]
#guard orderByCursorRecency [] "2026-08-17" == []
#guard orderByCursorRecency [("only", none)] "2026-08-17" == ["only"]

end Verified.Backfill
