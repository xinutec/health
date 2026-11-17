/-!
# How often each naming rule has been right

A stay's name is shown with "the certainty percentage from our own calculation"
(the user's call). What carries certainty is the rule that named it
(`Seg.placeSource`): a name from inside a building is almost always right. A
venue guessed among its neighbours is right about two times in three whichever
rule guessed it, so there the stay's own evidence share sets the band (`key`):
held out by day it predicts right-or-wrong better than the rule or a constant.

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
   ("guessBarely", 8, 19), ("guessClearly", 31, 40), ("guessDecisively", 5, 5),
   ("lodging", 24, 24), ("station", 25, 28), ("geocodeVenue", 1, 1),
   ("openSpace", 3, 3), ("residential", 0, 2)]

/-- The chance a name from `source` is right: the rule of succession over its
    graded rows. -/
def confidence (source : String) : Float :=
  match COUNTS.find? (·.1 == source) with
  | some (_, r, n) => (r.toFloat + 1) / (n.toFloat + 2)
  | none => 0.5

/-- The rules that guess a venue among its neighbours: their certainty is the
    stay's own, by how clearly the venue won (`BestPlace.evidenceShare`). -/
def GUESS_RULES : List String := ["nearField", "geocodeVenue", "ranked"]

/-- The band edges: the isotonic fit of right-or-wrong on the share over the
    corpus's graded guessed stays has three levels, parting here. -/
def SHARE_CLEAR : Float := 0.12
def SHARE_DECISIVE : Float := 0.5

/-- What a served name's certainty is counted under: a guessed venue's band,
    any other rule itself. A street is not a venue claim and carries none. -/
def key (source : String) (share : Option Float) : Option String :=
  if source == "address" then none else
  match share with
  | some p =>
    if !GUESS_RULES.contains source then some source
    else if p < SHARE_CLEAR then some "guessBarely"
    else if p < SHARE_DECISIVE then some "guessClearly"
    else some "guessDecisively"
  | none => some source

#guard key "ranked" (some 0.05) == some "guessBarely"
#guard key "nearField" (some 0.3) == some "guessClearly"
#guard key "geocodeVenue" (some 0.7) == some "guessDecisively"
#guard key "home" (some 0.05) == some "home"
#guard key "ranked" none == some "ranked"
#guard key "address" none == none

#guard confidence "enclosing" == 26 / 27
#guard confidence "guessBarely" == 9 / 21
#guard confidence "guessClearly" == 32 / 42
#guard confidence "unmeasured" == 0.5

end Verified.Geo.NameConfidence
