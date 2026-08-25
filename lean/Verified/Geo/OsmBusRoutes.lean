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

## ⚠ NEITHER ARM'S REFUSAL IS RIGHT, AND #1134 OWNS THE DECISION

Do not read the two rules as one being the good version. They fail in opposite
directions and both failures are live:

* **Bus is LOSSLESS but QUIET.** `rebuildRefusal` refuses only when every tile
  failed, which it can afford because the writer records which tile each row came
  from and replaces only the tiles that ANSWERED. Nothing is lost — but the
  2026-08-24 05:30 run refreshed **2 of 18 tiles and exited 0**, and its summary
  read `994 -> 994 routes`, which is exactly what a healthy run prints when OSM
  did not change. That is #1134.

* **Rail is LOUD but LOSSY.** Its guard trips whenever zero relations came back
  with any failure, so the same outage made the rail job exit 1 while the bus job
  looked fine — the odd one out was the QUIET one, not the healthy one. But rail
  has no `tile_key`: it DELETEs the whole table and rewrites what it found, so a
  run where most tiles failed and a few succeeded shrinks the mirror silently.
  Only the all-failed case is loud.

⚠ A COUNT-BASED FLOOR CANNOT FIX EITHER, and that is measured rather than
supposed (2026-08-14, #255): a run fetching 796 of 995 routes but losing the
handful the rider actually uses passed the floor, while a run dropping 300
untouched peripheral routes failed it. The number was uncorrelated with the harm.
Coverage — what FRACTION OF THE AREA was refreshed — is the quantity that is not.

## What this port does about it

Both rules are ported FAITHFULLY, defects included, because the port's whole
safety argument is that its output can be diffed against the TypeScript arm's —
which is how every defect this week was found. Changing the rule during the port
would remove the instrument.

What the port does add is the COVERAGE NUMBER in the summary line, which is
reporting and not behaviour, so the diff still holds. #1134 prefers exiting
non-zero below a coverage fraction; that is now a one-line change to
`rebuildRefusal` and `mayRebuild` with guards already around them, in one place
each, instead of a change to two CLI scripts.
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

/-- Union routes across tiles, FIRST tile to yield a relation owning it.

Returns each route with the tile key it came from — the writer replaces only the
tiles that answered, and that column is what makes a partial run lossless. -/
def unionByFirstTile (perTile : Array (String × Array BusRoute)) : Array (String × BusRoute) :=
  Id.run do
    let mut out : Array (String × BusRoute) := #[]
    for (key, routes) in perTile do
      for r in routes do
        if !out.any (fun p => p.2.osmRelationId == r.osmRelationId) then
          out := out.push (key, r)
    return out

/-- Why this run must not touch the cache, or `none` to proceed.

⚠ EVERY tile must have failed AND the cache must hold something. A first run
against an empty cache proceeds even if everything failed — there is nothing to
protect — and a run where one tile answered proceeds because the writer will
replace only that tile. -/
def rebuildRefusal (existing tileFailures tilesTotal : Nat) : Option String :=
  if tilesTotal > 0 && tileFailures ≥ tilesTotal && existing > 0 then
    some s!"Every tile failed ({tileFailures}/{tilesTotal}) and the cache holds {existing} route(s)"
  else none

/-- Is this run authoritative for the WHOLE bbox?

A complete run may DELETE everything, which is also what retires rows written
before the `tile_key` column existed. A partial run may delete only the keys it
answered for. -/
def isFullRebuild (tileFailures : Nat) : Bool := tileFailures == 0

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

-- ⚠ FIRST TILE OWNS — the opposite of the rail arm, and ported that way.
private def A : BusRoute := { routeRef := "38", routeName := some "from A", osmRelationId := 9, stops := #[] }
private def B : BusRoute := { routeRef := "38", routeName := some "from B", osmRelationId := 9, stops := #[] }
#guard (unionByFirstTile #[("t1", #[A]), ("t2", #[B])]).size == 1
#guard (unionByFirstTile #[("t1", #[A]), ("t2", #[B])])[0]! == ("t1", A)
#guard (unionByFirstTile #[("t2", #[B]), ("t1", #[A])])[0]! == ("t2", B)

-- ⚠ THE REFUSAL. All three conditions are load-bearing and each has its own
-- guard, because a threshold here was measured on production and found to be
-- uncorrelated with the harm it was meant to prevent (#255).
#guard (rebuildRefusal 995 153 153).isSome        -- every tile failed, cache full
#guard (rebuildRefusal 995 152 153).isNone        -- one answered: replace just it
#guard (rebuildRefusal 0 153 153).isNone          -- nothing to protect
#guard (rebuildRefusal 995 0 153).isNone          -- a clean run
#guard (rebuildRefusal 995 0 0).isNone            -- no tiles at all
-- ⚠ A COUNT IS NOT A CONDITION HERE: 796 of 995 routes fetched is not a refusal,
-- however alarming the drop looks, because tile ownership already made it safe.
#guard (rebuildRefusal 995 1 153).isNone

#guard isFullRebuild 0 == true
#guard isFullRebuild 1 == false

#guard buildBusRouteOverpassQuery "51.5" "-0.2" "51.6" "-0.1"
        == "[out:json][timeout:180];relation[route=bus](51.5,-0.2,51.6,-0.1);out body;node(r);out body;"

end Verified.Geo.OsmBusRoutes
