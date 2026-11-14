import Verified.FloatConst
/-!
# The refine-mode cascade

Given a segment's mode, pace and nearby OSM ways, decide what it is and what to
call it. In the fold, `UndergroundAnnotate.sideWayName` names the walk left over
when a tube ride is carved out, and `reenrichSplitWalks` names the on-foot
remainders of `vehicleSplit`, re-running the enrichment stage on one leg.

UNPROVEN.
-/

namespace Verified.Geo.RefineMode

/-- One nearby OSM way, as `nearbyWays` returns it. -/
structure NearbyWay where
  /-- `"highway"`, `"railway"`, `"waterway"`, `"aeroway"`. -/
  type : String
  /-- `"motorway"`, `"rail"`, `"subway"`, `"river"`, … -/
  subtype : String
  name : Option String := none
  distanceM : Option Float := none
  deriving Inhabited, Repr

/-- What the cascade decides. -/
structure ModeRefinement where
  mode : String
  /-- `"low"` / `"medium"` / `"high"` — a label, not a number. -/
  confidence : String
  reason : String
  wayName : Option String := none
  deriving Inhabited, BEq, Repr

/-- Highway subtypes cars cannot be on, so a vehicular segment skips them when a
closer pedestrian way would otherwise win the label. -/
def PEDESTRIAN_HIGHWAY_SUBTYPES : List String :=
  ["footway", "path", "pedestrian", "cycleway", "bridleway", "steps"]

/-- Major roads, as the rail-versus-road tie-break counts them. -/
private def MAJOR_HIGHWAY : List String := ["motorway", "trunk", "primary", "secondary"]

/-- How far a named way may sit from a pavement and still be the street that
pavement belongs to. A pavement runs a few metres from its carriageway; a wide
dual carriageway reaches ~25 m. Beyond that it is a different street. -/
def WALK_NAME_BORROW_MAX_M : Float := 30
/-- Pace below which a nearby unnamed footway is plausibly the pavement. -/
def WALK_NAME_BORROW_MAX_KMH : Float := 10

open Verified.FloatConst (posInf)

/-- `w.distanceM`, or infinity: an absent distance loses every comparison. -/
private def dist (w : NearbyWay) : Float := w.distanceM.getD posInf

/-- A non-empty name: `""` is no name. -/
private def named (w : NearbyWay) : Bool :=
  match w.name with | some n => n ≠ "" | none => false

/-- The highway that best represents what the user is on: at driving speed the
first driveable one, otherwise the first.

⚠ The order is load-bearing and is not "closest first": it is
`dedupNearestWays`' insertion order, roughly nearest at the first sample. On the
corpus it leaves 5 regressed truth rows, against 14 for global-nearest and 17
for coverage-ranked. Do not sort by distance.

Also refuted: preferring the nearest named way for the name at walking pace
(cost eleven confirmed rows), and naming by the matcher's route dominance
(`QMatchResult.wayUm`: broke 12, fixed 2), since the route can miss the true way.
What survived is in `WalkAnnotate.drawMatcher`: the report names a leg only when
this cascade named nothing. -/
private def pickBestHighway (highways : Array NearbyWay) (speedKmh : Float)
    (h : highways.size > 0) : NearbyWay :=
  if speedKmh > 30 then
    match highways.find? (fun h => !(PEDESTRIAN_HIGHWAY_SUBTYPES.contains h.subtype)) with
    | some d => d
    | none => highways[0]
  else highways[0]

/-- Name a walk after the street its pavement belongs to: OSM maps the pavement
as its own, usually unnamed, way, so the nearest way to a walking fix is an
anonymous footway beside the named street. `none` beyond
`WALK_NAME_BORROW_MAX_M`, where it is a different street. -/
private def borrowStreetName (highways : Array NearbyWay) : Option String :=
  let best := highways.foldl (init := (none : Option NearbyWay)) fun best h =>
    if !named h then best
    else match best with
      | none => some h
      | some b => if dist h < dist b then some h else some b
  match best with
  | some b => if dist b ≤ WALK_NAME_BORROW_MAX_M then b.name else none
  | none => none

