import Verified.Hsmm.FloatScore
/-!
# Quantise (implementation-first port of `quantize` in `lean-shadow-core.ts`)

The bridge from the float scoring to the integer trellis: `round(x · 2²⁰)`, with
`-∞` mapped to the `null`/`none` sentinel the packed decoder reads as a hard
zero. `Math.round` is round-half-toward-+∞, i.e. `floor(y + 0.5)` — pinned by the
tie `#guard`s below. Scores here are far below `2⁵²`, so `floor(y+0.5)` and
`Math.round(y)` never diverge.

The value is returned as an integer-valued `Float` (`none` for `-∞`); packing it
into the trellis's `Nat`/`Int` representation is a mechanical follow-on. UNPROVEN,
per the implementation-first direction; bit-exact with the TS `quantize`.
-/

namespace Verified.Hsmm.Quantize

open Verified.Hsmm.FloatScore

/-- `SCALE = 2²⁰`. -/
def SCALE : Float := 1048576

/-- `quantize`: `-∞ → none`; otherwise `round(x · SCALE)` as an integer-valued
    `Float`, using `Math.round`'s round-half-toward-+∞ (`floor(y + 0.5)`). -/
def quantize (x : Float) : Option Float :=
  if x == negInf then none
  else some (Float.floor (x * SCALE + 0.5))

-- Parity with the TS `quantize` (values from Node/V8):
#guard quantize (-5.7721301172670145) == some (-6052517)
#guard quantize (-0.05129329438755058) == some (-53785)
#guard quantize (-3.6477794064106472) == some (-3824974)
#guard quantize (1.5 / SCALE) == some 2      -- round(1.5) = 2 (half up)
#guard quantize (2.5 / SCALE) == some 3      -- round(2.5) = 3
#guard quantize (-2.5 / SCALE) == some (-2)  -- round(-2.5) = -2 (toward +∞)
#guard quantize (-0.5 / SCALE) == some 0     -- round(-0.5) = -0 == 0
#guard quantize negInf == none

end Verified.Hsmm.Quantize
