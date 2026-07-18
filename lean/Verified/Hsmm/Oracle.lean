import Verified.Hsmm.Spec

/-!
# Brute-force oracle

Enumerates *every* well-formed segmentation and takes the best score. This is
the executable form of the spec — exponential, usable only on tiny instances,
but obviously correct. The trellis is checked against it: same best score, and
the trellis's returned path must itself score that maximum (self-consistency),
which pins the decoder without depending on tie-breaking order.

`enum_sound` and `enum_complete` together (`enum_iff`) prove the enumeration
is *exactly* the well-formed segmentations, so `oracleBest` is a genuine,
attained maximum (`oracleBest_ge`, `oracleBest_attained`). The remaining
pilot milestone is the trellis-refinement theorem — see the roadmap in
`docs/proposals/2026-07-verified-core-lean.md`.
-/

namespace Verified.Hsmm

/-- All well-formed segmentations of a window of `r` remaining minutes, where
`prev` is the state of the preceding segment (`none` at the very start).
Recursion on `r`: each segment consumes `d ≥ 1` minutes. -/
def enumFrom (P : Problem) (prev : Option Nat) : (r : Nat) → List (List Seg)
  | 0 => [[]]
  | r + 1 =>
    (List.range P.S).flatMap fun s =>
      if prev == some s then []
      else
        (List.range (Nat.min P.maxD (r + 1))).flatMap fun d0 =>
          let d := d0 + 1
          (enumFrom P (some s) (r + 1 - d)).map (⟨s, d⟩ :: ·)
  termination_by r => r
  decreasing_by omega

/-- Every well-formed segmentation of the full window. -/
def enumAll (P : Problem) : List (List Seg) :=
  enumFrom P none P.T

/-- The best achievable score over all well-formed segmentations. -/
def oracleBest (P : Problem) : Score :=
  Score.listMax ((enumAll P).map (score P))

/-- A best-scoring segmentation, when any scores above `-∞`. -/
def oracleArgmax (P : Problem) : Option (List Seg) :=
  let best := oracleBest P
  if best == Score.negInf then none
  else (enumAll P).find? (fun segs => score P segs == best)

