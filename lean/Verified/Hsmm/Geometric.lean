import Verified.Hsmm.Emissions
/-!
# Geometric feasibility

What the fixes around a dark minute say about the state holding it, as
likelihoods: the gap term (whatever holds the minute covered the gap) and the
place term (a stay at a known place was reachable from the fixes either side).
Both read the modes' own speed distributions and the measured fix noise; the
fixes and `obs.ts` are passed in, and `placeCoord` is the resolved centroid for
`s.placeId`. UNPROVEN, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Geometric

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.Emissions (Mode State ModePrior modePriors)

structure GpsFix where
  ts : Float
  lat : Float
  lon : Float

/-! ## The gap term

At a minute without a fix, the fixes bracketing its gap say how far the day
moved in the dark: `d` metres in `dt` seconds. Whatever state holds the minute
must have covered at least that straight line. The term is the probability that
it could: the mode's own speed distribution (`ModePrior.speedMean` /
`speedStd`, the same table the speed emission reads and the fitter learns),
truncated at zero, carried over `dt` and widened by both fixes' noise, survives
`d`. Mixed with an outlier tail, because a bracketing fix can be wrong — but
only by so much: the chance falls off with the distance the outlier would have
to explain.

The gap's log-likelihood is shared out over its dark minutes, so a gap held
whole by one mode pays it once, and a gap shared with a ride charges each of
its minutes a share. There is no gap-length cutoff, no per-mode ceiling and no
clamp: a short gap is dominated by fix noise and asserts little; a long one by
the speed spread. -/

/-! Measured on the decoder corpus's fixes, each against the midpoint of
neighbours that agree with each other: 99% lie within 31 m (a per-axis σ of
10 m), one in a thousand beyond 100 m, the excess past that falling off with a
scale of about 70 m, and none beyond 500 m. -/

/-- The per-axis noise of a fix. -/
def GPS_NOISE_M : Float := 10
/-- The chance a fix is an outlier. -/
def GAP_OUTLIER_P : Float := 1e-3
/-- How fast the outlier chance falls with the distance it must explain. -/
def GAP_OUTLIER_SCALE_M : Float := 70

/-- `log erfc x` for `x ≥ 0`: the Chebyshev fit of Numerical Recipes (`erfcc`),
    fractional error below `1.2e-7`, stable deep in the tail. -/
def logErfc (x : Float) : Float :=
  let t := 1 / (1 + 0.5 * x)
  Float.log t + (0 - x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))))

private def HALF : Float := 0.5
private def LOG_HALF : Float := Float.log 0.5
private def SQRT_2 : Float := Float.sqrt 2

/-- `log Φ z`, the standard normal CDF. -/
def logPhi (z : Float) : Float :=
  if z <= 0 then LOG_HALF + logErfc (0 - z / SQRT_2)
  else Float.log (1 - HALF * Float.exp (logErfc (z / SQRT_2)))

/-- log P(a mode with prior `pr` covers `d` metres in `dt` seconds). -/
def gapLogLikelihood (pr : ModePrior) (d dt : Float) : Float :=
  let mu := pr.speedMean / 3.6 * dt
  let sdMove := pr.speedStd / 3.6 * dt
  let sd := Float.sqrt (sdMove * sdMove + 2 * GPS_NOISE_M * GPS_NOISE_M)
  let survives := Float.exp (logPhi ((mu - d) / sd) - logPhi (mu / sd))
  let excess := max 0 (d - mu)
  Float.log (GAP_OUTLIER_P * Float.exp (0 - excess / GAP_OUTLIER_SCALE_M)
    + (1 - GAP_OUTLIER_P) * survives)

/-- This dark minute's share of its gap's log-likelihood under `s`. -/
def gapTerm (s : State) (hasFix : Bool) (prevFix nextFix : Option GpsFix)
    (priors : Mode → ModePrior := modePriors) : Float :=
  if hasFix then 0.0
  else match prevFix, nextFix with
    | some p, some n =>
      let dt := n.ts - p.ts
      let dark := Float.round (dt / 60) - 1
      if dark < 1 then 0.0
      else gapLogLikelihood (priors s.mode) (haversineMeters p.lat p.lon n.lat n.lon) dt / dark
    | _, _ => 0.0

/-! ## The place term

A stay at a known place during a dark minute: the day got from the previous fix
to the place in the time since, and from the place to the next fix in the time
left. Each leg needs only that SOME travel mode covers it: the best mode's
survival. Which mode it was is the travel minutes' own states to pay for, so
the mode prior is not charged here again. The two legs multiply.

Ground modes only. A plane reaches anywhere in a night, so with it a stay at
Home 1,300 km from the morning's first fix went free, and the decode put the
night there; no plane state pays for that flight, because none is decoded. -/

private def TRAVEL_MODES : Array Mode := #[.walking, .cycling, .driving, .train]

