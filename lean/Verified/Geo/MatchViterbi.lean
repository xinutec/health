import Verified.Hsmm.Score
import Verified.Hsmm.Decode

/-!
# Abstract first-order Viterbi optimality

The matcher's trajectory decoder (`qMatchTrajectory` in `Match.lean`) is a
plain first-order max-sum trellis: one layer per observation, `width t`
candidates at layer `t`, a node score `emit t j`, and an edge weight
`step t i j` between consecutive layers (`-∞` when the two candidates are not
route-connected — which, by `qRouteBetween_route_pure`, is a well-defined pure
function of the graph, so this trellis is well-defined).

This file proves the flagship optimality for such a trellis, on a clean
spec-style decoder — the matcher analogue of the HSMM `decode_correct` /
`decode_none_iff`, one dimension simpler (no segment durations):

* `cell_eq_listMax` — the forward DP cell equals the max declarative score over
  all in-range paths reaching it (the tropical-semiring heart: addition
  distributes over the running maximum, `Score.add_listMax` / `add_max`);
* `bestPath_score` — the backtracked path attains its cell value;
* `decode_argmax` — the decoded path attains the maximum `pathScore` over every
  length-`T` candidate chain;
* `decode_none_iff` — the decoder returns `none` exactly when no chain has a
  finite score.

Reuses `Verified.Hsmm.Score` (the exact-integer tropical semiring: `+` = `⊗`,
`Score.max` = `⊕`, `negInf` = `-∞`, `listMax`, and the distributivity kit).
-/

namespace Verified.Geo.MatchViterbi

open Verified.Hsmm (Score)

/-- A first-order max-sum trellis over layers `0 … T-1`. -/
structure Trellis where
  /-- Number of layers (observations). -/
  T : Nat
  /-- Candidate count at each layer. -/
  width : Nat → Nat
  /-- Node score `e(t,j)`. -/
  emit : Nat → Nat → Score
  /-- Edge weight from candidate `i` at layer `t-1` to `j` at layer `t`
  (`negInf` = not connected). -/
  step : Nat → Nat → Nat → Score

/-- The node score with an in-range guard: out-of-range indices score `-∞`. -/
def emitG (Tr : Trellis) (layer j : Nat) : Score :=
  if j < Tr.width layer then Tr.emit layer j else Score.negInf

/-- Declarative score of a candidate chain, threading the layer index and the
previous choice. The first element pays only its emission; every later element
pays the edge weight from its predecessor plus its own emission. -/
def scoreAux (Tr : Trellis) : Nat → Option Nat → List Nat → Score
  | _, _, [] => Score.zero
  | layer, prev, j :: rest =>
    (match prev with
      | none => Score.zero
      | some p => Tr.step layer p j)
    + emitG Tr layer j
    + scoreAux Tr (layer + 1) (some j) rest

/-- Score of a whole chain (layer 0 first). -/
def pathScore (Tr : Trellis) (js : List Nat) : Score := scoreAux Tr 0 none js

/-- All in-range chains of length `t+1` whose last element is `j`. -/
def pathsTo (Tr : Trellis) : Nat → Nat → List (List Nat)
  | 0, j => [[j]]
  | t + 1, j => ((List.range (Tr.width t)).flatMap (fun i => pathsTo Tr t i)).map (· ++ [j])

/-- The forward DP cell: best partial score of an in-range chain reaching
`(t, j)`. -/
def cell (Tr : Trellis) : Nat → Nat → Score
  | 0, j => emitG Tr 0 j
  | t + 1, j =>
    Score.listMax ((List.range (Tr.width t)).map (fun i => cell Tr t i + Tr.step (t + 1) i j))
      + emitG Tr (t + 1) j

/-! ## The append algebra and the cell/paths correspondence -/

open Verified.Hsmm.Score

/-- The incoming-edge summand: `-∞`-safe for the first layer (`none`). -/
def stepG (Tr : Trellis) (prev : Option Nat) (layer j : Nat) : Score :=
  match prev with
  | none => Score.zero
  | some p => Tr.step layer p j

/-- The "previous choice after consuming `xs`" the score threads. -/
def finalPrev : Option Nat → List Nat → Option Nat
  | prev, [] => prev
  | _, x :: rest => finalPrev (some x) rest

