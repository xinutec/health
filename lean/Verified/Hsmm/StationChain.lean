import Verified.Hsmm.RouteModel
import Verified.Hsmm.RouteGraph
import Verified.Hsmm.Observation
import Verified.Geo.WalkableRoute
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
open Verified.Hsmm.Observation (ObsRow)

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
    allowed to be cut short.

    Returns the pairs in the TS `Map`'s INSERTION order, not a bare lookup table.
    `trajectoryAdmits` iterates the result and its own output order reaches the
    candidate list, where `sideCandidates` dedupes and cuts — so a hash-ordered
    return would be a permutation the caller reads. `linePathMeters` only looks
    up, and takes a strict minimum, so it is indifferent. -/
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

All in nats, all clamped: evidence, never a veto. Each is a port of a PRIVATE TS
function, so none can be pinned on its own — the guards at the bottom drive the
whole resolver and each case is shaped so one term decides it. -/

def STATION_SIGMA_M : Float := 200
def SLOP_SPEED_M_PER_MIN : Float := 500
def CAND_BASE_RADIUS_M : Float := 800
def MAX_CANDIDATES_PER_SIDE : Nat := 12
def TUBE_SPEED_KMH : Float := 32
def STOP_OVERHEAD_MIN : Float := 0.8
def DURATION_SIGMA_FRAC : Float := 0.35
def DURATION_SIGMA_MIN : Float := 2
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

inductive Side where
  | board
  | alight
  deriving BEq, Inhabited

/-- Seconds to minutes, on the `Int` timestamps the TS carries as numbers. -/
private def mins (a b : Int) : Float := Float.ofInt (a - b) / 60

/-- `−z²/2` with σ widened in quadrature by anchor staleness, clamped. -/
def slopZPenalty (distM sigmaM slopMin clamp : Float) : Float :=
  let slop := SLOP_SPEED_M_PER_MIN * slopMin
  let sigma := Float.sqrt (sigmaM * sigmaM + slop * slop)
  let z := distM / sigma
  max clamp (-0.5 * z * z)

structure Fit where
  v : Float
  c : Float
  madM : Float
  deriving Inhabited

/-- Theil–Sen: slope is the median of pairwise slopes, so a MINORITY of corrupted
    fixes cannot steer it. `(t, d)` pairs.

    `Observation.median` is reused rather than restated. Note it returns 0 on an
    empty list where the TS returns NaN (`(undefined + undefined) / 2`) — a real
    divergence, and unreachable here: the empty case is guarded for `v`, and `c`
    and `madM` are only reached with at least `TRAJ_MIN_FIXES` points. -/
def theilSen (pts : Array (Float × Float)) : Fit :=
  let slopes := (List.range pts.size).foldl (fun acc i =>
    (List.range pts.size).foldl (fun acc j =>
      if j > i && pts[j]!.1 != pts[i]!.1
      then acc ++ [(pts[j]!.2 - pts[i]!.2) / (pts[j]!.1 - pts[i]!.1)]
      else acc) acc) []
  let v := if slopes.isEmpty then 0 else Verified.Hsmm.Observation.median slopes
  let c := Verified.Hsmm.Observation.median (pts.toList.map (fun p => p.2 - v * p.1))
  let madM := Verified.Hsmm.Observation.median
    (pts.toList.map (fun p => Float.abs (p.2 - (v * p.1 + c))))
  { v, c, madM }

/-- Observed leg minutes against the along-line path the pair implies.

    A boundary lost in a blackout means the ride extends past the observed
    window, so the term goes ONE-SIDED: a pair expecting LONGER than observed is
    consistent, only a pair expecting shorter contradicts. -/
def durationPenalty (observedMin pathM : Float) (boundaryUnobserved : Bool) : Float :=
  let expectedMin := (pathM / 1000 / TUBE_SPEED_KMH) * 60 + STOP_OVERHEAD_MIN
  let sigma := max DURATION_SIGMA_MIN (DURATION_SIGMA_FRAC * expectedMin)
  if boundaryUnobserved && expectedMin ≥ observedMin then 0
  else
    let z := (observedMin - expectedMin) / sigma
    max DURATION_CLAMP (-0.5 * z * z)

