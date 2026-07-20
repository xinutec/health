import Verified.Geo.LazyFuel

/-!
# Lazy Dijkstra: the live-heap-entry invariant (weight-optimality, keystone)

`LazyInv.wf` says every heap entry is *valid* (its price ≥ the vertex's current
`dist`). The converse — every *unsettled* vertex with a defined `dist` still
holds a live heap entry *at* that `dist` — is what `LazyInv` omits, and it is
the keystone of weight-optimality: it forces the price a vertex is popped at to
equal its `dist` (a smaller live entry would have popped first), which is what
makes "settled distances are the ones the relaxations wrote" true.

> `HInv`: for every vertex `v` that is not yet `done` with `dist[v] = some d`,
> the pair `(d, v)` is in the heap.

It holds because `dist[v]` is only ever set by `relaxStep`, which in the same
step pushes `(d, v)`; `done` only grows; and `pop` removes exactly the popped
top (`pop_cover`), so any *other* vertex's entry survives. `iter_hinv` carries
it from `linit`; `settle_price` reads off the consequence — when `lstep` settles
`u`, it pops it at price `dist[u]`.

Native to the lazy machine (the rail `dijkstra_complete` lives on the rail
`DState`, a different state type), but it reuses the shared `HeapInv` lemmas
(`push_mem`, `pop_cover`, `pop_min`) over the shared `Heap`.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges Heap)
open Verified.Rail.Heap (IsHeap push_mem pop_min pop_top_mem pop_cover pop_mem)

/-- Every unsettled vertex with a defined distance holds a heap entry at that
distance. -/
def HInv (_g : Graph) (s : LState) : Prop :=
  ∀ v d, s.done.getD v false = false → s.dist.getD v none = some d → (d, v) ∈ s.heap.a

/-! ## `relaxStep` building blocks -/

/-- `relaxStep` only ever grows the heap. -/
theorem relaxStep_heap_mono {u p : Nat} {s : LState} {tw : Nat × Nat} {z : Nat × Nat}
    (hz : z ∈ s.heap.a) : z ∈ (relaxStep u p s tw).heap.a := by
  unfold relaxStep
  split
  · exact (push_mem _ _ _ _).mpr (Or.inl hz)
  · split
    · exact (push_mem _ _ _ _).mpr (Or.inl hz)
    · exact hz

/-- At the relaxation target, `relaxStep` either left `dist` untouched, or wrote
`some (p + tw.2)` and pushed the matching entry. -/
theorem relaxStep_dist_cases {u p : Nat} {s : LState} {tw : Nat × Nat} {v : Nat} :
    (relaxStep u p s tw).dist.getD v none = s.dist.getD v none ∨
    (v = tw.1 ∧ (relaxStep u p s tw).dist.getD v none = some (p + tw.2) ∧
      (p + tw.2, v) ∈ (relaxStep u p s tw).heap.a) := by
  by_cases hvt : v = tw.1
  · subst hvt
    unfold relaxStep
    split
    · by_cases hb : tw.1 < s.dist.size
      · exact Or.inr ⟨rfl, getD_sib_lt hb _ _, (push_mem _ _ _ _).mpr (Or.inr rfl)⟩
      · left
        rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds, if_pos rfl, if_neg hb,
          Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (show s.dist.size ≤ tw.1 by omega)]
    · split
      · by_cases hb : tw.1 < s.dist.size
        · exact Or.inr ⟨rfl, getD_sib_lt hb _ _, (push_mem _ _ _ _).mpr (Or.inr rfl)⟩
        · left
          rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds, if_pos rfl, if_neg hb,
            Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (show s.dist.size ≤ tw.1 by omega)]
      · exact Or.inl rfl
  · left
    unfold relaxStep
    split
    · exact getD_sib_ne (fun e => hvt e.symm) _ _
    · split
      · exact getD_sib_ne (fun e => hvt e.symm) _ _
      · rfl

/-- One relaxation preserves `HInv`: an untouched vertex's entry survives (heap
grows), and a written vertex gets its new entry pushed. -/
theorem relaxStep_hinv {g : Graph} {u p : Nat} {s : LState} {tw : Nat × Nat}
    (hH : HInv g s) : HInv g (relaxStep u p s tw) := by
  intro v d hdone hdist
  have hdone' : s.done.getD v false = false := by rw [relaxStep_done u p s tw] at hdone; exact hdone
  rcases relaxStep_dist_cases (u := u) (p := p) (s := s) (tw := tw) (v := v) with heq | ⟨hvt, hval, hmem⟩
  · rw [heq] at hdist
    exact relaxStep_heap_mono (hH v d hdone' hdist)
  · rw [hval] at hdist
    have hd : d = p + tw.2 := (Option.some.injEq _ _).mp hdist.symm
    rw [hd]; exact hmem

/-- The relaxation pass preserves `HInv`. -/
theorem relaxL_hinv {g : Graph} {u p : Nat} {edges : Array (Nat × Nat)} {s : LState}
    (hH : HInv g s) : HInv g (relaxL u p edges s) := by
  unfold relaxL
  rw [← Array.foldl_toList]
  induction edges.toList generalizing s with
  | nil => exact hH
  | cons tw l ih => rw [List.foldl_cons]; exact ih (relaxStep_hinv hH)

/-! ## `HInv` along the trajectory -/

/-- An entry for a vertex other than the popped top survives the pop. -/
private theorem pop_survive {h h' : Heap} {t : Nat × Nat} (hp : h.pop = some (t, h'))
    {d v : Nat} (hvu : v ≠ t.2) (hmem : (d, v) ∈ h.a) : (d, v) ∈ h'.a := by
  rcases pop_cover hp (d, v) hmem with heq | hin
  · exact absurd (congrArg Prod.snd heq) hvu
  · exact hin