theorem finalPrev_snoc (prev : Option Nat) (xs : List Nat) (k : Nat) :
    finalPrev prev (xs ++ [k]) = some k := by
  induction xs generalizing prev with
  | nil => rfl
  | cons x rest ih => simpa [finalPrev] using ih (some x)

/-- Appending one element to a scored chain adds exactly that element's edge
and emission at the extended layer. -/
theorem scoreAux_snoc (Tr : Trellis) (j : Nat) :
    ∀ (xs : List Nat) (layer : Nat) (prev : Option Nat),
      scoreAux Tr layer prev (xs ++ [j])
        = scoreAux Tr layer prev xs
          + (stepG Tr (finalPrev prev xs) (layer + xs.length) j
              + emitG Tr (layer + xs.length) j) := by
  intro xs
  induction xs with
  | nil =>
    intro layer prev
    simp only [List.nil_append, scoreAux, finalPrev, List.length_nil, Nat.add_zero, stepG,
      Score.add_zero, Score.zero_add]
  | cons x rest ih =>
    intro layer prev
    rw [List.cons_append]
    simp only [scoreAux]
    rw [ih (layer + 1) (some x)]
    simp only [finalPrev, List.length_cons]
    rw [show layer + 1 + rest.length = layer + (rest.length + 1) by omega]
    ac_rfl

theorem pathsTo_length (Tr : Trellis) :
    ∀ (t j : Nat) (p : List Nat), p ∈ pathsTo Tr t j → p.length = t + 1 := by
  intro t
  induction t with
  | zero => intro j p hp; simp only [pathsTo, List.mem_singleton] at hp; subst hp; rfl
  | succ t ih =>
    intro j p hp
    simp only [pathsTo, List.mem_map, List.mem_flatMap, List.mem_range] at hp
    obtain ⟨q, ⟨i, _, hq⟩, rfl⟩ := hp
    simp only [List.length_append, List.length_cons, List.length_nil, ih i q hq]

theorem pathsTo_ends (Tr : Trellis) :
    ∀ (t j : Nat) (p : List Nat), p ∈ pathsTo Tr t j → ∃ r, p = r ++ [j] := by
  intro t
  cases t with
  | zero => intro j p hp; simp only [pathsTo, List.mem_singleton] at hp; exact ⟨[], hp⟩
  | succ t =>
    intro j p hp
    simp only [pathsTo, List.mem_map] at hp
    obtain ⟨q, _, rfl⟩ := hp
    exact ⟨q, rfl⟩

/-- Score of a path extended by `j`, when the path ends at `i` and has the
right length — the per-edge increment the DP recurrence pays. -/
theorem pathScore_snoc (Tr : Trellis) {t i j : Nat} {p : List Nat}
    (hmem : p ∈ pathsTo Tr t i) :
    pathScore Tr (p ++ [j]) = pathScore Tr p + Tr.step (t + 1) i j + emitG Tr (t + 1) j := by
  obtain ⟨r, hr⟩ := pathsTo_ends Tr t i p hmem
  have hlen := pathsTo_length Tr t i p hmem
  unfold pathScore
  rw [scoreAux_snoc Tr j p 0 none]
  have hfp : finalPrev none p = some i := by rw [hr]; exact finalPrev_snoc none r i
  rw [hfp, Nat.zero_add, hlen]
  simp only [stepG]
  rw [Score.add_assoc]

