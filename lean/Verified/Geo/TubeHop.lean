import Verified.Geo.SegmentMerge
import Verified.Geo.RailRuns
import Verified.Fix
/-!
# Picking a station (port of `pickBestStation` and its ranking, `src/geo/passes/tube-hop.ts`)

`NearbyStation` is a rail station near a coordinate as the OSM adapter reports
it; `rankStations` orders candidates (an entrance node below the station it
belongs to, a preferred name first) and `pickBestStation` takes the best.
Exact. UNPROVEN; pinned against Node/V8 (`lean/experiments/tube-hop-refs.mts`).
-/

namespace Verified.Geo.TubeHop


/-- A rail station near a coordinate, as the OSM adapter reports it.

`lat`/`lon` are OPTIONAL, matching the TS interface: fixture recordings made
before those fields existed replay without them, and a consumer that wants the
station's own node coordinate must degrade to the query point. The rail-run
line-intersection retry is the consumer that cares — see
`Verified.Geo.RailRunAnnotate.stationCoord`. -/
structure NearbyStation where
  name : String
  subtype : String := "station"
  distanceM : Float
  lat : Option Float := none
  lon : Option Float := none
  deriving Inhabited, BEq, Repr

-- `refinedMode ?? mode` — `SegmentMerge.effectiveMode`, the one definition.
export Verified.Geo.SegmentMerge (effectiveMode)

/-! ## `pickBestStation` -/

/-- Whether a name is an entrance CODE — a bare capital optionally followed by
ONE digit (`"A"`, `"B2"`). The TS regex is `^[A-Z]\d?$`, so `"B22"` and `"a"`
are real names. -/
def isEntranceCode (name : String) : Bool :=
  match name.toList with
  | [c] => c.isUpper
  | [c, d] => c.isUpper && d.isDigit
  | _ => false

def isEntranceLike (s : NearbyStation) : Bool :=
  s.subtype == "subway_entrance" || isEntranceCode s.name

/-- How usable a node is as the NAME of a station, best (0) first.

* **3 — an entrance.** A gate locates the station but is not it.
* **2 — a platform position.** A `stop_position` is a point on the track inside
  the station, and it carries the OPERATOR's name for that platform rather than
  the place's: at St Pancras the Metropolitan platform is tagged
  `"London St Pancras"` while the station node is `"King's Cross St Pancras"`.
  It sits nearer the boarding fix than the station node does, so on distance
  alone it wins, and the ride gets named after a mainline terminus the rider
  never entered.
* **1 — a real station of the WRONG subtype**, when the caller expressed a
  preference. Only `underground-rail.ts` does, with `"subway"`: a shared site
  offers a mainline node and a tube node, and a tube ride should be named after
  the tube one even when the mainline node is nearer.
* **0 — a real station**, of the preferred subtype when there is one.

Tier dominates distance entirely — that is the whole point. A station node
200 m away outranks its own platform at 50 m.

The `prefer` split applies only WITHIN the real-station tier: the platform test
returns before it, so a `stop_position` of the preferred subtype is still 2. -/
def stationTier (s : NearbyStation) (prefer : Option String := none) : Nat :=
  if isEntranceLike s then 3
  else if s.subtype == "stop_position" then 2
  else match prefer with
    | some p => if s.subtype != p then 1 else 0
    | none => 0

/-- The full ordering `pickBestStation` takes the head of, best first. Exported
because the realisable-alight sweep in `RailRunAnnotate` walks the whole order
and cuts at tier ≥ 2 — it needs to tell a station node from a gate without
restating the rule.

Ties keep INPUT ORDER. The TS relies on `Array#sort` being stable; rather than
lean on `List.mergeSort` being left-biased to match it, the index is carried in
the key and compared last, which makes the order TOTAL and the agreement a fact
about the comparator instead of about either sort.

The distance comparison is written as two strict `<` tests falling through to
the index, not as `≠` then `<`. That is deliberate: it makes a NaN distance keep
input order, which is what V8 does (a comparator returning NaN is read as 0). -/
def rankStations (stations : Array NearbyStation) (prefer : Option String := none) :
    Array NearbyStation :=
  let keyed := stations.mapIdx fun i s => (s, i)
  (keyed.toList.mergeSort fun a b =>
    let ta := stationTier a.1 prefer
    let tb := stationTier b.1 prefer
    if ta != tb then ta < tb
    else if a.1.distanceM < b.1.distanceM then true
    else if b.1.distanceM < a.1.distanceM then false
    else a.2 ≤ b.2).toArray.map (·.1)

/-- The best node to name a station by, or `none` when the site offers nothing.

