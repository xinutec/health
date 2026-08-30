import Verified.Geo.SegmentMerge
import Verified.Geo.TubeHop
import Verified.Geo.LineMembership
-- For `meanCadenceSpm` / `PEDESTRIAN_MIN_CADENCE_SPM`: cadence is what decides a
-- ride tail, and the pedestrian floor is the worldline module's to define.
import Verified.Geo.Worldline
-- For `statsOverWindow`: an anchor that moves a walk's boundary owes that walk a
-- fresh summary, and the summary rule is shared with the other two passes that
-- move boundaries (#424).
import Verified.Geo.SegmentUtil
import Verified.JsNum
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

/-- A Kalman-filtered fix. `bearing` is carried by the TS type but read by nothing
in this file.

`speedKmh` IS read, as of #424 — by the two anchors, which recompute the
kinematics of the walk whose boundary they moved. It was omitted while they did
not, and its absence is exactly why they did not: the summary they needed to
recompute is derived from it. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  deriving Inhabited, BEq, Repr

/-- The fix as `Verified.Geo.SegmentUtil` types it — a rename, field for field. -/
def Fix.toPointF (f : Fix) : Shed.PointF :=
  { ts := f.ts, lat := f.lat, lon := f.lon, speedKmh := f.speedKmh }

/-- `statsOverWindow` over this module's fix type. -/
def windowStats (points : Array Fix) (startTs endTs : Int)
    (excludeStart : Bool := false) : Verified.Geo.SegmentUtil.WindowStats :=
  Verified.Geo.SegmentUtil.statsOverWindow (points.map Fix.toPointF) startTs endTs excludeStart

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- Re-summarise a segment whose window just changed. The four fields are exactly
the ones TS's `{ ...walk, ...statsOverWindow(...) }` spreads. -/
def applyStats (s : Seg) (st : Verified.Geo.SegmentUtil.WindowStats) : Seg :=
  { s with pointCount := st.pointCount, avgSpeed := st.avgSpeed,
           maxSpeed := st.maxSpeed, linearity := st.linearity }

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

/-- The ` · <line>` suffix a rewritten label carries, or nothing. The TS tests
`rail.line` for TRUTHINESS, so a label ending in a bare separator — which parses
to `some ""` — gets no suffix back. -/
private def lineSuffix : Option String → String
  | some l => if l == "" then "" else s!"{RAIL_LINE_SEP}{l}"
  | none => ""

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

/-! ## The two walk-anchored re-anchors

`anchorTrainBoardingToWalkedStation` and `anchorTrainAlightToWalkedStation` are
mirror images: when GPS goes dark in a tunnel the reconstruction pins a rail
leg's boundary where the fixes are clean, which is a stop or two off the real
one, and the missing ride is stranded as a vehicle-paced RUN at the tail of the
preceding walk (boarding) or the head of the following one (alight). Each anchor
finds that run, moves the boundary to it, and rewrites the label.

Their three OSM lookups all arrive as injected functions, so the decisions port
whole; only the awaiting is shell.

### They are NOT symmetric, in three ways

1. **Which run.** Boarding takes the FIRST qualifying run and `break`s out of the
   scan once it has ended — coming out of a platform the train accelerates, so
   the earliest qualifying run is the departure. Alight takes the LAST, because
   GPS routinely sticks at an intermediate surfaced station while the train
   keeps going.
2. **Where the boundary lands.** Boarding cuts at `fixes[split - 1]`, the fix
   BEFORE the run; alight cuts at `fixes[settle]`, the fix the run ENDS on.
3. **When the line veto applies.** Boarding gates `lineCannotServe` on
   `!sameBoard`, so an unserving label does not stop a same-station extension —
   that changes no name. Alight tests it BEFORE deciding whether the station is a
   rename, so an unserving line stops the extension too. Both are guarded.

### `Math.round` on a non-negative distance

The reason strings quote `Math.round(d)`. `jsRound` here is `floor (x + 0.5)`,
which is `Math.round` exactly; the two differ only at negative halves, and a
haversine distance is never negative.
-/

open Verified.JsNum (jsRound)
private def metres (x : Float) : String := toString (jsRound x).toInt64.toInt

/-- Great-circle metres. Deliberately NOT `Verified.Hsmm.FloatScore`'s: that one
associates the final product as `((cos·cos)·sin)·sin`, and `place-snap.ts` — the
copy these passes import — writes `Math.sin(dLon/2) ** 2` as its own factor.

The grouping is UNPINNABLE from here and always will be: it moves the result by
about one ULP, and everything this module publishes is a distance passed through
`Math.round`. Faithful anyway, because the value also feeds `≥ 250` and
`≥ 15 km/h` comparisons, where a fixture sitting exactly on a bar WOULD see it —
the corpus simply has no such fixture. Do not "simplify" it to the shared copy. -/
private def haversineMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let R := 6371000.0
  let pi := 3.141592653589793
  let dLat := (lat2 - lat1) * pi / 180.0
  let dLon := (lon2 - lon1) * pi / 180.0
  let sLat := Float.sin (dLat / 2.0)
  let sLon := Float.sin (dLon / 2.0)
  let a := sLat * sLat + Float.cos (lat1 * pi / 180.0) * Float.cos (lat2 * pi / 180.0) * (sLon * sLon)
  R * 2.0 * Float.atan2 (Float.sqrt a) (Float.sqrt (1.0 - a))

private def fixDist (a b : Fix) : Float := haversineMeters a.lat a.lon b.lat b.lon

/-- Step speed in km/h. A zero-duration step scores 0 rather than dividing —
`dt > 0 ? … : 0` in the TS. -/
private def stepKmh (a b : Fix) : Float :=
  let dt := b.ts - a.ts
  if dt > 0 then fixDist a b / Float.ofInt dt * 3.6 else 0

/-- INCLUSIVE at both ends, unlike `absorbBoardingPlatform`'s window. The step
straddling the walk↔train boundary is the ride itself, and the kinematic
invariant charges it to this leg — a pass that cannot see it is blind to exactly
the evidence the invariant reports. -/
private def samplesInWindow (points : Array Fix) (s : Seg) : Array Fix :=
  points.filter fun p => decide (p.ts ≥ s.startTs) && decide (p.ts ≤ s.endTs)

/-! ### `anchorTrainBoardingToWalkedStation` -/

/-- Min step speed for a walk-tail fix to count as the train pulling out rather
than a walking step. Well above any run. -/
def BOARDING_HOP_MIN_KMH : Float := 15
/-- …and the run must cover a real inter-station distance, not a few metres of
acceleration as the doors close. -/
def BOARDING_HOP_MIN_DIST_M : Float := 250

/-- The index of the fix the train should open at, plus how many consecutive
fast steps backed the run — the `split` / `hopRunSteps` pair.

The FIRST qualifying run, not the last: the surfaced fix often settles into a
slow one as the train decelerates into the next station, so a from-the-end scan
would miss the departure. A RUN, not a single step: coming out of a platform the
train is still accelerating, so the first observed steps are short (76 m, 86 m on
2026-07-01) and each falls under the distance bar on its own while the run covers
981 m. The run qualifies once its NET displacement clears the bar. -/
private def boardingHop (fixes : Array Fix) : Int × Nat := Id.run do
  let mut split : Int := -1
  let mut hopRunSteps : Nat := 0
  let mut runStart : Int := -1
  for i in [1 : fixes.size] do
    if stepKmh fixes[i - 1]! fixes[i]! ≥ BOARDING_HOP_MIN_KMH then
      if runStart < 0 then runStart := Int.ofNat i - 1
      let rs := runStart.toNat
      -- `split < 0` is UNPINNABLE, and doubly so: within one run `runStart` is
      -- constant, so re-assigning `split` would write the same value, and the
      -- `break` below means a SECOND run is never reached. The two guards are
      -- mutually redundant; the break is the one with observable consequences
      -- (it also freezes `hopRunSteps`), and it is guarded.
      if split < 0 && fixDist fixes[rs]! fixes[i]! ≥ BOARDING_HOP_MIN_DIST_M then split := runStart + 1
      if split ≥ 0 then hopRunSteps := i - rs
    else
      -- The qualifying run has ended; nothing later can be the departure.
      if split ≥ 0 then break
      runStart := -1
  return (split, hopRunSteps)

/-- Re-anchor an underground train's boarding to the station the preceding walk
delivered the rider to, reclaiming the first inter-station hop the reconstruction
stranded in the walk.

When the GPS first surfaces a stop or two into a tunnel, `annotateUndergroundRuns`
anchors the boarding to the first fix it can snap to the rail line — which can be
one or two stations past where the rider actually boarded. The walk before it
keeps a fast tail: the train pulling out of the real boarding station. So the
drawn walk bleeds hundreds of metres onto the next station (2026-06-23 Hospital U →
Euston Square, where the walk drew on to Great Portland Street and the boarding
read "Baker Street", two stops late).

The scanned station EQUALLING the label is not "nothing to do": the rename is a
no-op but the hop is still stranded in the walk, where the kinematic invariant
reads it as vehicle-paced walking. Extend the boundary in both cases — but the
same-station extension demands DENSE evidence (≥ 2 consecutive fast steps), since
a lone fast step landing back at the labelled board is the stuck-GPS signature
and extending there eats a real walk's tail. -/
def anchorTrainBoardingToWalkedStation (segments : Array Seg) (points : Array Fix)
    (stationsLookup : Float → Float → Array NearbyStation)
    (servedLookup : String → Array LineMembership.ServedStation) : Array Seg := Id.run do
  let mut out := segments
  for k in [1 : out.size] do
    let train := out[k]!
    if effectiveMode train != "train" then continue
    match parseRailWayName train.wayName with
    | none => continue
    | some rail =>
      let walk := out[k - 1]!
      if effectiveMode walk != "walking" then continue
      -- Continuity guard (2026-06-24 Wembley Park → Euston Square): a walk
      -- bracketed by a preceding train is an underground-reconstruction
      -- artifact, not a walk-to-station. Its "boarding hop" is the SAME ride
      -- continuing, so re-anchoring here would invent a rail discontinuity —
      -- which also defeats `assembleRailJourney`'s single-line merge. Boarding
      -- continuity there is owned by the journey assembler, not by this pass.
      if k ≥ 2 && effectiveMode out[k - 2]! == "train" then continue
      let fixes := samplesInWindow points walk
      if fixes.size < 4 then continue
      let (split, hopRunSteps) := boardingHop fixes
      -- `< 1` rather than `< 0`, and UNPINNABLE: `split` is either -1 or
      -- `runStart + 1` for a non-negative `runStart`, so 0 never occurs. The
      -- form is the TS's, and it reads as "there is a fix BEFORE the run".
      if split < 1 then continue
      let boardFix := fixes[split.toNat - 1]!
      -- A lone GPS spike that returns is not a relocation onto the tube: the
      -- walk must actually END away from the boarding fix.
      let tailDist := fixDist boardFix fixes[fixes.size - 1]!
      if tailDist < BOARDING_HOP_MIN_DIST_M then continue
      match pickBestStation (stationsLookup boardFix.lat boardFix.lon) with
      | none => continue
      | some station =>
        let sameBoard := station.name == rail.board
        if sameBoard && hopRunSteps < 2 then continue
        -- Only the RENAME is gated. The scan sees whatever the walk's terminal
        -- fix is near, and at an interchange that is several lines' stations;
        -- being there is not boarding THIS one. A boundary that reclaims a
        -- stranded hop is right whether or not the label is, so the
        -- same-station case skips the veto entirely.
        if !sameBoard then
          match rail.line with
          | some line =>
            if line != "" && LineMembership.lineCannotServe line station.name servedLookup then continue
          | none => pure ()
        let reason :=
          if sameBoard then
            s!"boarding boundary extended back to the {station.name} departure — reclaimed a {metres tailDist} m hop the underground reconstruction had left in the walk"
          else
            s!"boarding re-anchored to {station.name} (walk's terminal station) — reclaimed a {metres tailDist} m hop the underground reconstruction had left in the walk (was boarding {rail.board})"
        -- Mirror of the alight side: the reclaimed hop belongs to the ride now,
        -- so it must stop counting toward the walk's peak. No `excludeStart` —
        -- nothing precedes this walk's start, only its END moved.
        out := out.set! (k - 1)
          (applyStats { walk with endTs := boardFix.ts }
            (windowStats points walk.startTs boardFix.ts))
        out := out.set! k
          { train with
              startTs := boardFix.ts
              wayName :=
                if sameBoard then train.wayName
                else some s!"{station.name} → {rail.alight}{lineSuffix rail.line}"
              refinedReason :=
                match train.refinedReason with
                | some r => some s!"{r}; {reason}"
                | none => some reason }
  return out

/-! ### `anchorTrainAlightToWalkedStation` -/

/-- Min step speed for a LEADING walk-fix to count as the train still riding in.
Mirrors `BOARDING_HOP_MIN_KMH`. -/
def ALIGHT_HOP_MIN_KMH : Float := 15
/-- The leading fast run must cover a real inter-station distance. -/
def ALIGHT_HOP_MIN_DIST_M : Float := 250

/-- The index of the fix the train should close at, plus how many consecutive
fast steps backed it.

The LAST qualifying run — never the first — because GPS routinely "sticks" at an
intermediate surfaced station (a slow cluster) while the train keeps going. Note
there is no `break` here and no `split < 0` test on the update: every qualifying
run overwrites the previous one. -/
private def alightSettle (fixes : Array Fix) : Int × Nat := Id.run do
  let mut settle : Int := -1
  let mut settleRunSteps : Nat := 0
  let mut runStart : Int := -1
  for i in [1 : fixes.size] do
    if stepKmh fixes[i - 1]! fixes[i]! ≥ ALIGHT_HOP_MIN_KMH then
      if runStart < 0 then runStart := Int.ofNat i - 1
      let rs := runStart.toNat
      if fixDist fixes[rs]! fixes[i]! ≥ ALIGHT_HOP_MIN_DIST_M then
        settle := Int.ofNat i
        settleRunSteps := i - rs
    else
      runStart := -1
  return (settle, settleRunSteps)

/-- Re-anchor an underground train's ALIGHT to the station the following walk's
leading hop reached — the mirror of `anchorTrainBoardingToWalkedStation`.

When GPS goes dark in a tunnel the train closes at the last clean fix (the
surfaced station), and the continued ride to the true disembark a stop or two on
the SAME line is stranded as the FAST leading fixes of the next "walking"
segment. The 2026-06-29 outbound: Wembley Park → Baker Street pinned where GPS
reappeared, then a "15-minute walk" whose first hop is the Metropolitan still
doing ~50 km/h on to Euston Square.

Two line gates, asking different questions. The first says the hop stayed on the
run's corridor: the surfaced and settled fixes must share a line, compared after
`expandTubeLineNames` canonicalises directional and combined relation names. The
second says this leg can actually stop there: a corridor shared with a line
running alongside the tube for miles satisfies the first while saying nothing
about the line the leg is LABELLED with. Without it the anchor turned the
2026-06-28 return into a "North London line" ride alighting 7.1 km away at
Wembley Park (#377). -/
def anchorTrainAlightToWalkedStation (segments : Array Seg) (points : Array Fix)
    (steps : List Verified.Geo.Worldline.FeasibilityStepPoint)
    (stationsLookup : Float → Float → Array NearbyStation)
    (servedLookup : String → Array LineMembership.ServedStation) : Array Seg := Id.run do
  let mut out := segments
  if out.isEmpty then return out
  for k in [0 : out.size - 1] do
    let train := out[k]!
    if effectiveMode train != "train" then continue
    match parseRailWayName train.wayName with
    | none => continue
    | some rail =>
      let walk := out[k + 1]!
      if effectiveMode walk != "walking" then continue
      -- Interchange guard, the mirror of the boarding side: train → walk →
      -- train is a sliver, and its leading hop is the NEXT train pulling out,
      -- not this one riding in.
      if k + 2 < out.size && effectiveMode out[k + 2]! == "train" then continue
      let fixes := samplesInWindow points walk
      if fixes.size < 3 then continue
      let (settle, settleRunSteps) := alightSettle fixes
      -- Same vacuity as the boarding side: `settle` is -1 or an `i ≥ 1`.
      if settle < 1 then continue
      let alightFix := fixes[settle.toNat]!
      let surfaced := fixes[0]!
      if fixDist surfaced alightFix < ALIGHT_HOP_MIN_DIST_M then continue
      match pickBestStation (stationsLookup alightFix.lat alightFix.lon) with
      | none => continue
      | some station =>
        -- The line-continuity guard that stood here is GONE (TS `16fcbe3`). It
        -- required the settled station and the surfaced fix to share a line,
        -- which presumes a line identifier is stable along a route: true of the
        -- tube mirror, false of per-section names, so it refused every such
        -- alight by construction. Ablated over 35 days it moved nothing but one
        -- leg. Removing it also removes this pass's ONLY `linesAtPoint` asks —
        -- which is why keeping it here turned the day gate into 25 LOOKUP MISS
        -- days: the fold asked for keys the TS arm no longer requests, so the
        -- table never carried them.
        -- Applied BEFORE the rename decision, unlike the boarding side.
        match rail.line with
        | some line =>
          if line != "" && LineMembership.lineCannotServe line station.name servedLookup then continue
        | none => pure ()
        let hopM := metres (fixDist surfaced alightFix)
        let sameAlight := station.name == rail.alight
        -- CADENCE, not step count, decides a ride tail (TS `dd72209`). A single
        -- fast step landing at the already-labelled alight is ambiguous: it is
        -- either a ride still running through a blackout, or stale fixes
        -- teleporting to catch up with a rider already walking. The step COUNT
        -- cannot separate those — the pedometer can. Refuse only when the rider
        -- was demonstrably walking, or when there is no cadence to read at all.
        let cadence :=
          if sameAlight then Verified.Geo.Worldline.meanCadenceSpm steps surfaced.ts alightFix.ts else none
        let wasWalking :=
          match cadence with
          | some c => decide (c ≥ Verified.Geo.Worldline.PEDESTRIAN_MIN_CADENCE_SPM)
          | none => false
        let singleStepRefusal :=
          sameAlight && settleRunSteps < 2 && (match cadence with | none => true | some _ => wasWalking)
        if singleStepRefusal then continue
        let reason :=
          if sameAlight then
            s!"alight boundary extended to the {station.name} arrival — reclaimed a {hopM} m ride tail the early cut left in the walk"
          else
            s!"alight re-anchored to {station.name} (walk's leading hop reached it) — reclaimed a {hopM} m hop the GPS blackout left in the walk (was alighting {rail.alight})"
        out := out.set! k
          { train with
              endTs := alightFix.ts
              wayName :=
                if sameAlight then train.wayName
                else some s!"{rail.board} → {station.name}{lineSuffix rail.line}"
              refinedReason :=
                match train.refinedReason with
                | some r => some s!"{r}; {reason}"
                | none => some reason }
        -- The hop just moved into the ride, so it is no longer the walk's to
        -- report. Leaving the summary alone left a walk claiming a 187.2 km/h
        -- peak — the reclaimed blackout hop — long after the fix that produced
        -- it had been handed to the train. `excludeStart` because the ride owns
        -- its arrival fix.
        out := out.set! (k + 1)
          (applyStats { walk with startTs := alightFix.ts }
            (windowStats points alightFix.ts walk.endTs (excludeStart := true)))
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
  if lat == 51.52539999999999 && lon == -0.1359 then #[{ name := "B2", subtype := "station", distanceM := 5 }, { name := "Euston Square", subtype := "station", distanceM := 20 }]
  else if lat == 51.5271 && lon == -0.1327 then #[{ name := "King's Cross St Pancras", subtype := "station", distanceM := 30 }]
  else if lat == 51.9999 && lon == -0.9999 then #[{ name := "Baker Street", subtype := "station", distanceM := 20 }]
  -- A station with an EMPTY name — the only thing that can tell a REJECTED
  -- missing label apart from one read as an empty boarding station.
  else if lat == 40 && lon == 40 then #[{ name := "", subtype := "station", distanceM := 20 }]
  -- A station at the NaN centroid an empty window would produce: reachable only
  -- if the empty-window guard is gone.
  else if lat.isNaN then #[{ name := "Euston Square", subtype := "station", distanceM := 20 }]
  else #[]

/-- Four fixes whose mean is none of them, so the average is observable. The
last sits exactly ON the stationary's closing boundary, where the exclusive-end
window excludes it — and it is 50 km away, so an inclusive window would resolve
a different station outright. -/
private def platform : Array Fix :=
  #[⟨600, 51.5254, -0.1359, 0⟩, ⟨660, 51.5256, -0.1361, 0⟩, ⟨720, 51.5252, -0.1357, 0⟩, ⟨900, 51.9999, -0.9999, 0⟩]

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
#guard absorb #[pstay 600 900, ptrain 900 1800] #[⟨600, 0, 0, 0⟩, ⟨660, 0, 0, 0⟩]
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
#guard absorb #[pstay 600 900, ptrain 900 1800] #[⟨1000, 51.5254, -0.1359, 0⟩]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
-- A MISSING label is rejected, not read as an empty boarding station: the
-- station here really is named `""`, and the wait still survives…
#guard absorb #[pstay 600 900, ptrain 900 1800 none] #[⟨700, 40, 40, 0⟩]
  == #[("stationary", 600, 900), ("train", 900, 1800)]
-- …whereas a label that genuinely parses to an empty board absorbs there.
#guard absorb #[pstay 600 900, ptrain 900 1800 (some " → Baker Street")] #[⟨700, 40, 40, 0⟩]
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
#guard absorb #[pstay 600 901, ptrain 901 1800 (some "Baker Street → Wembley Park")] #[⟨900, 51.9999, -0.9999, 0⟩]
  == #[("train", 600, 1800)]

-- Shape: neighbours survive, and two waits in one day both absorb.
#guard absorb #[{ startTs := 0, endTs := 600, mode := "walking" }, pstay 600 900, ptrain 900 1800,
                { startTs := 1800, endTs := 2400, mode := "walking" }]
  == #[("walking", 0, 600), ("train", 600, 1800), ("walking", 1800, 2400)]
#guard absorb
    #[pstay 600 900, ptrain 900 1800, pstay 1800 2100,
      ptrain 2100 3000 (some "King's Cross St Pancras → Farringdon · Circle Line")]
    (platform ++ #[⟨1800, 51.5271, -0.1327, 0⟩, ⟨1900, 51.5271, -0.1327, 0⟩])
  == #[("train", 600, 1800), ("train", 1800, 3000)]
#guard absorb #[{ startTs := 0, endTs := 600, mode := "walking" }] == #[("walking", 0, 600)]
#guard absorb #[] == #[]

-- The train keeps every other field; only `startTs` moves.
#guard absorbBoardingPlatform
    #[pstay 600 900, { ptrain 900 1800 with refinedReason := some "earlier note" }] platform stationsAt
  == #[{ startTs := 600, endTs := 1800, mode := "train", wayName := some MET_RUN, pointCount := 30,
         refinedReason := some "earlier note" }]

