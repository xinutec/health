import Verified.Hsmm.Trellis
import Verified.Hsmm.Viterbi

/-!
# The verified decoder: path attainment

`decode` returns an optimal per-minute path with a *proof* it is optimal:
`decode_correct` shows any returned result's path comes from a well-formed
segmentation achieving `oracleBest`, and `decode_none_iff` shows `none` is
returned exactly when every segmentation scores `-∞`.

Structure: the final cell `(s, τ)` is chosen by `pickBest` (a first-best
argmax whose result provably attains the list maximum); the segmentation is
then reconstructed backwards by `walk`, which *re-searches* the argmax at each
segment boundary against the proved column recurrence `col`. No backpointer
invariants are needed: each step is justified by `col_eq_openVal` +
`closeB_eq`, and the chosen candidate's score is pinned by `pickBest`'s
attainment lemma.

`decode` evaluates `col` without memoisation, so it is exponential — a
*specification* decoder, exact on tiny instances (see the `#guard`s in
`Tests.lean` pinning it against the imperative `viterbi`, including paths:
`pickBest`'s first-best tie-break composes to the same selection order as the
TypeScript loops). The efficiency step — memoising `col` into arrays — is a
pointwise refinement that cannot disturb these theorems.
-/

namespace Verified.Hsmm

/-- First-best argmax: the earliest element attaining the maximum of `f` over
the list, with its (finite) score. `none` iff every element scores `-∞`. -/
def pickBest {α : Type} (f : α → Score) : List α → Option (α × Score)
  | [] => none
  | x :: xs =>
    match pickBest f xs with
    | none => if f x == Score.negInf then none else some (x, f x)
    | some (b, bs) => if Score.ble bs (f x) then some (x, f x) else some (b, bs)

theorem pickBest_none {α : Type} (f : α → Score) :
    ∀ (l : List α), pickBest f l = none → ∀ x ∈ l, f x = Score.negInf := by
  intro l
  induction l with
  | nil => intro _ x hx; cases hx
  | cons y ys ih =>
    intro h x hx
    simp only [pickBest] at h
    cases hp : pickBest f ys with
    | none =>
      rw [hp] at h
      cases hfy : (f y == Score.negInf) with
      | false => rw [hfy] at h; simp at h
      | true =>
        rcases List.mem_cons.mp hx with hE | hT
        · subst hE; exact eq_of_beq hfy
        · exact ih hp x hT
    | some p =>
      rw [hp] at h
      obtain ⟨b, bs⟩ := p
      dsimp only at h
      by_cases hble : Score.ble bs (f y) = true
      · rw [if_pos hble] at h; simp at h
      · rw [if_neg hble] at h; simp at h

