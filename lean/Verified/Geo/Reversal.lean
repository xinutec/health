import Verified.Geo.SegmentMerge
import Verified.Geo.StaySplit
import Verified.Hsmm.FloatScore

/-!
# Reversal detection — a ride that doubles back is two rides

Port of `src/geo/passes/reversal.ts`, the `reversalSplit` entry of
`computeVelocityFromInputs`' pass fold. Wholly pure: segments and fixes in,
segments out, no OSM and no async, so every leaf runs for real on both arms and
the guards are the TS's own answers rather than a stub's.

You cannot stay on one train from a station out to another and back again;
reaching the far point and returning means you got off and boarded a train going
the other way. Nothing local to the turnaround says so — the platform dwell
there looks exactly like the station dwells a journey is meant to be stitched
ACROSS, and the speeds either side are identical. The evidence is directional,
so that is what this module reads.

Two consumers, one rule: `splitReversingLegs` cuts a leg whose own fixes reverse
inside it, and `reversesAt` stops the rail-run pass growing a run back across a
cut. Without the split there is no boundary to refuse to cross; without the
refusal the run pass welds the two halves straight back together.

## What the direction test actually refuses — MEASURED, and not what the TS says

`reversal.ts` documents the direction test as the thing a lone far-flung GPS
spike fails: *"the track approaches and leaves a spike on the same heading, so
its arms do not oppose"*. That is not what happens. A sweep of **345 spike
geometries** clearing both distance gates — corridor length × along-track offset
× lateral offset × spike index — found `reversesAtPoint` accepting **all 345**
and refusing **none**. Reaching a spike and leaving it IS an out-and-back at the
scale the arms measure, so the arms oppose; that is true whether the spike is
lateral or an along-track overshoot.

What it DOES refuse is a **loop**: a ride that ends where it began and reaches
far out, but turns gently the whole way — a Circle-line ride, a bus loop, a
drive round a one-way system. There the return and span bars both pass and the
direction test is the only thing standing between a real journey and an invented
interchange. `LOOP` in the guards is that case, and it is the only shape measured
to reach the test.

The port reproduces the TS exactly, including the comment's premise being
wrong about which input it catches. The behaviour is what the corpus was
blessed under.

## Floats

`localOffset` is a local equirectangular projection (`cos` at the MIDPOINT of
the pair, R = 6371000) and the TS takes its magnitudes with `Math.hypot` where
this port uses `sqrt(x² + y²)`.

Both feed only a RATIO — the cosine compared against `REVERSAL_COS_MAX` — and
that is worth measuring rather than asserting. Over **115,320 arm pairs**
(500 m to 8 km on each side, headings every 3°): the two magnitudes differ in
bits on **51.4%**, the worst resulting cosine gap is **5.55e-16**, and the number
of geometries on which they disagree about `cos < -0.5` is **zero**. So the
difference is real and pervasive at the bit level and has no measured effect on
the answer.

`haversineMeters` is reused from `Verified.Hsmm.FloatScore` and is the same
formula, term for term, as `place-snap.ts`'s.

## Probe survivors

The mutation sweep runs 61 perturbations. The ones that do NOT fire are recorded
here rather than left looking like coverage, because two of them are invariances
that would otherwise read as bugs.

**Provably no-ops.**

* *Transposing `localOffset`'s two components.* Swapping the components of BOTH
  arms leaves the dot product and both magnitudes bit-identical (IEEE addition
  commutes), so the cosine cannot move — measured: 0 of 43,560 geometries differ
  by one bit. A lat/lon transposition here is invisible **by construction**,
  which is why the deliberately diagonal fixture corridor does not catch it.
* *Changing the Earth radius.* It scales both arms uniformly, and a uniform
  positive scale is invisible to a cosine. Not bit-exact (30,148 of 43,560 move)
  but bounded by 6.66e-16 — the knife-edge class below.
* *The zero-magnitude guard.* An arm can only vanish for a fix coincident with
  the pivot, but the arm filter already demands a haversine of ≥ 500 m; the
  smallest magnitude any accepted arm reached in measurement was 533 m.
* *`reversesAt`'s empty-array guard.* Without it `points[0]!` yields the default
  `PointF` — a `(0,0)` pivot — but `reversesAtPoint` then finds no arms in an
  empty array and returns `false` regardless. Harmless HERE only because no
  distance is ever computed against real data from that sentinel; the same
  sentinel meeting a populated spatial index is the wedge recorded on task #416.
* *Passing the whole day's `points` rather than the leg's `fixes` to the
  direction test.* The arm filters are `≥ fromTs` / `≤ toTs` and those receive
  `seg.startTs` / `seg.endTs`, which is exactly the window `fixes` was cut to, so
  the candidate sets are equal. An earlier draft of this header claimed the
  opposite; the probe refuted it and a direct check found 0 disagreements over 60
  multi-leg windows.
* *`statsOver`'s empty-window arm.* Unreachable through `splitReversingLegs`: the
  cut is always a fix and `samplesInWindow` is inclusive at both ends, so each
  half owns at least that one fix.

**Knife-edges — measured unreachable, not unexamined.** Four comparisons differ
only when a haversine lands exactly on its bar: the arm radius at 500 m, the span
at 1500 m, the return fraction at half the span, and the cosine at −0.5. One
latitude ULP moves a haversine by ~7.9e-10 m against an output ULP of ~1e-13 m,
so roughly 8,000 representable outputs are skipped per representable input and
the bar cannot be landed on by search — the same conclusion the rail-journey and
rail-run tranches reached at their own thresholds. Each CONSTANT is bracketed by
a fixture either side; only the strictness is unpinned.

Reference values: `lean/experiments/reversal-refs.mts`.
-/

namespace Verified.Geo.Reversal