/-! ### The two walk-anchored re-anchors

Every fixture sits on the -0.14 meridian, so the lookups discriminate on
latitude alone, and every queried coordinate is a fixture LITERAL rather than a
computed one — nothing has to survive being rendered as a string.

Step geometry, from V8's own `haversineMeters`:

| step                | metres |
|---------------------|--------|
| 51.5 → 51.5003      |  33.36 |
| 51.5 → 51.5014      | 155.67 |
| 51.5 → 51.5028      | 311.35 |
| 51.5 → 51.5059      | 656.05 |
| 51.5006 → 51.502    | 155.67 |
| 51.5006 → 51.5036   | 333.58 |
| 51.5006 → 51.5048   | 467.02 |
| 51.5006 → 51.5008   |  22.24 |
-/

private def METLINE : String := "Metropolitan Line"
private def NLL : String := "North London Line"

private def aStations : Float → Float → Array NearbyStation := fun lat lon =>
  if lon == -0.139 then #[{ name := "Euston Square", subtype := "station", distanceM := 20 }]
  else if lon != -0.14 then #[]
  else if lat == 51.5006 then #[{ name := "Euston Square", subtype := "station", distanceM := 20 }]
  else if lat == 51.5001 then #[{ name := "Euston Square", subtype := "station", distanceM := 20 }]
  else if lat == 51.5028 then #[{ name := "Great Portland Street", subtype := "station", distanceM := 25 }]
  else if lat == 51.5031 then #[{ name := "Great Portland Street", subtype := "station", distanceM := 30 }]
  else if lat == 51.5059 then #[{ name := "Baker Street", subtype := "station", distanceM := 15 }]
  else #[]

