import Verified.Geo.Kalman
/-!
# GPS quality-control pre-filter (implementation-first port of `src/geo/gps-quality.ts`)

Runs BEFORE the Kalman filter: drop physically-incoherent runs of GPS fixes
(underground / cell-tower garbage) so downstream gap-inference sees an honest
temporal gap. An anchor walk — keep the last trusted fix as an anchor; a
candidate reachable from it at a plausible speed is kept and becomes the new
anchor; an unreachable-or-inaccurate-moving candidate starts a suspected garbage
run, and a forward bridge scan finds the surfacing fix on the far side (dropping
the run) unless the run is genuine sustained fast travel (no bridge) or
poor-accuracy jitter that never travelled (kept).

Pure over the track; the only transcendental is `cos` in `distanceM` (≤1 ULP),
and every decision is a threshold well clear of the boundary on real data, so the
KEPT SET is exact (a subset of the input, coords unchanged — like `dropGpsOutliers`).
UNPROVEN; pinned by the `#guard`.
-/

namespace Verified.Geo.GpsQuality

open Verified.Geo.Kalman (GpsPoint)

def SPEED_CEILING_KMH : Float := 150
def BRIDGE_WINDOW_S : Int := 1800
def ACCURACY_CEILING_M : Float := 80
def GARBAGE_MIN_SPEED_KMH : Float := 15
def MIN_TRANSIT_DISPLACEMENT_M : Float := 800
/-- Accuracy (m) above which a fix is not a position at all, and is dropped
whether or not it moved. `inaccurateMotion` keeps a poor-accuracy fix that is
going nowhere on purpose — an indoor sit reports the same cell-tower grade as a
tube ride — but that trade holds only while the fix still says roughly WHERE you
are. Beyond the distance at which this module distinguishes "here" from "a
station away" (`MIN_TRANSIT_DISPLACEMENT_M`, the resolution of its own
decision), the measurement cannot inform any question asked of it. -/
def ACCURACY_UNINFORMATIVE_M : Float := MIN_TRANSIT_DISPLACEMENT_M
private def pi : Float := 3.141592653589793

def distanceM (a b : GpsPoint) : Float :=
  let dLatM := (b.lat - a.lat) * 111320
  let dLonM := (b.lon - a.lon) * 111320 * Float.cos (a.lat * pi / 180)
  Float.sqrt (dLatM ^ 2 + dLonM ^ 2)

/-- Point-to-point speed (km/h); duplicate/out-of-order ts ⇒ 0 (treated reachable). -/
def impliedSpeedKmh (a b : GpsPoint) : Float :=
  let dt := b.ts - a.ts
  if decide (dt ≤ 0) then 0 else distanceM a b / dt.toNat.toFloat * 3.6

/-- Unreachable from the anchor at any plausible ground speed — always garbage. -/
def speedUnreachable (anchor cand : GpsPoint) : Bool := decide (impliedSpeedKmh anchor cand > SPEED_CEILING_KMH)

/-- Cell-tower-grade movement: poor-accuracy AND moved at non-pedestrian speed. -/
def inaccurateMotion (anchor cand : GpsPoint) : Bool :=
  match cand.accuracy with
  | some acc => decide (acc > ACCURACY_CEILING_M) && decide (impliedSpeedKmh anchor cand > GARBAGE_MIN_SPEED_KMH)
  | none => false

def isGarbage (anchor cand : GpsPoint) : Bool := speedUnreachable anchor cand || inaccurateMotion anchor cand

/-- Position trustworthy enough to anchor / bridge from (good accuracy). -/
def trustworthy (p : GpsPoint) : Bool :=
  match p.accuracy with | some acc => decide (acc ≤ ACCURACY_CEILING_M) | none => true

/-- First fix `≥ j` that can bridge the garbage run: reachable, trustworthy, and
    the start of a coherent run (its own successor reachable). Stops at the
    `BRIDGE_WINDOW_S` horizon. -/
partial def findBridge (points : Array GpsPoint) (anchor : GpsPoint) (j : Nat) : Option Nat :=
  if j ≥ points.size then none
  else if decide (points[j]!.ts - anchor.ts > BRIDGE_WINDOW_S) then none
  else if isGarbage anchor points[j]! || !trustworthy points[j]! then findBridge points anchor (j + 1)
  else
    let coherentSuccessor := j + 1 ≥ points.size || decide (impliedSpeedKmh points[j]! points[j+1]! ≤ SPEED_CEILING_KMH)
    if coherentSuccessor then some j else findBridge points anchor (j + 1)