/-- The reason a leg carries when the map had no ways near it at all — no
coverage, not a road. `PreFold.trainContinuesWithoutMap` reads it. -/
def NO_OSM_CONTEXT : String := "no OSM context"

/-- The reason a classifier "train" carries when demoted to driving for want of
a railway in its samples, with no major road either: absence, not a road. Off
the mirror's ground a road layer can be fetched before the railway one. -/
def NO_RAIL_EVIDENCE : String := "no rail evidence"

/--
The cascade, in order; each arm returns. The rail-versus-road tie-break: "any
rail nearby → train" is hijacked by freight beside a motorway, "any major road
→ not train" by a tube under an arterial, so with distances known it prefers
whichever the track was closer to, and falls back to presence only without.
-/
def refineModeLegacyCascade (originalMode : String) (speedKmh : Float)
    (ways : Array NearbyWay) : ModeRefinement :=
  let railways := ways.filter (·.type == "railway")
  let highways := ways.filter (·.type == "highway")
  let aeroways := ways.filter (·.type == "aeroway")
  let waterways := ways.filter (·.type == "waterway")

  if h : aeroways.size > 0 then
    let aero := aeroways[0]
    if aero.subtype == "runway" || aero.subtype == "taxiway" then
      { mode := "plane", confidence := "high", reason := "on runway/taxiway", wayName := aero.name }
    else
      { mode := "stationary", confidence := "high", reason := "at airport", wayName := aero.name }
  else
  let majorHighways := highways.filter (fun h => MAJOR_HIGHWAY.contains h.subtype)
  -- `Math.min(...[])` is `Infinity`, which is what an empty side means here.
  let minDist (xs : Array NearbyWay) : Float := xs.foldl (fun m w => min m (dist w)) posInf
  let railMinM := minDist railways
  let hwyMinM := if majorHighways.isEmpty then posInf else minDist majorHighways
  let haveDistanceInfo := railMinM.isFinite || hwyMinM.isFinite
  let preferRail := if haveDistanceInfo then railMinM ≤ hwyMinM else majorHighways.isEmpty
  let railPick := if speedKmh > 30 && preferRail then railways[0]? else none
  if let some rail := railPick then
    { mode := "train", confidence := "high", reason := s!"on {rail.subtype}", wayName := rail.name }
  else
  -- The classifier said "train" with no rail in any sample: almost certainly
  -- motorway cruise control, whose linearity and steady pace match the profile.
  if originalMode == "train" && railways.isEmpty then
    if let some hw := majorHighways[0]? then
      { mode := "driving", confidence := "high", reason := s!"on {hw.subtype}", wayName := hw.name }
    else { mode := "driving", confidence := "medium", reason := NO_RAIL_EVIDENCE }
  else
  if hh : highways.size > 0 then
    let hw := pickBestHighway highways speedKmh hh
    -- The same distance bar whether or not the pick is named, or a far named
    -- pick would displace a nearer one the borrow finds.
    let hwFar := dist hw > WALK_NAME_BORROW_MAX_M
    let hwName :=
      if speedKmh < WALK_NAME_BORROW_MAX_KMH then
        ((if hwFar then none else hw.name).orElse fun _ => borrowStreetName highways)
      else hw.name
    if (hw.subtype == "footway" || hw.subtype == "path" || hw.subtype == "pedestrian")
        && speedKmh < 10 then
      { mode := "walking", confidence := "high", reason := s!"on {hw.subtype}", wayName := hwName }
    else if hw.subtype == "cycleway" then
      { mode := "cycling", confidence := "high", reason := "on cycleway", wayName := hw.name }
    else if (hw.subtype == "motorway" || hw.subtype == "trunk" || hw.subtype == "primary")
        && speedKmh > 30 then
      { mode := "driving", confidence := "high", reason := s!"on {hw.subtype}", wayName := hw.name }
    else if speedKmh > 30 && !(PEDESTRIAN_HIGHWAY_SUBTYPES.contains hw.subtype) then
      -- Generic road at driving pace: the "on Great Central Way" label.
      { mode := originalMode, confidence := "medium", reason := s!"on {hw.subtype}", wayName := hw.name }
    else
      { mode := originalMode, confidence := "medium", reason := s!"near {hw.subtype}", wayName := hwName }
  else
  -- A navigable waterway, which excludes drains, ditches and streams.
  let navigable := waterways.filter fun w => ["river", "canal", "fairway"].contains w.subtype
  let waterPick := if speedKmh > 3 && speedKmh < 50 then navigable[0]? else none
  if let some ww := waterPick then
    { mode := "boat", confidence := "medium", reason := s!"on {ww.subtype}", wayName := ww.name }
  else
    { mode := originalMode, confidence := "low", reason := NO_OSM_CONTEXT }

