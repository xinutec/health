import Verified.Geo.Simplify
import Verified.Geo.Prefilter

/-!
# Cleaning passes — `dedupeConsecutive`, `removeSpurs`,
# `despikeUnsupportedApexes`

The remaining small display passes of `map-match-core.ts`, ported in the
same metric-parametric style as the rest of the layer (`Simplify.lean`
et al.): the pass logic is combinatorial, the primitives are parameters.

- `dedupe` (TS `dedupeConsecutive`): drop points `near` the last *kept*
  point (the TS `< 0.5 m` test — note *strict* `<`, unlike the trim
  rebuild's `≤`; the instantiations mirror each separately).
- `removeSpurs`: drop dead-end out-and-back excursions — an anchor from
  which the path departs and, within `maxSpan` steps *of the current
  (already-spliced) array*, returns to within `retM`; the farthest
  qualifying return wins (the TS scans `j` downward), and the
  near-duplicate return vertex is dropped with the excursion. The
  recursion here processes the same mutated-suffix view as the TS
  splice loop.
- `despike` (TS `despikeUnsupportedApexes`): drop matched vertices whose
  apex juts off the chord between their *original* neighbours further
  than any raw fix in the same time window did, while nearly doubling
  back. The three tests (apex height, turn angle, raw-fix excess)
  arrive as the parametric `perp`/`turnOk` primitives plus the raw-fix
  window fold; each vertex's verdict depends only on its original
  neighbours, so this is a pure indexed filter.

Theorems: every pass is drop-only (`Sublist` of its input); `dedupe`
additionally guarantees no adjacent output pair is `near` (the same
chain shape as `holdSpeed_chain`), and `despike` keeps both endpoints.
-/

namespace Verified.Geo

variable {π : Type}

/-- The dedupe scan: `acc` is the kept list, `prev` its last element. -/
def dedupeGo (near : π → π → Bool) (pts : Nat → π) (n i : Nat) (prev : π)
    (acc : List π) : List π :=
  if _h : i < n then
    if near prev (pts i) then dedupeGo near pts n (i + 1) prev acc
    else dedupeGo near pts n (i + 1) (pts i) (acc ++ [pts i])
  else acc
termination_by n - i

/-- The TS `dedupeConsecutive` over `n` points. -/
def dedupe (near : π → π → Bool) (pts : Nat → π) (n : Nat) : List π :=
  if n = 0 then [] else dedupeGo near pts n 1 (pts 0) [pts 0]

/-- Chain invariant: no adjacent pair of the deduped output is `near`. -/
theorem dedupeGo_chain (near : π → π → Bool) (pts : Nat → π) (n : Nat) :
    ∀ (i : Nat) (prev : π) (front : List π),
      (∀ p ∈ adjPairs (front ++ [prev]), near p.1 p.2 = false) →
      ∀ p ∈ adjPairs (dedupeGo near pts n i prev (front ++ [prev])),
        near p.1 p.2 = false
  | i, prev, front, hchain, p, hp => by
    unfold dedupeGo at hp
    split at hp
    next _h =>
      split at hp
      next => exact dedupeGo_chain near pts n (i + 1) prev front hchain p hp
      next hok =>
        refine dedupeGo_chain near pts n (i + 1) (pts i) (front ++ [prev]) ?_ p hp
        intro q hq
        rw [adjPairs_concat] at hq
        rcases List.mem_append.mp hq with hq' | hq'
        · exact hchain q hq'
        · obtain rfl : q = (prev, pts i) := by simpa using hq'
          simpa using hok
    next => exact hchain p hp
  termination_by i _ _ _ _ _ => n - i
  decreasing_by all_goals omega

/-- No adjacent pair of the deduped output is `near`. -/
theorem dedupe_chain (near : π → π → Bool) (pts : Nat → π) (n : Nat) :
    ∀ p ∈ adjPairs (dedupe near pts n), near p.1 p.2 = false := by
  intro p hp
  unfold dedupe at hp
  split at hp
  next => exact absurd hp (by simp [adjPairs])
  next => exact dedupeGo_chain near pts n 1 (pts 0) [] (fun _ hq => nomatch hq) p hp

/-- The deduped output is a subsequence of the input. -/
theorem dedupeGo_sublist (near : π → π → Bool) (pts : Nat → π) (n : Nat) :
    ∀ (i : Nat) (prev : π) (acc : List π), i ≤ n →
      acc.Sublist ((List.range i).map pts) →
      (dedupeGo near pts n i prev acc).Sublist ((List.range n).map pts)
  | i, prev, acc, hin, hsub => by
    have hstep : ((List.range i).map pts).Sublist
        ((List.range (i + 1)).map pts) := by
      rw [List.range_succ, List.map_append]
      exact List.sublist_append_left _ _
    unfold dedupeGo
    split
    next _h =>
      split
      next =>
        exact dedupeGo_sublist near pts n (i + 1) _ _ (by omega)
          (List.Sublist.trans hsub hstep)
      next =>
        refine dedupeGo_sublist near pts n (i + 1) _ _ (by omega) ?_
        rw [List.range_succ, List.map_append]
        exact List.Sublist.append hsub (List.Sublist.refl _)
    next =>
      have : i = n := by omega
      subst this
      exact hsub
  termination_by i _ _ _ _ => n - i
  decreasing_by all_goals omega

theorem dedupe_sublist (near : π → π → Bool) (pts : Nat → π) (n : Nat) :
    (dedupe near pts n).Sublist ((List.range n).map pts) := by
  unfold dedupe
  split
  next => exact List.nil_sublist _
  next hn =>
    refine dedupeGo_sublist near pts n 1 (pts 0) [pts 0] (by omega) ?_
    have : (List.range 1).map pts = [pts 0] := by simp
    rw [this]
    exact List.Sublist.refl _

/-- Downward spur scan: the largest `k ∈ [1, k₀]` with
`pd x rest[k] ≤ retM` (the TS inner `j--` loop; `k₀` is already clamped
to the array by the caller). -/
def spurScan (pd : π → π → Nat) (retM : Nat) (x : π) (rest : List π) :
    Nat → Option Nat
  | 0 => none
  | k + 1 =>
    if pd x (rest.getD (k + 1) x) ≤ retM then some (k + 1)
    else spurScan pd retM x rest k

/-- A found return index is a real interior index. -/
theorem spurScan_le (pd : π → π → Nat) (retM : Nat) (x : π) (rest : List π) :
    ∀ (k : Nat) {j : Nat}, spurScan pd retM x rest k = some j →
      1 ≤ j ∧ j ≤ k
  | 0, j, h => nomatch h
  | k + 1, j, h => by
    unfold spurScan at h
    split at h
    next => exact (Option.some.inj h) ▸ ⟨by omega, Nat.le_refl _⟩
    next =>
      have := spurScan_le pd retM x rest k h
      omega

/-- The TS `removeSpurs` splice loop, as recursion over the current
(post-splice) list. An anchor with fewer than two successors ends the
pass (`i < out.length - 2`). -/
def spurGo (pd : π → π → Nat) (retM maxSpan : Nat) : List π → List π
  | [] => []
  | x :: rest =>
    if rest.length < 2 then x :: rest
    else
      match spurScan pd retM x rest (min (maxSpan - 1) (rest.length - 1)) with
      | some k => x :: spurGo pd retM maxSpan (rest.drop (k + 1))
      | none => x :: spurGo pd retM maxSpan rest
termination_by l => l.length
decreasing_by
  · simp only [List.length_drop, List.length_cons]; omega
  · simp only [List.length_cons]; omega

/-- Spur removal only drops. -/
theorem spurGo_sublist (pd : π → π → Nat) (retM maxSpan : Nat) :
    ∀ l : List π, (spurGo pd retM maxSpan l).Sublist l
  | [] => by
    unfold spurGo
    exact List.Sublist.refl _
  | x :: rest => by
    unfold spurGo
    split
    next => exact List.Sublist.refl _
    next =>
      split
      next k _ =>
        exact List.Sublist.cons_cons _
          (List.Sublist.trans (spurGo_sublist pd retM maxSpan (rest.drop (k + 1)))
            (List.drop_sublist _ _))
      next => exact List.Sublist.cons_cons _ (spurGo_sublist pd retM maxSpan rest)
  termination_by l => l.length
  decreasing_by
    · simp only [List.length_drop, List.length_cons]; omega
    · simp only [List.length_cons]; omega

/-- The apex verdict for one interior vertex: `a`/`b` are the *original*
neighbours, `c` the apex; drop when the apex clears `minApex`, nearly
doubles back (`turnOk` is the ≥140° test), and juts at least `excess`
further than any raw fix in the neighbour time window did (no raw fix
in the window keeps the vertex). -/
def apexDrop (perp : π → π → π → Nat) (turnOk : π → π → π → Bool)
    (ts : π → Int) (minApex excess : Nat) (raw : List π)
    (a c b : π) : Bool :=
  let h := perp c a b
  if h < minApex then false
  else if !turnOk a c b then false
  else
    let t0 := min (ts a) (ts b)
    let t1 := max (ts a) (ts b)
    let win := raw.filter fun f => t0 ≤ ts f && ts f ≤ t1
    if win.isEmpty then false
    else decide (win.foldl (fun m f => max m (perp f a b)) 0 + excess ≤ h)

/-- The TS `despikeUnsupportedApexes` over `n` matched vertices. -/
def despike (perp : π → π → π → Nat) (turnOk : π → π → π → Bool)
    (ts : π → Int) (minApex excess : Nat) (raw : List π)
    (path : Nat → π) (n : Nat) : List π :=
  if n < 3 then (List.range n).map path
  else
    (List.range n).filterMap fun i =>
      if 1 ≤ i ∧ i < n - 1 ∧
          apexDrop perp turnOk ts minApex excess raw
            (path (i - 1)) (path i) (path (i + 1)) then none
      else some (path i)

/-- A drop-or-keep `filterMap` is a sublist of the plain `map`. -/
theorem filterMap_if_sublist {α β : Type} (f : α → β) (P : α → Prop)
    [DecidablePred P] :
    ∀ l : List α,
      (l.filterMap fun x => if P x then none else some (f x)).Sublist (l.map f)
  | [] => List.Sublist.refl _
  | x :: l => by
    rw [List.filterMap_cons, List.map_cons]
    by_cases h : P x
    · rw [if_pos h]
      exact List.Sublist.cons _ (filterMap_if_sublist f P l)
    · rw [if_neg h]
      exact List.Sublist.cons_cons _ (filterMap_if_sublist f P l)

/-- Despiking only drops. -/
theorem despike_sublist (perp : π → π → π → Nat) (turnOk : π → π → π → Bool)
    (ts : π → Int) (minApex excess : Nat) (raw : List π)
    (path : Nat → π) (n : Nat) :
    (despike perp turnOk ts minApex excess raw path n).Sublist
      ((List.range n).map path) := by
  unfold despike
  split
  next => exact List.Sublist.refl _
  next => exact filterMap_if_sublist _ _ _

/-- Despiking keeps both endpoints. -/
theorem despike_ends (perp : π → π → π → Nat) (turnOk : π → π → π → Bool)
    (ts : π → Int) (minApex excess : Nat) (raw : List π)
    (path : Nat → π) {n : Nat} (hn : 1 ≤ n) :
    path 0 ∈ despike perp turnOk ts minApex excess raw path n ∧
    path (n - 1) ∈ despike perp turnOk ts minApex excess raw path n := by
  unfold despike
  split
  next =>
    exact ⟨List.mem_map.mpr ⟨0, List.mem_range.mpr (by omega), rfl⟩,
      List.mem_map.mpr ⟨n - 1, List.mem_range.mpr (by omega), rfl⟩⟩
  next hn3 =>
    constructor
    · refine List.mem_filterMap.mpr ⟨0, List.mem_range.mpr (by omega), ?_⟩
      rw [if_neg fun h => absurd h.1 (by omega)]
    · refine List.mem_filterMap.mpr ⟨n - 1, List.mem_range.mpr (by omega), ?_⟩
      rw [if_neg fun h => absurd h.2.1 (by omega)]

-- Smoke tests (π = Int × Int with the toy vertical deviation; ts = 0).
private def toyPd (a b : Int × Int) : Nat :=
  ((a.1 - b.1).natAbs + (a.2 - b.2).natAbs)

private def spurPts : List (Int × Int) :=
  [(0, 0), (2, 0), (4, 0), (4, 9), (4, 1), (6, 0), (8, 0)]

-- The out-and-back to (4,9) returns to (4,1) within 1 of anchor (4,0):
-- excursion and return vertex both dropped.
#guard spurGo toyPd 1 5 spurPts == [(0, 0), (2, 0), (4, 0), (6, 0), (8, 0)]
-- With a span too short to see the return, nothing is dropped.
#guard spurGo toyPd 1 1 spurPts == spurPts

private def dedupePts (i : Nat) : Int × Int :=
  match i with
  | 0 => (0, 0)
  | 1 => (0, 0)
  | 2 => (5, 0)
  | _ => (5, 1)

#guard dedupe (fun a b => toyPd a b < 2) dedupePts 4 == [(0, 0), (5, 0)]

end Verified.Geo
