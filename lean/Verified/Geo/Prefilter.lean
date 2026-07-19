import Verified.Geo.Simplify

/-!
# GPS pre-filters — `holdImplausibleSpeed` and `rejectSpikes`

`src/geo/episode-geometry.ts`'s display pre-filters, the "stable, pure,
small" stratum of the V4 port. Parametric over the point type and the
per-hop predicates, like the rest of the pass layer:

- `holdSpeed` (TS `holdImplausibleSpeed`): keep the longest
  plausible-speed run over all start fixes; `ok last cur` is the TS
  "`dt > 0` and implied speed within `capKmh`" test. Earliest longest
  run wins (the TS strict `>`), so a leading or trailing straggler is
  excluded rather than anchoring the hold. The TS bypass for a
  non-finite `capKmh` (return the input unfiltered) is the caller's
  branch, outside this function.
- `rejectSpikes`: drop lone geometric detours; `spike prev cur next` is
  the TS "through > 3 × direct and through − direct > 500 m" test
  against the last *kept* point.

Theorems:
- `holdSpeed_chain` — **the kinematic honesty invariant**: every
  consecutive pair of the output satisfies `ok`. The whole point of the
  pass (#265 Phase 1: never draw an impossible sprint) holds by
  construction, for any instantiation of `ok`.
- `holdSpeed_sublist` / `rejectSpikes_sublist`: outputs are
  subsequences of the input — the filters only drop, never invent or
  reorder fixes.
- `rejectSpikes_ends`: spike rejection always keeps both endpoints.

Not yet stated: `holdSpeed`'s longest/earliest optimality (the output
is the earliest maximal run) — the honesty and subsequence facts are
the load-bearing ones.
-/

namespace Verified.Geo

variable {π : Type}

/-- One plausible-speed run: scan `i ∈ [i₀, n)`, keeping a fix only if
`ok last (fixes i)` against the last *kept* fix — the TS `runFrom`
inner loop. `acc` is the kept list so far (in order), `last` its final
element. -/
def runGo (ok : π → π → Bool) (fixes : Nat → π) (n i : Nat) (last : π)
    (acc : List π) : List π :=
  if _h : i < n then
    if ok last (fixes i) then
      runGo ok fixes n (i + 1) (fixes i) (acc ++ [fixes i])
    else
      runGo ok fixes n (i + 1) last acc
  else acc
termination_by n - i

/-- The plausible-speed run anchored at start fix `s`. -/
def runFrom (ok : π → π → Bool) (fixes : Nat → π) (n s : Nat) : List π :=
  runGo ok fixes n (s + 1) (fixes s) [fixes s]

