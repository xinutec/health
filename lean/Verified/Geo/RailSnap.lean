import Verified.Geo.PathPoint
import Verified.Geo.WalkableRoute
import Verified.Geo.Worldline
import Verified.JsNum
import Std.Data.HashMap

/-!
# Fix-cloud-weighted rail snapper (port of `src/geo/rail-snap.ts`)

Snap a confident train leg onto the rail network, routing between its two named
stations along the line the user's past journeys actually traced rather than the
geometrically shortest one. The whole module is pure geometry and graph search,
so all of it ports — including the vertex fusion, which earlier ports left in
the shell:

* **Fusion is in Lean.** `buildRailGraph` keys a vertex by
  `` `${lat.toFixed(7)},${lon.toFixed(7)}` ``. That was the last algorithmic
  reason to hand Lean a pre-built topology; with `toFixed` ported exactly
  (`Verified.JsNum`) the builder takes RAW ways and fuses them itself, so the
  shell's only remaining job for this module is reading the rows.
  {@link Verified.JsNum.coordKey7} stands in for the key string — a graph
  builder needs only to know when two coordinates agree, and that comparison is
  exact even where the string rendering is not.
* **Reuse.** `parseRailWayName` is already ported in `Verified.Geo.Worldline`
  (it is the same `indexOf`/`slice` parser, splitting on the FIRST separator
  with the tail rejoined) and `metersBetween` in `Verified.Geo.WalkableRoute`
  (identical constants and formula).

`snapTrainSegment` calls `shortestPathViaLean`, which returns the TS path
unchanged when `LEAN_RAIL` is unset (mode `off`) — the arm ported here, and the
arm the references pin. `parseLineMemberships` lives in `route-graph.ts` but is
ported here because `wayOnLine` is its only consumer in this cluster — which
also lets `snapTrainSegmentOnLine` do its own line filtering.

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

open Verified.JsNum (jsRound)

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

/-- Whether a way's OSM subtype carries train traffic. -/
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

