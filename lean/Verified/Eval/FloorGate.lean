/-!
# The one-way floor (port of `src/eval/floor-gate.ts`, #1052)

The shared mechanism behind every "this used to work and must not stop working"
gate in the golden harness. A floor is a committed per-day set of
narrative-stable window start times (unix seconds) naming what the pipeline
currently gets right: the ground-truth journeys it reconstructs, the confirmed
truth rows it still satisfies. A key in the floor and absent from the current run
is a REGRESSION and fails the gate; a key present now and absent from the floor
is an IMPROVEMENT to re-bless. The floor can only grow.

The keys are window STARTS because that is the one property a narrative keeps
across an edit to its own prose: rewording a row, sharpening a place name or
correcting a line label all leave the window alone. It is not a perfect identity
— moving a boundary DOES move the key — which is what `ratchetUpFloor`'s
`described` argument is for.

## ⚠ A DATE ABSENT FROM `current` SATISFIES NOTHING

That is the trap this module documents rather than solves: to a floor gate, "I
could not measure this day" and "this day lost everything" are the same silence.
A caller that cannot replay a day must drop it from BOTH sides. #408 is what
happens otherwise — 26 confirmed rows reported as lost, two lines above a
message naming those same days as unmeasured, one re-bless away from being
destroyed for real.

## ⚠ WHY BLESSING CANNOT LAUNDER A REGRESSION

`ratchetUpFloor` takes the UNION, so a key that used to hold and does not now
STAYS in the floor and keeps failing. The single exception is a key the
narrative no longer `described` — a row rewritten or re-audited away, which a
floor would otherwise fail on forever because nothing can satisfy it again. Every
such drop is returned in `dropped` and must be said out loud: it is the only
route from "the gate is red" to "the gate is green" that does not involve fixing
anything, and an honest re-audit is distinguished from flipping rows until the
gate passes only by being visible at the moment it happens.
-/

namespace Verified.Eval.FloorGate

/-- A per-date set of narrative-stable window start times (unix seconds).

Represented as an association array rather than a map so the wire order is the
caller's; every result below is either explicitly sorted or follows the input
order, so no consumer depends on the representation. -/
abbrev Floor := Array (String × Array Int)

structure Key where
  date : String
  startTs : Int
  deriving BEq, Repr, Inhabited

structure GateResult where
  /-- Floor keys the current run no longer satisfies — the failures. -/
  regressed : Array Key
  /-- Keys satisfied now but absent from the floor: re-bless to ratchet up.
  ⚠ NEVER a failure. New testimony revealing standing debt is a measurement,
  not a breakage. -/
  improved : Array Key
  deriving Inhabited

private def lookup (f : Floor) (d : String) : Array Int :=
  match f.find? (·.1 == d) with
  | some (_, ts) => ts
  | none => #[]

private def byDateThenTs (a b : Key) : Bool :=
  if a.date == b.date then a.startTs < b.startTs else a.date < b.date

/-- Compare a committed floor against the current run.

⚠ Dates absent from `current` satisfy NOTHING — see the module header. -/
def gateFloor (baseline current : Floor) : GateResult :=
  let regressed := baseline.flatMap fun (date, baseTs) =>
    let now := lookup current date
    (baseTs.filter (!now.contains ·)).map ({ date, startTs := · })
  let improved := current.flatMap fun (date, nowTs) =>
    let base := lookup baseline date
    (nowTs.filter (!base.contains ·)).map ({ date, startTs := · })
  { regressed := regressed.qsort byDateThenTs, improved := improved.qsort byDateThenTs }

structure RatchetResult where
  floor : Floor
  /-- Committed keys the narrative no longer describes, so they left the floor.
  ⚠ NEVER silent — see the module header. -/
  dropped : Array Key
  deriving Inhabited

/-- Ratchet the floor UP to the current run: the union of the committed keys and
the ones satisfied now, minus any the narrative no longer describes.

