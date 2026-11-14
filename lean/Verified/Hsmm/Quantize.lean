import Verified.Hsmm.FloatScore
/-!
# Quantise

Float scores to the integer trellis: `floor(x · 2²⁰ + 0.5)` (ties up, pinned by
the tie `#guard`s), with `-∞` as `none`, the hard-zero sentinel. Returned as an
integer-valued `Float`. UNPROVEN; bit-exact.
-/

namespace Verified.Hsmm.Quantize

open Verified.Hsmm.FloatScore

/-- `SCALE = 2²⁰`. -/
def SCALE : Float := 1048576
/-- `½`, once: inlined into a caller's loop a literal is converted per call. -/
def HALF : Float := 0.5

/-- `quantize`: `-∞ → none`; otherwise `round(x · SCALE)` as an integer-valued
    `Float`, using `Math.round`'s round-half-toward-+∞ (`floor(y + 0.5)`). -/
@[inline] def quantize (x : Float) : Option Float :=
  if x == negInf then none
  else some (Float.floor (x * SCALE + HALF))

-- `quantize`'s reference values:
#guard quantize (-5.7721301172670145) == some (-6052517)
#guard quantize (-0.05129329438755058) == some (-53785)
#guard quantize (-3.6477794064106472) == some (-3824974)
#guard quantize (1.5 / SCALE) == some 2      -- round(1.5) = 2 (half up)
#guard quantize (2.5 / SCALE) == some 3      -- round(2.5) = 3
#guard quantize (-2.5 / SCALE) == some (-2)  -- round(-2.5) = -2 (toward +∞)
#guard quantize (-0.5 / SCALE) == some 0     -- round(-0.5) = -0 == 0
#guard quantize negInf == none

end Verified.Hsmm.Quantize
