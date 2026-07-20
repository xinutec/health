import Verified.Geo.LazyInv

/-!
# Lazy Dijkstra: resume-read stability

The single fact the matcher's per-source route cache rests on: **the target
reads after settling do not depend on where you resume from.** The twin's
`QRouteCache` pauses a source's search at one target and resumes it at the
next; this file proves the value it then reads — `dist`, `prev`, and `done`
at the queried target — is exactly what a search resumed from the source's
*start* would read.

The argument is entirely trajectory-algebraic over the already-proved
refinement machinery:

- `lsettle_from_iter` (`LazyDijkstra`): a settle resumed from `iter m` lands
  on `iter (max m k) s`, where `k` is the target's first-stop index from `s`
  — independent of `m`;
- past the first stop the read is frozen, by two disjoint mechanisms the
  stop condition splits into — `settled_final` (`LazyInv`) when the target is
  *done*, and `iter_terminal_fix` (proved here) when the search has *terminated*
  (a terminal state is an `iter` fixpoint).

So two resumes of the same source to the same target — from `iter m` and from
`iter 0 = s` — reduce to `iter (max m k) s` and `iter k s`, which agree on the
target. This is the load-bearing lemma behind `qRouteBetween`'s cache purity
(the route result is a pure function of the graph, not of settle history),
which in turn is what makes the matcher's declarative score model well-defined.
-/

namespace Verified.Geo

open Verified.Rail (Graph WFEdges)

/-- A terminal state is a fixpoint of one step. -/
theorem lstep_terminal_fix {g : Graph} {maxR : Nat} {s : LState}
    (h : lterminal s = true) : lstep g maxR s = s := by
  unfold lterminal at h
  rcases Bool.or_eq_true _ _ ▸ h with hex | hempty
  · exact lstep_exhausted_fix hex
  · exact lstep_empty_fix (by simpa using hempty)

/-- Hence a fixpoint of the whole trajectory: once the search has
terminated, no number of further steps changes the state. -/
theorem iter_terminal_fix {g : Graph} {maxR : Nat} :
    ∀ (k : Nat) {s : LState}, lterminal s = true → iter g maxR k s = s := by
  intro k
  induction k with
  | zero => intro s _; rfl
  | succ k ih =>
    intro s h
    rw [iter_succ, lstep_terminal_fix h]
    exact ih h

/-- **Done-vertex read stability.** From a valid base `s`, once *any*
vertex `v` is settled by step `k` its `dist`/`prev`/`done` are frozen for
the rest of the trajectory (`settled_final`). This is the fact the route
reconstruction needs: every vertex on a settled target's `prev` chain is
itself settled, so the whole reconstructed path is resume-stable, not just
the target. -/
theorem iter_done_stable {g : Graph} {maxR L : Nat} (hwf : WFEdges g)
    {s : LState} (hs : LInv g L s) {v k : Nat}
    (hv : (iter g maxR k s).done.getD v false = true) (m : Nat) :
    (iter g maxR (Nat.max m k) s).dist.getD v none = (iter g maxR k s).dist.getD v none ∧
    (iter g maxR (Nat.max m k) s).prev.getD v 0 = (iter g maxR k s).prev.getD v 0 ∧
    (iter g maxR (Nat.max m k) s).done.getD v false = (iter g maxR k s).done.getD v false := by
  rcases Nat.le_total m k with hmk | hkm
  · rw [show Nat.max m k = k from Nat.max_eq_right hmk]; exact ⟨rfl, rfl, rfl⟩
  · rw [show Nat.max m k = m from Nat.max_eq_left hkm]
    obtain ⟨d, rfl⟩ : ∃ d, m = k + d := ⟨m - k, by omega⟩
    rw [iter_add]
    obtain ⟨L', _, hLk⟩ := (iter_inv (maxR := maxR) hwf k hs).1
    obtain ⟨hd, hp, hdn⟩ := settled_final (k := d) hwf hLk hv
    exact ⟨hd, hp, hdn.trans hv.symm⟩

