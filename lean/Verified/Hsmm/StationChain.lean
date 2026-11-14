import Verified.Hsmm.RouteModel
import Verified.Hsmm.RouteGraph
import Verified.Hsmm.Observation
import Verified.Hsmm.ServedStations
import Verified.Geo.WalkableRoute
import Verified.Hsmm.Journey
/-!
# Chained train triples: the graph layer

`resolveStationChain` gives each named-line train leg a (board, alight) station
pair, scored jointly along the journey chain, on the served decode path. This
file is the graph half (candidates and along-line distances); the scoring
terms, the pair Viterbi and the emission gates follow.

Node order is load-bearing: `sideCandidates` dedupes by name keeping the first
best, sorts stably and cuts at `MAX_CANDIDATES_PER_SIDE`, so ties are decided by
insertion order. Hence `ChainGraph.nodes` is an ordered array, and
`TrainCandidates.stationsNear` (hash order) is not reused.

`nodeKey`'s `toFixed` rounding stays in the shell: a node's coordinates are its
rounded key parsed back (~0.3 m), while edge geometry keeps full precision.

UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.StationChain

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.RouteGraph (LatLon geometryLengthM)
open Verified.Hsmm.RouteModel (RouteGraphModel RouteEdge buildRouteGraphModel edgesNearIdx)
open Verified.Hsmm.Observation (ObsRow)
open Verified.Hsmm.ServedStations (RailStopRelation servedStationSet stationNameServed)

/-- Station-footprint radius (m). -/
def STATION_FOOTPRINT_M : Float := 200
/-- Lines are read from edges within this radius of a station node. -/
def STATION_LINE_RADIUS_M : Float := 250

/-- A station-annotated graph node. `lat`/`lon` are the `nodeKey` string parsed
    back to numbers, as `RouteGraph.buildWireGraph` builds them. -/
structure ChainNode where
  id : String
  lat : Float
  lon : Float
  stationName : Option String
  edgeIds : List String
  deriving Inhabited, Repr

/-- The resolver's view of the route graph. `nodes` is ordered — see the module
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
    g.model.edges[i].lineMemberships.foldl (fun acc l =>
      if acc.contains l then acc else acc ++ [l]) acc) []

/-- Station nodes within `radiusM`, paired with their distance, in graph order.
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
      let e := g.model.edges[i]
      let acc := match e.geometry.head? with
        | some p => if haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M
                    then acc.insert e.startNode else acc
        | none => acc
      match e.geometry.getLast? with
      | some p => if haversineMeters station.lat station.lon p.lat p.lon ≤ STATION_FOOTPRINT_M
                  then acc.insert e.endNode else acc
      | none => acc) (Std.HashSet.emptyWithCapacity.insert station.id)

/-- Dijkstra state with insertion order: `order` is what the min-extraction
    scan reads, and it decides ties. Updating an existing key must not move
    it. -/
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
      -- The node is already marked done: the loop goes round again rather than
      -- stopping.
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

/-- Dijkstra over `line`'s own edges from seeded nodes; distances for every node
    reached. The fuel cannot run out (each round settles one node); it is the
    decreasing measure Lean needs. Returns pairs in insertion order, because
    `trajectoryAdmits` iterates them into the candidate list. -/
