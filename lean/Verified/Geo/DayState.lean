import Verified.Geo.Worldline
import Verified.PlaceSource
/-!
# Day assembly: states, sleep attribution, known-place stays, day grammar

Port of the Tier-5 day-assembly cluster:

* `src/sleep/day-state.ts` — `segmentsToDayStates` (the boundary sweep that
  turns segments + watch sleep windows into the day's non-overlapping state
  sequence) and `clipFuture`.
* `src/sleep/load.ts` — `derivePlaceForSleepAt`, the side-ranked choice of
  which stay names a sleep window.
* `src/sleep/known-place-stays.ts` — `detectKnownPlaceStays`, dwell clustering
  in raw fixes snapped to mined focus places.
* `src/geo/inferred-stay.ts` — `buildInferredStayState`.

All of these are already pure in the TS: no DB, no `Intl`, no async. So they
port whole, including the output records — unlike the record-*sequencing*
orchestration elsewhere in this port, the `DayState[]` here IS the decision.
What stays shell is only what it always was: the DB reads behind the sleep
windows and the empty-day bracket (`loadDaySleepWindows`, `loadEmptyDayBracket`),
the tz/civil-date work (`dateBoundsUtc`, `nextDateString`), and the OSM
resolution in `inferEmptyDayStatesFromBracket`.

Exactness: everything here is comparison, counting and string handling ⇒
EXACT, except `haversineMeters` (atan2) behind the cluster/snap tests, which is
≤1 ULP and only ever compared against metre thresholds. UNPROVEN; pinned
against Node/V8 (`lean/experiments/day-state-refs.mts`).
-/

namespace Verified.Geo.DayState

open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Shapes -/

/-- A `DayStateMode`: every `TransportMode` plus `sleeping` (which comes from
    the Fitbit windows, not GPS) and `bus` (which lives on a segment as
    `vehicleKind`, not as a mode). Kept as `String` for the same reason
    `Verified.Geo.Segments` does. -/
abbrev Mode := String

/-- One non-overlapping stretch of the day. Optional fields are omitted in the
    TS via `undefined`; `none` here means the same thing, and the distinction
    is load-bearing — `sameState` compares them for merge eligibility. -/
