/-!
# Float constants and the small JS-shaped helpers, once

`pi`, the two infinities, `Math.floor` into an `Int`, JS `x || 1`, and
`Math.hypot` were restated privately in up to twenty-three modules — the same
doubles and the same bodies every time (both spellings of π round to the same
double). One home, no imports, so any module can open it.
-/

namespace Verified.FloatConst

def pi : Float := 3.141592653589793

/-- IEEE +∞ — `Infinity`; the `?? Infinity` of an absent distance, which loses
every comparison. -/
def posInf : Float := 1.0 / 0.0

/-- IEEE −∞, matching TS `Number.NEGATIVE_INFINITY`. -/
def negInf : Float := (-1.0) / 0.0

/-- `Math.floor` into an `Int`, the JS grid-cell index. -/
def floorInt (x : Float) : Int := (Float.floor x).toInt64.toInt

/-- JS `x || 1`: zero and NaN are falsy. -/
def orOne (x : Float) : Float := if x == 0 || x.isNaN then 1 else x

/-- `Math.hypot(x, y)` as `sqrt (x² + y²)` — within an ULP of the libm hypot
at these magnitudes; the modules that measured this say so in their headers. -/
def hyp (x y : Float) : Float := Float.sqrt (x * x + y * y)

#guard pi == 3.14159265358979323846
#guard posInf > 1e308 && negInf < -1e308 && !(posInf == negInf)
#guard floorInt 2.7 == 2 && floorInt (-2.2) == -3
#guard orOne 0 == 1 && orOne (0.0 / 0.0) == 1 && orOne 3 == 3
#guard hyp 3 4 == 5

end Verified.FloatConst