open Verified.Geo.SegmentMerge (Seg effectiveMode)
-- NOTE the bare `Shed`: `StaySplit.lean` closes `namespace Verified.Geo.StaySplit`
-- before opening `Shed`, so that namespace and its six siblings (`Handoff`,
-- `Arrival`, `VehicleLeg`, `RideHead`, `Stays`, `Walks`) sit at the ROOT. Reused
-- rather than redeclared because the pass fold has to thread ONE fix type through
-- every pass; a second `PointF` would make the fold's shape a conversion.
open Shed (PointF jsRound)
open Verified.Hsmm.FloatScore (haversineMeters)

private def pi : Float := 3.141592653589793

/-- How far the track must travel either side of a point before its direction is
worth reading. Under this, platform scatter and a tunnel-mouth reacquire
dominate the vector and the angle is noise. EXPORTED — `annotateRailRuns` reads
it too. -/
def DIRECTION_ARM_M : Float := 500

/-- Cosine of the angle between the approach and departure vectors, above which
the track carried on. Below it (a turn sharper than 120°) it went back the way
it came. Deliberately far from a right angle: a line that merely curves through a
station, or an interchange onto a line heading off at a tangent, must not read as
a reversal. EXPORTED. -/
def REVERSAL_COS_MAX : Float := -0.5

/-- How far a leg must reach from its start before "it came back" is a
meaningful thing to say about it. -/
def REVERSAL_MIN_SPAN_M : Float := 1500

/-- A leg ending this fraction (or less) of the way out from its start, having
once been much further, has doubled back. Half is deliberately loose: the test
must not fire on a ride whose GPS goes dark short of the alight, where the last
OBSERVED fix is still well down the line. -/
def REVERSAL_RETURN_FRACTION : Float := 0.5

/-- Only a MOTORISED leg is split. An out-and-back stroll is an ordinary single
walk. The bound sits above the cycling ceiling, matching the rail passes' own
transit test. -/
def REVERSAL_MIN_PEAK_KMH : Float := 40

/-- Each half of a split must be long enough to be a ride in its own right. -/
def REVERSAL_MIN_HALF_S : Int := 60

/-- How long after the furthest fix to look for the platform the rider actually
stood on. -/
def TURNAROUND_SETTLE_S : Int := 180

/-- Speed below which the rider is off the train and on the platform. Matches the
rail passes' own disembark threshold. -/
def TURNAROUND_STOPPED_KMH : Float := 5

/-- A point the direction test can pivot on: the fixes carry speeds, but a pivot
needs only a time and a position. -/
structure Pivot where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- Local metres east/north of `ref` — good enough for comparing directions over
a few km, and it keeps the turn test to plain vector arithmetic. -/
def localOffset (pLat pLon refLat refLon : Float) : Float × Float :=
  let d := pi / 180
  let r := 6371000.0
  ((pLon - refLon) * d * Float.cos (((pLat + refLat) / 2) * d) * r, (pLat - refLat) * d * r)

/-- Fixes inside a window, INCLUSIVE both ends (`samplesInWindow`). -/
def samplesInWindow (points : Array PointF) (startTs endTs : Int) : Array PointF :=
  points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/--
Do the approach to `pivot` and the departure from it oppose?

Measured from the nearest fixes at least `DIRECTION_ARM_M` away on each side, so
the answer is about travel rather than platform scatter, and bounded to
`[fromTs, toTs]` so it only ever reads evidence the caller owns. FALSE when
either side is unobserved — a test that cannot see is not evidence of a reversal.

The pivot's own fix is excluded from both arms (`< pivot.ts` on one side,
`> pivot.ts` on the other), which matters only for a pivot that coincides with a
fix — which is every call this module makes.
-/
def reversesAtPoint (points : Array PointF) (pivot : Pivot) (fromTs toTs : Int) : Bool :=
  let far := fun (p : PointF) => haversineMeters p.lat p.lon pivot.lat pivot.lon ≥ DIRECTION_ARM_M
  -- `[...points].reverse().find(...)`: the LAST qualifying fix before the pivot.
  let inFix? := points.reverse.find? fun p => p.ts ≥ fromTs && p.ts < pivot.ts && far p
  let outFix? := points.find? fun p => p.ts > pivot.ts && p.ts ≤ toTs && far p
  match inFix?, outFix? with
  | some inFix, some outFix =>
    let (ax, ay) := localOffset pivot.lat pivot.lon inFix.lat inFix.lon -- approach: towards the pivot
    -- `by` is a RESERVED keyword, so the departure components are `bx`/`bv`.
    let (bx, bv) := localOffset outFix.lat outFix.lon pivot.lat pivot.lon -- departure: away from it
    let magA := Float.sqrt (ax * ax + ay * ay)
    let magB := Float.sqrt (bx * bx + bv * bv)
    if magA == 0 || magB == 0 then false
    else (ax * bx + ay * bv) / (magA * magB) < REVERSAL_COS_MAX
  | _, _ => false

/--
Does the track double back at a segment boundary? The rail-run pass asks this
before growing a run across the boundary, because what follows a turnaround is
the ride back, not more of this ride.

The pivot is the fix nearest `boundaryTs` in TIME. The TS sorts by
`|a.ts − boundaryTs| − |b.ts − boundaryTs|` and takes `[0]`; V8's sort is stable,
so a boundary exactly between two fixes keeps the EARLIER one — which is what the
first-wins fold here reproduces.
-/
def reversesAt (points : Array PointF) (runStartTs boundaryTs lookAheadTs : Int) : Bool :=
  if points.isEmpty then false
  else
    let pivot := points.foldl (init := points[0]!) fun best p =>
      if (p.ts - boundaryTs).natAbs < (best.ts - boundaryTs).natAbs then p else best
    reversesAtPoint points ⟨pivot.ts, pivot.lat, pivot.lon⟩ runStartTs lookAheadTs

/--
The fix a leg turns round at, or `none` when it does not turn round.

