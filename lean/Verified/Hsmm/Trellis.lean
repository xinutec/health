import Verified.Hsmm.Forward

/-!
# The trellis recurrence, functionally

`col P t s τ` is the trellis cell after processing minute `t`: the best score
of any prefix of `[0, t]` whose current *open* segment (duration prior not yet
paid) is a run of state `s` of length exactly `τ`. This is precisely what the
imperative array in `Viterbi.lean` stores at `(s, τ)` — stated here as a pure
recurrence so it can be proved correct.

- `openVal` gives the cell's intended meaning in terms of the (already proved)
  forward DP `bestEnd`;
- `col_eq_openVal` is the column invariant: every cell means what it should;
- `closeB` is the trellis's per-`t` "best close of a segment ending here", and
  `closeB_eq` shows closing the open run recovers `bestEnd` exactly;
- `trellisScore` is the final closure at `T - 1`, and
  `trellisScore_eq_oracleBest` proves the whole recurrence decodes the true
  optimum — with *no* side conditions: degenerate shapes (`T = 0`, `S = 0`,
  `maxD = 0`) are handled explicitly.

The remaining (V1) gap to `Viterbi.lean` is now mechanical: the array code
computes `col` columns with rolling buffers and picks argmaxes in a fixed
order; its refinement (plus backtrack correctness) is the next step.
-/

namespace Verified.Hsmm

/-- Snoc form of `emitRun`: one more minute of the run pays its emission at
the end. -/
theorem emitRun_succ (P : Problem) (s : Nat) :
    ∀ (d start : Nat), emitRun P s start (d + 1) = emitRun P s start d + P.emit (start + d) s := by
  intro d
  induction d with
  | zero =>
    intro start
    simp [emitRun]
  | succ d ih =>
    intro start
    rw [show emitRun P s start (d + 1 + 1) = P.emit start s + emitRun P s (start + 1) (d + 1)
      from rfl]
    rw [ih (start + 1)]
    rw [show emitRun P s start (d + 1) = P.emit start s + emitRun P s (start + 1) d from rfl]
    rw [← Score.add_assoc]
    have h : start + 1 + d = start + (d + 1) := by omega
    rw [h]

/-- The trellis column recurrence. `τ = 1` starts a new segment from the best
closing predecessor; `τ ≥ 2` continues the open run. -/
def col (P : Problem) : (t : Nat) → Nat → Nat → Score
  | 0, s, tau =>
    if tau = 1 then P.init s + P.entry s 0 + P.emit 0 s else Score.negInf
  | t + 1, s, tau =>
    if tau = 1 then
      Score.listMax ((List.range P.S).flatMap fun sp =>
        if sp == s then []
        else
          [Score.listMax ((List.range P.maxD).map fun t0 =>
              col P t sp (t0 + 1) + P.dur sp (t0 + 1) t)
            + P.trans sp s (t + 1)])
        + P.entry s (t + 1) + P.emit (t + 1) s
    else if 2 ≤ tau ∧ tau ≤ P.maxD then
      col P t s (tau - 1) + P.emit (t + 1) s
    else Score.negInf

/-- Best close-of-segment score at minute `t` for state `sp` — the trellis's
per-`t` precomputation (`closeBestScore` in the imperative code). -/
def closeB (P : Problem) (t sp : Nat) : Score :=
  Score.listMax ((List.range P.maxD).map fun t0 =>
    col P t sp (t0 + 1) + P.dur sp (t0 + 1) t)

/-- What a trellis cell *means*: the open run of length `τ` started at `start`;
everything before it is a closed segmentation ending in some `sp ≠ s`
(`bestEnd`), paying the transition at `start` — or `init` when `start = 0`. -/
def openVal (P : Problem) (start s tau : Nat) : Score :=
  (if start = 0 then P.init s
   else
     Score.listMax ((List.range P.S).flatMap fun sp =>
       if sp == s then [] else [bestEnd P sp start + P.trans sp s start]))
    + P.entry s start + emitRun P s start tau

