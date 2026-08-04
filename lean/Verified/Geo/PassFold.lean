import Verified.Geo.Velocity
import Verified.Geo.SegmentMerge
import Verified.Geo.Reversal
import Verified.Geo.RailRunAnnotate
import Verified.Geo.UndergroundAnnotate
import Verified.Geo.RailAbsorbers
import Verified.Geo.RailReconcile
import Verified.Geo.StaySplit
import Verified.Geo.SegmentPasses
import Verified.Geo.TubeHop
/-!
# The refinement cascade (port of the `passes` array in `src/geo/velocity.ts`)

`computeVelocity` classifies a day's GPS into segments and then rewrites that
list 38 times, each pass consuming what the last produced. The TS expresses the
sequence as DATA — one array entry per pass, in execution order — because the
order is load-bearing and several passes exist only to run after another. This
is the same array, and the same reason.

What arrives here is already segmented and enriched; what leaves is the day the
API serves. Nothing in this module decides anything itself: it names passes and
their order, and every decision belongs to the module the entry calls.

## The environment

The day's observations and the shell's lookups arrive as one record rather than
as 20 parameters, so adding a pass that needs a new lookup does not re-thread
every call site. Three kinds of field live in it:

* **Observations** — the Kalman track, the pre-Kalman coarse fixes the
  underground reconstruction mines, the step rows.
* **Mirror reads** — station / line / way lookups against the local OSM mirror.
  Functions of a coordinate, which is what the TS passes them as.
* **Shell callbacks** — the two things Lean cannot do and does not pretend to:
  venue re-resolution (`bestPlace`) and the IANA zone at a coordinate (`tzAt`).

## Why the fixes are projected rather than unified

Every pass declares the fix shape it reads, and they differ: some want a speed
per fix, most want only a position and a timestamp. The env carries the RICHEST
one and narrows at each call site.

That is safe HERE in a way it would not be for the segment record, and the
difference is worth stating: a fix is INPUT, which no pass writes. Narrowing an
input to the fields a consumer declares cannot lose a write, because there are
none. The segment record is the opposite — every pass rewrites it — so a
narrowed segment silently drops whatever an earlier pass wrote into a field the
projection omitted. That is why the segment is one shared record and the fix is
not.

Measured, not assumed: unifying the fix would cost 63 fixture literals across
six modules (an anonymous constructor takes every explicit field, so a default
does not save them) to delete six one-line projections.
-/

namespace Verified.Geo.PassFold

open Verified.Geo.SegmentMerge (Seg StepPoint)

/-- The day's observations and the shell's lookups. -/
structure Env where
  /-- The Kalman-filtered track, carrying the per-fix speed the ride-head and
  rail passes read. Every other pass takes a narrowing of it. -/
  points : Array Shed.PointF
  /-- The RAW, pre-Kalman fixes. The underground reconstruction mines these
  because smoothing destroys the coarse cell-network pattern it looks for. -/
  rawFixes : Array Verified.Geo.UndergroundRun.CoarseFix
  /-- Per-minute step rows. -/
  steps : Array StepPoint
  /-- Route-relation stop membership, for the stopping-pattern line picker. -/
  railStops : Array Verified.Geo.LineStoppingPattern.RailStopRelation
  /-- `osm.nearbyStations(lat, lon, radiusM)` — the radius is the caller's, so
  each pass supplies its own. -/
  nearbyStations : Float → Float → Float → Array Verified.Geo.TubeHop.NearbyStation
  /-- `osm.linesAtPoint(lat, lon, radiusM)`. -/
  linesAtPoint : Float → Float → Float → Array String
  /-- `osm.nearbyWays(lat, lon)`. -/
  nearbyWays : Float → Float → Array Verified.Geo.Factors.NearbyWay
  /-- SHELL: re-resolve a merged stay's venue from its combined centre. An OSM
  call in the TS, injected here so the pass around it ports whole. -/
  bestPlace : Float → Float → Int → Int → String → Option Verified.Geo.SegmentMerge.ResolvedPlace
  /-- SHELL: the IANA zone at a coordinate. tzdata, not arithmetic. -/
  tzAt : Float → Float → String

