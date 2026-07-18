import Verified.Hsmm.Bellman

/-!
# The forward (Viterbi-principle) recurrence

The trellis processes the day forward, so its provable functional form is a
*prefix* DP: `bestEnd P s m` = the best score over well-formed segmentations of
`[0, m)` whose last segment has state exactly `s`. Parameterising by the exact
last state is what lets the transition into a new segment be paid at the
segment's start — precisely the trellis's `closeBest`-then-transition step.

Segmentations here are manipulated in *reverse* order (most recent segment
first), which makes the prefix DP structurally recursive; `scoreRev` scores
that representation and `scoreRev_eq` bridges it to the spec's `score` via the
snoc lemma `scoreAux_append_single`.

Main result: `forwardBest_eq_oracleBest` — the forward DP computes exactly
`oracleBest`. The remaining V1 step is the array-refinement: the trellis's
τ-indexed columns compute `bestEnd` (see the roadmap).
-/

namespace Verified.Hsmm

/-- The state of the last segment, defaulting to `prev` for an empty list. -/
def lastStateD (prev : Option Nat) (segs : List Seg) : Option Nat :=
  match segs.getLast? with
  | some sg => some sg.state
  | none => prev

theorem lastStateD_cons (prev : Option Nat) (x : Seg) (xs : List Seg) :
    lastStateD prev (x :: xs) = lastStateD (some x.state) xs := by
  cases xs with
  | nil => rfl
  | cons y ys =>
    simp only [lastStateD, List.getLast?_cons_cons]
    cases h : (y :: ys).getLast? with
    | none => simp [List.getLast?_eq_none_iff] at h
    | some sg => rfl

/-- Snoc decomposition of the spec score: appending one segment pays its
`segScore` at the accumulated start, transitioning from the front's last state. -/
theorem scoreAux_append_single (P : Problem) (xs : List Seg) (s d : Nat) :
    ∀ (start : Nat) (prev : Option Nat),
      scoreAux P start prev (xs ++ [⟨s, d⟩])
        = scoreAux P start prev xs
          + segScore P (start + (xs.map (·.dur)).sum) (lastStateD prev xs) s d := by
  induction xs with
  | nil =>
    intro start prev
    simp [scoreAux_cons, scoreAux, lastStateD]
  | cons x xs ih =>
    obtain ⟨sx, dx⟩ := x
    intro start prev
    simp only [List.cons_append, scoreAux_cons, ih, lastStateD_cons,
      List.map_cons, List.sum_cons]
    rw [← Score.add_assoc, Nat.add_assoc]

/-- Score of a reversed segmentation (most recent segment first) covering
`[0, m)`. The init-vs-transition choice peeks at the chronologically previous
segment — the head of the tail. -/
def scoreRev (P : Problem) : Nat → List Seg → Score
  | _, [] => Score.zero
  | m, ⟨s, d⟩ :: rest =>
    segScore P (m - d)
      (match rest with
        | [] => none
        | sp :: _ => some sp.state) s d
    + scoreRev P (m - d) rest

/-- The reversed scorer agrees with the spec score of the reversed list. -/
theorem scoreRev_eq (P : Problem) :
    ∀ (rsegs : List Seg) (m : Nat), (rsegs.map (·.dur)).sum = m →
      scoreRev P m rsegs = score P rsegs.reverse := by
  intro rsegs
  induction rsegs with
  | nil => intro m _; simp [scoreRev, score, scoreAux]
  | cons x rest ih =>
    obtain ⟨s, d⟩ := x
    intro m hsum
    simp only [List.map_cons, List.sum_cons] at hsum
    have hsum' : d + (rest.map (·.dur)).sum = m := hsum
    rw [List.reverse_cons]
    simp only [score, scoreAux_append_single, List.map_reverse, List.sum_reverse,
      Nat.zero_add]
    simp only [scoreRev]
    rw [ih (m - d) (by omega)]
    have hmd : m - d = (rest.map (·.dur)).sum := by omega
    rw [hmd]
    have hlast : lastStateD none rest.reverse
        = (match rest with | [] => none | sp :: _ => some sp.state) := by
      cases rest with
      | nil => rfl
      | cons y ys => simp [lastStateD, List.getLast?_reverse]
    rw [hlast]
    simp only [score]
    exact Score.add_comm _ _

