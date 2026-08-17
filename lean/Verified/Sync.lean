import Verified.Civil

/-!
# Sync decisions — the pure rules the Fitbit ingestion walks by

Three functions the Rust backend used to carry, moved here because they DECIDE
things rather than move bytes, and each one guards against a failure that has
already happened in production.

## Why these are worth proving rather than testing

`prevDayBounded` exists because a skip condition that always fired walked a
backfill cursor indefinitely backward, crossed year 0, and wrote `-000026-02`
into `sync_state`. The TypeScript defends against that with a regex and a
comparison — two guards bolted onto arithmetic that could still produce the bad
state. Here it cannot: [`Verified.Civil.parseDate`] yields three integers or
nothing, so there is no path from a malformed string to a malformed successor.

The rate-limit decision is the difference between a CronJob that resumes next
tick and one killed at its `activeDeadlineSeconds`, which surfaces as a spurious
`Failed` and reads as a broken sync rather than a spent budget.
-/

namespace Verified.Sync

/-! ## Rate limiting -/

/-- Below this remaining count the client stops issuing calls. -/
def RATE_LIMIT_FLOOR : Int := 5

/-- What a depleted-or-not client should do before its next call. -/
inductive RateLimitAction where
  /-- Budget left, or the window already turned over. -/
  | proceed
  /-- Budget spent, reset near enough to ride out in-process. -/
  | sleep (ms : Int)
  /-- Budget spent, reset too far out. Bail; the next scheduled run resumes. -/
  | exhausted (resumeInSec : Int)
  deriving Repr, DecidableEq

/-- The decision.

`msUntilReset ≤ 0` means the window has already turned over, so the remaining
count is stale — proceed and let the response headers correct it.

The resume time rounds UP. Reporting a moment before the budget actually returns
sends the caller straight back into a 429, and it is the caller's cue for when to
come back. -/
def decideRateLimitWait (remaining msUntilReset maxWaitMs : Int) : RateLimitAction :=
  if remaining > RATE_LIMIT_FLOOR || msUntilReset ≤ 0 then .proceed
  else if msUntilReset > maxWaitMs then
    .exhausted ((msUntilReset + 999) / 1000)
  else .sleep msUntilReset

/-! ## Backfill cursors -/

/-- The day before `date`, refusing to reach `floor` or earlier.

`floor` is EXCLUSIVE: landing exactly on it stops the walk. Callers must stop on
`none` — that is the guard against a runaway loop. -/
def prevDayBounded (date floor : String) : Option String :=
  match Verified.Civil.parseDate date with
  | none => none
  | some (y, m, d) =>
    let (py, pm, pd) := Verified.Civil.civilFromDays (Verified.Civil.daysFromCivil y m d - 1)
    let prev := Verified.Civil.formatDate py pm pd
    -- Lexicographic, which is exact for a fixed-width `YYYY-MM-DD` and is what
    -- the TypeScript compares.
    if prev ≤ floor then none else some prev

/-- The next older `[start, end]` window of `windowDays` inclusive days.

`start` is clamped UP to `floor`, so a window may straddle the floor but never
reaches before it. `none` when `windowDays < 1`, `end` does not parse, or `end`
is at or before `floor`. -/
def prevWindowBounded (endDate : String) (windowDays : Int) (floor : String)
    : Option (String × String) :=
  if windowDays < 1 then none
  else match Verified.Civil.parseDate endDate with
    | none => none
    | some (y, m, d) =>
      if endDate ≤ floor then none
      else
        let z := Verified.Civil.daysFromCivil y m d
        let (sy, sm, sd) := Verified.Civil.civilFromDays (z - (windowDays - 1))
        let start := Verified.Civil.formatDate sy sm sd
        some (if start < floor then floor else start, endDate)

/-! ## Guards

Values match `src/backfill.ts` and `src/fitbit/rate-limit.ts`, and both sides of
every boundary are named — the edges are where these are wrong. -/

-- Above the floor proceeds however far away the reset is.
#guard decideRateLimitWait 6 3600000 60000 == .proceed
#guard decideRateLimitWait 150 3600000 60000 == .proceed
-- `>` and not `≥`: at exactly the floor the client stops.
#guard decideRateLimitWait 5 30000 60000 == .sleep 30000
-- An already-reset window proceeds on a spent budget.
#guard decideRateLimitWait 0 0 60000 == .proceed
#guard decideRateLimitWait 0 (-5000) 60000 == .proceed
-- The cap boundary is `>` too: exactly at it is still a sleep.
#guard decideRateLimitWait 0 60000 60000 == .sleep 60000
#guard decideRateLimitWait 0 60001 60000 == .exhausted 61
-- Rounding up, never down.
#guard decideRateLimitWait 0 120000 60000 == .exhausted 120
#guard decideRateLimitWait 0 3600000 60000 == .exhausted 3600
-- The cap is honoured as given, not read from the constant.
#guard decideRateLimitWait 0 5000 1000 == .exhausted 5
#guard decideRateLimitWait 0 5000 10000 == .sleep 5000

#guard prevDayBounded "2026-08-17" "2010-01-01" == some "2026-08-16"
#guard prevDayBounded "2026-03-01" "2010-01-01" == some "2026-02-28"
#guard prevDayBounded "2024-03-01" "2010-01-01" == some "2024-02-29"
#guard prevDayBounded "2027-01-01" "2010-01-01" == some "2026-12-31"
-- The floor is exclusive.
#guard prevDayBounded "2010-01-02" "2010-01-01" == none
#guard prevDayBounded "2010-01-01" "2010-01-01" == none
#guard prevDayBounded "2009-06-01" "2010-01-01" == none
-- ⚠ The runaway cursor. A malformed value already in `sync_state` must stop the
-- walk rather than be compounded — and here it cannot even be constructed.
#guard prevDayBounded "-000026-02" "2010-01-01" == none
#guard prevDayBounded "not-a-date" "2010-01-01" == none
#guard prevDayBounded "2026-2-3" "2010-01-01" == none
#guard prevDayBounded "2026-02-30" "2010-01-01" == none
#guard prevDayBounded "" "2010-01-01" == none

#guard prevWindowBounded "2026-08-17" 7 "2010-01-01" == some ("2026-08-11", "2026-08-17")
#guard prevWindowBounded "2026-08-17" 1 "2010-01-01" == some ("2026-08-17", "2026-08-17")
-- Straddling the floor clamps the start up rather than reaching 2009.
#guard prevWindowBounded "2010-01-05" 30 "2010-01-01" == some ("2010-01-01", "2010-01-05")
#guard prevWindowBounded "2026-08-17" 0 "2010-01-01" == none
#guard prevWindowBounded "2026-08-17" (-5) "2010-01-01" == none
#guard prevWindowBounded "2010-01-01" 7 "2010-01-01" == none
#guard prevWindowBounded "2009-12-31" 7 "2010-01-01" == none
#guard prevWindowBounded "garbage" 7 "2010-01-01" == none

end Verified.Sync