/-- Directional and combined relation names on purpose: the corridor test
intersects EXPANDED components, not the raw strings. -/
private def aLines : Float → Float → Array String := fun lat _ =>
  if lat == 51.5 then #["Metropolitan Line Northbound"]
  else if lat == 51.5001 then #[METLINE]
  else if lat == 51.5028 then #["Circle, Hammersmith & City and Metropolitan Lines"]
  else if lat == 51.5031 then #[METLINE]
  else if lat == 51.5059 then #[METLINE]
  else #[]

/-- The EMPTY line name answers a non-empty list excluding every station here,
so a caller that consults the mirror for a PRESENT-but-empty label gets a veto.
That is what makes the TS's `rail.line &&` TRUTHINESS test observable: with the
test, an empty line is never asked about; without it, the rewrite is refused. -/
private def aServed : String → Array LineMembership.ServedStation := fun line =>
  if line == METLINE then #[⟨"Euston Square"⟩, ⟨"Great Portland Street"⟩, ⟨"Baker Street"⟩]
  else if line == NLL then #[⟨"Finchley Road & Frognal"⟩, ⟨"West Hampstead"⟩]
  else if line == "" then #[⟨"Nowhere"⟩]
  else #[]

private def f (ts : Int) (lat : Float) (speedKmh : Float := 0) : Fix := ⟨ts, lat, -0.14, speedKmh⟩
/-- An EAST-WEST fix: one latitude throughout, so the haversine's two arguments
cannot be swapped without the distance changing. -/
private def ef (ts : Int) (lon : Float) : Fix := ⟨ts, 51.5, lon, 0⟩
private def aseg (a b : Int) (mode : Mode) (wayName : Option String := none)
    (refinedMode : Option Mode := none) (refinedReason : Option String := none) : Seg :=
  { startTs := a, endTs := b, mode, wayName, refinedMode, refinedReason }