The furthest fix from the leg's start is the candidate turnaround. It is only
accepted when the leg both RETURNS from it — ending far closer to its start than
that furthest point ever was — and genuinely reverses direction there.

The cut is then moved to the PLATFORM rather than the furthest fix: the extreme
fix is wherever the train happened to be at its outermost sample, which on
2026-07-07 was 455 m beyond Wembley Park and outside the station lookup's radius,
so the leg resolved to no station at all. The first fix at which the rider is
actually stopped is the one that names the interchange — unless taking it would
leave under a minute of ride behind, in which case the furthest fix stands.

The window and the extremes come from `fixes` (this leg's own) while
`reversesAtPoint` is handed ALL `points`, which looks like an asymmetry a
multi-leg day would expose. It is not — see the survivors note in the module
header — but the TS is reproduced as written.
-/
def turnaroundOf (seg : Seg) (points : Array PointF) : Option PointF :=
  if effectiveMode seg == "stationary" || seg.maxSpeed < REVERSAL_MIN_PEAK_KMH then none
  else
    let fixes := samplesInWindow points seg.startTs seg.endTs
    if fixes.size < 4 then none
    else
      let origin := fixes[0]!
      let (far, maxD) := fixes.foldl (init := (fixes[0]!, (0 : Float))) fun (bestP, bestD) p =>
        let d := haversineMeters p.lat p.lon origin.lat origin.lon
        if d > bestD then (p, d) else (bestP, bestD)
      if maxD < REVERSAL_MIN_SPAN_M then none
      else
        let last := fixes[fixes.size - 1]!
        let endD := haversineMeters last.lat last.lon origin.lat origin.lon
        if endD ≥ maxD * REVERSAL_RETURN_FRACTION then none
        else if far.ts - seg.startTs < REVERSAL_MIN_HALF_S
            || seg.endTs - far.ts < REVERSAL_MIN_HALF_S then none
        else if !reversesAtPoint points ⟨far.ts, far.lat, far.lon⟩ seg.startTs seg.endTs then none
        else
          let settled? := fixes.find? fun p =>
            p.ts ≥ far.ts && p.ts ≤ far.ts + TURNAROUND_SETTLE_S && p.speedKmh < TURNAROUND_STOPPED_KMH
          let cut := settled?.getD far
          some (if seg.endTs - cut.ts ≥ REVERSAL_MIN_HALF_S then cut else far)

/-- The per-half observations, recomputed from the fixes each half actually owns.
Copying the whole leg's speeds onto both would report a peak that never happened
in that window, which the kinematic invariants read as evidence. -/
structure Stats where
  pointCount : Int
  avgSpeed : Float
  maxSpeed : Float
  deriving Inhabited, BEq, Repr

/-- `statsOver`. The `Math.max(...)` spread would be `-Infinity` on an empty
array, which is why the TS returns zeros first. -/
def statsOver (points : Array PointF) (startTs endTs : Int) : Stats :=
  let fixes := samplesInWindow points startTs endTs
  if fixes.isEmpty then ⟨0, 0, 0⟩
  else
    let n := Float.ofNat fixes.size
    let sum := fixes.foldl (init := (0 : Float)) (· + ·.speedKmh)
    let peak := fixes.foldl (init := fixes[0]!.speedKmh) fun m p => max m p.speedKmh
    ⟨Int.ofNat fixes.size, jsRound (sum / n * 10) / 10, jsRound (peak * 10) / 10⟩

/-- `existing ? [...existing, kind] : [kind]` — the TS `addRefinedKind`. Lean's
`refinedKinds` is a plain `Array` because the pipeline's readers collapse
`undefined` and `[]`, and both branches of the TS produce the same list, so the
push is faithful for either. -/
def addRefinedKind (existing : Array String) (kind : String) : Array String :=
  existing.push kind

private def SPLIT_REASON : String :=
  "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them"

/-- `seg.refinedReason ? `${…}; ${reason}` : reason`. -/
def appendReason (seg : Seg) (reason : String) : String :=
  match seg.refinedReason with
  | some prior => if prior.isEmpty then reason else s!"{prior}; {reason}"
  | none => reason

/--
Split any motorised leg whose own fixes double back, at the turnaround.

Runs before the rail-run pass, so both halves get their own board/alight labels
from the existing machinery rather than needing to be named here.
-/
def splitReversingLegs (segments : Array Seg) (points : Array PointF) : Array Seg :=
  segments.foldl (init := #[]) fun out seg =>
    match turnaroundOf seg points with
    | none => out.push seg
    | some split =>
      let a := statsOver points seg.startTs split.ts
      let b := statsOver points split.ts seg.endTs
      let reason := appendReason seg SPLIT_REASON
      out
        |>.push { seg with
            endTs := split.ts, pointCount := a.pointCount, avgSpeed := a.avgSpeed,
            maxSpeed := a.maxSpeed, refinedReason := some reason,
            refinedKinds := addRefinedKind seg.refinedKinds "turnaround-alight" }
        |>.push { seg with
            startTs := split.ts, pointCount := b.pointCount, avgSpeed := b.avgSpeed,
            maxSpeed := b.maxSpeed, refinedReason := some reason,
            refinedKinds := addRefinedKind seg.refinedKinds "turnaround-board" }

/-- The projection the guards compare: everything the pass can change, and
nothing it merely copies. -/
def projSeg (s : Seg) : Int × Int × Int × Float × Float × Option String × Array String :=
  (s.startTs, s.endTs, s.pointCount, s.avgSpeed, s.maxSpeed, s.refinedReason, s.refinedKinds)

/-- Guard helper: the `hypot`-vs-`sqrt` and `cos` wobble means a metre value is
compared with a tolerance rather than for bit equality. -/
def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

/-! ## Guards

GENERATED by `lean/experiments/reversal-refs.mts` — do not hand-edit. Every
number below is V8's own answer from the real `src/geo/passes/reversal.ts`,
transcribed at full precision.
-/

namespace Guards

private def OUT_AND_BACK : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.540328028851775, (-0.10848393651334032), 70.0⟩, ⟨1751000240, 51.553032067320814, (-0.0880625185311274), 75.0⟩, ⟨1751000360, 51.5663713077133, (-0.06662002964980385), 60.0⟩, ⟨1751000420, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000450, 51.56884859521476, (-0.06263785314327233), 2.0⟩, ⟨1751000600, 51.56878507502242, (-0.0627399602331834), 1.0⟩, ⟨1751000720, 51.55747848078497, (-0.08091502223735289), 65.0⟩, ⟨1751000840, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751000960, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def NO_SETTLE : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.540328028851775, (-0.10848393651334032), 70.0⟩, ⟨1751000240, 51.553032067320814, (-0.0880625185311274), 75.0⟩, ⟨1751000360, 51.5663713077133, (-0.06662002964980385), 60.0⟩, ⟨1751000420, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000450, 51.56884859521476, (-0.06263785314327233), 20.0⟩, ⟨1751000600, 51.56878507502242, (-0.0627399602331834), 12.0⟩, ⟨1751000640, 51.56256009617259, (-0.07274645504446772), 40.0⟩, ⟨1751000720, 51.55747848078497, (-0.08091502223735289), 65.0⟩, ⟨1751000840, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751000960, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def LATE_SETTLE : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.540328028851775, (-0.10848393651334032), 70.0⟩, ⟨1751000240, 51.553032067320814, (-0.0880625185311274), 75.0⟩, ⟨1751000360, 51.5663713077133, (-0.06662002964980385), 60.0⟩, ⟨1751000420, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000560, 51.56884859521476, (-0.06263785314327233), 2.0⟩, ⟨1751000580, 51.54985605770355, (-0.09316787302668063), 70.0⟩, ⟨1751000590, 51.540328028851775, (-0.10848393651334032), 70.0⟩, ⟨1751000600, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def SPIKE : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.535246413464165, (-0.11665250370622547), 70.0⟩, ⟨1751000240, 51.53905762500487, (-0.11052607831156161), 75.0⟩, ⟨1751000300, 51.53439324469996, (-0.08047963058999705), 80.0⟩, ⟨1751000360, 51.540328028851775, (-0.10848393651334032), 60.0⟩, ⟨1751000480, 51.53651681731107, (-0.11461036190800418), 65.0⟩, ⟨1751000600, 51.53270560577035, (-0.12073678730266806), 50.0⟩]
private def SHORT_RETURN : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751000240, 51.55620807693807, (-0.08295716403557418), 75.0⟩, ⟨1751000420, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000450, 51.56884859521476, (-0.06263785314327233), 2.0⟩, ⟨1751000720, 51.56256009617259, (-0.07274645504446772), 65.0⟩, ⟨1751000960, 51.55620807693807, (-0.08295716403557418), 50.0⟩]
private def TIGHT : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.53461121154071, (-0.11767357460533612), 70.0⟩, ⟨1751000240, 51.53842242308142, (-0.11154714921067224), 45.0⟩, ⟨1751000300, 51.53835890288907, (-0.11164925630058331), 2.0⟩, ⟨1751000480, 51.53461121154071, (-0.11767357460533612), 65.0⟩, ⟨1751000600, 51.53143520192345, (-0.12277892910088935), 50.0⟩]
private def EARLY_TURN : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000020, 51.54985605770355, (-0.09316787302668063), 75.0⟩, ⟨1751000030, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000045, 51.56884859521476, (-0.06263785314327233), 2.0⟩, ⟨1751000300, 51.54985605770355, (-0.09316787302668063), 70.0⟩, ⟨1751000600, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def LATE_TURN : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000200, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751000400, 51.55620807693807, (-0.08295716403557418), 75.0⟩, ⟨1751000570, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000580, 51.54985605770355, (-0.09316787302668063), 70.0⟩, ⟨1751000590, 51.53715201923452, (-0.11358929100889353), 70.0⟩, ⟨1751000600, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def THREE : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000300, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751000600, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
private def LOOP : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 60.0⟩, ⟨1751000120, 51.532244210523345, (-0.1151359261179994), 60.0⟩, ⟨1751000240, 51.53618986704995, (-0.10879338383584446), 60.0⟩, ⟨1751000360, 51.54157973409989, (-0.10647185223599881), 60.0⟩, ⟨1751000480, 51.54696960114984, (-0.10879338383584446), 60.0⟩, ⟨1751000600, 51.55091525767644, (-0.1151359261179994), 60.0⟩, ⟨1751000720, 51.55235946819978, (-0.1238), 2.0⟩, ⟨1751000840, 51.55091525767644, (-0.13246407388200057), 60.0⟩, ⟨1751000960, 51.54696960114984, (-0.13880661616415552), 60.0⟩, ⟨1751001080, 51.54157973409989, (-0.14112814776400118), 60.0⟩, ⟨1751001200, 51.53618986704995, (-0.13880661616415554), 60.0⟩, ⟨1751001320, 51.532244210523345, (-0.1324640738820006), 60.0⟩, ⟨1751001440, 51.5308, (-0.1238), 60.0⟩]
private def SPAN_1400 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.533764275642774, (-0.11903500247081698), 70.0⟩, ⟨1751000200, 51.53672855128555, (-0.11427000494163397), 75.0⟩, ⟨1751000300, 51.539692826928324, (-0.10950500741245096), 30.0⟩, ⟨1751000330, 51.53962930673598, (-0.10960711450236202), 2.0⟩, ⟨1751000450, 51.53556401442589, (-0.11614196825667016), 65.0⟩, ⟨1751000600, 51.53143520192345, (-0.12277892910088935), 50.0⟩]
private def SPAN_1600 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.534187743591744, (-0.11835428853807656), 70.0⟩, ⟨1751000200, 51.53757548718349, (-0.11290857707615311), 75.0⟩, ⟨1751000300, 51.540963230775226, (-0.10746286561422967), 30.0⟩, ⟨1751000330, 51.540899710582885, (-0.10756497270414073), 2.0⟩, ⟨1751000450, 51.53619921634934, (-0.11512089735755951), 65.0⟩, ⟨1751000600, 51.53143520192345, (-0.12277892910088935), 50.0⟩]
private def RETURN_40 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000330, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000450, 51.553032067320814, (-0.0880625185311274), 65.0⟩, ⟨1751000600, 51.54350403846904, (-0.10337858201778709), 50.0⟩]
private def HALF_50 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000017, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000033, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000050, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000070, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000325, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000600, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def HALF_65 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000022, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000043, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000065, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000085, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000333, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000600, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def SETTLE_150 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000450, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def SETTLE_250 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000550, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def STOP_4 : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000360, 51.56249657598024, (-0.07284856213437879), 4.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def STOP_EXACT : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000360, 51.56249657598024, (-0.07284856213437879), 5.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def SETTLE_EDGE : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000480, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def DUP_TURN : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.0⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 75.0⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000300, 51.560019288478784, (-0.0768307386409103), 2.0⟩, ⟨1751000360, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 65.0⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def FRACTIONAL : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.55⟩, ⟨1751000100, 51.541386698724196, (-0.10678215168148925), 70.25⟩, ⟨1751000200, 51.55197339744839, (-0.08976430336297848), 63.34⟩, ⟨1751000300, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000330, 51.56249657598024, (-0.07284856213437879), 2.0⟩, ⟨1751000600, 51.547315250009746, (-0.09725215662312321), 48.96⟩, ⟨1751000900, 51.5320704038469, (-0.1217578582017787), 51.07⟩]
private def EQUIDISTANT : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000100, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751000200, 51.56256009617259, (-0.07274645504446772), 30.0⟩, ⟨1751000260, 51.56256009617259, (-0.17485354495553226), 30.0⟩, ⟨1751000500, 51.54350403846904, (-0.10337858201778709), 65.0⟩, ⟨1751000800, 51.5320704038469, (-0.1217578582017787), 50.0⟩]
private def CURVED_APPROACH : Array PointF := #[⟨1751000000, 51.55774933524973, (-0.1238), 60.0⟩, ⟨1751000120, 51.55774933524973, (-0.1526802462733353), 60.0⟩, ⟨1751000240, 51.54157973409989, (-0.1613443201553359), 60.0⟩, ⟨1751000360, 51.5308, (-0.13246407388200057), 60.0⟩, ⟨1751000480, 51.5308, (-0.1238), 3.0⟩, ⟨1751000600, 51.5308, (-0.1367961108230009), 60.0⟩, ⟨1751000720, 51.5308, (-0.15556827090066883), 60.0⟩]

