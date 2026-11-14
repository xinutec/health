import Verified.Geo.OsmRouteMembers

/-!
# Which rail relations are worth mirroring

`refresh-rail-stops` mirrors OSM rail route relations (subway, train,
light_rail, tram) with their ordered stops into `rail_stops_cache`. This is the
cron's judgement: the Overpass query, and which relations are kept.

Only a relation's `stop` members say whether line L stops at S; proximity
cannot express passing without stopping.

Tram is included: several systems ridden as rail are tagged `tram`, and a
missing network reads as "no stops", not as an error.

Rail relations are kept on `ref` or `name`; buses require `ref`. Tube
relations often carry only a name.
-/

namespace Verified.Geo.OsmRailStops

open Verified.Geo.OsmRouteMembers (Member ResolvedNode RouteStop resolveOrderedStops)

/-- The `route=*` values that are rail services. -/
def RAIL_ROUTE_TYPES : List String := ["subway", "train", "light_rail", "tram"]

/-- A relation as it arrives from Overpass, already narrowed to the tags this
cares about. The shell does the JSON walk; this decides what to keep. -/
structure RawRelation where
  osmRelationId : Nat
  /-- The `type` tag. Only `route` relations are considered. -/
  relType : Option String
  /-- The `route` tag: subway | train | light_rail | tram | anything else. -/
  route : Option String
  ref : Option String
  name : Option String
  members : Array Member
  deriving Repr, Inhabited

/-- A relation the mirror will write. -/
structure RailStopRelation where
  osmRelationId : Nat
  routeType : String
  lineRef : Option String
  lineName : Option String
  stops : Array RouteStop
  deriving Repr, Inhabited

/-- The Overpass QL the mirror runs for one tile. `node(r)` returns the full
stop list of any relation touching the tile, so small tiles find relations
without clipping them.

The coordinates arrive as strings Rust rendered: Overpass parses them and
nothing compares them, unlike `stops_json`, which must be exact. -/
def buildRailStopsOverpassQuery (minLat minLon maxLat maxLon : String) : String :=
  let box := s!"{minLat},{minLon},{maxLat},{maxLon}"
  let routeRe := s!"^({String.intercalate "|" RAIL_ROUTE_TYPES})$"
  s!"[out:json][timeout:180];relation[route~\"{routeRe}\"]({box});out body;node(r);out body;"

/-- Keep the relations that can identify a line and anchor a call pattern: a
rail route with a `ref` or `name` and at least two ordered stops. -/
def extractRailStopRelations (rels : Array RawRelation) (nodes : Array (Nat × ResolvedNode))
    : Array RailStopRelation := Id.run do
  let mut out : Array RailStopRelation := #[]
  for el in rels do
    if el.relType != some "route" then continue
    let some route := el.route | continue
    if !RAIL_ROUTE_TYPES.contains route then continue
    -- `ref` or `name`, not both, and not `ref` alone — see the module note.
    if el.ref.isNone && el.name.isNone then continue
    let stops := resolveOrderedStops el.members nodes
    if stops.isEmpty then continue
    out := out.push
      { osmRelationId := el.osmRelationId
      , routeType := route
      , lineRef := el.ref
      , lineName := el.name
      , stops := stops }
  return out

/-! ## Guards -/

private def N (id : Nat) (name : Option String) : Nat × ResolvedNode :=
  (id, { lat := 51.5, lon := -0.1, name })
private def M (ref : Nat) (role : String) : Member :=
  { type := some "node", ref := some ref, role := some role }
private def NODES : Array (Nat × ResolvedNode) := #[N 1 (some "Stanmore"), N 2 (some "Stratford")]
private def STOPS : Array Member := #[M 1 "stop", M 2 "stop"]

private def R (route : Option String) (ref name : Option String) : RawRelation :=
  { osmRelationId := 7, relType := some "route", route, ref, name, members := STOPS }

#guard (extractRailStopRelations #[R (some "subway") (some "JUB") (some "Jubilee")] NODES).size == 1
#guard (extractRailStopRelations #[R (some "subway") (some "JUB") (some "Jubilee")] NODES)[0]!.stops.size == 2

-- Name alone is enough for rail. Most tube route relations have no `ref`, and
-- requiring one would drop the London Underground.
#guard (extractRailStopRelations #[R (some "subway") none (some "Jubilee line")] NODES).size == 1
-- Ref alone is enough too.
#guard (extractRailStopRelations #[R (some "train") (some "TL") none] NODES).size == 1
-- Neither is nothing to match a line label against.
#guard (extractRailStopRelations #[R (some "subway") none none] NODES).isEmpty

-- All four rail types are mirrored, tram included.
#guard (extractRailStopRelations
          (RAIL_ROUTE_TYPES.toArray.map (fun t => R (some t) (some "X") none)) NODES).size == 4
-- A bus route is not this cron's business.
#guard (extractRailStopRelations #[R (some "bus") (some "24") none] NODES).isEmpty
#guard (extractRailStopRelations #[R none (some "X") none] NODES).isEmpty

-- A multipolygon that happens to carry a `route` tag is not a route relation.
#guard (extractRailStopRelations
          #[{ R (some "subway") (some "JUB") none with relType := some "multipolygon" }] NODES).isEmpty

-- One stop cannot anchor a call pattern, so the relation goes.
#guard (extractRailStopRelations
          #[{ R (some "subway") (some "JUB") none with members := #[M 1 "stop"] }] NODES).isEmpty

-- The query names all four types and the bbox in Overpass's lat,lon,lat,lon order.
#guard buildRailStopsOverpassQuery "51.5" "-0.2" "51.6" "-0.1"
        == "[out:json][timeout:180];relation[route~\"^(subway|train|light_rail|tram)$\"](51.5,-0.2,51.6,-0.1);out body;node(r);out body;"

end Verified.Geo.OsmRailStops
