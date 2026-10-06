import Verified.Hsmm.Observation
import Verified.FloatConst
/-!
# HMM GPS outlier filter (implementation-first port of `gps-outliers.ts`)

A robust-statistics pass run on the fix stream BEFORE the observation tensor:
for each fix, take the median position over a ±30-min window and drop the fix if
it lies more than `MAX_DEVIATION_M` from that cluster centre — UNLESS the fix is
reachable from the last kept one at a speed a vehicle attains (`V_MAX_KMH`).

The median alone is right about an isolated teleport (a stale buffer, a cell
triangulation): the cluster stays put and the rogue fix sits kilometres off it.
It is wrong about a ride between two stays shorter than its window. There the
window straddles both stays, its coordinate-wise median lands between them, and
every fix on the way — the platform wait, the run at 100 km/h, the walk to the
station — is 2 km from a point nobody was at. Measured 2026-09-29 over the
eleven decoder days: 35 to 115 fixes a day gone, always a ride's interior, so
the decoder saw every ride from its bookends only (#238: a line credited on
endpoint proximity, because endpoints were all that survived). The speed rescue
tells the two apart: a teleport implies thousands of km/h from the fix before
it, a ride implies tens.

Composes directly into `buildObservationTensor` (same `GpsPoint`, same
`median`). The only transcendental is `cos` in the equirectangular distance,
and it feeds only a deviation compared against a 2 km threshold and a speed
against 250 km/h — so the KEPT-SET (a discrete decision, nothing sits at the
knife-edge) is exact even though the intermediate distance is ≤1-ULP-close.
UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.GpsOutliers

open Verified.Hsmm.Observation (GpsPoint median)

/-- Cluster window (seconds): ±30 min. -/
def WINDOW_S : Int := 1800
/-- Max plausible deviation (m) from the cluster median. -/
def MAX_DEVIATION_M : Float := 2000
/-- Below this cluster size, don't filter — too small to tell an outlier from
    real motion. -/
def MIN_CLUSTER_SIZE : Nat := 5

def M_PER_DEG_LAT : Float := 111320
open Verified.FloatConst (pi)

/-- Equirectangular distance (m) — fine at the city scale we filter at. -/
def approxDistanceMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let dLatM := (lat2 - lat1) * M_PER_DEG_LAT
  let dLonM := (lon2 - lon1) * M_PER_DEG_LAT * Float.cos (lat1 * pi / 180)
  Float.sqrt (dLatM * dLatM + dLonM * dLonM)

/-- Fastest travel a fix may imply from the fix before it and still be a place
    someone was (km/h): the tube runs at 100, national rail at 200, a plane far
    above, a teleport in the thousands. -/
def V_MAX_KMH : Float := 250

/-- Speed (km/h) that reaching `b` from `a` implies; `none` when `b` is not
    after `a`. -/
def impliedSpeedKmh (a b : GpsPoint) : Option Float :=
  let dt := Float.ofInt (b.ts - a.ts)
  if dt ≤ 0 then none
  else some (approxDistanceMeters a.lat a.lon b.lat b.lon / dt * 3.6)

/-- The median rule: `p` sits more than `MAX_DEVIATION_M` from the median of the
    fixes within `WINDOW_S` of it (a cluster below `MIN_CLUSTER_SIZE` is too
    small to tell an outlier from motion, and never far). -/
def farFromCluster (points : List GpsPoint) (p : GpsPoint) : Bool :=
  let cluster := points.filter (fun c =>
    decide (p.ts - WINDOW_S ≤ c.ts ∧ c.ts ≤ p.ts + WINDOW_S))
  if cluster.length < MIN_CLUSTER_SIZE then false
  else
    let medLat := median (cluster.map GpsPoint.lat)
    let medLon := median (cluster.map GpsPoint.lon)
    decide (approxDistanceMeters p.lat p.lon medLat medLon > MAX_DEVIATION_M)

/-- Drop the fixes that are far from their cluster median AND unreachable at
    `V_MAX_KMH` from the fix before them — the last kept fix, or the raw one
    before it while nothing has been kept yet; the first fix has no reference
    and is judged by the median alone. Preserves all other fixes in input
    order. Assumes `points` sorted by `ts` (the velocity pipeline's output), so
    the ±window cluster is a contiguous run. -/
def dropGpsOutliers (points : List GpsPoint) : List GpsPoint :=
  if points.length < MIN_CLUSTER_SIZE then points
  else
    let step := fun (acc : List GpsPoint × Option GpsPoint × Option GpsPoint) (p : GpsPoint) =>
      let (keptRev, lastKept, lastRaw) := acc
      let reference := lastKept.orElse fun _ => lastRaw
      let reachable := match reference with
        | none => false
        | some r => match impliedSpeedKmh r p with
          | none => true
          | some v => decide (v ≤ V_MAX_KMH)
      if !farFromCluster points p || reachable then (p :: keptRev, some p, some p)
      else (keptRev, lastKept, some p)
    (points.foldl step ([], none, none)).1.reverse

-- Parity with the real `dropGpsOutliers` (kept ts sets from Node/V8).
private def mk (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, 0⟩

private def pts : List GpsPoint :=
  [mk 0 51.5 (-0.1), mk 60 51.501 (-0.101), mk 120 51.4995 (-0.0998),
   mk 180 52.0 (-0.5), mk 240 51.5005 (-0.1002), mk 300 51.5001 (-0.0999),
   mk 360 51.4998 (-0.1001)]

-- Rogue at ts=180 (~55 km away) is dropped; the six clustered fixes survive.
#guard (dropGpsOutliers pts).map GpsPoint.ts == [0, 60, 120, 240, 300, 360]

-- Below MIN_CLUSTER_SIZE: everything passes through untouched.
#guard (dropGpsOutliers [mk 0 51.5 (-0.1), mk 60 99 99, mk 120 51.5 (-0.1)]).map GpsPoint.ts
  == [0, 60, 120]

-- A ride between two stays inside one window: ten fixes at A, ten on the way
-- north at 36 km/h, ten at B six kilometres on. The window's median lands on
-- the way; the median rule alone dropped A entire (3 km off) and the ride's
-- first half — the speed rescue keeps every fix but A's first, which has no
-- fix before it to be reached from.
private def ride : List GpsPoint :=
  (List.range 10).map (fun (k : Nat) => mk (Int.ofNat (60 * k)) 51.50 (-0.10))
  ++ (List.range 10).map (fun (k : Nat) =>
        mk (Int.ofNat (600 + 60 * k)) (51.50 + 0.0054 * (k + 1).toFloat) (-0.10))
  ++ (List.range 10).map (fun (k : Nat) => mk (Int.ofNat (1200 + 60 * k)) 51.554 (-0.10))
#guard (dropGpsOutliers ride).map GpsPoint.ts
  == ((List.range 30).map (fun (k : Nat) => Int.ofNat (60 * k))).drop 1
-- The rogue of `pts` is 55 km from the fix before it in a minute: no rescue.
#guard (match impliedSpeedKmh (mk 120 51.4995 (-0.0998)) (mk 180 52.0 (-0.5)) with
        | some v => decide (v > V_MAX_KMH) | none => false)

end Verified.Hsmm.GpsOutliers
