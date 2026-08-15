import Verified.Geo.SegmentMerge
import Verified.Geo.RailAbsorbers
import Verified.Geo.RailSnap
/-!
# Rail reconciliation (port of the pure passes in `src/geo/passes/rail-reconcile.ts`)

The last of the per-pass rail modules.

* `mergeAdjacentSameRouteTrains` — one tube journey left as two adjacent train
  segments resolving to the SAME board→alight pair becomes one ride.
* `reconcileAdjacentRailLegs` — the day-grammar law that two back-to-back rail
  legs must share a station, enforced in time order with leg A's alight as the
  trusted value.
* `annotateSnappedPaths` — attach the offline-computed route geometry to a run
  and interpolate its time window along it.

`assembleRailJourney` (async OSM line and station lookups) stays shell.

## A FOURTH reading of the same label

`trainStationPair` — private in the TS, driven here through the merge — tests
the BARE arrow `"→"` rather than `" → "`, then splits on `" · "` and trims. That
is looser than either of the two parsers this repo already has: `"A→B"` with no
spaces IS a station pair to it, while `RailAbsorbers.parseRailWayName` (and
rail-snap's) both require the spaced separator and return `none`. A guard pins
it. The reconciliation itself uses `RailAbsorbers.parseRailWayName` — the
rail-reconcile flavour — NOT `Verified.Geo.Worldline`'s.

## The JSON boundary

`annotateSnappedPaths` reads `rail_route_cache` rows whose geometry is a JSON
string. `JSON.parse` and the `Array.isArray` check are SHELL — this port takes
rows already decoded to a coordinate list, and a row the shell could not decode
is simply absent. The `length ≥ 2` rejection is a real decision and stays here.

Exactness: every merge and rewrite decision is exact; the weighted means go
through `Math.round`, and `interpolateTimes` (reused from
`Verified.Geo.RailSnap`) carries its own ≤ 1 ULP metric. UNPROVEN; pinned
against Node/V8 (`lean/experiments/rail-reconcile-refs.mts`).
-/

namespace Verified.Geo.RailReconcile

open Verified.Geo.RailAbsorbers (parseRailWayName RAIL_STATION_SEP RAIL_LINE_SEP)
open Verified.Hsmm.FloatScore (haversineMeters)

abbrev Mode := String

/-- `Math.round` — halves go UP, towards +∞. -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- A GPS fix, as the filter left it.

The ABSORBERS' fix, not `SegmentMerge`'s, because `splitChangeoverWindows` has to
re-summarise the walk it trims and the summary is derived from `speedKmh`
(#424). The two differ in that field alone. -/
abbrev Fix := Verified.Geo.RailAbsorbers.Fix

def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `mergeAdjacentSameRouteTrains` -/

def MOVING_MERGE_MAX_GAP_S : Int := 3 * 60

/-- The board→alight pair a train leg resolves to, or `none`.

Note how LOOSE this is next to the two real parsers: it tests the BARE arrow, so
`"A→B"` counts, and it takes everything before the first `" · "` and trims.
Nothing is validated — the pair is only ever compared to another pair. -/
def trainStationPair (s : Seg) : Option String :=
  if effectiveMode s != "train" then none
  else match s.wayName with
    | none => none
    | some w =>
      if (w.splitOn "→").length < 2 then none
      else some ((w.splitOn RAIL_LINE_SEP).headD w).trimAscii.toString

/-- Merge consecutive train segments resolving to the SAME station pair.

The rail and underground reconstructions can leave a single tube journey as two
adjacent train segments. The pair is read BEFORE the line suffix, so two halves
differing only in whether they resolved a line still merge — and the merged leg
keeps the MORE SPECIFIC label, the half that has one.

`wTot` falls back to 1 when both point counts are zero, mirroring the TS's
`|| 1`. That prevents a NaN but does NOT produce a sensible mean: the weighted
fields all come out ZERO in that case. Pinned, because it is surprising. -/
def mergeAdjacentSameRouteTrains (segments : Array Seg) : Array Seg :=
  segments.foldl (init := #[]) fun out seg =>
    match out.back? with
    | none => out.push seg
    | some prev =>
      let pair := trainStationPair seg
      if pair.isSome && trainStationPair prev == pair
          && seg.startTs - prev.endTs ≤ MOVING_MERGE_MAX_GAP_S then
        let w0 := Float.ofInt prev.pointCount
        let w1 := Float.ofInt seg.pointCount
        let wTot := if w0 + w1 == 0 then 1 else w0 + w1
        out.pop.push
          { prev with
            endTs := seg.endTs
            pointCount := prev.pointCount + seg.pointCount
            avgSpeed := jsRound ((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot * 10) / 10
            maxSpeed := jsRound (max prev.maxSpeed seg.maxSpeed * 10) / 10
            linearity := jsRound ((prev.linearity * w0 + seg.linearity * w1) / wTot * 100) / 100
            -- Keep the more specific label: the half that resolved a line.
            wayName :=
              if ((prev.wayName.getD "").splitOn RAIL_LINE_SEP).length < 2
                  && ((seg.wayName.getD "").splitOn RAIL_LINE_SEP).length ≥ 2
              then seg.wayName else prev.wayName
            snappedPath := if prev.snappedPath.isNone then seg.snappedPath else prev.snappedPath }
      else out.push seg

/-! ## `reconcileAdjacentRailLegs` -/

/-- Enforce the physical law that two back-to-back rail legs share a station.

You cannot step off a train at one station and instantly be on another train
somewhere else: there is no time and no walk in between. The two annotators
resolve each leg's stations INDEPENDENTLY, so a leg reconstructed from coarse
underground fixes can board at a station the previous leg already passed — a
sequence that reads as travelling backwards.

Enforced in time order, taking leg A's alight as trusted because it was
established first:

* **Distinct alights** (A → S, B boards T₀ ≠ S, alights T) — leg B continues the
  journey, so it is rewritten to board where A alighted. Only the station label
  changes; the split time and line name stay as resolved.
* **Same alight** (both alight at S) — leg B claims a ride to a station already
  reached, with no travel between. Physically impossible, and the boarding
  cannot be rewritten without collapsing B to a degenerate `S → S`. So B is a
  phantom re-arrival (typically a coarse-fix reconstruction duplicating A's
  tail) and is ABSORBED into A. Before this branch existed the impossibility was
  left standing (the 2026-06-22 bug). -/
def reconcileAdjacentRailLegs (segments : Array Seg) : Array Seg :=
  segments.foldl (init := #[]) fun out b =>
    match out.back? with
    | none => out.push b
    | some a =>
      if effectiveMode a != "train" || effectiveMode b != "train" then out.push b
      else match parseRailWayName a.wayName, parseRailWayName b.wayName with
        | some aRail, some bRail =>
          -- A consistent pair short-circuits. Note this is a NO-OP rather than a
          -- behaviour difference: rail-reconcile's parser neither trims nor
          -- validates, so re-formatting `bRail` reproduces `b.wayName` exactly
          -- when `aRail.alight == bRail.board`. No guard can distinguish the two,
          -- and the TS has the early return, so it is kept.
          if aRail.alight == bRail.board then out.push b
          else if aRail.alight == bRail.alight then
            out.pop.push
              { a with
                endTs := max a.endTs b.endTs
                pointCount := a.pointCount + b.pointCount
                maxSpeed := max a.maxSpeed b.maxSpeed
                snappedPath := if a.snappedPath.isNone then b.snappedPath else a.snappedPath }
          else
            let lineSuffix := match bRail.line with
              | some l => RAIL_LINE_SEP ++ l
              | none => ""
            out.push { b with wayName := some (aRail.alight ++ RAIL_STATION_SEP ++ bRail.alight ++ lineSuffix) }
        | _, _ => out.push b

/-! ## `annotateSnappedPaths` -/

/-- A decoded `rail_route_cache` row: the run label it is keyed by, and the
route geometry the shell parsed out of its JSON column. -/
structure RouteRow where
  routeKey : String
  geometry : Array Verified.Geo.WalkableRoute.Pt
  deriving Inhabited, BEq, Repr

/-- Attach a train run's cached route geometry and interpolate its time window
along it.

The geometry is far too expensive to compute per request (a graph build plus a
spatial scan), so `refresh-rail-routes` computes it offline into
`rail_route_cache`, keyed by the run's `<board> → <alight>` label. Here it is one
lookup, an attach, and a time interpolation. A run whose route is not yet cached
simply keeps no `snappedPath` and the frontend draws its raw fixes — it becomes
snapped once the cron has run. Purely additive.

A geometry with fewer than two vertices is rejected: there is nothing to draw. -/
def annotateSnappedPaths (segments : Array Seg) (railRouteCache : Array RouteRow) : Array Seg :=
  let keys := segments.filterMap fun s =>
    if effectiveMode s == "train" then s.wayName.filter (· != "") else none
  if keys.isEmpty then segments else
  let usable := railRouteCache.filter fun r => keys.contains r.routeKey && r.geometry.size ≥ 2
  if usable.isEmpty then segments else
  segments.map fun seg =>
    if effectiveMode seg != "train" then seg
    else match seg.wayName.filter (· != "") with
      | none => seg
      | some key =>
        match usable.find? (·.routeKey == key) with
        | none => seg
        | some row =>
          { seg with
            snappedPath := some (Verified.Geo.RailSnap.interpolateTimes row.geometry
              (Float.ofInt seg.startTs) (Float.ofInt seg.endTs)) }

/-! ## `splitChangeoverWindows` -/

/-- A step at or above this (km/h) is the phone on a train, not on a platform. -/
def CHANGEOVER_RIDE_MIN_KMH : Float := 15

/-- Net displacement a reclaimed side must cover (m) before a leg boundary moves.
Comfortably under a tube inter-station hop, comfortably over a platform walk. -/
def CHANGEOVER_RIDE_MIN_M : Float := 250

/-- The platform walk left behind must span at least this (s). Below it there is
no walk to speak of and the two legs are really one arrival. -/
def CHANGEOVER_PLATFORM_MIN_S : Int := 20

/-- A station-pair-labelled train leg — the only kind this pass reasons over.
Private in the TS; named here because the pass is driven directly. -/
def isStationPairTrain (s : Seg) : Bool :=
  effectiveMode s == "train" && (parseRailWayName s.wayName).isSome

/-- `existing ? "existing; add" : add`. The EMPTY STRING is included in the
falsy branch, as in the TS: `refinedReason = ""` is replaced, not prefixed. -/
private def appendReason (existing : Option String) (add : String) : String :=
  match existing with
  | some r => if r == "" then add else s!"{r}; {add}"
  | none => add

/-- The maximal runs of consecutive non-ride steps, as `(from, to)` index pairs
into the FIX array: `ride[from] … ride[to-1]` are all false, so the run spans
fix `from` through fix `to`. A run still open at the end closes at `ride.size`,
which is the last fix — so `to` indexes a fix in every case. -/
private def stillRuns (ride : Array Bool) : Array (Nat × Nat) :=
  let (runs, opened) := (List.range ride.size).foldl
    (init := ((#[] : Array (Nat × Nat)), (none : Option Nat)))
    fun (runs, opened) k =>
      if ride[k]! then
        match opened with
        | some s => (runs.push (s, k), none)
        | none => (runs, none)
      else
        match opened with
        | some _ => (runs, opened)
        | none => (runs, some k)
  match opened with
  | some s => runs.push (s, ride.size)
  | none => runs

/-- The platform walk: the LONGEST still run BY DURATION, with its span.
First-wins on a tie, mirroring the TS's strict `>` against a `-1` seed. -/
private def platformRun (fixes : Array Fix) (ride : Array Bool) : Option (Nat × Nat × Int) :=
  (stillRuns ride).foldl (init := none) fun best (f, t) =>
    let span := fixes[t]!.ts - fixes[f]!.ts
    match best with
    | some (_, _, bs) => if span > bs then some (f, t, span) else best
    | none => if span > -1 then some (f, t, span) else none

/-- One `[ride tail][platform walk][ride head]` window, at the walk's index.

Sequential by construction: the head branch moves the NEXT leg's start, and that
leg is the `prev` of a window two indices on, so each step reads the array the
previous ones left. Hence a fold over indices rather than a map. -/
private def splitOneWindow (points : Array Fix) (out : Array Seg) (i : Nat) : Array Seg :=
  let walk := out[i]!
  let prev := out[i-1]!
  let next := out[i+1]!
  if effectiveMode walk != "walking" then out
  else if !isStationPairTrain prev || !isStationPairTrain next then out
  else
    -- `samplesInWindow`, inclusive at both ends — spelled out because the shared
    -- one is typed to `SegmentMerge.Fix` and this pass reads the absorbers'.
    let fixes := points.filter fun p => p.ts ≥ walk.startTs && p.ts ≤ walk.endTs
    if fixes.size < 4 then out else
    -- Step k joins fixes[k] and fixes[k+1]. `ride[k]` is that step at train pace.
    let ride : Array Bool := (Array.range (fixes.size - 1)).map fun k =>
      let a := fixes[k]!
      let b := fixes[k+1]!
      let dt := b.ts - a.ts
      dt > 0 && haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt * 3.6 ≥ CHANGEOVER_RIDE_MIN_KMH
    if !ride.any id then out else -- nothing stranded — an honest walk
    match platformRun fixes ride with
    | none => out
    | some (bestFrom, bestTo, bestS) =>
      if bestS < CHANGEOVER_PLATFORM_MIN_S then out else
      let net (a b : Nat) : Float :=
        haversineMeters fixes[a]!.lat fixes[a]!.lon fixes[b]!.lat fixes[b]!.lon
      let tailM := if bestFrom > 0 then net 0 bestFrom else 0
      let headM := if bestTo < fixes.size - 1 then net bestTo (fixes.size - 1) else 0
      let takeTail := tailM ≥ CHANGEOVER_RIDE_MIN_M
      let takeHead := headM ≥ CHANGEOVER_RIDE_MIN_M
      if !takeTail && !takeHead then out else
      let walkStart := if takeTail then fixes[bestFrom]!.ts else walk.startTs
      let walkEnd := if takeHead then fixes[bestTo]!.ts else walk.endTs
      if walkEnd - walkStart < CHANGEOVER_PLATFORM_MIN_S then out else
      -- EXCLUSIVE upper bound, unlike the `samplesInWindow` that read the fixes:
      -- the recount is `>= from && < to`, so a boundary point falls to one side
      -- only. Counted over ALL points, not the window's fixes.
      --
      -- It applies to the two RIDES only. The walk between them gets the full
      -- `statsOverWindow` below, on the other bound convention — the TS spells
      -- these differently at the two ends of the same block and the difference
      -- is load-bearing, so they stay spelled differently here.
      let countIn (a b : Int) : Int :=
        Int.ofNat (points.filter (fun p => p.ts ≥ a && p.ts < b)).size
      let reclaimed (m : Float) : String :=
        let r := (Verified.JsNum.toFixed (jsRound m) 0).getD "?"
        s!"changeover window: reclaimed {r} m of stranded ride (#444)"
      let out := if takeTail then
          out.set! (i-1) { prev with
            endTs := walkStart
            pointCount := countIn prev.startTs walkStart
            refinedReason := some (appendReason prev.refinedReason (reclaimed tailM)) }
        else out
      let out := if takeHead then
          out.set! (i+1) { next with
            startTs := walkEnd
            pointCount := countIn walkEnd next.endTs
            refinedReason := some (appendReason next.refinedReason (reclaimed headM)) }
        else out
      -- The stranded ride just moved out of this walk on both sides, so the peak
      -- it reports has to move with it — `pointCount` alone left 2026-04-29's
      -- changeover claiming 87.8 km/h across a window whose own fixes top out at
      -- 5. A ride precedes, so its arrival fix stays with the ride.
      out.set! i
        (Verified.Geo.RailAbsorbers.applyStats
          { walk with
            startTs := walkStart
            endTs := walkEnd
            refinedReason := some (appendReason walk.refinedReason
              "changeover window: trimmed to the platform change (#444)") }
          (Verified.Geo.RailAbsorbers.windowStats points walkStart walkEnd (excludeStart := true)))

/-- A changeover window is `[ride tail][platform walk][ride head]`, and only the
middle is a walk (#444).

The rail reconstruction can end a leg while the phone is still a kilometre from
the station that leg CLAIMS to alight at, and still closing at 50 km/h. The
remaining ride is then stranded in the walk between the two legs — which the
interchange labeller has already named `"<station> (interchange)"` — so a
four-minute "platform walk" contains an inter-station hop, and the kinematic
invariant correctly calls it physically impossible.

The anchors decline this case by design: reclaiming a hop on ONE side says
nothing about which side it belongs to. Between two rides it can belong to
either, and the window has to be read as a whole.

## Which part is the walk

The platform walk is the LONGEST stretch of the window the phone is not moving
at vehicle pace. Everything before it belongs to the arriving ride, everything
after to the departing one.

That criterion rather than "the fast steps at each end", because a train STOPS:
an intermediate call sits inside the window as a slow stretch of its own.
Duration alone cannot separate those either — the intermediate stops run
14-28 s and the real cross-platform change 32 s. What distinguishes the change
is that it is the LONGEST such stretch, which is the one thing a station stop
mid-ride is not.

Both sides are optional and measured independently. Conservative by
construction: it runs only on a walk BETWEEN two station-pair-labelled trains,
moves a boundary only when the reclaimed side covers a real inter-station
distance, and leaves the walk alone unless a recognisable platform stretch
survives. Any of those failing means the window is not this shape, and the pass
declines rather than guessing — an unfixed impossible leg is a REPORTED defect,
a wrongly moved boundary a silent one. -/
def splitChangeoverWindows (segments : Array Seg) (points : Array Fix) : Array Seg :=
  (List.range segments.size).foldl (init := segments) fun out i =>
    if i == 0 || i + 1 ≥ segments.size then out else splitOneWindow points out i

/-! ## Guards (V8 reference values) -/

private def blank : Seg := { startTs := 0, endTs := 0, mode := "" }
private def tr (a b : Int) (wayName : Option String) (pointCount : Int := 10)
    (avgSpeed maxSpeed : Float := 0) (linearity : Float := 0.5) (mode : Mode := "train")
    (refinedMode : Option Mode := none) (snapped : Bool := false) : Seg :=
  { blank with
    startTs := a, endTs := b, mode := mode, refinedMode := refinedMode, wayName := wayName,
    pointCount := pointCount, avgSpeed := avgSpeed, maxSpeed := maxSpeed, linearity := linearity,
    snappedPath := if snapped then some #[⟨51.52, -0.13, 0⟩] else none }

private def mview (out : Array Seg) : Array (Int × Int × Int × Float × Float × Float × Option String × Bool) :=
  out.map fun s => (s.startTs, s.endTs, s.pointCount, s.avgSpeed, s.maxSpeed, s.linearity, s.wayName,
    s.snappedPath.isSome)

-- The same pair split into two legs: merged, weighted at each field's own
-- precision, `maxSpeed` a max rather than a mean.
#guard mview (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B") 10 30.4 44.2 0.81, tr 660 1200 (some "A → B") 30 40.6 52.8 0.93])
  == #[(0, 1200, 40, 38.1, 52.8, 0.9, some "A → B", false)]
-- The pair is read BEFORE the line suffix, so two legs differing only in their
-- line still merge — and the MORE SPECIFIC label survives, either way round.
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B"), tr 660 1200 (some "A → B · Metropolitan Line")])[0]!.wayName
  == some "A → B · Metropolitan Line"
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B · Metropolitan Line"), tr 660 1200 (some "A → B")])[0]!.wayName
  == some "A → B · Metropolitan Line"
#guard (mergeAdjacentSameRouteTrains #[tr 0 600 (some "A → B"), tr 660 1200 (some "B → C")]).size == 2
-- 181 s is past the bar; 180 exactly merges.
#guard (mergeAdjacentSameRouteTrains #[tr 0 600 (some "A → B"), tr 781 1200 (some "A → B")]).size == 2
#guard (mergeAdjacentSameRouteTrains #[tr 0 600 (some "A → B"), tr 780 1200 (some "A → B")]).size == 1
-- No arrow at all: not a station pair.
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "Metropolitan Line"), tr 660 1200 (some "Metropolitan Line")]).size == 2
-- THE LOOSE READING: `trainStationPair` tests the BARE arrow, so a label with
-- no spaces around it still pairs — where `RailAbsorbers.parseRailWayName`
-- returns `none` for the very same string.
#guard (mergeAdjacentSameRouteTrains #[tr 0 600 (some "A→B"), tr 660 1200 (some "A→B")]).size == 1
#guard parseRailWayName (some "A→B") == none
-- …and the pair is TRIMMED, so a trailing space still pairs with the clean
-- form. The MERGE is the evidence: asserting the surviving label alone would
-- prove nothing, since element 0 is the first leg either way.
#guard mview (mergeAdjacentSameRouteTrains #[tr 0 600 (some "A → B "), tr 660 1200 (some "A → B")])
  == #[(0, 1200, 20, 0, 0, 0.5, some "A → B ", false)]
-- Non-train legs never pair; a leg refined TO train does.
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B") (mode := "walking"), tr 660 1200 (some "A → B") (mode := "walking")]).size == 2
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B") (mode := "driving") (refinedMode := some "train"),
      tr 660 1200 (some "A → B")]).size == 1
-- A snappedPath is adopted from the later leg when the earlier has none.
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B"), tr 660 1200 (some "A → B") (snapped := true)])[0]!.snappedPath.isSome
-- …and the adopt is ONE-directional: an earlier path is never overwritten by a
-- later leg that has none.
#guard (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B") (snapped := true), tr 660 1200 (some "A → B")])[0]!.snappedPath.isSome
-- BOTH point counts zero: the `|| 1` guard stops a NaN, but the weighted fields
-- come out ZERO rather than averaged — surprising, so pinned. `maxSpeed` is a
-- max and is unaffected.
#guard mview (mergeAdjacentSameRouteTrains
    #[tr 0 600 (some "A → B") 0 30 44 0.8, tr 660 1200 (some "A → B") 0 40 52 0.9])
  == #[(0, 1200, 0, 0, 52, 0, some "A → B", false)]
#guard mergeAdjacentSameRouteTrains #[] == #[]

private def rview (out : Array Seg) : Array (Int × Int × Int × Float × Option String × Bool) :=
  out.map fun s => (s.startTs, s.endTs, s.pointCount, s.maxSpeed, s.wayName, s.snappedPath.isSome)

-- DISTINCT alights: leg B is rewritten to board where A alighted, keeping its
-- own alight and line.
#guard (reconcileAdjacentRailLegs
    #[tr 0 600 (some "A → S"), tr 600 1200 (some "T0 → T · Jubilee Line")])[1]!.wayName
  == some "S → T · Jubilee Line"
-- …and with no line the suffix is omitted entirely.
#guard (reconcileAdjacentRailLegs #[tr 0 600 (some "A → S"), tr 600 1200 (some "T0 → T")])[1]!.wayName
  == some "S → T"
-- SAME alight: leg B is a phantom re-arrival and is absorbed into A, which takes
-- the later end, the summed points, the larger max speed and B's snapped path.
#guard rview (reconcileAdjacentRailLegs
    #[tr 0 600 (some "A → S") 10 0 40, tr 600 1200 (some "B → S") 7 0 55 (snapped := true)])
  == #[(0, 1200, 17, 55, some "A → S", true)]
-- The absorb takes the LATER end, so a B that ends earlier does not shorten A.
#guard rview (reconcileAdjacentRailLegs
    #[tr 0 1200 (some "A → S") 10 0 55, tr 600 900 (some "B → S") 10 0 40])
  == #[(0, 1200, 20, 55, some "A → S", false)]
-- Already consistent, unparseable, missing, or not two trains: untouched.
#guard (reconcileAdjacentRailLegs #[tr 0 600 (some "A → S"), tr 600 1200 (some "S → T")])[1]!.wayName
  == some "S → T"
#guard (reconcileAdjacentRailLegs
    #[tr 0 600 (some "Metropolitan Line"), tr 600 1200 (some "T0 → T")])[1]!.wayName == some "T0 → T"
#guard (reconcileAdjacentRailLegs #[tr 0 600 (some "A → S"), tr 600 1200 none])[1]!.wayName == none
#guard (reconcileAdjacentRailLegs
    #[tr 0 600 (some "A → S") (mode := "walking"), tr 600 1200 (some "T0 → T")])[1]!.wayName
  == some "T0 → T"
#guard reconcileAdjacentRailLegs #[] == #[]

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def northPt (n : Float) : Verified.Geo.WalkableRoute.Pt := ⟨lat0 + n * mlat, lon0⟩

#guard (northPt 1000).lat == 51.528983111749916

private def CACHE : Array RouteRow := #[⟨"A → B", #[northPt 0, northPt 1000]⟩]

-- A cached route for the run's label: geometry attached, timestamps
-- interpolated across the window by arc length (endpoints land on the bounds).
#guard (annotateSnappedPaths #[tr 1000 2000 (some "A → B")] CACHE)[0]!.snappedPath
  == some #[⟨lat0, lon0, 1000⟩, ⟨(northPt 1000).lat, lon0, 2000⟩]
-- No row for this key; a single-vertex geometry rejected (`≥ 2`, nothing to
-- draw); a non-train leg; an unlabelled leg.
#guard (annotateSnappedPaths #[tr 1000 2000 (some "C → D")] CACHE)[0]!.snappedPath == none
#guard (annotateSnappedPaths #[tr 1000 2000 (some "A → B")] #[⟨"A → B", #[northPt 0]⟩])[0]!.snappedPath == none
-- A non-train leg is skipped by the PER-SEGMENT mode test, not by an empty key
-- set: the train leg beside it puts a usable row in the cache lookup.
#guard (annotateSnappedPaths
    #[tr 1000 2000 (some "A → B"), tr 2000 3000 (some "A → B") (mode := "walking")] CACHE).map
    (·.snappedPath.isSome) == #[true, false]
#guard (annotateSnappedPaths #[tr 1000 2000 none] CACHE)[0]!.snappedPath == none
#guard annotateSnappedPaths #[] CACHE == #[]

private def fx (ts : Int) (m : Float) (speedKmh : Float := 0) : Fix :=
  ⟨ts, (northPt m).lat, (northPt m).lon, speedKmh⟩

/-- The only shape the pass reads: a walk between two station-pair-labelled
trains. The trains extend 300 s past the walk, so a moved boundary shows. -/
private def cwin (fixes : Array Fix) : Array Seg :=
  let t0 := fixes[0]!.ts
  let t1 := fixes[fixes.size - 1]!.ts
  #[tr (t0 - 300) t0 (some "A → S · Jubilee Line"),
    tr t0 t1 (some "S (interchange)") (mode := "walking"),
    tr t1 (t1 + 300) (some "S → T · Bakerloo Line")]

private def cview (out : Array Seg) : Array (Int × Int × Int × Option String) :=
  out.map fun s => (s.startTs, s.endTs, s.pointCount, s.refinedReason)

private def TRIMMED : String := "changeover window: trimmed to the platform change (#444)"
private def reclaim (m : String) : String := s!"changeover window: reclaimed {m} m of stranded ride (#444)"

-- BOTH sides: a fast approach, a 90 s platform stretch, a fast departure. Each
-- leg is recounted over the points, and the reclaimed metres are the HAVERSINE
-- distance rounded — 499, not the 500 m the frame was built at.
private def BOTH : Array Fix :=
  #[fx 1000 0, fx 1030 500, fx 1060 505, fx 1120 515, fx 1150 1015, fx 1180 1520]
#guard cview (splitChangeoverWindows (cwin BOTH) BOTH)
  == #[(700, 1030, 1, some (reclaim "499")),
       (1030, 1120, 2, some TRIMMED),
       (1120, 1480, 3, some (reclaim "1004"))]

-- THE SUMMARY FOLLOWS THE BOUNDARY (#424). `pointCount` alone is not enough:
-- the walk inherited its `avgSpeed`/`maxSpeed`/`linearity` from a window that
-- CONTAINED the ride, and trimming the window without restating them left
-- 2026-04-29's changeover reporting 87.8 km/h across a platform stretch. Note
-- the counts are unchanged from the guard above — `>= start, < end` and
-- `> start, <= end` happen to agree on this window, which is exactly why the
-- defect hid behind an agreeing `pointCount` on the corpus.
private def BOTH_KMH : Array Fix :=
  #[fx 1000 0 80, fx 1030 500 85, fx 1060 505 4, fx 1120 515 5, fx 1150 1015 88, fx 1180 1520 90]
/-- `cwin`, but the walk carries the ride's peak — the state the trim inherits. -/
private def cwinFast (fixes : Array Fix) : Array Seg :=
  let t0 := fixes[0]!.ts
  let t1 := fixes[fixes.size - 1]!.ts
  #[tr (t0 - 300) t0 (some "A → S · Jubilee Line"),
    tr t0 t1 (some "S (interchange)") 10 40 90 0.5 "walking",
    tr t1 (t1 + 300) (some "S → T · Bakerloo Line")]
-- The walk went in carrying 40 / 90 and comes out at 4.5 / 5, its own fixes'
-- median and peak. The two RIDES keep their zeros: they are recounted, never
-- re-summarised, on this side as on the TS's.
#guard (splitChangeoverWindows (cwinFast BOTH_KMH) BOTH_KMH).map
    (fun s => (s.pointCount, s.avgSpeed, s.maxSpeed))
  == #[(1, 0, 0), (2, 4.5, 5), (3, 0, 0)]

-- TAIL only (the 07-02 shape): the ride is stranded at the START of the walk
-- and nothing fast follows, so only the arriving leg's boundary moves and the
-- departing leg keeps its own count of 10 untouched.
private def TAIL : Array Fix := #[fx 1000 0, fx 1030 500, fx 1060 505, fx 1120 515, fx 1150 525]
#guard cview (splitChangeoverWindows (cwin TAIL) TAIL)
  == #[(700, 1030, 1, some (reclaim "499")), (1030, 1150, 3, some TRIMMED), (1150, 1450, 10, none)]

-- THE DISCRIMINATOR: a 25 s intermediate station stop precedes the 35 s
-- cross-platform change. A scan that ended the tail at the FIRST slow step
-- would cut at the intermediate platform, 505 m in; LONGEST-run reclaims the
-- whole 1004 m and cuts at the real change.
private def INTER : Array Fix :=
  #[fx 1000 0, fx 1030 500, fx 1055 505, fx 1085 1005, fx 1120 1010, fx 1150 1510]
#guard cview (splitChangeoverWindows (cwin INTER) INTER)
  == #[(700, 1085, 3, some (reclaim "1004")),
       (1085, 1120, 1, some TRIMMED),
       (1120, 1450, 2, some (reclaim "499"))]

-- An honest walk: no step at vehicle pace, so nothing is stranded.
private def HONEST : Array Fix := #[fx 1000 0, fx 1030 20, fx 1060 40, fx 1120 70, fx 1150 90]
#guard cview (splitChangeoverWindows (cwin HONEST) HONEST)
  == #[(700, 1000, 10, none), (1000, 1150, 10, none), (1150, 1450, 10, none)]
-- A ride IS present, but neither side covers an inter-station distance
-- (200 m < 250 m): the pass declines rather than moving a boundary.
private def SHORT : Array Fix := #[fx 1000 0, fx 1010 200, fx 1040 205, fx 1100 210, fx 1110 215]
#guard cview (splitChangeoverWindows (cwin SHORT) SHORT)
  == #[(700, 1000, 10, none), (1000, 1110, 10, none), (1110, 1410, 10, none)]
-- Fewer than four fixes: too little to read a window from.
private def FEW : Array Fix := #[fx 1000 0, fx 1030 500, fx 1120 515]
#guard cview (splitChangeoverWindows (cwin FEW) FEW)
  == #[(700, 1000, 10, none), (1000, 1120, 10, none), (1120, 1420, 10, none)]
-- The platform stretch is 15 s, under the 20 s bar: what is left would not be a
-- walk, so the window is one arrival for the merge passes, not this one.
private def BRIEF : Array Fix := #[fx 1000 0, fx 1030 500, fx 1045 505, fx 1060 1005, fx 1090 1510]
#guard cview (splitChangeoverWindows (cwin BRIEF) BRIEF)
  == #[(700, 1000, 10, none), (1000, 1090, 10, none), (1090, 1390, 10, none)]

-- Not two station-pair trains, and a middle that is not a walk: both decline.
#guard cview (splitChangeoverWindows
    #[tr 700 1000 (some "Jubilee Line"), tr 1000 1180 none (mode := "walking"),
      tr 1180 1480 (some "S → T")] BOTH)
  == #[(700, 1000, 10, none), (1000, 1180, 10, none), (1180, 1480, 10, none)]
#guard cview (splitChangeoverWindows
    #[tr 700 1000 (some "A → S"), tr 1000 1180 none (mode := "stationary"),
      tr 1180 1480 (some "S → T")] BOTH)
  == #[(700, 1000, 10, none), (1000, 1180, 10, none), (1180, 1480, 10, none)]

-- An existing reason is PREFIXED; an EMPTY-STRING one is replaced outright,
-- because `""` is falsy in the TS append.
#guard (splitChangeoverWindows
    #[{ tr 700 1000 (some "A → S") with refinedReason := some "earlier note" },
      { tr 1000 1180 none (mode := "walking") with refinedReason := some "" },
      tr 1180 1480 (some "S → T")] BOTH).map (·.refinedReason)
  == #[some s!"earlier note; {reclaim "499"}", some TRIMMED, some (reclaim "1004")]

#guard splitChangeoverWindows #[] BOTH == #[]

end Verified.Geo.RailReconcile
