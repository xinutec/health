import Verified.Geo.LazyDijkstra
import Verified.Rail.HeapInv
import Verified.Rail.LoopInv

/-!
# LazyDijkstra "settled = final" — the last `#guard` pin, retired

`LazyDijkstra.lean` proved the refinement half (lazy pausing/resuming
traverses exactly the eager trajectory); the classic "a settled vertex's
`dist`/`prev` never change afterwards" fact stayed `#guard`-pinned. This
file proves it with a slim cut of the rail `LoopInv` bundle — no ghost
tree, no certification, no completeness, just the freezing argument:

`LInv g L s` carries the heap-shape invariant, lazy deletion (`wf`:
every live heap entry over-approximates its vertex's `dist`), the
monotone pop floor `L` (`ge`), and settled-prices-below-the-floor
(`dle`). One `lstep` preserves the bundle at a possibly-larger floor and
— the point — leaves every already-done vertex's `dist`/`prev` bits
untouched: a done vertex `v` has `dist v ≤ L ≤ p` for the popped price
`p`, so a relaxation candidate `p + w ≥ p` can never beat it
(`relaxStep_inv`). Induction along `iter`/`lsettle` gives
`iter_frozen`/`lsettle_frozen`; `linit_inv` starts the chain, and
`lsettle_inv` re-establishes the bundle after every settle, so the fact
holds across any interleaving of memoised settles — the per-source
cache never serves a value that a later resume could have changed.

Hypotheses, as in the rail proof: `WFEdges g` (in-range adjacency
targets — `setIfInBounds` silently drops out-of-range updates, so this
is a real assumption, true of production graphs by construction) and an
in-range source for `linit`.

Fuel sufficiency (the TS loop always reaches the stop condition) is
proved in `LazyFuel.lean`; the `#guard`s stay as smoke tests.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges Heap)
open Verified.Rail.Heap (IsHeap push_isHeap push_mem pop_min pop_top_mem
  pop_isHeap pop_mem)

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

/-- The lazy-search invariant at pop floor `L`: well-shaped heap, lazy
deletion, floor-bounded entries, settled prices below the floor, and
in-range arrays. -/
structure LInv (g : Graph) (L : Nat) (s : LState) : Prop where
  hp : IsHeap s.heap
  dsz : s.dist.size = g.n
  psz : s.prev.size = g.n
  wf : ∀ z : Nat × Nat, z ∈ s.heap.a →
    ∃ d, s.dist.getD z.2 none = some d ∧ d ≤ z.1
  ge : ∀ z : Nat × Nat, z ∈ s.heap.a → L ≤ z.1
  dle : ∀ v, s.done.getD v false = true →
    ∃ d, s.dist.getD v none = some d ∧ d ≤ L

