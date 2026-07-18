/-!
# `cellKey` collision-freedom — the first V4 comment-proof, made a theorem

`src/geo/map-match-core.ts`'s hot grids key a cell pair `(cy, cx)` as the
single number `cy * 2^22 + cx` (template-string keys were measured GC
churn). The comment argues this is collision-free because `|cx| < 2^21`
holds for every cell size in use. That argument is load-bearing — a
collision would silently merge two far-apart buckets and break the
ring-search exactness guarantee — and lives here as `cellKey_inj`.

The float side: JS computes the key in doubles, and integers of magnitude
`< 2^53` are exactly representable, so the JS arithmetic *is* the integer
arithmetic modelled here — `cellKey_magnitude` bounds the key by
`2^43 + 2^21 ≪ 2^53` under the same cell bounds (the established
integers-exact-in-doubles substrate convention; same reason integer
scores are the V1/V2 substrate).

`cell_bounds_hold` pins the comment's premise itself: at the smallest
cell in use (15 m), a whole hemisphere of latitude / the full longitude
range stays under `2^21` cells.
-/

namespace Verified.Geo

/-- The grid-cell pair key, exactly as the TS computes it. -/
def cellKey (cy cx : Int) : Int := cy * 4194304 + cx

/-- Collision-freedom: within `|cx| < 2^21` the key determines the pair.
(The multiplier is `2^22`, so distinct `cy` are `2^22` apart while the
`cx` contribution spans less than `2^22`.) -/
theorem cellKey_inj {cy cx cy' cx' : Int}
    (hx : cx.natAbs < 2097152) (hx' : cx'.natAbs < 2097152)
    (h : cellKey cy cx = cellKey cy' cx') : cy = cy' ∧ cx = cx' := by
  unfold cellKey at h
  omega

/-- Key magnitude stays far inside the double-exact integer range `2^53`
whenever both coordinates are in the `2^21` box. -/
theorem cellKey_magnitude {cy cx : Int}
    (hy : cy.natAbs < 2097152) (hx : cx.natAbs < 2097152) :
    (cellKey cy cx).natAbs < 9007199254740992 := by
  unfold cellKey
  omega

/-- The premise holds for the grids in use: at the smallest cell (15 m),
`⌈90° of latitude⌉` and `⌈360° of longitude⌉` (i.e. `|lon| ≤ 180`) fit in
`2^21` cells — `90·111320/15` and `180·111320/15` cell indices. -/
theorem cell_bounds_hold :
    90 * 111320 / 15 < 2097152 ∧ 180 * 111320 / 15 < 2097152 := by
  omega

#guard cellKey 5 7 == 5 * 4194304 + 7
#guard cellKey (-3) 2097151 ≠ cellKey (-2) (-2097151)

end Verified.Geo
