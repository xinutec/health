import Verified.Geo.SegmentMerge
import Verified.Geo.RailRuns
import Verified.Geo.TubeHop
import Verified.Geo.LineStoppingPattern
/-!
# The rail-run annotator (port of `annotateRailRuns` in `src/geo/passes/rail-runs.ts`)

Three steps over the day's segments: find maximal runs of rail-like segments,
resolve each run's `board → alight · line` label from OSM, and collapse each run
into a single train segment. Only the middle step touches OSM, through two
injected lookups, so the whole pass is modelled here with those as ordinary
functions of a coordinate and every other decision runs for real.

## The read trace is part of the output

NEITHER lookup is memoised. `resolveRailRunLabel` asks for stations up to three
times per run and `lineUnderTheTrack` asks for lines once per mid-ride fix, and
asking again at the same coordinate really does query again. So the ORDERED list
of reads pins facts the returned label cannot:

* the boarding lookup is SKIPPED entirely when a preceding stationary segment
  already answered — `startStation ? Promise.resolve([]) : stationsLookup(…)`,
  which is why the trace for a trusted-stay run is one station read shorter;
* the mid-ride vote reads EVERY fix between board and alight, even after the
  outcome can no longer change. A ride whose first mid fix already decides it
  still queries the remaining fifteen;
* the line-intersection retry reads the BOARDING station's node first and then
  each alight candidate's, stopping at the first candidate that shares a line.

Within one run, `Promise.all([a, b])` reorders nothing: both lookups are invoked
synchronously as the array is built, in source order.

ACROSS runs it does. `annotateRailRuns` resolves every run's label through one
`Promise.all(runs.map(resolveRailRunLabel))`, so the runs advance in LOCK-STEP
by await depth rather than one after another: every run's station pair is read,
then every run's line pair, then whichever runs still have work. Measured on a
two-run day (S13):

    V8         stations ×2 (run 1), stations ×2 (run 2), lines ×2, lines ×2
    this model stations ×2, lines ×2 (run 1), then the same for run 2

Both issue the same reads, in the same order WITHIN each run, and produce the
same output — the lookups are pure, so the interleaving cannot change an answer.
Modelling it would mean making `resolveRailRunLabel` a resumable coroutine to
reproduce a scheduling artefact, and the runs have await chains of different
lengths (the mid-ride vote is one await per fix), so the lock-step is not a
fixed two-phase shape either.

So the model is sequential per run and the boundary is stated rather than
papered over: the 29 single-run scenarios guard the trace EXACTLY, and the three
multi-run ones (S13, S15, S27) guard it as a sorted multiset — still checked
against V8, and honest about which part of the order it checks. Each of those
carries V8's exact interleaved order in a comment beside it.

## The exception arms are not modelled

The TS wraps both lookup phases in `try/catch`, rethrowing `isUncapturedLookup`
(a stale fixture, which must fail the day) and otherwise degrading to `null` or
to the bare pair. Injected total functions cannot throw, so those arms are
unreachable here. That is a boundary of the model, not a simplification of the
algorithm: the distinction they draw is between a lookup that legitimately found
nothing and a RECORDING that is out of date, and only the shell can tell.

## `Verified.Geo.RailRuns` holds the leaves

`findBoardingPlatformFix`, `findRunAlightFix` and `expandTubeLineNames` were
ported earlier and are used here unchanged. `findRunAlightFix` gained its
`endsAtTurnaround` arm as part of this port — the leaf had been pinned without
it.

Exactness: every decision is exact except the four float comparisons named in
"Deliberately unpinned" at the foot of the file. UNPROVEN; pinned against
Node/V8 (`lean/experiments/rail-runs-annotate-refs.mts`).
-/

namespace Verified.Geo.RailRunAnnotate

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Geo.RailRuns (Fix expandTubeLineNames findRunBoardingFix findRunAlightFix)
open Verified.Geo.TubeHop (NearbyStation pickBestStation rankStations stationTier)
open Verified.Geo.LineStoppingPattern (RailStopRelation pickLineByStoppingPattern)

/-! ## Shapes -/

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
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

/-- A pause longer than this is a real stop, not a platform dwell. -/
def TRAIN_PAUSE_MAX_SEC : Int := 5 * 60
/-- …or one faster than this on average. -/
def TRAIN_PAUSE_MAX_AVG_KMH : Float := 10
/-- The GPS-tightness fallback: the pause's fixes must cluster this close to
their own centroid… -/
def TRAIN_DWELL_RADIUS_M : Float := 100
/-- …at this percentile, so a couple of multipath spikes do not veto it. -/
def TRAIN_DWELL_PERCENTILE : Float := 0.8

/-- The interior-collapse label. -/
def MERGED_REASON : String := "merged rail run (collapsed brief pauses)"
/-- The single-segment upgrade label. -/
def UPGRADE_REASON : String := "station-pair upgrade"

/-! ## Segment-window helpers

Local rather than shared: this pass's `Seg` is its own projection of
`EnrichedSegment`, and `Verified.Geo.SegmentMerge` carries a different one. -/

def hasRefinedKind (s : Seg) (kind : String) : Bool := s.refinedKinds.contains kind

/-- Fixes inside a segment's window, INCLUSIVE both ends. -/
def samplesInWindow (points : Array Fix) (s : Seg) : Array Fix :=
  points.filter fun p => p.ts ≥ s.startTs && p.ts ≤ s.endTs

/-- …and with an EXCLUSIVE upper bound.

The strictness is load-bearing. `seg.endTs` equals the NEXT segment's `startTs`
— the classifier lays segments back to back — so the fix on the boundary is the
first fix of what follows, not the last of this. Including it made the boarding
lookup resolve to wherever the train was passing instead of the platform the
rider stood on (#131). -/
def samplesInWindowExclusiveEnd (points : Array Fix) (s : Seg) : Array Fix :=
  points.filter fun p => p.ts ≥ s.startTs && p.ts < s.endTs

/-! ## `findRailRuns` -/

/-- A maximal rail run: segments `[from, toExclusive)`, plus the indices of any
short stationary "platform" segments swallowed into its interior. -/
structure RailRun where
  from_ : Nat
  toExclusive : Nat
  absorbedStationary : Array Nat
  deriving Inhabited, BEq, Repr

/-- Anything the pass will treat as part of a ride.

Two sufficient signatures: the classifier said train (either channel), or the
segment is an inferred vehicle-speed GAP — a stretch with no fixes that the gap
filler reconstructed, non-stationary and moving at 7 km/h or more. A multi-
station tube ride that surfaced for one fix mid-route arrives here as
train + inferred-gap + train, three segments and one journey. -/
def isRailLike (s : Seg) : Bool :=
  if s.mode == "train" || s.refinedMode == some "train" then true
  else hasRefinedKind s "gps-gap-inferred" && s.mode != "stationary" && s.avgSpeed ≥ 7

/-- Whether a short non-rail segment between two rail ones is a train pause.

Three DISJUNCTIVE signals under one duration ceiling, and either of the last two
alone is enough. The classifier's `avgSpeed` is sometimes wrong (GPS jitter at a
platform inflates instant speeds) and the GPS tightness is sometimes wrong
(sparse fixes with multipath spikes inflate the apparent spread — the 2026-04-29
case had 7 fixes covering 2.8 km of apparent path at avgSpeed 4.7). Trusting
whichever looks sane catches both failure modes. -/
def couldBeTrainPause (points : Array Fix) (s : Seg) : Bool :=
  if s.endTs - s.startTs > TRAIN_PAUSE_MAX_SEC then false
  else if s.mode == "stationary" then true
  else if s.avgSpeed ≤ TRAIN_PAUSE_MAX_AVG_KMH then true
  else
    let segPoints := samplesInWindow points s
    if segPoints.size < 2 then false
    else
      let n := segPoints.size.toFloat
      let cLat := (segPoints.foldl (fun a p => a + p.lat) 0.0) / n
      let cLon := (segPoints.foldl (fun a p => a + p.lon) 0.0) / n
      let dists := (segPoints.map fun p => haversineMeters p.lat p.lon cLat cLon).toList.mergeSort (· ≤ ·)
      let idx := min (segPoints.size - 1) (Float.floor (n * TRAIN_DWELL_PERCENTILE)).toUInt64.toNat
      match dists[idx]? with
      | some d => d ≤ TRAIN_DWELL_RADIUS_M
      | none => false

