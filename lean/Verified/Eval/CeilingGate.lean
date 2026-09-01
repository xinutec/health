/-!
# The one-way ceiling (port of `src/eval/ceiling-gate.ts`, #1048)

The count-shaped sibling of `FloorGate`. Where a floor records what the pipeline
gets RIGHT and may only grow, a ceiling records standing DEFECTS as a per-day
count and may only shrink: the physically-impossible legs of
`Verified.Eval.Feasibility`, and the train legs labelled with a line that does
not serve their stations (#181/#351). A day emitting more than its committed
count is a regression; fewer is an improvement to re-bless.

## ⚠ SILENCE IS NOT ZERO, and this is the module that keeps getting it wrong

`current[date] ?? 0` cannot tell a day with NO defects from a day that never
ran, and against a non-zero ceiling the second reads as the first: the day drops
out of the failures and into `improvedDays`, and the run then invites a re-bless
on the strength of it. A change that breaks a fixture AND worsens that day would
report as an IMPROVEMENT — the one direction a ratchet must never get wrong. So
`measured` is a separate argument and a day outside it is named, never scored.

`attempted` closes the other half. Without it the sweep is the union of the two
baselines, and a day at ceiling ZERO appears in neither — so a day carrying no
standing debt that quietly stops replaying is named nowhere. That is where a NEW
defect hides best: it cannot regress a ceiling it is no longer measured against.

## ⚠ BLESSING TAKES THE MINIMUM, NOT THE CURRENT COUNTS

Until 2026-07-27 the bless wrote current counts WHOLESALE, so a run that fixed
four days and left one red silently RAISED that day's ceiling and the standing
failure vanished from the gate. A run may fix some days without fixing all of
them; blessing the wins must not also bless the losses.
-/

namespace Verified.Eval.CeilingGate

/-- Per-date count of standing defects. -/
abbrev Ceiling := Array (String × Nat)

structure Regression where
  date : String
  was : Nat
  now : Nat
  deriving BEq, Repr, Inhabited

structure Result where
  /-- Days above their committed ceiling — the failures. -/
  regressed : Array Regression
  /-- Days below their ceiling — re-bless to ratchet it down. -/
  improvedDays : Nat
  /-- Days the run could not measure, NAMED rather than scored. -/
  unmeasured : Array String
  deriving Inhabited

private def countOf (c : Ceiling) (d : String) : Nat :=
  match c.find? (·.1 == d) with
  | some (_, n) => n
  | none => 0

private def sortedUnion (xs : Array String) : Array String :=
  (xs.foldl (fun acc d => if acc.contains d then acc else acc.push d) #[]).qsort (· < ·)

/-- Compare a run against the committed ceiling, over the days actually
measured. See the module header for why `measured` and `attempted` are both
separate arguments. -/
def gateCeiling (committed current : Ceiling) (measured attempted : Array String) : Result := Id.run do
  let dates := sortedUnion (committed.map (·.1) ++ current.map (·.1) ++ attempted)
  let mut regressed : Array Regression := #[]
  let mut improvedDays := 0
  let mut unmeasured : Array String := #[]
  for date in dates do
    if !measured.contains date then
      unmeasured := unmeasured.push date
      continue
    let was := countOf committed date
    let now := countOf current date
    if now > was then regressed := regressed.push { date, was, now }
    else if now < was then improvedDays := improvedDays + 1
  return { regressed, improvedDays, unmeasured }

/-- Merge a fresh run into the committed ceiling, keeping the ratchet one-way:
`min(committed, current)` per day.

⚠ A day MISSING from the committed baseline has a ceiling of ZERO — that is how
the gate reads it everywhere else, so a newly-offending day cannot be blessed in
by omission either. `committed = none` is the distinct BOOTSTRAP case (no
baseline file at all): nothing to ratchet against, so the current counts
establish the first ceiling.

A day absent from `measured` counted nothing and keeps what it had: reading
silence as zero would record a fix nobody observed and drop that day to the
strictest ceiling there is, on no evidence. -/
def ratchetDownCounts (committed : Option Ceiling) (current : Ceiling)
    (measured : Array String) : Ceiling := Id.run do
  let com := committed.getD #[]
  let dates := sortedUnion (com.map (·.1) ++ current.map (·.1))
  let mut out : Ceiling := #[]
  for date in dates do
    if committed.isSome && !measured.contains date then
      let held := countOf com date
      if held > 0 then out := out.push (date, held)
      continue
    let floor := match committed with
      | none => countOf current date
      | some c => min (countOf c date) (countOf current date)
    if floor > 0 then out := out.push (date, floor)
  return out

/-! ## Witnesses -/

section Witnesses

private def c (xs : List (String × Nat)) : Ceiling := xs.toArray
private def m (xs : List String) : Array String := xs.toArray

-- More than the ceiling is a regression; fewer is an improvement.
#guard (gateCeiling (c [("d1", 1)]) (c [("d1", 2)]) (m ["d1"]) (m [])).regressed
    == #[{ date := "d1", was := 1, now := 2 }]
#guard (gateCeiling (c [("d1", 2)]) (c [("d1", 1)]) (m ["d1"]) (m [])).improvedDays == 1
#guard (gateCeiling (c [("d1", 1)]) (c [("d1", 1)]) (m ["d1"]) (m [])).regressed == #[]
-- ⚠ SILENCE IS NOT ZERO. An unmeasured day is NAMED, not scored as fixed.
#guard (gateCeiling (c [("d1", 2)]) (c []) (m []) (m [])).unmeasured == #["d1"]
#guard (gateCeiling (c [("d1", 2)]) (c []) (m []) (m [])).improvedDays == 0
#guard (gateCeiling (c [("d1", 2)]) (c []) (m []) (m [])).regressed == #[]
-- …and MEASURED-at-zero really is an improvement.
#guard (gateCeiling (c [("d1", 2)]) (c []) (m ["d1"]) (m [])).improvedDays == 1
-- ⚠ `attempted` is what names a day at ceiling ZERO that stopped replaying.
-- Without it such a day is in no baseline and appears nowhere at all.
#guard (gateCeiling (c []) (c []) (m []) (m ["d9"])).unmeasured == #["d9"]
#guard (gateCeiling (c []) (c []) (m []) (m [])).unmeasured == #[]
-- A day newly offending against no committed entry regresses from zero.
#guard (gateCeiling (c []) (c [("d1", 1)]) (m ["d1"]) (m [])).regressed
    == #[{ date := "d1", was := 0, now := 1 }]

-- The bless takes the MINIMUM: fixing one day cannot raise another's ceiling.
#guard ratchetDownCounts (some (c [("d1", 1), ("d2", 2)])) (c [("d1", 0), ("d2", 5)]) (m ["d1", "d2"])
    == c [("d2", 2)]
-- Zero drops out entirely rather than being recorded.
#guard ratchetDownCounts (some (c [("d1", 3)])) (c [("d1", 0)]) (m ["d1"]) == c []
-- ⚠ An unmeasured day keeps what it had — never ratcheted to zero on silence.
#guard ratchetDownCounts (some (c [("d1", 3)])) (c []) (m []) == c [("d1", 3)]
-- ⚠ A day missing from the committed baseline has a ceiling of ZERO, so a new
-- offender cannot be blessed in by omission.
#guard ratchetDownCounts (some (c [])) (c [("d1", 4)]) (m ["d1"]) == c []
-- BOOTSTRAP is the distinct case: no baseline at all, so the run establishes one.
#guard ratchetDownCounts none (c [("d1", 4)]) (m ["d1"]) == c [("d1", 4)]
#guard ratchetDownCounts none (c []) (m []) == c []
-- Dates come back sorted.
#guard ratchetDownCounts (some (c [("d2", 1), ("d1", 1)])) (c [("d1", 1), ("d2", 1)]) (m ["d1", "d2"])
    == c [("d1", 1), ("d2", 1)]

end Witnesses

end Verified.Eval.CeilingGate
