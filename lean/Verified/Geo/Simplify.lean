/-!
# `simplifyPath`'s Douglas-Peucker guarantee — the display-pass layer, part 1

`src/geo/map-match-core.ts` cleans a matched walk polyline with a pipeline
of display passes. `simplifyPath` is the one whose *guarantee* is
load-bearing: `spliceRouteDetail` (#369) restores way geometry exactly
where a chord deviates within `(DETAIL_TOLERANCE_M, simplifyDropM]`, and
its correctness argument is "a chord over simplify-dropped geometry
deviates at most the simplify tolerance (the Douglas-Peucker guarantee),
while a chord over a deliberate excision deviates beyond it — that is why
simplify had kept the excised vertices". This file makes the guarantee a
theorem: `simplifyIdx_dropped_le` — every dropped vertex lies within the
tolerance of the retained chord spanning it.

The pass layer is purely combinatorial over two primitives (point↔point
and point↔chord distance), so everything here is *parametric over the
metric*: `cd p a b` is the distance from `p` to the chord `a`–`b` in any
fixed-point scale, and the theorems hold for whatever arithmetic
substrate instantiates them — no float is modelled, and no metric axioms
are needed (the guarantee is a statement about the recursion, true for
an arbitrary `cd`). The quantised integer primitives arrive in a later
V4 slice; toy `#guard`s pin the keep-set behaviour meanwhile.

Mirroring notes vs the TS `simplifyPath`:
- The TS explicit stack processes segments LIFO, but each segment's
  outcome depends only on its own endpoints, so the recursive form here
  computes the same keep set (the TS↔Lean harness twin will mirror the
  recursive form and the fixture corpus pins the stack form against it).
- The TS `maxd` starts at `-1` and updates on strict `>`; here it starts
  at `0` over `Nat`. The split index is consumed only under
  `tol < maxd` (with `tol : Nat`), where both versions have taken the
  same first-argmax updates from the first positive deviation on, so
  the decisions agree.
- The TS `idx > 0` guard is vacuous (any updated index is `≥ a + 1 ≥ 1`)
  and has no counterpart here.
-/

namespace Verified.Geo

variable {π : Type} {α : Type}

/-- Consecutive pairs of a list: `adjPairs [x, y, z] = [(x, y), (y, z)]`.
The retained chords of a simplified polyline are the `adjPairs` of its
kept-index list. -/
def adjPairs : List α → List (α × α)
  | x :: y :: rest => (x, y) :: adjPairs (y :: rest)
  | _ => []

/-- `adjPairs` splits at any interior element: the chords of a chain
through `y` are the chords up to `y` plus the chords from `y`. -/
theorem adjPairs_append : ∀ (xs : List α) (y : α) (ys : List α),
    adjPairs (xs ++ y :: ys) = adjPairs (xs ++ [y]) ++ adjPairs (y :: ys)
  | [], _, _ => rfl
  | [_], _, _ => rfl
  | x :: z :: xs, y, ys => by
    show (x, z) :: adjPairs ((z :: xs) ++ y :: ys)
       = (x, z) :: (adjPairs ((z :: xs) ++ [y]) ++ adjPairs (y :: ys))
    exact congrArg (List.cons (x, z)) (adjPairs_append (z :: xs) y ys)

/-- Appending one element extends the chords by exactly the final pair
(stated over an explicit last element to avoid `getLast?`). -/
theorem adjPairs_concat : ∀ (front : List α) (last a : α),
    adjPairs ((front ++ [last]) ++ [a]) = adjPairs (front ++ [last]) ++ [(last, a)]
  | [], _, _ => rfl
  | [_], _, _ => rfl
  | x :: z :: front, last, a => by
    show (x, z) :: adjPairs (((z :: front) ++ [last]) ++ [a])
       = (x, z) :: (adjPairs ((z :: front) ++ [last]) ++ [(last, a)])
    exact congrArg (List.cons (x, z)) (adjPairs_concat (z :: front) last a)

/-- First-argmax scan of the chord deviation `cd (pts i) (pts a) (pts b)`
over `i ∈ [i₀, b)` — the TS `for (i = a+1; i < b; i++) if (d > maxd)`
loop, carried as `(maxd, idx)`. -/
def devScan (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat) :
    Nat → Nat × Nat → Nat × Nat
  | i, best =>
    if _h : i < b then
      devScan cd pts a b (i + 1)
        (if best.1 < cd (pts i) (pts a) (pts b)
         then (cd (pts i) (pts a) (pts b), i) else best)
    else best
  termination_by i _ => b - i
  decreasing_by omega

/-- The running maximum never decreases. -/
theorem devScan_ge (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat) :
    ∀ (i : Nat) (best : Nat × Nat), best.1 ≤ (devScan cd pts a b i best).1
  | i, best => by
    unfold devScan
    split
    next _h =>
      refine Nat.le_trans ?_ (devScan_ge cd pts a b (i + 1) _)
      split
      next hlt => exact Nat.le_of_lt hlt
      next => exact Nat.le_refl _
    next => exact Nat.le_refl _
  termination_by i _ => b - i
  decreasing_by omega

/-- Every scanned deviation is bounded by the scan result. -/
theorem devScan_bound (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat) :
    ∀ (i : Nat) (best : Nat × Nat) (j : Nat), i ≤ j → j < b →
      cd (pts j) (pts a) (pts b) ≤ (devScan cd pts a b i best).1
  | i, best, j, hij, hjb => by
    unfold devScan
    split
    next _h =>
      rcases Nat.lt_or_ge i j with hlt | hge
      · exact devScan_bound cd pts a b (i + 1) _ j hlt hjb
      · have hji : j = i := Nat.le_antisymm hge hij
        subst hji
        refine Nat.le_trans ?_ (devScan_ge cd pts a b (j + 1) _)
        split
        next => exact Nat.le_refl _
        next hnlt => exact Nat.le_of_not_lt hnlt
    next => omega
  termination_by i _ _ _ _ => b - i
  decreasing_by omega

/-- The scan either returns `best` untouched or an attained deviation at
an index inside the scanned range. -/
theorem devScan_cases (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat) :
    ∀ (i : Nat) (best : Nat × Nat),
      devScan cd pts a b i best = best ∨
      ∃ k, i ≤ k ∧ k < b ∧
        devScan cd pts a b i best = (cd (pts k) (pts a) (pts b), k)
  | i, best => by
    unfold devScan
    split
    next _h =>
      split
      next =>
        rcases devScan_cases cd pts a b (i + 1) (cd (pts i) (pts a) (pts b), i)
          with hc | ⟨k, hk1, hk2, hk3⟩
        · exact Or.inr ⟨i, Nat.le_refl _, _h, hc⟩
        · exact Or.inr ⟨k, by omega, hk2, hk3⟩
      next =>
        rcases devScan_cases cd pts a b (i + 1) best with hc | ⟨k, hk1, hk2, hk3⟩
        · exact Or.inl hc
        · exact Or.inr ⟨k, by omega, hk2, hk3⟩
    next => exact Or.inl rfl
  termination_by i _ => b - i
  decreasing_by all_goals omega

/-- The TS `(maxd, idx)` over the interior of `(a, b)`. -/
def maxDev (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat) : Nat × Nat :=
  devScan cd pts a b (a + 1) (0, 0)

/-- Every interior deviation is bounded by `maxd`. -/
theorem maxDev_bound (cd : π → π → π → Nat) (pts : Nat → π) (a b : Nat)
    {j : Nat} (hj1 : a < j) (hj2 : j < b) :
    cd (pts j) (pts a) (pts b) ≤ (maxDev cd pts a b).1 :=
  devScan_bound cd pts a b (a + 1) (0, 0) j hj1 hj2

/-- When `maxd` clears a (nonnegative) tolerance, the split index is
strictly interior. -/
theorem maxDev_split (cd : π → π → π → Nat) (pts : Nat → π) {a b tol : Nat}
    (h : tol < (maxDev cd pts a b).1) :
    a < (maxDev cd pts a b).2 ∧ (maxDev cd pts a b).2 < b := by
  rcases devScan_cases cd pts a b (a + 1) (0, 0) with hc | ⟨k, hk1, hk2, hk3⟩
  · rw [maxDev, hc] at h
    exact absurd h (by omega)
  · rw [maxDev, hk3]
    exact ⟨hk1, hk2⟩

/-- The Douglas-Peucker keep set strictly between `a` and `b`: split at
the max-deviation index while it exceeds `tol`, else drop the whole
interior. Fuel `≥ b - a` always suffices (each split index is strictly
interior). The TS stack form computes the same set — segment outcomes
depend only on their own endpoints, so processing order is irrelevant. -/
def keepBetween (cd : π → π → π → Nat) (pts : Nat → π) (tol : Nat) :
    Nat → Nat → Nat → List Nat
  | 0, _, _ => []
  | fuel + 1, a, b =>
    if tol < (maxDev cd pts a b).1 then
      keepBetween cd pts tol fuel a (maxDev cd pts a b).2
        ++ (maxDev cd pts a b).2 :: keepBetween cd pts tol fuel (maxDev cd pts a b).2 b
    else []

/-- Kept indices are strictly interior. -/
theorem keepBetween_mem (cd : π → π → π → Nat) (pts : Nat → π) (tol : Nat) :
    ∀ (fuel : Nat) {a b : Nat}, ∀ x ∈ keepBetween cd pts tol fuel a b,
      a < x ∧ x < b := by
  intro fuel
  induction fuel with
  | zero => intro a b x hx; exact absurd hx (by simp [keepBetween])
  | succ fuel ih =>
    intro a b x hx
    simp only [keepBetween] at hx
    split at hx
    next hlt =>
      obtain ⟨hka, hkb⟩ := maxDev_split cd pts hlt
      rcases List.mem_append.mp hx with hL | hR
      · have := ih x hL
        omega
      · rcases List.mem_cons.mp hR with rfl | hR'
        · omega
        · have := ih x hR'
          omega
    next => exact absurd hx (by simp)

/-- Every retained chord of the keep-set chain is increasing and bounds
its interior deviations by `tol` — the recursion invariant behind the
Douglas-Peucker guarantee. -/
theorem keepBetween_guarantee (cd : π → π → π → Nat) (pts : Nat → π) (tol : Nat) :
    ∀ (fuel : Nat) {a b : Nat}, b - a ≤ fuel → a < b →
      ∀ p ∈ adjPairs (a :: keepBetween cd pts tol fuel a b ++ [b]),
        p.1 < p.2 ∧ ∀ j, p.1 < j → j < p.2 →
          cd (pts j) (pts p.1) (pts p.2) ≤ tol := by
  intro fuel
  induction fuel with
  | zero => intro a b hf hab; exact absurd hab (by omega)
  | succ fuel ih =>
    intro a b hf hab p hp
    simp only [keepBetween] at hp
    split at hp
    next hlt =>
      obtain ⟨hka, hkb⟩ := maxDev_split cd pts hlt
      rw [show a :: (keepBetween cd pts tol fuel a (maxDev cd pts a b).2
              ++ (maxDev cd pts a b).2
                :: keepBetween cd pts tol fuel (maxDev cd pts a b).2 b) ++ [b]
            = (a :: keepBetween cd pts tol fuel a (maxDev cd pts a b).2)
              ++ (maxDev cd pts a b).2
                :: (keepBetween cd pts tol fuel (maxDev cd pts a b).2 b ++ [b])
          from by simp, adjPairs_append] at hp
      rcases List.mem_append.mp hp with hL | hR
      · exact ih (by omega) hka p hL
      · exact ih (by omega) hkb p hR
    next hge =>
      have hpe : p = (a, b) := by simpa [adjPairs] using hp
      subst hpe
      exact ⟨hab, fun j hj1 hj2 =>
        Nat.le_trans (maxDev_bound cd pts a b hj1 hj2) (Nat.le_of_not_lt hge)⟩

/-- Every dropped interior index lies strictly between some retained
chord's endpoints. -/
theorem keepBetween_cover (cd : π → π → π → Nat) (pts : Nat → π) (tol : Nat) :
    ∀ (fuel : Nat) {a b : Nat}, b - a ≤ fuel → a < b →
      ∀ j, a < j → j < b → j ∉ keepBetween cd pts tol fuel a b →
        ∃ p ∈ adjPairs (a :: keepBetween cd pts tol fuel a b ++ [b]),
          p.1 < j ∧ j < p.2 := by
  intro fuel
  induction fuel with
  | zero => intro a b hf hab; exact absurd hab (by omega)
  | succ fuel ih =>
    intro a b hf hab j hj1 hj2 hnot
    simp only [keepBetween] at hnot ⊢
    by_cases hlt : tol < (maxDev cd pts a b).1
    · rw [if_pos hlt] at hnot ⊢
      obtain ⟨hka, hkb⟩ := maxDev_split cd pts hlt
      simp only [List.mem_append, List.mem_cons, not_or] at hnot
      obtain ⟨hjL, hjk, hjR⟩ := hnot
      have hsplit : a :: (keepBetween cd pts tol fuel a (maxDev cd pts a b).2
              ++ (maxDev cd pts a b).2
                :: keepBetween cd pts tol fuel (maxDev cd pts a b).2 b) ++ [b]
            = (a :: keepBetween cd pts tol fuel a (maxDev cd pts a b).2)
              ++ (maxDev cd pts a b).2
                :: (keepBetween cd pts tol fuel (maxDev cd pts a b).2 b ++ [b]) := by
        simp
      rcases Nat.lt_or_ge j (maxDev cd pts a b).2 with hjlt | hjge
      · obtain ⟨p, hp, hp1, hp2⟩ :=
          ih (a := a) (b := (maxDev cd pts a b).2) (by omega) hka j hj1 hjlt hjL
        refine ⟨p, ?_, hp1, hp2⟩
        rw [hsplit, adjPairs_append]
        exact List.mem_append_left _ hp
      · have hjk' : (maxDev cd pts a b).2 < j := by omega
        obtain ⟨p, hp, hp1, hp2⟩ :=
          ih (a := (maxDev cd pts a b).2) (b := b) (by omega) hkb j hjk' hj2 hjR
        refine ⟨p, ?_, hp1, hp2⟩
        rw [hsplit, adjPairs_append]
        exact List.mem_append_right _ hp
    · rw [if_neg hlt] at hnot ⊢
      exact ⟨(a, b), by simp [adjPairs], hj1, hj2⟩

/-- Kept indices of the TS `simplifyPath` over `n` points: endpoints plus
the Douglas-Peucker keep set (`≤ 2` points are returned unchanged). The
polyline itself is recovered by mapping `pts` over this list; keeping the
index level makes the drop/keep statements direct. -/
def simplifyIdx (cd : π → π → π → Nat) (pts : Nat → π) (n tol : Nat) : List Nat :=
  if n ≤ 2 then List.range n
  else 0 :: keepBetween cd pts tol (n - 1) 0 (n - 1) ++ [n - 1]

/-- Every kept index is in range. -/
theorem simplifyIdx_mem (cd : π → π → π → Nat) (pts : Nat → π) {n tol : Nat} :
    ∀ x ∈ simplifyIdx cd pts n tol, x < n := by
  intro x hx
  unfold simplifyIdx at hx
  by_cases hn : n ≤ 2
  · rw [if_pos hn] at hx
    exact List.mem_range.mp hx
  · rw [if_neg hn] at hx
    rcases List.mem_cons.mp hx with rfl | hx'
    · omega
    · rcases List.mem_append.mp hx' with hK | hE
      · have := keepBetween_mem cd pts tol (n - 1) x hK
        omega
      · have : x = n - 1 := by simpa using hE
        omega

/-- The endpoints always survive. -/
theorem simplifyIdx_endpoints (cd : π → π → π → Nat) (pts : Nat → π)
    {n tol : Nat} (hn : 1 ≤ n) :
    0 ∈ simplifyIdx cd pts n tol ∧ (n - 1) ∈ simplifyIdx cd pts n tol := by
  unfold simplifyIdx
  by_cases h2 : n ≤ 2
  · rw [if_pos h2]
    exact ⟨List.mem_range.mpr (by omega), List.mem_range.mpr (by omega)⟩
  · rw [if_neg h2]
    exact ⟨List.mem_cons_self .., List.mem_cons_of_mem _ (List.mem_append_right _ (by simp))⟩

/-- **The Douglas-Peucker guarantee** — #369's load-bearing bound, as a
theorem: every vertex `simplifyPath` drops lies within `tol` of the
retained chord spanning it (and strictly between that chord's endpoint
indices). This is the exact fact `spliceRouteDetail`'s comment-proof
cites to separate simplify-flattened curves (deviation `≤ tol`,
restorable) from deliberate artifact excisions (deviation `> tol`,
which simplify would have kept — so their absence is someone else's
decision and stays). -/
theorem simplifyIdx_dropped_le (cd : π → π → π → Nat) (pts : Nat → π)
    {n tol j : Nat} (hj : j < n) (hdrop : j ∉ simplifyIdx cd pts n tol) :
    ∃ p ∈ adjPairs (simplifyIdx cd pts n tol),
      p.1 < j ∧ j < p.2 ∧ cd (pts j) (pts p.1) (pts p.2) ≤ tol := by
  unfold simplifyIdx at hdrop ⊢
  by_cases hn : n ≤ 2
  · rw [if_pos hn] at hdrop
    exact absurd (List.mem_range.mpr hj) hdrop
  · rw [if_neg hn] at hdrop ⊢
    have hj0 : j ≠ 0 := fun h => hdrop (h ▸ List.mem_cons_self ..)
    have hjn : j ≠ n - 1 := fun h =>
      hdrop (List.mem_cons_of_mem _ (List.mem_append_right _ (by simp [h])))
    have hjK : j ∉ keepBetween cd pts tol (n - 1) 0 (n - 1) := fun h =>
      hdrop (List.mem_cons_of_mem _ (List.mem_append_left _ h))
    obtain ⟨p, hp, hp1, hp2⟩ :=
      keepBetween_cover cd pts tol (n - 1) (a := 0) (b := n - 1)
        (by omega) (by omega) j (by omega) (by omega) hjK
    obtain ⟨-, hbound⟩ :=
      keepBetween_guarantee cd pts tol (n - 1) (a := 0) (b := n - 1)
        (by omega) (by omega) p hp
    exact ⟨p, hp, hp1, hp2, hbound j hp1 hp2⟩

/-- Every retained chord is increasing, so the kept-index list is an
ascending chain from `0` to `n - 1`. -/
theorem simplifyIdx_chords_lt (cd : π → π → π → Nat) (pts : Nat → π)
    {n tol : Nat} (hn : 2 < n) :
    ∀ p ∈ adjPairs (simplifyIdx cd pts n tol), p.1 < p.2 := by
  intro p hp
  unfold simplifyIdx at hp
  rw [if_neg (by omega)] at hp
  exact (keepBetween_guarantee cd pts tol (n - 1) (a := 0) (b := n - 1)
    (by omega) (by omega) p hp).1

-- Smoke tests: a flat 5-point line with one bump at index 2 under a toy
-- axis-aligned deviation (the theorems are metric-free; the real
-- quantised metric instantiates these in a later slice).
private def toyCd (p a b : Int × Int) : Nat :=
  if a.2 = b.2 then (p.2 - a.2).natAbs else 0

private def toyPts (i : Nat) : Int × Int :=
  match i with
  | 0 => (0, 0)
  | 1 => (1, 0)
  | 2 => (2, 5)
  | 3 => (3, 0)
  | _ => (4, 0)

#guard adjPairs [1, 2, 3] == [(1, 2), (2, 3)]
#guard simplifyIdx toyCd toyPts 5 1 == [0, 2, 4]
#guard simplifyIdx toyCd toyPts 5 10 == [0, 4]
#guard simplifyIdx toyCd toyPts 2 0 == [0, 1]

end Verified.Geo
