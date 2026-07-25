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

abbrev Mode := String

/-- `Math.round` — halves go UP, towards +∞. -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-- The `EnrichedSegment` fields these passes read and rewrite. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  wayName : Option String := none
  avgSpeed : Float := 0
  maxSpeed : Float := 0
  linearity : Float := 0.5
  pointCount : Int := 10
  snappedPath : Option (Array Verified.Geo.RailSnap.SnappedPoint) := none
  deriving Inhabited, BEq, Repr

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

end Verified.Geo.RailReconcile
