/-!
# Reading a route relation's stop sequence

Shared by `refresh-rail-stops` and `refresh-bus-routes`: index the member nodes
by id, then read each relation's stops in member order, preferring
`stop_position` roles, else platforms.

⚠ Member order is the route direction and must not be sorted. `seq` counts the
kept stops, so an unresolved member leaves no gap.

The fallback is all-or-nothing: under two `stop_position` stops, the whole
sequence is re-read from platforms, never mixed. Under two either way resolves
to nothing.
-/

namespace Verified.Geo.OsmRouteMembers

/-- A relation member, as Overpass returns it. Everything is optional because
Overpass omits what does not apply, and a member missing any of the three fields
this cares about is skipped rather than defaulted. -/
structure Member where
  type : Option String := none
  ref : Option Nat := none
  role : Option String := none
  deriving Repr, Inhabited

/-- A node the mirror resolved: coordinates, and a name if OSM has one. An
unnamed `stop_position` is kept (its coordinates still merge into stations) with
`name = none`, not `""`. -/
structure ResolvedNode where
  lat : Float
  lon : Float
  name : Option String
  deriving Repr, Inhabited

/-- An ordered stop. `seq` is the position within the relation's stop sequence,
which is the route direction. -/
structure RouteStop where
  name : Option String
  lat : Float
  lon : Float
  seq : Nat
  deriving Repr, Inhabited, BEq

/-- The roles that mark where riders actually board — the node the vehicle
stops at, in PT-v2. -/
def STOP_ROLES : List String := ["stop", "stop_entry_only", "stop_exit_only"]

/-- The fallback, for routes mapped without `stop_position` nodes. -/
def PLATFORM_ROLES : List String := ["platform", "platform_entry_only", "platform_exit_only"]

/-- The minimum stops a relation needs to be worth keeping. One stop cannot
anchor a call pattern. -/
def MIN_STOPS : Nat := 2

private def lookup (nodes : Array (Nat × ResolvedNode)) (id : Nat) : Option ResolvedNode :=
  (nodes.find? (fun p => p.1 == id)).map (·.2)

/-- The ordered, resolvable stop nodes of one relation under a given role set. -/
def stopsForRoles (members : Array Member) (nodes : Array (Nat × ResolvedNode))
    (roles : List String) : Array RouteStop := Id.run do
  let mut stops : Array RouteStop := #[]
  for m in members do
    -- A member is skipped, never defaulted, when it is not a node, carries no
    -- ref, or carries no role: all three are how Overpass says "not this".
    if m.type != some "node" then continue
    let some ref := m.ref | continue
    let some role := m.role | continue
    if !roles.contains role then continue
    let some node := lookup nodes ref | continue
    -- `seq` counts the kept stops, so an unresolvable member leaves no hole.
    stops := stops.push { name := node.name, lat := node.lat, lon := node.lon, seq := stops.size }
  return stops

/-- A relation's ordered stops: `stop_position` members when they reach
`MIN_STOPS`, platform members otherwise, and nothing if neither does. -/
def resolveOrderedStops (members : Array Member) (nodes : Array (Nat × ResolvedNode))
    : Array RouteStop :=
  let byStop := stopsForRoles members nodes STOP_ROLES
  let stops := if byStop.size < MIN_STOPS then stopsForRoles members nodes PLATFORM_ROLES else byStop
  if stops.size < MIN_STOPS then #[] else stops

/-! ## Guards -/

private def N (id : Nat) (name : Option String) : Nat × ResolvedNode :=
  (id, { lat := 51.5 + id.toFloat / 1000.0, lon := -0.1, name })
private def M (ref : Nat) (role : String) : Member :=
  { type := some "node", ref := some ref, role := some role }

private def NODES : Array (Nat × ResolvedNode) := #[N 1 (some "A"), N 2 (some "B"), N 3 none]

-- The plain case: three stop_position members, in member order, seq 0..2.
#guard (resolveOrderedStops #[M 1 "stop", M 2 "stop", M 3 "stop"] NODES).size == 3
#guard (resolveOrderedStops #[M 1 "stop", M 2 "stop", M 3 "stop"] NODES).map (·.seq) == #[0, 1, 2]
#guard (resolveOrderedStops #[M 1 "stop", M 2 "stop", M 3 "stop"] NODES).map (·.name)
        == #[some "A", some "B", none]

-- Member order is the direction — reversing the members reverses the stops.
-- Nothing sorts, and a guard is the only thing standing between that and a
-- well-meaning `.qsort` on name.
#guard (resolveOrderedStops #[M 2 "stop", M 1 "stop"] NODES).map (·.name) == #[some "B", some "A"]

-- An unnamed stop is kept with `none`, because its coordinates still resolve.
#guard (resolveOrderedStops #[M 3 "stop", M 1 "stop"] NODES).map (·.name) == #[none, some "A"]

-- One stop cannot anchor a call pattern.
#guard (resolveOrderedStops #[M 1 "stop"] NODES).isEmpty
#guard (resolveOrderedStops #[] NODES).isEmpty

-- A member whose node is absent from the response leaves no gap: the second
-- kept stop is seq 1, not seq 2.
#guard (resolveOrderedStops #[M 1 "stop", M 99 "stop", M 2 "stop"] NODES).map (·.seq) == #[0, 1]

-- Roles outside both sets are ignored — `forward`/`backward` way members are
-- the common case and they are not stops.
#guard (resolveOrderedStops #[M 1 "forward", M 2 "backward"] NODES).isEmpty

-- The platform fallback fires only when stop_position cannot reach two.
#guard (resolveOrderedStops #[M 1 "platform", M 2 "platform"] NODES).size == 2
-- All or nothing: one stop_position plus two platforms yields the two
-- platforms, not a mixture of all three. Mixing would interleave two different
-- mappings of one route and the order would be neither of them.
#guard (resolveOrderedStops #[M 3 "stop", M 1 "platform", M 2 "platform"] NODES).map (·.name)
        == #[some "A", some "B"]
-- Two stop_positions are enough, so the platforms are not consulted at all.
#guard (resolveOrderedStops #[M 1 "stop", M 2 "stop", M 3 "platform"] NODES).size == 2

-- A non-node member is skipped even with a stop role — ways carry roles too.
#guard (resolveOrderedStops
          #[{ type := some "way", ref := some 1, role := some "stop" }, M 2 "stop"] NODES).isEmpty

end Verified.Geo.OsmRouteMembers
