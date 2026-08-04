import Verified.Geo.StaySplit
import Verified.Geo.BridgeStays
/-!
# Re-cutting the day's segments on biometric evidence (`src/geo/velocity.ts` 731-761)

`classifySegments` cuts the day from the track alone. Three stages then re-cut it
from the step counter and the heart rate, because the track cannot see the
difference between a phone that stopped reporting and a wearer who stopped
moving:

| TS                            | velocity phase | direction                       |
| ----------------------------- | -------------- | ------------------------------- |
| `splitStaysOnEvidence`        | `staySplit`    | one stay → stays + `unknown` gap |
| `splitWalksOnEvidence`        | `walkSplit`    | one walk → sit / walk / sit     |
| `bridgeStaysWithBiometrics`   | `bridgeStays`  | several stays → one             |

The first two divide and the third merges, which is not a contradiction: they
answer different questions. The splits ask whether the wearer LEFT during an
interval the GPS could not see; the bridge asks whether a stay the GPS
fragmented was ever actually interrupted. Both are answered from steps and HR
because that is the only evidence there is when the fixes stop.

This module is the sequence, and only the sequence — every body already had a
Lean port ({@link Verified.Geo.StaySplit.Stays},
{@link Verified.Geo.StaySplit.Walks}, {@link Verified.Geo.BridgeStays}). What
did not exist was the ORDER and the centroids, so nothing executed them: the
gate imported `StaySplit` through `PassFold` (for the pass-stage namespaces) and
`BridgeStays` through nothing at all. It moves the chain's start earlier again
(#430), to the output of segmentation.

## The centroids are part of the stage, not an input to it

`bridgeStaysWithBiometrics` takes them as an argument, but they are computed
inline at the call site — a plain mean over each stationary segment's fixes. So
{@link stayCentroids} is ported here rather than crossing the wire: a centroid
that crossed would be the TS's answer to the question the Lean arm is supposed
to be answering, and the two arms would agree about co-location by construction.

## No OSM, and no new observations

Segments in, segments out. The track, the steps and the HR are already on the
wire for the corrections and the fold, so this stage adds one field to the
request (the segmentation output) and one to the response (its own). That is the
whole cost of chaining it, and it is why this came before the enrichment stage
between here and {@link Verified.Geo.PreFold}, which needs the mirror.
-/

namespace Verified.Geo.SplitFold

open Verified.Geo.SegmentMerge (Seg)
open Shed (PointF)
open Stays (SplitContext)

/-- Each stationary segment's fix centroid, `none` where the bridge must refuse.

TWO different reasons produce `none` and the bridge treats them the same: a
segment that is not a stay, and a stay no fix covers. Both mean "cannot be
compared to another centroid", which is what the bridge tests.

Reads `mode`, not `effectiveMode` — nothing has refined anything yet at this
point in the pipeline, but the TS says `s.mode` and a later pass could make the
two disagree.

The window is INCLUSIVE at both ends (`samplesInWindow`), so a fix on the
boundary counts toward both bracketing segments. Unsorted: `filter` keeps the
track's order, and the TS sums in that order too — which matters, because these
are float sums. -/
def stayCentroids (points : Array PointF) (segs : Array Seg) : Array (Option (Float × Float)) :=
  segs.map fun s =>
    if s.mode != "stationary" then none
    else
      let inWindow := points.filter fun p => p.ts ≥ s.startTs && p.ts ≤ s.endTs
      if inWindow.isEmpty then none
      else
        let n := Float.ofNat inWindow.size
        some ((inWindow.foldl (fun acc p => acc + p.lat) 0) / n,
              (inWindow.foldl (fun acc p => acc + p.lon) 0) / n)

/-- Split, split again, then bridge. The centroids are taken AFTER both splits,
over the segments the bridge will actually see — a stay the walk split carved
out of a walk is a stay the bridge may merge, and a centroid computed before the
splits would be indexed against a different array. -/
def splitFold (points : Array PointF) (ctx : SplitContext) (segs : Array Seg) : Array Seg :=
  let stays := Stays.splitStaysOnEvidence segs points ctx
  let walks := Walks.splitWalksOnEvidence stays points ctx
  Verified.Geo.BridgeStays.bridgeStaysWithBiometrics walks (stayCentroids points walks)
    (ctx.hr.map fun h => ⟨h.ts, h.bpm⟩) (ctx.steps.map fun s => ⟨s.ts, s.steps⟩)

/-! ## Guards

The three bodies are pinned in their own modules. What is new here is the
centroid arithmetic and the order, so that is what these test. -/

private def fx (ts : Int) (lat lon : Float) : PointF := { ts, lat, lon, speedKmh := 0 }

private def stay (startTs endTs : Int) : Seg :=
  { startTs, endTs, mode := "stationary", pointCount := 10 }

/-- Coordinates chosen so every mean below is EXACT in binary. What is under
test is which fixes enter the window, not float rounding, and a guard written on
round decimals would fail on the rounding instead of pinning the window. -/
private def FIXES : Array PointF := #[fx 0 51.5 (-0.5), fx 100 51.75 (-0.25), fx 200 52.0 0.0]

-- The mean of the covered fixes, and nothing outside the window enters it.
#guard stayCentroids FIXES #[stay 0 200] == #[some (51.75, -0.25)]
#guard stayCentroids FIXES #[stay 0 100] == #[some (51.625, -0.375)]
-- INCLUSIVE both ends: the boundary fix belongs to both neighbours.
#guard stayCentroids FIXES #[stay 0 100, stay 100 200] == #[some (51.625, -0.375), some (51.875, -0.125)]
-- A stay no fix covers cannot be placed, and a moving segment is not asked.
#guard stayCentroids FIXES #[stay 300 400] == #[none]
#guard stayCentroids FIXES #[{ stay 0 200 with mode := "walking" }] == #[none]
#guard stayCentroids #[] #[stay 0 200] == #[none]

end Verified.Geo.SplitFold
