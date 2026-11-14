import Verified.Hsmm.Observation
import Verified.FloatConst
/-!
# HMM GPS outlier filter

Before the observation tensor: drop a fix more than `MAX_DEVIATION_M` from the
median position of its ±30-min window, unless it is reachable from the last
kept fix at a vehicle's speed (`V_MAX_KMH`).

The median catches an isolated teleport, but a ride between two stays inside
one window puts the median between them and would drop the whole ride's
interior. The speed rescue separates them: a teleport implies thousands of
km/h, a ride tens.

Feeds `buildObservationTensor` (same `GpsPoint`, same `median`). `cos` makes
distances ≤1 ULP, compared only against 2 km and 250 km/h, so the kept set is
exact. UNPROVEN; pinned by the `#guard`s.
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

/-- Drop the fixes far from their cluster median and unreachable at `V_MAX_KMH`
    from the fix before (the last kept, or the raw previous before any is kept;
    the first fix is judged by the median alone). Order preserved; `points`
    sorted by `ts`, so the window is a contiguous run. -/
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

-- `dropGpsOutliers`' reference kept-ts sets.
private def mk (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, 0, none⟩

private def pts : List GpsPoint :=
  [mk 0 51.5 (-0.1), mk 60 51.501 (-0.101), mk 120 51.4995 (-0.0998),
   mk 180 52.0 (-0.5), mk 240 51.5005 (-0.1002), mk 300 51.5001 (-0.0999),
   mk 360 51.4998 (-0.1001)]

-- Rogue at ts=180 (~55 km away) is dropped; the six clustered fixes survive.
#guard (dropGpsOutliers pts).map GpsPoint.ts == [0, 60, 120, 240, 300, 360]

-- Below MIN_CLUSTER_SIZE: everything passes through untouched.
#guard (dropGpsOutliers [mk 0 51.5 (-0.1), mk 60 99 99, mk 120 51.5 (-0.1)]).map GpsPoint.ts
  == [0, 60, 120]

-- A ride between two stays in one window: ten fixes at A, ten on the way at
-- 36 km/h, ten at B 6 km on. The median lands on the way, so the median alone
-- drops A and half the ride; the rescue keeps all but A's first fix.
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