/-! ## Sampling a leg's ways

Both callers take evenly spaced samples and dedup the union keeping each way's
minimum distance. Shared, since `pickBestHighway` reads the dedup's order. -/

/-- Evenly spaced indices into a run of `n` points: first, last, and
`count - 2` between. `Math.floor(i * (n - 1) / max(1, count - 1))` — `Nat`
division is that floor. -/
def sampleIdxs (n count : Nat) : Array Nat :=
  (Array.range count).map fun i => (i * (n - 1)) / (max 1 (count - 1))

/-- Upsert into a JS `Map`: a key already present keeps its original position and
only its value is replaced. Load-bearing — the deduped ways are handed to the
cascade in this order, and `pickBestHighway` reads the first driveable one. -/
private def upsert (m : Array (String × NearbyWay)) (k : String) (v : NearbyWay)
    : Array (String × NearbyWay) :=
  match m.findFinIdx? (fun p => p.1 == k) with
  | some i => if dist v < dist m[i].2 then m.set i (k, v) else m
  | none => m.push (k, v)

/-- The union of every sample's ways, deduped on `(type, subtype, name)` keeping
the minimum distance (the tie-break reads it), in first-sample order. Takes the
answers, each read twice (here and for the road-corridor fraction). -/
def dedupNearestWays (wayResults : Array (Array NearbyWay)) : Array NearbyWay :=
  (wayResults.foldl (init := (#[] : Array (String × NearbyWay))) fun acc ways =>
    ways.foldl (init := acc) fun acc w =>
      let nm := w.name.getD ""
      upsert acc s!"{w.type}/{w.subtype}/{nm}" w).map (·.2)

/-! ## The physical-plausibility override

`rejectImplausibleDriving` runs on the cascade's verdict: a tube ride under an
arterial looks like driving, the road being nearest at the surface fixes. -/

/-- Max sustained pace plausible on a non-motorway road. UK urban limit is 30 mph
(48 km/h); an urban dual carriageway 50 mph (80 km/h). Above this off a motorway
the only physically plausible mode is rail. -/
def URBAN_NON_MOTORWAY_MAX_KMH : Float := 80

/-- Subtypes that permit sustained speeds past that bar. Anything else is a city
or arterial road however OSM grades it — central London tags as `trunk` plenty of
surface roads that sit directly over an Underground tunnel. -/
def MOTORWAY_GRADE_SUBTYPES : List String := ["motorway", "motorway_link"]

/-- How near a parallel subway counts as evidence the segment is on the tube
under the road rather than on the road. Generous: surface GPS over a station
typically sits 20-50 m from the line's mapped geometry. -/
def SUBWAY_PARALLEL_DISTANCE_M : Float := 100

/-- What the override decides. Not a `ModeRefinement`: off the override path its
`reason` must be absent so the caller's `plausible.reason ?? refined.reason`
falls back to the cascade's. -/
structure Plausible where
  mode : String
  wayName : Option String
  reason : Option String := none
  deriving Inhabited, BEq, Repr

/-- Demote a "driving" verdict no road can explain to the subway beside it,
sparing legal motorway speed, rides with no subway in range, and plausible
urban paces. -/
def rejectImplausibleDriving (refined : Plausible) (maxSpeedKmh : Float)
    (ways : Array NearbyWay) : Plausible :=
  if refined.mode != "driving" then refined
  else if maxSpeedKmh ≤ URBAN_NON_MOTORWAY_MAX_KMH then refined
  else if ways.any (fun w => w.type == "highway" && MOTORWAY_GRADE_SUBTYPES.contains w.subtype) then
    refined
  else
    match ways.find? (fun w =>
        w.type == "railway" && w.subtype == "subway" && dist w < SUBWAY_PARALLEL_DISTANCE_M) with
    | none => refined
    | some subway =>
      let kmh := Float.floor (maxSpeedKmh + 0.5)
      { mode := "train", wayName := subway.name
        reason := some
          s!"{kmh.toInt64.toInt} km/h max exceeds urban non-motorway limit; subway in range" }

/-! ## Guards -/

section RefineGuards

private def rw (ty sub : String) (nm : Option String) (d : Option Float) : NearbyWay :=
  { type := ty, subtype := sub, name := nm, distanceM := d }

#guard sampleIdxs 9 5 == #[0, 2, 4, 6, 8]
#guard sampleIdxs 10 5 == #[0, 2, 4, 6, 9]
#guard sampleIdxs 3 3 == #[0, 1, 2]
-- `Math.max(1, count - 1)` is what keeps the single-point run from dividing by
-- zero; `Nat` subtraction truncates instead, so this pins that the two agree.
#guard sampleIdxs 1 1 == #[0]

private def DEDUP_SAMPLES : Array (Array NearbyWay) := #[
  #[rw "highway" "residential" (some "Midway") (some 12),
    rw "highway" "footway" none (some 3)],
  #[rw "highway" "residential" (some "Midway") (some 8),
    rw "highway" "primary" (some "Holloway Road") (some 9)],
  #[rw "highway" "primary" (some "Holloway Road") (some 40),
    rw "railway" "subway" (some "Piccadilly") (some 30)]]

