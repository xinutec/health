import Verified.Hsmm.RouteModel
import Verified.Hsmm.RouteGraph
/-!
# C4.3 chained train triples — the graph layer (port of `src/hmm/station-chain.ts`, #672)

`resolveStationChain` assigns each named-line train leg a (board, alight)
station pair, scored jointly along the journey chain. It runs on the SERVED and
PERSISTED decode path — `decodeServed` → both arms → `segmentsFromStates` →
here, then `decode-day.ts` writes the result to `decoded_days` — which is the
finding #672 records: every coverage number had this module excluded as
off-path.

This file is the graph half: the candidate substrate and the along-line
distances every scoring term is measured against. The scoring terms, the pair
Viterbi and the max-marginal emission gates follow.

## Node ORDER is load-bearing, so the graph carries an ordered node array

`stationsNear` walks `routeGraph.nodes.values()` — a JS `Map`, hence INSERTION
order — and `sideCandidates` then (1) dedupes by station name keeping the first
best, (2) sorts by anchor penalty with V8's STABLE sort, and (3) cuts at
`MAX_CANDIDATES_PER_SIDE`. All three read that order, so ties at the cut are
decided by it.

`TrainCandidates.stationsNear` is NOT reused here for exactly that reason: it
folds a `Std.HashMap`, so it yields hash order. That is invisible in its own
guards, whose caller takes a minimum over the result and therefore cannot see a
permutation. Reusing it here would import an order this module's caller reads —
the `dedupNearestWays` hazard (#426) in a new place. So `ChainGraph` carries
`nodes : Array ChainNode` in the builder's insertion order, and the shell hands
it over in that order.

`nodeKey`'s `toFixed` rounding stays SHELL-side, as it does for
`RouteConnectivity`: edges carry `startNode` / `endNode` as the already-computed
key strings. Note the consequence, which is real and ~0.3 m wide — a node's
coordinates are the ROUNDED key parsed back, while the edge geometry it belongs
to keeps full precision. Both are used, for different things, and neither is a
rounding of the other's use.

UNPROVEN; pinned by the `#guard`s against V8 (`lean/experiments/station-chain-refs.mts`).
-/

namespace Verified.Hsmm.StationChain

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.RouteGraph (LatLon geometryLengthM)
open Verified.Hsmm.RouteModel (RouteGraphModel RouteEdge buildRouteGraphModel edgesNearIdx)

/-- Station-footprint radius (m) — `train-candidate-generator.ts`'s constant,
    restated here because this module's copy is what its own guards pin. -/
def STATION_FOOTPRINT_M : Float := 200
/-- Lines are read from edges within this radius of a station node. -/
def STATION_LINE_RADIUS_M : Float := 250

/-- A station-annotated graph node. `lat`/`lon` are the `nodeKey` string parsed
    back to numbers, which is what `buildRouteGraph` materialises them from. -/
structure ChainNode where
  id : String
  lat : Float
  lon : Float
  stationName : Option String
  edgeIds : List String
  deriving Inhabited, Repr

/-- The resolver's view of the route graph. `nodes` is ORDERED — see the module
    docstring; the maps are lookups only and no iteration reads them. -/
structure ChainGraph where
  model : RouteGraphModel
  nodes : Array ChainNode
  nodeById : Std.HashMap String ChainNode
  edgeById : Std.HashMap String RouteEdge

def mkChainGraph (edges : Array RouteEdge) (nodes : Array ChainNode) : ChainGraph :=
  { model := buildRouteGraphModel edges
    nodes := nodes
    nodeById := nodes.foldl (fun m n => m.insert n.id n) {}
    edgeById := edges.foldl (fun m e => m.insert e.id e) {} }

/-- Lines with an edge within `STATION_LINE_RADIUS_M` of the node. Membership is
    all the caller tests, so the result order is not read. -/
def stationLineMemberships (g : ChainGraph) (n : ChainNode) : List String :=
  (edgesNearIdx g.model n.lat n.lon STATION_LINE_RADIUS_M).foldl (fun acc i =>
    g.model.edges[i]!.lineMemberships.foldl (fun acc l =>
      if acc.contains l then acc else acc ++ [l]) acc) []

/-- Station nodes within `radiusM`, paired with their distance, IN GRAPH ORDER.
    The order is the point of this function existing separately — see the
    module docstring. -/
def stationsNear (g : ChainGraph) (lat lon radiusM : Float) : Array (ChainNode × Float) :=
  g.nodes.foldl (fun acc n =>
    match n.stationName with
    | none => acc
    | some _ =>
      let d := haversineMeters lat lon n.lat n.lon
      if d ≤ radiusM then acc.push (n, d) else acc) #[]

/-- Every node id within `STATION_FOOTPRINT_M` of a station, including its own,
    for seeding and terminating the along-line search. Set-valued: only
    membership is read. -/
def stationFootprintNodes (g : ChainGraph) (station : ChainNode) : Std.HashSet String :=
  (edgesNearIdx g.model station.lat station.lon STATION_FOOTPRINT_M).foldl (fun acc i =>
    let e := g.model.edges[i]!
    let acc := match e.geometry.head? with
      | some p => if haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M
                  then acc.insert e.startNode else acc
      | none => acc
    match e.geometry.getLast? with
    | some p => if haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M
                then acc.insert e.endNode else acc
    | none => acc) (Std.HashSet.emptyWithCapacity.insert station.id)

/-- Dijkstra state modelled on the TS `Map`: `order` reproduces JS insertion
    order, which the min-extraction scan reads and which decides ties. Updating
    an existing key must NOT move it, exactly as `Map.set` does not. -/
private structure Sssp where
  order : Array String
  dist : Std.HashMap String Float
  done : Std.HashSet String

private def relax (st : Sssp) (id : String) (d : Float) : Sssp :=
  match st.dist.get? id with
  | some cur => if d < cur then { st with dist := st.dist.insert id d } else st
  | none => { order := st.order.push id, dist := st.dist.insert id d, done := st.done }

/-- One extraction: the least-distance node not yet done, first-inserted on a
    tie (the scan uses a STRICT `<`, so an equal later entry never displaces). -/
private def extractMin (st : Sssp) : Option (String × Float) :=
  st.order.foldl (fun acc id =>
    if st.done.contains id then acc
    else match st.dist.get? id with
      | none => acc
      | some d => match acc with
        | none => some (id, d)
        | some (_, bd) => if d < bd then some (id, d) else acc) none

private def ssspLoop (g : ChainGraph) (line : String) : Nat → Sssp → Sssp
  | 0, st => st
  | fuel + 1, st =>
    match extractMin st with
    | none => st
    | some (bestId, bestD) =>
      let st := { st with done := st.done.insert bestId }
      match g.nodeById.get? bestId with
      -- The TS `continue`s here: the node is already marked done, and the loop
      -- goes round again rather than stopping.
      | none => ssspLoop g line fuel st
      | some node =>
        let st := node.edgeIds.foldl (fun st eid =>
          match g.edgeById.get? eid with
          | none => st
          | some e =>
            if !e.lineMemberships.contains line then st
            else
              let len := geometryLengthM e.geometry
              [e.startNode, e.endNode].foldl (fun st nextId =>
                if st.done.contains nextId then st else relax st nextId (bestD + len)) st) st
        ssspLoop g line fuel st

/-- Dijkstra over `line`'s own edges from seeded nodes. Distances for every node
    reached.

    The fuel is not a budget: each round marks exactly one node done and a node
    is done at most once, so `nodes.size + seeds` rounds cannot be reached. It
    exists because Lean needs a decreasing measure, not because the search is
    allowed to be cut short. -/
def lineSssp (g : ChainGraph) (line : String) (seeds : Array (String × Float)) :
    Std.HashMap String Float :=
  let st0 : Sssp := seeds.foldl (fun st (id, d) => relax st id d)
    { order := #[], dist := {}, done := {} }
  (ssspLoop g line (g.nodes.size + seeds.size + 1) st0).dist

/-- Shortest along-line path (m) between two stations' footprints, or `none`
    when unreachable. Doubles as the pair-connectivity constraint. -/
def linePathMeters (g : ChainGraph) (line : String) (a b : ChainNode) : Option Float :=
  let start := stationFootprintNodes g a
  let goal := stationFootprintNodes g b
  if start.isEmpty || goal.isEmpty then none
  else if start.any (goal.contains ·) then some 0
  else
    let dist := lineSssp g line (start.toArray.map (fun id => (id, (0 : Float))))
    goal.fold (fun acc id =>
      match dist.get? id with
      | none => acc
      | some d => match acc with
        | none => some d
        | some bd => if d < bd then some d else acc) none

/-! ## Guards — the synthetic line from `lean/experiments/station-chain-refs.mts`

Five evenly-spaced stations west to east at lat 51.5, built there through the
REAL `buildRouteGraph`, so these literals are its output rather than a second
hand-assembly of the same graph. Note the two coordinate systems the builder
produces and this file must keep apart: node coordinates are the 5-decimal
`nodeKey` parsed back (`0.02165`), edge geometry is full precision
(`0.021645543464882695`). -/

/-- Edge geometry longitudes — FULL precision, as the WKT carried them. -/
private def LONS : Array Float :=
  #[0, 0.021645543464882695, 0.04329108692976539, 0.06493663039464809, 0.08658217385953078]

/-- Node keys — the same coordinates at `nodeKey`'s five decimals. Kept as
    literals rather than derived, because deriving them would put `toFixed` in
    Lean, which is the boundary this port deliberately leaves shell-side. -/
private def KEYS : Array String :=
  #["51.50000,0.00000", "51.50000,0.02165", "51.50000,0.04329", "51.50000,0.06494", "51.50000,0.08658"]

private def edgeOf (i : Nat) : RouteEdge :=
  { id := s!"way:{1000 + i}"
    geometry := [⟨51.5, LONS[i]!⟩, ⟨51.5, LONS[i + 1]!⟩]
    lineMemberships := ["Test Line"]
    underground := true
    startNode := KEYS[i]!
    endNode := KEYS[i + 1]! }

private def testEdges : Array RouteEdge := #[edgeOf 0, edgeOf 1, edgeOf 2, edgeOf 3]

private def testNodes : Array ChainNode :=
  #[⟨KEYS[0]!, 51.5, 0, some "Alpha", ["way:1000"]⟩,
    ⟨KEYS[1]!, 51.5, 0.02165, some "Bravo", ["way:1000", "way:1001"]⟩,
    ⟨KEYS[2]!, 51.5, 0.04329, some "Charlie", ["way:1001", "way:1002"]⟩,
    ⟨KEYS[3]!, 51.5, 0.06494, some "Delta", ["way:1002", "way:1003"]⟩,
    ⟨KEYS[4]!, 51.5, 0.08658, some "Echo", ["way:1003"]⟩]

private def testGraph : ChainGraph := mkChainGraph testEdges testNodes

private def station (name : String) : ChainNode :=
  (testNodes.find? (fun n => n.stationName == some name)).getD default

/-- Every reference value below is a RANGE rather than an equality. The V8
    figures are printed to nine decimals, and pinning a Float to a decimal
    rendering would be pinning the rendering. The windows are tight enough that
    a real divergence cannot sit inside one. -/
private def within (x lo hi : Float) : Bool := x > lo && x < hi

private def edge0Len : Float := geometryLengthM testEdges[0]!.geometry

private def pathBetween (a b : String) : Option Float :=
  linePathMeters testGraph "Test Line" (station a) (station b)

-- V8: `graph.edges` reports every edge at 1498.314672649 m.
#guard within edge0Len 1498.3146726 1498.3146727

-- Every station reads the line, so no candidate is excluded for membership.
#guard testNodes.all (fun n => stationLineMemberships testGraph n == ["Test Line"])

-- Adjacent stations are one edge apart, Alpha→Delta three. Pinned against the
-- V8 edge length rather than against a second computation of it.
#guard (pathBetween "Alpha" "Bravo").any (within · 1498.3146726 1498.3146727)
#guard (pathBetween "Alpha" "Delta").any (within · 4494.9440179 4494.9440180)

-- NOT exactly symmetric, and that is a property of the algorithm rather than a
-- defect in this port. The search sums edge lengths in TRAVERSAL order, and the
-- four edges of this deliberately-uniform line are NOT bit-identical in length:
-- their longitudes differ, so `haversineMeters` returns doubles that agree to
-- every printed decimal and disagree in the last bits (measured: edges 0-2
-- compare equal to each other, edge 3 does not). Adding them west-to-east and
-- east-to-west therefore lands a ULP apart.
--
-- The TS accumulates identically, so this is shared, not divergent — but it is
-- why the guard is a window rather than `pathBetween a b == pathBetween b a`,
-- which is what the first version asserted and what failed.
#guard (pathBetween "Alpha" "Echo").any (within · 5993.2586905 5993.2586907)
#guard (pathBetween "Echo" "Alpha").any (within · 5993.2586905 5993.2586907)

-- A station against itself shares a footprint node, so the path is 0 — the arm
-- that makes MIN_PATH_M reject a self-pair rather than divide by it.
#guard pathBetween "Charlie" "Charlie" == some 0

-- No edge carries a line by this name, so nothing is reachable. This is the
-- connectivity constraint doing its job, not an error path.
#guard linePathMeters testGraph "Absent Line" (station "Alpha") (station "Echo") == none

-- `stationsNear` returns GRAPH ORDER, not distance order — the property the
-- whole ordered-array design exists for. A radius covering Bravo, Charlie and
-- Delta from a point beside Charlie must list them west to east, NOT nearest
-- first.
#guard
  (stationsNear testGraph 51.5 0.04329 1600.0).map (fun p => p.1.stationName)
    == #[some "Bravo", some "Charlie", some "Delta"]

-- The radius is inclusive and measured from the node's ROUNDED coordinates.
#guard (stationsNear testGraph 51.5 0 1.0).size == 1
#guard (stationsNear testGraph 51.5 0 0.0).size == 1

end Verified.Hsmm.StationChain
