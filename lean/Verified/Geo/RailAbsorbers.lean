import Verified.Geo.TubeHop
/-!
# Rail absorbers (port of `src/geo/passes/rail-absorbers.ts`)

List rewrites that clean up the segments around a rail journey, plus the label
parser two of them depend on.

* `absorbDriveStops` — a `driving → short stationary → driving` sandwich with
  almost no steps in the middle never opened the vehicle's doors. Absorb it.
* `absorbInterchanges` — a run of short stationary segments right after a train,
  with the journey continuing past it, is the platform change, not a stay.
  Extend the train over it.
* `relabelWalkingInterchanges` — a short walk between two train legs that share a
  station is the platform-to-platform change, so name it after the station
  rather than whatever street the GPS happened to see.
* `absorbBoardingPlatform` — a short stationary right before a train, AT that
  train's boarding station, is the wait on the platform. Drop it and extend the
  train back over it. `async` in the TS only because the station lookup is an
  OSM call; it arrives here as an injected function, so the pass ports whole.

## `absorbBoardingPlatform` reads the RAW mode, not `effectiveMode`

Every other mode test in this file — and both anchors further down the TS —
goes through `effectiveMode`. This one does not: it tests `train.mode` and
`prev.mode` directly, so a leg the classifier called `driving` and a later pass
refined to `train` does NOT absorb its platform wait. Two guards below pin that
asymmetry; it is faithful to the TS, not a simplification.

## `parseRailWayName` is deliberately NOT reused from `Verified.Geo.Worldline`

`Board → Alight · Line` is parsed by THREE different functions in the TS and
they disagree. `Worldline.parseRailWayName` mirrors **rail-snap's**: strip the
` · Line` suffix FIRST, then find the arrow, trimming both endpoints and
rejecting either when empty. The one `relabelWalkingInterchanges` calls lives in
**rail-reconcile.ts** and does none of that — it finds the ARROW first and looks
for the line separator only in what follows, without trimming and without
rejecting empties:

| input         | rail-snap / `Worldline`    | rail-reconcile (here)          |
|---------------|----------------------------|--------------------------------|
| `"A · X → B"` | `none` (no arrow left)     | board `"A · X"`, alight `"B"`  |
| `" → B"`      | `none` (empty board)       | board `""`, alight `"B"`       |
| `"A → "`      | `none` (empty alight)      | board `"A"`, alight `""`       |
| `" A → B "`   | trimmed                    | NOT trimmed                    |

`relabelWalkingInterchanges` compares `prevRail.alight == nextRail.board`, so
the difference reaches the output — two of the guards below are exactly that
discriminator. Reusing the Lean parser already in the tree would have been a
silent wrong port.

Wholly EXACT — no Float arithmetic anywhere in this module. UNPROVEN; pinned
against Node/V8 (`lean/experiments/rail-absorbers-refs.mts`).
-/

namespace Verified.Geo.RailAbsorbers

open Verified.Geo.TubeHop (NearbyStation pickBestStation)

abbrev Mode := String

/-- A Kalman-filtered fix. `speed_kmh` and `bearing` are carried by the TS type
but read by nothing in this file. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- The `EnrichedSegment` fields these passes read and rewrite. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  wayName : Option String := none
  refinedReason : Option String := none
  pointCount : Int := 10
  deriving Inhabited, BEq, Repr

/-- A per-minute step count. -/
structure StepPoint where
  ts : Int
  steps : Int
  deriving Inhabited, BEq, Repr

