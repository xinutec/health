import Verified.Hsmm.RouteGraph
import Verified.Hsmm.RouteConnectivity
import Verified.Hsmm.FloatScore
import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
/-!
# Unified route-graph model + fully Lean-computed route-rail factor

Composes the ported route-graph query primitives (`edgesNear`, `pathExistsOnLine`,
`pointToPolylineMeters`, `parseLineMemberships`-derived memberships, `haversine`)
into the route-rail emission term — the FIRST factor whose route-graph facts
(`linesPresent` / `linesUnderground` at each bookend fix, and per-line
connectivity) are computed IN Lean rather than taken as caller-resolved booleans.

The shell supplies parsed edges (id, geometry, line memberships, underground
flag, and the `toFixed`-derived node ids that define adjacency — the parity-hard
graph-STRUCTURE boundary); everything downstream is pure Lean. Caches are dropped
(pure recompute — the TS caches are semantically transparent memoisation, keyed
by `toFixed` rounding that only affected hit-rate, never results). UNPROVEN;
pinned by the `#guard`s (decisions from Node/V8's `buildRouteRailEvidence`).
-/

namespace Verified.Hsmm.RouteModel

open Verified.Hsmm.RouteGraph (LatLon cellOf neighborCells pointToPolylineMeters)
open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Observation (ObsRow Fix)

def EDGE_PROXIMITY_M : Float := 600
def MIN_GAP_DURATION_S : Int := 300
def MAX_GAP_DURATION_S : Int := 5400
def MIN_GAP_DISTANCE_M : Float := 1000
def UNDERGROUND_BOOST : Float := 3.5

/-- A parsed route edge with the attributes the factors read. Node ids are the
    shell's `toFixed` topology keys (opaque here). -/
structure RouteEdge where
  id : String
  geometry : List LatLon
  lineMemberships : List String
  underground : Bool
  startNode : String
  endNode : String
  deriving Inhabited

structure RouteGraphModel where
  edges : Array RouteEdge
  cellIndex : Std.HashMap (Int × Int) (Array Nat)
  nodeEdges : Std.HashMap String (List String)

private def appendDistinct (xs : List String) (x : String) : List String :=
  if xs.contains x then xs else xs ++ [x]

/-- Unique cells an edge's geometry touches. -/
def edgeCells (e : RouteEdge) : List (Int × Int) :=
  e.geometry.foldl (fun acc p =>
    let c := cellOf p.lat p.lon
    if acc.contains c then acc else acc ++ [c]) []

/-- Build the spatial (cell) + adjacency (node→edges) indices from parsed edges. -/
def buildRouteGraphModel (edges : Array RouteEdge) : RouteGraphModel :=
  let cellIndex := (List.range edges.size).foldl (fun idx i =>
    (edgeCells edges[i]!).foldl (fun idx c => idx.insert c ((idx.getD c #[]).push i)) idx) {}
  let nodeEdges := (List.range edges.size).foldl (fun ne i =>
    let e := edges[i]!
    let ne := ne.insert e.startNode (appendDistinct (ne.getD e.startNode []) e.id)
    ne.insert e.endNode (appendDistinct (ne.getD e.endNode []) e.id)) {}
  { edges, cellIndex, nodeEdges }

/-- Edge indices whose geometry passes within `radiusM` of `(lat, lon)` (grid
    scan, dedup, first-seen order — same as `RouteGraph.edgesNear`). -/
def edgesNearIdx (g : RouteGraphModel) (lat lon radiusM : Float) : Array Nat :=
  ((neighborCells lat lon).foldl (fun (st : Array Nat × Array Nat) c =>
    (g.cellIndex.getD c #[]).foldl (fun (st : Array Nat × Array Nat) i =>
      if st.2.contains i then st
      else if pointToPolylineMeters lat lon g.edges[i]!.geometry ≤ radiusM then (st.1.push i, st.2.push i)
      else (st.1, st.2.push i)) st) (#[], #[])).1

/-- Lines present near a fix, and which of them have an underground edge there. -/
structure FixLineEvidence where
  linesPresent : List String
  linesUnderground : List String

def computeFixLineEvidence (g : RouteGraphModel) (lat lon : Float) : FixLineEvidence :=
  (edgesNearIdx g lat lon EDGE_PROXIMITY_M).foldl (fun ev i =>
    let e := g.edges[i]!
    e.lineMemberships.foldl (fun ev line =>
      { linesPresent := appendDistinct ev.linesPresent line,
        linesUnderground := if e.underground then appendDistinct ev.linesUnderground line
                            else ev.linesUnderground }) ev)
    { linesPresent := [], linesUnderground := [] }

/-- Ids of edges near a fix that carry `line` (BFS start/goal sets). -/
def edgesNearOnLine (g : RouteGraphModel) (line : String) (lat lon : Float) : List String :=
  (edgesNearIdx g lat lon EDGE_PROXIMITY_M).toList.filterMap (fun i =>
    let e := g.edges[i]!
    if e.lineMemberships.contains line then some e.id else none)

/-- The BFS view of the model (edge endpoints + memberships + node adjacency). -/
def toConnGraph (g : RouteGraphModel) : RouteConnectivity.Graph :=
  let endpoints := (List.range g.edges.size).foldl (fun m i =>
    let e := g.edges[i]!; m.insert e.id [e.startNode, e.endNode]) {}
  let lines := (List.range g.edges.size).foldl (fun m i =>
    let e := g.edges[i]!; m.insert e.id e.lineMemberships) {}
  { endpoints, lines, nodeEdges := g.nodeEdges }

/-- `buildRouteRailEvidence`'s per-state verdict, with the route-graph facts
    computed in Lean. `isCovered` (train-generator coverage) stays caller-side. -/
def routeRailEvidence (g : RouteGraphModel) (cg : RouteConnectivity.Graph)
    (s : State) (o : ObsRow) (isCovered : Bool) : Float :=
  if s.mode != .train then 0.0
  else if isCovered then 0.0
  else match s.lineName with
    | none => 0.0
    | some line =>
      if line == "unknown_rail" then 0.0
      else if o.gps.isSome then 0.0
      else match o.prevGpsFix, o.nextGpsFix with
        | some prev, some next =>
          if next.ts - prev.ts < MIN_GAP_DURATION_S then 0.0
          else if next.ts - prev.ts > MAX_GAP_DURATION_S then 0.0
          else if haversineMeters prev.lat prev.lon next.lat next.lon < MIN_GAP_DISTANCE_M then 0.0
          else
            let pe := computeFixLineEvidence g prev.lat prev.lon
            let ne := computeFixLineEvidence g next.lat next.lon
            if !pe.linesPresent.contains line || !ne.linesPresent.contains line then 0.0
            else if !pe.linesUnderground.contains line || !ne.linesUnderground.contains line then 0.0
            else if !RouteConnectivity.pathExistsOnLine cg line
                      (edgesNearOnLine g line prev.lat prev.lon)
                      (edgesNearOnLine g line next.lat next.lon) then 0.0
            else UNDERGROUND_BOOST
        | _, _ => 0.0

-- Parity with the real `buildRouteRailEvidence` over a built graph (Node/V8).
private def edge (id : String) (g : List LatLon) (ug : Bool) (n1 n2 : String) : RouteEdge :=
  ⟨id, g, ["Test Line"], ug, n1, n2⟩

-- Two underground "Test Line" edges sharing node "nMid" → one connected path.
private def connModel : RouteGraphModel := buildRouteGraphModel #[
  edge "way:1" [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩] true "nA" "nMid",
  edge "way:2" [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩] true "nMid" "nB"]
private def connCg : RouteConnectivity.Graph := toConnGraph connModel

-- Same bookends, but the two underground edges share no node → not connected.
private def disconnModel : RouteGraphModel := buildRouteGraphModel #[
  edge "way:1" [⟨51.50, -0.101⟩, ⟨51.501, -0.099⟩] true "d1a" "d1b",
  edge "way:3" [⟨51.55, -0.051⟩, ⟨51.551, -0.049⟩] true "d3a" "d3b"]
private def disconnCg : RouteConnectivity.Graph := toConnGraph disconnModel

-- Connected geometry but surface (not underground).
private def surfModel : RouteGraphModel := buildRouteGraphModel #[
  edge "way:1" [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩] false "sA" "sMid",
  edge "way:2" [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩] false "sMid" "sB"]
private def surfCg : RouteConnectivity.Graph := toConnGraph surfModel

private def obs : ObsRow :=
  { ts := 1600, gps := none, hr := none, cadence := none, hourLocal := 0, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := some ⟨1000, 51.50, -0.10⟩, nextGpsFix := some ⟨1600, 51.55, -0.05⟩ }
private def shortObs : ObsRow := { obs with nextGpsFix := some ⟨1200, 51.55, -0.05⟩ }
private def train : State := ⟨.train, none, some "Test Line"⟩

#guard routeRailEvidence connModel connCg train obs false == 3.5      -- connected underground
#guard routeRailEvidence disconnModel disconnCg train obs false == 0  -- no L path
#guard routeRailEvidence surfModel surfCg train obs false == 0        -- surface, not underground
#guard routeRailEvidence connModel connCg train shortObs false == 0   -- gap 200s < 300
#guard routeRailEvidence connModel connCg train obs true == 0         -- generator-covered
#guard routeRailEvidence connModel connCg ⟨.walking, none, none⟩ obs false == 0  -- not train

end Verified.Hsmm.RouteModel