/-- Everything `enumFrom` produces for a window of `r` remaining minutes:
durations sum to `r`, every segment is in bounds, adjacent states differ, and
the head does not repeat the preceding segment's state. -/
theorem enumFrom_sound (P : Problem) (segs : List Seg) :
    ∀ (r : Nat) (prev : Option Nat), segs ∈ enumFrom P prev r →
    (segs.map (·.dur)).sum = r
      ∧ (∀ seg ∈ segs, 1 ≤ seg.dur ∧ seg.dur ≤ P.maxD ∧ seg.state < P.S)
      ∧ adjDistinct segs = true
      ∧ (∀ st d rest, segs = ⟨st, d⟩ :: rest → prev ≠ some st) := by
  induction segs with
  | nil =>
    intro r prev h
    cases r with
    | zero => simp [adjDistinct]
    | succ r' =>
      exfalso
      simp only [enumFrom, List.mem_flatMap, List.mem_range] at h
      obtain ⟨s, _, hmem⟩ := h
      cases hb : prev == some s with
      | true => simp [hb] at hmem
      | false => simp [hb] at hmem
  | cons seg tail ih =>
    intro r prev h
    cases r with
    | zero => simp [enumFrom] at h
    | succ r' =>
      simp only [enumFrom, List.mem_flatMap, List.mem_range] at h
      obtain ⟨s, hs, hmem⟩ := h
      cases hb : prev == some s with
      | true => simp [hb] at hmem
      | false =>
        simp only [hb, Bool.false_eq_true, if_false, List.mem_flatMap,
          List.mem_range, List.mem_map] at hmem
        obtain ⟨d0, hd0, tail', htail', hEq⟩ := hmem
        have hmaxd : d0 < P.maxD := Nat.lt_of_lt_of_le hd0 (Nat.min_le_left _ _)
        have hrle : d0 < r' + 1 := Nat.lt_of_lt_of_le hd0 (Nat.min_le_right _ _)
        obtain ⟨hseg, htl⟩ := List.cons.inj hEq
        subst hseg
        subst htl
        obtain ⟨hsum, hbounds, hadj, hhead⟩ := ih (r' + 1 - (d0 + 1)) (some s) htail'
        refine ⟨?_, ?_, ?_, ?_⟩
        · simp only [List.map_cons, List.sum_cons, hsum]
          omega
        · intro sg hsg
          rcases List.mem_cons.mp hsg with hE | hT
          · subst hE
            -- The projections reduce definitionally on the literal segment.
            exact ⟨Nat.succ_le_succ (Nat.zero_le _), hmaxd, hs⟩
          · exact hbounds sg hT
        · cases tail' with
          | nil => simp [adjDistinct]
          | cons t2 rest2 =>
            have hne : s ≠ t2.state := fun hE =>
              hhead t2.state t2.dur rest2 rfl (by rw [hE])
            simp only [adjDistinct, Bool.and_eq_true, bne_iff_ne, ne_eq]
            exact ⟨hne, hadj⟩
        · intro st d rest hE
          cases hE
          simpa using hb

/-- Everything the oracle enumerates is well-formed. -/
theorem enum_sound (P : Problem) {segs : List Seg} (h : segs ∈ enumAll P) :
    wellFormed P segs = true := by
  obtain ⟨hsum, hbounds, hadj, _⟩ := enumFrom_sound P segs P.T none h
  simp only [wellFormed, Bool.and_eq_true, beq_iff_eq, List.all_eq_true]
  refine ⟨⟨hsum, ?_⟩, hadj⟩
  intro seg hseg
  obtain ⟨h1, h2, h3⟩ := hbounds seg hseg
  simp only [decide_eq_true_eq]
  exact ⟨⟨h1, h2⟩, h3⟩

theorem adjDistinct_tail {a : Seg} {l : List Seg} (h : adjDistinct (a :: l) = true) :
    adjDistinct l = true := by
  cases l with
  | nil => rfl
  | cons b rest =>
    simp only [adjDistinct, Bool.and_eq_true] at h
    exact h.2

/-- Completeness of the enumerator: any segment list with the invariants of
`enumFrom_sound` — durations summing to the window, per-segment bounds,
adjacent-distinct states, and a head state differing from `prev` — is among
`enumFrom P prev r`'s output. -/
theorem enumFrom_complete (P : Problem) (segs : List Seg) :
    ∀ (r : Nat) (prev : Option Nat),
      (segs.map (·.dur)).sum = r →
      (∀ seg ∈ segs, 1 ≤ seg.dur ∧ seg.dur ≤ P.maxD ∧ seg.state < P.S) →
      adjDistinct segs = true →
      (∀ st d rest, segs = ⟨st, d⟩ :: rest → prev ≠ some st) →
      segs ∈ enumFrom P prev r := by
  induction segs with
  | nil =>
    intro r prev hsum _ _ _
    simp only [List.map_nil, List.sum_nil] at hsum
    subst hsum
    simp [enumFrom]
  | cons seg tail ih =>
    obtain ⟨s, d⟩ := seg
    intro r prev hsum hbounds hadj hhead
    obtain ⟨hb1, hb2, hb3⟩ := hbounds ⟨s, d⟩ (List.mem_cons_self ..)
    -- Re-state the bounds over the plain variables (the structure-literal
    -- projections are defeq but opaque to omega).
    have hd1 : 1 ≤ d := hb1
    have hdmax : d ≤ P.maxD := hb2
    have hsS : s < P.S := hb3
    simp only [List.map_cons, List.sum_cons] at hsum
    have hsum' : d + (tail.map (·.dur)).sum = r := hsum
    clear hsum
    cases r with
    | zero => omega
    | succ r' =>
      have hbeq : (prev == some s) = false := by
        simpa using hhead s d tail rfl
      simp only [enumFrom, List.mem_flatMap, List.mem_range]
      refine ⟨s, hsS, ?_⟩
      rw [hbeq]
      simp only [Bool.false_eq_true, if_false, List.mem_flatMap, List.mem_range, List.mem_map]
      have hdle : d ≤ r' + 1 := by omega
      refine ⟨d - 1, ?_, tail, ?_, ?_⟩
      · simp only [Nat.min_def]; split <;> omega
      · have hd : d - 1 + 1 = d := by omega
        rw [hd]
        apply ih
        · omega
        · intro sg hsg; exact hbounds sg (List.mem_cons_of_mem _ hsg)
        · exact adjDistinct_tail hadj
        · intro st d2 rest hE
          subst hE
          simp only [adjDistinct, Bool.and_eq_true, bne_iff_ne, ne_eq] at hadj
          intro hcontra
          exact hadj.1 (Option.some.inj hcontra)
      · have hd : d - 1 + 1 = d := by omega
        rw [hd]

/-- Every well-formed segmentation is enumerated by the oracle. -/
theorem enum_complete (P : Problem) {segs : List Seg} (h : wellFormed P segs = true) :
    segs ∈ enumAll P := by
  simp only [wellFormed, Bool.and_eq_true, beq_iff_eq, List.all_eq_true,
    decide_eq_true_eq] at h
  obtain ⟨⟨hsum, hbounds⟩, hadj⟩ := h
  refine enumFrom_complete P segs P.T none hsum ?_ hadj ?_
  · intro seg hseg
    obtain ⟨⟨h1, h2⟩, h3⟩ := hbounds seg hseg
    exact ⟨h1, h2, h3⟩
  · intro st d rest _ hE
    simp at hE

/-- The oracle's enumeration is exactly the well-formed segmentations. -/
theorem enum_iff (P : Problem) (segs : List Seg) :
    segs ∈ enumAll P ↔ wellFormed P segs = true :=
  ⟨enum_sound P, enum_complete P⟩

/-- `oracleBest` really is an upper bound over every well-formed segmentation. -/
theorem oracleBest_ge (P : Problem) {segs : List Seg} (h : wellFormed P segs = true) :
    score P segs ≤ oracleBest P :=
  Score.listMax_ge (List.mem_map_of_mem (enum_complete P h))

/-- `oracleBest` is attained by a well-formed segmentation, unless nothing
scores above `-∞`. -/
theorem oracleBest_attained (P : Problem) :
    (∃ segs, wellFormed P segs = true ∧ score P segs = oracleBest P)
      ∨ oracleBest P = Score.negInf := by
  rcases Score.listMax_mem_or_negInf ((enumAll P).map (score P)) with h | h
  · obtain ⟨segs, hmem, hsc⟩ := List.mem_map.mp h
    exact .inl ⟨segs, enum_sound P hmem, hsc⟩
  · exact .inr h

end Verified.Hsmm
