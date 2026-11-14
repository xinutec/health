/-!
# Collision-free cell keys for the matcher's grids

The matcher's grids key a cell pair `(cy, cx)` as one number,
`(cy + 2^21) · 2^22 + (cx + 2^21)` (`cellKeyN`). That is collision-free while
`|cx| < 2^21` (`cellKeyN_inj`), and `cell_bounds_hold` pins the premise: at the
smallest cell in use (15 m), a whole hemisphere of latitude / the full
longitude range stays under `2^21` cells.
-/

namespace Verified.Geo

/-- The pairing as a `Nat`, coordinates biased non-negative first: a key is
≈ `cy · 2^22`, past the `2^31` where Lean's `Int` becomes a GMP bignum, while
`Nat` stays an unboxed scalar to `2^63`. -/
def cellKeyN (cy cx : Int) : Nat :=
  (cy + 2097152).toNat * 4194304 + (cx + 2097152).toNat

/-- Collision-freedom, over the `2^21` box. (One row
bound suffices: a `cy` below the box saturates to bucket 0, which no in-box
`cy'` can reach.) -/
theorem cellKeyN_inj {cy cx cy' cx' : Int}
    (hx : cx.natAbs < 2097152)
    (hy' : cy'.natAbs < 2097152) (hx' : cx'.natAbs < 2097152)
    (h : cellKeyN cy cx = cellKeyN cy' cx') : cy = cy' ∧ cx = cx' := by
  unfold cellKeyN at h
  omega

/-- The premise holds for the grids in use: at the smallest cell (15 m),
`⌈90° of latitude⌉` and `⌈360° of longitude⌉` (i.e. `|lon| ≤ 180`) fit in
`2^21` cells — `90·111320/15` and `180·111320/15` cell indices. -/
theorem cell_bounds_hold :
    90 * 111320 / 15 < 2097152 ∧ 180 * 111320 / 15 < 2097152 := by
  omega

end Verified.Geo
