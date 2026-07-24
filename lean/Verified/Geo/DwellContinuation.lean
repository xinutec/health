/-!
# Dwell-prior continuation kernels (port of the pure exports of `src/geo/dwell-continuation.ts`)

When the phone goes quiet at a strong focus_place with no closing bracket,
silence is evidence the user is still there. Model P(still here | Δ) as an
exponential survival curve in elapsed time, with mean dwell τ = totalDwell /
visits; continue the stay while P ≥ a floor. `applyDwellContinuation` (the
DayState/segment orchestration) stays shell; ported here:

* `meanDwellSec` — τ, or `none` when the stats can't support one (exact).
* `dwellSurvival` — `exp(-max(0,Δ)/τ)` (≤1 ULP).
* `dwellContinuation` — how far to carry the stay: to where P hits the floor
  (`Δ = τ·ln(1/floor)`, `Math.round`ed), clamped to the day end; `none` when
  weakly established / unusable / no trailing room.

UNPROVEN; pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.DwellContinuation

def MIN_ESTABLISH_DAYS : Int := 5
def CONFIDENCE_FLOOR : Float := 0.5

structure DwellPlace where
  totalDwellSec : Float
  visitCount : Int
  uniqueDays : Int
  deriving Inhabited

/-- Mean visit length τ (seconds), or `none` when the stats can't support one. -/
def meanDwellSec (p : DwellPlace) : Option Float :=
  if decide (p.visitCount ≤ 0) || decide (p.totalDwellSec ≤ 0) then none
  else some (p.totalDwellSec / Float.ofInt p.visitCount)

/-- P(still here) after `elapsedSec` at a place with mean dwell `tauSec`. -/
def dwellSurvival (elapsedSec tauSec : Float) : Float :=
  if decide (tauSec ≤ 0) then 0 else Float.exp ((- max 0 elapsedSec) / tauSec)

/-- How far to continue a stay forward: to where P hits `floor`, clamped to the
    day end. `(endTs, tauSec)`, or `none` when weakly established / unusable /
    no trailing room. -/
def dwellContinuation (place : DwellPlace) (lastEndTs dayEndTs : Int) (floor : Float := 0.5) :
    Option (Int × Float) :=
  if decide (place.uniqueDays < MIN_ESTABLISH_DAYS) then none
  else if decide (lastEndTs ≥ dayEndTs) then none
  else match meanDwellSec place with
    | none => none
    | some tau =>
      let horizonSec := tau * Float.log (1 / floor)
      let roundH := (Float.floor (horizonSec + 0.5)).toInt64.toInt
      let endTs := min dayEndTs (lastEndTs + roundH)
      if decide (endTs ≤ lastEndTs) then none else some (endTs, tau)

/-! ## Parity with Node/V8 (`lean/experiments/dwell-refs.mts`) -/

private def approxD (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard meanDwellSec ⟨72000, 24, 30⟩ == some 3000
#guard meanDwellSec ⟨72000, 0, 30⟩ == none
#guard meanDwellSec ⟨0, 24, 30⟩ == none

#guard approxD (dwellSurvival 1800 3600) 0.6065306597126334
#guard dwellSurvival 0 3600 == 1
#guard dwellSurvival 3600 0 == 0
#guard dwellSurvival (-500) 3600 == 1

private def home : DwellPlace := ⟨1080000, 30, 30⟩   -- τ = 36000
private def cafe : DwellPlace := ⟨108000, 30, 10⟩     -- τ = 3600
#guard match dwellContinuation home 1000 100000 with | some (e, t) => e == 25953 && approxD t 36000 | none => false
#guard match dwellContinuation home 1000 10000 with | some (e, _) => e == 10000 | none => false
#guard dwellContinuation ⟨1080000, 30, 3⟩ 1000 100000 == none
#guard dwellContinuation home 100000 100000 == none
#guard dwellContinuation ⟨0, 30, 30⟩ 1000 100000 == none
#guard match dwellContinuation cafe 1000 100000 0.8 with | some (e, _) => e == 1803 | none => false

end Verified.Geo.DwellContinuation
