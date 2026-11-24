import Verified.Geo.DayState
import Verified.Geo.DwellContinuation
import Verified.Geo.EpisodeGeometry
/-!
# The day after the fold

After `Verified.Geo.PassFold`: attribute the sleep windows, cut the segments
into a state timeline, continue a trailing dwell, and draw the episodes, in
order:

    detectKnownPlaceStays   over the morning and prior-evening raw fixes, to find
                            where the user slept when the day's first stay is late.
    sleepPlace              shell: a generic "Stay" gets one lodging lookup.
    derivePlaceForSleepAt   over the segments plus those synthetic candidates.
    segmentsToDayStates     over the segments and enriched windows, not the
                            candidates, which never enter the timeline.
    applyDwellContinuation  over the states.
    buildEpisodes           over the states, segments and both fix series.

`sleepPlace` is a mirror lookup, so it crosses as an ask. The empty-day arm is
its own stage below (it reads a cross-day bracket); `checkWorldlineFeasibility`
is a log, not an output.

UNPROVEN.
-/

namespace Verified.Geo.DayChain

open Verified.Geo.DayState (DayState SleepWindow StayFix StayKnownPlace StayCandidate
  segmentsToDayStates detectKnownPlaceStays)

/-- A Fitbit sleep window before place attribution (`RawSleepWindow`). The
`place` this lacks is exactly what the chain adds. -/
structure RawSleepWindow where
  startTs : Int
  endTs : Int
  tz : Option String
  minutesAsleep : Int
  deriving Inhabited, BEq, Repr

/-- The day's tail, and the one lookup it delegates. -/
structure Env where
  /-- The fold's output. The shared segment record, so each stage below takes its
  own narrowing rather than this being narrowed once and lossily. -/
  segments : Array Verified.Geo.SegmentMerge.Seg
  /-- The Kalman track the episodes draw from. -/
  points : Array Verified.Geo.EpisodeGeometry.Fix
  /-- The quality-filtered, un-snapped fixes — a different series from `points`,
  and what an episode falls back to when nothing else drew it. -/
  displayFixes : Array Verified.Geo.EpisodeGeometry.RawFix
  /-- Raw fixes from this day's small hours. -/
  morningFixes : List StayFix
  /-- Raw fixes from the previous evening — the guesthouse case: today's sleep
  began where yesterday ended, and today's own track says nothing about it. -/
  prevEveningFixes : List StayFix
  /-- Mined places the dwell detector snaps a cluster to. -/
  stayPlaces : List StayKnownPlace
  /-- The same places as the dwell continuation reads them — a different
  projection (visit counts and dwell totals rather than a display name), so both
  are carried rather than one being derived from the other. -/
  dwellPlaces : Array Verified.Geo.DwellContinuation.DwellCandidate
  sleep : List RawSleepWindow
  /-- The day's end instant. `applyDwellContinuation` continues no further. -/
  dayEndTs : Int
  /-- Shell: re-resolve a stay centroid to a lodging name. `none` keeps the label
  the focus-place match gave it. -/
  sleepPlace : Float → Float → Option String := fun _ _ => none
  /-- The day's start instant. Only the empty-day arm reads it — a day with
  observations takes its bounds from the observations. -/
  dayStartTs : Int := 0
  /-- The day's display zone, carried onto an inferred stay so it renders in
  local time like every other state. -/
  dayTz : Option String := none
  /-- Shell: the cross-day bracket resolved to a name (a `presence_log`
  centroid named through the mirror). `none` means the day is not bracketed by
  one place on both sides: genuinely unknown, not a failure. -/
  bracketPlace : Option String := none

/-- The placeholder a focus-place match emits for a stay it cannot name: the
only label re-resolution is offered, since the mirror would replace "Home" with
a street address. -/
def GENERIC_STAY_LABEL : String := "Stay"

/-! ## Projections

One per shape a stage declares, as `PassFold` does: each drops unread fields
and invents none. -/

