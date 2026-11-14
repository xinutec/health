import Verified.Hsmm.FloatScore
/-!
# OSM spatial kernel

The OSM distance queries as definitions rather than SQL, so station selection
is something a theorem can be stated about (`docs/proposals/2026-07-osm-into-lean.md`).
The database ships rows and computes nothing.

The distance uses `FloatScore.haversineMeters` (radius 6371000). MariaDB's
`ST_Distance_Sphere` uses 6370986 m; both are below, and the 2.2 ppm difference
can only flip a feature within 0.22 mm of a 100 m bar.

The `MBRIntersects` pre-filter is not modelled: its box understates metres per
degree on both axes, so it strictly contains the radius circle and is an index
accelerator, not a predicate.

UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.OsmSpatial

open Verified.Hsmm.FloatScore (haversineMeters)

/-- MariaDB 12.3.2 `ST_Distance_Sphere`'s sphere. -/
def MARIA_EARTH_R : Float := 6370986
/-- The radius `FloatScore.haversineMeters` uses, and the one this kernel
adopts as the definition. -/
def LEAN_EARTH_R : Float := 6371000

/-- Great-circle distance on a sphere of the given radius — the same formula
`FloatScore.haversineMeters` uses, with the radius made explicit so the
MariaDB-compatible and native answers can be compared. -/
def haversineAt (R lat1 lon1 lat2 lon2 : Float) : Float :=
  let toRad := fun (d : Float) => d * 3.141592653589793 / 180
  let dLat := toRad (lat2 - lat1)
  let dLon := toRad (lon2 - lon1)
  let sLat := Float.sin (dLat / 2)
  let sLon := Float.sin (dLon / 2)
  let a := sLat * sLat + Float.cos (toRad lat1) * Float.cos (toRad lat2) * sLon * sLon
  R * 2 * Float.atan2 (Float.sqrt a) (Float.sqrt (1 - a))

/-- A row of `osm_points` as the pushed table carries it. -/
structure PointRow where
  osmId : Int
  subtype : String
  name : Option String
  lat : Float
  lon : Float
  /-- The feature's OSM tags. Only `station` and `tram` are read here. -/
  tags : Array (String × String) := #[]
  deriving Inhabited, BEq, Repr

/-- A row with its distance to the query point resolved. -/
structure ScoredPoint where
  row : PointRow
  distanceM : Float
  deriving Inhabited, BEq, Repr

