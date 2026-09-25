import Verified.JsNum
import Std.Data.HashMap

/-!
# Point-to-point routing on the walkable network (port of `src/geo/walkable-route.ts`)

The case-2 primitive of the building-escape corrector: when a drawn walk's chord
cuts through a building block and no vertex sits inside the block to push
(sparse fixes), the honest line goes AROUND the block along the streets. This
answers exactly that — the shortest walkable path between two GPS-anchored
points.

Deliberately NOT the Viterbi matcher. Routing between two KNOWN endpoints is
stable; it is global matching over a whole noisy fix cloud that invents wrong
routes. The graph is used only for what it is good for: connectivity around an
obstacle between two trusted points.

Both endpoints snap onto the nearest way EDGE — a virtual node spliced into the
edge, not the nearest graph NODE — so a mid-street start does not first detour
to a distant junction.

## Fusion

`buildWalkGraph` fuses way coordinates into graph nodes by `nodeKey`, a
`toFixed(7)` string. That was shell work until `toFixed` was ported exactly
(`Verified.JsNum`); it is Lean's now, so this module takes the raw way list and
needs nothing pre-computed. The distinction the fusion demands is still live in
the code: node COORDINATES are the first way coordinate that mapped to them and
edge lengths use those, while `snapToEdge` projects onto each way's own RAW
coordinates — mixing the two would move every projection by up to ~1 cm.

Every `none` returned here is an honest "there is no street path", and the
caller falls back to trusting the GPS: no way within `snapRadiusM`, a
disconnected network, or a route longer than `maxRouteM` (a longer "shortest"
path is a dishonest detour for a walk-leg gap, not a route).

Exactness: the Dijkstra ordering, the heap, the splice arithmetic and every
gate are EXACT. `metersBetween` uses `Math.hypot` in the TS and `sqrt(dx²+dy²)`
here, which may differ by ≤1 ULP, and that feeds edge weights and `distM`; the
`cos` in the local projection is likewise ≤1 ULP. UNPROVEN; pinned against
Node/V8 (`lean/experiments/walkable-route-refs.mts`).
-/

namespace Verified.Geo.WalkableRoute

private def pi : Float := 3.14159265358979323846

structure Pt where
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- Local equirectangular metres. The TS uses `Math.hypot`; `sqrt` of the sum of
    squares agrees to ≤1 ULP at these magnitudes. -/
def metersBetween (a b : Pt) : Float :=
  let dLat := (b.lat - a.lat) * 111320.0
  let dLon := (b.lon - a.lon) * 111320.0 * Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  Float.sqrt (dLat * dLat + dLon * dLon)

/-- Projection of `p` onto segment `a→b`, clamped to the segment. -/
structure Proj where
  lat : Float
  lon : Float
  /-- Position along the segment, clamped to `[0, 1]`. -/
  t : Float
  distM : Float
  deriving Inhabited, Repr

/-- `projectPointToSegment`: a local flat-earth projection about the segment's
    mean latitude. A degenerate segment (`len2 = 0`) yields `t = 0` at `a`. -/
