import Verified.Rail.Dijkstra

/-!
# Binary-heap invariants — the machinery behind "settled = final"

The classical Dijkstra ordering arguments — `none ⟺ disconnected` for
the rail search (`LoopInv.lean`, done) and a settled vertex's
`dist`/`prev` being final (`Verified/Geo/LazyDijkstra.lean`, still
`#guard`-pinned) — start here: the ported `Heap` really is a binary
min-heap.

`IsHeapA` is the parent-ordering invariant (`(j-1)/2` is the parent index,
written out everywhere so `omega` can reason about it directly). This file
proves the invariant is established and maintained by the ported
operations, exactly as written:

* `root_le` — the root of a heap-ordered array is a minimum;
* `siftUp_isHeap` — sift-up repairs the one violation `UpOK` allows (the
  freshly-appended index), so `push_isHeap` holds;
* `push_mem` / `push_size` — push bookkeeping;
* `siftDown_isHeap` — sift-down repairs the one violation `DownOK` allows
  (the index the popped root's replacement landed on), fuel permitting —
  `pop` passes the array size, which always suffices;
* `pop_min` / `pop_top_mem` — the popped entry is a minimum, and was in
  the heap;
* `pop_isHeap` / `pop_mem` / `pop_cover` / `pop_size` / `pop_none_iff` —
  pop bookkeeping: the remainder is a heap, its entries come from the old
  heap, every old entry is the popped one or still present, and `pop`
  fails exactly on the empty heap.

Consumers now rebuild the Dijkstra loop invariants on top.
-/

namespace Verified.Rail
namespace Heap

/-- The heap-order invariant: every non-root entry is ≥ its parent
`(j-1)/2`. -/
def IsHeapA (a : Array (Nat × Nat)) : Prop :=
  ∀ j : Nat, 0 < j → j < a.size → (a.getD ((j - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1

def IsHeap (h : Heap) : Prop := IsHeapA h.a

/-! ## `getD` plumbing -/

theorem getD_eq_of_lt {α : Type} {a : Array α} {i : Nat} (hi : i < a.size) (d : α) :
    a.getD i d = a[i] := by
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_getElem hi]
  rfl

theorem getD_set {α : Type} (a : Array α) {i : Nat} (hi : i < a.size) (x : α)
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
  termination_by _ i => i
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
  termination_by _ i => i
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
  termination_by _ i => i
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

/-! ## Sift-down: repairing the root after a pop -/

/-- Heap order everywhere except the edges out of `i`, plus "`i`'s parent
covers `i`'s children" — the mirror image of `UpOK`, re-established one
level down by each sift-down swap. -/
def DownOK (a : Array (Nat × Nat)) (i : Nat) : Prop :=
  (∀ j : Nat, 0 < j → j < a.size → (j - 1) / 2 ≠ i →
      (a.getD ((j - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1) ∧
  (0 < i → ∀ j : Nat, j < a.size → (j - 1) / 2 = i →
      (a.getD ((i - 1) / 2) (0, 0)).1 ≤ (a.getD j (0, 0)).1)

/-- `sDown1` picks the left child exactly when it's in bounds and strictly
smaller; otherwise it stays put and the left child (if any) is ≥. -/
private theorem sDown1_lt (a : Array (Nat × Nat)) (i : Nat) :
    (sDown1 a i = 2 * i + 1 ∧ 2 * i + 1 < a.size ∧
        (a.getD (2 * i + 1) (0, 0)).1 < (a.getD i (0, 0)).1) ∨
      (sDown1 a i = i ∧ (2 * i + 1 < a.size →
        (a.getD i (0, 0)).1 ≤ (a.getD (2 * i + 1) (0, 0)).1)) := by
  unfold sDown1
  by_cases h1 : 2 * i + 1 < a.size
  · by_cases h2 : (a.getD (2 * i + 1) (0, 0)).1 < (a.getD i (0, 0)).1
    · rw [if_pos (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact ⟨h1, h2⟩)]
      exact Or.inl ⟨rfl, h1, h2⟩
    · rw [if_neg (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact fun hc => h2 hc.2)]
      exact Or.inr ⟨rfl, fun _ => Nat.le_of_not_lt h2⟩
  · rw [if_neg (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact fun hc => h1 hc.1)]
    exact Or.inr ⟨rfl, fun h => absurd h h1⟩

/-- The full selection: either `sDown` stays put and both children (where
in bounds) are ≥, or it moves to a strictly smaller child that is minimal
among the children. -/
private theorem sDown_cases (a : Array (Nat × Nat)) (i : Nat) :
    (sDown a i = i ∧
        (∀ j, j < a.size → j = 2 * i + 1 ∨ j = 2 * i + 2 →
          (a.getD i (0, 0)).1 ≤ (a.getD j (0, 0)).1)) ∨
      (2 * i + 1 ≤ sDown a i ∧ sDown a i ≤ 2 * i + 2 ∧ sDown a i < a.size ∧
        (a.getD (sDown a i) (0, 0)).1 < (a.getD i (0, 0)).1 ∧
        (∀ j, j < a.size → j = 2 * i + 1 ∨ j = 2 * i + 2 →
          (a.getD (sDown a i) (0, 0)).1 ≤ (a.getD j (0, 0)).1)) := by
  rcases sDown1_lt a i with ⟨he, h1, h2⟩ | ⟨he, hge⟩
  · by_cases h3 : 2 * i + 2 < a.size ∧
        (a.getD (2 * i + 2) (0, 0)).1 < (a.getD (2 * i + 1) (0, 0)).1
    · have hs : sDown a i = 2 * i + 2 := by
        unfold sDown
        rw [he, if_pos (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact h3)]
      rw [hs]
      refine Or.inr ⟨by omega, by omega, h3.1, Nat.lt_trans h3.2 h2, ?_⟩
      intro j hj hc
      rcases hc with rfl | rfl
      · exact Nat.le_of_lt h3.2
      · exact Nat.le_refl _
    · have hs : sDown a i = 2 * i + 1 := by
        unfold sDown
        rw [he, if_neg (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact h3)]
      rw [hs]
      refine Or.inr ⟨by omega, by omega, h1, h2, ?_⟩
      intro j hj hc
      rcases hc with rfl | rfl
      · exact Nat.le_refl _
      · exact Nat.le_of_not_lt fun hb => h3 ⟨hj, hb⟩
  · by_cases h3 : 2 * i + 2 < a.size ∧
        (a.getD (2 * i + 2) (0, 0)).1 < (a.getD i (0, 0)).1
    · have hs : sDown a i = 2 * i + 2 := by
        unfold sDown
        rw [he, if_pos (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact h3)]
      rw [hs]
      refine Or.inr ⟨by omega, by omega, h3.1, h3.2, ?_⟩
      intro j hj hc
      rcases hc with rfl | rfl
      · exact Nat.le_of_lt (Nat.lt_of_lt_of_le h3.2 (hge hj))
      · exact Nat.le_refl _
    · have hs : sDown a i = i := by
        unfold sDown
        rw [he, if_neg (by simp only [Bool.and_eq_true, decide_eq_true_eq]; exact h3)]
      rw [hs]
      refine Or.inl ⟨rfl, ?_⟩
      intro j hj hc
      rcases hc with rfl | rfl
      · exact hge hj
      · exact Nat.le_of_not_lt fun hb => h3 ⟨hj, hb⟩

private theorem downok_swap {a : Array (Nat × Nat)} {i : Nat}
    (hok : DownOK a i) (hne : sDown a i ≠ i) :
    DownOK ((a.setIfInBounds i (a.getD (sDown a i) (0, 0))).setIfInBounds (sDown a i)
      (a.getD i (0, 0))) (sDown a i) := by
  rcases sDown_cases a i with ⟨he, _⟩ | ⟨hlo, hhi, hms, hlt, hmin⟩
  · exact absurd he hne
  · have his : i < a.size := by omega
    have hpm : (sDown a i - 1) / 2 = i := by omega
    constructor
    · intro j hj hjs hjp
      rw [swap_size] at hjs
      rw [getD_swap a his hms, getD_swap a his hms]
      rw [if_neg hjp]
      by_cases hjm : j = sDown a i
      · -- The swapped edge itself, now strictly ordered.
        rw [if_pos (show (j - 1) / 2 = i by omega), if_pos hjm]
        omega
      · rw [if_neg hjm]
        by_cases hpi : (j - 1) / 2 = i
        · -- The other child of i: the moved-up minimum still covers it.
          rw [if_pos hpi, if_neg (show ¬j = i by omega)]
          exact hmin j hjs (by omega)
        · by_cases hji : j = i
          · -- The edge into i: i's parent covered i's children, so it
            -- covers the value that moved up.
            rw [if_neg hpi, if_pos hji, hji]
            exact hok.2 (by omega) (sDown a i) hms hpm
          · -- Untouched pair.
            rw [if_neg hpi, if_neg hji]
            exact hok.1 j hj hjs hpi
    · intro hm0 j hjs hpj
      rw [swap_size] at hjs
      rw [getD_swap a his hms, getD_swap a his hms, hpm]
      rw [if_neg (show ¬i = sDown a i from fun hh => hne hh.symm), if_pos rfl,
        if_neg (show ¬j = sDown a i by omega), if_neg (show ¬j = i by omega)]
      have h1 := hok.1 j (by omega) hjs (by omega)
      rw [hpj] at h1
      exact h1

theorem siftDown_size : ∀ (fuel : Nat) (a : Array (Nat × Nat)) (i : Nat),
    (Heap.siftDown a fuel i).size = a.size
  | 0, _, _ => rfl
  | fuel + 1, a, i => by
    by_cases h : sDown a i = i
    · simp only [Heap.siftDown, if_pos h]
    · simp only [Heap.siftDown, if_neg h]
      rw [siftDown_size fuel, swap_size]

theorem siftDown_mem : ∀ (fuel : Nat) (a : Array (Nat × Nat)) (i : Nat) (z : Nat × Nat),
    z ∈ Heap.siftDown a fuel i ↔ z ∈ a
  | 0, _, _, _ => Iff.rfl
  | fuel + 1, a, i, z => by
    by_cases h : sDown a i = i
    · simp only [Heap.siftDown, if_pos h]
    · rcases sDown_cases a i with ⟨he, _⟩ | ⟨hlo, _, hms, _, _⟩
      · exact absurd he h
      · have his : i < a.size := by omega
        simp only [Heap.siftDown, if_neg h]
        rw [siftDown_mem fuel]
        exact mem_swap his hms z

/-- Sift-down repairs the `DownOK` violation, provided the fuel covers the
distance to the bottom of the array — `a.size` (what `pop` passes) always
does, since the index at least doubles each step. -/
theorem siftDown_isHeap : ∀ (fuel : Nat) (a : Array (Nat × Nat)) (i : Nat),
    a.size ≤ fuel + i → DownOK a i → IsHeapA (Heap.siftDown a fuel i)
  | 0, a, i, hfi, hok => by
    -- Out of fuel means i is already past the leaves: no in-bounds children.
    simp only [Heap.siftDown]
    intro j hj hjs
    by_cases hp : (j - 1) / 2 = i
    · omega
    · exact hok.1 j hj hjs hp
  | fuel + 1, a, i, hfi, hok => by
    rcases sDown_cases a i with ⟨he, hmin⟩ | ⟨hlo, hhi, hms, hlt, hmin⟩
    · -- No smaller child: DownOK plus the stop condition is the heap order.
      simp only [Heap.siftDown, if_pos he]
      intro j hj hjs
      by_cases hp : (j - 1) / 2 = i
      · rw [hp]
        exact hmin j hjs (by omega)
      · exact hok.1 j hj hjs hp
    · have hne : sDown a i ≠ i := by omega
      simp only [Heap.siftDown, if_neg hne]
      exact siftDown_isHeap fuel _ (sDown a i)
        (by rw [swap_size]; omega)
        (downok_swap hok hne)

/-! ## Pop -/

private theorem getD_pop {a : Array (Nat × Nat)} {q : Nat} (hq : q < a.size - 1) :
    a.pop.getD q (0, 0) = a.getD q (0, 0) := by
  have h1 : q < a.pop.size := by rw [Array.size_pop]; omega
  rw [getD_eq_of_lt h1, getD_eq_of_lt (show q < a.size by omega), Array.getElem_pop]

/-- The array `pop` sifts down: the last element moved onto the root of
everything but the last slot. -/
private theorem size_moved (a : Array (Nat × Nat)) :
    (a.pop.setIfInBounds 0 (a.getD (a.size - 1) (0, 0))).size = a.size - 1 := by
  simp [Array.size_setIfInBounds, Array.size_pop]

private theorem getD_moved {a : Array (Nat × Nat)} {q : Nat}
    (hq : q < a.size - 1) :
    (a.pop.setIfInBounds 0 (a.getD (a.size - 1) (0, 0))).getD q (0, 0) =
      if q = 0 then a.getD (a.size - 1) (0, 0) else a.getD q (0, 0) := by
  rw [getD_set _ (show 0 < a.pop.size by rw [Array.size_pop]; omega)]
  by_cases hq0 : q = 0
  · rw [if_pos hq0, if_pos hq0]
  · rw [if_neg hq0, if_neg hq0, getD_pop hq]

/-- Moving the last element onto the root leaves heap order intact
everywhere except the root's own edges — `DownOK _ 0`. -/
private theorem downok_moved {a : Array (Nat × Nat)} (hh : IsHeapA a) :
    DownOK (a.pop.setIfInBounds 0 (a.getD (a.size - 1) (0, 0))) 0 := by
  constructor
  · intro j hj hjs hjp
    rw [size_moved] at hjs
    rw [getD_moved (show (j - 1) / 2 < a.size - 1 by omega), if_neg hjp,
      getD_moved hjs, if_neg (by omega)]
    exact hh j hj (by omega)
  · intro h0
    omega

theorem mem_of_getD {a : Array (Nat × Nat)} {q : Nat} (hq : q < a.size) :
    a.getD q (0, 0) ∈ a := by
  rw [getD_eq_of_lt hq]
  exact Array.getElem_mem hq

/-- Structural view of a successful `pop`: the returned entry is the root,
and the remainder is either the sifted-down moved array (size > 1) or the
empty array (size 1). -/
private theorem pop_eq {h : Heap} {t : Nat × Nat} {h' : Heap} (hp : h.pop = some (t, h')) :
    0 < h.a.size ∧ t = h.a.getD 0 (0, 0) ∧
      ((1 < h.a.size ∧ h'.a =
          Heap.siftDown (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0)))
            (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0))).size 0) ∨
        (h.a.size = 1 ∧ h'.a = h.a.pop)) := by
  unfold Heap.pop at hp
  split at hp
  · exact absurd hp (by simp)
  · next top hz =>
    obtain ⟨h0, heq⟩ := Array.getElem?_eq_some_iff.mp hz
    have htop : top = h.a.getD 0 (0, 0) := by
      rw [getD_eq_of_lt h0]
      exact heq.symm
    by_cases hs : h.a.pop.size > 0
    · rw [if_pos hs, Option.some.injEq, Prod.mk.injEq] at hp
      obtain ⟨ht, hh⟩ := hp
      refine ⟨h0, ht ▸ htop, Or.inl ⟨by rw [Array.size_pop] at hs; omega, ?_⟩⟩
      rw [← hh]
    · rw [if_neg hs, Option.some.injEq, Prod.mk.injEq] at hp
      obtain ⟨ht, hh⟩ := hp
      have hs1 : h.a.size = 1 := by rw [Array.size_pop] at hs; omega
      exact ⟨h0, ht ▸ htop, Or.inr ⟨hs1, by rw [← hh]⟩⟩

theorem pop_none_iff {h : Heap} : h.pop = none ↔ h.a.size = 0 := by
  constructor
  · intro hp
    unfold Heap.pop at hp
    split at hp
    · next hz =>
      have := Array.getElem?_eq_none_iff.mp hz
      omega
    · next top hz =>
      by_cases hs : h.a.pop.size > 0
      · rw [if_pos hs] at hp
        cases hp
      · rw [if_neg hs] at hp
        cases hp
  · intro hs
    unfold Heap.pop
    rw [Array.getElem?_eq_none (by omega)]

/-- The popped entry is the root — a minimum of the whole heap. -/
theorem pop_min {h : Heap} (hh : IsHeap h) {t : Nat × Nat} {h' : Heap}
    (hp : h.pop = some (t, h')) : ∀ z ∈ h.a, t.1 ≤ z.1 := by
  obtain ⟨h0, ht, _⟩ := pop_eq hp
  intro z hz
  obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
  have hqs : q < h.a.size := by
    rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, _⟩
    exact hlt
  have hzq : h.a.getD q (0, 0) = z := by
    rw [Array.getElem?_eq_getElem hqs] at hq
    injection hq with hq
    rw [getD_eq_of_lt hqs]
    exact hq
  rw [ht, ← hzq]
  exact root_le hh q hqs

theorem pop_top_mem {h : Heap} {t : Nat × Nat} {h' : Heap}
    (hp : h.pop = some (t, h')) : t ∈ h.a := by
  obtain ⟨h0, ht, _⟩ := pop_eq hp
  rw [ht]
  exact mem_of_getD h0

theorem pop_isHeap {h : Heap} (hh : IsHeap h) {t : Nat × Nat} {h' : Heap}
    (hp : h.pop = some (t, h')) : IsHeap h' := by
  obtain ⟨h0, _, hrest⟩ := pop_eq hp
  show IsHeapA h'.a
  rcases hrest with ⟨hs, hb⟩ | ⟨hs, hb⟩
  · rw [hb]
    exact siftDown_isHeap _ _ 0 (by omega) (downok_moved hh)
  · rw [hb]
    intro j hj hjs
    rw [Array.size_pop] at hjs
    omega

/-- Every entry of the remainder was in the heap. -/
theorem pop_mem {h : Heap} {t : Nat × Nat} {h' : Heap} (hp : h.pop = some (t, h')) :
    ∀ z : Nat × Nat, z ∈ h'.a → z ∈ h.a := by
  obtain ⟨h0, _, hrest⟩ := pop_eq hp
  intro z hz
  rcases hrest with ⟨hs, hb⟩ | ⟨hs, hb⟩
  · rw [hb, siftDown_mem] at hz
    obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
    have hqs : q < h.a.size - 1 := by
      rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, _⟩
      rw [size_moved] at hlt
      exact hlt
    have hzq :
        (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0))).getD q (0, 0) = z := by
      rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, heq⟩
      rw [getD_eq_of_lt hlt]
      exact heq
    rw [getD_moved hqs] at hzq
    by_cases hq0 : q = 0
    · rw [if_pos hq0] at hzq
      rw [← hzq]
      exact mem_of_getD (by omega)
    · rw [if_neg hq0] at hzq
      rw [← hzq]
      exact mem_of_getD (by omega)
  · rw [hb] at hz
    obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
    rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, _⟩
    rw [Array.size_pop] at hlt
    omega

/-- Every heap entry is the popped one or survives into the remainder. -/
theorem pop_cover {h : Heap} {t : Nat × Nat} {h' : Heap} (hp : h.pop = some (t, h')) :
    ∀ z : Nat × Nat, z ∈ h.a → z = t ∨ z ∈ h'.a := by
  obtain ⟨h0, ht, hrest⟩ := pop_eq hp
  intro z hz
  obtain ⟨q, hq⟩ := Array.mem_iff_getElem?.mp hz
  have hqs : q < h.a.size := by
    rcases Array.getElem?_eq_some_iff.mp hq with ⟨hlt, _⟩
    exact hlt
  have hzq : h.a.getD q (0, 0) = z := by
    rw [Array.getElem?_eq_getElem hqs] at hq
    injection hq with hq
    rw [getD_eq_of_lt hqs]
    exact hq
  by_cases hq0 : q = 0
  · left
    rw [ht, ← hzq, hq0]
  · rcases hrest with ⟨hs, hb⟩ | ⟨hs, hb⟩
    · right
      rw [hb, siftDown_mem]
      by_cases hql : q = h.a.size - 1
      · -- The last element lives on at the root of the moved array.
        have : (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0))).getD 0 (0, 0)
            = z := by
          rw [getD_moved (show (0 : Nat) < h.a.size - 1 by omega), if_pos rfl, ← hql]
          exact hzq
        rw [← this]
        exact mem_of_getD (by rw [size_moved]; omega)
      · have : (h.a.pop.setIfInBounds 0 (h.a.getD (h.a.size - 1) (0, 0))).getD q (0, 0)
            = z := by
          rw [getD_moved (show q < h.a.size - 1 by omega), if_neg hq0]
          exact hzq
        rw [← this]
        exact mem_of_getD (by rw [size_moved]; omega)
    · -- Size 1: the only entry is the popped root, contradicting q ≠ 0.
      omega

theorem pop_size {h : Heap} {t : Nat × Nat} {h' : Heap} (hp : h.pop = some (t, h')) :
    h'.a.size = h.a.size - 1 := by
  obtain ⟨h0, _, hrest⟩ := pop_eq hp
  rcases hrest with ⟨hs, hb⟩ | ⟨hs, hb⟩
  · rw [hb, siftDown_size, size_moved]
  · rw [hb, Array.size_pop]

end Heap
end Verified.Rail
