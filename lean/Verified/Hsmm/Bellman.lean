import Verified.Hsmm.Oracle

/-!
# The Bellman recurrence

The trellis restated as a provable functional recurrence: `bestFrom P start
prev r` is the best score attainable over the remaining window of `r` minutes
beginning at absolute index `start`, given the preceding segment's state.
`bestFrom_eq` proves it equals the oracle's maximum — because `Score.add`
distributes over `Score.max` (with `-∞` absorbing), "max over all
segmentations" factors through "max over the first segment's choice".

This is the half-way point of the pilot's equivalence theorem: the oracle
(exponential, obviously correct) equals this recurrence; the array trellis in
`Viterbi.lean` refines this recurrence (that refinement is the remaining,
`#guard`-checked step — see `docs/proposals/2026-07-verified-core-lean.md`).
-/

namespace Verified.Hsmm

/-- Everything one segment `⟨s, d⟩` starting at `start` pays: init-or-transition,
entry, its emissions, and its duration prior. `scoreAux` on a cons is exactly
this plus the tail's score (`scoreAux_cons`, by definitional unfolding). -/
def segScore (P : Problem) (start : Nat) (prev : Option Nat) (s d : Nat) : Score :=
  (match prev with
    | none => P.init s
    | some sp => P.trans sp s start)
  + P.entry s start
  + emitRun P s start d
  + P.dur s d (start + d - 1)

theorem scoreAux_cons (P : Problem) (start : Nat) (prev : Option Nat)
    (s d : Nat) (rest : List Seg) :
    scoreAux P start prev (⟨s, d⟩ :: rest)
      = segScore P start prev s d + scoreAux P (start + d) (some s) rest := rfl

/-- The Bellman recurrence over the remaining window: choose the next segment's
state `s` (≠ `prev`) and duration `d ∈ [1, min maxD r]`, pay `segScore`, recurse.
Mirrors `enumFrom`'s structure choice-for-choice. -/
def bestFrom (P : Problem) (start : Nat) (prev : Option Nat) : (r : Nat) → Score
  | 0 => Score.zero
  | r + 1 =>
    Score.listMax <|
      (List.range P.S).flatMap fun s =>
        if prev == some s then []
        else
          (List.range (Nat.min P.maxD (r + 1))).map fun d0 =>
            segScore P start prev s (d0 + 1)
              + bestFrom P (start + (d0 + 1)) (some s) (r + 1 - (d0 + 1))
  termination_by r => r
  decreasing_by omega

/-- The recurrence computes exactly the maximum score over everything the
oracle enumerates for the remaining window. -/
theorem bestFrom_eq (P : Problem) :
    ∀ (r start : Nat) (prev : Option Nat),
      bestFrom P start prev r
        = Score.listMax ((enumFrom P prev r).map (scoreAux P start prev))
  | 0, start, prev => by
    simp [bestFrom, enumFrom, Score.listMax_cons, scoreAux]
  | r + 1, start, prev => by
    simp only [bestFrom, enumFrom]
    rw [List.map_flatMap, Score.listMax_flatMap, Score.listMax_flatMap]
    congr 1
    apply List.map_congr_left
    intro s _
    cases hps : prev == some s with
    | true => simp
    | false =>
      simp only [Bool.false_eq_true, if_false]
      rw [List.map_flatMap, Score.listMax_flatMap]
      congr 1
      apply List.map_congr_left
      intro d0 _
      rw [List.map_map]
      have hcomp :
          (scoreAux P start prev ∘ fun rest => (⟨s, d0 + 1⟩ : Seg) :: rest)
            = fun rest =>
                segScore P start prev s (d0 + 1)
                  + scoreAux P (start + (d0 + 1)) (some s) rest := rfl
      rw [hcomp, Score.add_listMax_map,
        bestFrom_eq P (r + 1 - (d0 + 1)) (start + (d0 + 1)) (some s)]
  termination_by r => r
  decreasing_by omega

/-- The oracle's best score is the Bellman recurrence over the full window. -/
theorem oracleBest_eq_bestFrom (P : Problem) :
    oracleBest P = bestFrom P 0 none P.T := by
  rw [bestFrom_eq]
  rfl

end Verified.Hsmm
