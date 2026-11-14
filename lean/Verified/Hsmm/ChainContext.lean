/-!
# Chain-context penalty kernel

The exit→entry chain factor's penalty: `−z²/2` with σ widened in quadrature by
fix staleness, clamped, plus the place-noise and line-noise wrappers. Only
correctly rounded operations, so bit-exact; ULP wobble enters only through
`haversineMeters` upstream. Routing it over transitions is `RouteModel`'s.
UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.ChainContext

def PLACE_NOISE_M : Float := 300
def LINE_NOISE_M : Float := 800
def SLOP_SPEED_M_PER_MIN : Float := 500
def CLAMP_NATS : Float := -6

/-- `slopZPenalty`: `max(CLAMP, −z²/2)` with σ widened by `SLOP·slopMin` in
    quadrature. Bit-exact (IEEE correctly rounded ops only). -/
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

-- `slopZPenalty`'s reference values, bit-exact.
#guard slopZPenalty 100 300 0 == -0.05555555555555555
#guard slopZPenalty 1000 300 0 == -5.555555555555556
#guard slopZPenalty 5000 300 0 == -6                    -- clamped
#guard slopZPenalty 1000 300 5 == -0.07886435331230286  -- staleness widens σ
#guard slopZPenalty 500 800 0 == -0.1953125
#guard stayPenalty 100 0 == -0.05555555555555555         -- σ = PLACE_NOISE_M
#guard boardingPenalty 500 0 == -0.1953125               -- σ = LINE_NOISE_M

end Verified.Hsmm.ChainContext
