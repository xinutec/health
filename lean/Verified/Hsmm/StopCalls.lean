/-!
# A train's stops, as a likelihood

At a passed station, the slowest minute says whether the train called. One
fitted mixture (`segEmission.journey.stops`): stopped (exponential on speed) and
moving (Gaussian), with calling and through shares. A line calling there is
scored by the ratio; one that does not scores nothing.

Fitted on the narrated rides' passed stations (`fit_emissions`); the Jubilee
and Metropolitan separate on the surface stations only one calls at.
-/

namespace Verified.Hsmm.StopCalls

/-- The fitted mixture: `piCall` and `piThrough` the stopped share of a
    calling and of a through pass; `rate` the stopped component's exponential
    rate per km/h; `mean`, `sd` the moving component's. -/
structure Params where
  piCall : Float
  piThrough : Float
  rate : Float
  mean : Float
  sd : Float
  deriving Inhabited, Repr, BEq

/-- `½ log 2π`. -/
def HALF_LOG_TWO_PI : Float := 0.9189385332046727
def HALF : Float := 0.5
def ONE : Float := 1

/-- `log` of the mixture's density at `v` km/h with stopped share `pi`. -/
def logMix (p : Params) (pi v : Float) : Float :=
  let z := (v - p.mean) / p.sd
  let logStopped := Float.log p.rate - p.rate * v
  let logMoving := -HALF_LOG_TWO_PI - Float.log p.sd - HALF * z * z
  -- log(pi·e^a + (1−pi)·e^b), from the larger term.
  let a := Float.log pi + logStopped
  let b := Float.log (ONE - pi) + logMoving
  let m := if a > b then a else b
  m + Float.log (Float.exp (a - m) + Float.exp (b - m))

/-- The calling line's evidence at a pass of `v` km/h: calling against through. -/
def callRatio (p : Params) (v : Float) : Float :=
  logMix p p.piCall v - logMix p p.piThrough v

private def P : Params := { piCall := 0.9, piThrough := 0.2, rate := 0.5, mean := 60, sd := 15 }
-- Standing at the platform says it called; running through at speed says not.
#guard callRatio P 0 > 1
#guard callRatio P 70 < -2
-- Equal shares carry no evidence.
#guard callRatio { P with piThrough := 0.9 } 35 == 0

end Verified.Hsmm.StopCalls
