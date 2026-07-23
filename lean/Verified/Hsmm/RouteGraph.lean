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
  | some d => (s.dropRight d.length).trim
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
    let cleaned := stripDirectional n.trim
    let stripped? : Option String :=
      if cleaned.endsWith " Lines" then some (cleaned.dropRight " Lines".length)
      else if cleaned.endsWith " Line" then some (cleaned.dropRight " Line".length)
      else none
    match stripped? with
    | none => []
    | some stripped =>
      let parts := (stripped.splitOn " and ").flatMap (fun andPart => andPart.splitOn ", ")
      dedup (parts.filterMap (fun commaPart =>
        let trimmed := commaPart.trim
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

end Verified.Hsmm.RouteGraph