structure InLegFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited

private def dwellZ (excessMin : Float) : Float :=
  if excessMin ≤ 0 then 0
  else
    let z := excessMin / TERMINAL_DWELL_Z_MIN
    max DWELL_CLAMP (-0.5 * z * z)

/-- Alighting at A means the trajectory reaches A at the leg's END; an in-leg fix
    near A minutes earlier implies the train dwelt at a through station, which
    real services do not. Symmetrically for boards. A leg dark near the candidate
    asserts nothing. -/
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

/-- Where a side's candidates are measured from, and how stale that measurement
    is. `slopMin` widens both the admission radius and the penalty's sigma, so a
    boundary the phone never observed cannot masquerade as a precise one. -/
structure Anchor where
  lat : Float
  lon : Float
  /-- Minutes between the fix and the leg boundary it anchors. -/
  slopMin : Float
  deriving Inhabited, Repr

/-- Last observed fix strictly BEFORE the leg (board side).

    Two sources, and the fallback is not the same shape as the scan. The scan
    walks backwards for a minute that carries its own `gps`; failing that it
    takes `prevGpsFix` off the leg's FIRST row — the bookend, which is a fix the
    aggregator already reached back for. Note the index: the fallback reads
    `firstIdx`, not `firstIdx - 1`, so a leg whose every prior minute is dark
    still anchors from the bookend rather than from nothing. -/
def boardAnchor (obs : Array ObsRow) (firstIdx : Nat) (legStartTs : Int) : Option Anchor :=
  let rec scan (i : Nat) : Option Anchor :=
    match i with
    | 0 => none
    | j + 1 =>
      match obs[j]? with
      | none => none
      | some o => match o.gps with
        | some g => some ⟨g.lat, g.lon, max 0 (mins legStartTs o.ts)⟩
        | none => scan j
  match scan firstIdx with
  | some a => some a
  | none => match (obs[firstIdx]?).bind (·.prevGpsFix) with
    | none => none
    | some b => some ⟨b.lat, b.lon, max 0 (mins legStartTs b.ts)⟩

/-- First observed fix at/after the leg end (alight side) — `boardAnchor`
    mirrored, with `nextGpsFix` off the leg's LAST row as the bookend. -/
def alightAnchor (obs : Array ObsRow) (lastIdx : Nat) (legEndTs : Int) : Option Anchor :=
  let rec scan (i : Nat) (fuel : Nat) : Option Anchor :=
    match fuel with
    | 0 => none
    | f + 1 =>
      match obs[i]? with
      | none => none
      | some o => match o.gps with
        | some g => some ⟨g.lat, g.lon, max 0 (mins o.ts legEndTs)⟩
        | none => scan (i + 1) f
  match scan (lastIdx + 1) obs.size with
  | some a => some a
  | none => match (obs[lastIdx]?).bind (·.nextGpsFix) with
    | none => none
    | some b => some ⟨b.lat, b.lon, max 0 (mins b.ts legEndTs)⟩

/-! ## Side candidates: which stations one end of a leg may be -/

structure SideCandidate where
  node : ChainNode
  anchorPenalty : Float
  deriving Inhabited, Repr

/-- A name→candidate map that remembers INSERTION order, mirroring the JS `Map`
    the TS builds. Updating an existing name must NOT move it, which is exactly
    what `Map.set` does and what `{ st with best := … }` does here. -/
private structure ByName where
  order : Array String
  best : Std.HashMap String SideCandidate

private def byNameEmpty : ByName := ⟨#[], {}⟩

private def byNameOut (st : ByName) : Array SideCandidate :=
  st.order.filterMap (fun name => st.best.get? name)

/-- Keep the BEST-scoring node per station name. Penalties are ≤ 0, so "greater"
    is "closer to the anchor"; the comparison is STRICT, so a later node tying
    the incumbent does not displace it and the name keeps its first position. -/
private def admitCand (st : ByName) (node : ChainNode) (p : Float) : ByName :=
  match node.stationName with
  | none => st
  | some name =>
    match st.best.get? name with
    | some prev => if p > prev.anchorPenalty then { st with best := st.best.insert name ⟨node, p⟩ } else st
    | none => { order := st.order.push name, best := st.best.insert name ⟨node, p⟩ }

