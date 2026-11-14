import Verified.Geo.OsmRouteMembers

/-!
# Which bus relations are worth mirroring

`refresh-bus-routes` mirrors OSM `route=bus` relations with their ordered stops
into `bus_route_cache`, for the bus matcher.

⚠ Two deliberate differences from the rail arm ({@link Verified.Geo.OsmRailStops}):

1. Buses require `ref`, the rider-facing number; rail accepts `ref` or `name`.
2. Buses keep the first tile's copy of a relation, rail the last. Both copies
   are complete (`node(r)`), so neither is wrong, but merging the two would
   change behaviour.

Whether a run failed is `Verified.Geo.OsmMirrorRefresh`'s rule, shared.
-/

namespace Verified.Geo.OsmBusRoutes

open Verified.Geo.OsmRouteMembers (Member ResolvedNode RouteStop resolveOrderedStops)

/-- A relation as it arrives from Overpass, narrowed to the tags this cares
about. -/
structure RawRelation where
  osmRelationId : Nat
  relType : Option String
  route : Option String
  ref : Option String
  name : Option String
  members : Array Member
  deriving Repr, Inhabited

/-- A route the mirror will write. -/
structure BusRoute where
  routeRef : String
  routeName : Option String
  osmRelationId : Nat
  stops : Array RouteStop
  deriving Repr, Inhabited, BEq

/-- The Overpass QL the mirror runs for one tile; `node(r)` returns each route's
full stop list. Coordinates arrive rendered, as in
{@link Verified.Geo.OsmRailStops.buildRailStopsOverpassQuery}. -/
def buildBusRouteOverpassQuery (minLat minLon maxLat maxLon : String) : String :=
  s!"[out:json][timeout:180];relation[route=bus]({minLat},{minLon},{maxLat},{maxLon});out body;node(r);out body;"

/-- Keep the routes that can be named and anchored. An empty `ref` is no ref:
OSM carries empty `ref` tags. -/
def extractBusRoutes (rels : Array RawRelation) (nodes : Array (Nat × ResolvedNode))
    : Array BusRoute := Id.run do
  let mut out : Array BusRoute := #[]
  for el in rels do
    if el.relType != some "route" then continue
    if el.route != some "bus" then continue
    let some routeRef := el.ref | continue
    if routeRef.isEmpty then continue
    let stops := resolveOrderedStops el.members nodes
    if stops.isEmpty then continue
    out := out.push
      { routeRef := routeRef
      , routeName := el.name
      , osmRelationId := el.osmRelationId
      , stops := stops }
  return out

/-! ## Guards -/

private def N (id : Nat) (name : Option String) : Nat × ResolvedNode :=
  (id, { lat := 51.5, lon := -0.1, name })
private def M (ref : Nat) (role : String) : Member :=
  { type := some "node", ref := some ref, role := some role }
private def NODES : Array (Nat × ResolvedNode) := #[N 1 (some "Angel"), N 2 (some "Old Street")]
private def STOPS : Array Member := #[M 1 "stop", M 2 "stop"]

private def R (id : Nat) (route ref name : Option String) : RawRelation :=
  { osmRelationId := id, relType := some "route", route, ref, name, members := STOPS }

#guard (extractBusRoutes #[R 1 (some "bus") (some "38") (some "Clapton Pond")] NODES).size == 1
#guard (extractBusRoutes #[R 1 (some "bus") (some "38") none] NODES)[0]!.routeRef == "38"
#guard (extractBusRoutes #[R 1 (some "bus") (some "38") none] NODES)[0]!.routeName == none

-- Buses require `ref` — a name is not enough, unlike rail.
#guard (extractBusRoutes #[R 1 (some "bus") none (some "Clapton Pond")] NODES).isEmpty
-- And an empty ref is no ref. `!routeRef` rejects `""`; `isNone` would not.
#guard (extractBusRoutes #[R 1 (some "bus") (some "") (some "Clapton Pond")] NODES).isEmpty

-- Rail is not this cron's business.
#guard (extractBusRoutes #[R 1 (some "subway") (some "JUB") none] NODES).isEmpty
-- Nor is a non-route relation that happens to be tagged `route=bus`.
#guard (extractBusRoutes #[{ R 1 (some "bus") (some "38") none with relType := some "multipolygon" }] NODES).isEmpty
-- One stop cannot anchor a ride.
#guard (extractBusRoutes #[{ R 1 (some "bus") (some "38") none with members := #[M 1 "stop"] }] NODES).isEmpty

#guard buildBusRouteOverpassQuery "51.5" "-0.2" "51.6" "-0.1"
        == "[out:json][timeout:180];relation[route=bus](51.5,-0.2,51.6,-0.1);out body;node(r);out body;"

end Verified.Geo.OsmBusRoutes
