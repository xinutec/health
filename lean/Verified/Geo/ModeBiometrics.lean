/-!
# Per-user biometric mode signatures (port of the pure core of `src/geo/mode-biometrics.ts`)

The heuristic-training + biometric-correction engine: label clean minutes by
rule, mine per-mode Gaussian stats, and re-classify a segment's mode against
them (HR / cadence vetoes, then a log-likelihood flip). The segment-array
transforms in `biometrics.ts` that call these stay shell; ported here:

* `labelMinuteByHeuristic` — confident mode for a clean minute, or `none`.
* `scoreModeLogLikelihood` — per-modality Gaussian LL (std floored), `-∞` when
  nothing contributes.
* `isHrImplausibleForMode` / `isCadenceImplausibleForMode` — the veto predicates.
* `vetoImplausibleHr` / `vetoImplausibleCadence` — demote to the best alternative.
* `gateCycling` — the hard cycling-evidence gate.
* `correctModeBySignature` — the full decision (vetoes → margin gate → LL flip).
* `aggregateModeStats` — mine per-mode mean/std (population).

All discrete + arithmetic; the only transcendental is `sqrt` in the std (exact
per IEEE) ⇒ EXACT. UNPROVEN; pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.ModeBiometrics

private def negInf : Float := -1.0 / 0.0

/-! ## Constants -/
def HR_STD_FLOOR_BPM : Float := 5
def CADENCE_STD_FLOOR_SPM : Float := 5
def SPEED_STD_FLOOR_KMH : Float := 2
def RELABEL_LL_THRESHOLD : Float := 4
def RELABEL_MAX_MARGIN : Float := 3
def RELABEL_MIN_BIOMETRIC_OBS : Nat := 1
def HR_VETO_SIGMA : Float := 2.0
def CADENCE_VETO_SIGMA : Float := 2.0
def CADENCE_VETO_FLOOR_SPM : Float := 30
def CADENCE_VETO_MAX_SPEED_KMH : Float := 15
def CYCLING_MIN_SPEED_KMH : Float := 12
def CYCLING_MAX_SPEED_KMH : Float := 35
def CYCLING_MAX_CADENCE_SPM : Float := 20
def SIT_MODES : List String := ["driving", "train", "plane"]
def LOW_CADENCE_MODES : List String := ["cycling", "driving", "train", "plane"]
def NEVER_FLIP_TARGET : List String := ["cycling"]
def MAX_SPEED_FOR_MODE : List (String × Float) := [("stationary", 5), ("walking", 12), ("cycling", 35)]

/-! ## Shapes -/
structure MinuteObservation where
  hr : Option Float
  cadence : Option Float
  speed : Option Float
  deriving Inhabited

structure ModeStats where
  mode : String
  hrMean : Option Float
  hrStd : Option Float
  hrSampleCount : Nat
  cadenceMean : Option Float
  cadenceStd : Option Float
  cadenceSampleCount : Nat
  speedMean : Option Float
  speedStd : Option Float
  speedSampleCount : Nat
  sampleCount : Nat
  deriving Inhabited

/-! ## Heuristic labeller -/

/-- Confident mode for a clean per-minute observation, or `none` (ambiguous). -/
def labelMinuteByHeuristic (obs : MinuteObservation) : Option String := Id.run do
  match obs.speed with
  | none => return none
  | some speed =>
    let hr := obs.hr
    if decide (speed < 1) && (match obs.cadence with | none => true | some cv => decide (cv < 5)) then
      return some "stationary"
    match obs.cadence with
    | none => return none
    | some cv =>
      if decide (cv ≥ 80) && decide (cv ≤ 140) && decide (speed ≥ 3) && decide (speed ≤ 7) then return some "walking"
      if decide (cv < 5) && decide (speed ≥ 12) && decide (speed ≤ 25)
          && (match hr with | some h => decide (h ≥ 100) && decide (h ≤ 170) | none => false) then return some "cycling"
      let hrLt95 := match hr with | none => true | some h => decide (h < 95)
      if decide (cv < 5) && decide (speed > 30) && decide (speed ≤ 80) && hrLt95 then return some "driving"
      if decide (cv < 5) && decide (speed > 80) && decide (speed ≤ 330) && hrLt95 then return some "train"
      if decide (cv < 5) && decide (speed > 500) then return some "plane"
      return none

