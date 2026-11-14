/-!
# The one-way floor

Behind every "this used to work and must not stop" gate in the golden harness.
A floor is a committed per-day set of window start times (unix seconds) the
pipeline gets right. A floor key missing from the current run fails; a new key
is an improvement to re-bless. Window starts survive rewording a narrative;
a moved boundary is handled by `ratchetUpFloor`'s `described`.

⚠ A date absent from `current` satisfies nothing: unmeasured and lost
everything look alike. A caller that cannot replay a day drops it from both
sides.

`ratchetUpFloor` takes the union, so blessing cannot launder a regression. The
one exception, a key the narrative no longer describes, is returned in
`dropped` and must be printed: it is the only way to green without a fix.
-/

namespace Verified.Eval.FloorGate

/-- A per-date set of window start times (unix seconds), as an association array
so the wire order is the caller's. -/
abbrev Floor := Array (String × Array Int)

structure Key where
  date : String
  startTs : Int
  deriving BEq, Repr, Inhabited

structure GateResult where
  /-- Floor keys the current run no longer satisfies — the failures. -/
  regressed : Array Key
  /-- Keys satisfied now but absent from the floor: re-bless to ratchet up.
  Never a failure. New testimony revealing standing debt is a measurement,
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

Dates absent from `current` satisfy nothing — see the module header. -/
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
  Never silent — see the module header. -/
  dropped : Array Key
  deriving Inhabited

/-- Ratchet the floor up: committed keys plus those satisfied now, minus any the
narrative no longer describes. A date absent from `described` passes through
untouched. -/
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
-- An absent date satisfies nothing: every one of its keys regresses. This is
-- the unmeasured-day shape, and the reason a caller must exclude an unmeasured day itself.
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
-- A key the narrative no longer describes leaves the floor — and is announced.
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [20])])).floor
    == f [("d1", [20])]
#guard (ratchetUpFloor (f [("d1", [10])]) (f [("d1", [20])]) (f [("d1", [20])])).dropped
    == #[{ date := "d1", startTs := 10 }]
-- A date absent from `described` was not measured: its floor passes through
-- whole. Emptying it here is the same silence-as-loss bug as the gate's.
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [])).floor == f [("d1", [10, 20])]
#guard (ratchetUpFloor (f [("d1", [10, 20])]) (f []) (f [])).dropped == #[]
-- A day described as holding nothing loses its whole floor, loudly.
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
