import Verified.Hsmm.Oracle

/-!
# Per-segment score decomposition

`segScore` is what one segment `⟨s, d⟩` pays (init or transition, entry,
emissions, duration), and `scoreAux_cons` splits a score into the first
segment's plus the tail's. `Forward`, `Trellis` and `Decode` decompose through
these; optimality itself goes through the forward DP
(`Forward.forwardBest_eq_oracleBest`).
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
