/-!
# Rail-vs-road proximity kernel (port of `railRoadDistFromWays` in `src/geo/rail-road-proximity.ts`)

Given a fix's `nearbyWays` (OSM ways with a distance, type, and subtype), the
nearest rail-only way and the nearest drivable road — the road-vs-rail evidence
the HSMM's line-proximity factor consumes (`roadDistM`/`railDistM`). Trams are
excluded (mixed-traffic track is weak evidence); pedestrian/cycle ways are not
drivable.

Only the PURE kernel ports here. The surrounding `computeMinuteProximity` is
shell — an async `nearbyWays` OSM query + `dateBoundsUtc` tz resolution + minute
bucketing — the I/O boundary Lean does not cross; it feeds this kernel a resolved
ways list. Pure `min` over a filtered list, no transcendentals ⇒ exact. UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Geo.RailRoadProximity

/-- Rail-only OSM way subtypes (trams excluded). -/
def RAIL_ONLY_SUBTYPES : List String := ["rail", "subway", "light_rail", "narrow_gauge"]
/-- Drivable highway subtypes (pedestrian/cycle excluded). -/
def DRIVABLE_HIGHWAY_SUBTYPES : List String :=
  ["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
   "service", "unclassified", "track", "living_street"]

/-- An OSM way near a fix: distance (m, `none` when unknown), feature type, subtype. -/
structure NearbyWay where
  distanceM : Option Float
  type : String
  subtype : String

/-- Nearest rail-only way and nearest drivable road for a fix's ways. `none` for a
    kind with nothing in range. -/
def railRoadDistFromWays (ways : List NearbyWay) : Option Float × Option Float :=
  let inf : Float := 1.0 / 0.0
  let (minRail, minRoad) := ways.foldl (fun (acc : Float × Float) w =>
    match w.distanceM with
    | none => acc
    | some d =>
      if !d.isFinite then acc
      else if w.type == "railway" && RAIL_ONLY_SUBTYPES.contains w.subtype then
        (min acc.1 d, acc.2)
      else if w.type == "highway" && DRIVABLE_HIGHWAY_SUBTYPES.contains w.subtype then
        (acc.1, min acc.2 d)
      else acc) (inf, inf)
  (if minRail.isFinite then some minRail else none,
   if minRoad.isFinite then some minRoad else none)

-- Parity with the real `railRoadDistFromWays`.
private def w (d : Float) (ty sub : String) : NearbyWay := ⟨some d, ty, sub⟩
#guard railRoadDistFromWays [w 100 "railway" "rail", w 50 "highway" "primary",
  w 80 "railway" "subway", w 30 "railway" "tram", w 20 "highway" "footway"]
  == (some 80, some 50)                                        -- tram/footway excluded
#guard railRoadDistFromWays [w 40 "highway" "motorway", w 60 "highway" "service"]
  == (none, some 40)                                            -- no rail in range
#guard railRoadDistFromWays [] == (none, none)
#guard railRoadDistFromWays [⟨none, "railway", "rail"⟩, w 25 "railway" "light_rail"]
  == (some 25, none)                                            -- null distance skipped

end Verified.Geo.RailRoadProximity