theorem pickBest_some {α : Type} (f : α → Score) :
    ∀ (l : List α) (a : α) (sc : Score), pickBest f l = some (a, sc) →
      sc = f a ∧ a ∈ l ∧ sc ≠ Score.negInf ∧ sc = Score.listMax (l.map f) := by
  intro l
  induction l with
  | nil => intro a sc h; simp [pickBest] at h
  | cons y ys ih =>
    intro a sc h
    simp only [pickBest] at h
    rw [List.map_cons, Score.listMax_cons]
    cases hp : pickBest f ys with
    | none =>
      rw [hp] at h
      have hall : Score.listMax (ys.map f) = Score.negInf :=
        Score.listMax_eq_negInf_of_all (by
          intro x hx
          obtain ⟨z, hz, hfz⟩ := List.mem_map.mp hx
          rw [← hfz]
          exact pickBest_none f ys hp z hz)
      cases hfy : (f y == Score.negInf) with
      | true => rw [hfy] at h; simp at h
      | false =>
        rw [hfy] at h
        simp only [Bool.false_eq_true, if_false, Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨ha, hsc⟩ := h
        subst ha; subst hsc
        refine ⟨rfl, List.mem_cons_self .., beq_eq_false_iff_ne.mp hfy, ?_⟩
        rw [hall, Score.max_negInf]
    | some p =>
      rw [hp] at h
      obtain ⟨b, bs⟩ := p
      dsimp only at h
      obtain ⟨hbs, hbmem, hbne, hbmax⟩ := ih b bs hp
      by_cases hble : Score.ble bs (f y) = true
      · rw [if_pos hble] at h
        simp only [Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨ha, hsc⟩ := h
        subst ha; subst hsc
        have hfyne : f y ≠ Score.negInf := by
          intro hfy
          exact hbne (Score.le_antisymm (hfy ▸ (hble : bs ≤ f y)) (Score.negInf_le bs))
        refine ⟨rfl, List.mem_cons_self .., hfyne, ?_⟩
        rw [← hbmax, Score.max_eq_left (hble : bs ≤ f y)]
      · rw [if_neg hble] at h
        simp only [Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨ha, hsc⟩ := h
        subst ha; subst hsc
        have hyb : f y ≤ bs := by
          rcases Score.le_total (f y) bs with h1 | h2
          · exact h1
          · exact absurd h2 hble
        refine ⟨hbs, List.mem_cons_of_mem _ hbmem, hbne, ?_⟩
        rw [← hbmax, Score.max_eq_right hyb, hbs]

/-- Like `scoreRev`, but the head (most recent) segment's duration prior is
left unpaid — the score of an *open* trellis prefix. -/
def scoreRevOpen (P : Problem) (m : Nat) : List Seg → Score
  | [] => Score.zero
  | ⟨s, d⟩ :: rest =>
    ((match rest with
       | [] => P.init s
       | sp :: _ => P.trans sp.state s (m - d))
      + P.entry s (m - d) + emitRun P s (m - d) d)
    + scoreRev P (m - d) rest

/-- Paying the head segment's duration prior closes an open prefix. -/
theorem scoreRev_close (P : Problem) (m s d : Nat) (rest : List Seg) (hdm : d ≤ m) :
    scoreRev P m (⟨s, d⟩ :: rest)
      = scoreRevOpen P m (⟨s, d⟩ :: rest) + P.dur s d (m - 1) := by
  have harg : m - d + d - 1 = m - 1 := by omega
  cases rest with
  | nil =>
    simp only [scoreRev, scoreRevOpen, segScore]
    rw [harg]
    ac_rfl
  | cons y ys =>
    simp only [scoreRev, scoreRevOpen, segScore]
    rw [harg]
    ac_rfl

theorem toPath_length (segs : List Seg) :
    (toPath segs).length = (segs.map (·.dur)).sum := by
  simp [toPath]

/-- The walk's per-step re-search space equals the `openVal` predecessor
maximum: candidates `(sp, τ')` scored by "close `sp`'s run at `t'`, then
transition into `s`" reach exactly `bestEnd + trans` per predecessor state. -/
theorem pickL_eq (P : Problem) (hmaxD : 1 ≤ P.maxD) (s t' : Nat) :
    Score.listMax
        ((((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)).map
          fun p : Nat × Nat =>
            col P t' p.1 p.2 + P.dur p.1 p.2 t' + P.trans p.1 s (t' + 1)))
      = Score.listMax ((List.range P.S).flatMap fun sp =>
          if sp == s then []
          else [bestEnd P sp (t' + 1) + P.trans sp s (t' + 1)]) := by
  rw [List.map_flatMap, Score.listMax_flatMap, Score.listMax_flatMap]
  congr 1
  apply List.map_congr_left
  intro sp _
  cases hsp : sp == s
  · simp only [Bool.false_eq_true, if_false, List.map_map]
    have hfun : ∀ τ0 ∈ List.range P.maxD,
        ((fun p : Nat × Nat =>
            col P t' p.1 p.2 + P.dur p.1 p.2 t' + P.trans p.1 s (t' + 1))
          ∘ fun τ0 => (sp, τ0 + 1)) τ0
          = (fun τ0 => (col P t' sp (τ0 + 1) + P.dur sp (τ0 + 1) t')
              + P.trans sp s (t' + 1)) τ0 := by
      intro τ0 _
      rfl
    rw [List.map_congr_left hfun,
      Score.listMax_add_map (fun τ0 => col P t' sp (τ0 + 1) + P.dur sp (τ0 + 1) t')
        (P.trans sp s (t' + 1)),
      closeB_eq P hmaxD t' (col_eq_openVal P hmaxD t') sp]
    simp [Score.listMax_cons]
  · simp

/-- Reconstruct the (reversed) optimal segmentation from cell `(s, τ)` at
minute `t` by re-searching each boundary argmax. -/
def walk (P : Problem) : (t : Nat) → (s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      match pickBest
          (fun p : Nat × Nat =>
            col P (t + 1 - τ - 1) p.1 p.2 + P.dur p.1 p.2 (t + 1 - τ - 1)
              + P.trans p.1 s (t + 1 - τ - 1 + 1))
          ((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none => none
      | some ((sp, τ'), _) => (walk P (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

/-- The walk succeeds from any finite cell and returns an open prefix that is
structurally sound and achieves the cell's value exactly. -/
theorem walk_spec (P : Problem) (hmaxD : 1 ≤ P.maxD) :
    ∀ (t s τ : Nat), s < P.S → col P t s τ ≠ Score.negInf →
      ∃ rest, walk P t s τ = some (⟨s, τ⟩ :: rest)
        ∧ (((⟨s, τ⟩ :: rest : List Seg)).map (·.dur)).sum = t + 1
        ∧ (∀ seg ∈ (⟨s, τ⟩ :: rest : List Seg),
            1 ≤ seg.dur ∧ seg.dur ≤ P.maxD ∧ seg.state < P.S)
        ∧ adjDistinct (⟨s, τ⟩ :: rest) = true
        ∧ scoreRevOpen P (t + 1) (⟨s, τ⟩ :: rest) = col P t s τ
  | t, s, τ => by
    intro hsS hcol
    have hinv := col_eq_openVal P hmaxD t s τ
    have hcond : 1 ≤ τ ∧ τ ≤ P.maxD ∧ τ ≤ t + 1 := by
      rcases Decidable.em (1 ≤ τ ∧ τ ≤ P.maxD ∧ τ ≤ t + 1) with hc | hc
      · exact hc
      · rw [hinv, if_neg hc] at hcol
        exact absurd rfl hcol
    obtain ⟨hτ1, hτmax, hτt⟩ := hcond
    have hcolval : col P t s τ = openVal P (t + 1 - τ) s τ := by
      rw [hinv, if_pos ⟨hτ1, hτmax, hτt⟩]
    rw [walk]
    rw [dif_neg (by omega : ¬τ = 0)]
    by_cases hs0 : t + 1 - τ = 0
    · rw [dif_pos hs0]
      refine ⟨[], rfl, ?_, ?_, rfl, ?_⟩
      · simp only [List.map_cons, List.map_nil, List.sum_cons, List.sum_nil]
        show τ + 0 = t + 1
        omega
      · intro seg hseg
        simp only [List.mem_cons, List.not_mem_nil, or_false] at hseg
        subst hseg
        exact ⟨hτ1, hτmax, hsS⟩
      · rw [hcolval, openVal, if_pos hs0]
        simp [scoreRevOpen, scoreRev]
    · rw [dif_neg hs0]
      rw [hcolval, openVal, if_neg hs0] at hcol
      have hM : Score.listMax ((List.range P.S).flatMap fun sp =>
          if sp == s then []
          else [bestEnd P sp (t + 1 - τ) + P.trans sp s (t + 1 - τ)])
          ≠ Score.negInf :=
        Score.ne_negInf_of_add_left (Score.ne_negInf_of_add_left hcol)
      have hidx : t + 1 - τ - 1 + 1 = t + 1 - τ := by omega
      have hLmax := pickL_eq P hmaxD s (t + 1 - τ - 1)
      rw [hidx] at hLmax
      cases hp : pickBest
          (fun p : Nat × Nat =>
            col P (t + 1 - τ - 1) p.1 p.2 + P.dur p.1 p.2 (t + 1 - τ - 1)
              + P.trans p.1 s (t + 1 - τ - 1 + 1))
          ((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none =>
        exfalso
        apply hM
        rw [← hLmax, ← hidx]
        exact Score.listMax_eq_negInf_of_all (by
          intro x hx
          obtain ⟨p, hpmem, hfp⟩ := List.mem_map.mp hx
          rw [← hfp]
          exact pickBest_none _ _ hp p hpmem)
      | some q =>
        obtain ⟨⟨sp, τ'⟩, sc⟩ := q
        dsimp only
        obtain ⟨hsc, hmem, hscne, hscmax⟩ := pickBest_some _ _ _ _ hp
        rw [hidx] at hscmax
        rw [hLmax] at hscmax
        -- Decode the candidate's membership: sp < S, sp ≠ s, 1 ≤ τ' ≤ maxD.
        simp only [List.mem_flatMap, List.mem_range] at hmem
        obtain ⟨sp2, hsp2S, hmem2⟩ := hmem
        have hspfacts : sp2 = sp ∧ (sp == s) = false ∧ ∃ τ0, τ0 < P.maxD ∧ τ' = τ0 + 1 := by
          cases hb : sp2 == s with
          | true => rw [hb] at hmem2; simp at hmem2
          | false =>
            rw [hb] at hmem2
            simp only [Bool.false_eq_true, if_false, List.mem_map, List.mem_range] at hmem2
            obtain ⟨τ0, hτ0, hEq⟩ := hmem2
            obtain ⟨h1, h2⟩ := Prod.mk.injEq .. ▸ hEq
            exact ⟨h1, h1 ▸ hb, τ0, hτ0, h2.symm⟩
        obtain ⟨hsp2eq, hspne, τ0, hτ0max, hτ'⟩ := hspfacts
        rw [hsp2eq] at hsp2S
        have hspS : sp < P.S := hsp2S
        have hτ'1 : 1 ≤ τ' := by omega
        have hτ'max : τ' ≤ P.maxD := by omega
        -- The chosen predecessor cell is finite.
        rw [hsc] at hscne
        have hcol' : col P (t + 1 - τ - 1) sp τ' ≠ Score.negInf :=
          Score.ne_negInf_of_add_left (Score.ne_negInf_of_add_left hscne)
        obtain ⟨rest', hwalk, hsum', hbounds', hadj', hscore'⟩ :=
          walk_spec P hmaxD (t + 1 - τ - 1) sp τ' hspS hcol'
        rw [hwalk]
        refine ⟨⟨sp, τ'⟩ :: rest', rfl, ?_, ?_, ?_, ?_⟩
        · simp only [List.map_cons, List.sum_cons] at hsum' ⊢
          show τ + (τ' + (rest'.map (·.dur)).sum) = t + 1
          have hs' : τ' + (rest'.map (·.dur)).sum = t + 1 - τ - 1 + 1 := hsum'
          omega
        · intro seg hseg
          rcases List.mem_cons.mp hseg with hE | hT
          · subst hE
            exact ⟨hτ1, hτmax, hsS⟩
          · exact hbounds' seg hT
        · simp only [adjDistinct, Bool.and_eq_true, bne_iff_ne, ne_eq]
          exact ⟨fun hE => (beq_eq_false_iff_ne.mp hspne) hE.symm, hadj'⟩
        · -- Score: unfold one open step, close the predecessor's head, and
          -- let the attained maximum land exactly on the cell value.
          rw [hcolval, openVal, if_neg hs0]
          simp only [scoreRevOpen]
          have hdsum : (((⟨sp, τ'⟩ :: rest' : List Seg)).map (·.dur)).sum
              = t + 1 - τ - 1 + 1 := hsum'
          have hτ'le : τ' ≤ t + 1 - τ := by
            simp only [List.map_cons, List.sum_cons] at hdsum
            have : τ' + (rest'.map (·.dur)).sum = t + 1 - τ - 1 + 1 := hdsum
            omega
          have hstep : t + 1 - (t + 1 - τ) = τ := by omega
          rw [show t + 1 - τ - 1 + 1 = t + 1 - τ from by omega] at hscore' hdsum
          have hclose := scoreRev_close P (t + 1 - τ) sp τ' rest' hτ'le
          rw [show t + 1 - τ - 1 = t + 1 - τ - 1 from rfl] at hclose
          -- Assemble the target equality.
          rw [← hscmax, hsc]
          rw [show (t + 1) - τ = t + 1 - τ from rfl]
          rw [hclose]
          rw [hscore']
          rw [show t + 1 - τ - 1 + 1 = t + 1 - τ from by omega]
          ac_rfl
  termination_by t _ _ => t
  decreasing_by omega

/-- The verified decoder: `pickBest` over final cells, then `walk`. -/
def decode (P : Problem) : Option DecodeResult :=
  if P.T = 0 then some ⟨#[], Score.zero⟩
  else
    match pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => none
    | some ((s, τ), best) =>
      match walk P (P.T - 1) s τ with
      | none => none
      | some rsegs => some ⟨(toPath rsegs.reverse).toArray, best⟩

/-- The final-cell candidate maximum is the (proved) trellis closure. -/
theorem finalMax_eq (P : Problem) (hT : P.T ≠ 0) :
    Score.listMax
        ((((List.range P.S).flatMap fun s =>
            (List.range P.maxD).map fun τ0 => (s, τ0 + 1)).map
          fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1)))
      = oracleBest P := by
  rw [List.map_flatMap, Score.listMax_flatMap]
  have h := trellisScore_eq_oracleBest P
  rw [trellisScore, if_neg hT] at h
  rw [← h]
  congr 1
  apply List.map_congr_left
  intro s _
  rw [List.map_map, closeB]
  rfl

/-- `decode` returns `none` exactly when no segmentation scores above `-∞`. -/
theorem decode_none_iff (P : Problem) (hT : P.T ≠ 0) :
    decode P = none ↔ oracleBest P = Score.negInf := by
  rw [decode, if_neg hT]
  constructor
  · intro h
    cases hp : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none =>
      rw [← finalMax_eq P hT]
      exact Score.listMax_eq_negInf_of_all (by
        intro x hx
        obtain ⟨p, hpmem, hfp⟩ := List.mem_map.mp hx
        rw [← hfp]
        exact pickBest_none _ _ hp p hpmem)
    | some q =>
      exfalso
      obtain ⟨⟨s, τ⟩, best⟩ := q
      rw [hp] at h
      dsimp only at h
      obtain ⟨hsc, hmem, hscne, _⟩ := pickBest_some _ _ _ _ hp
      simp only [List.mem_flatMap, List.mem_range, List.mem_map] at hmem
      obtain ⟨s2, hs2S, τ0, hτ0, hEq⟩ := hmem
      obtain ⟨h1, _⟩ := Prod.mk.injEq .. ▸ hEq
      have hsS : s < P.S := h1 ▸ hs2S
      have hmaxD : 1 ≤ P.maxD := by omega
      rw [hsc] at hscne
      have hcolne : col P (P.T - 1) s τ ≠ Score.negInf :=
        Score.ne_negInf_of_add_left hscne
      obtain ⟨rest, hwalk, _⟩ := walk_spec P hmaxD (P.T - 1) s τ hsS hcolne
      rw [hwalk] at h
      simp at h
  · intro h
    cases hp : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => rfl
    | some q =>
      exfalso
      obtain ⟨⟨s, τ⟩, best⟩ := q
      obtain ⟨_, _, hscne, hscmax⟩ := pickBest_some _ _ _ _ hp
      rw [finalMax_eq P hT] at hscmax
      exact hscne (hscmax.trans h)

/-- **The pilot's goal theorem**: any decoded result's path is the per-minute
rendering of a well-formed segmentation that achieves the oracle's best score. -/
theorem decode_correct (P : Problem) {r : DecodeResult} (h : decode P = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray := by
  rw [decode] at h
  by_cases hT : P.T = 0
  · rw [if_pos hT] at h
    simp only [Option.some.injEq] at h
    subst h
    refine ⟨[], ?_, rfl, ?_, rfl⟩
    · simp [wellFormed, adjDistinct, hT]
    · have h2 := trellisScore_eq_oracleBest P
      rw [trellisScore, if_pos hT] at h2
      exact h2
  · rw [if_neg hT] at h
    cases hp : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => rw [hp] at h; simp at h
    | some q =>
      obtain ⟨⟨s, τ⟩, best⟩ := q
      rw [hp] at h
      dsimp only at h
      obtain ⟨hsc, hmem, hscne, hscmax⟩ := pickBest_some _ _ _ _ hp
      simp only [List.mem_flatMap, List.mem_range, List.mem_map] at hmem
      obtain ⟨s2, hs2S, τ0, hτ0, hEq⟩ := hmem
      obtain ⟨h1, _⟩ := Prod.mk.injEq .. ▸ hEq
      have hsS : s < P.S := h1 ▸ hs2S
      have hmaxD : 1 ≤ P.maxD := by omega
      rw [hsc] at hscne
      have hcolne : col P (P.T - 1) s τ ≠ Score.negInf :=
        Score.ne_negInf_of_add_left hscne
      obtain ⟨rest, hwalk, hsum, hbounds, hadj, hscore⟩ :=
        walk_spec P hmaxD (P.T - 1) s τ hsS hcolne
      rw [hwalk] at h
      simp only [Option.some.injEq] at h
      subst h
      have hTsum : ((⟨s, τ⟩ :: rest : List Seg).map (·.dur)).sum = P.T := by
        have h2 := hsum
        omega
      have hτT : τ ≤ P.T := by
        simp only [List.map_cons, List.sum_cons] at hTsum
        omega
      refine ⟨(⟨s, τ⟩ :: rest : List Seg).reverse, ?_, ?_, ?_, rfl⟩
      · apply enum_sound P
        have hmem' : (⟨s, τ⟩ :: rest : List Seg) ∈ enumEnd P s P.T := by
          apply enumEnd_complete P P.T s τ rest ?_ hbounds hadj
          simp only [List.map_cons, List.sum_cons] at hTsum
          exact hTsum
        exact reverse_mem_enumFrom_none P
          (enumEnd_subset P P.T s (⟨s, τ⟩ :: rest) hsS hmem')
      · rw [← scoreRev_eq P (⟨s, τ⟩ :: rest) P.T hTsum]
        rw [scoreRev_close P P.T s τ rest hτT]
        rw [show P.T - 1 + 1 = P.T from by omega] at hscore
        rw [hscore]
        exact hsc.symm
      · rw [hscmax, finalMax_eq P hT]

end Verified.Hsmm
