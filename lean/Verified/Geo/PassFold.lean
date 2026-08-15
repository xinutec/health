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
import Verified.Geo.Interchange
import Verified.Geo.RailJourney
import Verified.Geo.Bus
import Verified.Geo.PlaceOverride
import Verified.Geo.TransitPlace
import Verified.Geo.BiometricWindows
import Verified.Geo.BiometricLabels
import Verified.Geo.RoadMatchAnnotate
import Verified.Geo.WalkAnnotate
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
  /-- SHELL: the IANA zone at a coordinate. tzdata, not arithmetic.

  The TS wraps this in a `try`/`catch` and falls back to `homeTz`. Total here,
  so the fallback belongs to whoever supplies the function. -/
  tzAt : Float → Float → String
  /-- The user's home zone: what `displayTz` writes for a segment no fix
  covers, and the TS's fallback when `tzLookup` throws. -/
  homeTz : String := "Europe/London"
  /-- `osm.stationsOnLine(line)` — every station the line serves, with the
  coordinate of its canonical node. The RICHEST of the three shapes the passes
  ask for; the other two are projections of it. -/
  stationsOnLine : String → Array Verified.Geo.RailJourney.LineStation := fun _ => #[]
  /-- `rail_route_cache` rows, filled offline by `refresh-rail-routes`. -/
  railRouteCache : Array Verified.Geo.RailReconcile.RouteRow := #[]
  /-- `bus_route_cache` rows. Empty is the honest "no mirror yet", and the pass
  is a no-op then — which is why capturing routes cannot move a golden day. -/
  busRouteCache : List Verified.Geo.Bus.BusRoute := []
  /-- `osm.nearbyTransitStops(lat, lon, radiusM)`. -/
  transitStops : Float → Float → Float → Array Verified.Geo.Bus.TransitStop := fun _ _ _ => #[]
  /-- The HSMM's decode for this day, or empty when the cron has not run. The
  TS tests the decode for null; empty carries the same meaning here. -/
  hmmDecode : Array Verified.Geo.PlaceOverride.HmmSeg := #[]
  /-- Place id → display name and centroid, for resolving the HSMM's picks. -/
  hsmmPlaces : List (Int × Verified.Geo.PlaceOverride.PlaceLookup) := []
  /-- Mined focus places, for the far-phantom swallow. -/
  knownPlaces : Array Verified.Geo.SegmentMerge.KnownPlaceProjection := #[]
  /-- `focus_places.unique_days` by id — how established a place is. The
  transit-interchange labeller reads it as a PROVENANCE guard: a stay the
  posterior assigned to a place visited on many days is a destination, not a
  platform, and the rename is refused. A separate field because
  `KnownPlaceProjection` carries geometry only. -/
  focusPlaceDays : Int → Option Int := fun _ => none
  /-- Intraday heart-rate samples. -/
  hr : List Verified.Geo.BiometricWindows.HrPoint := []
  /-- Sleep-stage windows. -/
  sleep : List Verified.Geo.BiometricWindows.SleepStage := []
  /-- SHELL: re-derive one split walk's enrichment from its own geometry.
  `none` is a failed re-enrichment, and the TS's answer to that is to leave the
  leg honestly unnamed rather than confidently wrong — so the caller keeps the
  segment as it stands. The only genuinely async pass in the cascade; what is
  ASYNC is the OSM naming, and what is sequencing stays here. -/
  reenrich : Seg → Option Seg := fun _ => none
  /-- The road matcher's shell: the street-network read and the solver. -/
  roadEnv : Verified.Geo.RoadMatchAnnotate.Env :=
    { drivableRoads := fun _ _ _ => #[], matcher := fun _ _ => none }
  /-- The pedestrian matcher's shell: two OSM reads and five solver leaves. -/
  walkEnv : Verified.Geo.WalkAnnotate.Env :=
    { walkableRoads := fun _ _ _ => #[]
      buildingsNear := fun _ _ _ => #[]
      matcher := fun _ _ _ => none
      reconstruct := fun _ _ _ _ => none
      refineMatched := fun _ _ => none
      correct := fun drawn _ _ _ => drawn
      snapPassages := fun drawn _ _ => drawn }
  /-- The DISPLAY fixes — a different series from `points`, carrying the
  phone's self-reported accuracy the walk draw weighs. -/
  displayFixes : Array Verified.Geo.WalkAnnotate.PedFix := #[]
  /-- Kalman speed at a timestamp, for the walk matcher's pace gate. -/
  speedByTs : Int → Option Float := fun _ => none
  /-- Which line a walking leg draws. `matcher` is production. -/
  walkDraw : Verified.Geo.WalkAnnotate.Draw := .matcher
  /-- The walk draw's toggles. `matchDisable` is the `/api/velocity`
  `walkMatch=0` query param: it skips matching so the map can render raw walks
  for an A/B against the pavement-matched line. -/
  walkFlags : Verified.Geo.WalkAnnotate.Flags := {}

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

def Env.interchangeFixes (e : Env) : Array Verified.Geo.Interchange.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

/-- The second `Float → Int` step conversion — see `absorberSteps`, and #422. -/
def Env.interchangeSteps (e : Env) : List Verified.Geo.Interchange.StepPoint :=
  (e.steps.map fun s => ⟨s.ts, s.steps.toInt64.toInt⟩).toList

def Env.busFixes (e : Env) : List Verified.Geo.Bus.Fix :=
  (e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩).toList

/-- The step rows as the biometric windows declare them. A rename: `Float` both
sides, unlike the two `Int` conversions above. -/
def Env.biomSteps (e : Env) : List Verified.Geo.BiometricWindows.StepPoint :=
  (e.steps.map fun s => ⟨s.ts, s.steps⟩).toList

def Env.labelFixes (e : Env) : List Verified.Geo.BiometricLabels.Fix :=
  (e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩).toList

/-- The road matcher declares the episode-geometry fix — same four fields as
`railFixes`, a different record. -/
def Env.geomFixes (e : Env) : Array Verified.Geo.EpisodeGeometry.Fix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon, p.speedKmh⟩

/-! ### The line lookup, three ways

`stationsOnLine` is one mirror read, and three passes want three shapes of its
answer. The env carries the RICHEST — name and coordinate — and each consumer
takes what it declares, the same rule the fixes follow. -/

/-- Name only: what the anchors' served-station test compares. -/
def Env.servedStations (e : Env) : String → Array Verified.Geo.LineMembership.ServedStation :=
  fun line => (e.stationsOnLine line).map fun s => ⟨s.name⟩

/-- Name and coordinate, as a list: what the interchange splicer declares. -/
def Env.interchangeStations (e : Env) : String → List Verified.Geo.Interchange.Station :=
  fun line => ((e.stationsOnLine line).map fun s => ⟨s.name, s.lat, s.lon⟩).toList

/-- The journey assembler's own shell record. Its radius is an `Int` where the
env's is a `Float`; widening, so nothing is lost. -/
def Env.railJourneyEnv (e : Env) : Verified.Geo.RailJourney.Env :=
  { linesAtPoint := fun lat lon r => e.linesAtPoint lat lon (Float.ofInt r)
    stationsOnLine := e.stationsOnLine }

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

/-! ## The two passes with no module of their own

Every other entry names a function some module owns. These two are written
inline in `velocity.ts`, so they are written here — they are pass BODIES, not
wiring, and they belong to the fold in the same way. -/

/-- Fixes covering a segment's window. `samplesInWindow`: INCLUSIVE both ends,
the pipeline's dominant reading. -/
private def inWindow (e : Env) (s : Seg) : Array Shed.PointF :=
  e.points.filter fun p => decide (p.ts ≥ s.startTs) && decide (p.ts ≤ s.endTs)

/-- The zone the frontend renders this segment's clock in, so a travel day
reads as it was lived — morning at parents in CEST, evening home in BST.

Stationary takes the centroid, moving the midpoint of the path: a ride's
average position is somewhere it never was, and on a leg that crosses a border
that is the wrong side. Note `mode` and not `effectiveMode`, as the TS has it —
a leg refined to walking keeps the stationary branch. -/
def displayTz (e : Env) (segs : Array Seg) : Array Seg :=
  segs.map fun s =>
    let pts := inWindow e s
    if pts.isEmpty then { s with displayTz := some e.homeTz }
    else
      let (lat, lon) :=
        if s.mode == "stationary" then
          let n := Float.ofNat pts.size
          ((pts.foldl (fun a p => a + p.lat) 0) / n, (pts.foldl (fun a p => a + p.lon) 0) / n)
        else
          let mid := pts[pts.size / 2]!
          (mid.lat, mid.lon)
      { s with displayTz := some (e.tzAt lat lon) }

/-- Name a train-bracketed stay after its station.

Runs LAST because the train adjacency is only final once the rail passes and
`repairHandoff` have absorbed the slivers between the change and the next ride;
the early place enrichment that named the stay had no transit context at all.

The centroid is recomputed here rather than read off `centroidLat`, which is not
reliably attached by this point — the TS does the same, for the same reason.

The scan reads the array it is REWRITING, so a stay renamed at `i` is what index
`i + 1` sees when it looks for its bracketing trains. That is the TS's `out[i] =`
in place, and it is load-bearing for a run of two changes. -/
def interchangeStayLabels (e : Env) (segs : Array Seg) : Array Seg := Id.run do
  let mut out := segs
  for i in [0 : out.size] do
    let s := out[i]!
    if s.mode != "stationary" then continue
    let pts := inWindow e s
    if pts.isEmpty then continue
    let n := Float.ofNat pts.size
    let cLat := (pts.foldl (fun a p => a + p.lat) 0) / n
    let cLon := (pts.foldl (fun a p => a + p.lon) 0) / n
    match Verified.Geo.TransitPlace.stationAtTransitInterchange out (Int.ofNat i) cLat cLon
            e.nearbyStations (stayFocusDays := s.focusPlaceId.bind e.focusPlaceDays) with
    | none => pure ()
    | some station =>
      if some station != s.place then
        let reason := match s.refinedReason with
          | some r => s!"{r}; transit interchange → named station"
          | none => "transit interchange → named station"
        out := out.set! i { s with place := some station, refinedReason := some reason }
  return out

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
  -- `points` as well as `rawFixes`: the carve remainder is named from the
  -- SMOOTHED track by the enricher's rule, while the tunnel window is still
  -- mined from the raw one. Two different series, two different questions.
  ("undergroundRail", fun segs =>
    Verified.Geo.UndergroundAnnotate.annotateUndergroundRuns segs e.rawFixes e.points
      (fun lat lon => e.nearbyStations lat lon UNDERGROUND_STATION_RADIUS_M)
      (fun lat lon => e.linesAtPoint lat lon UNDERGROUND_LINES_RADIUS_M)
      e.nearbyWays e.servedStations),

  -- Second cadence-drive revert. The FIRST runs before the rail passes exist,
  -- so a platform interchange sandwiched between two rides saw `driving`
  -- neighbours and survived. Those neighbours are `train` now, so an isolated
  -- walking-pace flip between two trains reverts to the walk it is. A real
  -- drive to a station is untouched: it is not pedestrian-paced.
  ("revertIsolatedCadence2", fun segs =>
    Verified.Geo.BiometricLabels.revertIsolatedCadenceDrivesApplied segs.toList),

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

  -- A train leg whose endpoint line sets are disjoint is impossible as one
  -- ride. Split it at the watch-timed interchange step burst, with the change
  -- station picked from the line graph by timing fit.
  ("interchangeSplit", fun segs =>
    Verified.Geo.Interchange.spliceInterchanges segs e.interchangeFixes e.interchangeSteps
      (fun lat lon r => (e.linesAtPoint lat lon r).toList) e.interchangeStations),

  -- A "stationary" stop the watch shows was a walk-through: a clear per-minute
  -- step burst coinciding with real GPS translation. Runs HERE, after every
  -- rail and drive absorber has claimed the segments it owns, so this only
  -- touches genuine standalone phantom stops. The ONLY pass that changes the
  -- segment COUNT by merging, so it carries a merge plan as well as decisions.
  ("rideTailTrim", fun segs =>
    Verified.Geo.Interchange.trimRideTailAtWalk segs e.interchangeFixes e.interchangeSteps),
  ("walkThrough", fun segs =>
    Verified.Geo.BiometricLabels.applyStationaryWalkThroughApplied
      segs.toList e.biomSteps e.labelFixes),

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
  ("stayArrivalClaim", fun segs => FootArrival.claimStayArrivalFromWalk segs e.points),

  -- Re-enrich the on-foot remainders `vehicleSplit` left behind. The OSM pass
  -- ran ~30 passes ago, on segments not yet split, so everything it concluded
  -- about a walk that turned out to span a ride was derived from a window
  -- CONTAINING the ride — the road name from a line drawn straight through it,
  -- the refined mode from speeds averaged across it. `walkRemainder` has
  -- already cleared that; here each remainder gets its own, from its own
  -- geometry. One that fails re-enrichment stays honestly unnamed.
  --
  -- The naming is shell and injected; the sequencing is not. Note the flag is
  -- cleared either way, matching the TS's destructure-and-drop — a remainder
  -- whose re-enrichment failed is not retried by a later pass.
  --
  -- `needsRename` is the weaker request: take the fresh derivation's wayName
  -- and NOTHING else, because re-deriving the mode of a walk trimmed of its
  -- arrival is what cost a leg on 2026-04-29 (#782). A rename whose derivation
  -- produced no name comes out unnamed rather than holding the stale one — the
  -- old name described a window this segment no longer spans.
  ("reenrichSplitWalks", fun segs =>
    if !segs.any (fun s => s.needsReenrich || s.needsRename) then segs
    else segs.map fun s =>
      if s.needsReenrich then { (e.reenrich s).getD s with needsReenrich := false }
      else if !s.needsRename then s
      else { s with needsRename := false, wayName := (e.reenrich s).bind (·.wayName) }),

  -- When GPS surfaces a stop or two into a tunnel, the reconstruction boards at
  -- the first snappable fix and the walk keeps the stranded first hop — so the
  -- walk line bleeds on to the next station. Re-anchor the boarding to the
  -- station the walk actually reached. Before railJourney, so the corrected
  -- boarding feeds the merge.
  ("boardingAnchor", fun segs =>
    Verified.Geo.RailAbsorbers.anchorTrainBoardingToWalkedStation segs e.absorberFixes
      (fun lat lon =>
        e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M)
      e.servedStations),

  -- The mirror on the disembark side: the train closes at the surfaced station
  -- and the ride on to the true alight is stranded as the FAST leading fixes of
  -- the next walk. Extend the train forward and trim the walk.
  ("alightAnchor", fun segs =>
    Verified.Geo.RailAbsorbers.anchorTrainAlightToWalkedStation segs e.absorberFixes e.feasSteps
      (fun lat lon =>
        e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M)
      e.servedStations),

  -- One continuous Underground ride, shattered by a mid-tunnel GPS surface into
  -- several train legs plus slivers. If a SINGLE line serves every station the
  -- run touches, it was one ride on that line — collapse it. The line topology
  -- decides, not a GPS heuristic, so a genuine multi-line change is left whole.
  ("railJourney", fun segs =>
    Verified.Geo.RailJourney.assembleRailJourney e.railJourneyEnv segs e.railFixes e.biomSteps),

  -- A brief Underground hop with clean GPS trips neither underground gate, so
  -- it survives as `driving` and only the bus matcher is left to name it.
  -- Upgrade a fast station-to-station leg on a shared line to `train`.
  ("tubeHop", fun segs =>
    Verified.Geo.TubeHop.upgradeTubeHops segs e.tubeFixes
      (fun lat lon =>
        e.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M)
      (fun lat lon => e.linesAtPoint lat lon LINES_AT_POINT_DEFAULT_RADIUS_M)),

  -- Attach the precomputed track geometry to each train run whose route is in
  -- the cache. One indexed lookup, purely additive — the raw track is untouched.
  ("railSnap", fun segs =>
    Verified.Geo.RailReconcile.annotateSnappedPaths segs e.railRouteCache),

  -- A refined-driving leg whose boarding wait and mid-leg dwells coincide with
  -- bus_stop nodes is a bus. After all mode refinement, so it judges the FINAL
  -- driving legs.
  ("busEvidence", fun segs =>
    Verified.Geo.Bus.annotateBusEvidence segs e.busFixes e.transitStops),

  -- Stronger than the dwell evidence above: anchor a leg's first and last fix
  -- to a mirrored route's stops and, on a match, name the bus. Catches short
  -- rides with too few dwells to score.
  ("busRoutes", fun segs =>
    Verified.Geo.Bus.annotateBusRoutes segs e.busFixes e.busRouteCache),

  -- Snap each road-vehicle leg onto the street network so the map draws it on
  -- the road instead of the raw GPS zigzag through buildings. After all mode
  -- refinement, so it only matches the FINAL road legs. Purely additive: with
  -- no road data it is a no-op and the raw track draws.
  ("roadMatch", fun segs =>
    Verified.Geo.RoadMatchAnnotate.annotateRoadMatches e.roadEnv segs e.geomFixes),

  -- The same for walking legs, onto the walkable network, so the map draws the
  -- pavement instead of a line through buildings. Display geometry only —
  -- states unchanged.
  ("walkMatch", fun segs =>
    Verified.Geo.WalkAnnotate.annotateWalkMatches segs e.displayFixes e.speedByTs
      e.walkEnv e.biomSteps e.walkDraw e.walkFlags),

  -- The zone the frontend renders this segment's clock in.
  ("displayTz", fun segs => displayTz e segs),

  -- Final cross-modal enrichment: HR, sleep and step stats per segment. Missing
  -- Fitbit data leaves the enrichment's own fields empty — which is NOT the
  -- same as the field being absent, and the segment record keeps both readings
  -- apart.
  ("biomEnrich", fun segs =>
    segs.map fun s =>
      let bio := Verified.Geo.BiometricWindows.enrichSegmentWithBiometrics
                   s e.hr e.sleep e.biomSteps
      { s with biometrics := some bio }),

  -- The HSMM's place picks override the pipeline's attribution on stays. Falls
  -- back to the pipeline's label when no decode exists — an EMPTY decode is
  -- that "no decode", matching the TS's null test.
  ("hsmmOverride", fun segs =>
    if e.hmmDecode.isEmpty then segs
    else Verified.Geo.PlaceOverride.applyHsmmPlaceOverride segs e.hmmDecode e.hsmmPlaces),

  -- By now the HSMM may have placed a segment that was un-placed at the earlier
  -- merge, so two consecutive same-place stays could surface as duplicates.
  -- Absorb intra-place pottering first, then swallow a phantom focus-place stay,
  -- then re-merge.
  --
  -- The TS coalesces the freshly-adjacent walks ONLY when the swallow actually
  -- demoted something, and tests that by REFERENCE equality on the returned
  -- array. Lean has no such test; structural equality stands in, and is the
  -- stricter reading — it also skips the coalesce for a swallow that returned an
  -- equal-but-new array, which the TS would have coalesced. No such case can
  -- arise, because the TS returns its input by identity exactly when it changed
  -- nothing.
  ("finalMerge", fun segs =>
    let intra := Verified.Geo.SegmentMerge.absorbIntraPlaceWalk segs e.mergeFixes
    let swallowed :=
      Verified.Geo.SegmentMerge.absorbFarFocusPlacePhantom intra e.knownPlaces e.mergeFixes
    let coalesced :=
      if swallowed == intra then swallowed
      else Verified.Geo.SegmentMerge.mergeAdjacentMoving swallowed
    Verified.Geo.SegmentMerge.mergeAdjacentStays coalesced e.steps),

  -- Plausibility critic: absorb a non-train leg flush against an identified
  -- train journey into that journey — the tube-under-a-road "driving" stretch.
  ("repairHandoff", fun segs => Verified.Geo.SegmentPasses.repairVehicleHandoff segs),

  -- Re-establish the shared-station constraint over the FINAL leg sequence.
  -- `railReconcile` enforced it on pre-merge fragments, and two later passes
  -- invalidate that. An invariant checked before the last pass that can break
  -- it is not an invariant.
  ("railReconcile2", fun segs => Verified.Geo.RailReconcile.reconcileAdjacentRailLegs segs),

  -- The changeover window between two rides contains the RIDE, not just a
  -- platform walk. HERE and not earlier: after `railReconcile2`, so both
  -- neighbours carry their final station-pair labels, and after the anchors,
  -- which decline this case by design because a hop between two rides can
  -- belong to either side and the window has to be read whole.
  ("changeoverWindow", fun segs =>
    Verified.Geo.RailReconcile.splitChangeoverWindows segs e.mergeFixes),

  -- A stay at a station bracketed by trains on BOTH sides is a change of
  -- trains, not a venue visit — name it the station so a co-located shop cannot
  -- surface as a destination.
  ("interchangeStayLabel", fun segs => interchangeStayLabels e segs),

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
    "railRuns", "undergroundRail", "revertIsolatedCadence2", "boardingPlatform",
    "interchange", "driveStops", "railReconcile", "mergeSameRouteTrains",
    "interchangeSplit", "rideTailTrim", "walkThrough", "interchangeLabel",
    "vehicleSplit", "walkVehicleHandoff", "vehicleArrival", "vehicleEdgeShed",
    "rideHeadClaim", "stayArrivalClaim",
    "reenrichSplitWalks", "boardingAnchor", "alightAnchor", "railJourney", "tubeHop",
    "railSnap", "busEvidence", "busRoutes", "roadMatch", "walkMatch", "displayTz", "biomEnrich", "hsmmOverride", "finalMerge",
    "repairHandoff", "railReconcile2", "changeoverWindow", "interchangeStayLabel",
    "vehicleIdentity"]

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
  "interchangeSplit", "rideTailTrim", "walkThrough", "interchangeLabel", "vehicleSplit",
  "walkVehicleHandoff", "vehicleArrival", "vehicleEdgeShed", "rideHeadClaim",
  "stayArrivalClaim",
  "reenrichSplitWalks", "boardingAnchor", "alightAnchor", "railJourney", "tubeHop",
  "railSnap", "busEvidence", "busRoutes", "roadMatch", "walkMatch", "displayTz",
  "biomEnrich", "hsmmOverride", "finalMerge", "repairHandoff", "railReconcile2",
  "changeoverWindow", "interchangeStayLabel", "vehicleIdentity"]

