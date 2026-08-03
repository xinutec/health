import Verified.Geo.RailReconcile
import Verified.Geo.RailRuns
import Verified.Geo.RailAbsorbers

/-!
# `assembleRailJourney` — the rail-journey assembler

Port of `assembleRailJourney` in `src/geo/passes/rail-reconcile.ts`. The rest of
that file — `mergeAdjacentSameRouteTrains`, `reconcileAdjacentRailLegs`,
`annotateSnappedPaths` — is already in `Verified.Geo.RailReconcile`; this is the
one export that reads OSM, and the reason it was left until last.

## What is injected, and what is not

The pass is an ORCHESTRATOR, but a DISCRETE one: it reasons over station names
and line labels, not float geometry. Every leaf it consults already exists in
Lean with its own pinned references —

* `parseRailWayName` (`RailAbsorbers`) — the station-pair label parser;
* `expandTubeLineNames` (`RailRuns`) — directional/shared-track canonicalisation;
* `findRunAlightFix` (`RailRuns`) — where a ride actually ended;

— so all three are called FOR REAL here. The only thing injected is the
two-call OSM slice the TS declares as `RailJourneyOsm`:

    linesAtPoint  : lat → lon → radiusM → lines whose TRACK passes the point
    stationsOnLine: line → the stations it serves, with coordinates

Injecting exactly these two and nothing else is what makes the guards assert the
ORCHESTRATION: which fragments join a run, where a run is cut, and what label the
merged leg comes out with. A leaf faked here would move the question to the fake.

## The five gates, and why each needs its own fixture

A prefix of fragments extends only while ALL of these hold. They are listed in
evaluation order, which matters because an earlier gate stopping the prefix
means the later ones are never consulted — and, since two of them read OSM, that
is observable in the read trace.

1. **Through line** — a single line serves every station the prefix touches.
2. **Label compatibility** — the fragments' own line labels, expanded, still
   intersect. A ride never changes physical line, so explicit Metropolitan then
   explicit Jubilee is an interchange EVEN WHEN one line serves all three
   stations.
3. **No interchange walk** — a `"<station> (interchange)"` walk between two
   fragments is positive evidence of a train change, unless both fragments carry
   labels proving one shared line.
4. **The observed span does not double back** — from the fixes.
5. **…and neither does the fragment being added** — from its own label.

Gates 1 and 2 mask each other, and so do 4 and 5. A fixture that trips two of
them pins neither, so each has a scenario below on which it ALONE decides:

* gate 1 — S2, where no line serves {A, C, E};
* gate 2 — S3, where Gamma serves A, B and C but the labels say Alpha then Gamma;
* gate 3 — S4, where both fragments are unlabelled and Alpha serves all three;
* gate 4 — S6, where the labels march outward but the fixes come home;
* gate 5 — S7, where the fixes stop out at D but the label says D → B.

## Three asymmetries worth stating

**`stationsOnLine` is memoised for the whole pass; `linesAtPoint` is not.**
`findThroughLine` is re-entered once per candidate prefix, and each entry asks
the first leg's neighbourhood again. On S17 that is three `linesAtPoint` calls at
one centroid against a single `stationsOnLine` fetch. Both are lookups; only one
is cached, and the trace is where that shows.

**Gates 4 and 5 PEEK at the memo, they do not fetch.** The TS reads
`stationsOnLineMemo.get(ln) ?? []` — a plain map read, total only because `ln`
was just returned by `findThroughLine`, which necessarily fetched it. The peek
is modelled as a peek because that is what the source does, but it is worth
being straight about what that buys: NOTHING observable. A mutation probe that
replaces both peeks with fetches builds clean, precisely because the line is
always already cached, so neither the answer nor the read trace can move. The
`?? []` fallback is unreachable for the same reason.

**Candidates are labels first, then neighbourhoods, and the label a fragment
carries need not be the line it is merged onto.** On S16 both fragments say
"Beta Line", Beta serves neither of their stations, and the merged leg comes out
labelled "Alpha Line" — a line NEITHER fragment named. That is the intended
reading of "candidates are the lines named on the legs PLUS the union of lines
near each leg centroid", and it is the case that pins the order.

Reference values come from `lean/experiments/rail-journey-refs.mts`, which drives
the real TS pass against the same synthetic geography.
-/

namespace Verified.Geo.RailJourney

open Verified.Geo.RailAbsorbers (parseRailWayName RailTriple RAIL_STATION_SEP RAIL_LINE_SEP)
open Verified.Geo.RailRuns (Fix expandTubeLineNames findRunAlightFix)

/-! ## Shapes -/

/-- A station the line serves, with the coordinate of its canonical node. -/
structure LineStation where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- The `EnrichedSegment` fields the assembler reads and rewrites. `RailReconcile`
already carries the shared core; the assembler additionally reads a segment
centroid (the test-only fallback when a leg has no fixes) and appends to
`refinedReason`. -/
structure Seg extends Verified.Geo.RailReconcile.Seg where
  refinedReason : Option String := none
  centroidLat : Option Float := none
  centroidLon : Option Float := none
  deriving Inhabited, BEq, Repr

def effectiveMode (s : Seg) : String := Verified.Geo.RailReconcile.effectiveMode s.toSeg

/-- One OSM read, recorded in order. The pass's cost and its cache behaviour are
both properties of this list, so it is part of the output the guards check —
not a debugging aid. -/
inductive Read where
  | lines (lat lon : Float) (radiusM : Int)
  | stations (line : String)
  deriving Inhabited, BEq, Repr

/-- The two-call OSM slice. Both are pure functions of their arguments; the
caching and the read ordering live in the pass, not in the adapter. -/
structure Env where
  linesAtPoint : Float → Float → Int → Array String
  stationsOnLine : String → Array LineStation

/-- `stationsOnLine`'s memo, plus the read trace. Threaded rather than global
because the memo's LIFETIME is a fact about the pass: it spans one
`assembleRailJourney` call, so two sub-runs on the same line cost one fetch. -/
structure Memo where
  cache : Array (String × Array LineStation) := #[]
  trace : Array Read := #[]
  deriving Inhabited, Repr

abbrev MemoM := StateM Memo

/-! ## Constants -/

/-- Max duration of a NON-train segment that may sit between two train legs of
one continuous ride and still be absorbed into it. -/
def RAIL_JOURNEY_SLIVER_MAX_S : Int := 10 * 60

/-- A longer intervening segment is still part of the ride if it carries a
motorised peak — the underground surfaced at tube speed. Above the cycling
ceiling, so a genuine walk between two rides never qualifies. -/
def RAIL_JOURNEY_TRANSIT_PEAK_KMH : Float := 40

/-- Radius for the line lookup at a train leg's fix centroid. -/
def RAIL_JOURNEY_LINES_RADIUS_M : Int := 800

/-- Max distance from the ride's alighting fix to a station ON THE LINE for that
station to be accepted as the alight. -/
def JOURNEY_ALIGHT_MAX_M : Float := 400

/-- How far a ride must reach from its boarding station before "it came back" is
a meaningful thing to say. -/
def REVERSAL_MIN_SPAN_M : Float := 1500

/-- A ride ending this fraction or less of the way out, having once been much
further, has doubled back. -/
def REVERSAL_RETURN_FRACTION : Float := 0.5

/-- How much closer to the run's boarding station a fragment must ALIGHT than it
BOARDS before the ride counts as turned around. -/
def TURNAROUND_MIN_GAIN_M : Float := 2000

/-- Suffix `relabelWalkingInterchanges` stamps on a platform-to-platform walk. -/
def INTERCHANGE_WALK_SUFFIX : String := "(interchange)"

/-! ## Geometry

`place-snap.ts`'s haversine, associated exactly as written there: `R * 2 *
atan2 …`, NOT the `2 * R * asin …` form the walk passes use. The two agree to
well under a millimetre but not bit-for-bit, and this pass compares against a
400 m and a 2000 m threshold, so the form is pinned rather than shared. -/

private def pi : Float := 3.141592653589793

def haversineMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let R := 6371000.0
  let dLat := (lat2 - lat1) * pi / 180.0
  let dLon := (lon2 - lon1) * pi / 180.0
  let a := Float.sin (dLat / 2.0) ^ 2
    + Float.cos (lat1 * pi / 180.0) * Float.cos (lat2 * pi / 180.0) * Float.sin (dLon / 2.0) ^ 2
  R * 2.0 * Float.atan2 (Float.sqrt a) (Float.sqrt (1.0 - a))

/-! ## Small readers -/

/-- Fixes inside a segment's window, both bounds INCLUSIVE (`samplesInWindow`). -/
def samplesInWindow (points : Array Fix) (startTs endTs : Int) : Array Fix :=
  points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/-- Representative location of a train leg for the line lookup: the centroid of
its own fixes, falling back to a segment centroid when the leg has none. -/
def legLocation (seg : Seg) (points : Array Fix) : Option (Float × Float) :=
  let fixes := samplesInWindow points seg.startTs seg.endTs
  if fixes.size > 0 then
    let n := Float.ofNat fixes.size
    some ((fixes.foldl (fun a f => a + f.lat) 0.0) / n, (fixes.foldl (fun a f => a + f.lon) 0.0) / n)
  else
    match seg.centroidLat, seg.centroidLon with
    | some la, some lo => some (la, lo)
    | _, _ => none

/-- `[lo, lo+n)` as a list of indices. Named because the assembler walks index
ranges in four places and `List.range'` reads badly inline. -/
private def idxRange (lo n : Nat) : List Nat := List.range' lo n