/-- The unconstrained enumeration is closed under reversal (all its defining
conditions are direction-agnostic). -/
theorem reverse_mem_enumFrom_none (P : Problem) {m : Nat} {segs : List Seg}
    (h : segs ∈ enumFrom P none m) : segs.reverse ∈ enumFrom P none m := by
  obtain ⟨hsum, hbounds, hadj, _⟩ := enumFrom_sound P segs m none h
  apply enumFrom_complete
  · rw [List.map_reverse, List.sum_reverse]; exact hsum
  · intro seg hseg
    exact hbounds seg (List.mem_reverse.mp hseg)
  · rw [adjDistinct_reverse]; exact hadj
  · intro st d rest _
    simp

/-- All reversed segmentations of `[0, m)` whose (chronologically) last segment
has state exactly `s`: choose that segment's duration `d`; either it is the
only segment (`m - d = 0`, paying `init`) or recurse on the earlier prefix,
whose own last state `sp` must differ. -/
def enumEnd (P : Problem) (s : Nat) : (m : Nat) → List (List Seg)
  | 0 => []
  | m + 1 =>
    (List.range (Nat.min P.maxD (m + 1))).flatMap fun d0 =>
      if m + 1 - (d0 + 1) == 0 then [[⟨s, d0 + 1⟩]]
      else
        (List.range P.S).flatMap fun sp =>
          if sp == s then []
          else (enumEnd P sp (m + 1 - (d0 + 1))).map (⟨s, d0 + 1⟩ :: ·)
  termination_by m => m
  decreasing_by omega

/-- The forward DP: best score over segmentations of `[0, m)` ending in state
exactly `s`. Mirrors `enumEnd` choice-for-choice; the transition into the last
segment is paid here, where the predecessor state `sp` is the recursion
parameter — the trellis's segment-start bookkeeping. -/
def bestEnd (P : Problem) (s : Nat) : (m : Nat) → Score
  | 0 => Score.negInf
  | m + 1 =>
    Score.listMax <|
      (List.range (Nat.min P.maxD (m + 1))).flatMap fun d0 =>
        if m + 1 - (d0 + 1) == 0 then
          [segScore P (m + 1 - (d0 + 1)) none s (d0 + 1)]
        else
          (List.range P.S).flatMap fun sp =>
            if sp == s then []
            else
              [segScore P (m + 1 - (d0 + 1)) (some sp) s (d0 + 1)
                + bestEnd P sp (m + 1 - (d0 + 1))]
  termination_by m => m
  decreasing_by omega

