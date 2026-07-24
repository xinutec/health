import Verified.Geo.Worldline
/-!
# Day assembly: states, sleep attribution, known-place stays, day grammar

Port of the Tier-5 day-assembly cluster:

* `src/sleep/day-state.ts` — `segmentsToDayStates` (the boundary sweep that
  turns segments + Fitbit sleep windows into the day's non-overlapping state
  sequence) and `clipInferredFuture`.
* `src/sleep/load.ts` — `derivePlaceForSleep`, the side-ranked choice of which
  stay names a sleep window.
* `src/sleep/known-place-stays.ts` — `detectKnownPlaceStays`, dwell clustering
  in raw fixes snapped to mined focus places.
* `src/infer/day-grammar.ts` — `parseStationPair` and `checkDayConstraints`,
  the hard laws a physically-possible day must obey.
* `src/geo/inferred-stay.ts` — `bracketedStayPlaceId`, `buildInferredStayState`.

All of these are already pure in the TS: no DB, no `Intl`, no async. So they
port whole, including the output records — unlike the record-*sequencing*
orchestration elsewhere in this port, the `DayState[]` here IS the decision.
What stays shell is only what it always was: the DB reads behind the sleep
windows and the empty-day bracket (`loadDaySleepWindows`, `loadEmptyDayBracket`),
the tz/civil-date work (`dateBoundsUtc`, `nextDateString`), and the OSM
resolution in `inferEmptyDayStatesFromBracket`.

## Two separator parsers that are NOT the same function

`parseStationPair` here and {@link Verified.Geo.Worldline.parseRailWayName} both
read a `Board → Alight · Line` label, and they behave DIFFERENTLY. That is
faithful to the TS, not an oversight:

* `parseRailWayName` (`rail-snap.ts`) uses `indexOf`/`slice` — it strips the
  line suffix first and rejoins the arrow tail, so `"A → B → C"` alights at
  `"B → C"`.
* `parseStationPair` (`day-grammar.ts`) uses `split(sep, 2)`, and JS `split`
  with a limit TRUNCATES rather than keeping the remainder, so `"A → B → C"`
  alights at `"B"` and the `"→ C"` is silently dropped.

Both are pinned by guards below and in `Worldline`.

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
  wayName : Option String := none
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
  wayName : Option String := none
  displayTz : Option String := none
  deriving Inhabited, BEq

/-! ## `segmentsToDayStates` -/

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

