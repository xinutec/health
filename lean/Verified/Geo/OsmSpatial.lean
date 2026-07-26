import Verified.Hsmm.FloatScore
/-!
# OSM spatial kernel (port of `queryPoints` + the `nearbyStations` pipeline)

The part of the OSM lookup that has been running as SQL inside MariaDB. Moving
it here is what turns "the nearest station to this fix" from an ORACLE — a
number computed elsewhere and handed to the algorithm — into a DEFINITION, which
is the precondition for ever stating a theorem about station selection.
See `docs/proposals/2026-07-osm-into-lean.md`.

## The distance constant

MariaDB 12.3.2's `ST_Distance_Sphere` uses a sphere of radius **6370986 m**
(measured on the live server: one degree of latitude is 111194.68229846345 m,
which pins the radius to the metre). `FloatScore.haversineMeters` uses 6371000.

Under this design the DB no longer computes distances at all — it ships rows —
so Lean's constant becomes the definition and there is nothing to chase. The two
differ by 2.2 ppm, so a decision can only change for a feature lying within
`radius × 2.2e-6` of the bar: **0.22 mm at a 100 m radius, 0.9 mm at 400 m.**
Both are provided below so the re-bless delta is measurable rather than assumed.

## What is deliberately NOT modelled

The `MBRIntersects` pre-filter. Its box is `[lat ± dDeg] × [lon ± dDeg]` with
`dDeg = radius / min(111000, 111000·cos lat)`, and BOTH scale factors understate
the true metres per degree — 111000 against the sphere's 111194.68, and the
longitude factor against the same times `cos lat`. So `dDeg` overstates the
circle's extent on both axes and the box strictly contains the radius circle.
The pre-filter therefore cannot remove a row the distance test would keep: it
exists to make the spatial index usable, and is an accelerator, not a predicate.

UNPROVEN; pinned against Node/V8 (`lean/experiments/osm-spatial-refs.mts`).
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

/-- `queryPoints`: keep rows strictly inside the radius, of a wanted subtype,
ordered by distance, capped at 50.