def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `parseRailWayName` (rail-reconcile's) -/

def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

/-- `board`, `alight`, and the line when a ` · ` suffix is present.

`line` is an `Option` because the TS field is optional — but note it is
`some ""` for a label ending in a bare separator (`"A → B · "`), which is
PRESENT-but-falsy in JS. `relabelWalkingInterchanges` tests it for truthiness,
not presence, so the distinction is load-bearing and is guarded. -/
structure RailTriple where
  board : String
  alight : String
  line : Option String := none
  deriving Inhabited, BEq, Repr

/-- Split on the FIRST occurrence of `sep`, rejoining the tail — exactly what
`indexOf` + two `slice`s do. `none` when the separator is absent. -/
private def splitFirst (s sep : String) : Option (String × String) :=
  match s.splitOn sep with
  | [] => none
  | [_] => none
  | head :: rest => some (head, String.intercalate sep rest)

/-- rail-reconcile's parser: arrow first, then the line separator in the
remainder. No trimming, and an empty board or alight is accepted. -/
def parseRailWayName (wayName : Option String) : Option RailTriple :=
  match wayName with
  | none => none
  | some w =>
    match splitFirst w RAIL_STATION_SEP with
    | none => none
    | some (board, rest) =>
      match splitFirst rest RAIL_LINE_SEP with
      | none => some { board, alight := rest }
      | some (alight, line) => some { board, alight, line := some line }

/-! ## `absorbDriveStops` -/

/-- Longest a phantom drive-stop can be and still be absorbed. Real brief stops
(drop-off, ATM, quick errand) run a few minutes; longer ones are genuine even if
the user happened not to step out. -/
def DRIVE_STOP_ABSORB_MAX_S : Int := 15 * 60
/-- Even briefly getting out of a car generates a handful of steps, so near-zero
is the biometric tell for "stayed in the vehicle". -/
def DRIVE_STOP_ABSORB_MAX_STEPS : Int := 5
/-- Fixpoint bound, mirroring the TS's `guard < 10`. Also what makes this
structurally recursive rather than `partial`. -/
def DRIVE_STOP_MAX_PASSES : Nat := 10

private def stepsBetween (steps : Array StepPoint) (startTs endTs : Int) : Int :=
  steps.foldl (fun acc p => if p.ts ≥ startTs && p.ts ≤ endTs then acc + p.steps else acc) 0

/-- One left-to-right sweep; also reports whether anything changed. -/
private def driveStopsPass (steps : Array StepPoint) (input : Array Seg) : Array Seg × Bool := Id.run do
  let mut out : Array Seg := #[]
  let mut changed := false
  let mut i := 0
  while h : i < input.size do
    let seg := input[i]
    if effectiveMode seg != "driving" || i + 2 ≥ input.size then
      out := out.push seg
      i := i + 1
    else
      let middle := input[i + 1]!
      let next := input[i + 2]!
      let isPhantomStop :=
        effectiveMode middle == "stationary"
          && effectiveMode next == "driving"
          && middle.endTs - middle.startTs ≤ DRIVE_STOP_ABSORB_MAX_S
          && stepsBetween steps middle.startTs middle.endTs ≤ DRIVE_STOP_ABSORB_MAX_STEPS
      if isPhantomStop then
        out := out.push
          { seg with
            endTs := next.endTs
            pointCount := seg.pointCount + middle.pointCount + next.pointCount }
        i := i + 3
        changed := true
      else
        out := out.push seg
        i := i + 1
  return (out, changed)

/-- Absorb a phantom in-car stop into the drive around it.

If the user actually got out, the watch records steps almost immediately — even
three, from the seat to the kerb. Zero steps over a 5-15 minute "stop" is the
unambiguous tell that the doors never opened.

Run to a FIXPOINT (bounded at 10 passes, as the TS is), because one sweep
consumes three segments at a time: `drive → stop → drive → stop → drive` needs a
second pass to collapse fully. Only fires on the full sandwich, so a stop at the
start or end of a day, or before a longer stay, is left alone. -/
def absorbDriveStops (segments : Array Seg) (steps : Array StepPoint) : Array Seg :=
  go DRIVE_STOP_MAX_PASSES segments
where
  go : Nat → Array Seg → Array Seg
    | 0, current => current
    | n + 1, current =>
      let (out, changed) := driveStopsPass steps current
      if !changed then out else go n out

/-! ## `absorbInterchanges` -/

/-- Longest a single stationary segment can be and still count as part of an
interchange rather than a genuine stay. A platform change or a wait for the next
train runs minutes; a real stay would also have coalesced with its neighbours in
`mergeAdjacentStays` by now. -/
def INTERCHANGE_SEGMENT_MAX_S : Int := 8 * 60

/-- Absorb a transit interchange into the train it follows.

A run of short stationary segments straight after a train, with further movement
after it, is not a stay — it is the platform-to-platform walk, the wait, or an
underground hop the classifier read as stationary because the scattered fixes
barely displaced. Left alone each picks up a spurious place label from whatever
OSM venue is nearest the noisy centroid.

Only fires when the run is non-empty AND the journey continues past it with a
MOVING segment: a run that ends the day, or is stopped by a longer stay, is
where the journey actually finished. -/
def absorbInterchanges (segments : Array Seg) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  let mut i := 0
  while h : i < segments.size do
    let seg := segments[i]
    if effectiveMode seg != "train" then
      out := out.push seg
      i := i + 1
    else
      let mut runEnd := i + 1
      while hr : runEnd < segments.size do
        let s := segments[runEnd]
        if effectiveMode s != "stationary" || s.endTs - s.startTs > INTERCHANGE_SEGMENT_MAX_S then break
        runEnd := runEnd + 1
      let continues := runEnd < segments.size && effectiveMode segments[runEnd]! != "stationary"
      -- `runEnd > i + 1` (a NON-EMPTY run) rather than `≥`. The two are in fact
      -- equivalent — at `runEnd == i + 1` the absorb branch sets
      -- `endTs := segments[i].endTs`, which is `seg`'s own, and advances by one,
      -- exactly what the else branch does — so no guard can tell them apart.
      -- Kept as the TS has it; noted so nobody "simplifies" it later.
      if runEnd > i + 1 && continues then
        out := out.push { seg with endTs := segments[runEnd - 1]!.endTs }
        i := runEnd
      else
        out := out.push seg
        i := i + 1
  return out

/-! ## `relabelWalkingInterchanges` -/

/-- A walk longer than this between two trains is a genuine out-of-station
errand, not a platform change: a line change inside one station is short, going
out to do something and coming back to the same station is not. -/
def INTERCHANGE_WALK_MAX_S : Int := 300

/-- Relabel a short walk sandwiched between two train legs that share a station.

Changing lines is a walk between platforms INSIDE the station. GPS often
resurfaces mid-change, so the segment is correctly `walking` but gets named after
the nearest street the fix happened to see — "Allsop Place" for the 2026-06-16
Baker Street change — which reads as if the user left the station. The two
bounding legs already share a station (A alights where B boards), so a short walk
between them can only be the interchange.

Only the `wayName` and `refinedReason` change: the walk is real, only its
LOCATION was wrong. The line parenthetical is emitted only when BOTH sides carry
a non-empty line, matching the TS's truthiness test — an empty line suffix
parses to `some ""` and is falsy. -/
def relabelWalkingInterchanges (segments : Array Seg) : Array Seg :=
  segments.mapIdx fun i seg =>
    if effectiveMode seg != "walking" then seg
    else if seg.endTs - seg.startTs > INTERCHANGE_WALK_MAX_S then seg
    else if i == 0 then seg
    else match segments[i - 1]?, segments[i + 1]? with
      | some prev, some next =>
        if effectiveMode prev != "train" || effectiveMode next != "train" then seg
        else match parseRailWayName prev.wayName, parseRailWayName next.wayName with
          | some prevRail, some nextRail =>
            if prevRail.alight != nextRail.board then seg
            else
              let station := prevRail.alight
              let lineChange :=
                match prevRail.line, nextRail.line with
                | some p, some n => if p != "" && n != "" then s!" ({p} → {n})" else ""
                | _, _ => ""
              { seg with
                wayName := some s!"{station} (interchange)"
                refinedReason := some s!"walking interchange at {station}{lineChange}" }
          | _, _ => seg
      | _, _ => seg

/-! ## `absorbBoardingPlatform` -/

/-- Longest stationary stretch before a rail run still treated as a platform /
concourse wait. A longer stay at the station is a state of its own. -/
def PLATFORM_WAIT_MAX_S : Int := 15 * 60

/-- The new `startTs` for the train at index `k`, when the segment before it is
this train's platform wait.

The boarding station is read off the train's own label rather than looked up:
`"<board> → <alight>"` is what `annotateRailRuns` and `annotateUndergroundRuns`
both write, so the pass works downstream of either. Note the label is split on
the ARROW alone and nothing is trimmed — the ` · <line>` suffix stays in the
tail, which is discarded.

The point window is EXCLUSIVE at the closing end: the fix sitting exactly on the
`stationary → train` boundary is the ride pulling out, and letting it into the
platform centroid drags the query off the station. -/
private def platformStart (segments : Array Seg) (points : Array Fix)
    (stationsLookup : Float → Float → Array NearbyStation) (k : Nat) : Option Int :=
  let train := segments[k]!
  -- RAW `mode`, not `effectiveMode` — see the module header.
  if train.mode != "train" then none
  else match splitFirst (train.wayName.getD "") RAIL_STATION_SEP with
  | none => none
  | some (boardingStation, _) =>
    let prev := segments[k - 1]!
    if prev.mode != "stationary" then none
    else if prev.endTs - prev.startTs > PLATFORM_WAIT_MAX_S then none
    else
      let segPoints := points.filter fun p => decide (p.ts ≥ prev.startTs) && decide (p.ts < prev.endTs)
      if segPoints.isEmpty then none
      else
        let n := Float.ofNat segPoints.size
        let cLat := (segPoints.foldl (fun a p => a + p.lat) 0) / n
        let cLon := (segPoints.foldl (fun a p => a + p.lon) 0) / n
        match pickBestStation (stationsLookup cLat cLon) with
        | none => none
        | some station => if station.name == boardingStation then some prev.startTs else none

/-- Absorb a platform wait into the boarding of the rail run that follows it.

A short stationary immediately before a `train` whose location resolves to that
train's boarding station is the wait on the platform or concourse — part of
catching the train, not a separate stay. Left standalone it is mislabelled: a
station is not a focus place, so the place-assigner snaps the stay to the
nearest focus place instead (a King's Cross platform wait surfaced as "@ Work",
380 m away). Dropping the stationary and extending the train back over it makes
the timeline read walk → train. -/
def absorbBoardingPlatform (segments : Array Seg) (points : Array Fix)
    (stationsLookup : Float → Float → Array NearbyStation) : Array Seg := Id.run do
  let mut extendTo : Array (Nat × Int) := #[]
  -- Opening at 1 is load-bearing in the TS — `segments[-1]` is `undefined`
  -- there and reading `.mode` off it throws — but UNPINNABLE here: `k - 1`
  -- truncates to `0` on `Nat`, so at `k = 0` the "previous" segment IS the
  -- train, and no segment is both `train` and `stationary`. Kept as the TS has
  -- it, and noted so the vacuity is not mistaken for redundancy.
  for k in [1 : segments.size] do
    match platformStart segments points stationsLookup k with
    | none => pure ()
    | some ts => extendTo := extendTo.push (k, ts)
  -- UNPINNABLE, and provably: with nothing absorbed the rewrite below pushes
  -- every segment unchanged, so the early return saves a pass and decides
  -- nothing. (The TS additionally returns the SAME array object; that identity
  -- is not observable here, and no caller mutates it.) Kept to mirror the TS.
  if extendTo.isEmpty then return segments
  let mut out : Array Seg := #[]
  for idx in [0 : segments.size] do
    -- The platform wait for the train at `idx + 1` is this segment: it goes.
    if extendTo.any (·.1 == idx + 1) then continue
    match extendTo.find? (·.1 == idx) with
    | some (_, ts) => out := out.push { segments[idx]! with startTs := ts }
    | none => out := out.push segments[idx]!
  return out

/-! ## Guards (V8 reference values) -/

private def T (b a : String) (l : Option String := none) : Option RailTriple := some ⟨b, a, l⟩

#guard parseRailWayName (some "Euston Square → Wembley Park · Metropolitan Line")
  == T "Euston Square" "Wembley Park" (some "Metropolitan Line")
#guard parseRailWayName (some "Euston Square → Wembley Park") == T "Euston Square" "Wembley Park"
#guard parseRailWayName (some "Metropolitan Line") == none
#guard parseRailWayName (some "") == none
#guard parseRailWayName none == none
-- The arrow is found FIRST, so a line separator BEFORE it stays inside `board`.
-- rail-snap's parser strips the suffix first, finds no arrow, and returns none.
#guard parseRailWayName (some "A · X → B") == T "A · X" "B"
-- Empty endpoints are ACCEPTED; rail-snap's parser rejects both of these.
#guard parseRailWayName (some " → B") == T "" "B"
#guard parseRailWayName (some "A → ") == T "A" ""
-- Whitespace is NOT trimmed.
#guard parseRailWayName (some " A → B ") == T " A" "B "
-- A bare trailing separator yields a PRESENT but empty line, not `none`.
#guard parseRailWayName (some "A → B · ") == T "A" "B" (some "")
-- Both separators split on the FIRST occurrence with the tail rejoined.
#guard parseRailWayName (some "A → B → C") == T "A" "B → C"
#guard parseRailWayName (some "A → B · L1 · L2") == T "A" "B" (some "L1 · L2")

private def d (a b : Int) (mode : Mode) (pointCount : Int := 10) (refinedMode : Option Mode := none) : Seg :=
  { startTs := a, endTs := b, mode, pointCount, refinedMode }
private def dview (out : Array Seg) : Array (Int × Int × Mode × Int) :=
  out.map fun s => (s.startTs, s.endTs, s.mode, s.pointCount)

-- The sandwich collapses to one drive carrying all three point counts.
#guard dview (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[])
  == #[(0, 1500, "driving", 23)]
-- Six steps inside the stop mean the user got out; five exactly still absorbs.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨650, 6⟩]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨650, 5⟩]).size == 1
-- The step window is INCLUSIVE at both ends, so a bucket sitting exactly on
-- either boundary counts and six steps there veto the absorb.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨900, 6⟩]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨600, 6⟩]).size == 3
-- Steps OUTSIDE the stop window do not count.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"]
    #[⟨0, 60⟩, ⟨300, 60⟩, ⟨599, 60⟩]).size == 1
