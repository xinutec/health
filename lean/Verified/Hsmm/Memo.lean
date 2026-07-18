import Verified.Hsmm.Decode

/-!
# Memoising the verified decoder

`decode` (proved correct in `Decode.lean`) recomputes `col` exponentially.
This file computes the columns once — `buildCols` produces column `t` as a
flat `Array Score` indexed by `s * maxD + (τ - 1)`, exactly the imperative
trellis's layout — and proves every cell pointwise equal to `col`
(`buildCols_get`). `decodeFast` is `decode` with array lookups in place of
`col` calls; `decodeFast_eq` shows the two are *equal as functions of the
problem* (via `pickBest_congr`), so `decodeFast_correct` and
`decodeFast_none_iff` are inherited outright.

`decodeFast` runs in `O(T·S·(S + maxD))` like the TypeScript decoder — this
is the production-grade verified decoder.
-/

namespace Verified.Hsmm

/-- `pickBest` only looks at values on members. -/
theorem pickBest_congr {α : Type} {f g : α → Score} :
    ∀ (l : List α), (∀ x ∈ l, f x = g x) → pickBest f l = pickBest g l := by
  intro l
  induction l with
  | nil => intro _; rfl
  | cons x xs ih =>
    intro h
    simp only [pickBest]
    rw [ih fun y hy => h y (List.mem_cons_of_mem _ hy), h x (List.mem_cons_self ..)]

/-- Flat-index arithmetic: the cell `(s, τ0)` of a row-major `S × maxD` array. -/
theorem idx_div {s τ0 maxD : Nat} (hτ : τ0 < maxD) : (s * maxD + τ0) / maxD = s := by
  rw [Nat.mul_comm, Nat.mul_add_div (by omega), Nat.div_eq_of_lt hτ]
  rfl

theorem idx_mod {s τ0 maxD : Nat} (hτ : τ0 < maxD) : (s * maxD + τ0) % maxD = τ0 := by
  rw [Nat.mul_comm, Nat.mul_add_mod, Nat.mod_eq_of_lt hτ]

theorem idx_lt {s τ0 S maxD : Nat} (hs : s < S) (hτ : τ0 < maxD) :
    s * maxD + τ0 < S * maxD := by
  have h1 : s * maxD + maxD = (s + 1) * maxD := (Nat.succ_mul s maxD).symm
  have h2 : (s + 1) * maxD ≤ S * maxD := Nat.mul_le_mul_right maxD hs
  omega

/-- Column `t = 0`: only `τ = 1` cells are live. -/
def col0 (P : Problem) : Array Score :=
  Array.ofFn (n := P.S * P.maxD) fun i =>
    if i.val % P.maxD = 0 then
      P.init (i.val / P.maxD) + P.entry (i.val / P.maxD) 0 + P.emit 0 (i.val / P.maxD)
    else Score.negInf

/-- Best close-of-run per state at minute `t` (the trellis's `closeBest` row). -/
def closeRow (P : Problem) (t : Nat) (prev : Array Score) : Array Score :=
  Array.ofFn (n := P.S) fun sp =>
    Score.listMax ((List.range P.maxD).map fun τ0 =>
      prev[sp.val * P.maxD + τ0]! + P.dur sp.val (τ0 + 1) t)

/-- Column `t + 1` from column `t`. -/
def colStep (P : Problem) (t : Nat) (prev : Array Score) : Array Score :=
  let closeA := closeRow P t prev
  Array.ofFn (n := P.S * P.maxD) fun i =>
    let s := i.val / P.maxD
    if i.val % P.maxD = 0 then
      Score.listMax ((List.range P.S).flatMap fun sp =>
        if sp == s then [] else [closeA[sp]! + P.trans sp s (t + 1)])
        + P.entry s (t + 1) + P.emit (t + 1) s
    else prev[i.val - 1]! + P.emit (t + 1) s

/-- Columns `0 .. t`, in order. -/
def buildCols (P : Problem) : Nat → Array (Array Score)
  | 0 => #[col0 P]
  | t + 1 =>
    let cs := buildCols P t
    cs.push (colStep P t cs[t]!)

theorem col0_get (P : Problem) {s τ : Nat}
    (hs : s < P.S) (hτ1 : 1 ≤ τ) (hτm : τ ≤ P.maxD) :
    (col0 P)[s * P.maxD + (τ - 1)]! = col P 0 s τ := by
  have hτ0 : τ - 1 < P.maxD := by omega
  have hi : s * P.maxD + (τ - 1) < P.S * P.maxD := idx_lt hs hτ0
  rw [col0, getElem!_pos (Array.ofFn _) _ (by simpa using hi), Array.getElem_ofFn]
  simp only [idx_div hτ0, idx_mod hτ0, col]
  by_cases h1 : τ = 1
  · subst h1
    rw [if_pos rfl, if_pos rfl]
  · rw [if_neg (by omega), if_neg h1]

theorem closeRow_get (P : Problem) (t : Nat) (prev : Array Score)
    (hprev : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
      prev[s' * P.maxD + (τ' - 1)]! = col P t s' τ')
    {sp : Nat} (hsp : sp < P.S) :
    (closeRow P t prev)[sp]!
      = Score.listMax ((List.range P.maxD).map fun τ0 =>
          col P t sp (τ0 + 1) + P.dur sp (τ0 + 1) t) := by
  rw [closeRow, getElem!_pos (Array.ofFn _) _ (by simpa using hsp), Array.getElem_ofFn]
  congr 1
  apply List.map_congr_left
  intro τ0 hτ0
  rw [List.mem_range] at hτ0
  have h := hprev sp (τ0 + 1) hsp (by omega) (by omega)
  rw [show τ0 + 1 - 1 = τ0 from rfl] at h
  rw [h]

