import Verified.Geo.LazyUpper
import Verified.Geo.LazyPrev
import Verified.Geo.LazyEdge

/-!
# Lazy Dijkstra: weight-optimality, `pathCost(route) = dist[tgt]`

`LazyEdge` proved the reconstructed route is a *real costed walk* of `g`;
`LazyUpper`'s `UInv` bounds a done vertex's distance from *above* by every
outgoing edge. This file supplies the matching lower bound and telescopes the
two into the value half of weight-optimality:

> `WInv`: every relaxed vertex `v` was written by a real edge out of its `prev`,
> at exactly `dist[prev[v]] + w` — and `dist[prev[v]] ≤ maxR`.

`WInv` is the recorded-edge provenance with arithmetic: `relaxStep` writes
`dist[v] := p + w` and `prev[v] := u` together, and `settle_price` makes
`p = dist[u]`, so the equality is literal. Combining `WInv`'s lower bound
(`dist[v] = dist[u] + w ≥ dist[u] + edgeMinW`) with `UInv`'s upper bound
(`dist[v] ≤ dist[u] + edgeMinW`) pins each settled step to the cheapest edge:

> `done_dist_step`: `dist[v] = dist[prev[v]] + edgeMinW(prev[v], v)`.

Telescoped along the `prev`-chain (`chainList`, `PInv` keeps it inside done
vertices, `SInv` gives the `dist[src] = 0` base) this yields the payoff:

> `chainList_pathCost_eq`: the reconstructed route's `pathCost` in the shared
> `Verified.Rail.Graph` spec equals `dist[tgt]`.

This is the exact-cost half of the matcher's null-over-wrong routing contract:
not just "a real path" (`LazyEdge`) but "a path whose cost is the search's
answer". The remaining half — `dist[tgt] = oracleDist` (the search's answer is
*the* shortest) — is the next brick.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges Heap edgeMinW pathCost)
open Verified.Rail.Heap (IsHeap push_mem pop_min pop_top_mem pop_mem pop_isHeap)

/-! ## `SInv`: the source stays at distance 0 -/

/-- The source vertex's distance is always `0`. -/
def SInv (src : Nat) (s : LState) : Prop := s.dist.getD src none = some 0

