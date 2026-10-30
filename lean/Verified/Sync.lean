import Verified.Civil

/-!
# Sync decisions — the PhoneTrack chunk walk

`chunkRange` splits a date span into consecutive windows for the PhoneTrack
fetch, bounded so a malformed or runaway span cannot walk for ever. The Fitbit
ingestion's rules that lived beside it (the rate-limit decision, the backfill
cursor and window, the forward window) went with the Web API on 2026-10-30.
-/

namespace Verified.Sync

/-! ## The chunk walk -/

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
TypeScript always did it. Closing the interval would drop whichever end of
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

⚠ The `maxChunks` refusal is NEW — the TypeScript had no bound and would walk a
corrupt cursor across years, one HTTP request per week, before anything noticed.
It REFUSES rather than truncating: a prefix of the fixes is not a smaller
answer to the same question, it is a confident wrong zone for every row past
where the walk stopped. -/
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

Every boundary is named — the edges are where these are wrong. -/

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
