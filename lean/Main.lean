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

private def parseStationNode (j : Json) : Except String Verified.Hsmm.TrainCandidates.StationNode := do
  let name : Option String := match (j.getObjVal? "stationName" >>= (·.getStr?)) with
    | .ok s => some s | .error _ => none
  let edgeIds ← (← (← j.getObjVal? "edgeIds").getArr?).mapM (·.getStr?)
  return ⟨← (← j.getObjVal? "id").getStr?, ← jFloatField j "lat", ← jFloatField j "lon", name, edgeIds.toList⟩

private def parseAssemble (j : Json) : Except String (Verified.Hsmm.Assemble.ModelContext × Nat) := do
  let obs ← (← (← j.getObjVal? "obs").getArr?).mapM parseObsRow
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
  let maxD ← (← j.getObjVal? "maxD").getNat?
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

private def fBits (v : Float) : Json := Json.str (toString v.toBits.toNat)

private def jBits (j : Json) : Except String Float := do
  let s ← j.getStr?
  match s.toNat? with
  | some n => return Float.ofBits (UInt64.ofNat n)
  | none => throw s!"not a float bit pattern: {s}"

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

/-- An optional string field: absent and `null` both read as `none`. -/
private def optStr (j : Json) (k : String) : Except String (Option String) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> v.getStr?

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

namespace Day

-- Not `open`ed: `Verified.Hsmm.Seg` is already in scope at the top of this
-- file and the two names would be ambiguous.
abbrev Seg := Verified.Geo.SegmentMerge.Seg
abbrev StepPoint := Verified.Geo.SegmentMerge.StepPoint
abbrev Env := Verified.Geo.PassFold.Env

/-- Table key for a lookup of two coordinates, and for three where the third is
the caller's radius. Bit patterns, per the section note. -/
private def k2 (a b : Float) : String := s!"{a.toBits}|{b.toBits}"
private def k3 (a b c : Float) : String := s!"{a.toBits}|{b.toBits}|{c.toBits}"

private def mkMap (xs : Array (String × α)) : Std.HashMap String α :=
  xs.foldl (fun m (k, v) => m.insert k v) (Std.HashMap.emptyWithCapacity xs.size)

/-- Answer or abort. Never a default: see the section note on the miss policy. -/
private def hit [Inhabited α] (m : Std.HashMap String α) (what key : String) : α :=
  match m[key]? with
  | some v => v
  | none => panic! s!"verified_cli day: uncaptured {what}({key}) — re-capture required"

/-! ### Decoding -/

private def optBits (j : Json) (k : String) : Except String (Option Float) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> jBits v

private def optInt (j : Json) (k : String) : Except String (Option Int) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> v.getInt?

private def optBool (j : Json) (k : String) (dflt : Bool) : Except String Bool :=
  match j.getObjVal? k with
  | .error _ => pure dflt
  | .ok v => if v.isNull then pure dflt else v.getBool?

/-- A field holding an array; absent and `null` both read as empty. -/
private def optArr (j : Json) (k : String) : Except String (Array Json) :=
  match j.getObjVal? k with
  | .error _ => pure #[]
  | .ok v => if v.isNull then pure #[] else v.getArr?

private def nth (a : Array Json) (i : Nat) : Except String Json :=
  match a[i]? with
  | some v => pure v
  | none => throw s!"tuple too short: wanted index {i} of {a.size}"

private def strs (j : Json) : Except String (Array String) := do
  (← j.getArr?).mapM (·.getStr?)

private def parsePathPt (j : Json) : Except String Verified.Geo.PathPt := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- A positional bit pattern that may be `null` — the array-tuple counterpart of
{@link optBits}. The mined statistics are the first wire shape where a nullable
Float sits in a tuple rather than under a key: a mode observed with no HR at all
has `hrMean = null`, which is not the same claim as `hrMean = 0`. -/
private def nthBits (a : Array Json) (i : Nat) : Except String (Option Float) := do
  let v ← nth a i
  if v.isNull then pure none else some <$> jBits v

/-- One mined `mode_biometrics` row, as `fold-payload.ts` writes it. -/
private def parseModeStats (j : Json) : Except String Verified.Geo.ModeBiometrics.ModeStats := do
  let a ← j.getArr?
  return {
    mode := ← (← nth a 0).getStr?
    hrMean := ← nthBits a 1
    hrStd := ← nthBits a 2
    hrSampleCount := (← (← nth a 3).getInt?).toNat
    cadenceMean := ← nthBits a 4
    cadenceStd := ← nthBits a 5
    cadenceSampleCount := (← (← nth a 6).getInt?).toNat
    speedMean := ← nthBits a 7
    speedStd := ← nthBits a 8
    speedSampleCount := (← (← nth a 9).getInt?).toNat
    sampleCount := (← (← nth a 10).getInt?).toNat
  }

private def optPath (j : Json) (k : String) :
    Except String (Option (Array Verified.Geo.PathPt)) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => do
    if v.isNull then pure none else some <$> ((← v.getArr?).mapM parsePathPt)

private def parseBiom (j : Json) : Except String Verified.Geo.SegmentMerge.BiometricEnrichment := do
  return {
    hrMean := ← optBits j "hrMean"
    hrMin := ← optBits j "hrMin"
    hrMax := ← optBits j "hrMax"
    hrStd := ← optBits j "hrStd"
    sampleCount := (← (← j.getObjVal? "sampleCount").getInt?).toNat
    overlapsSleep := ← optBool j "overlapsSleep" false
    sleepFraction := ← jBits (← j.getObjVal? "sleepFraction")
    stepsTotal := ← optBits j "stepsTotal"
  }

private def parseSeg (j : Json) : Except String Seg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    refinedMode := ← optStr j "refinedMode"
    confidence := ← jBits (← j.getObjVal? "confidence")
    confidenceMargin := ← jBits (← j.getObjVal? "confidenceMargin")
    avgSpeed := ← jBits (← j.getObjVal? "avgSpeed")
    maxSpeed := ← jBits (← j.getObjVal? "maxSpeed")
    linearity := ← jBits (← j.getObjVal? "linearity")
    pointCount := ← (← j.getObjVal? "pointCount").getInt?
    place := ← optStr j "place"
    city := ← optStr j "city"
    wayName := ← optStr j "wayName"
    refinedReason := ← optStr j "refinedReason"
    refinedKinds := ← (← optArr j "refinedKinds").mapM (·.getStr?)
    centroidLat := ← optBits j "centroidLat"
    centroidLon := ← optBits j "centroidLon"
    focusPlaceId := ← optInt j "focusPlaceId"
    needsReenrich := ← optBool j "needsReenrich" false
    vehicleKind := ← optStr j "vehicleKind"
    roadCorridorFraction := ← optBits j "roadCorridorFraction"
    displayTz := ← optStr j "displayTz"
    snappedPath := ← optPath j "snappedPath"
    matchedPath := ← optPath j "matchedPath"
    walkMatchedPath := ← optPath j "walkMatchedPath"
    walkSmoothedPath := ← optPath j "walkSmoothedPath"
    biometrics := ← match j.getObjVal? "biometrics" with
      | .error _ => pure none
      | .ok v => if v.isNull then pure none else some <$> parseBiom v
  }

