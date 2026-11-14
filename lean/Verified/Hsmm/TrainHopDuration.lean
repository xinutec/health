import Verified.Hsmm.Duration
import Verified.Hsmm.Emissions
/-!
# Train one-stop-hop duration prior

The duration prior floors sub-`minDuration` movement at `HARD_FLOOR_LOG_PROB`
(a 1-minute `train` is usually an artifact). A one-stop underground hop is a
real sub-floor ride, so a covered, sub-floor, named-line train segment takes a
flat 0-nat prior; everything else is `logDurationProb`. The caller resolves
`covered`, the fit and floors. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.TrainHopDuration

open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Duration (GammaFit logDurationProb)

/-- A committed line the generator can vouch: present and not the
    `unknown_rail` graceful-degradation fallback. -/
def lineIsNamed : Option String → Bool
  | none => false
  | some l => !Verified.Hsmm.Emissions.isPlaceholderLine l

/-- The per-segment duration verdict. `covered` is the caller's "segment end has
    a timestamp and the generator covers it"; `fit`/`minForMode` are the mode's
    fit and floor; `trainMin` the train floor. -/
def trainHopDurationLogProb (s : State) (d : Float) (covered : Bool)
    (fit : GammaFit) (minForMode trainMin : Float) : Float :=
  if s.mode == .train && lineIsNamed s.lineName && d < trainMin && covered then 0.0
  else logDurationProb d fit minForMode

/-- `trainHopDurationLogProb` with the per-mode prior handed in, so a caller
    walking `e` computes `logDurationProb` once per `(s, d)`: the duration
    tensor dominates the model build. `trainHopDurationLogProb_eq`: same term. -/
def trainHopDurationLogProbFrom (s : State) (d : Float) (covered : Bool)
    (trainMin base : Float) : Float :=
  if s.mode == .train && lineIsNamed s.lineName && d < trainMin && covered then 0.0
  else base

theorem trainHopDurationLogProb_eq (s : State) (d : Float) (covered : Bool)
    (fit : GammaFit) (minForMode trainMin : Float) :
    trainHopDurationLogProb s d covered fit minForMode trainMin
      = trainHopDurationLogProbFrom s d covered trainMin (logDurationProb d fit minForMode) := rfl

-- Parity with the real closure (fall-through values are the pinned `logDurationProb`).
private def tr (line : Option String) : State := ⟨.train, none, line⟩
private def gf (a b : Float) : GammaFit := ⟨a, b, 10⟩

#guard trainHopDurationLogProb (tr (some "Jubilee")) 1 true (gf 4 0.1333) 2 2 == 0     -- relaxation fires
#guard trainHopDurationLogProb (tr (some "Jubilee")) 1 false (gf 4 0.1333) 2 2 == -10  -- uncovered → floor
#guard trainHopDurationLogProb (tr (some "Jubilee")) 30 true (gf 4 0.13333333333333333) 2 2 == -3.6477794064106472  -- d ≥ floor
#guard trainHopDurationLogProb (tr (some "unknown_rail")) 1 true (gf 4 0.1333) 2 2 == -10  -- fallback never relaxed
#guard trainHopDurationLogProb (tr none) 1 true (gf 4 0.1333) 2 2 == -10               -- no line committed
#guard trainHopDurationLogProb ⟨.walking, none, none⟩ 1 true (gf 4 0.1333) 2 2 == -10  -- not train

end Verified.Hsmm.TrainHopDuration