private def awalk (a b : Int) (refinedMode : Option Mode := none) (mode : Mode := "walking") : Seg :=
  aseg a b mode none refinedMode
private def atrain (a b : Int) (wayName : Option String) (refinedMode : Option Mode := none)
    (mode : Mode := "train") (refinedReason : Option String := none) : Seg :=
  aseg a b mode wayName refinedMode refinedReason

/-- Boundaries, labels and reasons — everything either anchor writes. -/
private def aview (out : Array Seg) : Array (Int × Int × Option String × Option String) :=
  out.map fun s => (s.startTs, s.endTs, s.wayName, s.refinedReason)

private def board (segs : Array Seg) (pts : Array Fix) :=
  aview (anchorTrainBoardingToWalkedStation segs pts aStations aServed)
private def alight (segs : Array Seg) (pts : Array Fix)
    (steps : List Verified.Geo.Worldline.FeasibilityStepPoint := [])
    (stations : Float → Float → Array NearbyStation := aStations) :=
  aview (anchorTrainAlightToWalkedStation segs pts steps stations aServed)

/-- Slow, slow, then a TWO-step vehicle-paced run: the boarding hop. -/
private def boardWalk : Array Fix :=
  #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 150 51.502, f 180 51.5034, f 240 51.5048]
/-- The same, but the run is ONE step long. -/
private def boardWalk1 : Array Fix := #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 150 51.5036, f 210 51.504]
/-- The hop returns to where it left: a GPS spike, not a relocation. -/
private def boardBounce : Array Fix := #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 150 51.5036, f 210 51.5008]

