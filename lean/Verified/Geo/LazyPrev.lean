import Verified.Geo.LazyInv
import Verified.Geo.LazyFuel

/-!
# Lazy Dijkstra: the prev-chain closure invariant

`LazyInv` is a deliberately slim cut of the settle bundle — it proves
"settled = final" without the ghost prev-tree the rail `LoopInv` carries.
The route reconstruction (`qReconstruct` in `Match.lean`) needs the one fact
that cut omits: **a settled vertex's `prev` chain is itself settled**, so
walking `prev` back from a done target stays inside done vertices until it
hits the `g.n` sentinel — which is what makes the reconstructed path (and
hence the route result) resume-stable, not just the target distance.

The invariant that delivers it, kept minimal:

> `PInv`: every vertex that has been *relaxed* (`dist ≠ none`) is either the
> source at the sentinel `prev`, or has `prev` pointing to a **done** vertex.

It holds because `prev[w]` is only ever written during `relaxL u …`, and
`lstep` sets `done[u]` *before* relaxing `u`'s edges — so every `prev` write
targets an already-done vertex, and `done` only grows. `iter_pinv` carries it
along the whole trajectory from `linit`; `PInv.done_prev` reads off the
consequence the reconstruction consumes.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges Heap)
open Verified.Rail.Heap (IsHeap push_isHeap push_mem pop_min pop_top_mem
  pop_isHeap pop_mem)

/-- Every relaxed vertex points, via `prev`, at a done vertex — or is the
source resting at the `g.n` sentinel. -/
def PInv (g : Graph) (src : Nat) (s : LState) : Prop :=
  ∀ v, s.dist.getD v none ≠ none →
    (v = src ∧ s.prev.getD v g.n = g.n) ∨
    s.done.getD (s.prev.getD v g.n) false = true

/-- The consequence the reconstruction consumes: a *done* vertex's `prev` is
either the sentinel or itself done. -/
theorem PInv.done_prev {g : Graph} {src L : Nat} {s : LState} (h : PInv g src s)
    {v : Nat} (hv : s.done.getD v false = true) (hL : LInv g L s) :
    s.prev.getD v g.n = g.n ∨ s.done.getD (s.prev.getD v g.n) false = true := by
  obtain ⟨d, hd, _⟩ := hL.dle v hv
  rcases h v (by rw [hd]; simp) with ⟨_, hp⟩ | hp
  · exact Or.inl hp
  · exact Or.inr hp

/-- Reads at a vertex other than the write target are untouched. -/
private theorem relaxStep_dist_ne {u p : Nat} {s : LState} {tw : Nat × Nat}
    {v : Nat} (h : v ≠ tw.1) :
    (relaxStep u p s tw).dist.getD v none = s.dist.getD v none := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

private theorem relaxStep_prev_ne {u p : Nat} {s : LState} {tw : Nat × Nat}
    {v d : Nat} (h : v ≠ tw.1) :
    (relaxStep u p s tw).prev.getD v d = s.prev.getD v d := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

/-- At the write target, a relaxation either wrote (`prev := u`, `dist` set)
or was a no-op (state unchanged). -/
private theorem relaxStep_target {u p : Nat} {s : LState} {tw : Nat × Nat}
    {d : Nat} (hd : tw.1 < s.dist.size) (hp : tw.1 < s.prev.size) :
    ((relaxStep u p s tw).prev.getD tw.1 d = u ∧
      (relaxStep u p s tw).dist.getD tw.1 none ≠ none) ∨
    relaxStep u p s tw = s := by
  unfold relaxStep
  split
  · exact Or.inl ⟨getD_sib_lt hp u d, by rw [getD_sib_lt hd]; simp⟩
  · split
    · exact Or.inl ⟨getD_sib_lt hp u d, by rw [getD_sib_lt hd]; simp⟩
    · exact Or.inr rfl

/-- One relaxation preserves `PInv`, given the relaxer `u` is done. -/
theorem relaxStep_pinv {g : Graph} {u p src L : Nat} {s : LState} {tw : Nat × Nat}
    (htw : tw.1 < g.n) (hu : s.done.getD u false = true)
    (hL : LInv g L s) (hP : PInv g src s) :
    PInv g src (relaxStep u p s tw) := by
  have hdone := relaxStep_done u p s tw
  intro v hv
  by_cases hvt : v = tw.1
  · subst hvt
    rcases relaxStep_target (d := g.n) (by rw [hL.dsz]; exact htw)
        (by rw [hL.psz]; exact htw) with ⟨hpu, _⟩ | hnop
    · exact Or.inr (by rw [hpu, hdone]; exact hu)
    · rw [hnop] at hv ⊢; exact hP tw.1 hv
  · rw [relaxStep_dist_ne hvt] at hv
    rcases hP v hv with ⟨hsrc, hpn⟩ | hpd
    · exact Or.inl ⟨hsrc, by rw [relaxStep_prev_ne hvt]; exact hpn⟩
    · exact Or.inr (by rw [hdone, relaxStep_prev_ne hvt]; exact hpd)