-- 901 s is past the 15-minute bar; 900 exactly still absorbs.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 1501 "stationary", d 1501 2000 "driving"] #[]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 1500 "stationary", d 1500 2000 "driving"] #[]).size == 1
-- Not bracketed by two drives, and a stop that ENDS the day.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary", d 900 1500 "walking"] #[]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary"] #[]).size == 2
-- TWO stops in a row: the FIXPOINT loop collapses all five into one drive. A
-- single sweep would leave two, since it consumes three segments at a time.
#guard dview (absorbDriveStops
    #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving",
      d 1500 1800 "stationary" 2, d 1800 2400 "driving"] #[])
  == #[(0, 2400, "driving", 35)]
-- effectiveMode: a leg refined to driving participates, and keeps its raw mode.
#guard dview (absorbDriveStops
    #[d 0 600 "train" 10 (some "driving"), d 600 900 "stationary" 3, d 900 1500 "driving"] #[])
  == #[(0, 1500, "train", 23)]
#guard absorbDriveStops #[] #[] == #[]

private def iview (out : Array Seg) : Array (Int × Int × Mode) :=
  out.map fun s => (s.startTs, s.endTs, s.mode)

-- Train, short stationary run, then movement: the train is extended over the
-- run and the run's segments are dropped.
#guard iview (absorbInterchanges
    #[d 0 600 "train", d 600 700 "stationary", d 700 800 "stationary", d 800 1400 "walking"])
  == #[(0, 800, "train"), (800, 1400, "walking")]
