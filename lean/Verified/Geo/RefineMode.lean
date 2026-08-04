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

Exactly one caller: `UndergroundAnnotate.sideWayName`, naming the walk left over
when a tube ride is carved out of its host. The `osm` enrichment stage that calls
`refineMode` for every moving segment runs BEFORE the 38-pass cascade, so it is
not the fold's business.

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

end Verified.Geo.RefineMode