The cap does not bind for the STATION and LINE-NAME lookups — over the golden
corpus `nearbyStations` returns at most 11 rows and `linesAtPoint` at most 14.
It very much binds for `nearbyWays`: its highway bucket comes back at exactly
50 on every dense-London query examined, which is what makes the line-metric
change able to LOSE a way (see the `lineDistDeg` note below). -/
def queryPoints (rows : Array PointRow) (lat lon radiusM : Float)
    (subtypes : Array String := #[]) (R : Float := LEAN_EARTH_R) : Array ScoredPoint :=
  let scored := rows.map fun r => { row := r, distanceM := haversineAt R lat lon r.lat r.lon }
  let inRadius := scored.filter fun s => s.distanceM < radiusM
  let wanted :=
    if subtypes.isEmpty then inRadius
    else inRadius.filter fun s => subtypes.contains s.row.subtype
  -- V8's `sort` is stable, and `mergeSort` with `≤` matches it: equal
  -- distances keep the order the rows arrived in.
  let ordered := (wanted.toList.mergeSort fun a b => a.distanceM ≤ b.distanceM).toArray
  ordered.extract 0 (min 50 ordered.size)

/-- The subtypes `nearbyStations` asks for. -/
def STATION_SUBTYPES : Array String := #["station", "subway_entrance", "halt", "stop", "tram_stop"]

private def tag (r : PointRow) (k : String) : Option String :=
  (r.tags.find? fun kv => kv.1 == k).map (·.2)

/-- `deriveStationSubtype`. An entrance keeps its own subtype so the picker can
deprioritise it — OSM labels entrance nodes "A", "B", "C", and one would
otherwise beat the real station node on distance for a passing fix. -/
def deriveStationSubtype (r : PointRow) : String :=
  if r.subtype == "subway_entrance" then "subway_entrance"
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

/-- `dedupeStationsByName`. A station and its entrances are separate OSM points
sharing one name, so a naive keep-closest picks the ENTRANCE — and the caller
then filters that out as entrance-like, deleting the station from the result
entirely and letting a further-away station win by default. Hence the asymmetry:
a station-typed record beats an entrance-typed one REGARDLESS of distance, and
distance only decides between records of the same kind.

Unnamed features are dropped outright.

Insertion order is the arrival order, which is distance order from
`queryPoints`; the final sort is by distance again, so the map's iteration order
only shows through on exact ties. -/
def dedupeStationsByName (scored : Array ScoredPoint) : Array NearbyStation := Id.run do
  let mut names : Array String := #[]
  let mut best : Array NearbyStation := #[]
  for s in scored do
    match s.row.name with
    | none => pure ()
    | some nm =>
      let cand : NearbyStation :=
        { name := nm, subtype := deriveStationSubtype s.row, distanceM := s.distanceM
          lat := s.row.lat, lon := s.row.lon }
      match names.findIdx? (· == nm) with
      | none =>
        names := names.push nm
        best := best.push cand
      | some i =>
        let cur := best[i]!
        let curIsEntrance := cur.subtype == "subway_entrance"
        let candIsEntrance := cand.subtype == "subway_entrance"
        if curIsEntrance && !candIsEntrance then
          best := best.set! i cand
        else if curIsEntrance == candIsEntrance && cand.distanceM < cur.distanceM then
          best := best.set! i cand
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
    -- A SECOND Dollis Hill entrance. Its station is out of range, so the winner
    -- here is decided by the same-kind distance rule and SURVIVES to the output —
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

-- The radius bar is STRICT, and the subtype filter drops the level crossing.
-- "Just In" at 99 m is kept; "On The Bar" at 100.0000000003 and "Just Out" at
-- 101 are not. The same set under both spheres — the constant can only flip a
-- feature within ~0.22 mm of the bar at this radius.
#guard ids (queryPoints FEATURES QLAT QLON 100 STATION_SUBTYPES MARIA_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8]
#guard ids (queryPoints FEATURES QLAT QLON 100 STATION_SUBTYPES LEAN_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8]
#guard ids (queryPoints FEATURES QLAT QLON 400 STATION_SUBTYPES LEAN_EARTH_R) == #[2, 4, 3, 7, 12, 1, 8, 11, 9]
-- The bar is STRICT. No latitude gives a distance of exactly 100 m — the
-- haversine steps from 99.99999999946 to 100.00000000025 — so the strictness is
-- pinned by setting the radius to a feature's OWN distance instead: under `<`
-- that feature is excluded, under `≤` it would be kept.
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

-- The dedupe trap: "Willesden Green" arrives as an ENTRANCE at 6.3 m, another
-- entrance at 18.6 m, and the STATION at 38.4 m — and resolves to the station,
-- because station-typed beats entrance-typed regardless of distance. Take that
-- asymmetry away and the caller filters the entrance out and loses the station
-- altogether. "Dollis Hill" has only an entrance in range, so it stays one.
-- The unnamed tram stop is dropped.
private def NAMED : Array (String × String × Float) :=
  (nearbyStations FEATURES QLAT QLON 400).map fun s => (s.name, s.subtype, s.distanceM)
#guard NAMED.map (fun t => (t.1, t.2.1)) ==
  #[("Dollis Hill", "subway_entrance"), ("Willesden Green", "rail"),
    ("Just In", "rail"), ("On The Bar", "rail"), ("Just Out", "rail")]
#guard approxD NAMED[1]!.2.2 38.43437398766941
-- Dollis Hill keeps the CLOSER of its two entrances (9.0 m, not the 24 m one):
-- the same-kind distance rule, which only shows through where no station
-- outranks the entrances.
#guard approxD NAMED[0]!.2.2 9.002446540603552

end SpatialGuards

/-! ## The LINE side (`queryLines` / `linesAtPoint`)

A different metric, and deliberately so. MariaDB's `ST_Distance` is PLANAR in
degree space, and the result is scaled back to metres by a single
`mPerDeg = min(111000, 111000·cos lat)` — one scale for both axes.

