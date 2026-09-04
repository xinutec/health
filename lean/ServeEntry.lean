import Verified
import DayEntry
import Lean.Data.Json

/-!
# `ServeEntry` — the serve-mode handlers, as a LIBRARY (#982)

Was `Main.lean`. Split so a host process can link these handlers and call them
in-process, which `Main.lean`'s `main` made impossible: an exe root's `main`
wins the link in a foreign host silently (#952 — the reason `DayEntry` and
`BackendEntry` are libraries already).

Nothing here changed but the name of `main`, which is now `cliMain`, and the
extraction of `dispatch` out of `serveLoop` so callers other than the loop can
reach the mode table. `verified_cli` behaves exactly as before.
-/


/-!
# `verified_cli` — JSON decode interface

Reads one HSMM problem as JSON on stdin, decodes it with `pDecodeFast` — the
flat-array decoder proved equal to the packed, checkpointed `pDecode`
(`pDecodeFast_eq`), so its output stays theorem-backed
(`pDecodeFast_correct`) — and writes the result as JSON on stdout. The parser
lays the tensors out as the flat `Array Nat`s `PData` reads through direct,
inlinable accessors (the forward pass' hot path), instead of the `PModel`
closure fields it used to build. The bridge for A/B-ing against
`src/hmm/hsmm-viterbi.ts` on identical integer-scaled scores: see
`lean/experiments/compare.mjs`.

Scores are parsed straight into the packed encoding (`enc`: `-∞ ↦ 0`,
`v ↦ v + 2^61` as a `Nat` scalar), and the parser REFUSES inputs outside the
proven envelope — `|v| ≤ 2^49` for emissions, `|v| ≤ 2^45` for the other
tensors, `T ≤ 2048` — rather than decode where the equivalence theorem does
not apply.

Input shape (all scores integers; `null` = `-∞`):
  {
    "T": 30, "S": 4, "maxD": 6,
    "emit":  [[..S]  × T],          // emit[t][s]
    "trans": [[..S] × S]            // trans[from][to], time-constant …
           | [[[..S] × S] × T],     // … or trans[t][from][to] per destination t
    "transOv": [[from,to,[..T]]]?,  // per-t rows for time-varying pairs (chain
                                    // context); each row overrides the base
                                    // matrix for that pair at every t
    "dur":   [[..maxD] × S],        // dur[s][d-1]
    "durOverrides": [[s,d,e,v]]?,   // sparse per-segEnd exceptions (v null = -∞)
    "durClass": [..S]?,             // + "durDelta": class-factorised per-segEnd
    "durDelta": [[[[v,len]..] × maxD]]?, // deltas (segment evidence),
                                    //   run-length-encoded over e: state s pays
                                    //   dur[s][d-1] + durDelta[durClass[s]][d-1][e];
                                    //   requires the -∞ pattern be e-independent
    "init":  [..S]?,                // absent → 0 (uniform), matching the TS default
    "entry": [[..S] × T]?           // absent → 0, matching the TS default
  }

`durOverrides` and `durClass`/`durDelta` are mutually exclusive (the exporter
picks sparse or class-factorised form).

Output: {"path": [..T], "best": n}
      | {"degenerate": true}       // every path scores -∞
      | {"error": "..."}           (exit 1)

## Rail mode (`verified_cli rail`)

V3: shortest path over a TS-exported rail graph. Input is the adjacency
structure verbatim — entry order per vertex is the TS insertion order, which
the tie-parity claim depends on — with ×2²⁰-quantised nonnegative integer
weights. `Nat` weights are exact at any magnitude, so unlike the packed HSMM
scores there is no envelope to refuse on.

  { "adj": [[[to, w], ..] × n],   // adj[u] = directed edges out of u
    "src": n, "dst": n }

Output: {"path": [..], "dist": n}
      | {"none": true}            // disconnected or endpoint out of range
      | {"error": "..."}          (exit 1)
-/

open Lean (Json)
open Wire
open Verified.Hsmm

/-- Parse one score directly into the packed encoding, refusing values
outside the verified envelope (`bound` = `pEB` for emissions, `pOB` for the
other tensors). -/
private def encOfJson (bound : Nat) (j : Json) : Except String Nat :=
  if j.isNull then .ok 0
  else do
    let n ← j.getInt?
    if n.natAbs > bound then
      throw s!"score {n} exceeds the verified envelope (|v| ≤ {bound})"
    return (n + (pOff : Int)).toNat

private def row (bound : Nat) (j : Json) : Except String (Array Nat) := do
  (← j.getArr?).mapM (encOfJson bound)

private def matrix (bound : Nat) (j : Json) : Except String (Array (Array Nat)) := do
  (← j.getArr?).mapM (row bound)

/-- `trans` is either `S×S` (time-constant) or `T×S×S` (per destination `t`);
normalised to the per-`t` form with a one-element broadcast array. -/
private def transTensor (j : Json) : Except String (Array (Array (Array Nat))) := do
  let outer ← j.getArr?
  let some first := outer[0]? | throw "trans: empty"
  let some firstInner := (← first.getArr?)[0]? | throw "trans: empty row"
  match firstInner.getArr? with
  | .ok _ => outer.mapM (matrix pOB) -- depth 3: per-t
  | .error _ => do return #[← matrix pOB j] -- depth 2: broadcast

/-- One run-length-encoded row of the class-factorised duration deltas:
`[[value, runLength], …]` over `e`. Rows are piecewise-constant over `e`, so
the exporter ships runs instead of `T` raw cells — smaller wire payload and,
the point, less for Lean's JSON parser to walk. `value` is shifted by `bound`
(as the tensors are) so decode-time arithmetic stays scalar `Nat` (an `Int` add
at the 2^61 scale would box per call — GMP, measured 5×). -/
private def deltaRunsRow (bound : Nat) (j : Json) : Except String (Array (Nat × Nat)) := do
  (← j.getArr?).mapM fun pair => do
    let a ← pair.getArr?
    let some vJ := a[0]? | throw "durDelta run: expected [value, runLength]"
    let some lJ := a[1]? | throw "durDelta run: expected [value, runLength]"
    let n ← vJ.getInt?
    if n.natAbs > bound then
      throw s!"delta {n} exceeds the verified envelope (|v| ≤ {bound})"
    return ((n + (bound : Int)).toNat, ← lJ.getNat?)

/-- Per-`t` transition rows for time-varying pairs (chain context): the
`S*S` pair-index table (sentinel = number of rows) plus the rows. -/
private def parseTransOv (j : Json) (S T : Nat) :
    Except String (Array Nat × Array (Array Nat)) := do
  let arr ← j.getArr?
  let mut idx := Array.replicate (S * S) arr.size
  let mut rows : Array (Array Nat) := #[]
  for entry in arr do
    let q ← entry.getArr?
    let some fJ := q[0]? | throw "transOv: bad entry"
    let some tJ := q[1]? | throw "transOv: bad entry"
    let some rJ := q[2]? | throw "transOv: bad entry"
    let f ← fJ.getNat?
    let t ← tJ.getNat?
    let r ← row pOB rJ
    if r.size != T then throw "transOv: row length ≠ T"
    if f ≥ S ∨ t ≥ S then throw "transOv: pair out of range"
    idx := idx.setIfInBounds (f * S + t) rows.size
    rows := rows.push r
  return (idx, rows)

/-- Sparse per-`segEnd` duration exceptions, keyed `(s * maxD + (d-1)) * T + e`. -/
private def parseDurOverrides (j : Json) (maxD T : Nat) :
    Except String (Std.HashMap Nat Nat) := do
  let arr ← j.getArr?
  let mut m : Std.HashMap Nat Nat := {}
  for entry in arr do
    let q ← entry.getArr?
    let some sJ := q[0]? | throw "durOverrides: bad entry"
    let some dJ := q[1]? | throw "durOverrides: bad entry"
    let some eJ := q[2]? | throw "durOverrides: bad entry"
    let some vJ := q[3]? | throw "durOverrides: bad entry"
    let s ← sJ.getNat?
    let d ← dJ.getNat?
    let e ← eJ.getNat?
    let v ← encOfJson pOB vJ
    if d == 0 then throw "durOverrides: d = 0"
    m := m.insert ((s * maxD + (d - 1)) * T + e) v
  return m

/-- `enc Score.zero` — the default for absent `init`/`entry` tensors,
matching the TS decoder's implicit 0. -/
private def encZero : Nat := pOff

private def parseModel (j : Json) : Except String PData := do
  let T := (← (← j.getObjVal? "T").getNat?)
  let S := (← (← j.getObjVal? "S").getNat?)
  let maxD := (← (← j.getObjVal? "maxD").getNat?)
  if T > pTMax then
    throw s!"T={T} exceeds the verified envelope (T ≤ 2048)"
  let emit ← matrix pEB (← j.getObjVal? "emit")
  let trans ← transTensor (← j.getObjVal? "trans")
  let (transIdx, transRows) ←
    match j.getObjVal? "transOv" with
    | .ok v => if v.isNull then pure (#[], #[]) else parseTransOv v S T
    | .error _ => pure (#[], #[])
  -- Flatten the override rows likewise (read per open cell: S²·T probes).
  let transFlat : Array Nat := Id.run do
    let mut a := Array.replicate (transRows.size * T) 0
    for i in [0:transRows.size] do
      let r := transRows[i]!
      for t in [0:min T r.size] do
        a := a.set! (i * T + t) r[t]!
    return a
  -- Class-factorised per-segEnd duration deltas (segment evidence). When
  -- present, the base matrix and the deltas each get half the envelope so
  -- their sum stays within `pOB`.
  let durClass : Array Nat ←
    match j.getObjVal? "durClass" with
    | .ok v => if v.isNull then pure #[] else do (← v.getArr?).mapM (·.getNat?)
    | .error _ => pure #[]
  let halfOB := pOB / 2
  let dur ← matrix (if durClass.isEmpty then pOB else halfOB) (← j.getObjVal? "dur")
  let durDelta : Array (Array (Array (Nat × Nat))) ←
    match j.getObjVal? "durDelta" with
    | .ok v =>
      if v.isNull then pure #[]
      else do
        (← v.getArr?).mapM fun cls => do
          (← cls.getArr?).mapM (deltaRunsRow halfOB)
    | .error _ => pure #[]
  if durClass.isEmpty != durDelta.isEmpty then
    throw "durClass and durDelta must be given together"
  -- Expand the RLE rows into the flat per-(class, d, e) tensor the decode
  -- reads (one flat-array probe per cell). Each `(v, len)` run writes `v` to
  -- the next `len` cells along `e`; runs cover exactly `T`.
  let durDeltaFlat : Array Nat := Id.run do
    let nC := durDelta.size
    let mut a := Array.replicate (nC * maxD * T) halfOB
    for c in [0:nC] do
      let cls := durDelta[c]!
      for d0 in [0:min maxD cls.size] do
        let mut e := 0
        for (v, len) in cls[d0]! do
          for _ in [0:len] do
            if e < T then a := a.set! ((c * maxD + d0) * T + e) v
            e := e + 1
    return a
  let durOv : Std.HashMap Nat Nat ←
    match j.getObjVal? "durOverrides" with
    | .ok v =>
      if v.isNull then pure {}
      else if !durClass.isEmpty then throw "durOverrides and durClass are exclusive"
      else parseDurOverrides v maxD T
    | .error _ => pure {}
  -- `(s, d)` cells that have at least one per-`segEnd` override — a cheap
  -- array probe in front of the HashMap, which the decoder consults
  -- O(T·S·maxD) times while overrides live in a handful of cells.
  let hasOv : Array Bool := Id.run do
    let mut a := Array.replicate (S * maxD) false
    for (k, _) in durOv do
      a := a.setIfInBounds (k / T) true
    return a
  let init : Array Nat ←
    match j.getObjVal? "init" with
    | .ok v => if v.isNull then pure #[] else row pOB v
    | .error _ => pure #[]
  let entry : Array (Array Nat) ←
    match j.getObjVal? "entry" with
    | .ok v => if v.isNull then pure #[] else matrix pOB v
    | .error _ => pure #[]
  -- Flatten the remaining nested tensors so the decode reads one flat-array
  -- probe per cell through `PData`'s monomorphic accessors (the accessors
  -- carry the same lookup these closures used to; here we only lay out the
  -- data they read). `emit`/`entry`/`dur` were `Array (Array Nat)`; `trans`
  -- is the per-`t` (or single broadcast) base matrix.
  let emitFlat : Array Nat := Id.run do
    let mut a := Array.replicate (T * S) 0
    for t in [0:T] do
      let r := emit.getD t #[]
      for s in [0:S] do a := a.set! (t * S + s) (r.getD s 0)
    return a
  let entryFlat : Array Nat := Id.run do
    if entry.isEmpty then return #[]
    let mut a := Array.replicate (T * S) encZero
    for t in [0:T] do
      let r := entry.getD t #[]
      for s in [0:S] do a := a.set! (t * S + s) (r.getD s encZero)
    return a
  let durBaseFlat : Array Nat := Id.run do
    let mut a := Array.replicate (S * maxD) 0
    for s in [0:S] do
      let r := dur.getD s #[]
      for d0 in [0:maxD] do a := a.set! (s * maxD + d0) (r.getD d0 0)
    return a
  let transBase : Array Nat := Id.run do
    let nTB := trans.size
    let mut a := Array.replicate (nTB * (S * S)) 0
    for k in [0:nTB] do
      let mk := trans.getD k #[]
      for sp in [0:S] do
        let r := mk.getD sp #[]
        for s in [0:S] do a := a.set! (k * (S * S) + sp * S + s) (r.getD s 0)
    return a
  return {
    T := T, S := S, maxD := maxD, halfOB := halfOB
    emit := emitFlat, entry := entryFlat, init := init
    transBase := transBase, nTB := trans.size
    transIdx := transIdx, transFlat := transFlat, nRows := transRows.size
    durBase := durBaseFlat, durClass := durClass, durDelta := durDeltaFlat
    hasOv := hasOv, durOv := durOv
  }

/-- Checkpoint stride for `pDecode`: retained cells scale as `T/K` columns
and each decoded segment recomputes `< K` columns during the walk.
`pDecode_eq` holds for every stride, so this is purely a space/time knob. -/
def ckptStride : Nat := 16

private def parseRail (j : Json) : Except String (Verified.Rail.Graph × Nat × Nat) := do
  let adj : Array (Array (Nat × Nat)) ← (← (← j.getObjVal? "adj").getArr?).mapM fun r => do
    (← r.getArr?).mapM fun e => do
      let a ← e.getArr?
      let some tJ := a[0]? | throw "adj: bad edge"
      let some wJ := a[1]? | throw "adj: bad edge"
      return (← tJ.getNat?, ← wJ.getNat?)
  let src ← (← j.getObjVal? "src").getNat?
  let dst ← (← j.getObjVal? "dst").getNat?
  return (⟨adj⟩, src, dst)

/-- Points for the geo mode: `[[la, lo, ts], ...]` in 1e-7° units /
epoch seconds. -/
private def parsePts (j : Json) : Except String (Array Verified.Geo.QPt) := do
  (← j.getArr?).mapM fun p => do
    let a ← p.getArr?
    let some laJ := a[0]? | throw "pt: expected [la, lo, ts]"
    let some loJ := a[1]? | throw "pt: expected [la, lo, ts]"
    let some tsJ := a[2]? | throw "pt: expected [la, lo, ts]"
    return { la := ← laJ.getInt?, lo := ← loJ.getInt?, ts := ← tsJ.getInt? }

/-- Way / building coordinates for the match mode: `[[la, lo], ...]` in
1e-7° units (timestamp implicitly 0). -/
private def parseLatLon (j : Json) : Except String (Array Verified.Geo.QPt) := do
  (← j.getArr?).mapM fun p => do
    let a ← p.getArr?
    let some laJ := a[0]? | throw "coord: expected [la, lo]"
    let some loJ := a[1]? | throw "coord: expected [la, lo]"
    return ({ la := ← laJ.getInt?, lo := ← loJ.getInt?, ts := 0 } : Verified.Geo.QPt)

private def parseWays (j : Json) : Except String (Array Verified.Geo.QWay) := do
  (← j.getArr?).mapM fun w => do
    let coords ← parseLatLon (← w.getObjVal? "coords")
    let name : Option String :=
      match w.getObjVal? "name" >>= (·.getStr?) with
      | .ok s => some s
      | .error _ => none
    return ({ coords, name } : Verified.Geo.QWay)

private def parseBuildings (j : Json) : Except String (Array (Array Verified.Geo.QPt)) := do
  (← j.getArr?).mapM parseLatLon

/-- `verified_cli match` input: fixes (`[la, lo, ts]`), ways, buildings. -/
private def parseMatch (j : Json) :
    Except String (Array Verified.Geo.QPt × Array Verified.Geo.QWay ×
      Array (Array Verified.Geo.QPt)) := do
  let fixes ← parsePts (← j.getObjVal? "fixes")
  let ways ← parseWays (← j.getObjVal? "ways")
  let buildings ← parseBuildings (← j.getObjVal? "buildings")
  return (fixes, ways, buildings)

private inductive GeoReq where
  | simplify (pts : Array Verified.Geo.QPt) (tol : Nat)
  | hold (pts : Array Verified.Geo.QPt) (cap : Nat)
  | spikes (pts : Array Verified.Geo.QPt)
  | splice (coarse route : Array Verified.Geo.QPt) (tol drop : Nat)
  | dedupe (pts : Array Verified.Geo.QPt)
  | spurs (pts : Array Verified.Geo.QPt) (ret span : Nat)
  | despike (pts raw : Array Verified.Geo.QPt) (apex excess : Nat)
  | trim (path fixes : Array Verified.Geo.QPt)

private def parseGeo (j : Json) : Except String GeoReq := do
  match ← (← j.getObjVal? "op").getStr? with
  | "simplify" =>
    return .simplify (← parsePts (← j.getObjVal? "pts"))
      (← (← j.getObjVal? "tol").getNat?)
  | "hold" =>
    return .hold (← parsePts (← j.getObjVal? "pts"))
      (← (← j.getObjVal? "cap").getNat?)
  | "spikes" => return .spikes (← parsePts (← j.getObjVal? "pts"))
  | "splice" =>
    return .splice (← parsePts (← j.getObjVal? "coarse"))
      (← parsePts (← j.getObjVal? "route"))
      (← (← j.getObjVal? "tol").getNat?)
      (← (← j.getObjVal? "drop").getNat?)
  | "dedupe" => return .dedupe (← parsePts (← j.getObjVal? "pts"))
  | "spurs" =>
    return .spurs (← parsePts (← j.getObjVal? "pts"))
      (← (← j.getObjVal? "ret").getNat?)
      (← (← j.getObjVal? "span").getNat?)
  | "despike" =>
    return .despike (← parsePts (← j.getObjVal? "pts"))
      (← parsePts (← j.getObjVal? "raw"))
      (← (← j.getObjVal? "apex").getNat?)
      (← (← j.getObjVal? "excess").getNat?)
  | "trim" =>
    return .trim (← parsePts (← j.getObjVal? "path"))
      (← parsePts (← j.getObjVal? "fixes"))
  | op => throw s!"unknown geo op {op}"

private def ptJson (p : Verified.Geo.QPt) : Json :=
  Json.arr #[Lean.toJson p.la, Lean.toJson p.lo, Lean.toJson p.ts]

/-- Run one pure JSON→JSON handler in one-shot mode: parse stdin, print the
result, exit non-zero iff it carries an `error`. -/
private def runOne (f : Json → Json) (input : String) : IO UInt32 := do
  match Json.parse input with
  | .error e =>
    IO.println (Json.mkObj [("error", Json.str e)]).compress
    return 1
  | .ok j =>
    let out := f j
    IO.println out.compress
    return (if (out.getObjVal? "error").toOption.isSome then 1 else 0)

/-- One display pass over quantised points as a pure result — the Lean side
of the `compare-geo` harness, and a `serve`-mode handler. -/
private def geoResult (j : Json) : Json :=
  match parseGeo j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok req =>
      match req with
      | .simplify pts tol =>
        Json.mkObj [("keep", Json.arr
          ((Verified.Geo.qSimplify (fun i => pts.getD i default) pts.size
            tol).toArray.map Lean.toJson))]
      | .hold pts cap =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qHoldSpeed cap (fun i => pts.getD i default)
            pts.size).toArray.map ptJson))]
      | .spikes pts =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qRejectSpikes (fun i => pts.getD i default)
            pts.size).toArray.map ptJson))]
      | .splice coarse route tol drop =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qSplice (fun i => route.getD i default) route.size
            tol drop (fun i => coarse.getD i default)
            coarse.size).toArray.map ptJson))]
      | .dedupe pts =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qDedupe (fun i => pts.getD i default)
            pts.size).toArray.map ptJson))]
      | .spurs pts ret span =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qRemoveSpurs ret span pts.toList).toArray.map ptJson))]
      | .despike pts raw apex excess =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qDespike apex excess raw.toList
            (fun i => pts.getD i default) pts.size).toArray.map ptJson))]
      | .trim path fixes =>
        Json.mkObj [("pts", Json.arr
          ((Verified.Geo.qTrim (fun i => fixes.getD i default) fixes.size
            (fun i => path.getD i default) path.size).toArray.map ptJson))]