/-- Closing the open run recovers the forward DP: assuming the column invariant
at `t`, the best "cell + duration prior" over `τ` equals `bestEnd` at `t + 1`. -/
theorem closeB_eq (P : Problem) (hmaxD : 1 ≤ P.maxD) (t : Nat)
    (ih : ∀ s tau, col P t s tau
      = if 1 ≤ tau ∧ tau ≤ P.maxD ∧ tau ≤ t + 1
        then openVal P (t + 1 - tau) s tau
        else Score.negInf)
    (s : Nat) :
    Score.listMax ((List.range P.maxD).map fun t0 =>
        col P t s (t0 + 1) + P.dur s (t0 + 1) t)
      = bestEnd P s (t + 1) := by
  have helt : ∀ t0 ∈ List.range P.maxD,
      col P t s (t0 + 1) + P.dur s (t0 + 1) t
        = if t0 + 1 ≤ t + 1
          then openVal P (t + 1 - (t0 + 1)) s (t0 + 1) + P.dur s (t0 + 1) t
          else Score.negInf := by
    intro t0 ht0
    rw [List.mem_range] at ht0
    rw [ih s (t0 + 1)]
    by_cases hle : t0 + 1 ≤ t + 1
    · rw [if_pos (by omega), if_pos hle]
    · rw [if_neg (by omega), if_neg hle]
      rfl
  rw [List.map_congr_left helt]
  rw [Score.listMax_map_range_pad _ (Nat.min_le_left P.maxD (t + 1))
    (by rw [Nat.min_def]; split <;> omega)
    (by
      intro i hi hik
      have hgt : ¬(i + 1 ≤ t + 1) := by
        rw [Nat.min_def] at hi
        split at hi <;> omega
      rw [if_neg hgt])]
  have helt2 : ∀ t0 ∈ List.range (Nat.min P.maxD (t + 1)),
      (if t0 + 1 ≤ t + 1
        then openVal P (t + 1 - (t0 + 1)) s (t0 + 1) + P.dur s (t0 + 1) t
        else Score.negInf)
        = openVal P (t + 1 - (t0 + 1)) s (t0 + 1) + P.dur s (t0 + 1) t := by
    intro t0 ht0
    rw [List.mem_range] at ht0
    have ht0' : t0 < t + 1 := Nat.lt_of_lt_of_le ht0 (Nat.min_le_right _ _)
    rw [if_pos (by omega)]
  rw [List.map_congr_left helt2]
  simp only [bestEnd]
  rw [Score.listMax_flatMap]
  congr 1
  apply List.map_congr_left
  intro d0 hd0
  rw [List.mem_range] at hd0
  have hd0t : d0 < t + 1 := Nat.lt_of_lt_of_le hd0 (Nat.min_le_right _ _)
  by_cases hz : t + 1 - (d0 + 1) = 0
  · have hbeq : (t + 1 - (d0 + 1) == 0) = true := beq_iff_eq.mpr hz
    rw [hbeq, if_pos rfl]
    rw [openVal, if_pos hz]
    simp only [Score.listMax_cons, Score.listMax_nil, Score.max_negInf]
    simp only [segScore]
    have harg : t + 1 - (d0 + 1) + (d0 + 1) - 1 = t := by omega
    rw [harg]
  · have hbeq : (t + 1 - (d0 + 1) == 0) = false := beq_eq_false_iff_ne.mpr hz
    rw [hbeq]
    simp only [Bool.false_eq_true, if_false]
    rw [openVal, if_neg hz]
    rw [Score.listMax_flatMap_ite, Score.listMax_flatMap_ite]
    rw [Score.listMax_add, List.map_map, Score.listMax_add, List.map_map,
      Score.listMax_add, List.map_map]
    apply congrArg
    apply List.map_congr_left
    intro sp _
    cases hsp : sp == s
    · simp only [Function.comp, hsp, Bool.false_eq_true, if_false]
      simp only [segScore]
      have harg : t + 1 - (d0 + 1) + (d0 + 1) - 1 = t := by omega
      rw [harg]
      rw [Score.add_comm _ (bestEnd P sp (t + 1 - (d0 + 1)))]
      simp only [Score.add_assoc]
    · simp [Function.comp, hsp]