/-! ## Fix projections

One per shape a pass declares. Each drops fields the consumer does not read;
none invents one. -/

def Env.coherenceFixes (e : Env) : Array StationaryCoherence.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

def Env.mergeFixes (e : Env) : Array Verified.Geo.SegmentMerge.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

def Env.railFixes (e : Env) : Array Verified.Geo.RailRuns.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon, p.speedKmh⟩

def Env.absorberFixes (e : Env) : Array Verified.Geo.RailAbsorbers.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

def Env.tubeFixes (e : Env) : Array Verified.Geo.TubeHop.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

/-- The step rows as the worldline passes declare them. A field-for-field
rename: both carry a `Float` count. -/
def Env.feasSteps (e : Env) : List Verified.Geo.Worldline.FeasibilityStepPoint :=
  (e.steps.map fun s => ⟨s.ts, s.steps⟩).toList

/-- The step rows as the rail absorbers declare them.

The ONE projection that is not a field-drop: `Verified.Geo.RailAbsorbers`
types the count `Int` where the env (and `steps_intraday`, and the TS
`StepPoint`) carry a `Float`. Exact for every value the column can hold — it is
an integer column — but a genuine conversion rather than a narrowing, so it is
named here rather than inlined. The Lean modules disagreeing about the type of
one row is #422; when that closes this becomes a rename like the one above. -/
def Env.absorberSteps (e : Env) : Array Verified.Geo.RailAbsorbers.StepPoint :=
  e.steps.map fun s => ⟨s.ts, s.steps.toInt64.toInt⟩

/-! ## Radii the cascade chooses

The mirror lookups take a radius, and it is the CALLER that picks one — the same
lookup reaches for a different distance depending on which pass is asking. Each
of these is a verbatim copy of the TS constant named beside it.

UNPINNED, and that is a gap rather than a decision: nothing here brackets them,
because the fold has no scenario guards yet. The pass each one feeds does pin
its own behaviour, so a wrong value surfaces as a wrong answer rather than as
silence — but that is weaker than a fixture either side of the bar. -/

/-- `UNDERGROUND_STATION_RADIUS_M` (`src/geo/underground-rail.ts`). Wider than
the rail-run radius: a tunnel reacquire lands further from the platform. -/
def UNDERGROUND_STATION_RADIUS_M : Float := 350

/-- `UNDERGROUND_LINES_RADIUS_M` (`src/geo/underground-rail.ts`). -/
def UNDERGROUND_LINES_RADIUS_M : Float := 300

/-- `DEFAULT_RADIUS_M.linesAtPoint` (`src/geo/osm.ts`) — what the adapter falls
back to when the caller names none, which is how `railRuns` calls it. -/
def LINES_AT_POINT_DEFAULT_RADIUS_M : Float := 100

/-! ## The passes

Order is execution order. Do not reorder without reading the rationale on the
TS entry — several of these exist only because they run after another. -/

/-- One entry of the cascade: the name the phase timer and the pass trace use,
and the rewrite. Named because a divergence is reported against a pass, and an
index would not survive an insertion. -/
abbrev Pass := String × (Array Seg → Array Seg)