At 51.55°N that is a large distortion, and the guards below state it as a
number: a way lying 100 true metres due NORTH is scored at 62.1 m, one 100 true
metres due EAST at 99.8 m — a ratio of 1.608, which is `1 / cos(51.55°)`. The
search therefore reaches about 1.6× further north than east. This is an
approximation the algorithm has always run on and the corpus was blessed under,
so it is reproduced rather than corrected; changing it would be a behaviour
change, not a port.

`MBRContains` is boundary-INCLUSIVE — a point on the bbox edge, on a corner, or
on a degenerate zero-extent bbox all return true. Confirmed on the live server.

## `lineDistDeg` deliberately does NOT reproduce MariaDB

An earlier version of this comment claimed `ST_Distance` was "the planar minimum
over segments clamped at the endpoints, confirmed against the live server". The
confirmation was run on a TWO-VERTEX fixture, which cannot tell that behaviour
apart from "distance to the nearest vertex". It is the second.

Measured on MariaDB 12.3.2 (2026-07-26), same point, same coordinates:

    full 12-vertex line   0.002419365488074187  = the distance to VERTEX 2
    its segment 1 alone   0.002405760590290686  = the true perpendicular

So `ST_Distance` is correct for a 2-point linestring and returns the nearest
VERTEX for a multi-vertex one. `lineDistDeg` computes the true minimum over
segments — verified against an independent dense-sampling brute force, which
agrees to 1e-13 and locates the minimum mid-segment.

This is therefore a deliberate BEHAVIOUR CHANGE, not a port, and it is taken
because encoding a database defect into the definition would make every theorem
about it a theorem about the defect.

### How big is it, really

An earlier note here put the consequences at "4 of 3840 ways, worst 0.94 m,
zero bar crossings". Those numbers were real but the SAMPLE was not
representative: it drew only from `highway`/`railway` rows near captured query
points. Roads are densely vertexed along their curves, so the gap between the
perpendicular foot and the nearest vertex stays small. Replaying all 2521
captured kernel queries against the pushed row-set
(`lean/experiments/osm-rowset-parity.mts`, 2026-07-26) gives the real scale:

- `nearbyLandmarks` — worst **17.67 m**. Landmark rows include closed ways:
  parks, buildings, car parks. A polygon's long wall carries vertices only at
  its corners, so standing beside the middle of one, the true distance and the
  corner distance differ by a large fraction of the wall's length. Measured
  case: Paleistuin (`osm 86909138`, 59 vertices) — true **2.0687 m**, MariaDB
  **16.9640 m**, bit-identical to its own nearest vertex.
- `nearbyWays` — worst **37.96 m**, for the same reason on long straight trunk
  roads.
- point-backed methods are untouched, as the sphere argument requires:
  `nearbyStations` worst **0.0009 m** over 269 differing queries, no membership
  change anywhere.

The size of the defect is the vertex SPACING along the nearest edge, not
anything about the corpus — which is why a road-only sample understated it by a
factor of ~40.

### One-directional, but not monotone in the RESULT

A vertex is never nearer than the true minimum, so this port is never FARTHER
than MariaDB: as a PREDICATE the change can only bring ways in. The METHOD is
not monotone, though, because `LIMIT 50` is applied after ordering. Over the
corpus, `nearbyWays` gained features on 18 queries and LOST them on 9 of those
same 18 — every loss displaced by the cap, whose highway bucket was already
saturated at exactly 50 rows in each case. So "features can only be gained" is
true of the filter and false of the method, and only the filter version is
safe to reason from.
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
  if coords.isEmpty then (1.0 / 0.0)
  else if coords.size == 1 then
    let c := coords[0]!
    Float.sqrt ((lon - c.2) * (lon - c.2) + (lat - c.1) * (lat - c.1))
  else
    (Array.range (coords.size - 1)).foldl (init := (1.0 / 0.0)) fun best i =>
      let a := coords[i]!
      let b := coords[i + 1]!
      min best (segDistDeg lon lat a.2 a.1 b.2 b.1)

