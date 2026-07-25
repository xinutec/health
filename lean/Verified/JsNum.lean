/-!
# JS numeric formatting (port of `Number.prototype.toFixed`)

`toFixed` is load-bearing algorithm in this codebase, not presentation. Two OSM
coordinates fuse into ONE graph vertex exactly when their `toFixed(7)` strings
are equal — `map-match-core`'s road graph, `rail-snap`'s rail graph and
`walkable-route`'s `nodeKey` all key vertices that way — so its rounding rule
decides graph connectivity. It also formats the display strings the ports
reproduce verbatim.

ECMA-262 21.1.3.3 step 10 defines the rounding against the double's **exact
binary value**: let `n` be the integer for which `n / 10^f - x` is closest to
zero, and **when two are equally close take the LARGER**. Two consequences a
naive `round(x * 10^f) / 10^f` gets wrong, both pinned by the guards:

* `(1.005).toFixed(2) = "1.00"`, because the double nearest 1.005 lies below it,
  while `(0.45).toFixed(1) = "0.5"` because that one lies above;
* the sign is stripped *before* rounding, so ties go half-up on the MAGNITUDE:
  `(-0.5).toFixed(0) = "-1"`, unlike `Math.round(-0.5)`, which is `-0`.

Doing this exactly needs no decimal library. A finite double is `m · 2^e` for
integers `m, e`, so `|x| · 10^f = m · 10^f · 2^e` is a dyadic rational, and
`n = ⌊N/D + 1/2⌋ = (2N + D) / (2D)` in exact `Nat` arithmetic — which is also
precisely the "ties to the larger" rule, since a tie makes `N/D + 1/2` an
integer. Lean's `Nat` is a bignum, so the whole computation is exact.

Not ported: the `|x| ≥ 10^21` arm, which defers to `ToString(x)` — the
shortest-round-trip printer, a separate algorithm (Ryu/Grisu) with no consumer
here. {@link toFixed} returns `none` there rather than guessing, and every call
site in this codebase (coordinates, distances, durations) is far below it.
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

/-- Split a double into `(sign, m, e)` with `|x| = m · 2^e`. Meaningful only for
    finite `x`; callers check first (`toFixed` handles NaN and ±∞ before
    reaching here). -/
def decompose (x : Float) : Decomposed :=
  let bits := x.toBits.toNat
  let neg := bits >>> 63 == 1
  let expo := (bits >>> 52) &&& 0x7FF
  let frac := bits &&& 0xFFFFFFFFFFFFF
  if expo == 0 then
    -- Subnormal: no implicit leading bit, fixed exponent.
    { neg, m := frac, e := -1074 }
  else
    { neg, m := frac + 0x10000000000000, e := Int.ofNat expo - 1075 }

/--
The integer `n` of ECMA-262 21.1.3.3 step 10 for `|x|`: the integer closest to
`|x| · 10^f`, ties going to the larger. Exact — no floating point is involved
past the decomposition. Meaningful for finite `x` only.
-/
def toFixedN (x : Float) (f : Nat) : Nat :=
  let d := decompose x
  let n := d.m * 10 ^ f
  if d.e ≥ 0 then
    -- `|x| · 10^f` is already an integer; nothing to round.
    n * 2 ^ d.e.toNat
  else
    let den := 2 ^ (-d.e).toNat
    -- ⌊n/den + 1/2⌋. A tie makes the numerator an exact multiple of `2·den`,
    -- and flooring then lands on the LARGER candidate, as the spec requires.
    (2 * n + den) / (2 * den)

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
`x.toFixed(f)`.

`none` is returned only for the one unported arm — a finite `|x| ≥ 10^21`,
where the spec defers to `ToString`. NaN and ±∞ take that same branch in the
spec but have fixed spellings, so they are answered here.
-/
def toFixed (x : Float) (f : Nat) : Option String :=
  if x.isNaN then some "NaN"
  else if x == (1.0 / 0.0) then some "Infinity"
  else if x == (-1.0 / 0.0) then some "-Infinity"
  else if x.abs ≥ toFixedMax then none
  else
    -- `x < 0` is FALSE for `-0`, so `(-0).toFixed(7)` is `"0.0000000"`.
    let sign := if x < 0 then "-" else ""
    some (sign ++ placePoint (toFixedN x f) f)

/-! ## The fusion identity

A graph builder does not need the string — it needs to know when two
coordinates produce the SAME string. That is `(sign, n)`, which is exact for
every finite double including those at or above `10^21`, where only the
*rendering* is unported. Keeping the key separate from the string is what lets
vertex fusion move into Lean without dragging `ToString` along. -/

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

/-- The coordinate-fusion key that the graph builders hash a vertex by — the
    comparable form of `` `${lat.toFixed(7)},${lon.toFixed(7)}` ``.

    The `raw` arm is reachable only for a coordinate at or above `10^21`, where
    the TS key would come from the unported `ToString`. Latitudes and longitudes
    are bounded by ±90 / ±180, so it cannot arise from real data; it gives such
    a point its own vertex rather than guessing at a spelling and fusing two
    points that JS would have kept apart. -/
inductive CoordKey where
  | fused (lat lon : FixedKey)
  | raw (latBits lonBits : UInt64)
  deriving BEq, Hashable, Repr

def coordKey7 (lat lon : Float) : CoordKey :=
  match toFixedKey lat 7, toFixedKey lon 7 with
  | some a, some b => .fused a b
  | _, _ => .raw lat.toBits lon.toBits

/-! ## Guards

Reference values from `lean/experiments/tofixed-refs.mts`, run under the same
V8 the backend runs on. These are EXACT string comparisons — no tolerance —
because the whole point of the port is the rounding decision. -/

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
-- The double nearest 0.45 lies ABOVE it, so this one rounds up where 0.35
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

-- Display precisions used by the ported `reason` / `detail` strings.
#guard chk 1234.56789 1 "1234.6"
#guard chk (-1234.56789) 1 "-1234.6"
#guard chk 1234.56789 2 "1234.57"
#guard chk (-1234.56789) 2 "-1234.57"
#guard chk 1234.56789 3 "1234.568"
#guard chk (-1234.56789) 3 "-1234.568"

-- Large (still integral) and subnormal. The 1e20 case shows the `e ≥ 0` arm,
-- and the second prints the double's EXACT value, not the literal typed.
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
private def pi : Float := 3.14159265358979323846
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
-- which must NOT.
#guard toFixedKey 0 7 == toFixedKey (-0.0) 7
#guard toFixedKey 1e-9 7 != toFixedKey (-1e-9) 7
#guard toFixed 1e-9 7 != toFixed (-1e-9) 7
#guard toFixed (-1e-9) 7 == some "-0.0000000"

end Guards

end Verified.JsNum