/-! ## Gaussian log-likelihood -/

/-- Per-modality Gaussian LL, each std floored; `-∞` when nothing contributes. -/
def scoreModeLogLikelihood (obs : MinuteObservation) (stats : ModeStats) : Float :=
  let factor := fun (val mean std : Option Float) (floor : Float) (acc : Float × Nat) =>
    match val, mean, std with
    | some v, some m, some s =>
      if s == 0 then acc
      else
        let eff := max s floor
        let z := (v - m) / eff
        (acc.1 + (-0.5 * z * z), acc.2 + 1)
    | _, _, _ => acc
  let a0 := factor obs.hr stats.hrMean stats.hrStd HR_STD_FLOOR_BPM (0, 0)
  let a1 := factor obs.cadence stats.cadenceMean stats.cadenceStd CADENCE_STD_FLOOR_SPM a0
  let a2 := factor obs.speed stats.speedMean stats.speedStd SPEED_STD_FLOOR_KMH a1
  if a2.2 == 0 then negInf else a2.1

/-! ## Veto predicates -/

def isHrImplausibleForMode (mode : String) (obsHr : Option Float) (stats : List ModeStats) : Bool :=
  if mode == "stationary" then false
  else match obsHr with
    | none => false
    | some hr =>
      match stats.find? (fun s => s.mode == mode) with
      | none => false
      | some cur => match cur.hrMean, cur.hrStd with
        | some m, some sd => if decide (sd ≤ 0) then false else decide (hr < m - HR_VETO_SIGMA * sd)
        | _, _ => false

def isCadenceImplausibleForMode (mode : String) (obsCadence obsSpeed : Option Float) (stats : List ModeStats) : Bool :=
  if !LOW_CADENCE_MODES.contains mode then false
  else match obsCadence with
    | none => false
    | some cad =>
      if (match obsSpeed with | some sp => decide (sp > CADENCE_VETO_MAX_SPEED_KMH) | none => false) then false
      else match stats.find? (fun s => s.mode == mode) with
        | none => false
        | some cur => match cur.cadenceMean, cur.cadenceStd with
          | some m, some sd => decide (cad > max (m + CADENCE_VETO_SIGMA * sd) CADENCE_VETO_FLOOR_SPM)
          | _, _ => false

/-- Highest-log-likelihood alternative mode (excluding the current + never-flip
    targets), or `none`. -/
private def bestAlternative (segMode : String) (obs : MinuteObservation) (stats : List ModeStats) : Option String :=
  (stats.foldl (fun (best : Option (String × Float)) s =>
    if s.mode == segMode || NEVER_FLIP_TARGET.contains s.mode then best
    else
      let sc := scoreModeLogLikelihood obs s
      match best with
      | none => some (s.mode, sc)
      | some (bm, bsc) => if decide (sc > bsc) then some (s.mode, sc) else some (bm, bsc)) none).map (·.1)

def vetoImplausibleHr (segMode : String) (obsHr obsCadence obsSpeed : Option Float)
    (stats : List ModeStats) : String × Bool :=
  if !isHrImplausibleForMode segMode obsHr stats then (segMode, false)
  else match bestAlternative segMode ⟨obsHr, obsCadence, obsSpeed⟩ stats with
    | some m => (m, true)
    | none => (segMode, false)

def vetoImplausibleCadence (segMode : String) (obsHr obsCadence obsSpeed : Option Float)
    (stats : List ModeStats) : String × Bool :=
  if !isCadenceImplausibleForMode segMode obsCadence obsSpeed stats then (segMode, false)
  else match bestAlternative segMode ⟨obsHr, obsCadence, obsSpeed⟩ stats with
    | some m => (m, true)
    | none => (segMode, false)

/-- Hard cycling-evidence gate: keep `cycling` only with cycle-band speed and no
    walking cadence; else demote (driving if too fast, otherwise walking). -/