/-- `queryPoints`: rows strictly inside the radius, of a wanted subtype, by
distance, capped at 50. The cap binds for `nearbyWays`, whose dense-London
highway bucket fills it, so a better line metric can lose a way (see
`lineDistDeg`). -/
def queryPoints (rows : Array PointRow) (lat lon radiusM : Float)
    (subtypes : Array String := #[]) (R : Float := LEAN_EARTH_R) : Array ScoredPoint :=
  let scored := rows.map fun r => { row := r, distanceM := haversineAt R lat lon r.lat r.lon }
  let inRadius := scored.filter fun s => s.distanceM < radiusM
  let wanted :=
    if subtypes.isEmpty then inRadius
    else inRadius.filter fun s => subtypes.contains s.row.subtype
  -- A stable sort (`mergeSort` with `≤`): equal distances keep the order the
  -- rows arrived in.
  let ordered := (wanted.toList.mergeSort fun a b => a.distanceM ≤ b.distanceM).toArray
  ordered.extract 0 (min 50 ordered.size)

/-- The subtypes `nearbyStations` asks for. -/
def STATION_SUBTYPES : Array String := #["station", "subway_entrance", "halt", "stop", "tram_stop"]

private def tag (r : PointRow) (k : String) : Option String :=
  (r.tags.find? fun kv => kv.1 == k).map (·.2)

/-- `deriveStationSubtype`. An entrance and a platform stop keep their own
subtypes so the picker can deprioritise them — OSM labels entrance nodes "A", "B", "C", and one would
otherwise beat the real station node on distance for a passing fix. -/
def deriveStationSubtype (r : PointRow) : String :=
  if r.subtype == "subway_entrance" then "subway_entrance"
  -- A `railway=stop` is a platform position, not the station, so it ranks
  -- below every station node; read as "rail" a platform 19 m off outranked the
  -- tube station 119 m off.
  else if r.subtype == "stop" then "stop_position"
  else if tag r "station" == some "subway" then "subway"
  else if tag r "station" == some "light_rail" then "light_rail"
  else if tag r "tram" == some "yes" || r.subtype == "tram_stop" then "tram"
  else if r.subtype == "halt" then "halt"
  else "rail"

/-- A station as the algorithm consumes it. -/
structure NearbyStation where
  name : String
  subtype : String
  distanceM : Float
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- `dedupeStationsByName`. A station and its entrances share a name, and a
naive keep-closest picks the entrance, which the caller then filters out,
losing the station. So a station-typed record beats an entrance-typed one
whatever the distance; distance decides within a kind, and stations of
different subtypes are both kept. Unnamed features are dropped. Arrival is
distance order, so map order shows only on exact ties. -/
def dedupeStationsByName (scored : Array ScoredPoint) : Array NearbyStation := Id.run do
  let mut best : Array NearbyStation := #[]
  for s in scored do
    match s.row.name with
    | none => pure ()
    | some nm =>
      let cand : NearbyStation :=
        { name := nm, subtype := deriveStationSubtype s.row, distanceM := s.distanceM
          lat := s.row.lat, lon := s.row.lon }
      -- Same name and kind collapse; different station subtypes are two
      -- stations at one site (tube and mainline King's Cross), both kept.
      let entrance := fun (x : NearbyStation) => x.subtype == "subway_entrance"
      match best.findFinIdx? (fun b => b.name == nm &&
          (b.subtype == cand.subtype || entrance b || entrance cand)) with
      | none =>
        best := best.push cand
      | some i =>
        let cur := best[i]
        let curIsEntrance := cur.subtype == "subway_entrance"
        let candIsEntrance := cand.subtype == "subway_entrance"
        if curIsEntrance && !candIsEntrance then
          best := best.set i cand
        else if curIsEntrance == candIsEntrance && cand.distanceM < cur.distanceM then
          best := best.set i cand
  return (best.toList.mergeSort fun a b => a.distanceM ≤ b.distanceM).toArray

/-- `nearbyStations` end to end, over a pushed row table. -/
def nearbyStations (rows : Array PointRow) (lat lon radiusM : Float)
    (R : Float := LEAN_EARTH_R) : Array NearbyStation :=
  dedupeStationsByName (queryPoints rows lat lon radiusM STATION_SUBTYPES R)

/-! ## Reference values -/

section SpatialGuards

private def QLAT : Float := 51.5492
private def QLON : Float := -0.2215
private def MDEG : Float := 111194.68229846345

private def pr (osmId : Int) (subtype : String) (name : Option String) (lat lon : Float)
    (tags : Array (String × String) := #[]) : PointRow :=
  { osmId, subtype, name, lat, lon, tags }

private def FEATURES : Array PointRow :=
  #[pr 1 "station" (some "Willesden Green") 51.54925 (-0.22095),
    pr 2 "subway_entrance" (some "Willesden Green") 51.54921 (-0.22141),
    pr 3 "subway_entrance" (some "Willesden Green") 51.54935 (-0.22162),
    pr 4 "subway_entrance" (some "Dollis Hill") 51.54928 (-0.22148),
    pr 5 "station" (some "Dollis Hill") 51.5520 (-0.2390),
    pr 6 "halt" (some "Far Halt") 51.5600 (-0.2500),
    pr 7 "tram_stop" none 51.54930 (-0.22120),
    pr 8 "station" (some "Just In") (QLAT + 99 / MDEG) QLON,
    pr 9 "station" (some "Just Out") (QLAT + 101 / MDEG) QLON,
    pr 10 "level_crossing" (some "Not A Station") 51.54926 (-0.22130),
    -- A second Dollis Hill entrance. Its station is out of range, so the winner
    -- here is decided by the same-kind distance rule and survives to the output —
    -- unlike Willesden Green, where the station outranks both entrances anyway.
    pr 12 "subway_entrance" (some "Dollis Hill") 51.54940 (-0.22180),
    pr 11 "station" (some "On The Bar") (QLAT + 100 / MDEG) QLON]

private def approxD (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def ids (q : Array ScoredPoint) : Array Int := q.map (·.row.osmId)

-- The two spheres, on the same geometry. Both are pinned so the re-bless delta
-- is a measured quantity: at 38 m the answers differ by 8.4e-5 m.
#guard approxD (haversineAt MARIA_EARTH_R QLAT QLON 51.54925 (-0.22095)) 38.434289529776485
#guard approxD (haversineAt LEAN_EARTH_R QLAT QLON 51.54925 (-0.22095)) 38.43437398766941
#guard approxD (haversineAt MARIA_EARTH_R QLAT QLON (QLAT + 99 / MDEG) QLON) 99.00000000004454
#guard approxD (haversineAt LEAN_EARTH_R QLAT QLON (QLAT + 99 / MDEG) QLON) 99.00021754878816

-- The radius bar is strict and the subtype filter drops the level crossing:
-- 99 m is kept, 100.0000000003 and 101 are not, under either sphere.
#guard ids (queryPoints FEATURES QLAT QLON 100 STATION_SUBTYPES MARIA_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8]
#guard ids (queryPoints FEATURES QLAT QLON 100 STATION_SUBTYPES LEAN_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8]
#guard ids (queryPoints FEATURES QLAT QLON 400 STATION_SUBTYPES LEAN_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8, 11, 9]
-- No latitude gives exactly 100 m, so strictness is pinned by setting the
-- radius to a feature's own distance: `<` excludes it, `≤` would keep it.
#guard ids (queryPoints FEATURES QLAT QLON
  (haversineAt LEAN_EARTH_R QLAT QLON (QLAT + 99 / MDEG) QLON) STATION_SUBTYPES LEAN_EARTH_R)
  == #[2, 4, 3, 7, 12, 1]
-- With no subtype filter the level crossing survives, ordered on distance.
#guard ids (queryPoints FEATURES QLAT QLON 100 #[] LEAN_EARTH_R) == #[2, 4, 10, 3, 7, 12, 1, 8]

-- `deriveStationSubtype` over every arm.
private def dsub (subtype : String) (tags : Array (String × String)) : String :=
  deriveStationSubtype (pr 0 subtype none 0 0 tags)
#guard dsub "subway_entrance" #[("station", "subway")] == "subway_entrance"
#guard dsub "station" #[("station", "subway")] == "subway"
#guard dsub "station" #[("station", "light_rail")] == "light_rail"
#guard dsub "station" #[("tram", "yes")] == "tram"
#guard dsub "tram_stop" #[] == "tram"
#guard dsub "halt" #[] == "halt"
#guard dsub "station" #[] == "rail"

-- The dedupe trap: "Willesden Green" arrives as entrances at 6.3 m and 18.6 m
-- and the station at 38.4 m, and resolves to the station. "Dollis Hill" has
-- only an entrance in range, so stays one. The unnamed tram stop is dropped.
private def NAMED : Array (String × String × Float) :=
  (nearbyStations FEATURES QLAT QLON 400).map fun s => (s.name, s.subtype, s.distanceM)
#guard NAMED.map (fun t => (t.1, t.2.1)) ==
  #[("Dollis Hill", "subway_entrance"), ("Willesden Green", "rail"),
    ("Just In", "rail"), ("On The Bar", "rail"), ("Just Out", "rail")]
#guard approxD NAMED[1]!.2.2 38.43437398766941
-- Dollis Hill keeps the closer of its two entrances (9.0 m, not the 24 m one):
-- the same-kind distance rule, which only shows through where no station
-- outranks the entrances.
#guard approxD NAMED[0]!.2.2 9.002446540603552

-- The King's Cross shape: platform stops come back as `stop_position` beside
-- their stations, so the picker's platform tier ranks them below both.
private def SHARED : Array PointRow :=
  #[pr 20 "stop" (some "Main Cross") (QLAT + 19 / MDEG) QLON,
    pr 21 "stop" (some "Cross Tube") (QLAT + 32 / MDEG) QLON,
    pr 22 "station" (some "Cross Tube") (QLAT + 119 / MDEG) QLON #[("station", "subway")],
    pr 23 "station" (some "Main Cross") (QLAT + 129 / MDEG) QLON]
