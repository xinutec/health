import Verified.Hsmm.Emissions
/-!
# Transition log-probabilities

The row-normalised static-prior transition matrix: each `src` keeps
`exp(selfLoop)` on the self-loop and splits the rest over valid (non-hard-zero)
destinations in proportion to `transitionWeight`. The station-graph hard zero
is `isHardZeroP` with a `placeNear` relation.

UNPROVEN. `crossMass = 1 - exp(selfLoop)` is computed, not a literal, so values
are fixed bit for bit; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Transitions

open Verified.Hsmm.FloatScore
open Verified.Hsmm.Emissions (Mode State)

/-- `DEFAULT_SELF_LOOP = Math.log(0.95)`. -/
def defaultSelfLoop : Float := Float.log 0.95

/-- `INTER_VEHICLE_PENALTY_LOG`. -/
def interVehiclePenaltyLog : Float := -8.0

/-- `VEHICLE_MODES` — modes in which you are aboard a vehicle. -/
def isVehicleMode : Mode → Bool
  | .driving | .train | .cycling | .plane => true
  | _ => false

/-- `sameState`: identity on the fields the matrix compares. -/
def sameState (a b : State) : Bool :=
  a.mode == b.mode && a.placeId == b.placeId && a.lineName == b.lineName

/-- `transitionWeight`: `exp(-8)` for a direct hop between two distinct vehicle
    modes (no non-vehicle state between), else `1`. -/
def transitionWeight (src dst : State) : Float :=
  if src.mode != dst.mode && isVehicleMode src.mode && isVehicleMode dst.mode then
    Float.exp interVehiclePenaltyLog
  else 1.0

/-- `isHardZero`, base path (no `placeNearLine`): stationary→stationary between
    distinct places is impossible without a moving state between. -/
def isHardZero (src dst : State) : Bool :=
  src.mode == .stationary && dst.mode == .stationary && src.placeId != dst.placeId

/-- Per-`src` cross-weight sum over the state space: total `transitionWeight` of
    the valid (not same, not hard-zero) cross destinations. -/
def crossWeightSum (states : List State) (src : State) : Float :=
  states.foldl
    (fun acc dst => if sameState src dst || isHardZero src dst then acc else acc + transitionWeight src dst)
    0.0

/-- Transition log-probability `src → dst` over `states`, matching
    `buildTransitionMatrix` (default self-loop, no `placeNearLine`). -/
def transitionLogProb (states : List State) (selfLoop : Float) (src dst : State) : Float :=
  if sameState src dst then selfLoop
  else if isHardZero src dst then negInf
  else
    let crossMass := 1.0 - Float.exp selfLoop
    let weightSum := crossWeightSum states src
    if weightSum <= 0.0 then negInf
    else Float.log (crossMass * transitionWeight src dst / weightSum)

/-- `isHardZero` with the station-graph rule: `train @ L ↔ stationary @ P`
    (either way, `L` named) is impossible when `placeNear P L` is false, the
    served `${placeId}|${lineName}` membership. Without the relation it is
    `isHardZeroP (fun _ _ => true)`. -/
def isHardZeroP (placeNear : Int → String → Bool) (src dst : State) : Bool :=
  isHardZero src dst
  || (match src.mode, dst.mode, src.lineName, dst.placeId with
      | .train, .stationary, some line, some pid => !Verified.Hsmm.Emissions.isPlaceholderLine line && !placeNear pid line
      | _, _, _, _ => false)
  || (match src.mode, dst.mode, src.placeId, dst.lineName with
      | .stationary, .train, some pid, some line => !Verified.Hsmm.Emissions.isPlaceholderLine line && !placeNear pid line
      | _, _, _, _ => false)

/-- `crossWeightSum` under the station-graph hard-zero. -/
def crossWeightSumP (placeNear : Int → String → Bool) (states : List State) (src : State)
    (weight : State → State → Float := transitionWeight) : Float :=
  states.foldl
    (fun acc dst => if sameState src dst || isHardZeroP placeNear src dst then acc else acc + weight src dst)
    0.0

/-- Transition log-probability under the station-graph hard zero
    (`buildTransitionMatrix` with `placeNearLine`). -/
