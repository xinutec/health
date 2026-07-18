import Verified
import Lean.Data.Json

/-!
# `verified_cli` — JSON decode interface

Reads one HSMM problem as JSON on stdin, decodes it with `decodeCk` — the
checkpointed, allocation-light decoder whose output is theorem-backed
(`decodeCk_correct`, `decodeCk_none_iff`) — and writes the result as JSON on
stdout. The bridge for A/B-ing against `src/hmm/hsmm-viterbi.ts` on identical
integer-scaled scores: see `lean/experiments/compare.mjs`.

Input shape (all scores integers; `null` = `-∞`):
  {
    "T": 30, "S": 4, "maxD": 6,
    "emit":  [[..S]  × T],          // emit[t][s]
    "trans": [[..S] × S]            // trans[from][to], time-constant …
           | [[[..S] × S] × T],     // … or trans[t][from][to] per destination t
    "dur":   [[..maxD] × S],        // dur[s][d-1]
    "durOverrides": [[s,d,e,v]]?,   // sparse per-segEnd exceptions (v null = -∞)
    "init":  [..S]?,                // absent → 0 (uniform), matching the TS default
    "entry": [[..S] × T]?           // absent → 0, matching the TS default
  }

Output: {"path": [..T], "best": n}
      | {"degenerate": true}       // every path scores -∞
      | {"error": "..."}           (exit 1)
-/

open Lean (Json)
open Verified.Hsmm

private def scoreOfJson (j : Json) : Except String Score :=
  if j.isNull then .ok .negInf
  else do
    let n ← j.getInt?
    return .val n

private def row (j : Json) : Except String (Array Score) := do
  (← j.getArr?).mapM scoreOfJson

private def matrix (j : Json) : Except String (Array (Array Score)) := do
  (← j.getArr?).mapM row

/-- `trans` is either `S×S` (time-constant) or `T×S×S` (per destination `t`);
normalised to the per-`t` form with a one-element broadcast array. -/
private def transTensor (j : Json) : Except String (Array (Array (Array Score))) := do
  let outer ← j.getArr?
  let some first := outer[0]? | throw "trans: empty"
  let some firstInner := (← first.getArr?)[0]? | throw "trans: empty row"
  match firstInner.getArr? with
  | .ok _ => outer.mapM matrix -- depth 3: per-t
  | .error _ => do return #[← matrix j] -- depth 2: broadcast

/-- Sparse per-`segEnd` duration exceptions, keyed `(s * maxD + (d-1)) * T + e`. -/
private def parseDurOverrides (j : Json) (maxD T : Nat) :
    Except String (Std.HashMap Nat Score) := do
  let arr ← j.getArr?
  let mut m : Std.HashMap Nat Score := {}
  for entry in arr do
    let q ← entry.getArr?
    let some sJ := q[0]? | throw "durOverrides: bad entry"
    let some dJ := q[1]? | throw "durOverrides: bad entry"
    let some eJ := q[2]? | throw "durOverrides: bad entry"
    let some vJ := q[3]? | throw "durOverrides: bad entry"
    let s ← sJ.getNat?
    let d ← dJ.getNat?
    let e ← eJ.getNat?
    let v ← scoreOfJson vJ
    if d == 0 then throw "durOverrides: d = 0"
    m := m.insert ((s * maxD + (d - 1)) * T + e) v
  return m

private def parseProblem (j : Json) : Except String Problem := do
  let T := (← (← j.getObjVal? "T").getNat?)
  let S := (← (← j.getObjVal? "S").getNat?)
  let maxD := (← (← j.getObjVal? "maxD").getNat?)
  let emit ← matrix (← j.getObjVal? "emit")
  let trans ← transTensor (← j.getObjVal? "trans")
  let dur ← matrix (← j.getObjVal? "dur")
  let durOv : Std.HashMap Nat Score ←
    match j.getObjVal? "durOverrides" with
    | .ok v => if v.isNull then pure {} else parseDurOverrides v maxD T
    | .error _ => pure {}
  -- `(s, d)` cells that have at least one per-`segEnd` override — a cheap
  -- array probe in front of the HashMap, which the decoder consults
  -- O(T·S·maxD) times while overrides live in a handful of cells.
  let hasOv : Array Bool := Id.run do
    let mut a := Array.replicate (S * maxD) false
    for (k, _) in durOv do
      a := a.setIfInBounds (k / T) true
    return a
  let init : Array Score ←
    match j.getObjVal? "init" with
    | .ok v => if v.isNull then pure #[] else row v
    | .error _ => pure #[]
  let entry : Array (Array Score) ←
    match j.getObjVal? "entry" with
    | .ok v => if v.isNull then pure #[] else matrix v
    | .error _ => pure #[]
  return {
    T := T
    S := S
    maxD := maxD
    emit := fun t s => ((emit.getD t #[]).getD s .negInf)
    trans := fun sp s t =>
      let m := if trans.size == 1 then trans[0]! else trans.getD t #[]
      (m.getD sp #[]).getD s .negInf
    dur := fun s d e =>
      if d == 0 then .negInf
      else if hasOv.getD (s * maxD + (d - 1)) false then
        match durOv[(s * maxD + (d - 1)) * T + e]? with
        | some v => v
        | none => (dur.getD s #[]).getD (d - 1) .negInf
      else (dur.getD s #[]).getD (d - 1) .negInf
    init := fun s => if init.isEmpty then .zero else init.getD s .negInf
    entry := fun s t => if entry.isEmpty then .zero else (entry.getD t #[]).getD s .negInf
  }

/-- Checkpoint stride for `decodeCk`: retained cells scale as `T/K` columns
and each decoded segment recomputes `< K` columns during the walk.
`decodeCk_eq` holds for every stride, so this is purely a space/time knob. -/
def ckptStride : Nat := 16

def main (args : List String) : IO UInt32 := do
  let timing := args.contains "--timing"
  let t0 ← IO.monoMsNow
  let input ← (← IO.getStdin).readToEnd
  let t1 ← IO.monoMsNow
  match Json.parse input >>= parseProblem with
  | .error e =>
    IO.println (Json.mkObj [("error", Json.str e)]).compress
    return 1
  | .ok P =>
    -- Forcing `P.T` doesn't force the tensors (they're closures over the
    -- parsed arrays), so "parse" here is Json.parse + closure setup; the
    -- lazy tensor reads land in the decode phase.
    let t2 ← IO.monoMsNow
    -- `IO.lazyPure` pins the evaluation between the two timestamps; a plain
    -- pure `let` gets floated into the match by the compiler.
    let r ← IO.lazyPure fun _ => decodeCk P ckptStride
    let t3 ← IO.monoMsNow
    match r with
    | none => IO.println (Json.mkObj [("degenerate", Json.bool true)]).compress
    | some r =>
      let path := Json.arr (r.path.map fun s => Lean.toJson s)
      let best := match r.best with
        | .val v => Lean.toJson v
        | .negInf => Json.null -- unreachable: `decodeFast` returns none instead
      IO.println (Json.mkObj [("path", path), ("best", best)]).compress
    if timing then
      IO.eprintln s!"timing: read={t1-t0}ms parse={t2-t1}ms decode={t3-t2}ms"
    return 0