def stateSeg (s : Verified.Geo.SegmentMerge.Seg) : Verified.Geo.DayState.Seg :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, refinedMode := s.refinedMode
    vehicleKind := s.vehicleKind, place := s.place, placeSource := s.placeSource, placeShare := s.placeShare, wayName := s.wayName
    -- The roads under the fixes, and — where the matcher's route is the one
    -- drawn — the roads of that route: a walk through a park reaches its road
    -- by the route, not by a fix's nearest way.
    roads := (s.roads ++ (if s.walkMatchedPath.isSome then s.walkWayUm.map (·.1) else #[])).toList.eraseDups.toArray
    displayTz := s.displayTz, city := s.city }

/-- The drawn paths; absent and empty mean the same to the renderer. `ts` stays
a `Float` across the boundary, since interpolated vertices are fractional. -/
private def spts (p : Option (Array Verified.Geo.PathPt)) :
    Array Verified.Geo.EpisodeGeometry.SPt :=
  (p.getD #[]).map fun q => ⟨q.lat, q.lon, q.ts⟩

def episodeSeg (s : Verified.Geo.SegmentMerge.Seg) : Verified.Geo.EpisodeGeometry.Seg :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, refinedMode := s.refinedMode
    pointCount := s.pointCount, centroidLat := s.centroidLat, centroidLon := s.centroidLon
    snappedPath := spts s.snappedPath, matchedPath := spts s.matchedPath
    walkMatchedPath := spts s.walkMatchedPath, walkSmoothedPath := spts s.walkSmoothedPath
    walkUnbacked := s.walkUnbacked }

def episodeState (s : DayState) : Verified.Geo.EpisodeGeometry.State :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, place := s.place }

/-- A post-midnight stay candidate as a synthetic stationary segment, for the
sleep-place attributor only: every field but the window, mode and place is
filler. -/
def stayCandidateSeg (c : StayCandidate) : Verified.Geo.DayState.Seg :=
  { startTs := c.startTs, endTs := c.endTs, mode := "stationary", place := some c.place
    -- The name stands for the mined place's centre; a sleep named after this
    -- candidate is judged there.
    placeSource := some ⟨c.place, "stay", some (c.centroidLat, c.centroidLon)⟩ }

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

/-- How far a bracketed position may sit from a known place and still name it:
`CLUSTER_RADIUS_M`, looser than a dwell's 25 m, because two independent
positions (before and after the window) agreeing is what carries the claim.

⚠ Do not raise `DEFAULT_PLACE_RADIUS_M` or the mined 25 m for this: they govern
every dwell snap, venue attribution and the dwell continuation. -/
private def BRACKET_RADIUS_M : Float := 100

open Verified.Hsmm.FloatScore (haversineMeters) in
/-- The nearest named place within `radiusM`, ignoring each place's own radius:
its name and its centre. -/
private def snapWithin (radiusM lat lon : Float)
    (places : List Verified.Geo.DayState.StayKnownPlace) : Option (String × (Float × Float)) :=
  let inRange := places.filterMap fun p =>
    let d := haversineMeters lat lon p.centroidLat p.centroidLon
    if decide (d > radiusM) then none
    else p.displayName.map fun n => ((n, (p.centroidLat, p.centroidLon)), d)
  (inRange.foldl (fun acc (n, d) =>
    match acc with
    | none => some (n, d)
    | some (_, bd) => if decide (d < bd) then some (n, d) else acc) none).map (·.1)

/-- The place a sleep window is bracketed by: the last known position before it
and the last inside it (else the first after), when both name the same place.
`fixes` run from the evening before to the next morning.

