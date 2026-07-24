/-!
# Biometric coherence (port of `src/geo/biometric-coherence.ts`)

The per-segment "is the user actually sitting here vs moving through" signal
`B_s ∈ [0,1]` that modulates a focus-place's magnetic pull. A logistic gate over
step density and HR-elevation: near 1 for clearly-sitting, near 0 for
clearly-moving. Missing biometrics ⇒ 1 (degrade to "no information"). The only
transcendental is `exp` in the logistic (≤1 ULP). UNPROVEN; pinned by the
`#guard`s against Node/V8.
-/

namespace Verified.Geo.BiometricCoherence

def BETA_0 : Float := 4
def BETA_STEPS : Float := 0.08
def BETA_HR : Float := 0.06
def REST_HR_BASELINE : Float := 70

structure HrPoint where
  ts : Int
  bpm : Float
  deriving Inhabited

structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited

private def logistic (x : Float) : Float := 1 / (1 + Float.exp (-x))

/-- `B_s` for a segment window: `logistic(β₀ − β_steps·stepsPerMin − β_hr·ΔHR)`.
    Steps summed over the window / duration-minutes; HR averaged (or the resting
    baseline when absent); `ΔHR = max(0, hrMean − baseline)`. -/
def biometricCoherence (startTs endTs : Int) (hr : List HrPoint) (steps : List StepPoint) : Float :=
  let durationMin := max 1 (Float.ofInt (endTs - startTs) / 60)
  let inSeg := fun (ts : Int) => decide (ts ≥ startTs) && decide (ts ≤ endTs)
  let hrInSeg := hr.filter (fun p => inSeg p.ts)
  let stepsInSeg := steps.filter (fun p => inSeg p.ts)
  let stepsPerMin := (stepsInSeg.foldl (fun s p => s + p.steps) 0) / durationMin
  let hrMean := if hrInSeg.isEmpty then REST_HR_BASELINE
                else (hrInSeg.foldl (fun s p => s + p.bpm) 0) / Float.ofNat hrInSeg.length
  let hrElevation := max 0 (hrMean - REST_HR_BASELINE)
  logistic (BETA_0 - BETA_STEPS * stepsPerMin - BETA_HR * hrElevation)

/-! ## Parity with Node/V8 (`lean/experiments/biocoherence-refs.mts`) -/

private def approxB (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard approxB (biometricCoherence 0 3600 [⟨60, 68⟩, ⟨120, 70⟩] [⟨60, 0⟩]) 0.9820137900379085
#guard approxB (biometricCoherence 0 600 [⟨60, 95⟩]
  [⟨60, 90⟩, ⟨120, 90⟩, ⟨180, 90⟩, ⟨240, 90⟩, ⟨300, 90⟩]) 0.24973989440488234
#guard approxB (biometricCoherence 0 3600 [] []) 0.9820137900379085
#guard approxB (biometricCoherence 0 600 [⟨60, 70⟩]
  [⟨60, 30⟩, ⟨120, 30⟩, ⟨180, 30⟩, ⟨240, 30⟩, ⟨300, 30⟩, ⟨360, 30⟩, ⟨420, 30⟩, ⟨480, 30⟩, ⟨540, 30⟩, ⟨600, 30⟩]) 0.8320183851339245

end Verified.Geo.BiometricCoherence
