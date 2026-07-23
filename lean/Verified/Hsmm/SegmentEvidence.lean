import Verified.Hsmm.Emissions
/-!
# Segment-scoped physics evidence (implementation-first port of `segment-evidence.ts`)

Once per candidate segment, score whether its *story* is physically coherent:
compare the net displacement between the bracketing GPS fixes against what the
hypothesised mode predicts over the segment's duration (stationary ≈ 0; walking
≈ measured steps × stride; vehicles ≈ net-speed × duration), as a clamped
`−z²/2` penalty with σ widened in quadrature by bracket slop.

Discipline mirrors the sibling factors: everything that needs the route/GPS
geometry — the two bracketing fixes, the `haversine` between them, the slop
minutes, the prefix-summed step total — is resolved by the caller and arrives
as a `Window` (`dispM`, `slopVar`, `steps`). That keeps the only transcendental
(`haversine`, ≤1-ULP) upstream, so this module is a pure decision over
`sqrt`/`*`/`/`/`-`/`max` — all IEEE-correctly-rounded — and is genuinely
BIT-EXACT with TS. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.SegmentEvidence

open Verified.Hsmm.Emissions (Mode State)

/-- Mean walking stride (metres per counted step). -/
def STRIDE_M : Float := 0.75
/-- Stride-model relative spread (cadence miscounts, path indirection). -/
def STRIDE_REL_STD : Float := 0.4
/-- GPS noise floor on a net-displacement prediction (m). -/
def DISP_NOISE_M : Float := 200
/-- Unattributable-motion spread per minute of bracket slop (m/min). -/
def SLOP_SPEED_M_PER_MIN : Float := 500
/-- Hard clamp on the penalty — evidence, never a veto. -/
def CLAMP_NATS : Float := -6

/-- `Math.max` for non-NaN operands (the only ones that reach here). -/
private def fmax (a b : Float) : Float := if a < b then b else a

/-- Net-speed priors (km/h) for vehicle segments — `none` for non-vehicle
    modes, whose displacement the caller handles specially or scores 0. -/
def netSpeed : Mode → Option (Float × Float)
  | .cycling => some (12, 6)
  | .driving => some (22, 12)
  | .train   => some (28, 14)
  | .plane   => some (400, 250)
  | _        => none

/-- Caller-resolved segment geometry: net displacement between the bracketing
    fixes, the (already-squared) slop variance, and the measured step total. -/
structure Window where
  dispM : Float
  slopVar : Float
  steps : Float

/-- `−z²/2`, clamped at `CLAMP_NATS`. -/
def zPenalty (observed predicted sigma : Float) : Float :=
  let z := (observed - predicted) / sigma
  fmax CLAMP_NATS (-0.5 * z * z)

/-- σ widened in quadrature by the bracket slop variance. -/
def withSlop (sigma slopVar : Float) : Float := Float.sqrt (sigma * sigma + slopVar)

/-- `buildSegmentEvidence`'s per-state verdict, over a caller-resolved window.
    `unknown` and modes with no net-speed prior assert nothing (0). -/
def segmentEvidence (mode : Mode) (durationMinutes : Float) (w : Window) : Float :=
  match mode with
  | .unknown => 0.0
  | .stationary => zPenalty w.dispM 0 (withSlop DISP_NOISE_M w.slopVar)
  | .walking =>
    let predicted := w.steps * STRIDE_M
    let sigma := fmax (STRIDE_REL_STD * predicted) DISP_NOISE_M
    zPenalty w.dispM predicted (withSlop sigma w.slopVar)
  | m =>
    match netSpeed m with
    | none => 0.0
    | some (mean, std) =>
      let segH := durationMinutes / 60
      let predicted := mean * 1000 * segH
      let sigma := fmax (std * 1000 * segH) DISP_NOISE_M
      zPenalty w.dispM predicted (withSlop sigma w.slopVar)

-- Parity with the real `buildSegmentEvidence` closure (values from Node/V8); bit-exact.
private def win (dispM slopVar steps : Float) : Window := ⟨dispM, slopVar, steps⟩

#guard segmentEvidence .unknown 60 (win 5000 0 0) == 0
#guard segmentEvidence .stationary 60 (win 100 0 0) == -0.125
#guard segmentEvidence .stationary 60 (win 3000 0 0) == -6            -- 3 km stay → clamp
#guard segmentEvidence .stationary 60 (win 300 0 0) == -1.125
#guard segmentEvidence .stationary 60 (win 300 90000 0) == -0.3461538461538462  -- slop widens σ
#guard segmentEvidence .walking 30 (win 1000 0 2000) == -0.34722222222222227    -- steps predict 1500 m
#guard segmentEvidence .walking 30 (win 2000 0 500) == -6             -- half the steps the distance demands
#guard segmentEvidence .walking 30 (win 100 0 0) == -0.125            -- σ floors at DISP_NOISE_M
#guard segmentEvidence .cycling 60 (win 12000 0 0) == 0               -- 12 km/h·1 h = 12 km predicted
#guard segmentEvidence .driving 30 (win 5000 0 0) == -0.5
#guard segmentEvidence .train 20 (win 20000 0 0) == -2.6122448979591852
#guard segmentEvidence .plane 120 (win 500000 0 0) == -0.18

end Verified.Hsmm.SegmentEvidence
