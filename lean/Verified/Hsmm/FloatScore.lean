/-!
# Float scoring primitives (implementation-first port of `src/hmm/emissions.ts`)

The verified trellis (`Score.lean` and below) works over *integer* fixed-point
scores. The TypeScript backend produces those integers by computing emission /
transition / duration log-likelihoods in IEEE `Float` and quantising. This
module begins moving that scoring INTO Lean, so the decoder can eventually build
its own tensors from raw observations instead of receiving a ~48 MB pre-scored
payload (see the "Strategic direction" section of
`docs/proposals/2026-07-verified-core-lean.md`).

Per the owner's implementation-first direction (2026-07-23): this is a direct,
UNPROVEN `Float` port that mirrors `emissions.ts` exactly. Theorems and a
fixed-point representation are a later, separate layer. The `#guard`s below pin
bit-for-bit agreement with the TypeScript values (V8 and Lean share the platform
libm, so the primitives agree to the ULP on these inputs).
-/

namespace Verified.Hsmm.FloatScore

/-- IEEE −∞, matching TS `Number.NEGATIVE_INFINITY`. -/
def negInf : Float := (-1.0) / 0.0

def LOG_2PI : Float := Float.log (2.0 * 3.141592653589793)

/-- log of the Gaussian pdf at `x` with mean `mu`, std `sigma`.
    Mirrors `logNormalPdf` in `src/hmm/emissions.ts`. -/
def logNormalPdf (x mu sigma : Float) : Float :=
  if sigma <= 0.0 then negInf
  else
    -0.5 * ((x - mu) / sigma) * ((x - mu) / sigma) - Float.log sigma - 0.5 * LOG_2PI

/-- log Bernoulli: `log p` if `present`, else `log (1 - p)`, with the same
    boundary handling as TS `logBernoulli`. -/
def logBernoulli (present : Bool) (pPresent : Float) : Float :=
  if pPresent <= 0.0 then (if present then negInf else 0.0)
  else if pPresent >= 1.0 then (if present then 0.0 else negInf)
  else Float.log (if present then pPresent else 1.0 - pPresent)

/-- Great-circle metres between two lat/lon points. Mirrors `haversineMeters`. -/
def haversineMeters (lat1 lon1 lat2 lon2 : Float) : Float :=
  let R := 6371000.0
  let pi := 3.141592653589793
  let dLat := (lat2 - lat1) * pi / 180.0
  let dLon := (lon2 - lon1) * pi / 180.0
  let sLat := Float.sin (dLat / 2.0)
  let sLon := Float.sin (dLon / 2.0)
  let a := sLat * sLat + Float.cos (lat1 * pi / 180.0) * Float.cos (lat2 * pi / 180.0) * sLon * sLon
  R * 2.0 * Float.atan2 (Float.sqrt a) (Float.sqrt (1.0 - a))

-- Parity with `src/hmm/emissions.ts` (reference values computed in Node/V8):
#guard logNormalPdf 1.0 0.0 1.0 == -1.4189385332046727
#guard logNormalPdf 3.5 2.0 0.8 == -2.453607481890463
#guard logBernoulli true 0.7 == -0.35667494393873245
#guard logBernoulli false 0.7 == -1.203972804325936
#guard haversineMeters 51.52 (-0.13) 51.53 (-0.12) == 1309.6002774019325

end Verified.Hsmm.FloatScore
