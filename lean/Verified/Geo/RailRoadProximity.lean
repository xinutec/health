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

end Verified.Geo.RailRoadProximity