-- The nearer way is not first: `Midway`, re-found at 8 m in the second sample,
-- keeps its slot ahead of the 3 m footway, and `pickBestHighway` reads
-- `highways[0]`. This pins the order, not its rightness.
#guard (dedupNearestWays DEDUP_SAMPLES).map (fun w =>
    s!"{w.type}/{w.subtype}/{w.name.getD ""}@{w.distanceM.getD 0}")
  == #["highway/residential/Midway@8.000000", "highway/footway/@3.000000",
       "highway/primary/Holloway Road@9.000000", "railway/subway/Piccadilly@30.000000"]

private def SUBWAY : NearbyWay := rw "railway" "subway" (some "Metropolitan") (some 40)
private def FAR_SUBWAY : NearbyWay := rw "railway" "subway" (some "Metropolitan") (some 140)
private def MOTORWAY : NearbyWay := rw "highway" "motorway" (some "M1") (some 5)
private def ARTERIAL : NearbyWay := rw "highway" "trunk" (some "Euston Road") (some 6)
private def held (m : String) : Plausible := { mode := m, wayName := some "Euston Road" }
private def rid (m : String) (kmh : Float) (ws : Array NearbyWay) : Plausible :=
  rejectImplausibleDriving (held m) kmh ws

#guard rid "walking" 99 #[ARTERIAL, SUBWAY] == held "walking"
-- The bar is `≤`, so 80 exactly is held.
#guard rid "driving" 80 #[ARTERIAL, SUBWAY] == held "driving"
#guard rid "driving" 99 #[MOTORWAY, SUBWAY] == held "driving"
#guard rid "driving" 99 #[ARTERIAL, FAR_SUBWAY] == held "driving"
#guard rid "driving" 99 #[ARTERIAL, SUBWAY]
  == { mode := "train", wayName := some "Metropolitan"
       reason := some "99 km/h max exceeds urban non-motorway limit; subway in range" }
-- `Math.round(98.5)` is 99: half toward +∞, not to-even.
#guard (rid "driving" 98.5 #[ARTERIAL, SUBWAY]).reason
  == some "99 km/h max exceeds urban non-motorway limit; subway in range"

end RefineGuards

end Verified.Geo.RefineMode
