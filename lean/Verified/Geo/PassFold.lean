import Verified.Geo.Velocity
import Verified.Geo.SegmentMerge
import Verified.Geo.Reversal
import Verified.Geo.RailRunAnnotate
import Verified.Geo.UndergroundAnnotate
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
      e.nearbyWays)
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
    "railRuns", "undergroundRail"]

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
#guard ((runPassesTraced env marchThenWalk).2.back!).1 == "undergroundRail"
#guard (runPassesTraced env marchThenWalk).2.size == (passes env).size

-- An empty day survives every pass.
#guard runPasses env #[] == #[]

end FoldGuards

end Verified.Geo.PassFold
