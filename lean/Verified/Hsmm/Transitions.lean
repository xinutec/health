import Verified.Hsmm.Emissions
/-!
# Transition log-probabilities (implementation-first port of `src/hmm/transitions.ts`)

The row-normalised static-prior transition matrix, in Lean `Float`. For each
`src` state: the self-loop holds `exp(selfLoop)` of the mass; the rest is split
across the valid (non-hard-zero) cross destinations in proportion to
`transitionWeight`. This is the BASE path — the station-graph hard-zero
(`placeNearLine`) needs the place↔line adjacency this pure module doesn't carry,
so it's a follow-on brick, exactly as `buildTransitionMatrix` behaves with no
`placeNearLine` provided.

UNPROVEN, per the implementation-first direction. Arithmetic mirrors
`transitions.ts` exactly — including computing `crossMass = 1 - exp(selfLoop)`
the same way (not the literal `0.05`) — so it's bit-for-bit identical to TS,
pinned by the `#guard`s against `buildTransitionMatrix` values.
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

/-- `transitionWeight`: `exp(-8)` for a direct hop between two DISTINCT vehicle
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

/-- `isHardZero` with the station-graph rule: a `train @ L ↔ stationary @ P`
    transition (either direction, `L` a named line) is impossible when `L` does
    not serve a station near `P` (`placeNear P L` false). `placeNear` is the
    served path's `${placeId}|${lineName}` membership; the base (no-`placeNearLine`)
    path is `isHardZeroP (fun _ _ => true)`. -/
def isHardZeroP (placeNear : Int → String → Bool) (src dst : State) : Bool :=
  isHardZero src dst
  || (match src.mode, dst.mode, src.lineName, dst.placeId with
      | .train, .stationary, some line, some pid => line != "unknown_rail" && !placeNear pid line
      | _, _, _, _ => false)
  || (match src.mode, dst.mode, src.placeId, dst.lineName with
      | .stationary, .train, some pid, some line => line != "unknown_rail" && !placeNear pid line
      | _, _, _, _ => false)

/-- `crossWeightSum` under the station-graph hard-zero. -/
def crossWeightSumP (placeNear : Int → String → Bool) (states : List State) (src : State) : Float :=
  states.foldl
    (fun acc dst => if sameState src dst || isHardZeroP placeNear src dst then acc else acc + transitionWeight src dst)
    0.0

/-- Transition log-probability under the station-graph hard-zero — the served
    `buildTransitionMatrix` with `placeNearLine`. -/
def transitionLogProbP (placeNear : Int → String → Bool) (states : List State) (selfLoop : Float)
    (src dst : State) : Float :=
  if sameState src dst then selfLoop
  else if isHardZeroP placeNear src dst then negInf
  else
    let crossMass := 1.0 - Float.exp selfLoop
    let weightSum := crossWeightSumP placeNear states src
    if weightSum <= 0.0 then negInf
    else Float.log (crossMass * transitionWeight src dst / weightSum)

-- Parity with the real `buildTransitionMatrix` (base path; values from Node/V8).
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

end Verified.Hsmm.Transitions