/-- A station-pair-labelled train leg — the only kind the assembler reasons over. -/
def isStationPairTrain (seg : Seg) : Bool :=
  effectiveMode seg == "train" && (parseRailWayName seg.wayName).isSome

/-- Is there a platform-to-platform interchange walk strictly between two
positions? Such a walk is positive evidence of a train change. -/
def hasInterchangeWalkBetween (segments : Array Seg) (aIdx bIdx : Nat) : Bool :=
  (idxRange (aIdx + 1) (bIdx - aIdx - 1)).any fun m =>
    match segments[m]? with
    | none => false
    | some seg =>
      effectiveMode seg == "walking" &&
        match seg.wayName with
        | none => false
        | some w => w.endsWith INTERCHANGE_WALK_SUFFIX

/-- The stations a set of train legs touches, in first-seen order. Order does not
affect the membership test that consumes it, but it is deterministic. -/
def stationsOf (segs : Array Seg) : Array String :=
  segs.foldl (init := #[]) fun acc t =>
    match parseRailWayName t.wayName with
    | none => acc
    | some r =>
      let acc := if acc.contains r.board then acc else acc.push r.board
      if acc.contains r.alight then acc else acc.push r.alight

/-! ## Memoised OSM reads -/

/-- Fetch a line's stations, memoised for the lifetime of one pass. -/
def fetchStations (env : Env) (line : String) : MemoM (Array LineStation) := do
  let m ← get
  match m.cache.find? (fun p => p.1 == line) with
  | some (_, v) => return v
  | none =>
    let v := env.stationsOnLine line
    set { m with cache := m.cache.push (line, v), trace := m.trace.push (.stations line) }
    return v

/-- PEEK at the memo — what gates 4 and 5 do. Never fetches, never traces; a miss
answers empty, mirroring the TS's `?? []`. -/
def peekStations (line : String) : MemoM (Array LineStation) := do
  let m ← get
  return match m.cache.find? (fun p => p.1 == line) with
    | some (_, v) => v
    | none => #[]

/-- The neighbourhood lookup. NOT memoised — see the module header. -/
def linesAt (env : Env) (lat lon : Float) : MemoM (Array String) := do
  modify fun m => { m with trace := m.trace.push (.lines lat lon RAIL_JOURNEY_LINES_RADIUS_M) }
  return env.linesAtPoint lat lon RAIL_JOURNEY_LINES_RADIUS_M

/-! ## `findThroughLine`

Candidates are the lines the legs NAME, then the union of lines near each leg
centroid — a union, not an intersection, because an underground-reconstructed
leg's coarse centroid can miss its own line while a clean above-ground leg in
the same run still contributes the through line. Every candidate is confirmed by
full station membership, so the looser candidate set cannot cause a wrong merge.

`tried` is per-call (a candidate rejected for THIS prefix is re-asked for the
next one, cheaply, off the memo); the station memo is per-pass. -/

/-- Does this line serve every wanted station? Threads `tried` so a candidate is
confirmed at most once per `findThroughLine` entry. -/
private def serves (env : Env) (want : Array String) (tried : Array String) (line : String) :
    MemoM (Bool × Array String) := do
  if tried.contains line then return (false, tried)
  let tried := tried.push line
  let onLine ← fetchStations env line
  let names := onLine.map LineStation.name
  return (want.all fun s => names.contains s, tried)

private def tryCandidates (env : Env) (want : Array String) :
    List String → Array String → MemoM (Option String × Array String)
  | [], tried => return (none, tried)
  | l :: ls, tried => do
    let (ok, tried) ← serves env want tried l
    if ok then return (some l, tried) else tryCandidates env want ls tried

/-- The label arm: a line a leg already names costs no OSM call beyond the
membership confirmation. -/
private def tryLabels (env : Env) (want : Array String) :
    List Seg → Array String → MemoM (Option String × Array String)
  | [], tried => return (none, tried)
  | t :: ts, tried => do
    match (parseRailWayName t.wayName).bind RailTriple.line with
    | none => tryLabels env want ts tried
    | some l =>
      let (ok, tried) ← serves env want tried l
      if ok then return (some l, tried) else tryLabels env want ts tried

/-- The neighbourhood arm, walked LAZILY: stop at the first leg whose
neighbourhood yields a serving line, so a clean above-ground leg finds the
through line and the coarse underground legs are never queried. -/
private def tryLegs (env : Env) (want : Array String) (points : Array Fix) :
    List Seg → Array String → MemoM (Option String × Array String)
  | [], tried => return (none, tried)
  | t :: ts, tried => do
    match legLocation t points with
    | none => tryLegs env want points ts tried
    | some (lat, lon) =>
      let lines ← linesAt env lat lon
      let (r, tried) ← tryCandidates env want lines.toList tried
      match r with
      | some l => return (some l, tried)
      | none => tryLegs env want points ts tried

def findThroughLine (env : Env) (trains : Array Seg) (stations : Array String)
    (points : Array Fix) : MemoM (Option String) := do
  let (r, tried) ← tryLabels env stations trains.toList #[]
  match r with
  | some l => return some l
  | none => return (← tryLegs env stations points trains.toList tried).1

/-! ## The reversal gates -/

/-- Would merging this span describe a ride that doubles back? Distance from the
boarding station grows along a one-way ride and stays grown; on a round trip it
peaks at the turnaround and returns to nothing. Unobserved spans answer `false` —
a gate that cannot see is not evidence of a reversal. -/
def spanDoublesBack (points : Array Fix) (startTs endTs : Int) (board : String)
    (onLine : Array LineStation) : Bool :=
  match onLine.find? (fun s => s.name == board) with
  | none => false
  | some bs =>
    let inSpan := points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs
    let maxD := inSpan.foldl (init := 0.0) fun m p =>
      let d := haversineMeters p.lat p.lon bs.lat bs.lon
      if d > m then d else m
    match inSpan.back? with
    | none => false
    | some last =>
      let endD := haversineMeters last.lat last.lon bs.lat bs.lon
      if maxD < REVERSAL_MIN_SPAN_M then false
      else endD < maxD * REVERSAL_RETURN_FRACTION

/-- Has this fragment turned the ride around, read from its OWN station pair?
`spanDoublesBack` asks the same question of the fixes and cannot answer it at the
moment that matters: when a return's FIRST fragment is offered, the return has
not travelled yet. The stations know already. Unknown stations answer `false`. -/
def ridesBackTowardBoard (runBoard : String) (frag : RailTriple)
    (onLine : Array LineStation) : Bool :=
  let stationAt (name : String) := onLine.find? fun s => s.name == name
  match stationAt runBoard, stationAt frag.board, stationAt frag.alight with
  | some origin, some from_, some to_ =>
    let outbound := haversineMeters from_.lat from_.lon origin.lat origin.lon
    let inbound := haversineMeters to_.lat to_.lon origin.lat origin.lon
    outbound - inbound ≥ TURNAROUND_MIN_GAIN_M
  | _, _, _ => false

/-- The ride's alight, resolved from the ride's own END against the stations its
line serves — NOT inherited from the last fragment, whose label stops wherever
the GPS last surfaced. Uses no OSM call of its own: the line's station set is
already in hand. Returns `none` when the end is unobserved or lands nowhere near
the line, and the caller then keeps the fragment's label. -/
def resolveJourneyAlight (points : Array Fix) (endTs : Int) (onLine : Array LineStation) :
    Option String :=
  match findRunAlightFix points endTs with
  | none => none
  | some off =>
    if onLine.isEmpty then none
    else
      -- The TS sorts ascending and takes the head. `Array.sort` is stable there,
      -- so among equal distances the FIRST in line order wins; a strict `<` fold
      -- keeps exactly that one.
      let best := onLine.foldl (init := none) fun acc s =>
        let d := haversineMeters off.lat off.lon s.lat s.lon
        match acc with
        | none => some (s, d)
        | some (_, bd) => if d < bd then some (s, d) else acc
      match best with
      | none => none
      | some (s, d) => if d ≤ JOURNEY_ALIGHT_MAX_M then some s.name else none

/-! ## Prefix extension

One step of the sub-run loop: offer `c` to the prefix built so far and either
accept it or stop. Stopping matters beyond the result — a gate that stops the
prefix means the later gates, two of which read OSM, are never consulted. -/

private structure PrefixState where
  /-- Positions accepted so far, in order. Never empty after the first step. -/
  acc : Array Nat
  /-- Physical lines still compatible with every LABEL seen, or `none` while no
  fragment has carried a label. -/
  allowed : Option (Array String)
  /-- The line the accepted prefix merges onto. -/
  groupLine : Option String
  deriving Inhabited, Repr

private def extendPrefix (env : Env) (segments : Array Seg) (points : Array Fix) (runBoard : String) :
    List Nat → PrefixState → MemoM PrefixState
  | [], st => return st
  | c :: rest, st => do
    let seg := segments[c]!
    let fragLabel := parseRailWayName seg.wayName
    let fragLine := fragLabel.bind RailTriple.line
    -- Gate 2 — labels are expanded to PHYSICAL lines first, so a shared-track
    -- combined name stays compatible with the plain one.
    let nextAllowed : Option (Array String) :=
      match fragLine with
      | none => st.allowed
      | some fl =>
        let expanded := (expandTubeLineNames fl).toArray
        match st.allowed with
        | none => some expanded
        | some a => some (a.filter fun l => expanded.contains l)
    if (match nextAllowed with | some a => a.isEmpty | none => false) then return st
    -- Gate 3 — an interchange walk breaks the run UNLESS both fragments carry
    -- explicit labels proving one shared line.
    let brokenByWalk :=
      match st.acc.back? with
      | none => false
      | some prev =>
        hasInterchangeWalkBetween segments prev c &&
          !(fragLine.isSome && st.allowed.isSome)
    if brokenByWalk then return st
    -- Gate 1 — a single line serves every station the prefix would touch.
    let sub := (st.acc.push c).map fun i => segments[i]!
    let ln ← findThroughLine env sub (stationsOf sub) points
    match ln with
    | none => return st
    | some ln =>
      let onLine ← peekStations ln
      let first := segments[st.acc.getD 0 c]!
      -- Gates 4 and 5 are only asked once a SECOND fragment is on the table: a
      -- lone fragment is not being merged with anything.
      let joining := !st.acc.isEmpty
      if joining && spanDoublesBack points first.startTs seg.endTs runBoard onLine then
        return st
      if joining && (match fragLabel with
                     | some fl => ridesBackTowardBoard runBoard fl onLine
                     | none => false) then
        return st
      extendPrefix env segments points runBoard rest
        { acc := st.acc.push c, allowed := nextAllowed, groupLine := some ln }

/-! ## The assembler -/

/-- Collapse `[firstPos..lastPos]` into one leg, absorbing the intervening
slivers. `snappedPath` is dropped for the later rail-snap pass to re-attach from
the merged route key. -/
private def mergedLeg (segments : Array Seg) (firstPos lastPos : Nat) (fragments : Nat)
    (groupLine : String) (first : RailTriple) (alight : String) : Seg :=
  let span := (idxRange firstPos (lastPos - firstPos + 1)).toArray
  let pointCount := span.foldl (init := (0 : Int)) fun a m => a + segments[m]!.pointCount
  let maxSpeed := span.foldl (init := 0.0) fun a m => max a segments[m]!.maxSpeed
  let reason := s!"rail-journey assembly: {fragments} fragments on {groupLine} (GPS surfaced mid-ride) merged into one continuous ride"
  let base := segments[firstPos]!
  { base with
    mode := "train"
    refinedMode := some "train"
    endTs := segments[lastPos]!.endTs
    wayName := some s!"{first.board}{RAIL_STATION_SEP}{alight}{RAIL_LINE_SEP}{groupLine}"
    snappedPath := none
    pointCount := pointCount
    maxSpeed := maxSpeed
    refinedReason := some (match base.refinedReason with
      | some r => s!"{r}; {reason}"
      | none => reason) }

/-- Partition a run's train legs into maximal SINGLE-LINE sub-runs and merge each
on its own, passing through anything between them.

`remaining` is the number of train positions still unvisited, not a fuel budget:
it starts at exactly `positions.size` and every step consumes at least the
position it just emitted, so it is a genuine well-founded measure. -/
private def subRuns (env : Env) (segments : Array Seg) (points : Array Fix)
    (positions : Array Nat) : Nat → Nat → Nat → Array Seg → MemoM (Array Seg)
  | 0, _, _, out => return out
  | remaining + 1, p, cursor, out => do
    if h : p < positions.size then
      let firstPos := positions[p]
      let runBoard := ((parseRailWayName segments[firstPos]!.wayName).map RailTriple.board).getD ""
      let st ← extendPrefix env segments points runBoard
        ((positions.toList.drop p)) { acc := #[], allowed := none, groupLine := none }
      -- `extendPrefix` accepts at least the first offered position unless gate 1
      -- or 2 rejects it outright, in which case the lone leg passes through.
      let e := p + (if st.acc.isEmpty then 0 else st.acc.size - 1)
      let lastPos := positions[min e (positions.size - 1)]!
      -- Emit everything before this sub-run unchanged (the interchange slivers).
      let out := (idxRange cursor (firstPos - cursor)).foldl
        (init := out) fun acc m => acc.push segments[m]!
      -- A lone leg, or an unresolvable line: pass the train leg(s) through
      -- unchanged rather than fabricate a merge.
      let passthrough := (idxRange firstPos (lastPos - firstPos + 1)).foldl
        (init := out) fun acc m => acc.push segments[m]!
      let out ← match st.groupLine, parseRailWayName segments[firstPos]!.wayName,
                      parseRailWayName segments[lastPos]!.wayName with
        | some gl, some f, some l =>
          if firstPos == lastPos then pure passthrough
          else do
            let onLine ← peekStations gl
            -- The ride's alight, resolved from the ride's own end — never
            -- collapsing to a degenerate "X → X", in which case the last
            -- fragment's own label stands.
            let alight := match resolveJourneyAlight points segments[lastPos]!.endTs onLine with
              | some r => if r != f.board then r else l.alight
              | none => l.alight
            pure (out.push (mergedLeg segments firstPos lastPos (e - p + 1) gl f alight))
        | _, _, _ => pure passthrough
      subRuns env segments points positions (remaining - (e - p)) (e + 1) (lastPos + 1) out
    else return out

/-- Assemble fragmented single-line rail journeys into one ride.

`remaining` counts segments still unvisited — the outer scan advances past at
least the segment it just handled, so it strictly decreases. -/
private def scan (env : Env) (segments : Array Seg) (points : Array Fix) :
    Nat → Nat → Array Seg → MemoM (Array Seg)
  | 0, _, out => return out
  | remaining + 1, i, out => do
    if h : i < segments.size then
      if !isStationPairTrain segments[i] then
        scan env segments points remaining (i + 1) (out.push segments[i])
      else
        -- Extend a maximal run: train legs plus short intervening slivers. A
        -- sliver is only INSIDE the run if another train leg follows it — a
        -- trailing sliver is not part of the ride, which is what `lastTrain`
        -- (rather than `k`) records.
        let mut lastTrain := i
        let mut k := i + 1
        let mut stop := false
        for _ in [i + 1 : segments.size] do
          if !stop then
            if h2 : k < segments.size then
              let s := segments[k]
              if isStationPairTrain s then
                lastTrain := k
                k := k + 1
              else if s.endTs - s.startTs < RAIL_JOURNEY_SLIVER_MAX_S then
                k := k + 1
              else if s.maxSpeed ≥ RAIL_JOURNEY_TRANSIT_PEAK_KMH then
                -- A longer middle is still inside the ride when it is mis-moded
                -- tunnel transit (a motorised peak), not a real walk or stop.
                k := k + 1
              else
                stop := true
            else stop := true
        if lastTrain == i then
          scan env segments points remaining (i + 1) (out.push segments[i])
        else
          let positions := (idxRange i (lastTrain - i + 1)).toArray.filter fun m =>
            match segments[m]? with
            | some s => isStationPairTrain s
            | none => false
          let out ← subRuns env segments points positions positions.size 0 i out
          -- Anything between the last sub-run and `lastTrain` has already been
          -- emitted by `subRuns`; resume after the run.
          scan env segments points (remaining - (lastTrain - i)) (lastTrain + 1) out
    else return out

/-- The pass, with its read trace. -/
def assembleRailJourneyTraced (env : Env) (segments : Array Seg) (points : Array Fix) :
    Array Seg × Array Read :=
  let (out, m) := (scan env segments points segments.size 0 #[]).run {}
  (out, m.trace)

def assembleRailJourney (env : Env) (segments : Array Seg) (points : Array Fix) : Array Seg :=
  (assembleRailJourneyTraced env segments points).1

/-! ## Guards (V8 reference values)

Fixtures mirror `lean/experiments/rail-journey-refs.mts` exactly, and the fix
arrays are GENERATED from it rather than transcribed — the centroid dust
(`51.519999999999996`, `51.507487499999996`, `51.560050000000004`) is what pins
the interpolation and the centroid summation order, and hand-rounding throws it
away.

Four stations on one meridian at 0.020 deg spacing, so every threshold in the
pass sits at a hand-checkable multiple of the 2223.9 m hop rather than at
whatever a real day happened to give. -/

section Guards

private def LON : Float := -0.1

private def STATIONS : List (String × Float × Float) :=
  [("A", 51.5, LON), ("B", 51.52, LON), ("C", 51.54, LON), ("D", 51.56, LON), ("E", 51.58, LON)]

/-- Alpha and Gamma both serve A..D. That overlap is the whole point: it lets the
line-LABEL gate be pinned separately from the through-line gate, which is
otherwise impossible because either one alone splits the run. -/
private def LINES : List (String × List String) :=
  [("Alpha Line", ["A", "B", "C", "D"]),
   ("Gamma Line", ["A", "B", "C", "D"]),
   ("Beta Line", ["C", "D", "E"])]

private def stationNamed (n : String) : LineStation :=
  match STATIONS.find? (fun s => s.1 == n) with
  | some (nm, la, lo) => ⟨nm, la, lo⟩
  | none => ⟨n, 0, 0⟩

private def stationsOnLine (l : String) : Array LineStation :=
  match LINES.find? (fun p => p.1 == l) with
  | some (_, names) => (names.map stationNamed).toArray
  | none => #[]

/-- A line is "at" a point when the point lies within its station span — for
collinear stations, exactly the segment its TRACK occupies. A station-keyed stub
would answer empty at every leg centroid the pass actually asks about, and no
fixture could reach the neighbourhood fallback at all. -/
private def linesAtPoint (lat lon : Float) (_r : Int) : Array String :=
  (LINES.filter fun p =>
    let lats := p.2.map fun n => (stationNamed n).lat
    let lo := lats.foldl min (lats.headD 0)
    let hi := lats.foldl max (lats.headD 0)
    lat ≥ lo && lat ≤ hi && Float.abs (lon - LON) < 0.001).map (·.1) |>.toArray

private def ENV : Env := { linesAtPoint, stationsOnLine }

private def train (startTs endTs : Int) (board alight : String) (line : Option String := none) : Seg :=
  { startTs, endTs, mode := "train", refinedMode := some "train",
    avgSpeed := 30, maxSpeed := 60, linearity := 0.95, pointCount := 10,
    wayName := some (match line with
      | none => s!"{board}{RAIL_STATION_SEP}{alight}"
      | some l => s!"{board}{RAIL_STATION_SEP}{alight}{RAIL_LINE_SEP}{l}") }

private def gap (startTs endTs : Int) (mode : String) (maxSpeed : Float)
    (wayName : Option String := none) : Seg :=
  { startTs, endTs, mode, refinedMode := some mode,
    avgSpeed := 3, maxSpeed, linearity := 0.4, pointCount := 4, wayName }

/-- The output reduced to what the guards compare: window, label, the two
accumulated fields, BOTH mode fields, and the reason. The mode fields are in
here because the merged leg FORCES them and nothing else in the tuple would
notice; the reason is in here because it carries the fragment COUNT, which is
the only place a mis-scoped run shows when the merged window is unchanged. -/
private def outOf (segs : Array Seg) (points : Array Fix) :
    Array (Int × Int × String × Int × Float × String × String × String) :=
  (assembleRailJourney ENV segs points).map fun s =>
    (s.startTs, s.endTs, s.wayName.getD "", s.pointCount, s.maxSpeed,
     s.mode, s.refinedMode.getD "", s.refinedReason.getD "")

private def traceOf (segs : Array Seg) (points : Array Fix) : Array Read :=
  (assembleRailJourneyTraced ENV segs points).2

/-! ### Leaves, called for real -/

#guard parseRailWayName (some "A → B · Alpha Line") == some ⟨"A", "B", some "Alpha Line"⟩
#guard parseRailWayName (some "A → B") == some ⟨"A", "B", none⟩
#guard parseRailWayName (some "Some Street") == none
#guard parseRailWayName none == none
-- An empty board or alight is ACCEPTED — the parser validates nothing.
#guard parseRailWayName (some " → ") == some ⟨"", "", none⟩
#guard parseRailWayName (some "A →  · L") == some ⟨"A", "", some "L"⟩

#guard expandTubeLineNames "Alpha Line" == ["Alpha Line"]
#guard expandTubeLineNames "Victoria Line Northbound" == ["Victoria Line"]
#guard expandTubeLineNames "Circle, Hammersmith & City and Metropolitan Lines"
  == ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
#guard expandTubeLineNames "Circle and District Lines" == ["Circle Line", "District Line"]

/-! ### The haversine, in `place-snap`'s association

`R * 2 * atan2 …`, NOT the `2 * R * asin …` the walk passes use. Pinned to the
bit because both reversal gates and the alight radius compare against it. -/

private def dAB : Float := haversineMeters 51.5 LON 51.52 LON
#guard dAB == 2223.8985328915223
#guard haversineMeters 51.5 LON 51.54 LON == 4447.797065782254
#guard haversineMeters 51.5 LON 51.56 LON == 6671.695598673777
-- A→E is the one pair where Lean and V8 DISAGREE, by exactly 1 ULP. The cause is
-- `atan2`: Lean calls the platform libm and V8 has its own, and they differ on a
-- minority of inputs at 1–2 ULP. Both values are pinned — Lean's, so the module
-- is checked at all, and the bit gap, so the divergence cannot silently widen to
-- 2 ULP or silently close without this guard noticing.
#guard haversineMeters 51.5 LON 51.58 LON == 8895.594131564509
#guard ((haversineMeters 51.5 LON 51.58 LON).toBits.toNat : Int)
  - ((8895.594131564507 : Float).toBits.toNat : Int) == 1
-- The other three pairs agree with V8 to the bit.
#guard ((haversineMeters 51.5 LON 51.54 LON).toBits.toNat : Int)
  - ((4447.797065782254 : Float).toBits.toNat : Int) == 0
-- Not associative-equal to the A→C hop: the same nominal 0.020 deg from a
-- different origin lands two ulps away. This is why the constant is pinned
-- rather than assumed symmetric.
#guard haversineMeters 51.52 LON 51.54 LON == 2223.8985328907324
#guard haversineMeters 51.54 LON 51.56 LON == 2223.8985328915223

/-! ### `findRunAlightFix`, on the S11 fix set -/

private def S11_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.507487499999996, -0.1, 50.0⟩, ⟨1115, 51.514975, -0.1, 50.0⟩, ⟨1173, 51.5224625, -0.1, 50.0⟩, ⟨1230, 51.52995, -0.1, 50.0⟩, ⟨1288, 51.537437499999996, -0.1, 50.0⟩, ⟨1345, 51.544925, -0.1, 50.0⟩, ⟨1403, 51.5524125, -0.1, 50.0⟩, ⟨1460, 51.5599, -0.1, 50.0⟩, ⟨1520, 51.56, -0.1, 4.0⟩, ⟨1580, 51.560050000000004, -0.1, 4.0⟩, ⟨1640, 51.5601, -0.1, 4.0⟩]

#guard (findRunAlightFix S11_FIXES 1460).map Fix.ts == some 1520
#guard (findRunAlightFix S11_FIXES 1500).map Fix.ts == some 1520
-- Past the last fix there is no alight to find: the ride ran off the data.
#guard (findRunAlightFix S11_FIXES 1640).isNone

/-! ### S1 — three fragments, one line, slivers between (the 2026-06-23 shape) -/

private def S1_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "walking" 5,
    train 1260 1460 "B" "C" (some "Alpha Line"),
    gap 1460 1520 "stationary" 2,
    train 1520 1720 "C" "D" (some "Alpha Line")]
private def S1_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1090, 51.5075, -0.1, 50.0⟩, ⟨1180, 51.515, -0.1, 50.0⟩, ⟨1270, 51.5225, -0.1, 50.0⟩, ⟨1360, 51.53, -0.1, 50.0⟩, ⟨1450, 51.5375, -0.1, 50.0⟩, ⟨1540, 51.545, -0.1, 50.0⟩, ⟨1630, 51.5525, -0.1, 50.0⟩, ⟨1720, 51.56, -0.1, 50.0⟩, ⟨1780, 51.5601, -0.1, 4.0⟩, ⟨1840, 51.5603, -0.1, 4.0⟩, ⟨1900, 51.5605, -0.1, 4.0⟩]