/-- An OSM way from the mirror, exactly as loaded. -/
structure RailWay where
  name : Option String
  subtype : Option String
  coords : Array Pt
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
  let some v0 := vertices[0]? | return adj
  let cellLat := gapBridgeM / 111320.0
  let midLat := v0.lat
  let cellLon := gapBridgeM / (111320.0 * Float.cos (midLat * pi / 180))
  let cellOf := fun (v : Pt) => (floorInt (v.lat / cellLat), floorInt (v.lon / cellLon))
  let mut buckets : Std.HashMap (Int × Int) (Array Nat) := {}
  for hm_i : i in [0:vertices.size] do
    let c := cellOf vertices[i]
    match buckets[c]? with
    | some b => buckets := buckets.insert c (b.push i)
    | none => buckets := buckets.insert c #[i]
  let mut adj := adj
  for hm_i : i in [0:vertices.size] do
    let v := vertices[i]
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
            -- `j` came out of a bucket this function filled with vertex
            -- indices, and `adj` has one row per vertex; the guard is where
            -- the tactic sees that.
            -- ⚠ No `continue` between the guard and the writes: in `do`
            -- notation a statement that can exit rebinds every mutable
            -- variable after it, and a bound on the old `adj` no longer names
            -- the new one.
            if h : j < vertices.size ∧ i < adj.size ∧ j < adj.size then
              let gap := metersBetween v (vertices[j]'h.1)
              if !(gap > gapBridgeM) && !((adj[i]'h.2.1).any (fun e => e.to == j)) then
                let w := edgeWeight v (vertices[j]'h.1) cloud
                -- `i < j`, so the two rows are distinct and may be read before
                -- either is written.
                let rowI := (adj[i]'h.2.1).push ⟨j, w⟩
                let rowJ := (adj[j]'h.2.2).push ⟨i, w⟩
                adj := (adj.set i rowI h.2.1).set j rowJ (by rw [Array.size_set]; exact h.2.2)
  return adj

/-- Build the undirected rail graph. Vertices are way nodes deduplicated by
    rounded coordinate — a node shared by two ways becomes ONE vertex, which is
    what connects ways into a network — and are numbered in first-seen order.
    Edges are consecutive node pairs within a way, plus gap-bridge edges. Only
    train-carrying subtypes are included. -/
def buildRailGraph (lines : Array RailWay) (cloud : FixCloud) : RailGraph := Id.run do
  let mut vertices : Array Pt := #[]
  let mut adj : Array (Array Edge) := #[]
  let mut idByKey : Std.HashMap Verified.JsNum.CoordKey Nat := {}
  for line in lines do
    if !isRailSubtype line.subtype then continue
    -- `prev < 0` marks "no previous node in this way yet".
    let mut prev : Int := -1
    let mut prevPt : Pt := ⟨0, 0⟩
    for c in line.coords do
      let key := Verified.JsNum.coordKey7 c.lat c.lon
      let mut id : Nat := 0
      match idByKey[key]? with
      | some i => id := i
      | none =>
        id := vertices.size
        idByKey := idByKey.insert key id
        -- The vertex keeps the FIRST coordinate that mapped to it, while edge
        -- weights below use each way's own raw coordinates.
        vertices := vertices.push c
        adj := adj.push #[]
      if prev ≥ 0 && prev.toNat != id then
        let w := edgeWeight prevPt c cloud
        if h : prev.toNat < adj.size ∧ id < adj.size then
          have hp := h.1
          have hid := h.2
          -- `prev.toNat != id` above: distinct rows, read before written.
          let rowP := adj[prev.toNat].push ⟨id, w⟩
          let rowId := adj[id].push ⟨prev.toNat, w⟩
          adj := (adj.set prev.toNat rowP hp).set id rowId (by rw [Array.size_set]; exact hid)
      prev := Int.ofNat id
      prevPt := c
  return { vertices, adj := bridgeGaps vertices adj cloud }

/-! ## Dijkstra

The binary min-heap is reproduced element-for-element — the same shape as
`Verified.Geo.WalkableRoute`'s, because the TS duplicates it too. Relaxation is
on STRICT improvement, so among equal-cost routes the winner is decided by
which vertex the heap pops first. -/

/-- Priority and vertex travel together, so one bound covers both reads —
the two parallel arrays this used to hold shared a length only by discipline. -/
private structure Heap where
  items : Array (Float × Nat) := #[]
  deriving Inhabited

private def Heap.size (h : Heap) : Nat := h.items.size

private def Heap.push (h : Heap) (p : Float) (v : Nat) : Heap := Id.run do
  let mut items := h.items.push (p, v)
  let mut i := items.size - 1
  while i > 0 do
    let parent := (i - 1) / 2
    -- `i` starts at the last index and only moves to a parent, so it stays in
    -- range; the guard is the form the tactic accepts.
    if hi : i < items.size then
      have hp : parent < items.size := by omega
      let cur := items[i]
      let par := items[parent]
      -- The swap sits in the `else`, not after a `break`: see `bridgeGaps`.
      if par.1 ≤ cur.1 then
        break
      else
        items := (items.set i par hi).set parent cur (by rw [Array.size_set]; exact hp)
        i := parent
    else break
  return { items }

private def Heap.pop (h : Heap) : Option (Float × Nat) × Heap :=
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
      let mut s := i
      if hl : l < items.size then
        if hs' : s < items.size then
          if items[l].1 < items[s].1 then s := l
      if hr : r < items.size then
        if hs' : s < items.size then
          if items[r].1 < items[s].1 then s := r
      if s == i then break
      if hi : i < items.size then
        if hs2 : s < items.size then
          let cur := items[i]
          let sv := items[s]
          items := (items.set i sv hi).set s cur (by rw [Array.size_set]; exact hs2)
          i := s
        else break
      else break
    return (some top, { items })
  return (some top, { items })

/-- Dijkstra shortest path between two vertices — the vertex-id sequence from
    `src` to `dst`, or `none` when they are disconnected. -/
def shortestPath (graph : RailGraph) (src dst : Nat) : Option (Array Nat) := Id.run do
  let n := graph.vertices.size
  let mut dist : Array Float := Array.replicate n posInf
  let mut prev : Array Int := Array.replicate n (-1)
  let mut done : Array Bool := Array.replicate n false
  if hsrc : src < dist.size then dist := dist.set src 0 hsrc
  let mut heap : Heap := {}
  heap := heap.push 0 src
  while heap.size > 0 do
    let (cur, h') := heap.pop
    heap := h'
    match cur with
    | none => break
    | some (p, u) =>
      -- A vertex id is below `n` by construction (the heap only ever holds
      -- `src` and edge targets); an id that is not is skipped rather than
      -- read off the end.
      if hu : u < done.size ∧ u < graph.adj.size then
        -- Nested rather than `continue`d: see `bridgeGaps`.
        if !(done[u]'hu.1) then
          done := done.set u true hu.1
          if u == dst then break
          for e in graph.adj[u]'hu.2 do
            let nd := p + e.w
            if ht : e.to < dist.size ∧ e.to < prev.size then
              if nd < dist[e.to]'ht.1 then
                dist := dist.set e.to nd ht.1
                prev := prev.set e.to (Int.ofNat u) ht.2
                heap := heap.push nd e.to
  let some dDst := dist[dst]? | return none
  if !dDst.isFinite then return none
  let mut path : Array Nat := #[]
  let mut v : Int := Int.ofNat dst
  for _ in [0:n + 1] do
    if v == -1 then break
    path := path.push v.toNat
    match prev[v.toNat]? with
    | some pv => v := pv
    | none => break
  return some path.reverse

/-- The rail-graph vertex nearest a point. -/
def nearestVertex (graph : RailGraph) (p : Pt) : Option (Nat × Float) := Id.run do
  let mut bestId : Int := -1
  let mut bestD := posInf
  for hm_i : i in [0:graph.vertices.size] do
    let d := metersBetween p graph.vertices[i]
    if d < bestD then
      bestD := d
      bestId := Int.ofNat i
  if bestId < 0 then return none
  return some (bestId.toNat, bestD)

/-! ## Snapping -/

/-- One vertex of the snapped path, with an interpolated timestamp. -/
abbrev SnappedPoint := Verified.Geo.PathPt

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
  for hm_i : i in [1:coords.size] do
    have hb_i : i < coords.size := hm_i.upper
    let d := metersBetween coords[i - 1] coords[i]
    -- `cum` has `i` entries here; its last is the sum so far.
    cum := cum.push ((cum.back?.getD 0) + d)
  let total := cum.back?.getD 0
  let mut out : Array SnappedPoint := #[]
  for hm_i : i in [0:coords.size] do
    let c := coords[i]
    -- `cum.size = coords.size` by the loop above; an index past it would have
    -- read the `!` default of 0, which is what `getD 0` says out loud.
    let ts := if total > 0 then jsRound (startTs + (endTs - startTs) * ((cum[i]?.getD 0) / total)) else startTs
    out := out.push ⟨c.lat, c.lon, ts⟩
  return out

/-- The shared tail of both snappers: build the graph, route between the two
    resolved stations and time-interpolate the result. `none` on every refusal —
    no rail geometry, a station off the network, the two stations landing on one
    vertex, or no path — which means "draw the raw fixes", never a guessed
    line. -/
private def routeBetweenStations (seg : TrainSegment) (lines : Array RailWay) (cloud : FixCloud)
    (board alight : ResolvedStation) (line : Option String) : Option SnapResult := Id.run do
  let graph := buildRailGraph lines cloud
  if graph.vertices.isEmpty then return none
  match nearestVertex graph ⟨board.lat, board.lon⟩, nearestVertex graph ⟨alight.lat, alight.lon⟩ with
  | some (fromId, fromD), some (toId, toD) =>
    if fromD > maxStationToRailM || toD > maxStationToRailM then return none
    if fromId == toId then return none
    match shortestPath graph fromId toId with
    | none => return none
    | some idPath =>
      if idPath.size < 2 then return none
      -- Every id on the path is a vertex; `filterMap` states the bound the
      -- `!` assumed.
      let coords := idPath.filterMap (fun i => graph.vertices[i]?)
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
def snapTrainSegment (seg : TrainSegment) (lines : Array RailWay) (stations : Array OsmStation)
    (corridorFixes : Array Pt) : Option SnapResult := Id.run do
  match parseRailWayName (some seg.wayName) with
  | none => return none
  | some parsed =>
    match resolveStation parsed.board stations, resolveStation parsed.alight stations with
    | some board, some alight =>
      if board.name == alight.name then return none
      -- Without enough historic fixes there is no trustworthy corridor.
      if corridorFixes.size < minCloudFixes then return none
      return routeBetweenStations seg lines (FixCloud.ofFixes corridorFixes) board alight parsed.line
    | _, _ => return none

/--
Snap a confident train leg onto its KNOWN line, routing between the two named
stations over ONLY that line's ways, with NO historic fix cloud: when the label
carries a line name the LINE itself is the disambiguator, so the geometric
shortest path within that line's ways IS the ridden route. The restriction is
done here, with {@link wayOnLine} — nothing is asked of the caller beyond the
full way list.
-/
def snapTrainSegmentOnLine (seg : TrainSegment) (lines : Array RailWay)
    (stations : Array OsmStation) : Option SnapResult := Id.run do
  match parseRailWayName (some seg.wayName) with
  | none => return none
  | some parsed =>
    match parsed.line with
    | none => return none
    | some line =>
      match resolveStation parsed.board stations, resolveStation parsed.alight stations with
      | some board, some alight =>
        if board.name == alight.name then return none
        let lineLines := lines.filter (fun l => wayOnLine l.name line)
        if lineLines.isEmpty then return none
        -- An empty fix cloud gives every edge the same uniform penalty, so the
        -- search returns the geometric shortest path.
        return routeBetweenStations seg lineLines (FixCloud.ofFixes #[]) board alight (some line)
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
-- TRAM carries MAIN's endpoints but is not a train subtype, so it contributes
-- no vertices at all.
private def wayMain : RailWay :=
  ⟨some "Metropolitan Line", some "rail", #[P 0 0, P 0 250, P 0 500, P 0 750, P 0 1000]⟩
private def wayNorth : RailWay :=
  ⟨some "Piccadilly Line", some "subway", #[P 300 0, P 300 500, P 300 1000]⟩
private def wayConnMid : RailWay :=
  ⟨some "Metropolitan Line", some "rail", #[P 0 500, P 150 500, P 300 500]⟩
private def wayConnEnd : RailWay :=
  ⟨some "Metropolitan Line", some "rail", #[P 0 1000, P 150 1000, P 300 1000]⟩
private def waySpur : RailWay :=
  ⟨some "Metropolitan Line", some "rail", #[P 0 1010, P 0 1200]⟩
private def wayTram : RailWay :=
  ⟨some "Tram Line", some "tram", #[P 0 0, P 0 1000]⟩

private def allLines : Array RailWay :=
  #[wayMain, wayNorth, wayConnMid, wayConnEnd, waySpur, wayTram]

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
  let row := (g.adj[i]?).getD #[]
  row.size == expect.size &&
    (row.zip expect).all (fun (x, e) => x.to == e.1 && approx x.w e.2)

private def gAll : RailGraph := buildRailGraph allLines cMain
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

private def gNorth : RailGraph := buildRailGraph allLines cNorth
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

private def gMetro : RailGraph :=
  buildRailGraph #[wayMain, wayConnMid, wayConnEnd, waySpur] cEmpty
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

private def gPicc : RailGraph := buildRailGraph #[wayNorth] cEmpty
#guard gPicc.vertices.size == 3
#guard adjOk gPicc 0 #[(1, 12499.260310329435)]
#guard adjOk gPicc 1 #[(0, 12499.260310329435), (2, 12499.260310329435)]
#guard adjOk gPicc 2 #[(1, 12499.260310329435)]

private def gSplit : RailGraph := buildRailGraph #[wayMain, wayNorth] cMain
#guard gSplit.vertices.size == 8
#guard adjOk gSplit 0 #[(1, 250.00000000000043)]
#guard adjOk gSplit 1 #[(0, 250.00000000000043), (2, 249.99999999999946)]
#guard adjOk gSplit 2 #[(1, 249.99999999999946), (3, 250.00000000000043)]
#guard adjOk gSplit 3 #[(2, 250.00000000000043), (4, 249.99999999999946)]
#guard adjOk gSplit 4 #[(3, 249.99999999999946)]
#guard adjOk gSplit 5 #[(6, 5642.5232257983280)]
#guard adjOk gSplit 6 #[(5, 5642.5232257983280), (7, 5642.5232257983280)]
#guard adjOk gSplit 7 #[(6, 5642.5232257983280)]

-- A tram is not a train: the subtype filter leaves nothing to fuse.
private def gEmpty : RailGraph := buildRailGraph #[wayTram] cMain
#guard gEmpty.vertices.size == 0
#guard (buildRailGraph #[] cMain).vertices.size == 0

-- Fusion, stated directly: the shared nodes land on the vertices the
-- adjacency rows above address.
#guard gAll.vertices[2]! == P 0 500 && gAll.vertices[4]! == P 0 1000

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

private def snapMain := snapTrainSegment segAB allLines stations (cloudAlong 0 21)
#guard (snapMain.map (·.board.name)) == some "Alpha"
#guard (snapMain.map (·.alight.name)) == some "Beta"
#guard (snapMain.bind (·.line)).isNone
#guard pathTs snapMain == #[1000, 1075, 1150, 1225, 1300]
#guard (pathLon snapMain).size == 5
#guard approx (pathLon snapMain)[4]! (-0.11556330146882557)

/-- The cloud, not the geometry, picks the route: fixes along the NORTH line
    make the 1600 m detour cheaper than the 1000 m direct run. -/
private def snapNorth := snapTrainSegment segAB allLines stations (cloudAlong 300 21)
#guard pathTs snapNorth == #[1000, 1047, 1094, 1122, 1150, 1244, 1272, 1300]
#guard approx (pathLon snapNorth)[3]! (-0.12278165073441279)

#guard (snapTrainSegment segAB allLines stations (cloudAlong 0 11)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha - Beta"⟩ allLines stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Zeta"⟩ allLines stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Alpha"⟩ allLines stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment ⟨1000, 1300, "Alpha → Nowhere"⟩ allLines stations (cloudAlong 0 21)).isNone
#guard (snapTrainSegment segAB #[wayTram] stations (cloudAlong 0 21)).isNone

-- snapTrainSegmentOnLine
private def snapMetro :=
  snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta · Metropolitan Line"⟩ allLines stations
#guard (snapMetro.bind (·.line)) == some "Metropolitan Line"
#guard pathTs snapMetro == #[1000, 1075, 1150, 1225, 1300]

private def snapPicc :=
  snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Gamma · Piccadilly Line"⟩ allLines stations
#guard (snapPicc.bind (·.line)) == some "Piccadilly Line"
#guard pathTs snapPicc == #[1000, 1150, 1300]
#guard approx (pathLon snapPicc)[0]! (-0.13000000000000000)

#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta"⟩ allLines stations).isNone
-- No way carries this line, so the `wayOnLine` filter empties the network.
#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Beta · Bakerloo Line"⟩ allLines stations).isNone
#guard (snapTrainSegmentOnLine ⟨1000, 1300, "Alpha → Alpha · Metropolitan Line"⟩ allLines stations).isNone

end Guards

end Verified.Geo.RailSnap
