import Verified.Geo.WalkableRoute
import Verified.Geo.Worldline
import Std.Data.HashMap

/-!
# Fix-cloud-weighted rail snapper (port of `src/geo/rail-snap.ts`)

Snap a confident train leg onto the rail network, routing between its two named
stations along the line the user's past journeys actually traced rather than the
geometrically shortest one. The whole module is pure geometry and graph search,
so all of it ports, with one boundary and one reuse:

* **Boundary — vertex fusion stays SHELL.** `buildRailGraph` keys a vertex by
  `` `${lat.toFixed(7)},${lon.toFixed(7)}` ``, the same string-keyed coordinate
  fusion as `walkable-route.ts`'s `nodeKey`, and the same decision is taken
  here: the shell fuses, and Lean is handed a {@link RailNet} — the fused
  vertex list plus, per way, the vertex id of each of its RAW coordinates.
  Both are needed, because the TS computes an edge's weight from the way's raw
  coordinates while storing the FIRST coordinate that mapped to each vertex; a
  net carrying only fused coordinates would move every weight.
* **Reuse.** `parseRailWayName` is already ported in `Verified.Geo.Worldline`
  (it is the same `indexOf`/`slice` parser, splitting on the FIRST separator
  with the tail rejoined) and `metersBetween` in `Verified.Geo.WalkableRoute`
  (identical constants and formula).

`snapTrainSegment` calls `shortestPathViaLean`, which returns the TS path
unchanged when `LEAN_RAIL` is unset (mode `off`) — the arm ported here, and the
arm the references pin. `parseLineMemberships` lives in `route-graph.ts` but is
ported here because `wayOnLine` is its only consumer in this cluster.

The private helpers `cloudPenalty`, `edgeWeight` and `bridgeGaps` are pinned
through the adjacency `buildRailGraph` returns, which exposes every weight as an
exact number.
-/

namespace Verified.Geo.RailSnap

open Verified.Geo.WalkableRoute (Pt metersBetween)
open Verified.Geo.Worldline (RailTriple parseRailWayName)

private def pi : Float := 3.14159265358979323846
private def posInf : Float := 1.0 / 0.0

/-- `Math.floor` into an `Int`, the JS grid-cell index. -/
private def floorInt (x : Float) : Int := (Float.floor x).toInt64.toInt

/-- `Math.round`: halves go UP, towards +∞. -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-! ## Constants (verbatim) -/

/-- OSM `railway` way subtypes that carry real train traffic. `tram` is
    excluded (not a train); `disused`/`abandoned` are excluded (no service runs
    on them). -/
def railSubtypes : List String := ["rail", "subway", "light_rail", "narrow_gauge"]
/-- Two rail vertices within this distance (m) but not sharing an OSM node are
    bridged with an edge. -/
def gapBridgeM : Float := 15
/-- A station whose nearest rail vertex is further than this (m) is not
    meaningfully on the network. -/
def maxStationToRailM : Float := 600
def cloudNearM : Float := 150
def cloudFarM : Float := 500
def cloudMaxPenalty : Float := 25
/-- Below this many historic fixes the corridor is too thin to trust. -/
def minCloudFixes : Nat := 12

/-- Whether a way's OSM subtype carries train traffic. The shell filters ways
    with this before fusing them into a {@link RailNet}. -/
def isRailSubtype (subtype : Option String) : Bool :=
  railSubtypes.contains (subtype.getD "")

/-! ## The historic fix cloud -/

/-- A grid-hashed cloud of historic GPS fixes. The cell is `cloudFarM`, so the
    3×3 neighbourhood of any point contains every fix within `cloudFarM` of it.
    The TS keys a cell with the string `` `${cy},${cx}` ``; an `Int × Int` key is
    the same partition (the pairing is injective either way) and the bucket
    contents, hence every distance, are identical. -/
structure FixCloud where
  cLat : Float
  cLon : Float
  buckets : Std.HashMap (Int × Int) (Array Pt)

def FixCloud.ofFixes (fixes : Array Pt) : FixCloud := Id.run do
  let lat0 := if h : fixes.size > 0 then fixes[0].lat else 0
  let cLat := cloudFarM / 111320.0
  let cLon := cloudFarM / (111320.0 * Float.cos (lat0 * pi / 180))
  let mut buckets : Std.HashMap (Int × Int) (Array Pt) := {}
  for f in fixes do
    let key := (floorInt (f.lat / cLat), floorInt (f.lon / cLon))
    match buckets[key]? with
    | some b => buckets := buckets.insert key (b.push f)
    | none => buckets := buckets.insert key #[f]
  return { cLat, cLon, buckets }

