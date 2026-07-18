import Verified
import Lean.Data.Json

/-!
# `verified_cli` — JSON decode interface

Reads one HSMM problem as JSON on stdin, decodes it with `decodeFast` — the
memoised decoder whose output is theorem-backed (`decodeFast_correct`,
`decodeFast_none_iff`) — and writes the result as JSON on stdout. The bridge
for A/B-ing against `src/hmm/hsmm-viterbi.ts` on identical integer-scaled
scores: see `lean/experiments/compare.mjs`.

Input shape (all scores integers; `null` = `-∞`):
  {
    "T": 30, "S": 4, "maxD": 6,
    "emit":  [[..S]  × T],          // emit[t][s]
    "trans": [[..S] × S]            // trans[from][to], time-constant …
           | [[[..S] × S] × T],     // … or trans[t][from][to] per destination t
    "dur":   [[..maxD] × S],        // dur[s][d-1]
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

private def parseProblem (j : Json) : Except String Problem := do
  let T := (← (← j.getObjVal? "T").getNat?)
  let S := (← (← j.getObjVal? "S").getNat?)
  let maxD := (← (← j.getObjVal? "maxD").getNat?)
  let emit ← matrix (← j.getObjVal? "emit")
  let trans ← transTensor (← j.getObjVal? "trans")
  let dur ← matrix (← j.getObjVal? "dur")
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
    dur := fun s d _ => if d == 0 then .negInf else (dur.getD s #[]).getD (d - 1) .negInf
    init := fun s => if init.isEmpty then .zero else init.getD s .negInf
    entry := fun s t => if entry.isEmpty then .zero else (entry.getD t #[]).getD s .negInf
  }

def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= parseProblem with
  | .error e =>
    IO.println (Json.mkObj [("error", Json.str e)]).compress
    return 1
  | .ok P =>
    match decodeFast P with
    | none => IO.println (Json.mkObj [("degenerate", Json.bool true)]).compress
    | some r =>
      let path := Json.arr (r.path.map fun s => Lean.toJson s)
      let best := match r.best with
        | .val v => Lean.toJson v
        | .negInf => Json.null -- unreachable: `decodeFast` returns none instead
      IO.println (Json.mkObj [("path", path), ("best", best)]).compress
    return 0