-- A run that ENDS the day is where the journey stopped, not an interchange…
#guard (absorbInterchanges #[d 0 600 "train", d 600 700 "stationary"]).size == 2
-- …and neither is one stopped by a longer stay.
#guard (absorbInterchanges
    #[d 0 600 "train", d 600 700 "stationary", d 700 2000 "stationary", d 2000 2400 "walking"]).size == 4
-- 481 s exceeds the per-segment bar so the run is empty; 480 exactly counts.
#guard (absorbInterchanges #[d 0 600 "train", d 600 1081 "stationary", d 1081 1600 "walking"]).size == 3
#guard iview (absorbInterchanges #[d 0 600 "train", d 600 1080 "stationary", d 1080 1600 "walking"])
  == #[(0, 1080, "train"), (1080, 1600, "walking")]
-- No run, and a non-train head: nothing happens.
#guard (absorbInterchanges #[d 0 600 "train", d 600 1200 "walking"]).size == 2
#guard (absorbInterchanges #[d 0 600 "walking", d 600 700 "stationary", d 700 1300 "walking"]).size == 3
-- A platform run BETWEEN two trains is absorbed into the first.
#guard iview (absorbInterchanges #[d 0 600 "train", d 600 700 "stationary", d 700 1300 "train"])
  == #[(0, 700, "train"), (700, 1300, "train")]
