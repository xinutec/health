import Verified.Hsmm.Duration
import Verified.Hsmm.Emissions
/-!
# Train one-stop-hop duration prior (implementation-first port of `train-hop-duration.ts`)

The per-mode duration prior floors every sub-`minDuration` movement segment at
`HARD_FLOOR_LOG_PROB` — a 1-minute `train` is normally a bridge artifact. But a
one-stop underground hop is a genuine sub-floor ride (GPS occluded from boarding
until a single reacquisition fix), so when the train generator vouches that
minute the floor must not apply: such a covered, sub-floor, named-line train
segment takes a flat 0-nat prior. Every other case is exactly the per-mode
`logDurationProb`.

The mode-indexed fit / floor lookups and the `tsAt`+`isTrainCovered` resolution
are caller-side; this module is the pure decision over the resolved `covered`
boolean and the resolved `fit` / floors. It reuses the ported `logDurationProb`
kernel, so its parity story is that kernel's (exact on tested inputs). UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Hsmm.TrainHopDuration

open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Duration (GammaFit logDurationProb)

/-- A committed line the generator can vouch: present and not the
    `unknown_rail` graceful-degradation fallback. -/
def lineIsNamed : Option String → Bool
  | none => false
  | some l => l != "unknown_rail"

/-- `buildDurationLogProb`'s per-segment verdict. `covered` folds the caller's
    `tsAt(segEndIndex)` defined ∧ `isTrainCovered(ts)`; `fit`/`minForMode` are
    the state-mode's fit and floor; `trainMin` is the train floor used for the
    sub-floor threshold. -/
def trainHopDurationLogProb (s : State) (d : Float) (covered : Bool)
    (fit : GammaFit) (minForMode trainMin : Float) : Float :=
  if s.mode == .train && lineIsNamed s.lineName && d < trainMin && covered then 0.0
  else logDurationProb d fit minForMode

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