/-- The cascade, in execution order. -/
def passes (e : Env) : Array Pass := #[
  -- A "stay" whose fixes march in a directed line is slow locomotion, not
  -- dwelling. Reclassify BEFORE merge and place attribution, so it coalesces
  -- with the adjacent walk and is never named after a POI it drifted past.
  ("stationaryCoherence", fun segs =>
    StationaryCoherence.stationaryCoherence segs e.coherenceFixes),

  ("merge", fun segs =>
    Verified.Geo.SegmentMerge.mergeAdjacentMoving
      (Verified.Geo.SegmentMerge.mergeAdjacentStays segs e.steps)),

  -- Collapse a sit that indoor GPS jitter shattered into several co-located
  -- stays with different wrong labels, re-resolving the venue from the merged
  -- centre.
  ("consolidateJitterStays", fun segs =>
    Verified.Geo.SegmentMerge.consolidateJitterStays
      (Verified.Geo.SegmentMerge.attachStayCentroids segs e.mergeFixes) e.bestPlace e.tzAt),

  -- A ride that doubles back is two rides with a change between them. Must run
  -- BEFORE railRuns: once a run is grown across a turnaround the two halves are
  -- one span, and every downstream gate legitimately passes for an out-and-back
  -- — yielding a leg that boards and alights at the same station.
  ("reversalSplit", fun segs => Verified.Geo.Reversal.splitReversingLegs segs e.points),

  ("railRuns", fun segs =>
    Verified.Geo.RailRunAnnotate.annotateRailRuns
      { stationsLookup := fun lat lon =>
          e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M
        linesLookup := fun lat lon => e.linesAtPoint lat lon LINES_AT_POINT_DEFAULT_RADIUS_M }
      segs e.railFixes e.railStops),

  -- A tube ride leaves only coarse cell-network fixes, which annotateRailRuns
  -- cannot resolve. Mine those from the RAW track to identify the line and
  -- split the swallowing walk into walk → train → walk.
  ("undergroundRail", fun segs =>
    Verified.Geo.UndergroundAnnotate.annotateUndergroundRuns segs e.rawFixes
      (fun lat lon => e.nearbyStations lat lon UNDERGROUND_STATION_RADIUS_M)
      (fun lat lon => e.linesAtPoint lat lon UNDERGROUND_LINES_RADIUS_M)
      e.nearbyWays),

  -- Absorb a platform / concourse wait into the boarding of its train run, so
  -- a station wait doesn't surface as a standalone stay mislabelled with the
  -- nearest focus place.
  ("boardingPlatform", fun segs =>
    Verified.Geo.RailAbsorbers.absorbBoardingPlatform segs e.absorberFixes
      (fun lat lon =>
        e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M)),

  -- A run of short stationary segments between a train and onward movement is
  -- an interchange, not a phantom place-stay.
  ("interchange", fun segs => Verified.Geo.RailAbsorbers.absorbInterchanges segs),

  -- A brief stationary segment between two drives with no steps across it is a
  -- traffic light, not a stop: the biometrics confirm the user never left.
  ("driveStops", fun segs =>
    Verified.Geo.RailAbsorbers.absorbDriveStops segs e.absorberSteps),

  -- Physical constraint: back-to-back train legs must share a station. Runs
  -- after the interchange absorber so it sees the final adjacency, and BEFORE
  -- railSnap so the snap keys off the corrected station pair.
  ("railReconcile", fun segs => Verified.Geo.RailReconcile.reconcileAdjacentRailLegs segs),

  -- Coalesce a tube ride the reconstruction left as two adjacent same-route
  -- train segments. After reconciliation, so it sees station-corrected legs.
  ("mergeSameRouteTrains", fun segs =>
    Verified.Geo.RailReconcile.mergeAdjacentSameRouteTrains segs),

  -- A short walk between two train legs sharing a station is the
  -- platform-to-platform change, not a street walk — name it the station so a
  -- mid-change GPS resurface can't name it after the nearest road.
  ("interchangeLabel", fun segs =>
    Verified.Geo.RailAbsorbers.relabelWalkingInterchanges segs),

  -- A "walking" leg that hides a short ride averages to walking pace and stays
  -- one walk. Carve the ride out by NET GPS progress, so a stationary platform
  -- wait is never split.
  ("vehicleSplit", fun segs => VehicleLeg.splitWalksOnVehicleLeg segs e.points),

  -- A drive's launch from the kerb is slow enough to be glued onto the
  -- preceding walk. Where the next leg is a confirmed road vehicle, move that
  -- sustained tail across the boundary. After vehicleSplit, so an interior ride
  -- is carved first and its trailing walk is what gets evaluated.
  ("walkVehicleHandoff", fun segs => Handoff.reassignWalkTailToVehicle segs e.points),

  -- The mirror on the ARRIVAL side: a drive decelerating into a stay leaves its
  -- final slow seconds blended with the first minute of sitting still, and the
  -- diluted mean scores walking. After walkVehicleHandoff, so the launch-side
  -- boundary is settled first.
  ("vehicleArrival", fun segs => Arrival.reassignVehicleArrivalWalk segs e.points),

  -- The mirror on the other side of a RIDE boundary: a train leg whose edge
  -- sustains pedestrian pace, duration, distance AND cadence is still carrying
  -- the walk to the platform. Hand that run to the adjacent walk.
  ("vehicleEdgeShed", fun segs => Shed.shedVehiclePedestrianEdges segs e.points e.feasSteps),

  -- The boarding-side anchor: when GPS dies in the tunnel just after boarding,
  -- the ride's whole head is buried in the STAY before the train, so the shed
  -- pass has no walk to hand anything to. Carve the departure march out of the
  -- stay's tail and extend the train back over the wait.
  ("rideHeadClaim", fun segs => RideHead.claimRideHeadFromStay segs e.points e.feasSteps),

  -- A brief Underground hop with clean GPS trips neither underground gate, so
  -- it survives as `driving` and only the bus matcher is left to name it.
  -- Upgrade a fast station-to-station leg on a shared line to `train`.
  ("tubeHop", fun segs =>
    Verified.Geo.TubeHop.upgradeTubeHops segs e.tubeFixes
      (fun lat lon =>
        e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M)
      (fun lat lon => e.linesAtPoint lat lon LINES_AT_POINT_DEFAULT_RADIUS_M)),

  -- Plausibility critic: absorb a non-train leg flush against an identified
  -- train journey into that journey — the tube-under-a-road "driving" stretch.
  ("repairHandoff", fun segs => Verified.Geo.SegmentPasses.repairVehicleHandoff segs),

  -- Re-establish the shared-station constraint over the FINAL leg sequence.
  -- `railReconcile` enforced it on pre-merge fragments, and two later passes
  -- invalidate that. An invariant checked before the last pass that can break
  -- it is not an invariant.
  ("railReconcile2", fun segs => Verified.Geo.RailReconcile.reconcileAdjacentRailLegs segs),

  -- LAST. `driving` is this cascade's placeholder for "a vehicle-speed run
  -- nobody has identified yet"; the rail and bus passes have now all had their
  -- chance to claim it, so a placeholder still wearing the name of a car must
  -- justify it with road evidence or be demoted to an honest `vehicle`.
  ("vehicleIdentity", fun segs => Verified.Geo.SegmentPasses.resolveVehicleIdentity segs)
]

