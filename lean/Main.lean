import Verified
import Lean.Data.Json

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

private def jFloat (j : Json) : Except String Float := do return (← j.getNum?).toFloat
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

private def parseAssemble (j : Json) : Except String (Verified.Hsmm.Assemble.ModelContext × Nat) := do
  let obs ← (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
  let edges ← (← (← j.getObjVal? "edges").getArr?).mapM parseEdge
  let places ← (← (← j.getObjVal? "places").getArr?).mapM parsePlace
  let coverage ← match j.getObjVal? "coverage" with
    | .ok v => if v.isNull then pure {} else parseCoverage v
    | .error _ => pure {}
  let continuity ← parseContinuity j
  let placeNearLine : Std.HashSet String ←
    match j.getObjVal? "placeNearLine" with
    | .ok v => if v.isNull then pure {} else do
        pure (Std.HashSet.ofList (← (← v.getArr?).mapM (·.getStr?)).toList)
    | .error _ => pure {}
  let flags ← j.getObjVal? "flags"
  let maxD ← (← j.getObjVal? "maxD").getNat?
  return (Verified.Hsmm.Assemble.buildContext obs (Verified.Hsmm.RouteModel.buildRouteGraphModel edges)
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
      let body : Json :=
        match (j.getObjVal? "mode" >>= (·.getStr?)) with
        | .ok "geo" => geoResult j
        | .ok "match" => matchResult j
        | .ok "rail" => railResult j
        | .ok "hsmm" => hsmmResult j
        | .ok "assemble" => assembleResult j
        | .ok other => Json.mkObj [("error", Json.str s!"unknown mode {other}")]
        | .error _ => Json.mkObj [("error", Json.str "missing mode")]
      Json.mkObj [("id", id), ("result", body)]
  stdout.putStr resp.compress
  stdout.putStr "\n"
  stdout.flush
  serveLoop stdin stdout

def main (args : List String) : IO UInt32 := do
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