A fix during the sleep outranks one after it: the first fix after waking can be
down the road. A phone quiet from home to home leaves no dwell in the window,
yet the night is constrained, not unevidenced, as `inferredEmptyDay` reasons
for a whole day. Disagreement yields `none`, and the ordinary rule decides. -/
def bracketPlaceForSleep (winStart winEnd : Int) (fixes : List Verified.Geo.DayState.StayFix)
    (places : List Verified.Geo.DayState.StayKnownPlace) : Option (String × (Float × Float)) :=
  -- A generic label is not a name: `sleepCandidates` re-resolves it into a
  -- lodging name and this path cannot, so those nights are left to it.
  let named := places.filter fun p =>
    p.displayName.isSome && p.displayName != some GENERIC_STAY_LABEL
  let sorted := fixes.toArray.qsort (fun a b => a.ts < b.ts) |>.toList
  let inside := sorted.filter fun p => winStart ≤ p.ts && p.ts ≤ winEnd
  let before := (sorted.filter (·.ts ≤ winStart)).getLast?.orElse fun _ => inside.head?
  let after := inside.getLast?.orElse fun _ => (sorted.filter (·.ts ≥ winEnd)).head?
  match before, after with
  | some b, some a =>
    match snapWithin BRACKET_RADIUS_M b.lat b.lon named,
          snapWithin BRACKET_RADIUS_M a.lat a.lon named with
    | some nb, some na => if nb.1 == na.1 then some nb else none
    | _, _ => none
  | _, _ => none

/-- The windows, dropping any that overlaps one with more minutes asleep (a tie
keeps the earlier): a date can carry several "main" sleeps (a nap, two versions
of one night). Disjoint windows all stay. -/
def distinctSleepWindows (raw : List RawSleepWindow) : List RawSleepWindow :=
  let overlaps := fun (a b : RawSleepWindow) => a.startTs < b.endTs && b.startTs < a.endTs
  let beats := fun (b w : RawSleepWindow) =>
    b.minutesAsleep > w.minutesAsleep || (b.minutesAsleep == w.minutesAsleep && b.startTs < w.startTs)
  raw.filter fun w => !(raw.any fun b => overlaps b w && beats b w)

#guard (distinctSleepWindows
    [{ startTs := 0, endTs := 100, tz := none, minutesAsleep := 90 },
     { startTs := 50, endTs := 120, tz := none, minutesAsleep := 60 },
     { startTs := 200, endTs := 260, tz := none, minutesAsleep := 50 }]).map (·.startTs) == [0, 200]
#guard (distinctSleepWindows
    [{ startTs := 50, endTs := 120, tz := none, minutesAsleep := 60 },
     { startTs := 0, endTs := 100, tz := none, minutesAsleep := 60 }]).map (·.startTs) == [0]

/-- The raw sleep windows, each given the place its onset side points at
(`derivePlaceForSleepAt`). The bracket goes first: where both sides agree it
beats the side-and-gap ranking, which cannot see across a silence. -/
def enrichSleepWindows (raw : List RawSleepWindow)
    (candidates : List Verified.Geo.DayState.Seg)
    (bracket : Int → Int → Option (String × (Float × Float))) : List SleepWindow :=
  raw.map fun w =>
    let named : Option (String × Option (Float × Float)) :=
      ((bracket w.startTs w.endTs).map fun (n, pos) => (n, some pos)).orElse fun _ =>
        Verified.Geo.DayState.derivePlaceForSleepAt w.startTs w.endTs candidates
    { startTs := w.startTs, endTs := w.endTs, tz := w.tz, minutesAsleep := w.minutesAsleep
      place := named.map (·.1), placeAt := named.bind (·.2) }

/-- The one state a fully-unobserved day gets, or nothing. Bracketed by the
same place on both sides, the day is constrained, not unknown: a multi-day stay
produces no fixes at all. `inferred := true` lets the renderer say "no data". -/
def inferredEmptyDay (e : Env) : Option DayState :=
  e.bracketPlace.map fun place =>
    Verified.Geo.DayState.buildInferredStayState place e.dayTz e.dayStartTs e.dayEndTs

/-- A hole at least this long between two states at the same place is bridged. -/
def BRIDGE_MIN_S : Int := 1800