/-- Grow one run from `i`, returning its end and the stationaries it swallowed.

`remaining` is the number of segments still to the right — a genuine measure,
decreasing at every recursive call, not a fuel budget. -/
private def growRun (points : Array Fix) (segments : Array Seg) :
    Nat → Nat → Array Nat → Nat × Array Nat
  | 0, j, absorbed => (j, absorbed)
  | remaining + 1, j, absorbed =>
    if j ≥ segments.size then (j, absorbed)
    else
      let sj := segments[j]!
      -- A run may not grow across a turnaround: what follows is the ride BACK,
      -- not more of this ride. Read the split pass's tag rather than re-deriving
      -- it — the cut lands on the platform, and from there the approach and the
      -- departure both point home, so the reversal is no longer in the fixes.
      if hasRefinedKind sj "turnaround-board" then (j, absorbed)
      else if isRailLike sj then growRun points segments remaining (j + 1) absorbed
      -- Absorb a short stationary IFF a rail-like segment FOLLOWS it. Without
      -- that condition the trailing stationary at the end of a journey — the
      -- arrival home — would be swallowed too.
      else if couldBeTrainPause points sj && j + 1 < segments.size
          && isRailLike segments[j + 1]! then
        growRun points segments remaining (j + 2) (absorbed.push j)
      else (j, absorbed)

/-- Scan for maximal runs. `remaining` bounds the outer walk the same way. -/
private def scanRuns (points : Array Fix) (segments : Array Seg) :
    Nat → Nat → Array RailRun → Array RailRun
  | 0, _, acc => acc
  | remaining + 1, i, acc =>
    if i ≥ segments.size then acc
    else if !isRailLike segments[i]! then scanRuns points segments remaining (i + 1) acc
    else
      let (j, absorbed) := growRun points segments segments.size (i + 1) #[]
      scanRuns points segments remaining j (acc.push ⟨i, j, absorbed⟩)

def findRailRuns (segments : Array Seg) (points : Array Fix) : Array RailRun :=
  scanRuns points segments segments.size 0 #[]

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
    else if ranked.size > 1 && (ranked[1]!).2 > 0 then return none -- the track backs more than one
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
  | i + 1 =>
    let s := segments[i]!
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
        if retry.size == 1 then return s!"{pair} · {retry[0]!}"
        else suffixFor env pair retry points boardTs alightTs startStation c.name railStops

/-- The station-pair (and optional line) label for one rail run, or `none`.

The station lookup and the line lookup have independent failure modes: a line
failure degrades to a bare station pair rather than losing the annotation, while
a station failure returns nothing at all. -/
def resolveRailRunLabel (env : Env) (run : RailRun) (segments : Array Seg)
    (points : Array Fix) (railStops : Array RailStopRelation) : TraceM (Option String) := do
  let first := segments[run.from_]!
  let last := segments[run.toExclusive - 1]!
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
          ⟨some st.name, st.lat, st.lon, stationCoord (some st.station)⟩
        else ⟨none, slowBefore.lat, slowBefore.lon, none⟩
      | none => ⟨none, slowBefore.lat, slowBefore.lon, none⟩
    -- Both reads are issued in source order: the boarding one is SKIPPED
    -- outright when the stay already answered.
    let startStationsSlow ← if b0.station.isSome then pure #[]
      else fetchStations env slowBefore.lat slowBefore.lon
    let endStations ← fetchStations env after.lat after.lon
    let b1 : Boarding := if b0.station.isSome then b0 else
      let bestSlow := pickBestStation startStationsSlow
      ⟨bestSlow.map (·.name), b0.lookupLat, b0.lookupLon, stationCoord bestSlow⟩
    -- Back-compat: `slowBefore` resolved to nothing but a preceding stay did.
    -- Covers the original "rider noisy at the platform" case from before the
    -- velocity gate existed.
    let b : Boarding := match b1.station, stay with
      | none, some st => ⟨some st.name, st.lat, st.lon, stationCoord (some st.station)⟩
      | _, _ => b1
    let bestEnd := pickBestStation endStations
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
        if inter.size == 1 then return some s!"{base} · {inter[0]!}"
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

/-! ## `applyRailRuns` -/

/-- Round to `digits` decimals the way `Math.round(x * 10^d) / 10^d` does.

JS `Math.round` breaks ties toward +∞ and Lean's `Float.round` breaks them away
from zero. Every field rounded here — confidence, margin, speed, linearity — is
non-negative, where the two agree. -/
private def roundTo (x : Float) (digits : Nat) : Float :=
  let p := (10.0 : Float) ^ digits.toFloat
  (x * p).round / p

/-- Union the run's refinement tags, first-seen order.

Rebuilding the merged segment from scratch silently dropped these, so a
downstream pass asking "was this touched by rule X?" got `no` for a run that
plainly was — which is how a turnaround-split half got welded back to its own
return. -/
private def unionKinds (segs : Array Seg) : Array String :=
  segs.foldl (fun acc s => s.refinedKinds.foldl pushUnique acc) #[]

/-- Collapse a multi-segment run into one train segment.

