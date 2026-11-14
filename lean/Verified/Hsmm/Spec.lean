import Verified.Hsmm.Score

/-!
# HSMM decoding — the specification

The decoder's meaning, independent of any algorithm: a segmentation of `[0, T)`
into runs of equal state, its score, and well-formedness. Contract: a path
whose well-formed segmentation scores the maximum, or `none` when every
segmentation scores `-∞`.

The model is a bundle of score functions over `Nat` indices:
  - `emit t s`      — emission of observation `t` under state `s`
  - `trans sp s t`  — transition `sp → s`, at the destination observation `t`
  - `dur s d e`     — duration prior for state `s`, length `d`, last minute `e`
  - `init s`        — initial-state prior at `t = 0`
  - `entry s t`     — per-segment-entry prior at every segment start
-/

namespace Verified.Hsmm

/-- The model + problem size. Everything the trellis's callbacks can express. -/
structure Problem where
  T : Nat
  S : Nat
  maxD : Nat
  emit : Nat → Nat → Score
  trans : Nat → Nat → Nat → Score
  dur : Nat → Nat → Nat → Score
  init : Nat → Score
  entry : Nat → Nat → Score

/-- One segment: a state held for `dur` consecutive minutes. -/
structure Seg where
  state : Nat
  dur : Nat
deriving Repr, DecidableEq

/-- Sum of emissions of state `s` over the `d` observations starting at `start`. -/
def emitRun (P : Problem) (s start : Nat) : (d : Nat) → Score
  | 0 => Score.zero
  | d + 1 => P.emit start s + emitRun P s (start + 1) d

/-- Score of a segmentation, threading the start index and previous state: the
first segment pays `init`, later ones the transition at their first observation;
each pays `entry`, its emissions, and its duration prior at its last minute. -/
def scoreAux (P : Problem) : Nat → Option Nat → List Seg → Score
  | _, _, [] => Score.zero
  | start, prev, seg :: rest =>
    (match prev with
      | none => P.init seg.state
      | some sp => P.trans sp seg.state start)
    + P.entry seg.state start
    + emitRun P seg.state start seg.dur
    + P.dur seg.state seg.dur (start + seg.dur - 1)
    + scoreAux P (start + seg.dur) (some seg.state) rest

/-- Total score of a segmentation of the whole window. -/
def score (P : Problem) (segs : List Seg) : Score :=
  scoreAux P 0 none segs

/-- Adjacent segments must change state (the trellis forbids self-transitions;
a longer run of one state is represented by a longer duration, up to `maxD`). -/
def adjDistinct : List Seg → Bool
  | a :: b :: rest => a.state != b.state && adjDistinct (b :: rest)
  | _ => true

/-- Well-formed segmentation: durations in `[1, maxD]`, states in range,
durations covering exactly `[0, T)`, adjacent states distinct. -/
def wellFormed (P : Problem) (segs : List Seg) : Bool :=
  ((segs.map (·.dur)).sum == P.T)
    && segs.all (fun seg => 1 ≤ seg.dur && seg.dur ≤ P.maxD && seg.state < P.S)
    && adjDistinct segs

theorem adjDistinct_append_singleton (ys : List Seg) (x : Seg) :
    adjDistinct (ys ++ [x])
      = (adjDistinct ys
          && match ys.getLast? with
             | some z => z.state != x.state
             | none => true) := by
  induction ys with
  | nil => simp [adjDistinct]
  | cons y ys ih =>
    cases ys with
    | nil => simp [adjDistinct]
    | cons z zs =>
      simp only [List.cons_append] at ih ⊢
      simp only [adjDistinct, ih, List.getLast?_cons_cons, Bool.and_assoc]

/-- Adjacent-distinctness is direction-agnostic. -/
theorem adjDistinct_reverse (l : List Seg) : adjDistinct l.reverse = adjDistinct l := by
  induction l with
  | nil => rfl
  | cons x xs ih =>
    rw [List.reverse_cons, adjDistinct_append_singleton, ih, List.getLast?_reverse]
    cases xs with
    | nil => rfl
    | cons z zs =>
      simp only [List.head?_cons, adjDistinct]
      rw [Bool.and_comm]
      congr 1
      rw [Bool.eq_iff_iff]
      simp only [bne_iff_ne, ne_eq]
      exact ⟨fun h e => h e.symm, fun h e => h e.symm⟩

/-- The per-minute path a segmentation induces (state repeated `dur` times). -/
def toPath (segs : List Seg) : List Nat :=
  segs.flatMap (fun seg => List.replicate seg.dur seg.state)

/-- Group a per-minute path back into maximal runs of equal state. Inverse of
`toPath` for well-formed segmentations (whose runs never exceed `maxD` — the
trellis cannot emit a longer one, since self-transitions are forbidden). -/
def ofPath (path : List Nat) : List Seg :=
  path.foldr
    (fun s acc =>
      match acc with
      | ⟨st, d⟩ :: rest => if st == s then ⟨st, d + 1⟩ :: rest else ⟨s, 1⟩ :: acc
      | [] => [⟨s, 1⟩])
    []

end Verified.Hsmm
