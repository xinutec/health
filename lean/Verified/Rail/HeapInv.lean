import Verified.Rail.Dijkstra

/-!
# Binary-heap invariants — the machinery behind "settled = final"

The two facts still `#guard`-pinned in `Verified/Rail/Certify.lean` and
`Verified/Geo/LazyDijkstra.lean` — `none ⟺ disconnected` for the raw
search, and a settled vertex's `dist`/`prev` being final — both reduce to
classical Dijkstra ordering arguments, and those start here: the ported
`Heap` really is a binary min-heap.

`IsHeapA` is the parent-ordering invariant (`(j-1)/2` is the parent index,
written out everywhere so `omega` can reason about it directly). This file
proves the invariant is established and maintained by the ported
operations, exactly as written:

* `root_le` — the root of a heap-ordered array is a minimum;
* `siftUp_isHeap` — sift-up repairs the one violation `UpOK` allows (the
  freshly-appended index), so `push_isHeap` holds;
* `push_mem` / `push_size` — push bookkeeping.

The sift-down/pop half follows in the next slice; consumers then rebuild
the Dijkstra loop invariants on top.
-/

namespace Verified.Rail
namespace Heap

/-- The heap-order invariant: every non-root entry is ≥ its parent
`(j-1)/2`. -/
def IsHeapA (a : Array (Nat × Nat)) : Prop :=
  ∀ j : Nat, 0 < j → j < a.size → (a.getD ((j - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1

def IsHeap (h : Heap) : Prop := IsHeapA h.a

/-! ## `getD` plumbing -/

private theorem getD_eq_of_lt {α : Type} {a : Array α} {i : Nat} (hi : i < a.size) (d : α) :
    a.getD i d = a[i] := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_getElem hi]
  rfl

private theorem getD_set {α : Type} (a : Array α) {i : Nat} (hi : i < a.size) (x : α)
    (j : Nat) (d : α) :
    (a.setIfInBounds i x).getD j d = if j = i then x else a.getD j d := by
  rw [Array.getD_eq_getD_getElem?, Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds]
  by_cases h : i = j
  · subst h
    rw [if_pos rfl, if_pos hi, if_pos rfl]
    rfl
  · rw [if_neg h, if_neg (fun hh => h hh.symm)]

/-- Value view of the sift swap `(a[i] ↔ a[p])`. -/
private theorem getD_swap (a : Array (Nat × Nat)) {i p : Nat} (hi : i < a.size)
    (hp : p < a.size) (q : Nat) :
    ((a.setIfInBounds i (a.getD p (0, 0))).setIfInBounds p (a.getD i (0, 0))).getD q (0, 0) =
      if q = p then a.getD i (0, 0)
      else if q = i then a.getD p (0, 0)
      else a.getD q (0, 0) := by
  rw [getD_set _ (by simpa [Array.size_setIfInBounds] using hp)]
  by_cases hqp : q = p
  · rw [if_pos hqp, if_pos hqp]
  · rw [if_neg hqp, if_neg hqp, getD_set a hi]

private theorem swap_size (a : Array (Nat × Nat)) (i p : Nat) :
    ((a.setIfInBounds i (a.getD p (0, 0))).setIfInBounds p (a.getD i (0, 0))).size = a.size := by
  simp [Array.size_setIfInBounds]

private theorem mem_swap {a : Array (Nat × Nat)} {i p : Nat} (hi : i < a.size)
    (hp : p < a.size) (z : Nat × Nat) :
    z ∈ (a.setIfInBounds i (a.getD p (0, 0))).setIfInBounds p (a.getD i (0, 0)) ↔ z ∈ a := by
  have hswap : ∀ q : Nat,
      ((a.setIfInBounds i (a.getD p (0, 0))).setIfInBounds p (a.getD i (0, 0)))[q]? =
        if q = p then some (a.getD i (0, 0))
        else if q = i then some (a.getD p (0, 0))
        else a[q]? := by
    intro q
    rw [Array.getElem?_setIfInBounds]
    by_cases hpq : p = q
    · rw [if_pos hpq, if_pos (by simpa [Array.size_setIfInBounds] using hp), if_pos hpq.symm]
    · rw [if_neg hpq, Array.getElem?_setIfInBounds]
      by_cases hiq : i = q
      · rw [if_pos hiq, if_pos hi, if_neg (show ¬q = p from fun hh => hpq hh.symm),
          if_pos hiq.symm]
      · rw [if_neg hiq, if_neg (show ¬q = p from fun hh => hpq hh.symm),
          if_neg (show ¬q = i from fun hh => hiq hh.symm)]
  constructor
  · intro hz
    obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
    rw [hswap q] at hq
    by_cases hqp : q = p
    · rw [if_pos hqp] at hq
      injection hq with hq
      refine Array.mem_iff_getElem?.mpr ⟨i, ?_⟩
      rw [Array.getElem?_eq_getElem hi]
      exact congrArg some (by rw [← hq, getD_eq_of_lt hi])
    · rw [if_neg hqp] at hq
      by_cases hqi : q = i
      · rw [if_pos hqi] at hq
        injection hq with hq
        refine Array.mem_iff_getElem?.mpr ⟨p, ?_⟩
        rw [Array.getElem?_eq_getElem hp]
        exact congrArg some (by rw [← hq, getD_eq_of_lt hp])
      · rw [if_neg hqi] at hq
        exact Array.mem_iff_getElem?.mpr ⟨q, hq⟩
  · intro hz
    obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
    by_cases hqp : q = p
    · rw [hqp] at hq
      refine Array.mem_iff_getElem?.mpr ⟨i, ?_⟩
      rw [hswap i]
      by_cases hip : i = p
      · rw [if_pos hip, hip, getD_eq_of_lt hp]
        rw [Array.getElem?_eq_getElem hp] at hq
        exact hq
      · rw [if_neg hip, if_pos rfl, getD_eq_of_lt hp]
        rw [Array.getElem?_eq_getElem hp] at hq
        injection hq with hq
        rw [hq]
    · by_cases hqi : q = i
      · rw [hqi] at hq
        refine Array.mem_iff_getElem?.mpr ⟨p, ?_⟩
        rw [hswap p, if_pos rfl, getD_eq_of_lt hi]
        rw [Array.getElem?_eq_getElem hi] at hq
        injection hq with hq
        rw [hq]
      · exact Array.mem_iff_getElem?.mpr ⟨q, by rw [hswap q, if_neg hqp, if_neg hqi]; exact hq⟩

/-! ## The root is a minimum -/

theorem root_le {a : Array (Nat × Nat)} (h : IsHeapA a) :
    ∀ (j : Nat), j < a.size → (a.getD 0 (0, 0)).1 ≤ (a.getD j (0, 0)).1
  | 0, _ => Nat.le_refl _
  | j + 1, hj =>
    Nat.le_trans (root_le h ((j + 1 - 1) / 2) (by omega)) (h (j + 1) (by omega) hj)
  termination_by j _ => j
  decreasing_by omega

/-! ## Sift-up: repairing the appended index -/

/-- Heap order everywhere except the pair at `i`, plus "the grandparent
covers `i`'s children" — exactly what one sift-up swap re-establishes one
level up. -/
def UpOK (a : Array (Nat × Nat)) (i : Nat) : Prop :=
  (∀ j : Nat, 0 < j → j < a.size → j ≠ i →
      (a.getD ((j - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1) ∧
  (0 < i → ∀ j : Nat, 0 < j → j < a.size → (j - 1) / 2 = i →
      (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1)

private theorem upok_swap {a : Array (Nat × Nat)} {i : Nat} (hi : i < a.size) (h0 : 0 < i)
    (hok : UpOK a i) (hviol : ¬(a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD i (0, 0)).1) :
    UpOK ((a.setIfInBounds i (a.getD ((i - 1) / 2) (0, 0))).setIfInBounds ((i - 1) / 2)
      (a.getD i (0, 0))) ((i - 1) / 2) := by
  have hps : (i - 1) / 2 < a.size := by omega
  have hxy : (a.getD i (0, 0)).1 < (a.getD ((i - 1) / 2) (0, 0)).1 := by omega
  constructor
  · intro j hj hjs hjp
    rw [swap_size] at hjs
    rw [getD_swap a hi hps, getD_swap a hi hps]
    by_cases hji : j = i
    · -- The swapped pair itself, now ordered.
      rw [if_pos (show (j - 1) / 2 = (i - 1) / 2 by omega), if_neg hjp, if_pos hji]
      omega
    · by_cases hpj : (j - 1) / 2 = i
      · -- A child of i: the grandparent clause covers it.
        rw [if_neg (show ¬(j - 1) / 2 = (i - 1) / 2 by omega), if_pos hpj,
          if_neg (show ¬j = (i - 1) / 2 by omega), if_neg hji]
        exact hok.2 h0 j hj hjs hpj
      · by_cases hpp : (j - 1) / 2 = (i - 1) / 2
        · -- A sibling of i under the parent.
          rw [if_pos hpp, if_neg hjp, if_neg hji]
          have h2 := hok.1 j hj hjs hji
          rw [hpp] at h2
          omega
        · -- Untouched pair.
          rw [if_neg hpp, if_neg hpj, if_neg hjp, if_neg hji]
          exact hok.1 j hj hjs hji
  · intro hp0 j hj hjs hpj
    rw [swap_size] at hjs
    rw [getD_swap a hi hps, getD_swap a hi hps]
    have h1 := hok.1 ((i - 1) / 2) hp0 hps (by omega)
    rw [if_neg (show ¬((i - 1) / 2 - 1) / 2 = (i - 1) / 2 by omega),
      if_neg (show ¬((i - 1) / 2 - 1) / 2 = i by omega)]
    by_cases hji : j = i
    · -- The child that received the old parent value.
      rw [if_neg (show ¬j = (i - 1) / 2 by omega), if_pos hji]
      omega
    · -- The sibling: chain through the old parent value.
      rw [if_neg (show ¬j = (i - 1) / 2 by omega), if_neg hji]
      have h2 := hok.1 j hj hjs hji
      rw [hpj] at h2
      omega

theorem siftUp_isHeap : ∀ (a : Array (Nat × Nat)) (i : Nat), i < a.size → UpOK a i →
    IsHeapA (Heap.siftUp a i)
  | a, i, hi, hok => by
    by_cases h0 : i = 0
    · unfold Heap.siftUp
      rw [dif_pos h0]
      intro j hj hjs
      exact hok.1 j hj hjs (by omega)
    · by_cases hord : (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD i (0, 0)).1
      · unfold Heap.siftUp
        rw [dif_neg h0, if_pos hord]
        intro j hj hjs
        by_cases hji : j = i
        · rw [hji]
          exact hord
        · exact hok.1 j hj hjs hji
      · unfold Heap.siftUp
        rw [dif_neg h0, if_neg hord]
        exact siftUp_isHeap _ ((i - 1) / 2)
          (by rw [swap_size]; omega)
          (upok_swap hi (by omega) hok hord)
  termination_by a i => i
  decreasing_by omega

theorem siftUp_size : ∀ (a : Array (Nat × Nat)) (i : Nat), (Heap.siftUp a i).size = a.size
  | a, i => by
    by_cases h0 : i = 0
    · unfold Heap.siftUp
      rw [dif_pos h0]
    · by_cases hord : (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD i (0, 0)).1
      · unfold Heap.siftUp
        rw [dif_neg h0, if_pos hord]
      · unfold Heap.siftUp
        rw [dif_neg h0, if_neg hord, siftUp_size _ ((i - 1) / 2), swap_size]
  termination_by a i => i
  decreasing_by omega

theorem siftUp_mem : ∀ (a : Array (Nat × Nat)) (i : Nat), i < a.size → ∀ z : Nat × Nat,
    (z ∈ Heap.siftUp a i ↔ z ∈ a)
  | a, i, hi, z => by
    by_cases h0 : i = 0
    · unfold Heap.siftUp
      rw [dif_pos h0]
    · by_cases hord : (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD i (0, 0)).1
      · unfold Heap.siftUp
        rw [dif_neg h0, if_pos hord]
      · unfold Heap.siftUp
        rw [dif_neg h0, if_neg hord,
          siftUp_mem _ ((i - 1) / 2) (by rw [swap_size]; omega) z]
        exact mem_swap hi (by omega) z
  termination_by a i => i
  decreasing_by omega

/-! ## Push -/

private theorem getD_push_lt {a : Array (Nat × Nat)} {q : Nat} (hq : q < a.size)
    (x : Nat × Nat) : (a.push x).getD q (0, 0) = a.getD q (0, 0) := by
  rw [Array.getD_eq_getD_getElem?, Array.getD_eq_getD_getElem?, Array.getElem?_push,
    if_neg (by omega)]

theorem push_isHeap (h : Heap) (hh : IsHeap h) (p v : Nat) : IsHeap (h.push p v) := by
  show IsHeapA (Heap.siftUp (h.a.push (p, v)) ((h.a.push (p, v)).size - 1))
  have hn : (h.a.push (p, v)).size = h.a.size + 1 := Array.size_push _
  apply siftUp_isHeap _ _ (by omega)
  constructor
  · intro j hj hjs hjn
    have hjlt : j < h.a.size := by omega
    rw [getD_push_lt (show (j - 1) / 2 < h.a.size by omega),
      getD_push_lt (show j < h.a.size by omega)]
    exact hh j hj hjlt
  · intro h0 j hj hjs hpj
    -- The appended index is the last one: it has no in-bounds children.
    omega

theorem push_mem (h : Heap) (p v : Nat) (z : Nat × Nat) :
    z ∈ (h.push p v).a ↔ z ∈ h.a ∨ z = (p, v) := by
  show z ∈ Heap.siftUp (h.a.push (p, v)) ((h.a.push (p, v)).size - 1) ↔ _
  rw [siftUp_mem _ _ (by simp [Array.size_push]) z, Array.mem_push]

theorem push_size (h : Heap) (p v : Nat) : (h.push p v).a.size = h.a.size + 1 := by
  show (Heap.siftUp (h.a.push (p, v)) _).size = _
  rw [siftUp_size, Array.size_push]

end Heap
end Verified.Rail