theorem colStep_get (P : Problem) (t : Nat) (prev : Array Score)
    (hprev : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
      prev[s' * P.maxD + (τ' - 1)]! = col P t s' τ')
    {s τ : Nat} (hs : s < P.S) (hτ1 : 1 ≤ τ) (hτm : τ ≤ P.maxD) :
    (colStep P t prev)[s * P.maxD + (τ - 1)]! = col P (t + 1) s τ := by
  have hτ0 : τ - 1 < P.maxD := by omega
  have hi : s * P.maxD + (τ - 1) < P.S * P.maxD := idx_lt hs hτ0
  rw [colStep, getElem!_pos (Array.ofFn _) _ (by simpa using hi), Array.getElem_ofFn]
  simp only [idx_div hτ0, idx_mod hτ0]
  by_cases h1 : τ = 1
  · subst h1
    rw [if_pos rfl, col, if_pos rfl]
    congr 2
    rw [Score.listMax_flatMap_ite, Score.listMax_flatMap_ite]
    congr 1
    apply List.map_congr_left
    intro sp hsp
    rw [List.mem_range] at hsp
    cases hb : sp == s
    · simp only [Bool.false_eq_true, if_false]
      rw [closeRow_get P t prev hprev hsp]
    · rfl
  · rw [if_neg (by omega)]
    have hidx : s * P.maxD + (τ - 1) - 1 = s * P.maxD + (τ - 1 - 1) := by omega
    rw [hidx]
    have h := hprev s (τ - 1) hs (by omega) (by omega)
    rw [h]
    rw [col, if_neg h1, if_pos ⟨by omega, hτm⟩]

theorem buildCols_size (P : Problem) : ∀ t, (buildCols P t).size = t + 1
  | 0 => rfl
  | t + 1 => by
    simp only [buildCols, Array.size_push, buildCols_size P t]

/-- Every stored cell is the corresponding `col` value. -/
theorem buildCols_get (P : Problem) :
    ∀ (tmax t : Nat), t ≤ tmax → ∀ (s τ : Nat), s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      ((buildCols P tmax)[t]!)[s * P.maxD + (τ - 1)]! = col P t s τ := by
  intro tmax
  induction tmax with
  | zero =>
    intro t ht s τ hs hτ1 hτm
    have ht0 : t = 0 := by omega
    subst ht0
    have h0 : (buildCols P 0)[0]! = col0 P := rfl
    rw [h0]
    exact col0_get P hs hτ1 hτm
  | succ tmax ih =>
    intro t ht s τ hs hτ1 hτm
    have hsz : (buildCols P tmax).size = tmax + 1 := buildCols_size P tmax
    by_cases htt : t = tmax + 1
    · subst htt
      have hread :
          ((buildCols P (tmax + 1)))[tmax + 1]!
            = colStep P tmax (buildCols P tmax)[tmax]! := by
        simp only [buildCols]
        rw [getElem!_pos _ _ (by simp only [Array.size_push, hsz]; omega),
          Array.getElem_push, dif_neg (by omega)]
      rw [hread]
      exact colStep_get P tmax _
        (fun s' τ' hs' h1' hm' => ih tmax (Nat.le_refl _) s' τ' hs' h1' hm')
        hs hτ1 hτm
    · have htle : t ≤ tmax := by omega
      have hread : ((buildCols P (tmax + 1)))[t]! = (buildCols P tmax)[t]! := by
        simp only [buildCols]
        rw [getElem!_pos _ _ (by simp only [Array.size_push, hsz]; omega),
          Array.getElem_push, dif_pos (by omega)]
        exact (getElem!_pos _ _ (by omega)).symm
      rw [hread]
      exact ih t htle s τ hs hτ1 hτm