def gateCycling (mode : String) (obsCadence obsSpeed : Option Float) : String × Bool :=
  if mode != "cycling" then (mode, false)
  else
    let speedOk := match obsSpeed with
      | some sp => decide (sp ≥ CYCLING_MIN_SPEED_KMH) && decide (sp ≤ CYCLING_MAX_SPEED_KMH)
      | none => false
    let cadenceOk := match obsCadence with | none => true | some c => decide (c < CYCLING_MAX_CADENCE_SPM)
    if speedOk && cadenceOk then ("cycling", false)
    else
      let demoted := match obsSpeed with
        | some sp => if decide (sp > CYCLING_MAX_SPEED_KMH) then "driving" else "walking"
        | none => "walking"
      (demoted, true)

/-- Relabel a segment's mode from per-user biometric signatures: vetoes first,
    then a margin gate, then a log-likelihood flip (never into cycling / a
    sibling sit-mode / a speed-incompatible mode). -/
def correctModeBySignature (segMode : String) (confidenceMargin : Float)
    (obsHr obsCadence obsSpeed : Option Float) (stats : List ModeStats) : String × Bool := Id.run do
  if segMode == "stationary" then return (segMode, false)
  let hrV := vetoImplausibleHr segMode obsHr obsCadence obsSpeed stats
  if hrV.2 then return hrV
  let cadV := vetoImplausibleCadence segMode obsHr obsCadence obsSpeed stats
  if cadV.2 then return cadV
  if decide (confidenceMargin ≥ RELABEL_MAX_MARGIN) then return (segMode, false)
  if stats.isEmpty then return (segMode, false)
  let obs : MinuteObservation := ⟨obsHr, obsCadence, obsSpeed⟩
  let biometricObsCount := (if obsHr.isSome then 1 else 0) + (if obsCadence.isSome then 1 else 0)
  if biometricObsCount < RELABEL_MIN_BIOMETRIC_OBS then return (segMode, false)
  let mut bestMode := segMode
  let mut bestScore : Float := negInf
  let mut currentScore : Float := negInf
  let mut currentFound := false
  for s in stats do
    let score := scoreModeLogLikelihood obs s
    if s.mode == segMode then
      currentScore := score
      currentFound := true
    let neverFlip := s.mode != segMode && NEVER_FLIP_TARGET.contains s.mode
    let sitSkip := SIT_MODES.contains segMode && SIT_MODES.contains s.mode && s.mode != segMode
    let capSkip := s.mode != segMode && (match obsSpeed with
      | some sp => (match MAX_SPEED_FOR_MODE.find? (fun p => p.1 == s.mode) with
        | some (_, cap) => decide (sp > cap)
        | none => false)
      | none => false)
    if !(neverFlip || sitSkip || capSkip) && decide (score > bestScore) then
      bestMode := s.mode
      bestScore := score
  if !currentFound then return (segMode, false)
  if bestMode == segMode then return (segMode, false)
  if decide (bestScore - currentScore < RELABEL_LL_THRESHOLD) then return (segMode, false)
  return (bestMode, true)

/-! ## Stats mining -/

private def computeMeanStd (values : List (Option Float)) : Option Float × Option Float × Nat :=
  let filtered := values.filterMap id
  if filtered.isEmpty then (none, none, 0)
  else
    let n := filtered.length
    let mean := filtered.foldl (· + ·) 0 / Float.ofNat n
    let variance := (filtered.foldl (fun a v => a + (v - mean) ^ 2) 0) / Float.ofNat n
    (some mean, some (Float.sqrt variance), n)

/-- Mine per-mode Gaussian stats from labelled minutes (population std), modes in
    first-seen order (mirroring the JS `Map`). -/
def aggregateModeStats (samples : List (String × MinuteObservation)) : List ModeStats := Id.run do
  let mut order : List String := []
  let mut byMode : List (String × List MinuteObservation) := []
  for (mode, obs) in samples do
    if byMode.any (fun p => p.1 == mode) then
      byMode := byMode.map (fun p => if p.1 == mode then (p.1, p.2 ++ [obs]) else p)
    else
      order := order ++ [mode]
      byMode := byMode ++ [(mode, [obs])]
  let mut stats : List ModeStats := []
  for mode in order do
    let obs := (byMode.find? (fun p => p.1 == mode)).map (·.2) |>.getD []
    let (hrMean, hrStd, hrN) := computeMeanStd (obs.map (·.hr))
    let (cadMean, cadStd, cadN) := computeMeanStd (obs.map (·.cadence))
    let (spMean, spStd, spN) := computeMeanStd (obs.map (·.speed))
    stats := stats ++ [⟨mode, hrMean, hrStd, hrN, cadMean, cadStd, cadN, spMean, spStd, spN, obs.length⟩]
  return stats