/-- Reading `prev`/`dist` at a vertex other than the relaxation target is
untouched. (Local copies — `LazyPrev`/`LazyEdge`'s are `private`.) -/
private theorem rs_prev_ne {u p : Nat} {s : LState} {tw : Nat × Nat} {v d : Nat}
    (h : v ≠ tw.1) : (relaxStep u p s tw).prev.getD v d = s.prev.getD v d := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

private theorem rs_dist_ne {u p : Nat} {s : LState} {tw : Nat × Nat} {v : Nat}
    (h : v ≠ tw.1) : (relaxStep u p s tw).dist.getD v none = s.dist.getD v none := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

theorem relaxStep_sinv {u p src : Nat} {s : LState} {tw : Nat × Nat}
    (hS : SInv src s) : SInv src (relaxStep u p s tw) := by
  unfold SInv at hS ⊢
  by_cases hvt : src = tw.1
  · subst hvt
    unfold relaxStep
    simp only [show s.dist.getD tw.1 none = some 0 from hS]
    rw [if_neg (by omega)]
    exact hS
  · rw [rs_dist_ne hvt]; exact hS

theorem relaxL_sinv {u p src : Nat} {edges : Array (Nat × Nat)} {s : LState}
    (hS : SInv src s) : SInv src (relaxL u p edges s) := by
  unfold relaxL
  rw [← Array.foldl_toList]
  induction edges.toList generalizing s with
  | nil => exact hS
  | cons tw l ih => rw [List.foldl_cons]; exact ih (relaxStep_sinv hS)

theorem lstep_sinv {g : Graph} {maxR src : Nat} {s : LState}
    (hS : SInv src s) : SInv src (lstep g maxR s) := by
  unfold lstep
  split
  · exact hS
  · split
    · exact hS
    · next p u h' hpop =>
      split
      · exact hS
      · next hu =>
        split
        · exact hS
        · exact relaxL_sinv
            (show SInv src { s with heap := h', done := s.done.setIfInBounds u true } from hS)

theorem iter_sinv {g : Graph} {maxR src : Nat} :
    ∀ (k : Nat) {s : LState}, SInv src s → SInv src (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro s hS; exact hS
  | succ k ih => intro s hS; rw [iter_succ]; exact ih (lstep_sinv hS)

theorem linit_sinv {g : Graph} {src : Nat} (hsrc : src < g.n) : SInv src (linit g.n src) := by
  show ((Array.replicate g.n none).setIfInBounds src (some 0)).getD src none = some 0
  rw [getD_sib_lt (by rw [Array.size_replicate]; exact hsrc)]

/-! ## `edgeMinW` is achieved by a listed edge, and bounds every listed edge -/

/-- The `edgeMinW` fold step (definitionally the inline lambda in `edgeMinW`). -/
private def emwF (v : Nat) (acc : Option Nat) (tw : Nat × Nat) : Option Nat :=
  if tw.1 = v then (match acc with | none => some tw.2 | some w => some (Nat.min w tw.2)) else acc

/-- The fold value never exceeds the seed or any matching listed weight. -/
private theorem foldl_emwF_le {v : Nat} :
    ∀ (l : List (Nat × Nat)) (init : Option Nat),
      (∀ i, init = some i → ∃ r, l.foldl (emwF v) init = some r ∧ r ≤ i) ∧
      (∀ w, (v, w) ∈ l → ∃ r, l.foldl (emwF v) init = some r ∧ r ≤ w) := by
  intro l
  induction l with
  | nil =>
    intro init
    refine ⟨fun i hi => ⟨i, by rw [List.foldl_nil]; exact hi, Nat.le_refl _⟩, ?_⟩
    intro w hw; exact absurd hw (by simp)
  | cons tw l ih =>
    intro init
    constructor
    · intro i hi
      rw [List.foldl_cons]
      have hstep : ∃ i', emwF v init tw = some i' ∧ i' ≤ i := by
        unfold emwF
        by_cases hc : tw.1 = v
        · rw [if_pos hc, hi]; exact ⟨Nat.min i tw.2, rfl, Nat.min_le_left _ _⟩
        · rw [if_neg hc]; exact ⟨i, hi, Nat.le_refl _⟩
      obtain ⟨i', hi', hi'le⟩ := hstep
      obtain ⟨r, hr, hrle⟩ := (ih (emwF v init tw)).1 i' hi'
      exact ⟨r, hr, Nat.le_trans hrle hi'le⟩
    · intro w hw
      rw [List.foldl_cons]
      rcases List.mem_cons.mp hw with heq | hin
      · -- `(v, w) = tw`: the step produces `some ≤ w`; the tail can only lower it
        subst heq
        have hstep : ∃ i', emwF v init (v, w) = some i' ∧ i' ≤ w := by
          unfold emwF
          rw [if_pos (rfl : (v, w).1 = v)]
          cases init with
          | none => exact ⟨w, rfl, Nat.le_refl _⟩
          | some j => exact ⟨Nat.min j w, rfl, Nat.min_le_right _ _⟩
        obtain ⟨i', hi', hi'le⟩ := hstep
        obtain ⟨r, hr, hrle⟩ := (ih (emwF v init (v, w))).1 i' hi'
        exact ⟨r, hr, Nat.le_trans hrle hi'le⟩
      · exact (ih (emwF v init tw)).2 w hin
/-- When the fold produces a value, it is either the seed or a listed weight. -/
private theorem foldl_emwF_mem {v : Nat} :
    ∀ (l : List (Nat × Nat)) (init : Option Nat) (r : Nat),
      l.foldl (emwF v) init = some r → init = some r ∨ (v, r) ∈ l := by
  intro l
  induction l with
  | nil => intro init r h; left; rw [List.foldl_nil] at h; exact h
  | cons tw l ih =>
    intro init r h
    rw [List.foldl_cons] at h
    rcases ih (emwF v init tw) r h with hinit | hmem
    · -- the value came from the seed after one step
      cases tw with
      | mk a b =>
        unfold emwF at hinit
        by_cases hc : a = v
        · rw [if_pos hc] at hinit
          have hmk : (v, r) = (a, b) → (v, r) ∈ (a, b) :: l := fun he => he ▸ List.mem_cons_self ..
          cases init with
          | none =>
            simp only [Option.some.injEq] at hinit    -- b = r
            right; exact hmk (by rw [← hc, ← hinit])
          | some j =>
            simp only [Option.some.injEq] at hinit    -- Nat.min j b = r
            rcases Nat.le_total j b with hle | hle
            · left
              have hmin : Nat.min j b = j := Nat.min_eq_left hle
              rw [hmin] at hinit; rw [hinit]
            · right
              have hmin : Nat.min j b = b := Nat.min_eq_right hle
              rw [hmin] at hinit
              exact hmk (by rw [← hc, ← hinit])
        · rw [if_neg hc] at hinit; left; exact hinit
    · right; exact List.mem_cons_of_mem _ hmem

/-- `edgeMinW g u v` is at most every listed `u → v` edge weight. -/
theorem edgeMinW_le_of_mem {g : Graph} {u v w : Nat}
    (h : (v, w) ∈ (g.adj.getD u #[]).toList) : ∃ w0, edgeMinW g u v = some w0 ∧ w0 ≤ w := by
  unfold edgeMinW
  rw [← Array.foldl_toList]
  exact (foldl_emwF_le _ none).2 w h

/-- `edgeMinW g u v`, when defined, is realised by a listed `u → v` edge. -/
theorem edgeMinW_mem {g : Graph} {u v w0 : Nat} (h : edgeMinW g u v = some w0) :
    (v, w0) ∈ (g.adj.getD u #[]).toList := by
  unfold edgeMinW at h
  rw [← Array.foldl_toList] at h
  rcases foldl_emwF_mem _ none w0 h with hnone | hmem
  · exact absurd hnone (by simp)
  · exact hmem

/-! ## `WInv`: the recorded-edge lower bound -/

/-- Every relaxed vertex points, via `prev`, at a real edge out of a
within-radius vertex, and its distance is exactly that vertex's distance plus
the recorded edge weight. -/
def WInv (g : Graph) (maxR : Nat) (s : LState) : Prop :=
  ∀ v, s.prev.getD v g.n ≠ g.n →
    ∃ w, (v, w) ∈ (g.adj.getD (s.prev.getD v g.n) #[]).toList ∧
      ∃ du, s.dist.getD (s.prev.getD v g.n) none = some du ∧ du ≤ maxR ∧
        s.dist.getD v none = some (du + w)

/-- At the relaxation target, `relaxStep` either wrote (`prev := u`,
`dist := some (p + tw.2)`, in bounds) or was a no-op. -/
theorem relaxStep_target_write {u p : Nat} {s : LState} {tw : Nat × Nat} {n : Nat}
    (hdb : tw.1 < s.dist.size) (hpb : tw.1 < s.prev.size) :
    ((relaxStep u p s tw).prev.getD tw.1 n = u ∧
     (relaxStep u p s tw).dist.getD tw.1 none = some (p + tw.2)) ∨
    relaxStep u p s tw = s := by
  unfold relaxStep
  split
  · exact Or.inl ⟨getD_sib_lt hpb u n, getD_sib_lt hdb _ _⟩
  · split
    · exact Or.inl ⟨getD_sib_lt hpb u n, getD_sib_lt hdb _ _⟩
    · exact Or.inr rfl

/-- One relaxation preserves `WInv`. The written target records its edge and
`dist[u] + w` (with `dist[u] = p` supplied); every other vertex's `prev`/`dist`
is untouched, and its `prev`-target (done, by `PInv`) is frozen. -/
theorem relaxStep_winv {g : Graph} {u p src maxR : Nat} {s : LState} {tw : Nat × Nat}
    (htw : tw ∈ (g.adj.getD u #[]).toList) (htw1 : tw.1 < g.n)
    (hu : s.done.getD u false = true) (hdup : s.dist.getD u none = some p) (hpmax : p ≤ maxR)
    (hL : LInv g p s) (hP : PInv g src s) (hW : WInv g maxR s) :
    WInv g maxR (relaxStep u p s tw) := by
  have hstep_inv := relaxStep_inv (g := g) (u := u) htw1 hL
  intro v hv
  by_cases hvt : v = tw.1
  · subst hvt
    rcases relaxStep_target_write (u := u) (p := p) (s := s) (tw := tw) (n := g.n)
        (by rw [hL.dsz]; exact htw1) (by rw [hL.psz]; exact htw1) with ⟨hpu, hdvw⟩ | hnop
    · rw [hpu]
      refine ⟨tw.2, htw, p, ?_, hpmax, hdvw⟩
      have hfr := (hstep_inv.2 u hu).2.1
      rw [hfr]; exact hdup
    · rw [hnop]; rw [hnop] at hv; exact hW tw.1 hv
  · rw [rs_prev_ne hvt] at hv ⊢
    obtain ⟨w, hwmem, du, hdu, hdule, hdvw⟩ := hW v hv
    have hvdist_ne : s.dist.getD v none ≠ none := by rw [hdvw]; simp
    have hpdone : s.done.getD (s.prev.getD v g.n) false = true := by
      rcases hP v hvdist_ne with ⟨_, hpn⟩ | hpd
      · exact absurd hpn hv
      · exact hpd
    refine ⟨w, hwmem, du, ?_, hdule, ?_⟩
    · have hfr := (hstep_inv.2 (s.prev.getD v g.n) hpdone).2.1
      rw [hfr]; exact hdu
    · rw [rs_dist_ne hvt]; exact hdvw

/-- The relaxation fold preserves `WInv`; `u` stays done at `dist = p`, and
`LInv`/`PInv` are threaded so each per-step preservation applies. -/
theorem relaxList_winv {g : Graph} {u p src maxR : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState},
      (∀ tw ∈ l, tw ∈ (g.adj.getD u #[]).toList) → (∀ tw ∈ l, tw.1 < g.n) →
      s.done.getD u false = true → s.dist.getD u none = some p → p ≤ maxR →
      LInv g p s → PInv g src s → WInv g maxR s →
      WInv g maxR (l.foldl (relaxStep u p) s) := by
  intro l
  induction l with
  | nil => intro s _ _ _ _ _ _ _ hW; exact hW
  | cons tw l ih =>
    intro s hmem hn hu hdup hpmax hL hP hW
    rw [List.foldl_cons]
    have htw := hmem tw (List.mem_cons_self ..)
    have htw1 := hn tw (List.mem_cons_self ..)
    refine ih (fun t ht => hmem t (List.mem_cons_of_mem _ ht))
      (fun t ht => hn t (List.mem_cons_of_mem _ ht)) ?_ ?_ hpmax ?_ ?_ ?_
    · rw [relaxStep_done]; exact hu
    · have hfr := ((relaxStep_inv (u := u) (p := p) htw1 hL).2 u hu).2.1
      rw [hfr]; exact hdup
    · exact (relaxStep_inv (u := u) (p := p) htw1 hL).1
    · exact relaxStep_pinv htw1 hu hL hP
    · exact relaxStep_winv htw htw1 hu hdup hpmax hL hP hW

theorem relaxL_winv {g : Graph} {u p src maxR : Nat} {s : LState}
    (hn : ∀ tw ∈ (g.adj.getD u #[]).toList, tw.1 < g.n)
    (hu : s.done.getD u false = true) (hdup : s.dist.getD u none = some p) (hpmax : p ≤ maxR)
    (hL : LInv g p s) (hP : PInv g src s) (hW : WInv g maxR s) :
    WInv g maxR (relaxL u p (g.adj.getD u #[]) s) := by
  unfold relaxL
  rw [← Array.foldl_toList]
  exact relaxList_winv _ (fun _ ht => ht) hn hu hdup hpmax hL hP hW

/-- One settle step preserves `WInv`. -/
theorem lstep_winv {g : Graph} {maxR src L : Nat} {s : LState}
    (hwf : WFEdges g) (hds : s.done.size = g.n) (hL : LInv g L s) (hH : HInv g s)
    (hP : PInv g src s) (hW : WInv g maxR s) : WInv g maxR (lstep g maxR s) := by
  unfold lstep
  split
  · exact hW
  · split
    · exact hW
    · next p u h' hpop =>
      split
      · exact hW
      · next hu =>
        have hufalse : s.done.getD u false = false := by simpa using hu
        have hpmem := pop_top_mem hpop
        obtain ⟨du0, hdu0, hdu0le⟩ := hL.wf _ hpmem
        have hpeq : p = du0 := settle_price hL hH hpop hufalse hdu0
        have hdup : s.dist.getD u none = some p := by rw [hpeq]; exact hdu0
        have hLp : L ≤ p := hL.ge _ hpmem
        have hinv' : LInv g p { s with heap := h', done := s.done.setIfInBounds u true } := by
          refine ⟨pop_isHeap hL.hp hpop, hL.dsz, hL.psz,
            fun z hz => hL.wf z (pop_mem hpop z hz),
            fun z hz => pop_min hL.hp hpop z (pop_mem hpop z hz), ?_⟩
          intro v hv
          rcases getD_sib_true hv with rfl | hv'
          · exact ⟨du0, hdu0, hdu0le⟩
          · obtain ⟨d, hd, hdle⟩ := hL.dle v hv'
            exact ⟨d, hd, Nat.le_trans hdle hLp⟩
        have hP' : PInv g src { s with heap := h', done := s.done.setIfInBounds u true } := by
          intro v hv
          rcases hP v hv with ⟨hsrc, hpn⟩ | hpd
          · exact Or.inl ⟨hsrc, hpn⟩
          · exact Or.inr (getD_set_true u _ hpd)
        split
        · exact hW
        · next hover =>
          rcases Nat.lt_or_ge u g.n with hun | hun
          · show WInv g maxR
              (relaxL u p (g.adj.getD u #[]) { s with heap := h', done := s.done.setIfInBounds u true })
            have hudone : (s.done.setIfInBounds u true).getD u false = true :=
              getD_sib_lt (by rw [hds]; exact hun) true false
            exact relaxL_winv (u := u) (p := p) (fun tw ht => hwf u hun tw ht)
              hudone hdup (by omega) hinv' hP' hW
          · show WInv g maxR
              (relaxL u p (g.adj.getD u #[]) { s with heap := h', done := s.done.setIfInBounds u true })
            have hemp : g.adj.getD u #[] = #[] := by
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none]
              · rfl
              · exact hun
            rw [hemp]
            have hnop : relaxL u p #[] { s with heap := h', done := s.done.setIfInBounds u true }
                = { s with heap := h', done := s.done.setIfInBounds u true } := by simp [relaxL]
            rw [hnop]; exact hW

theorem iter_winv {g : Graph} {maxR src : Nat} (hwf : WFEdges g) :
    ∀ (k : Nat) {L : Nat} {s : LState}, s.done.size = g.n → LInv g L s → HInv g s →
      PInv g src s → WInv g maxR s → WInv g maxR (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro L s _ _ _ _ hW; exact hW
  | succ k ih =>
    intro L s hds hL hH hP hW
    rw [iter_succ]
    obtain ⟨L₁, _, hL₁, _⟩ := lstep_inv (maxR := maxR) hwf hL
    exact ih (by rw [lstep_done_size]; exact hds) hL₁ (lstep_hinv hds hL hH)
      (lstep_pinv hwf hds hL hP) (lstep_winv hwf hds hL hH hP hW)

theorem linit_winv {g : Graph} {maxR src : Nat} : WInv g maxR (linit g.n src) := by
  intro v hv
  exfalso
  apply hv
  show (Array.replicate g.n g.n).getD v g.n = g.n
  rw [Array.getD_eq_getD_getElem?]
  rcases Nat.lt_or_ge v g.n with hlt | hge
  · rw [Array.getElem?_eq_getElem (by simpa using hlt)]; simp
  · rw [Array.getElem?_eq_none (by simpa using hge)]; rfl

/-! ## Combining the bounds: a settled step is its cheapest edge -/

/-- A done vertex is in range. -/
theorem done_lt {s : LState} {n v : Nat} (hsz : s.done.size = n)
    (h : s.done.getD v false = true) : v < n := by
  rcases Nat.lt_or_ge v n with hlt | hge
  · exact hlt
  · exfalso
    rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by rw [hsz]; omega)] at h
    simp at h

/-- **A settled step equals its cheapest edge.** Combining `WInv`'s lower bound
(the recorded edge `w ≥ edgeMinW`) with `UInv`'s upper bound at the min-realising
edge pins `dist[v] = dist[prev[v]] + edgeMinW(prev[v], v)`. -/
theorem done_dist_step {g : Graph} {maxR : Nat} {s : LState}
    (hW : WInv g maxR s) (hU : UInv g maxR s) {v : Nat}
    (hv : s.prev.getD v g.n ≠ g.n)
    (hdone_prev : s.done.getD (s.prev.getD v g.n) false = true) :
    ∃ w0 du dv, edgeMinW g (s.prev.getD v g.n) v = some w0 ∧
      s.dist.getD (s.prev.getD v g.n) none = some du ∧
      s.dist.getD v none = some dv ∧ dv = du + w0 := by
  obtain ⟨w, hwmem, du, hdu, hdule, hdvw⟩ := hW v hv
  obtain ⟨w0, hw0, hw0le⟩ := edgeMinW_le_of_mem hwmem
  have hw0mem := edgeMinW_mem hw0
  obtain ⟨dv', hdv', hdv'le⟩ := hU (s.prev.getD v g.n) v w0 du hdone_prev hdu hdule hw0mem
  injection hdvw.symm.trans hdv' with hval    -- du + w = dv'
  have hweq : w = w0 := by omega
  exact ⟨w0, du, du + w, hw0, hdu, hdvw, by rw [hweq]⟩

/-! ## Telescoping the chain to the route cost -/

/-- Appending one edge to a costed path adds that edge's weight to the cost. -/
theorem pathCost_snoc_eq {g : Graph} :
    ∀ (l : List Nat) {y x c ew : Nat}, l.getLast? = some y →
      pathCost g l = some c → edgeMinW g y x = some ew →
      pathCost g (l ++ [x]) = some (c + ew) := by
  intro l
  induction l with
  | nil => intro y x c ew hlast _ _; simp at hlast
  | cons a rest ih =>
    intro y x c ew hlast hpc he
    cases rest with
    | nil =>
      rw [List.getLast?_singleton, Option.some.injEq] at hlast
      subst hlast
      have hc0 : c = 0 := by simp only [pathCost, Option.some.injEq] at hpc; omega
      subst hc0
      show pathCost g [a, x] = some (0 + ew)
      rw [pathCost, he, show pathCost g [x] = some 0 from rfl]
      exact congrArg some (by omega)
    | cons b rest' =>
      have hlast' : (b :: rest').getLast? = some y := by rw [← hlast, List.getLast?_cons_cons]
      cases hwab : edgeMinW g a b with
      | none => rw [pathCost, hwab] at hpc; simp at hpc
      | some wab =>
        cases hcrest : pathCost g (b :: rest') with
        | none => rw [pathCost, hwab, hcrest] at hpc; simp at hpc
        | some crest =>
          have hcval : c = wab + crest := by
            rw [pathCost, hwab, hcrest] at hpc
            have hpc' : some (wab + crest) = some c := hpc
            injection hpc' with e; omega
          have hrec := ih hlast' hcrest he
          rw [List.cons_append, List.cons_append, pathCost, hwab]
          rw [List.cons_append] at hrec
          rw [hrec]
          show some (wab + (crest + ew)) = some (c + ew)
          exact congrArg some (by omega)

/-- **The route cost equals the target distance.** Under the settle bundle, the
reversed `prev`-chain from a done vertex `v` (once it has enough fuel to reach
the sentinel) has `pathCost` exactly `dist[v]`: each step contributes its
cheapest edge (`done_dist_step`), the chain stays inside done vertices (`PInv`),
and the source anchors the base at `dist = 0` (`SInv`). -/
theorem chainList_pathCost_eq {g : Graph} {maxR src L : Nat} {s : LState}
    (hW : WInv g maxR s) (hU : UInv g maxR s) (hP : PInv g src s)
    (hS : SInv src s) (hL : LInv g L s) (hds : s.done.size = g.n) :
    ∀ (fuel v : Nat), s.done.getD v false = true →
      chainList s.prev g.n fuel v = chainList s.prev g.n (fuel + 1) v →
      ∃ dv, s.dist.getD v none = some dv ∧
        pathCost g (chainList s.prev g.n fuel v).reverse = some dv := by
  intro fuel
  induction fuel with
  | zero =>
    intro v hvdone hcomp
    exfalso
    have hvn : v < g.n := done_lt hds hvdone
    rw [show chainList s.prev g.n 1 v = [v] by
        show (if v ≥ g.n then [] else v :: chainList s.prev g.n 0 (s.prev.getD v g.n)) = [v]
        rw [if_neg (by omega)]; rfl,
      show chainList s.prev g.n 0 v = [] from rfl] at hcomp
    exact absurd hcomp (by simp)
  | succ fuel ih =>
    intro v hvdone hcomp
    have hvn : v < g.n := done_lt hds hvdone
    have hcons : chainList s.prev g.n (fuel + 1) v
        = v :: chainList s.prev g.n fuel (s.prev.getD v g.n) := by
      show (if v ≥ g.n then [] else v :: chainList s.prev g.n fuel (s.prev.getD v g.n)) = _
      rw [if_neg (by omega)]
    have hcomp_rest : chainList s.prev g.n fuel (s.prev.getD v g.n)
        = chainList s.prev g.n (fuel + 1) (s.prev.getD v g.n) := by
      have h3 : chainList s.prev g.n (fuel + 2) v
          = v :: chainList s.prev g.n (fuel + 1) (s.prev.getD v g.n) := by
        show (if v ≥ g.n then [] else v :: chainList s.prev g.n (fuel + 1) (s.prev.getD v g.n)) = _
        rw [if_neg (by omega)]
      rw [hcons, h3] at hcomp
      exact ((List.cons.injEq _ _ _ _).mp hcomp).2
    have hvdist_ne : s.dist.getD v none ≠ none := by
      obtain ⟨d, hd, _⟩ := hL.dle v hvdone; rw [hd]; simp
    rw [hcons, List.reverse_cons]
    by_cases hpsent : s.prev.getD v g.n ≥ g.n
    · -- sentinel: `v = src`, distance `0`, tail empty
      have hvsrc : v = src := by
        rcases hP v hvdist_ne with ⟨h1, _⟩ | h2
        · exact h1
        · exact absurd (done_lt hds h2) (by omega)
      have hrest : chainList s.prev g.n fuel (s.prev.getD v g.n) = [] := by
        cases fuel with
        | zero => rfl
        | succ f =>
          show (if s.prev.getD v g.n ≥ g.n then [] else _) = []
          rw [if_pos hpsent]
      refine ⟨0, by rw [hvsrc]; exact hS, ?_⟩
      rw [hrest]
      show pathCost g [v] = some 0
      rfl
    · -- interior: recurse and snoc the closing edge
      have hpsent : s.prev.getD v g.n < g.n := Nat.not_le.mp hpsent
      have hpne : s.prev.getD v g.n ≠ g.n := by omega
      have hdone_prev : s.done.getD (s.prev.getD v g.n) false = true := by
        rcases hP v hvdist_ne with ⟨_, hpn⟩ | hpd
        · exact absurd hpn hpne
        · exact hpd
      obtain ⟨w0, du, dv, hw0, hdu, hdvv, hdveq⟩ := done_dist_step hW hU hpne hdone_prev
      obtain ⟨dpv, hdpv, hpc_rest⟩ := ih (s.prev.getD v g.n) hdone_prev hcomp_rest
      have hdpv_eq : dpv = du := Option.some.inj (hdpv.symm.trans hdu)
      have hrest_ne : chainList s.prev g.n fuel (s.prev.getD v g.n) ≠ [] := by
        intro hnil; rw [hnil] at hpc_rest; simp [pathCost] at hpc_rest
      have hlast : ((chainList s.prev g.n fuel (s.prev.getD v g.n)).reverse).getLast?
          = some (s.prev.getD v g.n) :=
        List.getLast?_reverse.trans (chainList_head? hrest_ne)
      refine ⟨dv, hdvv, ?_⟩
      rw [pathCost_snoc_eq _ hlast hpc_rest hw0, hdpv_eq]
      rw [hdveq]

/-! ## The payoff at a search state -/

/-- **Weight-optimality, value half.** At any trajectory point of a per-source
lazy search, the reconstructed route (`chainList` over `prev`, reversed) from a
done target `tgt` whose chain has completed has `pathCost` exactly `dist[tgt]` —
the search's own answer for that vertex, expressed in the shared
`Verified.Rail.Graph` spec. -/
theorem iter_route_pathCost_eq {g : Graph} {maxR src : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (k : Nat) {tgt dt : Nat}
    (htgt : (iter g maxR k (linit g.n src)).done.getD tgt false = true)
    (hcomp : chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt
           = chainList (iter g maxR k (linit g.n src)).prev g.n (g.n + 1) tgt)
    (hdt : (iter g maxR k (linit g.n src)).dist.getD tgt none = some dt) :
    pathCost g (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse = some dt := by
  have hds0 : (linit g.n src).done.size = g.n := linit_done_size g.n src
  have hL0 : LInv g 0 (linit g.n src) := linit_inv hsrc
  have hH0 : HInv g (linit g.n src) := linit_hinv hsrc
  have hP0 : PInv g src (linit g.n src) := linit_pinv
  have hdsk : (iter g maxR k (linit g.n src)).done.size = g.n :=
    (iter_done_size k _).trans hds0
  obtain ⟨L, _, hLk⟩ := (iter_inv (maxR := maxR) hwf k hL0).1
  have hWk := iter_winv (src := src) (maxR := maxR) hwf k hds0 hL0 hH0 hP0 linit_winv
  have hUk := iter_uinv (maxR := maxR) hwf k hds0 hL0 hH0 linit_uinv
  have hPk := iter_pinv (maxR := maxR) hwf k hds0 hL0 hP0
  have hSk := iter_sinv (g := g) (maxR := maxR) (src := src) k (linit_sinv hsrc)
  obtain ⟨dv, hdv, hpc⟩ :=
    chainList_pathCost_eq hWk hUk hPk hSk hLk hdsk g.n tgt htgt hcomp
  rw [show dv = dt from Option.some.inj (hdv.symm.trans hdt)] at hpc
  exact hpc

end Verified.Geo