-- The two EXPORTED constants, read by the rail-run pass as well as here.
#guard DIRECTION_ARM_M == 500.0
#guard REVERSAL_COS_MAX == (-0.5)

/-! Every scenario's whole output list, projected to the fields the pass can
change. `statsOver` is pinned through the halves' own `pointCount` /
`avgSpeed` / `maxSpeed` — the TS recomputes them per half rather than copying
the leg's, so a half's peak is one that happened in ITS window. -/

-- S1: the 2026-07-07 shape: out 6 km, platform wait, back. Splits at the SETTLED fix, not the furthest one — the furthest fix is 10 m further out and still rolling.
--     MEASURED: SPLITS at the settled fix (+450 s), not the furthest (+420 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000450, 6, 48.7, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000450, 1751000960, 5, 37.6, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S2: never settles inside the 180 s window, so the cut falls back to the furthest fix.
--     MEASURED: SPLITS at the furthest fix (+420 s) — never settled
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 11, refinedReason := none, refinedKinds := #[] }] NO_SETTLE).map projSeg ==
  #[(1751000000, 1751000420, 5, 58.0, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000420, 1751000960, 7, 41.0, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S3: settles, but too late to leave a minute of ride behind it — falls back to `far` rather than slicing a tail off.
--     MEASURED: SPLITS at the furthest fix (+420 s) — settled too late (+560 s leaves 40 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 9, refinedReason := none, refinedKinds := #[] }] LATE_SETTLE).map projSeg ==
  #[(1751000000, 1751000420, 5, 58.0, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000420, 1751000600, 5, 44.4, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S4: a lone far-flung spike. The distance test ACCEPTS it (out 3 km, back to 300 m); only the direction test refuses, because the track approaches and leaves the spike on the same heading.
--     MEASURED: SPLITS at the furthest fix (+300 s) — never settled
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SPIKE).map projSeg ==
  #[(1751000000, 1751000300, 4, 70.0, 80.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000300, 1751000600, 4, 63.8, 80.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S5: the return stops 4 km out of a 6 km span — 0.667 of the way, over the half bar.
--     MEASURED: return: ended 3995 m out of a 5992 m span
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SHORT_RETURN).map projSeg ==
  #[(1751000000, 1751000960, 7, 50.0, 75.0, none, #[])]

