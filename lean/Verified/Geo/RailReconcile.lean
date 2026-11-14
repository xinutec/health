import Verified.Geo.SegmentMerge
import Verified.Geo.RailAbsorbers
import Verified.Geo.RailSnap
import Verified.JsNum
/-!
# Snapped rail paths

`annotateSnappedPaths` attaches cached route geometry to a train leg and
interpolates its time window along it; `reattachSnappedPaths` reruns it after
passes that relabel a ride. Rows arrive decoded; an undecodable one is absent.

Exact except `interpolateTimes` (from `Verified.Geo.RailSnap`, ≤ 1 ULP).
UNPROVEN; pinned by the `#guard`s.
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

/-- Attach a train run's cached route geometry, keyed by its `<board> → <alight>`
label, and interpolate its time window along it. An uncached run keeps raw
fixes until `refresh-rail-routes` runs; a geometry under two vertices is
rejected. Purely additive. -/
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

/-- Each train run's track for its final label. Attached early (walk anchoring
and the merge read it), a track can outlive a later relabel; every track is from
the cache, so recomputing from the final label is exact. -/
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

/-! ## Guards -/

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
-- A non-train leg is skipped by the per-segment mode test, not by an empty key
-- set: the train leg beside it puts a usable row in the cache lookup.
#guard (annotateSnappedPaths
    #[tr 1000 2000 (some "A → B"), tr 2000 3000 (some "A → B") (mode := "walking")] CACHE).map
    (·.snappedPath.isSome) == #[true, false]
#guard (annotateSnappedPaths #[tr 1000 2000 none] CACHE)[0]!.snappedPath == none
#guard annotateSnappedPaths #[] CACHE == #[]

end Verified.Geo.RailReconcile
