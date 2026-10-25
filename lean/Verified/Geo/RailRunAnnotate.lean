import Verified.Geo.SegmentMerge
import Verified.Geo.RailRuns
import Verified.Geo.TubeHop
import Verified.Geo.LineStoppingPattern
/-!
# Labelling an unnamed train (from `annotateRailRuns` in `src/geo/passes/rail-runs.ts`)

`labelUnnamedTrains` gives each train segment that carries no route its
`board → alight · line` label, as a run of its own: the decoder has already
drawn the changes of trains, so no run grows and no segment merges.
`resolveRailRunLabel` does the work through two injected lookups, stations and
lines at a coordinate, recorded in a read trace (`TraceM`). Neither lookup is
memoised:

* the boarding lookup is SKIPPED when a preceding stationary segment already
  answered;
* the mid-ride vote reads EVERY fix between board and alight;
* the line-intersection retry reads the BOARDING station's node first and then
  each alight candidate's, stopping at the first that shares a line.

The leaves (`findRunBoardingFix`, `findRunAlightFix`, `expandTubeLineNames`)
are `Verified.Geo.RailRuns`'.

Exactness: every decision is exact except the float distance comparisons.
UNPROVEN.
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

/-- The two injected lookups. In production both are DB queries; here they are
functions of a coordinate, which is exactly what the TS docstring claims of
them. -/
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

/-- Search radius (m) for the endpoint station lookup. Larger than the adapter's
200 m default: an overground station's first post-train fix is often 200-300 m
away, because the phone reports the next position after the rider has already
walked off the platform. Read by the SHELL, which builds the lookup — the pass
itself never sees it, so it is here for the record. -/
def RAIL_RUN_STATION_RADIUS_M : Float := 400

/-- Above this a fix-to-fix hop is mid-tunnel GPS noise rather than a walk
between stations, and the preceding stay is trusted over the fix's own lookup. -/
def BOARDING_NOISE_SPEED_KMH : Float := 15

/-! ## Segment-window helpers -/

def hasRefinedKind (s : Seg) (kind : String) : Bool := s.refinedKinds.contains kind

/-- The fixes in a segment's window, with an EXCLUSIVE upper bound.

