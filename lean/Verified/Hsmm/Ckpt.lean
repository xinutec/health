import Verified.Hsmm.Memo

/-!
# Allocation-light, checkpointed verified decoder

`decodeFast` (Memo.lean) is theorem-backed but expensive at day scale: its
column functions build a `List` per cell (`List.range`/`map`/`flatMap`
feeding `listMax`), re-enter the `Problem` closures per cell, and
`buildCols` retains all `T` columns (~54M boxed cells on a real day).

This file keeps the theorems and swaps the machinery, in two layers:

* **Fold-based columns** — `rangeMax` accumulates a maximum over `0..n-1`
  with no list allocation; `closeRowF`/`colStepF` use it and hoist the
  per-column `emit`/`entry` reads into rows. `closeRowF_eq`/`colStepF_eq`
  prove them *equal* to `closeRow`/`colStep`, so every pointwise fact
  (`colStep_get`) transfers by rewriting.
* **Checkpointed storage** — `buildCkpt` runs the same recurrence but
  retains only every `K`-th column (as `(time, column)` entries) plus the
  final column. The walk recomputes a queried column from the nearest
  stored checkpoint (`findCk`/`colFrom`/`colAt`). Correctness never
  reasons about *which* columns were stored: the invariant is just "every
  stored entry equals `col` at its own time", so no division arithmetic
  enters the proofs.

`decodeCk` is `decodeFast` on this machinery; `decodeCk_eq` proves
`decodeCk P K = decode P` for **every** stride `K`, so `decodeCk_correct`
and `decodeCk_none_iff` are inherited outright.
-/

namespace Verified.Hsmm

/-- Maximum of `f 0 .. f (n-1)`, accumulator-style (no list is built). -/
def rangeMax (f : Nat → Score) : Nat → Score
  | 0 => .negInf
  | n + 1 => Score.max (rangeMax f n) (f n)

theorem rangeMax_eq (f : Nat → Score) :
    ∀ n, rangeMax f n = Score.listMax ((List.range n).map f)
  | 0 => rfl
  | n + 1 => by
    rw [rangeMax, rangeMax_eq f n, List.range_succ, List.map_append,
      Score.listMax_append]
    simp [Score.listMax_cons]

/-- `closeRow`, fold-based. -/
def closeRowF (P : Problem) (t : Nat) (prev : Array Score) : Array Score :=
  Array.ofFn (n := P.S) fun sp =>
    rangeMax (fun τ0 => prev[sp.val * P.maxD + τ0]! + P.dur sp.val (τ0 + 1) t) P.maxD

theorem closeRowF_eq (P : Problem) (t : Nat) (prev : Array Score) :
    closeRowF P t prev = closeRow P t prev := by
  apply Array.ext
  · simp [closeRowF, closeRow]
  · intro i h1 h2
    simp only [closeRowF, closeRow, Array.getElem_ofFn]
    rw [rangeMax_eq]

/-- `colStep`, fold-based, with the per-column `emit`/`entry` closure reads
hoisted into rows (they are per-state, not per-cell). -/
def colStepF (P : Problem) (t : Nat) (prev : Array Score) : Array Score :=
  let emitR : Array Score := Array.ofFn (n := P.S) fun s => P.emit (t + 1) s.val
  let entryR : Array Score := Array.ofFn (n := P.S) fun s => P.entry s.val (t + 1)
  let closeA := closeRowF P t prev
  Array.ofFn (n := P.S * P.maxD) fun i =>
    let s := i.val / P.maxD
    if i.val % P.maxD = 0 then
      rangeMax (fun sp => if sp == s then .negInf else closeA[sp]! + P.trans sp s (t + 1)) P.S
        + entryR[s]! + emitR[s]!
    else prev[i.val - 1]! + emitR[s]!