-- Three legs plus two slivers collapse to ONE, and the slivers' point counts
-- come with them: 10+4+10+4+10.
#guard outOf S1_SEGS S1_FIXES ==
  #[(1000, 1720, "A → D · Alpha Line", 38, 60.0, "train", "train", "rail-journey assembly: 3 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
-- One fetch for the whole pass: the label answers, and the memo holds across all
-- three `findThroughLine` entries.
#guard traceOf S1_SEGS S1_FIXES == #[.stations "Alpha Line"]

/-! ### S2 — gate 1 alone: no single line serves {A, C, E} -/

private def S2_SEGS : Array Seg :=
  #[train 1000 1200 "A" "C" (some "Alpha Line"),
    gap 1200 1260 "walking" 5,
    train 1260 1460 "C" "E" (some "Beta Line")]
private def S2_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.51, -0.1, 50.0⟩, ⟨1115, 51.519999999999996, -0.1, 50.0⟩, ⟨1173, 51.53, -0.1, 50.0⟩, ⟨1230, 51.54, -0.1, 50.0⟩, ⟨1288, 51.55, -0.1, 50.0⟩, ⟨1345, 51.56, -0.1, 50.0⟩, ⟨1403, 51.57, -0.1, 50.0⟩, ⟨1460, 51.58, -0.1, 50.0⟩, ⟨1520, 51.5801, -0.1, 4.0⟩, ⟨1580, 51.5803, -0.1, 4.0⟩, ⟨1640, 51.5805, -0.1, 4.0⟩]