private def makeStateFromSegment (seg : Seg) (startTs endTs : Int) (mode : Mode)
    (asleep : Bool) : DayState :=
  { startTs := startTs, endTs := endTs, mode := mode,
    place := seg.place,
    wayName := seg.wayName,
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
        -- Stationary AT the sleep place: rewrite to sleeping.
        if w.place.isSome && s.place == w.place then
          -- Prefer the window's tz over the segment's displayTz so the
          -- rewritten half matches the synthesized half — otherwise strict
          -- string equality in `sameState` would stop the two halves of one
          -- sleep from merging into a single row.
          some { startTs := start, endTs := finish, mode := "sleeping", place := s.place,
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

/-- The day's non-overlapping state sequence. Boundary sweep: take every
    distinct boundary, and for each sub-interval pick the state from the
    covering segment and covering sleep window (probed at the MIDPOINT, so a
    zero-length sub-interval cannot pick up a neighbour). -/
def segmentsToDayStates (segments : List Seg) (sleeps : List SleepWindow) : List DayState :=
  let bs := collectBoundaries segments sleeps
  if bs.length < 2 then [] else
  let pairs := (List.range (bs.length - 1)).map (fun i => (bs[i]!, bs[i+1]!))
  let states := pairs.filterMap (fun (start, finish) =>
    -- The TS probes at `start + (end - start) / 2` in FLOAT arithmetic. For
    -- integer timestamps the midpoint of a non-empty interval always lies in
    -- `[start, end)`, so integer floor division picks the same segment.
    let mid := start + (finish - start) / 2
    stateForInterval start finish (findCovering segments mid) (findCoveringSleep sleeps mid))
  stripPartialMinutesAsleep (mergeAdjacent states) sleeps

/-- Never assert the future. An inferred state may run to a survival horizon or
    the day end that lies ahead of now; clip it. Observed states are untouched
    (real data cannot be in the future). Presentation-layer only — the pipeline
    still fills to the horizon, so goldens replaying past days are unaffected. -/
def clipInferredFuture (states : List DayState) (nowTs : Int) : List DayState :=
  states.filterMap (fun s =>
    if s.inferred != some true || s.endTs ≤ nowTs then some s
    else if s.startTs ≥ nowTs then none          -- wholly future: drop
    else some { s with endTs := nowTs })         -- straddles now: truncate

/-! ## Sleep-place attribution -/

/-- Which side of the sleep window a candidate stay sits on. Smaller rank wins:
    `overlap` is direct evidence, the bedtime side is where you lay down, the
    wake side is only where you were found afterwards. -/
private def sideRank (r : Nat) : Nat := r

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
def derivePlaceForSleep (winStart winEnd : Int) (segments : List Seg) : Option String :=
  let scored := segments.filterMap (fun s =>
    if s.refinedMode.getD s.mode != "stationary" then none
    else match s.place with
      | none => none
      | some p =>
        let (rank, gap) :=
          if s.startTs > winEnd then (2, s.startTs - winEnd)        -- wake side
          else if winStart > s.endTs then (1, winStart - s.endTs)   -- bedtime side
          else (0, 0)
        if gap > PLACE_FALLBACK_MAX_GAP_SEC then none else some (p, rank, gap))
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

/-! ## Day grammar -/

private def STATION_SEP : String := " → "
private def LINE_SEP : String := " · "

/-- Modes in which you are aboard a vehicle: moving between two DIFFERENT ones
    requires alighting first. -/
private def VEHICLE_MODES : List Mode := ["driving", "bus", "train", "cycling", "plane"]
private def REST_MODES : List Mode := ["stationary", "sleeping"]

/-- Two states are *contiguous* — no time to do anything between them — when
    the gap is at most this. The adjacency laws fire only on contiguous pairs:
    a real gap is unobserved time in which the user could legitimately have
    travelled or alighted, so it is INCOMPLETE, not IMPOSSIBLE. Flagging it
    would punish the honest "we didn't see this". -/
private def CONTIGUITY_MAX_GAP_S : Int := 120

/-- JS `split(sep, limit)` semantics: the result is TRUNCATED to `limit`
    parts, the remainder is NOT rejoined onto the last one. -/
private def splitLimit (s sep : String) (limit : Nat) : List String :=
  (s.splitOn sep).take limit

/-- Parse a moving leg's `Board → Alight · Line` label, or `none` when it is
    not a station pair.

    Uses `split(sep, 2)` like the TS, so `"A → B → C"` yields alight `"B"` and
    drops the `"→ C"` — deliberately UNLIKE
    {@link Verified.Geo.Worldline.parseRailWayName}, which rejoins the tail.
    See the module header. -/
def parseStationPair (wayName : Option String) : Option (String × String) :=
  match wayName with
  | none => none
  | some s =>
    if !(s.splitOn STATION_SEP).length ≥ 2 then none else
    match splitLimit s STATION_SEP 2 with
    | [board, rest] =>
      let alight := (splitLimit rest LINE_SEP 1).headD ""
      if board.isEmpty || alight.isEmpty then none
      else some (board.trimAscii.toString, alight.trimAscii.toString)
    | _ => none

inductive ConstraintId where
  /-- Two adjacent vehicle legs of DIFFERENT modes with nothing between: you
      cannot step from one moving vehicle straight into another. -/
  | vehicleHandoff
  /-- Two adjacent at-rest states at DIFFERENT named places with no travel
      between: you cannot teleport. -/
  | stayTeleport
  /-- A transit leg whose board and alight are the same stop: a journey that
      begins and ends in one place is not a journey. -/
  | transitSameEndpoint
  deriving Inhabited, BEq, Repr

structure Violation where
  constraint : ConstraintId
  /-- Index of the offending state (the FIRST of the pair for adjacency laws). -/
  index : Nat
  deriving Inhabited, BEq, Repr

/--
Every hard-constraint violation in a rendered day, in timeline order. Empty
means the day is physically possible — it may still be WRONG (that is the
probabilistic layer's job) but not impossible.

Each law fires only on a genuine physical impossibility, never on a merely
unusual day: soft implausibilities belong in the scoring, not here. The TS also
builds a human-readable `detail` string per violation; that is display, so it
stays shell (same split as `classifyCluster.reason`).
-/
def checkDayConstraints (states : List DayState) : List Violation := Id.run do
  let arr := states.toArray
  let mut out : Array Violation := #[]
  for i in [0:arr.size] do
    let s := arr[i]!
    -- Law 3 — a transit leg must run between two distinct stations.
    if s.mode == "train" || s.mode == "bus" then
      match parseStationPair s.wayName with
      | some (board, alight) =>
        if board == alight then
          out := out.push ⟨ConstraintId.transitSameEndpoint, i⟩
      | none => pure ()
    if h : i + 1 < arr.size then
      let next := arr[i + 1]
      -- Adjacency laws apply only to contiguous pairs.
      if next.startTs - s.endTs > CONTIGUITY_MAX_GAP_S then
        pure ()
      else
        -- Law 1 — no direct hand-off between two different vehicles.
        if VEHICLE_MODES.contains s.mode && VEHICLE_MODES.contains next.mode
           && s.mode != next.mode then
          out := out.push ⟨ConstraintId.vehicleHandoff, i⟩
        -- Law 2 — no teleport between two distinct at-rest places.
        if REST_MODES.contains s.mode && REST_MODES.contains next.mode
           && s.place.isSome && next.place.isSome && s.place != next.place then
          out := out.push ⟨ConstraintId.stayTeleport, i⟩
  return out.toList

/-! ## Cross-day inference -/

/-- The place a no-data day is attributed to, or `none` when it is not
    bracketed by the SAME place on both sides (then it is genuinely unknown,
    not inferable). Confidence comes from how constrained the day is, not from
    how much data it has. -/
def bracketedStayPlaceId (prevEndOfDay nextDominant : Option Int) : Option Int :=
  match prevEndOfDay, nextDominant with
  | some a, some b => if a == b then some a else none
  | _, _ => none

/-- The single inferred state spanning a no-data day, once the bracketing place
    has been resolved to a name by the shell. -/
def buildInferredStayState (place : String) (tz : Option String) (startTs endTs : Int) :
    DayState :=
  { startTs := startTs, endTs := endTs, mode := "stationary",
    place := some place, tz := tz, inferred := some true }

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
#guard segmentsToDayStates [sg T0 (T0+3600) (place := some "Home")] []
  == [{ startTs := T0, endTs := T0+3600, mode := "stationary", place := some "Home" }]
-- Adjacent same-state runs merge; different places do not.
#guard (segmentsToDayStates
  [sg T0 (T0+3600) (place := some "Home"), sg (T0+3600) (T0+7200) (place := some "Home")] []).length == 1
#guard (segmentsToDayStates
  [sg T0 (T0+3600) (place := some "Home"), sg (T0+3600) (T0+7200) (place := some "Work")] []).length == 2
-- refinedMode wins over mode; vehicleKind "bus" wins over both.
#guard (segmentsToDayStates
  [sg T0 (T0+3600) "driving" (refinedMode := some "train") (wayName := some "A → B · Line")] []).head!.mode
  == "train"