structure DayState where
  startTs : Int
  endTs : Int
  mode : Mode
  place : Option String := none
  /-- The rule that named `place`, when the name is still the one it named
      (`Seg.placeSource`). Not part of `sameState`. -/
  placeSource : Option String := none
  /-- Where that rule asked for the name: the position the timeline puts him
      at, which the worldline referee checks for continuity. Gated like
      `placeSource`. Not part of `sameState`. -/
  placeAt : Option (Float × Float) := none
  /-- The city header the timeline draws above this state. Served rather than
  re-derived by the client (#339); see `cityForState`. -/
  city : Option String := none
  wayName : Option String := none
  /-- Every road a moving leg was on (`Seg.roads`); `wayName` has room for
      three. Not part of `sameState`. -/
  roads : Array String := #[]
  /-- Asleep while the underlying state is not `sleeping` (in transit). Omitted
      when the mode IS `sleeping` — it would be redundant. -/
  asleep : Option Bool := none
  tz : Option String := none
  /-- Fitbit's minutes-asleep; differs from the wall-clock span by time awake
      in bed. Stripped on rows that cover only part of their window. -/
  minutesAsleep : Option Int := none
  /-- Asserted from cross-day constraint rather than observed. -/
  inferred : Option Bool := none
  deriving Inhabited, BEq, Repr

/-- A Fitbit sleep window. `place` is `none` when the sleep happened while
    moving (overnight train) — no place to match, and nothing to synthesize. -/
structure SleepWindow where
  startTs : Int
  endTs : Int
  place : Option String
  minutesAsleep : Int
  tz : Option String
  /-- Where `place` was asked for: the stay or known place the name came from. -/
  placeAt : Option (Float × Float) := none
  deriving Inhabited, BEq

/-- The fields of `EnrichedSegment` the day-state converter reads. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  /-- `some "bus"` refines a driving leg into a bus for display. -/
  vehicleKind : Option String := none
  place : Option String := none
  /-- `SegmentMerge.Seg.placeSource`, carried to the state (#325). -/
  placeSource : Option Verified.PlaceSource := none
  wayName : Option String := none
  /-- The roads of a moving leg, longest first (`SegmentMerge.Seg.walkWayUm`'s
  names); `wayName` is the label composed from the first three. -/
  roads : Array String := #[]
  displayTz : Option String := none
  /-- The metro area the leg sits in, where both its ends agree on one
  (`Enrich.commonCity`). Absent on a leg that CROSSES cities. -/
  city : Option String := none
  deriving Inhabited, BEq

/-! ## `segmentsToDayStates` -/

private def REST_MODES : List Mode := ["stationary", "sleeping"]

/-- Two states are *contiguous* — no time to do anything between them — when
    the gap is at most this. The adjacency laws fire only on contiguous pairs:
    a real gap is unobserved time in which the user could legitimately have
    travelled or alighted, so it is INCOMPLETE, not IMPOSSIBLE. Flagging it
    would punish the honest "we didn't see this". -/
private def CONTIGUITY_MAX_GAP_S : Int := 120

/-- A gap no segment covers is a SEAM, not unobserved time, when it is
    contiguous and touches a moving segment: nobody sleeps between getting up
    and the walk out. Sleep is not synthesised there, which left two
    half-minute "sleeping" rows either side of the walk to breakfast on
    2026-10-01, where Fitbit's sleep ran half an hour past the getting up. -/
def awakeSeam (segments : List Seg) (start finish : Int) : Bool :=
  let moving (g : Seg) : Bool :=
    let m := if g.vehicleKind == some "bus" then "bus" else g.refinedMode.getD g.mode
    !REST_MODES.contains m
  finish - start ≤ CONTIGUITY_MAX_GAP_S &&
    segments.any fun g =>
      moving g && ((g.endTs ≤ start && start - g.endTs ≤ CONTIGUITY_MAX_GAP_S)
        || (g.startTs ≥ finish && g.startTs - finish ≤ CONTIGUITY_MAX_GAP_S))

/-- Distinct boundary timestamps from segments and sleep windows, ascending.
    Mirrors the TS `Set` + numeric sort. -/
def collectBoundaries (segments : List Seg) (sleeps : List SleepWindow) : List Int :=
  let raw := segments.flatMap (fun s => [s.startTs, s.endTs])
             ++ sleeps.flatMap (fun w => [w.startTs, w.endTs])
  let dedup := raw.foldl (fun acc t => if acc.contains t then acc else acc ++ [t]) []
  dedup.mergeSort (fun a b => a ≤ b)

/-- The segment covering `ts`, half-open `[startTs, endTs)`; first match wins. -/
def findCovering (segments : List Seg) (ts : Int) : Option Seg :=
  segments.find? (fun s => s.startTs ≤ ts && ts < s.endTs)

/-- The sleep window covering `ts`, half-open; first match wins. -/
def findCoveringSleep (sleeps : List SleepWindow) (ts : Int) : Option SleepWindow :=
  sleeps.find? (fun w => w.startTs ≤ ts && ts < w.endTs)

/-- The segment's provenance, while its name is still the one it named. -/
private def Seg.servedSource (s : Seg) : Option Verified.PlaceSource :=
  s.placeSource.filter fun ps => s.place == some ps.name && ps.rule != ""

private def makeStateFromSegment (seg : Seg) (startTs endTs : Int) (mode : Mode)
    (asleep : Bool) : DayState :=
  { startTs := startTs, endTs := endTs, mode := mode,
    place := seg.place,
    placeSource := seg.servedSource.map (·.rule),
    placeAt := seg.servedSource.bind (·.askedAt),
    wayName := seg.wayName,
    roads := seg.roads,
    asleep := if asleep && mode != "sleeping" then some true else none,
    tz := seg.displayTz,
    minutesAsleep := none,
    inferred := none }

/-- The state for one sub-interval, given the (at most one) covering segment
    and sleep window. `none` when neither covers it — nothing to say. -/
def stateForInterval (start finish : Int) (seg : Option Seg) (sleep : Option SleepWindow) :
    Option DayState :=
  match seg, sleep with
  | none, none => none
  -- A sleep window over a stretch with no GPS: synthesize a sleeping state.
  -- This is what surfaces morning-sleep-before-first-fix in the timeline.
  | none, some w =>
    match w.place with
    | none => none  -- overnight in transit: no place, nothing to synthesize
    | some p =>
      some { startTs := start, endTs := finish, mode := "sleeping", place := some p,
             placeSource := some "sleep", placeAt := w.placeAt,
             tz := w.tz,
             minutesAsleep := if w.minutesAsleep > 0 then some w.minutesAsleep else none }
  | some s, sleepOpt =>
    -- vehicleKind refines a driving leg into a bus for display; the upstream
    -- transport-mode machinery still says driving.
    let segMode : Mode :=
      if s.vehicleKind == some "bus" then "bus" else s.refinedMode.getD s.mode
    match sleepOpt with
    | none => some (makeStateFromSegment s start finish segMode false)
    | some w =>
      if segMode == "stationary" then
        -- A stay with no place under a window that has one: asleep there. The
        -- window's place is the night's (named from where the evening ended);
        -- a stay nobody placed asserts nowhere else. The decoder covers a dark
        -- night with such a stay where the cascade leaves no segment at all.
        if w.place.isSome && s.place.isNone then
          some { startTs := start, endTs := finish, mode := "sleeping", place := w.place,
                 placeSource := some "sleep", placeAt := w.placeAt,
                 tz := if w.tz.isSome then w.tz else s.displayTz,
                 minutesAsleep := if w.minutesAsleep > 0 then some w.minutesAsleep else none }
        -- Stationary AT the sleep place: rewrite to sleeping.
        else if w.place.isSome && s.place == w.place then
          -- Prefer the window's tz over the segment's displayTz so the
          -- rewritten half matches the synthesized half — otherwise strict
          -- string equality in `sameState` would stop the two halves of one
          -- sleep from merging into a single row.
          some { startTs := start, endTs := finish, mode := "sleeping", place := s.place,
                 placeSource := s.servedSource.map (·.rule),
                 placeAt := s.servedSource.bind (·.askedAt),
                 tz := if w.tz.isSome then w.tz else s.displayTz,
                 minutesAsleep := if w.minutesAsleep > 0 then some w.minutesAsleep else none }
        else
          -- Stationary somewhere else (awake at the desk while Fitbit thinks
          -- you are asleep): defer to GPS.
          some (makeStateFromSegment s start finish segMode false)
      else
        -- Moving through a sleep window: keep the mode, add the attribute.
        some (makeStateFromSegment s start finish segMode true)

/-- Merge-eligibility: every displayed field must agree. -/
def sameState (a b : DayState) : Bool :=
  a.mode == b.mode && a.place == b.place && a.wayName == b.wayName &&
  a.asleep == b.asleep && a.tz == b.tz && a.minutesAsleep == b.minutesAsleep

/-- Collapse adjacent same-state runs that touch exactly. -/
def mergeAdjacent (states : List DayState) : List DayState :=
  states.foldl (fun acc s =>
    match acc.reverse with
    | prev :: restRev =>
      if prev.endTs == s.startTs && sameState prev s then
        (restRev.reverse ++ [{ prev with endTs := s.endTs }])
      else acc ++ [s]
    | [] => [s]) []

/-- A merged sleeping row either matches its window exactly (the asleep total
    describes the whole row) or covers only part of it (split across a
    mid-night event). Strip `minutesAsleep` on the partial ones so the UI never
    claims a multi-hour asleep total on a row that is a fraction of it. -/
def stripPartialMinutesAsleep (states : List DayState) (sleeps : List SleepWindow) :
    List DayState :=
  states.map (fun s =>
    if s.mode != "sleeping" || s.minutesAsleep.isNone then s
    else if sleeps.any (fun w => w.startTs == s.startTs && w.endTs == s.endTs) then s
    else { s with minutesAsleep := none })

/-- The city header the timeline draws above a state — a port of the client's
`cityForState`, not a new rule (#339).

⚠ COMPUTED AFTER THE MERGE, on the merged span, because that is where the client
computes it. Taking the city from a contributing segment instead would answer
differently for any state that merged across a city edge, and the whole point is
that the drawn timeline does not move.

Two lookups, in the client's order:

* the segment whose span CONTAINS the state's midpoint and has a city. The
  bounds are inclusive at both ends there, and the midpoint is float — so the
  comparison is doubled here rather than floored, which is the same question in
  exact integers (`2·segStart ≤ start + end ≤ 2·segEnd`).
* failing that, ANY segment sharing the state's place. This is not decoration: a
  synthesised sleeping state runs beyond segment coverage (morning sleep before
  the first fix), so its midpoint lands in a gap, and without the fallback the
  header sits BELOW the sleep row instead of above it.
-/
def cityForState (segments : List Seg) (s : DayState) : Option String :=
  let mid2 := s.startTs + s.endTs
  match segments.find? (fun g =>
      2 * g.startTs ≤ mid2 && mid2 ≤ 2 * g.endTs && g.city.isSome) with
  | some g => g.city
  | none =>
    match s.place with
    | none => none
    | some p => (segments.find? (fun g => g.place == some p && g.city.isSome)).bind (·.city)

/-- The day's non-overlapping state sequence. Boundary sweep: take every
    distinct boundary, and for each sub-interval pick the state from the
    covering segment and covering sleep window (probed at the MIDPOINT, so a
    zero-length sub-interval cannot pick up a neighbour). -/
def segmentsToDayStates (segments : List Seg) (sleeps : List SleepWindow) : List DayState :=
  let bs := collectBoundaries segments sleeps
  if bs.length < 2 then [] else
  let pairs := bs.zip (bs.drop 1)
  let states := pairs.filterMap (fun (start, finish) =>
    -- The TS probes at `start + (end - start) / 2` in FLOAT arithmetic. For
    -- integer timestamps the midpoint of a non-empty interval always lies in
    -- `[start, end)`, so integer floor division picks the same segment.
    let mid := start + (finish - start) / 2
    let seg := findCovering segments mid
    let sleep := if seg.isNone && awakeSeam segments start finish then none
      else findCoveringSleep sleeps mid
    stateForInterval start finish seg sleep)
  stripPartialMinutesAsleep (mergeAdjacent states) sleeps

/-- The least a state may have behind `now` to be shown at all: one whole
    minute, the timeline's unit. Under it the row would read `0m`, asserting a
    state that has not yet had a minute to exist. -/
def MIN_SHOWN_S : Int := 60

/-- Never assert the future. The pipeline fills a day to its end: the decoder's
    last stay runs to midnight and an inferred stay to a survival horizon, so on
    TODAY either can end ahead of now. Observed or not, nothing past now was
    measured. Presentation-layer only — the pipeline still fills to the end, so
    goldens replaying past days are unaffected.

    A state that straddles `now` is truncated to it — unless less than
    `MIN_SHOWN_S` of it has happened, in which case it is dropped like a
    wholly-future one: it will appear once a minute of it has. -/
def clipFuture (states : List DayState) (nowTs : Int) : List DayState :=
  states.filterMap (fun s =>
    if s.endTs ≤ nowTs then some s
    else if s.startTs + MIN_SHOWN_S > nowTs then none  -- nothing yet: drop
    else some { s with endTs := nowTs })               -- straddles now: truncate

/-! ## Sleep-place attribution -/

private def PLACE_FALLBACK_MAX_GAP_SEC : Int := 6 * 3600

/--
The place naming a sleep window, or `none`.

You **cannot relocate while asleep**, so the location is anchored at sleep
ONSET and the wake side only confirms it. Candidates are ranked first by side
(overlap 0 < bedtime 1 < wake 2), then by smallest gap. This is why a
bedtime-side home beats a wake-side hospital that is nearer in TIME: on a
"walked straight out of home" morning the first stationary place after waking
is where you went TO, not where you slept. It is continuity, not a residential
bias — the same rule keeps inpatient nights at the hospital, whose bedtime side
IS the hospital.
-/
def derivePlaceForSleepAt (winStart winEnd : Int) (segments : List Seg) :
    Option (String × Option (Float × Float)) :=
  let scored := segments.filterMap (fun s =>
    if s.refinedMode.getD s.mode != "stationary" then none
    else match s.place with
      | none => none
      | some p =>
        let (rank, gap) :=
          if s.startTs > winEnd then (2, s.startTs - winEnd)        -- wake side
          else if winStart > s.endTs then (1, winStart - s.endTs)   -- bedtime side
          else (0, 0)
        if gap > PLACE_FALLBACK_MAX_GAP_SEC then none
        else some ((p, s.servedSource.bind (·.askedAt)), rank, gap))
  -- Strict improvement only, so ties keep the FIRST candidate (as the TS does).
  let best := scored.foldl (fun acc (p, rank, gap) =>
    match acc with
    | none => some (p, rank, gap)
    | some (_, br, bg) =>
      if rank < br || (rank == br && gap < bg) then some (p, rank, gap) else acc) none
  best.map (fun (p, _, _) => p)

/-! ## Known-place dwell detection -/

/-- A raw GPS fix. -/
structure StayFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- A mined focus place to snap dwells to. -/
structure StayKnownPlace where
  centroidLat : Float
  centroidLon : Float
  /-- Match radius in metres; the TS defaults to 50. -/
  radiusM : Option Float := none
  displayName : Option String
  deriving Inhabited, BEq

structure StayCandidate where
  startTs : Int
  endTs : Int
  centroidLat : Float
  centroidLon : Float
  place : String
  deriving Inhabited, BEq, Repr

private def MIN_DWELL_SEC : Int := 10 * 60
private def CLUSTER_RADIUS_M : Float := 100
private def DEFAULT_PLACE_RADIUS_M : Float := 50

/-- Mean of a list in the TS's left-to-right `reduce` order, so the floating
    accumulation matches bit-for-bit. -/
private def meanBy (f : StayFix → Float) (xs : List StayFix) : Float :=
  (xs.foldl (fun acc x => acc + f x) 0) / Float.ofNat xs.length

/-- Split fixes into runs: a new run starts whenever the next fix is farther
    than `CLUSTER_RADIUS_M` from the RUNNING centroid (which is recomputed from
    the whole current run after each accepted fix, so a slow drift stays one
    run). Runs of fewer than 2 fixes, or shorter than `MIN_DWELL_SEC`, drop. -/
def clusterFixes (fixes : List StayFix) : List (List StayFix) := Id.run do
  let mut runs : Array (List StayFix) := #[]
  let mut current : Array StayFix := #[]
  let mut cLat : Float := 0
  let mut cLon : Float := 0
  for fix in fixes do
    if current.isEmpty then
      current := #[fix]
      cLat := fix.lat
      cLon := fix.lon
    else if decide (haversineMeters cLat cLon fix.lat fix.lon > CLUSTER_RADIUS_M) then
      runs := runs.push current.toList
      current := #[fix]
      cLat := fix.lat
      cLon := fix.lon
    else
      current := current.push fix
      cLat := meanBy (·.lat) current.toList
      cLon := meanBy (·.lon) current.toList
  if !current.isEmpty then runs := runs.push current.toList
  return runs.toList.filter (fun r =>
    match r, r.getLast? with
    | _ :: _ :: _, some last => decide (last.ts - r.head!.ts ≥ MIN_DWELL_SEC)
    | _, _ => false)

/-- Snap a cluster centroid to the nearest known place within its radius, or
    `none` when it is outside every one. -/
def snapClusterToPlace (cLat cLon : Float) (places : List StayKnownPlace) :
    Option StayKnownPlace :=
  let inRange := places.filterMap (fun p =>
    let d := haversineMeters cLat cLon p.centroidLat p.centroidLon
    if decide (d > p.radiusM.getD DEFAULT_PLACE_RADIUS_M) then none else some (p, d))
  -- Strict `<`, so the FIRST of equally-distant places wins (as the TS does).
  (inRange.foldl (fun acc (p, d) =>
    match acc with
    | none => some (p, d)
    | some (_, bd) => if decide (d < bd) then some (p, d) else acc) none).map (·.1)

/-- Candidate stays: one per dwell cluster that snaps to a NAMED known place.
    Deliberately narrow — a cluster that does not snap is no better than the
    no-data fallback, so it is dropped rather than surfaced unnamed. -/
def detectKnownPlaceStays (fixes : List StayFix) (knownPlaces : List StayKnownPlace) :
    List StayCandidate :=
  if fixes.isEmpty || knownPlaces.isEmpty then [] else
  let named := knownPlaces.filter (·.displayName.isSome)
  if named.isEmpty then [] else
  (clusterFixes fixes).filterMap (fun run =>
    let cLat := meanBy (·.lat) run
    let cLon := meanBy (·.lon) run
    match snapClusterToPlace cLat cLon named with
    | none => none
    | some m =>
      match m.displayName with
      | none => none
      | some name =>
        match run.head?, run.getLast? with
        | some first, some last =>
          some { startTs := first.ts, endTs := last.ts,
                 centroidLat := cLat, centroidLon := cLon, place := name }
        | _, _ => none)

/-! ## Cross-day inference -/

/-- The single inferred state spanning a no-data day, once the bracketing place
    has been resolved to a name by the shell. -/
def buildInferredStayState (place : String) (tz : Option String) (startTs endTs : Int) :
    DayState :=
  { startTs := startTs, endTs := endTs, mode := "stationary",
    place := some place, placeSource := some "inferred", tz := tz, inferred := some true }

/-! ## Parity with Node/V8 (`lean/experiments/day-state-refs.mts`) -/

private def T0 : Int := 1778457600

private def sg (startTs endTs : Int) (mode : Mode := "stationary")
    (refinedMode : Option Mode := none) (vehicleKind : Option String := none)
    (place : Option String := none) (wayName : Option String := none)
    (displayTz : Option String := none) : Seg :=
  { startTs := startTs, endTs := endTs, mode := mode, refinedMode := refinedMode,
    vehicleKind := vehicleKind, place := place, wayName := wayName,
    displayTz := displayTz }

private def sw (startTs endTs : Int) (place : Option String) (minutesAsleep : Int := 0)
    (tz : Option String := none) : SleepWindow :=
  { startTs := startTs, endTs := endTs, place := place,
    minutesAsleep := minutesAsleep, tz := tz }

/-! ### `segmentsToDayStates` -/

#guard segmentsToDayStates [] [] == []
-- A sleep over a stretch with no GPS is judged where its window's name was asked.
#guard (segmentsToDayStates [] [{ sw T0 (T0+3600) (some "Home") with placeAt := some (51.5, -0.1) }]).head!.placeAt
  == some (51.5, -0.1)
#guard segmentsToDayStates [sg T0 (T0+3600) (place := some "Home")] []
  == [{ startTs := T0, endTs := T0+3600, mode := "stationary", place := some "Home" }]
-- Adjacent same-state runs merge; different places do not.
#guard (segmentsToDayStates
  [sg T0 (T0+3600) (place := some "Home"), sg (T0+3600) (T0+7200) (place := some "Home")] []).length == 1
#guard (segmentsToDayStates
  [sg T0 (T0+3600) (place := some "Home"), sg (T0+3600) (T0+7200) (place := some "Work")] []).length == 2
-- A stay nobody placed, under a sleep window that has a place: asleep there.
#guard segmentsToDayStates [sg T0 (T0+3600)] [sw T0 (T0+3600) (some "Home")]
  == [{ startTs := T0, endTs := T0+3600, mode := "sleeping", place := some "Home",
        placeSource := some "sleep" }]
-- A stay placed elsewhere keeps its place: awake there.
#guard (segmentsToDayStates [sg T0 (T0+3600) (place := some "Work")]
  [sw T0 (T0+3600) (some "Home")]).head!.place == some "Work"