#guard absorbInterchanges #[] == #[]

private def MET : String := "Euston Square → Baker Street · Metropolitan Line"
private def JUB : String := "Baker Street → Wembley Park · Jubilee Line"

private def walkBetween (prevWay nextWay : Option String) (walkEnd : Int := 900) : Array Seg :=
  #[{ startTs := 0, endTs := 600, mode := "train", wayName := prevWay },
    { startTs := 600, endTs := walkEnd, mode := "walking", wayName := some "Allsop Place" },
    { startTs := walkEnd, endTs := walkEnd + 600, mode := "train", wayName := nextWay }]

private def rview (out : Array Seg) : Option String × Option String :=
  (out[1]!.wayName, out[1]!.refinedReason)

-- The 2026-06-16 Baker Street case: leg A alights where leg B boards, so the
-- walk between them is the platform change.
#guard rview (relabelWalkingInterchanges (walkBetween (some MET) (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street (Metropolitan Line → Jubilee Line)")
-- The parenthetical needs BOTH lines; with either missing it is dropped.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Euston Square → Baker Street") (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
#guard rview (relabelWalkingInterchanges
    (walkBetween (some "Euston Square → Baker Street") (some "Baker Street → Wembley Park")))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
-- An EMPTY line suffix parses to `some ""` — present but falsy — so it is
-- dropped too. This is the guard that separates truthiness from presence.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Euston Square → Baker Street · ") (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
-- The legs do not share a station: the user really did leave and come back.
#guard rview (relabelWalkingInterchanges
    (walkBetween (some MET) (some "Bond Street → Wembley Park · Jubilee Line")))
  == (some "Allsop Place", none)
