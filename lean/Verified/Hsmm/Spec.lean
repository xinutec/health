import Verified.Hsmm.Score

/-!
# HSMM decoding — the specification

The mathematical meaning of `src/hmm/hsmm-viterbi.ts`, stated independently of
any algorithm: a *segmentation* of the observation window `[0, T)` into runs of
equal state, its *score* under the model, and well-formedness. The decoder's
contract is: return a path whose segmentation is well-formed and whose score
equals the maximum over all well-formed segmentations (`none` when every
segmentation scores `-∞` — the TypeScript version's silent all-`states[0]`
fallback becomes an explicit signal here).

The model is a bundle of score functions over plain `Nat` indices, mirroring
the callback interface of `HsmmInput`:
  - `emit t s`      — emission of observation `t` under state `s`
  - `trans sp s t`  — transition `sp → s`, conditioned on the destination
                      observation `t` (matching `transitionLogProb(from, to, toObs)`)
  - `dur s d e`     — duration prior for a segment of state `s`, length `d`,
                      whose last minute is observation `e` (the `segEndIndex`)
  - `init s`        — initial-state prior at `t = 0`
  - `entry s t`     — per-segment-entry prior, applied at every segment start
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

/-- Score of a segmentation, threading the absolute start index and previous
state. The first segment pays `init`; every later segment pays the transition
from its predecessor, evaluated at its own first observation. Every segment
pays `entry` at its start, its per-minute emissions, and its duration prior
evaluated at its last minute — exactly the composition the trellis performs. -/
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
