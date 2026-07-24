import Std.Data.HashMap
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

end Verified.Hsmm.RouteGraph
