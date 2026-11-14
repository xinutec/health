import Verified.Civil

/-!
# Google Health weigh-ins: which one speaks for a day, and what they replace

Google gives sparse, timestamped weigh-ins; the legacy Fitbit feed gave a
forward-filled series that froze when its upstream died. For the window Google
covers, the Fitbit rows are deleted and the real ones inserted; older history
stays. HTTP, paging and SQL are in Rust.

⚠ `replaceFrom` is a DELETE boundary: too early destroys history Google cannot
replace, too late keeps the flat line. It is derived from the data.
-/

namespace Verified.Weight

/-- One weigh-in as Google reports it: integer `grams`, and the RFC-3339 `ts`,
used only to order two weigh-ins on one date. -/
structure Weigh where
  date : String
  grams : Int
  ts : String
  deriving Repr, BEq, Inhabited

/-- Keep one weigh-in per civil date, the latest by `ts`, sorted by date. `ts`
compares as a string, correct while Google returns Z-normalised instants.
Strict, so ties keep the first; an empty `ts` (no `physicalTime`) sorts below
every real one. -/
def dedupeByDate (ms : List Weigh) : List Weigh :=
  let step := fun (acc : List Weigh) (m : Weigh) =>
    match acc.find? (fun w => w.date == m.date) with
    | none => acc ++ [m]
    | some cur =>
      if cur.ts < m.ts then acc.map (fun w => if w.date == m.date then m else w)
      else acc
  (ms.foldl step []).mergeSort (fun a b => a.date ≤ b.date)

/-- The date from which stored weight is replaced: the earliest deduped day.
⚠ `none` for an empty fetch, and the caller then writes nothing: an outage or
revoked token returns zero points, which must not delete every row. -/
def replaceFrom (ms : List Weigh) : Option String :=
  (dedupeByDate ms).head?.map (·.date)

/-! ## Guards -/

private def w (d : String) (g : Int) (t : String) : Weigh := ⟨d, g, t⟩

-- One weigh-in per date, latest by timestamp, whichever order they arrive in.
#guard dedupeByDate [w "2026-08-01" 67000 "2026-08-01T07:00:00Z",
                     w "2026-08-01" 68000 "2026-08-01T19:00:00Z"]
  == [w "2026-08-01" 68000 "2026-08-01T19:00:00Z"]
#guard dedupeByDate [w "2026-08-01" 68000 "2026-08-01T19:00:00Z",
                     w "2026-08-01" 67000 "2026-08-01T07:00:00Z"]
  == [w "2026-08-01" 68000 "2026-08-01T19:00:00Z"]
-- Sorted by date regardless of arrival order.
#guard (dedupeByDate [w "2026-08-03" 3 "c", w "2026-08-01" 1 "a", w "2026-08-02" 2 "b"]).map (·.date)
  == ["2026-08-01", "2026-08-02", "2026-08-03"]
-- A tie keeps the first.
#guard dedupeByDate [w "2026-08-01" 111 "same", w "2026-08-01" 222 "same"]
  == [w "2026-08-01" 111 "same"]
-- An empty `ts` loses to any real one, whichever arrives first.
#guard dedupeByDate [w "2026-08-01" 111 "", w "2026-08-01" 222 "2026-08-01T07:00:00Z"]
  == [w "2026-08-01" 222 "2026-08-01T07:00:00Z"]
#guard dedupeByDate [w "2026-08-01" 222 "2026-08-01T07:00:00Z", w "2026-08-01" 111 ""]
  == [w "2026-08-01" 222 "2026-08-01T07:00:00Z"]
-- Two empties on one date tie, so the first survives.
#guard dedupeByDate [w "2026-08-01" 111 "", w "2026-08-01" 222 ""]
  == [w "2026-08-01" 111 ""]
#guard dedupeByDate [] == []

-- The boundary is the earliest day, not the earliest point received.
#guard replaceFrom [w "2026-08-03" 3 "c", w "2026-08-01" 1 "a"] == some "2026-08-01"
#guard replaceFrom [w "2026-08-01" 1 "a"] == some "2026-08-01"
-- The guard that matters: an empty fetch names no boundary, so nothing is
-- deleted. A Google outage returns zero points and must not empty the table.
#guard replaceFrom [] == none

end Verified.Weight
