import Verified.Hsmm.TrainWindows
import Verified.Hsmm.RouteModel
/-!
# Train (board, line, alight) candidate generator (port of `enumerateTrainCandidates`)

The graph-dependent completion of the train-candidate generator: each train
window from `findTrainWindows` is matched to board/alight station nodes near its
GPS bookends, and a candidate is emitted for every line whose stations at both
ends are graph-connected on that line's edge subgraph. Its output feeds the
coverage map that gates the per-minute train factors.

Consumes a node-annotated `StationGraph` — the shell supplies the station
annotation (`toFixed` node ids, `parseTags` on OSM points; the parity-hazard
graph-structure boundary); everything here is pure Lean over it, reusing
`edgesNearIdx` and `haversine`. Pure graph/observation work, so candidate
membership is exact (velocity/proximity thresholds sit far from boundaries in
the tested case). UNPROVEN; pinned by the `#guard`.
-/

namespace Verified.Hsmm.TrainCandidates

open Verified.Hsmm.Observation (ObsRow)
open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.RouteGraph (LatLon)
open Verified.Hsmm.RouteModel (RouteGraphModel RouteEdge edgesNearIdx)
open Verified.Hsmm.TrainWindows (findTrainWindows)

def R_STATION_M : Float := 250
def STATION_LINE_RADIUS_M : Float := 250
def STATION_FOOTPRINT_M : Float := 200
def MAX_EXPAND : Nat := 10000

/-- A station-annotated graph node: id, coords, optional station name, incident edges. -/
structure StationNode where
  id : String
  lat : Float
  lon : Float
  stationName : Option String
  edgeIds : List String
  deriving Inhabited

/-- The candidate generator's view: the spatial model + node/edge lookups. -/
structure StationGraph where
  model : RouteGraphModel
  nodeById : Std.HashMap String StationNode
  edgeById : Std.HashMap String RouteEdge

structure Candidate where
  startMin : Nat
  endMin : Nat
  line : String
  boardStationId : String
  alightStationId : String
  boardStationName : Option String
  alightStationName : Option String

private def appendDistinct (xs : List String) (x : String) : List String :=
  if xs.contains x then xs else xs ++ [x]

/-- GPS context at minute `t`: the fix there, else the nearest observed fix in
    time, else the prev/next-fix bookend. -/
partial def scanOutward (obs : Array ObsRow) (t d : Nat) : Option (Float × Float) :=
  if d ≥ obs.size then none
  else
    let left : Int := (t : Int) - d
    let leftHit := if decide (left ≥ 0) then
      (match obs[left.toNat]!.gps with | some g => some (g.lat, g.lon) | none => none) else none
    match leftHit with
    | some r => some r
    | none =>
      if t + d < obs.size then
        match obs[t + d]!.gps with
        | some g => some (g.lat, g.lon)
        | none => scanOutward obs t (d + 1)
      else scanOutward obs t (d + 1)

def gpsContextAt (obs : Array ObsRow) (t : Int) : Option (Float × Float) :=
  if decide (t < 0) || decide (t ≥ (obs.size : Int)) then none
  else
    let tn := t.toNat
    match obs[tn]!.gps with
    | some g => some (g.lat, g.lon)
    | none => match scanOutward obs tn 1 with
      | some r => some r
      | none => match obs[tn]!.prevGpsFix with
        | some f => some (f.lat, f.lon)
        | none => obs[tn]!.nextGpsFix.map (fun f => (f.lat, f.lon))

/-- Lines with an edge within `STATION_LINE_RADIUS_M` of a node. -/
def stationLineMemberships (g : StationGraph) (lat lon : Float) : List String :=
  (edgesNearIdx g.model lat lon STATION_LINE_RADIUS_M).foldl (fun acc i =>
    g.model.edges[i]!.lineMemberships.foldl appendDistinct acc) []

/-- Station nodes within `radiusM` of `(lat, lon)` (only nodes with a station
    name), paired with their distance. -/
def stationsNear (g : StationGraph) (lat lon radiusM : Float) : List (StationNode × Float) :=
  g.nodeById.fold (fun acc _ node =>
    match node.stationName with
    | none => acc
    | some _ =>
      let d := haversineMeters lat lon node.lat node.lon
      if decide (d ≤ radiusM) then acc ++ [(node, d)] else acc) []

/-- Every node id within `STATION_FOOTPRINT_M` of a station (incl. its own),
    for starting/ending the connectivity BFS. -/
def stationFootprintNodes (g : StationGraph) (station : StationNode) : List String :=
  (edgesNearIdx g.model station.lat station.lon STATION_FOOTPRINT_M).foldl (fun acc i =>
    let e := g.model.edges[i]!
    let acc := match e.geometry.head? with
      | some p => if decide (haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M)
                  then appendDistinct acc e.startNode else acc
      | none => acc
    match e.geometry.getLast? with
    | some p => if decide (haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M)
                then appendDistinct acc e.endNode else acc
    | none => acc) [station.id]

/-- BFS on `line`'s node subgraph: any path from a `start` node to a `goal` node. -/
partial def bfsNodes (g : StationGraph) (line : String) (goal : Std.HashSet String) :
    List String → Std.HashSet String → Bool
  | [], _ => false
  | nodeId :: rest, visited =>
    if visited.size ≥ MAX_EXPAND then false
    else match g.nodeById.get? nodeId with
      | none => bfsNodes g line goal rest visited
      | some node =>
        let step := node.edgeIds.foldl (fun (acc : Bool × List String × Std.HashSet String) eid =>
          if acc.1 then acc
          else match g.edgeById.get? eid with
            | none => acc
            | some e =>
              if !e.lineMemberships.contains line then acc
              else [e.startNode, e.endNode].foldl (fun (a : Bool × List String × Std.HashSet String) nid =>
                if a.1 then a
                else if a.2.2.contains nid then a
                else if goal.contains nid then (true, a.2.1, a.2.2)
                else (false, a.2.1 ++ [nid], a.2.2.insert nid)) acc) (false, [], visited)
        if step.1 then true else bfsNodes g line goal (rest ++ step.2.1) step.2.2

