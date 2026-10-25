import Verified.Geo.OsmRouteMembers

/-!
# Which bus relations are worth mirroring, and when it is safe to write them

`refresh-bus-routes` mirrors OSM `route=bus` relations with their ordered stop
lists into `bus_route_cache` — the ingestion half of C-bus, whose matcher is
`bus-route-match.ts` (#982 Tier 2).

Port of `src/geo/osm-bus-routes.ts` and the pure decision in
`src/geo/bus-route-cache.ts`.

## ⚠ THIS ARM AND THE RAIL ARM DISAGREE, TWICE, AND BOTH DISAGREEMENTS ARE PORTED

They are near-identical crons over the same tiling, so the differences read as
oversights until you check them. They are not:

1. **Buses require `ref`; rail accepts `ref` OR `name`.** A bus route without a
   rider-facing number ("38") cannot be named to a user. A tube relation
   frequently has no `ref` at all, so requiring one there would drop most of the
   Underground. See {@link Verified.Geo.OsmRailStops}.

2. **Buses keep the FIRST tile's copy of a relation; rail keeps the LAST.** The
   bus loop is `if (!byRelation.has(id)) set(...)`, the rail loop is a bare
   `set(...)`. `node(r)` returns a relation's full stop list from any tile it
   touches, so both copies are complete and neither arm is wrong — but they are
   different, and a port that "tidied" them into one would be changing
   behaviour while claiming to share code.

## Whether a run failed

Neither arm decides it alone: a run writes the tiles that answered, and whether
too much of the area has gone stale is `Verified.Geo.OsmMirrorRefresh`'s rule,
the same for both.
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

/-- The Overpass QL the mirror runs for one tile. As with rail, `node(r)` returns
each matched route's FULL stop list, so a route is mirrored end to end even when
only its middle crosses the cell.

⚠ Coordinates arrive already rendered, for the reason given in
{@link Verified.Geo.OsmRailStops.buildRailStopsOverpassQuery}. -/
def buildBusRouteOverpassQuery (minLat minLon maxLat maxLon : String) : String :=
  s!"[out:json][timeout:180];relation[route=bus]({minLat},{minLon},{maxLat},{maxLon});out body;node(r);out body;"

/-- Keep the routes that can be both named and anchored.

⚠ AN EMPTY `ref` IS NO REF. The TypeScript writes `if (!routeRef) continue`,
which rejects `""` along with the absent tag — and OSM does carry empty `ref`
tags. Testing `isNone` alone would admit a route whose rider-facing number is the
empty string. -/
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

-- ⚠ BUSES REQUIRE `ref` — a name is not enough, unlike rail.
#guard (extractBusRoutes #[R 1 (some "bus") none (some "Clapton Pond")] NODES).isEmpty
-- ⚠ AND AN EMPTY REF IS NO REF. `!routeRef` rejects `""`; `isNone` would not.
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