-- 301 s is past the bar; 300 exactly still counts.
#guard rview (relabelWalkingInterchanges (walkBetween (some MET) (some JUB) 901)) == (some "Allsop Place", none)
#guard (relabelWalkingInterchanges (walkBetween (some MET) (some JUB) 900))[1]!.wayName
  == some "Baker Street (interchange)"
-- An unparseable or missing label on either side.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Metropolitan Line") (some JUB)))
  == (some "Allsop Place", none)
#guard rview (relabelWalkingInterchanges (walkBetween none (some JUB))) == (some "Allsop Place", none)
-- THE PARSER DISCRIMINATORS. rail-reconcile's parser accepts an empty board, so
-- `" → Baker Street"` alights at Baker Street and pairs with a leg boarding
-- there; and it leaves a pre-arrow line separator inside `board`, so the alight
-- is still clean. rail-snap's parser returns `none` for BOTH, which would leave
-- the walk untouched. These two guards are why this module has its own parser.
#guard (relabelWalkingInterchanges (walkBetween (some " → Baker Street") (some JUB)))[1]!.wayName
  == some "Baker Street (interchange)"
#guard (relabelWalkingInterchanges (walkBetween (some "A · X → Baker Street") (some JUB)))[1]!.wayName
  == some "Baker Street (interchange)"