/-- Run the cascade. -/
def runPasses (e : Env) (segs : Array Seg) : Array Seg :=
  (passes e).foldl (fun acc (_, run) => run acc) segs

/-- Run the cascade, keeping each pass's output alongside its name.

The shadow ledger reports a divergence against the pass that produced it, so the
per-pass output is part of what this module owes its caller — not a debugging
aid. Same reason `annotateRailRuns` returns its OSM read trace. -/
def runPassesTraced (e : Env) (segs : Array Seg) : Array Seg × Array (String × Array Seg) :=
  (passes e).foldl (fun (acc, trace) (name, run) =>
    let next := run acc
    (next, trace.push (name, next))) (segs, #[])

/-- The pass names, in order. -/
def passNames (e : Env) : Array String := (passes e).map (·.1)

/-! ## Parity with the TS cascade

These pin the two things this module owns and nothing else does: WHICH passes
run, and IN WHAT ORDER. Every decision inside a pass is pinned in the module
that makes it, and restating those here would be a second transcription of the
same thing rather than a second check on it.

An empty environment is enough for the ordering scenario below because the
passes it exercises read no lookup — the mirror reads start at `railRuns`. -/

section FoldGuards

open Verified.Geo.SegmentMerge (Seg)

private def NO_LOOKUPS : Env :=
  { points := #[], rawFixes := #[], steps := #[], railStops := #[]
    nearbyStations := fun _ _ _ => #[], linesAtPoint := fun _ _ _ => #[]
    nearbyWays := fun _ _ => #[]
    bestPlace := fun _ _ _ _ _ => none, tzAt := fun _ _ => "Europe/London" }

-- The cascade, named and ordered. A pass that moves or disappears fails here
-- before it fails as a wrong day.
#guard passNames NO_LOOKUPS ==
  #["stationaryCoherence", "merge", "consolidateJitterStays", "reversalSplit",
    "railRuns", "undergroundRail", "boardingPlatform", "interchange", "driveStops",
    "railReconcile", "mergeSameRouteTrains", "interchangeLabel", "vehicleSplit",
    "walkVehicleHandoff", "vehicleArrival", "vehicleEdgeShed", "rideHeadClaim",
    "tubeHop", "repairHandoff", "railReconcile2", "vehicleIdentity"]