private def geoMain (input : String) : IO UInt32 :=
  runOne geoResult input

/-- The walk map-matcher over quantised input as a pure result — the Lean
side of the `compare-match` harness, and a `serve`-mode handler. -/
private def matchResult (j : Json) : Json :=
  match parseMatch j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (fixes, ways, buildings) =>
    match Verified.Geo.qMatchWalkSegment fixes ways buildings with
    | none => Json.mkObj [("none", Json.bool true)]
    | some r =>
      Json.mkObj [
        ("path", Json.arr (r.path.map ptJson)),
        ("coarse", Json.arr (r.coarsePath.map ptJson))]

private def matchMain (input : String) : IO UInt32 :=
  runOne matchResult input

/-- `verified_cli matchprof` — the matcher's phases run one at a time with
wall-clock between them, plus the shape of the graph they produced. Attributes a
slow leg to a phase without a sampling profiler (which mis-attributes across
Lean's inlined loop closures). Each `IO.lazyPure` pins one phase's evaluation
between two timestamps; `full` re-runs the whole matcher, so the phases before
it are *included* in its own cost, not additional to it. -/
private def matchProfMain (input : String) : IO UInt32 := do
  match Json.parse input >>= parseMatch with
  | .error e => IO.eprintln s!"error: {e}"; return 1
  | .ok (fixes, ways, buildings) =>
    let P := Verified.Geo.WALK_QPROFILE
    let t0 ← IO.monoMsNow
    let co ← IO.lazyPure fun _ =>
      Verified.Geo.mkQCorridor fixes P.corridorNearUm P.corridorFarUm P.corridorMaxPenalty
    let t1 ← IO.monoMsNow
    let bld ← IO.lazyPure fun _ =>
      if P.buildingCrossFactor > 1 && buildings.size > 0 then
        some (Verified.Geo.mkQBuildings buildings fixes P.buildingCrossFactor P.buildingSupportUm)
      else none
    let t2 ← IO.monoMsNow
    let graph ← IO.lazyPure fun _ => Verified.Geo.buildQGraphFast ways co bld P.gapBridgeUm
    let t3 ← IO.monoMsNow
    let idx ← IO.lazyPure fun _ => Verified.Geo.mkQSegIndex graph P.radiusUm co.cmin
    -- Two counterfactual builds, for attribution only: without the buildings
    -- penalty, and with an empty corridor (`distToFast` returns at once). Their
    -- *values* are wrong; only their cost is read.
    let t3b ← IO.monoMsNow
    let _ ← IO.lazyPure fun _ =>
      (Verified.Geo.buildQGraphFast ways co none P.gapBridgeUm).segments.size
    let t3c ← IO.monoMsNow
    let _ ← IO.lazyPure fun _ =>
      (Verified.Geo.buildQGraphFast ways
        (Verified.Geo.mkQCorridor #[] P.corridorNearUm P.corridorFarUm P.corridorMaxPenalty)
        none P.gapBridgeUm).segments.size
    let t3d ← IO.monoMsNow
    let t4 ← IO.monoMsNow
    let nCand ← IO.lazyPure fun _ =>
      fixes.foldl (init := 0) fun acc f =>
        acc + (Verified.Geo.qCandidatesForFixFast f graph idx P.radiusUm P.maxCandidatesPerFix).size
    let t5 ← IO.monoMsNow
    let full ← IO.lazyPure fun _ => Verified.Geo.qMatchWalkSegment fixes ways buildings
    let t6 ← IO.monoMsNow
    IO.println s!"fixes={fixes.size} ways={ways.size} rings={buildings.size} \
vertices={graph.vertices.size} segments={graph.segments.size} \
edges={Verified.Geo.totalOut graph.g} chords={co.chords.size} cands={nCand} \
matched={full.isSome}"
    IO.println s!"corridor={t1 - t0}ms buildings={t2 - t1}ms graph={t3 - t2}ms \
segidx={t3b - t3}ms cands={t5 - t4}ms full={t6 - t5}ms"
    IO.println s!"graph-no-buildings={t3c - t3b}ms graph-no-corridor={t3d - t3c}ms"
    let stat (name : String) (g : Std.HashMap Nat (Array Nat)) : String :=
      let tot := g.fold (init := 0) fun a _ v => a + v.size
      let mx := g.fold (init := 0) fun a _ v => max a v.size
      s!"{name}: cells={g.size} filed={tot} mean={tot / max 1 g.size} max={mx}"
    IO.println (stat "corridor-grid" co.grid)
    IO.println (stat "segment-grid" idx.grid)
    match bld with
    | some b => IO.println (stat "building-grid" b.grid)
    | none => pure ()
    return 0

/-- The certified rail shortest-path as a pure result: any returned path is
theorem-backed (`dijkstraC_correct`); a certification failure degrades to
`none`. Lean side of `compare-rail`, and a `serve`-mode handler. -/
private def railResult (j : Json) : Json :=
  match parseRail j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (g, src, dst) =>
    match Verified.Rail.dijkstraC g src dst with
    | none => Json.mkObj [("none", Json.bool true)]
    | some path =>
      match Verified.Rail.dijkstraDist g src dst with
      | none => Json.mkObj [("error", Json.str "path without dist")]
      | some d =>
        Json.mkObj [
          ("path", Json.arr (path.toArray.map fun v => Lean.toJson v)),
          ("dist", Lean.toJson d)]

private def railMain (input : String) : IO UInt32 :=
  runOne railResult input

/-- One HSMM decode as a pure result (`serve`-mode handler). The one-shot
`main` path keeps its own timing-instrumented copy. -/
private def hsmmResult (j : Json) : Json :=
  match parseModel j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok m =>
    match pDecodeFast m ckptStride with
    | none => Json.mkObj [("degenerate", Json.bool true)]
    | some r =>
      Json.mkObj [
        ("path", Json.arr (r.path.map fun s => Lean.toJson s)),
        ("best", match r.best with | .val v => Lean.toJson v | .negInf => Json.null)]

/-! ## Assemble mode (`verified_cli assemble`)

Build the HSMM model FROM PARSED INPUTS in Lean — the `buildHsmmModel` twin
(`Verified.Hsmm.Assemble`) — and emit the quantised tensors, so the marshalled
`QuantProblem` payload is no longer produced TS-side. Input is the post-boundary
structured day (past the tz / WKT / `toFixed` boundary the shell owns): the
observation tensor, the parsed route edges, the focus places, the train-generator
coverage map, continuity, and the C4 flags. Output is the dense quantised
`emit`/`entry`/`init`/`trans`/`dur` tensors, compared cell-for-cell against TS
`quantizeModel` by `lean/experiments/compare-assemble.mjs`.

  { "maxD": n,
    "obs": [{ts, gps:{lat,lon,speedKmh}|null, hr, cadence, hourLocal, dayOfWeekLocal,
              inBed, roadDistM, railDistM, reacquireAgeMin, prevGpsFix, nextGpsFix}],
    "edges": [{id, geometry:[{lat,lon}], lineMemberships:[str], underground, startNode, endNode}],
    "places": [{id, name, lat, lon, hourProfile:[num]|null, dwell}],
    "coverage": [[ts, [lines]]],                         // ts → generator-vouched lines
    "continuity": {priorPlaceId, priorPlaceCoord:[lat,lon]|null, hoursSince, priorPosterior}|null,
    "flags": {reacquireRobust, segEvidence, chainContext} }

Output: { T, S, maxD, emit[t][s], entry[t][s], init[s], trans[t][a][b], dur[s][d-1][e] }
(all quantised ints, `null` = -∞). -/

/-- A Float from either encoding on this wire: a JSON number, or the decimal of
its IEEE-754 bit pattern as a string.

⚠ **BOTH, BECAUSE THE TWO PRODUCERS DISAGREE AND FIVE FIELDS PROVED IT.** The
TypeScript arms send numbers, because that is what `JSON.stringify` makes of a
JS float. Every Lean-to-Lean hop sends bit patterns (`fBits`), because a
coordinate re-rounded on the wire moves a node's 5-dp key, which is its
IDENTITY. Reading only one of the two is how `buildWireGraph`'s `edges`/`nodes`
came out of one Lean entry point and were refused with `number expected` by the
next — a shape defect entirely inside this repository, between two files that
are both here.

⚠ IT IS NOT A LENIENT PARSE. A string that is not a bit pattern is still an
error, by name: silently reading an unparseable distance as "no evidence" would
let a day decode, look plausible, and never learn that any fix was on a
railway. -/
private def jFloat (j : Json) : Except String Float :=
  match j.getStr? with
  | .ok _ => jBits j
  | .error _ => do return (← j.getNum?).toFloat

/-! ⚠ **A COORDINATE ON THIS WIRE IS A DECIMAL, AND IT HAS TO SURVIVE EXACTLY.**
Most floats in this file cross as IEEE-754 bit patterns (`fBits`/`jBits`), but
`observation.points` does not: the tensor's fixes are plain JSON numbers, because
that is what the TypeScript arm sends and what `decode-day` now sends too.

That is only safe because two things hold together — the emitter writes the
SHORTEST decimal that round-trips (`serde_json` uses Ryū; V8's `JSON.stringify`
is the same rule), and `Json.parse` reads it back to the same bits. The first is
somebody else's library; the second is checked here, so a toolchain bump that
made the parser merely close would fail loudly rather than shift every fix by an
invisible amount.

Measured 2026-08-26 before relying on it, rather than assumed. -/
private def parsesTo (s : String) (x : Float) : Bool :=
  match Json.parse s >>= (·.getNum?) with
  | .ok n => n.toFloat.toBits == x.toBits
  | .error _ => false

#guard parsesTo "51.5" 51.5
#guard parsesTo "-0.1278" (-0.1278)
-- 17 significant digits: the widest a round-tripping double ever needs.
#guard parsesTo "51.500100000000014" (Float.ofBits 4632444812033547622)
#guard parsesTo "-0.12345678901234567" (Float.ofBits 13816932456701818462)
#guard parsesTo "51.512345678901234" (Float.ofBits 4632446535459639385)
#guard parsesTo "123.45678901234568" (Float.ofBits 4638387916139875481)
-- ⚠ AND EXPONENT NOTATION, which is what an emitter writes for a small speed.
-- A parser that rejected it would fail loudly; one that read it as 0 would not.
#guard parsesTo "1e-7" 0.0000001
#guard parsesTo "-1.5e-9" (-0.0000000015)
private def jFloatField (j : Json) (k : String) : Except String Float := do jFloat (← j.getObjVal? k)
private def jOptFloat (j : Json) (k : String) : Except String (Option Float) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← jFloat v)
  | .error _ => .ok none
private def jOptInt (j : Json) (k : String) : Except String (Option Int) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← v.getInt?)
  | .error _ => .ok none

private def parseFix (j : Json) : Except String Verified.Hsmm.Observation.Fix := do
  return ⟨← (← j.getObjVal? "ts").getInt?, ← jFloatField j "lat", ← jFloatField j "lon"⟩
private def parseOptFix (j : Json) (k : String) : Except String (Option Verified.Hsmm.Observation.Fix) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← parseFix v)
  | .error _ => .ok none

private def parseObsRow (j : Json) : Except String Verified.Hsmm.Observation.ObsRow := do
  let gps : Option Verified.Hsmm.Observation.GpsAgg ←
    match j.getObjVal? "gps" with
    | .ok v => if v.isNull then pure none
               else pure (some ⟨← jFloatField v "lat", ← jFloatField v "lon", ← jFloatField v "speedKmh"⟩)
    | .error _ => pure none
  return {
    ts := ← (← j.getObjVal? "ts").getInt?, gps
    hr := ← jOptFloat j "hr", cadence := ← jOptFloat j "cadence"
    hourLocal := ← (← j.getObjVal? "hourLocal").getNat?
    dayOfWeekLocal := ← (← j.getObjVal? "dayOfWeekLocal").getNat?
    inBed := ← (← j.getObjVal? "inBed").getBool?
    roadDistM := ← jOptFloat j "roadDistM", railDistM := ← jOptFloat j "railDistM"
    reacquireAgeMin := ← jOptInt j "reacquireAgeMin"
    prevGpsFix := ← parseOptFix j "prevGpsFix", nextGpsFix := ← parseOptFix j "nextGpsFix" }

/-- `none` → `null`, `some s` → the string. -/
private def optStrJson : Option String → Json
  | none => Json.null
  | some s => Json.str s

/-- A station node for the chained-triple resolver. Same five fields as
`parseStationNode`'s, and a DIFFERENT record — the coverage builder and the
station chain each have their own. Kept here beside the other wire parsers
rather than inside `namespace StationChain`, because `assemblesegments` runs the
chain itself and needs this several hundred lines earlier. -/
private def parseChainNode (j : Json) : Except String Verified.Hsmm.StationChain.ChainNode := do
  let name : Option String := match (j.getObjVal? "stationName" >>= (·.getStr?)) with
    | .ok s => some s | .error _ => none
  let edgeIds ← (← (← j.getObjVal? "edgeIds").getArr?).mapM (·.getStr?)
  return ⟨← (← j.getObjVal? "id").getStr?, ← jFloatField j "lat", ← jFloatField j "lon",
    name, edgeIds.toList⟩

/-- One cached rail relation: which line, and the stops it serves. Only the stop
NAMES are read — the coordinates in `stops_json` answer a different question. -/
private def parseRelation (j : Json) :
    Except String Verified.Hsmm.ServedStations.RailStopRelation := do
  let stops ← (← (← j.getObjVal? "stops").getArr?).mapM fun t => do
    pure (⟨← optStr t "name"⟩ : Verified.Hsmm.ServedStations.RailStop)
  return ⟨← optStr j "lineRef", ← optStr j "lineName", stops⟩

private def parseEdge (j : Json) : Except String Verified.Hsmm.RouteModel.RouteEdge := do
  let geom ← (← (← j.getObjVal? "geometry").getArr?).mapM fun p => do
    pure (⟨← jFloatField p "lat", ← jFloatField p "lon"⟩ : Verified.Hsmm.RouteGraph.LatLon)
  let lines ← (← (← j.getObjVal? "lineMemberships").getArr?).mapM (·.getStr?)
  return ⟨← (← j.getObjVal? "id").getStr?, geom.toList, lines.toList,
    ← (← j.getObjVal? "underground").getBool?,
    ← (← j.getObjVal? "startNode").getStr?, ← (← j.getObjVal? "endNode").getStr?⟩

private def parsePlace (j : Json) :
    Except String (Verified.Hsmm.StateSpace.FocusPlaceRef × Float × Float × Option (Array Float) × Float) := do
  let name : Option String := match (j.getObjVal? "name" >>= (·.getStr?)) with | .ok s => some s | .error _ => none
  let prof : Option (Array Float) ←
    match j.getObjVal? "hourProfile" with
    | .ok v => if v.isNull then pure none else pure (some (← (← v.getArr?).mapM jFloat))
    | .error _ => pure none
  return (⟨← (← j.getObjVal? "id").getInt?, name⟩, ← jFloatField j "lat", ← jFloatField j "lon",
    prof, ← jFloatField j "dwell")

private def parseCoverage (j : Json) : Except String (Std.HashMap Int (List String)) := do
  let mut m : Std.HashMap Int (List String) := {}
  for e in (← j.getArr?) do
    let a ← e.getArr?
    let some tsJ := a[0]? | throw "coverage: expected [ts, [lines]]"
    let some lnJ := a[1]? | throw "coverage: expected [ts, [lines]]"
    m := m.insert (← tsJ.getInt?) (← (← lnJ.getArr?).mapM (·.getStr?)).toList
  return m

private def parseContinuity (j : Json) : Except String (Option Verified.Hsmm.Continuity.ContinuityContext) :=
  match j.getObjVal? "continuity" with
  | .ok v =>
    if v.isNull then .ok none else do
      let pid ← jOptInt v "priorPlaceId"
      let coord : Option (Float × Float) ←
        match v.getObjVal? "priorPlaceCoord" with
        | .ok x => if x.isNull then pure none else do
            let a ← x.getArr?
            let some laJ := a[0]? | throw "priorPlaceCoord"
            let some loJ := a[1]? | throw "priorPlaceCoord"
            pure (some (← jFloat laJ, ← jFloat loJ))
        | .error _ => pure none
      return some ⟨pid, coord, ← jFloatField v "hoursSince", ← jFloatField v "priorPosterior"⟩
  | .error _ => .ok none

private def parseStationNode (j : Json) : Except String Verified.Hsmm.TrainCandidates.StationNode := do
  let name : Option String := match (j.getObjVal? "stationName" >>= (·.getStr?)) with
    | .ok s => some s | .error _ => none
  let edgeIds ← (← (← j.getObjVal? "edgeIds").getArr?).mapM (·.getStr?)
  return ⟨← (← j.getObjVal? "id").getStr?, ← jFloatField j "lat", ← jFloatField j "lon", name, edgeIds.toList⟩

/-! ## Building the observation tensor here, instead of receiving it

⚠ THE TENSOR IS 1440 ROWS AND IT DOES NOT NEED TO CROSS THE WIRE. Shipping it is
what #411 measures at 33-40 MiB per day. Everything it is built FROM is small:
the day's fixes, three biometric streams, and two per-minute lookup tables the
shell must resolve because they are not pure — the local hour/day-of-week (a
timezone) and the road/rail distances (an OSM query).

So `assemblesegments` accepts EITHER form:

    "obs"          a pre-built array of rows   — what the TS shadow path sends
    "observation"  the raw materials           — what `decode-day` sends

⚠ The two are not interchangeable by accident: `head::capture`'s `obs` is the DAY
TENANT's object and has nothing to do with this. decode-day sent it for a week
and every run failed with `array expected`, because a compile cannot tell two
tensors apart when they share a field name.
-/

private def parseGpsPoint (j : Json) : Except String Verified.Hsmm.Observation.GpsPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, lat := ← jFloatField j "lat"
         , lon := ← jFloatField j "lon", speedKmh := ← jFloatField j "speedKmh" }

private def parseHrPoint (j : Json) : Except String Verified.Hsmm.Observation.HrPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, bpm := ← jFloatField j "bpm" }

private def parseStepPoint (j : Json) : Except String Verified.Hsmm.Observation.StepPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, steps := ← jFloatField j "steps" }

private def parseSleepRec (j : Json) : Except String Verified.Hsmm.Observation.SleepRec := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
         , endTs := ← (← j.getObjVal? "endTs").getInt? }

/-- Build the tensor from raw materials.

⚠ `localCtx` AND `proximity` ARE LOOKUP TABLES, NOT FUNCTIONS, because JSON has
no functions. `localCtx` is 1440 `[hourLocal, dayOfWeek]` pairs indexed by minute;
`proximity` is a list of `[minuteTs, roadDistM|null, railDistM|null]` for the
minutes that HAD fixes — sparse on purpose, since a minute with no fix has no
position to be near anything.

⚠ A MINUTE MISSING FROM `proximity` IS `(none, none)`, which is "not known to be
near either", NOT "far from both". The decoder treats a null as no evidence; a
large number would be evidence AGAINST rail. -/
private def parseObservationInput (v : Json)
    : Except String (Array Verified.Hsmm.Observation.ObsRow) := do
  let startUtc ← (← v.getObjVal? "startUtc").getInt?
  let points ← (← (← v.getObjVal? "points").getArr?).mapM parseGpsPoint
  let hr ← (← (← v.getObjVal? "hr").getArr?).mapM parseHrPoint
  let steps ← (← (← v.getObjVal? "steps").getArr?).mapM parseStepPoint
  let sleep ← (← (← v.getObjVal? "sleep").getArr?).mapM parseSleepRec
  let imputeCadence ← (← v.getObjVal? "imputeCadence").getBool?
  -- The local-time table: 1440 [hour, dayOfWeek] pairs.
  let ctxArr ← (← (← v.getObjVal? "localCtx").getArr?).mapM (fun e => do
    let a ← e.getArr?
    let some h := a[0]? | throw "localCtx: a row is not [hour, dayOfWeek]"
    let some d := a[1]? | throw "localCtx: a row is not [hour, dayOfWeek]"
    pure ((← h.getNat?), (← d.getNat?)))
  if ctxArr.size != Verified.Hsmm.Observation.MINUTES_PER_DAY then
    throw s!"localCtx has {ctxArr.size} rows, not {Verified.Hsmm.Observation.MINUTES_PER_DAY}"
  -- The proximity table, sparse and keyed by top-of-minute ts.
  let proxPairs ← (← (← v.getObjVal? "proximity").getArr?).mapM (fun e => do
    let a ← e.getArr?
    let some tsJ := a[0]? | throw "proximity: a row is not [ts, road, rail]"
    -- ⚠ EITHER ENCODING, WHICH IS `jFloat`'S JOB — `proximitytable` writes bit
    -- patterns and the TS shadow path writes numbers. Absent or null is "not
    -- known to be near either"; anything else is an ERROR rather than a null.
    let dist : Json → Except String (Option Float) := fun x =>
      if x.isNull then pure none else some <$> jFloat x
    let road ← match a[1]? with | some x => dist x | none => pure none
    let rail ← match a[2]? with | some x => dist x | none => pure none
    pure ((← tsJ.getInt?), road, rail))
  let proxMap : Std.HashMap Int (Option Float × Option Float) :=
    proxPairs.foldl (fun m (t, r, l) => m.insert t (r, l)) {}
  return Verified.Hsmm.Observation.buildObservationTensor startUtc
    points.toList hr.toList steps.toList sleep.toList
    (fun m => ctxArr[m]!)
    (fun ts => proxMap.getD ts (none, none))
    imputeCadence

