import Verified.Geo.Factors
/-!
# The legacy refine-mode cascade (port of `refineModeLegacyCascade`,
`src/geo/osm.ts`)

Given a segment's original mode, its pace, and the OSM ways near it, decide what
the segment actually is and what to call it.

## Why the LEGACY arm and not the factor scorer

`refineMode` dispatches on `useFactorScorer()`, which reads `USE_FACTOR_SCORER`
from the environment. Nothing in this repo sets it — only tests, via
`vi.stubEnv` — so the golden corpus, and therefore every parity measurement,
takes this cascade. `Verified.Geo.Factors` ports the OTHER arm
(`refineModeViaFactors`); the two are alternatives, not layers, and which one is
live is an environment fact rather than a code fact.

STATED BECAUSE IT IS NOT VERIFIABLE FROM HERE: what the production deployment
sets is unknown — its manifests are not in this repo. If production runs with the
flag on, then production and the corpus take different arms, and this module is
the corpus's.

## What reaches it inside the fold

Two callers. `UndergroundAnnotate.sideWayName` names the walk left over when a
tube ride is carved out of its host. `Enrich.enrichMovingSegment` names the
on-foot remainders `vehicleSplit` leaves behind, via `reenrichSplitWalks`.

The `osm` enrichment STAGE that calls `refineMode` for every moving segment runs
before the 38-pass cascade and is not the fold's business — but it calls the same
function this ports, and `reenrichSplitWalks` is that stage re-run on one leg.

`ModeRefinement.factorBreakdown` is not modelled: the TS populates it only on the
factor-scorer arm, and this is the other one.

UNPROVEN.
-/

namespace Verified.Geo.RefineMode

open Verified.Geo.Factors (NearbyWay)

/-- What the cascade decides. -/
structure ModeRefinement where
  mode : String
  /-- `"low"` / `"medium"` / `"high"` — a label, not a number. -/
  confidence : String
  reason : String
  wayName : Option String := none
  deriving Inhabited, BEq, Repr

/-- Highway subtypes cars cannot be on, so a vehicular segment skips them when a
closer pedestrian way would otherwise win the label. NOT the complement of
`Factors.driveableHighwaySubtypes` — that list is the scorer's, this one is the
cascade's, and `steps`/`bridleway` appear only here. -/
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

private def posInf : Float := 1.0 / 0.0

/-- `w.distanceM ?? Infinity` — an absent distance loses every comparison, which
is the TS's own reading of a missing measurement. -/
private def dist (w : NearbyWay) : Float := w.distanceM.getD posInf

/-- A non-empty name. The TS tests `w.name` for TRUTHINESS, so `""` is no name. -/
private def named (w : NearbyWay) : Bool :=
  match w.name with | some n => n ≠ "" | none => false

/-- The highway that best represents what the user is on. `highways` arrives
CLOSEST-FIRST from the adapter and the order is load-bearing: at driving speed
this takes the first driveable one, and otherwise the first outright. -/
private def pickBestHighway (highways : Array NearbyWay) (speedKmh : Float) : NearbyWay :=
  if speedKmh > 30 then
    match highways.find? (fun h => !(PEDESTRIAN_HIGHWAY_SUBTYPES.contains h.subtype)) with
    | some d => d
    | none => highways[0]!
  else highways[0]!

/-- Name a walk after the street its pavement belongs to.

OSM models a street's pavement and its carriageway as separate ways at the same
place, and the pavement is almost always unnamed — so the way CLOSEST to a
walking fix is an anonymous `footway` and reading its name renders the leg with
no street at all, while the street sits a few metres away in the same result set.

`none` past `WALK_NAME_BORROW_MAX_M`: beyond that it is a different street, and
naming the walk after it is exactly the confidently-wrong label this avoids. -/
private def borrowStreetName (highways : Array NearbyWay) : Option String :=
  let best := highways.foldl (init := (none : Option NearbyWay)) fun best h =>
    if !named h then best
    else match best with
      | none => some h
      | some b => if dist h < dist b then some h else some b
  match best with
  | some b => if dist b ≤ WALK_NAME_BORROW_MAX_M then b.name else none
  | none => none

/--
The cascade, in its own order. Each arm returns; falling through is what makes
the next one reachable.