theorem colStepF_eq (P : Problem) (t : Nat) (prev : Array Score) :
    colStepF P t prev = colStep P t prev := by
  apply Array.ext
  · simp [colStepF, colStep]
  · intro i h1 h2
    simp only [colStepF, colStep, Array.getElem_ofFn, closeRowF_eq]
    have hs : i / P.maxD < P.S := by
      have hsz : i < P.S * P.maxD := by simpa [colStepF] using h1
      exact Nat.div_lt_of_lt_mul (by rw [Nat.mul_comm] at hsz; exact hsz)
    have hemit : (Array.ofFn (n := P.S) fun s => P.emit (t + 1) s.val)[i / P.maxD]!
        = P.emit (t + 1) (i / P.maxD) := by
      rw [getElem!_pos _ _ (by simpa using hs), Array.getElem_ofFn]
    have hentry : (Array.ofFn (n := P.S) fun s => P.entry s.val (t + 1))[i / P.maxD]!
        = P.entry (i / P.maxD) (t + 1) := by
      rw [getElem!_pos _ _ (by simpa using hs), Array.getElem_ofFn]
    rw [hemit, hentry]
    by_cases hm : i % P.maxD = 0
    · rw [if_pos hm, if_pos hm]
      congr 2
      rw [rangeMax_eq, Score.listMax_flatMap_ite]
    · rw [if_neg hm, if_neg hm]

/-- The column recurrence, retaining only every `K`-th column (as
`(time, column)` entries, times increasing) plus the current column. -/
def buildCkpt (P : Problem) (K : Nat) : Nat → Array (Nat × Array Score) × Array Score
  | 0 =>
    let c0 := col0 P
    (#[(0, c0)], c0)
  | t + 1 =>
    let prev := buildCkpt P K t
    let next := colStepF P t prev.2
    (if (t + 1) % K = 0 then prev.1.push (t + 1, next) else prev.1, next)

/-- The running column is `col` at its time. -/
theorem buildCkpt_snd (P : Problem) (K : Nat) :
    ∀ t, ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      ((buildCkpt P K t).2)[s * P.maxD + (τ - 1)]! = col P t s τ
  | 0 => by
    intro s τ hs h1 hm
    have h0 : (buildCkpt P K 0).2 = col0 P := rfl
    rw [h0]
    exact col0_get P hs h1 hm
  | t + 1 => by
    intro s τ hs h1 hm
    have h2 : (buildCkpt P K (t + 1)).2 = colStepF P t (buildCkpt P K t).2 := by
      simp only [buildCkpt]
    rw [h2, colStepF_eq]
    exact colStep_get P t _
      (fun s' τ' hs' h1' hm' => buildCkpt_snd P K t s' τ' hs' h1' hm') hs h1 hm

/-- Every stored checkpoint is `col` at its own recorded time. -/
theorem buildCkpt_fst (P : Problem) (K : Nat) :
    ∀ t, ∀ i, i < ((buildCkpt P K t).1).size →
      ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        ((((buildCkpt P K t).1)[i]!).2)[s * P.maxD + (τ - 1)]!
          = col P (((buildCkpt P K t).1)[i]!).1 s τ
  | 0 => by
    intro i hi s τ hs h1 hm
    have hsz : ((buildCkpt P K 0).1).size = 1 := rfl
    have hi0 : i = 0 := by omega
    subst hi0
    have hread : ((buildCkpt P K 0).1)[0]! = (0, col0 P) := rfl
    rw [hread]
    exact col0_get P hs h1 hm
  | t + 1 => by
    intro i hi s τ hs h1 hm
    have hsnd : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
        ((buildCkpt P K (t + 1)).2)[s' * P.maxD + (τ' - 1)]! = col P (t + 1) s' τ' :=
      fun s' τ' hs' h1' hm' => buildCkpt_snd P K (t + 1) s' τ' hs' h1' hm'
    have hfst : (buildCkpt P K (t + 1)).1
        = if (t + 1) % K = 0
          then ((buildCkpt P K t).1).push (t + 1, (buildCkpt P K (t + 1)).2)
          else (buildCkpt P K t).1 := by
      simp only [buildCkpt]
    rw [hfst] at hi ⊢
    by_cases hc : (t + 1) % K = 0
    case neg =>
      rw [if_neg hc] at hi ⊢
      exact buildCkpt_fst P K t i hi s τ hs h1 hm
    case pos =>
      rw [if_pos hc] at hi ⊢
      rw [Array.size_push] at hi
      by_cases hlt : i < ((buildCkpt P K t).1).size
      · have hread : (((buildCkpt P K t).1).push (t + 1, (buildCkpt P K (t + 1)).2))[i]!
            = ((buildCkpt P K t).1)[i]! := by
          rw [getElem!_pos _ _ (by rw [Array.size_push]; omega), Array.getElem_push,
            dif_pos hlt]
          exact (getElem!_pos _ _ (by omega)).symm
        rw [hread]
        exact buildCkpt_fst P K t i hlt s τ hs h1 hm
      · have hieq : i = ((buildCkpt P K t).1).size := by omega
        have hread : (((buildCkpt P K t).1).push (t + 1, (buildCkpt P K (t + 1)).2))[i]!
            = (t + 1, (buildCkpt P K (t + 1)).2) := by
          rw [getElem!_pos _ _ (by rw [Array.size_push]; omega), Array.getElem_push,
            dif_neg (by omega)]
        rw [hread]
        exact hsnd s τ hs h1 hm