-- S6: a genuine reversal inside 1.2 km — under the span bar, so it is a manoeuvre, not a journey with a change in it.
--     MEASURED: span: reached only 1199 m < 1500
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 6, refinedReason := none, refinedKinds := #[] }] TIGHT).map projSeg ==
  #[(1751000000, 1751000600, 6, 50.0, 75.0, none, #[])]

-- S7: turnaround 30 s in: the first half would not be a ride.
--     MEASURED: first half: 30 s < 60
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 6, refinedReason := none, refinedKinds := #[] }] EARLY_TURN).map projSeg ==
  #[(1751000000, 1751000600, 6, 50.0, 75.0, none, #[])]

-- S8: turnaround 30 s from the end: the mirror bar, on the second half.
--     MEASURED: second half: 30 s < 60
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] LATE_TURN).map projSeg ==
  #[(1751000000, 1751000600, 7, 50.0, 75.0, none, #[])]

-- S9: three fixes — under the arity floor.
--     MEASURED: arity: 3 fixes < 4
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 3, refinedReason := none, refinedKinds := #[] }] THREE).map projSeg ==
  #[(1751000000, 1751000600, 3, 50.0, 75.0, none, #[])]

-- S10: a LOOP: out 2.4 km and back to the start, turning gently the whole way. The span and return bars both PASS — the direction test is the only thing refusing, and the only measured shape that reaches it.
--     MEASURED: DIRECTION: the arms do not oppose
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751001440, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 13, refinedReason := none, refinedKinds := #[] }] LOOP).map projSeg ==
  #[(1751000000, 1751001440, 13, 50.0, 75.0, none, #[])]

