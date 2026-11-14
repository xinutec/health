/-!
# `Array.ofFn` as a loop the compiler specialises

Core's `Array.ofFn` calls its closure per element, which dominated the HSMM
forward pass. `ofFnGo` is `@[specialize]`, so a call site with a known `f`
compiles to a loop with `f` inlined, and the `@[csimp]` lemma substitutes it.
Definitions and proofs still say `Array.ofFn`; `ofFn_eq_loop` makes it sound.
-/

namespace Verified.ArrayLoop

/-- The push loop: `acc` holds the first `i` elements. -/
@[specialize] def ofFnGo {α : Type u} (n : Nat) (f : Fin n → α) (i : Nat) (acc : Array α) : Array α :=
  if h : i < n then ofFnGo n f (i + 1) (acc.push (f ⟨i, h⟩)) else acc
termination_by n - i

/-- `Array.ofFn f`, built by `ofFnGo` with the right capacity. `@[inline]` so
    the specialiser sees the lambda at its call site. -/
@[inline] def ofFnLoop {α : Type u} {n : Nat} (f : Fin n → α) : Array α :=
  ofFnGo n f 0 (Array.emptyWithCapacity n)

/-- The loop invariant: with the first `i` elements in hand, the loop finishes
    exactly `Array.ofFn f`. -/
theorem ofFnGo_eq {α : Type u} {n : Nat} (f : Fin n → α) (i : Nat) (hi : i ≤ n) :
    ofFnGo n f i (Array.ofFn fun k : Fin i => f ⟨k.val, by omega⟩) = Array.ofFn f := by
  unfold ofFnGo
  split
  · rename_i h
    have step : (Array.ofFn fun k : Fin i => f ⟨k.val, by omega⟩).push (f ⟨i, h⟩)
        = Array.ofFn fun k : Fin (i + 1) => f ⟨k.val, by omega⟩ := by
      rw [Array.ofFn_succ]
      first
        | rfl
        | (congr 1; congr 1; funext k; rfl)
    rw [step]
    exact ofFnGo_eq f (i + 1) h
  · rename_i h
    have hn : i = n := by omega
    subst hn
    rfl
termination_by n - i

theorem ofFn_eq_loop {α : Type u} {n : Nat} (f : Fin n → α) : Array.ofFn f = ofFnLoop f := by
  unfold ofFnLoop
  have h := ofFnGo_eq f 0 (Nat.zero_le n)
  rw [Array.ofFn_zero] at h
  exact h.symm

/-- What lets the compiler use the loop wherever `Array.ofFn` is written. -/
@[csimp] theorem ofFn_eq_loop_csimp : @Array.ofFn = @ofFnLoop := by
  funext α n f
  exact ofFn_eq_loop f

end Verified.ArrayLoop