private def SHARED_NAMED : Array (String × String) :=
  (nearbyStations SHARED QLAT QLON 400).map fun s => (s.name, s.subtype)
#guard SHARED_NAMED == #[("Main Cross", "stop_position"), ("Cross Tube", "stop_position"),
  ("Cross Tube", "subway"), ("Main Cross", "rail")]

end SpatialGuards

/-! ## The line side (`queryLines` / `linesAtPoint`)

A planar degree-space distance scaled back by one `mPerDeg = min(111000,
111000·cos lat)` for both axes, as the corpus was blessed under: at 51.55°N a
way 100 m north scores 62.1 m and one 100 m east 99.8 m (`1 / cos`). `MBRContains`
is boundary-inclusive, checked on the server.

`lineDistDeg` is the true minimum over segments (checked against dense sampling
to 1e-13). MariaDB's `ST_Distance` was refuted as that: on a multi-vertex
linestring it returns the nearest vertex (a two-vertex check could not tell).
Encoding that defect would make every theorem about it a theorem about the
defect. Over the corpus it differs by up to 17.67 m for `nearbyLandmarks`
(polygon walls have vertices only at corners) and 37.96 m for `nearbyWays`;
point queries are untouched.

A vertex is never nearer than the true minimum, so as a filter this only
brings ways in; but `LIMIT 50` applies after ordering, so the method can also
displace a way where the highway bucket is saturated.
-/