-- S11: the same track the classifier called `stationary` — only a motorised leg is split.
--     MEASURED: mode: not motorised
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "stationary", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000960, 10, 50.0, 75.0, none, #[])]

-- S12: `refinedMode` decides, not `mode`: a leg the classifier called `train` and a later pass refined to `stationary` is NOT split.
--     MEASURED: mode: not motorised
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := some "stationary", avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000960, 10, 50.0, 75.0, none, #[])]

-- S13: peak 39.9 km/h — under the motorised bar. An out-and-back stroll is one walk.
--     MEASURED: peak: maxSpeed 39.9 < 40
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "walking", refinedMode := none, avgSpeed := 50.0, maxSpeed := 39.9, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000960, 10, 50.0, 39.9, none, #[])]

-- S14: peak exactly 40 — the bar is `< 40`, so this one splits.
--     MEASURED: SPLITS at the settled fix (+450 s), not the furthest (+420 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 40.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000450, 6, 48.7, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000450, 1751000960, 5, 37.6, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S15: an existing reason and an existing kind: both halves APPEND rather than replace, and each half gets its OWN kind.
--     MEASURED: SPLITS at the settled fix (+450 s), not the furthest (+420 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 10, refinedReason := some "prior finding", refinedKinds := #["boarding-platform"] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000450, 6, 48.7, 75.0, some "prior finding; split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["boarding-platform", "turnaround-alight"]), (1751000450, 1751000960, 5, 37.6, 70.0, some "prior finding; split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["boarding-platform", "turnaround-board"])]

-- S16: `maxSpeed` is read off the SEGMENT, not derived from the fixes — the classifier's record is what the bar tests. Here the fixes peak at 75 and the record says 20, and the leg is left alone.
--     MEASURED: peak: maxSpeed 20 < 40
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 20.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }] OUT_AND_BACK).map projSeg ==
  #[(1751000000, 1751000960, 10, 50.0, 20.0, none, #[])]

-- B1: reaches 1400 m — under the span bar.
--     MEASURED: span: reached only 1398 m < 1500
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SPAN_1400).map projSeg ==
  #[(1751000000, 1751000600, 7, 50.0, 75.0, none, #[])]

-- B2: reaches 1600 m — over it. B1/B2 straddle 1500.
--     MEASURED: SPLITS at the settled fix (+330 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SPAN_1600).map projSeg ==
  #[(1751000000, 1751000330, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000330, 1751000600, 3, 39.0, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B3: ends 2 km out of a 5 km span — 0.4 of the way, under the half bar. With SHORT_RETURN's 0.667 above it, the fraction is straddled.
--     MEASURED: SPLITS at the settled fix (+330 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] RETURN_40).map projSeg ==
  #[(1751000000, 1751000330, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000330, 1751000600, 3, 39.0, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B4: turns 50 s in — under the 60 s half bar.
--     MEASURED: first half: 50 s < 60
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] HALF_50).map projSeg ==
  #[(1751000000, 1751000600, 7, 50.0, 75.0, none, #[])]

-- B5: turns 65 s in — over it. B4/B5 straddle 60.
--     MEASURED: SPLITS at the settled fix (+85 s), not the furthest (+65 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] HALF_65).map projSeg ==
  #[(1751000000, 1751000085, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000085, 1751000600, 3, 39.0, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B6: settles 150 s after the turnaround — inside the 180 s window, so the cut moves to the platform.
--     MEASURED: SPLITS at the settled fix (+450 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SETTLE_150).map projSeg ==
  #[(1751000000, 1751000450, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000450, 1751000900, 3, 39.0, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B7: settles 250 s after it — outside the window, so the cut stays at the furthest fix. B6/B7 straddle 180.
--     MEASURED: SPLITS at the furthest fix (+300 s) — never settled
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SETTLE_250).map projSeg ==
  #[(1751000000, 1751000300, 4, 57.5, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000300, 1751000900, 4, 36.8, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B8: the slow fix reads 4 km/h — under the 5 km/h disembark bar, over a 3 km/h one.
--     MEASURED: SPLITS at the settled fix (+360 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] STOP_4).map projSeg ==
  #[(1751000000, 1751000360, 5, 46.8, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000360, 1751000900, 3, 39.7, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B9: EXACTLY 5 km/h. The test is `< 5`, so this fix does NOT count as stopped and the cut stays at the furthest fix — the strictness pinned by a fixture value rather than by hunting a coordinate.
--     MEASURED: SPLITS at the furthest fix (+300 s) — never settled
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] STOP_EXACT).map projSeg ==
  #[(1751000000, 1751000300, 4, 57.5, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000300, 1751000900, 4, 37.5, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B10: the slow fix sits EXACTLY on the 180 s window edge; `≤` admits it, so the cut moves.
--     MEASURED: SPLITS at the settled fix (+480 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] SETTLE_EDGE).map projSeg ==
  #[(1751000000, 1751000480, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000480, 1751000900, 3, 39.0, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B11: a DUPLICATE timestamp at the turnaround — a slow fix sharing the furthest fix's second. `p.ts ≥ far.ts` admits it.