#guard outOf S2_SEGS S2_FIXES ==
  #[(1000, 1200, "A → C · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 5.0, "walking", "walking", ""), (1260, 1460, "C → E · Beta Line", 10, 60.0, "train", "train", "")]
#guard traceOf S2_SEGS S2_FIXES == #[.stations "Alpha Line", .stations "Beta Line"]

/-! ### S3 — gate 2 alone: Gamma serves A, B and C, but the labels change line -/

private def S3_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Gamma Line")]
private def S3_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.505, -0.1, 50.0⟩, ⟨1115, 51.51, -0.1, 50.0⟩, ⟨1173, 51.515, -0.1, 50.0⟩, ⟨1230, 51.519999999999996, -0.1, 50.0⟩, ⟨1288, 51.525, -0.1, 50.0⟩, ⟨1345, 51.53, -0.1, 50.0⟩, ⟨1403, 51.535, -0.1, 50.0⟩, ⟨1460, 51.54, -0.1, 50.0⟩, ⟨1520, 51.5401, -0.1, 4.0⟩, ⟨1580, 51.5403, -0.1, 4.0⟩, ⟨1640, 51.5405, -0.1, 4.0⟩]

#guard outOf S3_SEGS S3_FIXES ==
  #[(1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "B → C · Gamma Line", 10, 60.0, "train", "train", "")]
