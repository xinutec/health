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

/-! ## Forward day walks -/

/-- `count` consecutive days starting at day number `z`.

Structural on `Nat`, so it terminates by construction rather than by a bound
somebody remembered to check. -/
private def daysFrom (z : Int) : Nat → List String
  | 0 => []
  | n + 1 =>
    let (y, m, d) := Verified.Civil.civilFromDays z
    Verified.Civil.formatDate y m d :: daysFrom (z + 1) n

/-- The inclusive `[startDate, endDate]` list of days a forward sync walks.

The TypeScript writes this as `for (let d = new Date(start); d <= new Date(end);
d.setDate(d.getDate() + 1))` in three separate files, and that loop has two
failure modes this shape removes:

* AN UNPARSEABLE ENDPOINT SYNCS NOTHING, SILENTLY. `new Date("garbage")` is
  `Invalid Date`, every comparison against it is `false`, so the loop body never
  runs and the caller sees a successful sync of zero days. Here a bad endpoint
  is `none` and the caller has to deal with it.
* AN ABSURD RANGE IS WALKED IN FULL. A corrupt cursor naming year 9999 asks for
  ~2.9 million days.

⚠ `maxDays` REFUSES, it does not truncate. Returning a shortened list would be a
sync that quietly did less than it reported; `none` is the caller's problem to
handle. It is a contract bound on the request, not fuel for the recursion —
`daysFrom` terminates without it.

`startDate` after `endDate` is the empty list and NOT an error: that is the
TypeScript's behaviour and it is what an already-caught-up cursor produces. -/
def dateRangeInclusive (startDate endDate : String) (maxDays : Int) : Option (List String) :=
  match Verified.Civil.parseDate startDate, Verified.Civil.parseDate endDate with
  | some (sy, sm, sd), some (ey, em, ed) =>
    let zs := Verified.Civil.daysFromCivil sy sm sd
    let ze := Verified.Civil.daysFromCivil ey em ed
    if ze < zs then some []
    else if maxDays < 1 || ze - zs + 1 > maxDays then none
    else some (daysFrom zs (ze - zs + 1).toNat)
  | _, _ => none

/-! ## The forward window -/

/-- Forward sync always re-queries at least this many days, however far the
stored cursor has advanced. -/
def SYNC_OVERLAP_DAYS : Int := 2

/-- How far back a first-ever forward sync reaches. -/
def SYNC_DEFAULT_DAYS_BACK : Int := 30

/-- The `[start, today]` window the forward pass fetches.

⚠ THE OVERLAP IS NOT A SAFETY MARGIN, IT IS THE POINT. Fitbit finalises a day's
sleep and biometrics only after you wake, and revises recent days afterwards. A
window of just `[cursor, today]` would permanently miss anything Fitbit
completed after the cursor moved past that date — last night's sleep, if every
sync that day ran while it was still being recorded. So the start is the EARLIER
of the stored cursor and today-minus-overlap, never the cursor alone.

Re-fetching is safe because every write on this path is an upsert or a
delete-then-insert, which is a property of the fetchers rather than of this
function, and is why the overlap costs only a few cheap calls.

`none` when `today` does not parse, or when a stored cursor is present and does
not — the same refusal as the backfill cursor, and for the same reason: a
malformed date must not be compounded into a window. -/
def forwardWindow (today : String) (storedCursor : Option String) : Option (String × String) :=
  match Verified.Civil.parseDate today with
  | none => none
  | some (y, m, d) =>
    let z := Verified.Civil.daysFromCivil y m d
    let dayBack := fun (n : Int) =>
      let (yy, mm, dd) := Verified.Civil.civilFromDays (z - n)
      Verified.Civil.formatDate yy mm dd
    let overlapStart := dayBack SYNC_OVERLAP_DAYS
    match storedCursor with
    | none => some (dayBack SYNC_DEFAULT_DAYS_BACK, today)
    | some c =>
      match Verified.Civil.parseDate c with
      | none => none
      -- Lexicographic, exact for fixed-width `YYYY-MM-DD`, and what the
      -- TypeScript compares.
      | some _ => some (if c < overlapStart then c else overlapStart, today)

/-- How many days of PhoneTrack history one request asks for. Matches the
`setDate(+7)` step the TypeScript walks the tz-inference window with. -/
def TRACK_CHUNK_DAYS : Int := 7

/-- How many chunks a single tz-inference window may be split into before the
request is refused outright.

Twenty-six weeks either side of the 30-day default, which covers every window
`forwardWindow` can produce and the 180-day one `refresh-focus-places` asks for.
-/
def MAX_TRACK_CHUNKS : Int := 60

