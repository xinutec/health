import Verified.Hsmm.Oracle

/-!
# Per-segment score decomposition

The two helpers the optimality chain rests on when it reasons about a single
segment's contribution: `segScore` — everything one segment `⟨s, d⟩` pays
(init-or-transition, entry, emissions, duration prior) — and `scoreAux_cons`,
which splits a segmentation's score into its first segment's `segScore` plus
the tail's score. The forward DP (`Forward.lean`), the trellis
(`Trellis.lean`), and the decoder (`Decode.lean`) all decompose through these.

The optimality equivalence itself runs through the *forward* DP
(`Forward.forwardBest_eq_oracleBest`), not a backward recurrence.
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

end Verified.Hsmm