-- Gamma IS fetched, but for the SECOND sub-run's own lone-leg test — not while
-- extending the first prefix, which gate 2 stopped before any OSM read.
#guard traceOf S3_SEGS S3_FIXES == #[.stations "Alpha Line", .stations "Gamma Line"]

/-! ### S4 — gate 3 alone: both fragments unlabelled, Alpha serves all three -/

private def S4_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B",
    gap 1200 1260 "walking" 5 (some "B (interchange)"),
    train 1260 1460 "B" "C"]

#guard outOf S4_SEGS S3_FIXES ==
  #[(1000, 1200, "A → B", 10, 60.0, "train", "train", ""), (1200, 1260, "B (interchange)", 4, 5.0, "walking", "walking", ""), (1260, 1460, "B → C", 10, 60.0, "train", "train", "")]
-- The memo asymmetry in miniature: two neighbourhood calls at two different
-- centroids, ONE station fetch. The second sub-run re-asks `linesAtPoint`
-- because it is not cached, then hits the memo for Alpha.
#guard traceOf S4_SEGS S3_FIXES ==
  #[.lines 51.50749999999999 (-0.1) 800, .stations "Alpha Line",
    .lines 51.5325 (-0.1) 800]

/-! ### S5 — the interchange marker OVERRIDDEN by two explicit same-line labels -/

private def S5_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "walking" 5 (some "B (interchange)"),
    train 1260 1460 "B" "C" (some "Alpha Line")]

#guard outOf S5_SEGS S3_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard traceOf S5_SEGS S3_FIXES == #[.stations "Alpha Line"]

/-! ### S6 — gate 4 alone: labels march outward, the fixes come home

Gate 5 cannot see this. Its question is asked of the fragment C → D, whose
alight is FURTHER from the board than its boarding (gain −2223.9 m), so the
label reads as continued outward travel. Only the observed span knows. -/

private def S6_SEGS : Array Seg :=
  #[train 1000 1200 "A" "C" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "C" "D" (some "Alpha Line")]
private def S6_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.515, -0.1, 50.0⟩, ⟨1115, 51.53, -0.1, 50.0⟩, ⟨1173, 51.545, -0.1, 50.0⟩, ⟨1230, 51.56, -0.1, 50.0⟩, ⟨1260, 51.56, -0.1, 50.0⟩, ⟨1310, 51.545, -0.1, 50.0⟩, ⟨1360, 51.53, -0.1, 50.0⟩, ⟨1410, 51.515, -0.1, 50.0⟩, ⟨1460, 51.5, -0.1, 50.0⟩]

#guard outOf S6_SEGS S6_FIXES ==
  #[(1000, 1200, "A → C · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "C → D · Alpha Line", 10, 60.0, "train", "train", "")]
#guard traceOf S6_SEGS S6_FIXES == #[.stations "Alpha Line"]
-- Directly: out to D, home to A.
#guard spanDoublesBack S6_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")
-- …and the label gate, asked the same question, says no.
#guard !ridesBackTowardBoard "A" ⟨"C", "D", none⟩ (stationsOnLine "Alpha Line")

/-! ### S7 — gate 5 alone: the fixes stop out at D, the label says D → B

The mirror image of S6. The return has not been travelled when its first
fragment is offered, so `spanDoublesBack` sees distance still growing. -/

private def S7_SEGS : Array Seg :=
  #[train 1000 1200 "A" "D" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "D" "B" (some "Alpha Line")]
private def S7_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1050, 51.515, -0.1, 50.0⟩, ⟨1100, 51.53, -0.1, 50.0⟩, ⟨1150, 51.545, -0.1, 50.0⟩, ⟨1200, 51.56, -0.1, 50.0⟩]

#guard outOf S7_SEGS S7_FIXES ==
  #[(1000, 1200, "A → D · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "D → B · Alpha Line", 10, 60.0, "train", "train", "")]
#guard traceOf S7_SEGS S7_FIXES == #[.stations "Alpha Line"]
#guard !spanDoublesBack S7_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")
-- 6671.7 out, 2223.9 back in: a 4447.8 m give-up, past the 2000 m margin.
#guard ridesBackTowardBoard "A" ⟨"D", "B", none⟩ (stationsOnLine "Alpha Line")
-- One stop back on THIS geography is 2223.9 m, which is over the 2000 m margin,
-- so it reads as a turnaround too. Real tube stops are closer together — the
-- margin exists so that King's Cross St Pancras → Euston Square, one stop west
-- and 0.57 km nearer, still merges. A tighter line shows the margin doing that
-- job, which the 0.020 deg spacing cannot.
#guard ridesBackTowardBoard "A" ⟨"D", "C", none⟩ (stationsOnLine "Alpha Line")
#guard !ridesBackTowardBoard "P"
  ⟨"R", "Q", none⟩ #[⟨"P", 51.5, LON⟩, ⟨"Q", 51.505, LON⟩, ⟨"R", 51.51, LON⟩]
-- …and two stops back on the same tight line clears it: 1112.0 m is still under.
#guard !ridesBackTowardBoard "P"
  ⟨"R", "P", none⟩ #[⟨"P", 51.5, LON⟩, ⟨"Q", 51.505, LON⟩, ⟨"R", 51.51, LON⟩]
-- An unknown station is not evidence of a turnaround.
#guard !ridesBackTowardBoard "A" ⟨"D", "Z", none⟩ (stationsOnLine "Alpha Line")

/-! ### S8 / S9 — the long middle, twice

The same 700 s middle: a street walk breaks the run, a motorised peak is
absorbed. S8 costs NO OSM read at all — the run never extends past its first
leg, so `findThroughLine` is never entered. -/

private def S8_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1138, 51.505, -0.1, 50.0⟩, ⟨1275, 51.51, -0.1, 50.0⟩, ⟨1413, 51.515, -0.1, 50.0⟩, ⟨1550, 51.519999999999996, -0.1, 50.0⟩, ⟨1688, 51.525, -0.1, 50.0⟩, ⟨1825, 51.53, -0.1, 50.0⟩, ⟨1963, 51.535, -0.1, 50.0⟩, ⟨2100, 51.54, -0.1, 50.0⟩, ⟨2160, 51.5401, -0.1, 4.0⟩, ⟨2220, 51.5403, -0.1, 4.0⟩, ⟨2280, 51.5405, -0.1, 4.0⟩]

private def S8_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1900 "walking" 5,
    train 1900 2100 "B" "C" (some "Alpha Line")]
private def S9_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1900 "walking" 45,
    train 1900 2100 "B" "C" (some "Alpha Line")]

#guard outOf S8_SEGS S8_FIXES ==
  #[(1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1900, "", 4, 5.0, "walking", "walking", ""), (1900, 2100, "B → C · Alpha Line", 10, 60.0, "train", "train", "")]
#guard traceOf S8_SEGS S8_FIXES == #[]
#guard outOf S9_SEGS S8_FIXES ==
  #[(1000, 2100, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard traceOf S9_SEGS S8_FIXES == #[.stations "Alpha Line"]