Averages are weighted by `pointCount`, with a zero count counting as ONE so a
fix-less segment still carries a vote. The emitted `pointCount` is the raw sum
though, NOT the same `|| 1` correction — a subtlety worth stating because the
two expressions sit two lines apart in the TS. -/
private def collapse (segments : Array Seg) (run : RailRun) (label : Option String) : Seg :=
  let first := segments[run.from_]!
  let last := segments[run.toExclusive - 1]!
  let railSegs := ((List.range (run.toExclusive - run.from_)).map (· + run.from_)).foldl
    (init := #[]) fun acc k =>
      let s := segments[k]!
      if s.mode != "stationary" then acc.push s else acc
  let weightOf (s : Seg) : Float := if s.pointCount == 0 then 1.0 else Float.ofInt s.pointCount
  let totalWeight :=
    let t := railSegs.foldl (fun a s => a + weightOf s) 0.0
    if t == 0.0 then 1.0 else t
  let weighted (f : Seg → Float) (digits : Nat) : Float :=
    roundTo ((railSegs.foldl (fun a s => a + f s * weightOf s) 0.0) / totalWeight) digits
  { startTs := first.startTs
    endTs := last.endTs
    mode := "train"
    refinedMode := some "train"
    refinedReason := some MERGED_REASON
    refinedKinds := unionKinds railSegs
    wayName := label
    confidence := weighted (·.confidence) 2
    confidenceMargin := weighted (·.confidenceMargin) 2
    avgSpeed := weighted (·.avgSpeed) 1
    maxSpeed := railSegs.foldl (fun a s => max a s.maxSpeed) (railSegs[0]!).maxSpeed
    linearity := weighted (·.linearity) 2
    pointCount := railSegs.foldl (fun a s => a + s.pointCount) 0 }

/-- A single-segment run keeps its shape and takes the label.

The mode is upgraded to train with it. A station-pair label is only ever
produced when BOTH endpoints resolved to real stations, which is strong rail
evidence; the classifier may have called this "driving" because the surface
fixes look road-shaped, but the station pair outranks that. Without the upgrade
the segment would be internally contradictory — mode=driving carrying a
station-pair wayName. -/
private def upgradeSingle (s : Seg) (label : Option String) : Seg :=
  match label with
  | none => s
  | some lbl =>
    if s.mode == "train" then { s with wayName := some lbl }
    else
      { s with
        wayName := some lbl
        mode := "train"
        refinedMode := some "train"
        refinedReason := some (UPGRADE_REASON ++
          (match s.refinedReason with
           | some r => if r == "" then "" else s!" (was: {r})"
           | none => "")) }

private def applyFrom (segments : Array Seg) (runs : Array RailRun) (labels : Array (Option String)) :
    Nat → Nat → Array Seg → Array Seg
  | 0, _, acc => acc
  | remaining + 1, i, acc =>
    if i ≥ segments.size then acc
    else
      match (List.range runs.size).find? (fun r => (runs[r]!).from_ == i) with
      | none => applyFrom segments runs labels remaining (i + 1) (acc.push segments[i]!)
      | some r =>
        let run := runs[r]!
        let label := labels[r]!
        let out :=
          if run.toExclusive - run.from_ == 1 && run.absorbedStationary.isEmpty then
            upgradeSingle segments[run.from_]! label
          else collapse segments run label
        applyFrom segments runs labels remaining run.toExclusive (acc.push out)

def applyRailRuns (segments : Array Seg) (runs : Array RailRun)
    (labels : Array (Option String)) : Array Seg :=
  applyFrom segments runs labels segments.size 0 #[]

/-! ## Entry points -/

def annotateRailRunsTraced (env : Env) (segments : Array Seg) (points : Array Fix)
    (railStops : Array RailStopRelation := #[]) : Array Seg × Array Read :=
  let act : TraceM (Array Seg) := do
    let runs := findRailRuns segments points
    let mut labels : Array (Option String) := #[]
    for run in runs do
      labels := labels.push (← resolveRailRunLabel env run segments points railStops)
    return applyRailRuns segments runs labels
  act.run #[]

def annotateRailRuns (env : Env) (segments : Array Seg) (points : Array Fix)
    (railStops : Array RailStopRelation := #[]) : Array Seg :=
  (annotateRailRunsTraced env segments points railStops).1

/-! ## Guards (V8 reference values)

Generated by `lean/experiments/rail-runs-annotate-refs.mts`.

The two lookups replay as TABLES of what V8's stub actually answered rather than
as a second copy of its geography. What the guards then check is the PASS: a
query this arm makes that the reference arm never did misses the table and comes
back empty, which reads as a divergence instead of as a plausible answer from a
stub that drifted. -/

private def STATION_TABLE : Array (Float × Float × Array NearbyStation) := #[
    (51.5, (-0.1), #[⟨"Ayton", "subway", 0.0, some 51.5, some (-0.1)⟩, ⟨"Ayton Platform 1", "stop_position", 11.119492664825003, some 51.5001, some (-0.1)⟩]),
    (51.54, (-0.1), #[⟨"Ceeford", "subway", 0.0, some 51.54, some (-0.1)⟩, ⟨"Ceeford Main", "rail", 282.1688536506832, some 51.5405, some (-0.096)⟩]),
    (51.515, (-0.1), #[]),
    (51.5135, (-0.1), #[]),
    (51.56, (-0.1), #[⟨"Deeham", "subway", 0.0, some 51.56, some (-0.1)⟩]),
    (51.5404, (-0.0975), #[⟨"Ceeford", "subway", 178.52780583849142, some 51.54, some (-0.1)⟩, ⟨"Ceeford Main", "rail", 104.3327580939171, some 51.5405, some (-0.096)⟩]),
    (51.5395, (-0.1), #[⟨"Ceeford", "subway", 55.59746332254485, some 51.54, some (-0.1)⟩, ⟨"Ceeford Main", "rail", 298.1498558465431, some 51.5405, some (-0.096)⟩]),
    (51.52, (-0.1), #[⟨"Beeston", "subway", 0.0, some 51.52, some (-0.1)⟩]),
    (51.500349, (-0.1), #[⟨"Ayton", "subway", 38.80702939894352, some 51.5, some (-0.1)⟩, ⟨"Ayton Platform 1", "stop_position", 27.68753673411851, some 51.5001, some (-0.1)⟩]),
    (51.57, (-0.1), #[⟨"Effton", "subway", 0.0, some 51.57, some (-0.1)⟩]),
    (51.5, (-0.12), #[⟨"Zedton", "rail", 173.0511733818029, some 51.5, some (-0.1225)⟩, ⟨"Beeston", "rail", 207.6614080537232, some 51.5, some (-0.117)⟩, ⟨"Haldon", "rail", 242.27164272322293, some 51.5, some (-0.1165)⟩]),
    (51.52, (-0.13), #[⟨"Gee Platform 1", "stop_position", 0.0, some 51.52, some (-0.13)⟩, ⟨"Gee Platform 2", "stop_position", 22.238985328859922, some 51.5202, some (-0.13)⟩])]

private def LINE_TABLE : Array (Float × Float × Array String) := #[
    (51.5, (-0.1), #["Alpha Line", "Beta Line"]),
    (51.54, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.56, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.505, (-0.1), #["Alpha Line", "Beta Line"]),
    (51.53, (-0.1), #["Alpha Line"]),
    (51.555, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.541, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.543, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.545, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.547, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.55, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.552, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.554, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.556, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.558, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.559, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5595, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5598, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5599, (-0.1), #["Alpha Line", "Beta Line", "Gamma Line"]),
    (51.5404, (-0.0975), #["Delta Line"]),
    (51.5405, (-0.096), #["Delta Line"]),
    (51.5395, (-0.1), #["Alpha Line", "Gamma Line"]),
    (51.52, (-0.1), #["Alpha Line", "Beta Line"]),
    (51.500349, (-0.1), #["Alpha Line", "Beta Line"]),
    (51.57, (-0.1), #["Alpha Line Northbound"]),
    (51.53, (-0.2), #["Epsilon Line"]),
    (51.54, (-0.088), #["Beta Line"]),
    (51.5, (-0.12), #[]),
    (51.5, (-0.1225), #["Zeta Line"]),
    (51.5, (-0.1165), #["Alpha Line", "Beta Line"]),
    (51.515, (-0.1), #["Alpha Line", "Beta Line"]),
    (51.52, (-0.13), #[])]

private def lookIn {α : Type} (table : Array (Float × Float × Array α))
    (lat lon : Float) : Array α :=
  match table.find? (fun e => e.1 == lat && e.2.1 == lon) with
  | some e => e.2.2
  | none => #[]

private def ENV : Env :=
  { stationsLookup := lookIn STATION_TABLE, linesLookup := lookIn LINE_TABLE }

private def RAIL_STOPS : Array RailStopRelation := #[
    { stops := #[⟨some "Ayton", 51.5, (-0.1), 0⟩, ⟨some "Beeston", 51.52, (-0.1), 1⟩, ⟨some "Ceeford", 51.54, (-0.1), 2⟩, ⟨some "Ceedee", 51.55, (-0.1), 3⟩, ⟨some "Deeham", 51.56, (-0.1), 4⟩], lineRef := none, lineName := some "Alpha Line", osmRelationId := 1, routeType := "subway" },
    { stops := #[⟨some "Ceeford", 51.54, (-0.1), 0⟩, ⟨some "Deeham", 51.56, (-0.1), 1⟩], lineRef := none, lineName := some "Gamma Line", osmRelationId := 3, routeType := "subway" }]

/-- Everything `applyRailRuns` can write. A field outside this tuple is a field
no mutation to it can be seen through. -/
private def outOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) :
    Array (Int × Int × String × String × String × String × Array String
      × Float × Float × Float × Float × Float × Int) :=
  (annotateRailRuns ENV segs fixes stops).map fun s =>
    (s.startTs, s.endTs, s.wayName.getD "", s.mode, s.refinedMode.getD "",
     s.refinedReason.getD "", s.refinedKinds,
     s.confidence, s.confidenceMargin, s.avgSpeed, s.maxSpeed, s.linearity, s.pointCount)

/-- The ORDERED reads. Neither lookup is memoised, so this is observable
behaviour and not an implementation detail. -/
private def traceOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) : Array Read :=
  (annotateRailRunsTraced ENV segs fixes stops).2

-- One train segment, one run, unambiguous line. Trace: two station lookups
-- then two line lookups, board before alight in both pairs.
private def segsS1 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS1 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS1 fixesS1 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS1 fixesS1 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- Not rail-like at all — no run, no lookup, segment passes through
-- byte-identical.
private def segsS2 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS2 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS2 fixesS2 == #[(1100, 1300, "", "walking", "", "", #[], 0.8, 2.0, 4.0, 60.0, 0.9, 10)]
#guard traceOf segsS2 fixesS2 == #[]

-- refinedMode train alone makes a segment rail-like, even with mode driving.
private def segsS3 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := some "train", refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS3 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS3 fixesS3 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "station-pair upgrade", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS3 fixesS3 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The inferred-vehicle-gap arm: gps-gap-inferred, non-stationary, avgSpeed >=
-- 7.
private def segsS4 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 7.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS4 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS4 fixesS4 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "station-pair upgrade", #["gps-gap-inferred"], 0.8, 2.0, 7.0, 60.0, 0.9, 10)]
#guard traceOf segsS4 fixesS4 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and its speed floor is a floor: avgSpeed 6.9 is not rail-like.
private def segsS5 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 6.9, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS5 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS5 fixesS5 == #[(1100, 1300, "", "driving", "", "", #["gps-gap-inferred"], 0.8, 2.0, 6.9, 60.0, 0.9, 10)]
#guard traceOf segsS5 fixesS5 == #[]

-- …and stationary is excluded from it however fast the average claims to be.
private def segsS6 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS6 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS6 fixesS6 == #[(1100, 1300, "", "stationary", "", "", #["gps-gap-inferred"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS6 fixesS6 == #[]

-- Two adjacent train segments collapse into one, with weighted
-- confidence/avgSpeed and summed pointCount.
private def segsS7 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.6, confidenceMargin := 2.0, avgSpeed := 30.0, maxSpeed := 50.0, linearity := 0.8, pointCount := 10 },
  { startTs := 1200, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.9, confidenceMargin := 2.0, avgSpeed := 50.0, maxSpeed := 70.0, linearity := 0.95, pointCount := 30 }]
private def fixesS7 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS7 fixesS7 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.83, 2.0, 45.0, 70.0, 0.91, 40)]
#guard traceOf segsS7 fixesS7 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A short stationary between two trains is ABSORBED — one segment out, and
-- the pause vanishes.
private def segsS8 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS8 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS8 fixesS8 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 20)]
#guard traceOf segsS8 fixesS8 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …but only when a rail-like segment FOLLOWS it. A trailing stationary is
-- left alone — arriving home is not a platform pause.
private def segsS9 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1300, endTs := 1400, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 }]
private def fixesS9 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS9 fixesS9 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1300, 1400, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 4)]
#guard traceOf segsS9 fixesS9 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The pause duration ceiling: 5 min exactly still absorbs.
private def segsS10 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1500, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1500, endTs := 1600, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS10 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS10 fixesS10 == #[(1100, 1600, "", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 20)]
#guard traceOf segsS10 fixesS10 == #[]

-- …and one second past it does not, so the run splits in two.
private def segsS11 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1501, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1501, endTs := 1600, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS11 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS11 fixesS11 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1501, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1501, 1600, "", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS11 fixesS11 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A non-stationary middle segment absorbs on the avgSpeed arm (<= 10 km/h)
-- without being stationary.
private def segsS12 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 10.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS12 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS12 fixesS12 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 35.0, 60.0, 0.9, 24)]
#guard traceOf segsS12 fixesS12 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and above it falls to the GPS-cluster arm, which here also fails (the
-- fixes span the whole ride), so the run splits.
private def segsS13 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 10.1, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS13 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS13 fixesS13 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1260, "", "walking", "", "", #[], 0.8, 2.0, 10.1, 60.0, 0.9, 4), (1260, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54
-- (-0.1)]
#guard ((traceOf segsS13 fixesS13).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- The GPS-cluster arm SUCCEEDING: avgSpeed over the bar, but the segment's
-- own fixes sit within 100 m of their centroid.
private def segsS14 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS14 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1210, 51.52, (-0.1), 40.0⟩, ⟨1230, 51.5202, (-0.1), 40.0⟩, ⟨1250, 51.5201, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS14 fixesS14 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 24)]
#guard traceOf segsS14 fixesS14 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A turnaround-board tag BREAKS the run — what follows is the ride back, not
-- more of this ride.
private def segsS15 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-board"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS15 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS15 fixesS15 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1300, "", "train", "", "", #["turnaround-board"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.515 (-0.1), .stations 51.54 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1)]
#guard ((traceOf segsS15 fixesS15).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.515 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- Board and alight resolve to the SAME station: no label, and the line
-- lookups are never made.
private def segsS16 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS16 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.5005, (-0.1), 45.0⟩, ⟨1360, 51.5, (-0.1), 2.0⟩]
#guard outOf segsS16 fixesS16 == #[(1100, 1300, "", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS16 fixesS16 == #[.stations 51.5 (-0.1), .stations 51.5 (-0.1)]

-- A preceding STATIONARY segment supplies the boarding station, and its own
-- lookup replaces the slowBefore one — the apparent velocity from the stay to
-- slowBefore is tunnel-noise fast.
private def segsS17 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS17 : Array Fix := #[⟨950, 51.5, (-0.1), 1.0⟩, ⟨1080, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.5135, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS17 fixesS17 == #[(900, 1090, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS17 fixesS17 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and at realistic WALKING pace the stay is not trusted: the rider genuinely
-- moved to another station, so slowBefore's own lookup stands.
private def segsS18 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS18 : Array Fix := #[⟨950, 51.5, (-0.1), 1.0⟩, ⟨1080, 51.5, (-0.1), 1.0⟩, ⟨1480, 51.502, (-0.1), 2.0⟩, ⟨1500, 51.53, (-0.1), 50.0⟩, ⟨1560, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS18 fixesS18 == #[(900, 1090, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS18 fixesS18 == #[.stations 51.5 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The walk-back stops at a non-walking, non-stationary mode: a preceding
-- DRIVING segment is not walked through, so the previous journey's
-- destination is not claimed as this boarding.
private def segsS19 : Array Seg := #[
  { startTs := 800, endTs := 900, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 900, endTs := 1090, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 30.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS19 : Array Fix := #[⟨850, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.5135, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS19 fixesS19 == #[(800, 900, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (900, 1090, "", "driving", "", "", #[], 0.8, 2.0, 30.0, 60.0, 0.9, 10), (1100, 1300, "", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS19 fixesS19 == #[.stations 51.5135 (-0.1), .stations 51.54 (-0.1)]

-- Ambiguous endpoints resolved by the TRACK: both lines serve Ayton and
-- Deeham, and the mid-ride fix on the meridian names only Alpha.
private def segsS20 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS20 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1400, 51.555, (-0.1), 20.0⟩, ⟨1560, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS20 fixesS20 == #[(1100, 1500, "Ayton → Deeham · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS20 fixesS20 == #[.stations 51.5 (-0.1), .stations 51.56 (-0.1), .lines 51.5 (-0.1), .lines 51.56 (-0.1), .lines 51.505 (-0.1), .lines 51.53 (-0.1), .lines 51.555 (-0.1)]

-- Alpha and Gamma share the Ceeford→Deeham track completely, so every
-- mid-ride fix names BOTH and the vote is a tie by construction. With no stop
-- data the honest answer is the bare pair.
private def segsS21 : Array Seg := #[
  { startTs := 1020, endTs := 1290, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS21 : Array Fix := #[⟨1000, 51.54, (-0.1), 2.0⟩, ⟨1020, 51.541, (-0.1), 40.0⟩, ⟨1040, 51.543, (-0.1), 40.0⟩, ⟨1060, 51.545, (-0.1), 40.0⟩, ⟨1080, 51.547, (-0.1), 40.0⟩, ⟨1100, 51.55, (-0.1), 3.0⟩, ⟨1120, 51.55, (-0.1), 3.0⟩, ⟨1140, 51.552, (-0.1), 40.0⟩, ⟨1160, 51.554, (-0.1), 40.0⟩, ⟨1180, 51.556, (-0.1), 40.0⟩, ⟨1200, 51.558, (-0.1), 40.0⟩, ⟨1220, 51.559, (-0.1), 40.0⟩, ⟨1240, 51.5595, (-0.1), 40.0⟩, ⟨1260, 51.5598, (-0.1), 40.0⟩, ⟨1280, 51.5599, (-0.1), 40.0⟩, ⟨1300, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS21 fixesS21 == #[(1020, 1290, "Ceeford → Deeham", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS21 fixesS21 == #[.stations 51.54 (-0.1), .stations 51.56 (-0.1), .lines 51.54 (-0.1), .lines 51.56 (-0.1), .lines 51.541 (-0.1), .lines 51.543 (-0.1), .lines 51.545 (-0.1), .lines 51.547 (-0.1), .lines 51.55 (-0.1), .lines 51.55 (-0.1), .lines 51.552 (-0.1), .lines 51.554 (-0.1), .lines 51.556 (-0.1), .lines 51.558 (-0.1), .lines 51.559 (-0.1), .lines 51.5595 (-0.1), .lines 51.5598 (-0.1), .lines 51.5599 (-0.1)]

-- …and with the stop lists in hand the tie the track could not break is
-- broken by which line CALLS at Ceedee: one observed dwell inside the running
-- span, and only Alpha's pattern allows exactly one.
private def segsS22 : Array Seg := #[
  { startTs := 1020, endTs := 1290, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS22 : Array Fix := #[⟨1000, 51.54, (-0.1), 2.0⟩, ⟨1020, 51.541, (-0.1), 40.0⟩, ⟨1040, 51.543, (-0.1), 40.0⟩, ⟨1060, 51.545, (-0.1), 40.0⟩, ⟨1080, 51.547, (-0.1), 40.0⟩, ⟨1100, 51.55, (-0.1), 3.0⟩, ⟨1120, 51.55, (-0.1), 3.0⟩, ⟨1140, 51.552, (-0.1), 40.0⟩, ⟨1160, 51.554, (-0.1), 40.0⟩, ⟨1180, 51.556, (-0.1), 40.0⟩, ⟨1200, 51.558, (-0.1), 40.0⟩, ⟨1220, 51.559, (-0.1), 40.0⟩, ⟨1240, 51.5595, (-0.1), 40.0⟩, ⟨1260, 51.5598, (-0.1), 40.0⟩, ⟨1280, 51.5599, (-0.1), 40.0⟩, ⟨1300, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS22 fixesS22 RAIL_STOPS == #[(1020, 1290, "Ceeford → Deeham · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS22 fixesS22 RAIL_STOPS == #[.stations 51.54 (-0.1), .stations 51.56 (-0.1), .lines 51.54 (-0.1), .lines 51.56 (-0.1), .lines 51.541 (-0.1), .lines 51.543 (-0.1), .lines 51.545 (-0.1), .lines 51.547 (-0.1), .lines 51.55 (-0.1), .lines 51.55 (-0.1), .lines 51.552 (-0.1), .lines 51.554 (-0.1), .lines 51.556 (-0.1), .lines 51.558 (-0.1), .lines 51.559 (-0.1), .lines 51.5595 (-0.1), .lines 51.5598 (-0.1), .lines 51.5599 (-0.1)]

-- The #380 shape: the alight reacquire lands NEARER a mainline node on a
-- corridor Ayton never touches. The primary intersection empties and the
-- realisable-alight sweep walks past it to the node a line can reach.
private def segsS23 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS23 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.5404, (-0.0975), 2.0⟩, ⟨1420, 51.5404, (-0.0975), 2.0⟩]
#guard outOf segsS23 fixesS23 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS23 fixesS23 == #[.stations 51.5 (-0.1), .stations 51.5404 (-0.0975), .lines 51.5 (-0.1), .lines 51.5404 (-0.0975), .lines 51.5 (-0.1), .lines 51.5405 (-0.096), .lines 51.54 (-0.1)]

-- A run with NO fix at or before its start resolves nothing — no boarding
-- fix, no label, and the segment still collapses to train.
private def segsS24 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS24 : Array Fix := #[⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS24 fixesS24 == #[(1100, 1300, "", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS24 fixesS24 == #[]

-- A single-segment run whose mode is NOT train gets the station-pair upgrade,
-- and the previous refinedReason is carried into the new one.
private def segsS25 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := none, refinedReason := some "gap", refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS25 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS25 fixesS25 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "station-pair upgrade (was: gap)", #["gps-gap-inferred"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS25 fixesS25 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and with no previous reason the parenthetical is absent entirely.
private def segsS26 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "driving", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS26 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS26 fixesS26 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "station-pair upgrade", #["gps-gap-inferred"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS26 fixesS26 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- Two runs in one day, each labelled independently, with an ordinary walk
-- between them left untouched.
private def segsS27 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1300, endTs := 2000, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 2100, endTs := 2300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS27 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩, ⟨2000, 51.54, (-0.1), 2.0⟩, ⟨2120, 51.545, (-0.1), 45.0⟩, ⟨2240, 51.55, (-0.1), 50.0⟩, ⟨2360, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS27 fixesS27 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1300, 2000, "", "walking", "", "", #[], 0.8, 2.0, 4.0, 60.0, 0.9, 10), (2100, 2300, "Ceeford → Deeham", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.54 (-0.1), .stations 51.56 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.54 (-0.1), .lines 51.56
-- (-0.1), .lines 51.545 (-0.1), .lines 51.55 (-0.1)]
#guard ((traceOf segsS27 fixesS27).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.54 (-0.1), .stations 51.56 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.54 (-0.1), .lines 51.56 (-0.1), .lines 51.545 (-0.1), .lines 51.55 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- The collapse UNIONS refinedKinds across the run's RAIL segments — a
-- downstream pass asking whether rule X touched this run must not get 'no'.
-- The absorbed stationary's own tag is not among them: it is not a rail
-- segment.
private def segsS28 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #["gps-jitter"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["low-cadence", "gps-gap-inferred"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS28 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS28 fixesS28 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #["gps-gap-inferred", "low-cadence"], 0.8, 2.0, 40.0, 60.0, 0.9, 20)]
#guard traceOf segsS28 fixesS28 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A stationary INSIDE a collapsing run contributes nothing to the weighted
-- averages — the train's own numbers survive undiluted.
private def segsS29 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.1, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 1.0, linearity := 0.1, pointCount := 90 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS29 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS29 fixesS29 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 20)]
#guard traceOf segsS29 fixesS29 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A run tagged turnaround-alight takes the fix NEAREST its endTs rather than
-- scanning forward. Standing on the platform the rider has already come back
-- past the outermost point, so the forward scan would name a station from the
-- return journey.
private def segsS30 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-alight"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS30 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS30 fixesS30 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #["turnaround-alight"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS30 fixesS30 == #[.stations 51.5 (-0.1), .stations 51.5395 (-0.1), .lines 51.5 (-0.1), .lines 51.5395 (-0.1)]

-- …and the mirror on the boarding side: turnaround-board takes the fix
-- nearest startTs, so the platform walkback cannot stride back across the
-- turnaround into the outbound journey.
private def segsS31 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-board"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS31 : Array Fix := #[⟨300, 51.52, (-0.1), 1.0⟩, ⟨360, 51.52, (-0.1), 1.0⟩, ⟨420, 51.52, (-0.1), 40.0⟩, ⟨1080, 51.5, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS31 fixesS31 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #["turnaround-board"], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS31 fixesS31 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and WITHOUT the tag the same fixes do stride back: the
-- platform-train-platform walkback reaches the Beeston cluster and names the
-- ride after it.
private def segsS32 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS32 : Array Fix := #[⟨300, 51.52, (-0.1), 1.0⟩, ⟨360, 51.52, (-0.1), 1.0⟩, ⟨420, 51.52, (-0.1), 40.0⟩, ⟨1080, 51.5, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS32 fixesS32 == #[(1100, 1300, "Beeston → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS32 fixesS32 == #[.stations 51.52 (-0.1), .stations 51.54 (-0.1), .lines 51.52 (-0.1), .lines 51.54 (-0.1)]

-- The boarding-noise bar from JUST ABOVE: 44.4 m in 10 s is 16 km/h, so the
-- stay is still trusted and its own lookup replaces slowBefore's.
private def segsS33 : Array Seg := #[
  { startTs := 900, endTs := 1085, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS33 : Array Fix := #[⟨950, 51.5, (-0.1), 1.0⟩, ⟨1080, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.500399, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS33 fixesS33 == #[(900, 1085, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS33 fixesS33 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- …and from JUST BELOW: 38.9 m in the same 10 s is 14 km/h, plainly a walk,
-- so the stay is NOT trusted and slowBefore gets its own station lookup — one
-- extra read in the trace.
private def segsS34 : Array Seg := #[
  { startTs := 900, endTs := 1085, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS34 : Array Fix := #[⟨950, 51.5, (-0.1), 1.0⟩, ⟨1080, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.500349, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS34 fixesS34 == #[(900, 1085, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS34 fixesS34 == #[.stations 51.5 (-0.1), .stations 51.500349 (-0.1), .stations 51.54 (-0.1), .lines 51.500349 (-0.1), .lines 51.54 (-0.1)]

-- The GPS-tightness radius bracketed from ABOVE: the pause's fixes sit ~150 m
-- from their centroid, so 100 m rejects them and any looser bar would not.
private def segsS35 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS35 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1210, 51.51865, (-0.1), 40.0⟩, ⟨1230, 51.52135, (-0.1), 40.0⟩, ⟨1250, 51.51865, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS35 fixesS35 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1260, "", "walking", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 4), (1260, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54
-- (-0.1)]
#guard ((traceOf segsS35 fixesS35).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- The percentile INDEX, which only an outlier can expose: four fixes within
-- 20 m and one 400 m out. At 0.8 the index lands on the outlier and the pause
-- is rejected; at 0.0 it lands on the nearest and the pause absorbs.
private def segsS36 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 5 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS36 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1205, 51.52, (-0.1), 40.0⟩, ⟨1215, 51.5201, (-0.1), 40.0⟩, ⟨1225, 51.5202, (-0.1), 40.0⟩, ⟨1235, 51.5203, (-0.1), 40.0⟩, ⟨1245, 51.5238, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS36 fixesS36 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1260, "", "walking", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 5), (1260, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54
-- (-0.1)]
#guard ((traceOf segsS36 fixesS36).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- …and the same shape at TEN fixes, where floor(10 × 0.8) = 8 and the clamped
-- index would be 9: the 9th-nearest is inside 100 m and the 10th is not, so
-- 0.8 absorbs and 1.0 does not.
private def segsS37 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS37 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1202, 51.52, (-0.1), 40.0⟩, ⟨1206, 51.5201, (-0.1), 40.0⟩, ⟨1210, 51.5202, (-0.1), 40.0⟩, ⟨1214, 51.5203, (-0.1), 40.0⟩, ⟨1218, 51.5204, (-0.1), 40.0⟩, ⟨1222, 51.5205, (-0.1), 40.0⟩, ⟨1226, 51.5206, (-0.1), 40.0⟩, ⟨1230, 51.5207, (-0.1), 40.0⟩, ⟨1234, 51.5208, (-0.1), 40.0⟩, ⟨1238, 51.5249, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS37 fixesS37 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 30)]
#guard traceOf segsS37 fixesS37 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The stationary SHORTCUT doing work no other arm can: mode stationary but
-- avgSpeed 40 and fixes spread over kilometres, so only 'it says stationary'
-- absorbs it. The April-29 shape — 7 fixes covering 2.8 km at a claimed 4.7
-- km/h.
private def segsS38 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS38 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS38 fixesS38 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 20)]
#guard traceOf segsS38 fixesS38 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The two-fix floor: a pause with EXACTLY two fixes reaches the cluster arm,
-- so `< 2` admits it and `< 3` would not.
private def segsS39 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 2 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS39 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1210, 51.52, (-0.1), 40.0⟩, ⟨1250, 51.5201, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS39 fixesS39 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 22)]
#guard traceOf segsS39 fixesS39 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The centroid is the MEAN, not the first fix. Three fixes 89 m apart: from
-- their mean the outermost are 89 m out and the pause absorbs; measured from
-- the FIRST fix the farthest is 178 m and it would not.
private def segsS40 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 3 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS40 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1210, 51.52, (-0.1), 40.0⟩, ⟨1230, 51.5208, (-0.1), 40.0⟩, ⟨1250, 51.5216, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS40 fixesS40 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 23)]
#guard traceOf segsS40 fixesS40 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- Absorbing skips the CONFIRMING segment too: without that the walk would
-- re-examine it, and here it carries a turnaround-board tag that would break
-- the run a segment later.
private def segsS41 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #["turnaround-board"], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1300, endTs := 1400, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS41 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS41 fixesS41 == #[(1100, 1400, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #["turnaround-board"], 0.8, 2.0, 40.0, 60.0, 0.9, 30)]
#guard traceOf segsS41 fixesS41 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The walk-back passes THROUGH a walking segment to reach the stay behind it
-- — the rider walked from the platform bench to the carriage door.
private def segsS42 : Array Seg := #[
  { startTs := 800, endTs := 1000, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1000, endTs := 1090, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS42 : Array Fix := #[⟨850, 51.5, (-0.1), 1.0⟩, ⟨990, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.5135, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS42 fixesS42 == #[(800, 1000, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1000, 1090, "", "walking", "", "", #[], 0.8, 2.0, 4.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS42 fixesS42 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The stay's LAST fix is the one looked up, not its first: the rider sat down
-- at Beeston and left from Ayton, and only the last fix names the boarding
-- station.
private def segsS43 : Array Seg := #[
  { startTs := 900, endTs := 1090, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS43 : Array Fix := #[⟨950, 51.52, (-0.1), 1.0⟩, ⟨1080, 51.5, (-0.1), 1.0⟩, ⟨1090, 51.5135, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS43 fixesS43 == #[(900, 1090, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS43 fixesS43 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- `max 1` on the elapsed time: the stay's closing fix is LATER than
-- slowBefore, so the raw difference is −150 s and the apparent speed comes
-- out NEGATIVE — below the bar, and the stay would be distrusted for having
-- moved impossibly fast.
private def segsS44 : Array Seg := #[
  { startTs := 900, endTs := 1160, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS44 : Array Fix := #[⟨950, 51.5, (-0.1), 1.0⟩, ⟨1000, 51.5135, (-0.1), 2.0⟩, ⟨1150, 51.5, (-0.1), 1.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS44 fixesS44 == #[(900, 1160, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS44 fixesS44 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- A DIRECTIONAL relation name at one endpoint: 'Alpha Line Northbound' and
-- 'Alpha Line' are one physical line, and a raw string intersection of the
-- two is empty.
private def segsS45 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS45 : Array Fix := #[⟨1000, 51.57, (-0.1), 2.0⟩, ⟨1120, 51.565, (-0.1), 45.0⟩, ⟨1240, 51.55, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS45 fixesS45 == #[(1100, 1300, "Effton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS45 fixesS45 == #[.stations 51.57 (-0.1), .stations 51.54 (-0.1), .lines 51.57 (-0.1), .lines 51.54 (-0.1)]

-- A mid-ride fix naming NONE of the candidates — off-corridor, or outside the
-- mirror's coverage. It must not vote, and it must not be read as evidence
-- against either.
private def segsS46 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS46 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1200, 51.53, (-0.2), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1400, 51.555, (-0.1), 20.0⟩, ⟨1560, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS46 fixesS46 == #[(1100, 1500, "Ayton → Deeham · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS46 fixesS46 == #[.stations 51.5 (-0.1), .stations 51.56 (-0.1), .lines 51.5 (-0.1), .lines 51.56 (-0.1), .lines 51.505 (-0.1), .lines 51.53 (-0.2), .lines 51.53 (-0.1), .lines 51.555 (-0.1)]

-- The track backing MORE THAN ONE candidate: one mid fix names only Alpha,
-- another only Beta. Both have votes, nothing is a clean winner, and a
-- guessed line is worse than none.
private def segsS47 : Array Seg := #[
  { startTs := 1100, endTs := 1500, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS47 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1200, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.54, (-0.088), 50.0⟩, ⟨1400, 51.555, (-0.1), 20.0⟩, ⟨1560, 51.56, (-0.1), 2.0⟩]
#guard outOf segsS47 fixesS47 == #[(1100, 1500, "Ayton → Deeham", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS47 fixesS47 == #[.stations 51.5 (-0.1), .stations 51.56 (-0.1), .lines 51.5 (-0.1), .lines 51.56 (-0.1), .lines 51.505 (-0.1), .lines 51.53 (-0.1), .lines 51.54 (-0.088), .lines 51.555 (-0.1)]

-- A rail segment with NO fixes of its own inside a collapsing run: its
-- pointCount 0 weighs ONE in the averages but contributes zero to the emitted
-- count — two expressions two lines apart in the TS, and they differ.
private def segsS48 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.2, confidenceMargin := 2.0, avgSpeed := 10.0, maxSpeed := 20.0, linearity := 0.1, pointCount := 0 },
  { startTs := 1200, endTs := 1260, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 4 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.9, confidenceMargin := 2.0, avgSpeed := 50.0, maxSpeed := 70.0, linearity := 0.95, pointCount := 30 }]
private def fixesS48 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS48 fixesS48 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.88, 2.0, 48.7, 70.0, 0.92, 30)]
#guard traceOf segsS48 fixesS48 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- Rounding places: weights of 10 and 30 over speeds 40 and 45 give 43.75,
-- which is 43.8 at one decimal and 43.75 at two. avgSpeed takes one,
-- confidence two.
private def segsS49 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.625, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.625, pointCount := 10 },
  { startTs := 1200, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.875, confidenceMargin := 2.0, avgSpeed := 45.0, maxSpeed := 70.0, linearity := 0.875, pointCount := 30 }]
private def fixesS49 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1060, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1180, 51.515, (-0.1), 50.0⟩, ⟨1240, 51.53, (-0.1), 50.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩, ⟨1420, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS49 fixesS49 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "train", "merged rail run (collapsed brief pauses)", #[], 0.81, 2.0, 43.8, 70.0, 0.81, 40)]
#guard traceOf segsS49 fixesS49 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The boarding slow-fix arm is a SPEED test, not merely the latest fix: a
-- transit-speed fix sits after the platform one and before the classifier's
-- start, and taking it would resolve the boarding station to wherever the
-- train was passing.
private def segsS50 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS50 : Array Fix := #[⟨900, 51.5, (-0.1), 2.0⟩, ⟨1000, 51.5135, (-0.1), 20.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS50 fixesS50 == #[(1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS50 fixesS50 == #[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

-- The sweep must SKIP a candidate carrying the boarding station's own name.
-- Boarding at Beeston, the alight site's SECOND candidate is a
-- through-station also tagged 'Beeston', and its retry would match — so
-- without the skip the run is labelled with the degenerate pair 'Beeston →
-- Beeston'. The candidate it settles on shares TWO lines, and every mid-ride
-- fix is on the stretch Alpha and Beta share, so nothing separates them and
-- the bare pair stands: a two-element retry must not simply take its first
-- entry.
private def segsS51 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS51 : Array Fix := #[⟨1000, 51.52, (-0.1), 2.0⟩, ⟨1120, 51.515, (-0.1), 45.0⟩, ⟨1240, 51.505, (-0.1), 50.0⟩, ⟨1360, 51.5, (-0.12), 2.0⟩, ⟨1420, 51.5, (-0.12), 2.0⟩]
#guard outOf segsS51 fixesS51 == #[(1100, 1300, "Beeston → Haldon", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS51 fixesS51 == #[.stations 51.52 (-0.1), .stations 51.5 (-0.12), .lines 51.52 (-0.1), .lines 51.5 (-0.12), .lines 51.52 (-0.1), .lines 51.5 (-0.1225), .lines 51.5 (-0.1165), .lines 51.515 (-0.1), .lines 51.505 (-0.1)]

-- The pause window is INCLUSIVE at its start: a fix sitting exactly on
-- `startTs` belongs to the pause. Here it is the one far fix, and admitting
-- it drags the centroid out and rejects the pause; excluding it would leave
-- two fixes 6 m apart and absorb.
private def segsS54 : Array Seg := #[
  { startTs := 1100, endTs := 1200, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1200, endTs := 1260, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 3 },
  { startTs := 1260, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS54 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1200, 51.524, (-0.1), 40.0⟩, ⟨1230, 51.52, (-0.1), 40.0⟩, ⟨1250, 51.5201, (-0.1), 40.0⟩, ⟨1300, 51.5395, (-0.1), 20.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS54 fixesS54 == #[(1100, 1200, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10), (1200, 1260, "", "walking", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 3), (1260, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
-- V8's exact order, which this arm does not reproduce across runs — every
-- run's station pair, then every run's line pair: #[.stations 51.5 (-0.1),
-- .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1),
-- .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54
-- (-0.1)]
#guard ((traceOf segsS54 fixesS54).map reprStr).qsort (· < ·) == (((#[.stations 51.5 (-0.1), .stations 51.54 (-0.1), .stations 51.5 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)] : Array Read).map reprStr).qsort (· < ·))

-- An alight site of nothing but PLATFORMS: `pickBestStation` still answers,
-- but every candidate is tier 2, so the sweep's list is exactly the one node
-- it seeded with — the tier filter and the `#[chosen]` seed are both
-- load-bearing here.
private def segsS52 : Array Seg := #[
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS52 : Array Fix := #[⟨1000, 51.5, (-0.1), 2.0⟩, ⟨1120, 51.505, (-0.1), 45.0⟩, ⟨1240, 51.51, (-0.1), 50.0⟩, ⟨1360, 51.52, (-0.13), 2.0⟩, ⟨1420, 51.52, (-0.13), 2.0⟩]
#guard outOf segsS52 fixesS52 == #[(1100, 1300, "Ayton → Gee Platform 1", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS52 fixesS52 == #[.stations 51.5 (-0.1), .stations 51.52 (-0.13), .lines 51.5 (-0.1), .lines 51.52 (-0.13), .lines 51.5 (-0.1), .lines 51.52 (-0.13)]

-- The back-compat stay fallback: the walking-pace gate declined to trust the
-- stay, and slowBefore then resolves to NOTHING, so without the fallback the
-- run loses its label entirely. The original 'rider noisy at the platform'
-- case, from before the velocity gate existed.
private def segsS53 : Array Seg := #[
  { startTs := 400, endTs := 600, mode := "stationary", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 0.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 600, endTs := 1090, mode := "walking", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 4.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 },
  { startTs := 1100, endTs := 1300, mode := "train", refinedMode := none, refinedReason := none, refinedKinds := #[], wayName := none, confidence := 0.8, confidenceMargin := 2.0, avgSpeed := 40.0, maxSpeed := 60.0, linearity := 0.9, pointCount := 10 }]
private def fixesS53 : Array Fix := #[⟨450, 51.5, (-0.1), 1.0⟩, ⟨590, 51.5, (-0.1), 1.0⟩, ⟨1095, 51.515, (-0.1), 2.0⟩, ⟨1180, 51.53, (-0.1), 50.0⟩, ⟨1360, 51.54, (-0.1), 2.0⟩]
#guard outOf segsS53 fixesS53 == #[(400, 600, "", "stationary", "", "", #[], 0.8, 2.0, 0.0, 60.0, 0.9, 10), (600, 1090, "", "walking", "", "", #[], 0.8, 2.0, 4.0, 60.0, 0.9, 10), (1100, 1300, "Ayton → Ceeford · Alpha Line", "train", "", "", #[], 0.8, 2.0, 40.0, 60.0, 0.9, 10)]
#guard traceOf segsS53 fixesS53 == #[.stations 51.5 (-0.1), .stations 51.515 (-0.1), .stations 51.54 (-0.1), .lines 51.5 (-0.1), .lines 51.54 (-0.1)]

/-! ## Deliberately unpinned

A mutation sweep flipped 77 decisions in this module one at a time and rebuilt.
70 broke a guard. The six below did not, and each is a decision the guards
CANNOT see rather than one they merely happen to miss — three redundant by
construction, two unreachable at float exactness, one whose result is never read
in an order-sensitive way. Every claim here is measured or argued, not assumed.

**1. `min (segPoints.size - 1)` on the percentile index is dead code.**
`idx = min (n-1) ⌊0.8n⌋`, and the clamp can only bite when `⌊0.8n⌋ > n-1`, i.e.
`0.8n ≥ n`, i.e. `n ≤ 0`. The earlier `segPoints.size < 2` test already
guarantees `n ≥ 2`. So the clamp never changes the index for any input that
reaches it — in the TS either. Mirrored because it is there, not because it
does anything.

**2. `supported.isEmpty ||` in the mid-ride vote is redundant.**
The branch it guards skips the fix; the alternative is a `for c in supported`
that adds a vote per element. With `supported` empty that loop adds nothing, so
skipping and not-skipping agree. Dropping the OTHER disjunct
(`supported.size == candidates.size`) does break guards — that one is
load-bearing, and the pair is only half redundant.

**3. A single-segment run can never carry an absorbed stationary.**
`applyRailRuns` tests `toExclusive - from == 1 && absorbedStationary.isEmpty`.
Absorbing pushes an index and advances by TWO (the stationary plus the rail-like
segment that confirmed it), so a run with a non-empty `absorbedStationary` spans
at least three segments. The conjunct is unreachable; the TS carries it as
belt-and-braces and so does this.

**4-5. Two float boundaries land between representable outputs.**
`d ≤ TRAIN_DWELL_RADIUS_M` and `apparentKmh > BOARDING_NOISE_SPEED_KMH` differ
from their strict/non-strict twins only when the output is EXACTLY 100 m or
exactly 15 km/h. Both come out of `haversineMeters`. Measured in the refs
harness by stepping one latitude ulp and comparing against the ulp of the
distance:

|            | distance | step per input ulp | ulp of output | outputs skipped |
|------------|----------|--------------------|---------------|-----------------|
| at 100 m   | 99.888 m | 7.90e-10 m         | 1.42e-14 m    | 55 598          |
| at 150 m   | 149.831 m| 7.90e-10 m         | 2.84e-14 m    | 27 800          |

One representable move of an input coordinate jumps the output past tens of
thousands of representable values, so the boundary is not a number the fixtures
can be steered onto. Both thresholds ARE bracketed either side — S35/S36 at
150 m against 100 m, S33/S34 at 16 km/h against 14 — which pins the constant.
What stays unpinned is only which way the comparison falls exactly ON it.

**6. The intersection's ORDER is never read order-sensitively.**
`intersect` keeps the first argument's order, and reversing it survives every
guard. Chasing where the result goes: `inter.size == 1` reads the sole element;
`pickLineByStoppingPattern` maps and filters, then asks `possible.length == 1`;
`lineUnderTheTrack` sorts by vote count and any tie there returns `none` via the
runner-up bail. So no consumer distinguishes two orderings of the same set. The
TS order is mirrored anyway — an order that is currently unobservable is a thin
thing to rely on, and matching it costs nothing.
-/

end Verified.Geo.RailRunAnnotate