/-- **The cell is the max declarative score over all paths reaching it.** The
tropical-semiring heart of Viterbi correctness: the DP's running maximum-of-
sums equals the maximum over enumerated chains, because addition distributes
over the maximum (`Score.listMax_add_map`). -/
theorem cell_eq_listMax (Tr : Trellis) :
    ∀ (t j : Nat), cell Tr t j = listMax ((pathsTo Tr t j).map (pathScore Tr)) := by
  intro t
  induction t with
  | zero =>
    intro j
    simp only [cell, pathsTo, List.map_cons, List.map_nil, listMax_cons, listMax_nil, max_negInf]
    show emitG Tr 0 j = pathScore Tr [j]
    simp [pathScore, scoreAux, Score.zero_add, Score.add_zero]
  | succ t ih =>
    intro j
    -- Rewrite the RHS back to the cell recurrence.
    rw [pathsTo]
    rw [List.map_map, List.map_flatMap, listMax_flatMap]
    -- Inner per-`i` maximum, using the snoc increment on members of `pathsTo t i`.
    have hinner : ∀ i ∈ List.range (Tr.width t),
        listMax ((pathsTo Tr t i).map ((pathScore Tr) ∘ (· ++ [j])))
          = (cell Tr t i + Tr.step (t + 1) i j) + emitG Tr (t + 1) j := by
      intro i _
      have hcongr : (pathsTo Tr t i).map ((pathScore Tr) ∘ (· ++ [j]))
          = (pathsTo Tr t i).map (fun p =>
              (pathScore Tr p + Tr.step (t + 1) i j) + emitG Tr (t + 1) j) := by
        apply List.map_congr_left
        intro p hp
        simp only [Function.comp]
        rw [pathScore_snoc Tr hp]
      rw [hcongr]
      rw [show (fun p => (pathScore Tr p + Tr.step (t + 1) i j) + emitG Tr (t + 1) j)
            = (fun p => pathScore Tr p + (Tr.step (t + 1) i j + emitG Tr (t + 1) j)) from
          funext fun p => Score.add_assoc _ _ _]
      rw [listMax_add_map, ← ih i, Score.add_assoc]
    rw [List.map_congr_left hinner]
    -- Pull the shared `emitG (t+1) j` out of the outer maximum.
    rw [show (fun i => (cell Tr t i + Tr.step (t + 1) i j) + emitG Tr (t + 1) j)
          = (fun i => (fun i => cell Tr t i + Tr.step (t + 1) i j) i + emitG Tr (t + 1) j) from rfl,
      listMax_add_map]
    rfl

/-! ## The decoder, its optimality, and the `none` characterisation -/

open Verified.Hsmm (pickBest pickBest_some pickBest_none)

/-- `listMax = -∞` forces every element to `-∞`. -/
private theorem listMax_negInf_all {xs : List Score} (h : listMax xs = Score.negInf) :
    ∀ x ∈ xs, x = Score.negInf := fun x hx =>
  Score.le_antisymm (h ▸ listMax_ge hx) (Score.negInf_le x)

/-- `pickBest` finds nothing exactly when every element scores `-∞`. -/
private theorem pickBest_none_of_all {α : Type} (f : α → Score) :
    ∀ (l : List α), (∀ x ∈ l, f x = Score.negInf) → pickBest f l = none := by
  intro l
  induction l with
  | nil => intro _; rfl
  | cons y ys ih =>
    intro h
    simp only [pickBest, ih (fun x hx => h x (List.mem_cons_of_mem _ hx)),
      h y (List.mem_cons_self ..), beq_self_eq_true, if_true]

/-- Backtracked optimal chain to `(t, j)`: pick the best predecessor by
`pickBest`, recurse, and append `j`. `none` when the layer is unreachable. -/
def decodeTo (Tr : Trellis) : Nat → Nat → Option (List Nat)
  | 0, j => if j < Tr.width 0 then some [j] else none
  | t + 1, j =>
    match pickBest (fun i => cell Tr t i + Tr.step (t + 1) i j) (List.range (Tr.width t)) with
    | none => none
    | some (i, _) =>
      match decodeTo Tr t i with
      | none => none
      | some p => if j < Tr.width (t + 1) then some (p ++ [j]) else none

