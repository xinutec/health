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

open Verified.Rail (Graph WFEdges edgeMinW pathCost pathCost_cons_cons)

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
    (hsrcdone : (iter g maxR k (linit g.n src)).done.getD src false = true)
    (htgtdone : (iter g maxR k (linit g.n src)).done.getD tgt false = true)
    (hD : (iter g maxR k (linit g.n src)).dist.getD tgt none = some D)
    (hDR : D ≤ maxR) :
    ∀ (p : List Nat) (C : Nat), p.head? = some src → p.getLast? = some tgt →
      pathCost g p = some C → D ≤ C := by
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
    (hsrcdone : (iter g maxR k (linit g.n src)).done.getD src false = true)
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
  exact iter_lower_bound hwf hsrc k hsrcdone htgtdone hdt hDR

end Verified.Geo