/-- Fill each fixless hole of `BRIDGE_MIN_S` or more between two
stationary/sleeping states at the same named place with an inferred stay: the
phone was quiet and the person never left. A hole with a fix is the segments'
business, one between different places stays a hole, and the day's end is not
a silence (or nearly every night would gain a small inferred row). -/
def bridgeSamePlaceHoles (states : Array DayState)
    (points : Array Verified.Geo.EpisodeGeometry.Fix) (dayEndTs : Int) : Array DayState := Id.run do
  let still := fun (s : DayState) => s.mode == "stationary" || s.mode == "sleeping"
  let mut out : Array DayState := #[]
  for h : i in [0:states.size] do
    let a := states[i]
    out := out.push a
    match states[i + 1]? with
    | some b =>
      if still a && still b && b.startTs - a.endTs ≥ BRIDGE_MIN_S && a.endTs + 120 < dayEndTs then
        match a.place, b.place with
        | some pa, some pb =>
          if pa == pb && !(points.any fun p => p.ts > a.endTs && p.ts < b.startTs) then
            out := out.push
              { startTs := a.endTs, endTs := b.startTs, mode := "stationary", place := some pa
                placeSource := some "inferred", placeAt := a.placeAt.orElse (fun _ => b.placeAt)
                tz := b.tz.orElse (fun _ => a.tz)
                inferred := some true }
        | _, _ => pure ()
    | none => pure ()
  return out

private def MINUTE_S : Int := 60
private def KMH_PER_MS : Float := 3.6

/-- The fastest a person covers ground in each mode, km/h: on foot (a run, with
fix noise), by bike, by car or bus in a city, by train or plane. -/
private def reachKmh (mode : String) : Float :=
  match mode with
  | "walking" => 15
  | "cycling" => 30
  | "driving" | "bus" | "vehicle" => 130
  | "train" | "plane" | "unknown" | "journey" => 200
  | _ => 0

/-- A stay reached by a trip nothing saw, which the drawn travel could not have
covered at its modes' fastest, is a guess until its first fix: that part is
marked inferred (the user's rule), the rest observed, and a fixless stay is
inferred whole. A trip with a fix, or one the drawn travel covers, stands. -/
def markUnseenArrivals (states : Array DayState)
    (points : Array Verified.Geo.EpisodeGeometry.Fix) : Array DayState := Id.run do
  let still := fun (s : DayState) => s.mode == "stationary" || s.mode == "sleeping"
  let mut out : Array DayState := #[]
  let mut prevStill : Option DayState := none
  let mut reachM : Float := 0
  for s in states do
    let unseen := match prevStill, s.placeAt with
      | some a, some (la, lo) =>
        s.mode == "stationary" && s.place.isSome && s.inferred != some true
          && a.place.isSome && a.place != s.place
          && !(points.any fun p => p.ts ≥ a.endTs && p.ts < s.startTs + MINUTE_S)
          && (match a.placeAt with
              | some (pa, po) => Verified.Hsmm.FloatScore.haversineMeters pa po la lo > reachM
              | none => false)
      | _, _ => false
    if unseen then
      match points.find? (fun p => p.ts ≥ s.startTs && p.ts < s.endTs) with
      | some f =>
        let t := f.ts - f.ts % MINUTE_S
        if t > s.startTs then
          out := out.push { s with endTs := t, inferred := some true }
          out := out.push { s with startTs := t }
        else out := out.push s
      | none => out := out.push { s with inferred := some true }
    else out := out.push s
    if still s then
      prevStill := some s
      reachM := 0
    else
      reachM := reachM + reachKmh s.mode / KMH_PER_MS * Float.ofInt (s.endTs - s.startTs)
  return out

-- Home, a walk nothing saw, the hospital from 09:30, its first fix at 11:41:
-- the hospital before 11:41 is a guess.
private def homeHosp : Array DayState :=
  #[{ startTs := 0, endTs := 33480, mode := "stationary", place := some "Home", placeAt := some (51.570, -0.279) },
    { startTs := 33480, endTs := 34200, mode := "walking" },
    { startTs := 34200, endTs := 42600, mode := "stationary", place := some "Macmillan", placeAt := some (51.524, -0.136) }]
