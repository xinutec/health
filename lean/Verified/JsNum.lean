import Verified.FloatConst
/-!
# JS numeric formatting

`toFixed` decides graph connectivity: OSM coordinates fuse into one vertex when
their `toFixed(7)` strings are equal (the road, rail and walk graphs). It also
formats display strings.

ECMA-262 21.1.3.3 step 10 rounds the double's exact binary value: `n` is the
integer with `n / 10^f - x` closest to zero, ties to the larger. So
`(1.005).toFixed(2) = "1.00"` but `(0.45).toFixed(1) = "0.5"`, and the sign is
stripped first: `(-0.5).toFixed(0) = "-1"`. A finite double is `m · 2^e`, so
`n = (2N + D) / (2D)` in exact `Nat` arithmetic, which is also the tie rule.

Not implemented: `|x| ≥ 10^21`, which defers to the shortest-round-trip
printer. {@link toFixed} returns `none` there; no caller comes near it.
-/

namespace Verified.JsNum

/-- `10^21` — the threshold above which `toFixed` defers to `ToString`. Exactly
    representable as a double (`10^21 = 2^21 · 5^21`, and `5^21 < 2^53`). -/
def toFixedMax : Float := 1e21

/-- A finite double decomposed so that `|x| = m · 2^e` exactly: the IEEE-754
    sign bit, the significand (with the implicit leading bit restored for
    normals), and the binary exponent. -/
structure Decomposed where
  neg : Bool
  m : Nat
  e : Int
  deriving Repr, BEq

/-- The IEEE-754 fraction mask (2^52 − 1) and implicit bit (2^52), by name:
`@[noinline]` as for `Verified.Geo.COS_K`, since a literal this wide is a GMP
parse per call and `decompose` runs under every walk-graph key. -/
@[noinline] def FRAC_MASK : UInt64 := 0xFFFFFFFFFFFFF
@[noinline] def IMPLICIT_BIT : Nat := 0x10000000000000


/-- Split a double into `(sign, m, e)` with `|x| = m · 2^e`. Meaningful only for
    finite `x`; callers check first (`toFixed` handles NaN and ±∞ before
    reaching here). -/
def decompose (x : Float) : Decomposed :=
  -- `UInt64` until the fields are read out: a negative double's bits are
  -- ≥ 2^63, which as a `Nat` is a GMP bignum for every shift and mask.
  let bits := x.toBits
  let neg := bits >>> 63 == 1
  let expo := ((bits >>> 52) &&& 0x7FF).toNat
  let frac := (bits &&& FRAC_MASK).toNat
  if expo == 0 then
    -- Subnormal: no implicit leading bit, fixed exponent.
    { neg, m := frac, e := -1074 }
  else
    { neg, m := frac + IMPLICIT_BIT, e := Int.ofNat expo - 1075 }

/-! ## `Math.round`

Round half toward +∞ (`floor(y + 0.5)`): `Math.round(-0.5)` is `-0`, unlike
`toFixed`'s ties on the magnitude. The wrong one is off by one on half the ties.
Private copies of this one-liner remain in `Verified/Geo`; new code uses this. -/

