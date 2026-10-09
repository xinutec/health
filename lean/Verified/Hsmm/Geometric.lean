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

/-- The feasibility penalty — the TS `buildGeometricFeasibility` closure. -/
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

/-! ## The gap-speed term (#238, 2026-09-29)

At a minute WITHOUT a fix, bracketed by fixes at least `GAP_MIN_S` apart, the
gap's straight-line speed says what the minutes inside it can have been. A mode
whose ceiling is below it — a walk, a placeless stay, a bike — pays a
half-Gaussian in the excess, clamped per minute. It is the mirror of the rail
gap credit a train line already earns under the same condition
(`RouteModel.routeRailEvidence`): until now a dark two-stop tube ride lost to a
walk that crossed 2 km in five minutes for free (05-20, Baker Street → Green
Park: the Jubilee won the dark minutes by 4.5 nats each and lost the ride on
the two mode switches). Only a STEPLESS minute pays: a gap that holds a ride
AND a walk is ordinary (06-12, Green Park → King's Cross: the Victoria line and
the stepped interchange), and charging the walk's minutes there pushed that
decode into a longer ride and a phantom leg (measured 2026-09-29, lines and
stations each −1 on that day). What cannot happen is a walk or a stay without
steps spanning a gap faster than a walk. A stay at a KNOWN place is
`geometricFeasibility`'s, not this term's.

A one-stop hop goes dark for two minutes, not three: 944 m between fixes 120 s
apart read as a walk until a WALK paid from 120 s and the clamp went to −6 (it
otherwise pays at most 3 nats a minute for 28 km/h). Only the walk: a placeless
stay paying from 120 s flipped a platform wait to the known place beside the
station, which pays nothing. At 45 s the bound reached into interchanges and
moved 06-12's Victoria ride to the District. -/

def GAP_MIN_S : Float := 180
/-- A walk pays from a shorter gap: a one-stop hop goes dark for two minutes. -/
def GAP_MIN_WALK_S : Float := 120
def GAP_WALK_MAX_KMH : Float := 7
def GAP_CYCLE_MAX_KMH : Float := 25
def GAP_SIGMA_KMH : Float := 5
def GAP_CLAMP : Float := -6

/-- The ceiling a mode can sustain across a gap; `none` = no ceiling here. -/
def gapCeilingKmh (s : State) : Option Float :=
  match s.mode with
  | .walking => some GAP_WALK_MAX_KMH
  | .stationary => if s.placeId.isNone then some GAP_WALK_MAX_KMH else none
  | .cycling => some GAP_CYCLE_MAX_KMH
  | _ => none

def gapSpeedPenalty (s : State) (hasFix stepped : Bool) (prevFix nextFix : Option GpsFix) : Float :=
  if hasFix || stepped then 0.0
  else match gapCeilingKmh s, prevFix, nextFix with
    | some cap, some p, some n =>
      let dt := n.ts - p.ts
      if dt < (if s.mode == .walking then GAP_MIN_WALK_S else GAP_MIN_S) then 0.0
      else
        let v := haversineMeters p.lat p.lon n.lat n.lon / 1000 / (dt / 3600)
        if v <= cap then 0.0
        else
          let e := (v - cap) / GAP_SIGMA_KMH
          max GAP_CLAMP (0.0 - 0.5 * (e * e))
    | _, _, _ => 0.0

-- 2.0 km in two and a half minutes: a walk clamps; in five
-- minutes a train and a stay at a known place are not this term's; a minute with
-- a fix and a short gap assert nothing.
#guard gapSpeedPenalty ⟨.walking, none, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨150, 51.5067, -0.1428⟩) == GAP_CLAMP
-- A placeless stay pays only from the longer gap: at two and a half minutes
-- a stay near a known place would otherwise flip to it, which pays nothing.
#guard gapSpeedPenalty ⟨.stationary, none, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨150, 51.5067, -0.1428⟩) == 0
#guard gapSpeedPenalty ⟨.stationary, none, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) < -5
-- The same 2.0 km in five minutes is 24 km/h: a bike can, so it goes free.
#guard gapSpeedPenalty ⟨.cycling, none, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
#guard gapSpeedPenalty ⟨.train, none, some "Jubilee Line"⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
#guard gapSpeedPenalty ⟨.stationary, some 5, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
#guard gapSpeedPenalty ⟨.walking, none, none⟩ true false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
#guard gapSpeedPenalty ⟨.walking, none, none⟩ false false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨90, 51.5067, -0.1428⟩) == 0
-- A stepped minute is a walk whatever the gap says.
#guard gapSpeedPenalty ⟨.walking, none, none⟩ false true (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
-- A walk's own pace across a gap is free.
#guard gapSpeedPenalty ⟨.walking, none, none⟩ false false (some ⟨0, 51.5000, -0.10⟩) (some ⟨600, 51.5090, -0.10⟩) == 0

-- Parity with the real `buildGeometricFeasibility` (Node/V8). Home is the
-- SYNTHETIC anchor (51.55, 2.22) — every lon in this file is shifted +2.5 from
-- the capture (#859); distances depend only on the lats and delta-lon, so the
-- expected values held.
-- NOTE: this factor's value flows through `haversineMeters` (sin/cos/atan2/sqrt),
-- where Lean's libm and V8's can differ by ≤1 ULP on some inputs — so the penalty
-- is checked ULP-close (`approx`), not bit-equal. Exact-zero branches stay `==`.
-- This is the accepted near-tie class the quant flip already tolerates.
private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-6
private def fx (ts lat lon : Float) : GpsFix := ⟨ts, lat, lon⟩
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩
private def home : Option (Float × Float) := some (51.55, 2.22)

#guard approx (geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 2.39)) none home)
  (-31.7255987889194)
#guard geometricFeasibility (stt .stationary (some 5)) 5000 (some (fx 1000 51.5501 2.2199)) none home == 0
#guard geometricFeasibility (stt .walking none) 1180 (some (fx 1000 51.53 2.39)) none home == 0
#guard geometricFeasibility (stt .stationary (some 9)) 1180 (some (fx 1000 51.53 2.39)) none none == 0
#guard geometricFeasibility (stt .stationary (some 5)) 1000 (some (fx 1000 51.53 2.39)) none home == 0
#guard approx (geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 2.39)) (some (fx 1300 51.60 2.20)) home)
  (-31.7255987889194)

end Verified.Hsmm.Geometric