/-- Marking the popped vertex done and dropping it from the heap preserves
`HInv`: every still-unsettled vertex with a distance is `≠` the popped one (it
is either already `done` at range, or out of range with no distance), so its
entry survives the pop. -/
private theorem hinv_settle {g : Graph} {L : Nat} {s : LState} {p u : Nat} {h' : Heap}
    (hds : s.done.size = g.n) (hL : LInv g L s)
    (hpop : s.heap.pop = some ((p, u), h')) (hH : HInv g s) :
    HInv g { s with heap := h', done := s.done.setIfInBounds u true } := by
  intro v d hdone hdist
  have hvu : v ≠ u := by
    intro he
    by_cases hun : u < g.n
    · rw [he, getD_sib_lt (by rw [hds]; exact hun)] at hdone; simp at hdone
    · have hnone : s.dist.getD u none = none := by
        rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by rw [hL.dsz]; omega)]; rfl
      rw [he, hnone] at hdist; exact absurd hdist (by simp)
  exact pop_survive hpop (t := (p, u)) hvu
    (hH v d (by rwa [getD_sib_ne (fun e => hvu e.symm)] at hdone) hdist)

/-- One settle step preserves `HInv`. -/
theorem lstep_hinv {g : Graph} {maxR L : Nat} {s : LState}
    (hds : s.done.size = g.n) (hL : LInv g L s) (hH : HInv g s) :
    HInv g (lstep g maxR s) := by
  unfold lstep
  split
  · exact hH
  · split
    · exact hH
    · next p u h' hpop =>
      split
      · -- popped vertex already done: only the heap shrank; unsettled entries survive
        next hu =>
          intro v d hdone hdist
          have hvu : v ≠ u := by intro he; subst he; rw [hu] at hdone; exact absurd hdone (by simp)
          exact pop_survive hpop (t := (p, u)) hvu (hH v d hdone hdist)
      · next hu =>
        split
        · exact hinv_settle hds hL hpop hH
        · exact relaxL_hinv (hinv_settle hds hL hpop hH)

/-- `HInv` survives any number of settle steps. -/
theorem iter_hinv {g : Graph} {maxR : Nat} (hwf : WFEdges g) :
    ∀ (k : Nat) {L : Nat} {s : LState}, s.done.size = g.n → LInv g L s → HInv g s →
      HInv g (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro L s _ _ hH; exact hH
  | succ k ih =>
    intro L s hds hL hH
    rw [iter_succ]
    obtain ⟨L₁, _, hL₁, _⟩ := lstep_inv (maxR := maxR) hwf hL
    exact ih (by rw [lstep_done_size]; exact hds) hL₁ (lstep_hinv hds hL hH)

/-- `linit` satisfies `HInv`: only the source has a distance (`0`), and the heap
is seeded with `(0, src)`. -/
theorem linit_hinv {g : Graph} {src : Nat} (hsrc : src < g.n) : HInv g (linit g.n src) := by
  intro v d hdone hdist
  have hdv : ((Array.replicate g.n none).setIfInBounds src (some 0)).getD v none = some d := hdist
  by_cases hv : v = src
  · subst hv
    rw [getD_sib_lt (by rw [Array.size_replicate]; exact hsrc)] at hdv
    have hd0 : d = 0 := (Option.some.injEq _ _).mp hdv.symm
    subst hd0
    show (0, v) ∈ (Heap.push ⟨#[]⟩ 0 v).a
    exact (push_mem _ _ _ _).mpr (Or.inr rfl)
  · exfalso
    rw [getD_sib_ne (fun e => hv e.symm)] at hdv
    rcases Nat.lt_or_ge v g.n with hlt | hge
    · rw [Array.getD_eq_getD_getElem?,
        Array.getElem?_eq_getElem (by rw [Array.size_replicate]; exact hlt)] at hdv
      simp at hdv
    · rw [Array.getD_eq_getD_getElem?,
        Array.getElem?_eq_none (by rw [Array.size_replicate]; omega)] at hdv
      simp at hdv

/-! ## The payoff: a vertex settles at its own distance -/

/-- **Settle price = distance.** When `lstep` pops `u` at price `p` to settle it
(it was unsettled with `dist[u] = some d`), `p = d`: a smaller live entry would
have popped first (`HInv` + `pop_min`), and `LazyInv.wf` bounds it below. This
is the fact weight-optimality rests on — the search settles each vertex exactly
at the distance the relaxations recorded for it. -/
theorem settle_price {g : Graph} {L p u d : Nat} {s : LState} {h' : Heap}
    (hL : LInv g L s) (hH : HInv g s)
    (hpop : s.heap.pop = some ((p, u), h'))
    (hundone : s.done.getD u false = false) (hdu : s.dist.getD u none = some d) :
    p = d := by
  -- `pop_min`: the popped price is ≤ every heap entry, in particular `(d, u)`.
  have hlive : (d, u) ∈ s.heap.a := hH u d hundone hdu
  have hple : p ≤ d := pop_min hL.hp hpop (d, u) hlive
  -- `LazyInv.wf`: the popped entry `(p, u)` has `dist[u] ≤ p`.
  obtain ⟨d', hd', hd'le⟩ := hL.wf (p, u) (pop_top_mem hpop)
  rw [hdu, Option.some.injEq] at hd'
  omega

end Verified.Geo