-- Not sandwiched by two trains, and a walk at index 0 with no previous segment.
#guard (relabelWalkingInterchanges
    #[{ startTs := 0, endTs := 600, mode := "walking" },
      { startTs := 600, endTs := 900, mode := "walking" },
      { startTs := 900, endTs := 1500, mode := "train", wayName := some "Baker Street → Wembley Park" }])[1]!.wayName
  == none
#guard (relabelWalkingInterchanges
    #[{ startTs := 0, endTs := 300, mode := "walking" },
      { startTs := 300, endTs := 900, mode := "train", wayName := some "Baker Street → Wembley Park" }])[0]!.wayName
  == none
#guard relabelWalkingInterchanges #[] == #[]

/-! ### `absorbBoardingPlatform`

The stub answers a station only at the exact coordinates V8 was observed to
query, so the point-averaged centroid is pinned by WHICH query succeeds rather
than asserted — a label built from a `Float` could not cross, since Lean and V8
render one differently. The literals are V8's own digits.
-/

private def stationsAt : Float → Float → Array NearbyStation := fun lat lon =>
  -- At the platform an entrance CODE sits nearer than the station itself, so
  -- `pickBestStation`'s ranking is exercised rather than assumed.
  if lat == 51.52539999999999 && lon == -0.1359 then #[⟨"B2", "station", 5⟩, ⟨"Euston Square", "station", 20⟩]
  else if lat == 51.5271 && lon == -0.1327 then #[⟨"King's Cross St Pancras", "station", 30⟩]
  else if lat == 51.9999 && lon == -0.9999 then #[⟨"Baker Street", "station", 20⟩]
  -- A station with an EMPTY name — the only thing that can tell a REJECTED
  -- missing label apart from one read as an empty boarding station.
  else if lat == 40 && lon == 40 then #[⟨"", "station", 20⟩]
  -- A station at the NaN centroid an empty window would produce: reachable only
  -- if the empty-window guard is gone.
  else if lat.isNaN then #[⟨"Euston Square", "station", 20⟩]
  else #[]

/-- Four fixes whose mean is none of them, so the average is observable. The
last sits exactly ON the stationary's closing boundary, where the exclusive-end
window excludes it — and it is 50 km away, so an inclusive window would resolve
a different station outright. -/
private def platform : Array Fix :=
  #[⟨600, 51.5254, -0.1359⟩, ⟨660, 51.5256, -0.1361⟩, ⟨720, 51.5252, -0.1357⟩, ⟨900, 51.9999, -0.9999⟩]

private def MET_RUN : String := "Euston Square → Baker Street · Metropolitan Line"

private def pstay (a b : Int) (mode : Mode := "stationary") (refinedMode : Option Mode := none) : Seg :=
  { startTs := a, endTs := b, mode, refinedMode, pointCount := 4 }
private def ptrain (a b : Int) (wayName : Option String := some MET_RUN)
    (mode : Mode := "train") (refinedMode : Option Mode := none) : Seg :=
  { startTs := a, endTs := b, mode, refinedMode, wayName, pointCount := 30 }

private def bview (out : Array Seg) : Array (Mode × Int × Int) :=
  out.map fun s => (s.mode, s.startTs, s.endTs)
private def absorb (segs : Array Seg) (pts : Array Fix := platform) : Array (Mode × Int × Int) :=
  bview (absorbBoardingPlatform segs pts stationsAt)

-- The wait resolves to the train's own boarding station: it goes, and the train
-- opens where the wait did.
#guard absorb #[pstay 600 900, ptrain 900 1800] == #[("train", 600, 1800)]
-- A station that is not THIS train's boarding station changes nothing.
#guard absorb #[pstay 600 900, ptrain 900 1800 (some "Baker Street → Wembley Park · Metropolitan Line")]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
-- Nothing near the centroid.
#guard absorb #[pstay 600 900, ptrain 900 1800] #[⟨600, 0, 0⟩, ⟨660, 0, 0⟩]
  == #[("stationary", 600, 900), ("train", 900, 1800)]

