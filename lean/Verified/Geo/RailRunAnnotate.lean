import Verified.Geo.SegmentMerge
import Verified.Geo.RailRuns
import Verified.Geo.TubeHop
import Verified.Geo.LineStoppingPattern
/-!
# Labelling an unnamed train

`labelUnnamedTrains` gives each train segment without a route its own
`board → alight · line` label (the decoder already drew the changes, so nothing
merges). `resolveRailRunLabel` works through two injected lookups, stations and
lines at a coordinate, recorded in a read trace (`TraceM`) and not memoised:
the boarding lookup is skipped when a preceding stay answered, the mid-ride vote
reads every fix between board and alight, and the line retry reads the boarding
node then each alight candidate's until one shares a line. The leaves are
`Verified.Geo.RailRuns`'.

Every decision is exact except the float distance comparisons. UNPROVEN.
-/

namespace Verified.Geo.RailRunAnnotate

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Geo.RailRuns (Fix expandTubeLineNames findRunBoardingFix findRunAlightFix)
open Verified.Geo.TubeHop (NearbyStation pickBestStation rankStations stationTier)
open Verified.Geo.LineStoppingPattern (RailStopRelation pickLineByStoppingPattern)

/-! ## Shapes -/

/-- The pipeline's segment record. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- One OSM read, in the order it was issued. -/
inductive Read where
  | stations (lat lon : Float)
  | lines (lat lon : Float)
  deriving Inhabited, BEq, Repr

/-- The two lookups the caller supplies. In production both are DB queries;
here they are functions of a coordinate. -/
structure Env where
  stationsLookup : Float → Float → Array NearbyStation
  linesLookup : Float → Float → Array String

abbrev TraceM := StateM (Array Read)

def fetchStations (env : Env) (lat lon : Float) : TraceM (Array NearbyStation) := do
  modify (·.push (.stations lat lon))
  return env.stationsLookup lat lon

def fetchLines (env : Env) (lat lon : Float) : TraceM (Array String) := do
  modify (·.push (.lines lat lon))
  return env.linesLookup lat lon

/-! ## Constants -/

/-- Search radius (m) for the endpoint station lookup, read by the shell that
builds it: an overground station's first post-train fix is often 200-300 m off,
the rider having already walked off the platform. -/
def RAIL_RUN_STATION_RADIUS_M : Float := 400

/-- Above this a fix-to-fix hop is mid-tunnel GPS noise rather than a walk
between stations, and the preceding stay is trusted over the fix's own lookup. -/
def BOARDING_NOISE_SPEED_KMH : Float := 15

/-! ## Segment-window helpers -/

def hasRefinedKind (s : Seg) (kind : String) : Bool := s.refinedKinds.contains kind

/-- The fixes in a segment's window, upper bound exclusive: segments lie back to
back, so the boundary fix is the next segment's first. Including it resolved
the boarding to wherever the train was passing. -/
def samplesInWindowExclusiveEnd (points : Array Fix) (s : Seg) : Array Fix :=
  points.filter fun p => p.ts ≥ s.startTs && p.ts < s.endTs

/-- A maximal rail run: segments `[from, toExclusive)`, plus the indices of any
short stationary "platform" segments swallowed into its interior. -/
structure RailRun where
  from_ : Nat
  toExclusive : Nat
  absorbedStationary : Array Nat
  deriving Inhabited, BEq, Repr

/-! ## Line-name handling -/

/-- Append preserving first-seen order and dropping repeats: every line
collection here is an insertion-ordered set. -/
private def pushUnique (xs : Array String) (x : String) : Array String :=
  if xs.contains x then xs else xs.push x

/-- A raw `linesAtPoint` result as a directionless line set: OSM tags each
direction as its own relation ("Jubilee Line Eastbound"). -/
def canonicalLines (lines : Array String) : Array String :=
  lines.foldl (fun acc l => (expandTubeLineNames l).foldl pushUnique acc) #[]

/-- Intersect, keeping the first collection's order — `[...a].filter(l => b.has(l))`. -/
private def intersect (a b : Array String) : Array String := a.filter b.contains

/-- A station's own node coordinates, when the adapter supplied them. Recordings
made before `NearbyStation.lat/lon` existed have none, and the retry that wants
them degrades to the query point rather than inventing one. -/
def stationCoord (s : Option NearbyStation) : Option (Float × Float) :=
  match s with
  | none => none
  | some st => match st.lat, st.lon with
    | some la, some lo => some (la, lo)
    | _, _ => none

