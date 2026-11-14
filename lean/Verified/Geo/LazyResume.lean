import Verified.Geo.LazyInv

/-!
# Lazy Dijkstra: resume-read stability

The matcher's `RouteCache` pauses a source's search at one target and resumes
it at the next. This proves the target's `dist`, `prev` and `done` read then
equal what a search from the source's start would read:

- `lsettle_from_iter` (`LazyDijkstra`): a settle resumed from `iter m` lands on
  `iter (max m k) s`, `k` the target's first stop from `s`, independent of `m`;
- past the first stop the read is frozen: by `settled_final` (`LazyInv`) when
  the target is done, by `iter_terminal_fix` (here) when the search terminated.

So resumes from `iter m` and from `s` agree on the target, which makes
`qRouteBetween`'s result a pure function of the graph, not settle history.
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

/-- Done-vertex read stability: once settled by step `k`, a vertex's
`dist`/`prev`/`done` are frozen (`settled_final`). Every vertex on a settled
target's `prev` chain is settled, so the whole route is resume-stable. -/
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

/-- Read stability past the first stop: if `t` stopped by step `k`, every later
`iter (max m k) s` reads the same at `t` as `iter k s`, whether it settled
(`iter_done_stable`) or the search terminated (an `iter` fixpoint). -/
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

/-- Resume-read stability: a fueled settle of `t` from any `iter m s` reads the
same at `t` as one from `s`, given `t`'s first stop `k` is within fuel. -/
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

/-- The lemma for a fresh per-source search (`linit`, valid by `linit_inv`):
every cached state for `src` is `iter m (linit g.n src)`, so its reads match a
fresh search's. -/
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