/-- Whatever `decodeTo` returns is a valid chain to `(t, j)` attaining the
cell value. -/
theorem decodeTo_score (Tr : Trellis) :
    ∀ (t j : Nat) (p : List Nat), decodeTo Tr t j = some p →
      p ∈ pathsTo Tr t j ∧ pathScore Tr p = cell Tr t j := by
  intro t
  induction t with
  | zero =>
    intro j p h
    simp only [decodeTo] at h
    by_cases hj : j < Tr.width 0
    · rw [if_pos hj] at h
      injection h with hp; subst hp
      refine ⟨by simp [pathsTo], ?_⟩
      show pathScore Tr [j] = cell Tr 0 j
      simp [pathScore, scoreAux, cell, emitG, hj, Score.zero_add, Score.add_zero]
    · rw [if_neg hj] at h; exact absurd h (by simp)
  | succ t ih =>
    intro j p h
    rw [decodeTo] at h
    cases hpb : pickBest (fun i => cell Tr t i + Tr.step (t + 1) i j) (List.range (Tr.width t)) with
    | none => simp only [hpb] at h; exact absurd h (by simp)
    | some q =>
      obtain ⟨i, sc⟩ := q
      simp only [hpb] at h
      cases hdt : decodeTo Tr t i with
      | none => simp only [hdt] at h; exact absurd h (by simp)
      | some r =>
        simp only [hdt] at h
        by_cases hj : j < Tr.width (t + 1)
        · rw [if_pos hj] at h
          injection h with hp; subst hp
          obtain ⟨hrmem, hrsc⟩ := ih i r hdt
          obtain ⟨hscf, hi_mem, -, hi_max⟩ := pickBest_some _ _ i sc hpb
          rw [List.mem_range] at hi_mem
          refine ⟨?_, ?_⟩
          · simp only [pathsTo, List.mem_map, List.mem_flatMap, List.mem_range]
            exact ⟨r, ⟨i, hi_mem, hrmem⟩, rfl⟩
          · rw [pathScore_snoc Tr hrmem, hrsc]
            show cell Tr t i + Tr.step (t + 1) i j + emitG Tr (t + 1) j = cell Tr (t + 1) j
            rw [cell, ← hscf, hi_max]
        · rw [if_neg hj] at h; simp at h

/-- A finite cell is reachable: `decodeTo` returns a chain. -/
theorem decodeTo_some_of_ne (Tr : Trellis) :
    ∀ (t j : Nat), cell Tr t j ≠ Score.negInf → ∃ p, decodeTo Tr t j = some p := by
  intro t
  induction t with
  | zero =>
    intro j h
    rcases Nat.lt_or_ge j (Tr.width 0) with hj | hj
    · exact ⟨[j], by simp [decodeTo, hj]⟩
    · rw [cell, emitG, if_neg (Nat.not_lt.mpr hj)] at h; exact absurd rfl h
  | succ t ih =>
    intro j h
    rw [cell] at h
    have hlm : listMax ((List.range (Tr.width t)).map
        (fun i => cell Tr t i + Tr.step (t + 1) i j)) ≠ Score.negInf := by
      intro he; rw [he] at h; exact h (Score.negInf_add _)
    have hj : j < Tr.width (t + 1) := by
      rcases Nat.lt_or_ge j (Tr.width (t + 1)) with hj | hj
      · exact hj
      · rw [emitG, if_neg (Nat.not_lt.mpr hj)] at h; exact absurd (Score.add_negInf _) h
    cases hpb : pickBest (fun i => cell Tr t i + Tr.step (t + 1) i j) (List.range (Tr.width t)) with
    | none =>
      exact absurd (Score.listMax_eq_negInf_of_all (by
        intro x hx
        obtain ⟨i, hi, hfi⟩ := List.mem_map.mp hx
        rw [← hfi]; exact pickBest_none _ _ hpb i hi)) hlm
    | some q =>
      obtain ⟨i, sc⟩ := q
      obtain ⟨hscf, -, hscne, -⟩ := pickBest_some _ _ i sc hpb
      have hci : cell Tr t i ≠ Score.negInf := by
        intro he; rw [hscf, he, Score.negInf_add] at hscne; exact hscne rfl
      obtain ⟨r, hr⟩ := ih i hci
      exact ⟨r ++ [j], by simp [decodeTo, hpb, hr, hj]⟩

/-- All in-range candidate chains of length `T` (one choice per layer). -/
def allFullPaths (Tr : Trellis) : List (List Nat) :=
  (List.range (Tr.width (Tr.T - 1))).flatMap (pathsTo Tr (Tr.T - 1))

/-- The terminal best score equals the max declarative score over every full
candidate chain (via `cell_eq_listMax`, folded across the last layer). -/
theorem bestScore_eq (Tr : Trellis) :
    listMax ((List.range (Tr.width (Tr.T - 1))).map (fun j => cell Tr (Tr.T - 1) j))
      = listMax ((allFullPaths Tr).map (pathScore Tr)) := by
  rw [List.map_congr_left (fun j _ => cell_eq_listMax Tr (Tr.T - 1) j)]
  rw [← listMax_flatMap, allFullPaths, List.map_flatMap]