Tiering DEMOTES rather than discards, so a site of nothing but entrances still
answers with the nearest entrance — losing the evidence entirely would be worse
than naming it imprecisely. -/
def pickBestStation (stations : Array NearbyStation) (prefer : Option String := none) :
    Option NearbyStation :=
  (rankStations stations prefer)[0]?

/-! ## Guards (V8 reference values) -/

private def st (name : String) (distanceM : Float) (subtype : String := "station") : NearbyStation :=
  { name, subtype, distanceM }

#guard (pickBestStation #[st "Far" 300, st "Near" 50]).map (·.name) == some "Near"
-- An entrance is skipped for a real station however much further away…
#guard (pickBestStation #[st "Entrance" 5 "subway_entrance", st "Real" 400]).map (·.name) == some "Real"
-- …and so is an entrance CODE name: a bare capital, optionally one digit.
#guard (pickBestStation #[st "A" 5, st "Real" 400]).map (·.name) == some "Real"
#guard (pickBestStation #[st "B2" 5, st "Real" 400]).map (·.name) == some "Real"
-- Two digits, or lowercase, is a real name.
#guard (pickBestStation #[st "B22" 5, st "Real" 400]).map (·.name) == some "B22"
#guard (pickBestStation #[st "a" 5, st "Real" 400]).map (·.name) == some "a"
-- With ONLY entrances the nearest entrance comes back — it still locates the
-- station, so returning nothing would lose the evidence.
#guard (pickBestStation #[st "Entrance" 400 "subway_entrance", st "A" 50]).map (·.name) == some "A"
-- Equal distances keep input order.
#guard (pickBestStation #[st "First" 100, st "Second" 100]).map (·.name) == some "First"
#guard pickBestStation #[] == none

-- A PLATFORM position loses to the station node from four times as far away.
-- This is the #373 shape: naming a Metropolitan ride after the Met platform's
-- own tag gave "London St Pancras", a mainline terminus the rider never entered.
#guard (pickBestStation #[st "London St Pancras" 50 "stop_position",
                          st "King's Cross St Pancras" 200]).map (·.name)
  == some "King's Cross St Pancras"
-- …and beats an entrance, so the three tiers are strictly ordered.
#guard (pickBestStation #[st "Gate C" 10 "subway_entrance",
                          st "Platform" 300 "stop_position"]).map (·.name) == some "Platform"
-- With ONLY platforms the nearest platform still answers — tiering demotes, it
-- never discards.
#guard (pickBestStation #[st "Far platform" 300 "stop_position",
                          st "Near platform" 50 "stop_position"]).map (·.name) == some "Near platform"

/-! ### The `prefer` split

Only `underground-rail.ts` passes one (`"subway"`). It reorders WITHIN the
real-station tier and nowhere else. -/

-- Without it the nearer mainline node wins; with it, the subway node from four
-- times as far.
#guard (pickBestStation #[st "London Euston" 60, st "Euston" 250 "subway"]).map (·.name)
  == some "London Euston"
#guard (pickBestStation #[st "London Euston" 60, st "Euston" 250 "subway"] (some "subway")).map (·.name)
  == some "Euston"
-- It does not rescue a platform: the tier-2 test returns before the split.
#guard (pickBestStation #[st "Platform" 20 "stop_position", st "Station" 400]).map (·.name)
  == some "Station"
#guard (pickBestStation #[st "Platform" 20 "stop_position", st "Station" 400] (some "subway")).map (·.name)
  == some "Station"
-- Among equals distance decides as usual.
#guard (pickBestStation #[st "Far subway" 300 "subway", st "Near subway" 50 "subway"]
          (some "subway")).map (·.name) == some "Near subway"

/-! ### The whole ordering, not just its head

The alight sweep walks the full order and cuts at tier ≥ 2, so the tail is read
too and a change to it must be visible. -/

private def SITE : Array NearbyStation :=
  #[st "Gate A" 5 "subway_entrance", st "Platform 4" 20 "stop_position",
    st "London Terminus" 100, st "Tube Station" 180 "subway", st "B2" 1]

#guard SITE.map (stationTier ·) == #[3, 2, 0, 0, 3]
#guard SITE.map (stationTier · (some "subway")) == #[3, 2, 1, 0, 3]
-- Distance orders within a tier, and only within one: the tier-3 pair sorts
-- "B2" (1 m) before "Gate A" (5 m) while both sit behind the 180 m tube node.
#guard (rankStations SITE).map (·.name)
  == #["London Terminus", "Tube Station", "Platform 4", "B2", "Gate A"]
#guard (rankStations SITE (some "subway")).map (·.name)
  == #["Tube Station", "London Terminus", "Platform 4", "B2", "Gate A"]

end Verified.Geo.TubeHop