-- refinedMode wins over mode; vehicleKind "bus" wins over both.
#guard (segmentsToDayStates
  [sg T0 (T0+3600) "driving" (refinedMode := some "train") (wayName := some "A → B · Line")] []).head!.mode
  == "train"
#guard (segmentsToDayStates
  [sg T0 (T0+3600) "driving" (refinedMode := some "driving") (vehicleKind := some "bus")
     (wayName := some "Rt 38")] []).head!.mode == "bus"
-- A sleep window with no segment coverage synthesizes a sleeping state.
#guard segmentsToDayStates [] [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]
  == [{ startTs := T0, endTs := T0+3600, mode := "sleeping", place := some "Home", placeSource := some "sleep",
        tz := some "Europe/London", minutesAsleep := some 55 }]
-- Sleeping while moving has no place to synthesize from.
#guard segmentsToDayStates [] [sw T0 (T0+3600) none 55] == []
-- Zero minutesAsleep is omitted, not stored as 0.
#guard (segmentsToDayStates [] [sw T0 (T0+3600) (some "Home") 0]).head!.minutesAsleep == none
-- Stationary at the sleep place is rewritten to sleeping.
#guard (segmentsToDayStates [sg T0 (T0+3600) (place := some "Home") (displayTz := some "Europe/London")]
  [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]).head!.mode == "sleeping"