private def parsePointF (j : Json) : Except String Shed.PointF := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), ← jBits (← nth a 3)⟩

private def parseCoarse (j : Json) : Except String Verified.Geo.UndergroundRun.CoarseFix := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parsePedFix (j : Json) : Except String Verified.Geo.WalkAnnotate.PedFix := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parseStep (j : Json) : Except String StepPoint := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1)⟩

private def parseHr (j : Json) : Except String Verified.Geo.BiometricWindows.HrPoint := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1)⟩

private def parseSleep (j : Json) : Except String Verified.Geo.BiometricWindows.SleepStage := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← (← nth a 1).getInt?⟩

private def parseKnownPlace (j : Json) : Except String Verified.Geo.SegmentMerge.KnownPlaceProjection := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- `[id, latBits, lonBits, radiusBits, uniqueDaysBits, hourProfile|null,
displayName|null, sleepHoursBits, amenityLabel|null]` — a mined `focus_places`
row as the OSM enrichment stage reads it.

The whole row rather than a projection, unlike `stayPlaces` and `dwellPlaces`
beside it: the stationary branch scores the candidate and then branches its
LABEL on three more fields of the SAME row in one decision, so a split would
only give the halves somewhere to drift apart. -/
private def parseNamedPlace (j : Json) : Except String Verified.Geo.StayEnrich.NamedPlace := do
  let a ← j.getArr?
  let profile ← match a[5]? with
    | some v => if v.isNull then pure none else some <$> ((← v.getArr?).mapM jBits).map Array.toList
    | none => pure none
  let optS (i : Nat) : Except String (Option String) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return {
    cand := {
      id := ← (← nth a 0).getInt?
      centroidLat := ← jBits (← nth a 1)
      centroidLon := ← jBits (← nth a 2)
      radiusM := ← jBits (← nth a 3)
      uniqueDays := ← jBits (← nth a 4)
      hourProfile := profile }
    displayName := ← optS 6
    sleepHours := ← jBits (← nth a 7)
    amenityLabel := ← optS 8 }

private def parseHmmSeg (j : Json) : Except String Verified.Geo.PlaceOverride.HmmSeg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    lineName := ← optStr j "lineName"
    placeId := ← optInt j "placeId"
  }

/-- `[id, displayName|null, latBits|null, lonBits|null]`. -/
private def parseHsmmPlace (j : Json) :
    Except String (Int × Verified.Geo.PlaceOverride.PlaceLookup) := do
  let a ← j.getArr?
  let nm ← match a[1]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  let la ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let lo ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return (← (← nth a 0).getInt?, ⟨nm, la, lo⟩)

private def parseRouteStop (j : Json) : Except String Verified.Geo.LineStoppingPattern.RouteStop := do
  let a ← j.getArr?
  let nm ← match a[0]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨nm, ← jBits (← nth a 1), ← jBits (← nth a 2), (← (← nth a 3).getInt?).toNat⟩

private def parseRailStops (j : Json) :
    Except String Verified.Geo.LineStoppingPattern.RailStopRelation := do
  return {
    stops := ← (← optArr j "stops").mapM parseRouteStop
    lineRef := ← optStr j "lineRef"
    lineName := ← optStr j "lineName"
    osmRelationId := (← (← j.getObjVal? "osmRelationId").getInt?).toNat
    routeType := ← (← j.getObjVal? "routeType").getStr?
  }

private def parseWpt (j : Json) : Except String Verified.Geo.WalkableRoute.Pt := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1)⟩

/-- `[routeKey, [[latBits, lonBits], …]]`. -/
private def parseRouteRow (j : Json) : Except String Verified.Geo.RailReconcile.RouteRow := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getStr?, ← (← (← nth a 1).getArr?).mapM parseWpt⟩

private def parseLatLon (j : Json) : Except String Verified.Geo.Bus.LatLon := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1)⟩

private def parseBusStop (j : Json) : Except String Verified.Geo.Bus.BusStop := do
  let a ← j.getArr?
  let nm ← match a[0]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨nm, ← jBits (← nth a 1), ← jBits (← nth a 2), ← (← nth a 3).getInt?⟩

private def parseBusRoute (j : Json) : Except String Verified.Geo.Bus.BusRoute := do
  return {
    routeRef := ← (← j.getObjVal? "routeRef").getStr?
    routeName := ← optStr j "routeName"
    osmRelationId := ← (← j.getObjVal? "osmRelationId").getInt?
    stops := (← (← optArr j "stops").mapM parseBusStop).toList
  }

private def parseStation (j : Json) : Except String Verified.Geo.TubeHop.NearbyStation := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← jBits (← j.getObjVal? "distanceM")
    lat := ← optBits j "lat"
    lon := ← optBits j "lon"
  }

private def parseWay (j : Json) : Except String Verified.Geo.Factors.NearbyWay := do
  return {
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    name := ← optStr j "name"
    distanceM := ← optBits j "distanceM"
  }

/-- A Nominatim reverse-geocode, whole.

It used to decode the five city-like fields only, because `extractCity` was the
one consumer. `Verified.Geo.BestPlace` reads the rest, so the projection went
away on both sides at once (#430) — a decoder narrower than the encoder would
silently drop the venue keys the naming turns on. -/
private def parseGeoResult (j : Json) : Except String Verified.Geo.BestPlace.Result := do
  return {
    displayName := ← (← j.getObjVal? "displayName").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    category := ← (← j.getObjVal? "category").getStr?
    address := {
      amenity := ← optStr j "amenity"
      tourism := ← optStr j "tourism"
      leisure := ← optStr j "leisure"
      shop := ← optStr j "shop"
      building := ← optStr j "building"
      houseNumber := ← optStr j "houseNumber"
      road := ← optStr j "road"
      pedestrian := ← optStr j "pedestrian"
      neighbourhood := ← optStr j "neighbourhood"
      suburb := ← optStr j "suburb"
      stateDistrict := ← optStr j "stateDistrict"
      city := ← optStr j "city"
      town := ← optStr j "town"
      village := ← optStr j "village"
      municipality := ← optStr j "municipality"
    }
  }

/-- One Overpass landmark, as `bestPlace` ranks them. `openingHours` is the RAW
tag: `Verified.Geo.BestPlace.toLandmark` parses it against the stay's samples,
because the fraction is a function of both and only the pair is meaningful. -/
private def parsePoi (j : Json) : Except String Verified.Geo.BestPlace.Poi := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← jBits (← j.getObjVal? "distanceM")
    openingHours := ← optStr j "openingHours"
    enclosing := ← optBool j "enclosing" false
  }