/-- `Math.round` — round half toward +∞. -/
def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-- `Math.round` as an `Int`, the form callers building quantised coordinates
want (`Interchange`'s `jsRoundInt`). -/
def jsRoundInt (x : Float) : Int := (jsRound x).toInt64.toInt

-- Ties go up, not away from zero — the whole reason this is not `Float.round`.
#guard jsRound 1.5 == 2
#guard jsRound 2.5 == 3
#guard jsRound (-2.5) == -2
#guard jsRound (-0.5) == 0
#guard jsRoundInt (-2.5) == -2
#guard jsRoundInt 2.5 == 3

/--
The integer `n` of ECMA-262 21.1.3.3 step 10 for `|x|`: closest to `|x| · 10^f`,
ties to the larger. Exact past the decomposition; finite `x` only.
-/
def toFixedNExact (x : Float) (f : Nat) : Nat :=
  let d := decompose x
  let n := d.m * 10 ^ f
  if d.e ≥ 0 then
    -- `|x| · 10^f` is already an integer; nothing to round.
    n * 2 ^ d.e.toNat
  else
    let den := 2 ^ (-d.e).toNat
    -- ⌊n/den + 1/2⌋. A tie makes the numerator an exact multiple of `2·den`,
    -- and flooring then lands on the larger candidate, as the spec requires.
    (2 * n + den) / (2 * den)

/-! ⚠ A float literal inside a branch or loop is not hoisted: it compiles to a
`Float.ofScientific` call per pass, a quarter of `toFixedN`'s time. A
module-level `def` is one cell, filled once. -/
private def TEN_POW_7 : Float := 10000000.0
private def HALF : Float := 0.5
private def TIE_BAND : Float := 1e-6

/-- `toFixedNExact`, with a float fast path for coordinates (`f = 7`,
`|x| < 200`): `y = |x|·10⁷ < 2³¹` is within 2.2·10⁻⁷ of exact and `y + 0.5` is
exact, so away from a tie (fraction more than 10⁻⁶ from ½) `⌊y + 0.5⌋` is the
answer. The big-integer path dominated the walk graph's cost. -/
def toFixedN (x : Float) (f : Nat) : Nat :=
  if f == 7 && x.abs < 200 then
    let y := x.abs * TEN_POW_7
    let r := y - Float.floor y
    if Float.abs (r - HALF) > TIE_BAND then (Float.floor (y + HALF)).toUInt64.toNat
    else toFixedNExact x f
  else toFixedNExact x f

-- The fast path agrees with the exact one: a sweep through London and Paris
-- coordinates in steps that land between and near the 10⁻⁷ grid, both signs,
-- and the near-tie values themselves (k + ½)·10⁻⁷ that the fast path hands back.
private def lcg (s : Nat) : Nat := (s * 6364136223846793005 + 1442695040888963407) % 2 ^ 64
private def sweep (n : Nat) : Bool := Id.run do
  let mut s := 12345
  for i in [0:n] do
    s := lcg s
    let base := if i % 3 == 0 then 51.5 else if i % 3 == 1 then -0.1278 else 48.8566
    let off := (s % 1000000).toFloat * 1.3e-9
    let x := base + off
    if toFixedN x 7 != toFixedNExact x 7 then return false
    if toFixedN (-x) 7 != toFixedNExact (-x) 7 then return false
    let tie := (Float.floor (x * 1e7) + 0.5) / 1e7
    if toFixedN tie 7 != toFixedNExact tie 7 then return false
  return true
#guard sweep 20000
#guard toFixedN 0.00000005 7 == toFixedNExact 0.00000005 7
#guard toFixedN 179.9999999 7 == toFixedNExact 179.9999999 7
#guard toFixedN (-0.0) 7 == 0

/-- Render `n` with a decimal point `f` digits from the right, zero-padding a
    short `n` — steps 11-12 of the spec. -/
private def placePoint (n : Nat) (f : Nat) : String :=
  let m := toString n
  if f == 0 then m
  else
    let k := m.length
    let padded := if k ≤ f then String.ofList (List.replicate (f + 1 - k) '0') ++ m else m
    let k' := if k ≤ f then f + 1 else k
    let cs := padded.toList
    String.ofList (cs.take (k' - f)) ++ "." ++ String.ofList (cs.drop (k' - f))

/--
`x.toFixed(f)`. `none` only for a finite `|x| ≥ 10^21`; NaN and ±∞ have fixed
spellings and are answered.
-/
def toFixed (x : Float) (f : Nat) : Option String :=
  if x.isNaN then some "NaN"
  else if x == (1.0 / 0.0) then some "Infinity"
  else if x == (-1.0 / 0.0) then some "-Infinity"
  else if x.abs ≥ toFixedMax then none
  else
    -- `x < 0` is false for `-0`, so `(-0).toFixed(7)` is `"0.0000000"`.
    let sign := if x < 0 then "-" else ""
    some (sign ++ placePoint (toFixedN x f) f)

/-! ## The fusion identity

A graph builder needs only when two coordinates produce the same string:
`(sign, n)`, exact for every finite double, including those whose rendering is
unported. -/

/-- What `toFixed` distinguishes: a rounded magnitude with its sign, or one of
    the fixed non-finite spellings. -/
inductive FixedKey where
  /-- `sign` is the spec's step 8 test, which is `false` for `-0`. -/
  | num (neg : Bool) (n : Nat)
  | nonFinite (s : String)
  deriving BEq, Hashable, Repr

/--
The identity `toFixed f` imposes: `toFixedKey a f == toFixedKey b f` exactly
when `a.toFixed(f) == b.toFixed(f)`, for every pair below `10^21`. `none` marks
the unported rendering arm, matching {@link toFixed}.
-/
def toFixedKey (x : Float) (f : Nat) : Option FixedKey :=
  if x.isNaN then some (.nonFinite "NaN")
  else if x == (1.0 / 0.0) then some (.nonFinite "Infinity")
  else if x == (-1.0 / 0.0) then some (.nonFinite "-Infinity")
  else if x.abs ≥ toFixedMax then none
  else some (.num (x < 0) (toFixedN x f))

/-- The coordinate-fusion key graph builders hash a vertex by, the comparable
    form of `` `${lat.toFixed(7)},${lon.toFixed(7)}` ``. The `raw` arm (≥ 10^21,
    impossible for a coordinate) gives such a point its own vertex. -/
inductive CoordKey where
  | fused (lat lon : FixedKey)
  | raw (latBits lonBits : UInt64)
  deriving BEq, Hashable, Repr

def coordKey7 (lat lon : Float) : CoordKey :=
  match toFixedKey lat 7, toFixedKey lon 7 with
  | some a, some b => .fused a b
  | _, _ => .raw lat.toBits lon.toBits

/-! ## Guards

Reference values are `Number.prototype.toFixed`'s, compared as exact strings. -/

section Guards

private def chk (x : Float) (f : Nat) (expect : String) : Bool := toFixed x f == some expect

-- Ties round half-up on the magnitude (the sign is stripped first).
#guard chk 0.5 0 "1"
#guard chk 1.5 0 "2"
#guard chk 2.5 0 "3"
#guard chk 3.5 0 "4"
#guard chk (-0.5) 0 "-1"
#guard chk (-1.5) 0 "-2"
#guard chk (-2.5) 0 "-3"
-- 0.25, 0.75, 0.125, 0.375 are exact in binary, so ×10^f lands exactly on a tie.
#guard chk 0.25 1 "0.3"
#guard chk 0.75 1 "0.8"
#guard chk 0.125 2 "0.13"
#guard chk 0.375 2 "0.38"

-- The exact binary value decides, not the decimal literal that was typed.
#guard chk 1.005 2 "1.00"
#guard chk 1.015 2 "1.01"
#guard chk 1.025 2 "1.02"
#guard chk 8.575 2 "8.57"
#guard chk 0.35 1 "0.3"
-- The double nearest 0.45 lies above it, so this one rounds up where 0.35
-- rounds down — the pair that refutes any "ties always go down" reading.
#guard chk 0.45 1 "0.5"
#guard chk 2.675 2 "2.67"
#guard chk 0.05 1 "0.1"

-- Padding, the f = 0 path, and signed zero.
#guard chk 0.5 7 "0.5000000"
#guard chk 0.000001 7 "0.0000010"
#guard chk 1e-8 7 "0.0000000"
#guard chk 0 7 "0.0000000"
#guard chk (-0.0) 7 "0.0000000"
#guard chk 123.456 0 "123"
#guard chk 5e-7 6 "0.000000"
#guard chk 9.9999999 7 "9.9999999"
#guard chk 9.99999995 7 "9.9999999"

-- Negatives and carries across the point.
#guard chk (-51.52) 7 "-51.5200000"
#guard chk (-0.13) 7 "-0.1300000"
#guard chk 99.99999999 7 "100.0000000"
#guard chk (-99.99999999) 7 "-100.0000000"
#guard chk 0.9999999999 7 "1.0000000"

-- Display precisions used by the `reason` / `detail` strings.
#guard chk 1234.56789 1 "1234.6"
#guard chk (-1234.56789) 1 "-1234.6"
#guard chk 1234.56789 2 "1234.57"
#guard chk (-1234.56789) 2 "-1234.57"
#guard chk 1234.56789 3 "1234.568"
#guard chk (-1234.56789) 3 "-1234.568"

-- Large (still integral) and subnormal. The 1e20 case shows the `e ≥ 0` arm,
-- and the second prints the double's exact value, not the literal typed.
#guard chk 1e20 7 "100000000000000000000.0000000"
#guard chk 123456789012345680000 2 "123456789012345683968.00"
#guard chk 5e-324 7 "0.0000000"
#guard chk 5e-324 20 "0.00000000000000000000"

-- The non-finite spellings, and the one unported arm.
#guard chk (1.0 / 0.0) 2 "Infinity"
#guard chk (-1.0 / 0.0) 2 "-Infinity"
#guard chk (0.0 / 0.0) 2 "NaN"
#guard (toFixed 1e21 2).isNone
#guard (toFixedKey 1e21 7).isNone

-- Coordinate keys, in the frame the geometry harnesses use.
private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
open Verified.FloatConst (pi)
private def mlat : Float := 1 / 111320.0
private def mlon : Float := 1 / (111320.0 * Float.cos (lat0 * pi / 180))
private def kLat (n : Float) : Option String := toFixed (lat0 + n * mlat) 7
private def kLon (e : Float) : Option String := toFixed (lon0 + e * mlon) 7

#guard kLat 0 == some "51.5200000" && kLon 0 == some "-0.1300000"
#guard kLon 250 == some "-0.1263908"
#guard kLat 300 == some "51.5226949" && kLon 1000 == some "-0.1155633"
#guard kLat 150 == some "51.5213475" && kLon 500 == some "-0.1227817"
#guard kLon 1010 == some "-0.1154189"

-- The fusion decision itself: ~0.1 mm apart collapses to one vertex, ~2 cm
-- apart does not. This is what `toFixed(7)` is doing in the graph builders.
#guard toFixed lat0 7 == toFixed (lat0 + 1e-9) 7
#guard toFixed lat0 7 != toFixed (lat0 + 2e-7) 7
#guard coordKey7 lat0 lon0 == coordKey7 (lat0 + 1e-9) lon0
#guard coordKey7 lat0 lon0 != coordKey7 (lat0 + 2e-7) lon0

-- `toFixedKey` agrees with the string it stands in for — including the two
-- zeroes, which share a key, and a positive/negative pair rounding to zero,
-- which must not.
#guard toFixedKey 0 7 == toFixedKey (-0.0) 7
#guard toFixedKey 1e-9 7 != toFixedKey (-1e-9) 7
#guard toFixed 1e-9 7 != toFixed (-1e-9) 7
#guard toFixed (-1e-9) 7 == some "-0.0000000"

end Guards

end Verified.JsNum