/-! ### The fold against the cascade it is replacing

`passes` is being filled in one tranche at a time, so at any moment it is a
PREFIX of nothing and a SUBSEQUENCE of the TS cascade. Stating the full TS order
here and checking containment both ways turns "how far along is this" from a
claim into a computation: the residue below IS the remaining work, and a pass
wired into the wrong slot fails the subsequence check rather than surfacing
later as a wrong day. -/

/-- Every entry of the TS `passes` array, in execution order
(`src/geo/velocity.ts`). The order of record. -/
def TS_CASCADE : Array String := #[
  "stationaryCoherence", "merge", "consolidateJitterStays", "reversalSplit",
  "railRuns", "undergroundRail", "revertIsolatedCadence2", "boardingPlatform",
  "interchange", "driveStops", "railReconcile", "mergeSameRouteTrains",
  "interchangeSplit", "walkThrough", "interchangeLabel", "vehicleSplit",
  "walkVehicleHandoff", "vehicleArrival", "vehicleEdgeShed", "rideHeadClaim",
  "reenrichSplitWalks", "boardingAnchor", "alightAnchor", "railJourney", "tubeHop",
  "railSnap", "busEvidence", "busRoutes", "roadMatch", "walkMatch", "displayTz",
  "biomEnrich", "hsmmOverride", "finalMerge", "repairHandoff", "railReconcile2",
  "interchangeStayLabel", "vehicleIdentity"]

#guard TS_CASCADE.size == 38

/-- Is `xs` an order-preserving subsequence of `ys`? -/
private def isSubsequence : List String → List String → Bool
  | [], _ => true
  | _ :: _, [] => false
  | x :: xs, y :: ys => if x == y then isSubsequence xs ys else isSubsequence (x :: xs) ys
termination_by _ ys => ys.length

-- Every wired pass sits in its TS slot, relative to every other wired pass.
#guard isSubsequence (passNames NO_LOOKUPS).toList TS_CASCADE.toList

/-- The cascade entries not yet wired into `passes`. -/
def unported (e : Env) : Array String :=
  TS_CASCADE.filter fun n => !(passNames e).contains n

-- Named, not counted: a tranche that quietly wires the easy half and leaves a
-- number to shrink says nothing about WHICH work is left.
#guard unported NO_LOOKUPS ==
  #["revertIsolatedCadence2", "interchangeSplit", "walkThrough", "reenrichSplitWalks",
    "boardingAnchor", "alightAnchor", "railJourney", "railSnap", "busEvidence",
    "busRoutes", "roadMatch", "walkMatch", "displayTz", "biomEnrich", "hsmmOverride",
    "finalMerge", "interchangeStayLabel"]