/-- What "nothing changed for `v`" means below. -/
def FrozenAt (s s' : LState) (v : Nat) : Prop :=
  s'.done.getD v false = true ∧
  s'.dist.getD v none = s.dist.getD v none ∧
  s'.prev.getD v 0 = s.prev.getD v 0

theorem frozenAt_refl {s : LState} {v : Nat}
    (h : s.done.getD v false = true) : FrozenAt s s v :=
  ⟨h, rfl, rfl⟩

theorem frozenAt_trans {s₁ s₂ s₃ : LState} {v : Nat}
    (h₁ : FrozenAt s₁ s₂ v) (h₂ : FrozenAt s₂ s₃ v) : FrozenAt s₁ s₃ v :=
  ⟨h₂.1, h₂.2.1.trans h₁.2.1, h₂.2.2.trans h₁.2.2⟩

/-- One relaxation preserves the bundle at floor `p` and freezes every
done vertex (a done price is `≤ p`, a candidate is `≥ p`). -/
theorem relaxStep_inv {g : Graph} {u p : Nat} {s : LState}
    {tw : Nat × Nat} (htw : tw.1 < g.n) (h : LInv g p s) :
    LInv g p (relaxStep u p s tw) ∧
    ∀ v, s.done.getD v false = true → FrozenAt s (relaxStep u p s tw) v := by
  have hdone := relaxStep_done u p s tw
  unfold relaxStep
  split
  next hnone =>
    -- fresh vertex: update and push
    have hfrz : ∀ v, s.done.getD v false = true →
        v ≠ tw.1 ∧ s.dist.getD v none ≠ none := by
      intro v hv
      obtain ⟨d, hd, _⟩ := h.dle v hv
      constructor
      · intro he
        rw [he, hnone] at hd
        exact absurd hd (by simp)
      · rw [hd]
        simp
    refine ⟨⟨push_isHeap _ h.hp _ _, by simp [h.dsz], by simp [h.psz],
      ?_, ?_, ?_⟩, ?_⟩
    · intro z hz
      rcases (push_mem _ _ _ _).mp hz with hz' | rfl
      · obtain ⟨d, hd, hdle⟩ := h.wf z hz'
        by_cases hzt : z.2 = tw.1
        · rw [hzt, hnone] at hd
          exact absurd hd (by simp)
        · exact ⟨d, by rw [getD_sib_ne (fun he => hzt he.symm)]; exact hd,
            hdle⟩
      · exact ⟨p + tw.2, by
          rw [getD_sib_lt (by rw [h.dsz]; exact htw)], Nat.le_refl _⟩
    · intro z hz
      rcases (push_mem _ _ _ _).mp hz with hz' | rfl
      · exact h.ge z hz'
      · exact Nat.le_add_right _ _
    · intro v hv
      obtain ⟨hne, _⟩ := hfrz v hv
      obtain ⟨d, hd, hdle⟩ := h.dle v hv
      exact ⟨d, by rw [getD_sib_ne (fun he => hne he.symm)]; exact hd, hdle⟩
    · intro v hv
      obtain ⟨hne, _⟩ := hfrz v hv
      exact ⟨hv, by rw [getD_sib_ne (fun he => hne he.symm)],
        by rw [getD_sib_ne (fun he => hne he.symm)]⟩
  next dv hdv =>
    split
    next hlt =>
      -- improvement: tw.1 cannot be done (its price would bound p + w)
      have hnd : s.done.getD tw.1 false ≠ true := by
        intro hd
        obtain ⟨d, hdist, hdle⟩ := h.dle tw.1 hd
        rw [hdv] at hdist
        injection hdist with hdd
        omega
      refine ⟨⟨push_isHeap _ h.hp _ _, by simp [h.dsz], by simp [h.psz],
        ?_, ?_, ?_⟩, ?_⟩
      · intro z hz
        rcases (push_mem _ _ _ _).mp hz with hz' | rfl
        · obtain ⟨d, hd, hdle⟩ := h.wf z hz'
          by_cases hzt : z.2 = tw.1
          · refine ⟨p + tw.2, by
              rw [hzt, getD_sib_lt (by rw [h.dsz]; exact htw)], ?_⟩
            rw [hzt, hdv] at hd
            injection hd with hd
            omega
          · exact ⟨d, by rw [getD_sib_ne (fun he => hzt he.symm)]; exact hd,
              hdle⟩
        · exact ⟨p + tw.2, by
            rw [getD_sib_lt (by rw [h.dsz]; exact htw)], Nat.le_refl _⟩
      · intro z hz
        rcases (push_mem _ _ _ _).mp hz with hz' | rfl
        · exact h.ge z hz'
        · exact Nat.le_add_right _ _
      · intro v hv
        have hne : v ≠ tw.1 := fun he => hnd (he ▸ hv)
        obtain ⟨d, hd, hdle⟩ := h.dle v hv
        exact ⟨d, by rw [getD_sib_ne (fun he => hne he.symm)]; exact hd, hdle⟩
      · intro v hv
        have hne : v ≠ tw.1 := fun he => hnd (he ▸ hv)
        exact ⟨hv, by rw [getD_sib_ne (fun he => hne he.symm)],
          by rw [getD_sib_ne (fun he => hne he.symm)]⟩
    next =>
      exact ⟨h, fun v hv => frozenAt_refl hv⟩

/-- The relaxation fold over an edge list. -/
theorem relaxList_inv {g : Graph} {u p : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState}, (∀ tw ∈ l, tw.1 < g.n) →
      LInv g p s →
      LInv g p (l.foldl (relaxStep u p) s) ∧
      ∀ v, s.done.getD v false = true →
        FrozenAt s (l.foldl (relaxStep u p) s) v
  | [], s, _, h => ⟨h, fun v hv => frozenAt_refl hv⟩
  | tw :: l, s, hedge, h => by
    rw [List.foldl_cons]
    have hstep := relaxStep_inv (g := g) (u := u)
      (hedge tw (List.mem_cons_self ..)) h
    have hrest := relaxList_inv (u := u) l
      (fun t ht => hedge t (List.mem_cons_of_mem _ ht)) hstep.1
    refine ⟨hrest.1, fun v hv => ?_⟩
    have h₁ := hstep.2 v hv
    exact frozenAt_trans h₁ (hrest.2 v h₁.1)

/-- The whole relaxation pass. -/
theorem relaxL_inv {g : Graph} {u p : Nat} {edges : Array (Nat × Nat)}
    {s : LState} (hedge : ∀ tw ∈ edges.toList, tw.1 < g.n)
    (h : LInv g p s) :
    LInv g p (relaxL u p edges s) ∧
    ∀ v, s.done.getD v false = true → FrozenAt s (relaxL u p edges s) v := by
  unfold relaxL
  rw [← Array.foldl_toList]
  exact relaxList_inv _ hedge h

/-- One step of the settle loop preserves the bundle at a
possibly-larger floor and freezes every done vertex — **the settled =
final step fact**. -/
theorem lstep_inv {g : Graph} {maxR L : Nat} {s : LState}
    (hwf : WFEdges g) (h : LInv g L s) :
    ∃ L', L ≤ L' ∧ LInv g L' (lstep g maxR s) ∧
      ∀ v, s.done.getD v false = true → FrozenAt s (lstep g maxR s) v := by
  unfold lstep
  split
  next => exact ⟨L, Nat.le_refl _, h, fun v hv => frozenAt_refl hv⟩
  next =>
    split
    next => exact ⟨L, Nat.le_refl _, h, fun v hv => frozenAt_refl hv⟩
    next p u h' hpop =>
      split
      next =>
        -- stale entry: only the heap shrinks
        refine ⟨L, Nat.le_refl _,
          ⟨pop_isHeap h.hp hpop, h.dsz, h.psz,
            fun z hz => h.wf z (pop_mem hpop z hz),
            fun z hz => h.ge z (pop_mem hpop z hz), h.dle⟩,
          fun v hv => frozenAt_refl hv⟩
      next hu =>
        -- fresh settle at price p: the new floor
        have hpmem := pop_top_mem hpop
        have hLp : L ≤ p := h.ge _ hpmem
        obtain ⟨du, hdu, hdup⟩ := h.wf _ hpmem
        have hinv' : LInv g p
            { s with heap := h', done := s.done.setIfInBounds u true } := by
          refine ⟨pop_isHeap h.hp hpop, h.dsz, h.psz,
            fun z hz => h.wf z (pop_mem hpop z hz),
            fun z hz => pop_min h.hp hpop z (pop_mem hpop z hz), ?_⟩
          intro v hv
          rcases getD_sib_true hv with rfl | hv'
          · exact ⟨du, hdu, hdup⟩
          · obtain ⟨d, hd, hdle⟩ := h.dle v hv'
            exact ⟨d, hd, Nat.le_trans hdle hLp⟩
        have hfrz' : ∀ v, s.done.getD v false = true →
            FrozenAt s { s with heap := h'
                                done := s.done.setIfInBounds u true } v :=
          fun v hv => ⟨getD_set_true _ _ hv, rfl, rfl⟩
        split
        next =>
          exact ⟨p, hLp,
            ⟨hinv'.hp, hinv'.dsz, hinv'.psz, hinv'.wf, hinv'.ge, hinv'.dle⟩,
            hfrz'⟩
        next =>
          rcases Nat.lt_or_ge u g.n with hun | hun
          · have hrel := relaxL_inv (u := u) (p := p)
              (hedge := fun tw ht => hwf u hun tw ht) hinv'
            exact ⟨p, hLp, hrel.1, fun v hv =>
              frozenAt_trans (hfrz' v hv) (hrel.2 v (hfrz' v hv).1)⟩
          · have hemp : g.adj.getD u #[] = #[] := by
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none]
              · rfl
              · exact hun
            rw [hemp]
            have hrel := relaxL_inv (u := u) (p := p) (edges := #[])
              (hedge := by simp) hinv'
            exact ⟨p, hLp, hrel.1, fun v hv =>
              frozenAt_trans (hfrz' v hv) (hrel.2 v (hfrz' v hv).1)⟩