/-- Everything in `enumEnd P s m` starts (in reversed order) with an `s`-segment. -/
theorem enumEnd_head (P : Problem) :
    ∀ {m s : Nat} {rsegs : List Seg}, rsegs ∈ enumEnd P s m →
      ∃ d rest, rsegs = ⟨s, d⟩ :: rest := by
  intro m s rsegs h
  cases m with
  | zero => simp [enumEnd] at h
  | succ m' =>
    simp only [enumEnd, List.mem_flatMap, List.mem_range] at h
    obtain ⟨d0, _, hmem⟩ := h
    cases hm : (m' + 1 - (d0 + 1) == 0) with
    | true =>
      rw [hm] at hmem
      simp at hmem
      exact ⟨d0 + 1, [], hmem⟩
    | false =>
      rw [hm] at hmem
      simp only [Bool.false_eq_true, if_false, List.mem_flatMap, List.mem_range] at hmem
      obtain ⟨sp, _, hmem2⟩ := hmem
      cases hsp : (sp == s) with
      | true => rw [hsp] at hmem2; simp at hmem2
      | false =>
        rw [hsp] at hmem2
        simp only [Bool.false_eq_true, if_false, List.mem_map] at hmem2
        obtain ⟨tail, _, hEq⟩ := hmem2
        exact ⟨d0 + 1, tail, hEq.symm⟩

/-- `enumEnd` only produces members of the unconstrained enumeration. -/
theorem enumEnd_subset (P : Problem) :
    ∀ (m s : Nat) (rsegs : List Seg), s < P.S → rsegs ∈ enumEnd P s m →
      rsegs ∈ enumFrom P none m
  | m, s, rsegs => by
    intro hs h
    cases m with
    | zero => simp [enumEnd] at h
    | succ m' =>
      simp only [enumEnd, List.mem_flatMap, List.mem_range] at h
      obtain ⟨d0, hd0, hmem⟩ := h
      have hd0maxD : d0 < P.maxD := Nat.lt_of_lt_of_le hd0 (Nat.min_le_left _ _)
      have hd0m : d0 < m' + 1 := Nat.lt_of_lt_of_le hd0 (Nat.min_le_right _ _)
      cases hm : (m' + 1 - (d0 + 1) == 0) with
      | true =>
        rw [hm] at hmem
        simp at hmem
        subst hmem
        have hz : m' + 1 - (d0 + 1) = 0 := eq_of_beq hm
        apply enumFrom_complete
        · simp only [List.map_cons, List.map_nil, List.sum_cons, List.sum_nil]
          show d0 + 1 + 0 = m' + 1
          omega
        · intro seg hseg
          simp only [List.mem_cons, List.not_mem_nil, or_false] at hseg
          subst hseg
          exact ⟨Nat.succ_le_succ (Nat.zero_le _), hd0maxD, hs⟩
        · rfl
        · intro st d rest _
          simp
      | false =>
        rw [hm] at hmem
        simp only [Bool.false_eq_true, if_false, List.mem_flatMap, List.mem_range] at hmem
        obtain ⟨sp, hsp, hmem2⟩ := hmem
        cases hspb : (sp == s) with
        | true => rw [hspb] at hmem2; simp at hmem2
        | false =>
          rw [hspb] at hmem2
          simp only [Bool.false_eq_true, if_false, List.mem_map] at hmem2
          obtain ⟨tail, htail, hEq⟩ := hmem2
          subst hEq
          have htail' := enumEnd_subset P (m' + 1 - (d0 + 1)) sp tail hsp htail
          obtain ⟨hsum, hbounds, hadj, _⟩ :=
            enumFrom_sound P tail (m' + 1 - (d0 + 1)) none htail'
          obtain ⟨dh, resth, hheadEq⟩ := enumEnd_head P htail
          apply enumFrom_complete
          · simp only [List.map_cons, List.sum_cons, hsum]
            show d0 + 1 + (m' + 1 - (d0 + 1)) = m' + 1
            omega
          · intro seg hseg
            rcases List.mem_cons.mp hseg with hE | hT
            · subst hE
              exact ⟨Nat.succ_le_succ (Nat.zero_le _), hd0maxD, hs⟩
            · exact hbounds seg hT
          · subst hheadEq
            simp only [adjDistinct, Bool.and_eq_true, bne_iff_ne, ne_eq]
            exact ⟨fun hE => (beq_eq_false_iff_ne.mp hspb) hE.symm, hadj⟩
          · intro st d rest _
            simp
  termination_by m _ _ => m
  decreasing_by omega

/-- Any well-formed-shaped segment list ending (reversed-head) in state `s` is
enumerated by `enumEnd P s`. -/
theorem enumEnd_complete (P : Problem) :
    ∀ (m s d : Nat) (rest : List Seg),
      d + (rest.map (·.dur)).sum = m →
      (∀ seg ∈ (⟨s, d⟩ :: rest : List Seg),
        1 ≤ seg.dur ∧ seg.dur ≤ P.maxD ∧ seg.state < P.S) →
      adjDistinct (⟨s, d⟩ :: rest) = true →
      (⟨s, d⟩ :: rest) ∈ enumEnd P s m
  | m, s, d, rest => by
    intro hsum hbounds hadj
    obtain ⟨hb1, hb2, _⟩ := hbounds ⟨s, d⟩ (List.mem_cons_self ..)
    have hd1 : 1 ≤ d := hb1
    have hdmax : d ≤ P.maxD := hb2
    cases m with
    | zero => omega
    | succ m' =>
      simp only [enumEnd, List.mem_flatMap, List.mem_range]
      refine ⟨d - 1, ?_, ?_⟩
      · simp only [Nat.min_def]; split <;> omega
      · have hd : d - 1 + 1 = d := by omega
        rw [hd]
        cases rest with
        | nil =>
          have hz : (m' + 1 - d == 0) = true := by
            simp only [List.map_nil, List.sum_nil] at hsum
            have : m' + 1 - d = 0 := by omega
            simp [this]
          rw [hz]
          simp
        | cons y rest' =>
          obtain ⟨sp, dp⟩ := y
          have hsum2 : dp + (rest'.map (·.dur)).sum = m' + 1 - d := by
            simp only [List.map_cons, List.sum_cons] at hsum
            have h' : d + (dp + (rest'.map (·.dur)).sum) = m' + 1 := hsum
            omega
          have hdp1 : 1 ≤ dp := (hbounds ⟨sp, dp⟩ (by simp)).1
          have hdp1' : 1 ≤ dp := hdp1
          have hnz : (m' + 1 - d == 0) = false := by
            have : m' + 1 - d ≠ 0 := by omega
            exact beq_eq_false_iff_ne.mpr this
          rw [hnz]
          simp only [Bool.false_eq_true, if_false, List.mem_flatMap, List.mem_range]
          refine ⟨sp, (hbounds ⟨sp, dp⟩ (by simp)).2.2, ?_⟩
          have hspne : (sp == s) = false := by
            simp only [adjDistinct, Bool.and_eq_true, bne_iff_ne, ne_eq] at hadj
            exact beq_eq_false_iff_ne.mpr (fun hE => hadj.1 hE.symm)
          rw [hspne]
          simp only [Bool.false_eq_true, if_false, List.mem_map]
          refine ⟨⟨sp, dp⟩ :: rest', ?_, rfl⟩
          exact enumEnd_complete P (m' + 1 - d) sp dp rest' hsum2
            (fun seg hseg => hbounds seg (List.mem_cons_of_mem _ hseg))
            (adjDistinct_tail hadj)
  termination_by m _ _ _ => m
  decreasing_by omega

/-- The forward DP computes the maximum `scoreRev` over its enumeration. -/
theorem bestEnd_eq (P : Problem) :
    ∀ (m s : Nat), bestEnd P s m = Score.listMax ((enumEnd P s m).map (scoreRev P m))
  | 0, s => by simp [bestEnd, enumEnd]
  | m + 1, s => by
    simp only [bestEnd, enumEnd]
    rw [List.map_flatMap, Score.listMax_flatMap, Score.listMax_flatMap]
    congr 1
    apply List.map_congr_left
    intro d0 _
    cases hm : (m + 1 - (d0 + 1) == 0) with
    | true =>
      simp [scoreRev, Score.listMax_cons]
    | false =>
      simp only [Bool.false_eq_true, if_false]
      rw [List.map_flatMap, Score.listMax_flatMap, Score.listMax_flatMap]
      congr 1
      apply List.map_congr_left
      intro sp _
      cases hsp : (sp == s) with
      | true => simp
      | false =>
        simp only [Bool.false_eq_true, if_false]
        rw [List.map_map]
        have hmap : ∀ rest ∈ enumEnd P sp (m + 1 - (d0 + 1)),
            (scoreRev P (m + 1) ∘ (⟨s, d0 + 1⟩ :: ·)) rest
              = segScore P (m + 1 - (d0 + 1)) (some sp) s (d0 + 1)
                + scoreRev P (m + 1 - (d0 + 1)) rest := by
          intro rest hrest
          obtain ⟨dh, rest', hEq⟩ := enumEnd_head P hrest
          subst hEq
          rfl
        rw [List.map_congr_left hmap, Score.add_listMax_map,
          bestEnd_eq P (m + 1 - (d0 + 1)) sp]
        simp [Score.listMax_cons]
  termination_by m _ => m
  decreasing_by omega

/-- The forward DP's final answer: best over the last segment's state. -/
def forwardBest (P : Problem) : Score :=
  if P.T == 0 then Score.zero
  else Score.listMax ((List.range P.S).map fun s => bestEnd P s P.T)

/-- **The Viterbi principle for this model**: the forward DP over exact last
states computes the oracle's best score. -/
theorem forwardBest_eq_oracleBest (P : Problem) : forwardBest P = oracleBest P := by
  unfold forwardBest
  cases hT : (P.T == 0) with
  | true =>
    have h0 : P.T = 0 := eq_of_beq hT
    simp [oracleBest, enumAll, h0, enumFrom, score, scoreAux, Score.listMax_cons]
  | false =>
    simp only [Bool.false_eq_true, if_false]
    have hT1 : 1 ≤ P.T := by
      have := beq_eq_false_iff_ne.mp hT
      omega
    have stepA : oracleBest P
        = Score.listMax ((enumFrom P none P.T).map (scoreRev P P.T)) := by
      rw [oracleBest, enumAll]
      apply Score.listMax_eq_of_exists
      · intro x hx
        obtain ⟨segs, hsegs, hsc⟩ := List.mem_map.mp hx
        refine ⟨scoreRev P P.T segs.reverse,
          List.mem_map_of_mem (reverse_mem_enumFrom_none P hsegs), ?_⟩
        have hsum : ((segs.reverse).map (·.dur)).sum = P.T := by
          rw [List.map_reverse, List.sum_reverse]
          exact (enumFrom_sound P segs P.T none hsegs).1
        rw [scoreRev_eq P segs.reverse P.T hsum, List.reverse_reverse, hsc]
        exact Score.le_refl _
      · intro y hy
        obtain ⟨segs, hsegs, hsc⟩ := List.mem_map.mp hy
        have hsum : (segs.map (·.dur)).sum = P.T :=
          (enumFrom_sound P segs P.T none hsegs).1
        refine ⟨score P segs.reverse,
          List.mem_map_of_mem (reverse_mem_enumFrom_none P hsegs), ?_⟩
        rw [← hsc, scoreRev_eq P segs P.T hsum]
        exact Score.le_refl _
    rw [stepA]
    have stepB : Score.listMax ((enumFrom P none P.T).map (scoreRev P P.T))
        = Score.listMax
            (((List.range P.S).flatMap fun s => enumEnd P s P.T).map (scoreRev P P.T)) := by
      apply Score.listMax_eq_of_exists
      · intro x hx
        obtain ⟨segs, hsegs, hsc⟩ := List.mem_map.mp hx
        obtain ⟨hsum, hbounds, hadj, _⟩ := enumFrom_sound P segs P.T none hsegs
        cases segs with
        | nil =>
          simp only [List.map_nil, List.sum_nil] at hsum
          omega
        | cons x0 rest =>
          obtain ⟨s0, d0'⟩ := x0
          refine ⟨x, ?_, Score.le_refl _⟩
          rw [← hsc]
          apply List.mem_map_of_mem
          simp only [List.mem_flatMap, List.mem_range]
          refine ⟨s0, (hbounds ⟨s0, d0'⟩ (List.mem_cons_self ..)).2.2, ?_⟩
          apply enumEnd_complete P P.T s0 d0' rest ?_ hbounds hadj
          simp only [List.map_cons, List.sum_cons] at hsum
          exact hsum
      · intro y hy
        obtain ⟨segs, hsegs, hsc⟩ := List.mem_map.mp hy
        simp only [List.mem_flatMap, List.mem_range] at hsegs
        obtain ⟨s0, hs0, hmem⟩ := hsegs
        refine ⟨y, ?_, Score.le_refl _⟩
        rw [← hsc]
        exact List.mem_map_of_mem (enumEnd_subset P P.T s0 segs hs0 hmem)
    rw [stepB, List.map_flatMap, Score.listMax_flatMap]
    congr 1
    apply List.map_congr_left
    intro s _
    exact bestEnd_eq P P.T s

end Verified.Hsmm