namespace Lines

/-- One scale for both axes, from `METERS_PER_DEG_LAT` and its longitude
counterpart — the smaller of the two, so the degree circle contains the metre
circle. -/
def mPerDegAt (lat : Float) : Float :=
  min 111000 (111000 * Float.cos (lat * 3.141592653589793 / 180))

/-- A row of `osm_lines`. Coordinates are `(lat, lon)` in OSM order. -/
structure LineRow where
  osmId : Int
  subtype : String
  name : Option String
  coords : Array (Float × Float)
  /-- The feature's OSM tags, defaulted empty. `nearbyLandmarks` spawns one
  landmark per tag key (a building tagged `amenity=cafe` and
  `tourism=attraction` is two candidates), so it needs the full map. -/
  tags : Array (String × String) := #[]
  deriving Inhabited, BEq, Repr

/-- Planar point-to-segment distance in degree space, x = lon and y = lat. -/
def segDistDeg (px py ax ay bx by_ : Float) : Float :=
  let dx := bx - ax
  let dy := by_ - ay
  let len2 := dx * dx + dy * dy
  let t := if len2 == 0 then 0 else max 0 (min 1 (((px - ax) * dx + (py - ay) * dy) / len2))
  let qx := ax + t * dx
  let qy := ay + t * dy
  Float.sqrt ((px - qx) * (px - qx) + (py - qy) * (py - qy))

/-- `ST_Distance(linestring, point)` — the minimum over the way's segments. A
one-vertex way degenerates to the distance to that vertex. -/
def lineDistDeg (coords : Array (Float × Float)) (lat lon : Float) : Float :=
  match coords[0]? with
  | none => (1.0 / 0.0)
  | some c =>
    if coords.size == 1 then
      Float.sqrt ((lon - c.2) * (lon - c.2) + (lat - c.1) * (lat - c.1))
    else
      (coords.zip (coords.extract 1 coords.size)).foldl (init := (1.0 / 0.0)) fun best (a, b) =>
        min best (segDistDeg lon lat a.2 a.1 b.2 b.1)

/-- `MBRContains(linestring, point)` — boundary-inclusive, and true for a
zero-extent bbox the point lies on. -/
def mbrContainsPoint (coords : Array (Float × Float)) (lat lon : Float) : Bool :=
  match coords[0]? with
  | none => false
  | some c0 =>
    let mn (f : Float × Float → Float) : Float := coords.foldl (fun m p => min m (f p)) (f c0)
    let mx (f : Float × Float → Float) : Float := coords.foldl (fun m p => max m (f p)) (f c0)
    lat ≥ mn (·.1) && lat ≤ mx (·.1) && lon ≥ mn (·.2) && lon ≤ mx (·.2)

/-- Whether a closed way (first vertex = last, four or more) contains the point,
by ray casting: a true inside test, not `mbrContainsPoint`'s bounding box. A
point on the boundary may fall either way, which no caller depends on. -/
def ringContains (coords : Array (Float × Float)) (lat lon : Float) : Bool := Id.run do
  if coords.size < 4 || coords[0]? != coords[coords.size - 1]? then return false
  let mut inside := false
  for i in [1 : coords.size] do
    let (aLat, aLon) := coords[i - 1]!
    let (bLat, bLon) := coords[i]!
    if (aLat > lat) != (bLat > lat) then
      let crossLon := aLon + (lat - aLat) / (bLat - aLat) * (bLon - aLon)
      if lon < crossLon then inside := !inside
  return inside