private def RENAME_467 : String :=
  "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 467 m hop the underground reconstruction had left in the walk (was boarding Baker Street)"
private def SAME_467 : String :=
  "boarding boundary extended back to the Euston Square departure — reclaimed a 467 m hop the underground reconstruction had left in the walk"
private def BAKER (line : String := s!" · {METLINE}") : Option String := some s!"Baker Street → Wembley Park{line}"
private def EUSTON (line : String := s!" · {METLINE}") : Option String := some s!"Euston Square → Wembley Park{line}"

-- The walk's tail reached Euston Square: the boundary moves back to the fix
-- before the hop, and the label is rewritten from two stops down the line.
#guard board #[awalk 0 240, atrain 240 900 (BAKER)] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON, some RENAME_467)]
-- The scanned station EQUALLING the label still moves the boundary — the hop is
-- stranded either way; only the rename is a no-op.
#guard board #[awalk 0 240, atrain 240 900 (EUSTON)] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON, some SAME_467)]
-- …but the same-station extension demands a run of at least TWO fast steps: a
-- lone one landing back at the labelled board is the stuck-GPS signature.
#guard board #[awalk 0 210, atrain 210 900 (EUSTON)] boardWalk1
  == #[(0, 210, none, none), (210, 900, EUSTON, none)]
-- A RENAME keeps working on a single blackout hop: it is anchored by a
-- DIFFERENT station the walk demonstrably reached.
#guard board #[awalk 0 210, atrain 210 900 (BAKER)] boardWalk1
  == #[(0, 120, none, none), (120, 900, EUSTON,
        some "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 378 m hop the underground reconstruction had left in the walk (was boarding Baker Street)")]
-- No line in the label: no veto to consult, and no suffix to write back.
#guard board #[awalk 0 240, atrain 240 900 (BAKER "")] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON "", some RENAME_467)]
-- THE #351 GUARD: a rename may only name a station this leg's line serves.
#guard board #[awalk 0 240, atrain 240 900 (BAKER s!" · {NLL}")] boardWalk
  == #[(0, 240, none, none), (240, 900, BAKER s!" · {NLL}", none)]
-- …and the veto is gated on `!sameBoard`, so it does NOT stop an extension that
-- changes no name. Its ALIGHT twin orders these the other way round.
#guard board #[awalk 0 240, atrain 240 900 (EUSTON s!" · {NLL}")] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON s!" · {NLL}", some SAME_467)]
-- The walk must END away from the boarding fix: 22 m back is a spike.
#guard board #[awalk 0 210, atrain 210 900 (BAKER)] boardBounce
  == #[(0, 210, none, none), (210, 900, BAKER, none)]