/-! ### S10 — a TRAILING sliver is not part of the run -/

private def S10_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"), gap 1200 1260 "walking" 5]
private def S10_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1050, 51.505, -0.1, 50.0⟩, ⟨1100, 51.510000000000005, -0.1, 50.0⟩, ⟨1150, 51.515, -0.1, 50.0⟩, ⟨1200, 51.52, -0.1, 50.0⟩, ⟨1320, 51.5201, -0.1, 4.0⟩, ⟨1380, 51.5203, -0.1, 4.0⟩, ⟨1440, 51.5205, -0.1, 4.0⟩]

#guard outOf S10_SEGS S10_FIXES ==
  #[(1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 5.0, "walking", "walking", "")]
#guard traceOf S10_SEGS S10_FIXES == #[]

/-! ### S11 / S12 / S13 — the alight resolver's three outcomes

Same two fragments labelled A → B, B → C every time; only where the fixes END
differs. S11 resolves PAST the last fragment's label (the 2026-06-28 shape);
S12 resolves back to the BOARD and is refused as degenerate; S13 lands 1112 m
from the nearest station, past the 400 m radius, and resolves nothing. The last
two produce the same output by different routes. -/

private def ALIGHT_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Alpha Line")]
private def S12_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.505, -0.1, 50.0⟩, ⟨1115, 51.51, -0.1, 50.0⟩, ⟨1173, 51.515, -0.1, 50.0⟩, ⟨1230, 51.519999999999996, -0.1, 50.0⟩, ⟨1288, 51.525, -0.1, 50.0⟩, ⟨1345, 51.53, -0.1, 50.0⟩, ⟨1403, 51.535, -0.1, 50.0⟩, ⟨1460, 51.54, -0.1, 50.0⟩, ⟨1520, 51.5, -0.1, 4.0⟩, ⟨1580, 51.50005, -0.1, 4.0⟩, ⟨1640, 51.5001, -0.1, 4.0⟩]
private def S13_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.505, -0.1, 50.0⟩, ⟨1115, 51.51, -0.1, 50.0⟩, ⟨1173, 51.515, -0.1, 50.0⟩, ⟨1230, 51.519999999999996, -0.1, 50.0⟩, ⟨1288, 51.525, -0.1, 50.0⟩, ⟨1345, 51.53, -0.1, 50.0⟩, ⟨1403, 51.535, -0.1, 50.0⟩, ⟨1460, 51.54, -0.1, 50.0⟩, ⟨1520, 51.55, -0.1, 4.0⟩, ⟨1580, 51.55005, -0.1, 4.0⟩, ⟨1640, 51.5501, -0.1, 4.0⟩]

#guard outOf ALIGHT_SEGS S11_FIXES ==
  #[(1000, 1460, "A → D · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard outOf ALIGHT_SEGS S12_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard outOf ALIGHT_SEGS S13_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
-- The resolver in isolation, so the three routes are distinguishable even
-- though two of the outputs coincide.
#guard resolveJourneyAlight S11_FIXES 1460 (stationsOnLine "Alpha Line") == some "D"
#guard resolveJourneyAlight S12_FIXES 1460 (stationsOnLine "Alpha Line") == some "A"
#guard (resolveJourneyAlight S13_FIXES 1460 (stationsOnLine "Alpha Line")).isNone
-- An empty station set resolves nothing rather than erroring.
#guard (resolveJourneyAlight S11_FIXES 1460 #[]).isNone
-- Co-located station nodes — the King's Cross shape, where the Underground and
-- National Rail nodes sit metres apart and can tie exactly. The TS maps to
-- distances, sorts ascending and takes the head; `Array.prototype.sort` has been
-- required to be stable since ES2019, so a tie keeps LINE ORDER. The fold here
-- uses a strict `<` for the same reason.
#guard resolveJourneyAlight S11_FIXES 1460
  #[⟨"Underground", 51.56, LON⟩, ⟨"National Rail", 51.56, LON⟩] == some "Underground"
#guard resolveJourneyAlight S11_FIXES 1460
  #[⟨"National Rail", 51.56, LON⟩, ⟨"Underground", 51.56, LON⟩] == some "National Rail"

/-! ### S14 — a run spanning a genuine interchange splits into two sub-runs -/

private def S14_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Alpha Line"),
    gap 1460 1560 "walking" 5 (some "C (interchange)"),
    train 1560 1760 "C" "D" (some "Beta Line"),
    gap 1760 1820 "stationary" 2,
    train 1820 2020 "D" "E" (some "Beta Line")]
private def S14_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1085, 51.50666666666667, -0.1, 50.0⟩, ⟨1170, 51.513333333333335, -0.1, 50.0⟩, ⟨1255, 51.519999999999996, -0.1, 50.0⟩, ⟨1340, 51.526666666666664, -0.1, 50.0⟩, ⟨1425, 51.53333333333333, -0.1, 50.0⟩, ⟨1510, 51.54, -0.1, 50.0⟩, ⟨1595, 51.54666666666667, -0.1, 50.0⟩, ⟨1680, 51.553333333333335, -0.1, 50.0⟩, ⟨1765, 51.56, -0.1, 50.0⟩, ⟨1850, 51.56666666666666, -0.1, 50.0⟩, ⟨1935, 51.57333333333333, -0.1, 50.0⟩, ⟨2020, 51.58, -0.1, 50.0⟩, ⟨2080, 51.5801, -0.1, 4.0⟩, ⟨2140, 51.5803, -0.1, 4.0⟩, ⟨2200, 51.5805, -0.1, 4.0⟩]

-- Each side merges on its own line; the interchange sliver BETWEEN sub-runs is
-- passed through, while the slivers WITHIN each are absorbed.
#guard outOf S14_SEGS S14_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride"), (1460, 1560, "C (interchange)", 4, 5.0, "walking", "walking", ""), (1560, 2020, "C → E · Beta Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Beta Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard traceOf S14_SEGS S14_FIXES == #[.stations "Alpha Line", .stations "Beta Line"]

/-! ### S15 — a `train` whose label is a ROAD is not a run member at all -/

private def S15_SEGS : Array Seg :=
  #[gap 900 1000 "walking" 5 (some "Some Street"),
    train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    { train 1260 1460 "B" "C" (some "Alpha Line") with wayName := some "Some Other Street" },
    gap 1460 1560 "walking" 5 (some "Third Street")]
private def S15_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.505, -0.1, 50.0⟩, ⟨1115, 51.51, -0.1, 50.0⟩, ⟨1173, 51.515, -0.1, 50.0⟩, ⟨1230, 51.519999999999996, -0.1, 50.0⟩, ⟨1288, 51.525, -0.1, 50.0⟩, ⟨1345, 51.53, -0.1, 50.0⟩, ⟨1403, 51.535, -0.1, 50.0⟩, ⟨1460, 51.54, -0.1, 50.0⟩, ⟨1620, 51.5401, -0.1, 4.0⟩, ⟨1680, 51.5403, -0.1, 4.0⟩, ⟨1740, 51.5405, -0.1, 4.0⟩]

#guard outOf S15_SEGS S15_FIXES ==
  #[(900, 1000, "Some Street", 4, 5.0, "walking", "walking", ""), (1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "Some Other Street", 10, 60.0, "train", "train", ""), (1460, 1560, "Third Street", 4, 5.0, "walking", "walking", "")]
#guard traceOf S15_SEGS S15_FIXES == #[]

/-! ### S16 — CANDIDATE ORDER: the merged line is one NEITHER fragment named

Both fragments say "Beta Line", which serves neither A nor B, so every label
candidate fails and the through line can only come from the neighbourhood. The
merged leg comes out on Alpha. -/

private def S16_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Beta Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Beta Line")]

#guard outOf S16_SEGS S3_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
-- Beta is asked FIRST (it is named), fails, and the neighbourhood supplies
-- Alpha. On the second prefix Beta is re-asked but hits the memo — so it
-- appears once — while `linesAtPoint` is asked again at the same centroid.
#guard traceOf S16_SEGS S3_FIXES ==
  #[.stations "Beta Line", .lines 51.50749999999999 (-0.1) 800,
    .stations "Alpha Line", .lines 51.50749999999999 (-0.1) 800]

/-! ### S17 — the LAZY stop, and the memo asymmetry at its plainest

Three unlabelled fragments that do merge. `findThroughLine` is entered three
times; each entry asks the FIRST leg's neighbourhood, gets Alpha, and never
queries legs two or three. Three `linesAtPoint` calls at ONE centroid against a
single `stationsOnLine` fetch — one lookup cached, the other not. -/

private def S17_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B",
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C",
    gap 1460 1520 "stationary" 2,
    train 1520 1720 "C" "D"]

#guard outOf S17_SEGS S1_FIXES ==
  #[(1000, 1720, "A → D · Alpha Line", 38, 60.0, "train", "train", "rail-journey assembly: 3 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard traceOf S17_SEGS S1_FIXES ==
  #[.lines 51.50749999999999 (-0.10000000000000002) 800, .stations "Alpha Line",
    .lines 51.50749999999999 (-0.10000000000000002) 800,
    .lines 51.50749999999999 (-0.10000000000000002) 800]