/-- Distance (m) to the nearest historic fix, capped at `cloudFarM`. -/
def FixCloud.nearestDist (c : FixCloud) (lat lon : Float) : Float := Id.run do
  let baseLat := floorInt (lat / c.cLat)
  let baseLon := floorInt (lon / c.cLon)
  let p : Pt := ⟨lat, lon⟩
  let mut best := cloudFarM
  for dLat in [0:3] do
    for dLon in [0:3] do
      let key := (baseLat + Int.ofNat dLat - 1, baseLon + Int.ofNat dLon - 1)
      match c.buckets[key]? with
      | none => pure ()
      | some b =>
        for f in b do
          let d := metersBetween p f
          if d < best then best := d
  return best

/-- Edge-weight multiplier from how far an edge sits from the historic fix
    cloud. This is what routes the search down the line the user's past
    journeys actually traced. -/
def cloudPenalty (distToCloudM : Float) : Float :=
  if distToCloudM ≤ cloudNearM then 1
  else if distToCloudM ≥ cloudFarM then cloudMaxPenalty
  else 1 + (cloudMaxPenalty - 1) * ((distToCloudM - cloudNearM) / (cloudFarM - cloudNearM))

/-- Metric length of an edge multiplied by its fix-cloud penalty — the weight
    the search minimises. The raw metric length is still used for gap-bridging
    thresholds and time interpolation. -/
def edgeWeight (a b : Pt) (cloud : FixCloud) : Float :=
  metersBetween a b * cloudPenalty (cloud.nearestDist ((a.lat + b.lat) / 2) ((a.lon + b.lon) / 2))

/-! ## Stations -/

/-- A railway POINT (station / halt / stop / entrance) from the mirror. -/
structure OsmStation where
  name : Option String
  subtype : Option String
  lat : Float
  lon : Float
  deriving Inhabited, Repr

/-- A station name resolved to a coordinate. -/
structure ResolvedStation where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- Resolve a station name to a coordinate. A station appears in OSM as several
    nodes (platforms, stop positions, entrances) all carrying the same `name`;
    the centroid of the exact-name matches is a stable anchor. -/
def resolveStation (name : String) (stations : Array OsmStation) : Option ResolvedStation :=
  let hits := stations.filter (fun s => s.name == some name)
  if hits.isEmpty then none
  else
    let n := Float.ofNat hits.size
    let lat := hits.foldl (fun a s => a + s.lat) 0 / n
    let lon := hits.foldl (fun a s => a + s.lon) 0 / n
    some ⟨name, lat, lon⟩

/-! ## Line memberships -/

private def directionals : List String :=
  [" Eastbound", " Westbound", " Northbound", " Southbound", " Inner Rail", " Outer Rail"]

/-- Push `s` unless already present — JS `Set.add`, whose iteration order is
    insertion order. -/
private def pushUniq (xs : Array String) (s : String) : Array String :=
  if xs.contains s then xs else xs.push s

/--
Parse a way's `name` into the rail line names it belongs to, handling OSM's
composite tagging where lines sharing track are merged into one name string:
strip a trailing directional, strip a trailing `" Line"`/`" Lines"`, split on
`" and "` then `", "`, and add `" Line"` back to each part. Names not ending in
`Line`/`Lines` yield nothing.
-/
def parseLineMemberships (name : Option String) : Array String := Id.run do
  match name with
  | none => return #[]
  | some raw =>
    if raw.isEmpty then return #[]
    let mut cleaned := raw.trimAscii.toString
    for dir in directionals do
      if cleaned.endsWith dir then
        cleaned := (cleaned.dropEnd dir.length).trimAscii.toString
        break
    let stripped ←
      if cleaned.endsWith " Lines" then pure (cleaned.dropEnd " Lines".length).toString
      else if cleaned.endsWith " Line" then pure (cleaned.dropEnd " Line".length).toString
      else return #[]
    let mut out : Array String := #[]
    for andPart in stripped.splitOn " and " do
      for commaPart in andPart.splitOn ", " do
        let trimmed := commaPart.trimAscii.toString
        if !trimmed.isEmpty then out := pushUniq out (trimmed ++ " Line")
    return out

/-- True when an OSM way's name places it on `line` — the canonical
    `"<Name> Line"` form. -/
def wayOnLine (osmName : Option String) (line : String) : Bool :=
  (parseLineMemberships osmName).contains line

/-! ## The rail graph -/

/-- One way, as the shell hands it over: its RAW coordinates alongside the
    fused vertex id each one resolved to. -/
structure FusedWay where
  coords : Array Pt
  vids : Array Nat
  deriving Inhabited, Repr

/-- The shell-fused rail network: the deduplicated vertex list (in first-seen
    order, which fixes the vertex numbering) and the rail-subtype ways. -/
structure RailNet where
  vertices : Array Pt
  ways : Array FusedWay
  deriving Inhabited, Repr

structure Edge where
  to : Nat
  w : Float
  deriving Inhabited, Repr

structure RailGraph where
  vertices : Array Pt
  adj : Array (Array Edge)
  deriving Inhabited, Repr

