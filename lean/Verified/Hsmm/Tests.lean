import Verified.Hsmm.Viterbi
import Verified.Hsmm.Oracle
import Verified.Hsmm.Trellis
import Verified.Hsmm.Decode
import Verified.Hsmm.Memo
import Verified.Hsmm.Ckpt
import Verified.Hsmm.Packed

/-!
# Compile-time parity checks: trellis vs brute-force oracle

Every `#guard` here is evaluated during `lake build` — the build FAILS if the
trellis ever disagrees with the exhaustive oracle on these instances. This is
the executable stand-in for the equivalence theorem until it is proved.

The check is tie-break-independent: rather than comparing paths (two optimal
paths may differ), it demands (1) the trellis's best score equals the oracle's
best score, (2) the trellis's returned path actually achieves that score, and
(3) the path's segmentation is well-formed.
-/

namespace Verified.Hsmm.Tests

/-- The decoder contract, checked executably against the oracle. -/
def check (P : Problem) : Bool :=
  match viterbi P with
  | none => oracleBest P == Score.negInf
  | some r =>
    r.best == oracleBest P
      && score P (ofPath r.path.toList) == r.best
      && wellFormed P (ofPath r.path.toList)
      && r.path.size == P.T

/-- Deterministic pseudo-random problem family (no I/O, no clock — a seeded
integer hash), with hard `-∞` zeros sprinkled through every factor. -/
def mkP (seed T S maxD : Nat) : Problem where
  T := T
  S := S
  maxD := maxD
  emit := fun t s =>
    if (t * 31 + s * 17 + seed) % 11 == 0 then .negInf
    else .val (Int.ofNat ((t * 13 + s * 7 + seed * 5) % 23) - 11)
  trans := fun sp s t =>
    if (sp * 29 + s * 23 + t * 19 + seed) % 13 == 0 then .negInf
    else .val (Int.ofNat ((sp * 11 + s * 3 + t + seed) % 17) - 8)
  dur := fun s d e =>
    if (s * 7 + d * 5 + e + seed) % 19 == 0 then .negInf
    else .val (Int.ofNat ((s * 5 + d * 3 + seed) % 9) - 4)
  init := fun s => .val (Int.ofNat ((s + seed) % 5) - 2)
  entry := fun s t =>
    if (s * 13 + t * 11 + seed) % 17 == 0 then .negInf
    else .val (Int.ofNat ((s * 3 + t * 2 + seed) % 7) - 3)

-- Hand-shaped smoke cases.
#guard check (mkP 0 1 1 1)
#guard check (mkP 1 1 3 2)
#guard check (mkP 2 4 1 4)
-- Degenerate shapes: an empty window decodes to the empty path; an empty
-- state space or zero duration cap cannot cover a non-empty window.
#guard (viterbi (mkP 0 0 3 2)) == some ⟨#[], Score.zero⟩
#guard (viterbi (mkP 0 4 0 2)) == none
#guard (viterbi (mkP 0 4 3 0)) == none
-- A duration cap below the window length forces multi-segment paths.
#guard check (mkP 3 5 2 2)
-- Sweeps: many seeds across small shapes (kept tiny — the oracle is
-- exponential in T).
#guard (List.range 25).all fun seed => check (mkP seed 4 2 2)
#guard (List.range 25).all fun seed => check (mkP seed 5 3 3)
#guard (List.range 15).all fun seed => check (mkP seed 6 2 4)
#guard (List.range 10).all fun seed => check (mkP seed 6 4 2)
-- All-blocked family: every transition -∞, so any T > maxD window with S ≥ 1
-- has no multi-segment escape once a single segment cannot cover it.
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  check blocked

/-- The still-unproved V1 link, checked executably: the imperative array
trellis reports exactly the (proved-correct) functional recurrence's score.
Instances stay tiny — `trellisScore` recomputes columns without memoisation. -/
def checkTrellis (P : Problem) : Bool :=
  match viterbi P with
  | some r => trellisScore P == r.best
  | none => trellisScore P == Score.negInf

