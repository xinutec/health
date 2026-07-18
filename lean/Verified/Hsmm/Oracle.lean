import Verified.Hsmm.Spec

/-!
# Brute-force oracle

Enumerates *every* well-formed segmentation and takes the best score. This is
the executable form of the spec — exponential, usable only on tiny instances,
but obviously correct. The trellis is checked against it: same best score, and
the trellis's returned path must itself score that maximum (self-consistency),
which pins the decoder without depending on tie-breaking order.

`enum_sound` proves everything the enumerator returns is well-formed; the
completeness direction (every well-formed segmentation is enumerated) and the
trellis equivalence theorem are the pilot's next milestones — see the roadmap
in `docs/proposals/2026-07-verified-core-lean.md`.
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

end Verified.Hsmm