/-- Cell lookup in the prebuilt columns. -/
def lookupCol (P : Problem) (cols : Array (Array Score)) (t s τ : Nat) : Score :=
  (cols[t]!)[s * P.maxD + (τ - 1)]!

/-- `walk`, reading the prebuilt columns instead of recomputing `col`. -/
def walkFast (P : Problem) (cols : Array (Array Score)) : (t s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      match pickBest
          (fun p : Nat × Nat =>
            lookupCol P cols (t + 1 - τ - 1) p.1 p.2 + P.dur p.1 p.2 (t + 1 - τ - 1)
              + P.trans p.1 s (t + 1 - τ - 1 + 1))
          ((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none => none
      | some ((sp, τ'), _) => (walkFast P cols (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

theorem walkFast_eq (P : Problem) (cols : Array (Array Score)) (tmax : Nat)
    (hcols : ∀ t s τ, t ≤ tmax → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      lookupCol P cols t s τ = col P t s τ) :
    ∀ (t s τ : Nat), t ≤ tmax → walkFast P cols t s τ = walk P t s τ
  | t, s, τ => by
    intro ht
    rw [walkFast, walk]
    by_cases hτ : τ = 0
    · rw [dif_pos hτ, dif_pos hτ]
    · rw [dif_neg hτ, dif_neg hτ]
      by_cases hs0 : t + 1 - τ = 0
      · rw [dif_pos hs0, dif_pos hs0]
      · rw [dif_neg hs0, dif_neg hs0]
        have hpick :
            pickBest
                (fun p : Nat × Nat =>
                  lookupCol P cols (t + 1 - τ - 1) p.1 p.2
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
            rw [hcols (t + 1 - τ - 1) sp (τ0 + 1) (by omega) hspS (by omega) (by omega)]
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
          rw [walkFast_eq P cols tmax hcols (t + 1 - τ - 1) sp τ' (by omega)]
  termination_by t _ _ => t
  decreasing_by omega

/-- The memoised verified decoder — `O(T·S·(S + maxD))`, same asymptotics as
the imperative trellis. -/
def decodeFast (P : Problem) : Option DecodeResult :=
  if P.T = 0 then some ⟨#[], Score.zero⟩
  else
    let cols := buildCols P (P.T - 1)
    match pickBest
        (fun p : Nat × Nat =>
          lookupCol P cols (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => none
    | some ((s, τ), best) =>
      match walkFast P cols (P.T - 1) s τ with
      | none => none
      | some rsegs => some ⟨(toPath rsegs.reverse).toArray, best⟩

theorem decodeFast_eq (P : Problem) : decodeFast P = decode P := by
  simp only [decodeFast, decode]
  by_cases hT : P.T = 0
  · rw [if_pos hT, if_pos hT]
  · rw [if_neg hT, if_neg hT]
    have hcols : ∀ t s τ, t ≤ P.T - 1 → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        lookupCol P (buildCols P (P.T - 1)) t s τ = col P t s τ := by
      intro t s τ ht hs h1 hm
      exact buildCols_get P (P.T - 1) t ht s τ hs h1 hm
    have hpick :
        pickBest
            (fun p : Nat × Nat =>
              lookupCol P (buildCols P (P.T - 1)) (P.T - 1) p.1 p.2
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
      rw [hcols (P.T - 1) s2 (τ0 + 1) (Nat.le_refl _) hs2 (by omega) (by omega)]
    rw [hpick]
    cases hq : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => rfl
    | some q =>
      obtain ⟨⟨s, τ⟩, best⟩ := q
      dsimp only
      rw [walkFast_eq P (buildCols P (P.T - 1)) (P.T - 1) hcols (P.T - 1) s τ
        (Nat.le_refl _)]
      rfl

/-- `decode_correct`, inherited by the memoised decoder. -/
theorem decodeFast_correct (P : Problem) {r : DecodeResult} (h : decodeFast P = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray :=
  decode_correct P (decodeFast_eq P ▸ h)

/-- `decode_none_iff`, inherited by the memoised decoder. -/
theorem decodeFast_none_iff (P : Problem) (hT : P.T ≠ 0) :
    decodeFast P = none ↔ oracleBest P = Score.negInf := by
  rw [decodeFast_eq]
  exact decode_none_iff P hT

end Verified.Hsmm