-- What disqualifies the pair.
#guard absorb #[pstay 600 900, ptrain 900 1800 (some "Metropolitan Line")]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
#guard absorb #[pstay 600 900, ptrain 900 1800 none] == #[("stationary", 600, 900), ("train", 900, 1800)]
#guard absorb #[pstay 600 900 "walking", ptrain 900 1800] == #[("walking", 600, 900), ("train", 900, 1800)]
-- The scan opens at index 1, so a train that starts the day has no wait to take.
#guard absorb #[ptrain 900 1800] == #[("train", 900, 1800)]
-- An empty window would average 0/0 = NaN. The stub answers a station AT NaN,
-- so without the guard the pass would absorb off a query it must never make.
#guard absorb #[pstay 600 900, ptrain 900 1800] #[⟨1000, 51.5254, -0.1359⟩]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
-- A MISSING label is rejected, not read as an empty boarding station: the
-- station here really is named `""`, and the wait still survives…
#guard absorb #[pstay 600 900, ptrain 900 1800 none] #[⟨700, 40, 40⟩]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
-- …whereas a label that genuinely parses to an empty board absorbs there.
#guard absorb #[pstay 600 900, ptrain 900 1800 (some " → Baker Street")] #[⟨700, 40, 40⟩]
  == #[("train", 600, 1800)]

-- 900 s exactly is still a platform wait; 901 s is a stay of its own.
#guard absorb #[pstay 0 900, ptrain 900 1800] == #[("train", 0, 1800)]
#guard absorb #[pstay (-1) 900, ptrain 900 1800] == #[("stationary", -1, 900), ("train", 900, 1800)]

-- RAW mode, not effectiveMode: neither side participates on a refinement alone.
#guard absorb #[pstay 600 900, ptrain 900 1800 (some MET_RUN) "driving" (some "train")]
  == #[("stationary", 600, 900), ("driving", 900, 1800)]
#guard absorb #[pstay 600 900 "walking" (some "stationary"), ptrain 900 1800]
  == #[("walking", 600, 900), ("train", 900, 1800)]

-- THE WINDOW DISCRIMINATOR. The boundary fix at 900 is excluded above; widen the
-- stationary by one second so the same fix falls strictly inside, and it is the
-- ONLY sample — the query moves 50 km and resolves Baker Street instead.
#guard absorb #[pstay 600 901, ptrain 901 1800 (some "Baker Street → Wembley Park")] #[⟨900, 51.9999, -0.9999⟩]
  == #[("train", 600, 1800)]

-- Shape: neighbours survive, and two waits in one day both absorb.
#guard absorb #[{ startTs := 0, endTs := 600, mode := "walking" }, pstay 600 900, ptrain 900 1800,
                { startTs := 1800, endTs := 2400, mode := "walking" }]
  == #[("walking", 0, 600), ("train", 600, 1800), ("walking", 1800, 2400)]
#guard absorb
    #[pstay 600 900, ptrain 900 1800, pstay 1800 2100,
      ptrain 2100 3000 (some "King's Cross St Pancras → Farringdon · Circle Line")]
    (platform ++ #[⟨1800, 51.5271, -0.1327⟩, ⟨1900, 51.5271, -0.1327⟩])
  == #[("train", 600, 1800), ("train", 1800, 3000)]
#guard absorb #[{ startTs := 0, endTs := 600, mode := "walking" }] == #[("walking", 0, 600)]
#guard absorb #[] == #[]

-- The train keeps every other field; only `startTs` moves.
#guard absorbBoardingPlatform
    #[pstay 600 900, { ptrain 900 1800 with refinedReason := some "earlier note" }] platform stationsAt
  == #[{ startTs := 600, endTs := 1800, mode := "train", wayName := some MET_RUN, pointCount := 30,
         refinedReason := some "earlier note" }]

end Verified.Geo.RailAbsorbers
