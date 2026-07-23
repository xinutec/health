import Verified.Hsmm.Emissions
/-!
# Duration log-probabilities (implementation-first port of `src/hmm/duration-dist.ts`)

Per-mode segment-duration model in Lean `Float`: a method-of-moments Gamma fit,
its log-pdf evaluated via a Lanczos `log Γ`, and the per-mode physical-floor
override. UNPROVEN, per the implementation-first direction; arithmetic mirrors
`duration-dist.ts` exactly (accumulation order, the Lanczos coefficients, the
`z < 0.5` reflection), pinned bit-for-bit by the `#guard`s against the exported
`logDurationProb` / `fitDurationDistribution`.
-/

namespace Verified.Hsmm.Duration

open Verified.Hsmm.Emissions (Mode)

/-- `HARD_FLOOR_LOG_PROB`: floor for physically-implausible durations. -/
def HARD_FLOOR_LOG_PROB : Float := -10

/-- `VAR_FLOOR`: stddev-floor² when fitting. -/
def VAR_FLOOR : Float := 4

/-- `DEFAULT_MIN_DURATION_BY_MODE` (minutes). -/
def minDurationByMode : Mode → Float
  | .stationary => 2
  | .walking    => 2
  | .cycling    => 2
  | .driving    => 2
  | .train      => 2
  | .plane      => 30
  | .unknown    => 1

structure GammaFit where
  alpha : Float
  beta : Float
  sampleCount : Nat

private def pi : Float := 3.141592653589793

/-- `LANCZOS_C` (g = 7). -/
def lanczosC : Array Float :=
  #[0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7]

/-- Lanczos approximation to `log Γ(z)` for `z ≥ 0.5`. -/
def logGammaLanczos (z : Float) : Float :=
  let zm1 := z - 1
  let x := (List.range' 1 8).foldl (fun acc i => acc + lanczosC[i]! / (zm1 + i.toFloat)) lanczosC[0]!
  let t := zm1 + 7 + 0.5
  0.5 * Float.log (2 * pi) + (zm1 + 0.5) * Float.log t - t + Float.log x

/-- `log Γ(z)` with the `z < 0.5` reflection `Γ(z)Γ(1−z) = π / sin(πz)`. -/
def logGamma (z : Float) : Float :=
  if z < 0.5 then Float.log (pi / Float.sin (pi * z)) - logGammaLanczos (1 - z)
  else logGammaLanczos z

/-- Log Gamma pdf: `α log β − log Γ(α) + (α−1) log d − β d`. -/
def logGammaPdf (d alpha beta : Float) : Float :=
  if alpha <= 0 || beta <= 0 || d <= 0 then HARD_FLOOR_LOG_PROB
  else alpha * Float.log beta - logGamma alpha + (alpha - 1) * Float.log d - beta * d

/-- Duration log-probability, with the physical floor below `minDuration`. -/
def logDurationProb (d : Float) (fit : GammaFit) (minDuration : Float) : Float :=
  if d < minDuration then HARD_FLOOR_LOG_PROB
  else if d <= 0 then HARD_FLOOR_LOG_PROB
  else logGammaPdf d fit.alpha fit.beta

/-- Method-of-moments Gamma fit; `FALLBACK_GAMMA` for < 5 samples. -/
def fitDurationDistribution (values : List Float) : GammaFit :=
  if values.length < 5 then { alpha := 1.5, beta := 0.1, sampleCount := values.length }
  else
    let n := values.length
    let sum := values.foldl (· + ·) 0.0
    let mean := sum / n.toFloat
    let sumSq := values.foldl (fun acc v => acc + (v - mean) * (v - mean)) 0.0
    let vv := sumSq / (n - 1).toFloat
    let variance := if vv > VAR_FLOOR then vv else VAR_FLOOR
    { alpha := mean * mean / variance, beta := mean / variance, sampleCount := n }

-- Parity with the real `logDurationProb` / `fitDurationDistribution` (Node/V8):
private def gf (a b : Float) : GammaFit := ⟨a, b, 10⟩
#guard logDurationProb 30 (gf 4 0.13333333333333333) 2 == -3.6477794064106472
#guard logDurationProb 1 (gf 4 0.1333) 2 == -10
#guard logDurationProb 10 (gf 1.5 0.1) 2 == -3.1818028553588005
#guard logDurationProb 45 (gf 5 0.11) 30 == -3.937778437215269
#guard logDurationProb 10 (gf 0.3 0.1) 2 == -4.398383087812121   -- exercises z<0.5 reflection
#guard (fitDurationDistribution [10, 20, 30, 40, 50, 15, 25]).alpha == 3.705731394354148
#guard (fitDurationDistribution [10, 20, 30, 40, 50, 15, 25]).beta == 0.13652694610778443
#guard (fitDurationDistribution [3, 4]).alpha == 1.5
#guard (fitDurationDistribution [3, 4]).sampleCount == 2

end Verified.Hsmm.Duration
