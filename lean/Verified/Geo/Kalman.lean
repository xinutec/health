/-!
# GPS Kalman filter (implementation-first port of `src/geo/kalman.ts`)

The upstream input-pipeline stage: smooth a raw GPS track into filtered
position + velocity fixes (`filterGpsTrack`), feeding the observation tensor.
Two independent 1D filters (lat, lon), each `(x, v, px, pv, pxv)`, with adaptive
process noise, innovation gating (teleport rejection), reset conditions (long
gap / impossible speed / re-acquisition after a run of gated fixes), and a
forward-look velocity seed on reset.

Pure over the track. Arithmetic is exact (IEEE `+`/`-`/`*`/`÷`/`sqrt`); the only
transcendentals are `cos` (metre↔degree scaling) and `atan2` (bearing), so lat/lon
and the reset-path speed/bearing are ≤1-ULP close. Normal-path speed/bearing are
`Math.round`-quantised (`round(speed·10)/10`, `round(bearing)`), which absorbs the
ULP wobble except at a round boundary — the accepted near-tie class. The
reset path emits speed/bearing UNROUNDED (a TS quirk, mirrored here). UNPROVEN;
pinned by the `#guard`s against Node/V8.

That "≤1-ULP close" was MEASURED rather than predicted (`compare-kalman`,
2026-07-29, all 32 golden days). ⚠ THAT COMMAND NO LONGER RUNS — its TypeScript
arm went at 06346bd and the script was deleted 2026-09-01 (#1301), so the
figures below are a RECORD and cannot be re-derived without restoring the arm. Row counts agree everywhere — the two arms keep
the same fixes. `lat` is bit-identical everywhere; `lon` differs on ~0.5% of rows
by ≤1 ULP (worst day 19, where the recursion compounds a run of them); the few
speed/bearing differences are all reset rows. Root cause, measured over inputs
carried across as exact bit patterns: this runtime's `Float.cos` and V8's
`Math.cos` disagree by 1 ULP on 65 of 860 (7.6%) of one real day's latitudes.
`metersToDegreesLon` calls `cos` and `metersToDegreesLat` does not — which is
why `lat` is the clean control, and makes that a controlled comparison rather
than an inference. Two libms cannot be made to agree; the way to make this
filter *provable* rather than merely pinned is to take the metre↔degree scaling
off `Float` entirely.
-/

namespace Verified.Geo.Kalman

def R_EARTH : Float := 6371000
private def pi : Float := 3.141592653589793

def metersToDegreesLat (m : Float) : Float := m / (R_EARTH * (pi / 180))
def metersToDegreesLon (m lat : Float) : Float := m / (R_EARTH * Float.cos (lat * (pi / 180)) * (pi / 180))

structure GpsPoint where
  ts : Int
  lat : Float
  lon : Float
  accuracy : Option Float
  deriving Inhabited

structure FilteredPoint where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  bearing : Float
  deriving Inhabited

/-- 1D filter state: position, velocity, and their (co)variances. -/
structure KState where
  x : Float
  v : Float
  px : Float
  pv : Float
  pxv : Float

/-- Constant-velocity prediction over `dt`, inflating covariance by `processNoise`. -/
def predict1D (s : KState) (dt processNoise : Float) : KState :=
  { x := s.x + s.v * dt, v := s.v
    px := s.px + 2 * dt * s.pxv + dt * dt * s.pv + (processNoise * dt * dt * dt) / 3
    pv := s.pv + processNoise * dt
    pxv := s.pxv + dt * s.pv + (processNoise * dt * dt) / 2 }

/-- Measurement update against `measurement` with variance `measurementVariance`. -/
def update1D (s : KState) (measurement measurementVariance : Float) : KState :=
  let y := measurement - s.x
  let sy := s.px + measurementVariance
  let kx := s.px / sy
  let kv := s.pxv / sy
  { x := s.x + kx * y, v := s.v + kv * y
    px := s.px - kx * s.px, pv := s.pv - kv * s.pxv, pxv := s.pxv - kx * s.pxv }

/-- Process noise scaled down at speed (a train needs less lateral freedom). -/
def adaptiveProcessNoise (speedDegPerSec : Float) : Float :=
  let speedKmh := speedDegPerSec * R_EARTH * (pi / 180) * 3.6
  if speedKmh > 80 then 0.1 else if speedKmh > 30 then 0.5 else if speedKmh > 7 then 1.0 else 2.0

def INNOVATION_GATE : Float := 50
def MAX_CONSECUTIVE_REJECTS : Nat := 3

/-- Velocity is only ever observed as a difference of positions, so the filter
may smooth what its fixes show but may not claim motion they contradict. Over
one step, motion that does not reverse averages `(v_start + v_end)/2`, so
`v_end ≤ 2 ×` the step's average — a kinematic identity, not a tuned threshold.
Applied to the posterior against the last two ACCEPTED measurements: a gated fix
moved no state, so it is not evidence about velocity either. -/
def VELOCITY_OBSERVABILITY_FACTOR : Float := 2
/-- …with a floor, so GPS noise around a standstill (or a repeated stale fix,
which shows zero displacement while the wearer really is moving) cannot pin the
velocity state to zero and make the next genuine fix look like a jump. -/
def VELOCITY_OBSERVABILITY_FLOOR_KMH : Float := 5
private def defaultAccuracy : Float := 20

private def mod360 (x : Float) : Float := x - Float.floor (x / 360) * 360
/-- `Math.round` — round half toward +∞; the emitted values are non-negative. -/
private def roundHalfUp (x : Float) : Float := Float.floor (x + 0.5)

/-- Filter a raw GPS track into position + velocity fixes. -/
def filterGpsTrack (points : Array GpsPoint) : Array FilteredPoint := Id.run do
  let n := points.size
  if n == 0 then return #[]
  let p0 := points[0]!
  if n == 1 then
    return #[⟨p0.ts, p0.lat, p0.lon, 0, 0⟩]
  let acc0 := p0.accuracy.getD defaultAccuracy
  let initVarLat := metersToDegreesLat acc0 ^ 2
  let initVarLon := metersToDegreesLon acc0 p0.lat ^ 2
  let mut stateLat : KState := ⟨p0.lat, 0, initVarLat, initVarLat, 0⟩
  let mut stateLon : KState := ⟨p0.lon, 0, initVarLon, initVarLon, 0⟩
  let mut result : Array FilteredPoint := #[⟨p0.ts, p0.lat, p0.lon, 0, 0⟩]
  let mut consecutiveRejects : Nat := 0
  -- The last measurement the filter actually took in (accepted update or reset).
  let mut lastAccepted : GpsPoint := p0
  for i in [1:n] do
    let p := points[i]!
    let prev := points[i-1]!
    let dtI := p.ts - prev.ts
    if decide (dtI ≤ 0) then pure ()   -- duplicate timestamp
    else
      let dt := dtI.toNat.toFloat
      let dLatM := (p.lat - prev.lat) * 111320
      let dLonM := (p.lon - prev.lon) * 111320 * Float.cos (p.lat * pi / 180)
      let impliedDist := Float.sqrt (dLatM ^ 2 + dLonM ^ 2)
      let impliedSpeedKmh := (impliedDist / dt) * 3.6
      let reacquire := consecutiveRejects ≥ MAX_CONSECUTIVE_REJECTS
      let shouldReset := decide (dt > 3600)
        || (decide (dt > 300) && decide (impliedSpeedKmh > 200))
        || (decide (dt ≥ 600) && decide (impliedDist ≥ 500)) || reacquire
      if shouldReset then
        consecutiveRejects := 0
        let acc := p.accuracy.getD defaultAccuracy
        let posVarLat := metersToDegreesLat acc ^ 2
        let posVarLon := metersToDegreesLon acc p.lat ^ 2
        -- Forward-look seed from (this, next) if the next fix is close in time.
        let mut initialSpeed : Float := 0
        let mut initialBearing : Float := 0
        let mut vLatPerSec : Float := 0
        let mut vLonPerSec : Float := 0
        if i + 1 < n then
          let next := points[i+1]!
          let dt2I := next.ts - p.ts
          if decide (dt2I > 0) && decide (dt2I < 600) then
            let dt2 := dt2I.toNat.toFloat
            let dLatDeg := next.lat - p.lat
            let dLonDeg := next.lon - p.lon
            let dLatM2 := dLatDeg * 111320
            let dLonM2 := dLonDeg * 111320 * Float.cos (p.lat * pi / 180)
            let dist := Float.sqrt (dLatM2 ^ 2 + dLonM2 ^ 2)
            initialSpeed := (dist / dt2) * 3.6
            initialBearing := mod360 (Float.atan2 dLonM2 dLatM2 * 180 / pi + 360)
            vLatPerSec := dLatDeg / dt2
            vLonPerSec := dLonDeg / dt2
        stateLat := ⟨p.lat, vLatPerSec, posVarLat, posVarLat * 100, 0⟩
        stateLon := ⟨p.lon, vLonPerSec, posVarLon, posVarLon * 100, 0⟩
        lastAccepted := p
        result := result.push ⟨p.ts, p.lat, p.lon, initialSpeed, initialBearing⟩
      else
        let qLat := adaptiveProcessNoise (Float.abs stateLat.v)
        let qLon := adaptiveProcessNoise (Float.abs stateLon.v)
        let qLatDeg := metersToDegreesLat qLat ^ 2
        let qLonDeg := metersToDegreesLon qLon stateLat.x ^ 2
        stateLat := predict1D stateLat dt qLatDeg
        stateLon := predict1D stateLon dt qLonDeg
        let accM := p.accuracy.getD defaultAccuracy
        let rLat := metersToDegreesLat accM ^ 2
        let rLon := metersToDegreesLon accM p.lat ^ 2
        let innovLat := p.lat - stateLat.x
        let innovLon := p.lon - stateLon.x
        let normInnovation := innovLat * innovLat / (stateLat.px + rLat) + innovLon * innovLon / (stateLon.px + rLon)
        if normInnovation > INNOVATION_GATE then
          consecutiveRejects := consecutiveRejects + 1
        else
          consecutiveRejects := 0
          stateLat := update1D stateLat p.lat rLat
          stateLon := update1D stateLon p.lon rLon
          -- Velocity-observability bound: the posterior may not travel faster
          -- than twice what the last two accepted fixes actually show.
          -- A coordinate bit-identical to the last one is the phone restating
          -- its previous answer, not reporting that it has stopped. Held back
          -- rather than advanced, so the next genuine fix is measured across the
          -- full elapsed span (the 2026-05-10 Eurostar alternated fresh fix and
          -- stale repeat the whole way across France).
          let obsDtI := p.ts - lastAccepted.ts
          let restated := p.lat == lastAccepted.lat && p.lon == lastAccepted.lon
          if decide (obsDtI > 0) && !restated then
            let obsDt := obsDtI.toNat.toFloat
            let obsLatM := (p.lat - lastAccepted.lat) * 111320
            let obsLonM := (p.lon - lastAccepted.lon) * 111320 * Float.cos (p.lat * pi / 180)
            let obsKmh := (Float.sqrt (obsLatM ^ 2 + obsLonM ^ 2) / obsDt) * 3.6
            let observed := VELOCITY_OBSERVABILITY_FACTOR * obsKmh
            let bound := if observed > VELOCITY_OBSERVABILITY_FLOOR_KMH then observed
                         else VELOCITY_OBSERVABILITY_FLOOR_KMH
            let stateLatMs := stateLat.v * R_EARTH * (pi / 180)
            let stateLonMs := stateLon.v * R_EARTH * Float.cos (stateLat.x * (pi / 180)) * (pi / 180)
            let stateKmh := Float.sqrt (stateLatMs ^ 2 + stateLonMs ^ 2) * 3.6
            if stateKmh > bound then
              -- Uniform scale: keep the direction, give up the magnitude the
              -- fixes cannot support.
              let scale := bound / stateKmh
              stateLat := { stateLat with v := stateLat.v * scale }
              stateLon := { stateLon with v := stateLon.v * scale }
          if !(p.lat == lastAccepted.lat && p.lon == lastAccepted.lon) then
            lastAccepted := p
          let vLatMs := stateLat.v * R_EARTH * (pi / 180)
          let vLonMs := stateLon.v * R_EARTH * Float.cos (stateLat.x * (pi / 180)) * (pi / 180)
          let speedKmh := Float.sqrt (vLatMs ^ 2 + vLonMs ^ 2) * 3.6
          let bearing := mod360 (Float.atan2 vLonMs vLatMs * 180 / pi + 360)
          result := result.push ⟨p.ts, stateLat.x, stateLon.x,
            roundHalfUp (speedKmh * 10) / 10, roundHalfUp bearing⟩
  return result

/-- Speed → transport-mode class (`classifyMode`). -/
def classifyMode (speedKmh : Float) : String :=
  if speedKmh < 2 then "stationary" else if speedKmh < 7 then "walking"
  else if speedKmh < 30 then "cycling" else if speedKmh < 120 then "driving" else "transit"

-- Parity with the real `filterGpsTrack` (values from Node/V8): a track exercising
-- init, normal filtering, adaptive noise, innovation-gate rejection (a teleport
-- spike, dropped from output), and reset + forward-look seed after a long gap.
private def gp (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, some 20⟩
private def track : Array GpsPoint := #[
  gp 0 51.5000 (-0.1000), gp 10 51.5001 (-0.1000), gp 20 51.5002 (-0.1000),
  gp 30 51.5003 (-0.1001), gp 40 51.5100 (-0.1000), gp 50 51.5004 (-0.1001),
  gp 60 51.5005 (-0.1002), gp 4000 51.6000 (-0.2000), gp 4010 51.6001 (-0.2001)]
private def out : Array FilteredPoint := filterGpsTrack track
private def approxK (a b : Float) : Bool := Float.abs (a - b) < 1e-6
private def rowOk (f : FilteredPoint) (ts : Int) (lat lon spd brg : Float) : Bool :=
  f.ts == ts && approxK f.lat lat && approxK f.lon lon && approxK f.speedKmh spd && approxK f.bearing brg

#guard out.size == 8                                             -- 9 in, spike gated out
#guard rowOk out[0]! 0 51.5 (-0.1) 0 0
#guard rowOk out[1]! 10 51.50009905063291 (-0.1) 4 0
#guard rowOk out[2]! 20 51.500199899933286 (-0.1) 4 0
#guard rowOk out[3]! 30 51.500300058631304 (-0.10009182429544923) 4.6 331
#guard rowOk out[4]! 50 51.50040190162477 (-0.10010327735151499) 1.7 10   -- post-gate
#guard rowOk out[5]! 60 51.500495664150236 (-0.10019179364539346) 4.4 329
#guard rowOk out[6]! 4000 51.6 (-0.2) 4.717694629017221 328.1536087263755  -- reset: UNROUNDED
#guard rowOk out[7]! 4010 51.6001 (-0.2001) 4.7 328
#guard classifyMode 1.0 == "stationary" && classifyMode 5 == "walking" && classifyMode 20 == "cycling"

-- The velocity-observability bound, which `track` above never reaches. Shape of
-- the 2026-08-05 Baker Street interchange: one stale coordinate repeated while
-- underground, then the far end of the tunnel run (859 m in 22 s → 141 km/h),
-- then fixes showing the phone stopped. Row 4 is the witness: the bound holds
-- the posterior at the 5 km/h floor where the unclamped filter carried ~70 and
-- coasted the estimate ~300 m past every observation. Values from Node/V8.
private def gpa (ts : Int) (lon acc : Float) : GpsPoint := ⟨ts, 50, lon, some acc⟩
private def clampTrack : Array GpsPoint := #[
  gpa 0 5.0 26, gpa 13 5.0 45, gpa 26 5.0 63,
  gpa 48 4.988 68, gpa 61 4.98803 14, gpa 80 4.9875 100,
  gpa 89 4.988 34, gpa 99 4.98805 13, gpa 113 4.98802 15, gpa 127 4.98806 37]