/-- `MBRContains(linestring, point)` — boundary-inclusive, and true for a
zero-extent bbox the point lies on. -/
def mbrContainsPoint (coords : Array (Float × Float)) (lat lon : Float) : Bool :=
  if coords.isEmpty then false
  else
    let lats := coords.map (·.1)
    let lons := coords.map (·.2)
    let mn := fun (a : Array Float) => a.foldl min a[0]!
    let mx := fun (a : Array Float) => a.foldl max a[0]!
    lat ≥ mn lats && lat ≤ mx lats && lon ≥ mn lons && lon ≤ mx lons

/-- A line with its distance and enclosure resolved. -/
structure ScoredLine where
  row : LineRow
  distanceM : Float
  encloses : Bool
  deriving Inhabited, BEq, Repr

/-- `queryLines`: the degree-space radius filter, ordering, and 50-cap. The
radius is converted to a degree budget with the SAME single scale, so the filter
carries the same anisotropy as the distance it reports. -/
def queryLines (rows : Array LineRow) (lat lon radiusM : Float)
    (subtypes : Array String := #[]) : Array ScoredLine :=
  let mpd := mPerDegAt lat
  let dDeg := radiusM / mpd
  let scored := rows.map fun r =>
    (r, lineDistDeg r.coords lat lon, mbrContainsPoint r.coords lat lon)
  let inRadius := scored.filter fun s => s.2.1 < dDeg
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
    -- A SHORT way lying entirely WEST, at the same 100 m northward offset. Its
    -- nearest approach is its eastern ENDPOINT (350 m away), so the segment
    -- clamp decides: unclamped, the infinite line through it runs due east-west
    -- at that latitude and would measure only the 100 m offset, pulling it into
    -- both radii below.
    lr 9 "rail" (some "Stub West") #[(LQLAT + D_LAT, LQLON - 0.01), (LQLAT + D_LAT, LQLON - 0.005)]]

private def lids (q : Array ScoredLine) : Array Int := q.map (·.row.osmId)
private def approxL (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard approxL (mPerDegAt LQLAT) 69024.5041828261

-- THE ANISOTROPY, as a number: both ways lie 100 true metres from the point,
-- one due north and one due east, and the metric scores them 62.1 m and 99.8 m.
-- The ratio is 1/cos(51.5492 deg), so the search reaches ~1.6x further north.
private def R150 : Array ScoredLine := queryLines LINES LQLAT LQLON 150 RAIL_SUBTYPES
#guard approxL (R150.filter (·.row.osmId == 1))[0]!.distanceM 62.07536435757793
#guard approxL (R150.filter (·.row.osmId == 2))[0]!.distanceM 99.8249176179657

-- The radius filter inherits that distortion: at 80 m the northward way at a
-- true 100 m is KEPT and the eastward one at the same true distance is not.
#guard lids (queryLines LINES LQLAT LQLON 80 RAIL_SUBTYPES) == #[3, 5, 8, 1]
#guard lids R150 == #[3, 5, 8, 1, 2, 4]

-- The bar is STRICT: with the radius set to the northward way's OWN distance
-- that way is excluded, where `≤` would keep it.
#guard lids (queryLines LINES LQLAT LQLON 62.07536435757793 RAIL_SUBTYPES) == #[3, 5, 8]

-- A way through the point measures zero and encloses it; so does the
-- single-vertex way, whose bbox has zero extent.
#guard (R150.filter (·.row.osmId == 3))[0]!.encloses == true
#guard (R150.filter (·.row.osmId == 8))[0]!.encloses == true
#guard (R150.filter (·.row.osmId == 1))[0]!.encloses == false
#guard approxL (R150.filter (·.row.osmId == 8))[0]!.distanceM 0

-- `linesAtPoint`: distinct names in distance order. The unnamed tram way
-- contributes nothing, the motorway is not a rail class, and the second Jubilee
-- way does not repeat the name.
#guard linesAtPoint LINES LQLAT LQLON 80 == #["Chiltern Main Line", "Degenerate", "Jubilee Line"]
#guard linesAtPoint LINES LQLAT LQLON 150
  == #["Chiltern Main Line", "Degenerate", "Jubilee Line", "Metropolitan Line"]

end LineGuards

end Verified.Geo.OsmSpatial
