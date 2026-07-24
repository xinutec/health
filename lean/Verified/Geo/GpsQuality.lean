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

/-- Drop incoherent GPS runs; surviving fixes in input order. -/
def qualityFilterGps (points : Array GpsPoint) : Array GpsPoint :=
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

end Verified.Geo.GpsQuality