#guard TS_CASCADE.size == 41

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
-- number to shrink says nothing about WHICH work is left. Nothing is left.
--
-- Note what this does NOT catch: `TS_CASCADE` is a hand-copied literal, so a
-- pass added to `velocity.ts` leaves both lists agreeing with each other and
-- disagreeing with the pipeline. That is exactly how the fold fell a pass
-- behind when `changeoverWindow` landed — every guard here stayed green.
-- `scripts/check-cascade-parity.mjs` reads the names out of the TS and is the
-- check that would have failed.
#guard unported NO_LOOKUPS == #[]

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
entries a mutation could reach.

The second tranche was measured the same way: twelve mutations, eight fire, and
these FOUR were silent — recorded because a witness proves a pass acts, not that
every input it is handed matters. Three are now closed (2026-08-06) and the
fourth is subsumed; the entries stay, struck through, because what made each one
silent is the reusable part. Both closures needed the SAME move — the pass fires
either way, so the guard cannot ask whether it acted, only what it produced.

* ~~`boardingAnchor` and `alightAnchor` still fire with `servedStations`
  replaced by an empty lookup~~ — CLOSED (#423). The `NOSERVE` pair below is
  what closed it: a mirror that knows the line but does not stop it where the
  walk arrives, so the veto has something to reject. Re-measured, all three
  mutations now fail the build — emptying either entry's lookup, or gutting
  `Env.servedStations` itself (which fails both guards at once).
* `undergroundRail` also takes `servedStations`, and emptying THAT argument is
  still silent. Not a fourth hole of its own: the pass is on `unwitnessed`, so
  nothing shows it acts at all, and its lookup cannot be pinned before it is.
* ~~`finalMerge` still fires with the far-phantom swallow removed~~ — CLOSED.
  `fires` was never going to reach it: with the swallow gone that day changes
  nothing, so "did the pass act" is the wrong question and the guards below
  assert the OUTPUT instead. Two same-place stays either side of a walk, one on
  the place and one 990 m off it; the far one is demoted and coalesced. Both
  mutations fail the build — deleting the swallow, and a swallow that demotes
  EVERY stay carrying the id, which is what the surviving-near-stay guard is
  for.

Of the six step and fix projections, five are pinned; `Env.feasSteps` is not,
and cannot be until `vehicleEdgeShed` and `rideHeadClaim` have witnesses, since
they are its only consumers. Same root as their `unwitnessed` entries rather
than a separate gap. Note the two projections have IDENTICAL bodies, so a probe
aimed at one by its text alone hits the other — anchor on the signature. -/

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

/-- Three stops along the ride: at its head, at the 22 km bar, and at its tail.
The coordinates are the ones the fast stretch actually passes, because a route
whose stops the leg never reaches anchors nothing. -/
private def stopAt (n : Float) : Verified.Geo.RailJourney.LineStation × Float :=
  (⟨"", lat0 + n * mlat, lon0⟩, n)

private def lineStations : Array Verified.Geo.RailJourney.LineStation :=
  #[⟨"S", lat0 + 3300 * mlat, lon0⟩, ⟨"M", lat0 + 22000 * mlat, lon0⟩,
    ⟨"T", lat0 + 40800 * mlat, lon0⟩]

