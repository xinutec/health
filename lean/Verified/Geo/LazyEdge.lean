import Verified.Geo.LazyDijkstra
import Verified.Rail.Graph

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

open Verified.Rail (Graph edgeMinW pathCost)

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

/-! ## Lifting edge provenance to a well-formed path cost

`EInv` gives one edge per `prev` link; the route reconstruction turns the
whole `prev`-chain into a vertex list. Here the per-edge fact is lifted to
the reconstructed path as a whole: its `pathCost` (the rail spec's cost, the
same one `dijkstraC_correct` uses) is *defined* — every consecutive step is a
real edge, so the route has a genuine total weight. This is the matcher's
route expressed in, and validated against, the shared `Verified.Rail.Graph`
spec.

`chainList` mirrors `Match.lean`'s `reconGo` without the accumulator (the
`prev`-walk as a plain cons list); `Match.lean` bridges the two. -/

/-- The `prev`-walk from `v`, budget `fuel`, stopping at the `≥ n` sentinel —
`reconGo`'s output as a plain list (no accumulator). -/
def chainList (prev : Array Nat) (n : Nat) : Nat → Nat → List Nat
  | 0, _ => []
  | fuel + 1, v => if v ≥ n then [] else v :: chainList prev n fuel (prev.getD v n)

/-- A nonempty chain starts at its seed (which is then below the sentinel). -/
theorem chainList_head? {prev : Array Nat} {n fuel v : Nat}
    (h : chainList prev n fuel v ≠ []) : (chainList prev n fuel v).head? = some v := by
  cases fuel with
  | zero => exact absurd rfl h
  | succ fuel =>
    unfold chainList at h ⊢
    by_cases hv : v ≥ n
    · rw [if_pos hv] at h; exact absurd rfl h
    · rw [if_neg hv]; rfl

/-- A nonempty chain's seed is below the sentinel. -/
theorem chainList_seed_lt {prev : Array Nat} {n fuel v : Nat}
    (h : chainList prev n fuel v ≠ []) : v < n := by
  cases fuel with
  | zero => exact absurd rfl h
  | succ fuel =>
    unfold chainList at h
    by_cases hv : v ≥ n
    · rw [if_pos hv] at h; exact absurd rfl h
    · omega

/-- Conversely, a seed below the sentinel with a positive budget yields a
nonempty chain (its head is the seed). -/
theorem chainList_ne_nil {prev : Array Nat} {n fuel v : Nat}
    (hv : v < n) (hf : 0 < fuel) : chainList prev n fuel v ≠ [] := by
  obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
  show (if v ≥ n then [] else v :: chainList prev n f (prev.getD v n)) ≠ []
  rw [if_neg (by omega)]
  exact List.cons_ne_nil _ _

/-! ### `edgeMinW` is defined whenever the target is a listed neighbour -/

private def emwStep (v : Nat) : Option Nat → Nat × Nat → Option Nat :=
  fun acc tw => if tw.1 = v then (match acc with | none => some tw.2 | some w => some (Nat.min w tw.2)) else acc

private theorem emwFold_pres {v : Nat} :
    ∀ (l : List (Nat × Nat)) {init : Option Nat}, init.isSome →
      (l.foldl (emwStep v) init).isSome := by
  intro l
  induction l with
  | nil => intro init h; exact h
  | cons tw l ih =>
    intro init h
    rw [List.foldl_cons]
    refine ih ?_
    unfold emwStep
    by_cases hc : tw.1 = v
    · rw [if_pos hc]; cases init <;> simp
    · rw [if_neg hc]; exact h

private theorem emwFold_isSome {v : Nat} :
    ∀ (l : List (Nat × Nat)), (∃ tw ∈ l, tw.1 = v) →
      (l.foldl (emwStep v) none).isSome := by
  intro l
  induction l with
  | nil => intro ⟨tw, htw, _⟩; exact absurd htw (List.not_mem_nil)
  | cons tw l ih =>
    intro ⟨tw', htw', hv'⟩
    rw [List.foldl_cons]
    by_cases hc : tw.1 = v
    · refine emwFold_pres l ?_
      unfold emwStep; rw [if_pos hc]; simp
    · rcases List.mem_cons.mp htw' with rfl | hmem
      · exact absurd hv' hc
      · have : emwStep v none tw = none := by unfold emwStep; rw [if_neg hc]
        rw [this]; exact ih ⟨tw', hmem, hv'⟩