--     MEASURED: SPLITS at the settled fix (+300 s), which is also the furthest
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 8, refinedReason := none, refinedKinds := #[] }] DUP_TURN).map projSeg ==
  #[(1751000000, 1751000300, 5, 46.4, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000300, 1751000900, 5, 29.8, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B12: fractional speeds, so `Math.round(x*10)/10` is observable at all — every other fixture uses whole km/h, under which the rounding is the identity.
--     MEASURED: SPLITS at the settled fix (+330 s), not the furthest (+300 s)
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000900, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 7, refinedReason := none, refinedKinds := #[] }] FRACTIONAL).map projSeg ==
  #[(1751000000, 1751000330, 5, 44.2, 70.3, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000330, 1751000900, 3, 34.0, 51.1, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- B13: two fixes the SAME distance from the origin. The max-fold keeps the EARLIER, so the cut lands on it; `≥` would keep the later one and move the cut — unlike a plain maximum, this tie is observable.
--     MEASURED: SPLITS at the furthest fix (+200 s) — never settled
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000800, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 6, refinedReason := none, refinedKinds := #[] }] EQUIDISTANT).map projSeg ==
  #[(1751000000, 1751000200, 3, 51.7, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751000200, 1751000800, 4, 43.8, 65.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"])]

-- S17: three legs on one stream — only the middle one reverses, and the
-- pass preserves ORDER while growing the list from 3 to 4.
private def S17_FIXES : Array PointF := #[⟨1751000000, 51.5308, (-0.1238), 55.0⟩, ⟨1751000120, 51.53461121154071, (-0.11767357460533612), 70.0⟩, ⟨1751000240, 51.53842242308142, (-0.11154714921067224), 45.0⟩, ⟨1751000300, 51.53835890288907, (-0.11164925630058331), 2.0⟩, ⟨1751000480, 51.53461121154071, (-0.11767357460533612), 65.0⟩, ⟨1751000600, 51.53143520192345, (-0.12277892910088935), 50.0⟩, ⟨1751002000, 51.5308, (-0.1238), 55.0⟩, ⟨1751002120, 51.540328028851775, (-0.10848393651334032), 70.0⟩, ⟨1751002240, 51.553032067320814, (-0.0880625185311274), 75.0⟩, ⟨1751002360, 51.5663713077133, (-0.06662002964980385), 60.0⟩, ⟨1751002420, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751002450, 51.56884859521476, (-0.06263785314327233), 2.0⟩, ⟨1751002600, 51.56878507502242, (-0.0627399602331834), 1.0⟩, ⟨1751002720, 51.55747848078497, (-0.08091502223735289), 65.0⟩, ⟨1751002840, 51.54350403846904, (-0.10337858201778709), 70.0⟩, ⟨1751002960, 51.533340807693804, (-0.11971571640355741), 50.0⟩, ⟨1751004000, 51.5308, (-0.1238), 55.0⟩, ⟨1751004300, 51.56891211540711, (-0.06253574605336126), 30.0⟩, ⟨1751004600, 51.533340807693804, (-0.11971571640355741), 50.0⟩]
#guard (splitReversingLegs #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 6, refinedReason := none, refinedKinds := #[] }, { startTs := 1751002000, endTs := 1751002960, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 10, refinedReason := none, refinedKinds := #[] }, { startTs := 1751004000, endTs := 1751004600, mode := "train", refinedMode := none, avgSpeed := 50.0, maxSpeed := 75.0, linearity := 0.9, pointCount := 3, refinedReason := none, refinedKinds := #[] }] S17_FIXES).map projSeg ==
  #[(1751000000, 1751000600, 6, 50.0, 75.0, none, #[]), (1751002000, 1751002450, 6, 48.7, 75.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-alight"]), (1751002450, 1751002960, 5, 37.6, 70.0, some "split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them", #["turnaround-board"]), (1751004000, 1751004600, 3, 50.0, 75.0, none, #[])]

/-! ### `reversesAtPoint` — the direction test, called directly. -/

-- P1: the real turnaround: arms oppose.
#guard reversesAtPoint OUT_AND_BACK ⟨1751000420, 51.56891211540711, (-0.06253574605336126)⟩ 1751000000 1751000960 == true

-- P2: the spike, and the answer is TRUE. The module docstring says a spike fails this test because the track leaves it on the same heading; it does not — the track must come BACK from a spike, and coming back is exactly what the arms read as opposing.
#guard reversesAtPoint SPIKE ⟨1751000300, 51.53439324469996, (-0.08047963058999705)⟩ 1751000000 1751000600 == true

-- P3: the far side of a loop: the track is turning, but over the 500 m arms it has turned only ~48°, nowhere near a doubling-back.
#guard reversesAtPoint LOOP ⟨1751000720, 51.55235946819978, (-0.1238)⟩ 1751000000 1751001440 == false

-- P4: the window CUTS OFF the approach: `fromTs` sits after every fix 500 m back, so the in-arm is unobserved and the answer is false. A test that cannot see is not evidence of a reversal.
#guard reversesAtPoint OUT_AND_BACK ⟨1751000420, 51.56891211540711, (-0.06253574605336126)⟩ 1751000361 1751000960 == false

-- P5: the window cuts off the DEPARTURE — the mirror of P4.
#guard reversesAtPoint OUT_AND_BACK ⟨1751000420, 51.56891211540711, (-0.06253574605336126)⟩ 1751000000 1751000600 == false

-- P6: the pivot's own fix is EXCLUDED from both arms (`< pivot.ts` / `> pivot.ts`) — the two nearest fixes are inside the arm radius anyway, and the arms are read from the first fix at least 500 m out on each side.
#guard reversesAtPoint OUT_AND_BACK ⟨1751000450, 51.56884859521476, (-0.06263785314327233)⟩ 1751000000 1751000960 == true

