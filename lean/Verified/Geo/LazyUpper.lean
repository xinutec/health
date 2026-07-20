import Verified.Geo.LazyLive

/-!
# Lazy Dijkstra: the edge upper-bound invariant (weight-optimality, half 1 of 2)

The route reconstruction turns the `prev`-chain into a real costed walk
(`LazyEdge`), and `settle_price` (`LazyLive`) pins each vertex's settle price to
its `dist`. What is still missing for weight-optimality is the *value* half —
that a settled vertex's `dist` is the length of the reconstructed route. That
splits into two bounds, and this file supplies the **upper** one:

> `UInv`: for every edge `(v, w)` out of a **done** vertex `u` whose distance is
> within the radius (`dist[u] ≤ maxR`), `dist[v] ≤ dist[u] + w`.

It is the "relaxation reached everyone it could" fact: once `u` is settled *by
relaxation* its whole adjacency has been relaxed, so every out-neighbour's
`dist` was pushed at or below `dist[u] + w`, and `dist` only ever decreases
afterwards. The `dist[u] ≤ maxR` gate is what excludes the single
radius-exhausted vertex (settled at price `> maxR` with its edges deliberately
*not* relaxed — the TS cutoff); that vertex is never any vertex's `prev`, so the
gate costs the route reconstruction nothing. `iter_uinv` carries it from
`linit`; the companion lower bound (`LazyWeight`'s `WInv`, the recorded-edge
provenance) closes the gap to the exact equality
`dist[v] = dist[u] + edgeMinW(u, v)`.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges Heap)
open Verified.Rail.Heap (IsHeap push_mem pop_min pop_top_mem pop_mem pop_isHeap)

/-! ## `dist` monotonicity: a relaxation never raises a distance -/

/-- Reading `dist` at a vertex other than the relaxation target is untouched.
(Reproved locally — `LazyPrev`'s copy is `private`.) -/
private theorem relaxStep_dist_ne' {u p : Nat} {s : LState} {tw : Nat × Nat}
    {v : Nat} (h : v ≠ tw.1) :
    (relaxStep u p s tw).dist.getD v none = s.dist.getD v none := by
  unfold relaxStep
  split
  · exact getD_sib_ne (fun e => h e.symm) _ _
  · split
    · exact getD_sib_ne (fun e => h e.symm) _ _
    · rfl

/-- `getD` at an out-of-range `setIfInBounds` reads the old value.
(Reproved locally — `LazyEdge`'s copy is `private`.) -/
private theorem getD_sib_ge' {α : Type} {a : Array α} {i : Nat} (h : ¬ i < a.size)
    (x d : α) : (a.setIfInBounds i x).getD i d = a.getD i d := by
  have hsz : (a.setIfInBounds i x).size = a.size := Array.size_setIfInBounds
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by rw [hsz]; omega),
    Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by omega)]

/-- `setIfInBounds` never changes an array's size. -/
private theorem relaxStep_dist_size (u p : Nat) (s : LState) (tw : Nat × Nat) :
    (relaxStep u p s tw).dist.size = s.dist.size := by
  unfold relaxStep
  split
  · simp
  · split <;> simp