#guard (segmentsToDayStates
  [sg T0 (T0+3600) "driving" (refinedMode := some "driving") (vehicleKind := some "bus")
     (wayName := some "Rt 38")] []).head!.mode == "bus"
-- A sleep window with no segment coverage synthesizes a sleeping state.
#guard segmentsToDayStates [] [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]
  == [{ startTs := T0, endTs := T0+3600, mode := "sleeping", place := some "Home",
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
-- The synthesized half and the rewritten half of ONE sleep merge into one row,
-- and because the merged row spans the full window minutesAsleep survives.
#guard segmentsToDayStates
  [sg (T0+1800) (T0+3600) (place := some "Home") (displayTz := some "Europe/London")]
  [sw T0 (T0+3600) (some "Home") 55 (some "Europe/London")]
  == [{ startTs := T0, endTs := T0+3600, mode := "sleeping", place := some "Home",
        tz := some "Europe/London", minutesAsleep := some 55 }]
-- A sleeping row covering only PART of its window loses minutesAsleep.
#guard segmentsToDayStates [sg (T0+1800) (T0+3600) (place := some "Work")]
  [sw T0 (T0+3600) (some "Home") 55]
  == [{ startTs := T0, endTs := T0+1800, mode := "sleeping", place := some "Home" },
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

/-! ### `clipInferredFuture` -/

private def NOW : Int := T0 + 3600
private def obs : DayState :=
  { startTs := T0, endTs := T0+7200, mode := "stationary", place := some "Home" }
private def inf (a b : Int) : DayState :=
  { startTs := a, endTs := b, mode := "stationary", place := some "Home", inferred := some true }

-- Observed states are never clipped: real data cannot be in the future.
#guard clipInferredFuture [obs] NOW == [obs]
#guard clipInferredFuture [inf T0 (T0+1800)] NOW == [inf T0 (T0+1800)]
-- Ending exactly at now is not future.
#guard clipInferredFuture [inf T0 NOW] NOW == [inf T0 NOW]
#guard clipInferredFuture [inf T0 (T0+7200)] NOW == [inf T0 NOW]
-- Starting exactly at now is wholly future.
#guard clipInferredFuture [inf NOW (T0+7200)] NOW == []
#guard clipInferredFuture [inf (NOW+60) (T0+7200)] NOW == []

/-! ### `derivePlaceForSleep` -/

private def WS : Int := T0 + 10000
private def WE : Int := T0 + 30000

#guard derivePlaceForSleep WS WE [] == none
#guard derivePlaceForSleep WS WE [sg (T0+12000) (T0+20000) "walking" (place := some "Home")] == none
#guard derivePlaceForSleep WS WE [sg (T0+12000) (T0+20000)] == none
#guard derivePlaceForSleep WS WE [sg (T0+12000) (T0+20000) (place := some "Hospital")] == some "Hospital"
-- The 2026-06-24 case: a bedtime-side home beats a NEARER wake-side place,
-- because you cannot relocate while asleep.
#guard derivePlaceForSleep WS WE
  [sg (T0+30060) (T0+34000) (place := some "Hospital"),
   sg (T0+2000) (T0+6000) (place := some "Home")] == some "Home"
#guard derivePlaceForSleep WS WE
  [sg (T0+2000) (T0+6000) (place := some "Home"),
   sg (T0+12000) (T0+20000) (place := some "Ward")] == some "Ward"
#guard derivePlaceForSleep WS WE
  [sg (T0+2000) (T0+6000) (place := some "Far"),
   sg (T0+2000) (T0+9000) (place := some "Near")] == some "Near"
-- The 6 h reach is inclusive.
#guard derivePlaceForSleep WS WE [sg T0 (T0+10000-6*3600-1) (place := some "TooFar")] == none
#guard derivePlaceForSleep WS WE [sg T0 (T0+10000-6*3600) (place := some "JustInRange")]
  == some "JustInRange"
#guard derivePlaceForSleep WS WE
  [sg (T0+12000) (T0+20000) "walking" (refinedMode := some "stationary") (place := some "Rewritten")]
  == some "Rewritten"
-- Ties keep the first candidate.
#guard derivePlaceForSleep WS WE
  [sg (T0+2000) (T0+6000) (place := some "First"),
   sg (T0+3000) (T0+6000) (place := some "Second")] == some "First"

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
#guard detectKnownPlaceStays (mkFixes T0 10 120 51.6 (-0.3)) [homePlace] == []
#guard (detectKnownPlaceStays
  (mkFixes T0 10 120 HOME_LAT HOME_LON ++ mkFixes (T0+5000) 10 120 51.6 (-0.3)) [homePlace]).length == 1
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

/-! ### `parseStationPair` -/

#guard parseStationPair none == none
#guard parseStationPair (some "") == none
#guard parseStationPair (some "Baker Street") == none
#guard parseStationPair (some "Euston → Kings Cross") == some ("Euston", "Kings Cross")
#guard parseStationPair (some "Euston → Kings Cross · Northern") == some ("Euston", "Kings Cross")
#guard parseStationPair (some "  Euston  →  Kings Cross  · Northern") == some ("Euston", "Kings Cross")
#guard parseStationPair (some "Euston → Kings Cross · Northern · Extra") == some ("Euston", "Kings Cross")
#guard parseStationPair (some " → Kings Cross") == none
#guard parseStationPair (some "Euston → ") == none
-- JS `split(sep, 2)` TRUNCATES: the trailing "→ C" is dropped, NOT rejoined.
-- `Worldline.parseRailWayName` deliberately differs here — see the header.
#guard parseStationPair (some "A → B → C") == some ("A", "B")

/-! ### `checkDayConstraints` -/

private def ds (a b : Int) (mode : Mode) (place : Option String := none)
    (wayName : Option String := none) : DayState :=
  { startTs := a, endTs := b, mode := mode, place := place, wayName := wayName }

#guard checkDayConstraints [] == []
#guard checkDayConstraints
  [ds T0 (T0+3600) "stationary" (place := some "Home"),
   ds (T0+3600) (T0+4000) "walking",
   ds (T0+4000) (T0+6000) "train" (wayName := some "Euston → Kings Cross · Northern")] == []
#guard checkDayConstraints [ds T0 (T0+3600) "train" (wayName := some "Euston → Euston · Northern")]
  == [⟨ConstraintId.transitSameEndpoint, 0⟩]
#guard checkDayConstraints [ds T0 (T0+3600) "bus" (wayName := some "Stop A → Stop A")]
  == [⟨ConstraintId.transitSameEndpoint, 0⟩]
-- A road name is not a station pair, so the law cannot fire on it.
#guard checkDayConstraints [ds T0 (T0+3600) "train" (wayName := some "Some Sidings")] == []
#guard checkDayConstraints
  [ds T0 (T0+3600) "driving", ds (T0+3600) (T0+5400) "train"]
  == [⟨ConstraintId.vehicleHandoff, 0⟩]
#guard checkDayConstraints [ds T0 (T0+3600) "train", ds (T0+3600) (T0+5400) "train"] == []
-- A gap wider than the contiguity window is unobserved time, not impossible.
#guard checkDayConstraints
  [ds T0 (T0+3600) "driving", ds (T0+3600+121) (T0+5400) "train"] == []
#guard checkDayConstraints
  [ds T0 (T0+3600) "driving", ds (T0+3600+120) (T0+5400) "train"]
  == [⟨ConstraintId.vehicleHandoff, 0⟩]
#guard checkDayConstraints
  [ds T0 (T0+3600) "stationary" (place := some "Home"),
   ds (T0+3600) (T0+5400) "stationary" (place := some "Work")]
  == [⟨ConstraintId.stayTeleport, 0⟩]
-- Sleeping counts as at-rest for the teleport law.
#guard checkDayConstraints
  [ds T0 (T0+3600) "sleeping" (place := some "Home"),
   ds (T0+3600) (T0+5400) "stationary" (place := some "Work")]
  == [⟨ConstraintId.stayTeleport, 0⟩]
-- An unnamed place is not evidence of a teleport.
#guard checkDayConstraints
  [ds T0 (T0+3600) "stationary" (place := some "Home"), ds (T0+3600) (T0+5400) "stationary"] == []
#guard checkDayConstraints
  [ds T0 (T0+3600) "stationary" (place := some "Home"),
   ds (T0+3600) (T0+5400) "sleeping" (place := some "Home")] == []
-- Several laws in one day, reported in timeline order.
#guard checkDayConstraints
  [ds T0 (T0+3600) "train" (wayName := some "A → A · L"),
   ds (T0+3600) (T0+5400) "bus",
   ds (T0+5400) (T0+7200) "stationary" (place := some "Home"),
   ds (T0+7200) (T0+9000) "stationary" (place := some "Work")]
  == [⟨ConstraintId.transitSameEndpoint, 0⟩, ⟨ConstraintId.vehicleHandoff, 0⟩,
      ⟨ConstraintId.stayTeleport, 2⟩]

/-! ### Cross-day inference -/

#guard bracketedStayPlaceId none none == none
#guard bracketedStayPlaceId none (some 7) == none
#guard bracketedStayPlaceId (some 7) none == none
#guard bracketedStayPlaceId (some 7) (some 7) == some 7
#guard bracketedStayPlaceId (some 7) (some 8) == none
-- Id 0 is a real id, not a falsy blank.
#guard bracketedStayPlaceId (some 0) (some 0) == some 0
#guard buildInferredStayState "Ward 12" (some "Europe/London") T0 (T0+86400)
  == { startTs := T0, endTs := T0+86400, mode := "stationary", place := some "Ward 12",
       tz := some "Europe/London", inferred := some true }
#guard buildInferredStayState "Ward 12" none T0 (T0+86400)
  == { startTs := T0, endTs := T0+86400, mode := "stationary", place := some "Ward 12",
       inferred := some true }

end Verified.Geo.DayState