/-- A line with its distance and enclosure resolved. -/
structure ScoredLine where
  row : LineRow
  distanceM : Float
  encloses : Bool
  deriving Inhabited, BEq, Repr

/-- `queryLines`: the degree-space radius filter, ordering, and 50-cap. The
radius is converted to a degree budget with the same single scale, so the filter
carries the same anisotropy as the distance it reports. -/
def queryLines (rows : Array LineRow) (lat lon radiusM : Float)
    (subtypes : Array String := #[]) : Array ScoredLine :=
  let mpd := mPerDegAt lat
  let dDeg := radiusM / mpd
  -- A closed way encloses by the true inside test; its bounding box also covers
  -- the streets around it (a hospital "enclosed" a stay 34 m outside it).
  -- An open way has no inside, so it keeps the box.
  let closed (c : Array (Float × Float)) := c.size ≥ 4 && c[0]? == c[c.size - 1]?
  let scored := rows.map fun r =>
    (r, lineDistDeg r.coords lat lon,
      if closed r.coords then ringContains r.coords lat lon else mbrContainsPoint r.coords lat lon)
  -- In range, or standing inside it: deep inside a park every edge is out of
  -- range. The distance reported stays the edge's, so ranking is unchanged.
  let inRadius := scored.filter fun s => s.2.1 < dDeg || ringContains s.1.coords lat lon
  let wanted :=
    if subtypes.isEmpty then inRadius
    else inRadius.filter fun s => subtypes.contains s.1.subtype
  let ordered := (wanted.toList.mergeSort fun a b => a.2.1 ≤ b.2.1).toArray
  (ordered.extract 0 (min 50 ordered.size)).map fun s =>
    { row := s.1, distanceM := s.2.1 * mpd, encloses := s.2.2 }

/-- The rail classes `linesAtPoint` asks for. -/
def RAIL_SUBTYPES : Array String := #["rail", "subway", "light_rail", "tram", "narrow_gauge"]

/-- `linesAtPoint`: the distinct names of rail-class ways near the point, in
first-seen (that is, distance) order. Unnamed ways contribute nothing. -/
def linesAtPoint (rows : Array LineRow) (lat lon radiusM : Float) : Array String := Id.run do
  let mut names : Array String := #[]
  for s in queryLines rows lat lon radiusM RAIL_SUBTYPES do
    match s.row.name with
    | none => pure ()
    | some nm => if !names.contains nm then names := names.push nm
  return names

end Lines

section LineGuards

open Lines

private def LQLAT : Float := 51.5492
private def LQLON : Float := -0.2215
private def D_LAT : Float := 100 / 111194.68229846345
private def D_LON : Float := 100 / (111194.68229846345 * Float.cos (LQLAT * 3.141592653589793 / 180))

private def lr (osmId : Int) (subtype : String) (name : Option String)
    (coords : Array (Float × Float)) : LineRow := { osmId, subtype, name, coords }

private def LINES : Array LineRow :=
  #[lr 1 "subway" (some "Jubilee Line") #[(LQLAT + D_LAT, LQLON - 0.01), (LQLAT + D_LAT, LQLON + 0.01)],
    lr 2 "subway" (some "Metropolitan Line") #[(LQLAT - 0.01, LQLON + D_LON), (LQLAT + 0.01, LQLON + D_LON)],
    lr 3 "rail" (some "Chiltern Main Line") #[(LQLAT - 0.005, LQLON - 0.005), (LQLAT + 0.005, LQLON + 0.005)],
    lr 4 "subway" (some "Jubilee Line") #[(LQLAT + 2 * D_LAT, LQLON - 0.01), (LQLAT + 2 * D_LAT, LQLON + 0.01)],
    lr 5 "tram" none #[(LQLAT, LQLON - 0.002), (LQLAT, LQLON + 0.002)],
    lr 6 "motorway" (some "North Circular") #[(LQLAT, LQLON - 0.001), (LQLAT, LQLON + 0.001)],
    lr 7 "rail" (some "Far Line") #[(51.60, -0.30), (51.61, -0.30)],
    lr 8 "rail" (some "Degenerate") #[(LQLAT, LQLON)],
    -- A short way entirely west at the same 100 m offset: its nearest point
    -- is its eastern end (350 m), so the segment clamp decides; unclamped, the
    -- line through it would measure only the 100 m offset.
    lr 9 "rail" (some "Stub West") #[(LQLAT + D_LAT, LQLON - 0.01), (LQLAT + D_LAT, LQLON - 0.005)]]

private def lids (q : Array ScoredLine) : Array Int := q.map (·.row.osmId)
private def approxL (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard approxL (mPerDegAt LQLAT) 69024.5041828261

-- The anisotropy, as a number: both ways lie 100 true metres from the point,
-- one due north and one due east, and the metric scores them 62.1 m and 99.8 m.
-- The ratio is 1/cos(51.5492 deg), so the search reaches ~1.6x further north.
private def R150 : Array ScoredLine := queryLines LINES LQLAT LQLON 150 RAIL_SUBTYPES
#guard approxL (R150.filter (·.row.osmId == 1))[0]!.distanceM 62.07536435757793
#guard approxL (R150.filter (·.row.osmId == 2))[0]!.distanceM 99.8249176179657

-- The radius filter inherits that distortion: at 80 m the northward way at a
-- true 100 m is kept and the eastward one at the same true distance is not.
#guard lids (queryLines LINES LQLAT LQLON 80 RAIL_SUBTYPES) == #[3, 5, 8, 1]
#guard lids R150 == #[3, 5, 8, 1, 2, 4]

-- The bar is strict: with the radius set to the northward way's own distance
-- that way is excluded, where `≤` would keep it.
#guard lids (queryLines LINES LQLAT LQLON 62.07536435757793 RAIL_SUBTYPES) == #[3, 5, 8]

-- A way through the point measures zero and encloses it; so does the
-- single-vertex way, whose bbox has zero extent.
#guard (R150.filter (·.row.osmId == 3))[0]!.encloses == true
#guard (R150.filter (·.row.osmId == 8))[0]!.encloses == true
#guard (R150.filter (·.row.osmId == 1))[0]!.encloses == false
#guard approxL (R150.filter (·.row.osmId == 8))[0]!.distanceM 0

-- A closed outline the point lies deep inside is kept although every edge is
-- out of range: a 2 km square around the query point, edges ~1 km away. An open
-- way of the same vertices, and the same square shifted off the point, are not.
private def SQUARE (dLat dLon : Float) : Array (Float × Float) :=
  #[(LQLAT - 0.01 + dLat, LQLON - 0.015 + dLon), (LQLAT - 0.01 + dLat, LQLON + 0.015 + dLon),
    (LQLAT + 0.01 + dLat, LQLON + 0.015 + dLon), (LQLAT + 0.01 + dLat, LQLON - 0.015 + dLon),
    (LQLAT - 0.01 + dLat, LQLON - 0.015 + dLon)]
#guard ringContains (SQUARE 0 0) LQLAT LQLON
#guard !ringContains (SQUARE 0.05 0) LQLAT LQLON
#guard !ringContains ((SQUARE 0 0).pop) LQLAT LQLON
#guard lids (queryLines #[lr 20 "park" (some "Big Park") (SQUARE 0 0)] LQLAT LQLON 100) == #[20]
#guard lids (queryLines #[lr 21 "park" (some "Open") (SQUARE 0 0).pop] LQLAT LQLON 100) == #[]
#guard lids (queryLines #[lr 22 "park" (some "Far Park") (SQUARE 0.05 0)] LQLAT LQLON 100) == #[]

-- `linesAtPoint`: distinct names in distance order. The unnamed tram way
-- contributes nothing, the motorway is not a rail class, and the second Jubilee
-- way does not repeat the name.
#guard linesAtPoint LINES LQLAT LQLON 80 == #["Chiltern Main Line", "Degenerate", "Jubilee Line"]
#guard linesAtPoint LINES LQLAT LQLON 150
  == #["Chiltern Main Line", "Degenerate", "Jubilee Line", "Metropolitan Line"]

end LineGuards

end Verified.Geo.OsmSpatial