private def parseVenueStats (j : Json) : Except String Verified.Geo.VenuePrior.VenueTypeStats := do
  return {
    visits := ← jBits (← j.getObjVal? "visits")
    dwell := (← (← optArr j "dwell").mapM jBits).toList
    hours := (← (← optArr j "hours").mapM jBits).toList
  }

/-- The mined visit-shape priors, or `none` when nothing has been mined.

Association lists rather than maps, and in the encoder's order: `shapeScore`
reads the subtype universe's SIZE off `bySubtype`, so the collection is data and
not just an index. -/
private def parseVenuePriors (j : Json) :
    Except String (Option Verified.Geo.VenuePrior.VenuePriors) := do
  match j.getObjVal? "venuePriors" with
  | .error _ => pure none
  | .ok v =>
    if v.isNull then pure none else do
      let pair := fun (e : Json) => do
        let a ← e.getArr?
        return (← (← nth a 0).getStr?, ← parseVenueStats (← nth a 1))
      return some {
        bySubtype := (← (← optArr v "bySubtype").mapM pair).toList
        byCategory := (← (← optArr v "byCategory").mapM pair).toList
        totalVisits := ← jBits (← v.getObjVal? "totalVisits")
      }

/-- `[latBits, lonBits, zoom, address|null]`.

The zoom crosses as a plain integer rather than as bits: it is an argument the
caller writes as a literal (16 here, 18 by default), not a measured double, and
keying an integer on its float bits would be a spelling both sides have to agree
on for no gain.

`null` is a RESULT — Nominatim resolving nothing — and is stored as such, so a
key present with a null answer is not a miss. -/
private def entryGeo (j : Json) :
    Except String (String × Option Verified.Geo.BestPlace.Result) := do
  let a ← j.getArr?
  let lat ← jBits (← nth a 0)
  let lon ← jBits (← nth a 1)
  let zoom ← (← nth a 2).getInt?
  let ans ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> parseGeoResult v
    | none => pure none
  return (s!"{lat.toBits}|{lon.toBits}|{zoom}", ans)

private def parseTransitStop (j : Json) : Except String Verified.Geo.Bus.TransitStop := do
  return ⟨← (← j.getObjVal? "subtype").getStr?, ← jBits (← j.getObjVal? "distanceM")⟩

private def parseLineStation (j : Json) : Except String Verified.Geo.RailJourney.LineStation := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getStr?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- `[latBits, lonBits, radiusBits, answer]` → a keyed entry. -/
private def entry3 (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  let k := k3 (← jBits (← nth a 0)) (← jBits (← nth a 1)) (← jBits (← nth a 2))
  return (k, ← parse (← nth a 3))

/-- `[latBits, lonBits, answer]` — the two-argument lookups. -/
private def entry2 (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  let k := k2 (← jBits (← nth a 0)) (← jBits (← nth a 1))
  return (k, ← parse (← nth a 2))

/-- `[key, answer]` — the lookups keyed by a name rather than a coordinate. -/
private def entryS (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  return (← (← nth a 0).getStr?, ← parse (← nth a 1))

/-- `[latBits, lonBits, startTs, endTs, tz, samples, localHour]` — the stay
CONTEXT of one naming question, keyed on all five arguments because it is asked
per merged stay and two stays at one centroid with different windows are
different questions.

It used to carry the ANSWER, `{label, city}`, because `bestPlace` was a shell.
It is now `Verified.Geo.BestPlace`, so what crosses is the part Lean cannot
compute: the stay's minutes and its midpoint hour resolved in the venue's zone.
The zone stays in the KEY as well — it is what those two were resolved against,
and a key without it would spell two different questions the same way. -/
private def entryPlace (j : Json) :
    Except String (String × (List (Nat × Nat) × Int)) := do
  let a ← j.getArr?
  let lat ← jBits (← nth a 0)
  let lon ← jBits (← nth a 1)
  let s ← (← nth a 2).getInt?
  let e ← (← nth a 3).getInt?
  let m ← (← nth a 4).getStr?
  let samples ← (← (← nth a 5).getArr?).mapM fun p => do
    let q ← p.getArr?
    return ((← (← nth q 0).getInt?).toNat, (← (← nth q 1).getInt?).toNat)
  let localHour ← (← nth a 6).getInt?
  return (s!"{lat.toBits}|{lon.toBits}|{s}|{e}|{m}", (samples.toList, localHour))

/-! ### The stages after the fold

`Verified.Geo.DayChain` reads a different closure: two raw-fix series from
OUTSIDE the day, the Fitbit windows before place attribution, the mined places in
two projections, and one shell lookup. Parsed separately from `Env` because they
are a different stage's inputs, not more of the fold's. -/

private def parseStayFix (j : Json) : Except String Verified.Geo.DayState.StayFix := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

private def parseRawSleep (j : Json) : Except String Verified.Geo.DayChain.RawSleepWindow := do
  let a ← j.getArr?
  let tz ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← (← nth a 1).getInt?, tz, ← (← nth a 3).getInt?⟩

private def parseStayPlace (j : Json) : Except String Verified.Geo.DayState.StayKnownPlace := do
  let a ← j.getArr?
  let r ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let nm ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), r, nm⟩

private def parseDwellPlace (j : Json) :
    Except String Verified.Geo.DwellContinuation.DwellCandidate := do
  let a ← j.getArr?
  let optF (i : Nat) : Except String (Option Float) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let optI (i : Nat) : Except String (Option Int) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> v.getInt?
    | none => pure none
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), ← optF 2, ← optF 3, ← optI 4,
    ← (← nth a 5).getInt?⟩

/-- `nearbyLandmarks`' radius, fixed by `bestPlace`'s only call to it. A literal
rather than a parameter for the same reason the TS writes it inline: the ring is
the picker's, not the caller's. -/
private def LANDMARK_RADIUS_M : Float := 100

/-- The tables the venue naming reads, bound once and shared by the fold's
`bestPlace` and the chain's `sleepPlace` — the same function at two call sites,
which is why they are built here rather than twice. -/
private structure Namer where
  landmarksAt : Float → Float → Array Verified.Geo.BestPlace.Poi
  geocodeAt : Float → Float → Int → Option Verified.Geo.BestPlace.Result
  stayCtx : Float → Float → Int → Int → String → List (Nat × Nat) × Int
  priors : Option Verified.Geo.VenuePrior.VenuePriors
  /-- The three tables' entry counts.
      These exist so the LAYER MEASUREMENT can force the three `mkMap` calls
      without calling the closures above (#433). The other five tables are
      forced by a probe that asks them for a key they hold, but these three are
      reachable only through `Namer.name`, which composes a landmark lookup, a
      geocode lookup and a stay-context lookup — any of which can reach a key a
      probe did not choose, and a miss `panic!`s. A structure field is computed
      when the structure is built, so reading a size here forces the map with no
      key to guess and no miss to risk.
      `dayResult` ignores them and is unaffected: it forces all three through
      the fold regardless, so the same work happens either way. -/
  sizes : Nat

private def namerOf (j : Json) : Except String Namer := do
  let lk := (j.getObjVal? "lookups").toOption.getD (Json.mkObj [])
  let landmarks := mkMap (← (← optArr lk "nearbyLandmarks").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parsePoi)))
  let geocodes := mkMap (← (← optArr lk "reverseGeocode").mapM entryGeo)
  let stays := mkMap (← (← optArr lk "bestPlace").mapM entryPlace)
  return {
    landmarksAt := fun lat lon => hit landmarks "nearbyLandmarks" (k3 lat lon LANDMARK_RADIUS_M)
    geocodeAt := fun lat lon zoom => hit geocodes "reverseGeocode" s!"{lat.toBits}|{lon.toBits}|{zoom}"
    stayCtx := fun lat lon s e tz => hit stays "bestPlace" s!"{lat.toBits}|{lon.toBits}|{s}|{e}|{tz}"
    priors := ← parseVenuePriors j
    sizes := landmarks.size + geocodes.size + stays.size
  }