/-- The column invariant: every trellis cell equals its intended `openVal`
meaning (and is `-∞` outside the valid `(τ, t)` window). -/
theorem col_eq_openVal (P : Problem) (hmaxD : 1 ≤ P.maxD) :
    ∀ (t s tau : Nat),
      col P t s tau
        = if 1 ≤ tau ∧ tau ≤ P.maxD ∧ tau ≤ t + 1
          then openVal P (t + 1 - tau) s tau
          else Score.negInf := by
  intro t
  induction t with
  | zero =>
    intro s tau
    by_cases h1 : tau = 1
    · subst h1
      simp only [col]
      rw [if_pos trivial, if_pos (by omega)]
      rw [openVal, if_pos rfl]
      simp [emitRun]
    · simp only [col]
      rw [if_neg h1, if_neg (by omega)]
  | succ t ih =>
    intro s tau
    by_cases h1 : tau = 1
    · subst h1
      simp only [col]
      rw [if_pos trivial, if_pos (by omega)]
      have hclose : ∀ sp,
          Score.listMax ((List.range P.maxD).map fun t0 =>
            col P t sp (t0 + 1) + P.dur sp (t0 + 1) t)
            = bestEnd P sp (t + 1) := fun sp => closeB_eq P hmaxD t ih sp
      simp only [hclose]
      rw [show t + 1 + 1 - 1 = t + 1 from rfl]
      rw [openVal, if_neg (Nat.succ_ne_zero t)]
      simp [emitRun]
    · simp only [col]
      rw [if_neg h1]
      by_cases h2 : 2 ≤ tau ∧ tau ≤ P.maxD
      · rw [if_pos h2]
        obtain ⟨tau', rfl⟩ : ∃ tau', tau = tau' + 1 := ⟨tau - 1, by omega⟩
        rw [show tau' + 1 - 1 = tau' from rfl]
        rw [ih s tau']
        by_cases h3 : tau' + 1 ≤ t + 1 + 1
        · rw [if_pos (by omega), if_pos (by omega)]
          have hstart : t + 1 - tau' = t + 1 + 1 - (tau' + 1) := by omega
          rw [hstart]
          rw [openVal, openVal]
          rw [Score.add_assoc]
          congr 1
          rw [emitRun_succ]
          have harg : t + 1 + 1 - (tau' + 1) + tau' = t + 1 := by omega
          rw [harg]
        · rw [if_neg (by omega), if_neg (by omega)]
          rfl
      · rw [if_neg h2, if_neg (by omega)]

theorem flatMap_const_nil {α β : Type} (l : List α) :
    (l.flatMap fun _ => ([] : List β)) = [] := by
  induction l with
  | nil => rfl
  | cons a l ih => simp [ih]

/-- The trellis's final closure at `T - 1` (the answer the decoder reports). -/
def trellisScore (P : Problem) : Score :=
  if P.T = 0 then Score.zero
  else Score.listMax ((List.range P.S).map fun s => closeB P (P.T - 1) s)

/-- **The trellis recurrence is correct**: its final closure is the oracle's
best score, for every problem shape (degenerate ones included). -/
theorem trellisScore_eq_oracleBest (P : Problem) : trellisScore P = oracleBest P := by
  rw [trellisScore]
  by_cases hT : P.T = 0
  · rw [if_pos hT]
    simp [oracleBest, enumAll, hT, enumFrom, score, scoreAux, Score.listMax_cons]
  · rw [if_neg hT]
    by_cases hmaxD : 1 ≤ P.maxD
    · have hinv := col_eq_openVal P hmaxD (P.T - 1)
      have hclose : ∀ s ∈ List.range P.S, closeB P (P.T - 1) s = bestEnd P s P.T := by
        intro s _
        have h := closeB_eq P hmaxD (P.T - 1) hinv s
        rw [show P.T - 1 + 1 = P.T from by omega] at h
        exact h
      rw [List.map_congr_left hclose]
      have h := forwardBest_eq_oracleBest P
      rw [forwardBest] at h
      have hb : (P.T == 0) = false := beq_eq_false_iff_ne.mpr hT
      rw [hb] at h
      simp only [Bool.false_eq_true, if_false] at h
      exact h
    · have hm0 : P.maxD = 0 := by omega
      have hL : ∀ s ∈ List.range P.S, closeB P (P.T - 1) s = Score.negInf := by
        intro s _
        simp [closeB, hm0]
      rw [List.map_congr_left hL]
      rw [Score.listMax_eq_negInf_of_all (by
        intro x hx
        obtain ⟨_, _, hfx⟩ := List.mem_map.mp hx
        exact hfx.symm)]
      obtain ⟨t', ht'⟩ : ∃ t', P.T = t' + 1 := ⟨P.T - 1, by omega⟩
      rw [oracleBest, enumAll, ht']
      simp [enumFrom, hm0, flatMap_const_nil]

end Verified.Hsmm