/-! ## Parity with Node/V8 (`lean/experiments/modebio-refs.mts`) -/

private def O (hr cadence speed : Float) : MinuteObservation := ⟨some hr, some cadence, some speed⟩
private def s (x : Float) : Option Float := some x
private def approxM (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard labelMinuteByHeuristic (O 65 0 0.5) == some "stationary"
#guard labelMinuteByHeuristic (O 90 110 5) == some "walking"
#guard labelMinuteByHeuristic (O 130 0 18) == some "cycling"
#guard labelMinuteByHeuristic (O 80 0 55) == some "driving"
#guard labelMinuteByHeuristic (O 70 0 120) == some "train"
#guard labelMinuteByHeuristic (O 60 0 600) == some "plane"
#guard labelMinuteByHeuristic ⟨some 70, some 0, none⟩ == none
#guard labelMinuteByHeuristic (O 90 0 40) == some "driving"
#guard labelMinuteByHeuristic (O 120 50 40) == none

private def samples : List (String × MinuteObservation) :=
  [("walking", O 95 110 5), ("walking", O 105 120 6), ("walking", O 100 100 4),
   ("driving", O 80 0 50), ("driving", O 82 0 60), ("cycling", ⟨some 140, none, some 18⟩)]
private def stats : List ModeStats := aggregateModeStats samples

-- aggregateModeStats: order + key fields
#guard stats.map (·.mode) == ["walking", "driving", "cycling"]
#guard match stats.find? (·.mode == "walking") with
  | some w => w.hrMean == some 100 && (match w.hrStd with | some sd => approxM sd 4.08248290463863 | none => false)
      && w.cadenceMean == some 110 && (match w.cadenceStd with | some sd => approxM sd 8.16496580927726 | none => false)
      && w.sampleCount == 3
  | none => false
#guard match stats.find? (·.mode == "driving") with
  | some d => d.cadenceStd == some 0 && d.hrMean == some 81
  | none => false
#guard match stats.find? (·.mode == "cycling") with
  | some c => c.cadenceMean == none && c.hrStd == some 0 && c.sampleCount == 1
  | none => false

-- scoreModeLogLikelihood
#guard match stats.find? (·.mode == "walking") with
  | some w => scoreModeLogLikelihood (O 100 110 5) w == 0
  | none => false
#guard match stats.find? (·.mode == "walking") with
  | some w => scoreModeLogLikelihood ⟨none, none, none⟩ w == negInf
  | none => false

-- veto predicates
#guard isHrImplausibleForMode "walking" (s 50) stats == true
#guard isHrImplausibleForMode "walking" (s 100) stats == false
#guard isCadenceImplausibleForMode "driving" (s 90) (s 50) stats == false
#guard isCadenceImplausibleForMode "driving" (s 90) (s 120) stats == false
#guard isCadenceImplausibleForMode "driving" (s 90) (s 10) stats == true
#guard isCadenceImplausibleForMode "walking" (s 90) (s 10) stats == false

-- gateCycling
#guard gateCycling "cycling" (s 5) (s 18) == ("cycling", false)
#guard gateCycling "cycling" (s 5) (s 40) == ("driving", true)
#guard gateCycling "cycling" (s 90) (s 18) == ("walking", true)
#guard gateCycling "walking" (s 90) (s 5) == ("walking", false)

-- correctModeBySignature
#guard correctModeBySignature "cycling" 1 (s 55) (s 100) (s 5) stats == ("walking", true)
#guard correctModeBySignature "stationary" 1 (s 55) (s 0) (s 0) stats == ("stationary", false)
#guard correctModeBySignature "walking" 5 (s 100) (s 110) (s 5) stats == ("walking", false)

end Verified.Geo.ModeBiometrics