/-- The anchor walk over the remaining track. -/
partial def walk (points : Array GpsPoint) (kept : Array GpsPoint) (i : Nat) : Array GpsPoint :=
  if i ≥ points.size then kept
  else
    let anchor := kept[kept.size - 1]!
    let cand := points[i]!
    if !isGarbage anchor cand then walk points (kept.push cand) (i + 1)
    else match findBridge points anchor (i + 1) with
      | some b =>
        let travelled := decide (distanceM anchor points[b]! > MIN_TRANSIT_DISPLACEMENT_M)
        if speedUnreachable anchor cand || travelled then walk points (kept.push points[b]!) (b + 1)
        else walk points (kept.push cand) (i + 1)
      | none => walk points (kept.push cand) (i + 1)

/-- Drop incoherent GPS runs; surviving fixes in input order. Fixes the phone
itself disclaims go first, before anything reasons from them — including before
the walk can make one an anchor, a bridge, or the thing a later fix is judged
"unreachable" from. -/
def qualityFilterGps (input : Array GpsPoint) : Array GpsPoint :=
  let points := input.filter fun p =>
    match p.accuracy with | some acc => decide (acc ≤ ACCURACY_UNINFORMATIVE_M) | none => true
  if points.size ≤ 2 then points else walk points #[points[0]!] 1

-- Parity with the real `qualityFilterGps` (kept-set ts from Node/V8): teleport
-- (t=20) and a poor-accuracy tube run (t=100) dropped; poor-accuracy jitter
-- (t=180, net < 800 m) kept.
private def gp (ts : Int) (lat lon : Float) (acc : Float) : GpsPoint := ⟨ts, lat, lon, some acc⟩
private def track : Array GpsPoint := #[
  gp 0 51.50 (-0.10) 20, gp 10 51.501 (-0.10) 20,
  gp 20 51.60 (-0.10) 20,            -- teleport
  gp 30 51.502 (-0.10) 20, gp 40 51.503 (-0.10) 20,
  gp 100 51.52 (-0.10) 100,          -- poor-accuracy tube run (travelled)
  gp 160 51.53 (-0.10) 20, gp 170 51.531 (-0.10) 20,
  gp 180 51.5315 (-0.10) 100,        -- poor-accuracy jitter (kept)
  gp 190 51.5312 (-0.10) 20]

#guard (qualityFilterGps track).map (·.ts) == #[0, 10, 30, 40, 160, 170, 180, 190]
#guard (qualityFilterGps #[gp 0 51.5 (-0.1) 20, gp 10 51.5 (-0.1) 20]).size == 2  -- ≤2 pass through

/-! ### Branch guards

The two guards above pin the shape a real day takes. They do not reach a null
accuracy, a duplicate timestamp, or a bridge scan that runs past its horizon —
and 32 days of real London track do not reach those either, so a port could get
any of them wrong and still measure 32/32 exact against TS.

Every expectation below is what `src/geo/gps-quality.ts` actually returned under
Node v24.18.0, not a value reasoned about here; regenerate with
`npx tsx lean/experiments/gpsquality-refs.mts` after any change to the filter.
A disagreement means the port and the original have diverged, which is the only
question these guards exist to answer. -/

private def gpn (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, none⟩

-- `inaccurateMotion` → `none ⇒ false`, `trustworthy` → `none ⇒ true`. With no
-- accuracy anywhere only the speed ceiling can condemn a fix: the t=20 teleport
-- must still go, and t=30 must be trusted as its bridge with nothing to judge
-- its accuracy by.
private def nullAccuracy : Array GpsPoint := #[
  gpn 0 51.5 (-0.1), gpn 10 51.501 (-0.1), gpn 20 51.6 (-0.1), gpn 30 51.502 (-0.1), gpn 40 51.503 (-0.1)]
#guard (qualityFilterGps nullAccuracy).map (·.ts) == #[0, 10, 30, 40]

-- `impliedSpeedKmh` → `dt ≤ 0 ⇒ 0`. Note what the expectation says: EVERY fix
-- survives, teleports included. A fix sharing or preceding its anchor's
-- timestamp has no defined speed, and the filter's documented choice is to
-- treat it as reachable rather than infinite — so it is invisible here. That is
-- the TS behaviour and the port must reproduce it; a port dividing by `dt`
-- would get `inf`, read it as unreachable, and drop fixes TS keeps.
private def duplicateTs : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 0 51.6 (-0.1) 20, gp 10 51.501 (-0.1) 20, gp 5 51.7 (-0.1) 20, gp 20 51.502 (-0.1) 20]
#guard (qualityFilterGps duplicateTs).map (·.ts) == #[0, 0, 10, 5, 20]

