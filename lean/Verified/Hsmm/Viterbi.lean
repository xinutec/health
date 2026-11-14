import Verified.Hsmm.Spec

/-!
# The HSMM Viterbi trellis

Explicit-duration Viterbi (Yu/Rabiner): `trellis[s][τ]` rolling over `t`, a
per-`t` best close per previous state, backpointers only at segment starts,
closure at `T-1`. Loop order and strict `>` fix tie-breaks.

All-`-∞` input and a missing backpointer return `none`, not a silent default.

The proved decoders are `Decode.lean`'s specification and its memoised forms
(`Memo.decodeFast`, `Ckpt.decodeCk`, `ByStart.sDecode`, which `verified_cli`
runs). This loop is unproved and not served: `Tests.lean` pins the spec against
it, paths included.
-/

namespace Verified.Hsmm

structure DecodeResult where
  /-- State index per minute, length `T`. -/
  path : Array Nat
  /-- The map score the decoder claims for that path. -/
  best : Score
deriving Repr, BEq

namespace Viterbi

/-- Flat trellis index for `(s, τ)`, `τ ∈ [1, maxD]`. -/
@[inline] def idx (maxD s tau : Nat) : Nat := s * maxD + (tau - 1)

end Viterbi

open Viterbi in
/-- `hsmmViterbi`: decode the map state-per-minute path. `none` when no path has
a finite score (or the window/state space is degenerate with `T > 0`). -/
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

  -- Per state, the largest τ with a finite `prev` entry (0: none); everything
  -- above is `−∞`, so the τ loops stop there instead of `maxD`.
  let mut live : Array Nat := Array.replicate S 0

  -- t = 0: only τ = 1 is valid.
  for s in [0:S] do
    let v := P.init s + P.entry s 0 + P.emit 0 s
    prev := prev.set! (idx maxD s 1) v
    if v != Score.negInf then live := live.set! s 1

  for t in [1:T] do
    let mut cur : Array Score := Array.replicate size .negInf
    let mut liveNext : Array Nat := Array.replicate S 0

    -- Best close-of-segment score per previous state sp:
    --   max over τ of prev[sp][τ] + dur(sp, τ, t-1).
    let mut closeBestScore : Array Score := Array.replicate S .negInf
    let mut closeBestTau : Array Nat := Array.replicate S 0
    for sp in [0:S] do
      let mut bestScore : Score := .negInf
      let mut bestTau : Nat := 0
      for tau in [1:(live.getD sp 0)+1] do
        let sc := (prev.getD (idx maxD sp tau) .negInf)
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
        -- Continue the running segment: τ ≥ 2, up to one past the column's
        -- longest finite τ.
        let top := min maxD ((live.getD s 0) + 1)
        for tau in [2:top+1] do
          let ps := (prev.getD (idx maxD s (tau - 1)) .negInf)
          if ps != Score.negInf then
            cur := cur.set! (idx maxD s tau) (ps + emit)
            liveNext := liveNext.set! s tau

        -- Start a new segment (τ = 1) from the best-closing predecessor.
        let mut bestNew : Score := .negInf
        let mut bestPrevState : Nat := S
        let mut bestPrevTau : Nat := 0
        for sp in [0:S] do
          if sp != s then
            let cb := (closeBestScore.getD sp .negInf)
            if cb != Score.negInf then
              let trans := P.trans sp s t
              if trans != Score.negInf then
                let sc := cb + trans
                if bestNew.blt sc then
                  bestNew := sc
                  bestPrevState := sp
                  bestPrevTau := (closeBestTau.getD sp 0)
        if bestNew != Score.negInf then
          cur := cur.set! (idx maxD s 1) (bestNew + P.entry s t + emit)
          backPrev := backPrev.set! (t * S + s) bestPrevState
          backTau := backTau.set! (t * S + s) bestPrevTau
          if liveNext.getD s 0 == 0 then liveNext := liveNext.set! s 1

    prev := cur
    live := liveNext

  -- Close the final segment at T-1.
  let mut bestFinalScore : Score := .negInf
  let mut bestFinalState : Nat := 0
  let mut bestFinalTau : Nat := 1
  for s in [0:S] do
    for tau in [1:(live.getD s 0)+1] do
      let sc := (prev.getD (idx maxD s tau) .negInf)
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
          let bp := (backPrev.getD (segStart * S + curState) 0)
          if bp == S then
            bad := true
            done := true
          else
            curTau := (backTau.getD (segStart * S + curState) 0)
            curState := bp
            segEnd := segStart - 1
  if bad || !done then return none
  return some ⟨path, bestFinalScore⟩

end Verified.Hsmm
