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

The cap never binds for the station and line lookups the pass list makes — over
the golden corpus `nearbyStations` returns at most 11 rows and `linesAtPoint`
at most 14 — but it is reproduced because `walkableRoads` and `buildingsNear`
run the same shape and do reach their caps. -/
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

end Verified.Geo.OsmSpatial