/-! ### S18 — gate 2 needs the EXPANSION, not the raw label

A combined shared-track relation name and the plain name of one of its
components denote the same physical line. Compare labels literally and this run
splits; expand them and it merges — onto the component, because that is what the
second prefix's own label candidate confirms. -/

private def S18_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha, Beta and Gamma Lines"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Gamma Line")]

#guard outOf S18_SEGS S3_FIXES ==
  #[(1000, 1460, "A → C · Gamma Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Gamma Line (GPS surfaced mid-ride) merged into one continuous ride")]
-- The combined name is asked FIRST and is not a line the mirror knows, so it
-- answers no stations and fails; the neighbourhood then supplies Alpha for the
-- lone-leg test, and the second prefix's own label lands on Gamma.
#guard traceOf S18_SEGS S3_FIXES ==
  #[.stations "Alpha, Beta and Gamma Lines", .lines 51.50749999999999 (-0.1) 800, .stations "Alpha Line", .stations "Gamma Line"]

/-! ### S19 / S20 — gate 3's "proven same line" needs BOTH halves

S19 has a prior label but the joining fragment has none; S20 has the joining
label but no prior. Neither proves one shared line, so the marker stands in
both — and the two traces differ, because in S19 the first prefix's label
answers while in S20 it has to fall to the neighbourhood. -/

private def S19_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1260 "walking" 5 (some "B (interchange)"),
    train 1260 1460 "B" "C"]
private def S20_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B",
    gap 1200 1260 "walking" 5 (some "B (interchange)"),
    train 1260 1460 "B" "C" (some "Alpha Line")]

#guard outOf S19_SEGS S3_FIXES ==
  #[(1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "B (interchange)", 4, 5.0, "walking", "walking", ""), (1260, 1460, "B → C", 10, 60.0, "train", "train", "")]
#guard traceOf S19_SEGS S3_FIXES == #[.stations "Alpha Line", .lines 51.5325 (-0.1) 800]
#guard outOf S20_SEGS S3_FIXES ==
  #[(1000, 1200, "A → B", 10, 60.0, "train", "train", ""), (1200, 1260, "B (interchange)", 4, 5.0, "walking", "walking", ""), (1260, 1460, "B → C · Alpha Line", 10, 60.0, "train", "train", "")]
#guard traceOf S20_SEGS S3_FIXES == #[.lines 51.50749999999999 (-0.1) 800, .stations "Alpha Line"]

/-! ### S21 / S22 — WHEN the reversal gates are asked, and over WHAT span

S21: the first fragment's own fixes double back, but the run as a whole does
not. Ask the gate at the first fragment — before anything is being merged — and
this run never starts.

S22: the mirror image. The whole span doubles back; the joining fragment's own
window sits still at the boarding station and cannot see it. Read the span from
the fragment instead of the run and the reversal is invisible. -/

private def REVERSAL_SEGS : Array Seg :=
  #[train 1000 1200 "A" "C" (some "Alpha Line"),
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "C" "D" (some "Alpha Line")]
private def S21_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1033, 51.52, -0.1, 50.0⟩, ⟨1067, 51.54, -0.1, 50.0⟩, ⟨1100, 51.56, -0.1, 50.0⟩, ⟨1130, 51.56, -0.1, 50.0⟩, ⟨1165, 51.53, -0.1, 50.0⟩, ⟨1200, 51.5, -0.1, 50.0⟩, ⟨1260, 51.5, -0.1, 50.0⟩, ⟨1310, 51.515, -0.1, 50.0⟩, ⟨1360, 51.53, -0.1, 50.0⟩, ⟨1410, 51.545, -0.1, 50.0⟩, ⟨1460, 51.56, -0.1, 50.0⟩]
private def S22_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1033, 51.52, -0.1, 50.0⟩, ⟨1067, 51.54, -0.1, 50.0⟩, ⟨1100, 51.56, -0.1, 50.0⟩, ⟨1130, 51.56, -0.1, 50.0⟩, ⟨1165, 51.53, -0.1, 50.0⟩, ⟨1200, 51.5, -0.1, 50.0⟩, ⟨1260, 51.5, -0.1, 50.0⟩, ⟨1310, 51.5, -0.1, 50.0⟩, ⟨1360, 51.5, -0.1, 50.0⟩, ⟨1410, 51.5, -0.1, 50.0⟩, ⟨1460, 51.5, -0.1, 50.0⟩]

#guard outOf REVERSAL_SEGS S21_FIXES ==
  #[(1000, 1460, "A → D · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard outOf REVERSAL_SEGS S22_FIXES ==
  #[(1000, 1200, "A → C · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "C → D · Alpha Line", 10, 60.0, "train", "train", "")]
-- Directly: the first fragment's own window doubles back in BOTH, and the run
-- span doubles back only in S22.
#guard spanDoublesBack S21_FIXES 1000 1200 "A" (stationsOnLine "Alpha Line")
#guard !spanDoublesBack S21_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")
#guard spanDoublesBack S22_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")
-- …and the joining fragment's own window sees nothing in S22: it never leaves
-- the boarding station, so its max reach is under REVERSAL_MIN_SPAN_M.
#guard !spanDoublesBack S22_FIXES 1260 1460 "A" (stationsOnLine "Alpha Line")

/-! ### S28 — the RETURN FRACTION itself

Every other reversal fixture comes home to essentially zero, where any fraction
strictly between 0 and 1 gives the same verdict. Only a PARTIAL return separates
one fraction from another: this ride reaches D and comes back as far as B —
2223.9 m of a 6671.7 m maximum, a third of the way out, which is inside 0.5 and
outside 0.1. -/

private def S28_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.515, -0.1, 50.0⟩, ⟨1115, 51.53, -0.1, 50.0⟩, ⟨1173, 51.545, -0.1, 50.0⟩, ⟨1230, 51.56, -0.1, 50.0⟩, ⟨1260, 51.56, -0.1, 50.0⟩, ⟨1310, 51.550000000000004, -0.1, 50.0⟩, ⟨1360, 51.540000000000006, -0.1, 50.0⟩, ⟨1410, 51.53, -0.1, 50.0⟩, ⟨1460, 51.52, -0.1, 50.0⟩]

#guard outOf REVERSAL_SEGS S28_FIXES ==
  #[(1000, 1200, "A → C · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1260, "", 4, 2.0, "stationary", "stationary", ""), (1260, 1460, "C → D · Alpha Line", 10, 60.0, "train", "train", "")]
#guard spanDoublesBack S28_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")
-- A board station the line does not serve is not evidence of a reversal. In the
-- pass this is unreachable — gate 1 has already established that the through
-- line serves every station the run touches, the boarding included — so it can
-- only be shown by calling the gate directly.
#guard !spanDoublesBack S28_FIXES 1000 1460 "Z" (stationsOnLine "Alpha Line")

-- …and the same shape from the OTHER side: back only as far as C, two thirds of
-- the way out, which is OUTSIDE the fraction. The two fixtures bracket the
-- constant — raise it or lower it and one of them flips.
private def S29_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1058, 51.515, -0.1, 50.0⟩, ⟨1115, 51.53, -0.1, 50.0⟩, ⟨1173, 51.545, -0.1, 50.0⟩, ⟨1230, 51.56, -0.1, 50.0⟩, ⟨1260, 51.56, -0.1, 50.0⟩, ⟨1310, 51.555, -0.1, 50.0⟩, ⟨1360, 51.55, -0.1, 50.0⟩, ⟨1410, 51.545, -0.1, 50.0⟩, ⟨1460, 51.54, -0.1, 50.0⟩]

#guard outOf REVERSAL_SEGS S29_FIXES ==
  #[(1000, 1460, "A → D · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard !spanDoublesBack S29_FIXES 1000 1460 "A" (stationsOnLine "Alpha Line")

/-! ### S23 — the alight is resolved at the RUN's end, not the first fragment's

Every fix here is at transit speed, so `findRunAlightFix` falls through both
sustained-slow arms to its last one — the first fix after the window — and the
two windows land at different stations. -/

private def S23_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1230, 51.54, -0.1, 50.0⟩, ⟨1460, 51.55, -0.1, 50.0⟩, ⟨1520, 51.56, -0.1, 50.0⟩]

#guard outOf ALIGHT_SEGS S23_FIXES ==
  #[(1000, 1460, "A → D · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]
#guard resolveJourneyAlight S23_FIXES 1460 (stationsOnLine "Alpha Line") == some "D"
#guard resolveJourneyAlight S23_FIXES 1200 (stationsOnLine "Alpha Line") == some "C"

/-! ### S24 — the merged leg FORCES both mode fields, and APPENDS its reason -/

private def S24_SEGS : Array Seg :=
  #[{ train 1000 1200 "A" "B" (some "Alpha Line") with
       mode := "driving", refinedReason := some "prior note" },
    gap 1200 1260 "stationary" 2,
    train 1260 1460 "B" "C" (some "Alpha Line")]