/-- Name one coordinate.

`stay` is `(startUnix, endUnix, tz)` when there is a window to weigh and `none`
when there is not — the two arms of `bestPlace`. The stay-context lookup sits
inside `Option.map`, so a `none` stay never applies the panicking table and a
naming with no window cannot fail on a key it was never going to need. -/
private def Namer.name (n : Namer) (lat lon : Float) (stay : Option (Int × Int × String))
    (preferResidential : Bool) : Option Verified.Geo.SegmentMerge.ResolvedPlace :=
  let ctx := stay.map fun (s, e, tz) => n.stayCtx lat lon s e tz
  Verified.Geo.BestPlace.resolve
    { landmarks := (n.landmarksAt lat lon).toList
      geocode := n.geocodeAt lat lon
      samples := (ctx.map (·.1)).getD [] }
    (stay.map fun (s, e, _) =>
      ({ startUnix := s, endUnix := e, localHour := (ctx.map (·.2)).getD 0 } :
        Verified.Geo.VenuePrior.StayShape))
    n.priors preferResidential

private def parseChain (j : Json) (segs : Array Seg)
    (points : Array Shed.PointF) (display : Array Verified.Geo.WalkAnnotate.PedFix) :
    Except String Verified.Geo.DayChain.Env := do
  let namer ← namerOf j
  return {
    segments := segs
    points := points.map fun p => ⟨p.ts, p.lat, p.lon, p.speedKmh⟩
    displayFixes := display.map fun p => ⟨p.ts, p.lat, p.lon⟩
    morningFixes := (← (← optArr j "morningFixes").mapM parseStayFix).toList
    prevEveningFixes := (← (← optArr j "prevEveningFixes").mapM parseStayFix).toList
    stayPlaces := (← (← optArr j "stayPlaces").mapM parseStayPlace).toList
    dwellPlaces := ← (← optArr j "dwellPlaces").mapM parseDwellPlace
    sleep := (← (← optArr j "rawSleep").mapM parseRawSleep).toList
    dayEndTs := (← optInt j "dayEndTs").getD 0
    -- `bestPlace(preferResidential: true)` composed with `placeLabel`, computed
    -- rather than injected as of #430. No stay window: the sleep attribution
    -- asks about a centroid, not about a visit.
    sleepPlace := fun lat lon => (namer.name lat lon none true).map (·.label)
  }