#guard (passNames NO_LOOKUPS).size + (unported NO_LOOKUPS).size == TS_CASCADE.size

/-! ### The order is load-bearing, and here is one case that proves it

A "stay" whose fixes march in a directed line, followed by a real walk. Run in
order, `stationaryCoherence` relabels the march as walking and `merge` then
coalesces the two into ONE leg. Swap those two passes and the merge sees a stay
next to a walk, has nothing to coalesce, and two legs reach the end.

So the guard below is not "the fold runs"; it is "the fold runs these two in
this order", and it changes if either moves. -/

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320

private def march : Array Shed.PointF :=
  (Array.range 21).map fun k =>
    { ts := 60 * Int.ofNat k, lat := lat0 + (30 * Float.ofNat k) * mlat, lon := lon0
      speedKmh := 4 }

/-- A directed 300 m march the classifier called a stay, then a real walk
continuing it. -/
private def marchThenWalk : Array Seg := #[
  { startTs := 0, endTs := 600, mode := "stationary", linearity := 0.9
    place := some "somewhere it merely drifted past" },
  { startTs := 600, endTs := 1200, mode := "walking", linearity := 0.9 }]

private def env : Env := { NO_LOOKUPS with points := march }

private def modesOf (segs : Array Seg) : Array String :=
  segs.map fun s => s.refinedMode.getD s.mode

-- In the shipped order: one walking leg, and the place the stay was wrongly
-- named after is gone with it.
#guard modesOf (runPasses env marchThenWalk) == #["walking"]
#guard (runPasses env marchThenWalk).size == 1

-- Reversed, the merge has nothing to coalesce and both legs survive.
private def swapped (segs : Array Seg) : Array Seg :=
  let e := env
  let merge := (passes e)[1]!.2
  let coherence := (passes e)[0]!.2
  coherence (merge segs)
#guard (swapped marchThenWalk).size == 2

-- The trace records what a pass PRODUCED, not what it consumed. Off by one and
-- the ledger blames the pass BEFORE the one that moved the leg — the
-- misattribution #409 is about. Caught by the first entry alone: after
-- `stationaryCoherence` the march reads walking, before it reads stationary.
#guard modesOf ((runPassesTraced env marchThenWalk).2[0]!.2) == #["walking", "walking"]

-- The trace's last output IS the fold's answer: a caller reading the ledger
-- per pass and a caller taking the result see the same day.
#guard (runPassesTraced env marchThenWalk).1 == runPasses env marchThenWalk
#guard ((runPassesTraced env marchThenWalk).2.back!).1 == "vehicleIdentity"
#guard (runPassesTraced env marchThenWalk).2.size == (passes env).size

-- An empty day survives every pass.
#guard runPasses env #[] == #[]

end FoldGuards

/-! ## Every wired pass, demonstrably doing something

The guards above pin WHICH passes run and in WHAT ORDER, and mutation testing
says they do that well: moving a pass out of its TS slot fails, deleting one
fails. It also says what they do NOT cover. Of eleven wiring mutations put to
them, NINE were silent — `fun segs => segs` in any of the tranche's entries
passed every guard, as did feeding a pass an empty fix array, and as did a
fabricated radius. An order guard cannot see whether an entry is CONNECTED:
wrong function, wrong argument, and no function at all all read the same to it.

So each pass gets a day it demonstrably rewrites. This is a REACHABILITY check,
not a parity check — what a pass decides is pinned in the module that decides
it, and restating that here would be transcription rather than a second check.
What is checked here is the thing only this module can get wrong: that the
fold reaches the pass, with inputs it can act on.

A pass with no witness is named in `unwitnessed` rather than left to be inferred
from a count, and the two lists must partition the wired set — so a pass added
without a witness cannot slip in as covered.