def projectPointToSegment (p a b : Pt) : Proj :=
  let cosLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  let bx := (b.lon - a.lon) * 111320.0 * cosLat
  let by' := (b.lat - a.lat) * 111320.0
  let px := (p.lon - a.lon) * 111320.0 * cosLat
  let py := (p.lat - a.lat) * 111320.0
  let len2 := bx * bx + by' * by'
  let t0 := if len2 == 0 then 0 else (px * bx + py * by') / len2
  let t := max 0 (min 1 t0)
  let lat := a.lat + t * (b.lat - a.lat)
  let lon := a.lon + t * (b.lon - a.lon)
  { lat := lat, lon := lon, t := t, distM := metersBetween p ⟨lat, lon⟩ }

/-- The fused walkable graph, built shell-side. `adj` is already deduplicated
    and already drops sub-millimetre edges. -/
structure WalkGraph where
  nodes : Array Pt
  /-- Per node, the `(neighbour, distance-in-metres)` pairs. -/
  adj : Array (Array (Nat × Float))
  deriving Inhabited

/-- A way network as coordinate lists, in way-iteration order. Order is
    load-bearing: it fixes graph-node numbering and breaks nearest-edge ties. -/
abbrev Ways := Array (Array Pt)

/-- Build the walkable graph: one node per distinct way coordinate, an
    undirected edge per consecutive pair. Ways connect where they share a
    junction coordinate — `toFixed(7)` equality, ported exactly in
    `Verified.JsNum`, which is what makes this fusion Lean's job and not the
    shell's. -/
def buildWalkGraph (ways : Ways) : WalkGraph := Id.run do
  let mut nodes : Array Pt := #[]
  let mut adj : Array (Array (Nat × Float)) := #[]
  let mut index : Std.HashMap Verified.JsNum.CoordKey Nat := {}
  for w in ways do
    for hm_i : i in [1:w.size] do
      have hb_i : i < w.size := hm_i.upper
      -- `nodeAt` for each end, earlier coordinate first — that order is what
      -- numbers the nodes.
      let mut ids : Array Nat := #[]
      for c in #[w[i - 1], w[i]] do
        let key := Verified.JsNum.coordKey7 c.lat c.lon
        match index[key]? with
        | some id => ids := ids.push id
        | none =>
          let id := nodes.size
          nodes := nodes.push c
          adj := adj.push #[]
          index := index.insert key id
          ids := ids.push id
      -- `ids` holds the two endpoint ids just fused; both are node indices and
      -- `adj` has one row per node. The guards say so where the tactic looks.
      if h : 1 < ids.size then
        let a := ids[0]
        let b := ids[1]
        if a != b then
          if hn : a < nodes.size ∧ b < nodes.size ∧ a < adj.size ∧ b < adj.size then
            have hna := hn.1
            have hnb := hn.2.1
            have haa := hn.2.2.1
            have hab := hn.2.2.2
            -- The FUSED node coordinates, not the way's raw ones.
            let d := metersBetween nodes[a] nodes[b]
            if d ≥ 1e-3 then
              -- Dedupe: ways can overlap on a shared stretch.
              if !(adj[a].any (fun e => e.1 == b)) then adj := adj.set a (adj[a].push (b, d)) haa
              if hab' : b < adj.size then
                if !(adj[b].any (fun e => e.1 == a)) then adj := adj.set b (adj[b].push (a, d)) hab'
  return { nodes, adj }

/-- Where an endpoint splices into the network. -/
structure Snap where
  point : Pt
  nodeA : Nat
  nodeB : Nat
  /-- Along-edge distance from the splice point to each end. -/
  toA : Float
  toB : Float
  distM : Float
  deriving Inhabited, Repr

/-- The nearest point on any way edge to `p`, with the edge's two graph-node
    ids. Strict improvement, so the FIRST edge at the minimum distance wins —
    way-iteration order is load-bearing. -/
def snapToEdge (p : Pt) (ways : Ways) (graph : WalkGraph) : Option Snap := Id.run do
  let mut index : Std.HashMap Verified.JsNum.CoordKey Nat := {}
  for hm_i : i in [0:graph.nodes.size] do
    let n := graph.nodes[i]
    index := index.insert (Verified.JsNum.coordKey7 n.lat n.lon) i
  let mut best : Option Snap := none
  for w in ways do
    for hm_i : i in [1:w.size] do
      have hb_i : i < w.size := hm_i.upper
      let a := w[i - 1]
      let b := w[i]
      let proj := projectPointToSegment p a b
      let better := match best with
        | none => true
        | some bb => proj.distM < bb.distM
      if better then
        match index[Verified.JsNum.coordKey7 a.lat a.lon]?,
              index[Verified.JsNum.coordKey7 b.lat b.lon]? with
        | some nodeA, some nodeB =>
          let projPt : Pt := ⟨proj.lat, proj.lon⟩
          best := some { point := projPt, nodeA, nodeB,
                         toA := metersBetween projPt a, toB := metersBetween projPt b,
                         distM := proj.distM }
        | _, _ => pure ()
  return best

/-! ## Binary min-heap

Reproduced element-for-element rather than replaced with a sorted structure:
Dijkstra relaxes on STRICT improvement, so among equal-cost routes the winner
is decided by which node the heap pops first. A different heap would pick a
different — equally short but visibly different — path. -/

/-- Node id and key travel together, so one bound covers both reads — the two
parallel arrays this used to hold shared a length only by discipline. -/
private structure Heap where
  items : Array (Nat × Float) := #[]
  deriving Inhabited

private def Heap.size (h : Heap) : Nat := h.items.size

private def Heap.push (h : Heap) (id : Nat) (key : Float) : Heap := Id.run do
  let mut items := h.items.push (id, key)
  let mut i := items.size - 1
  while i > 0 do
    let parent := (i - 1) / 2
    -- `i` starts at the last index and only moves to a parent, so it stays in
    -- range; the guard is the form the tactic accepts.
    if hi : i < items.size then
      have hp : parent < items.size := by omega
      let cur := items[i]
      let par := items[parent]
      -- The swap sits in the `else`, not after a `break`: a statement that can
      -- exit rebinds every mutable variable after it in `do` notation, and a
      -- bound on the old `items` no longer names the new one.
      if par.2 ≤ cur.2 then
        break
      else
        items := (items.set i par hi).set parent cur (by rw [Array.size_set]; exact hp)
        i := parent
    else break
  return { items }

private def Heap.pop (h : Heap) : Option (Nat × Float) × Heap :=
  if h0 : h.items.size = 0 then (none, h) else Id.run do
  let top := h.items[0]'(by omega)
  let last := h.items[h.items.size - 1]'(by omega)
  let mut items := h.items.pop
  if hs : 0 < items.size then
    items := items.set 0 last hs
    let mut i := 0
    while true do
      let l := 2 * i + 1
      let r := l + 1
      let mut smallest := i
      if hl : l < items.size then
        if hs' : smallest < items.size then
          if items[l].2 < items[smallest].2 then smallest := l
      if hr : r < items.size then
        if hs' : smallest < items.size then
          if items[r].2 < items[smallest].2 then smallest := r
      if smallest == i then break
      if hi : i < items.size then
        if hs2 : smallest < items.size then
          let cur := items[i]
          let sv := items[smallest]
          items := (items.set i sv hi).set smallest cur (by rw [Array.size_set]; exact hs2)
          i := smallest
        else break
      else break
    return (some top, { items })
  return (some top, { items })

/-! ## Routing -/

structure RouteOptions where
  /-- Give up when an endpoint is farther than this from every way — there is
      no street to route on there, so trust the GPS instead. -/
  snapRadiusM : Float := 35
  /-- Abandon the search past this route length. -/
  maxRouteM : Float := 1200
  deriving Inhabited

private def posInf : Float := 1.0 / 0.0

/--
Shortest walkable path from `a` to `b`:
`[snapped-a, …graph nodes…, snapped-b]`, or `none`.

`ways` must be in way-iteration order — it fixes node numbering and breaks the
snap tie. The graph is built here, as the TS builds it per call.
-/
def routeOnWalkable (a b : Pt) (ways : Ways) (opts : RouteOptions := {}) :
    Option (Array Pt) := Id.run do
  if ways.isEmpty then return none
  let graph := buildWalkGraph ways
  let some from_ := snapToEdge a ways graph | return none
  let some to := snapToEdge b ways graph | return none
  if from_.distM > opts.snapRadiusM || to.distM > opts.snapRadiusM then return none

  -- Same-edge shortcut: both project onto one edge, so the route is straight
  -- along it and no search is needed. Still subject to `maxRouteM`: the bound
  -- is a property of the route, not of how it was found.
  if (from_.nodeA == to.nodeA && from_.nodeB == to.nodeB)
     || (from_.nodeA == to.nodeB && from_.nodeB == to.nodeA) then
    return if metersBetween from_.point to.point > opts.maxRouteM then none
           else some #[from_.point, to.point]

  -- Dijkstra from BOTH splice nodes of `from`, seeded with the along-edge
  -- distances, until both splice nodes of `to` are settled (or the bound trips).
  let n := graph.nodes.size
  let mut dist : Array Float := Array.replicate n posInf
  let mut prev : Array Int := Array.replicate n (-1)
  let mut settled : Array Bool := Array.replicate n false
  let mut heap : Heap := {}
  if hA : from_.nodeA < dist.size then dist := dist.set from_.nodeA from_.toA hA
  if hB : from_.nodeB < dist.size then dist := dist.set from_.nodeB from_.toB hB
  heap := heap.push from_.nodeA from_.toA
  heap := heap.push from_.nodeB from_.toB

  while heap.size > 0 do
    let (top, h') := heap.pop
    heap := h'
    match top with
    | none => break
    | some (id, key) =>
      -- A node id is below `n` by construction (the heap only ever holds the
      -- splice nodes and edge targets); one that is not is skipped rather than
      -- read off the end.
      if hid : id < settled.size ∧ id < graph.adj.size then
      -- Nested rather than `continue`d — see the heap's note.
      if !(settled[id]'hid.1) then
      settled := settled.set id true hid.1
      -- Frontier past the bound: STOP searching, but keep what is already
      -- settled. Answering `none` here reported "no walkable path exists" for a
      -- destination whose route was already known and admissible — the far
      -- splice node of a long destination edge can sit hundreds of metres out,
      -- so the search must overshoot the bound to settle it. `maxRouteM` bounds
      -- the ROUTE, and that bound is enforced on the total below.
      --
      -- Safe to read `dist` for unsettled nodes after this break: Dijkstra
      -- settles in increasing key order, so anything still unsettled when a key
      -- K is popped has final distance ≥ K > maxRouteM, and the total check
      -- rejects it.
      if key > opts.maxRouteM then break
      if (settled[to.nodeA]?.getD false) && (settled[to.nodeB]?.getD false) then break
      for (toId, w) in graph.adj[id]'hid.2 do
        let nd := key + w
        if ht : toId < dist.size ∧ toId < prev.size then
          if nd < dist[toId]'ht.1 then
            dist := dist.set toId nd ht.1
            prev := prev.set toId (Int.ofNat id) ht.2
            heap := heap.push toId nd

  -- Total cost of arriving at `to`'s edge via either of its splice nodes.
  -- An off-range splice node read `posInf` through the `!` default of 0.0?
  -- No: the `!` default is 0, which would have made a phantom route of cost
  -- `to.toA`. `getD posInf` is the honest reading — no node, no route.
  let viaA := (dist[to.nodeA]?.getD posInf) + to.toA
  let viaB := (dist[to.nodeB]?.getD posInf) + to.toB
  if !viaA.isFinite && !viaB.isFinite then return none
  let last := if viaA ≤ viaB then to.nodeA else to.nodeB
  let total := min viaA viaB
  if total > opts.maxRouteM then return none

  -- Backtrack the node chain, then bracket with the snapped endpoints.
  let mut chain : Array Nat := #[]
  let mut cur : Int := Int.ofNat last
  let mut cycled := false
  while cur != -1 do
    chain := chain.push cur.toNat
    if chain.size > n then
      cycled := true
      break
    match prev[cur.toNat]? with
    | some pv => cur := pv
    | none => break
  if cycled then return none

  let mut path : Array Pt := #[from_.point]
  for id in chain.reverse do
    match graph.nodes[id]? with
    | some node => path := path.push node
    | none => pure ()
  path := path.push to.point

  -- Drop degenerate duplicates (a snap point coinciding with a node).
  let mut out : Array Pt := #[]
  for p in path do
    let keep := match out.back? with
      | none => true
      | some prevPt => metersBetween prevPt p > 0.5
    if keep then out := out.push p
  return if out.size ≥ 2 then some out else none

/-! ## Parity with Node/V8 (`lean/experiments/walkable-route-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def LAT0 : Float := 51.52
private def LON0 : Float := -0.13
private def D : Float := 0.0009

/-! ### `projectPointToSegment` -/

private def segA : Pt := ⟨LAT0, LON0⟩
private def segB : Pt := ⟨LAT0, LON0 + D⟩

#guard (projectPointToSegment ⟨LAT0, LON0 - D⟩ segA segB).t == 0
#guard approx (projectPointToSegment ⟨LAT0, LON0 - D⟩ segA segB).distM 62.341123079945348
#guard (projectPointToSegment ⟨LAT0, LON0⟩ segA segB).distM == 0
#guard (projectPointToSegment ⟨LAT0, LON0 + D / 2⟩ segA segB).t == 0.5
#guard (projectPointToSegment ⟨LAT0, LON0 + D / 2⟩ segA segB).distM == 0
-- Clamped past the far end.
#guard (projectPointToSegment ⟨LAT0, LON0 + 2 * D⟩ segA segB).t == 1
#guard approx (projectPointToSegment ⟨LAT0, LON0 + 2 * D⟩ segA segB).distM 62.341123079943429
#guard approx (projectPointToSegment ⟨LAT0 + D / 3, LON0 + D / 2⟩ segA segB).distM 33.396000000317656
-- A degenerate segment projects to `a` with t = 0, not NaN.
#guard (projectPointToSegment ⟨LAT0 + D, LON0⟩ segA segA).t == 0
#guard approx (projectPointToSegment ⟨LAT0 + D, LON0⟩ segA segA).distM 100.18800000016199

/-! ### The block network

Four ways meeting at exact shared corner coordinates — the OSM junction
convention — fused shell-side into four nodes. -/

private def n0 : Pt := ⟨LAT0, LON0⟩
private def n1 : Pt := ⟨LAT0, LON0 + D⟩
private def n2 : Pt := ⟨LAT0 + D, LON0⟩
private def n3 : Pt := ⟨LAT0 + D, LON0 + D⟩

private def dSouth : Float := 62.341123079945348
private def dNorth : Float := 62.339891101219884
private def dSide : Float := 100.18800000016199

private def blockGraph : WalkGraph :=
  { nodes := #[n0, n1, n2, n3],
    adj := #[#[(1, dSouth), (2, dSide)],
             #[(0, dSouth), (3, dSide)],
             #[(0, dSide), (3, dNorth)],
             #[(2, dNorth), (1, dSide)]] }

/-- The same block as four ways. `buildWalkGraph` must fuse the shared corners
    so this yields exactly `blockGraph` — 8 coordinates down to 4 nodes. -/
private def blockWays : Ways := #[#[n0, n1], #[n0, n2], #[n2, n3], #[n1, n3]]

private def graphEq (g : WalkGraph) (h : WalkGraph) : Bool :=
  g.nodes.size == h.nodes.size && g.adj.size == h.adj.size
    && (Array.range g.nodes.size).all (fun i =>
        approx g.nodes[i]!.lat h.nodes[i]!.lat && approx g.nodes[i]!.lon h.nodes[i]!.lon)
    && (Array.range g.adj.size).all (fun i =>
        g.adj[i]!.size == h.adj[i]!.size
          && (Array.range g.adj[i]!.size).all (fun k =>
              g.adj[i]![k]!.1 == h.adj[i]![k]!.1 && approx g.adj[i]![k]!.2 h.adj[i]![k]!.2))

#guard graphEq (buildWalkGraph blockWays) blockGraph
-- A way repeated shares every node, and the edge dedupe keeps the adjacency
-- unchanged rather than doubling it.
#guard graphEq (buildWalkGraph (blockWays.push #[n0, n1])) blockGraph
-- A zero-length edge (`< 1e-3 m`) is dropped, so a repeated coordinate adds a
-- node but no edge.
#guard (buildWalkGraph #[#[n0, n0]]).nodes.size == 1
#guard (buildWalkGraph #[#[n0, n0]]).adj[0]!.isEmpty

private def ptsApprox (a : Array Pt) (b : List Pt) : Bool :=
  a.size == b.length && (a.toList.zip b).all (fun (x, y) => approx x.lat y.lat && approx x.lon y.lon)

/-! ### `routeOnWalkable` -/

-- No network at all.
#guard (routeOnWalkable n0 n2 #[]).isNone
-- Both endpoints on ONE edge: straight along it, no search.
#guard match routeOnWalkable ⟨LAT0, LON0 + D * 0.25⟩ ⟨LAT0, LON0 + D * 0.75⟩ blockWays with
  | some r => ptsApprox r [⟨LAT0, LON0 + D * 0.25⟩, ⟨LAT0, LON0 + D * 0.75⟩]
  | none => false
-- Around one corner: snapped-start, the shared junction, snapped-end.
#guard match routeOnWalkable ⟨LAT0, LON0 + D * 0.5⟩ ⟨LAT0 + D * 0.5, LON0⟩ blockWays with
  | some r => ptsApprox r [⟨LAT0, LON0 + D * 0.5⟩, n0, ⟨LAT0 + D * 0.5, LON0⟩]
  | none => false
-- Diagonally opposite corners. The two ways round are NOT equal-cost: the north
-- edge is ~1 mm shorter than the south because `cos(lat)` differs, so the
-- west-then-north route wins deterministically.
#guard match routeOnWalkable n0 n3 blockWays with
  | some r => ptsApprox r [n0, n2, n3]
  | none => false
-- An endpoint with no way in range.
#guard (routeOnWalkable ⟨LAT0 + 0.01, LON0⟩ ⟨LAT0, LON0 + D⟩ blockWays).isNone
-- The snap radius is a real gate: ~2.2 m off the way passes at 5 m, fails at 1 m.
#guard (routeOnWalkable ⟨LAT0 + 0.00002, LON0 + D * 0.5⟩ ⟨LAT0 + D * 0.5, LON0⟩
  blockWays { snapRadiusM := 5 }).isSome
#guard (routeOnWalkable ⟨LAT0 + 0.00002, LON0 + D * 0.5⟩ ⟨LAT0 + D * 0.5, LON0⟩
  blockWays { snapRadiusM := 1 }).isNone
-- The corner route is ~81 m, so a 50 m bound refuses it rather than detouring.
#guard (routeOnWalkable ⟨LAT0, LON0 + D * 0.5⟩ ⟨LAT0 + D * 0.5, LON0⟩
  blockWays { maxRouteM := 50 }).isNone

/-! ### The bound is on the ROUTE, not on the search

One straight street with a junction at 2D (~125 m) and a far end at 8D (~499 m).
The destination sits just past the junction, on the LONG second edge, so its far
splice node is ~374 m out — Dijkstra has to overshoot the bound to settle it,
even though the route itself is ~128 m and admissible. -/

private def e2 : Pt := ⟨LAT0, LON0 + 2 * D⟩
private def e8 : Pt := ⟨LAT0, LON0 + 8 * D⟩
private def longWays : Ways := #[#[n0, e2, e8]]
private def justPast : Pt := ⟨LAT0, LON0 + 2.05 * D⟩

#guard match routeOnWalkable n0 justPast longWays { maxRouteM := 130 } with
  | some r => ptsApprox r [n0, e2, justPast]
  | none => false
-- ...while a route that is ITSELF over the bound is still refused.
#guard (routeOnWalkable n0 justPast longWays { maxRouteM := 120 }).isNone
-- The same-edge shortcut obeys the bound too: ~94 m along one edge, no search.
#guard (routeOnWalkable n0 ⟨LAT0, LON0 + 1.5 * D⟩ longWays { maxRouteM := 120 }).isSome
#guard (routeOnWalkable n0 ⟨LAT0, LON0 + 1.5 * D⟩ longWays { maxRouteM := 60 }).isNone

/-! ### A disconnected network

Two ways sharing no coordinate: reachable snaps, no path. Generous snap radius,
so the `none` is connectivity and not the radius gate. -/

private def s2 : Pt := ⟨LAT0 + 5 * D, LON0⟩
private def s3 : Pt := ⟨LAT0 + 5 * D, LON0 + D⟩
private def splitGraph : WalkGraph :=
  { nodes := #[n0, n1, s2, s3],
    adj := #[#[(1, dSouth)], #[(0, dSouth)],
             #[(3, 62.334963032503580)], #[(2, 62.334963032503580)]] }
private def splitWays : Ways := #[#[n0, n1], #[s2, s3]]
#guard graphEq (buildWalkGraph splitWays) splitGraph

#guard (routeOnWalkable n0 s2 splitWays { snapRadiusM := 2000 }).isNone
-- ...while each component still routes within itself.
#guard (routeOnWalkable ⟨LAT0, LON0 + D * 0.25⟩ ⟨LAT0, LON0 + D * 0.75⟩ splitWays).isSome

end Verified.Geo.WalkableRoute
