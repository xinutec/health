import Verified.Geo.LazyInv
import Verified.Rail.LoopInv

/-!
# LazyDijkstra fuel sufficiency — the model's last hypothesis, discharged

`LazyDijkstra.lean` models the TS `while (this.heap.size > 0)` settle
loop with a fuel parameter; its refinement theorems assume a stop is
fuel-reachable (`k ≤ fuel` with `stopAt … = true`). This file proves
that assumption for the fuel the model is actually run with: the rail
potential argument, ported to the lazy state.

`potentialL = heap.a.size + Σ undone out-degrees` strictly decreases at
every live step (`lstep_potential`): a pop always shrinks the heap by
one, a stale pop changes nothing else, and a fresh settle's relaxation
pushes at most `outdeg u` entries while permanently removing `outdeg u`
from the undone sum (`sum_map_flip`, as in the rail proof). Hence the
trajectory reaches a terminal state within `potentialL` steps
(`iter_terminal`), the initial potential is at most `E + 1`
(`potentialL_linit`), and every settle call with fuel ≥ `E + 1` lands
on a stopped state — from the initial state, from any trajectory point,
and therefore through any interleaving of memoised settles, since a
fold of settles is itself a trajectory point (`settles_eq_iter`,
via `lsettle_spec`). `all_settles_stop` is the headline.

Combined with `lsettle_eq_iter`/`lsettle_comm` (refinement) and
`settled_final` (`LazyInv.lean`), no hypothesis about the lazy search
remains unproved: the TS loop always terminates within the modelled
fuel, pausing order is irrelevant, and settled reads are final.
-/

namespace Verified.Geo

open Verified.Rail (Graph Heap sum_map_flip sum_map_le foldl_add_sum
  map_range_getD getD_toList)
open Verified.Rail.Heap (push_size pop_size pop_none_iff)

/-! ## Heap growth bounds -/

theorem relaxStep_heap_le (u p : Nat) (s : LState) (tw : Nat × Nat) :
    (relaxStep u p s tw).heap.a.size ≤ s.heap.a.size + 1 := by
  unfold relaxStep
  split
  · exact Nat.le_of_eq (push_size ..)
  · split
    · exact Nat.le_of_eq (push_size ..)
    · exact Nat.le_add_right _ _

theorem relaxList_heap_le (u p : Nat) :
    ∀ (l : List (Nat × Nat)) (s : LState),
      (l.foldl (relaxStep u p) s).heap.a.size ≤ s.heap.a.size + l.length
  | [], _ => Nat.le_add_right _ _
  | tw :: l, s => by
    rw [List.foldl_cons, List.length_cons]
    have h1 := relaxList_heap_le u p l (relaxStep u p s tw)
    have h2 := relaxStep_heap_le u p s tw
    omega

theorem relaxL_heap_le (u p : Nat) (edges : Array (Nat × Nat)) (s : LState) :
    (relaxL u p edges s).heap.a.size ≤ s.heap.a.size + edges.size := by
  unfold relaxL
  rw [← Array.foldl_toList]
  have h := relaxList_heap_le u p edges.toList s
  rw [Array.length_toList] at h
  exact h

/-- `lstep` never changes the `done` array's size. -/
theorem lstep_done_size {g : Graph} {maxR : Nat} {s : LState} :
    (lstep g maxR s).done.size = s.done.size := by
  unfold lstep
  split
  · rfl
  · split
    · rfl
    · split
      · rfl
      · split
        · exact Array.size_setIfInBounds ..
        · rw [relaxL_done]
          exact Array.size_setIfInBounds ..

/-! ## The potential -/