A date ABSENT from `described` was not measured this run, and its committed floor
passes through untouched rather than being emptied by a silence. -/
def ratchetUpFloor (committed current described : Floor) : RatchetResult := Id.run do
  let dates := ((committed.map (·.1) ++ current.map (·.1)).foldl
    (fun acc d => if acc.contains d then acc else acc.push d) #[]).qsort (· < ·)
  let mut floor : Floor := #[]
  let mut dropped : Array Key := #[]
  for date in dates do
    let committedDay := lookup committed date
    let describes := described.any (·.1 == date)
    let day := lookup described date
    let kept := if describes then committedDay.filter (day.contains ·) else committedDay
    if describes then
      for ts in committedDay do
        if !day.contains ts then dropped := dropped.push { date, startTs := ts }
    let union := (kept ++ lookup current date).foldl
      (fun acc t => if acc.contains t then acc else acc.push t) #[]
    floor := floor.push (date, union.qsort (· < ·))
  return { floor, dropped }

/-! ## Witnesses -/

section Witnesses

private def f (xs : List (String × List Int)) : Floor :=
  (xs.map fun (d, ts) => (d, ts.toArray)).toArray

-- A key in the floor and missing now is a regression; the reverse is an
-- improvement. Both, at once, on the same day.
#guard (gateFloor (f [("d1", [10, 20])]) (f [("d1", [20, 30])])).regressed
    == #[{ date := "d1", startTs := 10 }]
#guard (gateFloor (f [("d1", [10, 20])]) (f [("d1", [20, 30])])).improved
    == #[{ date := "d1", startTs := 30 }]
#guard (gateFloor (f [("d1", [10])]) (f [("d1", [10])])).regressed == #[]
#guard (gateFloor (f [("d1", [10])]) (f [("d1", [10])])).improved == #[]
-- ⚠ An absent date satisfies nothing: every one of its keys regresses. This is
-- the #408 shape, and the reason a caller must exclude an unmeasured day itself.
#guard (gateFloor (f [("d1", [10, 20])]) (f [])).regressed
    == #[{ date := "d1", startTs := 10 }, { date := "d1", startTs := 20 }]
-- An empty floor never fails; everything is an improvement.
#guard (gateFloor (f []) (f [("d1", [10])])).regressed == #[]
#guard (gateFloor (f []) (f [("d1", [10])])).improved == #[{ date := "d1", startTs := 10 }]
-- Sorted by date then timestamp regardless of the input order.
#guard (gateFloor (f [("d2", [30, 10]), ("d1", [20])]) (f [])).regressed
    == #[{ date := "d1", startTs := 20 }, { date := "d2", startTs := 10 },
         { date := "d2", startTs := 30 }]

-- The ratchet takes the UNION: a key that stopped holding stays in the floor,
-- so blessing this run's wins cannot launder the regression away.
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [10, 20])])).floor
    == f [("d1", [10, 20])]
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [10, 20])])).dropped == #[]
-- A key the narrative no longer DESCRIBES leaves the floor — and is announced.
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [20])])).floor
    == f [("d1", [20])]
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [20])])).dropped
    == #[{ date := "d1", startTs := 10 }]
-- ⚠ A date absent from `described` was NOT MEASURED: its floor passes through
-- whole. Emptying it here is the same silence-as-loss bug as the gate's.
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [])).floor == f [("d1", [10, 20])]
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [])).dropped == #[]
-- A day described as holding NOTHING loses its whole floor, loudly.
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [("d1", [])])).floor == f [("d1", [])]
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [("d1", [])])).dropped
    == #[{ date := "d1", startTs := 10 }, { date := "d1", startTs := 20 }]
-- Dates are unioned and sorted; keys are deduped and sorted.
#guard (ratchetUpFloor (f [("d2", [5])]) (f [("d1", [9])]) (f [("d1", [9]), ("d2", [5])])).floor
    == f [("d1", [9]), ("d2", [5])]
#guard (ratchetUpFloor (f [("d1", [20, 10])]) (f [("d1", [10, 30])]) (f [("d1", [10, 20, 30])])).floor
    == f [("d1", [10, 20, 30])]
-- Blessing an empty run over an empty floor is a no-op, not a crash.
#guard (ratchetUpFloor (f []) (f []) (f [])).floor == f []

end Witnesses

end Verified.Eval.FloorGate
