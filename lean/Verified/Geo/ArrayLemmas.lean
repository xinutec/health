/-!
# Array `getD` / `setIfInBounds` lemmas

The small array read-after-write facts the Lazy-Dijkstra proofs
(`LazyDijkstra`/`LazyInv`/`LazyFuel`) lean on repeatedly: reading a
`setIfInBounds` at a different index, at the written index, and the two
`Bool`-specific corollaries used to track the `done` array. Kept in one
place so the lazy chain — and the matcher passes that will route over it —
share a single copy.

`setIfInBounds` silently drops an out-of-range write, which is why
`getD_sib_lt` needs the in-bounds hypothesis and `getD_set_true` handles
the out-of-range case explicitly.
-/

namespace Verified.Geo

/-- `getD` through an out-of-place `setIfInBounds` is unchanged. -/
theorem getD_sib_ne {α : Type} {a : Array α} {i j : Nat} (h : i ≠ j)
    (x d : α) : (a.setIfInBounds i x).getD j d = a.getD j d := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds,
    Array.getD_eq_getD_getElem?, if_neg h]

/-- `getD` at an in-bounds `setIfInBounds` reads the new value. -/
theorem getD_sib_lt {α : Type} {a : Array α} {i : Nat} (h : i < a.size)
    (x d : α) : (a.setIfInBounds i x).getD i d = x := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds,
    if_pos rfl, if_pos h]
  rfl

/-- A set `done` bit came from the write or was already set. -/
theorem getD_sib_true {a : Array Bool} {u v : Nat}
    (h : (a.setIfInBounds u true).getD v false = true) :
    v = u ∨ a.getD v false = true := by
  by_cases huv : v = u
  · exact Or.inl huv
  · rw [getD_sib_ne (fun he => huv he.symm)] at h
    exact Or.inr h

/-- Setting a `done` bit true preserves any already-true bit, in range or
not (`setIfInBounds` is a no-op out of range). -/
theorem getD_set_true {a : Array Bool} (u v : Nat)
    (h : a.getD v false = true) : (a.setIfInBounds u true).getD v false = true := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds]
  rw [Array.getD_eq_getD_getElem?] at h
  by_cases huv : u = v
  · subst huv
    by_cases hlt : u < a.size
    · simp [hlt]
    · rw [if_pos rfl, if_neg hlt]
      rw [Array.getElem?_eq_none (by omega)] at h
      exact h
  · rw [if_neg huv]
    exact h

end Verified.Geo
