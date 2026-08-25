import Std.Data.HashMap
import Verified.JsNum
/-!
# Route-graph primitives (implementation-first port of `route-graph.ts`)

Pure primitives the HSMM route factors need from the OSM route graph:

  - `parseLineMemberships` — an OSM way's `name` tag → the set of tube lines it
    carries (strip "… Eastbound", split "Circle, Hammersmith & City and
    Metropolitan Lines"). Pure string work, EXACT.
  - `pointToPolylineMeters` — min perpendicular distance from a point to a
    track polyline (equirectangular projection, clamped per segment). Uses
    `cos` and a `sqrt(x²+y²)` magnitude (V8 uses `Math.hypot`, which differs by
    ≤1 ULP), so distances are ULP-close (on-segment zeros stay exact) — the same
    accepted class as `haversine`.

UNPROVEN; pinned by the `#guard`s.

(The grid index, `edgesNear`, and line connectivity are the larger follow-on.)
-/

namespace Verified.Hsmm.RouteGraph

def M_PER_DEG_LAT : Float := 111320
private def pi : Float := 3.141592653589793

/-- Directional suffixes OSM appends to distinguish parallel tracks; the line
    membership is the same either way. Order matters (first match wins). -/
def DIRECTIONALS : List String :=
  [" Eastbound", " Westbound", " Northbound", " Southbound", " Inner Rail", " Outer Rail"]

/-- Strip a trailing directional (first match), re-trimming after. -/
def stripDirectional (s : String) : String :=
  match DIRECTIONALS.find? (fun d => s.endsWith d) with
  | some d => (s.dropEnd d.length).trimAscii.toString
  | none => s

/-- Append-preserving dedup (mirrors JS `Set` insertion-order iteration). -/
def dedup (xs : List String) : List String :=
  xs.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) []

/-- OSM way `name` → the tube lines it carries. Empty for names not ending in
    "Line"/"Lines". -/
def parseLineMemberships (name : Option String) : List String :=
  match name with
  | none => []
  | some n =>
    if n == "" then [] else
    let cleaned := stripDirectional n.trimAscii.toString
    let stripped? : Option String :=
      if cleaned.endsWith " Lines" then some (cleaned.dropEnd " Lines".length).toString
      else if cleaned.endsWith " Line" then some (cleaned.dropEnd " Line".length).toString
      else none
    match stripped? with
    | none => []
    | some stripped =>
      let parts := (stripped.splitOn " and ").flatMap (fun andPart => andPart.splitOn ", ")
      dedup (parts.filterMap (fun commaPart =>
        let trimmed := commaPart.trimAscii.toString
        if trimmed.isEmpty then none else some (trimmed ++ " Line")))

-- Parity with the real `parseLineMemberships` (Node/V8; Set → insertion-ordered list).
#guard parseLineMemberships (some "Metropolitan Line") == ["Metropolitan Line"]
#guard parseLineMemberships (some "Hammersmith & City Line") == ["Hammersmith & City Line"]
#guard parseLineMemberships (some "Circle, Hammersmith & City and Metropolitan Lines")
  == ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
#guard parseLineMemberships (some "Metropolitan and Piccadilly Line")
  == ["Metropolitan Line", "Piccadilly Line"]
#guard parseLineMemberships (some "Jubilee Line Eastbound") == ["Jubilee Line"]
#guard parseLineMemberships (some "Metropolitan Line Westbound") == ["Metropolitan Line"]
#guard parseLineMemberships (some "District Line Inner Rail") == ["District Line"]
#guard parseLineMemberships (some "Not A Railway") == []
#guard parseLineMemberships (some "") == []
#guard parseLineMemberships none == []
#guard parseLineMemberships (some "Bakerloo Lines") == ["Bakerloo Line"]
#guard parseLineMemberships (some "A, B and C Lines") == ["A Line", "B Line", "C Line"]

/-- A lon/lat vertex of a track polyline. -/
structure LatLon where
  lat : Float
  lon : Float
  deriving Inhabited