private def parseEnv (j : Json) : Except String Env := do
  let lk := (j.getObjVal? "lookups").toOption.getD (Json.mkObj [])
  let stations := mkMap (← (← optArr lk "nearbyStations").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parseStation)))
  let lines := mkMap (← (← optArr lk "linesAtPoint").mapM (entry3 strs))
  let ways := mkMap (← (← optArr lk "nearbyWays").mapM
    (entry2 (fun v => do (← v.getArr?).mapM parseWay)))
  let stops := mkMap (← (← optArr lk "transitStops").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parseTransitStop)))
  let onLine := mkMap (← (← optArr lk "stationsOnLine").mapM
    (entryS (fun v => do (← v.getArr?).mapM parseLineStation)))
  let tz := mkMap (← (← optArr lk "tzAt").mapM (entry2 (·.getStr?)))
  let namer ← namerOf j
  -- Not under `lookups`: these two are columns and a derived series, not
  -- questions put to the OSM mirror, so a miss in them is not a capture gap.
  let days := mkMap (← (← optArr j "focusPlaceDays").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← (← nth a 1).getInt?)))
  let speeds := mkMap (← (← optArr j "speedByTs").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← jBits (← nth a 1))))
  -- Bound rather than inlined: the Kalman track is both an `Env` field and the
  -- window the re-enrichment closure samples, and those must be the same series.
  let pts ← (← optArr j "points").mapM parsePointF
  let waysAt := fun lat lon => hit ways "nearbyWays" (k2 lat lon)
  -- `enrichMovingSegment` reads only the city fields, so the full response is
  -- narrowed here rather than at the table.
  let geocodeAt := fun (lat lon : Float) (zoom : Int) =>
    (namer.geocodeAt lat lon zoom).map (·.address)
  return {
    points := pts
    rawFixes := ← (← optArr j "rawFixes").mapM parseCoarse
    steps := ← (← optArr j "steps").mapM parseStep
    railStops := ← (← optArr j "railStops").mapM parseRailStops
    nearbyStations := fun lat lon r => hit stations "nearbyStations" (k3 lat lon r)
    linesAtPoint := fun lat lon r => hit lines "linesAtPoint" (k3 lat lon r)
    nearbyWays := waysAt
    -- `reenrichSplitWalks` re-derives one carve remainder's enrichment from its
    -- OWN geometry. `samplesInWindow` is inclusive at both ends, and an empty
    -- window is `none` — which the pass reads as "leave the leg as it stands",
    -- the same answer the TS's `if (segPoints.length === 0) return` gives.
    reenrich := fun seg =>
      Verified.Geo.Enrich.enrichMovingSegment waysAt geocodeAt seg
        ((pts.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs).map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt))
    -- Computed, not injected, as of #430 — see `Verified.Geo.BestPlace`.
    bestPlace := fun lat lon s e m => namer.name lat lon (some (s, e, m)) false
    tzAt := fun lat lon => hit tz "tzAt" (k2 lat lon)
    homeTz := ← (← j.getObjVal? "homeTz").getStr?
    stationsOnLine := fun line => hit onLine "stationsOnLine" line
    railRouteCache := ← (← optArr j "railRouteCache").mapM parseRouteRow
    busRouteCache := (← (← optArr j "busRouteCache").mapM parseBusRoute).toList
    transitStops := fun lat lon r => hit stops "transitStops" (k3 lat lon r)
    hmmDecode := ← (← optArr j "hmmDecode").mapM parseHmmSeg
    hsmmPlaces := (← (← optArr j "hsmmPlaces").mapM parseHsmmPlace).toList
    knownPlaces := ← (← optArr j "knownPlaces").mapM parseKnownPlace
    focusPlaceDays := fun id => days[toString id]?
    hr := (← (← optArr j "hr").mapM parseHr).toList
    sleep := (← (← optArr j "sleep").mapM parseSleep).toList
    displayFixes := ← (← optArr j "displayFixes").mapM parsePedFix
    speedByTs := fun ts => speeds[toString ts]?
  }

/-! ### Encoding -/

private def jOptS : Option String → Json
  | none => Json.null
  | some s => Json.str s

private def jOptF : Option Float → Json
  | none => Json.null
  | some f => fBits f

private def jOptI : Option Int → Json
  | none => Json.null
  | some i => Lean.toJson i

private def pathJson (p : Array Verified.Geo.PathPt) : Json :=
  Json.arr (p.map fun q => Json.arr #[fBits q.lat, fBits q.lon, fBits q.ts])

private def biomJson (b : Verified.Geo.SegmentMerge.BiometricEnrichment) : Json :=
  Json.mkObj [
    ("hrMean", jOptF b.hrMean), ("hrMin", jOptF b.hrMin), ("hrMax", jOptF b.hrMax),
    ("hrStd", jOptF b.hrStd), ("sampleCount", Lean.toJson b.sampleCount),
    ("overlapsSleep", Json.bool b.overlapsSleep), ("sleepFraction", fBits b.sleepFraction),
    ("stepsTotal", jOptF b.stepsTotal)]

private def segJson (s : Seg) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("refinedMode", jOptS s.refinedMode),
    ("confidence", fBits s.confidence), ("confidenceMargin", fBits s.confidenceMargin),
    ("avgSpeed", fBits s.avgSpeed), ("maxSpeed", fBits s.maxSpeed),
    ("linearity", fBits s.linearity), ("pointCount", Lean.toJson s.pointCount),
    ("place", jOptS s.place), ("city", jOptS s.city), ("wayName", jOptS s.wayName),
    ("refinedReason", jOptS s.refinedReason),
    ("refinedKinds", Json.arr (s.refinedKinds.map Json.str)),
    ("centroidLat", jOptF s.centroidLat), ("centroidLon", jOptF s.centroidLon),
    ("focusPlaceId", jOptI s.focusPlaceId),
    ("needsReenrich", Json.bool s.needsReenrich),
    ("vehicleKind", jOptS s.vehicleKind),
    ("roadCorridorFraction", jOptF s.roadCorridorFraction),
    ("displayTz", jOptS s.displayTz),
    ("snappedPath", match s.snappedPath with | none => Json.null | some p => pathJson p),
    ("matchedPath", match s.matchedPath with | none => Json.null | some p => pathJson p),
    ("walkMatchedPath", match s.walkMatchedPath with | none => Json.null | some p => pathJson p),
    ("walkSmoothedPath", match s.walkSmoothedPath with | none => Json.null | some p => pathJson p),
    ("biometrics", match s.biometrics with | none => Json.null | some b => biomJson b)]

private def stateJson (s : Verified.Geo.DayState.DayState) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("place", jOptS s.place), ("wayName", jOptS s.wayName),
    ("asleep", match s.asleep with | none => Json.null | some b => Json.bool b),
    ("tz", jOptS s.tz), ("minutesAsleep", jOptI s.minutesAsleep),
    ("inferred", match s.inferred with | none => Json.null | some b => Json.bool b)]

