import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.FloatScore
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

/-! ## Window resolution over the observation tensor (port of `buildSegmentEvidence`'s `windowFor`)

`segmentEvidence` scores a caller-resolved `Window`; this resolves it from the
observation tensor exactly as `buildSegmentEvidence` does — a prefix sum of
MEASURED cadence for the O(1) step total, and the bracketing `prevGpsFix` /
`nextGpsFix` with their slop (fix time outside the segment's own minutes, which
widens σ). The only transcendental is `haversineMeters` (≤1 ULP), so the resolved
`dispM` — and thus the composed score — is ULP-close; the slop/step arithmetic is
exact. This closes the last caller-resolved scoring stub: with it every factor the
model-assembly callbacks consume is computed in Lean from the parsed inputs. -/

open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- Prefix sums of MEASURED cadence: `pref[i] = Σ_{k<i} cadence(k)` (absent → 0),
    so a segment's step total is one subtraction. -/
def stepPrefix (obs : Array ObsRow) : Array Float := Id.run do
  let mut a := Array.replicate (obs.size + 1) 0.0
  for i in [0:obs.size] do
    a := a.set! (i + 1) (a[i]! + obs[i]!.cadence.getD 0)
  return a

/-- The caller-side `Window` for `[startIndex, segEnd]`, or `none` ("assert
    nothing") when a bracketing fix is missing or non-advancing. `startIndex` may
    be negative for early segments; it is clamped for the `first`/step lookups
    exactly as the TS `Math.max(0, startIndex)`. -/
def windowFor (obs : Array ObsRow) (pref : Array Float) (startIndex segEnd : Int) : Option Window :=
  if decide (segEnd < 0) || decide (segEnd ≥ (obs.size : Int)) then none
  else
    let loIdx := (max 0 startIndex).toNat
    if decide (loIdx ≥ obs.size) then none
    else
      let first := obs[loIdx]!
      let last := obs[segEnd.toNat]!
      match first.prevGpsFix, last.nextGpsFix with
      | some before, some after =>
        if decide (after.ts ≤ before.ts) then none
        else
          let segStartTs := first.ts
          let segEndTs := last.ts + 60
          let slopMin := ((max 0 (segStartTs - before.ts)).toNat.toFloat
                        + (max 0 (after.ts - segEndTs)).toNat.toFloat) / 60
          let sl := SLOP_SPEED_M_PER_MIN * slopMin
          let hiIdx := (min (obs.size : Int) (segEnd + 1)).toNat
          some ⟨haversineMeters before.lat before.lon after.lat after.lon,
                sl * sl, pref[hiIdx]! - pref[loIdx]!⟩
      | _, _ => none

/-- Segment-evidence resolved over the observation tensor: the caller supplies
    only the state mode, segment length `d`, and end index `segEnd` (the duration
    hook's arguments). `startIndex = segEnd − d + 1`, matching `buildSegmentEvidence`. -/
def segmentEvidenceAt (obs : Array ObsRow) (pref : Array Float)
    (mode : Mode) (d segEnd : Nat) : Float :=
  if mode == .unknown then 0.0
  else match windowFor obs pref ((segEnd : Int) - (d : Int) + 1) (segEnd : Int) with
    | none => 0.0
    | some w => segmentEvidence mode d.toFloat w

-- Parity with `buildSegmentEvidence`'s window resolution (values from Node/V8).
private def sev (i : Nat) (prev next : Option Fix) : ObsRow :=
  { ts := 1000 + (i : Int) * 60, gps := none, hr := none, cadence := some 100,
    hourLocal := 0, dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none,
    reacquireAgeMin := none, prevGpsFix := prev, nextGpsFix := next }
private def sevObs : Array ObsRow := #[
  sev 0 none none,
  sev 1 (some ⟨1060, 51.5, -0.1⟩) none,          -- segStart bracket (slop 0 left)
  sev 2 none none, sev 3 none none, sev 4 none none,
  sev 5 none (some ⟨1360, 51.508, -0.1⟩),        -- segEnd bracket (segEndTs=1360, slop 0)
  sev 6 none (some ⟨1600, 51.508, -0.1⟩),        -- right-slop variant (after 1600 > 1420)
  sev 7 none none]
private def sevPref : Array Float := stepPrefix sevObs
private def approxS (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard stepPrefix sevObs == #[0, 100, 200, 300, 400, 500, 600, 700, 800]
#guard segmentEvidenceAt sevObs sevPref .stationary 5 5 == -6                          -- 890 m "stay" → clamp
#guard approxS (segmentEvidenceAt sevObs sevPref .walking 5 5) (-3.309642370852955)    -- 500 steps predict 375 m
#guard approxS (segmentEvidenceAt sevObs sevPref .train 5 5) (-0.7657284976831875)     -- net-speed prior
#guard segmentEvidenceAt sevObs sevPref .unknown 5 5 == 0                              -- asserts nothing
#guard segmentEvidenceAt sevObs sevPref .stationary 5 6 == 0                           -- start=2, no left bracket
#guard approxS (segmentEvidenceAt sevObs sevPref .train 6 6) (-0.4334659425009404)     -- 3-min right slop widens σ
#guard approxS (segmentEvidenceAt sevObs sevPref .walking 6 6) (-0.04218613050103086)  -- 600 steps predict 450 m

end Verified.Hsmm.SegmentEvidence