-- Too few fixes, and no vehicle-paced run at all.
#guard board #[awalk 0 120, atrain 120 900 (BAKER)] boardWalk
  == #[(0, 120, none, none), (120, 900, BAKER, none)]
#guard board #[awalk 0 120, atrain 120 900 (BAKER)] #[f 0 51.5, f 30 51.5001, f 60 51.5002, f 90 51.5003]
  == #[(0, 120, none, none), (120, 900, BAKER, none)]
-- An unparseable or missing label.
#guard board #[awalk 0 240, atrain 240 900 (some METLINE)] boardWalk
  == #[(0, 240, none, none), (240, 900, some METLINE, none)]
#guard board #[awalk 0 240, atrain 240 900 none] boardWalk
  == #[(0, 240, none, none), (240, 900, none, none)]
-- The previous segment is not a walk.
#guard board #[aseg 0 240 "stationary", atrain 240 900 (BAKER)] boardWalk
  == #[(0, 240, none, none), (240, 900, BAKER, none)]
-- THE CONTINUITY GUARD (2026-06-24): train → walk → train is a reconstruction
-- sliver, and its hop is the SAME ride continuing…
#guard board #[atrain (-600) 0 (some s!"A → B · {METLINE}"), awalk 0 240, atrain 240 900 (BAKER)] boardWalk
  == #[(-600, 0, some s!"A → B · {METLINE}", none), (0, 240, none, none), (240, 900, BAKER, none)]
-- …whereas a STATIONARY two back does not block it.
#guard board #[aseg (-600) 0 "stationary", awalk 0 240, atrain 240 900 (BAKER)] boardWalk
  == #[(-600, 0, none, none), (0, 120, none, none), (120, 900, EUSTON, some RENAME_467)]
-- Both modes are read through `effectiveMode`, unlike `absorbBoardingPlatform`.
#guard board #[awalk 0 240 (some "walking") "driving",
               atrain 240 900 (BAKER) (some "train") "driving"] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON, some RENAME_467)]
-- The window is INCLUSIVE at the close: trimming the walk by one second drops
-- the tail fix, and the reclaimed distance shrinks 467 m → 311 m.
#guard board #[awalk 0 239, atrain 239 900 (BAKER)] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON,
        some "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 311 m hop the underground reconstruction had left in the walk (was boarding Baker Street)")]
-- An existing reason is appended to, not replaced.
#guard board #[awalk 0 240, atrain 240 900 (BAKER) none "train" (some "earlier note")] boardWalk
  == #[(0, 120, none, none), (120, 900, EUSTON, some s!"earlier note; {RENAME_467}")]
-- Nothing near the board fix.
#guard board #[awalk 0 240, atrain 240 900 (BAKER)]
    #[f 0 51.4, f 60 51.4003, f 120 51.4006, f 150 51.402, f 180 51.4034, f 240 51.4048]
  == #[(0, 240, none, none), (240, 900, BAKER, none)]
#guard board #[] boardWalk == #[]

/-! #### Boarding: the cases the probe sweep asked for -/

/-- A duplicate timestamp inside what would be the hop. `dt > 0 ? … : 0` scores
it ZERO — not `+∞`, which is what `Verified.Geo.TubeHop`'s leaf does with the
same shape. The run therefore never starts. -/
private def boardZeroDt : Array Fix := #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 120 51.5036, f 210 51.504]
/-- EAST-WEST, so a transposed haversine changes the distance. -/
private def boardEast : Array Fix := #[ef 0 (-0.14), ef 60 (-0.1395), ef 120 (-0.139), ef 150 (-0.134), ef 210 (-0.129)]
/-- A qualifying run, a slow step, then a SECOND qualifying run. -/
private def boardTwoRuns : Array Fix :=
  #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 150 51.5036, f 210 51.5039, f 240 51.5053, f 270 51.5067]
/-- A fast step too short to qualify, a slow one, then another short fast step:
only a STALE run start would let the second qualify. -/
private def boardStaleRun : Array Fix := #[f 0 51.5006, f 30 51.502, f 90 51.5023, f 120 51.5037, f 180 51.504]
/-- Three fixes that would anchor if the bar were three rather than four. -/
private def boardThree : Array Fix := #[f 0 51.5, f 60 51.5006, f 90 51.5036]
/-- The tail measures 344.7043 m — the only fixture whose fractional part crosses
a half, so it is the one that tells `Math.round` from truncation. -/
private def boardHalf : Array Fix := #[f 0 51.5, f 60 51.5003, f 120 51.5006, f 150 51.5036, f 210 51.5037]

-- A zero-duration step is not a teleport here: it scores 0 and the run never
-- opens, so nothing is reclaimed.
#guard board #[awalk 0 210, atrain 210 900 (BAKER)] boardZeroDt
  == #[(0, 210, none, none), (210, 900, BAKER, none)]
-- Moving due EAST instead of due north: the reclaimed distance is 692 m, which
-- a lat/lon transposition would render as a great circle along the equator.
#guard board #[awalk 0 210, atrain 210 900 (BAKER)] boardEast
  == #[(0, 120, none, none), (120, 900, EUSTON,
        some "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 692 m hop the underground reconstruction had left in the walk (was boarding Baker Street)")]
-- 344.7043 m rounds UP. Truncation would quote 344.
#guard board #[awalk 0 210, atrain 210 900 (BAKER)] boardHalf
  == #[(0, 120, none, none), (120, 900, EUSTON,
        some "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 345 m hop the underground reconstruction had left in the walk (was boarding Baker Street)")]
-- THE `break`. The scan stops at the FIRST qualifying run, whose one fast step
-- is not dense enough for a same-station extension. Running on to the second
-- run — two steps — would have allowed it.
#guard board #[awalk 0 270, atrain 270 900 (EUSTON)] boardTwoRuns
  == #[(0, 270, none, none), (270, 900, EUSTON, none)]
-- …and the rename off that same first run does go through, so the difference
-- above really is the density test and not a failure to find a run at all.
#guard board #[awalk 0 270, atrain 270 900 (BAKER)] boardTwoRuns
  == #[(0, 120, none, none), (120, 900, EUSTON,
        some "boarding re-anchored to Euston Square (walk's terminal station) — reclaimed a 678 m hop the underground reconstruction had left in the walk (was boarding Baker Street)")]