private def busRoute : Verified.Geo.Bus.BusRoute :=
  { routeRef := "18", routeName := some "Euston", osmRelationId := 1
    stops := (lineStations.mapIdx fun i s =>
      { name := some s.name, lat := s.lat, lon := s.lon, seq := Int.ofNat i + 1 }).toList }

private def withTrack (pts : Array Shed.PointF) (steps : Array StepPoint) : Env :=
  { NO_LOOKUPS with
    points := pts
    steps := steps
    nearbyStations := stationsAt
    -- RADIUS-SENSITIVE on purpose. A lookup that ignores its radius makes the
    -- constant the caller passes unfalsifiable: `LINES_AT_POINT_DEFAULT_RADIUS_M`
    -- could be anything, including the fabricated `0` this fold nearly shipped.
    -- Answering only for a real radius puts that constant inside the guards.
    linesAtPoint := fun _ _ r => if r ≥ 50 then #["Metropolitan"] else #[]
    -- DIFFERENT from `homeTz`, on purpose: with both answering London a
    -- `displayTz` that never looked anything up would be indistinguishable from
    -- one that did, and the fallback branch would be untestable.
    tzAt := fun _ _ => "Europe/Amsterdam"
    stationsOnLine := fun _ => lineStations
    railRouteCache := #[⟨"A → B", #[⟨lat0, lon0⟩, ⟨lat0 + 1000 * mlat, lon0⟩]⟩]
    busRouteCache := [busRoute]
    transitStops := fun _ _ _ => #[{ subtype := "bus_stop", distanceM := 10 }]
    hmmDecode := #[{ startTs := 0, endTs := 600, mode := "stationary", placeId := some 7 }]
    hsmmPlaces := [(7, { displayName := some "The Office", lat := some lat0, lon := some lon0 })]
    knownPlaces := #[⟨7, lat0, lon0⟩]
    hr := [{ ts := 60, bpm := 60 }, { ts := 120, bpm := 80 }] }