/-- Last stored entry (scanning backward) whose time is `≤ t`. Generic in the
column representation so the packed decoder (Packed.lean) can reuse it. -/
def findCk {α : Type} [Inhabited α] (cks : Array (Nat × α)) (t : Nat) : Nat → Option (Nat × α)
  | 0 => none
  | i + 1 => if (cks[i]!).1 ≤ t then some cks[i]! else findCk cks t i

theorem findCk_spec {α : Type} [Inhabited α] (cks : Array (Nat × α)) (t : Nat) :
    ∀ n, n ≤ cks.size → ∀ e, findCk cks t n = some e →
      (∃ i, i < cks.size ∧ cks[i]! = e) ∧ e.1 ≤ t
  | 0 => by intro _ e h; simp [findCk] at h
  | n + 1 => by
    intro hn e h
    rw [findCk] at h
    by_cases hc : (cks[n]!).1 ≤ t
    · rw [if_pos hc] at h
      have he : cks[n]! = e := Option.some.inj h
      exact ⟨⟨n, by omega, he⟩, he ▸ hc⟩
    · rw [if_neg hc] at h
      exact findCk_spec cks t n (by omega) e h

/-- Advance a column `k` steps from time `b`. -/
def colFrom (P : Problem) (b : Nat) (c : Array Score) : Nat → Array Score
  | 0 => c
  | k + 1 => colStepF P (b + k) (colFrom P b c k)

theorem colFrom_get (P : Problem) (b : Nat) (c : Array Score)
    (hc : ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      c[s * P.maxD + (τ - 1)]! = col P b s τ) :
    ∀ k, ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (colFrom P b c k)[s * P.maxD + (τ - 1)]! = col P (b + k) s τ
  | 0 => hc
  | k + 1 => by
    intro s τ hs h1 hm
    rw [colFrom, colStepF_eq]
    exact colStep_get P (b + k) _
      (fun s' τ' hs' h1' hm' => colFrom_get P b c hc k s' τ' hs' h1' hm') hs h1 hm

/-- The column at time `t`, recomputed from the nearest stored checkpoint.
The fallback (no checkpoint applies) restarts from `col0` — unreachable
when entry `(0, col0)` is present, but total and still correct. -/
def colAt (P : Problem) (cks : Array (Nat × Array Score)) (t : Nat) : Array Score :=
  match findCk cks t cks.size with
  | some (b, c) => colFrom P b c (t - b)
  | none => colFrom P 0 (col0 P) t