private def chunksFrom (ze : Int) (days : Int) : Int → Nat → List (String × String)
  | _, 0 => []
  | zs, n + 1 =>
    let fmt := fun (z : Int) =>
      let (y, m, d) := Verified.Civil.civilFromDays z
      Verified.Civil.formatDate y m d
    let e := if zs + days < ze then zs + days else ze
    (fmt zs, fmt e) :: chunksFrom ze days (zs + days) n

/-- Split `[startDate, endDate]` into consecutive windows of `days` days.

Used to ask PhoneTrack for a long tz-inference span in pieces rather than as one
request that would time out or be truncated server-side.

⚠ **CONSECUTIVE WINDOWS TOUCH AT THEIR ENDPOINTS AND THAT IS PRESERVED, NOT
FIXED.** Chunk *k* ends on the day chunk *k+1* begins, so a fix recorded on a
boundary day is fetched twice. It is harmless downstream — `Verified.FitbitTz`
picks the nearest fix in time and a duplicate is nearest to itself — and the
TypeScript has always done it. Closing the interval would drop whichever end of
the boundary day the half-open form excluded, which is a real change to which
fixes exist, made silently, to remove a duplicate nothing minds.

⚠ **A SPAN THAT IS AN EXACT MULTIPLE OF `days` ENDS WITH A DEGENERATE CHUNK**
whose start and end are both `endDate` — one extra request that re-fetches a day
already covered. It is what the TypeScript's `chunkStart <= end` loop guard does
and it is kept, because the alternative is trading one wasted call for a silent
change to which days get fetched. The guards below name it rather than leave the
next reader to discover it from a request count.

`none` rather than a shorter list when either endpoint fails to parse, when
`days` is not positive, or when the span needs more than `maxChunks` requests.

⚠ The `maxChunks` refusal is NEW — the TypeScript has no bound and would walk a
corrupt cursor across years, one HTTP request per week, before anything noticed.
It REFUSES rather than truncating, for the reason `dateRangeInclusive` does: a
prefix of the fixes is not a smaller answer to the same question, it is a
confident wrong zone for every row past where the walk stopped. -/
def chunkRange (startDate endDate : String) (days maxChunks : Int)
    : Option (List (String × String)) :=
  match Verified.Civil.parseDate startDate, Verified.Civil.parseDate endDate with
  | some (sy, sm, sd), some (ey, em, ed) =>
    if days < 1 then none
    else
      let zs := Verified.Civil.daysFromCivil sy sm sd
      let ze := Verified.Civil.daysFromCivil ey em ed
      -- A backwards span asks for nothing, matching a `for` loop whose guard is
      -- false on entry. It is NOT an error: a caught-up cursor produces one.
      if ze < zs then some []
      else
        let count := (ze - zs) / days + 1
        if maxChunks < 1 || count > maxChunks then none
        else some (chunksFrom ze days zs count.toNat)
  | _, _ => none

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

#guard dateRangeInclusive "2026-08-15" "2026-08-17" 400
  == some ["2026-08-15", "2026-08-16", "2026-08-17"]
-- A single day is a one-element walk, not an empty one.
#guard dateRangeInclusive "2026-08-17" "2026-08-17" 400 == some ["2026-08-17"]
-- Month and leap-year rollovers come from `Civil`, not from a day counter here.
#guard dateRangeInclusive "2026-02-27" "2026-03-01" 400
  == some ["2026-02-27", "2026-02-28", "2026-03-01"]
#guard dateRangeInclusive "2024-02-28" "2024-03-01" 400
  == some ["2024-02-28", "2024-02-29", "2024-03-01"]
#guard dateRangeInclusive "2025-12-30" "2026-01-02" 400
  == some ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]
-- Backwards is empty, which is what a caught-up cursor asks for.
#guard dateRangeInclusive "2026-08-17" "2026-08-15" 400 == some []
-- The bound refuses rather than truncating, and it is `>` — exactly at it passes.
#guard (dateRangeInclusive "2026-08-01" "2026-08-03" 3).map List.length == some 3
#guard dateRangeInclusive "2026-08-01" "2026-08-04" 3 == none
#guard dateRangeInclusive "2026-08-01" "2026-08-01" 0 == none
#guard dateRangeInclusive "2026-08-01" "2026-08-01" (-1) == none
-- ⚠ The silent-zero-days case the TypeScript has.
#guard dateRangeInclusive "garbage" "2026-08-17" 400 == none
#guard dateRangeInclusive "2026-08-15" "" 400 == none
#guard dateRangeInclusive "2026-8-15" "2026-08-17" 400 == none
#guard dateRangeInclusive "2026-02-30" "2026-03-05" 400 == none

