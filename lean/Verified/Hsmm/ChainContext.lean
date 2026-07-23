/-!
# Chain-context penalty kernel (implementation-first port of `chain-context.ts`)

The staleness-widened geometric penalty at the heart of the exit→entry chain
factor (and shared in shape with `segment-evidence`): `−z²/2` with σ widened in
quadrature by fix staleness, clamped. This kernel uses only `sqrt`/`*`/`/`/`-`
(all IEEE correctly-rounded), so it is genuinely BIT-EXACT across V8 and Lean —
the ≤1-ULP wobble only enters upstream where `haversineMeters` supplies `distM`.

Ported here: the kernel + the place-noise / line-noise wrappers. The decision
routing (which penalty applies for a given from→to transition, and the
route-graph distances it feeds in) is a thin follow-on that composes these over
caller-resolved distances. UNPROVEN; bit-exact, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.ChainContext

def PLACE_NOISE_M : Float := 300
def LINE_NOISE_M : Float := 800
def SLOP_SPEED_M_PER_MIN : Float := 500
def CLAMP_NATS : Float := -6

/-- `slopZPenalty`: `max(CLAMP, −z²/2)` with σ widened by `SLOP·slopMin` in
    quadrature. Bit-exact with TS (IEEE-correctly-rounded ops only). -/
def slopZPenalty (distM sigmaM slopMin : Float) : Float :=
  let sl := SLOP_SPEED_M_PER_MIN * slopMin
  let sigma := Float.sqrt (sigmaM * sigmaM + sl * sl)
  let z := distM / sigma
  let v := -0.5 * z * z
  if v < CLAMP_NATS then CLAMP_NATS else v

/-- Entering/leaving a known place: penalty on the exit fix ↔ place distance. -/
def stayPenalty (distM slopMin : Float) : Float := slopZPenalty distM PLACE_NOISE_M slopMin

/-- Boarding feasibility: penalty on the exit anchor ↔ line-track distance. -/
def boardingPenalty (distM slopMin : Float) : Float := slopZPenalty distM LINE_NOISE_M slopMin

-- Parity with the TS `slopZPenalty` (values from Node/V8); bit-exact.
#guard slopZPenalty 100 300 0 == -0.05555555555555555
#guard slopZPenalty 1000 300 0 == -5.555555555555556
#guard slopZPenalty 5000 300 0 == -6                    -- clamped
#guard slopZPenalty 1000 300 5 == -0.07886435331230286  -- staleness widens σ
#guard slopZPenalty 500 800 0 == -0.1953125
#guard stayPenalty 100 0 == -0.05555555555555555         -- σ = PLACE_NOISE_M
#guard boardingPenalty 500 0 == -0.1953125               -- σ = LINE_NOISE_M

end Verified.Hsmm.ChainContext