def nodesConnectedOnLine (g : StationGraph) (line : String) (startIds goalIds : List String) : Bool :=
  if startIds.isEmpty || goalIds.isEmpty then false
  else
    let goal : Std.HashSet String := goalIds.foldl (·.insert ·) {}
    if startIds.any (goal.contains ·) then true
    else bfsNodes g line goal startIds (startIds.foldl (·.insert ·) {})

/-- Enumerate valid `(board, line, alight)` train candidates over the windows. -/
def enumerateTrainCandidates (g : StationGraph) (obs : Array ObsRow) (knownLines : List String) :
    List Candidate := Id.run do
  let mut out : List Candidate := []
  for window in findTrainWindows obs do
    let (s, e) := window
    let startCtx := (gpsContextAt obs ((s : Int) - 1)).orElse (fun _ => gpsContextAt obs (s : Int))
    let endCtx := (gpsContextAt obs ((e : Int) + 1)).orElse (fun _ => gpsContextAt obs (e : Int))
    match startCtx, endCtx with
    | some (slat, slon), some (elat, elon) =>
      let boardCands := stationsNear g slat slon R_STATION_M
      let alightCands := stationsNear g elat elon R_STATION_M
      if boardCands.isEmpty || alightCands.isEmpty then pure ()
      else for line in knownLines do
        let boards := boardCands.filter (fun c => (stationLineMemberships g c.1.lat c.1.lon).contains line)
        let alights := alightCands.filter (fun c => (stationLineMemberships g c.1.lat c.1.lon).contains line)
        for b in boards do
          let boardFootprint := stationFootprintNodes g b.1
          for a in alights do
            if b.1.id == a.1.id then pure ()
            else if nodesConnectedOnLine g line boardFootprint (stationFootprintNodes g a.1) then
              out := out ++ [(⟨s, e, line, b.1.id, a.1.id, b.1.stationName, a.1.stationName⟩ : Candidate)]
    | _, _ => pure ()
  return out

/-- Coverage map `ts → lines vouched there` (port of `buildTrainEntryFromCandidates`'s
    coverage). Feeds `isCovered`/`linesAt`, i.e. the `covered`/`lineValid` facts the
    train-entry prior and per-minute route factors consume. -/
def buildCoverage (candidates : List Candidate) (obs : Array ObsRow) : Std.HashMap Int (List String) := Id.run do
  let mut cov : Std.HashMap Int (List String) := {}
  for c in candidates do
    for m in [c.startMin:c.endMin + 1] do
      if m < obs.size then
        let ts := obs[m]!.ts
        cov := cov.insert ts (appendDistinct (cov.getD ts []) c.line)
  return cov

/-- The train generator vouches a ride at `ts`. -/
def isCovered (cov : Std.HashMap Int (List String)) (ts : Int) : Bool := cov.contains ts
/-- Lines the generator vouches at `ts`. -/
def linesAt (cov : Std.HashMap Int (List String)) (ts : Int) : List String := cov.getD ts []

-- Parity with the real `enumerateTrainCandidates` (Node/V8): Alpha—Beta on Test Line.
private def mkMap {α : Type} (ps : List (String × α)) : Std.HashMap String α :=
  ps.foldl (fun m (k, v) => m.insert k v) {}
private def way1 : RouteEdge := ⟨"way:1", [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩], ["Test Line"], true, "nA", "nM"⟩
private def way2 : RouteEdge := ⟨"way:2", [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩], ["Test Line"], true, "nM", "nB"⟩
private def sg : StationGraph := {
  model := RouteModel.buildRouteGraphModel #[way1, way2],
  nodeById := mkMap [("nA", ⟨"nA", 51.50, -0.10, some "Alpha", ["way:1"]⟩),
                     ("nM", ⟨"nM", 51.525, -0.075, none, ["way:1", "way:2"]⟩),
                     ("nB", ⟨"nB", 51.55, -0.05, some "Beta", ["way:2"]⟩)],
  edgeById := mkMap [("way:1", way1), ("way:2", way2)] }

private def mk (i : Nat) (lat lon : Float) (spd : Option Float) : ObsRow :=
  { ts := 1000 + (i : Int) * 60, gps := spd.map (fun s => ⟨lat, lon, s⟩), hr := none, cadence := none,
    hourLocal := 0, dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none,
    reacquireAgeMin := none, prevGpsFix := none, nextGpsFix := none }
private def obs : Array ObsRow := #[
  mk 0 51.50 (-0.10) (some 2), mk 1 0 0 none, mk 2 0 0 none, mk 3 0 0 none, mk 4 0 0 none,
  mk 5 51.55 (-0.05) (some 2), mk 6 51.55 (-0.05) (some 3)]

#guard (enumerateTrainCandidates sg obs ["Test Line"]).map
  (fun c => (c.startMin, c.endMin, c.line, c.boardStationName, c.alightStationName))
  == [(0, 5, "Test Line", some "Alpha", some "Beta")]

-- Coverage: minutes 0–5 (ts 1000..1300) vouch "Test Line"; minute 6 (ts 1360) is uncovered.
private def cov : Std.HashMap Int (List String) := buildCoverage (enumerateTrainCandidates sg obs ["Test Line"]) obs
#guard isCovered cov 1000 == true
#guard isCovered cov 1300 == true
#guard isCovered cov 1360 == false
#guard linesAt cov 1000 == ["Test Line"]

end Verified.Hsmm.TrainCandidates