/-- Perpendicular distance (m) from a point to one polyline segment `a→b`,
    clamped at the endpoints. Local-flat-Earth Cartesian (scaled degrees). -/
def pointToSegmentMeters (lat lon : Float) (a b : LatLon) : Float :=
  let cosRefLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  let pX := (lon - a.lon) * M_PER_DEG_LAT * cosRefLat
  let pY := (lat - a.lat) * M_PER_DEG_LAT
  let dX := (b.lon - a.lon) * M_PER_DEG_LAT * cosRefLat
  let dY := (b.lat - a.lat) * M_PER_DEG_LAT
  let len2 := dX * dX + dY * dY
  if len2 == 0 then Float.sqrt (pX * pX + pY * pY)
  else
    let t := max 0 (min 1 ((pX * dX + pY * dY) / len2))
    let projX := t * dX
    let projY := t * dY
    Float.sqrt ((pX - projX) * (pX - projX) + (pY - projY) * (pY - projY))

/-- Min distance (m) from a point to a polyline: the minimum over its segments.
    Empty / single-vertex geometry has no segment → `+∞` (as in TS). -/
def pointToPolylineMeters (lat lon : Float) (geometry : List LatLon) : Float :=
  ((List.range (geometry.length - 1)).foldl (fun best i =>
    let d := pointToSegmentMeters lat lon geometry[i]! geometry[i+1]!
    if d < best then d else best) (1.0 / 0.0))

/-- ULP tolerance for the `hypot` / `cos` wobble (see module header). -/
private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-6

private def geom : List LatLon := [⟨51.5, -0.1⟩, ⟨51.51, -0.1⟩, ⟨51.51, -0.08⟩]

-- Parity with the real `pointToPolylineMeters` (Node/V8). On-segment → exact 0;
-- off-segment distances are ULP-close (approx).
#guard pointToPolylineMeters 51.505 (-0.1) geom == 0
#guard pointToPolylineMeters 51.51 (-0.09) geom == 0
#guard approx (pointToPolylineMeters 51.5 (-0.05) geom) 2357.8274447064964
#guard approx (pointToPolylineMeters 51.52 (-0.08) geom) 1113.2000000005696

/-! ## Spatial index + `edgesNear`

The grid buckets every edge into every ~500 m cell any of its geometry vertices
touches, so `edgesNear` scans only the local 3×3 cell neighbourhood. The grid is
COARSE (bucketed by vertices, not swept segments) — that is load-bearing: it can
miss an edge whose segment crosses the query cell while its vertices don't, and
this port reproduces that exactly. Cell keys are internal (never cross the
JS↔Lean boundary), so they use `(Int, Int)` rather than V8's `"cy:cx"` strings.
-/

/-- A route edge for spatial queries: stable id + ordered geometry. -/
structure Edge where
  id : String
  geometry : List LatLon
  deriving Inhabited

def GRID_CELL_DEG_LAT : Float := 0.0045
def GRID_CELL_DEG_LON : Float := 0.007

/-- Grid cell containing a coordinate. `Float.floor` then `toInt64` matches JS
    `Math.floor` (including for negatives). -/
def cellOf (lat lon : Float) : Int × Int :=
  ((lat / GRID_CELL_DEG_LAT).floor.toInt64.toInt, (lon / GRID_CELL_DEG_LON).floor.toInt64.toInt)

/-- The 3×3 cell neighbourhood, in V8's iteration order (dy −1..1 outer,
    dx −1..1 inner). -/
def neighborCells (lat lon : Float) : List (Int × Int) :=
  let (cy, cx) := cellOf lat lon
  (List.range 3).flatMap (fun dy => (List.range 3).map (fun dx =>
    (cy + Int.ofNat dy - 1, cx + Int.ofNat dx - 1)))