/-- Add edges between vertices of different ways that sit within `gapBridgeM`
    of each other but do not share an OSM node. Candidate pairs come from a
    coarse grid hash, so this stays linear in vertex count. -/
private def bridgeGaps (vertices : Array Pt) (adj : Array (Array Edge)) (cloud : FixCloud) :
    Array (Array Edge) := Id.run do
  if vertices.isEmpty then return adj
  let cellLat := gapBridgeM / 111320.0
  let midLat := vertices[0]!.lat
  let cellLon := gapBridgeM / (111320.0 * Float.cos (midLat * pi / 180))
  let cellOf := fun (v : Pt) => (floorInt (v.lat / cellLat), floorInt (v.lon / cellLon))
  let mut buckets : Std.HashMap (Int × Int) (Array Nat) := {}
  for i in [0:vertices.size] do
    let c := cellOf vertices[i]!
    match buckets[c]? with
    | some b => buckets := buckets.insert c (b.push i)
    | none => buckets := buckets.insert c #[i]
  let mut adj := adj
  for i in [0:vertices.size] do
    let v := vertices[i]!
    let (baseLatCell, baseLonCell) := cellOf v
    for dLat in [0:3] do
      for dLon in [0:3] do
        let key := (baseLatCell + Int.ofNat dLat - 1, baseLonCell + Int.ofNat dLon - 1)
        match buckets[key]? with
        | none => pure ()
        | some b =>
          for j in b do
            -- Each unordered pair once; skip vertices already adjacent.
            if j ≤ i then continue
            let gap := metersBetween v vertices[j]!
            if gap > gapBridgeM then continue
            if adj[i]!.any (fun e => e.to == j) then continue
            let w := edgeWeight v vertices[j]! cloud
            adj := adj.set! i (adj[i]!.push ⟨j, w⟩)
            adj := adj.set! j (adj[j]!.push ⟨i, w⟩)
  return adj

/-- Build the undirected rail graph over a shell-fused net. Edges are
    consecutive node pairs within a way, plus gap-bridge edges. -/
def buildRailGraph (net : RailNet) (cloud : FixCloud) : RailGraph := Id.run do
  let mut adj : Array (Array Edge) := Array.replicate net.vertices.size #[]
  for way in net.ways do
    let mut prev : Option (Nat × Pt) := none
    for i in [0:way.coords.size] do
      let id := way.vids[i]!
      let c := way.coords[i]!
      match prev with
      | some (pid, pc) =>
        if pid != id then
          let w := edgeWeight pc c cloud
          adj := adj.set! pid (adj[pid]!.push ⟨id, w⟩)
          adj := adj.set! id (adj[id]!.push ⟨pid, w⟩)
      | none => pure ()
      prev := some (id, c)
  return { vertices := net.vertices, adj := bridgeGaps net.vertices adj cloud }

/-! ## Dijkstra

The binary min-heap is reproduced element-for-element — the same shape as
`Verified.Geo.WalkableRoute`'s, because the TS duplicates it too. Relaxation is
on STRICT improvement, so among equal-cost routes the winner is decided by
which vertex the heap pops first. -/

private structure Heap where
  ps : Array Float := #[]
  vs : Array Nat := #[]
  deriving Inhabited

private def Heap.size (h : Heap) : Nat := h.vs.size

private def Heap.push (h : Heap) (p : Float) (v : Nat) : Heap := Id.run do
  let mut ps := h.ps.push p
  let mut vs := h.vs.push v
  let mut i := vs.size - 1
  while i > 0 do
    let parent := (i - 1) / 2
    if ps[parent]! ≤ ps[i]! then break
    let pi' := ps[i]!
    let pp := ps[parent]!
    ps := (ps.set! i pp).set! parent pi'
    let vi := vs[i]!
    let vp := vs[parent]!
    vs := (vs.set! i vp).set! parent vi
    i := parent
  return { ps, vs }

private def Heap.pop (h : Heap) : Option (Float × Nat) × Heap := Id.run do
  if h.vs.isEmpty then return (none, h)
  let topP := h.ps[0]!
  let topV := h.vs[0]!
  let lastP := h.ps[h.ps.size - 1]!
  let lastV := h.vs[h.vs.size - 1]!
  let mut ps := h.ps.pop
  let mut vs := h.vs.pop
  if vs.size > 0 then
    ps := ps.set! 0 lastP
    vs := vs.set! 0 lastV
    let mut i := 0
    while true do
      let l := 2 * i + 1
      let r := l + 1
      let mut s := i
      if l < vs.size && ps[l]! < ps[s]! then s := l
      if r < vs.size && ps[r]! < ps[s]! then s := r
      if s == i then break
      let pi' := ps[i]!
      let psv := ps[s]!
      ps := (ps.set! i psv).set! s pi'
      let vi := vs[i]!
      let vsv := vs[s]!
      vs := (vs.set! i vsv).set! s vi
      i := s
    return (some (topP, topV), { ps, vs })
  return (some (topP, topV), { ps, vs })