/-- Adjacency size still chargeable to future settles. -/
def undoneOutA (g : Graph) (dn : Array Bool) : Nat :=
  ((List.range g.n).map
    (fun u => if dn.getD u false then 0 else (g.adj.getD u #[]).size)).sum

/-- Strictly decreases at every live step. -/
def potentialL (g : Graph) (s : LState) : Nat :=
  s.heap.a.size + undoneOutA g s.done

/-- Setting a done bit never increases the undone sum. -/
theorem undoneOutA_set_le (g : Graph) (dn : Array Bool) (u : Nat) :
    undoneOutA g (dn.setIfInBounds u true) ≤ undoneOutA g dn := by
  unfold undoneOutA
  refine sum_map_le _ _ _ (fun x _ => ?_)
  dsimp only
  by_cases hxu : x = u
  · subst hxu
    by_cases hlt : x < dn.size
    · rw [getD_sib_lt hlt]
      exact Nat.zero_le _
    · have h1 : (dn.setIfInBounds x true).getD x false = dn.getD x false := by
        rw [Array.getD_eq_getD_getElem?, Array.getElem?_setIfInBounds,
          if_pos rfl, if_neg hlt, Array.getD_eq_getD_getElem?,
          Array.getElem?_eq_none (by omega)]
      rw [h1]
      exact Nat.le_refl _
  · rw [getD_sib_ne (fun he => hxu he.symm)]
    exact Nat.le_refl _

/-- Settling a live in-range vertex removes exactly its out-degree. -/
theorem undoneOutA_flip {g : Graph} {dn : Array Bool} {u : Nat}
    (hun : u < g.n) (hsz : dn.size = g.n) (hund : dn.getD u false = false) :
    undoneOutA g (dn.setIfInBounds u true) + (g.adj.getD u #[]).size =
      undoneOutA g dn := by
  unfold undoneOutA
  have hflip := sum_map_flip (List.range g.n)
    (fun x => if dn.getD x false then 0 else (g.adj.getD x #[]).size)
    (fun x => if (dn.setIfInBounds u true).getD x false then 0
      else (g.adj.getD x #[]).size)
    u List.nodup_range (List.mem_range.mpr hun)
    (fun x hx => by
      dsimp only
      rw [getD_sib_ne (fun he => hx he.symm)])
    (by
      dsimp only
      rw [getD_sib_lt (by rw [hsz]; exact hun), if_pos rfl])
  dsimp only at hflip
  rw [if_neg (by rw [hund]; exact Bool.false_ne_true)] at hflip
  exact hflip

/-- One live step strictly decreases the potential — a pop always
shrinks the heap by one, and a fresh settle's pushes are paid for by
the vertex leaving the undone sum. -/
theorem lstep_potential {g : Graph} {maxR : Nat} {s : LState}
    (hterm : lterminal s = false) (hdsz : s.done.size = g.n) :
    potentialL g (lstep g maxR s) < potentialL g s := by
  unfold lterminal at hterm
  rw [Bool.or_eq_false_iff] at hterm
  obtain ⟨hex, hhne⟩ := hterm
  have hne : s.heap.a.size ≠ 0 := fun h0 => by
    simp [Heap.size, h0] at hhne
  have hpos : 0 < s.heap.a.size := Nat.pos_of_ne_zero hne
  unfold lstep
  split
  next hexT => simp [hex] at hexT
  next =>
    split
    next hpop => exact absurd (pop_none_iff.mp hpop) hne
    next p u h' hpop =>
      have hsz := pop_size hpop
      split
      next =>
        -- stale entry: the heap shrinks, the sum is untouched
        show h'.a.size + undoneOutA g s.done <
          s.heap.a.size + undoneOutA g s.done
        omega
      next hdone =>
        have hund : s.done.getD u false = false := Bool.not_eq_true _ ▸ hdone
        have hkey : undoneOutA g (s.done.setIfInBounds u true) +
            (g.adj.getD u #[]).size ≤ undoneOutA g s.done := by
          rcases Nat.lt_or_ge u g.n with hun | hun
          · exact Nat.le_of_eq (undoneOutA_flip hun hdsz hund)
          · have hemp : g.adj.getD u #[] = #[] := by
              rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none]
              · rfl
              · exact hun
            rw [hemp]
            simpa using undoneOutA_set_le g s.done u
        split
        next =>
          -- radius exit: the heap still shrank by the pop
          show h'.a.size + undoneOutA g (s.done.setIfInBounds u true) <
            s.heap.a.size + undoneOutA g s.done
          have hle := undoneOutA_set_le g s.done u
          omega
        next =>
          -- fresh settle: pushes are paid for by the flipped sum term
          have hheap : (relaxL u p (g.adj.getD u #[])
              { s with heap := h'
                       done := s.done.setIfInBounds u true }).heap.a.size ≤
              h'.a.size + (g.adj.getD u #[]).size :=
            relaxL_heap_le u p _ _
          have hdn : (relaxL u p (g.adj.getD u #[])
              { s with heap := h'
                       done := s.done.setIfInBounds u true }).done =
              s.done.setIfInBounds u true :=
            relaxL_done u p _ _
          show (relaxL u p (g.adj.getD u #[])
              { s with heap := h'
                       done := s.done.setIfInBounds u true }).heap.a.size +
              undoneOutA g (relaxL u p (g.adj.getD u #[])
                { s with heap := h'
                         done := s.done.setIfInBounds u true }).done <
            s.heap.a.size + undoneOutA g s.done
          rw [hdn]
          omega

/-! ## Termination -/

/-- The trajectory reaches a terminal state within `potentialL` steps. -/
theorem iter_terminal {g : Graph} {maxR : Nat} :
    ∀ (n : Nat) (s : LState), potentialL g s ≤ n → s.done.size = g.n →
      ∃ k ≤ n, lterminal (iter g maxR k s) = true := by
  intro n
  induction n with
  | zero =>
    intro s hpot _
    have hsz : s.heap.a.size = 0 := by
      unfold potentialL at hpot
      omega
    refine ⟨0, Nat.le_refl _, ?_⟩
    show lterminal s = true
    unfold lterminal
    rw [show (s.heap.size == 0) = true by simp [Heap.size, hsz]]
    simp
  | succ n ih =>
    intro s hpot hdsz
    cases hterm : lterminal s with
    | true => exact ⟨0, Nat.zero_le _, hterm⟩
    | false =>
      have hdec := lstep_potential (maxR := maxR) hterm hdsz
      obtain ⟨k, hk, hkt⟩ := ih (lstep g maxR s) (by omega)
        (by rw [lstep_done_size]; exact hdsz)
      exact ⟨k + 1, by omega, hkt⟩

/-- Total out-degree — the `E` of the fuel bound. -/
def totalOut (g : Graph) : Nat := g.adj.foldl (fun acc r => acc + r.size) 0

theorem undoneOutA_le (g : Graph) (dn : Array Bool) :
    undoneOutA g dn ≤ totalOut g := by
  unfold totalOut
  have h1 : g.adj.foldl (fun acc r => acc + r.size) 0 =
      (g.adj.toList.map Array.size).sum := by
    rw [← Array.foldl_toList, foldl_add_sum]
    omega
  have h2 := map_range_getD g.adj.toList
  rw [Array.length_toList] at h2
  rw [h1, ← h2]
  unfold undoneOutA
  refine sum_map_le _ _ _ (fun x _ => ?_)
  dsimp only
  rw [getD_toList]
  by_cases hb : dn.getD x false = true
  · rw [if_pos hb]
    exact Nat.zero_le _
  · rw [if_neg hb]
    exact Nat.le_refl _

/-- The initial potential: one heap entry plus at most every edge. -/
theorem potentialL_linit (g : Graph) (src : Nat) :
    potentialL g (linit g.n src) ≤ totalOut g + 1 := by
  unfold potentialL
  have hh : (linit g.n src).heap.a.size = 1 := by
    rw [show (linit g.n src).heap = Heap.push ⟨#[]⟩ 0 src from rfl, push_size]
    rfl
  have hu := undoneOutA_le g (linit g.n src).done
  omega

theorem linit_done_size (n src : Nat) : (linit n src).done.size = n := by
  show (Array.replicate n false).size = n
  simp

/-! ## Fuel sufficiency -/

/-- Potential never increases (terminal steps are no-ops). -/
theorem lstep_potential_le {g : Graph} {maxR : Nat} {s : LState}
    (hdsz : s.done.size = g.n) :
    potentialL g (lstep g maxR s) ≤ potentialL g s := by
  cases hterm : lterminal s with
  | true =>
    unfold lterminal at hterm
    rcases Bool.or_eq_true _ _ ▸ hterm with hex | hemp
    · rw [lstep_exhausted_fix hex]
      exact Nat.le_refl _
    · rw [lstep_empty_fix (by simpa [Heap.size] using hemp)]
      exact Nat.le_refl _
  | false => exact Nat.le_of_lt (lstep_potential hterm hdsz)

theorem iter_done_size {g : Graph} {maxR : Nat} :
    ∀ (k : Nat) (s : LState), (iter g maxR k s).done.size = s.done.size
  | 0, _ => rfl
  | k + 1, s => by
    rw [iter_succ, iter_done_size k, lstep_done_size]

theorem iter_potential_le {g : Graph} {maxR : Nat} :
    ∀ (k : Nat) (s : LState), s.done.size = g.n →
      potentialL g (iter g maxR k s) ≤ potentialL g s
  | 0, _, _ => Nat.le_refl _
  | k + 1, s, hdsz => by
    rw [iter_succ]
    have h1 := iter_potential_le (g := g) (maxR := maxR) k (lstep g maxR s)
      (by rw [lstep_done_size]; exact hdsz)
    have h2 := lstep_potential_le (maxR := maxR) hdsz
    omega

/-- **Fuel sufficiency.** From any trajectory point of the real run,
`lsettle` with fuel ≥ `E + 1` lands on a stopped state: the stop is
reachable within the remaining potential, which the initial bound
dominates. This discharges the `k ≤ fuel` reachability hypothesis of
`lsettle_eq_iter`/`lsettle_comm`/`lsettle_idem` for the modelled fuel. -/
theorem lsettle_stops {g : Graph} {maxR t src m fuel : Nat}
    (hfuel : totalOut g + 1 ≤ fuel) :
    stopAt t (lsettle g maxR t fuel (iter g maxR m (linit g.n src))) = true := by
  have hdsz : (iter g maxR m (linit g.n src)).done.size = g.n := by
    rw [iter_done_size, linit_done_size]
  have hpot : potentialL g (iter g maxR m (linit g.n src)) ≤ totalOut g + 1 := by
    have h1 := iter_potential_le (maxR := maxR) m (linit g.n src)
      (linit_done_size g.n src)
    have h2 := potentialL_linit g src
    omega
  obtain ⟨k, hk, hkt⟩ := iter_terminal (maxR := maxR) (totalOut g + 1) _ hpot hdsz
  have hstop : stopAt t (iter g maxR k (iter g maxR m (linit g.n src))) = true := by
    unfold stopAt
    rw [hkt]
    simp
  obtain ⟨K, _, heq, hstop', -⟩ := lsettle_eq_iter (fuel := fuel) (by omega) hstop
  rw [heq]
  exact hstop'

/-- A fold of settles is a trajectory point (whatever the fuels). -/
theorem settles_eq_iter {g : Graph} {maxR : Nat} (s₀ : LState) :
    ∀ (calls : List (Nat × Nat)),
      ∃ m, calls.foldl (fun s c => lsettle g maxR c.1 c.2 s) s₀ =
        iter g maxR m s₀ := by
  intro calls
  induction calls generalizing s₀ with
  | nil => exact ⟨0, rfl⟩
  | cons c rest ih =>
    obtain ⟨k, _, hk, -, -⟩ := lsettle_spec g maxR c.1 c.2 s₀
    obtain ⟨m, hm⟩ := ih (lsettle g maxR c.1 c.2 s₀)
    refine ⟨k + m, ?_⟩
    rw [List.foldl_cons, hm, hk, ← iter_add]

/-- **Every settle stops.** Through any interleaving of memoised settle
calls (arbitrary targets and fuels), the next settle with fuel ≥ `E + 1`
lands stopped — the TS unfueled `while (heap.size)` loop always
terminates, at every resume. -/
theorem all_settles_stop {g : Graph} {maxR t src fuel : Nat}
    (calls : List (Nat × Nat)) (hfuel : totalOut g + 1 ≤ fuel) :
    stopAt t (lsettle g maxR t fuel
      (calls.foldl (fun s c => lsettle g maxR c.1 c.2 s) (linit g.n src))) =
      true := by
  obtain ⟨m, hm⟩ := settles_eq_iter (linit g.n src) calls
  rw [hm]
  exact lsettle_stops hfuel

/-! ## Executable cross-check: the bound is honest on random graphs -/

private def checkFuel (seed n m maxR src : Nat) : Bool := Id.run do
  let g := mkG seed n m
  let fuel := totalOut g + 1
  for t in [0:n] do
    if !(stopAt t (lsettle g maxR t fuel (linit n src))) then return false
  return true

#guard (List.range 6).all fun seed => checkFuel seed 7 12 100000 (seed % 7)
#guard (List.range 6).all fun seed => checkFuel seed 7 12 800 (seed % 7)
#guard (List.range 4).all fun seed => checkFuel seed 5 4 100000 0

end Verified.Geo