-- No cursor: a first-ever sync reaches 30 days back.
#guard forwardWindow "2026-08-17" none == some ("2026-07-18", "2026-08-17")
-- A cursor OLDER than the overlap start is used as given.
#guard forwardWindow "2026-08-17" (some "2026-08-01") == some ("2026-08-01", "2026-08-17")
-- ⚠ A cursor NEWER than the overlap start is pulled BACK to it. This is the
-- whole rule: an advanced cursor must not skip days Fitbit has since revised.
#guard forwardWindow "2026-08-17" (some "2026-08-17") == some ("2026-08-15", "2026-08-17")
#guard forwardWindow "2026-08-17" (some "2026-08-16") == some ("2026-08-15", "2026-08-17")
-- Exactly at the overlap start, either branch gives the same answer.
#guard forwardWindow "2026-08-17" (some "2026-08-15") == some ("2026-08-15", "2026-08-17")
-- The overlap crosses a month and a leap boundary via `Civil`, not arithmetic
-- on the string.
#guard forwardWindow "2026-03-01" (some "2026-03-01") == some ("2026-02-27", "2026-03-01")
#guard forwardWindow "2024-03-01" (some "2024-03-01") == some ("2024-02-28", "2024-03-01")
#guard forwardWindow "2026-01-01" none == some ("2025-12-02", "2026-01-01")
-- A malformed date refuses rather than being compounded into a window.
#guard forwardWindow "garbage" none == none
#guard forwardWindow "2026-08-17" (some "not-a-date") == none
#guard forwardWindow "2026-08-17" (some "2026-02-30") == none

-- Three chunks for a 16-day span at a 7-day step, the last one CLAMPED to the
-- end rather than overshooting it. This is the case the forward sync runs.
#guard chunkRange "2026-08-01" "2026-08-17" 7 60
  == some [("2026-08-01", "2026-08-08"), ("2026-08-08", "2026-08-15"), ("2026-08-15", "2026-08-17")]
-- ⚠ The touching endpoints above are the documented duplicate: 08-08 and 08-15
-- each close one chunk and open the next.
-- ⚠ An exact multiple DOES produce a trailing degenerate chunk, here and in the
-- TypeScript: `2026-08-15` closes the second chunk and then opens a third that
-- cannot advance past it. One wasted request, kept deliberately.
#guard chunkRange "2026-08-01" "2026-08-15" 7 60
  == some [("2026-08-01", "2026-08-08"), ("2026-08-08", "2026-08-15"), ("2026-08-15", "2026-08-15")]
-- One day in, one degenerate chunk out — not an empty list.
#guard chunkRange "2026-08-17" "2026-08-17" 7 60 == some [("2026-08-17", "2026-08-17")]
-- A span shorter than the step is one chunk clamped to the end.
#guard chunkRange "2026-08-15" "2026-08-17" 7 60 == some [("2026-08-15", "2026-08-17")]
-- Backwards is empty, as a caught-up cursor asks for.
#guard chunkRange "2026-08-17" "2026-08-01" 7 60 == some []
-- Month, leap and year rollovers come from `Civil`. Each is an exact multiple,
-- so each carries the trailing degenerate chunk named above.
#guard chunkRange "2026-02-25" "2026-03-04" 7 60
  == some [("2026-02-25", "2026-03-04"), ("2026-03-04", "2026-03-04")]
#guard chunkRange "2024-02-26" "2024-03-11" 7 60
  == some [("2024-02-26", "2024-03-04"), ("2024-03-04", "2024-03-11"), ("2024-03-11", "2024-03-11")]
#guard chunkRange "2025-12-28" "2026-01-11" 7 60
  == some [("2025-12-28", "2026-01-04"), ("2026-01-04", "2026-01-11"), ("2026-01-11", "2026-01-11")]
-- The 30-day default window and the 180-day backfill both fit under the bound.
#guard (chunkRange "2026-07-18" "2026-08-17" 7 60).map List.length == some 5
#guard (chunkRange "2026-02-18" "2026-08-17" 7 60).map List.length == some 26
-- The bound refuses rather than truncating, and it is `>` — exactly at it passes.
#guard (chunkRange "2026-08-01" "2026-08-08" 7 2).map List.length == some 2
#guard chunkRange "2026-08-01" "2026-08-08" 7 1 == none
#guard chunkRange "2026-08-01" "2026-08-15" 7 2 == none
#guard chunkRange "2026-08-01" "2026-08-15" 7 0 == none
-- A non-positive step refuses; it would otherwise ask for the same chunk forever.
#guard chunkRange "2026-08-01" "2026-08-15" 0 60 == none
#guard chunkRange "2026-08-01" "2026-08-15" (-7) 60 == none
-- A malformed endpoint refuses rather than silently fetching nothing.
#guard chunkRange "garbage" "2026-08-17" 7 60 == none
#guard chunkRange "2026-08-01" "" 7 60 == none
#guard chunkRange "2026-2-30" "2026-08-17" 7 60 == none
#guard chunkRange "2026-02-30" "2026-08-17" 7 60 == none

end Verified.Sync