-- `findBridge` → `none` at the `BRIDGE_WINDOW_S` horizon. The garbage fix at
-- t=100 has no surfacing fix within 1800 s (the next is t=2000), so the scan
-- gives up and the candidate is KEPT rather than bridged across half an hour.
private def bridgeHorizon : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 10 51.501 (-0.1) 20, gp 100 51.52 (-0.1) 100, gp 2000 51.53 (-0.1) 20, gp 2010 51.531 (-0.1) 20]
#guard (qualityFilterGps bridgeHorizon).map (·.ts) == #[0, 10, 100, 2000, 2010]

-- `findBridge` → `coherentSuccessor` false. t=60 is itself reachable and
-- trustworthy, so it looks like a bridge — but its own successor at t=70 is a
-- teleport, so it heads another garbage run and must be passed over for t=120.
private def incoherentSuccessor : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 10 51.501 (-0.1) 20, gp 20 51.7 (-0.1) 100, gp 60 51.502 (-0.1) 20,
  gp 70 51.9 (-0.1) 20, gp 120 51.503 (-0.1) 20, gp 130 51.504 (-0.1) 20]
#guard (qualityFilterGps incoherentSuccessor).map (·.ts) == #[0, 10, 120, 130]

-- `walk` → `speedUnreachable ∨ travelled`, with only the LEFT disjunct true. A
-- teleport that returns: net displacement across the run is far under
-- MIN_TRANSIT_DISPLACEMENT_M, so `travelled` is false and the run is bridged on
-- unreachability alone. A port testing only displacement would keep the
-- teleport.
private def unreachableNotTravelled : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 10 51.5005 (-0.1) 20, gp 20 51.9 (-0.1) 20, gp 30 51.501 (-0.1) 20, gp 40 51.5015 (-0.1) 20]
#guard (qualityFilterGps unreachableNotTravelled).map (·.ts) == #[0, 10, 30, 40]

-- ACCURACY_CEILING_M, both sides. These two tracks differ only in 80 → 80.001
-- and must NOT agree: `>` keeps the fix at exactly the ceiling and drops the
-- one a thousandth over. `≥` in either comparison collapses them.
private def accuracyAtCeiling : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 10 51.501 (-0.1) 20, gp 100 51.52 (-0.1) 80, gp 160 51.53 (-0.1) 20, gp 170 51.531 (-0.1) 20]
#guard (qualityFilterGps accuracyAtCeiling).map (·.ts) == #[0, 10, 100, 160, 170]

private def accuracyOverCeiling : Array GpsPoint := #[
  gp 0 51.5 (-0.1) 20, gp 10 51.501 (-0.1) 20, gp 100 51.52 (-0.1) 80.001, gp 160 51.53 (-0.1) 20, gp 170 51.531 (-0.1) 20]
#guard (qualityFilterGps accuracyOverCeiling).map (·.ts) == #[0, 10, 160, 170]

-- ACCURACY_UNINFORMATIVE_M — the pre-filter, which the anchor walk cannot
-- reach. Same geometry as the poor-accuracy jitter kept in `track` above (a run
-- bracketed by good fixes at one spot, going nowhere); the only difference is
-- the stated accuracy, and it decides. The 2026-05-11 evening train: the phone
-- stops solving, repeats one coordinate, and inflates its error bar 835 →
-- 37,880 m. Kept, the Kalman gives a ±37 km measurement no weight, coasts on
-- its last real velocity, and draws 29 km of travel that never happened.
private def gpf (ts : Int) (acc : Float) : GpsPoint := ⟨ts, 50, 5, some acc⟩
private def disclaimed : Array GpsPoint := #[
  gpf 1000 10, gpf 1015 10, gpf 1030 10, gpf 1045 10,
  gpf 1060 835, gpf 1090 1500, gpf 1120 2136, gpf 1150 6045, gpf 1180 9365,
  gpf 1210 10660, gpf 1240 11963, gpf 1270 13265, gpf 1300 14564, gpf 1330 15865,
  gpf 1360 17162, gpf 1390 18462, gpf 1420 19762, gpf 1450 21060, gpf 1480 37880,
  gpf 1510 10, gpf 1525 10, gpf 1540 10, gpf 1555 10]
#guard (qualityFilterGps disclaimed).map (·.ts) == #[1000, 1015, 1030, 1045, 1510, 1525, 1540, 1555]

-- The pre-filter runs BEFORE the ≤2 pass-through, so a track that is short only
-- because most of it is disclaimed does not get waved past. A port that filters
-- after the size check keeps all three.
#guard (qualityFilterGps #[gpf 0 10, gpf 10 5000, gpf 20 10]).map (·.ts) == #[0, 20]

end Verified.Geo.GpsQuality
