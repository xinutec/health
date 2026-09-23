/-!
# `Array.ofFn` as a loop the compiler specialises (#1362)

Core's `Array.ofFn` is a private recursion over a closure: every element is
one `lean_apply_1` of the `Fin n → α` argument. On the HSMM trellis — the
forward pass over `S · maxD` cells per minute — that call was ~58% of a day's
decode, and a hand-written loop with the cell body inlined measured ~10%
faster on the corpus.

`ofFnLoop` is that loop, once, for every `Array.ofFn` in any module that
imports this one: `ofFnGo` is `@[specialize]`, so a call site with a known
`f` compiles to a loop with `f`'s body in it, and the `@[csimp]` lemma makes
the compiler substitute it. Nothing in the logic changes — `Array.ofFn` is
still what every definition and proof says, and `ofFn_eq_loop` is why the
substitution is sound.
-/

namespace Verified.ArrayLoop

/-- The push loop: `acc` holds the first `i` elements. -/
@[specialize] def ofFnGo {α : Type u} (n : Nat) (f : Fin n → α) (i : Nat) (acc : Array α) : Array α :=
  if h : i < n then ofFnGo n f (i + 1) (acc.push (f ⟨i, h⟩)) else acc
termination_by n - i

/-- `Array.ofFn f`, built by `ofFnGo` from an array with the right capacity.
    `@[inline]` is load-bearing: the specialiser only sees a KNOWN `f` if this
    call opens at the site where the lambda is written; as a plain definition
    the closure was handed through unchanged and every cell still paid a call
    (measured 2026-09-23: no gain at all). -/
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