Re-measured with the witnesses in place, the same eleven mutations leave TWO
silent: `rideHeadClaim` and `vehicleEdgeShed`, which are the two `unwitnessed`
entries a mutation could reach. The guards now cover what this module claims
they cover, and the residue is the list, not a caveat. -/

section Witnesses

open Verified.Geo.SegmentMerge (Seg)

/-- A day that walks, rides, then walks: 4 km/h for 50 min, 45 km/h for 50 min,
4 km/h for 50 min, one fix a minute. The kinematics the boundary passes look
for, in one track. -/
private def mixedTrack : Array Shed.PointF := Id.run do
  let mut out : Array Shed.PointF := #[]
  let mut d : Float := 0
  for k in [0:151] do
    let fast := k ≥ 50 && k < 100
    out := out.push { ts := 60 * Int.ofNat k, lat := lat0 + d * mlat, lon := lon0
                      speedKmh := if fast then 45 else 4 }
    d := d + (if fast then 750 else 66)
  return out

/-- Out and back: north for half the window, south for the other half. -/
private def outAndBack : Array Shed.PointF :=
  (Array.range 151).map fun k =>
    let n := if k ≤ 75 then Float.ofNat k else Float.ofNat (150 - k)
    { ts := 60 * Int.ofNat k, lat := lat0 + (n * 100) * mlat, lon := lon0, speedKmh := 30 }

private def cadence : Array StepPoint :=
  (Array.range 151).map fun k => { ts := 60 * Int.ofNat k, steps := 100 }

/-- Two stations, S and T, either side of the ride. The 22 km bar sits inside
the fast stretch, so a leg spanning it boards at one and alights at the other —
which is what the station-pair passes need to have anything to say. -/
private def stationsAt : Float → Float → Float → Array Verified.Geo.TubeHop.NearbyStation :=
  fun lat lon _ =>
    #[{ name := (if lat < lat0 + 22000 * mlat then "S" else "T")
        distanceM := 40, lat := some lat, lon := some lon }]

