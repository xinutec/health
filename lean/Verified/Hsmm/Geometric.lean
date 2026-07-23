import Verified.Hsmm.Emissions
/-!
# Geometric feasibility (implementation-first port of `geometric-feasibility.ts`)

Emission term: penalises `stationary @ knownPlace` on a GPS-gap minute when the
implied teleport speed from the nearest fix (forward or backward in time) to the
place centroid exceeds `MAX_PLAUSIBLE_SPEED_KMH` — a half-Gaussian in the excess.
Reuses the verified `haversineMeters`. The fixes and `obs.ts` are passed in (the
caller reads them off the observation), and `placeCoord` is the resolved centroid
for `s.placeId`. UNPROVEN; bit-exact with TS, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Geometric

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.Emissions (Mode State)

def MAX_PLAUSIBLE_SPEED_KMH : Float := 80
def SPEED_PENALTY_SIGMA_KMH : Float := 20

structure GpsFix where
  ts : Float
  lat : Float
  lon : Float

/-- Implied avg km/h to traverse from `fix` to the target over the elapsed time;
    `0` for a same-or-future-minute fix (the place-distance term handles those). -/
def impliedSpeedKmh (fix : GpsFix) (tlat tlon currentTs : Float) : Float :=
  let elapsedSec := Float.abs (currentTs - fix.ts)
  if elapsedSec <= 0 then 0.0
  else
    let distKm := haversineMeters fix.lat fix.lon tlat tlon / 1000
    let elapsedH := elapsedSec / 3600
    distKm / elapsedH

/-- The feasibility penalty (`buildGeometricFeasibility`). -/
def geometricFeasibility (s : State) (obsTs : Float) (prevFix nextFix : Option GpsFix)
    (placeCoord : Option (Float × Float)) : Float :=
  if s.mode != .stationary || s.placeId.isNone then 0.0
  else match placeCoord with
    | none => 0.0
    | some (plat, plon) =>
      let sp1 := match prevFix with | some f => impliedSpeedKmh f plat plon obsTs | none => 0.0
      let sp2 := match nextFix with | some f => impliedSpeedKmh f plat plon obsTs | none => 0.0
      let worst := if sp1 > sp2 then sp1 else sp2
      if worst <= MAX_PLAUSIBLE_SPEED_KMH then 0.0
      else
        let e := (worst - MAX_PLAUSIBLE_SPEED_KMH) / SPEED_PENALTY_SIGMA_KMH
        0.0 - 0.5 * (e * e)

-- Parity with the real `buildGeometricFeasibility` (Node/V8). Home = (51.55,-0.28).
-- NOTE: this factor's value flows through `haversineMeters` (sin/cos/atan2/sqrt),
-- where Lean's libm and V8's can differ by ≤1 ULP on some inputs — so the penalty
-- is checked ULP-close (`approx`), not bit-equal. Exact-zero branches stay `==`.
-- This is the accepted near-tie class the quant flip already tolerates.
private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-6
private def fx (ts lat lon : Float) : GpsFix := ⟨ts, lat, lon⟩
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩
private def home : Option (Float × Float) := some (51.55, -0.28)

#guard approx (geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 (-0.11))) none home)
  (-31.7255987889194)
#guard geometricFeasibility (stt .stationary (some 5)) 5000 (some (fx 1000 51.5501 (-0.2801))) none home == 0
#guard geometricFeasibility (stt .walking none) 1180 (some (fx 1000 51.53 (-0.11))) none home == 0
#guard geometricFeasibility (stt .stationary (some 9)) 1180 (some (fx 1000 51.53 (-0.11))) none none == 0
#guard geometricFeasibility (stt .stationary (some 5)) 1000 (some (fx 1000 51.53 (-0.11))) none home == 0
#guard approx (geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 (-0.11))) (some (fx 1300 51.60 (-0.30))) home)
  (-31.7255987889194)

end Verified.Hsmm.Geometric