private def episodeJson (e : Verified.Geo.EpisodeGeometry.Episode) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson e.startTs), ("endTs", Lean.toJson e.endTs),
    ("mode", Json.str e.mode), ("kind", Json.str e.kind), ("place", jOptS e.place),
    -- `ts` rides as bits like its `lat`/`lon` siblings: it is a `Float` now
    -- (#420), and a derived vertex's is fractional, so a JSON number would round
    -- at the boundary the bit encoding exists to avoid. Nothing decodes this
    -- payload yet — the day chain has no serving path (#431) — so a consumer
    -- must read `ts` as bits when one is written.
    ("points", Json.arr (e.points.map fun p =>
      Json.mkObj [("lat", fBits p.lat), ("lon", fBits p.lon), ("ts", jOptF p.ts)]))]

/-- The passes whose output differs from what they were handed — computed from
the trace rather than declared, so it cannot drift from what ran. This is the
witness question at real-day scale: `PassFold.unwitnessed` names the 11 passes
no synthetic day reaches, and a corpus day that fires one retires it. -/
private def changedPasses (input : Array Seg) (trace : Array (String × Array Seg)) : Array String :=
  Id.run do
    let mut prev := input
    let mut out := #[]
    for (name, segs) in trace do
      if segs != prev then out := out.push name
      prev := segs
    return out

/-- The `Env` fields this mode does not feed. Their `Env` defaults are no-ops, so
a pass that needs one runs but decides nothing. Named in the output rather than
left to be inferred from a divergence: an unfed callback and a real disagreement
are different findings, and a parity run that cannot tell them apart reports the
wrong one.

Both entries are SOLVERS — the road and pedestrian matchers, whose street-network
reads and search leaves are 4.31 MiB/day the wire measurement deliberately left
shell-side. `reenrich` was here too and is not any more: it was an OSM read plus
arithmetic, which is a port (`Verified.Geo.Enrich`), not a shell. -/
private def UNFED : Array String := #["roadEnv", "walkEnv"]

/-- `walkDraw` and `walkFlags` stay at their `Env` defaults — `.matcher`, which
is what production draws, and no flags, which is the request without
`walkMatch=0`. Not in `UNFED` because they are configuration rather than a
callback: the fold gets the production answer, not an empty one. -/

def dayResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let wantTrace ← optBool j "trace" false
    -- ONE input, and one chain from here to the episodes (#430 B2). It used to be
    -- two — the OSM enrichment stage ran between the splits and the corrections
    -- and was not ported, so the corrections had to start from what the TS arm
    -- handed them. `EnrichFold` closed that gap and the day gate measured the
    -- new boundary green on all 33 golden days before this line was joined up.
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let splitCtx : Stays.SplitContext :=
      { hr := (env.hr.map fun h => ⟨h.ts, h.bpm⟩).toArray
        steps := env.steps.map fun s => ⟨s.ts, s.steps⟩ }
    let segsSplit := Verified.Geo.SplitFold.splitFold env.points splitCtx segsRaw
    -- The OSM enrichment stage itself, the piece that used to be the gap between
    -- the two sub-chains (#430 B2). Chained on both sides now.
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        -- The naming arms read the whole response; the moving arm reads only the
        -- city fields, so the narrowing happens here rather than at the table.
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    let segsEnriched := Verified.Geo.EnrichFold.enrichFold enrichReads
      { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
        steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
      (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
      env.points segsSplit
    -- The five corrections that run between the OSM enrichment stage and pass 1
    -- (#430). Same argument as the fold's: they are one stage because the order
    -- is what is being measured — `revertIsolatedCadence` exists to undo the
    -- pass before it, so a shell that re-imposed the sequence would put the
    -- thing under test outside the test. Their observations are the fold's own
    -- `steps` and `hr`, which is why only `modeStats` was added to the wire.
    let segs := Verified.Geo.PreFold.preFold env.biomSteps env.hr modeStats segsEnriched
    let (out, trace) := Verified.Geo.PassFold.runPassesTraced env segs
    -- The fold's output is the chain's input, which is the whole reason these
    -- run in one call rather than two: a second bridge crossing would have to
    -- ship the segments back out and in again, and the two arms could then be
    -- compared against different segment lists without anything saying so.
    let chain ← parseChain envJson out env.points env.displayFixes
    let (states, episodes) := Verified.Geo.DayChain.dayChain chain
    let base := [
      -- The split stage's output — the earliest boundary, and the only one whose
      -- input is not another Lean stage's output.
      ("segsSplit", Json.arr (segsSplit.map segJson)),
      -- The enrichment stage's output — the boundary that used to be the seam.
      ("segsEnriched", Json.arr (segsEnriched.map segJson)),
      -- The corrections' output — the BOUNDARY the chain used to start at. Sent
      -- back so a divergence in the five stages is named where it happens
      -- rather than read off the fold's output dozens of decisions later.
      ("segsMid", Json.arr (segs.map segJson)),
      ("segs", Json.arr (out.map segJson)),
      ("states", Json.arr (states.map stateJson)),
      ("episodes", Json.arr (episodes.map episodeJson)),
      ("passes", Json.arr ((Verified.Geo.PassFold.passNames env).map Json.str)),
      ("changed", Json.arr ((changedPasses segs trace).map Json.str)),
      ("unfed", Json.arr (UNFED.map Json.str))]
    return Json.mkObj (if !wantTrace then base else base ++ [
      ("trace", Json.arr (trace.map fun (name, segs) =>
        Json.mkObj [("name", Json.str name), ("segs", Json.arr (segs.map segJson))]))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ### The decode ablation (#433)

#405 measured a bridge call as four layers — request wire, response wire,
per-mode decode, algorithm — and only the last survives the Rust-shell
architecture, where the two arms are one process and there is nothing to
serialise. It also recorded that measuring with `noop` ALONE gets the answer
wrong in the reassuring direction, because `{}` as a reply hides both the
response wire and the decode; on gpsquality that mistake read the floor as a
quarter of the call when it was seven eighths.

`gpsquality` has `gqdecode` for its layer 3. The day mode had nothing, so
`lean/experiments/day-arm-cost.mts` could only report `fold − noop`, which is
layers 2+3+4 added together and therefore an upper bound on the residual rather
than the residual.

This is layer 3: `dayResult`'s parse prefix, and then stop. -/

/-- Force a two-key lookup table by asking it something it CAN answer.

The probe is not decoration. `parseEnv` binds each table's entries with `←`, so
the per-entry parse is forced by the `Except` bind — but `mkMap` on the result is
a plain pure `let` whose only consumers are the closures stored in `Env`, and the
compiler is free to sink such a `let` to its use site (`Main.lean`'s decode-timing
note records the same behaviour biting a timestamp). Whether the hash maps are
built during `parseEnv` or on the fold's first lookup could not be settled by
reading, and a layer measurement that skipped the work it claims to measure would
be worse than none, because it would be quoted.

So each table is asked for the key of its own FIRST entry — a hit, so no `panic!`
fires and no miss-formatting cost enters the measurement — and the answer's size
is folded into the reply, which is what forces it. An empty table has nothing to
build and contributes zero. -/
private def probe2 (lk : Json) (name : String) (f : Float → Float → α) (sz : α → Nat) :
    Except String Nat := do
  match (← optArr lk name)[0]? with
  | none => return 0
  | some e =>
    let a ← e.getArr?
    return sz (f (← jBits (← nth a 0)) (← jBits (← nth a 1)))

/-- As {@link probe2}, for the tables keyed by a radius as well as a coordinate. -/
private def probe3 (lk : Json) (name : String) (f : Float → Float → Float → α) (sz : α → Nat) :
    Except String Nat := do
  match (← optArr lk name)[0]? with
  | none => return 0
  | some e =>
    let a ← e.getArr?
    return sz (f (← jBits (← nth a 0)) (← jBits (← nth a 1)) (← jBits (← nth a 2)))

/-- Layer 2: run the WHOLE chain and return a summary instead of the rows.

`day − dayresp` is the response side — the six `Json.arr (… .map …Json)` AST
builds, `resp.compress`, the wire, and the caller's `JSON.parse`. `dayresp −
daydecode` is then the algorithm alone, which is what `#433` set out to isolate:
the 3.4 s the earlier measurement attributed to "response wire + algorithm,
unseparated" splits here.

`echo` cannot serve this tenant. Its reply is COMPUTED, so there is no input row
to ship back at realistic size — which is why this mode runs the real chain and
withholds only the encode.

# The forcing argument, and why it is CHECKED rather than argued

A handler returning only `changed` would be wrong in a way that looks fine.
`changedPasses segs trace` forces the pass fold, but `let (states, episodes) :=
dayChain chain` is a pure `let` whose result would then go unused — dead-code
elimination removes the call, and the handler would time the fold while claiming
to time the chain.

So the reply carries INTEGER CHECKSUMS over the same values the encoders read:
the timestamp sums and the vertex count. Those cannot be produced without
running the chain, and — the part that matters — they are recomputable from the
full `day` reply, so `day-arm-cost.mts` ASSERTS the two agree instead of
inferring it from a plausible-looking duration. A chain that silently did not
run reads as a mismatch, not as a fast number.

Two admitted biases, both in the same direction as every other choice in this
harness (against the port): the checksum folds are work `day` does not do, and
`passes`/`unfed` are not built here. Both make `dayresp` slower than a pure
"chain without encode", so they UNDERSTATE layer 2 and OVERSTATE the residual. -/
def chainNoEncode (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let splitCtx : Stays.SplitContext :=
      { hr := (env.hr.map fun h => ⟨h.ts, h.bpm⟩).toArray
        steps := env.steps.map fun s => ⟨s.ts, s.steps⟩ }
    let segsSplit := Verified.Geo.SplitFold.splitFold env.points splitCtx segsRaw
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    let segsEnriched := Verified.Geo.EnrichFold.enrichFold enrichReads
      { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
        steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
      (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
      env.points segsSplit
    let segs := Verified.Geo.PreFold.preFold env.biomSteps env.hr modeStats segsEnriched
    let (out, trace) := Verified.Geo.PassFold.runPassesTraced env segs
    let chain ← parseChain envJson out env.points env.displayFixes
    let (states, episodes) := Verified.Geo.DayChain.dayChain chain
    let tsSum (a : Array Seg) : Int := a.foldl (fun acc s => acc + s.startTs + s.endTs) 0
    return Json.mkObj [
      ("nSplit", Lean.toJson segsSplit.size),
      ("nEnriched", Lean.toJson segsEnriched.size),
      ("nMid", Lean.toJson segs.size),
      ("nSegs", Lean.toJson out.size),
      ("nStates", Lean.toJson states.size),
      ("nEpisodes", Lean.toJson episodes.size),
      ("nChanged", Lean.toJson (changedPasses segs trace).size),
      ("sumSegTs", Lean.toJson (tsSum out)),
      ("sumStateTs", Lean.toJson (states.foldl (fun acc s => acc + s.startTs + s.endTs) (0 : Int))),
      ("sumEpisodeTs", Lean.toJson (episodes.foldl (fun acc e => acc + e.startTs + e.endTs) (0 : Int))),
      ("nEpisodePoints", Lean.toJson (episodes.foldl (fun acc e => acc + e.points.size) 0))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-- Layer 3: decode the request into the day's own structures and stop.

Mirrors `dayResult`'s parse prefix exactly — same calls, same order — and must
keep mirroring it. `parseChain` is deliberately absent: it takes the fold's
OUTPUT, so it cannot run before the fold and its cost belongs to whatever
handler runs the chain.

The reply is a count rather than `{}` so that the sizes cannot be optimised
away, and small so that layer 2 stays out of it. -/
def decodeOnly (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let places := (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
    let lk := (envJson.getObjVal? "lookups").toOption.getD (Json.mkObj [])
    -- FIVE of the eight maps. The three `namerOf` builds — `nearbyLandmarks`,
    -- `reverseGeocode`, `bestPlace` — are NOT probed, and the reason is a
    -- property of the miss policy rather than an oversight: every route to them
    -- from `Env` goes through `Namer.name`, which composes a landmark lookup
    -- with a geocode lookup and a stay-context lookup, and any of the three can
    -- reach a key this handler did not choose. A miss `panic!`s, and a `panic!`
    -- inside a timing handler both prints and formats its message — cost that
    -- would land in the number and did not come from the decode.
    --
    -- So their hash-map construction is attributed to whatever forces it first,
    -- which is the fold. That UNDERSTATES layer 3 and overstates the residual —
    -- the same direction as every other choice here, against the port.
    let n1 ← probe2 lk "nearbyWays" env.nearbyWays Array.size
    let n2 ← probe2 lk "tzAt" env.tzAt String.length
    let n3 ← probe3 lk "nearbyStations" env.nearbyStations Array.size
    let n4 ← probe3 lk "linesAtPoint" env.linesAtPoint Array.size
    let n5 ← probe3 lk "transitStops" env.transitStops Array.size
    -- The three `namerOf` tables — `nearbyLandmarks`, `reverseGeocode`,
    -- `bestPlace`. They used to be charged to the fold because the only route to
    -- them was `Namer.name`, which composes three lookups and can reach a key a
    -- probe did not choose; a miss `panic!`s, and a panic inside a timing
    -- handler both prints and formats. `Namer.sizes` removes the need to guess a
    -- key at all: it is a structure field, so building the `Namer` builds the
    -- maps. This moves real work out of the residual and into layer 3, which is
    -- where it belongs.
    let namer ← namerOf envJson
    let n := n1 + n2 + n3 + n4 + n5 + namer.sizes
    return Json.mkObj [("n", Lean.toJson
      (n + env.points.size + env.rawFixes.size + env.steps.size + env.displayFixes.size
        + env.railStops.size + env.railRouteCache.size + env.busRouteCache.length
        + env.hmmDecode.size + env.hsmmPlaces.length + env.knownPlaces.size
        + env.hr.length + env.sleep.length
        + modeStats.length + segsRaw.size + places.length))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Day

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

namespace Focus

open Verified.Geo.FocusPlaces
open Verified.Geo.FocusIdentity (ExistingPlace NewCluster matchClusters)
-- The tuple accessors live in `Day` (private, so same-file only, which this is).
open Day (optArr nth)

private def parseRawPoint (j : Json) : Except String RawPoint := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parseStay (j : Json) : Except String Stay := do
  let a ← j.getArr?
  return { startTs := ← (← nth a 0).getInt?, endTs := ← (← nth a 1).getInt?,
           centroidLat := ← jBits (← nth a 2), centroidLon := ← jBits (← nth a 3),
           pointCount := (← (← nth a 4).getInt?).toNat, durationSec := ← (← nth a 5).getInt? }

private def parseCluster (j : Json) : Except String Cluster := do
  let stays ← (← optArr j "stays").mapM parseStay
  return { id := ← (← j.getObjVal? "id").getInt?,
           centroidLat := ← jBits (← j.getObjVal? "lat"),
           centroidLon := ← jBits (← j.getObjVal? "lon"),
           stays := stays.toList,
           totalDwellSec := ← (← j.getObjVal? "dwell").getInt? }

private def parseWindow (j : Json) : Except String (Int × Int) := do
  let a ← j.getArr?
  return (← (← nth a 0).getInt?, ← (← nth a 1).getInt?)

private def parseExisting (j : Json) : Except String ExistingPlace := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), ← (← nth a 3).getInt?⟩

private def encStay (s : Stay) : Json :=
  Json.arr #[Lean.toJson s.startTs, Lean.toJson s.endTs, fBits s.centroidLat, fBits s.centroidLon,
             Lean.toJson s.pointCount, Lean.toJson s.durationSec]

/-- A cluster and everything the mining cron derives from it.

The hour profile is emitted BOTH serialised and re-parsed, because
`serializeHourProfile` rounds to permille: comparing only the string would let
`parseHourProfile` drift unseen, and comparing only the parse would hide a
rounding difference the column actually stores. -/
private def report (windows : List (Int × Int)) (c : Cluster) : Json :=
  let profile := serializeHourProfile (hourProfileOf c)
  Json.mkObj [
    ("id", Lean.toJson c.id),
    ("lat", fBits c.centroidLat),
    ("lon", fBits c.centroidLon),
    ("dwell", Lean.toJson c.totalDwellSec),
    ("stays", Json.arr ((c.stays.map encStay).toArray)),
    ("label", Json.str (classifyClusterLabel c)),
    ("profile", Json.str profile),
    ("reparsed", match parseHourProfile (some profile) with
      | none => Json.null
      | some xs => Json.arr ((xs.map fBits).toArray)),
    -- `hourProfileForRange` is the RUNTIME counterpart of `hourProfileOf` — it
    -- scores one live stay against a mined profile — so it is exercised on the
    -- cluster's own first stay rather than left to the guards.
    ("firstStayProfile", match c.stays.head? with
      | none => Json.null
      | some s => Json.str (serializeHourProfile (hourProfileForRange s.startTs s.endTs c.centroidLon))),
    ("sleepH", fBits (sleepHoursOf c)),
    ("sleepFitbitH", fBits (sleepHoursFromFitbit c.stays windows)),
    ("uniqueDays", Lean.toJson (uniqueDayCount c.stays c.centroidLon))]

def focusResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let windows := (← (← optArr j "sleepWindows").mapM parseWindow).toList
    let points := (← (← optArr j "points").mapM parseRawPoint).toList
    let (stays, mined) := detectFocusPlaces points
    let groups ← (← optArr j "clusters").mapM parseCluster
    let old ← (← optArr j "old").mapM parseExisting
    let identity := matchClusters old
      ((mined.map (fun c => ({ centroidLat := c.centroidLat, centroidLon := c.centroidLon } : NewCluster))).toArray)
    return Json.mkObj [
      ("stays", Json.arr ((stays.map encStay).toArray)),
      ("mined", Json.arr ((mined.map (report windows)).toArray)),
      ("names", Json.arr (((assignDisplayNames mined).map
        (fun (id, n) => Json.arr #[Lean.toJson id, Json.str n])).toArray)),
      -- One entry per input cluster: the lobes `splitCluster` returned, which is
      -- the cluster itself when it refused to split.
      ("split", Json.arr (groups.map (fun c => Json.arr (((splitCluster c).map (report windows)).toArray)))),
      ("identity", Json.mkObj [
        ("assignments", Json.arr (identity.assignments.map (fun a =>
          match a.oldId with | none => Json.null | some i => Lean.toJson i))),
        ("deleted", Json.arr (identity.deletedOldIds.map Lean.toJson))])]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Focus

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

private def scOptStr (j : Json) (k : String) : Except String (Option String) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> v.getStr?

private def parseChainNode (j : Json) : Except String ChainNode := do
  let name : Option String := match (j.getObjVal? "stationName" >>= (·.getStr?)) with
    | .ok s => some s | .error _ => none
  let edgeIds ← (← (← j.getObjVal? "edgeIds").getArr?).mapM (·.getStr?)
  return ⟨← (← j.getObjVal? "id").getStr?, ← jFloatField j "lat", ← jFloatField j "lon",
    name, edgeIds.toList⟩

private def parseChainSeg (j : Json) : Except String ChainSeg := do
  return { mode := ← (← j.getObjVal? "mode").getStr?
           lineName := ← scOptStr j "lineName"
           startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt? }

private def parseRelation (j : Json) :
    Except String Verified.Hsmm.ServedStations.RailStopRelation := do
  let stops ← (← (← j.getObjVal? "stops").getArr?).mapM fun s => do
    pure (⟨← scOptStr s "name"⟩ : Verified.Hsmm.ServedStations.RailStop)
  return ⟨← scOptStr j "lineRef", ← scOptStr j "lineName", stops⟩

private def optJson : Option String → Json
  | none => Json.null
  | some s => Json.str s

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
      Json.arr #[Lean.toJson r.1, optJson r.2.board, optJson r.2.alight])))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end StationChain

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
        | .ok "assembledecode" => assembleDecodeResult j
        | .ok "coverage" => coverageResult j
        | .ok "kalman" => kalmanResult j
        | .ok "gpsquality" => gpsQualityResult j
        | .ok "biolabels" => bioLabelsResult j
        | .ok "day" => Day.dayResult j
        | .ok "focus" => Focus.focusResult j
        | .ok "stationchain" => StationChain.stationChainResult j
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
  if args.contains "assembledecode" then return ← runOne assembleDecodeResult input
  if args.contains "coverage" then return ← runOne coverageResult input
  if args.contains "kalman" then return ← runOne kalmanResult input
  if args.contains "gpsquality" then return ← runOne gpsQualityResult input
  if args.contains "biolabels" then return ← runOne bioLabelsResult input
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
