import Verified.Geo.LazyDijkstra

/-!
# Lazy Dijkstra: the prev-edge provenance invariant

`LazyInv` proves "settled = final" and `LazyPrev` proves the prev-chain stays
inside *done* vertices — enough to make the reconstructed route
*resume-stable*. Both deliberately omit the fact that turns a resume-stable
`prev`-walk into a *valid path*: that every `prev` link is a **real graph
edge**. This file supplies exactly that missing brick.

> `EInv`: for every vertex `v` whose `prev` is a non-sentinel `u`, `v` is a
> genuine out-neighbour of `u` — `(v, w) ∈ g.adj[u]` for some weight `w`.

It holds because `prev[v]` is only ever written by `relaxStep u p · (v, w)`
while `relaxL u p` folds over `g.adj[u]` — so the written `prev[v] = u` always
comes paired with the edge `(v, w) ∈ g.adj[u]` that drove the relaxation. The
invariant needs *no* `LInv`, no `done` bookkeeping, and no `WFEdges`: it is a
pure statement about how `prev` is populated, which is why it is markedly
lighter than `PInv`. `iter_einv` carries it along the whole search trajectory
from `linit`; `iter_einv_edge` reads off the consequence the route
reconstruction (`qReconstruct` over `(iter …).prev`) consumes: each step of
the reconstructed chain is a real edge of `g`.

This is the first brick of the matcher routing-optimality track (the analogue
of the rail `dijkstraC_correct` "valid path" half): the reconstructed route is
a genuine connected `src → tgt` walk of real graph edges. The weight-optimality
half (`dist[tgt] = trueShortestDist`) builds on this and the `LazyInv` settle
bundle, and is the next brick.
-/

namespace Verified.Geo

open Verified.Rail (Graph)

/-- Every vertex with a non-sentinel `prev` is a real out-neighbour of that
`prev`: `prev[v] = u ≠ g.n` implies `g` has an edge `u → v`. -/
def EInv (g : Graph) (s : LState) : Prop :=
  ∀ v, s.prev.getD v g.n ≠ g.n →
    ∃ w, (v, w) ∈ (g.adj.getD (s.prev.getD v g.n) #[]).toList

/-- `EInv` depends only on `prev`, so any state-update that leaves `prev`
untouched (heap/done/dist/exhausted writes) preserves it. -/
theorem EInv_congr {g : Graph} {s₁ s₂ : LState} (h : s₁.prev = s₂.prev)
    (hE : EInv g s₁) : EInv g s₂ := by
  intro v hv
  rw [← h] at hv ⊢
  exact hE v hv

/-! ## `prev` read-after-write facts specific to the edge invariant -/

/-- Reading `prev` at a vertex other than the relaxation target is untouched.
(Reproved locally — `LazyPrev`'s copy is `private`.) -/
private theorem relaxStep_prev_ne' {u p : Nat} {s : LState} {tw : Nat × Nat}
    {v d : Nat} (h : v ≠ tw.1) :
    (relaxStep u p s tw).prev.getD v d = s.prev.getD v d := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

/-- `getD` at an out-of-range `setIfInBounds` reads the old value (the write
is silently dropped). -/
private theorem getD_sib_ge {α : Type} {a : Array α} {i : Nat} (h : ¬ i < a.size)
    (x d : α) : (a.setIfInBounds i x).getD i d = a.getD i d := by
  have hsz : (a.setIfInBounds i x).size = a.size := Array.size_setIfInBounds
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by rw [hsz]; omega),
    Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by omega)]

/-- At the relaxation target, `prev` either became the relaxer `u` (a real
write, in bounds) or was left untouched (no better distance, or out of
range). -/
private theorem relaxStep_prev_cases {u p : Nat} {s : LState} {tw : Nat × Nat}
    {d : Nat} :
    (relaxStep u p s tw).prev.getD tw.1 d = u ∨
    (relaxStep u p s tw).prev.getD tw.1 d = s.prev.getD tw.1 d := by
  unfold relaxStep
  split
  · by_cases hb : tw.1 < s.prev.size
    · exact Or.inl (getD_sib_lt hb u d)
    · exact Or.inr (getD_sib_ge hb u d)
  · split
    · by_cases hb : tw.1 < s.prev.size
      · exact Or.inl (getD_sib_lt hb u d)
      · exact Or.inr (getD_sib_ge hb u d)
    · exact Or.inr rfl

/-! ## Preservation along the search trajectory -/

