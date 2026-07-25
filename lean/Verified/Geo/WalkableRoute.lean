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
    for i in [1:w.size] do
      -- `nodeAt` for each end, earlier coordinate first — that order is what
      -- numbers the nodes.
      let mut ids : Array Nat := #[]
      for c in #[w[i - 1]!, w[i]!] do
        let key := Verified.JsNum.coordKey7 c.lat c.lon
        match index[key]? with
        | some id => ids := ids.push id
        | none =>
          let id := nodes.size
          nodes := nodes.push c
          adj := adj.push #[]
          index := index.insert key id
          ids := ids.push id
      let a := ids[0]!
      let b := ids[1]!
      if a != b then
        -- The FUSED node coordinates, not the way's raw ones.
        let d := metersBetween nodes[a]! nodes[b]!
        if d ≥ 1e-3 then
          -- Dedupe: ways can overlap on a shared stretch.
          if !(adj[a]!.any (fun e => e.1 == b)) then adj := adj.set! a (adj[a]!.push (b, d))
          if !(adj[b]!.any (fun e => e.1 == a)) then adj := adj.set! b (adj[b]!.push (a, d))
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
  for i in [0:graph.nodes.size] do
    let n := graph.nodes[i]!
    index := index.insert (Verified.JsNum.coordKey7 n.lat n.lon) i
  let mut best : Option Snap := none
  for w in ways do
    for i in [1:w.size] do
      let a := w[i - 1]!
      let b := w[i]!
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

private structure Heap where
  ids : Array Nat := #[]
  keys : Array Float := #[]
  deriving Inhabited

private def Heap.size (h : Heap) : Nat := h.ids.size

private def Heap.push (h : Heap) (id : Nat) (key : Float) : Heap := Id.run do
  let mut ids := h.ids.push id
  let mut keys := h.keys.push key
  let mut i := ids.size - 1
  while i > 0 do
    let parent := (i - 1) / 2
    if keys[parent]! ≤ keys[i]! then break
    let ti := ids[i]!
    let tp := ids[parent]!
    ids := (ids.set! i tp).set! parent ti
    let ki := keys[i]!
    let kp := keys[parent]!
    keys := (keys.set! i kp).set! parent ki
    i := parent
  return { ids := ids, keys := keys }

private def Heap.pop (h : Heap) : Option (Nat × Float) × Heap := Id.run do
  if h.ids.isEmpty then return (none, h)
  let topId := h.ids[0]!
  let topKey := h.keys[0]!
  let lastId := h.ids[h.ids.size - 1]!
  let lastKey := h.keys[h.keys.size - 1]!
  let mut ids := h.ids.pop
  let mut keys := h.keys.pop
  if ids.size > 0 then
    ids := ids.set! 0 lastId
    keys := keys.set! 0 lastKey
    let mut i := 0
    while true do
      let l := 2 * i + 1
      let r := l + 1
      let mut smallest := i
      if l < ids.size && keys[l]! < keys[smallest]! then smallest := l
      if r < ids.size && keys[r]! < keys[smallest]! then smallest := r
      if smallest == i then break
      let ti := ids[i]!
      let ts := ids[smallest]!
      ids := (ids.set! i ts).set! smallest ti
      let ki := keys[i]!
      let ks := keys[smallest]!
      keys := (keys.set! i ks).set! smallest ki
      i := smallest
  return (some (topId, topKey), { ids := ids, keys := keys })

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
  -- along it and no search is needed.
  if (from_.nodeA == to.nodeA && from_.nodeB == to.nodeB)
     || (from_.nodeA == to.nodeB && from_.nodeB == to.nodeA) then
    return some #[from_.point, to.point]

  -- Dijkstra from BOTH splice nodes of `from`, seeded with the along-edge
  -- distances, until both splice nodes of `to` are settled (or the bound trips).
  let n := graph.nodes.size
  let mut dist : Array Float := Array.replicate n posInf
  let mut prev : Array Int := Array.replicate n (-1)
  let mut settled : Array Bool := Array.replicate n false
  let mut heap : Heap := {}
  if from_.nodeA < n then dist := dist.set! from_.nodeA from_.toA
  if from_.nodeB < n then dist := dist.set! from_.nodeB from_.toB
  heap := heap.push from_.nodeA from_.toA
  heap := heap.push from_.nodeB from_.toB

  let mut bailed := false
  while heap.size > 0 do
    let (top, h') := heap.pop
    heap := h'
    match top with
    | none => break
    | some (id, key) =>
      if settled[id]! then
        continue
      settled := settled.set! id true
      -- The best remaining is already too long: no route can beat the bound.
      if key > opts.maxRouteM then
        bailed := true
        break
      if settled[to.nodeA]! && settled[to.nodeB]! then break
      for (toId, w) in graph.adj[id]! do
        let nd := key + w
        if nd < dist[toId]! then
          dist := dist.set! toId nd
          prev := prev.set! toId (Int.ofNat id)
          heap := heap.push toId nd
  if bailed then return none

  -- Total cost of arriving at `to`'s edge via either of its splice nodes.
  let viaA := dist[to.nodeA]! + to.toA
  let viaB := dist[to.nodeB]! + to.toB
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
    cur := prev[cur.toNat]!
  if cycled then return none

  let mut path : Array Pt := #[from_.point]
  for id in chain.reverse do
    path := path.push graph.nodes[id]!
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
