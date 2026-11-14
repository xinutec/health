/-!
# Rail-vs-road proximity kernel

From a fix's `nearbyWays`, the nearest rail-only way and the nearest drivable
road: the `roadDistM`/`railDistM` evidence for line proximity. Trams are not
rail here; footways and cycleways are not drivable. The query, time zones and
minute bucketing are the caller's. Exact. UNPROVEN; pinned by the `#guard`s.
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

end Verified.Geo.RailRoadProximity