/-- The verified decoder: the terminal `pickBest` over the last layer, then
backtrack. -/
def decode (Tr : Trellis) : Option (List Nat) :=
  match pickBest (fun j => cell Tr (Tr.T - 1) j) (List.range (Tr.width (Tr.T - 1))) with
  | none => none
  | some (j, _) => decodeTo Tr (Tr.T - 1) j

/-- **Viterbi argmax.** The decoded chain is a full candidate chain and attains
the maximum declarative score over every full candidate chain. -/
theorem decode_argmax (Tr : Trellis) {p : List Nat} (h : decode Tr = some p) :
    p ∈ allFullPaths Tr ∧ ∀ c ∈ allFullPaths Tr, pathScore Tr c ≤ pathScore Tr p := by
  unfold decode at h
  cases hpb : pickBest (fun j => cell Tr (Tr.T - 1) j) (List.range (Tr.width (Tr.T - 1))) with
  | none => rw [hpb] at h; exact absurd h (by simp)
  | some q =>
    obtain ⟨j, sc⟩ := q
    rw [hpb] at h
    obtain ⟨hscf, hj_mem, -, hscmax⟩ := pickBest_some _ _ j sc hpb
    rw [List.mem_range] at hj_mem
    obtain ⟨hpmem, hpsc⟩ := decodeTo_score Tr (Tr.T - 1) j p h
    have hp_full : p ∈ allFullPaths Tr := by
      simp only [allFullPaths, List.mem_flatMap, List.mem_range]
      exact ⟨j, hj_mem, hpmem⟩
    refine ⟨hp_full, fun c hc => ?_⟩
    have hpscore : pathScore Tr p = listMax ((allFullPaths Tr).map (pathScore Tr)) := by
      rw [hpsc, ← hscf, hscmax, bestScore_eq]
    rw [hpscore]
    exact listMax_ge (List.mem_map_of_mem hc)

/-- **The decoder returns `none` exactly when no full candidate chain has a
finite score.** -/
theorem decode_none_iff (Tr : Trellis) :
    decode Tr = none ↔ ∀ c ∈ allFullPaths Tr, pathScore Tr c = Score.negInf := by
  constructor
  · intro h
    cases hpb : pickBest (fun j => cell Tr (Tr.T - 1) j) (List.range (Tr.width (Tr.T - 1))) with
    | some q =>
      -- A finite terminal cell would decode, contradicting `none`.
      obtain ⟨j, sc⟩ := q
      obtain ⟨hscf, -, hscne, -⟩ := pickBest_some _ _ j sc hpb
      obtain ⟨r, hr⟩ := decodeTo_some_of_ne Tr (Tr.T - 1) j (by rw [← hscf]; exact hscne)
      have hsome : decode Tr = some r := by unfold decode; rw [hpb]; exact hr
      rw [hsome] at h; exact absurd h (by simp)
    | none =>
      have hall : ∀ j ∈ List.range (Tr.width (Tr.T - 1)), cell Tr (Tr.T - 1) j = Score.negInf :=
        pickBest_none _ _ hpb
      intro c hc
      have hlm : listMax ((allFullPaths Tr).map (pathScore Tr)) = Score.negInf := by
        rw [← bestScore_eq]
        exact Score.listMax_eq_negInf_of_all (by
          intro x hx
          obtain ⟨j, hj, hfj⟩ := List.mem_map.mp hx
          rw [← hfj]; exact hall j hj)
      exact listMax_negInf_all hlm _ (List.mem_map_of_mem hc)
  · intro h
    unfold decode
    rw [pickBest_none_of_all _ _ (by
      intro j hj
      rw [cell_eq_listMax Tr (Tr.T - 1) j]
      apply Score.listMax_eq_negInf_of_all
      intro x hx
      obtain ⟨q, hq_mem, hq_score⟩ := List.mem_map.mp hx
      rw [← hq_score]
      apply h
      simp only [allFullPaths, List.mem_flatMap]
      exact ⟨j, hj, hq_mem⟩)]

end Verified.Geo.MatchViterbi