/-- The alight stations a site offers, best first: `pickBestStation`'s pick,
then the other station nodes in its order. Platforms and entrances are dropped:
the sweep tests corridor membership at a coordinate, and a terminus's dozen
platform nodes lie tens of metres off its station node. -/
def alightCandidates (stations : Array NearbyStation) (chosen : NearbyStation) :
    Array NearbyStation :=
  (rankStations stations).foldl (init := #[chosen]) fun out s =>
    if stationTier s ≥ 2 then out
    else if out.any (·.name == s.name) then out
    else out.push s

/-! ## `lineUnderTheTrack` -/

/-- Which candidate line does the ride's own track run along? Lines serving
both endpoints are indistinguishable there, but diverge between interchanges,
so one surfaced mid-ride fix usually decides. Votes via `linesAtPoint`, and only
a clean winner counts; otherwise `none` and a bare station pair, since a missing
line is honest and a guessed one is not. Every mid fix is read, for the trace
guards. -/
def lineUnderTheTrack (env : Env) (candidates : Array String) (points : Array Fix)
    (boardTs alightTs : Int) : TraceM (Option String) := do
  -- Strictly between the board and alight fixes: those sit at interchanges and
  -- carry every candidate, and the run's own end can fall on the one surfaced
  -- mid-ride fix.
  let mid := points.filter fun p => p.ts > boardTs && p.ts < alightTs
  if mid.isEmpty then return none
  let mut votes : Array (String × Nat) := candidates.map (·, 0)
  for p in mid do
    let here := canonicalLines (← fetchLines env p.lat p.lon)
    let supported := candidates.filter here.contains
    -- Only discriminating fixes vote: naming every candidate is shared track,
    -- naming none is off-corridor or unmirrored.
    if supported.isEmpty || supported.size == candidates.size then continue
    votes := votes.map fun (c, n) => if supported.contains c then (c, n + 1) else (c, n)
  -- Descending by votes, stable, so ties keep candidate order.
  let ranked := (votes.toList.mergeSort fun a b => b.2 ≤ a.2).toArray
  match ranked[0]? with
  | none => return none
  | some top =>
    if top.2 == 0 then return none                                -- nothing discriminating
    else if (match ranked[1]? with | some r1 => decide (r1.2 > 0) | none => false) then return none -- the track backs more than one
    else return some top.1

/-! ## `resolveRailRunLabel` -/

/-- What a preceding stationary segment offers as the boarding station. -/
private structure StayCandidate where
  name : String
  lat : Float
  lon : Float
  endTs : Int
  station : NearbyStation

/-- Walk back from the run for the stay the rider boarded from, through
stationary and walking segments only, so the previous journey's destination is
never claimed. The first stationary hit is the candidate. -/
private def findStayCandidate (env : Env) (segments : Array Seg) (points : Array Fix) :
    Nat → TraceM (Option StayCandidate)
  | 0 => return none
  | i + 1 => do
    let some s := segments[i]? | return none
    if s.mode == "stationary" then do
      let segPoints := samplesInWindowExclusiveEnd points s
      match segPoints[segPoints.size - 1]? with
      | none => return none
      | some last =>
        let stations ← fetchStations env last.lat last.lon
        match pickBestStation stations with
        | none => return none
        | some best =>
          return some ⟨best.name, last.lat, last.lon, last.ts, best⟩
    else if s.mode != "walking" then return none
    else findStayCandidate env segments points i

/-- The state the label resolution threads through its boarding decision. -/
private structure Boarding where
  station : Option String
  lookupLat : Float
  lookupLon : Float
  coord : Option (Float × Float)
  /-- The boarding node's OSM subtype, when a node named it. -/
  subtype : Option String

/-- The line suffix for a resolved pair, or the bare pair: the endpoints' line
sets, then the ride's track, then its stopping pattern, each only when the
previous could not decide. -/
private def suffixFor (env : Env) (base : String) (candidates : Array String)
    (points : Array Fix) (boardTs alightTs : Int)
    (board alight : String) (railStops : Array RailStopRelation) : TraceM String := do
  match ← lineUnderTheTrack env candidates points boardTs alightTs with
  | some ridden => return s!"{base} · {ridden}"
  | none =>
    -- The track could not separate them, so they share it (Metropolitan and
    -- Jubilee run on the same rails for kilometres); the speed profile says
    -- which stopping pattern the ride ran.
    let ride := points.map fun p =>
      ({ ts := p.ts, lat := p.lat, lon := p.lon, speedKmh := p.speedKmh, bearing := 0 } :
        Verified.Geo.LineStoppingPattern.FilteredPoint)
    match pickLineByStoppingPattern candidates board alight railStops ride boardTs alightTs with
    | some stopped => return s!"{base} · {stopped}"
    | none => return base

/-- Walk the alight candidates for a pair some line can realise: the first
sharing any line with the boarding station, so membership, not proximity,
decides. At a shared site the nearer node can be a terminus the ride's line does
not reach, which also erases the line and with it the check that would catch
the pair. A nearer candidate is overridden only by a reachable farther one;
otherwise the bare pair stands. -/
private def sweepAlight (env : Env) (startRetry : Array String) (endCanon : Array String)
    (startStation : String) (points : Array Fix) (boardTs alightTs : Int)
    (railStops : Array RailStopRelation) (fallback : String) :
    List NearbyStation → TraceM String
  | [] => return fallback
  | c :: rest =>
    if c.name == startStation then sweepAlight env startRetry endCanon startStation points
      boardTs alightTs railStops fallback rest
    else do
      let endRetry ← match stationCoord (some c) with
        | some (la, lo) => canonicalLines <$> fetchLines env la lo
        | none => pure endCanon
      let retry := intersect startRetry endRetry
      if retry.isEmpty then
        sweepAlight env startRetry endCanon startStation points boardTs alightTs railStops
          fallback rest
      else
        let pair := s!"{startStation} → {c.name}"
        if h1 : retry.size = 1 then
          have h0 : 0 < retry.size := by omega
          return s!"{pair} · {retry[0]}"
        else suffixFor env pair retry points boardTs alightTs startStation c.name railStops

/-- The station-pair (and optional line) label for one rail run, or `none`. A
line failure degrades to a bare pair; a station failure returns nothing. -/
def resolveRailRunLabel (env : Env) (run : RailRun) (segments : Array Seg)
    (points : Array Fix) (railStops : Array RailStopRelation) : TraceM (Option String) := do
  let some first := segments[run.from_]? | return none
  let some last := segments[run.toExclusive - 1]? | return none
  let slowBefore := findRunBoardingFix points first.startTs (hasRefinedKind first "turnaround-board")
  let after := findRunAlightFix points last.endTs (hasRefinedKind last "turnaround-alight")
  match slowBefore, after with
  | some slowBefore, some after => do
    let stay ← findStayCandidate env segments points run.from_
    -- The stay is used iff the apparent speed from it to `slowBefore` is tunnel
    -- noise; at walking pace the rider moved to another station.
    let b0 : Boarding := match stay with
      | some st =>
        let dM := haversineMeters st.lat st.lon slowBefore.lat slowBefore.lon
        let dt := max 1 (slowBefore.ts - st.endTs)
        -- `Float.ofInt`, not `Int.toNat.toFloat`, which clamps a negative to
        -- zero and reads as impossibly fast; correct without relying on `max 1`.
        let apparentKmh := (dM / Float.ofInt dt) * 3.6
        if apparentKmh > BOARDING_NOISE_SPEED_KMH then
          ⟨some st.name, st.lat, st.lon, stationCoord (some st.station), some st.station.subtype⟩
        else ⟨none, slowBefore.lat, slowBefore.lon, none, none⟩
      | none => ⟨none, slowBefore.lat, slowBefore.lon, none, none⟩
    -- Both reads are issued in source order: the boarding one is skipped
    -- outright when the stay already answered.
    let startStationsSlow ← if b0.station.isSome then pure #[]
      else fetchStations env slowBefore.lat slowBefore.lon
    let endStations ← fetchStations env after.lat after.lon
    let b1 : Boarding := if b0.station.isSome then b0 else
      let bestSlow := pickBestStation startStationsSlow
      ⟨bestSlow.map (·.name), b0.lookupLat, b0.lookupLon, stationCoord bestSlow,
        bestSlow.map (·.subtype)⟩
    -- `slowBefore` resolved to nothing but a preceding stay did: a rider whose
    -- fixes are noisy at the platform.
    let b : Boarding := match b1.station, stay with
      | none, some st =>
        ⟨some st.name, st.lat, st.lon, stationCoord (some st.station), some st.station.subtype⟩
      | _, _ => b1
    -- A ride boarded at a tube node alights at one: at a shared site the
    -- mainline node can be nearer and name a terminus the line does not reach.
    let preferEnd := b.subtype.filter (· == "subway")
    let bestEnd := pickBestStation endStations preferEnd
    match b.station, bestEnd with
    | some startStation, some bestEnd =>
      -- Same station at both ends: probably hanging around one station rather
      -- than riding. Skip the annotation — and do not even fetch lines for it.
      if startStation == bestEnd.name then return none
      else do
        let endCandidates := alightCandidates endStations bestEnd
        let base := s!"{startStation} → {bestEnd.name}"
        let startCanon := canonicalLines (← fetchLines env b.lookupLat b.lookupLon)
        let endCanon := canonicalLines (← fetchLines env after.lat after.lon)
        let inter := intersect startCanon endCanon
        if h1 : inter.size = 1 then
          have h0 : 0 < inter.size := by omega
          return some s!"{base} · {inter[0]}"
        else if inter.size > 1 then
          return some (← suffixFor env base inter points slowBefore.ts after.ts
            startStation bestEnd.name railStops)
        else do
          -- The endpoints yielded nothing: a lookup point can be off-corridor
          -- (a street reacquire, a stay centroid), which loses the line and so
          -- the route-cache key. Retry at the resolved stations' own nodes.
          -- Only when empty: an ambiguous primary must not collapse to a
          -- confident singleton from the less trustworthy node lookup. The
          -- boarding side keeps the single-node retry, being anchored where the
          -- rider stood; the alight is a bare lookup at the street reacquire.
          let startRetry ← match b.coord with
            | some (la, lo) => canonicalLines <$> fetchLines env la lo
            | none => pure startCanon
          return some (← sweepAlight env startRetry endCanon startStation points
            slowBefore.ts after.ts railStops base endCandidates.toList)
    | _, _ => return none
  | _, _ => return none

/-! ## Entry points -/

/-- Label each train segment that carries no route (`board → alight`) as a run
    of its own, and touch nothing else: no run grows, no segment merges. With
    the reads it made, in order. -/
def labelUnnamedTrainsTraced (env : Env) (segments : Array Seg) (points : Array Fix)
    (railStops : Array RailStopRelation := #[]) : Array Seg × Array Read :=
  let act : TraceM (Array Seg) := do
    let mut out := segments
    for h : i in [0:segments.size] do
      let s := segments[i]
      if s.mode == "train" && !(s.wayName.getD "").contains '→' then
        if let some lbl ← resolveRailRunLabel env ⟨i, i + 1, #[]⟩ segments points railStops then
          out := out.set! i { s with wayName := some lbl }
    return out
  act.run #[]

/-- `labelUnnamedTrainsTraced` without the reads. -/
def labelUnnamedTrains (env : Env) (segments : Array Seg) (points : Array Fix)
    (railStops : Array RailStopRelation := #[]) : Array Seg :=
  (labelUnnamedTrainsTraced env segments points railStops).1

/-! ## Guards

The reference scenarios for the pass, on the segments `labelUnnamedTrains`
takes as they stand: each unrouted train segment is a run of its own, so only
the label and the read set are compared. The lookups replay tables of the
reference stub's answers; a query outside them comes back empty and reads as a
divergence. -/

private def STATION_TABLE : Array (Float × Float × Array NearbyStation) := #[
    (51.5, (-38.1), #[⟨"Ayton", "subway", 0.0, some 51.5, some (-38.1)⟩, ⟨"Ayton Platform 1", "stop_position", 11.119492664825003, some 51.5001, some (-38.1)⟩]),
    (51.54, (-38.1), #[⟨"Ceeford", "subway", 0.0, some 51.54, some (-38.1)⟩, ⟨"Ceeford Main", "rail", 282.1688536506832, some 51.5405, some (-38.096)⟩]),
    (51.515, (-38.1), #[]),
    (51.5135, (-38.1), #[]),
    (51.56, (-38.1), #[⟨"Deeham", "subway", 0.0, some 51.56, some (-38.1)⟩]),
    (51.5404, (-38.0975), #[⟨"Ceeford", "subway", 178.52780583849142, some 51.54, some (-38.1)⟩, ⟨"Ceeford Main", "rail", 104.3327580939171, some 51.5405, some (-38.096)⟩]),
    (51.5395, (-38.1), #[⟨"Ceeford", "subway", 55.59746332254485, some 51.54, some (-38.1)⟩, ⟨"Ceeford Main", "rail", 298.1498558465431, some 51.5405, some (-38.096)⟩]),
    (51.52, (-38.1), #[⟨"Beeston", "subway", 0.0, some 51.52, some (-38.1)⟩]),
    (51.500349, (-38.1), #[⟨"Ayton", "subway", 38.80702939894352, some 51.5, some (-38.1)⟩, ⟨"Ayton Platform 1", "stop_position", 27.68753673411851, some 51.5001, some (-38.1)⟩]),
    (51.57, (-38.1), #[⟨"Effton", "subway", 0.0, some 51.57, some (-38.1)⟩]),
    (51.5, (-38.12), #[⟨"Zedton", "rail", 173.0511733818029, some 51.5, some (-38.1225)⟩, ⟨"Beeston", "rail", 207.6614080537232, some 51.5, some (-38.117)⟩, ⟨"Haldon", "rail", 242.27164272322293, some 51.5, some (-38.1165)⟩]),
    (51.52, (-38.13), #[⟨"Gee Platform 1", "stop_position", 0.0, some 51.52, some (-38.13)⟩, ⟨"Gee Platform 2", "stop_position", 22.238985328859922, some 51.5202, some (-38.13)⟩])]

private def LINE_TABLE : Array (Float × Float × Array String) := #[
    (51.5, (-38.1), #["Alpha Line", "Beta Line"]),
    (51.54, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.56, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.505, (-38.1), #["Alpha Line", "Beta Line"]),
    (51.53, (-38.1), #["Alpha Line"]),
    (51.555, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.541, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.543, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.545, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.547, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.55, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.552, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.554, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.556, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.558, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.559, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5595, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5598, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5599, (-38.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5404, (-38.0975), #["Delta Line"]),
    (51.5405, (-38.096), #["Delta Line"]),
    (51.5395, (-38.1), #["Alpha Line", "Gamma Line"]),
    (51.52, (-38.1), #["Alpha Line", "Beta Line"]),
    (51.500349, (-38.1), #["Alpha Line", "Beta Line"]),
    (51.57, (-38.1), #["Alpha Line Northbound"]),
    (51.53, (-38.2), #["Epsilon Line"]),
    (51.54, (-38.088), #["Beta Line"]),
    (51.5, (-38.12), #[]),
    (51.5, (-38.1225), #["Zeta Line"]),
    (51.5, (-38.1165), #["Alpha Line", "Beta Line"]),
    (51.515, (-38.1), #["Alpha Line", "Beta Line"]),
    (51.52, (-38.13), #[])]

private def lookIn {α : Type} (table : Array (Float × Float × Array α))
    (lat lon : Float) : Array α :=
  match table.find? (fun e => e.1 == lat && e.2.1 == lon) with
  | some e => e.2.2
  | none => #[]

private def ENV : Env :=
  { stationsLookup := lookIn STATION_TABLE, linesLookup := lookIn LINE_TABLE }

private def RAIL_STOPS : Array RailStopRelation := #[
    { stops := #[⟨some "Ayton", 51.5, (-38.1), 0⟩, ⟨some "Beeston", 51.52, (-38.1), 1⟩, ⟨some "Ceeford", 51.54, (-38.1), 2⟩, ⟨some "Ceedee", 51.55, (-38.1), 3⟩, ⟨some "Deeham", 51.56, (-38.1), 4⟩], lineRef := none, lineName := some "Alpha Line", osmRelationId := 1, routeType := "subway" },
    { stops := #[⟨some "Ceeford", 51.54, (-38.1), 0⟩, ⟨some "Deeham", 51.56, (-38.1), 1⟩], lineRef := none, lineName := some "Gamma Line", osmRelationId := 3, routeType := "subway" }]

/-- Each output segment's window and label. -/
private def labelsOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) : Array (Int × Int × String) :=
  (labelUnnamedTrains ENV segs fixes stops).map fun s => (s.startTs, s.endTs, s.wayName.getD "")

/-- The ordered reads. Neither lookup is memoised, so this is observable
behaviour and not an implementation detail. -/
private def traceOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) : Array Read :=
  (labelUnnamedTrainsTraced ENV segs fixes stops).2

private def segsS1 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS1 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS1 fixesS1 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS1 fixesS1 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- Not rail-like at all — no run, no lookup, segment passes through
-- byte-identical.
private def segsS2 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS2 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS2 fixesS2 == #[(1100, 1300, "")]
#guard traceOf segsS2 fixesS2 == #[]

-- …and its speed floor is a floor: avgSpeed 6.9 is not rail-like.
private def segsS5 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 6.9, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS5 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS5 fixesS5 == #[(1100, 1300, "")]
#guard traceOf segsS5 fixesS5 == #[]

-- …and stationary is excluded from it however fast the average claims to be.
private def segsS6 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS6 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS6 fixesS6 == #[(1100, 1300, "")]
#guard traceOf segsS6 fixesS6 == #[]

-- …but only when a rail-like segment follows it. A trailing stationary is
-- left alone — arriving home is not a platform pause.
private def segsS9 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1300, endTs := 1400, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 }]
private def fixesS9 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS9 fixesS9 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line"), (1300, 1400, "")]
#guard traceOf segsS9 fixesS9 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- …and one second past it does not, so the run splits in two.
private def segsS11 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1501, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1501, endTs := 1600, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS11 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS11 fixesS11 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1501, ""), (1501, 1600, "")]
#guard traceOf segsS11 fixesS11 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- …and above it falls to the GPS-cluster arm, which here also fails (the
-- fixes span the whole ride), so the run splits.
private def segsS13 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 10.1, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS13 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS13 fixesS13 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1260, ""), (1260, 1300, "Ayton → Ceeford · Alpha Line")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS13 fixesS13).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- A walk is refused however slow, so it splits where a `driving` middle would
-- merge: interchange walks were being welded into their train legs.
private def segsS12w : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 10.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS12w : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS12w fixesS12w == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1260, ""), (1260, 1300, "Ayton → Ceeford · Alpha Line")]

-- A turnaround-board tag breaks the run — what follows is the ride back, not
-- more of this ride.
private def segsS15 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-board"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS15 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS15 fixesS15 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1300, "")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS15 fixesS15).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.515 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- Board and alight resolve to the same station: no label, and the line
-- lookups are never made.
private def segsS16 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS16 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.5005, (-38.1), 45.0⟩, ⟨1360, 51.5, (-38.1), 2.0⟩]
#guard labelsOf segsS16 fixesS16 == #[(1100, 1300, "")]
#guard traceOf segsS16 fixesS16 == #[.stations 51.5 (-38.1), .stations 51.5 (-38.1)]

-- A preceding stationary segment supplies the boarding station, and its own
-- lookup replaces the slowBefore one — the apparent velocity from the stay to
-- slowBefore is tunnel-noise fast.
private def segsS17 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS17 : Array Fix := #[⟨950, 51.5, (-38.1), 1.0⟩, ⟨1080, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.5135, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS17 fixesS17 == #[(900, 1090, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS17 fixesS17 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- …and at realistic walking pace the stay is not trusted: the rider genuinely
-- moved to another station, so slowBefore's own lookup stands.
private def segsS18 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS18 : Array Fix := #[⟨950, 51.5, (-38.1), 1.0⟩, ⟨1080, 51.5, (-38.1), 1.0⟩, ⟨1480, 51.502, (-38.1), 2.0⟩, ⟨1500, 51.53, (-38.1), 50.0⟩, ⟨1560, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS18 fixesS18 == #[(900, 1090, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS18 fixesS18 == #[.stations 51.5 (-38.1), .stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- The walk-back stops at a non-walking, non-stationary mode: a preceding
-- driving segment is not walked through, so the previous journey's
-- destination is not claimed as this boarding.
private def segsS19 : Array Seg := #[
  { startTs := 800, endTs := 900, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 900, endTs := 1090, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 30.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS19 : Array Fix := #[⟨850, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.5135, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS19 fixesS19 == #[(800, 900, ""), (900, 1090, ""), (1100, 1300, "")]
#guard traceOf segsS19 fixesS19 == #[.stations 51.5135 (-38.1), .stations 51.54 (-38.1)]

-- Ambiguous endpoints resolved by the track: both lines serve Ayton and
-- Deeham, and the mid-ride fix on the meridian names only Alpha.
private def segsS20 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS20 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1400, 51.555, (-38.1), 20.0⟩, ⟨1560, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS20 fixesS20 == #[(1100, 1500, "Ayton → Deeham · Alpha Line")]
#guard traceOf segsS20 fixesS20 == #[.stations 51.5 (-38.1), .stations 51.56 (-38.1), .lines 51.5 (-38.1), .lines 51.56 (-38.1), .lines 51.505 (-38.1), .lines 51.53 (-38.1), .lines 51.555 (-38.1)]

-- Alpha and Gamma share the Ceeford→Deeham track completely, so every
-- mid-ride fix names both and the vote is a tie by construction. With no stop
-- data the honest answer is the bare pair.
private def segsS21 : Array Seg := #[
  { startTs := 1020, endTs := 1290, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS21 : Array Fix := #[⟨1000, 51.54, (-38.1), 2.0⟩, ⟨1020, 51.541, (-38.1), 40.0⟩, ⟨1040, 51.543, (-38.1), 40.0⟩, ⟨1060, 51.545, (-38.1), 40.0⟩, ⟨1080, 51.547, (-38.1), 40.0⟩, ⟨1100, 51.55, (-38.1), 3.0⟩, ⟨1120, 51.55, (-38.1), 3.0⟩, ⟨1140, 51.552, (-38.1), 40.0⟩, ⟨1160, 51.554, (-38.1), 40.0⟩, ⟨1180, 51.556, (-38.1), 40.0⟩, ⟨1200, 51.558, (-38.1), 40.0⟩, ⟨1220, 51.559, (-38.1), 40.0⟩, ⟨1240, 51.5595, (-38.1), 40.0⟩, ⟨1260, 51.5598, (-38.1), 40.0⟩, ⟨1280, 51.5599, (-38.1), 40.0⟩, ⟨1300, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS21 fixesS21 == #[(1020, 1290, "Ceeford → Deeham")]
#guard traceOf segsS21 fixesS21 == #[.stations 51.54 (-38.1), .stations 51.56 (-38.1), .lines 51.54 (-38.1), .lines 51.56 (-38.1), .lines 51.541 (-38.1), .lines 51.543 (-38.1), .lines 51.545 (-38.1), .lines 51.547 (-38.1), .lines 51.55 (-38.1), .lines 51.55 (-38.1), .lines 51.552 (-38.1), .lines 51.554 (-38.1), .lines 51.556 (-38.1), .lines 51.558 (-38.1), .lines 51.559 (-38.1), .lines 51.5595 (-38.1), .lines 51.5598 (-38.1), .lines 51.5599 (-38.1)]

-- …and with the stop lists in hand the tie the track could not break is
-- broken by which line calls at Ceedee: one observed dwell inside the running
-- span, and only Alpha's pattern allows exactly one.
private def segsS22 : Array Seg := #[
  { startTs := 1020, endTs := 1290, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS22 : Array Fix := #[⟨1000, 51.54, (-38.1), 2.0⟩, ⟨1020, 51.541, (-38.1), 40.0⟩, ⟨1040, 51.543, (-38.1), 40.0⟩, ⟨1060, 51.545, (-38.1), 40.0⟩, ⟨1080, 51.547, (-38.1), 40.0⟩, ⟨1100, 51.55, (-38.1), 3.0⟩, ⟨1120, 51.55, (-38.1), 3.0⟩, ⟨1140, 51.552, (-38.1), 40.0⟩, ⟨1160, 51.554, (-38.1), 40.0⟩, ⟨1180, 51.556, (-38.1), 40.0⟩, ⟨1200, 51.558, (-38.1), 40.0⟩, ⟨1220, 51.559, (-38.1), 40.0⟩, ⟨1240, 51.5595, (-38.1), 40.0⟩, ⟨1260, 51.5598, (-38.1), 40.0⟩, ⟨1280, 51.5599, (-38.1), 40.0⟩, ⟨1300, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS22 fixesS22 RAIL_STOPS == #[(1020, 1290, "Ceeford → Deeham · Alpha Line")]
#guard traceOf segsS22 fixesS22 RAIL_STOPS == #[.stations 51.54 (-38.1), .stations 51.56 (-38.1), .lines 51.54 (-38.1), .lines 51.56 (-38.1), .lines 51.541 (-38.1), .lines 51.543 (-38.1), .lines 51.545 (-38.1), .lines 51.547 (-38.1), .lines 51.55 (-38.1), .lines 51.55 (-38.1), .lines 51.552 (-38.1), .lines 51.554 (-38.1), .lines 51.556 (-38.1), .lines 51.558 (-38.1), .lines 51.559 (-38.1), .lines 51.5595 (-38.1), .lines 51.5598 (-38.1), .lines 51.5599 (-38.1)]

-- The alight reacquire lands nearer a mainline node on a
-- corridor Ayton never touches. The primary intersection empties and the
-- realisable-alight sweep walks past it to the node a line can reach.
private def segsS23 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS23 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.5404, (-38.0975), 2.0⟩, ⟨1420, 51.5404, (-38.0975), 2.0⟩]
#guard labelsOf segsS23 fixesS23 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line")]
-- Boarded at a tube node, the alight prefers one: the sweep still runs (the
-- reacquire fix is off-corridor) but tries Ceeford first and never asks about
-- the mainline node.
#guard traceOf segsS23 fixesS23 == #[.stations 51.5 (-38.1), .stations 51.5404 (-38.0975), .lines 51.5 (-38.1), .lines 51.5404 (-38.0975), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- A run with no fix at or before its start resolves nothing — no boarding
-- fix, no label, and the segment still collapses to train.
private def segsS24 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS24 : Array Fix := #[⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS24 fixesS24 == #[(1100, 1300, "")]
#guard traceOf segsS24 fixesS24 == #[]

-- Two runs in one day, each labelled independently, with an ordinary walk
-- between them left untouched.
private def segsS27 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1300, endTs := 2000, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 2100, endTs := 2300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS27 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩, ⟨2000, 51.54, (-38.1), 2.0⟩, ⟨2120, 51.545, (-38.1), 45.0⟩, ⟨2240, 51.55, (-38.1), 50.0⟩, ⟨2360, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS27 fixesS27 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line"), (1300, 2000, ""), (2100, 2300, "Ceeford → Deeham")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS27 fixesS27).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.54 (-38.1), .stations 51.56 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1), .lines 51.54 (-38.1), .lines 51.56 (-38.1), .lines 51.545 (-38.1), .lines 51.55 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- A turnaround-alight run takes the fix nearest its endTs: on the platform the
-- rider is already back past the outermost point.
private def segsS30 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-alight"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS30 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1060, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1180, 51.515, (-38.1), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS30 fixesS30 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS30 fixesS30 == #[.stations 51.5 (-38.1), .stations 51.5395 (-38.1), .lines 51.5 (-38.1), .lines 51.5395 (-38.1)]

-- …and the mirror on the boarding side: turnaround-board takes the fix
-- nearest startTs, so the platform walkback cannot stride back across the
-- turnaround into the outbound journey.
private def segsS31 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-board"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS31 : Array Fix := #[⟨300, 51.52, (-38.1), 1.0⟩, ⟨360, 51.52, (-38.1), 1.0⟩, ⟨420, 51.52, (-38.1), 40.0⟩, ⟨1080, 51.5, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS31 fixesS31 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS31 fixesS31 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- …and without the tag the same fixes do stride back: the
-- platform-train-platform walkback reaches the Beeston cluster and names the
-- ride after it.
private def segsS32 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS32 : Array Fix := #[⟨300, 51.52, (-38.1), 1.0⟩, ⟨360, 51.52, (-38.1), 1.0⟩, ⟨420, 51.52, (-38.1), 40.0⟩, ⟨1080, 51.5, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS32 fixesS32 == #[(1100, 1300, "Beeston → Ceeford · Alpha Line")]
#guard traceOf segsS32 fixesS32 == #[.stations 51.52 (-38.1), .stations 51.54 (-38.1), .lines 51.52 (-38.1), .lines 51.54 (-38.1)]

-- The boarding-noise bar from just above: 44.4 m in 10 s is 16 km/h, so the
-- stay is still trusted and its own lookup replaces slowBefore's.
private def segsS33 : Array Seg := #[
  { startTs := 900, endTs := 1085, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS33 : Array Fix := #[⟨950, 51.5, (-38.1), 1.0⟩, ⟨1080, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.500399, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS33 fixesS33 == #[(900, 1085, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS33 fixesS33 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- …and from just below: 38.9 m in the same 10 s is 14 km/h, plainly a walk,
-- so the stay is not trusted and slowBefore gets its own station lookup — one
-- extra read in the trace.
private def segsS34 : Array Seg := #[
  { startTs := 900, endTs := 1085, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS34 : Array Fix := #[⟨950, 51.5, (-38.1), 1.0⟩, ⟨1080, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.500349, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS34 fixesS34 == #[(900, 1085, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS34 fixesS34 == #[.stations 51.5 (-38.1), .stations 51.500349 (-38.1), .stations 51.54 (-38.1), .lines 51.500349 (-38.1), .lines 51.54 (-38.1)]

-- The GPS-tightness radius bracketed from above: the pause's fixes sit ~150 m
-- from their centroid, so 100 m rejects them and any looser bar would not.
private def segsS35 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS35 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1210, 51.51865, (-38.1), 40.0⟩, ⟨1230, 51.52135, (-38.1), 40.0⟩, ⟨1250, 51.51865, (-38.1), 40.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS35 fixesS35 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1260, ""), (1260, 1300, "Ayton → Ceeford · Alpha Line")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS35 fixesS35).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- The percentile index, which only an outlier can expose: four fixes within
-- 20 m and one 400 m out. At 0.8 the index lands on the outlier and the pause
-- is rejected; at 0.0 it lands on the nearest and the pause absorbs.
private def segsS36 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 5 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS36 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1205, 51.52, (-38.1), 40.0⟩, ⟨1215, 51.5201, (-38.1), 40.0⟩, ⟨1225, 51.5202, (-38.1), 40.0⟩, ⟨1235, 51.5203, (-38.1), 40.0⟩, ⟨1245, 51.5238, (-38.1), 40.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS36 fixesS36 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1260, ""), (1260, 1300, "Ayton → Ceeford · Alpha Line")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS36 fixesS36).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- The walk-back passes through a walking segment to reach the stay behind it
-- — the rider walked from the platform bench to the carriage door.
private def segsS42 : Array Seg := #[
  { startTs := 800, endTs := 1000, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1000, endTs := 1090, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS42 : Array Fix := #[⟨850, 51.5, (-38.1), 1.0⟩, ⟨990, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.5135, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS42 fixesS42 == #[(800, 1000, ""), (1000, 1090, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS42 fixesS42 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- The stay's last fix is the one looked up, not its first: the rider sat down
-- at Beeston and left from Ayton, and only the last fix names the boarding
-- station.
private def segsS43 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS43 : Array Fix := #[⟨950, 51.52, (-38.1), 1.0⟩, ⟨1080, 51.5, (-38.1), 1.0⟩, ⟨1090, 51.5135, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS43 fixesS43 == #[(900, 1090, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS43 fixesS43 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- `max 1` on the elapsed time: the stay's closing fix is later than
-- slowBefore, and a negative speed would distrust the stay.
private def segsS44 : Array Seg := #[
  { startTs := 900, endTs := 1160, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS44 : Array Fix := #[⟨950, 51.5, (-38.1), 1.0⟩, ⟨1000, 51.5135, (-38.1), 2.0⟩, ⟨1150, 51.5, (-38.1), 1.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS44 fixesS44 == #[(900, 1160, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS44 fixesS44 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- A directional relation name at one endpoint: 'Alpha Line Northbound' and
-- 'Alpha Line' are one physical line, and a raw string intersection of the
-- two is empty.
private def segsS45 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS45 : Array Fix := #[⟨1000, 51.57, (-38.1), 2.0⟩, ⟨1120, 51.565, (-38.1), 45.0⟩, ⟨1240, 51.55, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩, ⟨1420, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS45 fixesS45 == #[(1100, 1300, "Effton → Ceeford · Alpha Line")]
#guard traceOf segsS45 fixesS45 == #[.stations 51.57 (-38.1), .stations 51.54 (-38.1), .lines 51.57 (-38.1), .lines 51.54 (-38.1)]

-- A mid-ride fix naming none of the candidates — off-corridor, or outside the
-- mirror's coverage. It must not vote, and it must not be read as evidence
-- against either.
private def segsS46 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS46 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1200, 51.53, (-38.2), 50.0⟩, ⟨1240, 51.53, (-38.1), 50.0⟩, ⟨1400, 51.555, (-38.1), 20.0⟩, ⟨1560, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS46 fixesS46 == #[(1100, 1500, "Ayton → Deeham · Alpha Line")]
#guard traceOf segsS46 fixesS46 == #[.stations 51.5 (-38.1), .stations 51.56 (-38.1), .lines 51.5 (-38.1), .lines 51.56 (-38.1), .lines 51.505 (-38.1), .lines 51.53 (-38.2), .lines 51.53 (-38.1), .lines 51.555 (-38.1)]

-- The track backing more than one candidate: one mid fix names only Alpha,
-- another only Beta. Both have votes, nothing is a clean winner, and a
-- guessed line is worse than none.
private def segsS47 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS47 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1200, 51.53, (-38.1), 50.0⟩, ⟨1300, 51.54, (-38.088), 50.0⟩, ⟨1400, 51.555, (-38.1), 20.0⟩, ⟨1560, 51.56, (-38.1), 2.0⟩]
#guard labelsOf segsS47 fixesS47 == #[(1100, 1500, "Ayton → Deeham")]
#guard traceOf segsS47 fixesS47 == #[.stations 51.5 (-38.1), .stations 51.56 (-38.1), .lines 51.5 (-38.1), .lines 51.56 (-38.1), .lines 51.505 (-38.1), .lines 51.53 (-38.1), .lines 51.54 (-38.088), .lines 51.555 (-38.1)]

-- The boarding slow-fix arm is a speed test: a transit-speed fix after the
-- platform one would name wherever the train was passing.
private def segsS50 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS50 : Array Fix := #[⟨900, 51.5, (-38.1), 2.0⟩, ⟨1000, 51.5135, (-38.1), 20.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS50 fixesS50 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS50 fixesS50 == #[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

-- The sweep skips a candidate carrying the boarding station's own name (no
-- 'Beeston → Beeston'). The one it settles on shares two lines with all fixes on
-- shared track, so the bare pair stands: a two-line retry does not take its first.
private def segsS51 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS51 : Array Fix := #[⟨1000, 51.52, (-38.1), 2.0⟩, ⟨1120, 51.515, (-38.1), 45.0⟩, ⟨1240, 51.505, (-38.1), 50.0⟩, ⟨1360, 51.5, (-38.12), 2.0⟩, ⟨1420, 51.5, (-38.12), 2.0⟩]
#guard labelsOf segsS51 fixesS51 == #[(1100, 1300, "Beeston → Haldon")]
#guard traceOf segsS51 fixesS51 == #[.stations 51.52 (-38.1), .stations 51.5 (-38.12), .lines 51.52 (-38.1), .lines 51.5 (-38.12), .lines 51.52 (-38.1), .lines 51.5 (-38.1225), .lines 51.5 (-38.1165), .lines 51.515 (-38.1), .lines 51.505 (-38.1)]

-- The pause window includes its start: the far fix exactly on `startTs`
-- belongs to the pause and drags the centroid out.
private def segsS54 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 3 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS54 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1200, 51.524, (-38.1), 40.0⟩, ⟨1230, 51.52, (-38.1), 40.0⟩, ⟨1250, 51.5201, (-38.1), 40.0⟩, ⟨1300, 51.5395, (-38.1), 20.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS54 fixesS54 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line"), (1200, 1260, ""), (1260, 1300, "Ayton → Ceeford · Alpha Line")]
-- Reads compare as a set: the order across runs differs from the reference's.
#guard ((traceOf segsS54 fixesS54).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-38.1), .stations 51.54 (-38.1), .stations 51.5 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)] : Array Read).map reprStr).qsort (· < ·))

-- An alight site of only platforms: every candidate is tier 2, so the sweep's
-- list is just its `#[chosen]` seed.
private def segsS52 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS52 : Array Fix := #[⟨1000, 51.5, (-38.1), 2.0⟩, ⟨1120, 51.505, (-38.1), 45.0⟩, ⟨1240, 51.51, (-38.1), 50.0⟩, ⟨1360, 51.52, (-38.13), 2.0⟩, ⟨1420, 51.52, (-38.13), 2.0⟩]
#guard labelsOf segsS52 fixesS52 == #[(1100, 1300, "Ayton → Gee Platform 1")]
#guard traceOf segsS52 fixesS52 == #[.stations 51.5 (-38.1), .stations 51.52 (-38.13), .lines 51.5 (-38.1), .lines 51.52 (-38.13), .lines 51.5 (-38.1), .lines 51.52 (-38.13)]

-- The stay fallback: the walking-pace gate declined to trust the stay, and
-- slowBefore then resolves to nothing, so without the fallback the run loses
-- its label entirely. A rider noisy at the platform.
private def segsS53 : Array Seg := #[
  { startTs := 400, endTs := 600, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 600, endTs := 1090, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS53 : Array Fix := #[⟨450, 51.5, (-38.1), 1.0⟩, ⟨590, 51.5, (-38.1), 1.0⟩, ⟨1095, 51.515, (-38.1), 2.0⟩, ⟨1180, 51.53, (-38.1), 50.0⟩, ⟨1360, 51.54, (-38.1), 2.0⟩]
#guard labelsOf segsS53 fixesS53 == #[(400, 600, ""), (600, 1090, ""), (1100, 1300, "Ayton → Ceeford · Alpha Line")]
#guard traceOf segsS53 fixesS53 == #[.stations 51.5 (-38.1), .stations 51.515 (-38.1), .stations 51.54 (-38.1), .lines 51.5 (-38.1), .lines 51.54 (-38.1)]

end Verified.Geo.RailRunAnnotate