private def fx (t : Int) : Verified.Geo.EpisodeGeometry.Fix := ⟨t, 51.52, -0.13, 0⟩
#guard (markUnseenArrivals homeHosp #[fx 41,  fx 42070]).map (fun s => (s.startTs, s.endTs, s.inferred))
  == #[(0, 33480, none), (33480, 34200, none), (34200, 42060, some true), (42060, 42600, none)]
-- A fix on the way: the arrival was seen.
#guard (markUnseenArrivals homeHosp #[fx 33900, fx 42070]) == homeHosp
-- No fix in the stay at all: a guess whole.
#guard ((markUnseenArrivals homeHosp #[]).map (·.inferred)) == #[none, none, some true]
-- A neighbouring place 150 m off, the 12-minute walk covers it: it stands.
#guard (markUnseenArrivals (homeHosp.set! 2 { homeHosp[2]! with placeAt := some (51.5713, -0.279) }) #[]) ==
  homeHosp.set! 2 { homeHosp[2]! with placeAt := some (51.5713, -0.279) }
-- Back at the same place: not an arrival anywhere new.
#guard (markUnseenArrivals (homeHosp.set! 2 { homeHosp[2]! with place := some "Home" }) #[]) ==
  homeHosp.set! 2 { homeHosp[2]! with place := some "Home" }

/-- The served timeline and its geometry, together because the episodes are
1:1 with the final states. -/
def dayChain (e : Env) :
    Array DayState × Array Verified.Geo.EpisodeGeometry.Episode :=
  let windows := enrichSleepWindows (distinctSleepWindows e.sleep) (sleepCandidates e)
    (fun ws we => bracketPlaceForSleep ws we
      (e.prevEveningFixes ++ e.points.toList.map (fun p => { ts := p.ts, lat := p.lat, lon := p.lon })
        ++ e.morningFixes) e.stayPlaces)
  let states := (segmentsToDayStates (e.segments.map stateSeg).toList windows).toArray
  -- The empty-day arm, tested on `states` (a day with sleep windows is
  -- observed), after the states and before the dwell continuation.
  if states.isEmpty && e.points.isEmpty then
    match inferredEmptyDay e with
    | some st => (#[st], #[])
    | none => (#[], #[])
  else
  let continued := markUnseenArrivals (bridgeSamePlaceHoles
    (Verified.Geo.DwellContinuation.applyDwellContinuation
      states e.segments e.dwellPlaces e.dayEndTs) e.points e.dayEndTs) e.points
  -- City is stamped last, over the final states, so an inferred stay the dwell
  -- continuation creates also gets its header row.
  let segs := (e.segments.map stateSeg).toList
  let final := continued.map fun s =>
    { s with city := Verified.Geo.DayState.cityForState segs s }
  (final, Verified.Geo.EpisodeGeometry.buildEpisodes (final.map episodeState)
    (e.segments.map episodeSeg) e.points (some e.displayFixes))

/-! ## The empty-day arm

No golden day has zero fixes, so no corpus gate can see this arm; these guards
are the only check. -/

private def emptyEnv : Env :=
  { segments := #[], points := #[], displayFixes := #[]
    morningFixes := [], prevEveningFixes := [], stayPlaces := []
    dwellPlaces := #[], sleep := [], dayEndTs := 86400
    dayStartTs := 0, dayTz := some "Europe/London" }

-- Bracketed: one inferred stay spanning the whole local day.
#guard (dayChain { emptyEnv with bracketPlace := some "St Elsewhere" }).1 ==
  #[{ startTs := 0, endTs := 86400, mode := "stationary", place := some "St Elsewhere",
      placeSource := some "inferred", tz := some "Europe/London", inferred := some true }]

-- `inferred` must be `some true`, never `none`. Without it the renderer shows
-- an asserted day as an observed one, which is the failure this arm must not
-- have: the day is a claim from cross-day constraint, and it has to say so.
#guard ((dayChain { emptyEnv with bracketPlace := some "St Elsewhere" }).1[0]!).inferred == some true