private def MIX : Env := withTrack mixedTrack cadence
private def BACK : Env := withTrack outAndBack #[]

private def tr (a b : Int) (way : Option String) : Seg :=
  { startTs := a, endTs := b, mode := "train", wayName := way, pointCount := 50, maxSpeed := 50 }
private def wk (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "walking", linearity := 0.8, pointCount := 50, avgSpeed := 4 }
private def dr (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "driving", refinedMode := some "driving"
    avgSpeed := 45, maxSpeed := 60, pointCount := 50 }
private def st (a b : Int) (place : Option String := none) : Seg :=
  { startTs := a, endTs := b, mode := "stationary", linearity := 0.2, pointCount := 50, place }

/-- Run one named pass. A pass that has vanished returns its input, so `fires`
below reads `false` and the guards catch a deletion. -/
private def runNamed (e : Env) (name : String) (day : Array Seg) : Array Seg :=
  match (passes e).find? (·.1 == name) with
  | some p => p.2 day
  | none => day

/-- Does the named pass rewrite this day? -/
private def fires (e : Env) (name : String) (day : Array Seg) : Bool :=
  runNamed e name day != day

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
-- A "platform walk" laid across the track's 4 km/h → 45 km/h boundary: three
-- slow minutes and then the ride, so the departing leg's boarding is pulled back
-- to where the track actually starts moving. Head-only, which is the 07-02 shape
-- mirrored — `MIX` accelerates once and never decelerates, so there is no tail.
#guard fires MIX "changeoverWindow" #[tr 2400 2820 (some "A → S"), wk 2820 3300, tr 3300 3900 (some "S → T")]
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
-- A cadence flip with no vehicular context on either side. The tag stays; only
-- the mode reverts, which is why `isCadenceFlip` tests `refinedMode` too.
private def flipped (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "walking", refinedMode := some "driving"
    refinedKinds := #["low-cadence"], avgSpeed := 4, pointCount := 50 }
#guard fires MIX "revertIsolatedCadence2" #[wk 0 600, flipped 600 1200, wk 1200 1800]
-- …and the SAME flip beside a real drive is kept: a slow leg between two rides
-- is the ride, and the pass exists to spare it. Without this the revert could
-- fire unconditionally and the guard above would not notice.
#guard !fires MIX "revertIsolatedCadence2" #[dr 0 600, flipped 600 1200, wk 1200 1800]

-- A remainder flagged for re-enrichment. `MIX.reenrich` answers `none` — a
-- FAILED re-enrichment — and the flag clears anyway, which is the TS's
-- destructure-and-drop: the leg stays honestly unnamed and no later pass
-- retries it. Asserting only that something changed would not separate that
-- from a pass that cleared nothing, so the flag itself is checked.
#guard fires MIX "reenrichSplitWalks" #[{ wk 0 600 with needsReenrich := true }]
#guard !(runNamed MIX "reenrichSplitWalks" #[{ wk 0 600 with needsReenrich := true }])[0]!.needsReenrich
-- A day with nothing flagged is returned untouched.
#guard !fires MIX "reenrichSplitWalks" #[wk 0 600]

-- A train run whose route is in the cache gets the track drawn on it.
#guard fires MIX "railSnap" #[tr 1000 2000 (some "A → B")]
-- Any segment a fix covers gets a zone. `tzAt` answers Amsterdam and `homeTz`
-- is London, so a pass that fell back instead of looking up would still differ
-- from the input and pass here — what pins the BRANCH is the pair of guards on
-- `displayTz` itself, below.
#guard fires MIX "displayTz" #[wk 0 3000]
-- Every segment leaves with an enrichment attached. Asserting only that the
-- field went from `none` to `some` would be satisfied by a pass that attached a
-- DEFAULT, so the mean of the two in-window samples is what is checked.
#guard fires MIX "biomEnrich" #[wk 0 3000]
#guard ((runNamed MIX "biomEnrich" #[wk 0 3000])[0]!.biometrics.map (·.hrMean)) == some (some 70)
-- …and a window the samples miss gets an enrichment whose HR fields are empty,
-- which is a different thing from no enrichment at all.
#guard ((runNamed MIX "biomEnrich" #[wk 6000 9000])[0]!.biometrics.map (·.hrMean)) == some none
-- The step total too, which is what pins `biomSteps` — the HR guards above are
-- blind to it, and a projection that handed the pass no rows would pass them.
-- 51 minutes at 100 spm, inclusive both ends.
#guard ((runNamed MIX "biomEnrich" #[wk 0 3000])[0]!.biometrics.map (·.stepsTotal))
  == some (some 5100)

-- A decode with a place pick overrides the pipeline's attribution.
#guard fires MIX "hsmmOverride" #[st 0 600, wk 600 1200]
-- Two consecutive stays at one place are one visit.
#guard fires MIX "finalMerge" #[st 0 600 (some "Home"), st 600 1200 (some "Home")]
-- …and two adjacent walks are NOT coalesced, because nothing was swallowed.
-- The TS coalesces only when the far-phantom swallow demoted a stay, testing
-- that by reference equality on the returned array; this is the guard that
-- pins the structural stand-in. Drop the test and these two walks merge.
#guard !fires MIX "finalMerge" #[wk 0 600, wk 600 1200]

-- …and the far-phantom swallow, the arm the two guards above do not reach: they
-- are carried by the stay merge alone, so the swallow could be deleted and both
-- would still hold. `fires` cannot pin it either — with the swallow gone this
-- day changes nothing at all, so the assertion has to be about the OUTPUT.
--
-- Two stays carrying the same focus place with only a walk between them. The
-- first sits on it (centroid 66 m along the track, inside `FOCUS_AT_PLACE_M`);
-- the second is 990 m away, past `FOCUS_PHANTOM_MIN_M` — the label over-reach
-- the pass exists to demote. The far one loses mode, place and id, and then
-- coalesces with the walk before it into one 120→1200 leg.
private def stf (a b : Int) : Seg := { st a b (some "The Office") with focusPlaceId := some 7 }
private def farPhantomDay : Array Seg := #[stf 0 120, wk 120 600, stf 600 1200]
private def farPhantomOut : Array Seg := runNamed MIX "finalMerge" farPhantomDay

#guard farPhantomOut.size == 2
#guard farPhantomOut[1]!.startTs == 120 && farPhantomOut[1]!.endTs == 1200
#guard farPhantomOut[1]!.focusPlaceId == none
-- The NEAR stay survives with its label. Without this a swallow that demoted
-- every stay carrying the id — including the one actually at the place — would
-- satisfy all three guards above.
#guard farPhantomOut[0]!.focusPlaceId == some 7 && farPhantomOut[0]!.place == some "The Office"
-- A stay at a station with a train either side is a change of trains.
#guard fires MIX "interchangeStayLabel"
  #[tr 0 600 (some "A → S"), st 600 900, tr 900 1500 (some "S → T")]
-- The ride on to the true alight, stranded as the fast head of the next walk.
#guard fires MIX "alightAnchor" #[tr 0 2400 (some "S → T · Metropolitan"), wk 2400 6000]
-- Two legs of one Metropolitan ride, split by a sliver, are one ride.
#guard fires MIX "railJourney"
  #[tr 3000 4200 (some "S → M · Metropolitan"), wk 4200 4400,
    tr 4400 6000 (some "M → T · Metropolitan")]