-- P9: a CURVED approach: the track comes down from the north, swings west, and reaches the pivot heading east. Several fixes qualify as the in-arm and they point in different directions, so the LAST one — the nearest — is the approach, and taking the first instead reads a different heading. On a straight track the two agree, which is why no earlier fixture reached this.
#guard reversesAtPoint CURVED_APPROACH ⟨1751000480, 51.5308, (-0.1238)⟩ 1751000000 1751000720 == true

-- P7: the arm radius. The nearest candidate sits at
--     499.8999999999993 m and is SKIPPED; the one used is at
--     500.0999999999994 m. Both are within 1 cm of the 500 m
--     bar, which is as close as a haversine over real coordinates gets to
--     it — an output landing exactly on 500.0 is not reachable by search
--     (one latitude ULP moves the distance ~8e-10 m against an output ULP
--     of ~1e-13 m). So the CONSTANT is pinned and the strictness is not.
private def ARM : Array PointF := #[⟨1751000000, 51.52761983758988, (-0.12891203000421372), 60.0⟩, ⟨1751000060, 51.52762110937828, (-0.12890998563677328), 60.0⟩, ⟨1751000120, 51.5308, (-0.1238), 5.0⟩, ⟨1751000180, 51.52571838461238, (-0.13196856719288516), 60.0⟩]
#guard reversesAtPoint ARM ⟨1751000120, 51.5308, (-0.1238)⟩ 1751000000 1751000180 == true
#guard approx (haversineMeters 51.52762110937828 (-0.12890998563677328) 51.5308 (-0.1238)) 499.8999999999993
#guard approx (haversineMeters 51.52761983758988 (-0.12891203000421372) 51.5308 (-0.1238)) 500.0999999999994

-- P8/119: a 119° turn — short of the 120° bar.
private def TURN119 : Array PointF := #[⟨1751000000, 51.52635358653583, (-0.1309474962937745), 60.0⟩, ⟨1751000060, 51.5308, (-0.1238), 5.0⟩, ⟨1751000120, 51.52475541513513, (-0.12101383384865594), 60.0⟩]
#guard reversesAtPoint TURN119 ⟨1751000060, 51.5308, (-0.1238)⟩ 1751000000 1751000120 == false

-- P8/121: a 121° turn — past the 120° bar.
private def TURN121 : Array PointF := #[⟨1751000000, 51.52635358653583, (-0.1309474962937745), 60.0⟩, ⟨1751000060, 51.5308, (-0.1238), 5.0⟩, ⟨1751000120, 51.524698607542284, (-0.12135463262665931), 60.0⟩]
#guard reversesAtPoint TURN121 ⟨1751000060, 51.5308, (-0.1238)⟩ 1751000000 1751000120 == true

-- P8/MIDCOS: a MIDCOS° turn — short of the 120° bar.
private def TURNMIDCOS : Array PointF := #[⟨1751000000, 51.52635358653583, (-0.1309474962937745), 60.0⟩, ⟨1751000060, 51.5308, (-0.1238), 5.0⟩, ⟨1751000120, 51.524726029445446, (-0.12118417560069801), 60.0⟩]
#guard reversesAtPoint TURNMIDCOS ⟨1751000060, 51.5308, (-0.1238)⟩ 1751000000 1751000120 == false

/-! ### `reversesAt` — the boundary form the rail-run pass calls. -/

-- A1: the boundary lands on the turnaround: the run pass must not grow across it.
#guard reversesAt OUT_AND_BACK 1751000000 1751000420 1751000960 == true

-- A2: the pivot is chosen by |ts − boundary|, so a boundary BETWEEN fixes still picks the nearest one — here 20 s after the turnaround fix and 10 s before the settled one, so the settled fix wins.
#guard reversesAt OUT_AND_BACK 1751000000 1751000440 1751000960 == true

-- A3: a boundary out on the straight outbound run — no reversal there.
#guard reversesAt OUT_AND_BACK 1751000000 1751000240 1751000960 == false

-- A4: the look-ahead stops short of the return, so the departure arm is unobserved.
#guard reversesAt OUT_AND_BACK 1751000000 1751000420 1751000600 == false

-- A5: no fixes at all — no pivot, so no reversal.
#guard reversesAt #[] 1751000000 1751000100 1751000200 == false

-- A6: a boundary EXACTLY between two fixes, which sit 3 km apart. V8's
--     `sort` is stable, so the EARLIER of the tied pair is the pivot — and
--     at that pivot the track is running straight through, while at the
--     later one it doubles back. So the tie-break decides the answer.
private def TIE : Array PointF := #[⟨1751000000, 51.52444798076548, (-0.13401070899110645), 60.0⟩, ⟨1751000100, 51.5308, (-0.1238), 60.0⟩, ⟨1751000200, 51.54985605770355, (-0.09316787302668063), 60.0⟩, ⟨1751000300, 51.52444798076548, (-0.13401070899110645), 60.0⟩]
#guard reversesAt TIE 1751000000 1751000150 1751000300 == false

-- P10: a fix sharing the pivot's SECOND. Excluded from both arms, so the
--      approach is read from the south-west fix and the departure from the
--      south-west one — they oppose. Admitting the shared-second fix into
--      either arm would make that arm point north-east and the two agree,
--      so this one fixture pins both exclusions.
private def DUP_PIVOT : Array PointF := #[⟨1751000000, 51.52571838461238, (-0.13196856719288516), 60.0⟩, ⟨1751000060, 51.53651681731107, (-0.11461036190800418), 60.0⟩, ⟨1751000120, 51.52508318268893, (-0.1329896380919958), 60.0⟩]
#guard reversesAtPoint DUP_PIVOT ⟨1751000060, 51.5308, (-0.1238)⟩ 1751000000 1751000120 == true

end Guards

end Verified.Geo.Reversal