private def parseAssemble (j : Json) : Except String (Verified.Hsmm.Assemble.ModelContext × Nat) := do
  -- ⚠ `observation` WINS when both are present, and that is not arbitrary: the
  -- raw form is the one that cannot be stale, because it is what the tensor
  -- would be built from anyway.
  let obs ← match j.getObjVal? "observation" with
    | .ok v => if v.isNull then
                 (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
               else parseObservationInput v
    | .error _ => (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
  let edges ← (← (← j.getObjVal? "edges").getArr?).mapM parseEdge
  let places ← (← (← j.getObjVal? "places").getArr?).mapM parsePlace
  let model := Verified.Hsmm.RouteModel.buildRouteGraphModel edges
  -- Coverage: REBUILD in Lean from the station nodes when present (the
  -- self-contained serve path), else take the provided coverage map.
  let nodes ← match j.getObjVal? "nodes" with
    | .ok v => if v.isNull then pure #[] else (← v.getArr?).mapM parseStationNode
    | .error _ => pure #[]
  let coverage ←
    if nodes.isEmpty then
      match j.getObjVal? "coverage" with
      | .ok v => if v.isNull then pure {} else parseCoverage v
      | .error _ => pure {}
    else
      let edgeById : Std.HashMap String Verified.Hsmm.RouteModel.RouteEdge :=
        edges.foldl (fun m e => m.insert e.id e) {}
      let nodeById : Std.HashMap String Verified.Hsmm.TrainCandidates.StationNode :=
        nodes.foldl (fun m n => m.insert n.id n) {}
      let sg : Verified.Hsmm.TrainCandidates.StationGraph := { model, nodeById, edgeById }
      pure (Verified.Hsmm.TrainCandidates.buildCoverage
        (Verified.Hsmm.TrainCandidates.enumerateTrainCandidates sg obs Verified.Hsmm.Assemble.KNOWN_LINES) obs)
  let continuity ← parseContinuity j
  let placeNearLine : Std.HashSet String ←
    match j.getObjVal? "placeNearLine" with
    | .ok v => if v.isNull then pure {} else do
        pure (Std.HashSet.ofList (← (← v.getArr?).mapM (·.getStr?)).toList)
    | .error _ => pure {}
  let flags ← j.getObjVal? "flags"
  -- ⚠ ABSENT `maxD` IS THE MODEL'S OWN, not a caller's guess. It is the trellis
  -- depth every arm has to agree on, so the number lives in
  -- `Verified.Hsmm.Assemble` and a shell that has no opinion says nothing.
  let maxD ← match j.getObjVal? "maxD" with
    | .ok v => if v.isNull then pure Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION else v.getNat?
    | .error _ => pure Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION
  return (Verified.Hsmm.Assemble.buildContext obs model
    places.toList coverage placeNearLine continuity
    (← (← flags.getObjVal? "reacquireRobust").getBool?)
    (← (← flags.getObjVal? "segEvidence").getBool?)
    (← (← flags.getObjVal? "chainContext").getBool?), maxD)

/-- A quantised cell as JSON: integer-valued `Float` → `Int`; `none` → `null`. -/
private def qCell : Option Float → Json
  | none => Json.null
  | some v => Lean.toJson (Float.toInt64 v).toInt

/-- `[[a,b,t], …]` probe triples for the sparse `trans`/`dur` checks (the dense
    tensors are `S·maxD·T` — too large to ship for a full 1440-minute day). -/
private def triplesOf (j : Json) (k : String) : Array (Nat × Nat × Nat) :=
  match j.getObjVal? k >>= (·.getArr?) with
  | .ok arr => arr.filterMap fun e =>
      match e.getArr? with
      | .ok a =>
        match a[0]?, a[1]?, a[2]? with
        | some x, some y, some z =>
          match x.getNat?, y.getNat?, z.getNat? with
          | .ok xn, .ok yn, .ok zn => some (xn, yn, zn)
          | _, _, _ => none
        | _, _, _ => none
      | .error _ => none
  | .error _ => #[]

/-! ## Coverage mode (`verified_cli coverage`)

Rebuild the train-generator coverage map IN LEAN from the observation tensor and a
node-annotated station graph — `enumerateTrainCandidates` + `buildCoverage`, the
Lean twin of `buildTrainGeneratorPrior`. Checks the REBUILD parity (the assemble
mode CONSUMES a coverage map; here Lean reconstructs it). The shell supplies the
station annotation (`nodeKey` ids, station names, incident edge ids — the topology
boundary).

  { "obs": [...], "edges": [...],
    "nodes": [{id, lat, lon, stationName|null, edgeIds:[...]}] }

Output: { "coverage": [[ts, [lines]]] }. -/

private def coverageResult (j : Json) : Json :=
  let parsed : Except String (Std.HashMap Int (List String)) := do
    let obs ← (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
    let edges ← (← (← j.getObjVal? "edges").getArr?).mapM parseEdge
    let nodes ← (← (← j.getObjVal? "nodes").getArr?).mapM parseStationNode
    let edgeById : Std.HashMap String Verified.Hsmm.RouteModel.RouteEdge :=
      edges.foldl (fun m e => m.insert e.id e) {}
    let nodeById : Std.HashMap String Verified.Hsmm.TrainCandidates.StationNode :=
      nodes.foldl (fun m n => m.insert n.id n) {}
    let sg : Verified.Hsmm.TrainCandidates.StationGraph :=
      { model := Verified.Hsmm.RouteModel.buildRouteGraphModel edges, nodeById, edgeById }
    let cands := Verified.Hsmm.TrainCandidates.enumerateTrainCandidates sg obs Verified.Hsmm.Assemble.KNOWN_LINES
    return Verified.Hsmm.TrainCandidates.buildCoverage cands obs
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok cov =>
    Json.mkObj [("coverage", Json.arr (cov.toList.map
      (fun (ts, lines) => Json.arr #[Lean.toJson ts, Json.arr (lines.map Json.str).toArray])).toArray)]

/-- Encode a quantised score into the packed `Nat` (`enc`: -∞ ↦ 0, `v ↦ v + 2^61`),
    refusing values outside `bound` (the verified envelope). -/
private def encScore (bound : Nat) : Option Float → Except String Nat
  | none => .ok 0
  | some fv =>
    let v := (Float.toInt64 fv).toInt
    if v.natAbs > bound then throw s!"assembled score {v} exceeds envelope {bound}"
    else .ok (v + (pOff : Int)).toNat

/-- Class key for the duration factorisation. `dur(s,d,e)` depends on the state
    only through `(mode, isNamedTrain)` — segment evidence sees the mode, and the
    train-hop relaxation the named-line + coverage (which is line-independent). So
    this partition is EXACT (no iterative refinement): every state in a class has
    identical `dur(·,d,e)` at every cell. Named train ⇒ 7; unknown_rail train ⇒ 4. -/
private def durClassKey (s : Verified.Hsmm.Emissions.State) : Nat :=
  match s.mode with
  | .stationary => 0 | .walking => 1 | .cycling => 2 | .driving => 3
  | .plane => 5 | .unknown => 6
  | .train => match s.lineName with | some l => if l != "unknown_rail" then 7 else 4 | none => 4

/-- Reference `segEnd` for the duration baseline (matches TS `REF_E`). -/
private def assembleRefE : Nat := 720

/-- Build the packed `PData` directly from the assembled model — the in-process
    twin of `quantizeModel` + `parseModel`, so `verified_cli` goes raw-inputs →
    trellis with NO marshalled tensor payload. Transitions are per-`t` dense
    (`nTB = T`); durations use the `(mode, isNamedTrain)` class factorisation
    (`durBase` at `REF_E` + `durDelta` per class), the compact form the decoder
    reads. Scores are finite here (log-probabilities), so no -∞ path arises. -/
private def buildPData (c : Verified.Hsmm.Assemble.ModelContext) (maxD : Nat) : Except String PData := do
  let T := c.obs.size
  let S := c.states.size
  if T > pTMax then throw s!"T={T} exceeds the verified envelope (T ≤ 2048)"
  let halfOB := pOB / 2
  let quant := Verified.Hsmm.Quantize.quantize
  let mut emit : Array Nat := Array.replicate (T * S) 0
  let mut entry : Array Nat := Array.replicate (T * S) 0
  for t in [0:T] do
    for s in [0:S] do
      emit := emit.set! (t * S + s) (← encScore pEB (quant (Verified.Hsmm.Assemble.emitAt c t s)))
      entry := entry.set! (t * S + s) (← encScore pOB (quant (Verified.Hsmm.Assemble.entryAt c t s)))
  -- Transitions: the base matrix is time-constant; only chain-context makes a
  -- transition vary with t, and only for structurally chain-eligible pairs
  -- (stay into a place, leave a place into a move, board a named line). Build the
  -- base once with a shared per-src weight sum (O(S²)), then per-t override rows
  -- for the eligible pairs only — vs a T·S³ dense build.
  let placeNear := fun (pid : Int) (line : String) => c.placeNearLine.contains s!"{pid}|{line}"
  let statesL := c.states.toList
  let weightSum : Array Float := (Array.range S).map fun a =>
    Verified.Hsmm.Transitions.crossWeightSumP placeNear statesL c.states[a]!
  let baseTransF := fun (a b : Nat) =>
    Verified.Hsmm.Transitions.transitionLogProbPre placeNear c.selfLoop weightSum[a]! c.states[a]! c.states[b]!
  let mut transBase : Array Nat := Array.replicate (S * S) 0
  for a in [0:S] do
    for b in [0:S] do
      transBase := transBase.set! (a * S + b) (← encScore pOB (quant (baseTransF a b)))
  -- Override rows for chain-eligible, non-hard-zero pairs (superset of the pairs
  -- whose chain term can be non-zero — hard-zeros keep their −∞, chain not added).
  let chainEligible := fun (src dst : Verified.Hsmm.Emissions.State) =>
    (dst.mode == .stationary && dst.placeId != none)
    || (src.mode == .stationary && src.placeId != none && Verified.Hsmm.RouteModel.isMovingMode dst.mode)
    || (dst.mode == .train && (match dst.lineName with | some l => l != "unknown_rail" | none => false))
  let mut ovPairs : Array (Nat × Nat) := #[]
  let mut transRows : Array (Array Nat) := #[]
  if c.chainOn then
    for a in [0:S] do
      for b in [0:S] do
        let src := c.states[a]!
        let dst := c.states[b]!
        if chainEligible src dst && !Verified.Hsmm.Transitions.isHardZeroP placeNear src dst then
          let base := baseTransF a b
          let mut rowr : Array Nat := Array.replicate T 0
          for t in [0:T] do
            let o := c.obs[t]!
            let cv := Verified.Hsmm.RouteModel.chainContext c.edgesByLine c.placeCoords src dst o
              (Verified.Hsmm.TrainCandidates.isCovered c.coverage o.ts)
            rowr := rowr.set! t (← encScore pOB (quant (base + cv)))
          ovPairs := ovPairs.push (a, b)
          transRows := transRows.push rowr
  let nRows := transRows.size
  let transFlat : Array Nat := Id.run do
    let mut a := Array.replicate (nRows * T) 0
    for i in [0:nRows] do
      let r := transRows[i]!
      for t in [0:T] do a := a.set! (i * T + t) r[t]!
    return a
  let mut transIdx : Array Nat := Array.replicate (S * S) nRows  -- sentinel = nRows ⇒ use base
  for i in [0:ovPairs.size] do
    let (a, b) := ovPairs[i]!
    transIdx := transIdx.set! (a * S + b) i
  -- Duration: EXACT class partition by (mode, isNamedTrain).
  let keys : Array Nat := c.states.foldl (fun acc s =>
    let k := durClassKey s; if acc.contains k then acc else acc.push k) #[]
  let nC := keys.size
  let durClass : Array Nat := c.states.map (fun s => (keys.findIdx? (· == durClassKey s)).getD 0)
  let reps : Array Nat := keys.map (fun k => (c.states.findIdx? (fun s => durClassKey s == k)).getD 0)
  let mut durBase : Array Nat := Array.replicate (S * maxD) 0
  for s in [0:S] do
    for d0 in [0:maxD] do
      durBase := durBase.set! (s * maxD + d0) (← encScore halfOB (quant (Verified.Hsmm.Assemble.durAt c s (d0 + 1) assembleRefE)))
  let qiOf := fun (x : Float) => (Float.toInt64 x).toInt   -- dur is finite
  let mut durDelta : Array Nat := Array.replicate (nC * maxD * T) halfOB
  for cls in [0:nC] do
    let rep := reps[cls]!
    for d0 in [0:maxD] do
      let qRef := match quant (Verified.Hsmm.Assemble.durAt c rep (d0 + 1) assembleRefE) with
        | some v => qiOf v | none => 0
      for e in [0:T] do
        let qE := match quant (Verified.Hsmm.Assemble.durAt c rep (d0 + 1) e) with
          | some v => qiOf v | none => 0
        let delta := qE - qRef
        if delta.natAbs > halfOB then throw s!"dur delta {delta} exceeds halfOB {halfOB}"
        durDelta := durDelta.set! ((cls * maxD + d0) * T + e) (delta + (halfOB : Int)).toNat
  return {
    T, S, maxD, halfOB, emit, entry, init := #[]
    transBase, nTB := 1, transIdx, transFlat, nRows
    durBase, durClass, durDelta, hasOv := #[], durOv := {} }

/-- Assemble the model from parsed inputs, build `PData`, and DECODE it with
    `pDecodeFast` — the full raw-inputs → path serve path, no marshalled payload. -/
private def assembleDecodeResult (j : Json) : Json :=
  match parseAssemble j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (c, maxD) =>
    match buildPData c maxD with
    | .error e => Json.mkObj [("error", Json.str e)]
    | .ok pd =>
      match pDecodeFast pd ckptStride with
      | none => Json.mkObj [("degenerate", Json.bool true)]
      | some r => Json.mkObj [
          ("path", Json.arr (r.path.map fun s => Lean.toJson s)),
          ("best", match r.best with | .val v => Lean.toJson v | .negInf => Json.null)]

/-! ## `assemblesegments` — assemble, decode, and return SEGMENTS

⚠ `assembledecode` above returns a path of STATE INDICES and nothing else, which
is enough to measure a decode and not enough to persist one: the caller has no
way to map an index to `{mode, placeId, lineName}` because `parseAssemble` builds
`c.states` internally and never emits it.

The fix is NOT to emit the state table. That table is an internal representation,
and shipping it would invite every consumer to reimplement the run-grouping — the
`groupStates` logic — against it. So the grouping happens HERE, once, and what
crosses the wire is what `decoded_days` stores.

⚠ This is also `Verified.HsmmSegments.groupStates`' FIRST entry point. It was
ported on 2026-08-24 and reachable from no mode and no op until now — the #1003
orphan pattern, one day old.

⚠ The timestamps come from `c.obs`, NOT from a caller-supplied array: the path
indexes the observation tensor, so any other source could silently disagree in
length or order and `groupStates` would return `none` (or worse, agree by
accident on a shifted window). -/
private def assembleSegmentsResult (j : Json) : Json :=
  match parseAssemble j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (c, maxD) =>
    match buildPData c maxD with
    | .error e => Json.mkObj [("error", Json.str e)]
    | .ok pd =>
      match pDecodeFast pd ckptStride with
      | none => Json.mkObj [("degenerate", Json.bool true)]
      | some r =>
        -- Index → the state the model actually holds. An out-of-range index is
        -- an ERROR, not a skipped minute: it would shorten the path and shift
        -- every later segment boundary.
        let states : Except String (Array Verified.HsmmSegments.State) :=
          r.path.foldlM (fun acc i => do
            match c.states[i]? with
            | none => throw s!"decoded state index {i} is outside the {c.states.size}-state space"
            | some s => pure (acc.push
                { mode := Verified.Hsmm.StateSpace.modeName s.mode
                , placeId := s.placeId
                , lineName := s.lineName })) #[]
        match states with
        | .error e => Json.mkObj [("error", Json.str e)]
        | .ok sts =>
          match Verified.HsmmSegments.groupStates sts (c.obs.map (·.ts)) with
          | none =>
            -- `groupStates` returns none ONLY on a length mismatch, which means
            -- the path and the observation tensor disagree — a wiring fault, not
            -- a quiet day.
            Json.mkObj [("error", Json.str
              s!"path has {sts.size} states but the observation tensor has {c.obs.size} rows")]
          | some segs =>
            -- ⚠ THE STATION CHAIN RUNS HERE, and that is the point. `stationchain`
            -- exists as its own mode and takes `obs` — the 1440-row observation
            -- tensor — so calling it from the shell would put back on the wire
            -- exactly the payload #411 exists to delete. This function already
            -- HOLDS the tensor it built.
            --
            -- ⚠ The graph is built from `c.model`, NOT by re-running
            -- `mkChainGraph`. `buildRouteGraphModel` has already run on these
            -- edges, and `edgesNearIdx` reads `model.edges` in BUILDER ORDER —
            -- reusing the same object is not an optimisation, it is the only way
            -- to be certain the order is the one the model was built with.
            let chained : Except String (Array Json) := do
              let nodes ← (← optArr j "nodes").mapM parseChainNode
              -- ⚠ ABSENT AND `[]` ARE DIFFERENT REQUESTS. Absent means the mirror
              -- was never consulted, so every candidate's `servedPen` is 0; empty
              -- means it was consulted and had nothing. Flattening them would let
              -- a shell that cannot reach the mirror pass for one that found it
              -- bare.
              let rels ← match j.getObjVal? "railStopRelations" with
                | .ok v => if v.isNull then pure none
                           else pure (some (← (← v.getArr?).mapM parseRelation))
                | .error _ => pure none
              let g : Verified.Hsmm.StationChain.ChainGraph :=
                { model := c.model
                , nodes := nodes
                , nodeById := nodes.foldl (fun m n => m.insert n.id n) {}
                , edgeById := c.model.edges.foldl (fun m e => m.insert e.id e) {} }
              let chainSegs : Array Verified.Hsmm.StationChain.ChainSeg :=
                segs.map (fun s =>
                  { mode := s.mode, lineName := s.lineName
                  , startTs := s.startTs, endTs := s.endTs })
              let byIdx : Std.HashMap Nat Verified.Hsmm.StationChain.ResolvedStations :=
                (Verified.Hsmm.StationChain.resolveStationChain g chainSegs c.obs rels).foldl
                  (fun m (i, res) => m.insert i res) {}
              pure (segs.mapIdx (fun i s =>
                let base : List (String × Json) :=
                  [ ("startTs", Lean.toJson s.startTs)
                  , ("endTs", Lean.toJson s.endTs)
                  , ("mode", Json.str s.mode)
                  , ("placeId", match s.placeId with
                      | none => Json.null | some p => Lean.toJson p)
                  , ("lineName", match s.lineName with
                      | none => Json.null | some l => Json.str l) ]
                -- ⚠ ABSENT, NOT NULL, ON A SEGMENT THE RESOLVER DID NOT REACH.
                -- The TypeScript ASSIGNS these two fields only at the indices
                -- `resolveStationsServed` returned, and `JSON.stringify` omits an
                -- `undefined`. A resolved segment whose side could not be
                -- separated carries an explicit null — "wrong is worse than
                -- missing" — and an unresolved one carries no key at all. The two
                -- read the same to a consumer and differ byte for byte in
                -- `segments_json`, which is what the parity diff compares.
                Json.mkObj (match byIdx.get? i with
                  | none => base
                  | some res => base ++
                      [ ("boardStation", optStrJson res.board)
                      , ("alightStation", optStrJson res.alight) ])))
            match chained with
            | .error e => Json.mkObj [("error", Json.str e)]
            | .ok rows =>
              Json.mkObj [
                ("segments", Json.arr rows),
                ("best", match r.best with | .val v => Lean.toJson v | .negInf => Json.null)]

/-- Assemble the model from parsed inputs and emit the quantised tensors: dense
    `emit`/`entry`/`init`, and `trans`/`dur` at the requested probe indices. -/
private def assembleResult (j : Json) : Json :=
  match parseAssemble j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (c, maxD) =>
    let q := Verified.Hsmm.Quantize.quantize
    Json.mkObj [
      ("T", Lean.toJson c.obs.size), ("S", Lean.toJson c.states.size), ("maxD", Lean.toJson maxD),
      ("emit", Json.arr ((Verified.Hsmm.Assemble.buildEmit c).map (fun r => Json.arr (r.map qCell)))),
      ("entry", Json.arr ((Verified.Hsmm.Assemble.buildEntry c).map (fun r => Json.arr (r.map qCell)))),
      ("init", Json.arr ((Verified.Hsmm.Assemble.buildInit c).map qCell)),
      ("transP", Json.arr ((triplesOf j "transProbes").map
        (fun (a, b, t) => qCell (q (Verified.Hsmm.Assemble.transAt c a b t))))),
      ("durP", Json.arr ((triplesOf j "durProbes").map
        (fun (s, d, e) => qCell (q (Verified.Hsmm.Assemble.durAt c s d e)))))]

/-! ## Float bit transport

Every other mode quantises before it emits (`qCell`, `ptJson`) because its
inputs live on a pinned integer grid. The Kalman filter does not: it is a
covariance recursion over raw degrees, where the seventh decimal of a fix moves
the gain, so its wire format has to carry Floats exactly.

`Lean.toJson (f : Float)` cannot. `Lean.JsonNumber` is a decimal (mantissa ×
10⁻ᵉ) and the printer emits six places, so Float → JSON → Float is two
roundings: `51.50009905063291` comes back `51.500099` and `1e-7` comes back `0`.
Writing a faithful printer means a shortest-round-trip algorithm (Ryu/Grisu),
which `JsNum.lean` explicitly declines to port.

So a Float crosses the wire as its IEEE-754 bit pattern, and the pattern is a
decimal STRING rather than a JSON number: it reaches 2^64, well past the 2^53
JS integers are exact to, and a bare number would simply be re-rounded by
`JSON.parse` one layer down. Round-tripping is then exact by construction,
including `1e-7` and `-0.0`. The TS twin is `src/lean/float-bits.ts`. -/


/-! ## Kalman mode (`verified_cli kalman`)

`Verified.Geo.Kalman.filterGpsTrack` — the raw-GPS smoother upstream of the
observation tensor — over the whole day's track in one call.

  { "pts": [[ts, latBits, lonBits, accBits|null], …] }

Output: `{ "pts": [[ts, latBits, lonBits, speedBits, bearingBits], …] }`. The
filter DROPS rows (duplicate timestamps, innovation-gated fixes), so the output
is a subsequence of the input and a length mismatch is meaningful, not a bug. -/

private def parseKalmanPt (j : Json) : Except String Verified.Geo.Kalman.GpsPoint := do
  let a ← j.getArr?
  match a[0]?, a[1]?, a[2]? with
  | some ts, some la, some lo =>
    let acc ← match a[3]? with
      | some v => if v.isNull then pure none else some <$> jBits v
      | none => pure none
    return ⟨← ts.getInt?, ← jBits la, ← jBits lo, acc⟩
  | _, _, _ => throw "kalman point must be [ts, latBits, lonBits, accBits|null]"

private def kalmanResult (j : Json) : Json :=
  let parsed : Except String (Array Verified.Geo.Kalman.FilteredPoint) := do
    let pts ← (← (← j.getObjVal? "pts").getArr?).mapM parseKalmanPt
    return Verified.Geo.Kalman.filterGpsTrack pts
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out =>
    Json.mkObj [("pts", Json.arr (out.map fun p =>
      Json.arr #[Lean.toJson p.ts, fBits p.lat, fBits p.lon, fBits p.speedKmh, fBits p.bearing]))]

/-! ## GPS quality mode (`verified_cli gpsquality`)

`Verified.Geo.GpsQuality.qualityFilterGps` — the incoherent-run pre-filter that
runs immediately BEFORE the Kalman filter, over the whole day's track.

  { "pts": [[ts, latBits, lonBits, accBits|null], …] }

Output: the SURVIVING rows, same shape. Unlike `kalman` this emits no computed
values: every output row is a copy of an input row, so the response is a pure
selection and the only thing the two arms can disagree about is WHICH fixes
survive. `cos` reaches only the threshold comparisons, never the output. -/

/-! ## `rankvenues` — the venue ranking, candidate by candidate (#1405, #325)

`Verified.Geo.VenuePrior.rankVenues` decides which OSM venue names a stay, and
until now nothing could see INSIDE it. #325 built this probe and reverted it to
avoid landing a mode with no caller; #1405 is why it is back, with a test that
drives it: a hand-computed model of `shapeScore` disagreed with what the fold
actually served, and a model that disagrees with the artefact is worth nothing.

⚠ FLOATS CROSS AS PLAIN NUMBERS HERE, not as `fBits`. This is a probe read by a
human and by a test that writes literals, not a Lean-to-Lean parity hop — the
bit-pattern spelling exists so two implementations can compare doubles exactly,
and there is only one implementation of this.

  { "landmarks": [{name, type, subtype, distanceM,
                   openFraction?, enclosing?, reverseGeocoded?}],
    "stay":   {startUnix, endUnix, localHour} | null,
    "priors": {bySubtype: [[name, {visits, dwell:[…], hours:[…]}]],
               byCategory: [[…]], totalVisits} | null }

Output: every candidate in RANKED order with its score broken out, so the term
that decided a stay is readable rather than inferred.

  { "ranked": [{name, subtype, distanceM, total,
                distance, venue, shape|null, hours|null,
                nearField, enclosing}] }
-/

private def num (j : Json) : Except String Float := do
  match j.getNum? with
  | .ok n => return n.toFloat
  | .error e => throw e

private def optNum (j : Json) (k : String) : Except String (Option Float) :=
  match j.getObjVal? k with
  | .error _ => .ok none
  | .ok v => if v.isNull then .ok none else do return some (← num v)

private def optBool (j : Json) (k : String) : Bool :=
  match j.getObjVal? k with
  | .ok (.bool b) => b
  | _ => false

private def parseLandmark (j : Json) : Except String Verified.Geo.VenuePrior.Landmark := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← num (← j.getObjVal? "distanceM")
    openFraction := ← optNum j "openFraction"
    enclosing := optBool j "enclosing"
    reverseGeocoded := optBool j "reverseGeocoded"
  }

private def parseVenueStatsPlain (j : Json)
    : Except String Verified.Geo.VenuePrior.VenueTypeStats := do
  return {
    visits := ← num (← j.getObjVal? "visits")
    dwell := (← (← optArr j "dwell").mapM num).toList
    hours := (← (← optArr j "hours").mapM num).toList
  }

private def parsePriorsPlain (j : Json)
    : Except String (Option Verified.Geo.VenuePrior.VenuePriors) := do
  match j.getObjVal? "priors" with
  | .error _ => return none
  | .ok v =>
    if v.isNull then return none else do
      let pair : Json → Except String (String × Verified.Geo.VenuePrior.VenueTypeStats) :=
        fun e => do
          let a ← e.getArr?
          return (← (← nth a 0).getStr?, ← parseVenueStatsPlain (← nth a 1))
      return some {
        bySubtype := (← (← optArr v "bySubtype").mapM pair).toList
        byCategory := (← (← optArr v "byCategory").mapM pair).toList
        totalVisits := ← num (← v.getObjVal? "totalVisits")
      }

/-! ## `bestplace` — the WHOLE naming chain, not just the ranking (#1405)

`rankvenues` reads the ranker. This reads what `BestPlace.resolve` finally
ANSWERS, which is a different question: the ranker's winner passes through an
enclosing check, a Nominatim specific-venue branch, a lodging override and a
residential-address branch before it becomes a label.

⚠ THIS IS THE ONLY WAY TO TELL "the ranker chose X" FROM "the fold serves X".
#1405 needed exactly that: the ranker's winner and the served label disagree,
and without this mode there is no way to say which side of `resolve` the
disagreement is on.

  { "landmarks": [{name, type, subtype, distanceM, openingHours?, enclosing?}],
    "geocode": {"18": <result>|null, "16": <result>|null},
    "samples": [[weekday, minuteOfDay], …],
    "stay": {startUnix, endUnix, localHour} | null,
    "priors": <as rankvenues> | null,
    "preferResidential": bool }

  <result> = {displayName, type, category, address:{amenity?, tourism?, shop?,
              leisure?, building?, houseNumber?, road?, pedestrian?,
              neighbourhood?, suburb?, stateDistrict?, city?, town?, village?,
              municipality?}}

Output: `{ "label": str, "city": str|null }`, or `{"label": null}` when the
chain resolves nothing.
-/

private def optStr (j : Json) (k : String) : Option String :=
  match j.getObjVal? k with
  | .ok (.str v) => some v
  | _ => none

private def parseAddress (j : Json) : Verified.Geo.Enrich.Address :=
  { amenity := optStr j "amenity", tourism := optStr j "tourism"
    leisure := optStr j "leisure", shop := optStr j "shop"
    building := optStr j "building", houseNumber := optStr j "houseNumber"
    road := optStr j "road", pedestrian := optStr j "pedestrian"
    neighbourhood := optStr j "neighbourhood", suburb := optStr j "suburb"
    stateDistrict := optStr j "stateDistrict", city := optStr j "city"
    town := optStr j "town", village := optStr j "village"
    municipality := optStr j "municipality" }

private def parseGeoResult (j : Json) : Verified.Geo.BestPlace.Result :=
  { displayName := Option.getD (optStr j "displayName") ""
    type := Option.getD (optStr j "type") ""
    category := Option.getD (optStr j "category") ""
    address := match j.getObjVal? "address" with
               | .ok a => parseAddress a
               | .error _ => {} }

private def parsePoi (j : Json) : Except String Verified.Geo.BestPlace.Poi := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← num (← j.getObjVal? "distanceM")
    openingHours := optStr j "openingHours"
    enclosing := optBool j "enclosing"
  }

private def bestPlaceResult (j : Json) : Json :=
  let parsed : Except String (Option Verified.Geo.SegmentMerge.ResolvedPlace) := do
    let pois ← (← (← j.getObjVal? "landmarks").getArr?).mapM parsePoi
    -- The geocode is a TABLE keyed by zoom, so the chain's two asks (18 then,
    -- only on one branch, 16) are answered from data rather than recomputed.
    let geo := fun (zoom : Int) =>
      match j.getObjVal? "geocode" with
      | .error _ => none
      | .ok g => match g.getObjVal? (toString zoom) with
                 | .error _ => none
                 | .ok v => if v.isNull then none else some (parseGeoResult v)
    let samples ← (← optArr j "samples").mapM (fun e => do
      let a ← e.getArr?
      let w ← (← nth a 0).getNat?
      let m ← (← nth a 1).getNat?
      return ((w, m) : Nat × Nat))
    let stay : Option Verified.Geo.VenuePrior.StayShape ← match j.getObjVal? "stay" with
      | .error _ => pure none
      | .ok v =>
        if v.isNull then pure none else do
          let st : Verified.Geo.VenuePrior.StayShape := {
            startUnix := ← (← v.getObjVal? "startUnix").getInt?
            endUnix := ← (← v.getObjVal? "endUnix").getInt?
            localHour := ← (← v.getObjVal? "localHour").getInt?
          }
          pure (some st)
    let priors ← parsePriorsPlain j
    return Verified.Geo.BestPlace.resolve
      { landmarks := pois.toList, geocode := geo, samples := samples.toList }
      stay priors (optBool j "preferResidential")
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok none => Json.mkObj [("label", Json.null)]
  | .ok (some r) =>
    Json.mkObj [("label", Json.str r.label),
                ("city", match r.city with | none => Json.null | some c => Json.str c)]

private def rankVenuesResult (j : Json) : Json :=
  let parsed : Except String (List Verified.Geo.VenuePrior.VenueCandidateScore) := do
    let lms ← (← (← j.getObjVal? "landmarks").getArr?).mapM parseLandmark
    let stay : Option Verified.Geo.VenuePrior.StayShape ← match j.getObjVal? "stay" with
      | .error _ => pure none
      | .ok v =>
        if v.isNull then pure none else do
          let st : Verified.Geo.VenuePrior.StayShape := {
            startUnix := ← (← v.getObjVal? "startUnix").getInt?
            endUnix := ← (← v.getObjVal? "endUnix").getInt?
            localHour := ← (← v.getObjVal? "localHour").getInt?
          }
          pure (some st)
    let priors ← parsePriorsPlain j
    return Verified.Geo.VenuePrior.rankVenues lms.toList stay priors
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok ranked =>
    let optF : Option Float → Json := fun o =>
      match o with | none => Json.null | some v => Lean.toJson v
    Json.mkObj [("ranked", Json.arr ((ranked.map fun c =>
      Json.mkObj [
        ("name", Json.str c.landmark.name),
        ("subtype", Json.str c.landmark.subtype),
        ("distanceM", Lean.toJson c.landmark.distanceM),
        ("total", Lean.toJson c.total),
        ("distance", Lean.toJson c.parts.distance),
        ("venue", Lean.toJson c.parts.venue),
        ("shape", optF c.parts.shape),
        ("hours", optF c.parts.hours),
        ("nearField", Json.bool c.nearField),
        ("enclosing", Json.bool c.landmark.enclosing)]).toArray))]

private def gpsQualityResult (j : Json) : Json :=
  let parsed : Except String (Array Verified.Geo.Kalman.GpsPoint) := do
    let pts ← (← (← j.getObjVal? "pts").getArr?).mapM parseKalmanPt
    return Verified.Geo.GpsQuality.qualityFilterGps pts
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out =>
    Json.mkObj [("pts", Json.arr (out.map fun p =>
      Json.arr #[Lean.toJson p.ts, fBits p.lat, fBits p.lon,
        match p.accuracy with | none => Json.null | some a => fBits a]))]

/-! ## HSMM GPS outlier filter (`verified_cli gpsoutliers`)

`Verified.Hsmm.GpsOutliers.dropGpsOutliers` — the robust-median cluster filter
`buildHsmmModel` runs on its raw points before the observation tensor. Distinct
from `gpsquality` above, which is a different filter at a different stage: that
one runs before the Kalman smoother on raw PhoneTrack fixes, this one runs after
it on the smoothed stream, and only this one is the HSMM's.

  { "pts": [[ts, latBits, lonBits, speedBits], …] }

Output: the SURVIVING rows, same shape — a pure selection like `gpsquality`, so
the only thing the two arms can disagree about is WHICH fixes survive. `cos`
reaches the deviation compared against the 2 km threshold and nothing else, and
no real fix sits within a ULP of 2 km of its own cluster median, so the kept set
is exact rather than close. Set equality is the honest assertion here and a
float delta would be the wrong instrument.

This verb exists because the module had none (#695): `Verified.Hsmm.Factors` was
its only importer and nothing in `verified_cli` reached it, so the twin was a
real port of a live pass that no comparator could enter. -/

private def parseHsmmGpsPt (j : Json) : Except String Verified.Hsmm.Observation.GpsPoint := do
  let a ← j.getArr?
  match a[0]?, a[1]?, a[2]?, a[3]? with
  | some ts, some la, some lo, some sp =>
    return ⟨← ts.getInt?, ← jBits la, ← jBits lo, ← jBits sp⟩
  | _, _, _, _ => throw "hsmm gps point must be [ts, latBits, lonBits, speedBits]"

private def gpsOutliersResult (j : Json) : Json :=
  let parsed : Except String (List Verified.Hsmm.Observation.GpsPoint) := do
    let pts ← (← (← j.getObjVal? "pts").getArr?).mapM parseHsmmGpsPt
    return Verified.Hsmm.GpsOutliers.dropGpsOutliers pts.toList
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out =>
    Json.mkObj [("pts", Json.arr ((out.map fun p =>
      Json.arr #[Lean.toJson p.ts, fBits p.lat, fBits p.lon, fBits p.speedKmh]).toArray))]

/-! ## Biometric label rewrites (`verified_cli biolabels`)

`Verified.Geo.BiometricLabels` — the four velocity passes that let the step
counter overrule what GPS decided about a segment's mode. One verb for all
four, selected by `pass`, because they share the whole input parse.

  { "pass": "cadence" | "revert" | "jitter" | "walkthrough",
    "segs":  [{ startTs, endTs, mode, refinedMode?, kinds?, avgSpeed, maxSpeed,
                linearity, pointCount, place?, wayName? }, …],
    "steps": [[ts, stepsBits], …],
    "pts":   [[ts, latBits, lonBits], …] }

Floats cross as bit patterns (`avgSpeed`, `linearity`, …), same as everywhere
else, so both arms compare the same doubles rather than 6-decimal renderings.

Output: `{ "decisions": [null | [mode, reason, kind|null], …] }`, one per input
segment — `null` is "unchanged". `walkthrough` additionally returns
`"runs": [[start, end), …]`, the merge plan over the decided sequence.

The per-segment passes (`cadence`, `jitter`) are mapped over `segs` here rather
than called one segment at a time, so a day is one bridge call, not fifty. -/

private def parseStepPt (j : Json) : Except String Verified.Geo.BiometricWindows.StepPoint := do
  let a ← j.getArr?
  match a[0]?, a[1]? with
  | some ts, some st => return ⟨← ts.getInt?, ← jBits st⟩
  | _, _ => throw "step point must be [ts, stepsBits]"

private def parseLabelFix (j : Json) : Except String Verified.Geo.BiometricLabels.Fix := do
  let a ← j.getArr?
  match a[0]?, a[1]?, a[2]? with
  | some ts, some la, some lo => return ⟨← ts.getInt?, ← jBits la, ← jBits lo⟩
  | _, _, _ => throw "label fix must be [ts, latBits, lonBits]"


private def parseLabelSeg (j : Json) : Except String Verified.Geo.BiometricLabels.LabelSeg := do
  let kinds ← match j.getObjVal? "kinds" with
    | .error _ => pure #[]
    | .ok v => if v.isNull then pure #[] else (← v.getArr?).mapM (·.getStr?)
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    refinedMode := ← optStr j "refinedMode"
    refinedKinds := kinds
    avgSpeed := ← jBits (← j.getObjVal? "avgSpeed")
    maxSpeed := ← jBits (← j.getObjVal? "maxSpeed")
    linearity := ← jBits (← j.getObjVal? "linearity")
    pointCount := ← (← j.getObjVal? "pointCount").getInt?
    place := ← optStr j "place"
    wayName := ← optStr j "wayName"
  }

private def decisionJson : Verified.Geo.BiometricLabels.Decision → Json
  | .keep => Json.null
  | .flip mode reason kind =>
    Json.arr #[Json.str mode, Json.str reason,
      match kind with | none => Json.null | some k => Json.str k]

private def bioLabelsResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let pass ← (← j.getObjVal? "pass").getStr?
    let segs ← (← (← j.getObjVal? "segs").getArr?).toList.mapM parseLabelSeg
    let steps ← (← (← j.getObjVal? "steps").getArr?).toList.mapM parseStepPt
    let pts ← match j.getObjVal? "pts" with
      | .error _ => pure []
      | .ok v => (← v.getArr?).toList.mapM parseLabelFix
    let decisions : List Verified.Geo.BiometricLabels.Decision ← match pass with
      | "cadence" => pure (segs.map (Verified.Geo.BiometricLabels.correctModeFromCadence · steps))
      | "revert" => pure (Verified.Geo.BiometricLabels.revertIsolatedCadenceDrives segs)
      | "jitter" => pure (segs.map (Verified.Geo.BiometricLabels.demoteJitterWalkToStationary · steps))
      | "walkthrough" => pure []  -- handled below; it also returns a merge plan
      | other => throw s!"unknown biolabels pass {other}"
    if pass == "walkthrough" then
      let plan := Verified.Geo.BiometricLabels.applyStationaryWalkThrough segs steps pts
      return Json.mkObj [
        ("decisions", Json.arr (plan.decisions.map decisionJson).toArray),
        ("runs", Json.arr (plan.runs.map fun (s, e) =>
          Json.arr #[Lean.toJson s, Lean.toJson e]).toArray)]
    return Json.mkObj [("decisions", Json.arr (decisions.map decisionJson).toArray)]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## The pipeline head (`verified_cli head`)

The two TS algorithm steps still standing between the raw fixes and `segsRaw`,
which is the day fold's ONLY input:

    raw fixes → gpsquality (Lean) → snapToPlace (HERE) → kalman (Lean)
              → classifySegments (HERE) → segsRaw → day

Both have been complete and `#guard`-pinned under `Verified` for some time with
NOTHING CALLING THEM — `scripts/lean-reachability.mjs` found the pair among 31
such orphans. This verb is what makes them reachable, and it is the thing
`LEAN_DAY=solo` was blocked on: with the head in TS, the fold's own inputs are
computed by the arm the mode is meant to retire, so there is no TS to remove.

    { "op": "snap",
      "fixes":  [[latBits, lonBits, accBits|null], …],
      "places": [[latBits, lonBits, radiusBits|null, id|null], …] }
  → { "snapped": [[latBits, lonBits, accBits|null, moved], …] }  one per fix, in order

    { "op": "segments",
      "pts":     [[ts, latBits, lonBits, speedBits, bearingBits], …],
      "stayPts": [[ts, latBits, lonBits], …] | null }
  → { "segs": [ {startTs, endTs, mode, …}, … ] }

⚠ `snap` is BATCHED over the whole day, deliberately. The TS calls `snapToPlace`
once per fix inside a `.map` (`velocity.ts:687`); a round trip per fix would be
thousands of bridge calls for one day, where every other tenant makes one. The
response is positional — one row per input fix, same order — so the caller can
zip it back onto its own points without matching on coordinates.

`snapped` is returned as a flag rather than inferred from whether the coordinates
moved: a fix already AT a centroid snaps without moving, and reading "moved" off
the geometry would silently call that a non-snap. -/

private def parseHeadFix (j : Json) : Except String (Float × Float × Option Float) := do
  let a ← j.getArr?
  let la ← jBits (← nth a 0)
  let lo ← jBits (← nth a 1)
  let acc ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return (la, lo, acc)

private def parseHeadPlace (j : Json) : Except String Verified.Geo.PlacePrior.KnownPlace := do
  let a ← j.getArr?
  let la ← jBits (← nth a 0)
  let lo ← jBits (← nth a 1)
  let r ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let id ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return { centroidLat := la, centroidLon := lo, radiusM := r, id := id }

/-- ⚠ `Verified.Geo.Segments.FilteredPoint`, NOT `Verified.Geo.Kalman`'s. The two
are the same shape under different field names (`speed_kmh` vs `speedKmh`) and
`classifySegments` takes this one, so `parseKalmanPt` cannot be reused here. -/
private def parseHeadPt (j : Json) : Except String Verified.Geo.Segments.FilteredPoint := do
  let a ← j.getArr?
  return {
    ts := ← (← nth a 0).getInt?
    lat := ← jBits (← nth a 1)
    lon := ← jBits (← nth a 2)
    speed_kmh := ← jBits (← nth a 3)
    bearing := ← jBits (← nth a 4) }

private def parseHeadStayPt (j : Json) : Except String Verified.Geo.Segments.StayPoint := do
  let a ← j.getArr?
  return { ts := ← (← nth a 0).getInt?, lat := ← jBits (← nth a 1), lon := ← jBits (← nth a 2) }

private def headSegJson (s : Verified.Geo.Segments.TrackSegment) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode),
    ("confidence", fBits s.confidence), ("confidenceMargin", fBits s.confidenceMargin),
    ("avgSpeed", fBits s.avgSpeed), ("maxSpeed", fBits s.maxSpeed),
    ("linearity", fBits s.linearity), ("pointCount", Lean.toJson s.pointCount),
    ("refinedReason", match s.refinedReason with | none => Json.null | some r => Json.str r),
    ("refinedKinds", Json.arr (s.refinedKinds.map Json.str))]

private def headResult (j : Json) : Json :=
  let parsed : Except String Json := do
    match ← (← j.getObjVal? "op").getStr? with
    | "snap" =>
      let fixes ← (← (← j.getObjVal? "fixes").getArr?).mapM parseHeadFix
      let places ← (← (← j.getObjVal? "places").getArr?).mapM parseHeadPlace
      -- `snapToPlace` takes a List; convert ONCE rather than per fix.
      let pl := places.toList
      return Json.mkObj [("snapped", Json.arr (fixes.map fun (la, lo, acc) =>
        let r := Verified.Geo.PlacePrior.snapToPlace la lo acc pl
        Json.arr #[fBits r.lat, fBits r.lon,
          (match r.accuracy with | none => Json.null | some a => fBits a),
          Json.bool r.snapped]))]
    | "segments" =>
      let pts ← (← (← j.getObjVal? "pts").getArr?).mapM parseHeadPt
      -- Absent and null both mean "no separate stay set"; the fold then doubles
      -- the movement fixes up as stay evidence, which is `classifySegments`' own
      -- default and NOT the same as passing an empty array.
      let stay ← match j.getObjVal? "stayPts" with
        | .error _ => pure none
        | .ok v =>
          if v.isNull then pure none
          else do
            let arr ← v.getArr?
            let sp ← arr.mapM parseHeadStayPt
            pure (some sp)
      return Json.mkObj [("segs", Json.arr
        ((Verified.Geo.Segments.classifySegments pts stay).map headSegJson))]
    | other => throw s!"unknown head op {other}"
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## The refinement cascade (`verified_cli day`)

`Verified.Geo.PassFold.runPassesTraced` — all 38 passes of the `velocity.ts`
cascade over one day's segments, in ONE bridge call. The fold is the unit
because the order is the thing being measured: a pass at a time would let the
shell re-impose the sequence, and then the sequence would not be under test.

  { "segsRaw": [ …segment…, ],   -- the segmentation output, and the ONLY input
    "env":  { …observations, day tables, lookup answer tables… },
    "trace": true|false }

ONE input as of #430 B2. It was two for as long as the OSM enrichment stage sat
unported between the splits and the corrections — the corrections had to start
from what the TS arm handed them, because feeding the splits' output straight in
would have skipped a stage silently. `Verified.Geo.EnrichFold` closed that gap,
and the join was taken only after the day gate measured the new `segsEnriched`
boundary identical on all 33 golden days. Every boundary below `segsRaw` is now
Lean consuming Lean, and each is still returned and compared, so a difference is
named where it happens rather than read off the end.

### Why the lookups cross as answer tables

`Env`'s six mirror lookups are FUNCTIONS. They cross as recorded (args →
answer) tables because that is what they cost: measured over the 33-fixture
corpus (`lean/experiments/passfold-env-size.mts`), all six together are 0.154
MiB/day, against 13.7 MiB/day to push the raw rows and compute them here. The
row-set stays golden's oracle for the reason #412 gives; the serve path takes
the answers.

The road and walk solvers stay SHELL CALLBACKS and their geometry never
crosses at all — 4.31 MiB/day of road and building rows saved, twelve times
the whole rest of the payload. Their own parity is `LEAN_MATCH`'s job, not the
fold's: what the fold is measuring is the cascade.

### Keys are bit patterns, not rendered coordinates

A table keyed on a decimal rendering would be keyed on something JS and Lean
disagree about, and a key that disagrees is a MISS — which is the one failure
this must not have. Every float argument keys on `Float.toBits`, so the two
sides agree exactly or not at all.

### A miss is a hard error, and that needs the caller's help

An absent entry must never read as an empty answer: `LineMembership.scan`
takes an empty served-station lookup as "line unknown" and vetoes a journey
that happened (#423), so a short answer asserts a physical impossibility.

`panic!` alone does NOT give that. Measured: it prints a backtrace, returns
`Inhabited.default` and the process continues with exit 0 — the miss becomes
`#[]`. With `LEAN_ABORT_ON_PANIC=1` in the environment it aborts, and the
message names the key. So the spawning shell MUST set that variable; it is
load-bearing, not decoration. -/


/-! ## Focus-place mining (`verified_cli focus`)

`Verified.Geo.FocusPlaces` + `Verified.Geo.FocusIdentity` — the weekly
`refresh-focus-places` cron's pure core, which no day replay reaches, so until
this mode existed both modules were guard-pinned and unattended (#435).

Everything the cron computes off a point history, in the cron's own call order:

  { "points":       [[ts, latBits, lonBits, accBits|null], …],
    "sleepWindows": [[startTs, endTs], …],
    "clusters":     [{ id, lat, lon, dwell, stays: [[…], …] }, …],
    "old":          [[id, latBits, lonBits, firstSeenTs], …] }

`points` drives `detectFocusPlaces`; `clusters` are ALREADY-BUILT clusters that
go straight to `splitCluster` (the captured conflated café/residence and Home,
which no single day's points can reproduce); `old` drives `matchClusters`
against the mined centroids, the re-mining identity map.

Every cluster comes back as a REPORT — its own fields plus every derived value
`refresh-focus-places.ts` reads off it — so one comparison covers the
classification layer as well as the geometry. Floats cross as bit patterns, so
the two arms compare the same doubles.

`pickWinningAmenity` is the one export this mode does NOT reach, and it is not
an oversight: its input is a vote tally over OSM venue NAMES, produced by
`nearbyLandmarks` + `rankVenues` + `isLabelWorthyVenue`. Building one here
would mean this referee carrying another module's oracle, and a fabricated
tally would check nothing. It stays guard-pinned; `lean-coverage.mts` counts
that honestly rather than crediting it to this gate. -/


/-! ## `stationchain` — the C4.3 chained-triple resolver (#672)

The verb that makes `Verified.Hsmm.StationChain` live-compared rather than
merely guard-pinned. Its 22 guards pin it against eleven synthetic V8 outcomes;
what they cannot see is the TS moving underneath (#417), which is what a
comparator over real days is for.

Input:
  { "edges":  [{id, geometry:[{lat,lon}], lineMemberships:[str], underground,
                startNode, endNode}],
    "nodes":  [{id, lat, lon, stationName, edgeIds}]   -- ORDERED, see below
    "obs":    [ObsRow],
    "segs":   [{startTs, endTs, mode, lineName}],
    "relations": [{lineRef, lineName, stops:[{name}]}] | null }
Output: { "resolved": [[segIndex, board|null, alight|null]] }

`nodes` ARRIVES ORDERED and must stay that way across the wire. The shell hands
over `routeGraph.nodes.values()` in JS Map insertion order, and four things
downstream read it — the candidate dedupe, the stable sort, the cut at
`MAX_CANDIDATES_PER_SIDE`, and the first-wins argmax over max-marginals. A
transport that sorted or de-duplicated this array would change results while
looking like a tidy-up.
-/
namespace StationChain

open Verified.Hsmm.StationChain

private def parseChainSeg (j : Json) : Except String ChainSeg := do
  return { mode := ← (← j.getObjVal? "mode").getStr?
           lineName := ← optStr j "lineName"
           startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt? }

/-- `relations` ABSENT and `relations: []` are different requests, and the
    difference is not cosmetic: absent means the mirror was never consulted, so
    every candidate's `servedPen` is 0, while an empty array means it was
    consulted and had nothing — which `servedStationSet` also answers `none` to,
    but only after `railRelationsForLine` runs. Kept distinct here so a shell
    that cannot reach the mirror cannot be mistaken for one that found it bare. -/
def stationChainResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let edges ← (← (← j.getObjVal? "edges").getArr?).mapM parseEdge
    let nodes ← (← (← j.getObjVal? "nodes").getArr?).mapM parseChainNode
    let obs ← (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
    let segs ← (← (← j.getObjVal? "segs").getArr?).mapM parseChainSeg
    let rels ← match j.getObjVal? "relations" with
      | .ok v => if v.isNull then pure none else pure (some (← (← v.getArr?).mapM parseRelation))
      | .error _ => pure none
    let rows := resolveStationChain (mkChainGraph edges nodes) segs obs rels
    return Json.mkObj [("resolved", Json.arr (rows.map (fun r =>
      Json.arr #[Lean.toJson r.1, optStrJson r.2.board, optStrJson r.2.alight])))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end StationChain

/-! ## `osmspatial` — the row-set kernel (#982)

⚠ ORPHANED UNTIL NOW, like `batterySeries` before it and for the same reason:
`Verified.Geo.OsmSpatial` was ported and given reference values against
MariaDB's earth radius, then reachable from no entry point at all (#1003).

A host answering the day fold's converge loop needs exactly these: the fold
names a coordinate it has no answer for, and the host computes one from pushed
rows rather than from a database.

⚠ NO FEATURE-BUCKET FILTER HERE, deliberately. The TypeScript's
`queryLinesFromRows` takes a `featureType` and drops non-matching rows before
scoring; `LineRow` has no such field and should not gain one. The bucket is a
plain equality the caller can do while it is assembling the rows, and putting it
here would give this function two jobs and one of them would be filtering. -/
private def parsePointRow (j : Json) : Except String Verified.Geo.OsmSpatial.PointRow := do
  let a ← j.getArr?
  let tags ← match a[5]? with
    | some v => if v.isNull then pure #[] else do
        let ts ← v.getArr?
        ts.mapM (fun kv => do
          let p ← kv.getArr?
          return ((← (← nth p 0).getStr?), (← (← nth p 1).getStr?)))
    | none => pure #[]
  return { osmId := ← (← nth a 0).getInt?, subtype := ← (← nth a 1).getStr?,
           name := ← (match a[2]? with
             | some v => if v.isNull then pure none else some <$> v.getStr?
             | none => pure none),
           lat := ← jBits (← nth a 3), lon := ← jBits (← nth a 4), tags := tags }

private def parseLineRow (j : Json) : Except String Verified.Geo.OsmSpatial.Lines.LineRow := do
  let a ← j.getArr?
  let coords ← (← (← nth a 3).getArr?).mapM (fun c => do
    let p ← c.getArr?
    return ((← jBits (← nth p 0)), (← jBits (← nth p 1))))
  -- ⚠ Index 4, and OPTIONAL: a caller that predates the field sends four
  -- elements and gets an empty tag map rather than a parse error.
  let tags ← match a[4]? with
    | some v => if v.isNull then pure #[] else do
        let ts ← v.getArr?
        ts.mapM (fun kv => do
          let p ← kv.getArr?
          return ((← (← nth p 0).getStr?), (← (← nth p 1).getStr?)))
    | none => pure #[]
  return { osmId := ← (← nth a 0).getInt?, subtype := ← (← nth a 1).getStr?,
           name := ← (match a[2]? with
             | some v => if v.isNull then pure none else some <$> v.getStr?
             | none => pure none),
           coords := coords, tags := tags }

/-- ⚠ The tag map is EMITTED, not just carried. `nearbyLandmarks` spawns one
landmark per tag key, so a consumer given only `subtype` cannot build it — which
is exactly why that table went unanswered and served days lost venue names
(#1054). -/
private def tagsJson (tags : Array (String × String)) : Json :=
  Json.arr (tags.map (fun (k, v) => Json.arr #[Json.str k, Json.str v]))

private def scoredPointJson (s : Verified.Geo.OsmSpatial.ScoredPoint) : Json :=
  Json.mkObj [("osmId", Lean.toJson s.row.osmId), ("subtype", Json.str s.row.subtype),
    ("name", match s.row.name with | none => Json.null | some n => Json.str n),
    ("distanceM", fBits s.distanceM), ("tags", tagsJson s.row.tags)]

private def scoredLineJson (s : Verified.Geo.OsmSpatial.Lines.ScoredLine) : Json :=
  Json.mkObj [("osmId", Lean.toJson s.row.osmId), ("subtype", Json.str s.row.subtype),
    ("name", match s.row.name with | none => Json.null | some n => Json.str n),
    ("distanceM", fBits s.distanceM), ("encloses", Json.bool s.encloses),
    ("tags", tagsJson s.row.tags)]

private def stationJson (n : Verified.Geo.OsmSpatial.NearbyStation) : Json :=
  Json.mkObj [("name", Json.str n.name), ("subtype", Json.str n.subtype),
    ("distanceM", fBits n.distanceM),
    ("lat", fBits n.lat), ("lon", fBits n.lon)]

private def osmSpatialResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let op ← (← j.getObjVal? "op").getStr?
    let lat ← jBits (← j.getObjVal? "lat")
    let lon ← jBits (← j.getObjVal? "lon")
    let radiusM ← jBits (← j.getObjVal? "radiusM")
    let subtypes ← match j.getObjVal? "subtypes" with
      | .ok v => if v.isNull then pure #[] else do (← v.getArr?).mapM (·.getStr?)
      | .error _ => pure #[]
    match op with
    | "queryPoints" => do
      let rows ← (← optArr j "rows").mapM parsePointRow
      let out := Verified.Geo.OsmSpatial.queryPoints rows lat lon radiusM subtypes
      return Json.mkObj [("rows", Json.arr (out.map scoredPointJson))]
    | "queryLines" => do
      let rows ← (← optArr j "rows").mapM parseLineRow
      let out := Verified.Geo.OsmSpatial.Lines.queryLines rows lat lon radiusM subtypes
      return Json.mkObj [("rows", Json.arr (out.map scoredLineJson))]
    | "nearbyStations" => do
      let rows ← (← optArr j "rows").mapM parsePointRow
      let out := Verified.Geo.OsmSpatial.nearbyStations rows lat lon radiusM
      return Json.mkObj [("rows", Json.arr (out.map stationJson))]
    | "linesAtPoint" => do
      let rows ← (← optArr j "rows").mapM parseLineRow
      let out := Verified.Geo.OsmSpatial.Lines.linesAtPoint rows lat lon radiusM
      return Json.mkObj [("names", Json.arr (out.map Json.str))]
    | other => throw s!"unknown osmspatial op {other}"
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## `battery` — the chart series (#982)

⚠ ORPHANED UNTIL NOW. `Verified.Geo.Velocity.batterySeries` and
`appendBatteryTail` were ported and `#guard`ed against the Node references, then
reachable from no entry point at all — the shape #1003 is open about. The
velocity pipeline computes the chart beside the fold rather than inside it, so a
host porting that pipeline needs them callable, not merely written.

Composed in ONE mode rather than exposed as two, because the pipeline never
wants the raw series: `computeVelocity` writes
`appendBatteryTail(batterySeries(inDay), tail, endUtc)` as a single expression,
and splitting it across two round trips would let a caller ship the untailed
series by forgetting the second. -/
private def batteryResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let pts ← (← optArr j "points").mapM (fun e => do
      let a ← e.getArr?
      let ts ← (← nth a 0).getInt?
      let lvl ← match a[1]? with
        | some v => if v.isNull then pure none else some <$> v.getInt?
        | none => pure none
      pure (ts, lvl))
    let tail ← match j.getObjVal? "tail" with
      | .ok v =>
        if v.isNull then pure none
        else do
          let a ← v.getArr?
          let ts ← (← nth a 0).getInt?
          let lvl ← (← nth a 1).getInt?
          pure (some (ts, lvl))
      | .error _ => pure none
    let dayEndTs ← (← j.getObjVal? "dayEndTs").getInt?
    let series := Verified.Geo.Velocity.appendBatteryTail
      (Verified.Geo.Velocity.batterySeries pts.toList) tail dayEndTs
    return Json.mkObj [("series", Json.arr ((series.map
      (fun (ts, lvl) => Json.arr #[Lean.toJson ts, Lean.toJson lvl])).toArray))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out


/-! ## `watchbattery` — the watch trace for one day (#982)

`Verified.Geo.Velocity.watchBatterySeries`. The `device_battery_log` history,
shaped to sit on the same axis as the phone series.

  { "rows": [[ts|null, level, deviceVersion|null], …],
    "startUtc": int, "endUtc": int }
→ { "series": [[ts, level], …] }

⚠ `ts` is ALREADY RESOLVED, and `null` is a wall clock that did not. The column
is a Fitbit wall clock with no offset, so turning it into an instant needs
tzdata — the host's, not this. A `null` is dropped rather than defaulted: a
reading at a guessed instant would draw a step that never happened.

⚠ ORDER IS LOAD-BEARING. Two rows at the same instant keep the one that came
later in this array, so a caller that reorders the result set changes which level
is drawn. The SQL must not gain an `ORDER BY` that the shaping does not expect. -/
private def watchBatteryResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rows ← (← optArr j "rows").mapM (fun e => do
      let a ← e.getArr?
      let ts ← match a[0]? with
        | some v => if v.isNull then pure none else some <$> v.getInt?
        | none => pure none
      let level ← (← nth a 1).getInt?
      let dev ← match a[2]? with
        | some v => if v.isNull then pure none else some <$> v.getStr?
        | none => pure none
      pure ({ ts, level, deviceVersion := dev } : Verified.Geo.Velocity.WatchRow))
    let startUtc ← (← j.getObjVal? "startUtc").getInt?
    let endUtc ← (← j.getObjVal? "endUtc").getInt?
    let out := Verified.Geo.Velocity.watchBatterySeries rows.toList startUtc endUtc
    return Json.mkObj [("series", Json.arr ((out.map
      (fun (ts, lvl) => Json.arr #[Lean.toJson ts, Lean.toJson lvl])).toArray))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## `osmcoverage` — can the local mirror answer here? (#982)

`Verified.Geo.OsmCoverage.decideCoverage`. The gate a host must pass before
reading `osm_points`/`osm_lines`: `covered` means a spatial query over the
mirror is an ANSWER, anything else means nobody has fetched this area and the
same query returns nothing while looking exactly like an area with no roads.

  { "lat": bits, "lon": bits, "radiusM": bits,
    "coverage": [[minLatBits, maxLatBits, minLonBits, maxLonBits, fetchedAtMs|null], …],
    "nowMs": int,
    "hasLocalData": bool }
→ { "covered": true|false }

⚠ `coverage` is the rows for ONE feature_type. Boxes are per-bucket and mixing
them would report a highway fetch as covering the landmarks.

⚠ `nowMs` crosses the wire rather than being read here. Lean has no clock in a
pure function, and taking one would make the answer depend on when it was asked
— which is exactly what makes the staleness rule untestable. The host owns the
clock; this owns the decision. -/
private def parseCoverageRow (j : Json) : Except String Verified.Geo.OsmCoverage.CoverageRow := do
  let a ← j.getArr?
  let fetchedAt ← match a[4]? with
    | some v => if v.isNull then pure none else some <$> v.getInt?
    | none => pure none
  return { minLat := ← jBits (← nth a 0), maxLat := ← jBits (← nth a 1),
           minLon := ← jBits (← nth a 2), maxLon := ← jBits (← nth a 3),
           fetchedAt := fetchedAt }

private def osmCoverageResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let lat ← jBits (← j.getObjVal? "lat")
    let lon ← jBits (← j.getObjVal? "lon")
    let radiusM ← jBits (← j.getObjVal? "radiusM")
    let rows ← (← optArr j "coverage").mapM parseCoverageRow
    let nowMs ← (← j.getObjVal? "nowMs").getInt?
    let hasLocalData ← optBool j "hasLocalData" false
    return Json.mkObj [("covered", Json.bool
      (Verified.Geo.OsmCoverage.decideCoverage lat lon radiusM rows.toList nowMs hasLocalData))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## `railfill` — which train legs want a background route fill (#982, #363)

`Verified.Geo.RailRouteFill.unsnappedTrainRoutes`. A train leg draws on rails
only when its label has a `rail_route_cache` row, so a key first ridden today
draws raw until the nightly job runs. This names the legs a worker should fill.

  { "segments": [[mode, refinedMode|null, startTs, endTs, wayName|null, hasSnappedPath], …],
    "points":   [[ts, latBits, lonBits], …] }
→ { "candidates": [{ "key", "startTs", "endTs", "fixes": [[latBits, lonBits], …] }, …] }

⚠ `hasSnappedPath` is a BOOLEAN, not the path. The scan only asks whether the
leg is drawn already, and shipping the geometry to answer that would put every
snapped polyline of the day on the wire to be discarded.

⚠ The order out is the order the day was walked, and it is what the queue drains
in. Sorting the reply would be a change to the fill order. -/
private def parseFillSegment (j : Json) : Except String Verified.Geo.RailRouteFill.FillSegment := do
  let a ← j.getArr?
  return { mode := ← (← nth a 0).getStr?,
           refinedMode := ← (match a[1]? with
             | some v => if v.isNull then pure none else some <$> v.getStr?
             | none => pure none),
           startTs := ← (← nth a 2).getInt?,
           endTs := ← (← nth a 3).getInt?,
           wayName := ← (match a[4]? with
             | some v => if v.isNull then pure none else some <$> v.getStr?
             | none => pure none),
           hasSnappedPath := ← (match a[5]? with
             | some v => v.getBool?
             | none => pure false) }

private def parseFillFix (j : Json) : Except String Verified.Geo.RailRouteFill.Fix := do
  let a ← j.getArr?
  return { ts := ← (← nth a 0).getInt?,
           lat := ← jBits (← nth a 1), lon := ← jBits (← nth a 2) }

private def candidateJson (c : Verified.Geo.RailRouteFill.Candidate) : Json :=
  Json.mkObj
    [ ("key", Json.str c.key)
    , ("startTs", Lean.toJson c.startTs)
    , ("endTs", Lean.toJson c.endTs)
    , ("fixes", Json.arr ((c.fixes.map
        (fun (la, lo) => Json.arr #[fBits la, fBits lo])).toArray)) ]

/-! ## `railsnap` mode — the whole corridor snap, not just the shortest path

⚠ THE PRODUCTION TypeScript DOES NOT USE THIS. `src/lean/lean-rail.ts` builds
the rail graph itself and asks Lean only for `dijkstraC` (the `rail` mode
above), so `buildRailGraph`, `nearestVertex` and `snapTrainSegment` have been
ported and guarded (123 guards) while never running on the serving path — the
orphaned-port position of #1003.

This mode exists so `refresh-rail-routes` (#982 Tier 2) can hand over the RAW
ways, stations and fix cloud and get the finished path back, instead of the
Rust arm reimplementing the graph build. Rebuilding it shell-side would put
`edgeWeight`, `bridgeGaps` and the vertex fusion in Rust — the half that
drifts.

`onLine` picks the fallback: `snapTrainSegmentOnLine` routes over ONLY the
named line's ways with no fix cloud, which is what `computeRailRoute` reaches
for when the corridor snap refuses. -/

private def parseSnapPt (j : Json) : Except String Verified.Geo.WalkableRoute.Pt := do
  let a ← j.getArr?
  return { lat := ← jBits (← nth a 0), lon := ← jBits (← nth a 1) }

private def parseRailWay (j : Json) : Except String Verified.Geo.RailSnap.RailWay := do
  let coords ← (← (← j.getObjVal? "coords").getArr?).mapM parseSnapPt
  return { name := (j.getObjVal? "name" >>= (·.getStr?)).toOption
         , subtype := (j.getObjVal? "subtype" >>= (·.getStr?)).toOption
         , coords := coords }

private def parseOsmStation (j : Json) : Except String Verified.Geo.RailSnap.OsmStation := do
  return { name := (j.getObjVal? "name" >>= (·.getStr?)).toOption
         , subtype := (j.getObjVal? "subtype" >>= (·.getStr?)).toOption
         , lat := ← jBits (← j.getObjVal? "latBits")
         , lon := ← jBits (← j.getObjVal? "lonBits") }

private def railSnapResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let segJ ← j.getObjVal? "segment"
    let seg : Verified.Geo.RailSnap.TrainSegment :=
      { startTs := ← jBits (← segJ.getObjVal? "startTsBits")
      , endTs := ← jBits (← segJ.getObjVal? "endTsBits")
      , wayName := ← (← segJ.getObjVal? "wayName").getStr? }
    let lines ← (← optArr j "lines").mapM parseRailWay
    let stations ← (← optArr j "stations").mapM parseOsmStation
    let fixes ← (← optArr j "fixes").mapM parseSnapPt
    let onLine := (j.getObjVal? "onLine" >>= (·.getBool?)).toOption == some true
    -- ⚠ The two entry points are NOT interchangeable. `snapTrainSegment`
    -- refuses below `minCloudFixes` (12) because a thin cloud cannot evidence a
    -- corridor; `snapTrainSegmentOnLine` takes no cloud at all and leans on the
    -- line name instead. Calling the second when the first refused is the
    -- TypeScript's fallback order, and the caller picks it explicitly rather
    -- than this mode guessing.
    let res :=
      if onLine then Verified.Geo.RailSnap.snapTrainSegmentOnLine seg lines stations
      else Verified.Geo.RailSnap.snapTrainSegment seg lines stations fixes
    return match res with
      | none => Json.mkObj [("path", Json.null)]
      | some r =>
        Json.mkObj
          [ ("board", Json.str r.board.name)
          , ("alight", Json.str r.alight.name)
          , ("line", match r.line with | none => Json.null | some l => Json.str l)
          , ("path", Json.arr (r.path.map fun p =>
              Json.arr #[fBits p.lat, fBits p.lon, fBits p.ts])) ]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

private def railFillResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let segs ← (← optArr j "segments").mapM parseFillSegment
    let pts ← (← optArr j "points").mapM parseFillFix
    let out := Verified.Geo.RailRouteFill.unsnappedTrainRoutes segs.toList pts.toList
    return Json.mkObj [("candidates", Json.arr ((out.map candidateJson).toArray))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## `clipinferred` — never assert the future (#982)

`Verified.Geo.DayState.clipInferredFuture`. Inferred states — a dwell-prior
continuation, an empty-day inference — extend to a survival horizon or the day
end, which for TODAY lies ahead of the current moment and would claim presence
at a place hours before it happened.

  { "states": [ <the day mode's own state objects> ], "nowTs": int }
→ { "states": [ … ] }

⚠ PRESENTATION ONLY, and that is why it is a separate mode rather than a step of
`day`. The pipeline stays deterministic — it fills to the horizon — so the golden
corpus, which replays past days where `nowTs` is already past the day end, is
unaffected. A caller applies this PER REQUEST, after the cache, because `now`
advances while a cached result does not.

⚠ Observed states are untouched. Real data cannot be in the future, so a state
without `inferred` is passed through whatever its timestamps say. -/
private def parseDayState (j : Json) : Except String Verified.Geo.DayState.DayState := do
  let optS (k : String) : Except String (Option String) :=
    match j.getObjVal? k with
    | .ok v => if v.isNull then .ok none else do return some (← v.getStr?)
    | .error _ => .ok none
  let optB (k : String) : Except String (Option Bool) :=
    match j.getObjVal? k with
    | .ok v => if v.isNull then .ok none else do return some (← v.getBool?)
    | .error _ => .ok none
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
         , endTs := ← (← j.getObjVal? "endTs").getInt?
         , mode := ← (← j.getObjVal? "mode").getStr?
         , place := ← optS "place", wayName := ← optS "wayName"
         , asleep := ← optB "asleep", tz := ← optS "tz"
         , minutesAsleep := ← jOptInt j "minutesAsleep"
         , inferred := ← optB "inferred" }

private def clipInferredResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let states ← (← optArr j "states").mapM parseDayState
    let nowTs ← (← j.getObjVal? "nowTs").getInt?
    let out := Verified.Geo.DayState.clipInferredFuture states.toList nowTs
    return Json.mkObj [("states", Json.arr ((out.map Day.stateJson).toArray))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## Per-minute rail/road proximity (`proximityqueries` / `proximitytable`)

The two halves of `computeMinuteProximity`, split at the one place it is not
pure: the OSM lookup. The shell asks WHICH locations to query, runs
`nearby_ways` on each, and hands the answers back to be joined.

⚠ THE SPLIT IS TWO MODES AND NOT ONE BECAUSE THE MIDDLE IS I/O — not because
the shell is trusted with any of the decision. Bucketing into minutes, the
median that picks each minute's query point, the ~11 m key that decides how few
queries a day needs, which subtypes count as rail or road, and which minute gets
which answer are all in {@link Verified.Hsmm.RailRoadProximity}. The shell
transports coordinates and OSM rows.

⚠ THE SPEED FIELD IS NOT SENT. `minuteMedians` buckets and takes medians of
lat/lon only, so a `pts` row is `[ts, latBits, lonBits]` and `speedKmh` is
filled with 0. Shipping it would invite a later reader to think it mattered.
-/

/-- `[ts, latBits, lonBits]` → a `GpsPoint` with `speedKmh` 0; see the note. -/
private def parseProxPt (j : Json) : Except String Verified.Hsmm.Observation.GpsPoint := do
  match (← j.getArr?)[0]?, (← j.getArr?)[1]?, (← j.getArr?)[2]? with
  | some ts, some la, some lo =>
    return { ts := ← ts.getInt?, lat := ← jBits la, lon := ← jBits lo, speedKmh := 0 }
  | _, _, _ => throw "proximity point must be [ts, latBits, lonBits]"

private def minuteJson (m : Verified.Hsmm.RailRoadProximity.MinuteFix) : Json :=
  Json.arr #[Lean.toJson m.minuteTs, fBits m.lat, fBits m.lon]

private def parseMinuteFix (j : Json) : Except String Verified.Hsmm.RailRoadProximity.MinuteFix := do
  match (← j.getArr?)[0]?, (← j.getArr?)[1]?, (← j.getArr?)[2]? with
  | some ts, some la, some lo =>
    return { minuteTs := ← ts.getInt?, lat := ← jBits la, lon := ← jBits lo }
  | _, _, _ => throw "minute must be [minuteTs, latBits, lonBits]"

/-- `{ startUtc, endUtc, pts }` → `{ minutes, queries }`.

`minutes` is every local-day minute that had a fix, at its median position;
`queries` is the distinct subset the shell must actually ask OSM about. The
shell keeps `minutes` untouched and sends it back to `proximitytable`. -/
private def proximityQueriesResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let startUtc ← (← j.getObjVal? "startUtc").getInt?
    let endUtc ← (← j.getObjVal? "endUtc").getInt?
    let pts ← (← optArr j "pts").mapM parseProxPt
    let ms := Verified.Hsmm.RailRoadProximity.minuteMedians startUtc endUtc pts.toList
    let qs := Verified.Hsmm.RailRoadProximity.distinctQueryPoints ms
    return Json.mkObj
      [ ("minutes", Json.arr (ms.map minuteJson))
      , ("queries", Json.arr (qs.map (fun q => Json.arr #[fBits q.lat, fBits q.lon]))) ]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-- `{ minutes, answers }` → `{ proximity, unanswered }`.

`proximity` is the sparse `[minuteTs, roadBits|null, railBits|null]` table
`assemblesegments` takes as its `observation.proximity`. The shell passes it
through without reading it.

⚠ `answers` OMITS A QUERY THAT FAILED rather than sending it empty — see
`WayAnswer`. `unanswered` counts the minutes left uncovered, which is the only
number that can tell a failed mirror from an empty neighbourhood (#976).

⚠ THE ROW IS ROAD THEN RAIL. `Proximity` names rail first and the wire does
not; `parseObservationInput` reads `[ts, road, rail]`, and swapping them would
put every fix on a road. -/
private def proximityTableResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let ms ← (← optArr j "minutes").mapM parseMinuteFix
    let answers ← (← optArr j "answers").mapM (fun a => do
      let ways ← (← optArr a "ways").mapM (fun w => do
        let d ← match w.getObjVal? "distanceM" with
          | .ok v => if v.isNull then pure none else some <$> jBits v
          | .error _ => pure none
        pure ({ type := ← (← w.getObjVal? "type").getStr?
              , subtype := ← (← w.getObjVal? "subtype").getStr?
              , distanceM := d } : Verified.Hsmm.RailRoadProximity.NearbyWay))
      pure ({ lat := ← jBits (← a.getObjVal? "lat")
            , lon := ← jBits (← a.getObjVal? "lon")
            , ways := ways.toList } : Verified.Hsmm.RailRoadProximity.WayAnswer))
    let (rows, unanswered) := Verified.Hsmm.RailRoadProximity.proximityTable ms answers
    let optB : Option Float → Json := fun | none => Json.null | some v => fBits v
    return Json.mkObj
      [ ("proximity", Json.arr (rows.map (fun (ts, p) =>
          Json.arr #[Lean.toJson ts, optB p.roadDistM, optB p.railDistM])))
      , ("unanswered", Lean.toJson unanswered) ]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## The decoder's place/line hard constraint (`knownlines` / `placenearline`)

Split the same way the proximity pair is, and for the same reason: the middle is
an OSM query. The shell asks WHICH lines exist, resolves each one's stations, and
hands them back to be measured.

⚠ THE LINE LIST IS LEAN'S. `KNOWN_LINES` is the served state space; a shell with
its own copy would decode against a different set of train states than the model
was built for, and nothing would report a mismatch.
-/

/-- `{}` → `{ value: [line, …] }`. See `Verified.Hsmm.Assemble.KNOWN_LINES`. -/
private def knownLinesResult (_ : Json) : Json :=
  Json.mkObj [("value", Json.arr
    (Verified.Hsmm.Assemble.KNOWN_LINES.map Json.str).toArray)]

/-- `{ places, lines }` → `{ value: ["placeId|lineName", …] }`.

`places` are `[id, latBits, lonBits]`; `lines` are `[name, [[latBits, lonBits], …]]`.

⚠ ABSENT IS NOT NEUTRAL HERE. `parseAssemble` reads `placeNearLine` as optional
and an empty set removes every hard zero rather than adding them — so a shell
that skips this call gets a decoder that permits boardings the TypeScript
forbids, silently. See the module note. -/
private def parseNearPlace (e : Json) : Except String Verified.Hsmm.PlaceNearLine.Place := do
  let a ← e.getArr?
  match a[0]?, a[1]?, a[2]? with
  | some id, some la, some lo =>
    return { id := ← id.getInt?, lat := ← jBits la, lon := ← jBits lo }
  | _, _, _ => throw "place must be [id, latBits, lonBits]"

private def parseStation (e : Json) : Except String Verified.Hsmm.PlaceNearLine.Station := do
  let a ← e.getArr?
  match a[0]?, a[1]? with
  | some la, some lo => return { lat := ← jBits la, lon := ← jBits lo }
  | _, _ => throw "station must be [latBits, lonBits]"

private def parseLineStations (e : Json)
    : Except String (String × Array Verified.Hsmm.PlaceNearLine.Station) := do
  let a ← e.getArr?
  match a[0]?, a[1]? with
  | some nm, some sts => return ((← nm.getStr?), ← (← sts.getArr?).mapM parseStation)
  | _, _ => throw "line must be [name, stations]"

private def placeNearLineResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let places ← (← optArr j "places").mapM parseNearPlace
    let lines ← (← optArr j "lines").mapM parseLineStations
    return Json.mkObj [("value", Json.arr
      ((Verified.Hsmm.PlaceNearLine.buildPlaceNearLine places lines).map Json.str))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## Walk-gate mode (`verified_cli walkgate`) — a REFEREE, not a serving path

`Verified.Eval.WalkMetrics` and `Verified.Eval.WalkGate` over a corpus in one
call: measure every drawn walk, compare each against its blessed floor, and
return BOTH the current metrics (ready to re-bless) and the verdict. This is
#1048's Group B — the oracle is `tests/golden/walk-baseline.json`, a FILE, so
replacing the code under it loses nothing, unlike the parity gates whose oracle
was the TypeScript itself.

⚠ It sits in the mode table beside `coverage` and `gpsoutliers`, which nothing
serves either. A separate entry point was the alternative, and #982 exists
precisely because handlers that lived beside `main` could not be linked at all.

⚠ COORDINATES CROSS AS PLAIN JSON NUMBERS, NOT ON THE 1e-7 GRID `match` uses.
That mode quantises because its matcher is integer-exact by design. The referee
is not, and the floor was blessed from raw doubles, so quantising here would
move every metric away from the very file it is compared against. It is safe
for the reason `parsesTo` measures above: both ends write the shortest decimal
that round-trips.

⚠ METRICS COME BACK AS BIT PATTERNS. `Lean.toJson` on a `Float` emits six
decimal places, and this port has to demonstrate agreement with a baseline
recorded to seventeen significant digits — six would hide exactly the
divergence the harness exists to find.

    { "mode": "walkgate",
      "baseline": [ { "date": "2026-05-15", "walks": [ <entry>, … ] }, … ],
      "days":     [ { "date": "2026-05-15",
                      "ways":      [ { "name": "…"|null, "coords": [[lat,lon], …] }, … ],
                      "buildings": [ [[lat,lon], …], … ],
                      "steps":     [ [ts, steps], … ],
                      "walks":     [ { "startTs": n, "endTs": n,
                                       "drawn": [[lat,lon], …],
                                       "raw":   [[lat,lon], …],
                                       "acceptedNames": ["…", …] }, … ] }, … ] }

    <entry> = { "startTs": n, "p90M": bits|null, "stallM": bits,
                "speedKmh": bits, "routeCorr": bits|null, "offPathM": bits|null,
                "lenM": bits, "budgetM": bits|null }

Output: `{ "current": [ … ], "passes": bool, "regressed": […], "improved": […],
"unmatched": […], "added": […], "unmeasured": […] }` — `current` in the request
order, everything else in the gate's own sorted-by-date order. -/

namespace WalkGate

open Verified.Eval.WalkMetrics
open Verified.Eval.WalkGate

private def parseLL (j : Json) : Except String LatLon := do
  let a ← j.getArr?
  return ⟨← jFloat (← nth a 0), ← jFloat (← nth a 1)⟩

private def parsePts (j : Json) : Except String (Array LatLon) := do
  (← j.getArr?).mapM parseLL

private def parseWay (j : Json) : Except String Way := do
  let coords ← (← optArr j "coords").mapM fun c => do
    let a ← c.getArr?
    return ((← jFloat (← nth a 0)), (← jFloat (← nth a 1)))
  return { name := ← optStr j "name", coords }

private def parseStep (j : Json) : Except String PedStep := do
  let a ← j.getArr?
  return ⟨← jFloat (← nth a 0), ← jFloat (← nth a 1)⟩

/-- One drawn walk and the two tracks it is judged against. `raw` is the
pipeline's cleaned GPS for the leg — a fold INPUT, which is why the harness can
supply it and a frozen fixture cannot. -/
private structure WalkIn where
  startTs : Int
  endTs : Int
  drawn : Array LatLon
  raw : Array LatLon
  acceptedNames : Array String

private def parseWalkIn (j : Json) : Except String WalkIn := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    drawn := ← (← optArr j "drawn").mapM parseLL
    raw := ← (← optArr j "raw").mapM parseLL
    acceptedNames := ← (← optArr j "acceptedNames").mapM (·.getStr?) }

private structure DayIn where
  date : String
  ways : RoadGeometry
  buildings : Array Ring
  steps : Array PedStep
  walks : Array WalkIn

/-- Resolve a day's geometry: either INLINE arrays, or indices into the
request-level tables.

⚠ The tables exist because 91% of this request was duplication — measured
2026-09-03 over the 42-day corpus: 713,183 way items but 59,606 distinct, so
each way crossed the wire ~12 times, and the request was 145 MiB (a 3.9 GB
`serde_json::Value` on the caller's side and ~2.9 GB of `Json` here). Indices
change nothing the referee computes; they change what has to be held in
memory at once, which is what made a gate run and a parallel build starve
each other.

⚠ INLINE STILL WORKS, and is not deprecated: a caller grading one day has
nothing to dedupe. An index that points past the end is an ERROR, never a
silently-dropped way — a short ways list would quietly move every metric on
that day. -/
private def resolveIdx {α : Type} (what : String) (table : Array α) (j : Json)
    (inlineKey idxKey : String) (parseOne : Json → Except String α)
    : Except String (Array α) := do
  match j.getObjVal? idxKey with
  | .error _ => (← optArr j inlineKey).mapM parseOne
  | .ok idxJson =>
    (← idxJson.getArr?).mapM fun e => do
      let i ← e.getNat?
      match table[i]? with
      | some v => pure v
      | none => throw s!"walkgate: {what} index {i} is outside the table of {table.size}"

private def parseDayIn (wayTable : Array Way) (buildingTable : Array Ring)
    (j : Json) : Except String DayIn := do
  return {
    date := ← (← j.getObjVal? "date").getStr?
    ways := { ways := ← resolveIdx "way" wayTable j "ways" "wayIdx" parseWay }
    buildings := ← resolveIdx "building" buildingTable j "buildings" "buildingIdx" parsePts
    steps := ← (← optArr j "steps").mapM parseStep
    walks := ← (← optArr j "walks").mapM parseWalkIn }

private def oBits : Option Float → Json
  | some v => fBits v
  | none => Json.null

/-- A floor entry.

⚠ THE WIRE IS ASYMMETRIC ON PURPOSE, and this is the readable half.
`jFloatField`/`jOptFloat` accept EITHER a bit pattern or a plain JSON number,
because two different producers feed this side: `walk-baseline.json` holds
plain decimals a human blessed, and the fold's own episodes arrive as bits.
Both have to work without the host converting either one.

The WRITTEN half is bits only — see `entryJson`. `Lean.toJson` on a `Float`
emits six decimal places, which is coarser than the agreement this port exists
to demonstrate.

An ABSENT column reads as `none`, which is right: a floor that never recorded
an axis has not measured it. -/
private def parseEntry (j : Json) : Except String WalkEntry := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    p90M := ← jOptFloat j "p90M"
    stallM := ← jFloatField j "stallM"
    speedKmh := ← jFloatField j "speedKmh"
    routeCorr := ← jOptFloat j "routeCorr"
    offPathM := ← jOptFloat j "offPathM"
    lenM := ← jFloatField j "lenM"
    budgetM := ← jOptFloat j "budgetM" }

private def parseBaselineDay (j : Json) : Except String (String × Array WalkEntry) := do
  return ((← (← j.getObjVal? "date").getStr?), ← (← optArr j "walks").mapM parseEntry)

/-- Measure one drawn walk into exactly the shape the floor records.

⚠ EVERY `none` HERE IS A DIFFERENT QUESTION GOING UNANSWERED, and not one of
them is a zero: no building footprints in the day → `offPathM` unmeasured; no
ground-truth-confirmed street over the leg → `routeCorr` unmeasured; no step
rows → no budget. The gate treats an unmeasured axis and a perfect score
completely differently, so collapsing any of these would be a silent pass.

⚠ `scoreWalk` is given NO steps on purpose. Its own pedometer term uses a
different stride and a different window from the budget the gate acts on; the
budget comes from `stepBudgetM` below, separately. Handing steps to both would
put two incompatible pedometer readings in one row. -/
private def measure (d : DayIn) (wantP90 : Bool) (w : WalkIn) : WalkEntry :=
  let sc := scoreWalk w.drawn (Float.ofInt w.startTs) (Float.ofInt w.endTs) #[] (some d.ways)
              0.72 35 wantP90
  let span := (Float.ofInt w.endTs) - (Float.ofInt w.startTs)
  { startTs := w.startTs
    p90M := sc.offWalkableP90M
    stallM := maxCorridorStall w.raw w.drawn
    speedKmh := if span > 0 then (sc.drawnLengthM / span) * 3.6 else 0
    routeCorr := onNamedWayFraction w.drawn w.acceptedNames d.ways
    offPathM := if d.buildings.isEmpty then none
                else some (offPathBuildingCrossingM w.drawn d.buildings d.ways)
    lenM := sc.drawnLengthM
    budgetM := stepBudgetM d.steps (Float.ofInt w.startTs) (Float.ofInt w.endTs) }

private def entryJson (e : WalkEntry) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson e.startTs), ("p90M", oBits e.p90M),
    ("stallM", fBits e.stallM), ("speedKmh", fBits e.speedKmh),
    ("routeCorr", oBits e.routeCorr), ("offPathM", oBits e.offPathM),
    ("lenM", fBits e.lenM), ("budgetM", oBits e.budgetM)]

private def metricName : Metric → String
  | .stall => "stall" | .speed => "speed" | .route => "route"
  | .offPath => "offPath" | .budget => "budget"

private def deltaJson (d : Delta) : Json :=
  Json.mkObj [("date", Json.str d.date), ("startTs", Lean.toJson d.startTs),
    ("metric", Json.str (metricName d.metric)),
    ("base", fBits d.base), ("now", fBits d.now)]

private def atJson (a : At) : Json :=
  Json.mkObj [("date", Json.str a.date), ("startTs", Lean.toJson a.startTs)]

private def metricAtJson (m : MetricAt) : Json :=
  Json.mkObj [("date", Json.str m.date), ("startTs", Lean.toJson m.startTs),
    ("metric", Json.str (metricName m.metric))]

private def parseReq (j : Json)
    : Except String (WalkBaseline × Array DayIn) := do
  let wayTable ← (← optArr j "wayTable").mapM parseWay
  let buildingTable ← (← optArr j "buildingTable").mapM parsePts
  return (← (← optArr j "baseline").mapM parseBaselineDay,
          ← (← optArr j "days").mapM (parseDayIn wayTable buildingTable))

def walkGateResult (j : Json) : Json :=
  -- ⚠ OFF BY DEFAULT, and that is the point. `p90M` is 83% of this mode's cost
  -- and the ratchet does not act on it — `Metric` has no `p90` case. A caller
  -- that is GATING does not need it; one that is REFRESHING THE FLOOR does, and
  -- asks. An absent `p90M` is therefore "not asked this run", not a lost
  -- measurement, and nothing downstream reads it as one.
  let wantP90 := (j.getObjVal? "wantP90" >>= (·.getBool?)).toOption.getD false
  match parseReq j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (baseline, days) =>
    let current : WalkBaseline := days.map fun d => (d.date, d.walks.map (measure d wantP90))
    let r := gateWalks baseline current
    Json.mkObj [
      ("current", Json.arr (current.map fun (date, ws) =>
        Json.mkObj [("date", Json.str date), ("walks", Json.arr (ws.map entryJson))])),
      ("passes", Json.bool (passes r)),
      ("regressed", Json.arr (r.regressed.map deltaJson)),
      ("improved", Json.arr (r.improved.map deltaJson)),
      ("unmatched", Json.arr (r.unmatched.map atJson)),
      ("added", Json.arr (r.added.map atJson)),
      ("unmeasured", Json.arr (r.unmeasured.map metricAtJson))]

end WalkGate

/-! ## Ground-truth mode (`verified_cli groundtruth`) — a REFEREE input

`Verified.Eval.GroundTruth.parseGroundTruth` over one narrative. #1290: the
audit tables are the only non-self-referential truth signal in the corpus, and
two consumers were blocked without them — `routeCorr` in the walk referee, and
`score-decoder`, whose oracle IS the narrative.

⚠ THE REPLY CARRIES CIVIL TIME, NOT UNIX. Resolving a wall clock in a named zone
needs the tz database, which is data and IO; the Lean side stops at the anchored
`(day, hh, mm)` and the shell resolves it with
`rust/backend/src/timezone.rs::wall_clock_to_unix`. That split is the whole
reason this mode exists rather than a `parseGroundTruth` that returns seconds.

  { "mode": "groundtruth", "markdown": "…", "date": "YYYY-MM-DD", "tz": "…" }

Output: `{ "tz": …, "rows": [ { "window", "startDay", "startHh", "startMm",
"endDay", "endHh", "endMm", "status", "provenance", "enforceable", "truthText",
"truth": {…}|null } ] }`. -/

namespace GroundTruth

open Verified.Eval.GroundTruth

private def statusStr : Status → String
  | .correct => "correct" | .wrong => "wrong"
  | .«partial» => "partial" | .unclear => "unclear"

private def provStr : Provenance → String
  | .corroborated => "corroborated" | .user => "user" | .derived => "derived"
  | .inferred => "inferred" | .unspecified => "unspecified"

private def modeStr : Mode → String
  | .sleeping => "sleeping" | .stationary => "stationary" | .walking => "walking"
  | .cycling => "cycling" | .driving => "driving" | .bus => "bus"
  | .train => "train" | .plane => "plane"

private def truthJson : Option Truth → Json
  | none => Json.null
  | some t => Json.mkObj [
      ("mode", Json.str (modeStr t.mode)),
      ("place", optStrJson t.place), ("wayName", optStrJson t.wayName),
      ("placeQualifier", optStrJson t.placeQualifier),
      ("from", optStrJson t.trainFrom), ("to", optStrJson t.trainTo),
      ("lineName", optStrJson t.lineName)]

private def rowJson (r : Row) : Json :=
  Json.mkObj [
    ("window", Json.str r.windowText),
    ("startDay", Json.str r.startDay), ("startHh", Lean.toJson r.startHh),
    ("startMm", Lean.toJson r.startMm),
    ("endDay", Json.str r.endDay), ("endHh", Lean.toJson r.endHh),
    ("endMm", Lean.toJson r.endMm),
    ("status", Json.str (statusStr r.status)),
    ("provenance", Json.str (provStr r.provenance)),
    ("enforceable", Json.bool (isEnforceable r)),
    ("truthText", Json.str r.truthText),
    ("truth", truthJson r.truth)]

def groundTruthResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let md ← (← j.getObjVal? "markdown").getStr?
    let date ← (← j.getObjVal? "date").getStr?
    let tz ← (← j.getObjVal? "tz").getStr?
    let day := parseGroundTruth md date tz
    return Json.mkObj [("tz", Json.str day.tz),
                       ("rows", Json.arr (day.rows.map rowJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end GroundTruth

/-! ## Journeys mode (`verified_cli journeys`)

`Verified.Eval.Journeys.groundTruthJourneys` over RESOLVED audit rows — the
ground-truth side of the `score-decoder` scoreboard (#1048). Rows arrive with
unix `startTs`/`endTs` because the zone resolution is the shell's (see the
`groundtruth` mode above).

  { "mode": "journeys",
    "rows": [ { "startTs": n, "endTs": n, "status": "correct|wrong|partial|unclear",
                "truth": { "mode": "...", "lineName": s|null,
                           "from": s|null, "to": s|null } | null } ] }

Output: `{ "journeys": [ { "startTs", "endTs",
  "legs": [ { "startTs", "endTs", "mode", "line", "board", "alight" } ] } ] }`. -/

namespace Journeys

open Verified.Eval.GroundTruth
open Verified.Eval.Journeys

private def parseStatus : String → Status
  | "correct" => .correct | "wrong" => .wrong
  | "partial" => .«partial» | _ => .unclear

private def parseMode : String → Option Mode
  | "sleeping" => some .sleeping | "stationary" => some .stationary
  | "walking" => some .walking | "cycling" => some .cycling
  | "driving" => some .driving | "bus" => some .bus
  | "train" => some .train | "plane" => some .plane
  | _ => none

def parseJRow (j : Json) : Except String JRow := do
  let truth : Option Truth :=
    match j.getObjVal? "truth" with
    | .ok t =>
      if t.isNull then none
      else match (t.getObjVal? "mode" >>= (·.getStr?)) with
        | .ok ms => (parseMode ms).map fun m =>
            { mode := m,
              lineName := (t.getObjVal? "lineName" >>= (·.getStr?)).toOption,
              trainFrom := (t.getObjVal? "from" >>= (·.getStr?)).toOption,
              trainTo := (t.getObjVal? "to" >>= (·.getStr?)).toOption }
        | .error _ => none
    | .error _ => none
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    status := parseStatus ((j.getObjVal? "status" >>= (·.getStr?)).toOption.getD "unclear")
    truth }

private def legJson (l : Leg) : Json :=
  Json.mkObj [("startTs", Lean.toJson l.startTs), ("endTs", Lean.toJson l.endTs),
    ("mode", Json.str l.mode), ("line", optStrJson l.line),
    ("board", optStrJson l.board), ("alight", optStrJson l.alight)]

def journeysResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rows ← (← optArr j "rows").mapM parseJRow
    return Json.mkObj [("journeys", Json.arr ((groundTruthJourneys rows).map fun jr =>
      Json.mkObj [("startTs", Lean.toJson jr.startTs), ("endTs", Lean.toJson jr.endTs),
                  ("legs", Json.arr (jr.legs.map legJson))]))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Journeys

/-! ## Decoder-scoreboard mode (`verified_cli decoderscore`) — #1048

Input: the `journeys`-mode rows EXTENDED with `provenance`, plus the decoded
day's segments:

  { "mode": "decoderscore",
    "rows": [ { "startTs", "endTs", "status", "provenance",
                "truth": { "mode", "lineName", "from", "to" } | null } ],
    "segs": [ { "startTs", "endTs", "mode", "lineName", "board", "alight" } ] }

Output: the ten scoreboard counts, spelled as the blessed
`decoder-scoreboard.json` spells them. -/

namespace DecoderScore

open Verified.Eval.GroundTruth
open Verified.Eval.Journeys
open Verified.Eval.DecoderScore

private def parseProvenance : String → Provenance
  | "corroborated" => .corroborated | "user" => .user
  | "derived" => .derived | "inferred" => .inferred
  | _ => .unspecified

private def parseSeg (j : Json) : Except String Verified.Eval.DecoderScore.Seg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    lineName := (j.getObjVal? "lineName" >>= (·.getStr?)).toOption
    board := (j.getObjVal? "board" >>= (·.getStr?)).toOption
    alight := (j.getObjVal? "alight" >>= (·.getStr?)).toOption }

def decoderScoreResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rowsJ ← optArr j "rows"
    let rows ← rowsJ.mapM Journeys.parseJRow
    let segs ← (← optArr j "segs").mapM parseSeg
    -- The contradicting spans need provenance, which JRow does not carry:
    -- re-read it beside each row.
    let mut contradicting : Array ContradictingSpan := #[]
    for (rj, row) in rowsJ.zip rows do
      let prov := parseProvenance ((rj.getObjVal? "provenance" >>= (·.getStr?)).toOption.getD "unspecified")
      match row.truth with
      | some t =>
        if contradicts row.status prov t.mode then
          contradicting := contradicting.push ⟨row.startTs, row.endTs⟩
      | none => pure ()
    let minutes := segmentsToMinutes segs
    let gtJ := groundTruthJourneys rows
    let decJ := decoderJourneys minutes
    let jc := scoreJourneyCounts gtJ decJ minutes
    let st := scoreStations gtJ decJ
    let phantoms := countPhantomRides contradicting decJ
    return Json.mkObj [
      ("journeysExpected", Lean.toJson jc.journeysExpected),
      ("journeysMatched", Lean.toJson jc.journeysMatched),
      ("legModeScorable", Lean.toJson jc.legModeScorable),
      ("legModeMatching", Lean.toJson jc.legModeMatching),
      ("legLineScorable", Lean.toJson jc.legLineScorable),
      ("legLineMatching", Lean.toJson jc.legLineMatching),
      ("stationsAsserted", Lean.toJson st.stationsAsserted),
      ("stationsMatching", Lean.toJson st.stationsMatching),
      ("stationsMissing", Lean.toJson st.stationsMissing),
      ("phantomRides", Lean.toJson phantoms)]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end DecoderScore

/-! ## Truth-check mode (`verified_cli truthcheck`)

`Verified.Eval.TruthCheck.classifyDay` — the provenance-aware truth report
(#1052). Rows arrive RESOLVED (unix seconds), as in `journeys` above, because
the zone resolution is the shell's; `states` are the drawn timeline legs.

This is the corpus's only NON-SELF-REFERENTIAL gate: every other check compares
the pipeline against itself or against previously blessed pipeline output. Here
a human wrote down what actually happened and the pipeline is graded against it.

  { "mode": "truthcheck",
    "rows": [ { "startTs": n, "endTs": n, "status": "correct|wrong|partial|unclear",
                "provenance": "corroborated|user|derived|inferred|unspecified",
                "truth": { "mode", "place", "wayName", "placeQualifier",
                           "from", "to", "lineName" } | null } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s,
                  "place": s|null, "wayName": s|null } ] }

Output: `{ "verdicts": [s], "verified": n, "regressed": n, "knownError": n,
"cleared": n, "unverified": n, "hasRegression": b, "covering": [n] }`.
`covering` is the index of the state that answered each row, or `-1` — the
diagnosis a regressed row cannot give on its own. The `verdicts` array is
positional — one entry per input row, in order — so the caller can attribute a
regression to the row that caused it without a second lookup. -/

namespace TruthCheck

open Verified.Eval.GroundTruth
open Verified.Eval.TruthCheck

private def parseStatus : String -> Status
  | "correct" => .correct | "wrong" => .wrong
  | "partial" => .«partial» | _ => .unclear

private def parseProv : String -> Provenance
  | "corroborated" => .corroborated | "user" => .user | "derived" => .derived
  | "inferred" => .inferred | _ => .unspecified

private def parseMode : String -> Option Mode
  | "sleeping" => some .sleeping | "stationary" => some .stationary
  | "walking" => some .walking | "cycling" => some .cycling
  | "driving" => some .driving | "bus" => some .bus
  | "train" => some .train | "plane" => some .plane
  | _ => none

private def optStr (j : Json) (k : String) : Option String :=
  (j.getObjVal? k >>= (·.getStr?)).toOption

private def parseTruth (j : Json) : Option Truth :=
  match j.getObjVal? "truth" with
  | .error _ => none
  | .ok t =>
    if t.isNull then none
    else match (t.getObjVal? "mode" >>= (·.getStr?)) with
      | .error _ => none
      | .ok ms => (parseMode ms).map fun m =>
          { mode := m, place := optStr t "place", wayName := optStr t "wayName",
            placeQualifier := optStr t "placeQualifier",
            trainFrom := optStr t "from", trainTo := optStr t "to",
            lineName := optStr t "lineName" }

private def parseTRow (j : Json) : Except String TRow := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    status := parseStatus ((optStr j "status").getD "unclear")
    provenance := parseProv ((optStr j "provenance").getD "unspecified")
    truth := parseTruth j }

private def parseState (j : Json) : Except String StateWindow := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    place := optStr j "place"
    wayName := optStr j "wayName" }

def truthCheckResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rows ← (← optArr j "rows").mapM parseTRow
    let states ← (← optArr j "states").mapM parseState
    let r := classifyDay rows states
    return Json.mkObj [
      ("verdicts", Json.arr (r.verdicts.map (Json.str ·.toString))),
      ("verified", Lean.toJson r.verified), ("regressed", Lean.toJson r.regressed),
      ("knownError", Lean.toJson r.knownError), ("cleared", Lean.toJson r.cleared),
      ("unverified", Lean.toJson r.unverified),
      ("hasRegression", Json.bool r.hasRegression),
      ("covering", Json.arr (r.covering.map Lean.toJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end TruthCheck

/-! ## Floor-gate mode (`verified_cli floorgate`)

`Verified.Eval.FloorGate` — the one-way ratchet shared by the truth floor and
the journey floor (#1052).

⚠ THE FLOORS ARRIVE AS ARRAYS, NOT OBJECTS. A JSON object keyed by date is what
the baseline FILES hold, but the wire here takes `[{ "date", "keys" }]` like
every other mode, so the shell owns the map/array conversion and this side never
depends on key order.

`described` is OPTIONAL. Given, the reply also carries the ratcheted `floor` and
the `dropped` keys the narrative no longer describes; omitted, only the gate
runs. Dropping a key is the one way a red gate goes green without a fix, so it
is never computed silently as a side effect of gating.

  { "mode": "floorgate",
    "baseline": [ { "date": s, "keys": [n] } ],
    "current":  [ { "date": s, "keys": [n] } ],
    "described":[ { "date": s, "keys": [n] } ]   // optional
  }

Output: `{ "regressed": [{ "date", "startTs" }], "improved": [...],
"floor": [{ "date", "keys" }] | null, "dropped": [...] | null }`. -/

namespace FloorGate

open Verified.Eval.FloorGate

private def parseFloor (j : Json) (key : String) : Except String Floor := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => v.getArr?
  arr.mapM fun e => do
    let date ← (← e.getObjVal? "date").getStr?
    let keys ← (← (← e.getObjVal? "keys").getArr?).mapM (·.getInt?)
    return (date, keys)

private def keyJson (k : Key) : Json :=
  Json.mkObj [("date", Json.str k.date), ("startTs", Lean.toJson k.startTs)]

private def floorJson (f : Floor) : Json :=
  Json.arr (f.map fun (d, ks) =>
    Json.mkObj [("date", Json.str d), ("keys", Json.arr (ks.map Lean.toJson))])

def floorGateResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let baseline ← parseFloor j "baseline"
    let current ← parseFloor j "current"
    let g := gateFloor baseline current
    let base := [("regressed", Json.arr (g.regressed.map keyJson)),
                 ("improved", Json.arr (g.improved.map keyJson))]
    match j.getObjVal? "described" with
    | .error _ => return Json.mkObj (base ++ [("floor", Json.null), ("dropped", Json.null)])
    | .ok _ =>
      let described ← parseFloor j "described"
      let r := ratchetUpFloor baseline current described
      return Json.mkObj (base ++ [("floor", floorJson r.floor),
                                  ("dropped", Json.arr (r.dropped.map keyJson))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end FloorGate

/-! ## Journey-shape mode (`verified_cli journeyshape`)

`Verified.Eval.JourneyShape` — the journey referee (#1048). Builds the PIPELINE
side of the comparison from the drawn state legs and grades each ground-truth
journey against it.

⚠ THE STATES ARRIVE RAW, and the journey building happens HERE. Handing over
pre-built pipeline journeys would put `statesToJourneys` — the merge tolerance,
the pause split, which modes count as legs — on the shell's side of the line,
where it is not checked by anything. The shell passes what the fold produced.

`gt` is what the `journeys` mode returned, fed straight back.

  { "mode": "journeyshape",
    "gt": [ { "startTs": n, "endTs": n,
              "legs": [ { "startTs": n, "endTs": n, "mode": s } ] } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s } ] }

Output: `{ "pipelineJourneys": [ { "startTs", "endTs", "legs": [s] } ],
"results": [ { "startTs", "endTs", "expectedShape", "actualShape", "matched",
"uncoveredS", "slackS", "matchStartTs", "matchEndTs",
"clippedLegs": [ { "mode", "overlapS", "durationS" } ] } ] }`.

`pipelineJourneys` comes back because a coverage failure cannot be read without
it: `bestOverlap` grades ONE journey, so a trip the pipeline split in two is
scored on the larger half with the other half counted as uncovered — a failure
that exists only in the comparison. More than one touching the window is the
tell, and the caller can only see that if it is told. -/

namespace JourneyShape

open Verified.Eval.Journeys
open Verified.Eval.JourneyShape

private def parseLeg (j : Json) : Except String Leg := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           mode := ← (← j.getObjVal? "mode").getStr?
           line := none, board := none, alight := none }

private def parseJourney (j : Json) : Except String Journey := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           legs := ← (← optArr j "legs").mapM parseLeg }

private def parseState (j : Json) : Except String (Int × Int × String) := do
  return (← (← j.getObjVal? "startTs").getInt?,
          ← (← j.getObjVal? "endTs").getInt?,
          ← (← j.getObjVal? "mode").getStr?)

private def shapeJson (a : Array String) : Json := Json.arr (a.map Json.str)

private def optIntJson : Option Int → Json
  | none => Json.null
  | some i => Lean.toJson i

private def resultJson (r : Result) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson r.startTs), ("endTs", Lean.toJson r.endTs),
    ("expectedShape", shapeJson r.expectedShape),
    ("actualShape", match r.actualShape with | none => Json.null | some a => shapeJson a),
    ("matched", Json.bool r.matched),
    ("uncoveredS", Lean.toJson r.uncoveredS), ("slackS", Lean.toJson r.slackS),
    ("matchStartTs", optIntJson r.matchStartTs), ("matchEndTs", optIntJson r.matchEndTs),
    ("clippedLegs", Json.arr (r.clippedLegs.map fun l =>
      Json.mkObj [("mode", Json.str l.mode), ("overlapS", Lean.toJson l.overlapS),
                  ("durationS", Lean.toJson l.durationS)]))]

def journeyShapeResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let gt ← (← optArr j "gt").mapM parseJourney
    let states ← (← optArr j "states").mapM parseState
    let pipeline := statesToJourneys states
    return Json.mkObj [
      ("pipelineJourneys", Json.arr (pipeline.map fun p =>
        Json.mkObj [("startTs", Lean.toJson p.startTs), ("endTs", Lean.toJson p.endTs),
                    ("legs", Json.arr (p.legs.map (Json.str ·.mode)))])),
      ("results", Json.arr ((journeyShapeResults gt pipeline).map resultJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end JourneyShape

/-! ## Feasibility mode (`verified_cli feasibility`)

`Verified.Eval.Feasibility` — the worldline invariants (#1048). A
model-independent assertion on the DRAWN timeline: some outputs are impossible
regardless of how the cascade produced them.

⚠ EVERY INPUT IS OPTIONAL AND THE ABSENCE OF ONE SILENCES ITS INVARIANT, on
purpose. No `points` and the kinematic checks do not run; no `steps` and the
pedestrian twin does not; no `stationsOnLine` and the triple check does not.
That is the zero-false-positive rule applied to missing DATA rather than to
thresholds — a day whose fixture never recorded a line's stations must not have
its labels called impossible.

  { "mode": "feasibility",
    "legs": [ { "startTs": n, "endTs": n, "mode": s, "wayName": s|null } ],
    "points": [ { "ts": n, "lat": f, "lon": f } ],
    "steps": [ { "ts": n, "steps": f } ],
    "lineStations": [ { "line": s, "stations": [s] } ] }

Output: `{ "violations": [ { "kind", "startTs", "endTs", "detail" } ] }`. -/

namespace Feasibility

open Verified.Eval.Feasibility

private def parseLeg (j : Json) : Except String Leg := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           mode := ← (← j.getObjVal? "mode").getStr?
           wayName := (j.getObjVal? "wayName" >>= (·.getStr?)).toOption }

private def parseFix (j : Json) : Except String Fix := do
  return { ts := ← (← j.getObjVal? "ts").getInt?
           lat := ← jFloatField j "lat"
           lon := ← jFloatField j "lon" }

private def parseStep (j : Json) : Except String StepPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?
           steps := ← jFloatField j "steps" }

private def parseMembership (j : Json) : Except String (String × Array String) := do
  let line ← (← j.getObjVal? "line").getStr?
  let stations ← (← (← j.getObjVal? "stations").getArr?).mapM (·.getStr?)
  return (line, stations)

def feasibilityResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let legs ← (← optArr j "legs").mapM parseLeg
    let points ← (← optArr j "points").mapM parseFix
    let steps ← (← optArr j "steps").mapM parseStep
    let lineStations ← (← optArr j "lineStations").mapM parseMembership
    let vs := checkWorldlineFeasibility legs points steps lineStations
    return Json.mkObj [("violations", Json.arr (vs.map fun v =>
      Json.mkObj [("kind", Json.str v.kind.toString),
                  ("startTs", Lean.toJson v.startTs), ("endTs", Lean.toJson v.endTs),
                  ("detail", Json.str v.detail)]))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Feasibility

/-! ## Ceiling-gate modes (`ceilinggate`, `ceilingbless`)

`Verified.Eval.CeilingGate` — the count-shaped sibling of `floorgate`, for the
two standing-defect baselines (#1048).

⚠ `measured` AND `attempted` ARE BOTH REQUIRED and they are not the same list.
`measured` is the days that produced a count; `attempted` is every day the run
set out to cover. Without the second, a day whose ceiling is ZERO is in neither
baseline and so is named nowhere — which is where a new defect hides best, since
it cannot regress a ceiling it is no longer measured against.

  { "mode": "ceilinggate",
    "committed": [ { "date": s, "count": n } ],
    "current":   [ { "date": s, "count": n } ],
    "measured": [s], "attempted": [s] }

Output: `{ "regressed": [{ "date", "was", "now" }], "improvedDays": n,
"unmeasured": [s] }`.

  { "mode": "ceilingbless", "committed": … | null, "current": …, "measured": [s] }

Output: `{ "ceiling": [ { "date", "count" } ] }` — the MINIMUM per day, so
blessing a run that fixed some days cannot raise the ceiling on the others. A
`null` committed is the bootstrap case. -/

namespace CeilingGate

open Verified.Eval.CeilingGate

private def parseCeiling (j : Json) (key : String) : Except String Ceiling := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => if v.isNull then pure #[] else v.getArr?
  arr.mapM fun e => do
    let date ← (← e.getObjVal? "date").getStr?
    let count ← (← e.getObjVal? "count").getNat?
    return (date, count)

private def parseDates (j : Json) (key : String) : Except String (Array String) := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => v.getArr?
  arr.mapM (·.getStr?)

private def ceilingJson (c : Ceiling) : Json :=
  Json.arr (c.map fun (d, n) =>
    Json.mkObj [("date", Json.str d), ("count", Lean.toJson n)])

def ceilingGateResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let committed ← parseCeiling j "committed"
    let current ← parseCeiling j "current"
    let measured ← parseDates j "measured"
    let attempted ← parseDates j "attempted"
    let r := gateCeiling committed current measured attempted
    return Json.mkObj [
      ("regressed", Json.arr (r.regressed.map fun x =>
        Json.mkObj [("date", Json.str x.date), ("was", Lean.toJson x.was),
                    ("now", Lean.toJson x.now)])),
      ("improvedDays", Lean.toJson r.improvedDays),
      ("unmeasured", Json.arr (r.unmeasured.map Json.str))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

def ceilingBlessResult (j : Json) : Json :=
  let parsed : Except String Json := do
    -- ⚠ `null` and ABSENT both mean bootstrap; an empty ARRAY does not. A
    -- committed baseline of `[]` is a real ceiling of zero everywhere.
    let committed : Option Ceiling ← match j.getObjVal? "committed" with
      | .error _ => pure none
      | .ok v => if v.isNull then pure none else some <$> parseCeiling j "committed"
    let current ← parseCeiling j "current"
    let measured ← parseDates j "measured"
    return Json.mkObj [("ceiling", ceilingJson (ratchetDownCounts committed current measured))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end CeilingGate

/-- The mode table: one request object in, one result object out.

⚠ Lifted out of `serveLoop` so it is not reachable only from a read-eval loop
over stdin. A host that has linked this library already has the request in
memory and must not have to spell it back into NDJSON to ask a question — the
subprocess protocol is a consequence of `verified_cli` being a separate
process, not part of what the handlers are. -/
def dispatch (j : Json) : Json :=
  match (j.getObjVal? "mode" >>= (·.getStr?)) with
  | .ok "geo" => geoResult j
  | .ok "match" => matchResult j
  | .ok "rail" => railResult j
  | .ok "hsmm" => hsmmResult j
  | .ok "assemble" => assembleResult j
  | .ok "assembledecode" => assembleDecodeResult j
  | .ok "assemblesegments" => assembleSegmentsResult j
  | .ok "proximityqueries" => proximityQueriesResult j
  | .ok "proximitytable" => proximityTableResult j
  | .ok "knownlines" => knownLinesResult j
  | .ok "placenearline" => placeNearLineResult j
  | .ok "coverage" => coverageResult j
  | .ok "kalman" => kalmanResult j
  | .ok "rankvenues" => rankVenuesResult j
  | .ok "bestplace" => bestPlaceResult j
  | .ok "gpsquality" => gpsQualityResult j
  | .ok "gpsoutliers" => gpsOutliersResult j
  | .ok "biolabels" => bioLabelsResult j
  | .ok "head" => headResult j
  | .ok "day" => Day.dayResult j
  | .ok "focus" => Focus.focusResult j
  | .ok "battery" => batteryResult j
  | .ok "osmspatial" => osmSpatialResult j
  | .ok "osmcoverage" => osmCoverageResult j
  | .ok "railsnap" => railSnapResult j
  | .ok "railfill" => railFillResult j
  | .ok "clipinferred" => clipInferredResult j
  | .ok "watchbattery" => watchBatteryResult j
  | .ok "stationchain" => StationChain.stationChainResult j
  -- The walk referee (#1048 Group B). Nothing serves it; it is here rather
  -- than beside `main` because that is the only place a host can link.
  | .ok "walkgate" => WalkGate.walkGateResult j
  -- The narrative parser (#1290). Reply is CIVIL time; the shell resolves it.
  | .ok "groundtruth" => GroundTruth.groundTruthResult j
  -- The ground-truth side of the decoder scoreboard (#1048). Rows arrive
  -- RESOLVED; the zone conversion is the shell's.
  | .ok "journeys" => Journeys.journeysResult j
  | .ok "truthcheck" => TruthCheck.truthCheckResult j
  | .ok "floorgate" => FloorGate.floorGateResult j
  | .ok "journeyshape" => JourneyShape.journeyShapeResult j
  | .ok "decoderscore" => DecoderScore.decoderScoreResult j
  | .ok "feasibility" => Feasibility.feasibilityResult j
  | .ok "ceilinggate" => CeilingGate.ceilingGateResult j
  | .ok "ceilingbless" => CeilingGate.ceilingBlessResult j
  -- Layer 3 for the day mode (#433), the counterpart of `gqdecode`. Runs
  -- `dayResult`'s parse prefix and stops, so `day − daydecode` is the
  -- response wire plus the algorithm rather than those plus the decode.
  | .ok "daydecode" => Day.decodeOnly j
  -- Layer 2 for the day mode (#433): the whole chain, no row encoding, so
  -- `day − dayresp` is the response side and `dayresp − daydecode` is the
  -- algorithm. Its counts are cross-checked against the `day` reply.
  | .ok "dayresp" => Day.chainNoEncode j
  -- Ablation mode (#405): accept the request, do nothing, reply empty.
  -- The payload is still shipped across the SharedArrayBuffer and still
  -- parsed by `Json.parse line` above — only the ALGORITHM is skipped.
  -- So a `noop` round trip is the floor every tenant pays for consulting
  -- Lean at all, and `real − noop` is what the verified code itself costs.
  --
  -- This exists because the arm ratios (#404) run inverse to how much
  -- work the call does — gpsquality is 213x with a 0.05 ms TS arm — which
  -- says the numbers are measuring the crossing, not the core. That is a
  -- claim about the staging mechanism, and it has to be measured rather
  -- than argued: under the Rust-shell architecture there is no crossing,
  -- so anything below this floor is not a cost the verified core has.
  | .ok "noop" => Json.mkObj []
  -- The other half of the ablation. `noop` returns `{}`, so it measures
  -- only the REQUEST side — the response encode (`resp.compress` below)
  -- and the caller's `JSON.parse` of it are transport too, and charging
  -- them to the algorithm would understate the floor. `echo` ships the
  -- input rows straight back, so a real-sized response crosses the wire
  -- with no computation behind it.
  --
  -- Neither bounds the floor alone: `noop` is a floor for tenants whose
  -- reply is small (geo returns keep-indices), `echo` is the honest model
  -- for tenants whose reply is the rows (gpsquality returns a subset of
  -- its input). Read them as a bracket, not as one number.
  | .ok "echo" =>
    match j.getObjVal? "pts" with
    | .ok pts => Json.mkObj [("pts", pts)]
    | .error _ => Json.mkObj []
  -- The third layer. `noop`/`echo` leave the payload as generic `Json`;
  -- the real handler must still turn it into `GpsPoint`s, which for this
  -- tenant means a decimal-string → UInt64 → Float parse PER COORDINATE
  -- (see `fBits`/`parseKalmanPt`). That decode exists only because the
  -- two arms live in different processes — under a Rust shell the points
  -- are already in memory — so charging it to the verified algorithm
  -- would overstate what the algorithm costs.
  --
  -- Runs exactly `gpsQualityResult`'s parse and then stops, so
  -- `real − gqdecode` is the filter itself plus its response encode.
  | .ok "gqdecode" =>
    match (do
      let pts ← (← (← j.getObjVal? "pts").getArr?).mapM parseKalmanPt
      return pts.size : Except String Nat) with
    | .ok n => Json.mkObj [("n", Lean.toJson n)]
    | .error e => Json.mkObj [("error", Json.str e)]
  | .ok other => Json.mkObj [("error", Json.str s!"unknown mode {other}")]
  | .error _ => Json.mkObj [("error", Json.str "missing mode")]

/-- The C ABI a host links this library for.

Mirrors `health_day_result` in `DayEntry` and `health_backend_call` in
`BackendEntry`: an owned Lean string in, an owned Lean string out, so the shim
in `rust/*/src/shim.c` stays the same three functions. The payload is one
`serve` request — the same object `serveLoop` reads off a line — so a host and
the subprocess ask the identical question, and any divergence between them is a
transport bug rather than a difference in what was asked.

⚠ It returns the BODY, not `serveLoop`'s `{"id", "result"}` envelope. That
envelope correlates replies on one NDJSON pipe; a caller that has just invoked a
function has nothing to correlate, and handing it back would make every host
strip a field the transport invented. -/
@[export health_serve_dispatch]
def serveDispatchExport (input : String) : String :=
  match Json.parse input with
  | .error e => (Json.mkObj [("error", Json.str s!"parse: {e}")]).compress
  | .ok j => (dispatch j).compress


/-- Persistent request loop: one NDJSON request per line
(`{"id", "mode":"geo|match|rail|hsmm", …}`) → one NDJSON response
(`{"id", "result": …}`), flushed per line. Lets a long-lived worker serve
many calls without a process spawn each — the request-path execution
substrate the TS bridge drives. -/
private partial def serveLoop (stdin stdout : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return  -- EOF: the worker closed our stdin
  let resp : Json :=
    match Json.parse line with
    | .error e => Json.mkObj [("id", Json.null), ("error", Json.str s!"parse: {e}")]
    | .ok j =>
      let id := match j.getObjVal? "id" with | .ok v => v | .error _ => Json.null
      let body : Json := dispatch j
      Json.mkObj [("id", id), ("result", body)]
  stdout.putStr resp.compress
  stdout.putStr "\n"
  stdout.flush
  serveLoop stdin stdout

/-- The `verified_cli` command line, as a plain function.

⚠ NOT called `main`. A `lean_exe`'s root module emits `main`, and an archive
carrying it wins the link inside a foreign host silently — it builds, runs, and
answers from the wrong entry point. That is why `DayEntry` and `BackendEntry`
exist as libraries, and this file is now one for the same reason: every handler
below was unreachable from Rust purely because it shared a module with `main`.

`Main.lean` is the shim that turns this back into an executable. -/
def cliMain (args : List String) : IO UInt32 := do
  if args.contains "serve" then
    serveLoop (← IO.getStdin) (← IO.getStdout)
    return 0
  let timing := args.contains "--timing"
  let t0 ← IO.monoMsNow
  let input ← (← IO.getStdin).readToEnd
  if args.contains "rail" then return ← railMain input
  if args.contains "geo" then return ← geoMain input
  if args.contains "matchprof" then return ← matchProfMain input
  if args.contains "match" then return ← matchMain input
  if args.contains "assembledecode" then return ← runOne assembleDecodeResult input
  if args.contains "coverage" then return ← runOne coverageResult input
  if args.contains "kalman" then return ← runOne kalmanResult input
  if args.contains "rankvenues" then return ← runOne rankVenuesResult input
  if args.contains "bestplace" then return ← runOne bestPlaceResult input
  if args.contains "gpsquality" then return ← runOne gpsQualityResult input
  if args.contains "gpsoutliers" then return ← runOne gpsOutliersResult input
  if args.contains "biolabels" then return ← runOne bioLabelsResult input
  if args.contains "head" then return ← runOne headResult input
  if args.contains "day" then return ← runOne Day.dayResult input
  if args.contains "focus" then return ← runOne Focus.focusResult input
  if args.contains "stationchain" then return ← runOne StationChain.stationChainResult input
  if args.contains "assemble" then return ← runOne assembleResult input
  let t1 ← IO.monoMsNow
  match Json.parse input >>= parseModel with
  | .error e =>
    IO.println (Json.mkObj [("error", Json.str e)]).compress
    return 1
  | .ok m =>
    let t2 ← IO.monoMsNow
    -- `IO.lazyPure` pins the evaluation between the two timestamps; a plain
    -- pure `let` gets floated into the match by the compiler.
    let r ← IO.lazyPure fun _ => pDecodeFast m ckptStride
    let t3 ← IO.monoMsNow
    match r with
    | none => IO.println (Json.mkObj [("degenerate", Json.bool true)]).compress
    | some r =>
      let path := Json.arr (r.path.map fun s => Lean.toJson s)
      let best := match r.best with
        | .val v => Lean.toJson v
        | .negInf => Json.null -- unreachable: `pDecode` returns none instead
      IO.println (Json.mkObj [("path", path), ("best", best)]).compress
    if timing then
      IO.eprintln s!"timing: read={t1-t0}ms parse={t2-t1}ms decode={t3-t2}ms"
    return 0