-- The window's tz beats the segment's displayTz; the segment's is the fallback.
#guard (segmentsToDayStates [sg T0 (T0+3600) (place := some "Home") (displayTz := some "Europe/Dublin")]
  [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]).head!.tz == some "Europe/London"
#guard (segmentsToDayStates [sg T0 (T0+3600) (place := some "Home") (displayTz := some "Europe/Dublin")]
  [sw T0 (T0+3600) (some "Home") 55 none]).head!.tz == some "Europe/Dublin"
-- Stationary somewhere ELSE defers to GPS — no sleeping rewrite.
#guard (segmentsToDayStates [sg T0 (T0+3600) (place := some "Work")]
  [sw T0 (T0+3600) (some "Home") 55]).head!.mode == "stationary"
-- Moving through a sleep window keeps its mode and gains `asleep`.
#guard (segmentsToDayStates [sg T0 (T0+3600) "train" (wayName := some "Night train")]
  [sw T0 (T0+3600) (some "Home") 55]) ==
  [{ startTs := T0, endTs := T0+3600, mode := "train", wayName := some "Night train",
     asleep := some true }]
-- A seam beside a walk inside the window is the getting up, not sleep: no
-- half-minute sleeping rows either side of the walk (2026-10-01).
private def upAndOut : List Seg :=
  [sg T0 (T0+1000) (place := some "Home"), sg (T0+1030) (T0+1600) "walking",
   sg (T0+1630) (T0+3600) (place := some "Cafe")]