/-- `edgeMinW g u v` is defined when `v` is a listed out-neighbour of `u`. -/
theorem edgeMinW_isSome_of_mem {g : Graph} {u v w : Nat}
    (h : (v, w) ∈ (g.adj.getD u #[]).toList) : (edgeMinW g u v).isSome := by
  unfold edgeMinW
  rw [← Array.foldl_toList]
  exact emwFold_isSome _ ⟨(v, w), h, rfl⟩

/-! ### `pathCost` is defined on an all-edges list, and on a snoc -/

/-- Appending one edge to a costed path keeps the cost defined. -/
theorem pathCost_snoc_isSome {g : Graph} :
    ∀ (l : List Nat) {y x : Nat}, l.getLast? = some y →
      (pathCost g l).isSome → (edgeMinW g y x).isSome →
      (pathCost g (l ++ [x])).isSome := by
  intro l
  induction l with
  | nil => intro y x hlast _ _; simp at hlast
  | cons a rest ih =>
    intro y x hlast hpc he
    cases rest with
    | nil =>
      rw [List.getLast?_singleton, Option.some.injEq] at hlast
      cases hw : edgeMinW g a x with
      | none => rw [← hlast, hw] at he; simp at he
      | some w => simp [pathCost, hw]
    | cons b rest' =>
      have hlast' : (b :: rest').getLast? = some y := by
        rw [← hlast, List.getLast?_cons_cons]
      cases hw : edgeMinW g a b with
      | none => rw [pathCost, hw] at hpc; simp at hpc
      | some w =>
        have hpc' : (pathCost g (b :: rest')).isSome := by
          rw [pathCost, hw] at hpc
          cases hc : pathCost g (b :: rest') with
          | none => rw [hc] at hpc; simp at hpc
          | some c => simp
        have hrec := ih hlast' hpc' he
        rw [List.cons_append, List.cons_append, pathCost, hw]
        rw [List.cons_append] at hrec
        cases hc : pathCost g (b :: (rest' ++ [x])) with
        | none => rw [hc] at hrec; simp at hrec
        | some c => simp

/-- **The reconstructed route has a defined cost.** Under `EInv`, the reversed
`prev`-chain (`reconGo`'s output; `Match.lean` bridges `chainList` to it) is a
path every step of which is a real edge, so its `pathCost` in the shared rail
spec is `some`. This is the per-route lift of `EInv`: the matcher's route is a
genuine costed walk of `g`, not a bag of vertices. -/
theorem chainList_reverse_pathCost_isSome {g : Graph} {s : LState} (hE : EInv g s) :
    ∀ (fuel v : Nat), chainList s.prev g.n fuel v ≠ [] →
      (pathCost g (chainList s.prev g.n fuel v).reverse).isSome := by
  intro fuel
  induction fuel with
  | zero => intro v h; exact absurd rfl h
  | succ fuel ih =>
    intro v h
    have hv : v < g.n := chainList_seed_lt h
    have hcons : chainList s.prev g.n (fuel + 1) v
        = v :: chainList s.prev g.n fuel (s.prev.getD v g.n) := by
      show (if v ≥ g.n then [] else v :: chainList s.prev g.n fuel (s.prev.getD v g.n)) = _
      rw [if_neg (by omega)]
    rw [hcons, List.reverse_cons]
    by_cases hT : chainList s.prev g.n fuel (s.prev.getD v g.n) = []
    · rw [hT]; simp [pathCost]
    · -- the tail chain is nonempty: its head is `s.prev.getD v g.n`, so the
      -- reverse ends there, and `EInv` supplies the closing edge back to `v`.
      have hlast : ((chainList s.prev g.n fuel (s.prev.getD v g.n)).reverse).getLast?
          = some (s.prev.getD v g.n) := by
        rw [List.getLast?_reverse, chainList_head? hT]
      have hpne : s.prev.getD v g.n ≠ g.n := by
        have := chainList_seed_lt hT; omega
      obtain ⟨w, hw⟩ := hE v hpne
      have he : (edgeMinW g (s.prev.getD v g.n) v).isSome := edgeMinW_isSome_of_mem hw
      exact pathCost_snoc_isSome _ hlast (ih (s.prev.getD v g.n) hT) he

end Verified.Geo
