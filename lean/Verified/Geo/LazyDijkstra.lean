import Verified.Rail.Dijkstra
import Verified.Geo.ArrayLemmas

/-!
# Lazy-vs-eager Dijkstra — `LazyDijkstra`'s refinement comment-proof

`src/geo/map-match-core.ts` replaced an eager bounded Dijkstra (run once,
break at the target or the radius) with `LazyDijkstra`: the search pauses
when the requested target settles and *resumes* on the next
`settle(target')`, memoised per source. The comment claims the lazy form
matches "the eager version's post-break state". That refactor argument is
what this file proves.

The observation that makes it a theorem: the search is a **deterministic
step sequence** that never consults the target — `settle(t)` only chooses
*where to pause*. Modelling one pop-iteration as `lstep`:

* `lsettle_spec` / `lsettle_eq_iter` — a settle call is exactly a prefix
  of the step trajectory, ending at the first state where its stop
  condition (`done[t]`, exhaustion, or an empty heap) holds: the eager
  run-to-break, verbatim;
* `stopAt_mono` — stop conditions are monotone along the trajectory
  (done bits are only ever set, exhaustion is absorbing, an empty heap
  stays empty), so pausing can never *unsettle* anything;
* `lsettle_comm` / `lsettle_idem` — settles commute and are idempotent:
  any interleaving of settle calls lands on `iter (max of the first-hit
  indices)`, independent of order.

The classic "settled = final" fact — a settled vertex's `dist`/`prev`
never change afterwards — is proved in `LazyInv.lean`
(`settled_final`/`settled_final_settle`, under `WFEdges`), and the
stop-reachability hypothesis used below (`stopAt … (iter … k …) = true`
with `k ≤ fuel`) is discharged in `LazyFuel.lean` for any fuel ≥ `E + 1`
(`lsettle_stops`/`all_settles_stop`), so no assumption about the lazy
search remains unproved; the `#guard`s below stay as smoke tests.

Weights are `Nat` (the quantised substrate, as in `Verified/Rail`); the
TS radius check `cur.p > maxRadiusM` is ported strictly.
-/

namespace Verified.Geo

open Verified.Rail (Graph Heap)

deriving instance BEq for Heap

/-- The lazy search's working state — `LazyDijkstra`'s fields. -/
structure LState where
  dist : Array (Option Nat)
  prev : Array Nat
  done : Array Bool
  heap : Heap
  exhausted : Bool
deriving BEq, Repr

/-- One relaxation — the TS inner-loop body, adjacency order. -/
def relaxStep (u p : Nat) (s : LState) (tw : Nat × Nat) : LState :=
  match s.dist.getD tw.1 none with
  | none =>
    { s with
      dist := s.dist.setIfInBounds tw.1 (some (p + tw.2))
      prev := s.prev.setIfInBounds tw.1 u
      heap := s.heap.push (p + tw.2) tw.1 }
  | some dv =>
    if p + tw.2 < dv then
      { s with
        dist := s.dist.setIfInBounds tw.1 (some (p + tw.2))
        prev := s.prev.setIfInBounds tw.1 u
        heap := s.heap.push (p + tw.2) tw.1 }
    else s

def relaxL (u p : Nat) (edges : Array (Nat × Nat)) (s : LState) : LState :=
  edges.foldl (relaxStep u p) s