#guard outOf S24_SEGS S3_FIXES ==
  #[(1000, 1460, "A → C · Alpha Line", 24, 60.0, "train", "train", "prior note; rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]

/-! ### S25 / S26 — the two sliver thresholds at their exact boundaries

Both are reachable exactly: the duration is an `Int` and 40 km/h is
representable. A middle of EXACTLY 600 s is not short enough (strict `<`); a
peak of EXACTLY 40 km/h is fast enough (`≥`). -/

private def S25_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1800 "walking" 5,
    train 1800 2000 "B" "C" (some "Alpha Line")]
private def S26_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    gap 1200 1900 "walking" 40,
    train 1900 2100 "B" "C" (some "Alpha Line")]
private def S25_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1125, 51.505, -0.1, 50.0⟩, ⟨1250, 51.51, -0.1, 50.0⟩, ⟨1375, 51.515, -0.1, 50.0⟩, ⟨1500, 51.519999999999996, -0.1, 50.0⟩, ⟨1625, 51.525, -0.1, 50.0⟩, ⟨1750, 51.53, -0.1, 50.0⟩, ⟨1875, 51.535, -0.1, 50.0⟩, ⟨2000, 51.54, -0.1, 50.0⟩, ⟨2060, 51.5401, -0.1, 4.0⟩, ⟨2120, 51.5403, -0.1, 4.0⟩, ⟨2180, 51.5405, -0.1, 4.0⟩]

#guard outOf S25_SEGS S25_FIXES ==
  #[(1000, 1200, "A → B · Alpha Line", 10, 60.0, "train", "train", ""), (1200, 1800, "", 4, 5.0, "walking", "walking", ""), (1800, 2000, "B → C · Alpha Line", 10, 60.0, "train", "train", "")]
#guard outOf S26_SEGS S8_FIXES ==
  #[(1000, 2100, "A → C · Alpha Line", 24, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]

/-! ### S27 — a road-labelled `train` inside a run is a SLIVER, not a fragment

Its point count is absorbed (30, not 20) but it does not count as a fragment:
the reason says two, not three. Nothing else in the output can tell the
difference, which is why the reason is part of the compared tuple. -/

private def S27_SEGS : Array Seg :=
  #[train 1000 1200 "A" "B" (some "Alpha Line"),
    { train 1200 1400 "B" "C" (some "Alpha Line") with wayName := some "Some Street" },
    train 1400 1600 "B" "C" (some "Alpha Line")]
private def S27_FIXES : Array Fix := #[⟨1000, 51.5, -0.1, 50.0⟩, ⟨1075, 51.505, -0.1, 50.0⟩, ⟨1150, 51.51, -0.1, 50.0⟩, ⟨1225, 51.515, -0.1, 50.0⟩, ⟨1300, 51.519999999999996, -0.1, 50.0⟩, ⟨1375, 51.525, -0.1, 50.0⟩, ⟨1450, 51.53, -0.1, 50.0⟩, ⟨1525, 51.535, -0.1, 50.0⟩, ⟨1600, 51.54, -0.1, 50.0⟩, ⟨1660, 51.5401, -0.1, 4.0⟩, ⟨1720, 51.5403, -0.1, 4.0⟩, ⟨1780, 51.5405, -0.1, 4.0⟩]

#guard outOf S27_SEGS S27_FIXES ==
  #[(1000, 1600, "A → C · Alpha Line", 30, 60.0, "train", "train", "rail-journey assembly: 2 fragments on Alpha Line (GPS surfaced mid-ride) merged into one continuous ride")]

/-! ### Structural readers -/

-- Both bounds INCLUSIVE.
#guard (samplesInWindow S1_FIXES 1090 1180).map Fix.ts == #[1090, 1180]
-- The leg centroid the neighbourhood lookup is asked at. Neither coordinate is
-- the round number it looks like: the mean of three fixes at lon −0.1 is
-- −0.10000000000000002, and the same leg over the four-fix S3 set comes out at
-- exactly −0.1 instead. The centroid depends on how many fixes were summed, and
-- that is why these are generated from V8 rather than written by hand.
#guard legLocation (train 1000 1200 "A" "B") S1_FIXES
  == some (51.50749999999999, -0.10000000000000002)
#guard legLocation (train 1000 1200 "A" "B") S3_FIXES == some (51.50749999999999, -0.1)
-- No fixes in window falls back to the segment centroid, then to nothing.
#guard legLocation { train 5000 5100 "A" "B" with centroidLat := some 1, centroidLon := some 2 }
  S1_FIXES == some (1, 2)
#guard (legLocation (train 5000 5100 "A" "B") S1_FIXES).isNone
-- ONE fix in the window is enough: the centroid of a single fix is that fix, and
-- the segment centroid is not consulted. The test is `> 0`, not `> 1`.
#guard legLocation { train 1000 1010 "A" "B" with centroidLat := some 9, centroidLon := some 9 }
  #[⟨1005, 51.5, LON, 50⟩] == some (51.5, LON)
-- Only a station-PAIR train is a run member.
#guard isStationPairTrain (train 1000 1200 "A" "B")
#guard !isStationPairTrain { train 1000 1200 "A" "B" with wayName := some "Some Street" }
#guard !isStationPairTrain (gap 1000 1200 "walking" 5)
-- `refinedMode` wins over `mode`, so a re-moded segment is read as what it now is.
#guard isStationPairTrain { gap 1000 1200 "walking" 5 (some "A → B") with refinedMode := some "train" }
-- …and a station-pair label on something that is NOT a train is not a run
-- member. Both halves of the test are load-bearing.
#guard !isStationPairTrain (gap 1000 1200 "walking" 5 (some "A → B"))
-- Stations in first-seen order, deduplicated.
#guard stationsOf #[train 1000 1200 "A" "B" (some "L"), train 1260 1460 "B" "C" (some "L")]
  == #["A", "B", "C"]
-- The interval is EXCLUSIVE of both endpoints.
#guard hasInterchangeWalkBetween S4_SEGS 0 2
#guard !hasInterchangeWalkBetween S4_SEGS 0 1
#guard !hasInterchangeWalkBetween S14_SEGS 0 2
-- The lower endpoint is excluded too: an interchange walk sitting AT `aIdx` is
-- not between anything. (`aIdx` is a train position in every real call, so this
-- can only be shown by calling the helper directly.)
#guard !hasInterchangeWalkBetween
  #[gap 1000 1100 "walking" 5 (some "B (interchange)"), train 1100 1300 "B" "C"] 0 1

/-! ## Deliberately unpinned

A mutation-probe sweep of 76 single-change edits leaves eleven that build clean.
Each is unobservable for a stated reason, not merely unfixtured; they are listed
so that a later reader can attack the reason rather than rediscover the gap.

**Three are float commutativity or idempotence.** `R * 2` against `2 * R`
(multiplying by two is exact, so association cannot matter);
`cos lat1 * cos lat2` against the reverse (IEEE multiplication is commutative);
and the running maximum's `d > m` against `d ≥ m` (both keep the same maximum —
only which equal witness is discarded differs, and nothing reads the witness).

**Three are threshold boundaries that no representable coordinate can reach.**
`maxD < REVERSAL_MIN_SPAN_M`, `endD < maxD * REVERSAL_RETURN_FRACTION` and
`d ≤ JOURNEY_ALIGHT_MAX_M` would each need a haversine output landing EXACTLY on
1500, on half the span maximum, or on 400. Measured on this geography: one ulp
of latitude moves the output by 7.9e-10 m, while one ulp OF the output at 1500 m
is 2.3e-13 m — so consecutive representable coordinates skip about 3470 output
ulps, and hitting one nominated double is not a matter of searching harder.
`TURNAROUND_MIN_GAIN_M`'s `≥` is the same case at 2000 m. Contrast the two
sliver thresholds, which ARE pinned at their exact boundaries in S25 and S26:
one compares `Int` seconds and the other a speed that is written into the
fixture, so both are hit exactly.

**Two are redundant guards, mirrored faithfully from the TS.** Removing
`if onLine.isEmpty then none` from the alight resolver changes nothing, because
the fold it guards already returns `none` on an empty array. Removing `tried`
from `serves` changes nothing observable either: it dedupes candidates within
one `findThroughLine` entry, and since `stationsOnLine` is memoised for the
whole pass, re-confirming a candidate costs no read and gives the same answer.
Both are kept because the source has them, not because they are load-bearing.

**Two are the memo peeks**, for the reason given in the module header: the line
is always already cached when they run, so fetching instead cannot move the
answer or the trace.

`RAIL_JOURNEY_LINES_RADIUS_M` is a separate case — it is not unpinned, but what
pins it is only the read TRACE. The stub answers on track span, exactly as the
real `linesAtPoint` answers on track geometry, and neither consults the radius
to decide membership. It is guarded as a trace value and is not claimed as a
behavioural threshold. -/

end Guards

end Verified.Geo.RailJourney
