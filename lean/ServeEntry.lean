import Verified
import DayEntry
import BackendEntry
import Lean.Data.Json
import ServeEntry.Gates
import Verified.RestHr

/-!
# `ServeEntry` — the mode table `verified_cli serve` dispatches on

One NDJSON request per line in, one reply per line out (`serveLoop`); mid-request
the day fold may put questions of its own on the same pipe (`DayEntry.Host`).
The Rust backend keeps these processes alive, and every Lean decision it makes
crosses here.
-/

/-!
# `verified_cli` — JSON decode interface

Reads one HSMM problem as JSON on stdin, decodes it with `sDecode` (proved equal
to the specification's `decode`, `sDecode_eq`), and writes the result as JSON
on stdout. Scores are parsed straight into the packed encoding (`enc`: `-∞ ↦ 0`,
`v ↦ v + 2^61`), and inputs outside the proven envelope are refused: `|v| ≤
2^49` for emissions, `|v| ≤ 2^45` for the other tensors, `T ≤ 2048`.

Input shape (all scores integers; `null` = `-∞`):
  {
    "T": 30, "S": 4, "maxD": 6,
    "emit":  [[..S]  × T],          // emit[t][s]
    "trans": [[..S] × S]            // trans[from][to], time-constant …
           | [[[..S] × S] × T],     // … or trans[t][from][to] per destination t
    "transOv": [[from,to,[..T]]]?,  // per-t rows overriding the base matrix
    "dur":   [[..maxD] × S],        // dur[s][d-1]
    "durOverrides": [[s,d,e,v]]?,   // sparse per-segEnd exceptions (v null = -∞)
    "durClass": [..S]?,             // + "durDelta": state s pays
    "durDelta": [[[[v,len]..] × maxD]]?, //   dur[s][d-1] + durDelta[durClass[s]][d-1][e],
                                    //   run-length-encoded over e
    "init":  [..S]?,                // absent → 0 (uniform)
    "entry": [[..S] × T]?           // absent → 0
  }

`durOverrides` and `durClass`/`durDelta` are mutually exclusive.

Output: {"path": [..T], "best": n}
      | {"degenerate": true}       // every path scores -∞
      | {"error": "..."}           (exit 1)

## Rail mode (`verified_cli rail`)

Shortest path over a rail graph given as its adjacency structure, with
×2²⁰-quantised nonnegative integer weights. Entry order per vertex decides
ties. `Nat` weights are exact at any magnitude, so there is no envelope.

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

/-- `enc Score.zero`: the default for absent `init`/`entry` tensors. -/
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
    for (r, i) in transRows.zipIdx do
      for (v, t) in r.zipIdx do
        if t < T then a := a.set! (i * T + t) v
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
    let tri := Verified.Hsmm.triOff maxD T
    let mut a := Array.replicate (nC * tri) halfOB
    for (cls, c) in durDelta.zipIdx do
      for (runs, d0) in cls.zipIdx do
        if d0 < maxD then
          let mut e := 0
          for (v, len) in runs do
            for _ in [0:len] do
              if d0 ≤ e && e < T then
                a := a.set! (c * tri + Verified.Hsmm.triOff maxD e + d0) v
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

/-- `verified_cli matchprof` input: fixes (`[la, lo, ts]`), ways, buildings. -/
private def parseMatch (j : Json) :
    Except String (Array Verified.Geo.QPt × Array Verified.Geo.QWay ×
      Array (Array Verified.Geo.QPt)) := do
  let fixes ← parsePts (← j.getObjVal? "fixes")
  let ways ← parseWays (← j.getObjVal? "ways")
  let buildings ← parseBuildings (← j.getObjVal? "buildings")
  return (fixes, ways, buildings)

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
    let bld : Option Verified.Geo.QBuildings ← IO.lazyPure fun _ =>
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
    -- Two more, splitting the buildings penalty: footprints reduced to their
    -- boxes (a 4-vertex ray cast), and no fixes (no support scan).
    let _ ← IO.lazyPure fun _ =>
      match bld with
      | some b =>
        let boxRings := b.boxes.map fun (bx : Verified.Geo.QBox) => #[
          ({ la := bx.minLa, lo := bx.minLo, ts := 0 } : Verified.Geo.QPt),
          { la := bx.minLa, lo := bx.maxLo, ts := 0 },
          { la := bx.maxLa, lo := bx.maxLo, ts := 0 },
          { la := bx.maxLa, lo := bx.minLo, ts := 0 }]
        (Verified.Geo.buildQGraphFast ways co (some { b with rings := boxRings })
          P.gapBridgeUm).segments.size
      | none => 0
    let t3e ← IO.monoMsNow
    let _ ← IO.lazyPure fun _ =>
      match bld with
      | some b =>
        (Verified.Geo.buildQGraphFast ways co (some { b with fixes := #[] }) P.gapBridgeUm).segments.size
      | none => 0
    let t3f ← IO.monoMsNow
    let t4 ← IO.monoMsNow
    let obs ← IO.lazyPure fun _ =>
      fixes.foldl (init := (#[] : Array Verified.Geo.QObs)) fun acc f =>
        let cands := Verified.Geo.qCandidatesForFixFast f graph idx P.radiusUm P.maxCandidatesPerFix
        if cands.size == 0 then acc else acc.push { fix := f, cands }
    let nCand := obs.foldl (init := 0) fun acc o => acc + o.cands.size
    let t5 ← IO.monoMsNow
    -- Phase A of `qMatchTrajectory`, replayed here on its own: the route matrix
    -- over the same candidates, in the same `(t, j, i)` order, with the same
    -- per-layer cache pruning. Its cost is the route searches'.
    let (nRoutes, nSources, nSettled) ← IO.lazyPure fun _ => Id.run do
      let mut maxStep : Nat := 0
      for i in [1:obs.size] do
        let d := Verified.Geo.qDist (obs.getD (i - 1) default).fix (obs.getD i default).fix
        if d > maxStep then maxStep := d
      let maxR := (maxStep * P.detourFactor + P.detourSlackUm) * P.corridorMaxPenalty * co.S
      let n := graph.vertices.size
      let fuel := Verified.Geo.totalOut graph.g + 1
      let mut routeCache : Verified.Geo.RouteCache := Array.replicate n none
      let mut nRoutes := 0
      let mut sources : Std.HashSet Nat := ∅
      let mut nSettled := 0
      for t in [1:obs.size] do
        let prev := obs.getD (t - 1) default
        let cur := obs.getD t default
        for j in [0:cur.cands.size] do
          for i in [0:prev.cands.size] do
            let (_, rc) := Verified.Geo.qRouteBetween (prev.cands.getD i default)
              (cur.cands.getD j default) graph bld co.S maxR fuel routeCache
            routeCache := rc
            nRoutes := nRoutes + 1
        for c in prev.cands do
          let s := graph.segments.getD c.si default
          sources := (sources.insert s.u).insert s.v
        let keep : Array Nat := cur.cands.foldl (init := #[]) fun acc c =>
          let s := graph.segments.getD c.si default
          (acc.push s.u).push s.v
        for i in [0:n] do
          match routeCache.getD i none with
          | some st => if !keep.contains i then nSettled := nSettled + st.done.foldl (fun k d => if d then k + 1 else k) 0
          | none => pure ()
        routeCache := routeCache.mapIdx fun i o => if keep.contains i then o else none
      for st? in routeCache do
        match st? with
        | some st => nSettled := nSettled + st.done.foldl (fun k d => if d then k + 1 else k) 0
        | none => pure ()
      return (nRoutes, sources.size, nSettled)
    let t5b ← IO.monoMsNow
    let full ← IO.lazyPure fun _ => Verified.Geo.qMatchWalkSegment fixes ways buildings
    let t6 ← IO.monoMsNow
    -- The float-side badness context the drawing builds around the matcher
    -- (`makeBadnessCtx`: the way grid and the footprint boxes), on this input.
    let fpt := fun (q : Verified.Geo.QPt) => Verified.Geo.WalkMatchAdapt.fromQ q
    let fways : Verified.Geo.WalkableRoute.Ways := ways.map fun w => w.coords.map fun q => (fpt q).pt
    let fbld : Array Verified.Geo.WalkEscape.Ring := buildings.map fun r => r.map fun q => (fpt q).pt
    let _ ← IO.lazyPure fun _ =>
      (Verified.Geo.WalkEscape.makeBadnessCtx fways fbld {}).ring.footprints.size
    let t7 ← IO.monoMsNow
    let _ ← IO.lazyPure fun _ => (Verified.Geo.WalkableRoute.buildWalkGraph fways).nodes.size
    let t8 ← IO.monoMsNow
    IO.println s!"badness-ctx={t7 - t6}ms walk-graph={t8 - t7}ms"
    IO.println s!"fixes={fixes.size} ways={ways.size} rings={buildings.size} \
vertices={graph.vertices.size} segments={graph.segments.size} \
edges={Verified.Geo.totalOut graph.g} chords={co.chords.size} cands={nCand} \
routes={nRoutes} sources={nSources} settled={nSettled} matched={full.isSome}"
    IO.println s!"corridor={t1 - t0}ms buildings={t2 - t1}ms graph={t3 - t2}ms \
segidx={t3b - t3}ms cands={t5 - t4}ms routes={t5b - t5}ms full={t6 - t5b}ms"
    IO.println s!"graph-no-buildings={t3c - t3b}ms graph-no-corridor={t3d - t3c}ms \
graph-box-rings={t3e - t3d}ms graph-no-fixes={t3f - t3e}ms"
    let stat (name : String) (g : Std.HashMap Nat (Array Nat)) : String :=
      let tot := g.fold (init := 0) fun a _ v => a + v.size
      let mx := g.fold (init := 0) fun a _ v => max a v.size
      s!"{name}: cells={g.size} filed={tot} mean={tot / max 1 g.size} max={mx}"
    IO.println (stat "corridor-grid" co.grid)
    IO.println (stat "segment-grid" idx.grid)
    match bld with
    | some b => IO.println (stat "building-grid" b.grid)
    | none => pure ()
    return (0 : UInt32)

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

/-! ## Assembling the model

Build the HSMM model FROM PARSED INPUTS in Lean (`Verified.Hsmm.Assemble`).
Input is the post-boundary structured day (past the tz / WKT / `toFixed`
boundary the shell owns): the observation tensor, the parsed route edges, the
focus places, the train-generator coverage map, continuity, and the C4 flags.

  { "maxD": n,
    "obs": [{ts, gps:{lat,lon,speedKmh}|null, hr, cadence, hourLocal, dayOfWeekLocal,
              inBed, roadDistM, railDistM, prevGpsFix, nextGpsFix}],
    "edges": [{id, geometry:[{lat,lon}], lineMemberships:[str], underground, startNode, endNode}],
    "places": [{id, name, lat, lon, hourProfile:[num]|null, dwell}],
    "coverage": [[ts, [lines]]],                         // ts → generator-vouched lines
    "continuity": {priorPlaceId, priorPlaceCoord:[lat,lon]|null, hoursSince, priorPosterior}|null,
    "flags": {chainContext, segEmission, …} }
 -/

private def parseObsRow (j : Json) : Except String Verified.Hsmm.Observation.ObsRow := do
  let gps : Option Verified.Hsmm.Observation.GpsAgg ←
    match j.getObjVal? "gps" with
    | .ok v => if v.isNull then pure none
               else pure (some ⟨← jFloatField v "lat", ← jFloatField v "lon", ← jFloatField v "speedKmh",
                                 ((v.getObjVal? "accuracyM") >>= (·.getNum?)).toOption.map (·.toFloat)⟩)
    | .error _ => pure none
  return {
    ts := ← (← j.getObjVal? "ts").getInt?, gps
    hr := ← jOptFloat j "hr", cadence := ← jOptFloat j "cadence"
    hourLocal := ← (← j.getObjVal? "hourLocal").getNat?
    dayOfWeekLocal := ← (← j.getObjVal? "dayOfWeekLocal").getNat?
    inBed := ← (← j.getObjVal? "inBed").getBool?
    roadDistM := ← jOptFloat j "roadDistM", railDistM := ← jOptFloat j "railDistM"
    prevGpsFix := ← parseOptFix j "prevGpsFix", nextGpsFix := ← parseOptFix j "nextGpsFix" }

/-- A station node for the chained-triple resolver: the same fields as
`parseStationNode`'s, a different record. Here rather than in `StationChain`
because `assemblesegments` runs the chain and needs it earlier. -/
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
    -- Coordinates are plain numbers in `stops_json`; absent or unreadable is
    -- unknown, which only silences the pass term.
    let coord := fun (k : String) => (t.getObjVal? k).toOption.bind (fun x => (jFloat x).toOption)
    pure ({ name := ← optStr t "name", lat := coord "lat", lon := coord "lon" }
      : Verified.Hsmm.ServedStations.RailStop)
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

The tensor is 1440 rows, built from small inputs: the day's fixes, three
biometric streams, and two per-minute lookup tables the shell resolves because
they are not pure (the local hour/day-of-week, a timezone; the road/rail
distances, an OSM query). So `assemblesegments` takes either a pre-built `obs`
array or the raw `observation`, which is what `decode-day` sends.
-/

private def parseGpsPoint (j : Json) : Except String Verified.Hsmm.Observation.GpsPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, lat := ← jFloatField j "lat"
         , lon := ← jFloatField j "lon", speedKmh := ← jFloatField j "speedKmh"
         , accuracyM := ((j.getObjVal? "accuracyM") >>= (·.getNum?)).toOption.map (·.toFloat) }

private def parseHrPoint (j : Json) : Except String Verified.Hsmm.Observation.HrPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, bpm := ← jFloatField j "bpm" }

private def parseStepPoint (j : Json) : Except String Verified.Hsmm.Observation.StepPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?, steps := ← jFloatField j "steps" }

private def parseSleepRec (j : Json) : Except String Verified.Hsmm.Observation.SleepRec := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
         , endTs := ← (← j.getObjVal? "endTs").getInt? }

/-- Build the tensor from raw materials.

`localCtx` and `proximity` are lookup tables (JSON has no functions):
`localCtx` is 1440 `[hourLocal, dayOfWeek]` pairs by minute; `proximity` is a
sparse list of `[minuteTs, roadDistM|null, railDistM|null]` for the minutes
with a fix. A minute missing from it is `(none, none)`, no evidence, not "far
from both". -/
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
    -- Either encoding (`jFloat`): bit patterns or numbers. Absent or null is
    -- "not known to be near either"; anything else malformed is an error.
    let dist : Json → Except String (Option Float) := fun x =>
      if x.isNull then pure none else some <$> jFloat x
    let road ← match a[1]? with | some x => dist x | none => pure none
    let rail ← match a[2]? with | some x => dist x | none => pure none
    pure ((← tsJ.getInt?), road, rail))
  let proxMap : Std.HashMap Int (Option Float × Option Float) :=
    proxPairs.foldl (fun m (t, r, l) => m.insert t (r, l)) {}
  return Verified.Hsmm.Observation.buildObservationTensor startUtc
    points.toList hr.toList steps.toList sleep.toList
    (fun m => ctxArr.getD m (0, 0))
    (fun ts => proxMap.getD ts (none, none))
    imputeCadence

/-- A Float zero for the record parser's branches (a literal there is a GMP call). -/
private def recordZero : Float := 0

private def parseAssemble (j : Json) : Except String (Verified.Hsmm.Assemble.ModelContext × Nat) := do
  -- `observation` wins when both are present: it is what the tensor would be
  -- built from anyway, so it cannot be stale.
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
      let cands := Verified.Hsmm.TrainCandidates.enumerateTrainCandidates sg obs Verified.Hsmm.Assemble.KNOWN_LINES
      -- Each window reaches back over the wait at its boarding station.
      let cands := cands.map (Verified.Hsmm.TrainCandidates.boardingWait sg obs)
      pure (Verified.Hsmm.TrainCandidates.buildCoverage cands obs)
  let continuity ← parseContinuity j
  let placeNearLine : Std.HashSet String ←
    match j.getObjVal? "placeNearLine" with
    | .ok v => if v.isNull then pure {} else do
        pure (Std.HashSet.ofList (← (← v.getArr?).mapM (·.getStr?)).toList)
    | .error _ => pure {}
  let flags ← j.getObjVal? "flags"
  -- Absent `maxD` is the model's own (`Verified.Hsmm.Assemble`), the trellis
  -- depth every caller must agree on.
  let maxD ← match j.getObjVal? "maxD" with
    | .ok v => if v.isNull then pure Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION else v.getNat?
    | .error _ => pure Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION
  -- A fitted parameter table (`examples/fit_emissions`), harness-only: each
  -- mode it names replaces the shipped prior and duration fit, the rest stay.
  let fitted := (flags.getObjVal? "fittedPriors").toOption.filter (!·.isNull)
  let row (sect : String) (m : Verified.Hsmm.Emissions.Mode) : Option (Array Float) := do
    let f ← fitted
    let arr ← ((f.getObjVal? sect) >>= (·.getObjVal? (Verified.Hsmm.StateSpace.modeName m)) >>= (·.getArr?)).toOption
    arr.mapM fun v => (v.getNum?).toOption.map (·.toFloat)
  -- `mainlineSpeed: [mean, std]` beside `modePriors`: the train's speed on
  -- `unknown_rail`, apart from the metro lines'.
  let mainline : Option (Float × Float) := do
    let f ← fitted
    let arr ← ((f.getObjVal? "mainlineSpeed") >>= (·.getArr?)).toOption
    match arr.toList.filterMap (fun v => (v.getNum?).toOption.map (·.toFloat)) with
    | [m, sd] => some (m, sd)
    | _ => none
  -- `speedStop: {mode: [share, std]}` (and `mainline`): the standstill
  -- component of a vehicle's windowed speed.
  let stop := fun (k : String) => (do
    let f ← fitted
    let arr ← ((f.getObjVal? "speedStop") >>= (·.getObjVal? k) >>= (·.getArr?)).toOption
    match arr.toList.filterMap (fun v => (v.getNum?).toOption.map (·.toFloat)) with
    | [share, sd] => some (share, sd)
    | _ => none : Option (Float × Float))
  let priorsOf := fun (m : Verified.Hsmm.Emissions.Mode) =>
    let base : Verified.Hsmm.Emissions.ModePrior := match row "modePriors" m with
      | some #[g, sm, ss, hm, hs, z, cm, cs] =>
        ⟨g, sm, ss, hm, hs, z, cm, cs, Verified.Hsmm.Emissions.MAINLINE_SPEED_MEAN,
         Verified.Hsmm.Emissions.MAINLINE_SPEED_STD, Verified.Hsmm.Emissions.NO_STOP_SHARE,
         Verified.Hsmm.Emissions.STOP_STD_DEFAULT, Verified.Hsmm.Emissions.NO_STOP_SHARE,
         Verified.Hsmm.Emissions.STOP_STD_DEFAULT⟩
      | _ => Verified.Hsmm.Emissions.modePriors m
    let base := match mainline with
      | some (mm, ms) => { base with mainlineSpeedMean := mm, mainlineSpeedStd := ms }
      | none => base
    let base := match stop (Verified.Hsmm.StateSpace.modeName m) with
      | some (sh, sd) => { base with stopShare := sh, stopStd := sd }
      | none => base
    match m, stop "mainline" with
    | .train, some (sh, sd) => { base with mainlineStopShare := sh, mainlineStopStd := sd }
    | _, _ => base
  -- Per-family term weights (harness-only): a name absent keeps the model's own.
  let d : Verified.Hsmm.EmissionFull.TermWeights := {}
  let tw (k : String) (dflt : Float) : Float :=
    match (flags.getObjVal? "termWeights" >>= (·.getObjVal? k) >>= (·.getNum?)) with
    | .ok n => n.toFloat
    | .error _ => dflt
  let weights : Verified.Hsmm.EmissionFull.TermWeights :=
    { base := tw "base" d.base, geometric := tw "geometric" d.geometric, gap := tw "gap" d.gap
      rail := tw "rail" d.rail, lineProximity := tw "lineProximity" d.lineProximity
      continuity := tw "continuity" d.continuity, entry := tw "entry" d.entry
      chain := tw "chain" d.chain, duration := tw "duration" d.duration }
  let fitsOf := fun (m : Verified.Hsmm.Emissions.Mode) =>
    match row "durationFits" m with
    | some #[a, b] => ({ alpha := a, beta := b, sampleCount := 10 } : Verified.Hsmm.Duration.GammaFit)
    | _ => Verified.Hsmm.Assemble.baselineFit m
  -- Both read once per mode here: the emissions ask them for every minute of
  -- every state, and as closures over the record each ask re-read its JSON
  -- (a third of the emission table's time, in GMP from the numbers' decoding).
  let modeIdx : Verified.Hsmm.Emissions.Mode → Nat := fun m => match m with
    | .stationary => 0 | .walking => 1 | .cycling => 2 | .driving => 3
    | .train => 4 | .plane => 5 | .unknown => 6
  let modeList : List Verified.Hsmm.Emissions.Mode :=
    [.stationary, .walking, .cycling, .driving, .train, .plane, .unknown]
  let priorsT := (modeList.map priorsOf).toArray
  let fitsT := (modeList.map fitsOf).toArray
  let priors := fun (m : Verified.Hsmm.Emissions.Mode) =>
    match priorsT[modeIdx m]? with | some p => p | none => priorsOf m
  let fits := fun (m : Verified.Hsmm.Emissions.Mode) =>
    match fitsT[modeIdx m]? with | some f => f | none => fitsOf m
  let mainlineFit : Option Verified.Hsmm.Duration.GammaFit := do
    let f ← fitted
    let arr ← ((f.getObjVal? "durationFits") >>= (·.getObjVal? "mainline") >>= (·.getArr?)).toOption
    match arr.toList.filterMap (fun v => (v.getNum?).toOption.map (·.toFloat)) with
    | [a, b] => some { alpha := a, beta := b, sampleCount := 10 }
    | _ => none
  -- The platform wait's duration (`durationFits.wait`), the journey's wait legs;
  -- a third number is its floor in minutes (the shortest narrated wait).
  let waitFitFloor : Option (Verified.Hsmm.Duration.GammaFit × Option Float) := do
    let f ← fitted
    let arr ← ((f.getObjVal? "durationFits") >>= (·.getObjVal? "wait") >>= (·.getArr?)).toOption
    match arr.toList.filterMap (fun v => (v.getNum?).toOption.map (·.toFloat)) with
    | [a, b] => some ({ alpha := a, beta := b, sampleCount := 10 }, none)
    | [a, b, m] => some ({ alpha := a, beta := b, sampleCount := 10 }, some m)
    | _ => none
  let waitFit := waitFitFloor.map (·.1)
  let waitMin := (waitFitFloor.bind (·.2)).getD (Verified.Hsmm.Duration.minDurationByMode .stationary)
  -- Segment-level emissions, the decoder record's `segEmission`: `{sigmaW,
  -- rho, modes: {mode: [hrMean, hrTau, fixA, fixB]}, …}`. Required: the
  -- decoder has no form without it.
  let segEm? : Option Verified.Hsmm.SegmentEmission.Params := do
    let f ← (flags.getObjVal? "segEmission").toOption.filter (!·.isNull)
    let num := fun (v : Json) => (v.getNum?).toOption.map (·.toFloat)
    let sigmaW ← num (← (f.getObjVal? "sigmaW").toOption)
    let rho ← num (← (f.getObjVal? "rho").toOption)
    let modes ← (f.getObjVal? "modes").toOption
    let all : List Verified.Hsmm.Emissions.Mode :=
      [.stationary, .walking, .cycling, .driving, .train, .plane]
    let disp := all.filterMap fun m => do
      let arr ← (((f.getObjVal? "disp") >>= (·.getObjVal? (Verified.Hsmm.StateSpace.modeName m)))
        >>= (·.getArr?)).toOption
      match arr.toList.filterMap num with
      | [mu, sigma, eps] => some (m, ({ mu, sigma, eps } : Verified.Hsmm.SegmentEmission.DispParams))
      | _ => none
    let uMaxKmh := ((f.getObjVal? "uMaxKmh").toOption.bind num).getD
      Verified.Hsmm.SegmentEmission.DEFAULT_U_MAX_KMH
    -- `unknown` is the journey's level (`Params.journey`), absent otherwise.
    let byMode := (all ++ [Verified.Hsmm.Emissions.Mode.unknown]).filterMap fun m => do
      let arr ← ((modes.getObjVal? (Verified.Hsmm.StateSpace.modeName m)) >>= (·.getArr?)).toOption
      match arr.toList.filterMap num with
      | [a, b, c, d] => some (m, ({ hrMean := a, hrTau := b, fixA := c, fixB := d } :
          Verified.Hsmm.SegmentEmission.ModeParams))
      | _ => none
    let speedEps := all.filterMap fun m => do
      let v ← ((f.getObjVal? "speedEps") >>= (·.getObjVal? (Verified.Hsmm.StateSpace.modeName m))).toOption
      pure (m, ← num v)
    let pairBoundaryMeanKmh := (f.getObjVal? "pairBoundaryMeanKmh").toOption >>= num
    let pairBoundaryEps := (f.getObjVal? "pairBoundaryEps").toOption >>= num
    let unlistedCentre := (f.getObjVal? "unlistedCentre").toOption >>= num
    let stayMove : Option (Float × Float) := do
      let arr ← ((f.getObjVal? "stayMove") >>= (·.getArr?)).toOption
      match arr.toList.filterMap num with
      | [aIn, pStay] => some (aIn, pStay)
      | _ => none
    let asleep : Option Verified.Hsmm.SegmentEmission.SleepParams := do
      let arr ← ((f.getObjVal? "asleep") >>= (·.getArr?)).toOption
      match arr.toList.filterMap num with
      | [hrMean, hrTau, sigmaW, rho] => some { hrMean, hrTau, sigmaW, rho }
      | [hrMean, hrTau, sigmaW, rho, diffSd] => some { hrMean, hrTau, sigmaW, rho, diffSd }
      | _ => none
    let obsChain := all.filterMap fun m => do
      let rows ← (((f.getObjVal? "obsChain") >>= (·.getObjVal? (Verified.Hsmm.StateSpace.modeName m)))
        >>= (·.getArr?)).toOption
      let mat := rows.filterMap fun r => (r.getArr?).toOption.map fun xs => xs.filterMap num
      if mat.size == 3 && mat.all (·.size == 3) then some (m, mat) else none
    -- `journey: {maxJ, firstLeg: {mode: p}, lastLeg: {mode: p}}`, the journey state's arm.
    let journey : Option Verified.Hsmm.SegmentEmission.JourneyParams := do
      let jj ← (f.getObjVal? "journey").toOption.filter (!·.isNull)
      let maxJ ← (jj.getObjVal? "maxJ" >>= (·.getNat?)).toOption
      let legs := fun (k : String) => all.filterMap fun m => do
        let v ← ((jj.getObjVal? k) >>= (·.getObjVal? (Verified.Hsmm.StateSpace.modeName m))).toOption
        let pr ← num v
        if pr > recordZero then pure (m, Float.log pr) else none
      let continueLog := match ((jj.getObjVal? "continue").toOption >>= num) with
        | some pr => if pr > recordZero then Float.log pr else Verified.FloatConst.negInf
        | none => Verified.FloatConst.negInf
      -- `stops: {piCall, piThrough, rate, mean, sd}`, the train legs' calling evidence.
      let stops : Option Verified.Hsmm.StopCalls.Params := do
        let sj ← (jj.getObjVal? "stops").toOption.filter (!·.isNull)
        let g := fun (k : String) => (sj.getObjVal? k).toOption >>= num
        pure { piCall := ← g "piCall", piThrough := ← g "piThrough", rate := ← g "rate",
               mean := ← g "mean", sd := ← g "sd" }
      pure { maxJ, firstLeg := legs "firstLeg", lastLeg := legs "lastLeg", continueLog, stops }
    -- `trainLine: {vouchedShare, covered, uncovered}`, the train generator's
    -- evidence at a leg's start.
    let trainLine : Option Verified.Hsmm.SegmentEmission.TrainLine := do
      let tl ← (f.getObjVal? "trainLine").toOption.filter (!·.isNull)
      let g := fun (k : String) => (tl.getObjVal? k).toOption >>= num
      pure { vouchedShare := ← g "vouchedShare", covered := ← g "covered", uncovered := ← g "uncovered" }
    pure { sigmaW, rho, byMode, disp, uMaxKmh, speedEps, pairBoundaryMeanKmh, pairBoundaryEps,
           obsChain, asleep, unlistedCentre, stayMove, journey, trainLine }
  let some segEm := segEm?
    | throw "flags.segEmission is missing or malformed: the decoder runs on its record (DECODER_PARAMS_JSON)"
  if segEm.trainLine.isNone then
    throw "flags.segEmission.trainLine is missing or malformed: the decoder runs on its record (DECODER_PARAMS_JSON)"
  -- The wait leg exists only with a fitted wait duration.
  let segEm := { segEm with journey := segEm.journey.map fun jp => { jp with wait := waitFit.isSome } }
  let ctx := Verified.Hsmm.Assemble.buildContext obs model
    places.toList coverage placeNearLine continuity
    (← (← flags.getObjVal? "chainContext").getBool?) segEm
  let posRef := Verified.Hsmm.SegmentEmission.refOf obs
  let segPref := Verified.Hsmm.SegmentEmission.withPositions
    (Verified.Hsmm.SegmentEmission.prefixOf obs) obs posRef
    Verified.Hsmm.Emissions.PLACE_RADIUS_M Verified.Hsmm.Assemble.ACCURACY_DEFAULT_M
  let placePrior := Verified.Hsmm.SegmentEmission.placesLocal posRef
    (places.toList.map fun (_, lat, lon, _, _) => (lat, lon))
  -- A fitted mode-to-mode transition matrix (harness-only): `{src: {dst: p}}`.
  let modesAll : List Verified.Hsmm.Emissions.Mode :=
    [.stationary, .walking, .cycling, .driving, .train, .plane, .unknown]
  let modeOf := fun (n : String) => modesAll.find? (Verified.Hsmm.StateSpace.modeName · == n)
  -- Per source state, how many states of each mode it may move to (the even
  -- split's denominator); shared by the fitted matrix and the stay give-back.
  let placeNear := fun (pid : Int) (line : String) => ctx.placeNearLine.contains s!"{pid}|{line}"
  let statesL := ctx.states.toList
  let counts : Std.HashMap String (List (Verified.Hsmm.Emissions.Mode × Nat)) :=
    ctx.states.foldl (fun m src =>
      m.insert (Verified.Hsmm.StateSpace.stateKey src) (modesAll.map fun md =>
        (md, (statesL.filter fun dst => dst.mode == md && !Verified.Hsmm.Transitions.sameState src dst
           && !Verified.Hsmm.Transitions.isHardZeroP placeNear src dst).length))) {}
  let count := fun (src : Verified.Hsmm.Emissions.State) (md : Verified.Hsmm.Emissions.Mode) =>
    (((counts.get? (Verified.Hsmm.StateSpace.stateKey src)).getD []).find? (·.1 == md)).map (·.2) |>.getD 0
  let transFit := (flags.getObjVal? "transFit").toOption.filter (!·.isNull)
  let transWeight : Verified.Hsmm.Emissions.State → Verified.Hsmm.Emissions.State → Float :=
    match transFit with
    | none => Verified.Hsmm.Transitions.transitionWeight
    | some tf =>
      let entries : List (Verified.Hsmm.Emissions.Mode × Verified.Hsmm.Emissions.Mode × Float) :=
        match tf.getObj? with
        | .ok rows => rows.toList.flatMap fun (sk, row) =>
          match modeOf sk, row.getObj? with
          | some sm, .ok cols => cols.toList.filterMap fun (dk, v) => do
              let dm ← modeOf dk
              let p ← (v.getNum?).toOption
              pure (sm, dm, p.toFloat)
          | _, _ => []
        | .error _ => []
      let matrix := fun (a b : Verified.Hsmm.Emissions.Mode) =>
        (entries.find? fun (x, y, _) => x == a && y == b).map (·.2.2)
      Verified.Hsmm.Transitions.fittedWeight matrix count
  -- A transition into a stay gives the even split back: the entry prior alone
  -- chooses the place.
  let stayEntryLog : Array Float :=
    ctx.states.map fun src => Float.log (Verified.FloatConst.natToFloat (count src .stationary))
  -- And into a train: the entry chooses the line (`trainLine`).
  let trainEntryLog : Array Float :=
    ctx.states.map fun src => Float.log (Verified.FloatConst.natToFloat (count src .train))
  -- `flags.entryCounts` (harness arm): `{alpha, beta}` — the entry prior as
  -- smoothed counts of visits (`Assemble.entryCountsTable`); the places' counts
  -- ride on the request as `visits`.
  let visitCounts : Std.HashMap Int Float := Id.run do
    let mut m : Std.HashMap Int Float := {}
    for pj in ((j.getObjVal? "places") >>= (·.getArr?)).toOption.getD #[] do
      match (pj.getObjVal? "id" >>= (·.getInt?)).toOption, (pj.getObjVal? "visits" >>= (·.getNum?)).toOption with
      | some id, some n => m := m.insert id n.toFloat
      | _, _ => pure ()
    return m
  let entryTable := match (flags.getObjVal? "entryCounts").toOption.filter (!·.isNull) with
    | some ec =>
      let num := fun (k : String) => ((ec.getObjVal? k) >>= (·.getNum?)).toOption.map (·.toFloat)
      match num "alpha", num "beta" with
      | some alpha, some beta =>
        Verified.Hsmm.Assemble.entryCountsTable (ctx.placeCoords.toList.map (·.1)) visitCounts ctx.hourProfiles alpha beta
          (num "newShare")
      | _, _ => #[]
    | none => #[]
  let ctx := { ctx with priors, fits, mainlineFit, waitFit, waitMin, weights, segPref, placePrior, transWeight, stayEntryLog, trainEntryLog,
                        visitCounts, entryTable }
  let lineProxBest := Verified.Hsmm.Assemble.lineProxBestTable ctx
  let (pairPref, pairBoundary) := Verified.Hsmm.Assemble.pairTables ctx
  let stayMoveCorr := Verified.Hsmm.Assemble.stayMoveTable ctx maxD
  return ({ ctx with lineProxBest, pairPref, pairBoundary, stayMoveCorr }, maxD)

/-! ## Coverage mode (`verified_cli coverage`)

Rebuild the train-generator coverage map from the observation tensor and a
node-annotated station graph (`enumerateTrainCandidates` + `buildCoverage`).
The shell supplies the station annotation: `nodeKey` ids, station names,
incident edge ids.

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
    -- In machine words: `Int` past 2^31 is a GMP number, and these scores are
    -- far past it. `|w|` as a `UInt64` is exact for every `Int64`.
    let w := Float.toInt64 fv
    let mag := (if w < 0 then 0 - w else w).toUInt64.toNat
    if mag > bound then throw s!"assembled score {w.toInt} exceeds envelope {bound}"
    else .ok (if w < 0 then pOff - mag else pOff + mag)

/-- Inside `±int64Lim` two `Int64`s subtract without overflow. `@[noinline]`:
a literal ≥ 2^32 inlined into a loop is a GMP string parse per evaluation. -/
@[noinline] private def int64Lim : Int64 := 4611686018427387904

/-- `((qE - qR) + h).toNat`, and the difference when `|qE - qR| > h` — the
duration delta's packing. On machine words when both scores sit inside
`±2^62`, so the difference is exact; in `Int` otherwise. -/
@[inline] private def packDelta (qE qR : Int64) (h : Nat) : Nat × Option Int :=
  if -int64Lim < qE && qE < int64Lim && -int64Lim < qR && qR < int64Lim then
    let d := qE - qR
    let mag := (if d < 0 then 0 - d else d).toUInt64.toNat
    (if d < 0 then h - mag else h + mag, if mag > h then some d.toInt else none)
  else
    let d := qE.toInt - qR.toInt
    ((d + (h : Int)).toNat, if d.natAbs > h then some d else none)

private def packDeltaRef (qE qR : Int64) (h : Nat) : Nat × Option Int :=
  let d := qE.toInt - qR.toInt
  ((d + (h : Int)).toNat, if d.natAbs > h then some d else none)

-- The fast path against the `Int` form, at the edges that can differ: signs,
-- the band edge `h`, past it, the ±2^62 boundary, and the extremes.
#guard
  let vs : List Int64 := [0, 1, -1, 17592186044416, -17592186044416, 17592186044417,
    -17592186044417, 562949953421312, -562949953421312, 4611686018427387903,
    -4611686018427387903, 4611686018427387904, -4611686018427387904,
    9223372036854775807, -9223372036854775808]
  vs.all fun a => vs.all fun b =>
    [0, 1, 17592186044416].all fun h => packDelta a b h == packDeltaRef a b h

#guard [((0 : Int64), 0), (5, 3), (-5, 3), (-9223372036854775808, 9223372036854775808),
    (9223372036854775807, 9223372036854775807), (-3, 3), (3, 2)].all fun (w, bound) =>
  let ref : Except String Nat :=
    if w.toInt.natAbs > bound then .error "x" else .ok (w.toInt + (pOff : Int)).toNat
  match encScore bound (some w.toFloat), ref with
  | .ok a, .ok b => a == b
  | .error _, .error _ => true
  | _, _ => false

/-- Class key for the duration factorisation. `dur(s,d,e)` depends on the state
    only through `(mode, isNamedTrain, placeless stay)` — segment evidence sees
    the mode, the train-hop relaxation the named-line + coverage (which is
    line-independent), and the unlisted centre (`unlistedCentre`) the placeless
    stay alone. So this partition is EXACT (no iterative refinement): every
    state in a class has identical `dur(·,d,e)` at every cell. Named train ⇒ 7;
    the mainline (`unknown_rail`, its own duration fit) ⇒ 9; another unnamed
    train ⇒ 4; the placeless stay ⇒ 8. -/
private def durClassKey (s : Verified.Hsmm.Emissions.State) : Nat :=
  match s.mode with
  | .stationary =>
    if s.lineName == some Verified.Hsmm.Assemble.WAIT_MARK then 10
    else match s.placeId with
      | none => 8
      | some _ => 0
  | .walking => 1 | .cycling => 2 | .driving => 3
  | .plane => 5 | .unknown => 6
  | .train => match s.lineName with
    | some l =>
      if !Verified.Hsmm.Emissions.isPlaceholderLine l then 7
      else if Verified.Hsmm.Emissions.isMainline s then 9 else 4
    | none => 4

/-- The floor under one minute's emission in the journey's leg prefix sums:
    a leg over 240 such minutes stays inside the packed envelope. -/
private def journeyEmitFloor : Float := -10000
/-- A Float zero for the journey builders' loops (a literal there is a GMP call). -/
private def journeyZero : Float := 0
/-- How near a fix must be to a station for a leg to board or alight there. -/
private def journeyReachM : Float := 400
/-- How stale a neighbouring fix may be to stand for a dark minute's position. -/
private def journeyFixStaleS : Int := 360
/-- The same window in whole minutes, for the alight's search forward. -/
private def journeyFixStaleMin : Nat := (journeyFixStaleS / 60).toNat
private def journeyKmPerM : Float := 0.001
private def journeyMinPerHour : Float := 60

/-- Phase one of the model build: the emission and entry tensors, `T·S` each.
    The phases are separate so `decodeprof` can time each; only `buildPData`
    composes them. -/
private def buildEmitEntry (c : Verified.Hsmm.Assemble.ModelContext) (T S : Nat) :
    Except String (Array Nat × Array Nat) := do
  let quant := Verified.Hsmm.Quantize.quantize
  let mut emit : Array Nat := Array.replicate (T * S) 0
  let mut entry : Array Nat := Array.replicate (T * S) 0
  for t in [0:T] do
    for s in [0:S] do
      emit := emit.set! (t * S + s) (← encScore pEB (quant (Verified.Hsmm.Assemble.emitAt c t s)))
      entry := entry.set! (t * S + s) (← encScore pOB (quant (Verified.Hsmm.Assemble.entryAt c t s)))
  return (emit, entry)

/-- Phase two: the transition base, the override index and the flat override
    rows — `(transBase, transIdx, transFlat, nRows)`. -/
private def buildTransitions (c : Verified.Hsmm.Assemble.ModelContext) (T S : Nat) :
    Except String (Array Nat × Array Nat × Array Nat × Nat × Option (FloatArray × FloatArray)) := do
  let quant := Verified.Hsmm.Quantize.quantize
  -- Under the journey state the outer trellis holds stays and the journey: a
  -- leg state is unreachable there, a stay and the journey exchange at no
  -- cost (the place is the entry prior's, the legs are the journey's cell).
  let jOn := (Verified.Hsmm.Assemble.journeyIdx c).isSome
  let isLeg := Verified.Hsmm.Assemble.isLegState
  -- Transitions: the base matrix is time-constant; only chain-context makes a
  -- transition vary with t, and only for structurally chain-eligible pairs
  -- (stay into a place, leave a place into a move, board a named line). Build the
  -- base once with a shared per-src weight sum (O(S²)), then per-t override rows
  -- for the eligible pairs only — vs a T·S³ dense build.
  let placeNear := fun (pid : Int) (line : String) => c.placeNearLine.contains s!"{pid}|{line}"
  let statesL := c.states.toList
  -- Each state with its weight sum and its index, so the pair loops below read
  -- nothing by index: the state comes from the iteration itself.
  let weighted : Array ((Verified.Hsmm.Emissions.State × Float) × Nat) :=
    (c.states.map fun s => (s, Verified.Hsmm.Transitions.crossWeightSumP placeNear statesL s c.transWeight)).zipIdx
  let baseTransF := fun (src dst : Verified.Hsmm.Emissions.State) (ws : Float) (a : Nat) =>
    Verified.Hsmm.Transitions.transitionLogProbPre placeNear Verified.Hsmm.Assemble.NO_SELF_LOOP ws src dst c.transWeight
      + Verified.Hsmm.Assemble.stayEntryAt c a dst
  let outerTransF := fun (src dst : Verified.Hsmm.Emissions.State) (ws : Float) (a b : Nat) =>
    if !jOn then baseTransF src dst ws a
    else if isLeg src || isLeg dst then Verified.FloatConst.negInf
    else if src.mode == .unknown && dst.mode == .unknown then
      -- Two journeys back to back: one longer than the bound, at its rate.
      (match c.segEm.p.journey with | some jp => jp.continueLog | none => Verified.FloatConst.negInf)
    else if src.mode == .unknown || dst.mode == .unknown then
      (if a == b then Verified.FloatConst.negInf else journeyZero)
    else baseTransF src dst ws a
  let mut transBase : Array Nat := Array.replicate (S * S) 0
  for ((src, ws), a) in weighted do
    for ((dst, _), b) in weighted do
      transBase := transBase.set! (a * S + b) (← encScore pOB (quant (outerTransF src dst ws a b)))
  -- Override rows for chain-eligible, non-hard-zero pairs (superset of the pairs
  -- whose chain term can be non-zero — hard-zeros keep their −∞, chain not added).
  let chainEligible := fun (src dst : Verified.Hsmm.Emissions.State) =>
    (dst.mode == .stationary && dst.placeId != none)
    || (src.mode == .stationary && src.placeId != none
        && (Verified.Hsmm.RouteModel.isMovingMode dst.mode || dst.mode == .unknown))
    || (dst.mode == .train && (match dst.lineName with
        | some l => !Verified.Hsmm.Emissions.isPlaceholderLine l | none => false))
  -- What the chain term asks of each minute regardless of the pair (a fix's
  -- stay penalty per place, boarding penalty per line), tabled once per minute.
  let placeIds := c.placeCoords.toList.map (·.1)
  let lineNames := c.edgesByLine.toList.map (·.1)
  -- The fix's distances to every line and place, once per distinct fix: a
  -- gap's minutes all share one `prevGpsFix`.
  let minutes : Array (Verified.Hsmm.RouteModel.ChainMinute × Bool) :=
    if c.chainOn then Id.run do
      let mut out : Array (Verified.Hsmm.RouteModel.ChainMinute × Bool) := #[]
      let mut fd : Option Verified.Hsmm.RouteModel.FixDists := none
      for o in c.obs do
        if let some fx := o.prevGpsFix then
          if !(fd.any (·.fx == fx)) then
            fd := some (Verified.Hsmm.RouteModel.fixDists c.edgesByLine c.placeCoords placeIds lineNames fx)
        out := out.push
          (Verified.Hsmm.RouteModel.chainMinuteTabledD c.edgesByLine c.placeCoords placeIds lineNames
             fd o,
           Verified.Hsmm.TrainCandidates.isCovered c.coverage o.ts)
      return out
    else #[]
  -- The override rows go straight into the flat `nRows × T` array. A pure loop:
  -- the first envelope error is kept and thrown after it.
  let (ovPairs, transFlat, err) : Array (Nat × Nat) × Array Nat × Option String := Id.run do
    let mut ovPairs : Array (Nat × Nat) := #[]
    let mut flat : Array Nat := #[]
    let mut err : Option String := none
    if c.chainOn then
      for ((src, ws), a) in weighted do
        for ((dst, _), b) in weighted do
          if chainEligible src dst && !Verified.Hsmm.Transitions.isHardZeroP placeNear src dst
              && !(jOn && (isLeg src || isLeg dst)) then
            -- A journey arrives at and leaves a place with the place's own
            -- context, as a walk does.
            let base := outerTransF src dst ws a b
            -- The place-anchored boarding penalty once per pair; each minute adds
            -- only what depends on it.
            let pb := Verified.Hsmm.RouteModel.chainPlaceBoard c.edgesByLine c.placeCoords src dst
            for (cm, covered) in minutes do
              let cv := Verified.Hsmm.RouteModel.chainContextWith c.edgesByLine src dst covered pb cm
              match encScore pOB (quant (base + cv)) with
              | .ok v => flat := flat.push v
              | .error e =>
                if err.isNone then err := some e
                flat := flat.push 0
            ovPairs := ovPairs.push (a, b)
    return (ovPairs, flat, err)
  if let some e := err then throw e
  let nRows := ovPairs.size
  let mut transIdx : Array Nat := Array.replicate (S * S) nRows  -- sentinel = nRows ⇒ use base
  for ((a, b), i) in ovPairs.zipIdx do
    transIdx := transIdx.set! (a * S + b) i
  -- The legs' transitions for the journey's inner pass, per minute: the
  -- fitted base and, for a chain-eligible pair, the chain context.
  let legTrans : Option (FloatArray × FloatArray) := if !jOn then none else some (Id.run do
    let legs := Verified.Hsmm.Assemble.legIdxs c
    let L := legs.size
    -- A ride's coverage is one fact however many legs it is cut into: the
    -- generator's coverage evidence rides on a train leg's entry, so a train
    -- leg straight after a train leg gives it back here — two one-minute hops
    -- at calls earned it twice and out-scored the ride they cut (07-02's
    -- Baker Street → Euston Square). The line share stays: a change is a
    -- new line.
    let coveredT : Array Bool := c.obs.map fun o => Verified.Hsmm.TrainCandidates.isCovered c.coverage o.ts
    let coverageBack := fun (src dst : Verified.Hsmm.Emissions.State) (t : Nat) =>
      match c.segEm.p.trainLine with
      | some tl => if src.mode == .train && dst.mode == .train then
          (if coveredT.getD t false then tl.covered else tl.uncovered) else journeyZero
      | none => journeyZero
    -- A journey's first leg boards as a walk would: the fix-anchored term.
    let walkSt : Verified.Hsmm.Emissions.State := ⟨.walking, none, none⟩
    let mut firstCtx := Verified.FloatConst.floats (L * T) journeyZero
    if c.chainOn then
      for (b, bi) in legs.zipIdx do
        let dst := c.states[b]!
        if dst.mode == .train then
          for ((cm, covered), t) in minutes.zipIdx do
            firstCtx := firstCtx.set! (bi * T + t)
              (Verified.Hsmm.RouteModel.chainContextWith c.edgesByLine walkSt dst covered none cm)
    let mut out := Verified.FloatConst.floats (T * L * L) Verified.FloatConst.negInf
    for (a, ai) in legs.zipIdx do
      for (b, bi) in legs.zipIdx do
        if a == b then continue
        let ((src, ws), _) := weighted[a]!
        let ((dst, _), _) := weighted[b]!
        -- A wait continues only into a ride (`pairOk`): that successor is
        -- certain, and the ride's entry chooses the line. The fitted stay
        -- row would charge it the share of stays that end in a ride.
        let base := if src.lineName == some Verified.Hsmm.Assemble.WAIT_MARK then
            (if dst.mode == .train then journeyZero else Verified.FloatConst.negInf)
          else baseTransF src dst ws a
        if c.chainOn && chainEligible src dst && !Verified.Hsmm.Transitions.isHardZeroP placeNear src dst then
          let pb := Verified.Hsmm.RouteModel.chainPlaceBoard c.edgesByLine c.placeCoords src dst
          for ((cm, covered), t) in minutes.zipIdx do
            out := out.set! ((t * L + ai) * L + bi)
              (base - coverageBack src dst t + Verified.Hsmm.RouteModel.chainContextWith c.edgesByLine src dst covered pb cm)
        else
          for t in [0:T] do
            out := out.set! ((t * L + ai) * L + bi) (base - coverageBack src dst t)
    return (out, firstCtx))
  return (transBase, transIdx, transFlat, nRows, legTrans)

/-- What an incremental build reuses from the day's previous one: every cell
    ending before `f` (`durDelta`, `legDur`, the journey's `inner`), copied
    (docs/proposals/2026-11-incremental-today.md). -/
structure IncFrom where
  f : Nat
  durDelta : Array Nat
  legDur : FloatArray
  inner : FloatArray

/-- Phase three: the duration base and the per-class deltas —
    `(durClass, durBase, durDelta)`. With `inc`, only the cells ending at
    `inc.f` or later are computed; with `tablesOnly`, none, and the journey's
    per-minute tables come back before its own scores and sweeps. -/
private def buildDurations (c : Verified.Hsmm.Assemble.ModelContext) (T S maxD halfOB : Nat)
    (legTrans : Option (FloatArray × FloatArray) := none)
    (g? : Option Verified.Hsmm.StationChain.ChainGraph := none)
    (rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation) := none)
    (inc : Option IncFrom := none) (tablesOnly : Bool := false)
    (preTb : Option Verified.Hsmm.Journey.Tables := none) :
    Except String (Array Nat × Array Nat × Array Nat × Option Verified.Hsmm.Journey.Tables) := do
  let quant := Verified.Hsmm.Quantize.quantize
  -- Duration: EXACT class partition by (mode, isNamedTrain).
  let keys : Array Nat := c.states.foldl (fun acc s =>
    let k := durClassKey s; if acc.contains k then acc else acc.push k) #[]
  let nC := keys.size
  let durClass : Array Nat := c.states.map (fun s => (keys.findIdx? (· == durClassKey s)).getD 0)
  let reps : Array Nat := keys.map (fun k => (c.states.findIdx? (fun s => durClassKey s == k)).getD 0)
  let mut durBase : Array Nat := Array.replicate (S * maxD) 0
  for s in [0:S] do
    for d0 in [0:maxD] do
      durBase := durBase.set! (s * maxD + d0) (← encScore halfOB (quant (Verified.Hsmm.Assemble.durPriorBase c s (d0 + 1))))
  let qiOf := fun (x : Float) => Float.toInt64 x   -- dur is finite
  -- Coverage depends on `e` alone, so once per `e` for every class and `d`.
  let covered : Array Bool := (Array.range T).map (Verified.Hsmm.Assemble.coveredAtE c)
  -- The journey state's arm: its class, the legs' classes (slots of the
  -- level-free table) and the journey bound.
  let jIdx := Verified.Hsmm.Assemble.journeyIdx c
  let jCls := jIdx.map fun i => durClass[i]!
  -- Every journey state (two): the bound applies to each.
  let jAll : Array Nat := (c.states.zipIdx.filter fun (st, _) => st.mode == .unknown).map (·.2)
  let maxJ := match c.segEm.p.journey with | some jp => min jp.maxJ maxD | none => 0
  let legs := if jIdx.isSome then Verified.Hsmm.Assemble.legIdxs c else #[]
  let legSlots : Array Nat := legs.foldl (fun acc l => let k := durClass[l]!; if acc.contains k then acc else acc.push k) #[]
  let slotArr : Array (Option Nat) := (Array.range nC).map fun cls => legSlots.findIdx? (· == cls)
  -- Every slot is a class below `nC`, so past it there is none either.
  let slotOfCls := fun (cls : Nat) => slotArr.getD cls none
  -- A pure loop (in `Except`, every one of ~2.4M cells paid for the monad); an
  -- out-of-range delta is recorded and thrown after it.
  -- The first end minute computed: `T` (none) for the tables alone.
  let f := if tablesOnly then T else (inc.map (·.f)).getD 0
  let (durDelta, bad, legDur) : Array Nat × Option Int × FloatArray := Id.run do
    let tri := Verified.Hsmm.triOff maxD T
    let mut durDelta : Array Nat := match inc, tablesOnly with
      | _, true => #[]
      | some p, _ => p.durDelta
      | none, _ => Array.replicate (nC * tri) halfOB
    let mut bad : Option Int := none
    let mut legDur := match inc, tablesOnly with
      | _, true => FloatArray.empty
      | some p, _ => p.legDur
      | none, _ => Verified.FloatConst.floats (legSlots.size * maxJ * T) Verified.FloatConst.negInf
    for d0 in [0:maxD] do
      -- The gamma prior once per (class, d) (`durAt_eq_durAtFrom`), and the
      -- reference each delta is taken against: the prior itself, which no
      -- minute's data moves (`durBase` holds it too, so a cell is its class's
      -- cell at `e` whatever the reference).
      let bases := reps.map fun rep => Verified.Hsmm.Assemble.durPriorBase c rep (d0 + 1)
      let qRefs := bases.map fun base =>
        match quant base with
          | some v => qiOf v | none => 0
      -- A segment of `d0 + 1` minutes ends at minute `d0` at the earliest;
      -- the cells below start before the day and neither sweep reads them
      -- (`τ ≤ t + 1`, a leg's `start ≥ 0`), so the triangle is skipped: half
      -- the phase, exactly. Below `f` the cells are the previous build's.
      for e in [max d0 f:T] do
        -- The segment's window once per (d, e) for every class
        -- (`durAtFrom_eq_W`).
        let w := Verified.Hsmm.SegmentEvidence.windowAt c.obs c.stepPref (d0 + 1) e
        let sst := Verified.Hsmm.SegmentEmission.statsAt c.segPref (d0 + 1) e
        -- The displacement densities once per (d, e): every class and both
        -- cells below read the same vector (`dispPosteriorFrom`).
        let dv := w.map fun w => Verified.Hsmm.SegmentEmission.dispPrep
          (Verified.Hsmm.SegmentEmission.dispVector c.segEm.p (d0 + 1) w)
        let cov := covered[e]!
        for cls in [0:nC] do
          -- The journey's cell waits for the inner pass (below).
          if jCls == some cls then continue
          let qE := match quant (Verified.Hsmm.Assemble.durAtFromW c reps[cls]! (d0 + 1) cov w sst bases[cls]! (dv := dv)) with
            | some v => qiOf v | none => 0
          let (packed, over) := packDelta qE qRefs[cls]! halfOB
          if over.isSome then bad := over
          durDelta := durDelta.set! (cls * tri + Verified.Hsmm.triOff maxD e + d0) packed
          -- A leg under a journey: the same cell without the level, and
          -- without the covered train's relaxed floor — a leg pays no level,
          -- so the floor is what stops a ride splitting into one-minute legs.
          if d0 < maxJ then
            if let some slot := slotOfCls cls then
              legDur := legDur.set! ((slot * maxJ + d0) * T + e)
                (Verified.Hsmm.Assemble.durAtFromW c reps[cls]! (d0 + 1) false w sst bases[cls]! false dv)
    return (durDelta, bad, legDur)
  if let some delta := bad then throw s!"dur delta {delta} exceeds halfOB {halfOB}"
  -- The journey state: its cell is the inner pass over the legs plus its own
  -- level and duration; beyond `maxJ` it is impossible.
  match jIdx, jCls, legTrans with
  | some jI, some jc, some (trans, firstCtx) =>
    let tb : Verified.Hsmm.Journey.Tables := match preTb with
      | some t => { t with legDur }
      | none => Id.run do
        let L := legs.size
        let emitPre : FloatArray := Id.run do
          let mut out := Verified.FloatConst.floats (L * (T + 1)) journeyZero
          -- A minute a leg cannot emit is −∞ per cell in the outer trellis; in a
          -- prefix sum it would poison every later minute, so it is floored
          -- here: still far beyond any leg that spans it.
          for (l, li) in legs.zipIdx do
            let mut acc := journeyZero
            for t in [0:T] do
              let v := Verified.Hsmm.Assemble.emitAt c t l
              acc := acc + (if v < journeyEmitFloor then journeyEmitFloor else v)
              out := out.set! (li * (T + 1) + t + 1) acc
          return out
        let entryF : FloatArray := Id.run do
          let mut out := Verified.FloatConst.floats (L * T) journeyZero
          for (l, li) in legs.zipIdx do
            for t in [0:T] do
              out := out.set! (li * T + t) (Verified.Hsmm.Assemble.entryAt c t l)
          return out
        -- The first leg's prior is spread over the LINES of its mode (which line),
        -- as the fitted transition weight is; the last leg's is the leg's own.
        let prior := fun (spread : Bool) (xs : List (Verified.Hsmm.Emissions.Mode × Float)) (l : Nat) =>
          let st := c.states[l]!
          match xs.find? (·.1 == st.mode) with
          | some (_, lp) =>
            if !spread then lp else
            let n := (legs.foldl (fun (acc : List (Option String)) l2 =>
              let s2 := c.states[l2]!
              if s2.mode == st.mode && !acc.contains s2.lineName then s2.lineName :: acc else acc) []).length
            lp - Float.log (Verified.FloatConst.natToFloat (max n 1))
          | none => Verified.FloatConst.negInf
        let jp := c.segEm.p.journey.get!
        -- S2: a named line's leg per board station within reach of the day's
        -- fixes. It shares its base's tables, begins only within reach of its
        -- station, and prices its length by the along-line path to the station
        -- the fixes put the ride's end at.
        let fixAt := fun (t : Nat) => match c.obs[t]? with
          | none => none
          | some o => match o.gps with
            | some gp => some (gp.lat, gp.lon)
            | none => match o.prevGpsFix with
              | some f => if o.ts - f.ts ≤ journeyFixStaleS then some (f.lat, f.lon) else none
              | none => none
        -- The last raw fix of the minute, not its median: where he was when the
        -- next minute began. A minute straddling an arrival puts its median between
        -- the two stations and its first fix at the one before.
        let fixBefore := fun (t : Nat) => match c.obs[t]? with
          | none => none
          | some o => match o.lastFix with
            | some f => some (f.lat, f.lon)
            | none => match o.gps with
              | some gp => some (gp.lat, gp.lon)
              | none => none
        -- The same, or the next fix within the stale window for a dark minute.
        let fixAfter := fun (t : Nat) => match fixBefore t with
          | some f => some f
          | none => match c.obs[t]? with
            | none => none
            | some o => match o.nextGpsFix with
              | some f => if f.ts - o.ts ≤ journeyFixStaleS then some (f.lat, f.lon) else none
              | none => none
        let nearFix := fun (f : Option (Float × Float)) (n : Verified.Hsmm.StationChain.ChainNode) =>
          match f with
          | some (la, lo) => Verified.Hsmm.FloatScore.haversineMeters la lo n.lat n.lon ≤ journeyReachM
          | none => false
        let fixes : Array (Option (Float × Float)) := (Array.range T).map fixAt
        -- Each line's served stations, once: matching a line to its relations
        -- parses every relation's name, and the legs' tables ask per station.
        let servedSets : Std.HashMap String (Option (Std.HashSet String)) := match rels? with
          | none => {}
          | some rels => c.states.foldl (fun m st => match st.lineName with
            | some line => if m.contains line then m
              else m.insert line (Verified.Hsmm.ServedStations.servedStationSet rels line)
            | none => m) {}
        let servedSet : String → Option (Std.HashSet String) := fun line => match rels? with
          | none => none
          | some rels => match servedSets.get? line with
            | some s => s
            | none => Verified.Hsmm.ServedStations.servedStationSet rels line
        -- A station is a line's only where the relations have the line calling
        -- there; without relations, where the line's track passes it.
        let servedOn := fun (line : String) (n : Verified.Hsmm.StationChain.ChainNode) =>
          match rels?, n.stationName with
          | some _, some name =>
            match servedSet line with
            | some served => Verified.Hsmm.ServedStations.stationNameServed served name
            | none => true
          | _, _ => true
        let legListAll : Array (Nat × Nat × Option Verified.Hsmm.StationChain.ChainNode) := Id.run do
          let mut out := legs.zipIdx.map fun (l, li) => (l, li, none)
          match g? with
          | none => return out
          | some g =>
            -- Within reach of some fix of the day, once per node: the cheap test
            -- first, the track geometry only for the stations it keeps.
            let nearAny : Array Bool := g.nodes.map fun n =>
              n.stationName.isSome && fixes.any (fun f => nearFix f n)
            for (l, li) in legs.zipIdx do
              let st := c.states[l]!
              match st.mode, st.lineName with
              | .train, some line =>
                if Verified.Hsmm.Emissions.isPlaceholderLine line then continue
                for (n, ni) in g.nodes.zipIdx do
                  if !nearAny[ni]! then continue
                  if !Verified.Hsmm.StationChain.stationOnLine g line n then continue
                  if !servedOn line n then continue
                  out := out.push (l, li, some n)
              | .stationary, some _ =>
                -- The wait: a leg per station within reach of the fixes.
                for (n, ni) in g.nodes.zipIdx do
                  if nearAny[ni]! then out := out.push (l, li, some n)
              | _, _ => pure ()
            return out
        -- A wait continues only into a ride boarding at its node (`pairOk`) and
        -- never ends a journey, so a wait where no ride leg boards lies on no
        -- path: it is not built. It still counts in `boardAt`'s best station.
        let boards : Std.HashSet String := legListAll.foldl (fun acc (l, _, st?) =>
          match (c.states[l]!).mode, st? with
          | .train, some n => acc.insert n.id
          | _, _ => acc) {}
        let keptIdx : Array Nat := (Array.range legListAll.size).filter fun i =>
          match legListAll[i]! with
          | (l, _, some n) => (c.states[l]!).lineName != some Verified.Hsmm.Assemble.WAIT_MARK || boards.contains n.id
          | _ => true
        let legList := keptIdx.map (legListAll[·]!)
        let L := legList.size
        let legOuter := legList.map (·.1)
        let baseOf := legList.map (·.2.1)
        -- A ride begins where the fixes leave its board station (in 85 of 86
        -- corpus departures the decoded ride began inside the platform wait). A
        -- minute with its own fix at the station starts a ride only when the next
        -- minute is away; a minute whose fix is carried from before (a dark
        -- platform, `fixAt`) may start one. The wait keeps every reach minute.
        let reachStarts : Array (Array Nat) := legList.map fun (l, _, st?) =>
          match st? with
          | none => #[]
          | some n =>
            let near := fun (t : Nat) => nearFix fixes[t]! n
            let seen := fun (t : Nat) => match c.obs[t]? with | some o => o.gps.isSome | none => false
            -- Seen at the station as the minute ENDS (its own last fix): a train
            -- pulling away slowly leaves its first moving minute's median within
            -- reach, and the dark minute after a train enters the tunnel says
            -- nothing of where he is.
            let stillHere := fun (t : Nat) => t < T && seen t
              && nearFix (match fixBefore t with | some f => some f | none => fixes[t]!) n
            if (c.states[l]!).mode == .train then
              (Array.range T).filter fun t => near t && (!seen t || !stillHere t || !stillHere (t + 1))
            else (Array.range T).filter near
        -- The board station against the fix of the minute BEFORE the leg — where
        -- he stood when the ride began (the leg's own first minute already moves):
        -- the chain's anchor form, relative to the best station at that minute.
        let boardAt : FloatArray := Id.run do
          let LA := legListAll.size
          let mut raw := Verified.FloatConst.floats (LA * T) journeyZero
          let mut has := Array.replicate (LA * T) false
          -- A station is a complex of nodes (one per line's platforms); the leg's
          -- distance is its NAME's nearest node, so two lines boarded at the same
          -- station tie here and their pairs decide.
          let stationNodes : Std.HashMap String (Array Verified.Hsmm.StationChain.ChainNode) :=
            match g? with
            | none => {}
            | some g => g.nodes.foldl (fun m n => match n.stationName with
                | some name => m.insert name ((m.getD name #[]).push n)
                | none => m) {}
          for (entry, li) in legListAll.zipIdx do
            let (_, _, st?) := entry
            let some n := st? | continue
            let nodes := match n.stationName with
              | some name => stationNodes.getD name #[n]
              | none => #[n]
            for t in [0:T] do
              let f := if t == 0 then fixes[t]! else match fixBefore (t - 1) with
                | some f => some f | none => fixes[t]!
              match f with
              | none => pure ()
              | some (la, lo) =>
                let dM := nodes.foldl (fun acc x =>
                  min acc (Verified.Hsmm.FloatScore.haversineMeters la lo x.lat x.lon))
                  (Verified.Hsmm.FloatScore.haversineMeters la lo n.lat n.lon)
                let z := dM / Verified.Hsmm.StationChain.STATION_SIGMA_M
                raw := raw.set! (li * T + t) (max Verified.Hsmm.StationChain.ANCHOR_CLAMP (-(Verified.Hsmm.Journey.HALF * z * z)))
                has := has.set! (li * T + t) true
          let mut out := Verified.FloatConst.floats (L * T) journeyZero
          for t in [0:T] do
            let mut mx := Verified.FloatConst.negInf
            for ai in [0:LA] do
              if has[ai * T + t]! then mx := max mx (raw.get! (ai * T + t))
            if mx == Verified.FloatConst.negInf then continue
            for (ai, li) in keptIdx.zipIdx do
              if has[ai * T + t]! then out := out.set! (li * T + t) (raw.get! (ai * T + t) - mx)
          return out
        let reachMask : Array Bool := Id.run do
          let mut out := Array.replicate (L * T) true
          for (starts, li) in reachStarts.zipIdx do
            if starts.isEmpty then continue
            for t in [0:T] do out := out.set! (li * T + t) false
            for t in starts do out := out.set! (li * T + t) true
          return out
        let (expectedMin, alightName, pairPathM, pairCalls) :
            FloatArray × Array (Option String) × FloatArray × FloatArray := Id.run do
          let mut out := Verified.FloatConst.floats (L * T) Verified.FloatConst.negInf
          -- The station each paired leg alights at, per end minute (`stopAlight`).
          let mut names : Array (Option String) := Array.replicate (L * T) none
          let mut pathOut := Verified.FloatConst.floats (L * T) Verified.FloatConst.negInf
          let mut callsOut := Verified.FloatConst.floats (L * T) Verified.FloatConst.negInf
          match g? with
          | none => return (out, names, pathOut, callsOut)
          | some g =>
            -- The stations within reach of each minute's next fix, once for every
            -- line (each line then keeps those on its track).
            let nearE : Array (Option (Array (Verified.Hsmm.StationChain.ChainNode × Float))) :=
              (Array.range T).map fun e => (fixAfter e).map fun (la, lo) =>
                Verified.Hsmm.StationChain.stationsNear g la lo journeyReachM
            let mut alightCache : Std.HashMap String (Array (Option Verified.Hsmm.StationChain.ChainNode)) := {}
            -- The calls between a pair, once per (line, board, alight).
            let mut stopsCache : Std.HashMap (String × String × String) (Option Nat) := {}
            let mut footCache : Std.HashMap String (Std.HashSet String) := {}
            for (entry, li) in legList.zipIdx do
              let (l, _, st?) := entry
              let some σ := st? | continue
              let line := (c.states[l]!).lineName.getD ""
              -- Per line, the station the fixes put each minute's end at, once.
              let alights := match alightCache.get? line with
                | some a => a
                | none =>
                  -- The track test once per station that comes within reach.
                  let onLine : Std.HashMap String Bool := nearE.foldl (fun m ns? =>
                    (ns?.getD #[]).foldl (fun m (n, _) => if m.contains n.id then m
                      else m.insert n.id (Verified.Hsmm.StationChain.stationOnLine g line n && servedOn line n)) m) {}
                  nearE.map fun ns? => match ns? with
                  | none => none
                  | some ns =>
                    let near := ns.filter fun (n, _) => onLine.getD n.id false
                    (near.foldl (fun (bestN : Option (Verified.Hsmm.StationChain.ChainNode × Float)) (n, d) =>
                      match bestN with
                      | none => some (n, d)
                      | some (_, bd) => if d < bd then some (n, d) else bestN) none).map (·.1)
              alightCache := alightCache.insert line alights
              let footOf := fun (cache : Std.HashMap String (Std.HashSet String)) (n : Verified.Hsmm.StationChain.ChainNode) =>
                match cache.get? n.id with
                | some f => (f, cache)
                | none =>
                  let f := Verified.Hsmm.StationChain.stationFootprintNodes g n
                  (f, cache.insert n.id f)
              let (start, fc) := footOf footCache σ
              footCache := fc
              let dist := Verified.Hsmm.StationChain.ssspMap
                (Verified.Hsmm.StationChain.lineSssp g line (start.toArray.map (fun id => (id, journeyZero))))
              -- The path along the line from the board's footprint to a station's.
              let pathTo := fun (fc : Std.HashMap String (Std.HashSet String)) (n : Verified.Hsmm.StationChain.ChainNode) =>
                let (goal, fc2) := footOf fc n
                (goal.fold (fun (acc : Option Float) id => match dist.get? id with
                  | none => acc
                  | some d => match acc with | none => some d | some bd => if d < bd then some d else acc) none, fc2)
              for e in [0:T] do
                -- The arrival is the first minute after the leg whose end is away
                -- from the board station and at a served station of the line,
                -- within the stale window, read from the minute's last fix (a
                -- minute can begin at a call on the way and end on the platform;
                -- the last such minute would be the next ride). Underground the
                -- phone repeats the board station's position, and the minute
                -- straddling the arrival sits between two stations, so neither
                -- ends the search. The arrival also lies at or beyond the farthest
                -- station the ride's own fixes reached before its end (the phone
                -- repeats a passed call too); the look-back stops at a fix at the
                -- board station, so a short hop does not read the ride before it.
                let mut passedM : Float := journeyZero
                let mut t := e
                while true do
                  match alights[t]! with
                  | some r =>
                    if r.stationName == σ.stationName then break
                    let (pm, fc2) := pathTo footCache r
                    footCache := fc2
                    passedM := max passedM (pm.getD journeyZero)
                  | none => pure ()
                  if t == 0 || e - t ≥ journeyFixStaleMin then break
                  t := t - 1
                let mut m := e + 1
                let mut found : Option (Verified.Hsmm.StationChain.ChainNode × Option Float) := none
                while m < T && m ≤ e + journeyFixStaleMin do
                  match fixAfter m, alights[m]! with
                  | some (la, lo), some a =>
                    -- The same station is no ride: a station is several nodes,
                    -- and a node of the board station within reach would price a
                    -- ride to itself.
                    if Verified.Hsmm.FloatScore.haversineMeters la lo σ.lat σ.lon > journeyReachM
                        && a.stationName != σ.stationName then
                      let (pm, fc2) := pathTo footCache a
                      footCache := fc2
                      if pm.getD passedM ≥ passedM then
                        found := some (a, pm)
                        break
                  | _, _ => pure ()
                  m := m + 1
                let some (a, pm) := found | continue
                names := names.set! (li * T + e) a.stationName
                match pm with
                | some pathM =>
                  -- The chain's ride-time form: with the calls between the pair
                  -- known, running time plus a stop each; else the all-stations
                  -- average.
                  let calls ← match rels?, σ.stationName, a.stationName with
                    | some rels, some sa, some sb =>
                      match stopsCache.get? (line, sa, sb) with
                      | some k => pure k
                      | none =>
                        let k := Verified.Hsmm.ServedStations.intermediateStops rels line sa sb
                        stopsCache := stopsCache.insert (line, sa, sb) k
                        pure k
                    | _, _, _ => pure none
                  let expected := match calls with
                    | some k => (pathM * journeyKmPerM / Verified.Hsmm.StationChain.RIDE_RUN_KMH) * journeyMinPerHour
                        + Verified.Hsmm.StationChain.RIDE_STOP_MIN * Verified.FloatConst.natToFloat k
                        + Verified.Hsmm.StationChain.RIDE_FIXED_MIN
                    | none => (pathM * journeyKmPerM / Verified.Hsmm.StationChain.TUBE_SPEED_KMH) * journeyMinPerHour
                        + Verified.Hsmm.StationChain.STOP_OVERHEAD_MIN
                  out := out.set! (li * T + e) expected
                  pathOut := pathOut.set! (li * T + e) pathM
                  callsOut := callsOut.set! (li * T + e) (match calls with
                    | some k => Verified.FloatConst.natToFloat k
                    | none => Verified.FloatConst.negInf)
                | none => pure ()
            return (out, names, pathOut, callsOut)
        let firstCtxL : FloatArray := Id.run do
          let mut out := Verified.FloatConst.floats (L * T) journeyZero
          for (bi, li) in baseOf.zipIdx do
            for t in [0:T] do
              out := out.set! (li * T + t) (firstCtx.get! (bi * T + t))
          return out
        let durBaseF : FloatArray := Id.run do
          let mut out := Verified.FloatConst.floats (legSlots.size * maxJ) journeyZero
          for (cls, slot) in legSlots.zipIdx do
            for d0 in [0:maxJ] do
              out := out.set! (slot * maxJ + d0) (Verified.Hsmm.Assemble.durPriorBase c reps[cls]! (d0 + 1))
          return out
        -- The pair rule beside the base matrix: a wait at σ is followed by a ride
        -- boarding at σ and by nothing else (a pause inside a walk is the walk's);
        -- other legs pair freely. The wait never ends a journey (`last` below).
        let isWaitLeg := fun (l : Nat) => (c.states[l]!).lineName == some Verified.Hsmm.Assemble.WAIT_MARK
        let pairOk : Array Bool := Id.run do
          let mut out := Array.replicate (L * L) true
          for (ea, ai) in legList.zipIdx do
            let (la, _, sa) := ea
            if !isWaitLeg la then continue
            for (eb, bi) in legList.zipIdx do
              let (lb, _, sb) := eb
              let ok := match (c.states[lb]!).mode, sa, sb with
                | .train, some x, some y => x.id == y.id
                | _, _, _ => false
              if !ok then out := out.set! (ai * L + bi) false
          return out
        let legName : Array String := legList.map fun (l, _, st?) =>
          let base := Verified.Hsmm.StateSpace.stateKey c.states[l]!
          match st? with
          | some n => base ++ "@" ++ (n.stationName.getD n.id)
          | none => base
        -- The train legs' calling evidence (`StationStops`), with the record's `stops`.
        let (stopPre, stopAlight, stopAlightPre, stopActive, stopActiveFirst, stopAlightKey) :
            FloatArray × Array (Option Nat) × Array FloatArray × FloatArray × Array Nat
              × Array (String × String) :=
          match jp.stops, g? with
          | some sp, some g => Id.run do
            let ps := Verified.Hsmm.StationStops.passes g c.obs
            let calls := fun (line : String) (st : String) => match servedSet line with
              | some served => Verified.Hsmm.ServedStations.stationNameServed served st
              | none => false
            let lineOf := fun (l : Nat) =>
              let st := c.states[l]!
              if st.mode != .train then none else
              st.lineName.filter fun n => !Verified.Hsmm.Emissions.isPlaceholderLine n
            let mut pre := Verified.FloatConst.floats (L * (T + 1)) journeyZero
            let mut active := Verified.FloatConst.floats (L * T) journeyZero
            let mut activeFirst : Array Nat := Array.replicate (L * T) T
            let mut alightIdx : Array (Option Nat) := Array.replicate (L * T) none
            let mut alightPre : Array FloatArray := #[]
            let mut alightKey : Std.HashMap (String × String) Nat := {}
            let mut alightKeys : Array (String × String) := #[]
            for (entry, li) in legList.zipIdx do
              let (l, _, st?) := entry
              let some line := lineOf l | continue
              let row := Verified.Hsmm.StationStops.prefixSum
                (Verified.Hsmm.StationStops.lineEvidence sp ps T (calls line) (st?.bind (·.stationName)))
              for t in [0:T + 1] do pre := pre.set! (li * (T + 1) + t) (row.get! t)
              let (act, actFirst) := Verified.Hsmm.StationStops.activeEvidence sp ps T (calls line)
                (st?.bind (·.stationName))
              for t in [0:T] do
                active := active.set! (li * T + t) (act.get! t)
                activeFirst := activeFirst.set! (li * T + t) actFirst[t]!
              for e in [0:T] do
                let some a := alightName[li * T + e]! | continue
                let k ← match alightKey.get? (line, a) with
                  | some k => pure k
                  | none =>
                    let k := alightPre.size
                    alightPre := alightPre.push (Verified.Hsmm.StationStops.prefixSum
                      (Verified.Hsmm.StationStops.lineEvidence sp ps T (fun x => x == a && calls line x)))
                    alightKey := alightKey.insert (line, a) k
                    alightKeys := alightKeys.push (line, a)
                    pure k
                alightIdx := alightIdx.set! (li * T + e) (some k)
            return (pre, alightIdx, alightPre, active, activeFirst, alightKeys)
          | _, _ => (FloatArray.empty, #[], #[], FloatArray.empty, #[], #[])
        let r : Verified.Hsmm.Journey.Tables :=
          { T, maxJ, journey := jI, legs := legOuter, legName, baseOf, nBase := legs.size
            stopPre, stopAlight, stopAlightPre, stopActive, stopActiveFirst, stopAlightKey
            legStation := legList.map fun (_, _, st?) => st?.bind (·.stationName)
            legNode := legList.map fun (_, _, st?) => st?.map fun n => (n.lat, n.lon)
            legSlot := legOuter.map (fun l => (slotOfCls durClass[l]!).getD 0)
            nSlots := legSlots.size, emitPre, entry := entryF, legDur, trans
            first := legOuter.map (prior true jp.firstLeg)
            last := legOuter.map fun l => if isWaitLeg l then Verified.FloatConst.negInf else prior false jp.lastLeg l
            firstCtx := firstCtxL, reachStarts, reachMask, expectedMin, alightName, pairPathM, pairCalls, boardAt, durBaseF, pairOk }
        return r
    if tablesOnly then
      -- The same base the full build returns: a journey longer than `maxJ`
      -- is impossible (the loop below).
      let mut durBaseJ := durBase
      for d0 in [maxJ:maxD] do
        for ji in jAll do
          durBaseJ := durBaseJ.set! (ji * maxD + d0) 0
      return (durClass, durBaseJ, durDelta, some tb)
    let tb := Verified.Hsmm.Journey.withOwn tb (f + 1 - maxJ)
    let inner := Verified.Hsmm.Journey.bestFrom tb (f + 1 - maxJ)
      ((inc.map (·.inner)).getD FloatArray.empty)
    -- The own-score tables served `best`; what reads the tables after it (a
    -- decoded journey's legs, the debuggers) is a few windows, and `candidate`
    -- sums the same terms in the same order, so they go before the decode.
    let noSlot : Array (Option Nat) := tb.ownSlot.map fun _ => none
    let tb := { tb with
      cell := inner
      own := FloatArray.empty
      pairOwn := #[]
      ownSlot := noSlot }
    let (durDelta, durBaseJ, bad) : Array Nat × Array Nat × Option Int := Id.run do
      let tri := Verified.Hsmm.triOff maxD T
      let mut durDelta := durDelta
      let mut durBaseJ := durBase
      let mut bad : Option Int := none
      for d0 in [0:maxD] do
        if d0 ≥ maxJ then
          for ji in jAll do
            durBaseJ := durBaseJ.set! (ji * maxD + d0) 0
          continue
        let base := Verified.Hsmm.Assemble.durPriorBase c jI (d0 + 1)
        let qRef := match quant base with
          | some v => qiOf v | none => 0
        -- From `e = d0`: a journey cannot begin before the day (`triOff`).
        for e in [max d0 f:T] do
          let w := Verified.Hsmm.SegmentEvidence.windowAt c.obs c.stepPref (d0 + 1) e
          let sst := Verified.Hsmm.SegmentEmission.statsAt c.segPref (d0 + 1) e
          let legsPart := inner.get! (d0 * T + e)
          let full := Verified.Hsmm.Assemble.durAtFromW c jI (d0 + 1) covered[e]! w sst base + legsPart
          match quant full with
          | none => durDelta := durDelta.set! (jc * tri + Verified.Hsmm.triOff maxD e + d0) 0
          | some v =>
            let (packed, over) := packDelta (qiOf v) qRef halfOB
            if over.isSome then bad := over
            durDelta := durDelta.set! (jc * tri + Verified.Hsmm.triOff maxD e + d0) packed
      return (durDelta, durBaseJ, bad)
    if let some delta := bad then throw s!"journey dur delta {delta} exceeds halfOB {halfOB}"
    return (durClass, durBaseJ, durDelta, some tb)
  | _, _, _ => return (durClass, durBase, durDelta, none)

/-- The cheap half of a day's model: emissions, entries, transitions, the
    duration bases and the journey's per-minute tables. An incremental run
    compares these with the previous run's (`todayFrontier`); every run builds
    the rest from them (`buildPDataFrom`). -/
structure Pre where
  T : Nat
  S : Nat
  halfOB : Nat
  emit : Array Nat
  entry : Array Nat
  transBase : Array Nat
  transIdx : Array Nat
  transFlat : Array Nat
  nRows : Nat
  legTrans : Option (FloatArray × FloatArray)
  durClass : Array Nat
  durBase : Array Nat
  tb : Option Verified.Hsmm.Journey.Tables

private def buildPre (c : Verified.Hsmm.Assemble.ModelContext) (maxD : Nat)
    (g? : Option Verified.Hsmm.StationChain.ChainGraph := none)
    (rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation) := none) :
    Except String Pre := do
  let T := c.obs.size
  let S := c.states.size
  if T > pTMax then throw s!"T={T} exceeds the verified envelope (T ≤ 2048)"
  let halfOB := pOB / 2
  let (emit, entry) ← buildEmitEntry c T S
  let (transBase, transIdx, transFlat, nRows, legTrans) ← buildTransitions c T S
  let (durClass, durBase, _, tb) ←
    buildDurations c T S maxD halfOB legTrans g? rels? (tablesOnly := true)
  let pre : Pre :=
    { T := T, S := S, halfOB := halfOB, emit := emit, entry := entry,
      transBase := transBase, transIdx := transIdx, transFlat := transFlat, nRows := nRows,
      legTrans := legTrans, durClass := durClass, durBase := durBase, tb := tb }
  return pre

/-- `pre`'s tables as a `PData` without its duration cells: what
    `todayFrontier` compares. -/
private def Pre.toPData (pre : Pre) (maxD : Nat) : PData :=
  { T := pre.T, S := pre.S, maxD, halfOB := pre.halfOB, emit := pre.emit, entry := pre.entry
    init := #[], transBase := pre.transBase, nTB := 1, transIdx := pre.transIdx
    transFlat := pre.transFlat, nRows := pre.nRows, durBase := pre.durBase
    durClass := pre.durClass, durDelta := #[], hasOv := #[], durOv := {} }

/-- The day's `PData` from its cheap half: with `inc`, the duration cells and
    the journey's sweeps only from `inc.f` on. -/
private def buildPDataFrom (c : Verified.Hsmm.Assemble.ModelContext) (maxD : Nat)
    (g? : Option Verified.Hsmm.StationChain.ChainGraph) 
    (rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation))
    (pre : Pre) (inc : Option IncFrom := none) :
    Except String (PData × Option Verified.Hsmm.Journey.Tables) := do
  let (durClass, durBase, durDelta, journey) ←
    buildDurations c pre.T pre.S maxD pre.halfOB pre.legTrans g? rels? inc (preTb := pre.tb)
  return ({
    T := pre.T, S := pre.S, maxD, halfOB := pre.halfOB, emit := pre.emit, entry := pre.entry
    init := #[], transBase := pre.transBase, nTB := 1, transIdx := pre.transIdx
    transFlat := pre.transFlat, nRows := pre.nRows
    durBase, durClass, durDelta, hasOv := #[], durOv := {} }, journey)

/-- Build the packed `PData` directly from the assembled model — the in-process
    twin of `quantizeModel` + `parseModel`, so `verified_cli` goes raw-inputs →
    trellis with NO marshalled tensor payload. Transitions are per-`t` dense
    (`nTB = T`); durations use the `(mode, isNamedTrain)` class factorisation
    (`durBase`, the prior, + `durDelta` per class), the compact form the decoder
    reads. Scores are finite here (log-probabilities), so no -∞ path arises. -/
private def buildPData (c : Verified.Hsmm.Assemble.ModelContext) (maxD : Nat)
    (g? : Option Verified.Hsmm.StationChain.ChainGraph := none)
    (rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation) := none) :
    Except String (PData × Option Verified.Hsmm.Journey.Tables) := do
  buildPDataFrom c maxD g? rels? (← buildPre c maxD g? rels?)

/-- `verified_cli decodetrace`: the per-minute line evidence over a window, for
reading why a ride took its line. An `assemblesegments` request plus
`"window": [tsFrom, tsTo]`; per minute: the generator's coverage, and per state
(place stays excepted) the emission, the entry prior, and the transition into
it from `walking` and `stationary`. -/
private def decodeTraceResult (j : Json) : Json :=
  match parseAssemble j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (c, _) =>
    let bound (i : Nat) : Option Int :=
      match j.getObjVal? "window" >>= (·.getArr?) with
      | .ok a => a[i]?.bind fun x => (x.getInt?).toOption
      | .error _ => none
    match bound 0, bound 1 with
    | some t0, some t1 =>
      let fl (v : Float) : Json := if v == Verified.Hsmm.FloatScore.negInf then Json.null else Lean.toJson v
      let idxOf (p : Verified.Hsmm.Emissions.State → Bool) : Option Nat :=
        (List.range c.states.size).find? fun i => match c.states[i]? with
          | some s => p s | none => false
      let walkIdx := idxOf fun s => s.mode == .walking
      let statIdx := idxOf fun s => s.mode == .stationary && s.placeId.isNone
      let rows := (List.range c.obs.size).filterMap fun t =>
        match c.obs[t]? with
        | none => none
        | some o =>
          if o.ts < t0 || o.ts > t1 then none else
          let states := (List.range c.states.size).filterMap fun si =>
            match c.states[si]? with
            | none => none
            | some st =>
              -- Every state but the place stays: the rides, the walk, and
              -- the placeless stay a platform wait decodes as.
              if st.mode == .stationary && st.placeId.isSome then none
              else
                let from_ (a : Option Nat) : Json := match a with
                  | some ai => fl (Verified.Hsmm.Assemble.transAt c ai si t)
                  | none => Json.null
                some (Json.mkObj [
                  ("key", Json.str (Verified.Hsmm.StateSpace.stateKey st)),
                  ("emit", fl (Verified.Hsmm.Assemble.emitAt c t si)),
                  ("entry", fl (Verified.Hsmm.Assemble.entryAt c t si)),
                  ("fromWalk", from_ walkIdx),
                  ("fromStat", from_ statIdx)])
          some (Json.mkObj [
            ("ts", Lean.toJson o.ts),
            ("gps", Json.bool o.gps.isSome),
            ("covered", Json.bool (Verified.Hsmm.TrainCandidates.isCovered c.coverage o.ts)),
            ("lines", Json.arr ((Verified.Hsmm.TrainCandidates.linesAt c.coverage o.ts).map Json.str).toArray),
            ("states", Json.arr states.toArray)])
      Json.mkObj [("minutes", Json.arr rows.toArray)]
    | _, _ => Json.mkObj [("error", Json.str "window: [tsFrom, tsTo] required")]

/-- The journey state's station graph and stop relations, from the request:
    what the leg tables need before the decode. `none` without the journey
    state. One definition for the serving path and the profiler, so the
    profiler times the decode the server runs. -/
private def journeyInputs (c : Verified.Hsmm.Assemble.ModelContext) (j : Json) :
    Option Verified.Hsmm.StationChain.ChainGraph
      × Option (Array Verified.Hsmm.ServedStations.RailStopRelation) :=
  let g? : Option Verified.Hsmm.StationChain.ChainGraph :=
    if (Verified.Hsmm.Assemble.journeyIdx c).isNone then none else
    match (optArr j "nodes") >>= (·.mapM parseChainNode) with
    | .error _ => none
    | .ok nodes => some
      { model := c.model, nodes
      , nodeById := nodes.foldl (fun m n => m.insert n.id n) {}
      , edgeById := c.model.edges.foldl (fun m e => m.insert e.id e) {} }
  let rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation) :=
    if g?.isNone then none else
    match j.getObjVal? "railStopRelations" with
    | .ok v => if v.isNull then none else ((v.getArr?) >>= (·.mapM parseRelation)).toOption
    | .error _ => none
  (g?, rels?)

/-- `verified_cli decodeprof`: the decoder's cost on one day, apart from the
model build. An `assemblesegments` request plus `"runs"` (default 5): builds
`PData` once, times `sDecode` per run (each pinned by `IO.lazyPure`), and
replies with the trellis shape, `buildMs`, every `decodeMs`, and the best score,
which every run must agree on.

The instrument for a trellis change: `hsmm_decode_corpus` proves a decode exact,
but its wall time swings 2× and cannot see a 10% change. -/
private def decodeProfMain (input : String) : IO UInt32 := do
  match Json.parse input with
  | .error e => IO.eprintln s!"error: {e}"; return 1
  | .ok j =>
    let runs := (j.getObjVal? "runs" >>= (·.getNat?)).toOption.getD 5
    match parseAssemble j with
    | .error e => IO.eprintln s!"error: {e}"; return 1
    | .ok (c, maxD) =>
      -- The three build phases one at a time, then the whole build as the
      -- decoder gets it; the phases are re-run inside the whole, so
      -- `buildMs` stays the decoder's own number and the phases sum to it.
      let (T, S, halfOB) := (c.obs.size, c.states.size, pOB / 2)
      let p0 ← IO.monoMsNow
      let ee ← IO.lazyPure fun _ => buildEmitEntry c T S
      let p1 ← IO.monoMsNow
      let tr ← IO.lazyPure fun _ => buildTransitions c T S
      let p2 ← IO.monoMsNow
      -- The durations as the server builds them: the journey's legs with
      -- their station graph and stops.
      let (g?, rels?) := journeyInputs c j
      -- Once without the journey's legs: the per-class cells alone, so the
      -- journey pass is the difference.
      let du0 ← IO.lazyPure fun _ => buildDurations c T S maxD halfOB none g? rels?
      let p2j ← IO.monoMsNow
      let du ← IO.lazyPure fun _ => buildDurations c T S maxD halfOB
        (match tr with | .ok (_, _, _, _, lt) => lt | .error _ => none) g? rels?
      let p3 ← IO.monoMsNow
      -- Sizes, so the phase values are demanded and not merely thunked.
      let phaseCells : Nat :=
        (match ee with | .ok (e, _) => e.size | .error _ => 0)
        + (match tr with | .ok (_, _, f, _, _) => f.size | .error _ => 0)
        + (match du with | .ok (_, _, d, _) => d.size | .error _ => 0)
        + (match du0 with | .ok (_, _, d, _) => d.size | .error _ => 0)
      let t0 ← IO.monoMsNow
      let built ← IO.lazyPure fun _ => buildPData c maxD g? rels?
      let t1 ← IO.monoMsNow
      match built with
      | .error e => IO.eprintln s!"error: {e}"; return 1
      | .ok (pd, _) =>
        let mut times : Array Nat := #[]
        let mut bests : Array String := #[]
        for _ in [0:runs] do
          let a ← IO.monoMsNow
          let r ← IO.lazyPure fun _ => Verified.Hsmm.sDecode pd
          let b ← IO.monoMsNow
          times := times.push (b - a)
          bests := bests.push (match r with
            | none => "degenerate"
            | some r => match r.best with | .val v => toString v | .negInf => "null")
        let best := bests.getD 0 "degenerate"
        if bests.any (· != best) then
          IO.eprintln s!"error: the runs disagree on the best score: {bests}"
          return 1
        IO.println (Json.mkObj [
          ("T", Lean.toJson pd.T), ("S", Lean.toJson pd.S), ("maxD", Lean.toJson pd.maxD),
          ("buildMs", Lean.toJson (t1 - t0)),
          ("buildPhasesMs", Json.mkObj [("emitEntry", Lean.toJson (p1 - p0)),
            ("transitions", Lean.toJson (p2 - p1)), ("durations", Lean.toJson (p3 - p2j)),
            ("durationCells", Lean.toJson (p2j - p2)),
            ("phaseCells", Lean.toJson phaseCells)]),
          ("decodeMs", Json.arr (times.map Lean.toJson)),
          ("best", Json.str best)]).compress
        return 0

/-! ## `assemblesegments` — assemble, decode, and return segments

A decode is a path of state indices, meaningless without `c.states`, which
never crosses: the grouping into `{mode, placeId, lineName}` runs
(`HsmmSegments.groupStates`) happens here, once, and the reply is what
`decoded_days` stores. The timestamps come from `c.obs`, which the path indexes;
any other source could disagree in length or order. -/
private def MINUTES_PER_HOUR : Float := 60

/-- `"emissionDebug": {"fromTs": n, "toTs": n}` on an `assemblesegments` request:
every state's per-minute emission and entry over the window, beside the state
the decode chose — the instrument for a minute that went to the wrong mode, as
`chainDebug` is for a wrong line. Each minute also carries what the decoder
observed of it (the windowed speed, the rail class, in bed, the minute's
position and accuracy), and `"segments": [[fromTs, toTs], …]` asks for each
span's net-displacement window (`SegmentEvidence.windowAt`): what the fitter
(`fit_emissions`) measures, observed exactly as the decoder observes it. -/
private def emissionDebugJson (c : Verified.Hsmm.Assemble.ModelContext) (path : Array Nat)
    (dj : Json) : Json :=
  let fromTs := (dj.getObjValAs? Int "fromTs").toOption.getD 0
  let toTs := (dj.getObjValAs? Int "toTs").toOption.getD 0
  let optF := fun (x : Option Float) => match x with | some v => Lean.toJson v | none => Json.null
  let rows := (c.obs.zipIdx.filter fun (o, _) => fromTs ≤ o.ts && o.ts ≤ toTs).map fun (o, t) =>
    let decoded := (path[t]?.bind fun i => c.states[i]?).map Verified.Hsmm.StateSpace.stateKey
    let per := c.states.zipIdx.map fun (st, s) =>
      Json.mkObj [("state", Json.str (Verified.Hsmm.StateSpace.stateKey st)),
                  ("emit", Lean.toJson (Verified.Hsmm.Assemble.emitAt c t s)),
                  -- What `SegmentEmission` changes in the minute's emission:
                  -- its base remainder and minute terms against the whole base.
                  ("seg", Lean.toJson (c.weights.base
                      * (Verified.Hsmm.Assemble.segBaseAt c.segEm c st o
                        - Verified.Hsmm.Emissions.emissionLogProb st (Verified.Hsmm.EmissionFull.toThin o)
                            (st.placeId.bind (c.placeCoords.get? ·)) c.priors)
                    + Verified.Hsmm.Assemble.segMinuteAt c.segEm c t st o)),
                  -- The base's parts, for the state a reader asks about: the
                  -- speed Gaussian, the place term, the geometric reach, the
                  -- gap share, the cadence, the heart rate.
                  ("parts", let prior := Verified.Hsmm.Emissions.priorOf c.priors st
                    let thin := Verified.Hsmm.EmissionFull.toThin o
                    let placeCoord := st.placeId.bind (c.placeCoords.get? ·)
                    let geo := fun (f : Verified.Hsmm.Observation.Fix) =>
                      (⟨Verified.FloatConst.natToFloat f.ts.toNat, f.lat, f.lon⟩ : Verified.Hsmm.Geometric.GpsFix)
                    Json.mkObj [
                      ("speed", Lean.toJson (Verified.Hsmm.Emissions.speedTerm st thin prior)),
                      ("place", Lean.toJson (Verified.Hsmm.Emissions.placeTerm st thin placeCoord)),
                      ("geom", Lean.toJson (Verified.Hsmm.Geometric.geometricFeasibility st (Verified.FloatConst.natToFloat o.ts.toNat)
                        (o.prevGpsFix.map geo) (o.nextGpsFix.map geo) placeCoord c.priors)),
                      ("gap", Lean.toJson (Verified.Hsmm.Geometric.gapTerm st o.gps.isSome
                        (o.prevGpsFix.map geo) (o.nextGpsFix.map geo) c.priors)),
                      ("cad", Lean.toJson (match o.cadence with
                        | some cd => Verified.Hsmm.Emissions.logCadencePdf cd prior | none => (0 : Float))),
                      ("hr", Lean.toJson (Verified.Hsmm.Emissions.hrTerm st thin prior))]),
                  ("entry", Lean.toJson (Verified.Hsmm.Assemble.entryAt c t s))]
    Json.mkObj [("ts", Lean.toJson o.ts),
                ("speedKmh", optF (o.gps.map (·.speedKmh))),
                ("cadence", optF o.cadence), ("hr", optF o.hr),
                ("railDistM", optF o.railDistM),
                ("prevFixTs", match o.prevGpsFix with | some f => Lean.toJson f.ts | none => Json.null),
                ("nextFixTs", match o.nextGpsFix with | some f => Lean.toJson f.ts | none => Json.null),
                ("decoded", match decoded with | some k => Json.str k | none => Json.null),
                ("covered", Json.bool (Verified.Hsmm.TrainCandidates.isCovered c.coverage o.ts)),
                ("linesAt", Json.arr ((Verified.Hsmm.TrainCandidates.linesAt c.coverage o.ts).map Json.str).toArray),
                ("pairKmh", optF ((Verified.Hsmm.Assemble.pairSpan c.obs t).map (·.1))),
                ("obsClass", Lean.toJson (Verified.Hsmm.SegmentEmission.obsClass o)),
                ("inBed", Json.bool o.inBed),
                ("lat", optF (o.gps.map (·.lat))), ("lon", optF (o.gps.map (·.lon))),
                ("accuracyM", optF (o.gps.bind (·.accuracyM))),
                ("states", Json.arr per)]
  let spans : Array Json := ((dj.getObjVal? "segments") >>= (·.getArr?)).toOption.getD #[]
  let idxOf := fun (ts : Int) => c.obs.findIdx? (·.ts == ts)
  let windows := spans.map fun sp =>
    let a := ((sp.getArrVal? 0) >>= (·.getInt?)).toOption
    let b := ((sp.getArrVal? 1) >>= (·.getInt?)).toOption
    match a.bind idxOf, b.bind idxOf with
    | some i, some e =>
      if e < i then Json.null else
      match Verified.Hsmm.SegmentEvidence.windowAt c.obs c.stepPref (e - i + 1) e with
      | some w =>
        -- The span `dispScoreWith` divides by: the minutes and the bracket slop's.
        let hours := (Verified.FloatConst.natToFloat (e - i + 1)
          + Float.sqrt w.slopVar / Verified.Hsmm.SegmentEvidence.SLOP_SPEED_M_PER_MIN) / MINUTES_PER_HOUR
        Json.mkObj [("dispM", Lean.toJson w.dispM), ("hours", Lean.toJson hours)]
      | none => Json.null
    | _, _ => Json.null
  Json.mkObj [("emissionDebug", Json.arr rows), ("segWindows", Json.arr windows)]

private def PATH_ZERO : Float := 0

/-- `"segScore": {"segs": [{"startTs": n, "endTs": n, "state": "<stateKey>"}]}` on
an `assemblesegments` request: each segment over `[startTs, endTs)` scored
alone with the model's own cells — the summed `emitAt`, `entryAt`, the
duration prior and the segment-level emissions (`durAt`, or the inner pass's
cell for a journey) — and no transition. Two segments of one state back to
back, which no path can write, are two entries here: the instrument for the
decoder's invariants (whether a stretch scores better split). -/
private def segScoreJson (c : Verified.Hsmm.Assemble.ModelContext) (dj : Json)
    (journey : Option Verified.Hsmm.Journey.Tables) : Json :=
  let fl (v : Float) : Json := if v == Verified.Hsmm.FloatScore.negInf then Json.null else Lean.toJson v
  let segs : Array Json := ((dj.getObjVal? "segs") >>= (·.getArr?)).toOption.getD #[]
  Json.arr <| segs.map fun a =>
    let s0 := (a.getObjValAs? Int "startTs").toOption.getD 0
    let s1 := (a.getObjValAs? Int "endTs").toOption.getD 0
    let key := (a.getObjValAs? String "state").toOption.getD ""
    let lo := c.obs.foldl (fun acc o => if o.ts < s0 then acc + 1 else acc) 0
    let hi := c.obs.foldl (fun acc o => if o.ts < s1 then acc + 1 else acc) 0
    match c.states.findIdx? (fun st => Verified.Hsmm.StateSpace.stateKey st == key) with
    | none => Json.mkObj [("error", Json.str s!"no state {key}")]
    | some s =>
      if hi ≤ lo then Json.mkObj [("error", Json.str "empty segment")] else
      let d := hi - lo
      let last := hi - 1
      let emit := (List.range d).foldl (fun acc i => acc + Verified.Hsmm.Assemble.emitAt c (lo + i) s) PATH_ZERO
      let cell := match journey with
        | some tb =>
          if s == tb.journey then
            (if d ≤ tb.maxJ then tb.cell.get! ((d - 1) * tb.T + last)
               + Verified.Hsmm.Assemble.durAt c s d last else Verified.FloatConst.negInf)
          else Verified.Hsmm.Assemble.durAt c s d last
        | none => Verified.Hsmm.Assemble.durAt c s d last
      let entry := Verified.Hsmm.Assemble.entryAt c lo s
      -- A journey's best legs over the segment, each with its terms.
      let legs : Json := match journey with
        | some tb =>
          if s == tb.journey && d ≤ tb.maxJ then
            let (ls, _) := Verified.Hsmm.Journey.scoreLegs tb lo (Verified.Hsmm.Journey.legsPath tb lo last)
            Json.arr (ls.map fun x => Json.mkObj [
              ("leg", Json.str (tb.legName.getD x.leg "?")), ("d", Lean.toJson x.d),
              ("prev", fl x.prev), ("emit", fl x.emit), ("entry", fl x.entry), ("cell", fl x.cell)])
          else Json.null
        | none => Json.null
      Json.mkObj [
        ("state", Json.str key), ("d", Lean.toJson d), ("legs", legs),
        ("entry", fl entry), ("emit", fl emit), ("cell", fl cell),
        ("durPrior", fl (Verified.Hsmm.Assemble.durPriorBase c s d)),
        ("segParts", Json.mkObj ((Verified.Hsmm.Assemble.segEmParts c s d
          (Verified.Hsmm.SegmentEvidence.windowAt c.obs c.stepPref d last)
          (Verified.Hsmm.SegmentEmission.statsAt c.segPref d last)).map fun (k, v) => (k, fl v))),
        ("total", fl (entry + emit + cell))]

/-- `"pathDebug": {"alt": [{"startTs": n, "endTs": n, "state": "<stateKey>"}]}` on
an `assemblesegments` request: the decoded path, and the decoded path with the
caller's segments written over `[startTs, endTs)`, each scored segment by
segment with the model's own cells (`initAt`, the trellis's transitions,
`entryAt`, `emitAt`, `durAt`, composed as `Spec.scoreAux`) — the instrument for a boundary the
decode did not place: which term paid for leaving it out. A written-over run
may exceed `maxD`; `durAt` still prices it, the trellis never would. -/
private def pathDebugJson (c : Verified.Hsmm.Assemble.ModelContext) (path : Array Nat)
    (dj : Json) (journey : Option Verified.Hsmm.Journey.Tables := none) (pd : Option PData := none) : Json :=
  let fl (v : Float) : Json := if v == Verified.Hsmm.FloatScore.negInf then Json.null else Lean.toJson v
  let alts : Array Json := ((dj.getObjVal? "alt") >>= (·.getArr?)).toOption.getD #[]
  let (altPath, bad) : Array Nat × Option String := Id.run do
    let mut p := path
    let mut bad : Option String := none
    for a in alts do
      let s0 := (a.getObjValAs? Int "startTs").toOption.getD 0
      let s1 := (a.getObjValAs? Int "endTs").toOption.getD 0
      let key := (a.getObjValAs? String "state").toOption.getD ""
      match c.states.findIdx? (fun st => Verified.Hsmm.StateSpace.stateKey st == key) with
      | none => bad := some s!"no state {key}"
      | some si =>
        for (o, t) in c.obs.zipIdx do
          if s0 ≤ o.ts && o.ts < s1 then p := p.set! t si
    return (p, bad)
  let rows (p : Array Nat) : Array Json × Float := Id.run do
    let mut start := 0
    let mut prev : Option Nat := none
    let mut out : Array Json := #[]
    let mut total := PATH_ZERO
    for seg in Verified.Hsmm.ofPath p.toList do
      let last := start + seg.dur - 1
      -- The trellis's own transition where it has one: under the journey a
      -- stay and the journey exchange by the outer rule, which the flat
      -- model's `transAt` does not know.
      let trans := match prev, pd with
        | none, _ => Verified.Hsmm.Assemble.initAt c seg.state
        | some sp, some d => match Verified.Hsmm.dec (d.transAt sp seg.state start) with
          | .val v => Float.ofInt v / Verified.Hsmm.Quantize.SCALE
          | .negInf => Verified.FloatConst.negInf
        | some sp, none => Verified.Hsmm.Assemble.transAt c sp seg.state start
      let entry := Verified.Hsmm.Assemble.entryAt c start seg.state
      let emit := (List.range seg.dur).foldl
        (fun acc i => acc + Verified.Hsmm.Assemble.emitAt c (start + i) seg.state) PATH_ZERO
      -- A journey's cell is the inner pass's, not `durAt`'s.
      let dur := match journey with
        | some tb =>
          if seg.state == tb.journey then
            -- The legs' inner pass, and the journey's own level and duration,
            -- as the trellis's cell sums them.
            (if seg.dur ≤ tb.maxJ then tb.cell.get! ((seg.dur - 1) * tb.T + last)
               + Verified.Hsmm.Assemble.durAt c seg.state seg.dur last else Verified.FloatConst.negInf)
          else Verified.Hsmm.Assemble.durAt c seg.state seg.dur last
        | none => Verified.Hsmm.Assemble.durAt c seg.state seg.dur last
      let sum := trans + entry + emit + dur
      total := total + sum
      out := out.push (Json.mkObj [
        ("state", Json.str (match c.states[seg.state]? with
          | some st => Verified.Hsmm.StateSpace.stateKey st | none => "?")),
        ("startTs", Lean.toJson (match c.obs[start]? with | some o => o.ts | none => 0)),
        ("endTs", Lean.toJson (match c.obs[last]? with | some o => o.ts + 60 | none => 0)),
        ("d", Lean.toJson seg.dur),
        ("trans", fl trans), ("entry", fl entry), ("emit", fl emit), ("dur", fl dur),
        -- `dur`'s parts: the mode's duration prior and the segment-level
        -- emissions; the rest is the train-hop relaxation and `SegmentEvidence`.
        ("durPrior", fl (Verified.Hsmm.Assemble.durPriorBase c seg.state seg.dur)),
        ("segEm", fl (Verified.Hsmm.Assemble.segEmAt c seg.state seg.dur last)),
        ("segParts", Json.mkObj ((Verified.Hsmm.Assemble.segEmParts c seg.state seg.dur
          (Verified.Hsmm.SegmentEvidence.windowAt c.obs c.stepPref seg.dur last)
          (Verified.Hsmm.SegmentEmission.statsAt c.segPref seg.dur last)).map fun (k, v) => (k, fl v))),
        ("total", fl sum)])
      start := start + seg.dur
      prev := some seg.state
    return (out, total)
  -- What sharing the levels would give back (docs/proposals/2026-10-shared-levels.md,
  -- stage 1): for a state that resumes after one segment of at most ten
  -- minutes, its heart-rate/fix-share term and duration prior scored once over
  -- both parts against twice, one part each.
  let shares (p : Array Nat) : Array Json := Id.run do
    let segs := (Verified.Hsmm.ofPath p.toList).toArray
    let starts := segs.foldl (fun (acc : Array Nat × Nat) sg => (acc.1.push acc.2, acc.2 + sg.dur)) (#[], 0) |>.1
    let mut out : Array Json := #[]
    for i in [0:segs.size] do
      match segs[i]?, segs[i + 1]?, segs[i + 2]?, starts[i]?, starts[i + 2]?, c.states[(segs[i]?).map (·.state) |>.getD 0]? with
      | some a, some mid, some b, some sa, some sb, some st =>
        if a.state == b.state && mid.dur ≤ 10 then
          let stA := Verified.Hsmm.SegmentEmission.statsAt c.segPref a.dur (sa + a.dur - 1)
          let stB := Verified.Hsmm.SegmentEmission.statsAt c.segPref b.dur (sb + b.dur - 1)
          let both : Verified.Hsmm.SegmentEmission.Stats :=
            { n := stA.n + stB.n, hrN := stA.hrN + stB.hrN, hrSum := stA.hrSum + stB.hrSum
              hrSq := stA.hrSq + stB.hrSq, fixN := stA.fixN + stB.fixN
              bedN := stA.bedN + stB.bedN, bedSum := stA.bedSum + stB.bedSum, bedSq := stA.bedSq + stB.bedSq
              lo := stA.lo, hi := stB.hi }
          let sc := fun (x : Verified.Hsmm.SegmentEmission.Stats) =>
            Verified.Hsmm.SegmentEmission.scorePrepared c.segEm st.mode x
          let apart := sc stA + sc stB + Verified.Hsmm.Assemble.durPriorBase c a.state a.dur
            + Verified.Hsmm.Assemble.durPriorBase c b.state b.dur
          let pooled := sc both + Verified.Hsmm.Assemble.durPriorBase c a.state (a.dur + b.dur)
          out := out.push (Json.mkObj [
            ("state", Json.str (Verified.Hsmm.StateSpace.stateKey st)),
            ("startTs", Lean.toJson (match c.obs[sa]? with | some o => o.ts | none => 0)),
            ("gap", Lean.toJson mid.dur),
            ("apart", fl apart), ("pooled", fl pooled), ("gain", fl (pooled - apart))])
      | _, _, _, _, _, _ => pure ()
    return out
  let (dRows, dTot) := rows path
  let (aRows, aTot) := rows altPath
  Json.mkObj [("decoded", Json.arr dRows), ("decodedTotal", fl dTot),
              ("alt", Json.arr aRows), ("altTotal", fl aTot),
              ("decodedShares", Json.arr (shares path)), ("altShares", Json.arr (shares altPath)),
              ("error", match bad with | some e => Json.str e | none => Json.null)]

/-- `"journeyDebug": {"alt": [{startTs, endTs, leg}]}` under the journey state:
every decoded journey's legs with their terms, and — for the journey the
alternative's segments tile exactly — the forced legs scored the same way.
`leg` is a leg's name (`train|Metropolitan Line`, or with `@Station` for a
board-station leg). What `path_debug` cannot see inside a journey. -/
private def journeyDebugJson (c : Verified.Hsmm.Assemble.ModelContext)
    (tb : Verified.Hsmm.Journey.Tables) (path : Array Nat) (dj : Json) : Json :=
  let fl (v : Float) : Json := if v == Verified.FloatConst.negInf then Json.null else Lean.toJson v
  let tsOf : Nat → Int := fun t => match c.obs[t]? with | some o => o.ts | none => 0
  let legJson := fun (s0 : Nat) (ls : Array Verified.Hsmm.Journey.LegScore) (total : Float) =>
    Json.mkObj [
      ("startTs", Lean.toJson (tsOf s0)),
      ("total", fl total),
      ("legs", Json.arr (ls.map fun x => Json.mkObj [
        ("leg", Json.str (tb.legName.getD x.leg "?")),
        ("startTs", Lean.toJson (tsOf x.start)),
        ("endTs", Lean.toJson (tsOf (x.start + x.d - 1) + 60)),
        ("d", Lean.toJson x.d), ("prev", fl x.prev), ("emit", fl x.emit), ("entry", fl x.entry),
        ("board", fl x.board), ("cell", fl x.cell), ("expectedMin", fl x.expectedMin),
        -- The cell's parts: the duration term (pair density or generic prior),
        -- the segment terms, the calling evidence.
        ("cellParts", Json.mkObj [("dur", fl x.cellDur), ("seg", fl x.cellSeg), ("stop", fl x.cellStop)]),
        -- A forced leg is scored whether or not the trellis could start it
        -- here: `false` names a path the decoder was never offered.
        ("reach", Json.bool (tb.reachMask.getD (x.leg * tb.T + x.start) true)),
        -- The start rule's facts at the minute before, the start and the minute
        -- after, against the leg's station node: whether the minute has a fix,
        -- and the metres from its median, first, last and carried fix.
        ("start", match tb.legNode.getD x.leg none with
          | none => Json.null
          | some (nlat, nlon) => Json.arr ((List.range 3).toArray.filterMap fun k =>
              if x.start + k == 0 then none else
              let t := x.start + k - 1
              match c.obs[t]? with
              | none => none
              | some o =>
                let dOf := fun (f : Option (Float × Float)) => match f with
                  | some (la, lo) => fl (Verified.Hsmm.FloatScore.haversineMeters la lo nlat nlon)
                  | none => Json.null
                some (Json.mkObj [("ts", Lean.toJson o.ts), ("seen", Json.bool o.gps.isSome),
                  ("median", dOf (o.gps.map fun g => (g.lat, g.lon))),
                  ("first", dOf (o.firstFix.map fun f => (f.lat, f.lon))),
                  ("last", dOf (o.lastFix.map fun f => (f.lat, f.lon))),
                  ("carried", dOf (o.prevGpsFix.map fun f => (f.lat, f.lon))),
                  ("carriedAgeS", match o.prevGpsFix with | some f => Lean.toJson (o.ts - f.ts) | none => Json.null)]))),
        ("alight", match tb.alightName[x.leg * tb.T + (x.start + x.d - 1)]? with
          | some (some a) => Json.str a
          | _ => Json.null),
        ("pathM", if tb.pairPathM.size == 0 then Json.null
          else fl (tb.pairPathM.get! (x.leg * tb.T + (x.start + x.d - 1)))),
        ("calls", if tb.pairCalls.size == 0 then Json.null
          else fl (tb.pairCalls.get! (x.leg * tb.T + (x.start + x.d - 1)))),
        ("total", fl (x.prev + x.emit + x.entry + x.board + x.cell))]))]
  -- The alternative: segments by leg name, each over `[startTs, endTs)`.
  let alts : Array Json := ((dj.getObjVal? "alt") >>= (·.getArr?)).toOption.getD #[]
  let altLegs : Array (Nat × Nat × Nat) := alts.filterMap fun a => do
    let s0 := (a.getObjValAs? Int "startTs").toOption.getD 0
    let s1 := (a.getObjValAs? Int "endTs").toOption.getD 0
    let name := (a.getObjValAs? String "leg").toOption.getD ""
    let l ← tb.legName.findIdx? (· == name)
    let t0 ← c.obs.findIdx? (·.ts == s0)
    let t1 := c.obs.foldl (fun acc o => if o.ts < s1 then acc + 1 else acc) 0
    if t1 ≤ t0 then none else some (l, t0, t1 - t0)
  let (out, _) := Id.run do
    let mut out : Array Json := #[]
    let mut i := 0
    while i < path.size do
      if (c.states[path[i]!]?.map (·.mode == .unknown)).getD false then
        let mut j := i
        while j + 1 < path.size && path[j + 1]! == path[i]! do j := j + 1
        let decoded := Verified.Hsmm.Journey.legsPath tb i j
        let (ds, dt) := Verified.Hsmm.Journey.scoreLegs tb i decoded
        let forced : Option Json :=
          let inside := altLegs.filter fun (_, t0, d) => t0 ≥ i && t0 + d - 1 ≤ j
          if inside.isEmpty then none else
          let span := inside.foldl (fun acc (_, _, d) => acc + d) 0
          if span != j + 1 - i then some (Json.mkObj [("error", Json.str s!"the alternative covers {span} of the journey's {j + 1 - i} minutes")]) else
          let (fs, ft) := Verified.Hsmm.Journey.scoreLegs tb i (inside.map fun (l, _, d) => (l, d))
          some (legJson i fs ft)
        out := out.push (Json.mkObj [("decoded", legJson i ds dt), ("alt", forced.getD Json.null)])
        i := j + 1
      else
        i := i + 1
    return (out, ())
  Json.mkObj [("journeys", Json.arr out),
    ("legNames", Json.arr (tb.legName.map Json.str))]

/-- The served answer for a decoded day: the segments, the journey's legs, the
    station chain and the debuggers a request asks for. -/
private def segmentsOf (j : Json) (c : Verified.Hsmm.Assemble.ModelContext)
    (g? : Option Verified.Hsmm.StationChain.ChainGraph)
    (rels? : Option (Array Verified.Hsmm.ServedStations.RailStopRelation))
    (pd : PData) (journey : Option Verified.Hsmm.Journey.Tables) (r : DecodeResult) : Json :=
  if let .ok dj := j.getObjVal? "emissionDebug" then
    -- The stations the day passes, each with the lines calling there:
    -- the fitter's population for `journey.stops`.
    let passesJ : Json := match g? with
      | none => Json.null
      | some g => Json.arr ((Verified.Hsmm.StationStops.passes g c.obs).map fun q =>
        let calling := Verified.Hsmm.Assemble.KNOWN_LINES.filter fun line => match rels? with
          | some rels => match Verified.Hsmm.ServedStations.servedStationSet rels line with
            | some served => Verified.Hsmm.ServedStations.stationNameServed served q.station
            | none => false
          | none => false
        Json.mkObj [("station", Json.str q.station),
          ("ts", Lean.toJson ((c.obs[q.t]?.map (·.ts)).getD 0)),
          ("speedKmh", Lean.toJson q.speedKmh),
          ("firstTs", Lean.toJson ((c.obs[q.first]?.map (·.ts)).getD 0)),
          ("lastTs", Lean.toJson ((c.obs[q.last]?.map (·.ts)).getD 0)),
          ("calls", Json.arr (calling.map Json.str).toArray)])
    (emissionDebugJson c r.path dj).setObjVal! "stationPasses" passesJ else
  if let .ok dj := j.getObjVal? "pathDebug" then pathDebugJson c r.path dj journey (some pd) else
  if let .ok dj := j.getObjVal? "segScore" then Json.mkObj [("segScore", segScoreJson c dj journey)] else
  if let .ok dj := j.getObjVal? "journeyDebug" then
    (match journey with
     | some tb => journeyDebugJson c tb r.path dj
     | none => Json.mkObj [("error", Json.str "journeyDebug needs the journey state (segEmission.journey)")]) else
  -- Under the journey state, each journey segment becomes its legs.
  let isJ := fun (i : Nat) => (c.states[i]?.map (·.mode == .unknown)).getD false
  -- The longest decoded journey, in minutes: the decode corpus holds it
  -- under `maxJ`, a table size that must never bind (`JourneyParams`).
  let longestJourneyMin : Nat := Id.run do
    let mut best := 0
    let mut run := 0
    for i in r.path do
      run := if isJ i then run + 1 else 0
      if run > best then best := run
    return best
  let path := match journey with
    | some tb => Verified.Hsmm.Journey.expand tb r.path isJ
    | none => r.path
  -- The leg each minute inside a journey came from: a wait's station rides on it.
  let legAt : Array (Option Nat) := match journey with
    | some tb => Verified.Hsmm.Journey.expandLegs tb r.path isJ
    | none => #[]
  -- Index → the state the model actually holds. An out-of-range index is
  -- an ERROR, not a skipped minute: it would shorten the path and shift
  -- every later segment boundary.
  let states : Except String (Array Verified.HsmmSegments.State) :=
    path.foldlM (fun acc i => do
      match c.states[i]? with
      | none => throw s!"decoded state index {i} is outside the {c.states.size}-state space"
      | some s => pure (acc.push
          { mode := Verified.Hsmm.StateSpace.modeName s.mode
          , placeId := s.placeId
            -- An unnamed metro is rail with no line to every reader.
          , lineName := if s.lineName == some Verified.Hsmm.Emissions.UNKNOWN_METRO then some "unknown_rail"
              else s.lineName })) #[]
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
    | some segs0 =>
      let folded := Verified.HsmmSegments.foldRideWaits segs0
      -- A decoded wait's station, from its leg at its first minute: the
      -- segment leaves as a stay AT the station, so the fold's stay namer
      -- cannot name it after the venue beside it and absorb the walk.
      let obsT0 := (c.obs[0]?.map (·.ts)).getD 0
      let waitStation : Array (Option String) := folded.map fun s =>
        if s.lineName != some Verified.Hsmm.Assemble.WAIT_MARK then none else
        match journey with
        | none => none
        | some tb =>
          let t := ((s.startTs - obsT0) / 60).toNat
          (legAt[t]?.bind id).bind fun l => tb.legStation[l]?.bind id
      let segs := folded.map fun s =>
        if s.lineName == some Verified.Hsmm.Assemble.WAIT_MARK then { s with lineName := none } else s
      -- The station chain runs here, where the observation tensor already is
      -- (the `stationchain` mode would put it back on the wire). The graph comes
      -- from `c.model`, not a fresh `mkChainGraph`: `edgesNearIdx` reads
      -- `model.edges` in builder order, and reusing the object guarantees it.
      let chained : Except String (Array Json) := do
        let nodes ← (← optArr j "nodes").mapM parseChainNode
        -- Absent and `[]` differ: absent means the mirror was never consulted
        -- (every `servedPen` 0), empty means it had nothing.
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
            -- A ride's pair from its journey leg: the board station of
            -- the leg at its first minute, the alight at its last.
            let (jb, ja) : Option String × Option String :=
              if s.mode != "train" then (none, none) else
              match journey with
              | none => (none, none)
              | some tb =>
                let t := ((s.startTs - obsT0) / 60).toNat
                let e := ((s.endTs - obsT0) / 60).toNat - 1
                match legAt[t]?.bind id with
                | none => (none, none)
                | some l =>
                  ( tb.legStation[l]?.bind id
                  , tb.alightName[l * tb.T + e]?.bind id )
            { mode := s.mode, lineName := s.lineName
            , startTs := s.startTs, endTs := s.endTs
            , journeyBoard := jb, journeyAlight := ja })
        let byIdx : Std.HashMap Nat Verified.Hsmm.StationChain.ResolvedStations :=
          (Verified.Hsmm.StationChain.resolveStationChain g chainSegs c.obs rels
              Verified.Hsmm.Assemble.KNOWN_LINES).foldl
            (fun m (i, res) => m.insert i res) {}
        -- `"chainDebug": true`: every pair the chain weighed, per leg, with
        -- its max-marginal — the instrument for a wrong line.
        if (j.getObjVal? "chainDebug" >>= (·.getBool?)).toOption == some true then
          let marg := Verified.Hsmm.StationChain.chainMarginals g chainSegs c.obs rels
            Verified.Hsmm.Assemble.KNOWN_LINES
          -- The same legs in the same order, each pair's posterior under the chain.
          let post := Verified.Hsmm.StationChain.chainPosteriors g chainSegs c.obs rels
            Verified.Hsmm.Assemble.KNOWN_LINES
          let dbg := Json.arr (marg.zipIdx.map fun ((leg, through), li) =>
            let pp := ((post[li]?).map (·.2)).getD #[]
            Json.mkObj [
              ("segIndex", Lean.toJson leg.segIndex),
              ("decodedLine", Json.str leg.decodedLine),
              ("journeyPair", Json.arr #[optStrJson leg.journeyBoard, optStrJson leg.journeyAlight]),
              ("startTs", Lean.toJson leg.startTs), ("endTs", Lean.toJson leg.endTs),
              ("sides", Json.arr (leg.sides.map fun sd => Json.mkObj [
                ("line", Json.str sd.line), ("side", Json.str sd.side), ("name", Json.str sd.name),
                ("nodeId", Json.str sd.nodeId), ("anchorPen", Lean.toJson sd.anchorPen)])),
              ("pairs", Json.arr (leg.pairs.zipIdx.map fun (p, k) =>
                Json.mkObj [
                  ("line", Json.str p.line),
                  ("board", optStrJson p.board.node.stationName),
                  ("alight", optStrJson p.alight.node.stationName),
                  ("legScore", Lean.toJson p.legScore),
                  ("through", Lean.toJson ((through[k]?).getD 0)),
                  ("posterior", Lean.toJson ((pp[k]?).getD 0)),
                  ("pathM", match Verified.Hsmm.StationChain.linePathMeters g p.line
                      p.board.node p.alight.node with
                    | some m => Lean.toJson m | none => Json.null),
                  ("calls", match rels, p.board.node.stationName, p.alight.node.stationName with
                    | some rs, some bn, some an =>
                      match Verified.Hsmm.ServedStations.intermediateCalls rs p.line bn an with
                      | some cs => Lean.toJson cs.size | none => Json.null
                    | _, _, _ => Json.null),
                  ("boardAnchor", Lean.toJson p.board.anchorPen),
                  ("alightAnchor", Lean.toJson p.alight.anchorPen),
                  ("boardDwell", Lean.toJson p.board.dwellPen),
                  ("alightDwell", Lean.toJson p.alight.dwellPen),
                  ("boardServed", Lean.toJson p.board.servedPen),
                  ("alightServed", Lean.toJson p.alight.servedPen),
                  ("boardTraj", match p.board.trajPen with | some t => Lean.toJson t | none => Json.null),
                  ("alightTraj", match p.alight.trajPen with | some t => Lean.toJson t | none => Json.null),
                  ("durPen", Lean.toJson p.durPen),
                  ("passPen", Lean.toJson p.passPen)]))])
          pure #[Json.mkObj [("chainDebug", dbg)]]
        else
        -- `flags.posterior` (harness-only): each segment's confidence, the
        -- posterior mass of its mode over its minutes (`Posterior`).
        -- `flags.unknownBelow` (harness arm): a segment whose confidence is
        -- under it leaves as `unknown`, the posterior's "don't know".
        let unknownBelow : Option Float := (j.getObjVal? "flags" >>= (·.getObjVal? "unknownBelow") >>= (·.getNum?)).toOption.map (·.toFloat)
        let wantPost := (j.getObjVal? "flags" >>= (·.getObjVal? "posterior") >>= (·.getBool?)).toOption == some true
          || unknownBelow.isSome
        let marg := if wantPost then Verified.Hsmm.Posterior.marginals pd else #[]
        let t0 := (c.obs[0]?.map (·.ts)).getD 0
        let confidence := fun (seg : Verified.HsmmSegments.Segment) => Id.run do
          let S := c.states.size
          let mut tot := 0.0
          let mut n := 0
          let mut ts := seg.startTs
          while ts < seg.endTs do
            let t := ((ts - t0) / 60).toNat
            for h : k in [0:S] do
              if Verified.Hsmm.StateSpace.modeName c.states[k].mode == seg.mode then
                tot := tot + marg.getD (t * S + k) 0
            n := n + 1
            ts := ts + 60
          return if n == 0 then 0.0 else tot / Verified.FloatConst.natToFloat n
        pure (segs.mapIdx (fun i s =>
          let conf := if wantPost then confidence s else 1.0
          let unsure : Bool := match unknownBelow with | some q => decide (conf < q) | none => false
          let base : List (String × Json) :=
            (if wantPost then [("confidence", Lean.toJson conf)] else []) ++
            [ ("startTs", Lean.toJson s.startTs)
            , ("endTs", Lean.toJson s.endTs)
            , ("mode", Json.str (if unsure then "unknown" else s.mode))
            , ("placeId", match s.placeId with
                | none => Json.null | some p => Lean.toJson p)
            -- The chain's line when it re-lined the leg.
            , ("lineName", match (byIdx.get? i).bind (·.line), s.lineName with
                | some l, _ => Json.str l
                | none, none => Json.null
                | none, some l => Json.str l) ]
          -- A segment the resolver did not reach has no board/alight keys; a
          -- resolved one whose side could not be separated carries an explicit
          -- null. The stored `segments_json` keeps the difference.
          Json.mkObj (match byIdx.get? i with
            | none => base ++ (match waitStation[i]? with
                | some (some st) => [("boardStation", Json.str st)]
                | _ => [])
            | some res => base ++
                [ ("boardStation", optStrJson res.board)
                , ("alightStation", optStrJson res.alight) ]
                -- The wait's bound, only when the chain found one.
                ++ (match res.boardTs with
                  | some t => [("boardTs", Lean.toJson t)] | none => [])
                ++ (match res.alightTs with
                  | some t => [("alightTs", Lean.toJson t)] | none => []))))
      match chained with
      | .error e => Json.mkObj [("error", Json.str e)]
      | .ok rows =>
        Json.mkObj [
          ("segments", Json.arr rows),
          ("longestJourneyMin", Lean.toJson longestJourneyMin),
          ("best", match r.best with | .val v => Lean.toJson v | .negInf => Json.null)]

private def assembleSegmentsResult (j : Json) : Json :=
  match parseAssemble j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (c, maxD) =>
    -- Under the journey state the leg tables need the station graph before
    -- the decode; the chain below builds its own from the same inputs.
    let (g?, rels?) := journeyInputs c j
    match buildPData c maxD g? rels? with
    | .error e => Json.mkObj [("error", Json.str e)]
    | .ok (pd, journey) =>
      match Verified.Hsmm.sDecode pd with
      | none => Json.mkObj [("degenerate", Json.bool true)]
      | some r =>
        segmentsOf j c g? rels? pd journey r

/-! ## Today, from the earliest changed minute (`assemblesegmentsinc`)

The serve loop keeps the day's previous run. A run whose per-minute tables match
it before minute `f` copies every cell ending before `f`, computes the rest, and
builds the trellis rows on from the previous run's, cut at `f` (`sDecodeInc_eq`:
exactly the full decode). Any day-wide difference, a new key, or no previous run
decodes in full. -/

/-- What the day's next run reuses. -/
structure TodayState where
  key : String
  obs : Array Verified.Hsmm.Observation.ObsRow
  covered : Array Bool
  pd : PData
  journey : Option Verified.Hsmm.Journey.Tables
  /-- The run's by-start rows (`sBuild`), which the next run cuts at its
      frontier and builds on (`sDecodeInc_eq`). -/
  rows : Array Nat × Array Nat

private def minOpt (a b : Option Nat) : Option Nat :=
  match a, b with
  | some x, some y => some (min x y)
  | some x, none => some x
  | none, y => y

/-- The least `minuteOf i` over the indices where two tables differ; minute 0
    when their sizes do, `none` when they agree. -/
private def diffMinute {α : Type} [BEq α] [Inhabited α] (a b : Array α) (minuteOf : Nat → Nat) :
    Option Nat :=
  if a.size != b.size then some 0 else Id.run do
    let mut m : Option Nat := none
    for i in [0:a.size] do
      if a[i]! != b[i]! then m := minOpt m (some (minuteOf i))
    return m

private def diffMinuteF (a b : FloatArray) (minuteOf : Nat → Nat) : Option Nat :=
  if a.size != b.size then some 0 else Id.run do
    let mut m : Option Nat := none
    for i in [0:a.size] do
      if a.get! i != b.get! i then m := minOpt m (some (minuteOf i))
    return m

private def sameF (a b : FloatArray) : Bool := diffMinuteF a b id == none

/-- The first minute any per-minute table differs from the previous run's, and
    the table: `0` when a day-wide one does, `T` when none does. -/
private def todayFrontier (old : TodayState) (obs : Array Verified.Hsmm.Observation.ObsRow)
    (covered : Array Bool) (pd : PData) (journey : Option Verified.Hsmm.Journey.Tables) :
    Nat × String :=
  let T := pd.T
  let S := pd.S
  let o := old.pd
  let modelMoved := [("T", o.T == T), ("S", o.S == S), ("maxD", o.maxD == pd.maxD),
      ("halfOB", o.halfOB == pd.halfOB), ("init", o.init == pd.init),
      ("transBase", o.transBase == pd.transBase), ("nTB", o.nTB == pd.nTB),
      ("transIdx", o.transIdx == pd.transIdx), ("nRows", o.nRows == pd.nRows),
      ("durBase", o.durBase == pd.durBase), ("durClass", o.durClass == pd.durClass)].filterMap
    fun (n, ok) => if ok then none else some n
  let dayWide := modelMoved.isEmpty
  let jDay : Option (List (String × Option Nat)) := match old.journey, journey with
    | none, none => some []
    | some a, some b =>
      let prefixMin := fun (k : Nat) => k % (T + 1) - 1
      if a.T == b.T && a.maxJ == b.maxJ && a.journey == b.journey && a.legs == b.legs
          && a.legName == b.legName && a.legStation == b.legStation && a.legNode == b.legNode
          && a.baseOf == b.baseOf && a.nBase == b.nBase && a.legSlot == b.legSlot
          && a.nSlots == b.nSlots && a.first == b.first && a.last == b.last
          && a.pairOk == b.pairOk && sameF a.durBaseF b.durBaseF
          && a.stopAlightPre.size == a.stopAlightKey.size
          && b.stopAlightPre.size == b.stopAlightKey.size then
        let B := a.nBase
        some ([ ("journey.emitPre", diffMinuteF a.emitPre b.emitPre prefixMin)
              , ("journey.entry", diffMinuteF a.entry b.entry (· % T))
              , ("journey.trans", diffMinuteF a.trans b.trans (· / (B * B)))
              , ("journey.firstCtx", diffMinuteF a.firstCtx b.firstCtx (· % T))
              , ("journey.reach", diffMinute a.reachMask b.reachMask (· % T))
              , ("journey.expectedMin", diffMinuteF a.expectedMin b.expectedMin (· % T))
              , ("journey.alight", diffMinute a.alightName b.alightName (· % T))
              , ("journey.pairPathM", diffMinuteF a.pairPathM b.pairPathM (· % T))
              , ("journey.pairCalls", diffMinuteF a.pairCalls b.pairCalls (· % T))
              , ("journey.boardAt", diffMinuteF a.boardAt b.boardAt (· % T))
              , ("journey.stopPre", diffMinuteF a.stopPre b.stopPre prefixMin)
              , ("journey.stopAlight", diffMinute
                  (a.stopAlight.map (·.bind (a.stopAlightKey[·]?)))
                  (b.stopAlight.map (·.bind (b.stopAlightKey[·]?))) (· % T))
              , ("journey.stopActive", diffMinuteF a.stopActive b.stopActive (· % T))
              , ("journey.stopActiveFirst", diffMinute a.stopActiveFirst b.stopActiveFirst (· % T)) ]
          -- An alight station's tables by its (line, station): a key on one
          -- side only is a `stopAlight` difference already.
          ++ (a.stopAlightKey.zipIdx.toList.filterMap fun (key, i) =>
            (b.stopAlightKey.findIdx? (· == key)).map fun j =>
              ("journey.stopAlightPre", diffMinuteF a.stopAlightPre[i]! b.stopAlightPre[j]! prefixMin)))
      else none
    | _, _ => none
  match dayWide, jDay with
  | false, _ => (0, s!"day-wide: {", ".intercalate modelMoved}")
  | _, none =>
    -- Which leg moved, for the log: the counts and the first name that differs.
    let detail := match old.journey, journey with
      | some a, some b =>
        let i := (List.range (min a.legName.size b.legName.size)).find? fun i =>
          a.legName[i]! != b.legName[i]! || a.legNode[i]! != b.legNode[i]!
        let checks : List (String × Bool) := [("T", a.T == b.T), ("maxJ", a.maxJ == b.maxJ), ("journey", a.journey == b.journey),
            ("legs", a.legs == b.legs), ("legStation", a.legStation == b.legStation),
            ("baseOf", a.baseOf == b.baseOf), ("nBase", a.nBase == b.nBase),
            ("legSlot", a.legSlot == b.legSlot), ("nSlots", a.nSlots == b.nSlots),
            ("first", a.first == b.first), ("last", a.last == b.last), ("pairOk", a.pairOk == b.pairOk),
            ("durBaseF", sameF a.durBaseF b.durBaseF),
            ("stopAlightKey", a.stopAlightPre.size == a.stopAlightKey.size
              && b.stopAlightPre.size == b.stopAlightKey.size)]
        let fields : List String := checks.filterMap fun (p : String × Bool) => if p.2 then none else some p.1
        let name := match i with
          | some i => s!"{a.legName[i]!} → {b.legName[i]!}"
          | none => if a.legName.size == b.legName.size then ", ".intercalate fields else "the list's end"
        s!" ({a.legName.size} → {b.legName.size} legs; first difference: {name})"
      | _, _ => ""
    (0, s!"day-wide: journey legs{detail}")
  | true, some jd =>
    let ds := [ ("obs", Verified.Hsmm.Observation.firstDiff old.obs obs)
              , ("coverage", diffMinute old.covered covered id)
              , ("emit", diffMinute o.emit pd.emit (· / S))
              , ("entry", diffMinute o.entry pd.entry (· / S))
              , ("trans", diffMinute o.transFlat pd.transFlat (· % T)) ] ++ jd
    ds.foldl (fun (best : Nat × String) (name, d) => match d with
      | some k => if k < best.1 then (k, name) else best
      | none => best) (T, "nothing")

/-- `assemblesegmentsinc`: `assemblesegments` for a day decoded again and again
    as it grows, with the previous run's state; the answer carries
    `"incremental": {"frontier", "resumedAt"}` when it reused, and the new state
    to keep. -/
private def assembleSegmentsInc (j : Json) (st? : Option TodayState) : Json × Option TodayState :=
  let key := (j.getObjVal? "todayKey" >>= (·.getStr?)).toOption.getD ""
  match parseAssemble j with
  | .error e => (Json.mkObj [("error", Json.str e)], none)
  | .ok (c, maxD) =>
    let (g?, rels?) := journeyInputs c j
    let T := c.obs.size
    let covered := (Array.range T).map (Verified.Hsmm.Assemble.coveredAtE c)
    let answer := fun (pd : PData) (journey : Option Verified.Hsmm.Journey.Tables)
        (r? : Option DecodeResult) (rows : Array Nat × Array Nat) (incJ : Json) =>
      match r? with
      | none => (Json.mkObj [("degenerate", Json.bool true)], none)
      | some r =>
        let out := segmentsOf j c g? rels? pd journey r
        (out.setObjVal! "incremental" incJ,
          if key.isEmpty then none else some { key, obs := c.obs, covered, pd, journey, rows })
    match buildPre c maxD g? rels? with
    | .error e => (Json.mkObj [("error", Json.str e)], none)
    | .ok pre =>
    let full : Unit → Json × Option TodayState := fun _ =>
      match buildPDataFrom c maxD g? rels? pre with
      | .error e => (Json.mkObj [("error", Json.str e)], none)
      | .ok (pd, journey) =>
        if pd.T == 0 then (Json.mkObj [("degenerate", Json.bool true)], none) else
        let pref := Verified.Hsmm.sPrefix pd
        let rows := Verified.Hsmm.sBuild pd pref pd.T
        answer pd journey (Verified.Hsmm.sDecodeWith pd pref rows.1) rows Json.null
    match st? with
    | none => full ()
    | some st =>
      -- A place coming into play gives it its own duration class: the
      -- earlier build's cells are laid out by the old classes.
      if key.isEmpty || st.key != key || st.pd.durClass != pre.durClass then full () else
      let pdT := pre.toPData maxD
      let (first, why) := todayFrontier st c.obs covered pdT pre.tb
      if first == 0 || pdT.T == 0 then
        let (out, st') := full ()
        (out.setObjVal! "incremental" (Json.mkObj [("full", Json.str why)]), st')
      else
      let f := first - 1
      -- Both runs' rows exist up to here: the earlier run's to its day's end.
      let t0 := min f (min pdT.T st.pd.T)
      let inc : IncFrom :=
        { f, durDelta := st.pd.durDelta
        , legDur := (st.journey.map (·.legDur)).getD FloatArray.empty
        , inner := (st.journey.map (·.cell)).getD FloatArray.empty }
      match buildPDataFrom c maxD g? rels? pre (inc := some inc) with
      | .error e => (Json.mkObj [("error", Json.str e)], none)
      | .ok (pd, journey) =>
        let (r?, rows) := Verified.Hsmm.sDecodeInc pd t0 st.rows
        answer pd journey r? rows
          (Json.mkObj [("frontier", Lean.toJson f), ("resumedAt", Lean.toJson t0),
            ("by", Json.str why)])

/-! ## Float bit transport

Most modes quantise before they emit (`qCell`, `ptJson`). The Kalman filter
cannot: it runs over raw degrees, where the seventh decimal moves the gain. And
`Lean.toJson (f : Float)` rounds to six places (`51.50009905063291` comes back
`51.500099`, `1e-7` comes back `0`).

So a Float crosses as its IEEE-754 bit pattern, as a decimal string: it reaches
2^64, past the 2^53 a JSON number is exact to. The round trip is then exact by
construction, `1e-7` and `-0.0` included. -/

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

`Verified.Geo.GpsQuality.qualityFilterGps`, the incoherent-run pre-filter that
runs just before the Kalman filter, over the whole day's track.

  { "pts": [[ts, latBits, lonBits, accBits|null], …] }

Output: the surviving rows, same shape: a pure selection. -/

/-! ## `rankvenues` — the venue ranking, candidate by candidate

`Verified.Geo.VenuePrior.rankVenues`, with every candidate's score broken out,
so the term that decided a stay is readable. A probe for people and tests, so
floats cross as plain numbers.

  { "landmarks": [{name, type, subtype, distanceM,
                   openFraction?, enclosing?, reverseGeocoded?}],
    "stay":   {startUnix, endUnix, localHour} | null,
    "priors": {bySubtype: [[name, {visits, dwell:[…], hours:[…]}]],
               byCategory: [[…]], totalVisits} | null }

  → { "ranked": [{name, subtype, distanceM, total,
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

/-! ## `bestplace` — the whole naming chain

What `BestPlace.resolve` finally answers: the ranker's winner after the
enclosing check, the Nominatim specific-venue branch, the lodging override and
the residential-address branch. The only way to tell "the ranker chose X" from
"the fold serves X".

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

Output: `{ "label": str, "city": str|null }`, or `{"label": null}`.
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
    -- Without it an open-space stay replays as whatever venue ranked, not as
    -- the park the fold named.
    inside := optBool j "inside"
  }

private def bestPlaceResult (j : Json) : Json :=
  let parsed : Except String
      (Option Verified.Geo.SegmentMerge.ResolvedPlace
        × List (Verified.Geo.VenuePrior.VenueCandidateScore × Option (Float × Float × Float))) := do
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
    let resolved := Verified.Geo.BestPlace.resolve
      { landmarks := pois.toList, geocode := geo, samples := samples.toList }
      stay priors (optBool j "preferResidential")
    -- The ranker's view of the same candidates beside the chain's answer, so a
    -- census over dumped namings (`LEAN_DUMP_DIR`) can say what lost and why.
    let ranked := Verified.Geo.VenuePrior.rankVenues
      (pois.toList.map (Verified.Geo.BestPlace.toLandmark samples.toList stay.isSome)) stay priors
    -- The shape's three log-ratios unclamped, per candidate, for a fit over
    -- dumped namings.
    let shapeParts : List (Option (Float × Float × Float)) := ranked.map fun c =>
      match stay, priors, c.parts.shape with
      | some st, some pr, some _ => some (Verified.Geo.VenuePrior.shapeParts c.landmark.subtype st pr)
      | _, _, _ => none
    return (resolved, ranked.zip shapeParts)
  let optF : Option Float → Json := fun o =>
    match o with | none => Json.null | some v => Lean.toJson v
  let rankedJson := fun (ranked : List (Verified.Geo.VenuePrior.VenueCandidateScore × Option (Float × Float × Float))) =>
    Json.arr ((ranked.map fun (c, sp) => Json.mkObj [
      ("name", Json.str c.landmark.name), ("subtype", Json.str c.landmark.subtype),
      ("distanceM", Lean.toJson c.landmark.distanceM), ("openFraction", optF c.landmark.openFraction),
      ("total", Lean.toJson c.total), ("hours", optF c.parts.hours),
      -- Each term of the sum, so a fit over dumped namings sees what the
      -- picker weighed.
      ("distance", Lean.toJson c.parts.distance), ("venue", Lean.toJson c.parts.venue),
      ("shape", optF c.parts.shape),
      ("shapeParts", match sp with
        | some (b, d, h) => Json.arr #[Lean.toJson b, Lean.toJson d, Lean.toJson h]
        | none => Json.null),
      ("nearField", Json.bool c.nearField), ("enclosing", Json.bool c.landmark.enclosing)]).toArray)
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (none, ranked) => Json.mkObj [("label", Json.null), ("ranked", rankedJson ranked)]
  | .ok (some r, ranked) =>
    Json.mkObj [("label", Json.str r.label),
                ("city", match r.city with | none => Json.null | some c => Json.str c),
                ("ranked", rankedJson ranked)]

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

`Verified.Hsmm.GpsOutliers.dropGpsOutliers`: the robust-median cluster filter
run on the smoothed stream before the observation tensor (unlike `gpsquality`,
which runs on raw fixes before the Kalman smoother).

  { "pts": [[ts, latBits, lonBits, speedBits], …] }

Output: the surviving rows, same shape: a pure selection. -/

private def parseHsmmGpsPt (j : Json) : Except String Verified.Hsmm.Observation.GpsPoint := do
  let a ← j.getArr?
  match a[0]?, a[1]?, a[2]?, a[3]? with
  | some ts, some la, some lo, some sp =>
    return ⟨← ts.getInt?, ← jBits la, ← jBits lo, ← jBits sp, none⟩
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

`Verified.Geo.BiometricLabels`: the four velocity passes that let the step
counter overrule GPS on a segment's mode, one verb for all four (`pass`).

  { "pass": "cadence" | "revert" | "jitter" | "walkthrough",
    "segs":  [{ startTs, endTs, mode, refinedMode?, kinds?, avgSpeed, maxSpeed,
                linearity, pointCount, place?, wayName? }, …],
    "steps": [[ts, stepsBits], …],
    "pts":   [[ts, latBits, lonBits], …] }

Output: `{ "decisions": [null | [mode, reason, kind|null], …] }`, one per segment
(`null` = unchanged); `walkthrough` adds `"runs": [[start, end), …]`, the merge
plan. The per-segment passes map over `segs` here, so a day is one call. -/

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

/-! ## Snapping fixes to known places (`verified_cli head`)

`Verified.Geo.PlacePrior.snapToPlace` over a day's raw fixes, batched (one call,
not one per fix):

    { "op": "snap",
      "fixes":  [[latBits, lonBits, accBits|null], …],
      "places": [[latBits, lonBits, radiusBits|null, id|null], …] }
  → { "snapped": [[latBits, lonBits, accBits|null, moved], …] }  one per fix, in order

`snapped` is a flag, not inferred from movement: a fix already at a centroid
snaps without moving. -/

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
    | other => throw s!"unknown head op {other}"
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## Focus-place mining (`verified_cli focus`)

`Verified.Geo.FocusPlaces` + `Verified.Geo.FocusIdentity`: the weekly mining
job's pure core, in its call order.

  { "points":       [[ts, latBits, lonBits, accBits|null], …],
    "sleepWindows": [[startTs, endTs], …],
    "clusters":     [{ id, lat, lon, dwell, stays: [[…], …] }, …],
    "old":          [[id, latBits, lonBits, firstSeenTs], …] }

`points` drives `detectFocusPlaces`; `clusters` are already-built clusters for
`splitCluster` (captured cases no single day's points reproduce); `old` drives
`matchClusters`, the re-mining identity map. Every cluster comes back as a
report: its fields plus every derived value the job reads. -/

/-! ## `stationchain` — the chained-triple resolver

Input:
  { "edges":  [{id, geometry:[{lat,lon}], lineMemberships:[str], underground,
                startNode, endNode}],
    "nodes":  [{id, lat, lon, stationName, edgeIds}]   -- ORDERED, see below
    "obs":    [ObsRow],
    "segs":   [{startTs, endTs, mode, lineName}],
    "relations": [{lineRef, lineName, stops:[{name}]}] | null }
Output: { "resolved": [[segIndex, board|null, alight|null]] }

⚠ `nodes` order is part of the input: the candidate dedupe, the stable sort,
the cut at `MAX_CANDIDATES_PER_SIDE` and the first-wins argmax all read it. A
transport that sorted or deduplicated it would change results.
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

/-! ## `osmspatial` — the row-set kernel

Distance queries over rows the host pushes, for a host answering the day fold's
asks without a database. No feature-bucket filter: the caller filters by bucket
while assembling the rows. -/
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
  -- Index 4, optional: a four-element row gets an empty tag map.
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

/-- The tag map is emitted, not just carried: `nearbyLandmarks` spawns one
landmark per tag key, which `subtype` alone cannot. -/
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

/-! ## `battery` — the chart series

`appendBatteryTail(batterySeries(inDay), tail, endUtc)` in one mode: the
pipeline never wants the untailed series, and two calls would let a caller ship
it. -/
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

/-! ## `watchbattery` — the watch trace for one day

`Verified.Geo.Velocity.watchBatterySeries`: the `device_battery_log` history on
the phone series' axis.

  { "rows": [[ts|null, level, deviceVersion|null], …],
    "startUtc": int, "endUtc": int }
→ { "series": [[ts, level], …] }

`ts` is already resolved by the host (tzdata); a `null` is dropped, never
guessed. ⚠ Row order matters: of two rows at one instant the later is kept, so
the SQL must not gain an `ORDER BY` the shaping does not expect. -/
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

/-! ## `venuetags` — which named features are places

`Verified.Geo.Landmarks.VENUE_TAGS`, for the mirror's fetch: it asks the landmark
query for named features with these tags and files them as landmarks. Declared
once, here; the host asks rather than keeping a copy.

  {} → { "tags": [["building", ["hotel"]], ["natural", ["beach"]], …] } -/
private def venueTagsResult (_ : Json) : Json :=
  Json.mkObj [("tags", Json.arr (Verified.Geo.Landmarks.VENUE_TAGS.toArray.map fun (k, vs, _) =>
    Json.arr #[Json.str k, Json.arr (vs.toArray.map Json.str)]))]

/-! ## `osmcoverage` — can the local mirror answer here?

`Verified.Geo.OsmCoverage.decideCoverage`: the gate before reading
`osm_points`/`osm_lines`. `covered` means a query is an answer; otherwise nobody
fetched this area, and an empty result would look like an area with no roads.

  { "lat": bits, "lon": bits, "radiusM": bits,
    "coverage": [[minLatBits, maxLatBits, minLonBits, maxLonBits, fetchedAtMs|null], …],
    "nowMs": int,
    "hasLocalData": bool }
→ { "covered": true|false }

`coverage` holds one feature type's boxes. `nowMs` is passed in: the host owns
the clock, Lean the decision. -/
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

/-! ## `railfill` — which train legs want a background route fill

`Verified.Geo.RailRouteFill.unsnappedTrainRoutes`: a train leg draws on rails
only when its label has a `rail_route_cache` row; this names the legs a worker
should fill, in the order the day was walked (the fill order).

  { "segments": [[mode, refinedMode|null, startTs, endTs, wayName|null, hasSnappedPath], …],
    "points":   [[ts, latBits, lonBits], …] }
→ { "candidates": [{ "key", "startTs", "endTs", "fixes": [[latBits, lonBits], …] }, …] }

`hasSnappedPath` is a boolean, so the day's polylines never cross. -/
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

/-! ## `railsnap` — the whole corridor snap

The host hands over the raw ways, stations and fix cloud and gets the finished
path back; the graph build, edge weights, gap bridging and vertex fusion all
stay here. `onLine` picks the fallback, `snapTrainSegmentOnLine`: route over
only the named line's ways, with no fix cloud. -/

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
    -- Not interchangeable: `snapTrainSegment` refuses below `minCloudFixes`
    -- (12), since a thin cloud cannot evidence a corridor; the on-line form
    -- takes no cloud and leans on the line name. The caller chooses.
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

/-- `relationroute`: a route relation's own track between two points
(`RailSnap.snapOnRelation`).

  { "ways": [ <railsnap way> ], "board": [latBits, lonBits], "alight": [latBits, lonBits],
    "startTsBits": …, "endTsBits": …, "fixes": [[latBits, lonBits], …] }
→ { "path": [[latBits, lonBits, tsBits], …] | null, "medianM": bits } — `medianM`
  the fixes' median distance to the path, for choosing among candidates. -/
private def relationRouteResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let ways ← (← optArr j "ways").mapM parseRailWay
    let board ← parseSnapPt (← j.getObjVal? "board")
    let alight ← parseSnapPt (← j.getObjVal? "alight")
    let fixes ← (← optArr j "fixes").mapM parseSnapPt
    let res := Verified.Geo.RailSnap.snapOnRelation ways board alight
      (← jBits (← j.getObjVal? "startTsBits")) (← jBits (← j.getObjVal? "endTsBits"))
    return match res with
      | none => Json.mkObj [("path", Json.null)]
      | some path => Json.mkObj [
          ("medianM", fBits (Verified.Geo.RailSnap.medianDistanceToPath path fixes)),
          ("path", Json.arr (path.map fun p => Json.arr #[fBits p.lat, fBits p.lon, fBits p.ts]))]
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

/-! ## `clipfuture` — never assert the future

`Verified.Geo.DayState.clipFuture`. The pipeline fills a day to its end, which
for today lies ahead of now.

  { "states": [ <the day mode's own state objects> ], "nowTs": int }
→ { "states": [ … ] }

Presentation only, so the pipeline stays deterministic; a caller applies it per
request, after the cache. A state straddling `now` by under a minute is dropped
rather than shown as `0m`. -/
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
         , place := ← optS "place", city := ← optS "city", wayName := ← optS "wayName"
         -- The rule that named `place`; `placeConfidence` is derived from it on
         -- the way out, so it is not read.
         , placeSource := ← optS "placeSource"
         , placeAt := ← match j.getObjVal? "placeAt" with
             | .ok (.arr #[la, lo]) => do return some (← jFloat la, ← jFloat lo)
             | _ => pure none
         , roads := ← match j.getObjVal? "roads" with
             | .ok (.arr xs) => xs.mapM (·.getStr?)
             | _ => pure #[]
         , asleep := ← optB "asleep", tz := ← optS "tz"
         , minutesAsleep := ← jOptInt j "minutesAsleep"
         , inferred := ← optB "inferred" }

private def clipFutureResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let states ← (← optArr j "states").mapM parseDayState
    let nowTs ← (← j.getObjVal? "nowTs").getInt?
    let observed := (j.getObjValAs? Int "observedThrough").toOption
    let out := Verified.Geo.DayState.clipFuture states.toList nowTs observed
    return Json.mkObj [("states", Json.arr ((out.map Day.stateJson).toArray))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ## Per-minute rail/road proximity (`proximityqueries` / `proximitytable`)

`computeMinuteProximity` split at its one impure step, the OSM lookup: the shell
asks which locations to query, runs `nearby_ways` on each, and hands the answers
back. Every decision (minute buckets, medians, the ~11 m key, which subtypes
count as rail or road) is `Verified.Hsmm.RailRoadProximity`'s. A `pts` row is
`[ts, latBits, lonBits]`: speed plays no part. -/

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
`assemblesegments` takes, passed through unread. `answers` omits a failed
query; `unanswered` counts the minutes left uncovered, which tells a failed
mirror from an empty neighbourhood. ⚠ Road then rail: swapped, every fix would
be on a road. -/
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

Split like the proximity pair, around the OSM query: the shell asks which lines
exist, resolves each one's stations, and hands them back to be measured. The
line list is Lean's (`KNOWN_LINES`, the served state space).
-/

/-- `{}` → `{ value: [line, …] }`. See `Verified.Hsmm.Assemble.KNOWN_LINES`. -/
private def knownLinesResult (_ : Json) : Json :=
  Json.mkObj [("value", Json.arr
    (Verified.Hsmm.Assemble.KNOWN_LINES.map Json.str).toArray)]

/-- `{ places, lines }` → `{ value: ["placeId|lineName", …] }`.

`places` are `[id, latBits, lonBits]`; `lines` are `[name, [[latBits, lonBits], …]]`.
⚠ An empty set is not neutral: it removes every hard zero. -/
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

/-- `resthr`: one day's heart rate awake and at rest (`Verified.RestHr`).
Request `{samples: [[unix, bpm]…] (time-sorted), steps: [minute…],
sleep: [[start, end]…], dayStart, dayEnd}`; reply `{day: null | {median, p25,
p75, p05, p95, restMinutes}}`. -/
private def restHrResult (j : Json) : Json :=
  let parsed : Except String (Option Verified.RestHr.Day) := do
    let samples ← (← (← j.getObjVal? "samples").getArr?).mapM fun e => do
      let a ← e.getArr?
      return ((← (← nth a 0).getInt?), (← (← nth a 1).getNat?))
    let steps ← (← (← j.getObjVal? "steps").getArr?).mapM (·.getInt?)
    let sleep ← (← (← j.getObjVal? "sleep").getArr?).mapM fun e => do
      let a ← e.getArr?
      return ((← (← nth a 0).getInt?), (← (← nth a 1).getInt?))
    let dayStart ← (← j.getObjVal? "dayStart").getInt?
    let dayEnd ← (← j.getObjVal? "dayEnd").getInt?
    return Verified.RestHr.restDay samples steps sleep dayStart dayEnd
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok none => Json.mkObj [("day", Json.null)]
  | .ok (some d) => Json.mkObj [("day", Json.mkObj [
      ("median", Lean.toJson d.medianBpm), ("p25", Lean.toJson d.p25),
      ("p75", Lean.toJson d.p75), ("p05", Lean.toJson d.p05), ("p95", Lean.toJson d.p95),
      ("restMinutes", Lean.toJson d.restMinutes)])]

/-- The mode table: one request object in, one result object out. Separate from
`serveLoop`, so a host that links this library can ask without spelling the
request into NDJSON. -/
def dispatch (j : Json) : Json :=
  match (j.getObjVal? "mode" >>= (·.getStr?)) with
  | .ok "rail" => railResult j
  | .ok "assemblesegments" => assembleSegmentsResult j
  | .ok "proximityqueries" => proximityQueriesResult j
  | .ok "proximitytable" => proximityTableResult j
  | .ok "knownlines" => knownLinesResult j
  | .ok "placenearline" => placeNearLineResult j
  | .ok "coverage" => coverageResult j
  | .ok "kalman" => kalmanResult j
  | .ok "rankvenues" => rankVenuesResult j
  | .ok "bestplace" => bestPlaceResult j
  | .ok "resthr" => restHrResult j
  | .ok "gpsquality" => gpsQualityResult j
  | .ok "gpsoutliers" => gpsOutliersResult j
  | .ok "biolabels" => bioLabelsResult j
  | .ok "head" => headResult j
  | .ok "day" => Day.dayResult j
  -- The name-confidence table, for the test that holds it to its blessed
  -- measurement (`tests/golden/name-confidence.jsonl`).
  | .ok "nameconfidence" => Json.mkObj [("counts", Json.arr
      (Verified.Geo.NameConfidence.COUNTS.map fun (src, r, n) =>
        Json.arr #[Json.str src, Lean.toJson r, Lean.toJson n]).toArray)]
  | .ok "focus" => Focus.focusResult j
  | .ok "battery" => batteryResult j
  | .ok "osmspatial" => osmSpatialResult j
  | .ok "osmcoverage" => osmCoverageResult j
  | .ok "venuetags" => venueTagsResult j
  | .ok "railsnap" => railSnapResult j
  | .ok "relationroute" => relationRouteResult j
  | .ok "railfill" => railFillResult j
  | .ok "clipfuture" => clipFutureResult j
  | .ok "watchbattery" => watchBatteryResult j
  | .ok "stationchain" => StationChain.stationChainResult j
  -- The walk referee. Nothing serves it; it is here because this is where a
  -- host can link it.
  | .ok "walkgate" => WalkGate.walkGateResult j
  -- The narrative parser. The reply is civil time; the shell resolves it.
  | .ok "groundtruth" => GroundTruth.groundTruthResult j
  -- The ground-truth side of the decoder scoreboard. Rows arrive resolved; the
  -- zone conversion is the shell's.
  | .ok "journeys" => Journeys.journeysResult j
  | .ok "truthcheck" => TruthCheck.truthCheckResult j
  | .ok "floorgate" => FloorGate.floorGateResult j
  | .ok "journeyshape" => JourneyShape.journeyShapeResult j
  | .ok "decoderscore" => DecoderScore.decoderScoreResult j
  | .ok "feasibility" => Feasibility.feasibilityResult j
  | .ok "ceilinggate" => CeilingGate.ceilingGateResult j
  | .ok "ceilingbless" => CeilingGate.ceilingBlessResult j
  -- The backend's decision table (`Verified.Session`, `Verified.Share`, …),
  -- keyed on `op`, in the same process. The payload rides under `req`, not
  -- merged: some ops carry a `mode` of their own.
  | .ok "backend" =>
    match j.getObjVal? "req" with
    | .ok r => BackendEntry.dispatch r
    | .error _ => Json.mkObj [("error", Json.str "backend: no req")]
  | .ok other => Json.mkObj [("error", Json.str s!"unknown mode {other}")]
  | .error _ => Json.mkObj [("error", Json.str "missing mode")]

/-- Persistent request loop: one NDJSON request per line (`{"id", "mode", …}`)
→ one NDJSON response (`{"id", "result": …}`), flushed per line. A handler may
write `{"ask": …}` lines and read the reply off the same stdin before its result
goes out (`DayEntry.Host`). The loop carries the day's incremental state from
one `assemblesegmentsinc` to the next; every other mode is `dispatch`. -/
private partial def serveLoop (stdin stdout : IO.FS.Stream) (today : Option TodayState) :
    IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return  -- EOF: the worker closed our stdin
  let (resp, today) : Json × Option TodayState :=
    match Json.parse line with
    | .error e => (Json.mkObj [("id", Json.null), ("error", Json.str s!"parse: {e}")], today)
    | .ok j =>
      let id := match j.getObjVal? "id" with | .ok v => v | .error _ => Json.null
      let (body, today) : Json × Option TodayState :=
        if (j.getObjVal? "mode" >>= (·.getStr?)).toOption == some "assemblesegmentsinc"
        then assembleSegmentsInc j today
        else (dispatch j, today)
      (Json.mkObj [("id", id), ("result", body)], today)
  stdout.putStr resp.compress
  stdout.putStr "\n"
  stdout.flush
  serveLoop stdin stdout today

/-- The `verified_cli` command line, as a plain function; `Main.lean` is the
eleven-line shim that turns it into an executable. -/
def cliMain (args : List String) : IO UInt32 := do
  if args.contains "serve" then
    serveLoop (← IO.getStdin) (← IO.getStdout) none
    return 0
  let timing := args.contains "--timing"
  let t0 ← IO.monoMsNow
  let input ← (← IO.getStdin).readToEnd
  if args.contains "rail" then return ← railMain input
  if args.contains "matchprof" then return ← matchProfMain input
  if args.contains "decodeprof" then return ← decodeProfMain input
  if args.contains "decodetrace" then return ← runOne decodeTraceResult input
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
  let t1 ← IO.monoMsNow
  match Json.parse input >>= parseModel with
  | .error e =>
    IO.println (Json.mkObj [("error", Json.str e)]).compress
    return 1
  | .ok m =>
    let t2 ← IO.monoMsNow
    -- `IO.lazyPure` pins the evaluation between the two timestamps; a plain
    -- pure `let` gets floated into the match by the compiler.
    let r ← IO.lazyPure fun _ => Verified.Hsmm.sDecode m
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