#guard (segmentsToDayStates upAndOut [sw T0 (T0+3600) (some "Home") 55]).map (fun s => (s.startTs - T0, s.mode))
  == [(0, "sleeping"), (1030, "walking"), (1630, "stationary")]
-- A seam between two rests still sleeps, so one night stays one row.
#guard (segmentsToDayStates
  [sg T0 (T0+1000) (place := some "Home"), sg (T0+1030) (T0+3600) (place := some "Home")]
  [sw T0 (T0+3600) (some "Home") 55]).length == 1
-- A gap past the contiguity bar is unobserved time, and sleep is synthesised.
#guard (segmentsToDayStates
  [sg T0 (T0+1000) (place := some "Home"), sg (T0+1121) (T0+1600) "walking"]
  [sw T0 (T0+3600) (some "Home") 55]).head!.endTs == T0+1121
#guard (segmentsToDayStates
  [sg T0 (T0+1000) (place := some "Home"), sg (T0+1120) (T0+1600) "walking"]
  [sw T0 (T0+3600) (some "Home") 55]).head!.endTs == T0+1000
-- The synthesized half and the rewritten half of ONE sleep merge into one row,
-- and because the merged row spans the full window minutesAsleep survives.
#guard segmentsToDayStates
  [sg (T0+1800) (T0+3600) (place := some "Home") (displayTz := some "Europe/London")]
  [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]
  == [{ startTs := T0, endTs := T0+3600, mode := "sleeping", place := some "Home", placeSource := some "sleep",
        tz := some "Europe/London", minutesAsleep := some 55 }]