/-- Stations on `line` admissible for one side of a leg, scored against the
    anchor and DEDUPED BY NAME — one real station is several OSM nodes
    (entrances, merged endpoints), and the margin gate compares stations, not
    nodes.

    A missing anchor admits every station on the line at a flat 0; the chain and
    duration terms then carry the choice. Trajectory-admitted stations (`extra`)
    join AFTER the cap, so a candidate the track vouches for cannot be crowded
    out by anchor-plausible ones — that is what trajectory admission is for.

    THREE consumers of order, which is why the graph carries an ordered node
    array (see the module docstring): the dedupe above keeps the first best, the
    sort below is stable, and the cut then falls wherever those two left things. -/
def sideCandidates (g : ChainGraph) (line : String) (anchor : Option Anchor)
    (extra : Array ChainNode) : Array SideCandidate :=
  let admitted := match anchor with
    | none =>
      g.nodes.foldl (fun st n =>
        match n.stationName with
        | none => st
        | some _ => if (stationLineMemberships g n).contains line then admitCand st n 0 else st)
        byNameEmpty
    | some a =>
      let radius := CAND_BASE_RADIUS_M + SLOP_SPEED_M_PER_MIN * a.slopMin
      (stationsNear g a.lat a.lon radius).foldl (fun st nd =>
        if (stationLineMemberships g nd.1).contains line then
          admitCand st nd.1 (slopZPenalty nd.2 STATION_SIGMA_M a.slopMin ANCHOR_CLAMP)
        else st) byNameEmpty
  -- Descending by penalty, STABLY: `mergeSort` is left-biased on `≤`, so ties
  -- keep the graph order the dedupe left them in — the same guarantee V8 gives
  -- `sort((a, b) => b.p - a.p)`, and the reason ties at the cut are decidable.
  let sorted := ((byNameOut admitted).toList.mergeSort
    (fun a b => b.anchorPenalty ≤ a.anchorPenalty)).toArray
  -- `stationName.getD ""` mirrors the TS `?? ""`, which is unreachable: every
  -- candidate here came through `admitCand`, which drops the nameless.
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
            slopZPenalty (haversineMeters a.lat a.lon n.lat n.lon) STATION_SIGMA_M a.slopMin ANCHOR_CLAMP
        { order := st.order.push name, best := st.best.insert name ⟨n, p⟩ }) capped)

/-! ## Trajectory: the fixes' own vote, projected onto the line's track -/

structure TrackFix where
  ts : Int
  edge : RouteEdge
  alongM : Float
  deriving Inhabited

/-- Project each in-leg fix onto the nearest point of `line`'s track, dropping
    fixes further off it than `TRAJ_OFFLINE_MAX_M`.

    Scans the line's own edge set directly — `edgesNear`'s grid indexes geometry
    VERTICES, so it goes blind mid-span of a sparse edge.

    `bestDist` is seeded once per FIX and carried across edges, and the
    comparison is STRICT, so the first edge to reach a distance keeps it. That is
    why `g.model.edges` must be in builder order. -/
def projectFixesToLine (g : ChainGraph) (line : String) (fixes : Array InLegFix) :
    Array TrackFix :=
  let lineEdges := g.model.edges.filter (fun e => e.lineMemberships.contains line)
  -- One fix against one edge: walk the geometry, carrying `(best, bestDist)` in
  -- and out, and an `arc` that belongs to this edge alone.
  let scanEdge (f : InLegFix) (st : Option TrackFix × Float) (e : RouteEdge) :
      Option TrackFix × Float :=
    let geom := e.geometry.toArray
    let r := (List.range (geom.size - 1)).foldl
      (fun (acc : Option TrackFix × Float × Float) i =>
        let a := geom[i]!
        let b := geom[i + 1]!
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

/-- Stations admissible for one side from the TRAJECTORY alone: along-line
    reachable from a near-boundary on-track fix within the ride time that
    boundary leaves. This is what gets the true station into the candidate set
    when the anchor fix is kilometres wrong — the anchor may be, the track is
    not. -/
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
      -- replaces it only when LOWER and only when it is the same key.
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
