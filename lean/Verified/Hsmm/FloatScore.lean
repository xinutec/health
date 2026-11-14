import Verified.FloatConst
/-!
# Float scoring primitives

The emission, transition and duration log-likelihoods in IEEE `Float`, before
quantising into the trellis's integer scores. UNPROVEN; the `#guard`s pin values
bit for bit (the platform libm decides primitives to the ULP).
-/

namespace Verified.Hsmm.FloatScore

export Verified.FloatConst (negInf)

def LOG_2PI : Float := Float.log (2.0 * 3.141592653589793)

/-- log of the Gaussian pdf at `x` with mean `mu`, std `sigma`. -/
def logNormalPdf (x mu sigma : Float) : Float :=
  if sigma <= 0.0 then negInf
  else
    -0.5 * ((x - mu) / sigma) * ((x - mu) / sigma) - Float.log sigma - 0.5 * LOG_2PI

/-- log Bernoulli: `log p` if `present`, else `log (1 - p)`, with boundary
    handling. -/
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

-- Reference values:
#guard logNormalPdf 1.0 0.0 1.0 == -1.4189385332046727
#guard logNormalPdf 3.5 2.0 0.8 == -2.453607481890463
#guard logBernoulli true 0.7 == -0.35667494393873245
#guard logBernoulli false 0.7 == -1.203972804325936
#guard haversineMeters 51.52 (-0.13) 51.53 (-0.12) == 1309.6002774019325

end Verified.Hsmm.FloatScore