The strictness is load-bearing. `seg.endTs` equals the NEXT segment's `startTs`
— the classifier lays segments back to back — so the fix on the boundary is the
first fix of what follows, not the last of this. Including it made the boarding
lookup resolve to wherever the train was passing instead of the platform the
rider stood on (#131). -/
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

/-- Append preserving FIRST-seen order and dropping repeats — a JS `Set` built by
insertion, which is what every line collection here is. -/
private def pushUnique (xs : Array String) (x : String) : Array String :=
  if xs.contains x then xs else xs.push x

/-- Canonicalise a raw `linesAtPoint` result into a directionless line set.

OSM tags each travel direction as its own relation ("Jubilee Line Eastbound" at
one station, "Jubilee Line" at the next), so a raw string intersection comes up
empty for the same physical line. -/
def canonicalLines (lines : Array String) : Array String :=
  lines.foldl (fun acc l => (expandTubeLineNames l).foldl pushUnique acc) #[]

/-- Intersect, keeping the FIRST collection's order — `[...a].filter(l => b.has(l))`. -/
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

/-- The alight stations a site offers, best first: the pick `pickBestStation`
made, then the other STATION-NODE candidates in its own tier/distance order.

Platforms and entrances are dropped — not because they name the place wrongly,
which is why `pickBestStation` keeps them as tiers, but because the sweep asks a
COORDINATE question, and a gate or a platform end sits tens of metres off the
node whose corridor membership is being tested. A terminus has a dozen platform
nodes strung along its trainshed (#373); admitting them would make the sweep
answer about whichever one happened to be captured.

The chosen pick leads REGARDLESS of tier, so the sweep's first iteration is
exactly what the code did before the sweep existed. -/
def alightCandidates (stations : Array NearbyStation) (chosen : NearbyStation) :
    Array NearbyStation :=
  (rankStations stations).foldl (init := #[chosen]) fun out s =>
    if stationTier s ≥ 2 then out
    else if out.any (·.name == s.name) then out
    else out.push s

/-! ## `lineUnderTheTrack` -/

/-- Which of several candidate lines does the ride's own track run along?

Two lines serving both endpoints are indistinguishable FROM the endpoints — that
is a fact about the stations, not about the journey. The fixes BETWEEN them are
not ambiguous at all: tube lines diverge between interchanges, often by a
kilometre, so one surfaced mid-ride fix is usually enough.

Votes rather than distances, reusing the `linesAtPoint` lookup already in hand.
Decides ONLY on a clean winner — one candidate backed by the track and the rest
by none. Anything less returns `none` and the caller emits a bare station pair,
because a missing line label is honest and a guessed one is not.

Every mid fix is read even once the outcome is settled. That is not waste to be
optimised away here: it is what the TS does, and the trace guards pin it. -/
def lineUnderTheTrack (env : Env) (candidates : Array String) (points : Array Fix)
    (boardTs alightTs : Int) : TraceM (Option String) := do
  -- Strictly BETWEEN the boarding and alighting fixes, not between the run's
  -- segment bounds. Those endpoint fixes sit at interchanges and carry every
  -- candidate, so including either would make the vote a tie by construction —
  -- and the run's own end can fall exactly ON the one surfaced mid-ride fix,
  -- which an exclusive segment window would then discard as the sole evidence.
  let mid := points.filter fun p => p.ts > boardTs && p.ts < alightTs
  if mid.isEmpty then return none
  let mut votes : Array (String × Nat) := candidates.map (·, 0)
  for p in mid do
    let here := canonicalLines (← fetchLines env p.lat p.lon)
    let supported := candidates.filter here.contains
    -- Only DISCRIMINATING fixes vote. One naming every candidate says nothing
    -- about which was ridden — that is shared track through an interchange, and
    -- near the alighting station most fixes are of that kind. One naming none is
    -- off-corridor, or outside the mirror's coverage.
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

/-- Walk back from the run looking for the stay the rider boarded from.

Through stationary and walking segments ONLY; anything else — a previous train,
a drive — stops the walk, so the last journey's destination is never claimed as
this one's boarding station. The first stationary hit is the candidate, whether
or not it resolves. -/
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

/-- The line suffix for a resolved station pair, or the bare pair.

Three sources of evidence in order, each consulted only when the previous could
not decide: the endpoints' own line sets, then the ride's track, then its
stopping pattern. -/
private def suffixFor (env : Env) (base : String) (candidates : Array String)
    (points : Array Fix) (boardTs alightTs : Int)
    (board alight : String) (railStops : Array RailStopRelation) : TraceM String := do
  match ← lineUnderTheTrack env candidates points boardTs alightTs with
  | some ridden => return s!"{base} · {ridden}"
  | none =>
    -- The track could not separate them, which means they SHARE it — Wembley
    -- Park to Finchley Road is seven kilometres of Metropolitan and Jubilee on
    -- the same rails. Where they differ is where they STOP, and the ride's own
    -- speed profile says which pattern it ran.
    let ride := points.map fun p =>
      ({ ts := p.ts, lat := p.lat, lon := p.lon, speedKmh := p.speedKmh, bearing := 0 } :
        Verified.Geo.LineStoppingPattern.FilteredPoint)
    match pickLineByStoppingPattern candidates board alight railStops ride boardTs alightTs with
    | some stopped => return s!"{base} · {stopped}"
    | none => return base

/-- Walk the alight candidates for a pair some line can actually realise.

A pair must be REALISABLE. `pickBestStation` chose on distance, and at a shared
site that choice is itself in doubt: King's Cross carries a National Rail
terminus node ("London King's Cross") and a tube node ("King's Cross St Pancras")
~200 m apart, both station-tier, and on 2026-05-15 the street reacquire after a
Victoria-line ride landed nearer the terminus. That named the ride after a
station the Victoria line does not reach, and erased the line too, since the
terminus node sits on the mainline corridor. The erasure is what made it
self-concealing: with no line on the leg, `checkRailTriples` had nothing to
assert against, so the invariant that would have caught the impossible pair was
disabled by the very defect it should catch (#380).

So: take the first candidate sharing ANY line with the boarding station — the
#377 veto shape, membership deciding the label instead of proximity. A nearer
candidate is only ever overridden by a farther one that is REACHABLE where the
nearer is not; when none is, nothing is renamed and the bare pair stands.

Sharing SOME line, not exactly one, because the station question and the line
question are separate and only the first is what proximity got wrong. The
corrected pair is emitted either way, and its suffix goes through the same
evidence the primary path uses. -/
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

/-- The station-pair (and optional line) label for one rail run, or `none`.

The station lookup and the line lookup have independent failure modes: a line
failure degrades to a bare station pair rather than losing the annotation, while
a station failure returns nothing at all. -/
def resolveRailRunLabel (env : Env) (run : RailRun) (segments : Array Seg)
    (points : Array Fix) (railStops : Array RailStopRelation) : TraceM (Option String) := do
  let some first := segments[run.from_]? | return none
  let some last := segments[run.toExclusive - 1]? | return none
  let slowBefore := findRunBoardingFix points first.startTs (hasRefinedKind first "turnaround-board")
  let after := findRunAlightFix points last.endTs (hasRefinedKind last "turnaround-alight")
  match slowBefore, after with
  | some slowBefore, some after => do
    let stay ← findStayCandidate env segments points run.from_
    -- The stay is used IFF the apparent velocity from it to `slowBefore` is
    -- mid-tunnel-noise territory. At realistic walking pace the rider genuinely
    -- moved to a different station between the stay and the boarding, and
    -- `slowBefore`'s own lookup is the truthful one.
    let b0 : Boarding := match stay with
      | some st =>
        let dM := haversineMeters st.lat st.lon slowBefore.lat slowBefore.lon
        let dt := max 1 (slowBefore.ts - st.endTs)
        -- `Float.ofInt`, NOT `Int.toNat.toFloat`: the latter clamps a negative to
        -- zero, which turns the division into `inf` and reads as "impossibly
        -- fast" where the TS gets a negative and reads as "slower than walking".
        -- `max 1` means the difference cannot arise here, and a conversion that
        -- is only correct because of a guard elsewhere is one bad edit from
        -- being wrong.
        let apparentKmh := (dM / Float.ofInt dt) * 3.6
        if apparentKmh > BOARDING_NOISE_SPEED_KMH then
          ⟨some st.name, st.lat, st.lon, stationCoord (some st.station), some st.station.subtype⟩
        else ⟨none, slowBefore.lat, slowBefore.lon, none, none⟩
      | none => ⟨none, slowBefore.lat, slowBefore.lon, none, none⟩
    -- Both reads are issued in source order: the boarding one is SKIPPED
    -- outright when the stay already answered.
    let startStationsSlow ← if b0.station.isSome then pure #[]
      else fetchStations env slowBefore.lat slowBefore.lon
    let endStations ← fetchStations env after.lat after.lon
    let b1 : Boarding := if b0.station.isSome then b0 else
      let bestSlow := pickBestStation startStationsSlow
      ⟨bestSlow.map (·.name), b0.lookupLat, b0.lookupLon, stationCoord bestSlow,
        bestSlow.map (·.subtype)⟩
    -- Back-compat: `slowBefore` resolved to nothing but a preceding stay did.
    -- Covers the original "rider noisy at the platform" case from before the
    -- velocity gate existed.
    let b : Boarding := match b1.station, stay with
      | none, some st =>
        ⟨some st.name, st.lat, st.lon, stationCoord (some st.station), some st.station.subtype⟩
      | _, _ => b1
    -- A ride boarded at a tube node alights at one: at a shared site the
    -- mainline node can be nearer (2026-08-13, "London King's Cross" 19 m
    -- against the King's Cross St Pancras tube node) and on distance alone it
    -- names a Victoria line ride after a terminus that line does not reach.
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
          -- The endpoints yielded NOTHING. A lookup point can be an off-corridor
          -- fix — a street reacquire after alighting, a stay centroid a block
          -- from the platform — where `linesAtPoint` finds nothing; the
          -- intersection empties and the label loses its line, which is also the
          -- rail_route_cache key, so the ride draws as raw GPS. The stations
          -- themselves resolved and their own nodes sit on the corridor: retry
          -- there.
          --
          -- ONLY when empty. An AMBIGUOUS primary must not be collapsed by this
          -- retry: the station nodes are a different and here less trustworthy
          -- lookup, and with the alight still resolved to the National Rail
          -- terminus the retry returned a confident singleton of the WRONG line
          -- while the honest answer was "two candidates, and the track knows
          -- which" (#374).
          --
          -- The BOARDING side keeps the single-node retry. Its station is chosen
          -- from the preceding stationary under a walking-pace gate — anchored
          -- on where the rider actually stood — whereas the alight is a bare
          -- lookup at the reacquire fix, which is precisely the fix that
          -- surfaces at street level away from the platform. The asymmetry is in
          -- the evidence, not in the rule.
          let startRetry ← match b.coord with
            | some (la, lo) => canonicalLines <$> fetchLines env la lo
            | none => pure startCanon
          return some (← sweepAlight env startRetry endCanon startStation points
            slowBefore.ts after.ts railStops base endCandidates.toList)
    | _, _ => return none
  | _, _ => return none

/-! ## Entry points -/

/-- Label each train segment that carries no route (`board → alight`) as a run
    of its own, and touch nothing else: no run grows, no segment merges. -/
def labelUnnamedTrains (env : Env) (segments : Array Seg) (points : Array Fix)
    (railStops : Array RailStopRelation := #[]) : Array Seg :=
  let act : TraceM (Array Seg) := do
    let mut out := segments
    for h : i in [0:segments.size] do
      let s := segments[i]
      if s.mode == "train" && !(s.wayName.getD "").contains '→' then
        if let some lbl ← resolveRailRunLabel env ⟨i, i + 1, #[]⟩ segments points railStops then
          out := out.set! i { s with wayName := some lbl }
    return out
  (act.run #[]).1

end Verified.Geo.RailRunAnnotate