-- A sleeping row covering only PART of its window loses minutesAsleep.
#guard segmentsToDayStates [sg (T0+1800) (T0+3600) (place := some "Work")]
  [sw T0 (T0+3600) (some "Home") 55]
  == [{ startTs := T0, endTs := T0+1800, mode := "sleeping", place := some "Home", placeSource := some "sleep" },
      { startTs := T0+1800, endTs := T0+3600, mode := "stationary", place := some "Work" }]
-- A hole between segments emits nothing for the hole itself.
#guard segmentsToDayStates
  [sg T0 (T0+1800) (place := some "Home"), sg (T0+3600) (T0+5400) (place := some "Work")] []
  == [{ startTs := T0, endTs := T0+1800, mode := "stationary", place := some "Home" },
      { startTs := T0+3600, endTs := T0+5400, mode := "stationary", place := some "Work" }]
-- A sleep window strictly inside a segment splits it into three rows.
#guard segmentsToDayStates
  [sg T0 (T0+7200) (place := some "Home") (displayTz := some "Europe/London")]
  [sw (T0+1800) (T0+5400) (some "Home") 40 (some "Europe/London")]
  == [{ startTs := T0, endTs := T0+1800, mode := "stationary", place := some "Home",
        tz := some "Europe/London" },
      { startTs := T0+1800, endTs := T0+5400, mode := "sleeping", place := some "Home",
        tz := some "Europe/London", minutesAsleep := some 40 },
      { startTs := T0+5400, endTs := T0+7200, mode := "stationary", place := some "Home",
        tz := some "Europe/London" }]