-- Boarding re-anchored to the station the preceding walk actually reached.
#guard fires MIX "boardingAnchor" #[wk 3000 3600, tr 3600 6000 (some "T → S · Metropolitan")]

-- …and the SAME two days against a mirror that knows the line but does not stop
-- it where the walk arrives: `M` is the only served station, and neither walk
-- reaches it. The membership veto fires and both anchors decline. #423.
--
-- These are what pin `Env.servedStations`. The positive witnesses above cannot:
-- their walks reach `S`/`T`, which `MIX`'s mirror serves, so they anchor whether
-- the lookup answers or not. And an EMPTY lookup is not a disabled one —
-- `LineMembership.scan` leaves `known` false when every component comes back
-- empty, so a gutted projection reads as "unknown, assert nothing" and both
-- anchors fire again. That is a DIFFERENT answer, not a missing one, which is
-- why the guard has to be negative: only a day the veto is supposed to STOP can
-- tell a populated lookup from an absent one.
private def NOSERVE : Env :=
  { MIX with stationsOnLine := fun _ => #[⟨"M", lat0 + 22000 * mlat, lon0⟩] }

#guard !fires NOSERVE "boardingAnchor" #[wk 3000 3600, tr 3600 6000 (some "T → S · Metropolitan")]
#guard !fires NOSERVE "alightAnchor" #[tr 0 2400 (some "S → T · Metropolitan"), wk 2400 6000]

/-! ### `displayTz`, whose branches nothing else owns

The other 31 entries call a function some module pins. This one and
`interchangeStayLabel` are written here, so their behaviour is pinned here too —
a witness that they merely change something would leave the choice of
coordinate, and the fallback, untested. -/

-- A segment no fix covers takes `homeTz`, not a looked-up zone.
#guard (displayTz MIX #[wk 100000 200000])[0]!.displayTz == some "Europe/London"
-- One a fix covers takes the lookup's answer.
#guard (displayTz MIX #[wk 0 3000])[0]!.displayTz == some "Europe/Amsterdam"
-- Stationary reads the CENTROID, moving the MIDPOINT. The window has to span
-- the pace change for that to be a distinction at all: over a UNIFORM stretch
-- the mean position and the middle sample are the same point, so a pass that
-- used one for both would pass. Across 0-6000 the ride pulls the mean far ahead
-- of the middle sample — centroid ≈ 11.9 km, midpoint 3.3 km — and the lookup
-- below answers by latitude, which makes the choice visible.
private def byLat : Env :=
  { MIX with tzAt := fun lat _ => if lat < lat0 + 7000 * mlat then "south" else "north" }
#guard (displayTz byLat #[{ startTs := 0, endTs := 6000, mode := "stationary" }])[0]!.displayTz
  == some "north"
#guard (displayTz byLat #[{ startTs := 0, endTs := 6000, mode := "walking" }])[0]!.displayTz
  == some "south"

/-- Wired passes with no witness day here: the fold reaches them, and nothing
above shows they act. Each needs a fixture shaped to its own gate, and they fall
into three groups:

* `railRuns`, `undergroundRail`, `interchangeSplit` want line and stop data the
  synthetic lookups do not carry — `interchangeSplit` in particular needs
  endpoint line sets that are DISJOINT, which one uniform `linesAtPoint` cannot
  produce.
* `vehicleArrival`, `vehicleEdgeShed`, `rideHeadClaim`, `walkThrough` want a
  cadence-and-pace profile at a segment boundary this track does not have: a
  step burst coinciding with real translation, or its absence.
* `busEvidence`, `busRoutes` want mid-leg dwells — a stop pattern, not a
  constant-speed line.

Named rather than counted, so the residue is the work rather than a number. -/
def unwitnessed : Array String :=
  #["railRuns", "undergroundRail", "vehicleArrival", "vehicleEdgeShed", "rideHeadClaim",
    "stayArrivalClaim", "rideTailTrim",
    "interchangeSplit", "busEvidence", "busRoutes", "walkThrough", "roadMatch", "walkMatch"]

/-- Wired passes with a witness above. -/
def witnessed : Array String :=
  (passNames NO_LOOKUPS).filter fun n => !unwitnessed.contains n

#guard witnessed.size == 28
#guard unwitnessed.all (passNames NO_LOOKUPS).contains
-- The two lists partition the wired set, so a new pass must be classified.
#guard witnessed.size + unwitnessed.size == (passNames NO_LOOKUPS).size

end Witnesses

end Verified.Geo.PassFold
