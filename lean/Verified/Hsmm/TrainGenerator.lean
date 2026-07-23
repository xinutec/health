import Verified.Hsmm.Emissions
/-!
# Train-generator entry prior (implementation-first port of `train-generator-prior.ts`)

A per-segment entry prior over `train @ L` states: the structural
`(board, line, alight)` candidate generator vouches, for each covered minute, a
set of lines that form a valid station-to-station ride there. Entering `train @ L`
on a covered minute is boosted when L is one of those lines and penalised when it
is not (on covered minutes the per-minute line factors are gated off, so this is
the only line signal); off-window it asserts nothing and the minute falls through
to the per-minute factors.

The candidate enumeration and the ts→line-set coverage map are the structural
resolution and stay caller-side; this module is the pure entry decision over two
resolved booleans (`covered`, `lineValid`). Outputs are exact integer constants,
so parity is exact `==`. Bit-exact with TS, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.TrainGenerator

open Verified.Hsmm.Emissions (Mode State)

/-- Entry boost for a `train @ L` segment whose line is structurally valid for
    the covered window. Below the ~5-nat cross-state transition cost — nudges,
    never forces mode. -/
def VALID_LINE_BOOST : Float := 3
/-- Entry penalty for a `train @ L` segment whose line is not valid for the
    covered window. Decisive among train lines, bounded so it cannot flip the
    mode to driving. -/
def INVALID_LINE_PENALTY : Float := 8

/-- `buildTrainEntryFromCandidates`' `entry` decision. `covered` = the minute's
    ts is inside a generator window; `lineValid` = that window vouches the
    state's line. `unknown_rail` (the graceful-degradation fallback the
    generator never emits) is never penalised. -/
def trainEntryPrior (s : State) (covered lineValid : Bool) : Float :=
  if s.mode != .train then 0.0
  else match s.lineName with
    | none => 0.0
    | some line =>
      if line == "unknown_rail" then 0.0
      else if !covered then 0.0            -- generator silent here
      else if lineValid then VALID_LINE_BOOST else -INVALID_LINE_PENALTY

-- Parity with the real `entry` closure (constants match the TS routing).
private def tr (line : Option String) : State := ⟨.train, none, line⟩

#guard trainEntryPrior (tr (some "Jubilee")) true true == 3     -- covered & valid → boost
#guard trainEntryPrior (tr (some "Metropolitan")) true false == -8  -- covered & invalid → penalty
#guard trainEntryPrior (tr (some "Jubilee")) false false == 0   -- generator silent (off-window)
#guard trainEntryPrior (tr (some "unknown_rail")) true false == 0   -- fallback never penalised
#guard trainEntryPrior (tr none) true true == 0                 -- no line committed
#guard trainEntryPrior ⟨.walking, none, none⟩ true true == 0    -- not train
#guard trainEntryPrior ⟨.stationary, some 5, none⟩ true true == 0

end Verified.Hsmm.TrainGenerator