The rail-versus-road tie-break is the one worth reading twice. "Any rail nearby →
train" is hijacked by a freight line beside a motorway; "any major road nearby →
not train" is hijacked by a tube line under an urban arterial. So when distances
are known it prefers whichever the track was actually CLOSER to, and only falls
back to presence when neither side reports a distance.
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
  if railways.size > 0 && speedKmh > 30 && preferRail then
    let rail := railways[0]!
    { mode := "train", confidence := "high", reason := s!"on {rail.subtype}", wayName := rail.name }
  else
  -- The classifier said "train" with no rail in any sample: almost certainly
  -- motorway cruise control, whose linearity and steady pace match the profile.
  if originalMode == "train" && railways.isEmpty then
    if majorHighways.size > 0 then
      let hw := majorHighways[0]!
      { mode := "driving", confidence := "high", reason := s!"on {hw.subtype}", wayName := hw.name }
    else { mode := "driving", confidence := "medium", reason := "no rail evidence" }
  else
  if highways.size > 0 then
    let hw := pickBestHighway highways speedKmh
    -- The SAME distance bar applies whether or not the pick is named. The bar is
    -- about the DISTANCE, not about how the name was obtained, so a named pick
    -- past it is exactly as wrong — and without this the code is stricter about
    -- naming a walk when its pick is anonymous than when its pick is named-but-
    -- far, letting a far named pick displace a nearer one the borrow would find.
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
  if navigable.size > 0 && speedKmh > 3 && speedKmh < 50 then
    let ww := navigable[0]!
    { mode := "boat", confidence := "medium", reason := s!"on {ww.subtype}", wayName := ww.name }
  else
    { mode := originalMode, confidence := "low", reason := "no OSM context" }

/-! ## Sampling a leg's ways

Both callers ask the same question of a leg — what ways lie along it — in the
same two steps: take evenly spaced samples, then dedup the union keeping each
way's MINIMUM distance. Shared rather than copied, because the ORDER the dedup
produces is what `pickBestHighway` reads, and two copies of an order-sensitive
helper is how a port drifts (#426). -/

/-- Evenly spaced indices into a run of `n` points: first, last, and
`count - 2` between. `Math.floor(i * (n - 1) / max(1, count - 1))` — `Nat`
division is that floor. -/
def sampleIdxs (n count : Nat) : Array Nat :=
  (Array.range count).map fun i => (i * (n - 1)) / (max 1 (count - 1))

/-- Upsert into a JS `Map`: a key already present keeps its ORIGINAL position and
only its value is replaced. Load-bearing — the deduped ways are handed to the
cascade in this order, and `pickBestHighway` reads the FIRST driveable one. -/
private def upsert (m : Array (String × NearbyWay)) (k : String) (v : NearbyWay)
    : Array (String × NearbyWay) :=
  match m.findIdx? (fun p => p.1 == k) with
  | some i => if dist v < dist m[i]!.2 then m.set! i (k, v) else m
  | none => m.push (k, v)

/-- The union of every sample's ways, deduped on `(type, subtype, name)` keeping
the MINIMUM distance — a way brushed past at one sample cannot outweigh one
hugged at four others, and the distance is what the rail-versus-road tie-break
reads. First-SAMPLE order, per `upsert`.

Takes the ANSWERS rather than the lookup: the TS asks each sample once and reads
the result twice (here, and for the road-corridor fraction), so a lookup taken
twice would be this function's shape rather than the pipeline's. -/
def dedupNearestWays (wayResults : Array (Array NearbyWay)) : Array NearbyWay :=
  (wayResults.foldl (init := (#[] : Array (String × NearbyWay))) fun acc ways =>
    ways.foldl (init := acc) fun acc w =>
      let nm := w.name.getD ""
      upsert acc s!"{w.type}/{w.subtype}/{nm}" w).map (·.2)

/-! ## The physical-plausibility override

`rejectImplausibleDriving` runs AFTER the cascade, on its verdict. A tube ride
under an arterial looks like driving to the cascade, because the road is the
closest way at the surface fixes bracketing the tunnel. -/

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

/-- What the override decides. NOT a `ModeRefinement`, and the difference is
load-bearing: the TS hands this function `{mode, wayName}` only, so on every
non-override path its `reason` is ABSENT and the caller's `plausible.reason ??
refined.reason` falls back to the cascade's. A `ModeRefinement` here would carry
a reason on that path and silently win the `??`. -/
structure Plausible where
  mode : String
  wayName : Option String
  reason : Option String := none
  deriving Inhabited, BEq, Repr

/-- Demote a "driving" verdict that no road can explain to the subway beside it.

The three conditions together spare the legitimate fast drives: on a motorway the
speed is legal; with no subway in range there is no better candidate to offer;
under the bar it is a plausible urban journey. -/
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

/-! ## Parity with Node/V8 (values from `lean/experiments/enrich-refs.mts`) -/

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

-- MEASURED, and it is the reason this helper is shared rather than copied: the
-- nearer way is NOT first. `Midway` is re-found at 8 m in the second sample and
-- keeps its original slot, so it precedes the 3 m footway — and
-- `pickBestHighway` reads `highways[0]`. Whether that ordering is RIGHT is a
-- question about `velocity.ts`, not about this port; what is pinned here is that
-- both arms answer it the same way.
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
