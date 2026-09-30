/-!
# How often each naming rule has been right (#325, 2026-09-30)

The user's call, 2026-09-15: a stay's name is a guess, and the guess is shown
with "the certainty percentage from our own calculation". The calculation that carries
one is WHICH RULE named the stay (`Seg.placeSource`). Measured on the confirmed
stays of the golden corpus, the ranking's own softmax posterior does not: at
leave-one-out it scores the same Brier as a constant (0.175 against 0.175),
because the rules that decide most names — inside a building, the nearest
venue — sit outside the totals it is computed from. The rule does separate
(0.139): a name from inside a building is almost always right, one from the
summed evidence far less often — `COUNTS` has the figures.

So the number shown is the rule's hit rate on his confirmed days, estimated by
the rule of succession, `(right + 1) / (graded + 2)` — a small sample never
claims certainty, and a rule no confirmed row has graded reads 0.5, "unknown".

⚠ `COUNTS` IS A MEASUREMENT, NOT A SETTING. The truth gate re-counts it on
every corpus run, day by day, against `tests/golden/name-confidence.jsonl`, and
a Rust test holds this table to that file's sum. A naming change that moves a
count fails the gate until it is re-blessed (`NAME_CONFIDENCE_BLESS=1`) and this
table updated to match.
-/

namespace Verified.Geo.NameConfidence

/-- `(source, right, graded)` over the corpus's graded stay rows. -/
def COUNTS : List (String × Nat × Nat) :=
  [("home", 52, 52), ("sleep", 37, 37), ("enclosing", 31, 32), ("work", 18, 18),
   ("nearField", 9, 13), ("ranked", 4, 6), ("lodging", 3, 3), ("station", 3, 3)]

/-- The chance a name from `source` is right: the rule of succession over its
    graded rows. -/
def confidence (source : String) : Float :=
  match COUNTS.find? (·.1 == source) with
  | some (_, r, n) => (r.toFloat + 1) / (n.toFloat + 2)
  | none => 0.5

#guard confidence "enclosing" == 32 / 34
#guard confidence "ranked" == 5 / 8
#guard confidence "address" == 0.5

end Verified.Geo.NameConfidence