private def withTrack (pts : Array Shed.PointF) (steps : Array StepPoint) : Env :=
  { NO_LOOKUPS with
    points := pts
    steps := steps
    nearbyStations := stationsAt
    -- RADIUS-SENSITIVE on purpose. A lookup that ignores its radius makes the
    -- constant the caller passes unfalsifiable: `LINES_AT_POINT_DEFAULT_RADIUS_M`
    -- could be anything, including the fabricated `0` this fold nearly shipped.
    -- Answering only for a real radius puts that constant inside the guards.
    linesAtPoint := fun _ _ r => if r ≥ 50 then #["Metropolitan"] else #[] }

private def MIX : Env := withTrack mixedTrack cadence
private def BACK : Env := withTrack outAndBack #[]

private def tr (a b : Int) (way : Option String) : Seg :=
  { startTs := a, endTs := b, mode := "train", wayName := way, pointCount := 50, maxSpeed := 50 }
private def wk (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "walking", linearity := 0.8, pointCount := 50, avgSpeed := 4 }
private def dr (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "driving", refinedMode := some "driving"
    avgSpeed := 45, maxSpeed := 60, pointCount := 50 }
private def st (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "stationary", linearity := 0.2, pointCount := 50 }

/-- Does the named pass rewrite this day? A pass that has vanished reads as
`false`, so the guards below also catch a deletion. -/
private def fires (e : Env) (name : String) (day : Array Seg) : Bool :=
  match (passes e).find? (·.1 == name) with
  | some p => p.2 day != day
  | none => false

-- Two stays either side of a march the classifier called dwelling: the first
-- pass relabels it and the second coalesces the result. Both are pinned in
-- their firing ORDER above; these pin that each does something at all.
#guard fires env "stationaryCoherence" marchThenWalk
#guard fires env "merge" (StationaryCoherence.stationaryCoherence marchThenWalk env.coherenceFixes)

-- Two co-located stays, re-resolved from the merged centre.
#guard fires MIX "consolidateJitterStays" #[st 0 600, st 600 1200]
-- A ride that doubles back is two rides.
#guard fires BACK "reversalSplit" #[dr 0 9000]
-- A short stay at the boarding station, absorbed into the train.
#guard fires MIX "boardingPlatform" #[st 0 600, tr 600 1200 (some "S → T")]
-- A short stationary between a train and onward movement.
#guard fires MIX "interchange" #[tr 0 600 (some "S → T"), st 600 700, wk 700 1200]
-- Drive, brief stop, drive. `BACK` and not `MIX` because the tell is the
-- ABSENCE of steps: if the user had got out the watch would have counted some,
-- and `MIX` walks at 100 spm throughout.
#guard fires BACK "driveStops" #[dr 0 600, st 600 900, dr 900 1500]
-- …and the SAME sandwich under `MIX`, which walks at 100 spm throughout, is
-- left alone. A negative witness, and the only thing that pins the step COUNT:
-- `absorberSteps` is the one projection that converts rather than drops a
-- field, and a conversion that lost the count would absorb this stop.
#guard !fires MIX "driveStops" #[dr 0 600, st 600 900, dr 900 1500]
-- Leg B boards where leg A alighted, not where it independently resolved.
#guard fires MIX "railReconcile" #[tr 0 600 (some "A → S"), tr 600 1200 (some "T0 → T · Jubilee Line")]
#guard fires MIX "railReconcile2" #[tr 0 600 (some "A → S"), tr 600 1200 (some "T0 → T · Jubilee Line")]
-- Two adjacent legs of one ride.
#guard fires MIX "mergeSameRouteTrains" #[tr 0 600 (some "A → B"), tr 660 1200 (some "A → B")]
-- A short walk between two trains sharing a station is the platform change.
#guard fires MIX "interchangeLabel"
  #[tr 0 600 (some "A → S · Metropolitan Line"), wk 600 700, tr 700 1200 (some "S → T · Jubilee Line")]
-- One "walk" spanning a ride comes out walk → ride → walk.
#guard fires MIX "vehicleSplit" #[wk 0 9000]
-- A walk whose tail is vehicle-paced, handing off to a confirmed drive.
#guard fires MIX "walkVehicleHandoff" #[wk 0 6000, dr 6000 9000]
-- A fast station-to-station driving leg bracketed by walks is a tube hop.
#guard fires MIX "tubeHop" #[wk 0 3000, dr 3000 6000, wk 6000 9000]
-- A driving leg flush against an identified ride is part of it.
#guard fires MIX "repairHandoff" #[dr 100 200, tr 200 400 (some "X → Y · Metropolitan Line")]
-- A day ending on a ride nobody placed: `driving` is a claim, `vehicle` is not.
#guard fires MIX "vehicleIdentity" #[st 0 600, dr 600 1200]

/-- Wired passes with no witness day here: the fold reaches them, and nothing
below shows they act. Each needs a fixture shaped to its own gate — the two
rail annotators want line/stop data the synthetic lookups above do not carry,
and the three edge passes want a cadence-and-pace profile at a segment boundary
this track does not produce. Named rather than counted, so the residue is the
work rather than a number. -/
def unwitnessed : Array String :=
  #["railRuns", "undergroundRail", "vehicleArrival", "vehicleEdgeShed", "rideHeadClaim"]

/-- Wired passes with a witness above. -/
def witnessed : Array String :=
  (passNames NO_LOOKUPS).filter fun n => !unwitnessed.contains n

#guard witnessed.size == 16
#guard unwitnessed.all (passNames NO_LOOKUPS).contains
-- The two lists partition the wired set, so a new pass must be classified.
#guard witnessed.size + unwitnessed.size == (passNames NO_LOOKUPS).size

end Witnesses

end Verified.Geo.PassFold