theorem colAt_get (P : Problem) (cks : Array (Nat × Array Score))
    (hcks : ∀ i, i < cks.size → ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      ((cks[i]!).2)[s * P.maxD + (τ - 1)]! = col P ((cks[i]!).1) s τ)
    (t : Nat) : ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (colAt P cks t)[s * P.maxD + (τ - 1)]! = col P t s τ := by
  intro s τ hs h1 hm
  rw [colAt]
  cases hf : findCk cks t cks.size with
  | none =>
    have := colFrom_get P 0 (col0 P)
      (fun s' τ' hs' h1' hm' => col0_get P hs' h1' hm') t s τ hs h1 hm
    rwa [Nat.zero_add] at this
  | some e =>
    obtain ⟨b, c⟩ := e
    obtain ⟨⟨i, hi, hie⟩, hbt⟩ := findCk_spec cks t cks.size (Nat.le_refl _) (b, c) hf
    have hc : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
        c[s' * P.maxD + (τ' - 1)]! = col P b s' τ' := by
      intro s' τ' hs' h1' hm'
      have := hcks i hi s' τ' hs' h1' hm'
      rw [hie] at this
      exact this
    have := colFrom_get P b c hc (t - b) s τ hs h1 hm
    rwa [Nat.add_sub_cancel' hbt] at this

/-- `walkFast`, reading recomputed-from-checkpoint columns. The column is
hoisted out of the `pickBest` scan so it is computed once per boundary. -/
def walkCk (P : Problem) (cks : Array (Nat × Array Score)) : (t s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      let c := colAt P cks (t + 1 - τ - 1)
      match pickBest
          (fun p : Nat × Nat =>
            c[p.1 * P.maxD + (p.2 - 1)]! + P.dur p.1 p.2 (t + 1 - τ - 1)
              + P.trans p.1 s (t + 1 - τ - 1 + 1))
          ((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none => none
      | some ((sp, τ'), _) => (walkCk P cks (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

theorem walkCk_eq (P : Problem) (cks : Array (Nat × Array Score))
    (hcols : ∀ t s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (colAt P cks t)[s * P.maxD + (τ - 1)]! = col P t s τ) :
    ∀ (t s τ : Nat), walkCk P cks t s τ = walk P t s τ
  | t, s, τ => by
    rw [walkCk, walk]
    by_cases hτ : τ = 0
    · rw [dif_pos hτ, dif_pos hτ]
    · rw [dif_neg hτ, dif_neg hτ]
      by_cases hs0 : t + 1 - τ = 0
      · rw [dif_pos hs0, dif_pos hs0]
      · rw [dif_neg hs0, dif_neg hs0]
        -- zeta-reduce walkCk's hoisted `let c := colAt …` so the pickBest
        -- rewrite below can see the column term
        dsimp only
        have hpick :
            pickBest
                (fun p : Nat × Nat =>
                  (colAt P cks (t + 1 - τ - 1))[p.1 * P.maxD + (p.2 - 1)]!
                    + P.dur p.1 p.2 (t + 1 - τ - 1)
                    + P.trans p.1 s (t + 1 - τ - 1 + 1))
                ((List.range P.S).flatMap fun sp =>
                  if sp == s then []
                  else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1))
              = pickBest
                  (fun p : Nat × Nat =>
                    col P (t + 1 - τ - 1) p.1 p.2
                      + P.dur p.1 p.2 (t + 1 - τ - 1)
                      + P.trans p.1 s (t + 1 - τ - 1 + 1))
                  ((List.range P.S).flatMap fun sp =>
                    if sp == s then []
                    else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) := by
          apply pickBest_congr
          intro p hp
          simp only [List.mem_flatMap, List.mem_range] at hp
          obtain ⟨sp, hspS, hp2⟩ := hp
          cases hb : sp == s with
          | true => rw [hb] at hp2; simp at hp2
          | false =>
            rw [hb] at hp2
            simp only [Bool.false_eq_true, if_false, List.mem_map, List.mem_range] at hp2
            obtain ⟨τ0, hτ0, hEq⟩ := hp2
            subst hEq
            dsimp only
            rw [hcols (t + 1 - τ - 1) sp (τ0 + 1) hspS (by omega) (by omega)]
        rw [hpick]
        cases hq : pickBest
            (fun p : Nat × Nat =>
              col P (t + 1 - τ - 1) p.1 p.2 + P.dur p.1 p.2 (t + 1 - τ - 1)
                + P.trans p.1 s (t + 1 - τ - 1 + 1))
            ((List.range P.S).flatMap fun sp =>
              if sp == s then []
              else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
        | none => rfl
        | some q =>
          obtain ⟨⟨sp, τ'⟩, sc⟩ := q
          dsimp only
          rw [walkCk_eq P cks hcols (t + 1 - τ - 1) sp τ']
  termination_by t _ _ => t
  decreasing_by omega

/-- The checkpointed verified decoder: `decodeFast`'s asymptotic compute
(plus `≤ K` recomputed columns per decoded segment) with `O((T/K)·S·maxD)`
retained cells instead of `O(T·S·maxD)`. Correct for every stride `K`. -/
def decodeCk (P : Problem) (K : Nat) : Option DecodeResult :=
  if P.T = 0 then some ⟨#[], Score.zero⟩
  else
    let bc := buildCkpt P K (P.T - 1)
    match pickBest
        (fun p : Nat × Nat =>
          (bc.2)[p.1 * P.maxD + (p.2 - 1)]! + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => none
    | some ((s, τ), best) =>
      match walkCk P bc.1 (P.T - 1) s τ with
      | none => none
      | some rsegs => some ⟨(toPath rsegs.reverse).toArray, best⟩

theorem decodeCk_eq (P : Problem) (K : Nat) : decodeCk P K = decode P := by
  simp only [decodeCk, decode]
  by_cases hT : P.T = 0
  · rw [if_pos hT, if_pos hT]
  · rw [if_neg hT, if_neg hT]
    have hcols : ∀ t s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        (colAt P (buildCkpt P K (P.T - 1)).1 t)[s * P.maxD + (τ - 1)]! = col P t s τ :=
      colAt_get P (buildCkpt P K (P.T - 1)).1
        (fun i hi => buildCkpt_fst P K (P.T - 1) i hi)
    have hpick :
        pickBest
            (fun p : Nat × Nat =>
              ((buildCkpt P K (P.T - 1)).2)[p.1 * P.maxD + (p.2 - 1)]!
                + P.dur p.1 p.2 (P.T - 1))
            ((List.range P.S).flatMap fun s =>
              (List.range P.maxD).map fun τ0 => (s, τ0 + 1))
          = pickBest
              (fun p : Nat × Nat =>
                col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
              ((List.range P.S).flatMap fun s =>
                (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) := by
      apply pickBest_congr
      intro p hp
      simp only [List.mem_flatMap, List.mem_range, List.mem_map] at hp
      obtain ⟨s2, hs2, τ0, hτ0, hEq⟩ := hp
      subst hEq
      dsimp only
      rw [buildCkpt_snd P K (P.T - 1) s2 (τ0 + 1) hs2 (by omega) (by omega)]
    rw [hpick]
    cases hq : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => rfl
    | some q =>
      obtain ⟨⟨s, τ⟩, best⟩ := q
      dsimp only
      rw [walkCk_eq P (buildCkpt P K (P.T - 1)).1 hcols (P.T - 1) s τ]
      rfl

theorem decodeCk_eq_fast (P : Problem) (K : Nat) : decodeCk P K = decodeFast P := by
  rw [decodeCk_eq, decodeFast_eq]

/-- `decode_correct`, inherited by the checkpointed decoder. -/
theorem decodeCk_correct (P : Problem) (K : Nat) {r : DecodeResult}
    (h : decodeCk P K = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray :=
  decode_correct P (decodeCk_eq P K ▸ h)

/-- `decode_none_iff`, inherited by the checkpointed decoder. -/
theorem decodeCk_none_iff (P : Problem) (K : Nat) (hT : P.T ≠ 0) :
    decodeCk P K = none ↔ oracleBest P = Score.negInf := by
  rw [decodeCk_eq]
  exact decode_none_iff P hT

end Verified.Hsmm
