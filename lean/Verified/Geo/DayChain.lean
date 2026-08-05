import Verified.Geo.DayState
import Verified.Geo.DwellContinuation
import Verified.Geo.EpisodeGeometry
/-!
# The day after the fold (port of `velocity.ts`'s tail)

`Verified.Geo.PassFold` ends at `withBiometrics`. What `computeVelocityFromInputs`
does next — attribute the sleep windows, cut the segment list into a state
timeline, continue a trailing dwell, and draw the episodes — is six more stages,
and this composes them.

Every body was already ported. `segmentsToDayStates`, `derivePlaceForSleep` and
`detectKnownPlaceStays` are `Geo.DayState`; `applyDwellContinuation` is
`Geo.DwellContinuation`; `buildEpisodes` is `Geo.EpisodeGeometry`. What did not
exist was anything that ran them in order against the same day, which is why the
first two were among the fourteen modules #426 measured as having no comparator
at all.

## The order, and what each stage reads

    detectKnownPlaceStays   over the MORNING and PRIOR-EVENING raw fixes, not the
                            day's own — the point is to find where the user slept
                            when today's first stationary segment is hours late.
    sleepPlace              SHELL. A generic "Stay" label gets one chance at a
                            lodging POI from the mirror.
    derivePlaceForSleep     over the day's segments PLUS the synthetic stay
                            candidates, per raw sleep window.
    segmentsToDayStates     over the day's segments and those enriched windows.
                            NOT the candidate set — the synthetics exist only to
                            attribute a sleep place and never enter the timeline.
    applyDwellContinuation  over the states.
    buildEpisodes           over the states, the segments, and both fix series.

## What stays shell, and why only this

`sleepPlace` is `bestPlace(preferResidential: true)` composed with `placeLabel` —
venue resolution against the OSM mirror, the same class as `Env.bestPlace` in the
fold. It is a lookup, so it crosses as an answer table.

The empty-day arm (`inferEmptyDayStatesFromBracket`) is NOT here. It fires only
when the day has no states AND no points, reads a cross-day bracket this env does
not carry, and resolves its label through the mirror. A separate stage rather
than a branch of this one.

`checkWorldlineFeasibility` is not here either: it is a LOG, not an output. It
computes nothing the served day carries.

UNPROVEN.
-/

namespace Verified.Geo.DayChain

open Verified.Geo.DayState (DayState SleepWindow StayFix StayKnownPlace StayCandidate
  segmentsToDayStates derivePlaceForSleep detectKnownPlaceStays)

/-- A Fitbit sleep window before place attribution — `RawSleepWindow`
(`src/sleep/load.ts`). The `place` this lacks is exactly what the chain adds. -/
structure RawSleepWindow where
  startTs : Int
  endTs : Int
  tz : Option String
  minutesAsleep : Int
  deriving Inhabited, BEq, Repr

/-- The day's tail, and the one lookup it delegates. -/
structure Env where
  /-- The fold's output. The SHARED segment record, so each stage below takes its
  own narrowing rather than this being narrowed once and lossily. -/
  segments : Array Verified.Geo.SegmentMerge.Seg
  /-- The Kalman track the episodes draw from. -/
  points : Array Verified.Geo.EpisodeGeometry.Fix
  /-- The quality-filtered, un-snapped fixes — a different series from `points`,
  and what an episode falls back to when nothing else drew it. -/
  displayFixes : Array Verified.Geo.EpisodeGeometry.RawFix
  /-- Raw fixes from THIS day's small hours. -/
  morningFixes : List StayFix
  /-- Raw fixes from the PREVIOUS evening — the guesthouse case: today's sleep
  began where yesterday ended, and today's own track says nothing about it. -/
  prevEveningFixes : List StayFix
  /-- Mined places the dwell detector snaps a cluster to. -/
  stayPlaces : List StayKnownPlace
  /-- The same places as the dwell CONTINUATION reads them — a different
  projection (visit counts and dwell totals rather than a display name), so both
  are carried rather than one being derived from the other. -/
  dwellPlaces : Array Verified.Geo.DwellContinuation.DwellCandidate
  sleep : List RawSleepWindow
  /-- The day's end instant. `applyDwellContinuation` continues no further. -/
  dayEndTs : Int
  /-- SHELL: re-resolve a stay centroid to a lodging name. `none` keeps the label
  the focus-place match gave it, which is the TS's own fallback. -/
  sleepPlace : Float → Float → Option String := fun _ _ => none

