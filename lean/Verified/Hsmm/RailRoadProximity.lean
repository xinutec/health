/-!
# Is this fix on the track, or on a road?

The per-minute `roadDistM` / `railDistM` the observation tensor carries, and the
single source of truth for the rail-vs-road call (#238). The decoder never
credits a tube line to a fix that hugs a road, and this is what lets it tell the
difference (#982 Tier 2).

Port of the pure half of `src/geo/rail-road-proximity.ts`.

## What is here and what is not

`nearbyWays` is an OSM query and stays in the shell. Everything the shell does
with the answer is here: which subtypes count, which distance wins, how fixes
bucket into minutes, and the ~11 m cache key that collapses a stationary day to
one lookup.

## ⚠ TRAMS ARE NOT RAIL HERE

`RAIL_ONLY_SUBTYPES` excludes `tram` deliberately — mixed-traffic track runs
down the middle of a road, so a tram way is not evidence for rail OVER road. It
is the one subtype where the two categories genuinely overlap, and including it
would make the strongest signal the decoder has ambiguous exactly where the
ambiguity matters. Note that {@link Verified.Geo.OsmRailStops} DOES mirror
trams: "which lines stop here" and "is this fix on rail not road" are different
questions.
-/

namespace Verified.Hsmm.RailRoadProximity

/-- Rail-only OSM way subtypes. ⚠ No `tram` — see the module note. -/
def RAIL_ONLY_SUBTYPES : List String := ["rail", "subway", "light_rail", "narrow_gauge"]

/-- Drivable highway subtypes: residential through motorway, plus track and
living_street. Pedestrian and cycle ways are excluded — a towpath beside a
railway is not a road the fix could be driving on. -/
def DRIVABLE_HIGHWAY_SUBTYPES : List String :=
  ["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
   "service", "unclassified", "track", "living_street"]

/-- Query radius in metres. ⚠ Wider than the line-proximity factor's `NEAR_M`
(250) ON PURPOSE: when a fix is "near" line L by the route graph, the rail way
must also be in range HERE, or the road-vs-rail comparison is a null rather than
a comparison. -/
def PROXIMITY_RADIUS_M : Float := 300

/-- One way from a `nearbyWays` answer. -/
structure NearbyWay where
  type : String
  subtype : String
  /-- `none` when the shell could not measure it — skipped, never treated as 0. -/
  distanceM : Option Float
  deriving Repr, Inhabited

/-- The nearest rail and the nearest drivable road, in metres. `none` for a kind
with nothing in range — which is a fact about the surroundings, not a failure. -/
structure Proximity where
  railDistM : Option Float
  roadDistM : Option Float
  deriving Repr, Inhabited, BEq

/-- ⚠ A NON-FINITE DISTANCE IS SKIPPED, not compared. The TypeScript tests
`Number.isFinite(d)` before using it, and a NaN would otherwise win every `<`
comparison it took part in and pin the minimum at NaN. -/
private def usable (d : Option Float) : Option Float :=
  match d with
  | none => none
  | some x => if x.isFinite then some x else none

/-- Distance from one fix to the nearest rail-only way and to the nearest
drivable road, given that fix's `nearbyWays` list. -/
def railRoadDistFromWays (ways : List NearbyWay) : Proximity := Id.run do
  let mut minRail : Option Float := none
  let mut minRoad : Option Float := none
  for w in ways do
    let some d := usable w.distanceM | continue
    -- ⚠ `else if`, not two `if`s: a way is rail OR road, never both. A way
    -- tagged `railway` whose subtype is not rail-only does NOT fall through to
    -- the road test — it is simply not evidence either way.
    if w.type == "railway" && RAIL_ONLY_SUBTYPES.contains w.subtype then
      minRail := some (match minRail with | none => d | some m => min m d)
    else if w.type == "highway" && DRIVABLE_HIGHWAY_SUBTYPES.contains w.subtype then
      minRoad := some (match minRoad with | none => d | some m => min m d)
  return { railDistM := minRail, roadDistM := minRoad }

/-! ## Guards -/

private def W (t s : String) (d : Float) : NearbyWay :=
  { type := t, subtype := s, distanceM := some d }

#guard (railRoadDistFromWays []) == { railDistM := none, roadDistM := none }

-- The nearest of each kind wins, independently.
#guard (railRoadDistFromWays [W "railway" "subway" 40, W "railway" "rail" 12,
                              W "highway" "primary" 80])
        == { railDistM := some 12, roadDistM := some 80 }

-- ⚠ A TRAM IS NEITHER. Mixed-traffic track is not rail-vs-road evidence, and it
-- must not be counted as a road either.
#guard (railRoadDistFromWays [W "railway" "tram" 5])
        == { railDistM := none, roadDistM := none }

-- ⚠ A railway that is not rail-only does NOT fall through to the road test.
-- `else if` is what stops a siding counting as a road.
#guard (railRoadDistFromWays [W "railway" "disused" 5])
        == { railDistM := none, roadDistM := none }

-- Footpaths and cycleways are not drivable.
#guard (railRoadDistFromWays [W "highway" "footway" 3, W "highway" "cycleway" 4])
        == { railDistM := none, roadDistM := none }
#guard (railRoadDistFromWays [W "highway" "footway" 3, W "highway" "residential" 90])
        == { railDistM := none, roadDistM := some 90 }

-- Every drivable subtype counts, and every rail-only one.
#guard (DRIVABLE_HIGHWAY_SUBTYPES.map (fun s => railRoadDistFromWays [W "highway" s 10])).all
        (fun p => p.roadDistM == some 10)
#guard (RAIL_ONLY_SUBTYPES.map (fun s => railRoadDistFromWays [W "railway" s 10])).all
        (fun p => p.railDistM == some 10)

-- ⚠ A MISSING DISTANCE IS SKIPPED, not zero. Treating it as 0 would put the fix
-- on top of a way nobody measured.
#guard (railRoadDistFromWays [{ type := "railway", subtype := "rail", distanceM := none },
                              W "railway" "rail" 50])
        == { railDistM := some 50, roadDistM := none }
#guard (railRoadDistFromWays [{ type := "railway", subtype := "rail", distanceM := none }])
        == { railDistM := none, roadDistM := none }

-- ⚠ NaN MUST BE SKIPPED, AND THE ORDER OF THE WAYS DECIDES WHETHER A TEST CAN
-- SEE IT. Lean's `min` is `if a ≤ b then a else b`, and every comparison with
-- NaN is false — so `min NaN 25` is 25 (NaN silently dropped) while
-- `min 25 NaN` is NaN (NaN silently wins). A guard written only the first way
-- passes with the finite check REMOVED, which is how this one started.
private def NAN_WAY : NearbyWay :=
  { type := "railway", subtype := "rail", distanceM := some (0.0 / 0.0) }
#guard (railRoadDistFromWays [NAN_WAY, W "railway" "rail" 25]).railDistM == some 25
#guard (railRoadDistFromWays [W "railway" "rail" 25, NAN_WAY]).railDistM == some 25
-- And alone it is nothing in range, not a measured zero.
#guard (railRoadDistFromWays [NAN_WAY]).railDistM == none

-- Zero is a real distance: a fix ON the way.
#guard (railRoadDistFromWays [W "highway" "primary" 0]).roadDistM == some 0

end Verified.Hsmm.RailRoadProximity