private def clampOut : Array FilteredPoint := filterGpsTrack clampTrack

#guard clampOut.size == 10
#guard rowOk clampOut[3]! 48 50 4.9891191295311872 126.2 270          -- tunnel pair: velocity learned
#guard rowOk clampOut[4]! 61 50 4.9879683036293940 5.0 270            -- stopped: held at the floor
#guard rowOk clampOut[5]! 80 50 4.9875609605642586 5.6 270            -- the poor fix no longer coasts
#guard rowOk clampOut[6]! 89 50 4.9879331921647987 1.1 90
-- The `restated` exclusion, which `clampTrack` above does not pin (its repeats
-- sit where the velocity is already zero, so dropping the rule changes nothing
-- there). The 2026-05-10 Eurostar: a real fix, then the identical coordinate
-- restated, then a real fix ~3.9 km on — the whole way across France. Treating
-- a restatement as an observation of zero displacement pins a 250 km/h train to
-- the 5 km/h floor and drags the track kilometres behind it. Values from V8.
private def gpe (ts : Int) (lat acc : Float) : GpsPoint := ⟨ts, lat, 3.0, some acc⟩
private def restatedTrack : Array GpsPoint := #[
  gpe 0 50.0 30,
  gpe 28 50.034999999999997 700, gpe 55 50.034999999999997 700,
  gpe 83 50.069999999999993 700, gpe 110 50.069999999999993 700,
  gpe 138 50.104999999999990 700, gpe 165 50.104999999999990 700,
  gpe 193 50.139999999999986 700, gpe 220 50.139999999999986 700]
private def restatedOut : Array FilteredPoint := filterGpsTrack restatedTrack

#guard restatedOut.size == 9
#guard approxK restatedOut[4]!.lat 50.077496889790027 && approxK restatedOut[4]!.speedKmh 282.7
#guard approxK restatedOut[8]!.lat 50.150157067670655 && approxK restatedOut[8]!.speedKmh 272.5
-- The train stays a train: every fix after the first is still travelling.
#guard restatedOut.all fun f => f.ts == 0 || f.speedKmh > 100

-- …and therefore no step across the stopped stretch reads as a vehicle.
#guard (List.range 5).all fun k =>
  let a := clampOut[k+4]!; let b := clampOut[k+5]!
  let dt := (b.ts - a.ts).toNat.toFloat
  Float.abs (b.lon - a.lon) * 111320 * Float.cos (50 * pi / 180) / dt * 3.6 < 15

end Verified.Geo.Kalman