def transitionLogProbP (placeNear : Int → String → Bool) (states : List State) (selfLoop : Float)
    (src dst : State) (weight : State → State → Float := transitionWeight) : Float :=
  if sameState src dst then selfLoop
  else if isHardZeroP placeNear src dst then negInf
  else
    let crossMass := 1.0 - Float.exp selfLoop
    let weightSum := crossWeightSumP placeNear states src weight
    if weightSum <= 0.0 then negInf
    else Float.log (crossMass * weight src dst / weightSum)

/-- A fitted mode-to-mode matrix as a transition weight: `P(dst's mode | src's
    mode)` split evenly over the `count src m` states of that mode `src` may
    reach, so a row normalises to the matrix. An unnamed pair weighs `0`. -/
private def NO_WEIGHT : Float := 0

def fittedWeight (matrix : Mode → Mode → Option Float) (count : State → Mode → Nat)
    (src dst : State) : Float :=
  match matrix src.mode dst.mode with
  | some p =>
    let n := count src dst.mode
    if n == 0 then NO_WEIGHT else p / Verified.FloatConst.natToFloat n
  | none => NO_WEIGHT

/-- `transitionLogProbP` with the per-`src` cross-weight sum precomputed, so the
    whole matrix is O(S²), not O(S³). Identical values, pinned below. -/
def transitionLogProbPre (placeNear : Int → String → Bool) (selfLoop weightSum : Float)
    (src dst : State) (weight : State → State → Float := transitionWeight) : Float :=
  if sameState src dst then selfLoop
  else if isHardZeroP placeNear src dst then negInf
  else if weightSum <= 0.0 then negInf
  else Float.log ((1.0 - Float.exp selfLoop) * weight src dst / weightSum)

-- `buildTransitionMatrix`'s reference values (base path).
-- State space: 0 stat@5, 1 stat@7, 2 walk, 3 train@Central, 4 driving.
private def S (m : Mode) (pid : Option Int) (ln : Option String) : State := ⟨m, pid, ln⟩
private def space : List State :=
  [S .stationary (some 5) none, S .stationary (some 7) none, S .walking none none,
   S .train none (some "Central"), S .driving none none]
private def tp (src dst : State) : Float := transitionLogProb space defaultSelfLoop src dst

#guard tp space[0]! space[0]! == -0.05129329438755058   -- self-loop = log(0.95)
#guard tp space[0]! space[1]! == negInf                  -- stat@5 → stat@7 hard-zero
#guard tp space[0]! space[2]! == -4.0943445622220995     -- stat@5 → walk
#guard tp space[3]! space[4]! == -12.09445637684658      -- train → driving (inter-vehicle)
#guard tp space[2]! space[0]! == -4.38202663467388       -- walk → stat@5
#guard tp space[3]! space[2]! == -4.094456376846579      -- train → walk
#guard tp space[4]! space[3]! == -12.09445637684658      -- driving → train (inter-vehicle)

-- Station-graph hard-zero (`placeNearLine`). `allNear` reproduces the base path;
-- `noneNear` hard-zeroes every place↔train transition.
private def allNear : Int → String → Bool := fun _ _ => true
private def noneNear : Int → String → Bool := fun _ _ => false
#guard transitionLogProbP allNear space defaultSelfLoop space[0]! space[3]! == tp space[0]! space[3]!  -- allNear ⇒ base
#guard isHardZeroP noneNear space[0]! space[3]! == true                 -- stat@5 → train@Central: no membership
#guard isHardZeroP noneNear space[3]! space[0]! == true                 -- train@Central → stat@5 (symmetric)
#guard transitionLogProbP noneNear space defaultSelfLoop space[0]! space[3]! == negInf
#guard isHardZeroP noneNear space[0]! space[2]! == false                -- stat@5 → walk unaffected

-- Precomputed-weight-sum matches the full recompute (base matrix build).
#guard transitionLogProbPre allNear defaultSelfLoop (crossWeightSumP allNear space space[0]!) space[0]! space[2]!
  == transitionLogProbP allNear space defaultSelfLoop space[0]! space[2]!
#guard transitionLogProbPre noneNear defaultSelfLoop (crossWeightSumP noneNear space space[0]!) space[0]! space[3]!
  == transitionLogProbP noneNear space defaultSelfLoop space[0]! space[3]!   -- both negInf
#guard transitionLogProbPre allNear defaultSelfLoop (crossWeightSumP allNear space space[0]!) space[0]! space[0]!
  == defaultSelfLoop                                                          -- self-loop

end Verified.Hsmm.Transitions