/-- Unique cells an edge touches (dedup mirrors the TS per-edge `Set`). -/
def edgeCells (e : Edge) : List (Int × Int) :=
  e.geometry.foldl (fun acc p =>
    let c := cellOf p.lat p.lon
    if acc.contains c then acc else acc ++ [c]) []

/-- Bucket every edge (by index) into each cell it touches, in edge order. -/
def buildCellIndex (edges : Array Edge) : Std.HashMap (Int × Int) (Array Nat) :=
  (List.range edges.size).foldl (fun idx i =>
    (edgeCells edges[i]!).foldl (fun idx c => idx.insert c ((idx.getD c #[]).push i)) idx)
    {}

/-- Edges whose geometry passes within `radiusM` of `(lat, lon)`. Scans the 3×3
    neighbourhood, dedups by edge (first-seen order), keeps those within radius —
    same output set AND order as the TS `edgesNear`. -/
def edgesNear (edges : Array Edge) (idx : Std.HashMap (Int × Int) (Array Nat))
    (lat lon radiusM : Float) : Array Edge :=
  ((neighborCells lat lon).foldl (fun (st : Array Edge × Array Nat) c =>
    (idx.getD c #[]).foldl (fun (st : Array Edge × Array Nat) i =>
      if st.2.contains i then st
      else
        let e := edges[i]!
        let d := pointToPolylineMeters lat lon e.geometry
        if d ≤ radiusM then (st.1.push e, st.2.push i) else (st.1, st.2.push i))
      st) (#[], #[])).1

-- Parity with the real `edgesNear` (ids + order from Node/V8's `buildRouteGraph`).
private def spatialEdges : Array Edge := #[
  ⟨"way:1", [⟨51.5, -0.10⟩, ⟨51.5, -0.09⟩, ⟨51.5, -0.08⟩]⟩,
  ⟨"way:2", [⟨51.505, -0.10⟩, ⟨51.505, -0.08⟩]⟩,
  ⟨"way:3", [⟨52.0, -0.10⟩, ⟨52.0, -0.08⟩]⟩]
private def spatialIdx : Std.HashMap (Int × Int) (Array Nat) := buildCellIndex spatialEdges

#guard ((edgesNear spatialEdges spatialIdx 51.501 (-0.095) 300).map Edge.id).toList == ["way:1"]
#guard ((edgesNear spatialEdges spatialIdx 51.5025 (-0.095) 700).map Edge.id).toList == ["way:1", "way:2"]
#guard ((edgesNear spatialEdges spatialIdx 51.5025 (-0.095) 100).map Edge.id).toList == []

/-! ## Per-edge attributes

The last two pure leaves of `route-graph.ts`. Both are module-PRIVATE there, so
the reference values below come from driving `buildRouteGraph` and reading the
`attrs.underground` / `attrs.lengthM` it publishes — the same approach the
episode-geometry port used for its three private helpers.
-/

/-- Great-circle metres. `route-graph.ts` carries its own copy of the same
formula `place-snap.ts` exports; identical constants, identical result. -/
def haversineMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let R := 6371000.0
  let dLat := (lat2 - lat1) * pi / 180.0
  let dLon := (lon2 - lon1) * pi / 180.0
  let sLat := Float.sin (dLat / 2.0)
  let sLon := Float.sin (dLon / 2.0)
  let a := sLat * sLat + Float.cos (lat1 * pi / 180.0) * Float.cos (lat2 * pi / 180.0) * sLon * sLon
  R * 2.0 * Float.atan2 (Float.sqrt a) (Float.sqrt (1.0 - a))

/-- JS `Number(s)` narrowed to what an OSM `layer` value can be: an optional
minus sign and digits. Anything else is `NaN` in the TS, and every comparison
with `NaN` is false — modelled here as `none`. -/
private def jsIntegerLayer? (s : String) : Option Float :=
  let (neg, digits) := if s.startsWith "-" then (true, s.drop 1) else (false, s)
  if digits.isEmpty || !digits.all Char.isDigit then none
  else some (if neg then -(Float.ofNat digits.toNat!) else Float.ofNat digits.toNat!)

/-- Whether an OSM way runs below the surface. A SOFT UNION of the four
conventions OSM uses to mean it, plus the subtype: any `tunnel` value other than
`"no"`, a negative `layer`, `covered=yes`, `subway=yes`, or `subtype=subway`.

An unparseable `layer` means "not underground" rather than an error, because
`NaN < 0` is false. And `covered`/`subway` test `=== "yes"` exactly — so
`covered=no` is not underground — while `tunnel` tests `!== "no"`, so
`tunnel=building_passage` IS. That asymmetry is in the TS; both arms are pinned.

`tags` is an association list rather than a map because only membership and one
value are read, and the order the shell parsed them in is irrelevant. -/
def isUnderground (tags : List (String × String)) (subtype : Option String) : Bool :=
  let get (k : String) : Option String := (tags.find? (·.1 == k)).map (·.2)
  if (get "tunnel").any (· != "no") then true
  else if (get "layer").any (fun l => (jsIntegerLayer? l).any (· < 0)) then true
  else get "covered" == some "yes" || get "subway" == some "yes" || subtype == some "subway"

/-- Total length (m) of a polyline: the haversine sum over its legs. A geometry
with fewer than two vertices has no leg and measures 0 — unreachable through
`buildRouteGraph`, which drops such a way before building an edge at all, so
that arm is stated by the definition rather than pinned against V8. -/
def geometryLengthM (geom : List LatLon) : Float :=
  (List.range (geom.length - 1)).foldl
    (fun total i => total + haversineMeters geom[i]!.lat geom[i]!.lon geom[i+1]!.lat geom[i+1]!.lon) 0

-- Parity via `buildRouteGraph`'s published `attrs` (Node/V8).
private def undergroundOf (tunnel layer covered subway subtype : Option String) : Bool :=
  isUnderground
    ([("tunnel", tunnel), ("layer", layer), ("covered", covered), ("subway", subway)].filterMap
      (fun (k, v) => v.map (k, ·)))
    subtype

#guard undergroundOf (some "yes") none none none none == true
-- Any non-"no" tunnel value counts.
#guard undergroundOf (some "building_passage") none none none none == true
#guard undergroundOf (some "no") none none none none == false
#guard undergroundOf none (some "-1") none none none == true
#guard undergroundOf none (some "1") none none none == false
-- `Number("not-a-number")` is NaN, and `NaN < 0` is false.
#guard undergroundOf none (some "not-a-number") none none none == false
#guard undergroundOf none none (some "yes") none none == true
-- `covered` and `subway` test equality with "yes", unlike `tunnel`'s "≠ no" —
-- so a THIRD value separates the two rules, and only these two guards do.
#guard undergroundOf none none (some "no") none none == false
#guard undergroundOf none none (some "roof") none none == false
#guard undergroundOf none none none (some "yes") none == true
#guard undergroundOf none none none (some "maybe") none == false
#guard undergroundOf none none none none (some "subway") == true
#guard undergroundOf none none none none none == false

private def track : List LatLon := [⟨51.52, -0.13⟩, ⟨51.53, -0.13⟩, ⟨51.53, -0.11⟩]

#guard approx (geometryLengthM track) 2495.4471666856225
#guard approx (geometryLengthM [⟨51.52, -0.13⟩, ⟨51.52, -0.129⟩]) 69.19008871082293
-- No leg, no length. Not reachable through `buildRouteGraph` (see the docstring).
#guard geometryLengthM [⟨51.52, -0.13⟩] == 0
#guard geometryLengthM [] == 0

/-! ## Assembling the wire graph from raw OSM rows

⚠ This is `route-graph.ts`'s `buildRouteGraph`, narrowed to what actually
crosses to `parseAssemble`: `{id, geometry, lineMemberships, underground,
startNode, endNode}` per edge and `{id, lat, lon, stationName, edgeIds}` per
node. The TypeScript's `RouteGraph` additionally carries a cell index, per-edge
`lengthM` and endpoint copies — all of which Lean REBUILDS in
`buildRouteGraphModel`, so shipping them would be shipping a second copy of an
index the receiver constructs anyway.

The shell supplies rows with the WKT already parsed (a format concern) and
nothing else: `isUnderground`, `parseLineMemberships`, the node keying and the
station merge all happen here. -/

/-- One OSM way as the shell hands it over. -/
structure RawWay where
  id : String
  geometry : List LatLon
  name : Option String
  subtype : Option String
  tags : List (String × String)
  deriving Inhabited

/-- One OSM point that might be a station. -/
structure RawStop where
  lat : Float
  lon : Float
  name : Option String
  tags : List (String × String)
  deriving Inhabited

/-- ⚠ FIVE DECIMAL PLACES, and the identity of a node is this string. `toFixed(5)`
is ~1.1 m of latitude: two way endpoints that meet at a junction agree to 5 dp
and fuse into one node; a sixth place would split junctions that are the same
place, and a fourth would fuse ones that are not. -/
def nodeKey (lat lon : Float) : String :=
  -- ⚠ `toFixed` is `Option` because JS `toFixed` is undefined past 1e21. A
  -- coordinate can never reach that, and a silent "" here would fuse every such
  -- node into one, so the fallback is the raw value rather than empty.
  let f := fun (x : Float) => (Verified.JsNum.toFixed x 5).getD (toString x)
  s!"{f lat},{f lon}"

/-- A POI within this distance of a way endpoint IS that station. Tube station
POIs sit at the street entrance, 50-150 m from the platform-aligned endpoint of
the underground way — the hall, escalators and gates are that far above the
platform. 150 m is the upper end at which every London Tube POI attaches; the
candidate generator applies a wider 250 m and lets the scorer weigh it softly. -/
def STATION_MERGE_RADIUS_M : Float := 150

private def stopTag (tags : List (String × String)) (k : String) : Option String :=
  (tags.find? (fun p => p.1 == k)).map (·.2)

/-- Does this POI name a rail/transit stop at all? -/
def isStationStop (tags : List (String × String)) : Bool :=
  let is (k v : String) := stopTag tags k == some v
  is "railway" "station" || is "railway" "stop" || is "railway" "halt"
    || is "public_transport" "station" || is "public_transport" "stop_position"
    || is "subway" "yes" || is "amenity" "tram_stop" || is "highway" "bus_stop"

structure WireEdge where
  id : String
  geometry : List LatLon
  lineMemberships : List String
  underground : Bool
  startNode : String
  endNode : String
  deriving Inhabited

structure WireNode where
  id : String
  lat : Float
  lon : Float
  stationName : Option String
  edgeIds : List String
  deriving Inhabited

/--
Build the edge and node arrays `parseAssemble` consumes.

⚠ A way with fewer than two vertices is DROPPED, matching the TypeScript. It has
no endpoints to key on, so it could not join the graph regardless.

⚠ Node order follows FIRST APPEARANCE of each key across the ways, because the
receiver reads `nodes` as an ordered array (`StationChain` documents four things
downstream that depend on it). A map iteration or a sort would reorder it while
looking like a tidy-up.
-/
def buildWireGraph (ways : List RawWay) (stops : List RawStop) :
    Array WireEdge × Array WireNode := Id.run do
  let mut edges : Array WireEdge := #[]
  -- (key, lat, lon, edgeIds) in first-appearance order.
  let mut nodes : Array (String × Float × Float × Array String) := #[]
  let mut idx : Std.HashMap String Nat := {}
  for w in ways do
    match w.geometry, w.geometry.getLast? with
    | first :: _, some last =>
      if w.geometry.length < 2 then continue
      let sk := nodeKey first.lat first.lon
      let ek := nodeKey last.lat last.lon
      edges := edges.push
        { id := w.id, geometry := w.geometry
        , lineMemberships := parseLineMemberships w.name
        , underground := isUnderground w.tags w.subtype
        , startNode := sk, endNode := ek }
      for (k, p) in [(sk, first), (ek, last)] do
        match idx[k]? with
        | some i =>
          let (kk, la, lo, ids) := nodes[i]!
          if !ids.contains w.id then nodes := nodes.set! i (kk, la, lo, ids.push w.id)
        | none =>
          idx := idx.insert k nodes.size
          nodes := nodes.push (k, p.lat, p.lon, #[w.id])
    | _, _ => pure ()
  -- Station annotation: nearest node endpoint within the merge radius wins.
  let mut named : Std.HashMap String String := {}
  for s in stops do
    if !isStationStop s.tags then continue
    let mut best : Option (String × Float) := none
    for (k, la, lo, _) in nodes do
      let d := haversineMeters s.lat s.lon la lo
      if decide (d ≤ STATION_MERGE_RADIUS_M) then
        match best with
        | some (_, bd) => if decide (d < bd) then best := some (k, d)
        | none => best := some (k, d)
    match best, s.name with
    | some (k, _), some nm => named := named.insert k nm
    | _, _ => pure ()
  let outNodes := nodes.map fun (k, la, lo, ids) =>
    ({ id := k, lat := la, lon := lo, stationName := named[k]?, edgeIds := ids.toList } : WireNode)
  return (edges, outNodes)

/-! ### `buildWireGraph` -/

private def W (id : String) (pts : List (Float × Float)) (nm : Option String) : RawWay :=
  { id := id, geometry := pts.map (fun (a, b) => ⟨a, b⟩), name := nm
  , subtype := some "subway", tags := [] }

private def twoWays : List RawWay :=
  [ W "way:1" [(51.50000, -0.10000), (51.51000, -0.09000)] (some "Jubilee Line")
  , W "way:2" [(51.51000, -0.09000), (51.52000, -0.08000)] (some "Jubilee Line") ]

-- Two ways meeting at one point share ONE node, so the graph is connected.
#guard (buildWireGraph twoWays []).2.size == 3
#guard (buildWireGraph twoWays []).1.size == 2
-- ⚠ The shared endpoint carries BOTH edge ids. A node that listed one would
-- disconnect the graph while still looking like a node.
#guard ((buildWireGraph twoWays []).2.find? (fun n => n.edgeIds.length == 2)).isSome
-- Node identity is the 5-dp key, so the junction fuses rather than duplicating.
#guard nodeKey 51.5 (-0.1) == "51.50000,-0.10000"
#guard nodeKey 51.500001 (-0.1) == nodeKey 51.5 (-0.1)
-- ⚠ A sixth place would NOT fuse them; this is the boundary the identity rests on.
#guard nodeKey 51.50001 (-0.1) != nodeKey 51.5 (-0.1)
-- Line memberships come from the name, in Lean, not from the caller.
#guard ((buildWireGraph twoWays []).1[0]!).lineMemberships == ["Jubilee Line"]
-- A way with one vertex has no endpoints and is dropped.
#guard (buildWireGraph [W "way:x" [(51.5, -0.1)] none] []).1.size == 0
-- A stop within 150 m names the node; one beyond it does not.
#guard ((buildWireGraph twoWays
    [{ lat := 51.50050, lon := -0.10000, name := some "Somewhere"
     , tags := [("railway", "station")] }]).2.find?
      (fun n => n.stationName == some "Somewhere")).isSome
#guard ((buildWireGraph twoWays
    [{ lat := 51.60000, lon := -0.10000, name := some "Far"
     , tags := [("railway", "station")] }]).2.find?
      (fun n => n.stationName.isSome)).isNone
-- ⚠ A POI that is not a stop never names a node, however close it sits.
#guard ((buildWireGraph twoWays
    [{ lat := 51.50000, lon := -0.10000, name := some "A Cafe"
     , tags := [("amenity", "cafe")] }]).2.find?
      (fun n => n.stationName.isSome)).isNone

end Verified.Hsmm.RouteGraph
