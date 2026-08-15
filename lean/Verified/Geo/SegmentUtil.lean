import Verified.Geo.StaySplit
import Verified.Hsmm.FloatScore
/-!
# Segment utilities (port of the pure leaf of `src/geo/segment-util.ts`)

One function so far, and it is here rather than in a pass module for the reason
the TS has it in `segment-util.ts`: THREE passes recompute a piece's kinematics
after moving its boundary (`underground-rail.ts`, `passes/rail-absorbers.ts`,
`passes/rail-reconcile.ts`), and a pass that moves a boundary without it emits a
segment whose summary describes a window the segment no longer spans.

It lived in `Verified.Geo.UndergroundAnnotate` until #424 measured what that cost:
the two `rail-absorbers` anchors could not reach it — the absorbers cannot import
the annotator — so they moved their boundaries and left the parent's statistics
in place. The day gate saw that on 29 of 35 days as `pointCount`, `avgSpeed`,
`maxSpeed` and `linearity` disagreeing on a segment whose `startTs` and `endTs`
AGREED. Shared placement is the fix; the TS had it right first.
-/

namespace Verified.Geo.SegmentUtil

open Verified.Geo.StaySplit

/-- What a carved piece's own fixes say about it. -/
structure WindowStats where
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  linearity : Float
  deriving Inhabited, Repr

/--
Recompute a piece's kinematics from the fixes its window actually owns — the
port of TS `statsOverWindow` (`7d89369`).

A carve that reslices a segment and emits the pieces as `{ host with startTs,
endTs }` hands every piece the PARENT's summary. That summary was measured
across the whole parent, INCLUDING whatever the carve just removed, so the
piece reports a peak that never happened inside it and the kinematic invariants
downstream read that peak as evidence. Measured on the corpus: 60 of 208
walking segments reported a `maxSpeed` their own fixes do not support.

`avgSpeed` is the MEDIAN, matching how `classifySegments` derives it: a mean
over a window that contained a ride is dragged by the ride.

`excludeStart` drops the fix ON `startTs`. Set it when a VEHICLE precedes this
window — the boundary fix is the one the vehicle arrived on, and its speed is
the vehicle's, so a following walk that keeps it claims the ride's arrival
speed on foot.
-/
def statsOverWindow (points : Array Shed.PointF) (startTs endTs : Int)
    (excludeStart : Bool := false) : WindowStats :=
  let fixes := (points.toList.filter fun p =>
      (if excludeStart then decide (p.ts > startTs) else decide (p.ts ≥ startTs))
        && decide (p.ts ≤ endTs)).mergeSort fun a b => a.ts ≤ b.ts
  match fixes with
  | [] => { pointCount := 0, avgSpeed := 0, maxSpeed := 0, linearity := 0 }
  | first :: _ =>
    let arr := fixes.toArray
    let speeds := fixes.map (·.speedKmh)
    let sorted := speeds.mergeSort (· ≤ ·)
    let mid := sorted.length / 2
    let med :=
      if sorted.length % 2 == 0 then (sorted[mid - 1]! + sorted[mid]!) / 2 else sorted[mid]!
    let pathDist := (List.range (arr.size - 1)).foldl (init := (0 : Float)) fun acc k =>
      acc + Verified.Hsmm.FloatScore.haversineMeters
        arr[k]!.lat arr[k]!.lon arr[k + 1]!.lat arr[k + 1]!.lon
    let last := arr[arr.size - 1]!
    let straight := Verified.Hsmm.FloatScore.haversineMeters first.lat first.lon last.lat last.lon
    { pointCount := Int.ofNat arr.size
      avgSpeed := Float.floor (med * 10 + 0.5) / 10
      maxSpeed := Float.floor ((speeds.foldl max first.speedKmh) * 10 + 0.5) / 10
      linearity :=
        if pathDist > 0 then Float.floor (min (straight / pathDist) 1 * 100 + 0.5) / 100 else 0 }

/-! ## Guards

The window rule, which is the whole of what the callers depend on: both bounds
INCLUSIVE, and `excludeStart` drops the fix sitting exactly on the opening
boundary — nothing else. -/

private def p (ts : Int) (speedKmh : Float) : Shed.PointF :=
  { ts, lat := 51.5, lon := -0.14, speedKmh }

private def win : Array Shed.PointF := #[p 0 4, p 60 5, p 120 6, p 180 90]

#guard (statsOverWindow win 0 120).pointCount == 3
-- The closing bound is inclusive: the 90 km/h fix ON `endTs` is this window's.
#guard (statsOverWindow win 0 180).maxSpeed == 90
-- And the opening bound is too, until `excludeStart` says otherwise.
#guard (statsOverWindow win 0 120).avgSpeed == 5
#guard (statsOverWindow win 0 120 (excludeStart := true)).pointCount == 2
-- An empty window is zeroes, not the caller's previous summary — the whole
-- point of the function.
#guard (statsOverWindow win 1000 2000).pointCount == 0

end Verified.Geo.SegmentUtil