/-- Dijkstra shortest path between two vertices — the vertex-id sequence from
    `src` to `dst`, or `none` when they are disconnected. -/
def shortestPath (graph : RailGraph) (src dst : Nat) : Option (Array Nat) := Id.run do
  let n := graph.vertices.size
  let mut dist : Array Float := Array.replicate n posInf
  let mut prev : Array Int := Array.replicate n (-1)
  let mut done : Array Bool := Array.replicate n false
  dist := dist.set! src 0
  let mut heap : Heap := {}
  heap := heap.push 0 src
  while heap.size > 0 do
    let (cur, h') := heap.pop
    heap := h'
    match cur with
    | none => break
    | some (p, u) =>
      if done[u]! then continue
      done := done.set! u true
      if u == dst then break
      for e in graph.adj[u]! do
        let nd := p + e.w
        if nd < dist[e.to]! then
          dist := dist.set! e.to nd
          prev := prev.set! e.to (Int.ofNat u)
          heap := heap.push nd e.to
  if !dist[dst]!.isFinite then return none
  let mut path : Array Nat := #[]
  let mut v : Int := Int.ofNat dst
  for _ in [0:n + 1] do
    if v == -1 then break
    path := path.push v.toNat
    v := prev[v.toNat]!
  return some path.reverse

/-- The rail-graph vertex nearest a point. -/
def nearestVertex (graph : RailGraph) (p : Pt) : Option (Nat × Float) := Id.run do
  let mut bestId : Int := -1
  let mut bestD := posInf
  for i in [0:graph.vertices.size] do
    let d := metersBetween p graph.vertices[i]!
    if d < bestD then
      bestD := d
      bestId := Int.ofNat i
  if bestId < 0 then return none
  return some (bestId.toNat, bestD)

/-! ## Snapping -/

/-- One vertex of the snapped path, with an interpolated timestamp. -/
structure SnappedPoint where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

/-- The minimal slice of a classified train segment the snapper needs. -/
structure TrainSegment where
  startTs : Float
  endTs : Float
  wayName : String
  deriving Inhabited, Repr

structure SnapResult where
  board : ResolvedStation
  alight : ResolvedStation
  line : Option String
  path : Array SnappedPoint
  deriving Inhabited, Repr

/-- Interpolate `[startTs, endTs]` linearly along the path by cumulative
    distance: endpoints land exactly on the window bounds, interior points fall
    by how far along they are. -/
def interpolateTimes (coords : Array Pt) (startTs endTs : Float) : Array SnappedPoint := Id.run do
  let mut cum : Array Float := #[0]
  for i in [1:coords.size] do
    cum := cum.push (cum[i - 1]! + metersBetween coords[i - 1]! coords[i]!)
  let total := if cum.size > 0 then cum[cum.size - 1]! else 0
  let mut out : Array SnappedPoint := #[]
  for i in [0:coords.size] do
    let c := coords[i]!
    let ts := if total > 0 then jsRound (startTs + (endTs - startTs) * (cum[i]! / total)) else startTs
    out := out.push ⟨c.lat, c.lon, ts⟩
  return out

/-- The shared tail of both snappers: route between the two resolved stations
    over `net` and time-interpolate the result. `none` on every refusal — a
    station off the network, the two stations landing on one vertex, or no
    path — which means "draw the raw fixes", never a guessed line. -/
private def routeBetweenStations (seg : TrainSegment) (net : RailNet) (cloud : FixCloud)
    (board alight : ResolvedStation) (line : Option String) : Option SnapResult := Id.run do
  if net.vertices.isEmpty then return none
  let graph := buildRailGraph net cloud
  match nearestVertex graph ⟨board.lat, board.lon⟩, nearestVertex graph ⟨alight.lat, alight.lon⟩ with
  | some (fromId, fromD), some (toId, toD) =>
    if fromD > maxStationToRailM || toD > maxStationToRailM then return none
    if fromId == toId then return none
    match shortestPath graph fromId toId with
    | none => return none
    | some idPath =>
      if idPath.size < 2 then return none
      let coords := idPath.map (fun i => graph.vertices[i]!)
      return some ⟨board, alight, line, interpolateTimes coords seg.startTs seg.endTs⟩
  | _, _ => return none

/--
Snap a confident train segment onto the rail network. `corridorFixes` is the
cloud of historic GPS fixes for this route — the union of every past journey
between the same two stations — and the search is weighted to follow it, so the
snapped path traces the line actually ridden rather than the geometrically
shortest one.

`none` when the segment cannot be snapped: a too-thin corridor, a label that is
not a station pair, an unknown or off-network station, or two disconnected
stations.
-/
def snapTrainSegment (seg : TrainSegment) (net : RailNet) (stations : Array OsmStation)
    (corridorFixes : Array Pt) : Option SnapResult := Id.run do
  match parseRailWayName (some seg.wayName) with
  | none => return none
  | some parsed =>
    match resolveStation parsed.board stations, resolveStation parsed.alight stations with
    | some board, some alight =>
      if board.name == alight.name then return none
      -- Without enough historic fixes there is no trustworthy corridor.
      if corridorFixes.size < minCloudFixes then return none
      return routeBetweenStations seg net (FixCloud.ofFixes corridorFixes) board alight parsed.line
    | _, _ => return none

/--
Snap a confident train leg onto its KNOWN line, routing between the two named
stations over ONLY that line's ways, with NO historic fix cloud: when the label
carries a line name the LINE itself is the disambiguator, so the geometric
shortest path within that line's ways IS the ridden route. `net` is therefore
the line-restricted net — the shell filters the ways with {@link wayOnLine}
before fusing, and an empty `ways` reproduces the TS's `lineLines.length === 0`
refusal.
-/
def snapTrainSegmentOnLine (seg : TrainSegment) (net : RailNet) (stations : Array OsmStation) :
    Option SnapResult := Id.run do
  match parseRailWayName (some seg.wayName) with
  | none => return none
  | some parsed =>
    match parsed.line with
    | none => return none
    | some line =>
      match resolveStation parsed.board stations, resolveStation parsed.alight stations with
      | some board, some alight =>
        if board.name == alight.name then return none
        if net.ways.isEmpty then return none
        -- An empty fix cloud gives every edge the same uniform penalty, so the
        -- search returns the geometric shortest path.
        return routeBetweenStations seg net (FixCloud.ofFixes #[]) board alight (some line)
      | _, _ => return none

/-! ## Guards

Reference values from `lean/experiments/rail-snap-refs.mts`. Comparison is to
within 1e-9 because `metersBetween` uses `Math.hypot` where Lean uses `sqrt` of
the sum of squares. The nets below are the shell-side fusion the harness emits:
a line-restricted way set fuses a different set of ways and therefore numbers
its vertices differently, so each scenario carries its own. -/

section Guards

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320.0
private def mlon : Float := 1 / (111320.0 * Float.cos (lat0 * pi / 180))
/-- (north metres, east metres) → a point in the local frame. -/
private def P (n e : Float) : Pt := ⟨lat0 + n * mlat, lon0 + e * mlon⟩

-- Two parallel lines 300 m apart, joined by connectors at e=500 and e=1000;
-- SPUR continues MAIN east from 10 m past its end (gap-bridged, not shared).
private def wMain : Array Pt := #[P 0 0, P 0 250, P 0 500, P 0 750, P 0 1000]
private def wNorth : Array Pt := #[P 300 0, P 300 500, P 300 1000]
private def wConnMid : Array Pt := #[P 0 500, P 150 500, P 300 500]
private def wConnEnd : Array Pt := #[P 0 1000, P 150 1000, P 300 1000]
private def wSpur : Array Pt := #[P 0 1010, P 0 1200]

private def netAll : RailNet :=
  { vertices := #[P 0 0, P 0 250, P 0 500, P 0 750, P 0 1000, P 300 0, P 300 500, P 300 1000,
                  P 150 500, P 150 1000, P 0 1010, P 0 1200]
    ways := #[⟨wMain, #[0, 1, 2, 3, 4]⟩, ⟨wNorth, #[5, 6, 7]⟩, ⟨wConnMid, #[2, 8, 6]⟩,
              ⟨wConnEnd, #[4, 9, 7]⟩, ⟨wSpur, #[10, 11]⟩] }

private def netMetro : RailNet :=
  { vertices := #[P 0 0, P 0 250, P 0 500, P 0 750, P 0 1000, P 150 500, P 300 500,
                  P 150 1000, P 300 1000, P 0 1010, P 0 1200]
    ways := #[⟨wMain, #[0, 1, 2, 3, 4]⟩, ⟨wConnMid, #[2, 5, 6]⟩, ⟨wConnEnd, #[4, 7, 8]⟩,
              ⟨wSpur, #[9, 10]⟩] }

private def netPicc : RailNet :=
  { vertices := #[P 300 0, P 300 500, P 300 1000], ways := #[⟨wNorth, #[0, 1, 2]⟩] }

private def netSplit : RailNet :=
  { vertices := #[P 0 0, P 0 250, P 0 500, P 0 750, P 0 1000, P 300 0, P 300 500, P 300 1000]
    ways := #[⟨wMain, #[0, 1, 2, 3, 4]⟩, ⟨wNorth, #[5, 6, 7]⟩] }

/-- `cloudAlong(n, count)` from the harness. -/
private def cloudAlong (n : Float) (count : Nat) : Array Pt :=
  (Array.range count).map (fun i => P n (Float.ofNat i * 1000 / Float.ofNat (count - 1)))

private def cMain : FixCloud := FixCloud.ofFixes (cloudAlong 0 21)
private def cNorth : FixCloud := FixCloud.ofFixes (cloudAlong 300 21)
private def cEmpty : FixCloud := FixCloud.ofFixes #[]

private def stations : Array OsmStation :=
  #[⟨some "Alpha", some "station", (P 2 0).lat, (P 2 0).lon⟩,
    ⟨some "Alpha", some "station", (P (-2) 0).lat, (P (-2) 0).lon⟩,
    ⟨some "Beta", some "station", (P 0 1000).lat, (P 0 1000).lon⟩,
    ⟨some "Gamma", some "station", (P 300 1000).lat, (P 300 1000).lon⟩,
    ⟨some "Nowhere", some "station", (P 5000 5000).lat, (P 5000 5000).lon⟩]

-- isRailSubtype
#guard isRailSubtype (some "rail") && isRailSubtype (some "subway")
#guard isRailSubtype (some "light_rail") && isRailSubtype (some "narrow_gauge")
#guard !isRailSubtype (some "tram") && !isRailSubtype (some "disused") && !isRailSubtype none

-- parseRailWayName (reused from Worldline; pinned again through this cluster)
#guard parseRailWayName (some "Alpha → Beta") == some ⟨"Alpha", "Beta", none⟩
#guard parseRailWayName (some "Alpha → Beta · Metropolitan Line")
  == some ⟨"Alpha", "Beta", some "Metropolitan Line"⟩
#guard parseRailWayName (some "Alpha & Sons → Beta · Circle Line")
  == some ⟨"Alpha & Sons", "Beta", some "Circle Line"⟩
#guard parseRailWayName (some "Alpha → Beta · ") == some ⟨"Alpha", "Beta", none⟩
#guard (parseRailWayName (some "Alpha → ")).isNone
#guard (parseRailWayName (some " → Beta")).isNone
#guard (parseRailWayName (some "Alpha - Beta")).isNone
#guard (parseRailWayName (some "")).isNone

-- parseLineMemberships
#guard parseLineMemberships (some "Metropolitan Line") == #["Metropolitan Line"]
#guard parseLineMemberships (some "Hammersmith & City Line") == #["Hammersmith & City Line"]
#guard parseLineMemberships (some "Circle, Hammersmith & City and Metropolitan Lines")
  == #["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
#guard parseLineMemberships (some "Metropolitan and Piccadilly Line")
  == #["Metropolitan Line", "Piccadilly Line"]
#guard parseLineMemberships (some "Jubilee Line Eastbound") == #["Jubilee Line"]
#guard parseLineMemberships (some "Circle Line Inner Rail") == #["Circle Line"]
#guard parseLineMemberships (some "Metropolitan Line Westbound Extra") == #[]
#guard parseLineMemberships (some "District") == #[]
#guard parseLineMemberships (some "") == #[]
#guard parseLineMemberships (some " Line") == #[]
#guard parseLineMemberships (some "A,  B and C Lines") == #["A Line", "B Line", "C Line"]
#guard parseLineMemberships none == #[]
#guard wayOnLine (some "Circle, Hammersmith & City and Metropolitan Lines") "Metropolitan Line"
#guard !wayOnLine (some "Piccadilly Line") "Metropolitan Line"

-- resolveStation
#guard (resolveStation "Alpha" stations).map (·.lat) |>.all (approx · 51.520000000000003)
#guard (resolveStation "Alpha" stations).map (·.lon) |>.all (approx · (-0.13000000000000000))
#guard (resolveStation "Beta" stations).map (·.lon) |>.all (approx · (-0.11556330146882557))
#guard (resolveStation "Missing" stations).isNone

-- FixCloud
#guard approx (cMain.nearestDist (P 0 500).lat (P 0 500).lon) 0
#guard approx (cMain.nearestDist (P 50 500).lat (P 50 500).lon) 50.000000000095213
#guard approx (cMain.nearestDist (P 300 500).lat (P 300 500).lon) 299.99999999978030
#guard approx (cMain.nearestDist (P 900 500).lat (P 900 500).lon) 500
#guard approx (cEmpty.nearestDist (P 0 0).lat (P 0 0).lon) 500

-- buildRailGraph: adjacency rows, in the TS's per-vertex insertion order.
private def adjOk (g : RailGraph) (i : Nat) (expect : Array (Nat × Float)) : Bool :=
  g.adj[i]!.size == expect.size &&
    (Array.range expect.size).all (fun k =>
      g.adj[i]![k]!.to == expect[k]!.1 && approx g.adj[i]![k]!.w expect[k]!.2)

private def gAll : RailGraph := buildRailGraph netAll cMain
#guard gAll.vertices.size == 12
#guard adjOk gAll 0 #[(1, 250.00000000000043)]
#guard adjOk gAll 1 #[(0, 250.00000000000043), (2, 249.99999999999946)]
#guard adjOk gAll 2 #[(1, 249.99999999999946), (3, 250.00000000000043), (8, 150.00000000028564)]
#guard adjOk gAll 3 #[(2, 250.00000000000043), (4, 249.99999999999946)]
#guard adjOk gAll 4 #[(3, 249.99999999999946), (9, 150.00000000028564), (10, 10.000000000000785)]
#guard adjOk gAll 5 #[(6, 5642.5232257983280)]
#guard adjOk gAll 6 #[(5, 5642.5232257983280), (7, 5642.5232257983280), (8, 921.42857142580635)]
#guard adjOk gAll 7 #[(6, 5642.5232257983280), (9, 921.42857142580635)]
#guard adjOk gAll 8 #[(2, 150.00000000028564), (6, 921.42857142580635)]
#guard adjOk gAll 9 #[(4, 150.00000000028564), (7, 921.42857142580635)]
-- The gap-bridge edge (10 m, no shared node) — appended AFTER the way edges.
#guard adjOk gAll 10 #[(11, 189.99999999999955), (4, 10.000000000000785)]
#guard adjOk gAll 11 #[(10, 189.99999999999955)]

private def gNorth : RailGraph := buildRailGraph netAll cNorth
#guard adjOk gNorth 0 #[(1, 2839.2537664545421)]
#guard adjOk gNorth 1 #[(0, 2839.2537664545421), (2, 2839.2537664545321)]
#guard adjOk gNorth 2 #[(1, 2839.2537664545321), (3, 2839.2537664545430), (8, 921.42857143066522)]
#guard adjOk gNorth 3 #[(2, 2839.2537664545430), (4, 2839.2537664545312)]
#guard adjOk gNorth 4 #[(3, 2839.2537664545312), (9, 921.42857143066522), (10, 112.88571061127743)]
#guard adjOk gNorth 5 #[(6, 499.97041241317743)]
#guard adjOk gNorth 6 #[(5, 499.97041241317743), (7, 499.97041241317743), (8, 149.99999999949466)]
#guard adjOk gNorth 7 #[(6, 499.97041241317743), (9, 149.99999999949466)]
#guard adjOk gNorth 8 #[(2, 921.42857143066522), (6, 149.99999999949466)]
#guard adjOk gNorth 9 #[(4, 921.42857143066522), (7, 149.99999999949466)]
#guard adjOk gNorth 10 #[(11, 2376.7581001475037), (4, 112.88571061127743)]
#guard adjOk gNorth 11 #[(10, 2376.7581001475037)]

private def gMetro : RailGraph := buildRailGraph netMetro cEmpty
#guard gMetro.vertices.size == 11
#guard adjOk gMetro 0 #[(1, 6250.0000000000109)]
#guard adjOk gMetro 1 #[(0, 6250.0000000000109), (2, 6249.9999999999864)]
#guard adjOk gMetro 2 #[(1, 6249.9999999999864), (3, 6250.0000000000109), (5, 3750.0000000071409)]
#guard adjOk gMetro 3 #[(2, 6250.0000000000109), (4, 6249.9999999999864)]
#guard adjOk gMetro 4 #[(3, 6249.9999999999864), (7, 3750.0000000071409), (9, 250.00000000001964)]
#guard adjOk gMetro 5 #[(2, 3750.0000000071409), (6, 3749.9999999873667)]
#guard adjOk gMetro 6 #[(5, 3749.9999999873667)]
#guard adjOk gMetro 7 #[(4, 3750.0000000071409), (8, 3749.9999999873667)]
#guard adjOk gMetro 8 #[(7, 3749.9999999873667)]
#guard adjOk gMetro 9 #[(10, 4749.9999999999891), (4, 250.00000000001964)]
#guard adjOk gMetro 10 #[(9, 4749.9999999999891)]

private def gPicc : RailGraph := buildRailGraph netPicc cEmpty
#guard gPicc.vertices.size == 3
#guard adjOk gPicc 0 #[(1, 12499.260310329435)]
#guard adjOk gPicc 1 #[(0, 12499.260310329435), (2, 12499.260310329435)]
#guard adjOk gPicc 2 #[(1, 12499.260310329435)]

private def gSplit : RailGraph := buildRailGraph netSplit cMain
#guard gSplit.vertices.size == 8
#guard adjOk gSplit 0 #[(1, 250.00000000000043)]
#guard adjOk gSplit 1 #[(0, 250.00000000000043), (2, 249.99999999999946)]
#guard adjOk gSplit 2 #[(1, 249.99999999999946), (3, 250.00000000000043)]
#guard adjOk gSplit 3 #[(2, 250.00000000000043), (4, 249.99999999999946)]
#guard adjOk gSplit 4 #[(3, 249.99999999999946)]
#guard adjOk gSplit 5 #[(6, 5642.5232257983280)]
#guard adjOk gSplit 6 #[(5, 5642.5232257983280), (7, 5642.5232257983280)]
#guard adjOk gSplit 7 #[(6, 5642.5232257983280)]

private def gEmpty : RailGraph := buildRailGraph ⟨#[], #[]⟩ cMain
#guard gEmpty.vertices.size == 0

-- nearestVertex
private def alphaPt : Pt :=
  match resolveStation "Alpha" stations with | some s => ⟨s.lat, s.lon⟩ | none => P 0 0
private def nowherePt : Pt :=
  match resolveStation "Nowhere" stations with | some s => ⟨s.lat, s.lon⟩ | none => P 0 0
#guard (nearestVertex gAll alphaPt).map (·.1) == some 0
#guard (nearestVertex gAll alphaPt).map (·.2) |>.all (approx · 0)
#guard (nearestVertex gAll nowherePt).map (·.1) == some 7
#guard (nearestVertex gAll nowherePt).map (·.2) |>.all (approx · 6170.354533983668)
#guard (nearestVertex gEmpty (P 0 0)).isNone

-- shortestPath
#guard shortestPath gAll 0 4 == some #[0, 1, 2, 3, 4]
#guard shortestPath gNorth 0 4 == some #[0, 1, 2, 8, 6, 7, 9, 4]
#guard shortestPath gAll 0 0 == some #[0]
#guard (shortestPath gSplit 0 7).isNone

-- interpolateTimes
private def interp : Array SnappedPoint := interpolateTimes #[P 0 0, P 0 250, P 0 1000] 1000 1300
#guard interp.size == 3
#guard approx interp[0]!.ts 1000 && approx interp[1]!.ts 1075 && approx interp[2]!.ts 1300
#guard approx interp[1]!.lon (-0.12639082536720639)
#guard (interpolateTimes #[P 0 0] 1000 1300)[0]!.ts == 1000
#guard ((interpolateTimes #[P 0 0, P 0 0] 1000 1300).map (·.ts)) == #[1000, 1000]

-- snapTrainSegment
private def segAB : TrainSegment := ⟨1000, 1300, "Alpha → Beta"⟩
private def pathTs (r : Option SnapResult) : Array Float := (r.map (·.path.map (·.ts))).getD #[]
private def pathLon (r : Option SnapResult) : Array Float := (r.map (·.path.map (·.lon))).getD #[]

private def snapMain := snapTrainSegment segAB netAll stations (cloudAlong 0 21)
#guard (snapMain.map (·.board.name)) == some "Alpha"
#guard (snapMain.map (·.alight.name)) == some "Beta"
#guard (snapMain.bind (·.line)).isNone
#guard pathTs snapMain == #[1000, 1075, 1150, 1225, 1300]
#guard (pathLon snapMain).size == 5
#guard approx (pathLon snapMain)[4]! (-0.11556330146882557)

/-- The cloud, not the geometry, picks the route: fixes along the NORTH line
    make the 1600 m detour cheaper than the 1000 m direct run. -/
private def snapNorth := snapTrainSegment segAB netAll stations (cloudAlong 300 21)
#guard pathTs snapNorth == #[1000, 1047, 1094, 1122, 1150, 1244, 1272, 1300]
#guard approx (pathLon snapNorth)[3]! (-0.12278165073441279)

#guard (snapTrainSegment segAB netAll stations (cloudAlong 0 11)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha - Beta"⟩ netAll stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Zeta"⟩ netAll stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Alpha"⟩ netAll stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Nowhere"⟩ netAll stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment segAB ⟨#[], #[]⟩ stations (cloudAlong 0 21)).isNone

-- snapTrainSegmentOnLine
private def snapMetro :=
  snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta · Metropolitan Line"⟩ netMetro stations
#guard (snapMetro.bind (·.line)) == some "Metropolitan Line"
#guard pathTs snapMetro == #[1000, 1075, 1150, 1225, 1300]

private def snapPicc :=
  snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Gamma · Piccadilly Line"⟩ netPicc stations
#guard (snapPicc.bind (·.line)) == some "Piccadilly Line"
#guard pathTs snapPicc == #[1000, 1150, 1300]
#guard approx (pathLon snapPicc)[0]! (-0.13000000000000000)

#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta"⟩ netMetro stations).isNone
-- An unknown line leaves the shell's `wayOnLine` filter empty.
#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta · Bakerloo Line"⟩ ⟨#[], #[]⟩ stations).isNone
#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Alpha · Metropolitan Line"⟩ netMetro stations).isNone

end Guards

end Verified.Geo.RailSnap
