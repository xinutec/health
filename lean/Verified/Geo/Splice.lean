/-!
# `spliceRouteDetail` (#369) — the display-pass layer, part 2

The pass that fixed #369: for each chord of the cleaned `coarse` line,
re-insert the assembled route's vertices between the chord's endpoints
when the route curves away from the chord by more than the detail
tolerance but no more than the simplify tolerance. Together with
`Simplify.lean`'s Douglas-Peucker guarantee this is the whole #369
argument: simplify-flattened curves deviate `≤ simplifyDropM` (so they
are restorable — and get restored), while deliberate excisions (spur
removal, over-route trim, despiked apexes) deviate beyond it and stay
excised.

Like `Simplify.lean`, everything is parametric over the metric and the
point type: `cd` is chord deviation, `same` is the TS `1e-9` coordinate
match (exact equality once quantised), `near` is the `< 0.5 m` dedupe
check, and `clampTs a b v` is `v` with its timestamp clamped into the
chord window (the TS `min(max(ts, a.ts), b.ts)`) — all supplied by the
eventual arithmetic substrate, none needed for the theorems here.

The insertion loop threads `prev` (the last emitted vertex) explicitly;
the TS reads it back as `out[out.length - 1]`, which is the same value —
the previous coarse vertex at window start (its chord's `a`), then the
last inserted vertex.

Theorems:
- `splice_sound`: every output vertex is either a coarse vertex or a
  route vertex (timestamp-clamped to its chord window) whose deviation
  from its chord is `≤ dropM` — inserted only through a window whose
  guard cleared, so a `> dropM` excision window inserts nothing.
- `splice_coarse_sublist`: the coarse line survives in order — the pass
  only inserts, never drops or reorders, so every decision layer keeps
  consuming exactly the tuned coarse geometry.
-/

namespace Verified.Geo

variable {π : Type}

/-- First route index `≥ k` whose point matches `p` (the TS `indexOf`
scan; `same` is the coordinate match). -/
def indexFrom (same : π → π → Bool) (route : Nat → π) (m : Nat) (p : π)
    (k : Nat) : Option Nat :=
  if _h : k < m then
    if same (route k) p then some k else indexFrom same route m p (k + 1)
  else none
termination_by m - k

/-- A found index is in range. -/
theorem indexFrom_lt (same : π → π → Bool) (route : Nat → π) (m : Nat) (p : π) :
    ∀ (k : Nat) {j : Nat}, indexFrom same route m p k = some j → j < m
  | k, j, h => by
    unfold indexFrom at h
    split at h
    next _h =>
      split at h
      next => exact (Option.some.inj h) ▸ _h
      next => exact indexFrom_lt same route m p (k + 1) h
    next => nomatch h
  termination_by k => m - k
  decreasing_by omega

/-- Running maximum of `cd (route k) a b` over `k ∈ [k₀, stop)` — the TS
window-deviation loop. -/
def winDev (cd : π → π → π → Nat) (a b : π) (route : Nat → π)
    (stop k best : Nat) : Nat :=
  if _h : k < stop then
    winDev cd a b route stop (k + 1) (Nat.max best (cd (route k) a b))
  else best
termination_by stop - k

/-- The running maximum never decreases. -/
theorem winDev_ge (cd : π → π → π → Nat) (a b : π) (route : Nat → π)
    (stop : Nat) : ∀ (k best : Nat), best ≤ winDev cd a b route stop k best
  | k, best => by
    unfold winDev
    split
    next _h =>
      exact Nat.le_trans (Nat.le_max_left _ _)
        (winDev_ge cd a b route stop (k + 1) _)
    next => exact Nat.le_refl _
  termination_by k _ => stop - k
  decreasing_by omega

/-- Every scanned deviation is bounded by the window maximum. -/
theorem winDev_bound (cd : π → π → π → Nat) (a b : π) (route : Nat → π)
    (stop : Nat) : ∀ (k best j : Nat), k ≤ j → j < stop →
      cd (route j) a b ≤ winDev cd a b route stop k best
  | k, best, j, hkj, hjs => by
    unfold winDev
    split
    next _h =>
      rcases Nat.lt_or_ge k j with hlt | hge
      · exact winDev_bound cd a b route stop (k + 1) _ j hlt hjs
      · have hjk : j = k := Nat.le_antisymm hge hkj
        subst hjk
        exact Nat.le_trans (Nat.le_max_right _ _)
          (winDev_ge cd a b route stop (j + 1) _)
    next => omega
  termination_by k _ _ _ _ => stop - k
  decreasing_by omega

/-- Insert the window's route vertices (timestamp-clamped by `clamp`)
onto the reversed output, skipping any `near` the previously-emitted
vertex `prev` — the TS insertion loop, with `acc` as the reversed
`out`. -/
def insWin (near : π → π → Bool) (clamp : π → π) (route : Nat → π)
    (stop k : Nat) (prev : π) (acc : List π) : List π :=
  if _h : k < stop then
    if near prev (route k) then
      insWin near clamp route stop (k + 1) prev acc
    else
      insWin near clamp route stop (k + 1) (clamp (route k))
        (clamp (route k) :: acc)
  else acc
termination_by stop - k

/-- Everything `insWin` emits is either already in `acc` or a clamped
route vertex from the window. -/
theorem insWin_mem (near : π → π → Bool) (clamp : π → π) (route : Nat → π)
    (stop : Nat) : ∀ (k : Nat) (prev : π) (acc : List π) (v : π),
      v ∈ insWin near clamp route stop k prev acc →
      v ∈ acc ∨ ∃ j, k ≤ j ∧ j < stop ∧ v = clamp (route j)
  | k, prev, acc, v, hv => by
    unfold insWin at hv
    split at hv
    next _h =>
      split at hv
      next =>
        rcases insWin_mem near clamp route stop (k + 1) prev acc v hv
          with hin | ⟨j, hj1, hj2, hj3⟩
        · exact Or.inl hin
        · exact Or.inr ⟨j, by omega, hj2, hj3⟩
      next =>
        rcases insWin_mem near clamp route stop (k + 1) (clamp (route k))
          (clamp (route k) :: acc) v hv with hin | ⟨j, hj1, hj2, hj3⟩
        · rcases List.mem_cons.mp hin with rfl | hin'
          · exact Or.inr ⟨k, Nat.le_refl _, _h, rfl⟩
          · exact Or.inl hin'
        · exact Or.inr ⟨j, by omega, hj2, hj3⟩
    next => exact Or.inl hv
  termination_by k _ _ _ _ => stop - k
  decreasing_by all_goals omega

/-- `insWin` only prepends: the incoming reversed output survives. -/
theorem insWin_sublist (near : π → π → Bool) (clamp : π → π) (route : Nat → π)
    (stop : Nat) : ∀ (k : Nat) (prev : π) (acc : List π),
      acc.Sublist (insWin near clamp route stop k prev acc)
  | k, prev, acc => by
    unfold insWin
    split
    next _h =>
      split
      next => exact insWin_sublist near clamp route stop (k + 1) prev acc
      next =>
        exact List.Sublist.trans (List.sublist_cons_self _ _)
          (insWin_sublist near clamp route stop (k + 1) _ _)
    next => exact List.Sublist.refl _
  termination_by k _ _ => stop - k
  decreasing_by all_goals omega

/-- One chord's insertion step: find the window, check the deviation
guard, insert — the TS `if (ia >= 0 && ib > ia + 1) {...}` body. `a` is
the previously-emitted coarse vertex, so it seeds `prev`. -/
def insChord (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (a b : π) (ia : Option Nat) (acc : List π) : List π :=
  match ia with
  | none => acc
  | some ja =>
    match indexFrom same route m b (ja + 1) with
    | none => acc
    | some jb =>
      if ja + 1 < jb ∧ tol < winDev cd a b route jb (ja + 1) 0 ∧
          winDev cd a b route jb (ja + 1) 0 ≤ dropM then
        insWin near (clampTs a b) route jb (ja + 1) a acc
      else acc

/-- Everything `insChord` emits is either already in `acc` or a clamped
route vertex within `dropM` of the chord. -/
theorem insChord_mem (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (a b : π) (ia : Option Nat) (acc : List π) (v : π)
    (hv : v ∈ insChord cd same near clampTs route m tol dropM a b ia acc) :
    v ∈ acc ∨ ∃ j, j < m ∧ v = clampTs a b (route j) ∧
      cd (route j) a b ≤ dropM := by
  unfold insChord at hv
  split at hv
  next => exact Or.inl hv
  next ja =>
    split at hv
    next => exact Or.inl hv
    next jb hib =>
      split at hv
      next hg =>
        rcases insWin_mem near (clampTs a b) route jb (ja + 1) a acc v hv
          with hin | ⟨j, hj1, hj2, hj3⟩
        · exact Or.inl hin
        · refine Or.inr ⟨j, ?_, hj3, ?_⟩
          · exact Nat.lt_trans hj2 (indexFrom_lt same route m b (ja + 1) hib)
          · exact Nat.le_trans (winDev_bound cd a b route jb (ja + 1) 0 j hj1 hj2)
              hg.2.2
      next => exact Or.inl hv

/-- `insChord` only prepends. -/
theorem insChord_sublist (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (a b : π) (ia : Option Nat) (acc : List π) :
    acc.Sublist (insChord cd same near clampTs route m tol dropM a b ia acc) := by
  unfold insChord
  split
  next => exact List.Sublist.refl _
  next ja =>
    split
    next => exact List.Sublist.refl _
    next jb _ =>
      split
      next => exact insWin_sublist near (clampTs a b) route jb (ja + 1) a acc
      next => exact List.Sublist.refl _

/-- The TS `ia` update: the found window end, else a fresh scan from 0. -/
def nextIa (same : π → π → Bool) (route : Nat → π) (m : Nat) (b : π) :
    Option Nat → Option Nat
  | some ja =>
    match indexFrom same route m b (ja + 1) with
    | some jb => some jb
    | none => indexFrom same route m b 0
  | none => indexFrom same route m b 0

/-- The chord loop over `coarse`, `acc` being the reversed output. -/
def spliceLoop (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) (i : Nat) (ia : Option Nat) (acc : List π) :
    List π :=
  if _h : i < n then
    spliceLoop cd same near clampTs route m tol dropM coarse n (i + 1)
      (nextIa same route m (coarse i) ia)
      (coarse i ::
        insChord cd same near clampTs route m tol dropM
          (coarse (i - 1)) (coarse i) ia acc)
  else acc
termination_by n - i

/-- Loop soundness: with a sound `acc`, everything the loop emits is a
coarse vertex or a clamped in-bound route vertex of some chord. -/
theorem spliceLoop_mem (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) :
    ∀ (i : Nat) (ia : Option Nat) (acc : List π), 1 ≤ i →
      (∀ v ∈ acc, (∃ i₀, i₀ < n ∧ v = coarse i₀) ∨
        ∃ i₀ j, 1 ≤ i₀ ∧ i₀ < n ∧ j < m ∧
          v = clampTs (coarse (i₀ - 1)) (coarse i₀) (route j) ∧
          cd (route j) (coarse (i₀ - 1)) (coarse i₀) ≤ dropM) →
      ∀ v ∈ spliceLoop cd same near clampTs route m tol dropM coarse n i ia acc,
        (∃ i₀, i₀ < n ∧ v = coarse i₀) ∨
        ∃ i₀ j, 1 ≤ i₀ ∧ i₀ < n ∧ j < m ∧
          v = clampTs (coarse (i₀ - 1)) (coarse i₀) (route j) ∧
          cd (route j) (coarse (i₀ - 1)) (coarse i₀) ≤ dropM
  | i, ia, acc, hi, hacc, v, hv => by
    unfold spliceLoop at hv
    split at hv
    next _h =>
      refine spliceLoop_mem cd same near clampTs route m tol dropM coarse n
        (i + 1) _ _ (by omega) ?_ v hv
      intro w hw
      rcases List.mem_cons.mp hw with rfl | hw'
      · exact Or.inl ⟨i, _h, rfl⟩
      · rcases insChord_mem cd same near clampTs route m tol dropM
          (coarse (i - 1)) (coarse i) ia acc w hw' with hin | ⟨j, hj1, hj2, hj3⟩
        · exact hacc w hin
        · exact Or.inr ⟨i, j, hi, _h, hj1, hj2, hj3⟩
    next => exact hacc v hv
  termination_by i _ _ _ _ _ _ => n - i
  decreasing_by omega

/-- Loop preserves the coarse prefix as a sublist of the reversed
output. -/
theorem spliceLoop_sublist (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) :
    ∀ (i : Nat) (ia : Option Nat) (acc : List π), i ≤ n →
      (((List.range i).map coarse).reverse).Sublist acc →
      (((List.range n).map coarse).reverse).Sublist
        (spliceLoop cd same near clampTs route m tol dropM coarse n i ia acc)
  | i, ia, acc, hin, hsub => by
    unfold spliceLoop
    split
    next _h =>
      refine spliceLoop_sublist cd same near clampTs route m tol dropM coarse n
        (i + 1) _ _ (by omega) ?_
      have hrange : ((List.range (i + 1)).map coarse).reverse
          = coarse i :: ((List.range i).map coarse).reverse := by
        rw [List.range_succ, List.map_append]
        simp
      rw [hrange]
      exact List.Sublist.cons_cons _ (List.Sublist.trans hsub
        (insChord_sublist cd same near clampTs route m tol dropM
          (coarse (i - 1)) (coarse i) ia acc))
    next =>
      have : i = n := by omega
      subst this
      exact hsub
  termination_by i _ _ _ _ => n - i
  decreasing_by omega

/-- The TS `spliceRouteDetail`, over `n` coarse points and `m` route
points, as a list of points (short inputs are returned unchanged). -/
def splice (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) : List π :=
  if n < 2 ∨ m < 2 then (List.range n).map coarse
  else (spliceLoop cd same near clampTs route m tol dropM coarse n 1
    (indexFrom same route m (coarse 0) 0) [coarse 0]).reverse

/-- **Splice soundness** (#369): every output vertex is a coarse vertex,
or a route vertex — timestamp-clamped into its chord's window — whose
deviation from its chord is at most `dropM`. In particular a window
whose deviation exceeds `dropM` (a deliberate excision) contributes
nothing: what stays out, stays out. -/
theorem splice_sound (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) :
    ∀ v ∈ splice cd same near clampTs route m tol dropM coarse n,
      (∃ i, i < n ∧ v = coarse i) ∨
      ∃ i j, 1 ≤ i ∧ i < n ∧ j < m ∧
        v = clampTs (coarse (i - 1)) (coarse i) (route j) ∧
        cd (route j) (coarse (i - 1)) (coarse i) ≤ dropM := by
  intro v hv
  unfold splice at hv
  split at hv
  next =>
    obtain ⟨i, hi, hvi⟩ := List.mem_map.mp hv
    exact Or.inl ⟨i, List.mem_range.mp hi, hvi.symm⟩
  next hn =>
    refine spliceLoop_mem cd same near clampTs route m tol dropM coarse n
      1 _ _ (Nat.le_refl _) ?_ v (List.mem_reverse.mp hv)
    intro w hw
    have hw0 : w = coarse 0 := by simpa using hw
    exact Or.inl ⟨0, by omega, hw0⟩

/-- **The coarse line survives in order**: splicing only inserts — every
decision layer downstream keeps consuming exactly the tuned coarse
geometry, in its original order. -/
theorem splice_coarse_sublist (cd : π → π → π → Nat) (same near : π → π → Bool)
    (clampTs : π → π → π → π) (route : Nat → π) (m : Nat) (tol dropM : Nat)
    (coarse : Nat → π) (n : Nat) :
    ((List.range n).map coarse).Sublist
      (splice cd same near clampTs route m tol dropM coarse n) := by
  unfold splice
  split
  next => exact List.Sublist.refl _
  next hn =>
    have h1 : (((List.range 1).map coarse).reverse).Sublist [coarse 0] := by
      simp
    have hloop := spliceLoop_sublist cd same near clampTs route m tol dropM
      coarse n 1 (indexFrom same route m (coarse 0) 0) [coarse 0] (by omega) h1
    have hrev := hloop.reverse
    simpa using hrev

-- Smoke tests: a two-point coarse chord over a 5-point route with a
-- 1-unit bulge, under the same toy metric as `Simplify.lean`.
private def toyRoute (i : Nat) : Int × Int :=
  match i with
  | 0 => (0, 0)
  | 1 => (1, 1)
  | 2 => (2, 1)
  | 3 => (3, 1)
  | _ => (4, 0)

private def toyCoarse (i : Nat) : Int × Int :=
  if i = 0 then (0, 0) else (4, 0)

private def toySpliceCd (p a b : Int × Int) : Nat :=
  if a.2 = b.2 then (p.2 - a.2).natAbs else 0

-- tol 0 < bulge 1 ≤ dropM 5: the route detail is restored.
#guard splice toySpliceCd (· == ·) (fun _ _ => false) (fun _ _ v => v) toyRoute 5
    0 5 toyCoarse 2 == [(0, 0), (1, 1), (2, 1), (3, 1), (4, 0)]
-- bulge 1 > dropM 0: a deliberate excision stays excised.
#guard splice toySpliceCd (· == ·) (fun _ _ => false) (fun _ _ v => v) toyRoute 5
    0 0 toyCoarse 2 == [(0, 0), (4, 0)]
-- bulge 1 ≤ tol 1: nothing to restore.
#guard splice toySpliceCd (· == ·) (fun _ _ => false) (fun _ _ v => v) toyRoute 5
    1 5 toyCoarse 2 == [(0, 0), (4, 0)]

end Verified.Geo