-- A slow step RESETS the run start. Carrying a stale one would let the second
-- short fast step qualify on displacement it did not earn.
#guard board #[awalk 0 180, atrain 180 900 (BAKER)] boardStaleRun
  == #[(0, 180, none, none), (180, 900, BAKER, none)]
-- Three fixes would anchor on the merits; the bar is what refuses them.
#guard board #[awalk 0 90, atrain 90 900 (BAKER)] boardThree
  == #[(0, 90, none, none), (90, 900, BAKER, none)]
-- A label ending in a BARE separator parses to `line = some ""`. Same board, so
-- the label is kept verbatim — a rewrite would drop the dangling separator…
#guard board #[awalk 0 240, atrain 240 900 (some "Euston Square → Wembley Park · ")] boardWalk
  == #[(0, 120, none, none), (120, 900, some "Euston Square → Wembley Park · ", some SAME_467)]
-- …and on a RENAME the empty line writes NO suffix back. The mirror answers a
-- veto for `""`, so this also pins that an empty line is never consulted.
#guard board #[awalk 0 240, atrain 240 900 (some "Baker Street → Wembley Park · ")] boardWalk
  == #[(0, 120, none, none), (120, 900, some "Euston Square → Wembley Park", some RENAME_467)]

/-- A leading TWO-step run, then it settles. -/
private def alightWalk : Array Fix := #[f 0 51.5, f 30 51.5014, f 60 51.5028, f 120 51.5031, f 180 51.5034]
/-- TWO qualifying runs: the LAST one wins. -/
private def alightTwo : Array Fix :=
  #[f 0 51.5, f 30 51.5014, f 60 51.5028, f 120 51.5031, f 150 51.5045, f 180 51.5059]
/-- One long fast step — a tunnel blackout. -/
private def alight1 : Array Fix := #[f 0 51.5, f 30 51.5028, f 90 51.5031]

private def WP (alight : String) (line : String := s!" · {METLINE}") : Option String :=
  some s!"Wembley Park → {alight}{line}"
private def GPS_RENAME : String :=
  "alight re-anchored to Great Portland Street (walk's leading hop reached it) — reclaimed a 311 m hop the GPS blackout left in the walk (was alighting Euston Square)"
private def GPS_SAME : String :=
  "alight boundary extended to the Great Portland Street arrival — reclaimed a 311 m ride tail the early cut left in the walk"

-- The walk opens with the Metropolitan still riding in: the train closes at the
-- fix the run SETTLES on, and the walk is trimmed to it.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some GPS_RENAME), (60, 180, none, none)]
-- THE LAST qualifying run, not the first: GPS sticks at an intermediate
-- surfaced station while the train keeps going. Note the boarding side takes
-- the FIRST and breaks.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180] alightTwo
  == #[(-600, 180, WP "Baker Street",
        some "alight re-anchored to Baker Street (walk's leading hop reached it) — reclaimed a 656 m hop the GPS blackout left in the walk (was alighting Euston Square)"),
       (180, 180, none, none)]
-- A settled station equal to the current label still moves the boundary…
#guard alight #[atrain (-600) 0 (WP "Great Portland Street"), awalk 0 180] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some GPS_SAME), (60, 180, none, none)]
-- …on DENSE evidence only. A single fast step landing at the labelled alight is
-- the stuck-GPS signature: extending there eats a real walk's head.
#guard alight #[atrain (-600) 0 (WP "Great Portland Street"), awalk 0 90] alight1
  == #[(-600, 0, WP "Great Portland Street", none), (0, 90, none, none)]
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 90] alight1
  == #[(-600, 30, WP "Great Portland Street", some GPS_RENAME), (30, 90, none, none)]
-- No line in the label: no veto, no suffix.
#guard alight #[atrain (-600) 0 (WP "Euston Square" "")] alightWalk == #[(-600, 0, WP "Euston Square" "", none)]
#guard alight #[atrain (-600) 0 (WP "Euston Square" ""), awalk 0 180] alightWalk
  == #[(-600, 60, WP "Great Portland Street" "", some GPS_RENAME), (60, 180, none, none)]
-- THE #377 GUARD: a leg cannot alight where its own line does not stop.
#guard alight #[atrain (-600) 0 (WP "Euston Square" s!" · {NLL}"), awalk 0 180] alightWalk
  == #[(-600, 0, WP "Euston Square" s!" · {NLL}", none), (0, 180, none, none)]
-- THE ORDERING DISCRIMINATOR. Here the veto is applied BEFORE the rename
-- decision, so it stops a same-station extension too — the boarding side, whose
-- veto is gated on `!sameBoard`, allows the mirror of this case.
#guard alight #[atrain (-600) 0 (WP "Great Portland Street" s!" · {NLL}"), awalk 0 180] alightWalk
  == #[(-600, 0, WP "Great Portland Street" s!" · {NLL}", none), (0, 180, none, none)]
-- Too few fixes, and no vehicle-paced run.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 30] alightWalk
  == #[(-600, 0, WP "Euston Square", none), (0, 30, none, none)]
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180] #[f 0 51.5, f 60 51.5003, f 120 51.5006]
  == #[(-600, 0, WP "Euston Square", none), (0, 180, none, none)]
-- An unparseable label, and a next segment that is not a walk.
#guard alight #[atrain (-600) 0 (some METLINE), awalk 0 180] alightWalk
  == #[(-600, 0, some METLINE, none), (0, 180, none, none)]
#guard alight #[atrain (-600) 0 (WP "Euston Square"), aseg 0 180 "stationary"] alightWalk
  == #[(-600, 0, WP "Euston Square", none), (0, 180, none, none)]
-- The mirror of the continuity guard: train → walk → train is an interchange…
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180, atrain 180 600 (some s!"A → B · {METLINE}")] alightWalk
  == #[(-600, 0, WP "Euston Square", none), (0, 180, none, none), (180, 600, some s!"A → B · {METLINE}", none)]
-- …and a STATIONARY two on does not block it.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180, aseg 180 600 "stationary"] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some GPS_RENAME), (60, 180, none, none), (180, 600, none, none)]
-- Both modes through `effectiveMode`.
#guard alight #[atrain (-600) 0 (WP "Euston Square") (some "train") "driving",
                awalk 0 180 (some "walking") "driving"] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some GPS_RENAME), (60, 180, none, none)]