/-- The fold over an edge list preserves `PInv`; `u` stays done throughout,
and `LInv` is threaded so the per-step size facts stay available. -/
theorem relaxList_pinv {g : Graph} {u p src : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState}, (∀ tw ∈ l, tw.1 < g.n) →
      s.done.getD u false = true → LInv g p s → PInv g src s →
      PInv g src (l.foldl (relaxStep u p) s) := by
  intro l
  induction l with
  | nil => intro s _ _ _ hP; exact hP
  | cons tw l ih =>
    intro s hedge hu hL hP
    rw [List.foldl_cons]
    have htw := hedge tw (List.mem_cons_self ..)
    exact ih (fun t ht => hedge t (List.mem_cons_of_mem _ ht))
      (by rw [relaxStep_done]; exact hu)
      (relaxStep_inv (g := g) (u := u) htw hL).1
      (relaxStep_pinv htw hu hL hP)

/-- The whole relaxation pass preserves `PInv`. -/
theorem relaxL_pinv {g : Graph} {u p src : Nat} {edges : Array (Nat × Nat)}
    {s : LState} (hedge : ∀ tw ∈ edges.toList, tw.1 < g.n)
    (hu : s.done.getD u false = true) (hL : LInv g p s) (hP : PInv g src s) :
    PInv g src (relaxL u p edges s) := by
  unfold relaxL
  rw [← Array.foldl_toList]
  exact relaxList_pinv _ hedge hu hL hP

/-- Marking the popped vertex done preserves `PInv` (its own obligation is
inherited from before; `done` only grows and `prev`/`dist` are untouched). -/
private theorem setDone_pinv {g : Graph} {src u : Nat} {s : LState}
    (hP : PInv g src s) :
    PInv g src { s with done := s.done.setIfInBounds u true } := by
  intro v hv
  rcases hP v hv with ⟨hsrc, hpn⟩ | hpd
  · exact Or.inl ⟨hsrc, hpn⟩
  · exact Or.inr (getD_set_true _ _ hpd)

/-- One settle step preserves `PInv`. -/
theorem lstep_pinv {g : Graph} {maxR src L : Nat} {s : LState}
    (hwf : WFEdges g) (hds : s.done.size = g.n) (hL : LInv g L s) (hP : PInv g src s) :
    PInv g src (lstep g maxR s) := by
  unfold lstep
  split
  · exact hP
  · split
    · exact hP
    · next p u h' hpop =>
      split
      · exact hP
      · next hu =>
        have hpmem := pop_top_mem hpop
        have hLp : L ≤ p := hL.ge _ hpmem
        obtain ⟨du, hdu, hdup⟩ := hL.wf _ hpmem
        have hLs' : LInv g p { s with heap := h', done := s.done.setIfInBounds u true } := by
          refine ⟨pop_isHeap hL.hp hpop, hL.dsz, hL.psz,
            fun z hz => hL.wf z (pop_mem hpop z hz),
            fun z hz => pop_min hL.hp hpop z (pop_mem hpop z hz), ?_⟩
          intro v hv
          rcases getD_sib_true hv with rfl | hv'
          · exact ⟨du, hdu, hdup⟩
          · obtain ⟨d, hd, hdle⟩ := hL.dle v hv'
            exact ⟨d, hd, Nat.le_trans hdle hLp⟩
        have hPs' : PInv g src { s with heap := h', done := s.done.setIfInBounds u true } :=
          setDone_pinv hP
        split
        · exact hPs'
        · rcases Nat.lt_or_ge u g.n with hun | hun
          · have hudone : (s.done.setIfInBounds u true).getD u false = true :=
              getD_sib_lt (by rw [hds]; exact hun) true false
            exact relaxL_pinv (u := u) (p := p) (fun tw ht => hwf u hun tw ht)
              hudone hLs' hPs'
          · have hemp : g.adj.getD u #[] = #[] := by
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none]
              · rfl
              · exact hun
            rw [hemp]
            simpa [relaxL] using hPs'

/-- `PInv` survives any number of settle steps. -/
theorem iter_pinv {g : Graph} {maxR src : Nat} (hwf : WFEdges g) :
    ∀ (k : Nat) {L : Nat} {s : LState}, s.done.size = g.n → LInv g L s → PInv g src s →
      PInv g src (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro L s _ _ hP; exact hP
  | succ k ih =>
    intro L s hds hL hP
    rw [iter_succ]
    obtain ⟨L₁, _, hL₁, _⟩ := lstep_inv (maxR := maxR) hwf hL
    exact ih (by rw [lstep_done_size]; exact hds) hL₁ (lstep_pinv hwf hds hL hP)

/-- `linit` satisfies `PInv`: only the source is relaxed, and its `prev` is
the sentinel. -/
theorem linit_pinv {g : Graph} {src : Nat} : PInv g src (linit g.n src) := by
  intro v hv
  left
  by_cases hvsrc : v = src
  · refine ⟨hvsrc, ?_⟩
    show (Array.replicate g.n g.n).getD v g.n = g.n
    rw [Array.getD_eq_getD_getElem?]
    rcases Nat.lt_or_ge v g.n with hlt | hge
    · rw [Array.getElem?_eq_getElem (by simpa using hlt)]; simp
    · rw [Array.getElem?_eq_none (by simpa using hge)]; rfl
  · exfalso
    apply hv
    show ((Array.replicate g.n none).setIfInBounds src (some 0)).getD v none = none
    rw [getD_sib_ne (fun e => hvsrc e.symm), Array.getD_eq_getD_getElem?]
    rcases Nat.lt_or_ge v g.n with hlt | hge
    · rw [Array.getElem?_eq_getElem (by simpa using hlt)]; simp
    · rw [Array.getElem?_eq_none (by simpa using hge)]; rfl

end Verified.Geo