/-- Chain invariant: if the kept list is pairwise-`ok` and ends at
`last`, everything `runGo` produces is pairwise-`ok`. -/
theorem runGo_chain (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    ∀ (i : Nat) (last : π) (front : List π),
      (∀ p ∈ adjPairs (front ++ [last]), ok p.1 p.2 = true) →
      ∀ p ∈ adjPairs (runGo ok fixes n i last (front ++ [last])),
        ok p.1 p.2 = true
  | i, last, front, hchain, p, hp => by
    unfold runGo at hp
    split at hp
    next _h =>
      split at hp
      next hok =>
        refine runGo_chain ok fixes n (i + 1) (fixes i) (front ++ [last]) ?_ p hp
        intro q hq
        rw [adjPairs_concat] at hq
        rcases List.mem_append.mp hq with hq' | hq'
        · exact hchain q hq'
        · obtain rfl : q = (last, fixes i) := by simpa using hq'
          exact hok
      next => exact runGo_chain ok fixes n (i + 1) last front hchain p hp
    next => exact hchain p hp
  termination_by i _ _ _ _ _ => n - i
  decreasing_by all_goals omega

/-- Every consecutive pair of a run satisfies `ok`. -/
theorem runFrom_chain (ok : π → π → Bool) (fixes : Nat → π) (n s : Nat) :
    ∀ p ∈ adjPairs (runFrom ok fixes n s), ok p.1 p.2 = true :=
  runGo_chain ok fixes n (s + 1) (fixes s) []
    (fun _ hq => nomatch hq)

/-- `runGo` keeps a subsequence of the input prefix it has scanned. -/
theorem runGo_sublist (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    ∀ (i : Nat) (last : π) (acc : List π), i ≤ n →
      acc.Sublist ((List.range i).map fixes) →
      (runGo ok fixes n i last acc).Sublist ((List.range n).map fixes)
  | i, last, acc, hin, hsub => by
    have hstep : ((List.range i).map fixes).Sublist
        ((List.range (i + 1)).map fixes) := by
      rw [List.range_succ, List.map_append]
      exact List.sublist_append_left _ _
    unfold runGo
    split
    next _h =>
      split
      next =>
        refine runGo_sublist ok fixes n (i + 1) _ _ (by omega) ?_
        rw [List.range_succ, List.map_append]
        exact List.Sublist.append hsub (List.Sublist.refl _)
      next =>
        exact runGo_sublist ok fixes n (i + 1) _ _ (by omega)
          (List.Sublist.trans hsub hstep)
    next =>
      have : i = n := by omega
      subst this
      exact hsub
  termination_by i _ _ _ _ => n - i
  decreasing_by all_goals omega

/-- A run is a subsequence of the input. -/
theorem runFrom_sublist (ok : π → π → Bool) (fixes : Nat → π) {n s : Nat}
    (hs : s < n) :
    (runFrom ok fixes n s).Sublist ((List.range n).map fixes) := by
  refine runGo_sublist ok fixes n (s + 1) (fixes s) [fixes s] (by omega) ?_
  rw [List.range_succ, List.map_append]
  exact List.sublist_append_right _ _

/-- The longest-run selection over start fixes (earliest longest wins —
the TS strict `>`). -/
def bestRun (ok : π → π → Bool) (fixes : Nat → π) (n s : Nat)
    (best : List π) : List π :=
  if _h : s < n then
    bestRun ok fixes n (s + 1)
      (if best.length < (runFrom ok fixes n s).length
       then runFrom ok fixes n s else best)
  else best
termination_by n - s

/-- The selection preserves the chain invariant. -/
theorem bestRun_chain (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    ∀ (s : Nat) (best : List π),
      (∀ p ∈ adjPairs best, ok p.1 p.2 = true) →
      ∀ p ∈ adjPairs (bestRun ok fixes n s best), ok p.1 p.2 = true
  | s, best, hbest, p, hp => by
    unfold bestRun at hp
    split at hp
    next _h =>
      refine bestRun_chain ok fixes n (s + 1) _ ?_ p hp
      split
      next => exact runFrom_chain ok fixes n s
      next => exact hbest
    next => exact hbest p hp
  termination_by s _ _ _ _ => n - s
  decreasing_by omega

/-- The selection preserves the subsequence invariant. -/
theorem bestRun_sublist (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    ∀ (s : Nat) (best : List π),
      best.Sublist ((List.range n).map fixes) →
      (bestRun ok fixes n s best).Sublist ((List.range n).map fixes)
  | s, best, hbest => by
    unfold bestRun
    split
    next _h =>
      refine bestRun_sublist ok fixes n (s + 1) _ ?_
      split
      next => exact runFrom_sublist ok fixes _h
      next => exact hbest
    next => exact hbest
  termination_by s _ _ => n - s
  decreasing_by omega

/-- The TS `holdImplausibleSpeed` over `n` fixes (short inputs are
returned unchanged; the non-finite-cap bypass is the caller's). -/
def holdSpeed (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) : List π :=
  if n < 2 then (List.range n).map fixes
  else bestRun ok fixes n 0 []

/-- **The kinematic honesty invariant** (#265 Phase 1): every
consecutive pair of the held output satisfies the plausibility
predicate — the drawn leg never contains an implausible hop. -/
theorem holdSpeed_chain (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    ∀ p ∈ adjPairs (holdSpeed ok fixes n), ok p.1 p.2 = true := by
  intro p hp
  unfold holdSpeed at hp
  split at hp
  next hn =>
    have : n = 0 ∨ n = 1 := by omega
    rcases this with rfl | rfl
    · exact absurd hp (by simp [adjPairs])
    · exact absurd hp (by simp [adjPairs, List.range_succ])
  next hn =>
    exact bestRun_chain ok fixes n 0 [] (fun _ hq => nomatch hq) p hp

/-- The held output is a subsequence of the input: the filter only
drops fixes, never invents or reorders them. -/
theorem holdSpeed_sublist (ok : π → π → Bool) (fixes : Nat → π) (n : Nat) :
    (holdSpeed ok fixes n).Sublist ((List.range n).map fixes) := by
  unfold holdSpeed
  split
  next => exact List.Sublist.refl _
  next => exact bestRun_sublist ok fixes n 0 [] (List.nil_sublist _)

/-- The spike-rejection scan over interior points `i ∈ [i₀, n - 1)`,
testing each against the last *kept* point `prev` and its successor —
the TS `rejectSpikes` loop. -/
def rejectGo (spike : π → π → π → Bool) (pts : Nat → π) (n i : Nat)
    (prev : π) (acc : List π) : List π :=
  if _h : i < n - 1 then
    if spike prev (pts i) (pts (i + 1)) then
      rejectGo spike pts n (i + 1) prev acc
    else
      rejectGo spike pts n (i + 1) (pts i) (acc ++ [pts i])
  else acc
termination_by n - 1 - i

/-- `rejectGo` only appends to the kept prefix. -/
theorem rejectGo_prefix (spike : π → π → π → Bool) (pts : Nat → π) (n : Nat) :
    ∀ (i : Nat) (prev : π) (acc : List π),
      ∃ tail, rejectGo spike pts n i prev acc = acc ++ tail
  | i, prev, acc => by
    unfold rejectGo
    split
    next _h =>
      split
      next => exact rejectGo_prefix spike pts n (i + 1) prev acc
      next =>
        obtain ⟨tail, htail⟩ :=
          rejectGo_prefix spike pts n (i + 1) (pts i) (acc ++ [pts i])
        exact ⟨[pts i] ++ tail, by rw [htail, List.append_assoc]⟩
    next => exact ⟨[], (List.append_nil acc).symm⟩
  termination_by i _ _ => n - 1 - i
  decreasing_by all_goals omega

/-- `rejectGo` keeps a subsequence of the scanned input prefix. -/
theorem rejectGo_sublist (spike : π → π → π → Bool) (pts : Nat → π) (n : Nat) :
    ∀ (i : Nat) (prev : π) (acc : List π), i ≤ n - 1 →
      acc.Sublist ((List.range i).map pts) →
      (rejectGo spike pts n i prev acc).Sublist
        ((List.range (n - 1)).map pts)
  | i, prev, acc, hin, hsub => by
    have hstep : ((List.range i).map pts).Sublist
        ((List.range (i + 1)).map pts) := by
      rw [List.range_succ, List.map_append]
      exact List.sublist_append_left _ _
    unfold rejectGo
    split
    next _h =>
      split
      next =>
        exact rejectGo_sublist spike pts n (i + 1) _ _ (by omega)
          (List.Sublist.trans hsub hstep)
      next =>
        refine rejectGo_sublist spike pts n (i + 1) _ _ (by omega) ?_
        rw [List.range_succ, List.map_append]
        exact List.Sublist.append hsub (List.Sublist.refl _)
    next =>
      have : i = n - 1 := by omega
      subst this
      exact hsub
  termination_by i _ _ _ _ => n - 1 - i
  decreasing_by all_goals omega

/-- The TS `rejectSpikes` over `n` points (short inputs unchanged). -/
def rejectSpikes (spike : π → π → π → Bool) (pts : Nat → π) (n : Nat) :
    List π :=
  if n < 3 then (List.range n).map pts
  else rejectGo spike pts n 1 (pts 0) [pts 0] ++ [pts (n - 1)]

/-- Spike rejection keeps a subsequence of the input. -/
theorem rejectSpikes_sublist (spike : π → π → π → Bool) (pts : Nat → π)
    (n : Nat) :
    (rejectSpikes spike pts n).Sublist ((List.range n).map pts) := by
  unfold rejectSpikes
  split
  next => exact List.Sublist.refl _
  next hn =>
    have hrange : (List.range n).map pts
        = (List.range (n - 1)).map pts ++ [pts (n - 1)] := by
      have : n - 1 + 1 = n := by omega
      rw [← this, List.range_succ, List.map_append, this]
      simp
    rw [hrange]
    refine List.Sublist.append ?_ (List.Sublist.refl _)
    refine rejectGo_sublist spike pts n 1 (pts 0) [pts 0] (by omega) ?_
    have : (List.range 1).map pts = [pts 0] := by simp
    rw [this]
    exact List.Sublist.refl _

/-- Spike rejection always keeps both endpoints. -/
theorem rejectSpikes_ends (spike : π → π → π → Bool) (pts : Nat → π)
    {n : Nat} (hn : 3 ≤ n) :
    ∃ mid, rejectSpikes spike pts n = pts 0 :: (mid ++ [pts (n - 1)]) := by
  unfold rejectSpikes
  rw [if_neg (by omega)]
  obtain ⟨tail, htail⟩ := rejectGo_prefix spike pts n 1 (pts 0) [pts 0]
  exact ⟨tail, by rw [htail]; simp⟩

-- Smoke tests over π = Int, `ok a b` = |b − a| ≤ 1, spike = detour test.
private def toyOk (a b : Int) : Bool := (b - a).natAbs ≤ 1

private def toyFixes (i : Nat) : Int :=
  match i with
  | 0 => 0
  | 1 => 1
  | 2 => 9
  | 3 => 2
  | _ => 3

-- The mid-run teleport (index 2) is held; the run continues from the
-- last plausible fix.
#guard holdSpeed toyOk toyFixes 5 == [0, 1, 2, 3]

private def toyLead (i : Nat) : Int :=
  match i with
  | 0 => 100
  | 1 => 0
  | 2 => 1
  | _ => 2

-- A leading straggler does not anchor the hold: the longest run over
-- all start fixes excludes it (the Baker-St case from the TS comment).
#guard holdSpeed toyOk toyLead 4 == [0, 1, 2]

private def toySpike (prev cur next : Int) : Bool :=
  let through := (cur - prev).natAbs + (next - cur).natAbs
  let direct := (next - prev).natAbs
  through > 3 * direct && through - direct > 5

private def toySpikePts (i : Nat) : Int :=
  match i with
  | 0 => 0
  | 1 => 1
  | 2 => 50
  | 3 => 2
  | _ => 3

#guard rejectSpikes toySpike toySpikePts 5 == [0, 1, 2, 3]

end Verified.Geo