def lineSssp (g : ChainGraph) (line : String) (seeds : Array (String × Float)) :
    Array (String × Float) :=
  let st0 : Sssp := seeds.foldl (fun st (id, d) => relax st id d)
    { order := #[], dist := {}, done := {} }
  let st := ssspLoop g line (g.nodes.size + seeds.size + 1) st0
  st.order.filterMap (fun id => (st.dist.get? id).map (fun d => (id, d)))

/-- The same distances as a lookup table, for the callers that only probe. -/
def ssspMap (rows : Array (String × Float)) : Std.HashMap String Float :=
  rows.foldl (fun m (id, d) => m.insert id d) {}

/-- Shortest along-line path (m) between two stations' footprints, or `none`
    when unreachable. Doubles as the pair-connectivity constraint. -/
def linePathMeters (g : ChainGraph) (line : String) (a b : ChainNode) : Option Float :=
  let start := stationFootprintNodes g a
  let goal := stationFootprintNodes g b
  if start.isEmpty || goal.isEmpty then none
  else if start.any (goal.contains ·) then some 0
  else
    let dist := ssspMap (lineSssp g line (start.toArray.map (fun id => (id, (0 : Float)))))
    goal.fold (fun acc id =>
      match dist.get? id with
      | none => acc
      | some d => match acc with
        | none => some d
        | some bd => if d < bd then some d else acc) none

/-! ## Scoring terms

All in nats and clamped: evidence, never a veto. Each is private, so the guards
drive the whole resolver with cases shaped so one term decides. -/

def STATION_SIGMA_M : Float := 200
def SLOP_SPEED_M_PER_MIN : Float := 500
def CAND_BASE_RADIUS_M : Float := 800
def MAX_CANDIDATES_PER_SIDE : Nat := 12
def TUBE_SPEED_KMH : Float := 42.3
def STOP_OVERHEAD_MIN : Float := 0.94
def SAME_STATION_M : Float := 250
def TRANSFER_WALK_M_PER_MIN : Float := 75
def TRANSFER_Z_SCALE : Float := 40
def CHAIN_GAP_MAX_S : Int := 12 * 60
def STATION_PASS_M : Float := 300
def TERMINAL_DWELL_TOL_MIN : Float := 3
def TERMINAL_DWELL_Z_MIN : Float := 1
def MIN_PATH_M : Float := 400
def ANCHOR_CLAMP : Float := -6
def DURATION_CLAMP : Float := -6
def DWELL_CLAMP : Float := -6
def CHAIN_CLAMP : Float := -8
def MARGIN_NATS : Float := 1.0
def BOUNDARY_UNOBSERVED_MIN : Float := 5
def ABS_ANCHOR_FLOOR : Float := -4
def TRAJ_OFFLINE_MAX_M : Float := 400
def TRAJ_MIN_FIXES : Nat := 4
def TRAJ_MIN_SPAN_MIN : Float := 5
def TRAJ_MAX_EXTRAP_MIN : Float := 4
def TRAJ_SIGMA_BASE_M : Float := 500
def TRAJ_MAD_SCALE : Float := 2.5
def TRAJ_CLAMP : Float := -6
def TRAJ_SUPPORT_FLOOR : Float := -1.5
def TRAJ_ADMIT_WINDOW_MIN : Float := 6
def TRAJ_ADMIT_SPEED_M_PER_MIN : Float := 1000
def DWELL_DISQUALIFY : Float := -3
def NOT_SERVED_PENALTY : Float := -3
/-- The ride-time model when the relations know the calls between the pair:
    `pathKm / RIDE_RUN_KMH` hours of running, `RIDE_STOP_MIN` per intermediate
    call, `RIDE_FIXED_MIN` once; otherwise `TUBE_SPEED_KMH` flat plus
    `STOP_OVERHEAD_MIN`. Least-squares fits to the corpus's decoded rides on
    this module's along-track path (`lean/experiments/ride-time-fit.py`). A fit
    to the narratives' windows ran 2.5 minutes short, since those held the wait.
    The width is `Journey.RIDE_SIGMA_MIN`. -/
def RIDE_RUN_KMH : Float := 47.7
/-- The pass term. A minute averaging `PASS_MIN_KMH` or more cannot contain a
    call (braking, the shortest dwell and pulling away hold a minute under
    35 km/h), so a station inside the stretch it covered (median fix ± half a
    minute's travel, times `PASS_SPAN_FRAC`) was passed. The minute must sit in a
    sustained run: a single fast minute between slow ones is a tunnel reacquire.
    Each passed call of the candidate line costs `PASS_PENALTY`, clamped at
    `PASS_CLAMP`; it tells the Metropolitan from the Jubilee where timing cannot. -/
def PASS_MIN_KMH : Float := 50
/-- km/h per metre made good over the two minutes either side of a minute. -/
def PASS_ACROSS_KMH_PER_M : Float := 3.6 / 120
def PASS_SPAN_FRAC : Float := 0.6
def PASS_PENALTY : Float := -2
def PASS_CLAMP : Float := -6
def RIDE_STOP_MIN : Float := 0.6
def RIDE_FIXED_MIN : Float := 0.74
/-- Shortest leg (minutes) the chain may re-line: below two `RIDE_SIGMA_MIN`
    plus a stop, the duration term fits a short hop on any line through the
    station. -/
def RELINE_MIN_MINUTES : Float := 2 * Journey.RIDE_SIGMA_MIN + 1

inductive Side where
  | board
  | alight
  deriving BEq, Inhabited

/-- Seconds to minutes, on `Int` timestamps. -/
private def mins (a b : Int) : Float := Float.ofInt (a - b) / 60

/-- `−z²/2` with σ widened in quadrature by anchor staleness, clamped. `pace`
    is the anchor's (`Anchor.pace`); the default is the unpaced slop. -/
def slopZPenalty (distM sigmaM slopMin clamp : Float) (pace : Float := SLOP_SPEED_M_PER_MIN) : Float :=
  let slop := pace * slopMin
  let sigma := Float.sqrt (sigmaM * sigmaM + slop * slop)
  let z := distM / sigma
  max clamp (-0.5 * z * z)

structure Fit where
  v : Float
  c : Float
  madM : Float
  deriving Inhabited

/-- Theil–Sen: the median of pairwise slopes, so a minority of corrupted fixes
    cannot steer it. `Observation.median`'s 0 on an empty list is unreachable:
    `c` and `madM` are only reached with `TRAJ_MIN_FIXES` points. -/
def theilSen (pts : Array (Float × Float)) : Fit :=
  let slopes := (List.finRange pts.size).foldl (fun acc (i : Fin pts.size) =>
    (List.finRange pts.size).foldl (fun acc (j : Fin pts.size) =>
      if j.val > i.val && pts[j].1 != pts[i].1
      then acc ++ [(pts[j].2 - pts[i].2) / (pts[j].1 - pts[i].1)]
      else acc) acc) []
  let v := if slopes.isEmpty then 0 else Verified.Hsmm.Observation.median slopes
  let c := Verified.Hsmm.Observation.median (pts.toList.map (fun p => p.2 - v * p.1))
  let madM := Verified.Hsmm.Observation.median
    (pts.toList.map (fun p => Float.abs (p.2 - (v * p.1 + c))))
  { v, c, madM }

/-- Observed leg minutes against the along-line path the pair implies. With a
    boundary lost in a blackout the ride may extend past the window, so only a
    pair expecting a shorter ride contradicts. -/
def durationPenalty (observedMin pathM : Float) (boundaryUnobserved : Bool)
    (stops : Option Nat := none) : Float :=
  let expectedMin := match stops with
    | some k => (pathM / 1000 / RIDE_RUN_KMH) * 60 + RIDE_STOP_MIN * k.toFloat + RIDE_FIXED_MIN
    | none => (pathM / 1000 / TUBE_SPEED_KMH) * 60 + STOP_OVERHEAD_MIN
  let sigma := Journey.RIDE_SIGMA_MIN
  if boundaryUnobserved && expectedMin ≥ observedMin then 0
  else
    let z := (observedMin - expectedMin) / sigma
    max DURATION_CLAMP (-0.5 * z * z)

structure InLegFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited

/-- The pass term over a pair's intermediate calls; see `PASS_MIN_KMH`. The
    speed is the displacement from the minute before to the minute after, not
    the smoother's: a stopped phone sends no fix for most of a minute and the
    Kalman speed carries line speed across the dwell. `moving` is the leg's
    minutes, `(lat, lon, mean km/h)` or `none`; a call without coordinates
    asserts nothing. -/
def passPenalty (moving : Array (Option (Float × Float × Float)))
    (calls : Array Verified.Hsmm.ServedStations.RailStop) : Float :=
  -- km/h made good from minute `k - 1` to minute `k + 1`, when both are fixed.
  let across : Nat → Option Float := fun k =>
    if k == 0 then none else
    match moving[k - 1]?.getD none, moving[k + 1]?.getD none with
    | some (la, lo, _), some (lb, lob, _) => some (haversineMeters la lo lb lob * PASS_ACROSS_KMH_PER_M)
    | _, _ => none
  let passed := calls.foldl (fun n st =>
    match st.lat, st.lon with
    | some la, some lo =>
      if (List.range moving.size).any (fun k =>
          match moving[k]?.getD none, across k with
          | some (mlat, mlon, _), some v =>
            v ≥ PASS_MIN_KMH && haversineMeters mlat mlon la lo ≤ PASS_SPAN_FRAC * (v / 3.6) * 30
          | _, _ => false) then n + 1 else n
    | _, _ => n) 0
  max PASS_CLAMP (PASS_PENALTY * passed.toFloat)

-- A station the line calls at, passed at 60 km/h (a kilometre a minute, 0.009°
-- of latitude) inside a three-minute run; the same minute alone (a
-- reacquisition jump); a stop without coordinates.
private def stopAt (lat lon : Float) : Verified.Hsmm.ServedStations.RailStop :=
  { name := some "S", lat := some lat, lon := some lon }
private def run3 : Array (Option (Float × Float × Float)) :=
  #[some (51.496, -0.10, 60), some (51.505, -0.10, 60), some (51.514, -0.10, 60)]
#guard passPenalty run3 #[stopAt 51.5051 (-0.10)] == PASS_PENALTY
#guard passPenalty #[none, some (51.505, -0.10, 60), none] #[stopAt 51.5051 (-0.10)] == 0
#guard passPenalty run3 #[{ name := some "S" }] == 0
-- Slow minutes: a call, not a pass.
#guard passPenalty #[some (51.502, -0.10, 20), some (51.505, -0.10, 20), some (51.508, -0.10, 20)]
  #[stopAt 51.5051 (-0.10)] == 0
-- The smoother says 60 throughout, but the minutes either side are 670 m
-- apart: the train stopped in between (07-16, Kilburn). A call, not a pass.
#guard passPenalty #[some (51.502, -0.10, 60), some (51.505, -0.10, 60), some (51.508, -0.10, 60)]
  #[stopAt 51.5051 (-0.10)] == 0
-- Four passes clamp.
#guard passPenalty run3 #[stopAt 51.5051 (-0.10), stopAt 51.5050 (-0.10),
  stopAt 51.5052 (-0.10), stopAt 51.5049 (-0.10)] == PASS_CLAMP

private def dwellZ (excessMin : Float) : Float :=
  if excessMin ≤ 0 then 0
  else
    let z := excessMin / TERMINAL_DWELL_Z_MIN
    max DWELL_CLAMP (-0.5 * z * z)

/-- An in-leg fix near the alight station minutes before the leg ends means
    the train dwelt at a through station, which services do not; likewise for
    boards. A leg dark near the candidate asserts nothing. -/
def terminalDwellPenalty (fixes : Array InLegFix) (station : ChainNode)
    (legStartTs legEndTs : Int) (side : Side) : Float :=
  let near := fixes.filter (fun f =>
    haversineMeters f.lat f.lon station.lat station.lon ≤ STATION_PASS_M)
  match side with
  | .alight => match near[0]? with
    | none => 0
    | some f => dwellZ (mins legEndTs f.ts - TERMINAL_DWELL_TOL_MIN)
  | .board => match near.back? with
    | none => 0
    | some f => dwellZ (mins f.ts legStartTs - TERMINAL_DWELL_TOL_MIN)

/-- Handover between consecutive legs: the same station complex (by name or by
    proximity) is free, anything else must be walkable in the observed gap. -/
def chainPenalty (prevAlight board : ChainNode) (gapMin : Float) : Float :=
  if prevAlight.stationName == board.stationName then 0
  else
    let d := haversineMeters prevAlight.lat prevAlight.lon board.lat board.lon
    if d ≤ SAME_STATION_M then 0
    else
      let requiredPace := d / max gapMin 0.5
      let z := max 0 (requiredPace - TRANSFER_WALK_M_PER_MIN) / TRANSFER_Z_SCALE
      max CHAIN_CLAMP (-0.5 * z * z)

/-! ## Anchors: the observed fix each side of the leg is measured against -/

/-- The resolver's view of a decoded segment. -/
structure ChainSeg where
  mode : String
  lineName : Option String
  startTs : Int
  endTs : Int
  /-- The journey's own pair for a ride boarded at a station: its leg's board
      station and the alight its fixes resolved. The chain refines a pair the
      decoder priced; it does not re-line it. -/
  journeyBoard : Option String := none
  journeyAlight : Option String := none
  deriving Inhabited, Repr

/-- Where a side's candidates are measured from, and how stale that measurement
    is. `slopMin` widens both the admission radius and the penalty's sigma, so a
    boundary the phone never observed cannot masquerade as a precise one. -/
structure Anchor where
  lat : Float
  lon : Float
  /-- Minutes between the fix and the leg boundary it anchors. -/
  slopMin : Float
  /-- How far a minute of slop carries (m/min): `SLOP_SPEED_M_PER_MIN`, a
      walker's pace when the slop lies inside an adjacent walking segment, and
      nothing inside an adjacent stationary one (the platform wait, where the
      station's own sigma is the spread). -/
  pace : Float := SLOP_SPEED_M_PER_MIN
  deriving Inhabited, Repr

/-- The anchor's slop at walking pace inside an adjacent walking segment
    containing its fix, at no pace inside an adjacent stationary one, else
    unchanged. -/
def Anchor.pacedBy (a : Anchor) (fixTs : Int) (walk : Option ChainSeg) : Anchor :=
  match walk with
  | some w =>
    if !(w.startTs ≤ fixTs && fixTs ≤ w.endTs) then a
    else if w.mode == "walking" then { a with pace := TRANSFER_WALK_M_PER_MIN }
    else if w.mode == "stationary" then { a with pace := 0 }
    else a
  | none => a

private def pacedAnchor : Anchor := ⟨51.525, -0.136, 1, SLOP_SPEED_M_PER_MIN⟩
private def pacedSeg (mode : String) : ChainSeg := { mode, lineName := none, startTs := 100, endTs := 200 }
-- A walk beside the fix paces the slop at a walker's pace, a wait at nothing;
-- a ride, or a segment the fix lies outside, leaves it unpaced.
#guard (pacedAnchor.pacedBy 150 (some (pacedSeg "walking"))).pace == TRANSFER_WALK_M_PER_MIN
#guard (pacedAnchor.pacedBy 150 (some (pacedSeg "stationary"))).pace == 0
#guard (pacedAnchor.pacedBy 150 (some (pacedSeg "train"))).pace == SLOP_SPEED_M_PER_MIN
#guard (pacedAnchor.pacedBy 250 (some (pacedSeg "stationary"))).pace == SLOP_SPEED_M_PER_MIN
#guard (pacedAnchor.pacedBy 150 none).pace == SLOP_SPEED_M_PER_MIN

/-- Last observed fix strictly before the leg (board side): the latest minute
    with its own `gps`, else `prevGpsFix` off the leg's first row (`firstIdx`,
    not `firstIdx - 1`), so a leg whose prior minutes are all dark still
    anchors on the bookend. -/
def boardAnchorAt (obs : Array ObsRow) (firstIdx : Nat) (legStartTs : Int) : Option (Anchor × Int) :=
  let rec scan (i : Nat) : Option (Anchor × Int) :=
    match i with
    | 0 => none
    | j + 1 =>
      match obs[j]? with
      | none => none
      | some o => match o.gps with
        | some g => some (⟨g.lat, g.lon, max 0 (mins legStartTs o.ts), SLOP_SPEED_M_PER_MIN⟩, o.ts)
        | none => scan j
  match scan firstIdx with
  | some a => some a
  | none => match (obs[firstIdx]?).bind (·.prevGpsFix) with
    | none => none
    | some b => some (⟨b.lat, b.lon, max 0 (mins legStartTs b.ts), SLOP_SPEED_M_PER_MIN⟩, b.ts)

/-- First observed fix at/after the leg end (alight side) — `boardAnchorAt`
    mirrored, with `nextGpsFix` off the leg's LAST row as the bookend. -/
def alightAnchorAt (obs : Array ObsRow) (lastIdx : Nat) (legEndTs : Int) : Option (Anchor × Int) :=
  let rec scan (i : Nat) (fuel : Nat) : Option (Anchor × Int) :=
    match fuel with
    | 0 => none
    | f + 1 =>
      match obs[i]? with
      | none => none
      | some o => match o.gps with
        | some g => some (⟨g.lat, g.lon, max 0 (mins o.ts legEndTs), SLOP_SPEED_M_PER_MIN⟩, o.ts)
        | none => scan (i + 1) f
  match scan (lastIdx + 1) obs.size with
  | some a => some a
  | none => match (obs[lastIdx]?).bind (·.nextGpsFix) with
    | none => none
    | some b => some (⟨b.lat, b.lon, max 0 (mins b.ts legEndTs), SLOP_SPEED_M_PER_MIN⟩, b.ts)

/-! ## Side candidates: which stations one end of a leg may be -/

structure SideCandidate where
  node : ChainNode
  anchorPenalty : Float
  /-- The node sits on one of the line's own edges, so its footprint seeds
      itself and an along-line path exists. See `admitCand`. -/
  onLine : Bool := false
  deriving Inhabited, Repr

/-- Does one of the node's own edges carry the line? -/
def nodeOnLine (g : ChainGraph) (line : String) (n : ChainNode) : Bool :=
  n.edgeIds.any fun eid => match g.edgeById.get? eid with
    | some e => e.lineMemberships.contains line
    | none => false

/-- Does the line's track reach the station's footprint: an edge carrying the
    line ending within `STATION_FOOTPRINT_M`, as the along-line search seeds?
    A complex's nodes can sit on other lines' edges while this line's track
    runs through it, so `nodeOnLine` is not enough. -/
def stationOnLine (g : ChainGraph) (line : String) (n : ChainNode) : Bool :=
  nodeOnLine g line n
    || (edgesNearIdx g.model n.lat n.lon STATION_FOOTPRINT_M).any fun i =>
      let e := g.model.edges[i]
      let near (p? : Option _) := p?.any fun p => haversineMeters n.lat n.lon p.lat p.lon ≤ STATION_FOOTPRINT_M
      e.lineMemberships.contains line && (near e.geometry.head? || near e.geometry.getLast?)

/-- A name→candidate map that remembers insertion order. Updating an existing
    name must not move it, which is what `{ st with best := … }` does here. -/
private structure ByName where
  order : Array String
  best : Std.HashMap String SideCandidate

private def byNameEmpty : ByName := ⟨#[], {}⟩

private def byNameOut (st : ByName) : Array SideCandidate :=
  st.order.filterMap (fun name => st.best.get? name)

/-- Keep the best node per station name: on the line first, then closest to
    the anchor (penalties are ≤ 0). The comparison is strict, so a tie keeps
    the first position.

    ⚠ On the line first: the node nearest the anchor can be the complex's own
    point with no edge, whose pair then fails for want of a path while a node
    of the same name on the line would have formed one. -/
private def admitCand (st : ByName) (node : ChainNode) (p : Float) (onLine : Bool := false) : ByName :=
  match node.stationName with
  | none => st
  | some name =>
    match st.best.get? name with
    | some prev =>
      let better := (onLine && !prev.onLine) || (onLine == prev.onLine && p > prev.anchorPenalty)
      if better then { st with best := st.best.insert name ⟨node, p, onLine⟩ } else st
    | none => { order := st.order.push name, best := st.best.insert name ⟨node, p, onLine⟩ }

/-- Stations on `line` admissible for one side, scored against the anchor and
    deduped by name, since one station is several OSM nodes. A missing anchor
    admits every station at 0. Trajectory-admitted stations (`extra`) join
    after the cap, so anchor-plausible ones cannot crowd them out. Three steps
    read order (dedupe, stable sort, cut); see the module docstring. -/
def sideCandidates (g : ChainGraph) (line : String) (anchor : Option Anchor)
    (extra : Array ChainNode) : Array SideCandidate :=
  let admitted := match anchor with
    | none =>
      g.nodes.foldl (fun st n =>
        match n.stationName with
        | none => st
        | some _ => if (stationLineMemberships g n).contains line then admitCand st n 0 (nodeOnLine g line n) else st)
        byNameEmpty
    | some a =>
      let radius := CAND_BASE_RADIUS_M + a.pace * a.slopMin
      (stationsNear g a.lat a.lon radius).foldl (fun st nd =>
        if (stationLineMemberships g nd.1).contains line then
          admitCand st nd.1 (slopZPenalty nd.2 STATION_SIGMA_M a.slopMin ANCHOR_CLAMP a.pace)
            (nodeOnLine g line nd.1)
        else st) byNameEmpty
  -- Descending by penalty, stably: `mergeSort` is left-biased on `≤`, so ties
  -- keep the graph order the dedupe left them in, the reason ties at the cut
  -- are decidable.
  let sorted := ((byNameOut admitted).toList.mergeSort
    (fun a b => b.anchorPenalty ≤ a.anchorPenalty)).toArray
  -- `stationName.getD ""` is unreachable: every candidate here came through
  -- `admitCand`, which drops the nameless.
  let capped := (sorted.extract 0 MAX_CANDIDATES_PER_SIDE).foldl (fun st c =>
    { order := st.order.push (c.node.stationName.getD ""),
      best := st.best.insert (c.node.stationName.getD "") c }) byNameEmpty
  byNameOut (extra.foldl (fun st n =>
    match n.stationName with
    | none => st
    | some name =>
      if st.best.contains name then st
      else
        let p := match anchor with
          | none => 0
          | some a =>
            slopZPenalty (haversineMeters a.lat a.lon n.lat n.lon) STATION_SIGMA_M a.slopMin ANCHOR_CLAMP a.pace
        { order := st.order.push name, best := st.best.insert name ⟨n, p, nodeOnLine g line n⟩ }) capped)

/-! ## Trajectory: the fixes' own vote, projected onto the line's track -/

structure TrackFix where
  ts : Int
  edge : RouteEdge
  alongM : Float
  deriving Inhabited

/-- Project each in-leg fix onto the nearest point of `line`'s track, dropping
    those beyond `TRAJ_OFFLINE_MAX_M`. Scans the line's edges directly, since
    `edgesNearIdx` indexes vertices and misses mid-span. The strict comparison
    keeps the first edge to reach a distance, so `g.model.edges` must be in
    builder order. -/
def projectFixesToLine (g : ChainGraph) (line : String) (fixes : Array InLegFix) :
    Array TrackFix :=
  let lineEdges := g.model.edges.filter (fun e => e.lineMemberships.contains line)
  -- One fix against one edge: walk the geometry, carrying `(best, bestDist)` in
  -- and out, and an `arc` that belongs to this edge alone.
  let scanEdge (f : InLegFix) (st : Option TrackFix × Float) (e : RouteEdge) :
      Option TrackFix × Float :=
    let geom := e.geometry.toArray
    -- Consecutive pairs by `zip`, so no index is read at all.
    let r := (geom.zip (geom.extract 1 geom.size)).foldl
      (fun (acc : Option TrackFix × Float × Float) (ab : _ × _) =>
        let a := ab.1
        let b := ab.2
        let segLen := haversineMeters a.lat a.lon b.lat b.lon
        let proj := Verified.Geo.WalkableRoute.projectPointToSegment
          ⟨f.lat, f.lon⟩ ⟨a.lat, a.lon⟩ ⟨b.lat, b.lon⟩
        let hit := if proj.distM < acc.2.1
          then (some { ts := f.ts, edge := e, alongM := acc.2.2 + proj.t * segLen }, proj.distM)
          else (acc.1, acc.2.1)
        (hit.1, hit.2, acc.2.2 + segLen))
      (st.1, st.2, 0)
    (r.1, r.2.1)
  fixes.foldl (fun out f =>
    match (lineEdges.foldl (scanEdge f) (none, TRAJ_OFFLINE_MAX_M)).1 with
    | none => out
    | some tf => out.push tf) #[]

/-- Along-line distance from a projected fix to the SSSP's seed station, entering
    the fix's edge at whichever endpoint is closer. -/
def trackFixDistM (sssp : Std.HashMap String Float) (tf : TrackFix) : Option Float :=
  let len := geometryLengthM tf.edge.geometry
  let viaU := (sssp.get? tf.edge.startNode).map (· + tf.alongM)
  let viaV := (sssp.get? tf.edge.endNode).map (fun d => d + max 0 (len - tf.alongM))
  match viaU, viaV with
  | none, _ => viaV
  | some u, none => some u
  | some u, some v => some (min u v)

/-- Fit the on-track fixes' along-line distances to a candidate over time, and
    score how far from it the fit lands at the leg boundary. `none` = the fixes
    cannot support a fit (too few, too clustered, boundary too dark), and the
    term then asserts nothing rather than asserting zero. -/
def trajectoryPenalty (trackFixes : Array TrackFix) (sssp : Std.HashMap String Float)
    (legStartTs legEndTs : Int) (side : Side) : Option Float :=
  let acc := trackFixes.foldl
    (fun (st : Array (Float × Float) × Option Int × Option Int) tf =>
      match trackFixDistM sssp tf with
      | none => st
      | some d =>
        (st.1.push (mins tf.ts legStartTs, d),
         some (match st.2.1 with | none => tf.ts | some x => min x tf.ts),
         some (match st.2.2 with | none => tf.ts | some x => max x tf.ts)))
    (#[], none, none)
  let pts := acc.1
  if pts.size < TRAJ_MIN_FIXES then none
  else match acc.2.1, acc.2.2 with
    | some firstTs, some lastTs =>
      if mins lastTs firstTs < TRAJ_MIN_SPAN_MIN then none
      else if side == Side.alight && mins legEndTs lastTs > TRAJ_MAX_EXTRAP_MIN then none
      else if side == Side.board && mins firstTs legStartTs > TRAJ_MAX_EXTRAP_MIN then none
      else
        let fit := theilSen pts
        let targetT := match side with
          | .alight => mins legEndTs legStartTs
          | .board => 0
        let predictedM := fit.v * targetT + fit.c
        let sigma := max TRAJ_SIGMA_BASE_M (TRAJ_MAD_SCALE * fit.madM)
        let z := Float.abs predictedM / sigma
        some (max TRAJ_CLAMP (-0.5 * z * z))
    -- Unreachable: `pts.size ≥ TRAJ_MIN_FIXES` means both were set. Kept total
    -- rather than `!`-indexed, so the impossible case cannot panic in prod.
    | _, _ => none

/-- Stations admissible for one side from the trajectory alone: reachable along
    the line from a near-boundary on-track fix within the remaining ride time.
    This admits the true station when the anchor fix is kilometres wrong. -/
def trajectoryAdmits (g : ChainGraph) (line : String) (trackFixes : Array TrackFix)
    (legStartTs legEndTs : Int) (side : Side) : Array ChainNode :=
  (trackFixes.foldl (fun (acc : Array ChainNode × Std.HashSet String) tf =>
    let boundaryMin := match side with
      | .alight => mins legEndTs tf.ts
      | .board => mins tf.ts legStartTs
    if boundaryMin < 0 || boundaryMin > TRAJ_ADMIT_WINDOW_MIN then acc
    else
      let len := geometryLengthM tf.edge.geometry
      let endSeed := max 0 (len - tf.alongM)
      -- `Map.set` semantics: the start seed goes in first, and the end seed
      -- replaces it only when lower and only when it is the same key.
      let seeds : Array (String × Float) :=
        if tf.edge.endNode == tf.edge.startNode then
          #[(tf.edge.startNode, min tf.alongM endSeed)]
        else #[(tf.edge.startNode, tf.alongM), (tf.edge.endNode, endSeed)]
      let reachM := boundaryMin * TRAJ_ADMIT_SPEED_M_PER_MIN + CAND_BASE_RADIUS_M
      (lineSssp g line seeds).foldl (fun acc (id, d) =>
        if d > reachM then acc
        else match g.nodeById.get? id with
          | none => acc
          | some node => match node.stationName with
            | none => acc
            | some name =>
              if !(stationLineMemberships g node).contains line then acc
              else if acc.2.contains name then acc
              else (acc.1.push node, acc.2.insert name)) acc)
    (#[], {})).1

/-! ## The resolver: pair Viterbi over the chain, then the emission gates -/

/-- One side of one candidate pair, with its four independent penalty channels
    kept SEPARATE — `legScore` sums them, but the emission gates read
    `anchorPen`, `trajPen` and `dwellPen` individually. -/
structure SideEval where
  node : ChainNode
  anchorPen : Float
  dwellPen : Float
  /-- `none` = the fixes cannot support a fit, which asserts nothing. Not the
      same as `some 0`, and the plausibility gate depends on the difference. -/
  trajPen : Option Float
  servedPen : Float
  /-- Where the ride starts (board) or ends (alight) for this station: the
      leg's boundary, or past a wait there (`waitBound`). -/
  effTs : Int := 0
  deriving Inhabited, Repr

structure PairCandidate where
  board : SideEval
  alight : SideEval
  legScore : Float
  /-- The line this pair rides. A leg carries pairs on its decoded line and,
      when the caller offers alternatives, on every other line that connects
      a board candidate to an alight candidate. -/
  line : String := ""
  /-- The duration and pass terms, kept apart for the debug arm (`legScore`
      already sums them). -/
  durPen : Float := 0
  passPen : Float := 0
  deriving Inhabited, Repr

/-- One side's admitted candidates for one line, for the chain debug: the
    station name, the node the per-name dedupe kept, and its anchor penalty.
    A candidate here that forms no pair was dropped by the pair filters
    (same name, no along-line path, or a path under `MIN_PATH_M`). -/
structure SideDebug where
  line : String
  side : String
  name : String
  nodeId : String
  anchorPen : Float
  deriving Inhabited, Repr

structure ChainLeg where
  segIndex : Nat
  startTs : Int
  endTs : Int
  pairs : Array PairCandidate
  /-- The line the decoder labelled this leg with. -/
  decodedLine : String := ""
  /-- Every admitted candidate per line and side (debug only; read by nothing
      that decides). -/
  sides : Array SideDebug := #[]
  /-- The journey's own pair (`ChainSeg`): the stations a side falls back to
      when the chain cannot separate or hold it. -/
  journeyBoard : Option String := none
  journeyAlight : Option String := none
  deriving Inhabited, Repr

structure ResolvedStations where
  board : Option String
  alight : Option String
  /-- `some l` when the chain re-lines the leg: the best pair on `l` beats the
      best on the decoded line by `MARGIN_NATS`. `none` keeps the decoded line. -/
  line : Option String := none
  /-- The ride's own start (end) when the chain found a wait at the board
      (alight) station (`waitBound`): the leg before it is the wait, a stay at
      the station. `none` when the ride fills its leg. -/
  boardTs : Option Int := none
  alightTs : Option Int := none
  deriving Inhabited, Repr, BEq

private def NEG_INF : Float := -1.0 / 0.0

/-- Along-line distances from a candidate's whole station footprint. The seeds
    are in hash order, which is safe: every seed starts at 0 and shortest
    distances are unique, and the result is only probed by key. -/
private def footprintSssp (g : ChainGraph) (line : String) (node : ChainNode) :
    Std.HashMap String Float :=
  ssspMap (lineSssp g line ((stationFootprintNodes g node).toList.map (fun id => (id, 0.0))).toArray)

/-- No served-station penalty. -/
private def SERVED_FREE : Float := 0

/-- A wait at `station` at the leg's edge: the in-leg fixes from the start
    (board) or to the end (alight) all within `STATION_PASS_M` of it. The ride
    leaves (reaches) the station at the run's last (first) fix, not at a leg
    boundary that may sit in the dark. Only distinct positions count, since a
    re-reported position is the last one held underground. -/
def waitBound (fixes : Array InLegFix) (station : ChainNode) (side : Side) : Option Int :=
  let isNear := fun (f : InLegFix) =>
    haversineMeters f.lat f.lon station.lat station.lon ≤ STATION_PASS_M
  -- The run in time order, then its fixes that moved from the one before.
  let run := match side with
    | .board => fixes.toList.takeWhile isNear
    | .alight => (fixes.toList.reverse.takeWhile isNear).reverse
  let distinct := (run.zip (none :: run.map some)).filterMap fun (f, prev) =>
    match prev with
    | some p => if p.lat == f.lat && p.lon == f.lon then none else some f
    | none => some f
  if distinct.length < 2 then none
  else match side with
    | .board => distinct.getLast?.map (·.ts)
    | .alight => distinct.head?.map (·.ts)

-- A station, and fixes 50 m off it (0.00045° of latitude) and a kilometre off.
private def waitStn : ChainNode := { id := "w", lat := 51.53, lon := -0.12, stationName := some "W", edgeIds := [] }
private def atW (t : Int) (dLat : Float) : InLegFix := ⟨t, 51.53045 + dLat, -0.12⟩
private def awayW (t : Int) : InLegFix := ⟨t, 51.54, -0.12⟩
-- Standing at the station, then the ride: it leaves at the last fix there.
#guard waitBound #[atW 100 0, atW 130 0.0001, awayW 200] waitStn .board == some 130
-- The mirror at the end.
#guard waitBound #[awayW 100, atW 160 0, atW 190 0.0001] waitStn .alight == some 160
-- One position re-reported (held underground) is no wait.
#guard waitBound #[atW 100 0, atW 130 0, atW 160 0, awayW 200] waitStn .board == none
-- The leg seen elsewhere first: no wait at its start.
#guard waitBound #[awayW 100, atW 130 0, atW 160 0.0001] waitStn .board == none

/-- Score one side of one leg. The four channels stay separate; see `SideEval`. -/
private def evalSide (g : ChainGraph) (line : String) (served : Option (Std.HashSet String))
    (inLegFixes : Array InLegFix) (trackFixes : Array TrackFix) (legStartTs legEndTs : Int)
    (c : SideCandidate) (side : Side) : SideEval :=
  -- Past a wait at the station, the ride's own start (end), and the track
  -- fixes without the wait's.
  let wait := waitBound inLegFixes c.node side
  let startTs := if side == .board then wait.getD legStartTs else legStartTs
  let endTs := if side == .alight then wait.getD legEndTs else legEndTs
  let ride := trackFixes.filter fun tf => decide (tf.ts ≥ startTs) && decide (tf.ts ≤ endTs)
  { node := c.node
    anchorPen := c.anchorPenalty
    dwellPen := terminalDwellPenalty inLegFixes c.node startTs endTs side
    effTs := if side == .board then startTs else endTs
    trajPen :=
      if ride.isEmpty then none
      else trajectoryPenalty ride (footprintSssp g line c.node) startTs endTs side
    -- Served by name (`stationNameServed`, which sees through the National
    -- Rail "London " prefix), not by proximity to a served node: proximity
    -- took the scoreboard's stations from 15 to 5.
    servedPen := match served, c.node.stationName with
      | some sv, some nm => if stationNameServed sv nm then SERVED_FREE else NOT_SERVED_PENALTY
      | _, _ => SERVED_FREE }

/-- Build one resolvable leg: its candidates on both sides, and the cross product
    of pairs that survive the same-station and minimum-path filters. -/
private def buildLegOn (g : ChainGraph) (obs : Array ObsRow) (served : Option (Std.HashSet String))
    (callsBetween : String → String → Option (Array Verified.Hsmm.ServedStations.RailStop))
    (segIndex : Nat) (seg : ChainSeg) (line : String) (firstIdx lastIdx : Nat)
    (prev next : Option ChainSeg := none) : ChainLeg :=
  let bAnchor := (boardAnchorAt obs firstIdx seg.startTs).map fun (a, ts) => a.pacedBy ts prev
  let aAnchor := (alightAnchorAt obs lastIdx seg.endTs).map fun (a, ts) => a.pacedBy ts next
  -- A boundary is observed when a fresh fix sits at it or the segment beside it
  -- carries evidence (a walk or a stay). Against a ride, unknown or nothing it
  -- is unobserved, which widens the duration term.
  let evidenced := fun (s : Option ChainSeg) => match s with
    | some s => s.mode == "walking" || s.mode == "stationary" || s.mode == "cycling"
    | none => false
  let sideObserved := fun (a : Option Anchor) (neighbour : Option ChainSeg) => match a with
    | some a => a.slopMin ≤ BOUNDARY_UNOBSERVED_MIN || evidenced neighbour
    | none => evidenced neighbour
  let boundaryUnobserved := !(sideObserved bAnchor prev && sideObserved aAnchor next)
  let inLegFixes : Array InLegFix :=
    (List.range (lastIdx + 1 - firstIdx)).foldl (fun acc k =>
      match obs[firstIdx + k]? with
      | none => acc
      | some o => match o.gps with
        | none => acc
        | some gp => acc.push ⟨o.ts, gp.lat, gp.lon⟩) #[]
  let trackFixes := projectFixesToLine g line inLegFixes
  let moving : Array (Option (Float × Float × Float)) :=
    (List.range (lastIdx + 1 - firstIdx)).foldl (fun acc k =>
      acc.push ((obs[firstIdx + k]?).bind fun o => o.gps.map fun gp => (gp.lat, gp.lon, gp.speedKmh))) #[]
  let boards := sideCandidates g line bAnchor
    (trajectoryAdmits g line trackFixes seg.startTs seg.endTs .board)
  let alights := sideCandidates g line aAnchor
    (trajectoryAdmits g line trackFixes seg.startTs seg.endTs .alight)
  let ev := evalSide g line served inLegFixes trackFixes seg.startTs seg.endTs
  let boardEvals := boards.map (fun c => ev c .board)
  let alightEvals := alights.map (fun c => ev c .alight)
  -- The cross product in board-major order, which is the order the argmax below
  -- breaks its ties in — the fourth consumer of candidate order in this module.
  let pairs := boardEvals.foldl (fun acc b =>
    alightEvals.foldl (fun acc a =>
      if b.node.stationName == a.node.stationName then acc
      else match linePathMeters g line b.node a.node with
        | none => acc
        | some pathM =>
          if pathM < MIN_PATH_M then acc
          else
            let calls := match b.node.stationName, a.node.stationName with
              | some bn, some an => callsBetween bn an
              | _, _ => none
            -- The ride between the two stations' own boundaries.
            let durPen := durationPenalty (mins a.effTs b.effTs) pathM boundaryUnobserved
              (calls.map (·.size))
            let passPen := (calls.map (passPenalty moving)).getD 0
            acc.push
            { board := b, alight := a, line, durPen, passPen
              legScore := b.anchorPen + b.dwellPen + (b.trajPen.getD 0) + b.servedPen
                + a.anchorPen + a.dwellPen + (a.trajPen.getD 0) + a.servedPen
                + durPen + passPen }) acc) #[]
  -- The journey's pair, where the chain's candidates hold it: the pairs naming
  -- its board and its alight, each side where the journey has one. Candidates
  -- holding neither leave the field as it was — a floor, not a veto.
  let keep := fun (p : PairCandidate) =>
    (match seg.journeyBoard with | some b => p.board.node.stationName == some b | none => true)
    && (match seg.journeyAlight with | some a => p.alight.node.stationName == some a | none => true)
  let pairs := if (seg.journeyBoard.isSome || seg.journeyAlight.isSome) && pairs.any keep
    then pairs.filter keep else pairs
  let sideDbg := fun (tag : String) (cs : Array SideCandidate) => cs.map fun c =>
    ({ line, side := tag, name := c.node.stationName.getD "", nodeId := c.node.id,
       anchorPen := c.anchorPenalty } : SideDebug)
  { segIndex, startTs := seg.startTs, endTs := seg.endTs, pairs, decodedLine := line,
    sides := sideDbg "board" boards ++ sideDbg "alight" alights,
    journeyBoard := seg.journeyBoard, journeyAlight := seg.journeyAlight }

/-- `buildLegOn` for the decoded line, then for each alternative in order — the
    decoded line's pairs FIRST, so the first-wins argmax keeps it on a tie. -/
private def buildLeg (g : ChainGraph) (obs : Array ObsRow)
    (servedFor : String → Option (Std.HashSet String))
    (stopsFor : String → String → String → Option (Array Verified.Hsmm.ServedStations.RailStop))
    (segIndex : Nat) (seg : ChainSeg)
    (line : String) (altLines : List String) (firstIdx lastIdx : Nat)
    (prev next : Option ChainSeg := none) : ChainLeg :=
  let own := buildLegOn g obs (servedFor line) (stopsFor line) segIndex seg line firstIdx lastIdx prev next
  -- A ride the journey paired keeps its line: the alternatives are not weighed.
  let altLines := if seg.journeyBoard.isSome || seg.journeyAlight.isSome then [] else altLines
  altLines.foldl (fun leg alt =>
    if alt == line then leg
    else
      let other := buildLegOn g obs (servedFor alt) (stopsFor alt) segIndex seg alt firstIdx lastIdx prev next
      { leg with pairs := leg.pairs ++ other.pairs, sides := leg.sides ++ other.sides }) own

/-- Forward Viterbi over pairs. `best = 0` at the chain head is not a neutral
    element standing in for an empty max: it is the initialisation, and it
    differs from `NEG_INF` exactly when a leg opens a chain. -/
private def forwardPass (chain : Array ChainLeg) : Array (Array Float) :=
  chain.foldl (fun acc leg =>
    let row := match acc.back?, chain[acc.size - 1]? with
      | some prevRow, some prevLeg =>
        let gapMin := mins leg.startTs prevLeg.endTs
        leg.pairs.map (fun p =>
          p.legScore + (List.range prevRow.size).foldl (fun b q =>
            -- The row and the pairs are one length by construction (`map`).
            match prevRow[q]?, prevLeg.pairs[q]? with
            | some r, some pp =>
              let via := r + chainPenalty pp.alight.node p.board.node gapMin
              if via > b then via else b
            | _, _ => b) NEG_INF)
      | _, _ => leg.pairs.map (fun p => p.legScore)
    acc.push row) #[]

/-- Backward Viterbi — `forwardPass` mirrored, built right to left then flipped
    so the result indexes the same way. -/
private def backwardPass (chain : Array ChainLeg) : Array (Array Float) :=
  let rev := (List.finRange chain.size).foldl (fun acc (k : Fin chain.size) =>
    let i := chain.size - 1 - k.val
    have hi : chain.size - 1 - k.val < chain.size := by omega
    let leg := chain[chain.size - 1 - k.val]
    let row := match acc.back?, chain[i + 1]? with
      | some nextRow, some nextLeg =>
        let gapMin := mins nextLeg.startTs leg.endTs
        leg.pairs.map (fun p =>
          p.legScore + (List.range nextRow.size).foldl (fun b q =>
            match nextRow[q]?, nextLeg.pairs[q]? with
            | some r, some np =>
              let via := r + chainPenalty p.alight.node np.board.node gapMin
              if via > b then via else b
            | _, _ => b) NEG_INF)
      | _, _ => leg.pairs.map (fun p => p.legScore)
    acc.push row) #[]
  rev.reverse

/-- A side emits only when every alternative station trails by `MARGIN_NATS`,
    some channel (anchor plausibility or strong trajectory support) supports
    the winner, and the winner is not terminal-dwell-disqualified. -/
private def sidePlausible (s : SideEval) : Bool :=
  (s.anchorPen > ABS_ANCHOR_FLOOR || (match s.trajPen with
    | some t => t > TRAJ_SUPPORT_FLOOR
    | none => false))
  && s.dwellPen > DWELL_DISQUALIFY

/-- Emit for one leg of a chain, given its max-marginals. -/
private def emitLegOn (leg : ChainLeg) (through : Array Float) : Option (Nat × ResolvedStations) :=
  match leg.pairs[0]? with
  | none => none
  | some p0 =>
    -- First-wins argmax (strict `>`), so the cross product's board-major order
    -- decides a tie.
    let bestP := (List.range through.size).foldl (fun b p =>
      match through[p]?, through[b]? with
      | some tp, some tb => if tp > tb then p else b
      | _, _ => b) 0
    let best := leg.pairs[bestP]?.getD p0
    -- `through` has one entry per pair by construction; a pair without one
    -- (unreachable) takes no part in the alternatives.
    let bestAlt := (List.finRange leg.pairs.size).foldl (fun (acc : Float × Float) (p : Fin leg.pairs.size) =>
      let pr := leg.pairs[p]
      match through[p.val]? with
      | none => acc
      | some t =>
      ( if pr.board.node.stationName != best.board.node.stationName && t > acc.1 then t else acc.1
      , if pr.alight.node.stationName != best.alight.node.stationName && t > acc.2 then t else acc.2 ))
      (NEG_INF, NEG_INF)
    let clears (alt : Float) := alt == NEG_INF ||
      (match through[bestP]? with | some tb => tb - alt ≥ MARGIN_NATS | none => false)
    let board := if clears bestAlt.1 && sidePlausible best.board then best.board.node.stationName else none
    let alight := if clears bestAlt.2 && sidePlausible best.alight then best.alight.node.stationName else none
    -- The journey's pair fills a side the chain cannot separate or hold; the
    -- chain's own reading stands where it has one.
    let board := match board, leg.journeyBoard with | none, some b => some b | b, _ => b
    let alight := match alight, leg.journeyAlight with | none, some a => some a | a, _ => a
    let boardTs := if board == best.board.node.stationName && best.board.effTs > leg.startTs then some best.board.effTs else none
    let alightTs := if alight == best.alight.node.stationName && best.alight.effTs < leg.endTs then some best.alight.effTs else none
    if board.isNone && alight.isNone then none
    else some (leg.segIndex, { board, alight, boardTs, alightTs })

/-- Emit for one leg: its line, then its stations on that line. The line is
    the best pair's when that pair beats every pair on the decoded line by
    `MARGIN_NATS`, the leg lasts `RELINE_MIN_MINUTES`, and a station resolves on
    the new line; otherwise the decoded line stands. -/
private def emitLeg (leg : ChainLeg) (through : Array Float) : Option (Nat × ResolvedStations) :=
  let idx := List.range leg.pairs.size
  let bestOf (keep : PairCandidate → Bool) : Option (Nat × Float) :=
    idx.foldl (fun acc p =>
      match leg.pairs[p]?, through[p]? with
      | some pr, some t => if !keep pr then acc else (match acc with
          | none => some (p, t)
          | some (_, tb) => if t > tb then some (p, t) else acc)
      | _, _ => acc) none
  let decodedBest := bestOf (·.line == leg.decodedLine)
  let longEnough := mins leg.endTs leg.startTs ≥ RELINE_MIN_MINUTES
  let candidate : String := if !longEnough then leg.decodedLine else
    match bestOf (fun _ => true), decodedBest with
    | some (p, t), some (_, td) =>
      let l := (leg.pairs[p]?.map (·.line)).getD leg.decodedLine
      if l != leg.decodedLine && t - td ≥ MARGIN_NATS then l else leg.decodedLine
    | some (p, _), none => (leg.pairs[p]?.map (·.line)).getD leg.decodedLine
    | none, _ => leg.decodedLine
  let on (l : String) : Option (Nat × ResolvedStations) :=
    let keepIdx := idx.filter (fun p => (leg.pairs[p]?.map (·.line)) == some l)
    emitLegOn { leg with pairs := (keepIdx.filterMap (leg.pairs[·]?)).toArray }
      (keepIdx.filterMap (through[·]?)).toArray
  if candidate == leg.decodedLine then on leg.decodedLine
  else match on candidate with
    | some (i, r) => some (i, { r with line := some candidate })
    | none => on leg.decodedLine

/-- The day's resolvable legs as chains: consecutive legs, broken by a leg with
    no valid pair or a gap past `CHAIN_GAP_MAX_S`. -/
private def chainsOf (g : ChainGraph) (segs : Array ChainSeg) (obs : Array ObsRow)
    (railStopRelations : Option (Array RailStopRelation))
    (altLines : List String := []) : Array (Array ChainLeg) :=
  if obs.isEmpty then #[] else
  -- Later duplicates win, as `Map.set` does.
  let idxByTs : Std.HashMap Int Nat :=
    (obs.foldl (fun (acc : Std.HashMap Int Nat × Nat) o => (acc.1.insert o.ts acc.2, acc.2 + 1)) ({}, 0)).1
  let servedFor := fun (line : String) =>
    match railStopRelations with
    | none => none
    | some rels => servedStationSet rels line
  let stopsFor := fun (line a b : String) =>
    match railStopRelations with
    | none => none
    | some rels => Verified.Hsmm.ServedStations.intermediateCalls rels line a b
  let legs : Array ChainLeg := (segs.foldl (fun (acc : Array ChainLeg × Nat) seg =>
    let i := acc.2
    let skip := (acc.1, i + 1)
    if seg.mode != "train" then skip
    else match seg.lineName with
      | none => skip
      | some line =>
        if Verified.Hsmm.Emissions.isPlaceholderLine line then skip
        else match idxByTs.get? seg.startTs, idxByTs.get? (seg.endTs - 60) with
          | some firstIdx, some lastIdx =>
            (acc.1.push (buildLeg g obs servedFor stopsFor i seg line altLines firstIdx lastIdx
              (if i == 0 then none else segs[i - 1]?) segs[i + 1]?), i + 1)
          | _, _ => skip) (#[], 0)).1
  -- A leg with no valid pair stays unresolved and breaks the chain: its
  -- neighbours must not hand over across an opaque ride.
  let st := legs.foldl (fun (st : Array (Array ChainLeg) × Array ChainLeg) leg =>
      let breaks := leg.pairs.isEmpty || (match st.2.back? with
        | none => false
        | some prev => leg.startTs - prev.endTs > CHAIN_GAP_MAX_S)
      let st := if breaks && !st.2.isEmpty then (st.1.push st.2, #[]) else st
      if leg.pairs.isEmpty then st else (st.1, st.2.push leg)) (#[], #[])
  if st.2.isEmpty then st.1 else st.1.push st.2

/-- Every resolvable leg with its max-marginals (the best chain total through
    each pair), in segment order: what `resolveStationChain` emits from and the
    debug arm prints. -/
def chainMarginals (g : ChainGraph) (segs : Array ChainSeg) (obs : Array ObsRow)
    (railStopRelations : Option (Array RailStopRelation))
    (altLines : List String := []) : Array (ChainLeg × Array Float) :=
  if obs.isEmpty then #[] else
  let chains := chainsOf g segs obs railStopRelations altLines
  chains.foldl (fun out chain =>
    let fwd := forwardPass chain
    let bwd := backwardPass chain
    (List.finRange chain.size).foldl (fun out (i : Fin chain.size) =>
      let leg := chain[i]
      -- Max-marginal: the best chain total through this pair, less `legScore`,
      -- which both passes count.
      let through := (List.finRange leg.pairs.size).foldl (fun acc (p : Fin leg.pairs.size) =>
        let f := (fwd[i.val]?.bind (·[p.val]?)).getD 0
        let b := (bwd[i.val]?.bind (·[p.val]?)).getD 0
        acc.push (f + b - leg.pairs[p].legScore)) #[]
      out.push (leg, through)) out) #[]

/-- `log Σ exp` over `xs`; `NEG_INF` when empty or all `NEG_INF`. -/
private def lse (xs : List Float) : Float :=
  let m := xs.foldl (fun a x => if x > a then x else a) NEG_INF
  if m == NEG_INF then NEG_INF
  else m + Float.log (xs.foldl (fun a x => a + Float.exp (x - m)) 0)

/-- `forwardPass` with log-sum-exp for max: per pair, the log of the summed
    weight of every chain prefix ending in it. -/
private def forwardSum (chain : Array ChainLeg) : Array (Array Float) :=
  chain.foldl (fun acc leg =>
    let row := match acc.back?, chain[acc.size - 1]? with
      | some prevRow, some prevLeg =>
        let gapMin := mins leg.startTs prevLeg.endTs
        leg.pairs.map (fun p =>
          p.legScore + lse ((List.range prevRow.size).filterMap fun q =>
            match prevRow[q]?, prevLeg.pairs[q]? with
            | some r, some pp => some (r + chainPenalty pp.alight.node p.board.node gapMin)
            | _, _ => none))
      | _, _ => leg.pairs.map (fun p => p.legScore)
    acc.push row) #[]

/-- `backwardPass` with log-sum-exp for max. -/
private def backwardSum (chain : Array ChainLeg) : Array (Array Float) :=
  let rev := (List.finRange chain.size).foldl (fun acc (k : Fin chain.size) =>
    let i := chain.size - 1 - k.val
    have hi : chain.size - 1 - k.val < chain.size := by omega
    let leg := chain[chain.size - 1 - k.val]
    let row := match acc.back?, chain[i + 1]? with
      | some nextRow, some nextLeg =>
        let gapMin := mins nextLeg.startTs leg.endTs
        leg.pairs.map (fun p =>
          p.legScore + lse ((List.range nextRow.size).filterMap fun q =>
            match nextRow[q]?, nextLeg.pairs[q]? with
            | some r, some np => some (r + chainPenalty p.alight.node np.board.node gapMin)
            | _, _ => none))
      | _, _ => leg.pairs.map (fun p => p.legScore)
    acc.push row) #[]
  rev.reverse

/-- Each leg's pairs with their posterior under the chain (scores as
    log-weights, summed over chains through the pair, normalised). An
    instrument: nothing emits from it yet. -/
def chainPosteriors (g : ChainGraph) (segs : Array ChainSeg) (obs : Array ObsRow)
    (railStopRelations : Option (Array RailStopRelation))
    (altLines : List String := []) : Array (ChainLeg × Array Float) :=
  if obs.isEmpty then #[] else
  let chains := chainsOf g segs obs railStopRelations altLines
  chains.foldl (fun out chain =>
    let fwd := forwardSum chain
    let bwd := backwardSum chain
    let logZ := lse ((fwd.back?.getD #[]).toList)
    (List.finRange chain.size).foldl (fun out (i : Fin chain.size) =>
      let leg := chain[i]
      let post := (List.finRange leg.pairs.size).foldl (fun acc (p : Fin leg.pairs.size) =>
        let f := (fwd[i.val]?.bind (·[p.val]?)).getD NEG_INF
        let b := (bwd[i.val]?.bind (·[p.val]?)).getD NEG_INF
        acc.push (Float.exp (f + b - leg.pairs[p].legScore - logZ))) #[]
      out.push (leg, post)) out) #[]

/--
Resolve stations for every named-line train leg in `segs`: segment index →
pair, in order. An unconfident side is `none`; a leg with neither is absent.

`altLines` are lines a leg may be re-lined to: the chain runs over pairs on
each, and the leg takes the best pair's line when it clears `MARGIN_NATS` over
its decoded line (`emitLeg`). The decoder picks a line minute by minute; this
weighs the ride's timing, anchors and transfer. Empty means the decoded line.
-/
def resolveStationChain (g : ChainGraph) (segs : Array ChainSeg) (obs : Array ObsRow)
    (railStopRelations : Option (Array RailStopRelation))
    (altLines : List String := []) : Array (Nat × ResolvedStations) :=
  (chainMarginals g segs obs railStopRelations altLines).foldl (fun out (leg, through) =>
    match emitLeg leg through with
    | none => out
    | some r => out.push r) #[]

/-! ## Guards: a synthetic line

Five stations west to east at lat 51.5, built through the real
`RouteGraph.buildWireGraph`. Node coordinates are the 5-decimal `nodeKey` parsed back
(`0.02165`); edge geometry is full precision (`0.021645543464882695`). -/

/-- Edge geometry longitudes — full precision, as the WKT carried them. -/
private def LONS : Array Float :=
  #[0, 0.021645543464882695, 0.04329108692976539, 0.06493663039464809, 0.08658217385953078]

/-- Node keys: the same coordinates at `nodeKey`'s five decimals. Kept as
    literals rather than derived, because deriving them would put `toFixed` in
    Lean, which is the boundary left shell-side. -/
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

/-- Reference values are ranges: pinning a Float to its printed decimals
    would pin the rendering. -/
private def within (x lo hi : Float) : Bool := x > lo && x < hi

private def edge0Len : Float := geometryLengthM testEdges[0]!.geometry

private def pathBetween (a b : String) : Option Float :=
  linePathMeters testGraph "Test Line" (station a) (station b)

-- The reference reports every edge at 1498.314672649 m.
#guard within edge0Len 1498.3146726 1498.3146727

-- Every station reads the line, so no candidate is excluded for membership.
#guard testNodes.all (fun n => stationLineMemberships testGraph n == ["Test Line"])

-- Adjacent stations are one edge apart, Alpha→Delta three. Pinned against the
-- reference edge length rather than against a second computation of it.
#guard (pathBetween "Alpha" "Bravo").any (within · 1498.3146726 1498.3146727)
#guard (pathBetween "Alpha" "Delta").any (within · 4494.9440179 4494.9440180)

-- Not exactly symmetric: the four edges differ in their last bits, so summing
-- west to east and east to west lands a ULP apart. Hence a window, not
-- `pathBetween a b == pathBetween b a`.
#guard (pathBetween "Alpha" "Echo").any (within · 5993.2586905 5993.2586907)
#guard (pathBetween "Echo" "Alpha").any (within · 5993.2586905 5993.2586907)

-- A station against itself shares a footprint node, so the path is 0 — the arm
-- that makes MIN_PATH_M reject a self-pair rather than divide by it.
#guard pathBetween "Charlie" "Charlie" == some 0

-- No edge carries a line by this name, so nothing is reachable. This is the
-- connectivity constraint doing its job, not an error path.
#guard linePathMeters testGraph "Absent Line" (station "Alpha") (station "Echo") == none

-- `stationsNear` returns graph order, not distance order: from beside Charlie,
-- Bravo, Charlie and Delta come west to east.
#guard
  (stationsNear testGraph 51.5 0.04329 1600.0).map (fun p => p.1.stationName)
    == #[some "Bravo", some "Charlie", some "Delta"]

-- The radius is inclusive and measured from the node's rounded coordinates.
#guard (stationsNear testGraph 51.5 0 1.0).size == 1
#guard (stationsNear testGraph 51.5 0 0.0).size == 1

/-! ## End-to-end guards: `resolveStationChain` against eleven reference outcomes

They pin the anchors, candidates and scoring terms, all private. The inputs are
pasted reference rows rather than re-derived, since a slip in the float
`lonAt` would still pass. Timestamps are minute offsets from `T0`.
-/

private def T0 : Int := 1750000000

/-- A row carrying only what the resolver reads. Every case leaves both bookends
    `none`; the harness sets them per case precisely so one cannot appear by
    accident and hand a case the anchor it meant to withhold. -/
private def ob (i : Nat) (lon : Option Float) : ObsRow :=
  { ts := T0 + (i : Int) * 60
    gps := lon.map (fun l => ⟨51.5, l, 0, none⟩)
    hr := none, cadence := none, hourLocal := 9, dayOfWeekLocal := 3, inBed := false
    roadDistM := none, railDistM := none
    prevGpsFix := none, nextGpsFix := none }

private def tseg (a b : Nat) : ChainSeg :=
  ⟨"train", some "Test Line", T0 + (a : Int) * 60, T0 + (b : Int) * 60, none, none⟩

private def run (segs : Array ChainSeg) (obs : Array ObsRow) : Array (Nat × ResolvedStations) :=
  resolveStationChain testGraph segs obs none

private def dark (a b : Nat) : Array ObsRow :=
  ((List.range (b + 1 - a)).map (fun k => ob (a + k) none)).toArray

-- 1. The clean ride: fresh anchors on both platforms, in-leg fixes riding the
--    track, every term agreeing. Alpha → Delta.
private def cleanObs : Array ObsRow := #[
  ob 0 (some 0), ob 1 (some 0),
  ob 2 (some 0.007575940212708944), ob 3 (some 0.015151880425417888),
  ob 4 (some 0.022727820638126832), ob 5 (some 0.030303760850835776),
  ob 6 (some 0.03787970106354472), ob 7 (some 0.045455641276253664),
  ob 8 (some 0.053031581488962615), ob 9 (some 0.06060752170167155),
  ob 10 (some 0.06493663039464809), ob 11 (some 0.06493663039464809)]
-- The last two fixes stand at Delta: the ride ends a minute before its leg.
#guard run #[tseg 2 11] cleanObs == #[(0, ⟨some "Alpha", some "Delta", none, none, some (T0 + 540)⟩)]

-- Re-lining. A leg decoded on a line with no track, offered the real one:
-- the chain places it Alpha → Delta on Test Line and says so.
private def ghost (a b : Nat) : ChainSeg :=
  ⟨"train", some "Ghost Line", T0 + (a : Int) * 60, T0 + (b : Int) * 60, none, none⟩
#guard resolveStationChain testGraph #[ghost 2 11] cleanObs none ["Test Line"]
  == #[(0, ⟨some "Alpha", some "Delta", some "Test Line", none, some (T0 + 540)⟩)]
-- Offering a leg its own line changes nothing.
#guard resolveStationChain testGraph #[tseg 2 11] cleanObs none ["Test Line"]
  == run #[tseg 2 11] cleanObs
-- Under `RELINE_MIN_MINUTES` the offer is declined: three minutes of ride fit a
-- short hop on any line, so the decoded line stands (here: no pair, nothing).
#guard resolveStationChain testGraph #[ghost 2 5] cleanObs none ["Test Line"] == #[]

-- 2. Duration decides. The alight anchor is midway between Bravo and Charlie,
--    so the anchor term is indifferent; the leg is dark, so no trajectory or
--    dwell term exists. A three-minute leg goes silent (adjacent stations lie
--    2.1 expected minutes apart); seven minutes picks Charlie by 1.9 nats.
private def durationObs : Array ObsRow :=
  #[ob 0 (some 0), ob 1 (some 0)] ++ dark 2 9 ++ #[ob 10 (some 0.032468315197324044)]
#guard run #[tseg 2 9] durationObs == #[(0, ⟨some "Alpha", some "Charlie", none, none, none⟩)]
private def durationObsShort : Array ObsRow :=
  #[ob 0 (some 0), ob 1 (some 0)] ++ dark 2 5 ++ #[ob 6 (some 0.032468315197324044)]
#guard run #[tseg 2 5] durationObsShort == #[(0, ⟨some "Alpha", none, none, none, none⟩)]

-- 3. Terminal dwell disqualifies. The fixes sit on Delta from minute 4 to the
--    leg's end at 13 — the ride passed it mid-leg and stopped, which a real
--    service does not do at its terminus. The alight side goes silent while the
--    board side still resolves: the gate is PER SIDE.
private def dwellObs : Array ObsRow :=
  #[ob 0 (some 0), ob 1 (some 0),
    ob 2 (some 0.021645543464882695), ob 3 (some 0.04329108692976539)]
  ++ ((List.range 10).map (fun k => ob (4 + k) (some 0.06493663039464809))).toArray
#guard run #[tseg 2 13] dwellObs == #[(0, ⟨some "Alpha", none, none, none, none⟩)]

-- 4. No evidence at all: no in-leg fix, no anchor either side, no bookend. The
--    leg has no admissible pair, so it is absent from the result entirely —
--    silence, not a guess.
#guard run #[tseg 1 5] (dark 0 5) == #[]

-- 5. The chain decides the second leg's board: both legs are dark, and the
--    handover penalty makes Charlie→Echo win, available only within one chain.
private def chainObs : Array ObsRow :=
  #[ob 0 (some 0), ob 1 (some 0)] ++ dark 2 8
  ++ #[ob 9 (some 0.04329108692976539), ob 10 (some 0.05411385866220674)]
  ++ dark 11 14 ++ #[ob 15 (some 0.08658217385953078)]
#guard run #[tseg 2 8, tseg 11 15] chainObs
  == #[(0, ⟨some "Alpha", some "Charlie", none, none, none⟩), (1, ⟨some "Charlie", some "Echo", none, none, none⟩)]

-- 6. The same two legs, 13 minutes apart instead of 3: past CHAIN_GAP_MAX_S, so
--    they are SEPARATE chains and no handover term crosses the gap. Leg 1's
--    board goes silent — the evidence that resolved it in case 5 was the chain.
private def splitObs : Array ObsRow :=
  #[ob 0 (some 0), ob 1 (some 0)] ++ dark 2 8
  ++ #[ob 9 (some 0.04329108692976539)] ++ dark 10 19
  ++ #[ob 20 (some 0.05411385866220674)] ++ dark 21 24
  ++ #[ob 25 (some 0.08658217385953078)]
#guard run #[tseg 2 8, tseg 21 25] splitObs
  == #[(0, ⟨some "Alpha", some "Charlie", none, none, none⟩), (1, ⟨none, some "Echo", none, none, none⟩)]

-- 7. Three ways to be out of scope, each on its own so no case can pass by
--    satisfying a different guard than the one it names. All run the CLEAN
--    observations, which do resolve when the segment qualifies (case 1).
#guard run #[{ tseg 2 11 with mode := "walking" }] cleanObs == #[]
#guard run #[{ tseg 2 11 with lineName := none }] cleanObs == #[]
#guard run #[{ tseg 2 11 with lineName := some "unknown_rail" }] cleanObs == #[]

-- 8. Empty observations short-circuits before any leg is built.
#guard run #[tseg 2 11] #[] == #[]

end Verified.Hsmm.StationChain