/-- The bundle survives any number of steps, and every vertex done at
the start stays frozen throughout. -/
theorem iter_inv {g : Graph} {maxR : Nat} (hwf : WFEdges g) :
    ∀ (k : Nat) {L : Nat} {s : LState}, LInv g L s →
      (∃ L', L ≤ L' ∧ LInv g L' (iter g maxR k s)) ∧
      ∀ v, s.done.getD v false = true → FrozenAt s (iter g maxR k s) v
  | 0, L, s, h => ⟨⟨L, Nat.le_refl _, h⟩, fun v hv => frozenAt_refl hv⟩
  | k + 1, L, s, h => by
    obtain ⟨L₁, hL₁, h₁, hf₁⟩ := lstep_inv (maxR := maxR) hwf h
    obtain ⟨⟨L₂, hL₂, h₂⟩, hf₂⟩ := iter_inv hwf k h₁
    exact ⟨⟨L₂, Nat.le_trans hL₁ hL₂, h₂⟩, fun v hv =>
      frozenAt_trans (hf₁ v hv) (hf₂ v (hf₁ v hv).1)⟩

/-- Same along the fueled settle loop. -/
theorem lsettle_inv {g : Graph} {maxR t : Nat} (hwf : WFEdges g) :
    ∀ (fuel : Nat) {L : Nat} {s : LState}, LInv g L s →
      (∃ L', L ≤ L' ∧ LInv g L' (lsettle g maxR t fuel s)) ∧
      ∀ v, s.done.getD v false = true →
        FrozenAt s (lsettle g maxR t fuel s) v
  | 0, L, s, h => ⟨⟨L, Nat.le_refl _, h⟩, fun v hv => frozenAt_refl hv⟩
  | fuel + 1, L, s, h => by
    unfold lsettle
    split
    next => exact ⟨⟨L, Nat.le_refl _, h⟩, fun v hv => frozenAt_refl hv⟩
    next =>
      obtain ⟨L₁, hL₁, h₁, hf₁⟩ := lstep_inv (maxR := maxR) hwf h
      obtain ⟨⟨L₂, hL₂, h₂⟩, hf₂⟩ := lsettle_inv hwf fuel h₁
      exact ⟨⟨L₂, Nat.le_trans hL₁ hL₂, h₂⟩, fun v hv =>
        frozenAt_trans (hf₁ v hv) (hf₂ v (hf₁ v hv).1)⟩

/-- The per-source initial state satisfies the bundle at floor 0. -/
theorem linit_inv {g : Graph} {src : Nat} (hsrc : src < g.n) :
    LInv g 0 (linit g.n src) := by
  refine ⟨?_, by simp [linit], by simp [linit], ?_, ?_, ?_⟩
  · intro j hj hjs
    rw [show (linit g.n src).heap = Heap.push ⟨#[]⟩ 0 src from rfl,
      Verified.Rail.Heap.push_size] at hjs
    simp at hjs
    omega
  · intro z hz
    rcases (push_mem _ _ _ _).mp hz with hz' | rfl
    · exact absurd hz' (by simp)
    · refine ⟨0, ?_, Nat.le_refl _⟩
      show ((Array.replicate g.n none).setIfInBounds src
        (some 0)).getD src none = some 0
      rw [getD_sib_lt (by simpa using hsrc)]
  · intro z hz
    exact Nat.zero_le _
  · intro v hv
    rw [show (linit g.n src).done = Array.replicate g.n false from rfl] at hv
    rw [Array.getD_eq_getD_getElem?] at hv
    rcases Nat.lt_or_ge v g.n with hvn | hvn
    · rw [Array.getElem?_eq_getElem (by simpa using hvn)] at hv
      simp at hv
    · rw [Array.getElem?_eq_none (by simpa using hvn)] at hv
      exact absurd hv (by simp)

/-- **Settled = final** (the retired pin): from a valid state, once a
vertex is done, its `dist` and `prev` are what every later state of the
trajectory reports — through any number of steps or fueled settles,
hence through any interleaving of memoised `settle` calls. -/
theorem settled_final {g : Graph} {maxR L k : Nat} {s : LState} {v : Nat}
    (hwf : WFEdges g) (h : LInv g L s)
    (hv : s.done.getD v false = true) :
    (iter g maxR k s).dist.getD v none = s.dist.getD v none ∧
    (iter g maxR k s).prev.getD v 0 = s.prev.getD v 0 ∧
    (iter g maxR k s).done.getD v false = true := by
  obtain ⟨-, hf⟩ := iter_inv (maxR := maxR) hwf k h
  obtain ⟨hd, h1, h2⟩ := hf v hv
  exact ⟨h1, h2, hd⟩

theorem settled_final_settle {g : Graph} {maxR t fuel L : Nat}
    {s : LState} {v : Nat} (hwf : WFEdges g) (h : LInv g L s)
    (hv : s.done.getD v false = true) :
    (lsettle g maxR t fuel s).dist.getD v none = s.dist.getD v none ∧
    (lsettle g maxR t fuel s).prev.getD v 0 = s.prev.getD v 0 ∧
    (lsettle g maxR t fuel s).done.getD v false = true := by
  obtain ⟨-, hf⟩ := lsettle_inv (maxR := maxR) (t := t) hwf fuel h
  obtain ⟨hd, h1, h2⟩ := hf v hv
  exact ⟨h1, h2, hd⟩

end Verified.Geo