-- Not bracketed: the day stays genuinely unknown rather than being invented.
#guard (dayChain { emptyEnv with bracketPlace := none }).1 == #[]
-- A bracketed night names the known place and stands at its centre.
#guard bracketPlaceForSleep 1000 2000
  [{ ts := 900, lat := 51.5001, lon := -0.1 }, { ts := 2100, lat := 51.5, lon := -0.1001 }]
  [{ centroidLat := 51.5, centroidLon := -0.1, displayName := some "Home" }]
  == some ("Home", (51.5, -0.1))
-- 08-21's shape: the first fix after waking is 300 m off, one during the sleep
-- is at Home — Home.
#guard bracketPlaceForSleep 1000 2000
  [{ ts := 900, lat := 51.5001, lon := -0.1 }, { ts := 1900, lat := 51.5, lon := -0.1001 },
   { ts := 2600, lat := 51.5027, lon := -0.1 }]
  [{ centroidLat := 51.5, centroidLon := -0.1, displayName := some "Home" }]
  == some ("Home", (51.5, -0.1))
-- Disagreement is still silence: asleep away from the evening's place.
#guard bracketPlaceForSleep 1000 2000
  [{ ts := 900, lat := 51.5001, lon := -0.1 }, { ts := 1900, lat := 51.6, lon := -0.1 }]
  [{ centroidLat := 51.5, centroidLon := -0.1, displayName := some "Home" },
   { centroidLat := 51.6, centroidLon := -0.1, displayName := some "Work" }]
  == none

-- An empty day draws no episodes either way.
#guard (dayChain { emptyEnv with bracketPlace := some "St Elsewhere" }).2 == #[]

-- The control. With a fix present the day is observed, so the arm must not
-- fire even when a bracket is offered — otherwise this replaces a real day with
-- an inferred one, which is far worse than the gap it closes.
private def observedEnv : Env :=
  { emptyEnv with points := #[{ ts := 100, lat := 51.5, lon := -0.1, speedKmh := 0.0 }] }

#guard (dayChain { observedEnv with bracketPlace := some "St Elsewhere" }).1 == #[]

/-! ### `bridgeSamePlaceHoles` -/

private def hs (a b : Int) (m : String) (pl : String) : DayState :=
  { startTs := a, endTs := b, mode := m, place := some pl }
private def fixAt (t : Int) : Verified.Geo.EpisodeGeometry.Fix :=
  { ts := t, lat := 51.5, lon := -0.1, speedKmh := 0.0 }

-- A quiet hour between sleep at Home and a stay at Home: bridged, and inferred.
#guard (bridgeSamePlaceHoles #[hs 0 1000 "sleeping" "Home", hs 4600 9000 "stationary" "Home"] #[] 86400).map
    (fun s => (s.startTs, s.endTs, s.inferred)) ==
  #[(0, 1000, none), (1000, 4600, some true), (4600, 9000, none)]
-- A fix in the hole: not silence, so not bridged.
#guard (bridgeSamePlaceHoles #[hs 0 1000 "sleeping" "Home", hs 4600 9000 "stationary" "Home"]
    #[fixAt 2000] 86400).size == 2
-- Two different places: the hole stays.
#guard (bridgeSamePlaceHoles #[hs 0 1000 "stationary" "Home", hs 4600 9000 "stationary" "Work"] #[] 86400).size == 2
-- Shorter than BRIDGE_MIN_S: the hole stays.
#guard (bridgeSamePlaceHoles #[hs 0 1000 "stationary" "Home", hs 2000 9000 "stationary" "Home"] #[] 86400).size == 2
-- A stay clipped at the day's end and the next night's sleep: the boundary stays.
#guard (bridgeSamePlaceHoles #[hs 0 86340 "stationary" "Home", hs 89000 99000 "sleeping" "Home"] #[] 86400).size == 2

end Verified.Geo.DayChain