/-! ### `clipFuture` -/

private def NOW : Int := T0 + 3600
private def obs : DayState :=
  { startTs := T0, endTs := T0+7200, mode := "stationary", place := some "Home" }
private def inf (a b : Int) : DayState :=
  { startTs := a, endTs := b, mode := "stationary", place := some "Home", inferred := some true }

-- Observed states are clipped too: the decoder fills today's last stay to midnight.
#guard clipFuture [obs] NOW == [{ obs with endTs := NOW }]
#guard clipFuture [inf T0 (T0+1800)] NOW == [inf T0 (T0+1800)]
-- Ending exactly at now is not future.
#guard clipFuture [inf T0 NOW] NOW == [inf T0 NOW]
#guard clipFuture [inf T0 (T0+7200)] NOW == [inf T0 NOW]
-- Starting exactly at now is wholly future.
#guard clipFuture [inf NOW (T0+7200)] NOW == []
#guard clipFuture [inf (NOW+60) (T0+7200)] NOW == []
-- Under a minute behind now is nothing yet: dropped rather than shown as `0m`.
#guard clipFuture [inf (NOW-59) (T0+7200)] NOW == []
-- A whole minute behind now is the first thing worth showing.
#guard clipFuture [inf (NOW-60) (T0+7200)] NOW == [inf (NOW-60) NOW]

