import Verified.Hsmm.Spec

/-!
# The HSMM Viterbi trellis

A faithful port of `src/hmm/hsmm-viterbi.ts` (Yu/Rabiner explicit-duration
formulation): `trellis[s][τ]` rolling over `t`, a per-`t` precomputation of the
best close-of-segment score per previous state, backpointers stored only at
segment starts, and final-segment closure at `T-1`. Loop order and strict-`>`
argmax comparisons mirror the TypeScript exactly, so on identical integer
scores the two decoders tie-break identically.

Differences from the TypeScript, both deliberate:
  - degenerate input (every path scores `-∞`) returns `none` instead of the
    silent all-`states[0]` path;
  - a missing backpointer during backtrack returns `none` instead of leaving
    path minutes unfilled (unreachable when the best score is finite — making
    it a visible signal instead of silent corruption).

The goal theorem is proved for the *specification* decoder (`Decode.lean`:
`decode_correct`, `decode_none_iff`) and inherited by the memoised production
forms (`Memo.decodeFast` → `Ckpt.decodeCk` → `Packed.pDecode`, the last being
what `verified_cli` runs). This array `viterbi` is **not** itself proved and is
**not** on the production path: it is the TS-faithful reference that `Tests.lean`
`#guard`-pins the spec decoder against — paths included — so a divergence
between the ported loop and the verified spec fails the build. It exists to
cross-check faithfulness, not to decode in production.
-/

namespace Verified.Hsmm

structure DecodeResult where
  /-- State index per minute, length `T`. -/
  path : Array Nat
  /-- The MAP score the decoder claims for that path. -/
  best : Score
deriving Repr, BEq

namespace Viterbi

/-- Flat trellis index for `(s, τ)`, `τ ∈ [1, maxD]`. -/
@[inline] def idx (maxD s tau : Nat) : Nat := s * maxD + (tau - 1)

end Viterbi

open Viterbi in
/-- Decode the MAP state-per-minute path. `none` when no path has a finite
score (or the window/state space is degenerate with `T > 0`). -/
def viterbi (P : Problem) : Option DecodeResult := Id.run do
  let T := P.T
  let S := P.S
  let maxD := P.maxD
  if T == 0 then return some ⟨#[], Score.zero⟩
  if S == 0 || maxD == 0 then return none

  let size := S * maxD
  let mut prev : Array Score := Array.replicate size .negInf

  -- Backpointers, stored per (t, s) for segment starts only: the predecessor
  -- state (sentinel `S` = none) and its closed segment's duration.
  let mut backPrev : Array Nat := Array.replicate (T * S) S
  let mut backTau : Array Nat := Array.replicate (T * S) 0

  -- t = 0: only τ = 1 is valid.
  for s in [0:S] do
    prev := prev.set! (idx maxD s 1) (P.init s + P.entry s 0 + P.emit 0 s)

  for t in [1:T] do
    let mut cur : Array Score := Array.replicate size .negInf

    -- Best close-of-segment score per previous state sp:
    --   max over τ of prev[sp][τ] + dur(sp, τ, t-1).
    let mut closeBestScore : Array Score := Array.replicate S .negInf
    let mut closeBestTau : Array Nat := Array.replicate S 0
    for sp in [0:S] do
      let mut bestScore : Score := .negInf
      let mut bestTau : Nat := 0
      for tau in [1:maxD+1] do
        let sc := prev[idx maxD sp tau]!
        if sc != Score.negInf then
          let dlp := P.dur sp tau (t - 1)
          if dlp != Score.negInf then
            let total := sc + dlp
            if bestScore.blt total then
              bestScore := total
              bestTau := tau
      closeBestScore := closeBestScore.set! sp bestScore
      closeBestTau := closeBestTau.set! sp bestTau

    for s in [0:S] do
      let emit := P.emit t s
      if emit != Score.negInf then
        -- Continue the running segment: τ ≥ 2.
        for tau in [2:maxD+1] do
          let ps := prev[idx maxD s (tau - 1)]!
          if ps != Score.negInf then
            cur := cur.set! (idx maxD s tau) (ps + emit)

        -- Start a new segment (τ = 1) from the best-closing predecessor.
        let mut bestNew : Score := .negInf
        let mut bestPrevState : Nat := S
        let mut bestPrevTau : Nat := 0
        for sp in [0:S] do
          if sp != s then
            let cb := closeBestScore[sp]!
            if cb != Score.negInf then
              let trans := P.trans sp s t
              if trans != Score.negInf then
                let sc := cb + trans
                if bestNew.blt sc then
                  bestNew := sc
                  bestPrevState := sp
                  bestPrevTau := closeBestTau[sp]!
        if bestNew != Score.negInf then
          cur := cur.set! (idx maxD s 1) (bestNew + P.entry s t + emit)
          backPrev := backPrev.set! (t * S + s) bestPrevState
          backTau := backTau.set! (t * S + s) bestPrevTau

    prev := cur

  -- Close the final segment at T-1.
  let mut bestFinalScore : Score := .negInf
  let mut bestFinalState : Nat := 0
  let mut bestFinalTau : Nat := 1
  for s in [0:S] do
    for tau in [1:maxD+1] do
      let sc := prev[idx maxD s tau]!
      if sc != Score.negInf then
        let dlp := P.dur s tau (T - 1)
        if dlp != Score.negInf then
          let total := sc + dlp
          if bestFinalScore.blt total then
            bestFinalScore := total
            bestFinalState := s
            bestFinalTau := tau

  if bestFinalScore == Score.negInf then return none

  -- Backtrack segment by segment. Runs at most T iterations (every segment
  -- consumes ≥ 1 minute); the fuel loop makes totality trivial.
  let mut path : Array Nat := Array.replicate T 0
  let mut curState := bestFinalState
  let mut curTau := bestFinalTau
  let mut segEnd := T - 1
  let mut done := false
  let mut bad := false
  for _ in [0:T] do
    if !done then
      if curTau == 0 || segEnd + 1 < curTau then
        bad := true
        done := true
      else
        let segStart := segEnd + 1 - curTau
        for i in [segStart:segEnd + 1] do
          path := path.set! i curState
        if segStart == 0 then
          done := true
        else
          let bp := backPrev[segStart * S + curState]!
          if bp == S then
            bad := true
            done := true
          else
            curTau := backTau[segStart * S + curState]!
            curState := bp
            segEnd := segStart - 1
  if bad || !done then return none
  return some ⟨path, bestFinalScore⟩

end Verified.Hsmm