/-- **Read stability past the first stop.** From a valid base `s`, if the
target `t` has stopped by step `k`, then every later trajectory point
`iter (max m k) s` reports the same `dist`/`prev`/`done` at `t` as
`iter k s` — whether the stop was a settle (`done`, frozen by
`iter_done_stable`) or a termination (`lterminal`, an `iter` fixpoint). -/
theorem iter_stop_read_stable {g : Graph} {maxR t L : Nat} (hwf : WFEdges g)
    {s : LState} (hs : LInv g L s) {k : Nat}
    (hstop : stopAt t (iter g maxR k s) = true) (m : Nat) :
    (iter g maxR (Nat.max m k) s).dist.getD t none = (iter g maxR k s).dist.getD t none ∧
    (iter g maxR (Nat.max m k) s).prev.getD t 0 = (iter g maxR k s).prev.getD t 0 ∧
    (iter g maxR (Nat.max m k) s).done.getD t false = (iter g maxR k s).done.getD t false := by
  unfold stopAt at hstop
  rcases Bool.or_eq_true _ _ ▸ hstop with hdone | hterm
  · exact iter_done_stable hwf hs hdone m
  · rcases Nat.le_total m k with hmk | hkm
    · rw [show Nat.max m k = k from Nat.max_eq_right hmk]; exact ⟨rfl, rfl, rfl⟩
    · rw [show Nat.max m k = m from Nat.max_eq_left hkm]
      obtain ⟨d, rfl⟩ : ∃ d, m = k + d := ⟨m - k, by omega⟩
      rw [iter_add, iter_terminal_fix d hterm]
      exact ⟨rfl, rfl, rfl⟩

/-- **Resume-read stability.** A fueled settle of `t` resumed from any
trajectory point `iter m s` reports the same target reads as one resumed
from the start `s`, provided `k` is `t`'s first stop from `s` (reachable
within the fuel). This is the per-source cache soundness at the read level:
the value the twin's `rd.settle(t)` returns is independent of the paused
state it resumes. -/
theorem lsettle_read_stable {g : Graph} {maxR t fuel L : Nat} (hwf : WFEdges g)
    {s : LState} (hs : LInv g L s) {k : Nat} (hkf : k ≤ fuel)
    (hstop : stopAt t (iter g maxR k s) = true)
    (hmin : ∀ j < k, stopAt t (iter g maxR j s) = false) (m : Nat) :
    ((lsettle g maxR t fuel (iter g maxR m s)).dist.getD t none
        = (lsettle g maxR t fuel s).dist.getD t none) ∧
    ((lsettle g maxR t fuel (iter g maxR m s)).prev.getD t 0
        = (lsettle g maxR t fuel s).prev.getD t 0) ∧
    ((lsettle g maxR t fuel (iter g maxR m s)).done.getD t false
        = (lsettle g maxR t fuel s).done.getD t false) := by
  have hres := lsettle_from_iter (t := t) (fuel := fuel) (m := m) (K := k) (s := s)
    hkf hstop hmin
  have hfresh : lsettle g maxR t fuel s = iter g maxR k s := by
    have h0 := lsettle_from_iter (t := t) (fuel := fuel) (m := 0) (K := k) (s := s)
      hkf hstop hmin
    simpa using h0
  rw [hres, hfresh]
  exact iter_stop_read_stable hwf hs hstop m

/-- The lemma specialised to a fresh per-source search (`linit`), where the
validity hypothesis is discharged by `linit_inv`. This is the form the
matcher's cache purity consumes: every cached state for source `src` is
`iter m (linit g.n src)` for some `m`, so its target reads match the fresh
search's. -/
theorem lsettle_linit_read_stable {g : Graph} {maxR t fuel src : Nat}
    (hwf : WFEdges g) (hsrc : src < g.n) {k : Nat} (hkf : k ≤ fuel)
    (hstop : stopAt t (iter g maxR k (linit g.n src)) = true)
    (hmin : ∀ j < k, stopAt t (iter g maxR j (linit g.n src)) = false) (m : Nat) :
    ((lsettle g maxR t fuel (iter g maxR m (linit g.n src))).dist.getD t none
        = (lsettle g maxR t fuel (linit g.n src)).dist.getD t none) ∧
    ((lsettle g maxR t fuel (iter g maxR m (linit g.n src))).prev.getD t 0
        = (lsettle g maxR t fuel (linit g.n src)).prev.getD t 0) ∧
    ((lsettle g maxR t fuel (iter g maxR m (linit g.n src))).done.getD t false
        = (lsettle g maxR t fuel (linit g.n src)).done.getD t false) :=
  lsettle_read_stable hwf (linit_inv hsrc) hkf hstop hmin m

end Verified.Geo
