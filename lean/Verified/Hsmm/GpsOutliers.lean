import Verified.Hsmm.Observation
/-!
# HMM GPS outlier filter (implementation-first port of `gps-outliers.ts`)

A robust-statistics pass run on the fix stream BEFORE the observation tensor:
for each fix, take the median position over a ±30-min window and drop the fix if
it lies more than `MAX_DEVIATION_M` from that cluster centre. The median is
robust to a few rogue fixes (stale-buffer / cell-triangulation jumps), so real
sustained motion drags the cluster along but isolated teleports are rejected.

Composes directly into `buildObservationTensor` (same `GpsPoint`, same
`median`). The only transcendental is `cos` in the equirectangular distance,
and it feeds only a deviation compared against a 2 km threshold — so the
KEPT-SET (a discrete decision, nothing sits at the knife-edge) is exact even
though the intermediate distance is ≤1-ULP-close. UNPROVEN; pinned by the
`#guard`s.
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
private def pi : Float := 3.141592653589793

/-- Equirectangular distance (m) — fine at the city scale we filter at. -/
def approxDistanceMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let dLatM := (lat2 - lat1) * M_PER_DEG_LAT
  let dLonM := (lon2 - lon1) * M_PER_DEG_LAT * Float.cos (lat1 * pi / 180)
  Float.sqrt (dLatM * dLatM + dLonM * dLonM)

/-- Drop fixes outside `MAX_DEVIATION_M` of their recent cluster median.
    Preserves all other fixes in input order. Assumes `points` sorted by `ts`
    (the velocity pipeline's output), so the ±window cluster is a contiguous
    run — the TS two-index slide and this predicate select the same set. -/
def dropGpsOutliers (points : List GpsPoint) : List GpsPoint :=
  if points.length < MIN_CLUSTER_SIZE then points
  else points.filter (fun p =>
    let cluster := points.filter (fun c =>
      decide (p.ts - WINDOW_S ≤ c.ts ∧ c.ts ≤ p.ts + WINDOW_S))
    if cluster.length < MIN_CLUSTER_SIZE then true
    else
      let medLat := median (cluster.map GpsPoint.lat)
      let medLon := median (cluster.map GpsPoint.lon)
      decide (approxDistanceMeters p.lat p.lon medLat medLon ≤ MAX_DEVIATION_M))

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

end Verified.Hsmm.GpsOutliers