/-- One relaxation preserves `EInv`, given the edge it relaxes is a real edge
of the relaxer `u`. -/
theorem relaxStep_einv {g : Graph} {u p : Nat} {s : LState} {tw : Nat × Nat}
    (htw : tw ∈ (g.adj.getD u #[]).toList) (hE : EInv g s) :
    EInv g (relaxStep u p s tw) := by
  intro v hv
  by_cases hvt : v = tw.1
  · subst hvt
    rcases relaxStep_prev_cases (u := u) (p := p) (s := s) (tw := tw) (d := g.n) with hu | hun
    · rw [hu]; exact ⟨tw.2, htw⟩
    · rw [hun] at hv ⊢; exact hE tw.1 hv
  · rw [relaxStep_prev_ne' hvt] at hv ⊢; exact hE v hv

/-- Folding relaxations over an edge list preserves `EInv`, when every listed
edge is a real edge of `u`. -/
theorem relaxList_einv {g : Graph} {u p : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState},
      (∀ tw ∈ l, tw ∈ (g.adj.getD u #[]).toList) →
      EInv g s → EInv g (l.foldl (relaxStep u p) s) := by
  intro l
  induction l with
  | nil => intro s _ hE; exact hE
  | cons tw l ih =>
    intro s hmem hE
    rw [List.foldl_cons]
    exact ih (fun t ht => hmem t (List.mem_cons_of_mem _ ht))
      (relaxStep_einv (hmem tw (List.mem_cons_self ..)) hE)

/-- The whole relaxation pass over `u`'s adjacency preserves `EInv` — every
edge it folds is, by construction, a real edge of `u`. -/
theorem relaxL_einv {g : Graph} {u p : Nat} {s : LState} (hE : EInv g s) :
    EInv g (relaxL u p (g.adj.getD u #[]) s) := by
  unfold relaxL
  rw [← Array.foldl_toList]
  exact relaxList_einv (g.adj.getD u #[]).toList (fun _ ht => ht) hE

/-- One settle step preserves `EInv`: the only `prev` writes happen inside the
`relaxL` over the popped vertex's own adjacency; every other branch leaves
`prev` untouched. -/
theorem lstep_einv {g : Graph} {maxR : Nat} {s : LState} (hE : EInv g s) :
    EInv g (lstep g maxR s) := by
  unfold lstep
  split
  · exact hE
  · split
    · exact hE
    · next p u h' hpop =>
      split
      · exact EInv_congr rfl hE
      · next hu =>
        split
        · exact EInv_congr rfl hE
        · exact relaxL_einv (EInv_congr rfl hE)

/-- `EInv` survives any number of settle steps. -/
theorem iter_einv {g : Graph} {maxR : Nat} :
    ∀ (k : Nat) {s : LState}, EInv g s → EInv g (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro s hE; exact hE
  | succ k ih => intro s hE; rw [iter_succ]; exact ih (lstep_einv hE)

/-- `linit` satisfies `EInv` vacuously: every `prev` entry is the sentinel
`g.n`, so the hypothesis `prev[v] ≠ g.n` is never met. -/
theorem linit_einv {g : Graph} {src : Nat} : EInv g (linit g.n src) := by
  intro v hv
  exfalso
  apply hv
  show (Array.replicate g.n g.n).getD v g.n = g.n
  rw [Array.getD_eq_getD_getElem?]
  rcases Nat.lt_or_ge v g.n with hlt | hge
  · rw [Array.getElem?_eq_getElem (by simpa using hlt)]; simp
  · rw [Array.getElem?_eq_none (by simpa using hge)]; rfl

/-! ## The consequence the route reconstruction consumes -/

/-- **Edge provenance along the whole search.** At any trajectory point of a
per-source lazy search, a vertex `v` with a non-sentinel `prev` is a real
out-neighbour of that `prev` — so every step of the reconstructed route
(`qReconstruct` walks `(iter …).prev`) is a genuine edge of `g`. This is the
"valid path" half of the matcher's null-over-wrong routing contract. -/
theorem iter_einv_edge {g : Graph} {maxR src : Nat} (k : Nat) {v : Nat}
    (hv : (iter g maxR k (linit g.n src)).prev.getD v g.n ≠ g.n) :
    ∃ w, (v, w) ∈
      (g.adj.getD ((iter g maxR k (linit g.n src)).prev.getD v g.n) #[]).toList :=
  iter_einv k linit_einv v hv

end Verified.Geo
