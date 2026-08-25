import Verified.Geo.OsmRouteMembers

/-!
# Which rail relations are worth mirroring

`refresh-rail-stops` mirrors OSM rail route relations — subway, train,
light_rail, tram — with their ordered stop lists into `rail_stops_cache` (#364).
This module is the cron's judgement: the Overpass query it asks, and which of
the relations that come back are kept (#982 Tier 2).

Port of `src/geo/osm-rail-stops.ts`.

## Why relations and not proximity

"Does line L stop at station S" is ground truth only a relation's `stop` members
carry. Proximity cannot express passing-without-stopping: Dollis Hill sits within
300 m of the Metropolitan's fast tracks and the Met does not stop there. That
ambiguity is the 2026-07-16 wrong-line case.

## ⚠ TRAM IS IN, DELIBERATELY

Several systems this pipeline labels as rail are tagged `tram` in OSM. Mirroring
a mode the user never rides costs a few rows; NOT mirroring one silently loses a
whole network, and the loss looks like "that line has no stops" rather than like
an error.

## ⚠ RAIL KEEPS A RELATION ON `ref` OR `name`; BUSES REQUIRE `ref`

Tube route relations frequently carry no `ref` at all — "Jubilee line: Stanmore →
Stratford" is a name and nothing else. Requiring `ref` here, as the bus arm does,
would drop most of the London Underground.
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

/-- The Overpass QL the mirror runs for one tile.

⚠ `node(r)` RETURNS THE FULL STOP LIST of any relation that merely touches the
tile, so a line the user rides is mirrored end to end even when only its middle
crosses the box. That is why tiling small is safe here: a tile is a way of
finding relations, not of clipping them.

⚠ THE COORDINATES ARRIVE ALREADY RENDERED, as strings. The TypeScript
interpolates JS numbers, and Lean has no shortest-round-trip float renderer to
match that with — so the shell formats them. That is safe HERE and would not be
elsewhere: Overpass parses this string, nothing compares it, and `51.5` against
`51.500000` selects the same box. The same shortcut on `stops_json`, which IS
compared row for row, would be a defect. -/
def buildRailStopsOverpassQuery (minLat minLon maxLat maxLon : String) : String :=
  let box := s!"{minLat},{minLon},{maxLat},{maxLon}"
  let routeRe := s!"^({String.intercalate "|" RAIL_ROUTE_TYPES})$"
  s!"[out:json][timeout:180];relation[route~\"{routeRe}\"]({box});out body;node(r);out body;"

/-- Keep the relations that can both identify a line and anchor a call pattern.

A relation is dropped when it is not a route, is not a rail route, carries
neither `ref` nor `name`, or resolves to fewer than two ordered stops. Nothing
is guessed: a relation that cannot say which line it is has no use downstream,
and one with a single stop cannot say anything about a sequence. -/
def extractRailStopRelations (rels : Array RawRelation) (nodes : Array (Nat × ResolvedNode))
    : Array RailStopRelation := Id.run do
  let mut out : Array RailStopRelation := #[]
  for el in rels do
    if el.relType != some "route" then continue
    let some route := el.route | continue
    if !RAIL_ROUTE_TYPES.contains route then continue
    -- ⚠ `ref` OR `name`, not both, and not `ref` alone — see the module note.
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

/-- Does a run have enough evidence to replace the cache?

⚠ THIS RULE IS LOUD IN ONE CASE AND SILENTLY LOSSY IN ANOTHER — see #1134 and
the module note in {@link Verified.Geo.OsmBusRoutes}. It trips when zero
relations came back with any failure, which is why the 2026-08-24 outage made
the rail job exit 1 while the bus job reported success.

⚠ BUT IT SAYS NOTHING ABOUT A PARTIAL RUN, and rail has no `tile_key`: the whole
table is rebuilt each run, so 53 of 153 tiles succeeding means the other 100
tiles' relations are DELETED and not rewritten. The mirror shrinks and this
returns `true`. The comment this replaced called that "fine"; it is only fine
for the tiles that answered.

Ported faithfully anyway — the parity diff against the TypeScript is the
instrument that finds defects like this, and changing the rule mid-port removes
it. The fix is #1134's to choose. -/
def mayRebuild (relationCount tileFailures : Nat) : Bool :=
  relationCount > 0 || tileFailures == 0

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

-- ⚠ NAME ALONE IS ENOUGH for rail. Most tube route relations have no `ref`, and
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

-- ⚠ THE REBUILD GUARD. Zero relations with failures is a broken run, not an
-- empty region — and the table is rebuilt transactionally, so getting this
-- backwards wipes a working mirror and exits 0.
#guard mayRebuild 0 0 == true
#guard mayRebuild 0 3 == false
#guard mayRebuild 12 3 == true
#guard mayRebuild 12 0 == true

end Verified.Geo.OsmRailStops