#guard checkTrellis (mkP 0 1 1 1)
#guard checkTrellis (mkP 0 0 3 2)
#guard checkTrellis (mkP 0 4 0 2)
#guard checkTrellis (mkP 0 4 3 0)
#guard (List.range 8).all fun seed => checkTrellis (mkP seed 4 2 2)
#guard (List.range 8).all fun seed => checkTrellis (mkP seed 4 3 2)
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  checkTrellis blocked

-- The proved decoder must agree with the imperative trellis EXACTLY — same
-- Option, same best, same path. `pickBest`'s first-best tie-break composes to
-- the same selection order as the TypeScript argmax loops, so even ties match.
#guard decode (mkP 0 1 1 1) == viterbi (mkP 0 1 1 1)
#guard decode (mkP 0 0 3 2) == viterbi (mkP 0 0 3 2)
#guard decode (mkP 0 4 0 2) == viterbi (mkP 0 4 0 2)
#guard decode (mkP 0 4 3 0) == viterbi (mkP 0 4 3 0)
#guard (List.range 8).all fun seed => decode (mkP seed 4 2 2) == viterbi (mkP seed 4 2 2)
#guard (List.range 8).all fun seed => decode (mkP seed 4 3 2) == viterbi (mkP seed 4 3 2)
#guard (List.range 6).all fun seed => decode (mkP seed 5 2 3) == viterbi (mkP seed 5 2 3)
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  decode blocked == viterbi blocked

-- The memoised decoder inherits decode's theorems via `decodeFast_eq`; these
-- pin it against the imperative trellis on larger instances than the
-- exponential spec decoder can reach (decodeFast is polynomial).
#guard decodeFast (mkP 0 1 1 1) == viterbi (mkP 0 1 1 1)
#guard decodeFast (mkP 0 0 3 2) == viterbi (mkP 0 0 3 2)
#guard decodeFast (mkP 0 4 0 2) == viterbi (mkP 0 4 0 2)
#guard decodeFast (mkP 0 4 3 0) == viterbi (mkP 0 4 3 0)
#guard (List.range 6).all fun seed => decodeFast (mkP seed 30 4 6) == viterbi (mkP seed 30 4 6)
#guard (List.range 4).all fun seed => decodeFast (mkP seed 60 3 10) == viterbi (mkP seed 60 3 10)
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  decodeFast blocked == viterbi blocked

-- The checkpointed decoder is proved equal to decode for EVERY stride K
-- (`decodeCk_eq`); pin a few strides — degenerate (0: `% 0` stores nothing
-- beyond the t=0 entry), dense (1: every column stored), and sparse (7, 64:
-- most queried columns recomputed via `colFrom`).
#guard (List.range 6).all fun seed =>
  [0, 1, 7, 64].all fun K => decodeCk (mkP seed 30 4 6) K == viterbi (mkP seed 30 4 6)
#guard (List.range 4).all fun seed =>
  [0, 1, 7, 64].all fun K => decodeCk (mkP seed 60 3 10) K == viterbi (mkP seed 60 3 10)
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  decodeCk blocked 7 == viterbi blocked

-- The packed decoder (`Nat`-scalar arithmetic through `enc`) is proved equal
-- to decode under the envelope hypotheses (`pDecode_eq`); the seeded test
-- family sits comfortably inside the envelope, so it must match exactly.
#guard (List.range 6).all fun seed =>
  [0, 1, 7, 64].all fun K =>
    pDecode (packM (mkP seed 30 4 6)) K == viterbi (mkP seed 30 4 6)
#guard (List.range 4).all fun seed =>
  [1, 16].all fun K =>
    pDecode (packM (mkP seed 60 3 10)) K == viterbi (mkP seed 60 3 10)
#guard
  let blocked : Problem :=
    { mkP 0 5 2 3 with trans := fun _ _ _ => .negInf }
  pDecode (packM blocked) 7 == viterbi blocked

end Verified.Hsmm.Tests