/-- log P(the best travel mode covers `d` metres in `dt` seconds); `0` for `dt ≤ 0`. -/
def reachLogLikelihood (priors : Mode → ModePrior) (d dt : Float) : Float :=
  if dt <= 0 then 0.0
  else TRAVEL_MODES.foldl (fun best m => max best (gapLogLikelihood (priors m) d dt)) (gapLogLikelihood (priors .walking) d dt)

def geometricFeasibility (s : State) (obsTs : Float) (prevFix nextFix : Option GpsFix)
    (placeCoord : Option (Float × Float)) (priors : Mode → ModePrior := modePriors) : Float :=
  if s.mode != .stationary || s.placeId.isNone then 0.0
  else match placeCoord with
    | none => 0.0
    | some (plat, plon) =>
      let leg (f : Option GpsFix) (dt : GpsFix → Float) := match f with
        | some f => reachLogLikelihood priors (haversineMeters f.lat f.lon plat plon) (dt f)
        | none => 0.0
      leg prevFix (fun f => obsTs - f.ts) + leg nextFix (fun f => f.ts - obsTs)

#guard Float.abs (logPhi 0 - Float.log 0.5) < 1e-6
#guard Float.abs (logPhi (-5) - Float.log 2.866515718791939e-7) < 1e-6
#guard Float.abs (logPhi 1.5 - Float.log 0.9331927987311419) < 1e-6
-- 2.0 km in two minutes, one dark minute: a walk cannot, and no outlier
-- explains 1.8 km; a train can, and pays a few hundredths a minute.
#guard gapTerm ⟨.walking, none, none⟩ false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨120, 51.5067, -0.1428⟩) < -25
-- A walk 150 m ahead of its pace is an outlier's reach.
#guard gapTerm ⟨.walking, none, none⟩ false (some ⟨0, 51.5000, -0.10⟩) (some ⟨120, 51.5028, -0.10⟩) > -12
#guard gapTerm ⟨.train, none, some "Jubilee Line"⟩ false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) > -0.05
-- Five minutes, four dark: each pays a quarter of the gap.
#guard Float.abs (4 * gapTerm ⟨.walking, none, none⟩ false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩)
  - gapLogLikelihood (modePriors .walking) (haversineMeters 51.5226 (-0.1571) 51.5067 (-0.1428)) 300) < 1e-9
-- A stay, placed or not, is held to the same gap.
#guard gapTerm ⟨.stationary, some 5, none⟩ false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) < -1.5
-- A stay that did not move pays nothing; a walk at its own pace pays little.
#guard gapTerm ⟨.stationary, none, none⟩ false (some ⟨0, 51.5, -0.1⟩) (some ⟨300, 51.5, -0.1⟩) == 0
#guard gapTerm ⟨.walking, none, none⟩ false (some ⟨0, 51.5000, -0.10⟩) (some ⟨600, 51.5060, -0.10⟩) > -0.1
-- A minute with a fix, or a gap with no dark minute, asserts nothing.
#guard gapTerm ⟨.walking, none, none⟩ true (some ⟨0, 51.5226, -0.1571⟩) (some ⟨300, 51.5067, -0.1428⟩) == 0
#guard gapTerm ⟨.walking, none, none⟩ false (some ⟨0, 51.5226, -0.1571⟩) (some ⟨60, 51.5067, -0.1428⟩) == 0

private def fx (ts lat lon : Float) : GpsFix := ⟨ts, lat, lon⟩
private def stt (m : Mode) (pid : Option Int) : State := ⟨m, pid, none⟩
private def home : Option (Float × Float) := some (51.55, 2.22)

-- 17 km in three minutes (340 km/h) to reach the place: no ground mode.
#guard geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 2.39)) none home < -20
-- Four minutes after a fix 15 m away: reachable on foot.
#guard geometricFeasibility (stt .stationary (some 5)) 1240 (some (fx 1000 51.5501 2.2198)) none home > -0.01
-- An hour after a fix 12 km away: reachable.
#guard geometricFeasibility (stt .stationary (some 5)) 4600 (some (fx 1000 51.53 2.39)) none home > -0.5
-- Only a stay at a known place is this term's; a minute with its own fix asserts nothing.
#guard geometricFeasibility (stt .walking none) 1180 (some (fx 1000 51.53 2.39)) none home == 0
#guard geometricFeasibility (stt .stationary (some 9)) 1180 (some (fx 1000 51.53 2.39)) none none == 0
#guard geometricFeasibility (stt .stationary (some 5)) 1000 (some (fx 1000 51.53 2.39)) none home == 0
-- Both legs count: the way back out costs too.
#guard geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 2.39)) (some (fx 1300 51.60 2.20)) home
  < geometricFeasibility (stt .stationary (some 5)) 1180 (some (fx 1000 51.53 2.39)) none home

end Verified.Hsmm.Geometric