/-! ### `derivePlaceForSleepAt` -/

private def WS : Int := T0 + 10000
private def WE : Int := T0 + 30000

-- The position comes with the name: where the candidate's record was asked.
#guard derivePlaceForSleepAt WS WE
  [{ sg (T0+12000) (T0+20000) (place := some "Hospital") with
       placeSource := some ⟨"Hospital", "enclosing", some (51.5, -0.1)⟩ }]
  == some ("Hospital", some (51.5, -0.1))

/-! ### `detectKnownPlaceStays` -/

private def HOME_LAT : Float := 51.5205
private def HOME_LON : Float := -0.1275
private def homePlace : StayKnownPlace :=
  { centroidLat := HOME_LAT, centroidLon := HOME_LON, displayName := some "Home" }
private def mkFixes (startTs : Int) (n : Nat) (stepSec : Int) (lat lon : Float) : List StayFix :=
  (List.range n).map (fun i => { ts := startTs + Int.ofNat i * stepSec, lat := lat, lon := lon })

#guard detectKnownPlaceStays [] [homePlace] == []
#guard detectKnownPlaceStays (mkFixes T0 10 120 HOME_LAT HOME_LON) [] == []
#guard detectKnownPlaceStays (mkFixes T0 10 120 HOME_LAT HOME_LON)
  [{ centroidLat := HOME_LAT, centroidLon := HOME_LON, displayName := none }] == []
#guard (detectKnownPlaceStays (mkFixes T0 10 120 HOME_LAT HOME_LON) [homePlace]).length == 1
#guard (detectKnownPlaceStays (mkFixes T0 10 120 HOME_LAT HOME_LON) [homePlace]).head!.endTs == T0 + 1080
-- The 10-minute dwell floor is inclusive.
#guard (detectKnownPlaceStays (mkFixes T0 2 600 HOME_LAT HOME_LON) [homePlace]).length == 1
#guard detectKnownPlaceStays (mkFixes T0 2 599 HOME_LAT HOME_LON) [homePlace] == []
-- A run needs at least two fixes.
#guard detectKnownPlaceStays (mkFixes T0 1 120 HOME_LAT HOME_LON) [homePlace] == []
-- A cluster that snaps to nothing is dropped, not surfaced unnamed.
#guard detectKnownPlaceStays (mkFixes T0 10 120 51.6 (-38.3)) [homePlace] == []
#guard (detectKnownPlaceStays
  (mkFixes T0 10 120 HOME_LAT HOME_LON ++ mkFixes (T0+5000) 10 120 51.6 (-38.3)) [homePlace]).length == 1
-- The closer of two in-range places wins.
#guard (detectKnownPlaceStays (mkFixes T0 10 120 HOME_LAT HOME_LON)
  [{ centroidLat := HOME_LAT + 0.0003, centroidLon := HOME_LON, displayName := some "Farther" },
   { centroidLat := HOME_LAT + 0.0001, centroidLon := HOME_LON, displayName := some "Closer" }]).head!.place
  == "Closer"
-- The default match radius is 50 m; a wider one must be asked for.
#guard detectKnownPlaceStays (mkFixes T0 10 120 (HOME_LAT + 0.0006) HOME_LON) [homePlace] == []
#guard (detectKnownPlaceStays (mkFixes T0 10 120 (HOME_LAT + 0.0006) HOME_LON)
  [{ homePlace with radiusM := some 150 }]).length == 1
-- A slow drift stays ONE run: each step is inside the radius of the running mean.
#guard (detectKnownPlaceStays
  ((List.range 10).map (fun i =>
    { ts := T0 + Int.ofNat i * 120, lat := HOME_LAT + Float.ofNat i * 0.0001, lon := HOME_LON }))
  [{ homePlace with radiusM := some 150 }]).length == 1

/-! ### Cross-day inference -/

#guard buildInferredStayState "Ward 12" (some "Europe/London") T0 (T0+86400)
  == { startTs := T0, endTs := T0+86400, mode := "stationary", place := some "Ward 12", placeSource := some "inferred",
       tz := some "Europe/London", inferred := some true }
#guard buildInferredStayState "Ward 12" none T0 (T0+86400)
  == { startTs := T0, endTs := T0+86400, mode := "stationary", place := some "Ward 12",
       placeSource := some "inferred", inferred := some true }

end Verified.Geo.DayState
