import Verified.Geo.SegmentMerge
import Verified.Geo.RailAbsorbers
import Verified.Geo.RailSnap
import Verified.JsNum
/-!
# Snapped rail paths (from `src/geo/passes/rail-reconcile.ts`)

`annotateSnappedPaths` attaches the offline-computed route geometry to a train
leg and interpolates its time window along it; `reattachSnappedPaths` runs it
again after the passes that relabel a ride.

## The JSON boundary

`annotateSnappedPaths` reads `rail_route_cache` rows whose geometry is a JSON
string. `JSON.parse` and the `Array.isArray` check are SHELL — this port takes
rows already decoded to a coordinate list, and a row the shell could not decode
is simply absent. The `length ≥ 2` rejection is a real decision and stays here.

Exactness: every decision is exact, and `interpolateTimes` (reused from
`Verified.Geo.RailSnap`) carries its own ≤ 1 ULP metric. UNPROVEN; pinned
against Node/V8 (`lean/experiments/rail-reconcile-refs.mts`).
-/

namespace Verified.Geo.RailReconcile

open Verified.Geo.RailAbsorbers (parseRailWayName RAIL_STATION_SEP RAIL_LINE_SEP)
open Verified.Hsmm.FloatScore (haversineMeters)

abbrev Mode := String

open Verified.JsNum (jsRound)

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

-- `refinedMode ?? mode` — `SegmentMerge.effectiveMode`, the one definition.
export Verified.Geo.SegmentMerge (effectiveMode)

/-! ## `annotateSnappedPaths` -/

/-- A decoded `rail_route_cache` row: the run label it is keyed by, and the
route geometry the shell parsed out of its JSON column. -/
structure RouteRow where
  routeKey : String
  geometry : Array Verified.Geo.WalkableRoute.Pt
  deriving Inhabited, BEq, Repr

/-- A run's cached track by its label, or by the reverse journey's — the same
track ridden the other way, its geometry reversed. -/
def cachedTrack (railRouteCache : Array RouteRow) (key : String) :
    Option (Array Verified.Geo.WalkableRoute.Pt) :=
  let usable := fun (r : RouteRow) => r.geometry.size ≥ 2
  match railRouteCache.find? (fun r => r.routeKey == key && usable r) with
  | some row => some row.geometry
  | none =>
    match parseRailWayName (some key) with
    | none => none
    | some t =>
      let rev := t.alight ++ RAIL_STATION_SEP ++ t.board ++
        (match t.line with | some l => if l == "" then "" else RAIL_LINE_SEP ++ l | none => "")
      (railRouteCache.find? (fun r => r.routeKey == rev && usable r)).map (·.geometry.reverse)

#guard cachedTrack #[⟨"A → B", #[⟨0, 0⟩, ⟨1, 1⟩]⟩] "B → A" == some #[⟨1, 1⟩, ⟨0, 0⟩]
#guard cachedTrack #[⟨"A → B · L", #[⟨0, 0⟩, ⟨1, 1⟩]⟩] "B → A · L" == some #[⟨1, 1⟩, ⟨0, 0⟩]
#guard cachedTrack #[⟨"A → B", #[⟨0, 0⟩, ⟨1, 1⟩]⟩] "A → B" == some #[⟨0, 0⟩, ⟨1, 1⟩]
#guard cachedTrack #[⟨"A → B", #[⟨0, 0⟩, ⟨1, 1⟩]⟩] "A → C" == none

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
  segments.map fun seg =>
    if effectiveMode seg != "train" then seg
    else match seg.wayName.filter (· != "") with
      | none => seg
      | some key =>
        match cachedTrack railRouteCache key with
        | none => seg
        | some geom =>
          { seg with
            snappedPath := some (Verified.Geo.RailSnap.interpolateTimes geom
              (Float.ofInt seg.startTs) (Float.ofInt seg.endTs)) }

/-- Each train run's track for its FINAL label: the cached geometry, or none.

`annotateSnappedPaths` attaches early, because walk anchoring and the final
merge read the track; passes after it can still relabel a run — a later alight,
a through-joined leg — and the track attached for the old label stayed on it
(10-08: the Hendaye–Bordeaux track under "Hendaye → Gare Montparnasse", the rest
drawn as a gap). Every track comes from the cache, so recomputing from the final
label is exact; a label not yet cached draws its raw fixes until the nightly
job has resolved it. -/
def reattachSnappedPaths (segments : Array Seg) (railRouteCache : Array RouteRow) : Array Seg :=
  segments.map fun seg =>
    if effectiveMode seg != "train" then seg
    else match seg.wayName.filter (· != "") with
      | none => seg
      | some key =>
        match cachedTrack railRouteCache key with
        | some geom =>
          { seg with snappedPath := some (Verified.Geo.RailSnap.interpolateTimes geom
              (Float.ofInt seg.startTs) (Float.ofInt seg.endTs)) }
        | none => { seg with snappedPath := none }

/-! ## Guards (V8 reference values) -/

private def blank : Seg := { startTs := 0, endTs := 0, mode := "" }
private def tr (a b : Int) (wayName : Option String) (pointCount : Int := 10)
    (avgSpeed maxSpeed : Float := 0) (linearity : Float := 0.5) (mode : Mode := "train")
    (refinedMode : Option Mode := none) (snapped : Bool := false) : Seg :=
  { blank with
    startTs := a, endTs := b, mode := mode, refinedMode := refinedMode, wayName := wayName,
    pointCount := pointCount, avgSpeed := avgSpeed, maxSpeed := maxSpeed, linearity := linearity,
    snappedPath := if snapped then some #[⟨51.52, -38.13, 0⟩] else none }

#guard parseRailWayName (some "A→B") == none

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
