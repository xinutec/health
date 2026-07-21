import Verified.Geo.LazyWeight
import Verified.Rail.Certify

/-!
# Lazy Dijkstra: the optimality lower bound (`dist[tgt] ≤ every path`)

The weight-optimality *value* half (`LazyWeight.iter_route_pathCost_eq`) proves
the reconstructed route costs exactly `dist[tgt]`. This file supplies the other
half of "the search's answer is *the* shortest": every valid `src → tgt` path
costs at least `dist[tgt]`. Together they say the route is a minimum-cost path.

The classical argument is the feasible-cut walk (rail `Certify.cut_bound`): walk
a candidate path from `src`, chaining the no-shortcut inequality (a settled
vertex's edges were relaxed, so `dist[v] ≤ dist[u] + w`) while the path stays in
the settled set, and stop at the first vertex that left it — which by the floor
already costs `≥ D`. The rail proof reuses `feasibleCut` over the shared bare
`done`/`dist` arrays, but the lazy machine breaks that predicate: a
radius-*exhausted* vertex is settled with its edges deliberately **not** relaxed
(`dist > maxR`, the TS cutoff), so `feasibleCut` over the whole graph is false.

`cut_walk` handles the radius honestly. It threads the bound `du ≤ prefix-cost`
and branches on `du ≤ maxR`: within the radius `UInv` supplies the no-shortcut
step; a settled vertex found *beyond* the radius short-circuits, because
`D ≤ maxR < du ≤ du + C` closes the goal outright. The honest precondition is
therefore `D ≤ maxR` — the lower bound is claimed only inside the searched
radius, never beyond it.

The "nothing cheaper is still unsettled" fact (`nocheap_of_inv`) is not an extra
assumption: it falls straight out of the existing invariants — an unsettled
finite vertex holds a live heap entry (`HInv`) priced `≥ L` (`LInv.ge`), and the
settled target is priced `≤ L` (`LInv.dle`), so `D ≤ L ≤ dv`.

What remains for a *fully* unconditional statement — and is the next brick — is
discharging `done[src]` (the search settled the source) and bridging the bound
to `Rail.oracleDist` via the enumeration lemmas. Those are taken as explicit
hypotheses here.
-/

namespace Verified.Geo

open Verified.Rail (Graph Heap WFEdges edgeMinW pathCost pathCost_cons_cons
  oracleDist simplePathCosts nodupB enum_sound enum_complete oracleDist_eq
  nodupB_head_notin_tail)

/-! ## Discharging `done[src]` — the source is always settled

`iter_route_optimal` below assumed `done[src]` ("the search settled the
source"). It is not an assumption: `linit`'s heap is seeded `#[(0, src)]`, so
the very first `lstep` pops `(0, src)` at price `0 ≤ maxR` (never radius-
exhausted, since `maxR : Nat`) and settles it; `done` only ever grows
(`lstep_done_mono`), so `src` stays settled for every `k ≥ 1`. And any `k` that
settled `tgt` is `≥ 1`. -/

/-- `linit`'s `done` array is all-false. -/
private theorem linit_done_getD (n src v : Nat) :
    (linit n src).done.getD v false = false := by
  show (Array.replicate n false).getD v false = false
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_replicate]
  split <;> rfl

/-- The first `lstep` from `linit` pops the seeded `(0, src)` and settles it. -/
private theorem first_lstep_done_src {g : Graph} {maxR src : Nat}
    (hsrc : src < g.n) :
    (lstep g maxR (linit g.n src)).done.getD src false = true := by
  have hpop : (linit g.n src).heap.pop = some ((0, src), (⟨#[]⟩ : Heap)) := by
    have ha : Heap.push (⟨#[]⟩ : Heap) 0 src = (⟨#[(0, src)]⟩ : Heap) := by
      have h1 : (Heap.push (⟨#[]⟩ : Heap) 0 src).a = #[(0, src)] := by
        show Heap.siftUp (Array.push #[] ((0 : Nat), src))
            ((Array.push #[] ((0 : Nat), src)).size - 1) = #[(0, src)]
        unfold Heap.siftUp
        rw [dif_pos (show (Array.push #[] ((0 : Nat), src)).size - 1 = 0 from rfl)]
        rfl
      show Heap.push (⟨#[]⟩ : Heap) 0 src = ⟨#[(0, src)]⟩
      rw [← h1]
    show (Heap.push (⟨#[]⟩ : Heap) 0 src).pop = some ((0, src), ⟨#[]⟩)
    rw [ha]
    rfl
  unfold lstep
  split
  · next hc => exact absurd hc Bool.false_ne_true
  · rw [hpop]
    dsimp only
    rw [if_neg (show ¬ (linit g.n src).done.getD src false = true by
      rw [linit_done_getD]; decide)]
    rw [if_neg (show ¬ (0 > maxR) from Nat.not_lt.mpr (Nat.zero_le maxR))]
    rw [relaxL_done]
    exact getD_sib_lt (show src < (linit g.n src).done.size by
      show src < (Array.replicate g.n false).size
      rw [Array.size_replicate]; exact hsrc) true false

/-- `done` is monotone along `iter`: a settled vertex stays settled. -/
theorem iter_done_mono {g : Graph} {maxR : Nat} {s : LState} {v : Nat}
    (k : Nat) (h : s.done.getD v false = true) :
    (iter g maxR k s).done.getD v false = true := by
  induction k generalizing s with
  | zero => exact h
  | succ k ih => rw [iter_succ]; exact ih (lstep_done_mono h)

/-- After any `k + 1` steps from `linit`, the source is settled. -/
theorem iter_src_done {g : Graph} {maxR src : Nat} (hsrc : src < g.n) (k : Nat) :
    (iter g maxR (k + 1) (linit g.n src)).done.getD src false = true := by
  rw [iter_succ]
  exact iter_done_mono k (first_lstep_done_src hsrc)

/-- If some vertex `tgt` is settled at `iter k (linit …)`, then so is `src`
(that `k` ran at least one step). -/
theorem iter_src_done_of_tgt {g : Graph} {maxR src : Nat} (hsrc : src < g.n)
    {k tgt : Nat}
    (htgt : (iter g maxR k (linit g.n src)).done.getD tgt false = true) :
    (iter g maxR k (linit g.n src)).done.getD src false = true := by
  cases k with
  | zero =>
      rw [show iter g maxR 0 (linit g.n src) = linit g.n src from rfl,
        linit_done_getD] at htgt
      exact absurd htgt (by decide)
  | succ k' => exact iter_src_done hsrc k'

/-! ## The radius-aware cut walk -/

/-- **Radius-aware Dijkstra lower bound.** Walking any path from a settled
in-range vertex `u` (priced `du`) to `tgt` (priced `D`), the settled distance
`D` is bounded by `du` plus the path cost.

While the path stays inside the settled set *and* the radius, `UInv` gives the
no-shortcut step; the first unsettled vertex is bounded below by `D` (`hnc`); and
a settled vertex found beyond the radius short-circuits via `D ≤ maxR < du`. -/
theorem cut_walk {g : Graph} {maxR D tgt : Nat} {s : LState}
    (hwf : WFEdges g) (hU : UInv g maxR s)
    (hnc : ∀ v dv, v < g.n → s.done.getD v false = false →
        s.dist.getD v none = some dv → D ≤ dv)
    (hDR : D ≤ maxR) (htgt : s.dist.getD tgt none = some D) :
    ∀ (p : List Nat) (u du C : Nat), p.head? = some u → p.getLast? = some tgt →
      pathCost g p = some C → s.done.getD u false = true → u < g.n →
      s.dist.getD u none = some du → D ≤ du + C := by
  intro p
  induction p with
  | nil => intro u du C h; cases h
  | cons a rest ih =>
    intro u du C hhead hlast hcost hdone hun hdu
    obtain rfl : a = u := by simpa using hhead
    cases rest with
    | nil =>
      obtain rfl : a = tgt := by simpa using hlast
      simp only [pathCost, Option.some.injEq] at hcost
      rw [hdu] at htgt
      injection htgt with hD
      omega
    | cons b rest' =>
      rw [List.getLast?_cons_cons] at hlast
      rw [pathCost_cons_cons] at hcost
      cases hw : edgeMinW g a b with
      | none => rw [hw] at hcost; cases hcost
      | some w =>
        cases hc' : pathCost g (b :: rest') with
        | none => rw [hw, hc'] at hcost; cases hcost
        | some C' =>
          rw [hw, hc'] at hcost
          injection hcost with hC
          by_cases hdumax : du ≤ maxR
          · -- Within the radius: relaxation bounds the next vertex.
            have hmem := edgeMinW_mem hw
            obtain ⟨dv, hdv, hle⟩ := hU a b w du hdone hdu hdumax hmem
            have hbn : b < g.n := hwf a hun (b, w) hmem
            by_cases hbd : s.done.getD b false = true
            · -- b still settled: recurse.
              have := ih b dv C' rfl hlast hc' hbd hbn hdv
              omega
            · -- b left the settled set: the floor already prices it ≥ D.
              have hbf : s.done.getD b false = false := by
                cases hbb : s.done.getD b false with
                | false => rfl
                | true => exact absurd hbb hbd
              have := hnc b dv hbn hbf hdv
              omega
          · -- Beyond the radius: du > maxR ≥ D closes the goal outright.
            omega

/-! ## Discharging "nothing cheaper is unsettled" -/

/-- The floor bound: with `LInv`/`HInv` and the target settled at `D`, no
unsettled finite vertex is priced below `D`. An unsettled vertex with a distance
holds a live heap entry (`HInv`) priced `≥ L` (`LInv.ge`), and the settled target
is priced `≤ L` (`LInv.dle`), so `D ≤ L ≤ dv`. -/
theorem nocheap_of_inv {g : Graph} {L D tgt : Nat} {s : LState}
    (hL : LInv g L s) (hH : HInv g s)
    (htgtdone : s.done.getD tgt false = true) (htgt : s.dist.getD tgt none = some D) :
    ∀ v dv, v < g.n → s.done.getD v false = false →
      s.dist.getD v none = some dv → D ≤ dv := by
  intro v dv _ hvf hvd
  obtain ⟨d, hd, hdle⟩ := hL.dle tgt htgtdone
  rw [htgt] at hd
  injection hd with hDd
  have hmem := hH v dv hvf hvd
  have := hL.ge (dv, v) hmem
  omega

/-! ## The lower bound at a search state -/

/-- **Optimality lower bound.** At `iter g maxR k (linit g.n src)` with `tgt`
settled at `D ≤ maxR`, every valid `src → tgt` path costs at least `D`.

Given the value half (`iter_route_pathCost_eq`), this makes the reconstructed
route a minimum-cost path. `done[src]` (the source was settled) is the only
"ran far enough" fact still assumed — the floor bound (`nocheap_of_inv`) is
discharged internally. -/
theorem iter_lower_bound {g : Graph} {maxR src : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (k : Nat) {tgt D : Nat}
    (htgtdone : (iter g maxR k (linit g.n src)).done.getD tgt false = true)
    (hD : (iter g maxR k (linit g.n src)).dist.getD tgt none = some D)
    (hDR : D ≤ maxR) :
    ∀ (p : List Nat) (C : Nat), p.head? = some src → p.getLast? = some tgt →
      pathCost g p = some C → D ≤ C := by
  have hsrcdone : (iter g maxR k (linit g.n src)).done.getD src false = true :=
    iter_src_done_of_tgt hsrc htgtdone
  have hds0 : (linit g.n src).done.size = g.n := linit_done_size g.n src
  have hL0 : LInv g 0 (linit g.n src) := linit_inv hsrc
  have hH0 : HInv g (linit g.n src) := linit_hinv hsrc
  obtain ⟨L, _, hLk⟩ := (iter_inv (maxR := maxR) hwf k hL0).1
  have hHk := iter_hinv (maxR := maxR) hwf k hds0 hL0 hH0
  have hUk := iter_uinv (maxR := maxR) hwf k hds0 hL0 hH0 linit_uinv
  have hSk := iter_sinv (g := g) (maxR := maxR) (src := src) k (linit_sinv hsrc)
  have hnc := nocheap_of_inv hLk hHk htgtdone hD
  intro p C hh hl hc
  have hsrc0 : (iter g maxR k (linit g.n src)).dist.getD src none = some 0 := hSk
  have := cut_walk hwf hUk hnc hDR hD p src 0 C hh hl hc hsrcdone hsrc hsrc0
  omega

/-! ## The route is a minimum-cost path -/

/-- **Weight-optimality, both halves.** The reconstructed route from a settled,
chain-completed, within-radius target costs exactly `dist[tgt]` (value half) and
that cost lower-bounds every valid `src → tgt` path (this file) — so the route is
a minimum-cost path. -/
theorem iter_route_optimal {g : Graph} {maxR src : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (k : Nat) {tgt dt : Nat}
    (htgtdone : (iter g maxR k (linit g.n src)).done.getD tgt false = true)
    (hcomp : chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt
           = chainList (iter g maxR k (linit g.n src)).prev g.n (g.n + 1) tgt)
    (hdt : (iter g maxR k (linit g.n src)).dist.getD tgt none = some dt)
    (hDR : dt ≤ maxR) :
    pathCost g (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse
        = some dt ∧
    ∀ (p : List Nat) (C : Nat), p.head? = some src → p.getLast? = some tgt →
      pathCost g p = some C → dt ≤ C := by
  refine ⟨iter_route_pathCost_eq hwf hsrc k htgtdone hcomp hdt, ?_⟩
  exact iter_lower_bound hwf hsrc k htgtdone hdt hDR

/-! ## Bridge to the shared enumeration oracle

`iter_route_optimal` says the route is a minimum over *valid* paths. The rail
flagship is certified against `Rail.oracleDist` — the minimum over *simple*
paths of bounded length. This bridge closes the gap, pinning the lazy search's
answer to the very same oracle: `oracleDist g src tgt = some dt`.

Two directions, both radius-honest:

* **Lower bound** — every enumerated (simple-path) cost is a valid-path cost
  (`enum_sound`), and `iter_lower_bound` floors every valid `src → tgt` path at
  `dt`. No feasible cut needed; the radius bound `dt ≤ maxR` carries it.
* **Membership** — the reconstructed route itself is enumerated
  (`enum_complete`) at cost `dt`, so the running minimum can be no larger.

The route's simplicity (`nodupB`) and length (`≤ g.n + 1`) are taken as
hypotheses — cheap, executable checks the caller witnesses per route, exactly
as the rail `certify` gate does — rather than proved from a settle-order ghost
invariant the lazy machine does not carry. The endpoints and cost are proved:
`iter_route_pathCost_eq` (cost `dt`), `chainList_head?` (far end `tgt`),
`iter_route_head?_src` (near end `src`). -/

/-- **The lazy search's route attains the shared oracle distance.** For a
settled, chain-completed, within-radius target whose reconstructed route is
simple and short (both executable checks), the route's cost `dt` is exactly
`Rail.oracleDist g src tgt` — the same simple-path minimum the rail flagship is
certified against. -/
theorem iter_route_oracle {g : Graph} {maxR src : Nat} (hwf : WFEdges g)
    (hsrc : src < g.n) (k : Nat) {tgt dt : Nat}
    (htgtdone : (iter g maxR k (linit g.n src)).done.getD tgt false = true)
    (hcomp : chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt
           = chainList (iter g maxR k (linit g.n src)).prev g.n (g.n + 1) tgt)
    (hdt : (iter g maxR k (linit g.n src)).dist.getD tgt none = some dt)
    (hDR : dt ≤ maxR)
    (hnd : nodupB (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse = true)
    (hlen : (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse.length ≤ g.n + 1) :
    oracleDist g src tgt = some dt := by
  have hdsk : (iter g maxR k (linit g.n src)).done.size = g.n :=
    (iter_done_size k _).trans (linit_done_size g.n src)
  have htgtlt : tgt < g.n := done_lt hdsk htgtdone
  have hne : chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt ≠ [] :=
    chainList_ne_nil htgtlt (by omega)
  have hpc : pathCost g (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse
      = some dt := iter_route_pathCost_eq hwf hsrc k htgtdone hcomp hdt
  have hhead : (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse.head?
      = some src := iter_route_head?_src hwf hsrc k htgtdone hcomp
  have hlast : (chainList (iter g maxR k (linit g.n src)).prev g.n g.n tgt).reverse.getLast?
      = some tgt := by rw [List.getLast?_reverse]; exact chainList_head? hne
  -- Lower bound: every enumerated cost is a valid-path cost, floored at `dt`.
  have hlow : ∀ c ∈ simplePathCosts g tgt (g.n + 1) src [src], dt ≤ c := by
    intro c hc
    obtain ⟨q, C, hqh, hql, hqc, hqle⟩ := enum_sound _ _ _ _ hc
    have := iter_lower_bound hwf hsrc k htgtdone hdt hDR q C hqh hql hqc
    omega
  -- Membership: the route itself is enumerated, at its own cost `dt`.
  have hdisj := nodupB_head_notin_tail hnd hhead
  obtain ⟨c0, hc0mem, hc0le⟩ :=
    enum_complete _ (g.n + 1) src [src] dt hhead hlast hpc hnd hdisj hlen
  have hc0 : c0 = dt := Nat.le_antisymm hc0le (hlow c0 hc0mem)
  exact oracleDist_eq hlow (hc0 ▸ hc0mem)

end Verified.Geo