/-- The placeholder a focus-place match emits when it knows a stay happened but
not what is there. The ONLY label re-resolution is offered: a specific one (Home,
Work, a named hotel from a prior re-mine) is kept, because the mirror would
otherwise replace "Home" with the residential street address. -/
def GENERIC_STAY_LABEL : String := "Stay"

/-! ## Projections

One per shape a stage declares, on the pattern `PassFold` uses for the fix
series: each drops fields the consumer does not read, none invents one. -/

def stateSeg (s : Verified.Geo.SegmentMerge.Seg) : Verified.Geo.DayState.Seg :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, refinedMode := s.refinedMode
    vehicleKind := s.vehicleKind, place := s.place, wayName := s.wayName
    displayTz := s.displayTz }

/-- The drawn paths, `Option (Array PathPt)` on the shared segment record and
`Array SPt` here — absent and empty mean the same thing to the renderer.

The timestamp used to NARROW here: `PathPt.ts` is a `Float` because the
over-route trim and the walk corrector interpolate `ts` along a chord without
rounding, while `SPt.ts` was an `Int`, so this conversion rounded. Both are
`Float` now (#420), so the vertex crosses the stage boundary untouched — which
is what a projection between two views of one record should do. -/
private def spts (p : Option (Array Verified.Geo.PathPt)) :
    Array Verified.Geo.EpisodeGeometry.SPt :=
  (p.getD #[]).map fun q => ⟨q.lat, q.lon, q.ts⟩

def episodeSeg (s : Verified.Geo.SegmentMerge.Seg) : Verified.Geo.EpisodeGeometry.Seg :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, refinedMode := s.refinedMode
    pointCount := s.pointCount, centroidLat := s.centroidLat, centroidLon := s.centroidLon
    snappedPath := spts s.snappedPath, matchedPath := spts s.matchedPath
    walkMatchedPath := spts s.walkMatchedPath, walkSmoothedPath := spts s.walkSmoothedPath }

def episodeState (s : DayState) : Verified.Geo.EpisodeGeometry.State :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, place := s.place }

/-- A post-midnight stay candidate as the sleep-place attributor reads it: a
synthetic stationary segment. It never enters the day's segment output, only the
candidate set, so every field but the window, the mode and the place is filler —
and `derivePlaceForSleep` reads exactly those. -/
def stayCandidateSeg (c : StayCandidate) : Verified.Geo.DayState.Seg :=
  { startTs := c.startTs, endTs := c.endTs, mode := "stationary", place := some c.place }

/-! ## The chain -/

/-- Sleep-place candidates: the day's own segments, plus the synthetic stays
mined from the morning and prior-evening fixes with their labels re-resolved. -/
def sleepCandidates (e : Env) : List Verified.Geo.DayState.Seg :=
  let stays := detectKnownPlaceStays e.morningFixes e.stayPlaces
    ++ detectKnownPlaceStays e.prevEveningFixes e.stayPlaces
  let resolved := stays.map fun c =>
    if c.place != GENERIC_STAY_LABEL then c
    else { c with place := (e.sleepPlace c.centroidLat c.centroidLon).getD c.place }
  (e.segments.map stateSeg).toList ++ resolved.map stayCandidateSeg

/-- `enrichSleepWindows` — the raw windows, each given the place its onset side
points at. A one-line map in the TS, and the decision it wraps is
`derivePlaceForSleep`. -/
def enrichSleepWindows (raw : List RawSleepWindow)
    (candidates : List Verified.Geo.DayState.Seg) : List SleepWindow :=
  raw.map fun w =>
    { startTs := w.startTs, endTs := w.endTs, tz := w.tz, minutesAsleep := w.minutesAsleep
      place := derivePlaceForSleep w.startTs w.endTs candidates }

/-- The served timeline and its geometry.

Returns both because they are one decision: the episodes are 1:1 with the FINAL
states, so producing them from anything but the continued list would draw a day
the timeline does not describe. -/
def dayChain (e : Env) :
    Array DayState × Array Verified.Geo.EpisodeGeometry.Episode :=
  let windows := enrichSleepWindows e.sleep (sleepCandidates e)
  let states := (segmentsToDayStates (e.segments.map stateSeg).toList windows).toArray
  let final := Verified.Geo.DwellContinuation.applyDwellContinuation
    states e.segments e.dwellPlaces e.dayEndTs
  (final, Verified.Geo.EpisodeGeometry.buildEpisodes (final.map episodeState)
    (e.segments.map episodeSeg) e.points (some e.displayFixes))

end Verified.Geo.DayChain