/-- `relaxStep` never raises a distance: a defined `dist[v]` stays defined and
does not increase. -/
theorem relaxStep_mono_at {u p : Nat} {s : LState} {tw : Nat × Nat} {v d : Nat}
    (h : s.dist.getD v none = some d) :
    ∃ d', (relaxStep u p s tw).dist.getD v none = some d' ∧ d' ≤ d := by
  by_cases hvt : v = tw.1
  · subst hvt
    unfold relaxStep
    split
    · next hnone => rw [hnone] at h; simp at h
    · next dv hsome =>
      split
      · next hlt =>
        by_cases hb : tw.1 < s.dist.size
        · refine ⟨p + tw.2, getD_sib_lt hb _ _, ?_⟩
          rw [h] at hsome; injection hsome with e; omega
        · exact ⟨d, by rw [getD_sib_ge' hb]; exact h, Nat.le_refl _⟩
      · next => exact ⟨d, h, Nat.le_refl _⟩
  · exact ⟨d, by rw [relaxStep_dist_ne' hvt]; exact h, Nat.le_refl _⟩

/-- The relaxation fold never raises a distance. -/
theorem relaxList_mono_at {u p : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState} {v d : Nat},
      s.dist.getD v none = some d →
      ∃ d', (l.foldl (relaxStep u p) s).dist.getD v none = some d' ∧ d' ≤ d
  | [], _, _, d, h => ⟨d, h, Nat.le_refl _⟩
  | tw :: l, s, v, d, h => by
    rw [List.foldl_cons]
    obtain ⟨d1, h1, hle1⟩ := relaxStep_mono_at (u := u) (p := p) (tw := tw) h
    obtain ⟨d2, h2, hle2⟩ := relaxList_mono_at l h1
    exact ⟨d2, h2, Nat.le_trans hle2 hle1⟩

/-! ## The per-edge relaxation bound -/

/-- Relaxing the edge `(v, w)` out of `u` at price `p` bounds `dist[v]` by
`p + w` (and defines it), provided `v` is in range. -/
theorem relaxStep_target_ub {u p : Nat} {s : LState} {v w : Nat}
    (hb : v < s.dist.size) :
    ∃ d0, (relaxStep u p s (v, w)).dist.getD v none = some d0 ∧ d0 ≤ p + w := by
  cases hd : s.dist.getD v none with
  | none =>
    refine ⟨p + w, ?_, Nat.le_refl _⟩
    unfold relaxStep
    simp only [show s.dist.getD (v, w).1 none = none from hd]
    exact getD_sib_lt hb _ _
  | some dv =>
    by_cases himp : p + w < dv
    · refine ⟨p + w, ?_, Nat.le_refl _⟩
      unfold relaxStep
      simp only [show s.dist.getD (v, w).1 none = some dv from hd]
      rw [if_pos (show p + (v, w).2 < dv from himp)]
      exact getD_sib_lt hb _ _
    · refine ⟨dv, ?_, by omega⟩
      unfold relaxStep
      simp only [show s.dist.getD (v, w).1 none = some dv from hd]
      rw [if_neg (show ¬ p + (v, w).2 < dv from himp)]
      exact hd

/-- After the whole relaxation over an edge list, every listed out-neighbour
`(v, w)` has `dist[v] ≤ p + w`. -/
theorem relaxList_edge_ub {u p : Nat} :
    ∀ (l : List (Nat × Nat)) {s : LState} {v w : Nat}, (v, w) ∈ l →
      v < s.dist.size →
      ∃ d', (l.foldl (relaxStep u p) s).dist.getD v none = some d' ∧ d' ≤ p + w := by
  intro l
  induction l with
  | nil => intro s v w hmem _; exact absurd hmem (by simp)
  | cons tw l ih =>
    intro s v w hmem hb
    rw [List.foldl_cons]
    rcases List.mem_cons.mp hmem with heq | hin
    · subst heq
      obtain ⟨d0, hd0, hle0⟩ := relaxStep_target_ub (u := u) (p := p) (s := s) hb
      obtain ⟨d', hd', hle'⟩ := relaxList_mono_at (u := u) (p := p) l hd0
      exact ⟨d', hd', Nat.le_trans hle' hle0⟩
    · exact ih hin (by rw [relaxStep_dist_size]; exact hb)

/-- The relaxation pass over an edge list bounds every listed neighbour. -/
theorem relaxL_edge_ub {u p : Nat} {edges : Array (Nat × Nat)} {s : LState}
    {v w : Nat} (hmem : (v, w) ∈ edges.toList) (hb : v < s.dist.size) :
    ∃ d', (relaxL u p edges s).dist.getD v none = some d' ∧ d' ≤ p + w := by
  unfold relaxL
  rw [← Array.foldl_toList]
  exact relaxList_edge_ub _ hmem hb

/-! ## The invariant -/

/-- For every edge out of a done vertex within the radius, the head's distance
is bounded by the tail's distance plus the edge weight. -/
def UInv (g : Graph) (maxR : Nat) (s : LState) : Prop :=
  ∀ u v w du, s.done.getD u false = true → s.dist.getD u none = some du → du ≤ maxR →
    (v, w) ∈ (g.adj.getD u #[]).toList →
    ∃ dv, s.dist.getD v none = some dv ∧ dv ≤ du + w

/-! ## Preservation along the trajectory -/

/-- One settle step preserves `UInv`. The newly-settled vertex's edge bounds
come from the relaxation pass (`relaxL_edge_ub`, with `dist[u] = p` by
`settle_price`); the already-done vertices' bounds survive because `dist` only
decreases and their own `dist` is frozen; and a radius-exhausted settle is ruled
out of the invariant by the `dist[u] ≤ maxR` gate. -/
theorem lstep_uinv {g : Graph} {maxR L : Nat} {s : LState}
    (hwf : WFEdges g) (hL : LInv g L s) (hH : HInv g s)
    (hU : UInv g maxR s) : UInv g maxR (lstep g maxR s) := by
  unfold lstep
  split
  · exact hU
  · split
    · exact hU
    · next p u h' hpop =>
      split
      · -- stale entry: only the heap shrinks
        next =>
          intro u' v w du hdone' hdu' hdule hmem
          exact hU u' v w du hdone' hdu' hdule hmem
      · next hu =>
        have hufalse : s.done.getD u false = false := by simpa using hu
        have hpmem := pop_top_mem hpop
        obtain ⟨du0, hdu0, hdu0le⟩ := hL.wf _ hpmem
        have hpeq : p = du0 := settle_price hL hH hpop hufalse hdu0
        have hdup : s.dist.getD u none = some p := by rw [hpeq]; exact hdu0
        have hLp : L ≤ p := hL.ge _ hpmem
        have hinv' : LInv g p
            { s with heap := h', done := s.done.setIfInBounds u true } := by
          refine ⟨pop_isHeap hL.hp hpop, hL.dsz, hL.psz,
            fun z hz => hL.wf z (pop_mem hpop z hz),
            fun z hz => pop_min hL.hp hpop z (pop_mem hpop z hz), ?_⟩
          intro v hv
          rcases getD_sib_true hv with rfl | hv'
          · exact ⟨du0, hdu0, hdu0le⟩
          · obtain ⟨d, hd, hdle⟩ := hL.dle v hv'
            exact ⟨d, hd, Nat.le_trans hdle hLp⟩
        split
        · -- radius-exhausted: `done[u]` set, no relaxation; the gate excludes `u`
          next hover =>
            show UInv g maxR
              { s with heap := h', done := s.done.setIfInBounds u true, exhausted := true }
            intro u' v w du hdone' hdu' hdule hmem
            by_cases hu'u : u' = u
            · subst hu'u
              -- `dist[u'] = some p` and `du ≤ maxR < p` is impossible
              have hval : s.dist.getD u' none = some du := hdu'
              rw [hdup] at hval
              injection hval with he
              omega
            · refine hU u' v w du ?_ hdu' hdule hmem
              rwa [getD_sib_ne (fun e => hu'u e.symm)] at hdone'
        · next hover =>
          rcases Nat.lt_or_ge u g.n with hun | hun
          · -- relaxation pass over `u`'s (nonempty-capable) adjacency
            show UInv g maxR
              (relaxL u p (g.adj.getD u #[]) { s with heap := h', done := s.done.setIfInBounds u true })
            have hrel := relaxL_inv (u := u) (p := p)
              (hedge := fun tw ht => hwf u hun tw ht) hinv'
            intro u' v w du hdone' hdu' hdule hmem
            have hdreq : (relaxL u p (g.adj.getD u #[])
                { s with heap := h', done := s.done.setIfInBounds u true }).done
                = s.done.setIfInBounds u true := relaxL_done _ _ _ _
            have hdone_s' : (s.done.setIfInBounds u true).getD u' false = true := by
              rw [← hdreq]; exact hdone'
            rcases getD_sib_true hdone_s' with heq | hdone_su'
            · -- establish: `u' = u`, its edges just got relaxed
              have hfrz := (hrel.2 u' hdone_s').2.1
              -- `dist'[u'] = s.dist[u'] = some p`, so `du = p`
              have hdu'p : s.dist.getD u' none = some du := by rw [← hfrz]; exact hdu'
              rw [heq, hdup] at hdu'p; injection hdu'p with hdp
              rw [heq] at hmem
              have hvn : v < g.n := hwf u hun (v, w) hmem
              obtain ⟨dv, hdv, hdvle⟩ := relaxL_edge_ub (u := u) (p := p)
                (edges := g.adj.getD u #[])
                (s := { s with heap := h', done := s.done.setIfInBounds u true })
                hmem (by show v < s.dist.size; rw [hL.dsz]; exact hvn)
              exact ⟨dv, hdv, by rw [← hdp]; exact hdvle⟩
            · -- transfer: `u'` was already done; its `dist` is frozen, `v`'s only fell
              have hfrzu := (hrel.2 u' (getD_set_true u u' hdone_su')).2.1
              have hdu_s : s.dist.getD u' none = some du := by rw [← hfrzu]; exact hdu'
              obtain ⟨dv, hdv, hdvle⟩ := hU u' v w du hdone_su' hdu_s hdule hmem
              obtain ⟨dv', hdv', hdv'le⟩ := relaxList_mono_at (u := u) (p := p)
                (g.adj.getD u #[]).toList
                (s := { s with heap := h', done := s.done.setIfInBounds u true }) hdv
              refine ⟨dv', ?_, Nat.le_trans hdv'le hdvle⟩
              show (relaxL u p (g.adj.getD u #[]) _).dist.getD v none = some dv'
              rw [relaxL, ← Array.foldl_toList]; exact hdv'
          · -- `u` out of range: its adjacency is empty, no relaxation happens
            show UInv g maxR
              (relaxL u p (g.adj.getD u #[]) { s with heap := h', done := s.done.setIfInBounds u true })
            have hemp : g.adj.getD u #[] = #[] := by
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none]
              · rfl
              · exact hun
            rw [hemp]
            have hstate : relaxL u p #[] { s with heap := h', done := s.done.setIfInBounds u true }
                = { s with heap := h', done := s.done.setIfInBounds u true } := by
              simp [relaxL]
            rw [hstate]
            intro u' v w du hdone' hdu' hdule hmem
            by_cases hu'u : u' = u
            · subst hu'u
              -- no edges out of an out-of-range vertex
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none hun] at hmem
              exact absurd hmem (by simp)
            · refine hU u' v w du ?_ hdu' hdule hmem
              rwa [getD_sib_ne (fun e => hu'u e.symm)] at hdone'

/-- `UInv` survives any number of settle steps. -/
theorem iter_uinv {g : Graph} {maxR : Nat} (hwf : WFEdges g) :
    ∀ (k : Nat) {L : Nat} {s : LState}, s.done.size = g.n → LInv g L s → HInv g s →
      UInv g maxR s → UInv g maxR (iter g maxR k s) := by
  intro k
  induction k with
  | zero => intro L s _ _ _ hU; exact hU
  | succ k ih =>
    intro L s hds hL hH hU
    rw [iter_succ]
    obtain ⟨L₁, _, hL₁, _⟩ := lstep_inv (maxR := maxR) hwf hL
    exact ih (by rw [lstep_done_size]; exact hds) hL₁ (lstep_hinv hds hL hH)
      (lstep_uinv hwf hL hH hU)

/-- `linit` satisfies `UInv` vacuously: no vertex is done. -/
theorem linit_uinv {g : Graph} {maxR src : Nat} : UInv g maxR (linit g.n src) := by
  intro u v w du hdone _ _ _
  exfalso
  have : (Array.replicate g.n false).getD u false = true := hdone
  rw [Array.getD_eq_getD_getElem?] at this
  rcases Nat.lt_or_ge u g.n with hlt | hge
  · rw [Array.getElem?_eq_getElem (by simpa using hlt)] at this; simp at this
  · rw [Array.getElem?_eq_none (by simpa using hge)] at this; simp at this

end Verified.Geo
