import Verified.Civil

/-!
# Google Health weigh-ins: which one speaks for a day, and what they replace

Port of the two decisions inside `src/google/body.ts` (#260, #982). The HTTP,
the pagination and the SQL stay in Rust; these two do not, because both govern
which numbers end up in the `body` table and both are wrong silently.

## Why there is a replacement at all

Google gives real, sparse, individually-timestamped weigh-ins. The legacy Fitbit
feed gave a forward-filled DAILY series, and it froze in Apr 2026 when the
Hume → Fitbit path died — so the table holds a flat line that looks like data.
For the window Google covers, the Fitbit rows are deleted and the real
measurements inserted. Rows BEFORE that window are older Fitbit history and are
left alone.

⚠ So `replaceFrom` names a DELETE boundary. Too early and it destroys history
Google cannot replace; too late and the stale flat line survives inside the
window. It is derived from the data rather than configured, which is why it is
here and not a constant.
-/

namespace Verified.Weight

/-- One weigh-in as Google reports it.

`grams` is an integer because that is how Google stores it; the conversion to
kilograms happens at the write and is not a decision. `ts` is the RFC-3339
instant, used ONLY to order two weigh-ins that fall on the same civil date. -/
structure Weigh where
  date : String
  grams : Int
  ts : String
  deriving Repr, BEq, Inhabited

/-- Keep one weigh-in per civil date — the LATEST by `ts` — sorted by date.

⚠ **`ts` IS COMPARED AS A STRING, and that is preserved from the TypeScript
rather than endorsed.** It is correct only while every timestamp shares one
format and one offset: `2026-01-01T13:00:00+01:00` is the same instant as
`2026-01-01T12:00:00Z` and compares GREATER. Google returns Z-normalised
instants today, so the two agree; if that ever changes, this picks the wrong
weigh-in for a day on which somebody weighed twice, and nothing says so.

⚠ The comparison is STRICT, so on a tie the FIRST occurrence wins — which
matters more than it looks: `ts` is empty when a data point carries no
`physicalTime`, so several such points on one date all tie, and the first
survives. An empty `ts` also sorts BELOW every real one, so a timestamped
weigh-in always beats an untimestamped one on the same day. Both match the
TypeScript's `if (!cur || m.ts > cur.ts)`. -/
def dedupeByDate (ms : List Weigh) : List Weigh :=
  let step := fun (acc : List Weigh) (m : Weigh) =>
    match acc.find? (fun w => w.date == m.date) with
    | none => acc ++ [m]
    | some cur =>
      if cur.ts < m.ts then acc.map (fun w => if w.date == m.date then m else w)
      else acc
  (ms.foldl step []).mergeSort (fun a b => a.date ≤ b.date)

/-- The date from which stored weight is replaced: the earliest deduped day.

`none` for an empty fetch, and that is the whole guard. ⚠ An empty result must
NOT be read as "replace from the beginning of time" — a Google outage, a revoked
token or a scope change all produce zero points, and treating that as a boundary
would delete every weight row the table has. The caller writes nothing on
`none`. -/
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
-- ⚠ A TIE KEEPS THE FIRST, matching the TypeScript's strict `>`.
#guard dedupeByDate [w "2026-08-01" 111 "same", w "2026-08-01" 222 "same"]
  == [w "2026-08-01" 111 "same"]
-- ⚠ An EMPTY `ts` loses to any real one, whichever arrives first.
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
-- ⚠ THE GUARD THAT MATTERS: an empty fetch names no boundary, so nothing is
-- deleted. A Google outage returns zero points and must not empty the table.
#guard replaceFrom [] == none

end Verified.Weight
