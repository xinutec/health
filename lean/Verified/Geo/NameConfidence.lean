/-!
# How often each naming rule has been right

A stay's name is shown with "the certainty percentage from our own calculation"
(the user's call). What carries certainty is the rule that named it
(`Seg.placeSource`): the ranking's softmax posterior scores no better than a
constant at leave-one-out, while the rule separates (a name from inside a
building is almost always right).

The number shown is the rule's hit rate on confirmed days by the rule of
succession, `(right + 1) / (graded + 2)`; an ungraded rule reads 0.5.

⚠ `COUNTS` is a measurement: the truth gate recounts it every corpus run
against `tests/golden/name-confidence.jsonl`, and a Rust test holds this table
to that file. A naming change that moves a count needs
`NAME_CONFIDENCE_BLESS=1` and this table updated.
-/

namespace Verified.Geo.NameConfidence

/-- `(source, right, graded)` over the corpus's graded stay rows. -/
def COUNTS : List (String × Nat × Nat) :=
  [("home", 80, 80), ("sleep", 29, 29), ("enclosing", 25, 25), ("work", 24, 24),
   ("nearField", 20, 28), ("ranked", 9, 15), ("lodging", 24, 24), ("station", 25, 28),
   ("geocodeVenue", 16, 22), ("openSpace", 3, 3), ("residential", 0, 2),
   ("address", 0, 1)]

/-- The chance a name from `source` is right: the rule of succession over its
    graded rows. -/
def confidence (source : String) : Float :=
  match COUNTS.find? (·.1 == source) with
  | some (_, r, n) => (r.toFloat + 1) / (n.toFloat + 2)
  | none => 0.5

#guard confidence "enclosing" == 26 / 27
#guard confidence "ranked" == 10 / 17
#guard confidence "address" == 1 / 3
#guard confidence "unmeasured" == 0.5

end Verified.Geo.NameConfidence