-- An existing reason is appended to.
#guard alight #[atrain (-600) 0 (WP "Euston Square") none "train" (some "earlier note"), awalk 0 180] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some s!"earlier note; {GPS_RENAME}"), (60, 180, none, none)]
-- Nothing at the settle fix: the line lookups are never reached.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180]
    #[f 0 51.4, f 30 51.4014, f 60 51.4028, f 120 51.4031]
  == #[(-600, 0, WP "Euston Square", none), (0, 180, none, none)]
#guard alight #[] alightWalk == #[]

/-! #### The summary follows the boundary (#424)

Both anchors move a walk's edge, and the walk's kinematics are derived from the
window that edge closes. Leaving them alone is what the Lean arm did until #424:
the two sides then agreed on `startTs`/`endTs` and disagreed on `pointCount`,
`avgSpeed`, `maxSpeed` and `linearity` — a segment describing a window it no
longer spans, on 29 of 35 golden days.

The fixtures carry SPEEDS here (the ones above default to zero, which cannot
distinguish a recomputed summary from an inherited one). Walking pace on the
walk's own fixes, vehicle pace on the reclaimed hop: the fix that tells them
apart is exactly the one changing hands. -/

private def statsView (out : Array Seg) : Array (Int × Float × Float) :=
  out.map fun s => (s.pointCount, s.avgSpeed, s.maxSpeed)

/-- `boardWalk`, with the hop at vehicle pace. -/
private def boardWalkSpeeds : Array Fix :=
  #[f 0 51.5 4, f 60 51.5003 5, f 120 51.5006 6, f 150 51.502 60, f 180 51.5034 62, f 240 51.5048 64]
/-- `alightWalk`, with the leading hop at vehicle pace. -/
private def alightWalkSpeeds : Array Fix :=
  #[f 0 51.5 55, f 30 51.5014 60, f 60 51.5028 58, f 120 51.5031 5, f 180 51.5034 4]

-- Boarding: the walk keeps 0-120, so 3 fixes topping out at 6 km/h — NOT the
-- six fixes and 64 km/h peak the un-recomputed parent reported. `avgSpeed` is
-- the median of [4, 5, 6]. The train is not re-summarised (nor is it in the TS):
-- it keeps `Seg`'s defaults.
#guard statsView (anchorTrainBoardingToWalkedStation
    #[awalk 0 240, atrain 240 900 (BAKER)] boardWalkSpeeds aStations aServed)
  == #[(3, 5, 6), (10, 0, 0)]
-- A refused extension leaves the summary untouched, defaults and all: this pass
-- restates a window only when it moves one.
#guard statsView (anchorTrainBoardingToWalkedStation
    #[awalk 0 240, atrain 240 900 (BAKER s!" · {NLL}")] boardWalkSpeeds aStations aServed)
  == #[(10, 0, 0), (10, 0, 0)]
-- Alight: the walk starts at 60 and `excludeStart` gives the boundary fix to the
-- ride that arrived on it, so 2 fixes — 120 and 180 — at walking pace.
#guard statsView (anchorTrainAlightToWalkedStation
    #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180] alightWalkSpeeds [] aStations aServed)
  == #[(10, 0, 0), (2, 4.5, 5)]

/-! #### Alight: the cases the probe sweep asked for -/

/-- Short fast, slow, short fast: only a STALE run start would qualify. -/
private def alightStaleRun : Array Fix := #[f 0 51.5, f 30 51.5014, f 90 51.5017, f 120 51.5031]
/-- A long SLOW drift out and a fast return. The run covers 322 m, but the walk
ends 11 m from where it began, which is not a ride to anywhere — and the run
started at fix 1, so only the surfaced-to-settled test can see it. -/
private def alightBounce : Array Fix := #[f 0 51.5, f 600 51.503, f 630 51.5001]
/-- Two fixes that would anchor if the bar were two rather than three. -/
private def alightTwoFix : Array Fix := #[f 0 51.5, f 30 51.5028]

#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 120] alightStaleRun
  == #[(-600, 0, WP "Euston Square", none), (0, 120, none, none)]
#guard alight #[atrain (-600) 0 (WP "Great Portland Street"), awalk 0 630] alightBounce
  == #[(-600, 0, WP "Great Portland Street", none), (0, 630, none, none)]
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 30] alightTwoFix
  == #[(-600, 0, WP "Euston Square", none), (0, 30, none, none)]
-- The bare-separator pair, as on the boarding side. Note the mirror answers a
-- veto for `""`, and BOTH of these go through — so on this side too an empty
-- line is never consulted, even though the veto here precedes the rename test.
#guard alight #[atrain (-600) 0 (some "Wembley Park → Great Portland Street · "), awalk 0 180] alightWalk
  == #[(-600, 60, some "Wembley Park → Great Portland Street · ", some GPS_SAME), (60, 180, none, none)]
#guard alight #[atrain (-600) 0 (some "Wembley Park → Euston Square · "), awalk 0 180] alightWalk
  == #[(-600, 60, some "Wembley Park → Great Portland Street", some GPS_RENAME), (60, 180, none, none)]

-- THE CORRIDOR GATE IS GONE (TS `16fcbe3`), and six guards went with it. They
-- pinned an intersection of line labels at the two ends — including the rule
-- that an EMPTY intersection refuses, and the fallback that asks the resolved
-- station when the settle fix is off the mapped track. All of it presumed a
-- line identifier is stable along a route, which is a tube-mirror premise: a
-- per-section name can never intersect itself, so the gate refused every such
-- alight by construction.
--
-- ⚠ THE GUARD BELOW RECORDS A GAP, NOT A GUARANTEE — the Lean twin of the TS
-- test named for it. Where the gate used to refuse a settle on an unrelated
-- line, the anchor now FIRES. A leg carrying a line is still covered, by
-- `lineCannotServe` on the line topology (the guards above prove it); a leg
-- with no line is not covered by anything here.
--
-- When a legless-leg check lands, this expectation flips back to a refusal —
-- deliberately, and this comment goes with it.
#guard alight #[atrain (-600) 0 (WP "Euston Square"), awalk 0 180] alightWalk
  == #[(-600, 60, WP "Great Portland Street", some GPS_RENAME), (60, 180, none, none)]

end Verified.Geo.RailAbsorbers