/-- One pop-iteration of the settle loop: skip stale entries, settle the
vertex, exhaust past the radius (marked done, never relaxed — the TS
semantics), otherwise relax. Deterministic and target-free. -/
def lstep (g : Graph) (maxR : Nat) (s : LState) : LState :=
  if s.exhausted then s
  else
    match s.heap.pop with
    | none => s
    | some ((p, u), h') =>
      if s.done.getD u false then { s with heap := h' }
      else
        let s' := { s with heap := h', done := s.done.setIfInBounds u true }
        if p > maxR then { s' with exhausted := true }
        else relaxL u p (g.adj.getD u #[]) s'

/-- The search is over for good: radius-exhausted or drained. -/
def lterminal (s : LState) : Bool := s.exhausted || s.heap.size == 0

/-- `settle t` pauses here: `t` settled, or the search is over. -/
def stopAt (t : Nat) (s : LState) : Bool := s.done.getD t false || lterminal s

/-- The bare step trajectory. -/
def iter (g : Graph) (maxR : Nat) : Nat → LState → LState
  | 0, s => s
  | k + 1, s => iter g maxR k (lstep g maxR s)

/-- The TS `settle(target)`: entry check, then iterate until the stop. -/
def lsettle (g : Graph) (maxR t : Nat) : Nat → LState → LState
  | 0, s => s
  | fuel + 1, s => if stopAt t s then s else lsettle g maxR t fuel (lstep g maxR s)

/-- Per-source initial state — the TS constructor. -/
def linit (n src : Nat) : LState :=
  { dist := (Array.replicate n none).setIfInBounds src (some 0)
    prev := Array.replicate n n
    done := Array.replicate n false
    heap := Heap.push ⟨#[]⟩ 0 src
    exhausted := false }

/-! ## Step lemmas: what one iteration can never undo -/

theorem relaxStep_done (u p : Nat) (s : LState) (tw : Nat × Nat) :
    (relaxStep u p s tw).done = s.done := by
  unfold relaxStep
  split <;> first | rfl | (split <;> rfl)

theorem relaxStep_exhausted (u p : Nat) (s : LState) (tw : Nat × Nat) :
    (relaxStep u p s tw).exhausted = s.exhausted := by
  unfold relaxStep
  split <;> first | rfl | (split <;> rfl)

theorem relaxL_done (u p : Nat) (edges : Array (Nat × Nat)) (s : LState) :
    (relaxL u p edges s).done = s.done := by
  unfold relaxL
  rw [← Array.foldl_toList]
  induction edges.toList generalizing s with
  | nil => rfl
  | cons tw l ih =>
    rw [List.foldl_cons]
    rw [ih (relaxStep u p s tw), relaxStep_done]

theorem relaxL_exhausted (u p : Nat) (edges : Array (Nat × Nat)) (s : LState) :
    (relaxL u p edges s).exhausted = s.exhausted := by
  unfold relaxL
  rw [← Array.foldl_toList]
  induction edges.toList generalizing s with
  | nil => rfl
  | cons tw l ih =>
    rw [List.foldl_cons]
    rw [ih (relaxStep u p s tw), relaxStep_exhausted]

/-- Done bits are only ever set. -/
theorem lstep_done_mono {g : Graph} {maxR : Nat} {s : LState} {v : Nat}
    (h : s.done.getD v false = true) :
    (lstep g maxR s).done.getD v false = true := by
  unfold lstep
  split
  · exact h
  · split
    · exact h
    · split
      · exact h
      · split
        · exact getD_set_true _ _ h
        · rw [relaxL_done]
          exact getD_set_true _ _ h

/-- Exhaustion short-circuits the step entirely. -/
theorem lstep_exhausted_fix {g : Graph} {maxR : Nat} {s : LState}
    (h : s.exhausted = true) : lstep g maxR s = s := by
  unfold lstep
  rw [if_pos h]

/-- A drained heap makes the step a no-op. -/
theorem lstep_empty_fix {g : Graph} {maxR : Nat} {s : LState}
    (h : s.heap.size = 0) : lstep g maxR s = s := by
  unfold lstep
  split
  · rfl
  · have hsz : s.heap.a.size = 0 := by simpa [Heap.size] using h
    have hp : s.heap.pop = none := by
      unfold Heap.pop
      rw [Array.getElem?_eq_none (by omega)]
    rw [hp]

/-- Stop conditions are monotone along the trajectory: a settled target
stays settled, a finished search stays finished. -/
theorem stopAt_mono {g : Graph} {maxR : Nat} {t : Nat} {s : LState}
    (h : stopAt t s = true) : stopAt t (lstep g maxR s) = true := by
  unfold stopAt lterminal at h ⊢
  rcases Bool.or_eq_true _ _ ▸ h with hd | hterm
  · rw [lstep_done_mono hd]
    simp
  · rcases Bool.or_eq_true _ _ ▸ hterm with hex | hempty
    · rw [lstep_exhausted_fix hex, hex]
      simp
    · rw [lstep_empty_fix (by simpa using hempty), hempty]
      simp

/-! ## Trajectory algebra -/

theorem iter_succ (g : Graph) (maxR k : Nat) (s : LState) :
    iter g maxR (k + 1) s = iter g maxR k (lstep g maxR s) := rfl

theorem iter_add (g : Graph) (maxR : Nat) :
    ∀ (m k : Nat) (s : LState), iter g maxR (m + k) s = iter g maxR k (iter g maxR m s) := by
  intro m
  induction m with
  | zero =>
    intro k s
    show iter g maxR (0 + k) s = iter g maxR k s
    rw [Nat.zero_add]
  | succ m ih =>
    intro k s
    have hidx : m + 1 + k = (m + k) + 1 := by omega
    rw [hidx, iter_succ, ih k (lstep g maxR s)]
    rfl

private theorem stopAt_iter_of_stopAt {g : Graph} {maxR t : Nat} :
    ∀ (d : Nat) (s : LState), stopAt t s = true →
      stopAt t (iter g maxR d s) = true := by
  intro d
  induction d with
  | zero => exact fun _ h => h
  | succ d ih =>
    intro s h
    rw [iter_succ]
    exact ih _ (stopAt_mono h)

/-- Stop monotonicity, lifted to the trajectory. -/
theorem stopAt_iter_mono {g : Graph} {maxR t : Nat} {s : LState} {j j' : Nat}
    (hj : stopAt t (iter g maxR j s) = true) (hle : j ≤ j') :
    stopAt t (iter g maxR j' s) = true := by
  obtain ⟨d, rfl⟩ : ∃ d, j' = j + d := ⟨j' - j, by omega⟩
  rw [iter_add]
  exact stopAt_iter_of_stopAt d _ hj

/-! ## The refinement theorems -/

/-- A settle call is exactly a trajectory prefix: it lands on `iter k`
for the first `k` where its stop holds (or fuel runs out — excluded
whenever a stop is known reachable, see `lsettle_eq_iter`). -/
theorem lsettle_spec (g : Graph) (maxR t : Nat) :
    ∀ (fuel : Nat) (s : LState), ∃ k ≤ fuel,
      lsettle g maxR t fuel s = iter g maxR k s ∧
      (∀ j < k, stopAt t (iter g maxR j s) = false) ∧
      (stopAt t (iter g maxR k s) = true ∨ k = fuel) := by
  intro fuel
  induction fuel with
  | zero => exact fun s => ⟨0, Nat.le_refl 0, rfl, fun j hj => absurd hj (by omega), .inr rfl⟩
  | succ fuel ih =>
    intro s
    by_cases hstop : stopAt t s = true
    · exact ⟨0, by omega, by rw [lsettle, if_pos hstop]; rfl, fun j hj => absurd hj (by omega),
        .inl hstop⟩
    · obtain ⟨k, hk, heq, hbelow, hend⟩ := ih (lstep g maxR s)
      refine ⟨k + 1, by omega, ?_, ?_, ?_⟩
      · rw [lsettle, if_neg hstop, heq, iter_succ]
      · intro j hj
        cases j with
        | zero => exact Bool.not_eq_true _ ▸ hstop
        | succ j => rw [iter_succ]; exact hbelow j (by omega)
      · rcases hend with h | h
        · exact .inl (by rw [iter_succ]; exact h)
        · exact .inr (by omega)

/-- **Lazy = eager.** If `t`'s stop is reachable within the fuel, the
settle call lands exactly on the trajectory's first stop state — the
eager run's post-break state — and that state is stopped. -/
theorem lsettle_eq_iter {g : Graph} {maxR t : Nat} {fuel : Nat} {s : LState}
    {k : Nat} (hk : k ≤ fuel) (hstop : stopAt t (iter g maxR k s) = true) :
    ∃ K ≤ k, lsettle g maxR t fuel s = iter g maxR K s ∧
      stopAt t (iter g maxR K s) = true ∧
      (∀ j < K, stopAt t (iter g maxR j s) = false) := by
  obtain ⟨K, hKf, heq, hbelow, hend⟩ := lsettle_spec g maxR t fuel s
  have hKk : K ≤ k := by
    rcases Nat.lt_or_ge k K with hlt | hge
    · have hfalse := hbelow k hlt
      rw [hstop] at hfalse
      cases hfalse
    · exact hge
  rcases hend with h | h
  · exact ⟨K, hKk, heq, h, hbelow⟩
  · -- Fuel exit: but the stop at k ≤ fuel = K forces K = k, stopped.
    have hKeq : K = k := by omega
    exact ⟨K, hKk, heq, by rw [hKeq]; exact hstop, hbelow⟩

/-- Settling from a later trajectory point reaches `iter (max m K)`:
either the stop already happened (`K ≤ m`, pause immediately) or the
search continues to the same global first stop. -/
theorem lsettle_from_iter {g : Graph} {maxR t : Nat} {fuel m K : Nat} {s : LState}
    (hKf : K ≤ fuel) (hstop : stopAt t (iter g maxR K s) = true)
    (hmin : ∀ j < K, stopAt t (iter g maxR j s) = false) :
    lsettle g maxR t fuel (iter g maxR m s) = iter g maxR (Nat.max m K) s := by
  by_cases hle : K ≤ m
  · -- Already stopped at m: the settle pauses instantly.
    have hsm : stopAt t (iter g maxR m s) = true := stopAt_iter_mono hstop hle
    have hmk : Nat.max m K = m := Nat.max_eq_left hle
    rw [hmk]
    cases fuel with
    | zero => rfl
    | succ fuel => rw [lsettle, if_pos hsm]
  · -- Still short of the stop: continue exactly K − m more steps.
    have hstop' : stopAt t (iter g maxR (K - m) (iter g maxR m s)) = true := by
      rw [← iter_add]
      rw [show m + (K - m) = K by omega]
      exact hstop
    obtain ⟨K', hK', heq, hstop'', hbelow⟩ :=
      lsettle_eq_iter (fuel := fuel) (k := K - m) (by omega) hstop'
    have hexact : K' = K - m := by
      rcases Nat.lt_or_ge K' (K - m) with hlt | hge
      · have hf := hmin (m + K') (by omega)
        rw [iter_add] at hf
        rw [hf] at hstop''
        cases hstop''
      · omega
    subst hexact
    rw [heq, ← iter_add]
    have hmk : Nat.max m K = K := Nat.max_eq_right (by omega : m ≤ K)
    rw [show m + (K - m) = K by omega, hmk]

/-- **Settles commute.** Any interleaving of settle calls for targets
whose stops are fuel-reachable lands on the same state — the trajectory
point at the larger first-stop index. Pausing order is irrelevant, which
is what makes the per-source memoised cache sound. -/
theorem lsettle_comm {g : Graph} {maxR t₁ t₂ : Nat} {fuel k₁ k₂ : Nat} {s : LState}
    (h₁f : k₁ ≤ fuel) (h₁ : stopAt t₁ (iter g maxR k₁ s) = true)
    (h₂f : k₂ ≤ fuel) (h₂ : stopAt t₂ (iter g maxR k₂ s) = true) :
    lsettle g maxR t₂ fuel (lsettle g maxR t₁ fuel s) =
      lsettle g maxR t₁ fuel (lsettle g maxR t₂ fuel s) := by
  obtain ⟨K₁, hK₁k, heq₁, hstop₁, hmin₁⟩ := lsettle_eq_iter h₁f h₁
  obtain ⟨K₂, hK₂k, heq₂, hstop₂, hmin₂⟩ := lsettle_eq_iter h₂f h₂
  have e₂ := lsettle_from_iter (t := t₂) (fuel := fuel) (m := K₁) (K := K₂) (s := s)
    (by omega) hstop₂ hmin₂
  have e₁ := lsettle_from_iter (t := t₁) (fuel := fuel) (m := K₂) (K := K₁) (s := s)
    (by omega) hstop₁ hmin₁
  have hmx : Nat.max K₁ K₂ = Nat.max K₂ K₁ := Nat.max_comm K₁ K₂
  rw [heq₁, heq₂, e₂, e₁, hmx]

/-- Settling twice is settling once. -/
theorem lsettle_idem {g : Graph} {maxR t : Nat} {fuel k : Nat} {s : LState}
    (hkf : k ≤ fuel) (hstop : stopAt t (iter g maxR k s) = true) :
    lsettle g maxR t fuel (lsettle g maxR t fuel s) = lsettle g maxR t fuel s := by
  obtain ⟨K, hKk, heq, hstop', hmin⟩ := lsettle_eq_iter hkf hstop
  have e := lsettle_from_iter (t := t) (fuel := fuel) (m := K) (K := K) (s := s)
    (by omega) hstop' hmin
  have hmx : Nat.max K K = K := Nat.max_self K
  rw [heq, e, hmx]

/-! ## Executable pinning of the unproved halves

Seeded random graphs: interleavings agree (also covered by the theorems —
a live cross-check), and the *frozen* claim the theorems deliberately do
not prove — a settled vertex's `dist`/`prev` equal the fully-exhausted
run's — holds on every instance, radius cutoffs included. -/

private def lcg (s : Nat) : Nat := (s * 1103515245 + 12345) % 2147483648

def mkG (seed n m : Nat) : Graph := Id.run do
  let mut adj : Array (Array (Nat × Nat)) := Array.replicate n #[]
  let mut s := lcg (seed + 1)
  for _ in [0:m] do
    let a := s % n
    s := lcg s
    let b := s % n
    s := lcg s
    let w := s % 1000 + 1
    s := lcg s
    if a ≠ b then
      adj := adj.setIfInBounds a ((adj.getD a #[]).push (b, w))
      adj := adj.setIfInBounds b ((adj.getD b #[]).push (a, w))
  return ⟨adj⟩

/-- Settled reads match the exhausted run — the pinned frozen claim. -/
private def checkFrozen (seed n m maxR src : Nat) : Bool := Id.run do
  let g := mkG seed n m
  let fuel := 4 * m + n + 2
  let full := iter g maxR fuel (linit n src)
  for t in [0:n] do
    let st := lsettle g maxR t fuel (linit n src)
    if st.done.getD t false then
      if st.dist.getD t none != full.dist.getD t none then return false
      if st.prev.getD t 0 != full.prev.getD t 0 then return false
  return true

/-- All settle interleavings of three targets agree. -/
private def checkComm (seed n m maxR src a b c : Nat) : Bool :=
  let g := mkG seed n m
  let fuel := 4 * m + n + 2
  let s0 := linit n src
  let go (ts : List Nat) : LState := ts.foldl (fun s t => lsettle g maxR t fuel s) s0
  (go [a, b, c] == go [c, b, a]) && (go [a, b, c] == go [b, a, c]) &&
    (go [a, b, c] == go [a, b, c, a, b, c])

#guard (List.range 6).all fun seed => checkFrozen seed 7 12 100000 (seed % 7)
#guard (List.range 6).all fun seed => checkFrozen seed 7 12 800 (seed % 7)   -- radius bites
#guard (List.range 6).all fun seed => checkFrozen seed 5 4 100000 0          -- disconnection
#guard (List.range 4).all fun seed => checkComm seed 7 12 100000 (seed % 7) 1 4 6
#guard (List.range 4).all fun seed => checkComm seed 7 12 900 (seed % 7) 6 2 0
#guard (List.range 4).all fun seed => checkComm seed 5 4 100000 1 0 2 4

end Verified.Geo
