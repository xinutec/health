import Verified.Geo.Simplify
import Verified.Geo.Splice
import Verified.Geo.Prefilter
import Verified.Geo.Clean
import Verified.Geo.Trim

/-!
# The pinned integer metric — V4's arithmetic substrate

The corpus-probed representation (`lean/experiments/quant-probe.mjs`,
173 walking legs / 31 golden days — see the proposal doc):

- coordinates as **1e-7° integers** (OSM-native, ~11 mm; one unit of
  latitude is exactly 11 132 µm, so the degree→metre factor is an
  integer multiply with no division);
- distances in **µm** via `isqrt` (Newton floor square root, mirroring
  the twin's BigInt loop) of the exact squared sum;
- equirectangular projection with a **Q20 fixed-point degree-6 minimax
  cos** evaluated by integer Horner — no float transcendental anywhere;
- the foot of the chord projection rounded half-away-from-zero
  (`roundDiv`), the clamp exact.

Probe verdict vs the float pipeline: max |Δdist| 38 mm, mean 0.24 mm,
zero keep-set flips on simplify-5 m / the 12 km/h speed hold / spike
rejection, and one near-threshold tie in 173 legs on the display-only
1.5 m detail tolerance.

Division semantics are part of the contract with the TS BigInt twin:
`Int.fdiv` (floor) mirrors BigInt `>>`, `Int.tdiv` (truncation toward
zero) mirrors BigInt `/` — every division below is one of the two,
chosen to match the twin expression by expression. The `#guard` vectors
at the bottom were computed by the twin arithmetic in node and pin the
two sides together until the `compare-geometry` harness lands.

This file also instantiates the metric-parametric pass layer
(`Simplify`/`Splice`/`Prefilter`) with the pinned metric, so the pass
theorems specialise for free: `qSimplify_dropped_le`,
`qSplice_sound`/`qSplice_coarse_sublist`, `qHoldSpeed_chain`.
-/

namespace Verified.Geo

/-- A quantised point: latitude/longitude in 1e-7° units, timestamp in
epoch seconds. -/
structure QPt where
  la : Int
  lo : Int
  ts : Int
  deriving BEq, Repr, Inhabited

/-- Newton's descent for the floor square root, as the twin's BigInt loop
(`while (y < x) { x = y; y = (x + n/x)/2 }`). The iterate strictly decreases,
and the fixed point of the loop is `⌊√n⌋` from any start `x₀ ≥ √n`. -/
def isqrtGo (n x y : Nat) : Nat :=
  if _h : y < x then isqrtGo n y ((y + n / y) / 2) else x
termination_by x

/-- Integer floor square root — the same value as the twin, reached in far fewer
steps. The twin seeds the descent at `x₀ = n`, which costs one halving per bit of
`n`: for the ~10¹⁴ operands here (µm², squared), ~24 big divisions per call, and
`qDist` is called several times per graph edge. Seeding instead at the next power
of two above `√n` — `2^⌈bits(n)/2⌉`, so `x₀² ≥ 2^bits(n) > n` — puts the start
within a factor of √2 and Newton then doubles the correct digits each step, ~4
iterations. The precondition for the descent is exactly `x₀ ≥ √n`, and
`isqrt_isSqrt` discharges it for this seed, so the fixed point — and hence the
value — is the twin's. -/
def isqrt (n : Nat) : Nat :=
  if n < 2 then n
  else
    let s := 1 <<< ((n.log2 + 2) / 2)
    isqrtGo n s ((s + n / s) / 2)

/-! ### `isqrt` is the floor square root

The seed change above is a claim about a numeric algorithm, not a rearrangement
of one expression into another, so the twin comparison cannot check it: both
sides would have to be wrong in the same way to agree, and they are different
programs. It is discharged here instead. Everything the matcher measures —
`qDist`, `qDistA`, `qChordDist` — bottoms out in `isqrt`, so this is the
foundation the rest of the geometry stands on. -/

/-- `r` is the integer floor square root of `n`: the largest `r` with `r² ≤ n`.
Stated as a two-sided bracket rather than as a maximum so that both halves are
directly usable — the lower half bounds distances from below (the matcher's
rejects), the upper half from above. -/
def IsSqrt (n r : Nat) : Prop := r * r ≤ n ∧ n < (r + 1) * (r + 1)

/-- The bracket pins a unique value, so "the" floor square root is well defined
and any two routes to it agree. -/
theorem IsSqrt.unique {n r r' : Nat} (h : IsSqrt n r) (h' : IsSqrt n r') : r = r' := by
  rcases Nat.lt_trichotomy r r' with hlt | heq | hgt
  · exact absurd (Nat.le_trans (Nat.mul_le_mul hlt hlt) h'.1) (Nat.not_le.mpr h.2)
  · exact heq
  · exact absurd (Nat.le_trans (Nat.mul_le_mul hgt hgt) h.1) (Nat.not_le.mpr h'.2)

/-- AM–GM over `Nat`: a product is at most the square of the mean. This is what
makes Newton's step land above the root — `x` and `n/x` bracket `√n`, so their
mean cannot fall below it. -/
theorem mul_le_sq_of_add_eq {a b r : Nat} (h : a + b = 2 * r) : a * b ≤ r * r := by
  rcases Nat.le_total a r with hr | hr
  · obtain ⟨d, hd⟩ : ∃ d, r = a + d := ⟨r - a, by omega⟩
    have hb : b = a + d + d := by omega
    subst hb; subst hd
    have h1 : a * (a + d + d) = a * a + a * d + a * d := by
      rw [Nat.mul_add, Nat.mul_add]
    have h2 : (a + d) * (a + d) = a * a + d * a + (a * d + d * d) := by
      rw [Nat.add_mul, Nat.mul_add, Nat.mul_add]; omega
    have h3 : a * d = d * a := Nat.mul_comm a d
    omega
  · obtain ⟨d, hd⟩ : ∃ d, r = b + d := ⟨r - b, by omega⟩
    have ha : a = b + d + d := by omega
    subst ha; subst hd
    have h1 : (b + d + d) * b = b * b + d * b + d * b := by
      rw [Nat.add_mul, Nat.add_mul]
    have h2 : (b + d) * (b + d) = b * b + d * b + (b * d + d * d) := by
      rw [Nat.add_mul, Nat.mul_add, Nat.mul_add]; omega
    have h3 : b * d = d * b := Nat.mul_comm b d
    omega

/-- **The descent never overshoots.** A Newton step from any positive `x` stays
at or above every `r` with `r² ≤ n` — in particular above the root itself. This
is the loop invariant: it is what stops the iterate from sliding past `⌊√n⌋` and
converging to something smaller. -/
theorem le_newtonStep {n x r : Nat} (hx : 0 < x) (hr : r * r ≤ n) :
    r ≤ (x + n / x) / 2 := by
  rcases Nat.le_total (2 * r) x with h | h
  · have h2 : x / 2 ≤ (x + n / x) / 2 := Nat.div_le_div_right (Nat.le_add_right _ _)
    omega
  · have hk : (2 * r - x) * x ≤ n :=
      Nat.le_trans (mul_le_sq_of_add_eq (by omega)) hr
    have := (Nat.le_div_iff_mul_le hx).mpr hk
    omega

/-- **The descent makes progress.** Strictly above the root, a Newton step
strictly decreases — so the loop cannot stall before reaching it. -/
theorem newtonStep_lt {n x : Nat} (h : n < x * x) : (x + n / x) / 2 < x := by
  have : n / x < x := Nat.div_lt_of_lt_mul h
  omega

/-- The loop returns `⌊√n⌋` from any start at or above it. `hge` is the seed
precondition, stated as "no `r` with `r² ≤ n` exceeds `x`"; the two Newton
lemmas above carry it through each step, and the exit test `¬ y < x` is exactly
what forces `x² ≤ n` at the end. -/
theorem isqrtGo_spec (n x : Nat) (hn : 0 < n) (hx : 0 < x)
    (hge : ∀ r, r * r ≤ n → r ≤ x) :
    IsSqrt n (isqrtGo n x ((x + n / x) / 2)) := by
  unfold isqrtGo
  split
  · next hlt =>
    have hge' : ∀ r, r * r ≤ n → r ≤ (x + n / x) / 2 := fun r hr => le_newtonStep hx hr
    have hy : 0 < (x + n / x) / 2 := hge' 1 (by omega)
    exact isqrtGo_spec n _ hn hy hge'
  · next hnl =>
    refine ⟨?_, ?_⟩
    · exact Nat.not_lt.mp fun hlt => hnl (newtonStep_lt hlt)
    · exact Nat.not_le.mp fun hle => absurd (hge (x + 1) hle) (by omega)
termination_by x

/-- **`isqrt n = ⌊√n⌋.`** The seed `2^⌈bits(n)/2⌉` is above the root — that is
the `n ≤ s·s` step, and it is the whole content of the optimisation — so the
descent's precondition holds and the loop lands on the floor square root. -/
theorem isqrt_isSqrt (n : Nat) : IsSqrt n (isqrt n) := by
  unfold isqrt
  split
  · next h =>
    have : n = 0 ∨ n = 1 := by omega
    rcases this with rfl | rfl
    · exact ⟨by omega, by omega⟩
    · exact ⟨by omega, by omega⟩
  · next h =>
    have hn : 0 < n := by omega
    have hs : 1 <<< ((n.log2 + 2) / 2) = 2 ^ ((n.log2 + 2) / 2) := by
      rw [Nat.shiftLeft_eq]; omega
    -- `n < 2^(log2 n + 1) ≤ 2^k · 2^k`, since `2·⌊(log2 n + 2)/2⌋ ≥ log2 n + 1`
    -- whether `log2 n` is even or odd — the ceiling in `⌈bits/2⌉`.
    have hsq : n ≤ 2 ^ ((n.log2 + 2) / 2) * 2 ^ ((n.log2 + 2) / 2) := by
      have h1 : n < 2 ^ (n.log2 + 1) := Nat.lt_log2_self
      have h2 : 2 ^ (n.log2 + 1)
          ≤ 2 ^ ((n.log2 + 2) / 2) * 2 ^ ((n.log2 + 2) / 2) := by
        rw [← Nat.pow_add]
        exact Nat.pow_le_pow_right (by omega) (by omega)
      omega
    simp only [hs]
    refine isqrtGo_spec n _ hn Nat.one_le_two_pow ?_
    intro r hr
    refine Nat.not_lt.mp fun hgt => ?_
    have hgt' : 2 ^ ((n.log2 + 2) / 2) + 1 ≤ r := hgt
    have hle := Nat.mul_le_mul hgt' hgt'
    have e : (2 ^ ((n.log2 + 2) / 2) + 1) * (2 ^ ((n.log2 + 2) / 2) + 1)
        = 2 ^ ((n.log2 + 2) / 2) * 2 ^ ((n.log2 + 2) / 2)
          + 2 ^ ((n.log2 + 2) / 2) + 2 ^ ((n.log2 + 2) / 2) + 1 := by
      rw [Nat.add_mul, Nat.mul_add, Nat.mul_add]; omega
    have hpos : 1 ≤ 2 ^ ((n.log2 + 2) / 2) := Nat.one_le_two_pow
    omega

/-- The form the distance rejects need: a squared bound transfers through
`isqrt` without a square root ever being taken exactly. -/
theorem le_isqrt {k n : Nat} (h : k * k ≤ n) : k ≤ isqrt n :=
  Nat.not_lt.mp fun hgt =>
    absurd (Nat.le_trans (Nat.mul_le_mul hgt hgt) h) (Nat.not_le.mpr (isqrt_isSqrt n).2)

theorem isqrt_le {k n : Nat} (h : n < (k + 1) * (k + 1)) : isqrt n ≤ k :=
  Nat.not_lt.mp fun hgt =>
    absurd (Nat.le_trans (Nat.mul_le_mul hgt hgt) (isqrt_isSqrt n).1) (Nat.not_le.mpr h)

/-- `isqrt` is monotone — a bigger squared sum is a bigger distance. -/
theorem isqrt_le_isqrt {m n : Nat} (h : m ≤ n) : isqrt m ≤ isqrt n :=
  le_isqrt (Nat.le_trans (isqrt_isSqrt m).1 h)

/-- The one wide multiply inside `cosQ`: `|la| · 19190098069` reaches ≈ 2⁶³
(for a real latitude `|la| ≤ 9·10⁸`), which tips `Nat` off its unboxed range
and onto a GMP bignum on every call — the dominant matcher hotspot. Done in
`UInt64` it is exact (the product `≤ 9·10⁸ · 19190098069 ≈ 1.73·10¹⁹ < 2⁶⁴`)
and allocation-free; past that bound it falls back to `Nat` so the value is
unconditionally the same (`cosMul_eq`). -/
@[inline] def cosMul (la : Int) : Nat :=
  if la.natAbs ≤ 900000000 then
    (la.natAbs.toUInt64 * 19190098069 / 10485760000000).toNat
  else la.natAbs * 19190098069 / 10485760000000

theorem cosMul_eq (la : Int) : cosMul la = la.natAbs * 19190098069 / 10485760000000 := by
  unfold cosMul
  split
  · next h =>
    have hn : la.natAbs < 18446744073709551616 := by omega
    have hmul : la.natAbs * 19190098069 < 18446744073709551616 :=
      Nat.lt_of_le_of_lt (Nat.mul_le_mul_right _ h) (by omega)
    rw [UInt64.toNat_div, UInt64.toNat_mul,
      show (la.natAbs.toUInt64).toNat = la.natAbs by
        rw [UInt64.toNat_ofNat']; exact Nat.mod_eq_of_lt hn,
      show (19190098069 : UInt64).toNat = 19190098069 from rfl,
      show (10485760000000 : UInt64).toNat = 10485760000000 from rfl,
      Nat.mod_eq_of_lt hmul]
  · rfl

/-- `⌊m/d⌋` on a non-negative numerator is just `Nat` division. -/
theorem fdiv_natCast (m d : Nat) : ((m : Int)).fdiv (d : Int) = ((m / d : Nat) : Int) := by
  cases m with
  | zero => simp
  | succ m' => rfl

/-- `⌊−m/d⌋ = −⌈m/d⌉`, with the ceiling written the usual `(m + d − 1)/d` way.
This is the identity that lets a signed `fdiv` be carried as a `Nat` magnitude
plus a sign — the rewrite the matcher's hot path depends on. -/
theorem fdiv_neg_natCast (m d : Nat) (hd : 0 < d) :
    (-(m : Int)).fdiv (d : Int) = -(((m + d - 1) / d : Nat) : Int) := by
  obtain ⟨d', rfl⟩ : ∃ d', d = d' + 1 := ⟨d - 1, by omega⟩
  cases m with
  | zero =>
    have h0 : (0 + (d' + 1) - 1) / (d' + 1) = 0 := by
      rw [show 0 + (d' + 1) - 1 = d' by omega]
      exact Nat.div_eq_of_lt (by omega)
    rw [h0]
    rfl
  | succ m' =>
    -- `-(ofNat (m'+1))` is `negSucc m'` definitionally, and `fdiv` on that pair
    -- is `-[m' / (d'+1) + 1]` — the ceiling, already.
    show Int.fdiv (Int.negSucc m') (Int.ofNat (d' + 1)) = _
    rw [show m' + 1 + (d' + 1) - 1 = m' + (d' + 1) by omega,
      Nat.add_div_right m' (by omega : 0 < d' + 1)]
    rfl

/-- `fdiv_neg_natCast` with the `d − 1` supplied as its own literal, so a call
site can state the ceiling as e.g. `(m + 1048575) / 1048576` and still unify. -/
theorem fdiv_neg_natCast' (m d e : Nat) (hd : 0 < d) (he : e + 1 = d) :
    (-(m : Int)).fdiv (d : Int) = -(((m + e) / d : Nat) : Int) := by
  rw [fdiv_neg_natCast m d hd, show m + d - 1 = m + e by omega]

/-- Q20 fixed-point cosine of a 1e-7°-unit latitude, by integer Horner
over a degree-6 minimax polynomial (|poly err| ≈ 1e-7; the Q20 width,
not the polynomial, is the binding precision). Constants:
`19190098069 = round(π/180 · 2^40)`, coefficients `round(cᵢ · 2^20)` of
the Hastings minimax for `cos` on `[0, π/2]`;
`10485760000000 = 1e7 · 2^20`. The wide first multiply is `cosMul`. -/
def cosQ (la : Int) : Int :=
  let x : Nat := cosMul la
  let x2 : Nat := x * x / 1048576
  if x2 ≤ 4000000 then
    -- Every Horner product here lands between 2^31 and 2^41, and Lean's `Int`
    -- is a GMP bignum past 2^31 (`LEAN_MAX_SMALL_INT = INT_MAX`) while `Nat`
    -- stays an unboxed scalar to 2^63 — so the same three multiplies cost three
    -- heap allocations as `Int` and none as `Nat`. The signs are static, so they
    -- can be carried in the shape instead of the values: `fdiv` by a positive
    -- divisor is `⌊·⌋` on a non-negative numerator and `−⌈·⌉` on a negative one,
    -- which is what the ceilings below spell out. Both subtractions stay in
    -- `Nat`: over `x2 ≤ 4·10^6`, `⌈1453·x2/2^20⌉ ≤ 5544 < 43687` and
    -- `⌊s1·x2/2^20⌋ ≤ 166 653 < 524 287`. The final value may still be slightly
    -- negative (the minimax polynomial undershoots at 90°), so it is an `Int`.
    let s1 : Nat := 43687 - (1453 * x2 + 1048575) / 1048576
    let s2 : Nat := 524287 - s1 * x2 / 1048576
    (1048576 : Int) - (((s2 * x2 + 1048575) / 1048576 : Nat) : Int)
  else
    let s1 : Int := (-1453 * (x2 : Int)).fdiv 1048576 + 43687
    let s2 : Int := (s1 * (x2 : Int)).fdiv 1048576 + -524287
    (s2 * (x2 : Int)).fdiv 1048576 + 1048576

/-- The reference Horner, exactly as the BigInt twin writes it: signed `Int`
throughout, no case split. `cosQ` runs the `Nat`-magnitude form instead, for
speed; `cosQ_eq` proves the two agree at every latitude. -/
def cosQSpec (la : Int) : Int :=
  let x2 : Nat := cosMul la * cosMul la / 1048576
  let s1 : Int := (-1453 * (x2 : Int)).fdiv 1048576 + 43687
  let s2 : Int := (s1 * (x2 : Int)).fdiv 1048576 + -524287
  (s2 * (x2 : Int)).fdiv 1048576 + 1048576

/-- **`cosQ` computes the reference Horner.** The fast branch replaces three
signed `fdiv`s by `Nat` divisions with the signs moved into the term's shape;
this discharges that rewrite, including the two `Nat` subtractions, which
truncate at zero rather than going negative and so would silently return a
different cosine if the `x2 ≤ 4·10^6` guard did not bound them. Neither branch
is assumed: the guard is what makes the bounds hold, and it is discharged here
rather than argued in a comment. -/
theorem cosQ_eq (la : Int) : cosQ la = cosQSpec la := by
  unfold cosQ cosQSpec
  simp only []
  generalize cosMul la * cosMul la / 1048576 = x2
  split
  · next hbnd =>
    -- Step 1. `(-1453·x2).fdiv 2^20 = -⌈1453·x2/2^20⌉`, and the ceiling is at
    -- most 5544, so `43687 - ⌈·⌉` does not truncate.
    have hc1 : (1453 * x2 + 1048575) / 1048576 ≤ 5544 :=
      Nat.div_le_of_le_mul (by
        have h : 1453 * x2 ≤ 1453 * 4000000 := Nat.mul_le_mul_left 1453 hbnd
        omega)
    have h1 : (-1453 * (x2 : Int)).fdiv 1048576
        = -(((1453 * x2 + 1048575) / 1048576 : Nat) : Int) := by
      rw [show (-1453 * (x2 : Int)) = -((1453 * x2 : Nat) : Int) by
        rw [Int.natCast_mul]; rfl]
      exact fdiv_neg_natCast' (1453 * x2) 1048576 1048575 (by omega) (by omega)
    have hb1 : (1453 * x2 + 1048575) / 1048576 ≤ 43687 := by omega
    have hs1 : (-1453 * (x2 : Int)).fdiv 1048576 + 43687
        = ((43687 - (1453 * x2 + 1048575) / 1048576 : Nat) : Int) := by
      rw [h1, Int.natCast_sub hb1]; omega
    rw [hs1]
    -- Step 2. `s1 ≥ 0`, so its `fdiv` is plain `Nat` division; bound it so
    -- `524287 - ⌊·⌋` does not truncate either.
    generalize hs1d : 43687 - (1453 * x2 + 1048575) / 1048576 = s1
    have hs1le : s1 ≤ 43687 := by omega
    have hc2 : s1 * x2 / 1048576 ≤ 166653 :=
      Nat.div_le_of_le_mul (Nat.le_trans (Nat.mul_le_mul hs1le hbnd) (by omega))
    have h2 : ((s1 : Int) * (x2 : Int)).fdiv 1048576 = ((s1 * x2 / 1048576 : Nat) : Int) := by
      rw [← Int.natCast_mul]; exact fdiv_natCast _ _
    have hb2 : s1 * x2 / 1048576 ≤ 524287 := by omega
    have hs2 : ((s1 : Int) * (x2 : Int)).fdiv 1048576 + -524287
        = -((524287 - s1 * x2 / 1048576 : Nat) : Int) := by
      rw [h2, Int.natCast_sub hb2]; omega
    rw [hs2]
    -- Step 3. Negative again, so `fdiv` is the ceiling once more.
    generalize 524287 - s1 * x2 / 1048576 = s2
    rw [show (-((s2 : Nat) : Int)) * (x2 : Int) = -((s2 * x2 : Nat) : Int) by
      rw [Int.natCast_mul]; exact Int.neg_mul _ _]
    have h3 : (-((s2 * x2 : Nat) : Int)).fdiv 1048576
        = -(((s2 * x2 + 1048575) / 1048576 : Nat) : Int) :=
      fdiv_neg_natCast' (s2 * x2) 1048576 1048575 (by omega) (by omega)
    rw [h3]
    omega
  · rfl

/-- µm between two points, cos at the mid-latitude — mirrors
`metersBetween` (`map-match-core.ts`). One latitude unit = 11 132 µm
exactly. -/
def qDist (a b : QPt) : Nat :=
  -- Carried as `Nat` magnitudes, not `Int`: the intermediates here reach ≈2⁴⁸
  -- (`Δlo·11132·c`) and ≈2⁵⁶ (the squares), which is inside `Nat`'s unboxed
  -- range but *not* `Int`'s — as `Int` every one of these allocated a GMP
  -- bignum, the matcher's dominant cost. Only the squares are used, so the sign
  -- drops out; `fdiv`'s magnitude is the floor when the product is ≥ 0 and the
  -- ceiling when it is negative, which is what `dloAbs` reproduces exactly.
  let dlaAbs : Nat := (b.la - a.la).natAbs * 11132
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let yAbs : Nat := (b.lo - a.lo).natAbs * 11132 * c.natAbs
  let negY : Bool := decide ((b.lo - a.lo) < 0) != decide (c < 0)
  let dloAbs : Nat := if negY then (yAbs + 1048575) / 1048576 else yAbs / 1048576
  isqrt (dlaAbs * dlaAbs + dloAbs * dloAbs)

/-- µm between two points, cos at the first point — mirrors
`equirectMeters` (`episode-geometry.ts`'s variant). -/
def qDistA (a b : QPt) : Nat :=
  let dla : Int := (b.la - a.la) * 11132
  let c : Int := cosQ a.la
  let dlo : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  isqrt (dla * dla + dlo * dlo).toNat

/-- `round(p/q)` half-away-from-zero for `q > 0` — the twin's
`roundDiv`. -/
def roundDiv (p q : Int) : Int :=
  if p ≥ 0 then (p + q.tdiv 2).tdiv q
  else -((-p + q.tdiv 2).tdiv q)

/-- µm from `p` to the segment `a`–`b` — mirrors `segmentDistM`:
project onto the chord in the local equirectangular frame (cos at the
chord's mid-latitude), clamp to `[0, len²]`, round the foot back to
coordinate units, and measure `qDist` to it. -/
def qChordDist (p a b : QPt) : Nat :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (p.la - a.la) * 11132
  let len2 : Int := bx * bx + vy * vy
  if len2 = 0 then qDist p a
  else
    let dot : Int := max 0 (min (px * bx + py * vy) len2)
    qDist p
      { la := a.la + roundDiv (dot * (b.la - a.la)) len2
        lo := a.lo + roundDiv (dot * (b.lo - a.lo)) len2
        ts := 0 }

/-- µm from `p` to the infinite line `a`–`b` — mirrors `perpDistM`
(`|cross| / len` with the chord-frame degenerate fallback; both the
cross and the length live in the chord's equirectangular frame). -/
def qPerp (p a b : QPt) : Nat :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (p.la - a.la) * 11132
  if bx * bx + vy * vy = 0 then isqrt (px * px + py * py).toNat
  else (px * vy - py * bx).natAbs / isqrt (bx * bx + vy * vy).toNat

/-- The TS ≥140° turn test (`acos(dot/(|u|·|v|)) ≥ 140`) as an exact
squared comparison: `dot ≤ 0 ∧ dot²·10⁹ ≥ round(cos²140°·10⁹)·|u|²·|v|²`
(`586824089 = round(cos²140° · 10⁹)`). Vectors in the TS frame — Δlon
scaled by the apex-latitude cos (Q20), Δlat by `2^20` to match.
Degenerate legs keep the vertex, like the TS `1e-12` guard. -/
def qTurnOk (a c b : QPt) : Bool :=
  let cl : Int := cosQ c.la
  let ux : Int := (c.lo - a.lo) * cl
  let uy : Int := (c.la - a.la) * 1048576
  let vx : Int := (b.lo - c.lo) * cl
  let vy : Int := (b.la - c.la) * 1048576
  let un2 : Int := ux * ux + uy * uy
  let vn2 : Int := vx * vx + vy * vy
  if un2 = 0 || vn2 = 0 then false
  else
    let dot : Int := ux * vx + uy * vy
    dot ≤ 0 && dot * dot * 1000000000 ≥ 586824089 * un2 * vn2

/-- The corridor-position arc interpolation — mirrors
`fArc[i] + proj.t · (fArc[i+1] − fArc[i])` with the clamped rational
`t = dot/len²` applied by rounded division. -/
def qArcPos (v a b : QPt) (arcA arcB : Int) : Int :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((v.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (v.la - a.la) * 11132
  let len2 : Int := bx * bx + vy * vy
  if len2 = 0 then arcA
  else arcA + roundDiv (max 0 (min (px * bx + py * vy) len2) * (arcB - arcA)) len2

-- ---------------------------------------------------------------
-- Pass instantiations: the metric-parametric layer over this metric.
-- ---------------------------------------------------------------

/-- `simplifyPath` over the pinned metric (tolerance in µm). -/
def qSimplify (pts : Nat → QPt) (n tol : Nat) : List Nat :=
  simplifyIdx qChordDist pts n tol

/-- The TS `1e-9`-degree coordinate match is exact equality at 1e-7°
resolution. -/
def qSame (a b : QPt) : Bool := a.la == b.la && a.lo == b.lo

/-- The TS `< 0.5 m` dedupe check: 500 000 µm. -/
def qNear (a b : QPt) : Bool := qDist a b < 500000

/-- The TS timestamp clamp `min(max(ts, a.ts), b.ts)`. -/
def qClampTs (a b v : QPt) : QPt := { v with ts := min (max v.ts a.ts) b.ts }

/-- `spliceRouteDetail` over the pinned metric (tolerances in µm). -/
def qSplice (route : Nat → QPt) (m : Nat) (tol dropUm : Nat)
    (coarse : Nat → QPt) (n : Nat) : List QPt :=
  splice qChordDist qSame qNear qClampTs route m tol dropUm coarse n

/-- Speed plausibility at `cap` km/h, as the exact cross-multiplied
integer form of `(d/dt)·3.6 ≤ cap`: `dt > 0 ∧ 36·d_µm ≤ cap·dt·10⁷`
(`qDistA`, because the TS predicate uses `equirectMeters`). -/
def qSpeedOk (cap : Nat) (a b : QPt) : Bool :=
  b.ts - a.ts > 0 && 36 * (qDistA a b : Int) ≤ (cap : Int) * (b.ts - a.ts) * 10000000

/-- `holdImplausibleSpeed` over the pinned metric. -/
def qHoldSpeed (cap : Nat) (fixes : Nat → QPt) (n : Nat) : List QPt :=
  holdSpeed (qSpeedOk cap) fixes n

/-- The TS spike test: `through > 3·direct ∧ through − direct > 500 m`
(5·10⁸ µm; `Nat` truncation on the difference agrees with the TS since
the first conjunct forces `through > direct`). -/
def qSpike (prev cur next : QPt) : Bool :=
  let direct := qDistA prev next
  let through := qDistA prev cur + qDistA cur next
  through > 3 * direct && through - direct > 500000000

/-- `rejectSpikes` over the pinned metric. -/
def qRejectSpikes (pts : Nat → QPt) (n : Nat) : List QPt :=
  rejectSpikes qSpike pts n

/-- `dedupeConsecutive` over the pinned metric (strict `< 0.5 m`). -/
def qDedupe (pts : Nat → QPt) (n : Nat) : List QPt :=
  dedupe (fun a b => qDist a b < 500000) pts n

/-- `removeSpurs` over the pinned metric (thresholds in µm / steps). -/
def qRemoveSpurs (retUm maxSpan : Nat) (l : List QPt) : List QPt :=
  spurGo qDist retUm maxSpan l

/-- `despikeUnsupportedApexes` over the pinned metric (µm thresholds;
the 140° turn is baked into `qTurnOk`). -/
def qDespike (minApexUm excessUm : Nat) (raw : List QPt) (path : Nat → QPt)
    (n : Nat) : List QPt :=
  despike qPerp qTurnOk (·.ts) minApexUm excessUm raw path n

/-- The TS `trimOverRouteExcursions` default thresholds, in µm. -/
def qTrimP : TrimP :=
  { offM := 30000000, detourNum := 1, detourDen := 2, minStall := 80000000
    returnNum := 7, returnDen := 20, stallNum := 3, stallDen := 20
    slack := 1000000 }

/-- The trim rebuild's `> 0.5 m` push guard (`≤` skip semantics). -/
def qNearLe (a b : QPt) : Bool := qDist a b ≤ 500000

/-- `trimOverRouteExcursions` over the pinned metric. -/
def qTrim (fx : Nat → QPt) (nf : Nat) (path : Nat → QPt) (n : Nat) :
    List QPt :=
  trim qTrimP qDist qChordDist qArcPos qNearLe fx nf path n

-- ---------------------------------------------------------------
-- The pass theorems, specialised for free.
-- ---------------------------------------------------------------

/-- The Douglas-Peucker guarantee over the pinned metric: every dropped
vertex lies within `tol` µm of the retained chord spanning it. -/
theorem qSimplify_dropped_le (pts : Nat → QPt) {n tol j : Nat} (hj : j < n)
    (hdrop : j ∉ qSimplify pts n tol) :
    ∃ p ∈ adjPairs (qSimplify pts n tol),
      p.1 < j ∧ j < p.2 ∧ qChordDist (pts j) (pts p.1) (pts p.2) ≤ tol :=
  simplifyIdx_dropped_le qChordDist pts hj hdrop

/-- Splice soundness over the pinned metric. -/
theorem qSplice_sound (route : Nat → QPt) (m : Nat) (tol dropUm : Nat)
    (coarse : Nat → QPt) (n : Nat) :
    ∀ v ∈ qSplice route m tol dropUm coarse n,
      (∃ i, i < n ∧ v = coarse i) ∨
      ∃ i j, 1 ≤ i ∧ i < n ∧ j < m ∧
        v = qClampTs (coarse (i - 1)) (coarse i) (route j) ∧
        qChordDist (route j) (coarse (i - 1)) (coarse i) ≤ dropUm :=
  splice_sound qChordDist qSame qNear qClampTs route m tol dropUm coarse n

/-- The coarse line survives splicing, in order. -/
theorem qSplice_coarse_sublist (route : Nat → QPt) (m : Nat)
    (tol dropUm : Nat) (coarse : Nat → QPt) (n : Nat) :
    ((List.range n).map coarse).Sublist (qSplice route m tol dropUm coarse n) :=
  splice_coarse_sublist qChordDist qSame qNear qClampTs route m tol dropUm
    coarse n

/-- The kinematic honesty invariant over the pinned metric: no adjacent
pair of the held output exceeds `cap` km/h in the exact integer sense. -/
theorem qHoldSpeed_chain (cap : Nat) (fixes : Nat → QPt) (n : Nat) :
    ∀ p ∈ adjPairs (qHoldSpeed cap fixes n), qSpeedOk cap p.1 p.2 = true :=
  holdSpeed_chain (qSpeedOk cap) fixes n

/-- The held output is a subsequence of the input. -/
theorem qHoldSpeed_sublist (cap : Nat) (fixes : Nat → QPt) (n : Nat) :
    (qHoldSpeed cap fixes n).Sublist ((List.range n).map fixes) :=
  holdSpeed_sublist (qSpeedOk cap) fixes n

/-- No adjacent deduped pair is within 0.5 m. -/
theorem qDedupe_chain (pts : Nat → QPt) (n : Nat) :
    ∀ p ∈ adjPairs (qDedupe pts n), (qDist p.1 p.2 < 500000 : Bool) = false :=
  dedupe_chain _ pts n

/-- The cleaning passes are drop-only over the pinned metric. -/
theorem qDedupe_sublist (pts : Nat → QPt) (n : Nat) :
    (qDedupe pts n).Sublist ((List.range n).map pts) :=
  dedupe_sublist _ pts n

theorem qRemoveSpurs_sublist (retUm maxSpan : Nat) (l : List QPt) :
    (qRemoveSpurs retUm maxSpan l).Sublist l :=
  spurGo_sublist qDist retUm maxSpan l

theorem qDespike_sublist (minApexUm excessUm : Nat) (raw : List QPt)
    (path : Nat → QPt) (n : Nat) :
    (qDespike minApexUm excessUm raw path n).Sublist
      ((List.range n).map path) :=
  despike_sublist qPerp qTurnOk (·.ts) minApexUm excessUm raw path n

theorem qTrim_sublist (fx : Nat → QPt) (nf : Nat) (path : Nat → QPt)
    (n : Nat) :
    (qTrim fx nf path n).Sublist ((List.range n).map path) :=
  trim_sublist qTrimP qDist qChordDist qArcPos qNearLe fx nf path n

-- ---------------------------------------------------------------
-- Cross-language pin: values computed by the BigInt twin arithmetic
-- (node; see the module docstring). London test points.
-- ---------------------------------------------------------------

#guard cosQ 515074000 == 652636
#guard cosQ (-515074000) == 652636
#guard cosQ 0 == 1048576
#guard cosQ 600000000 == 524251

private def qTestA : QPt := ⟨515074000, -1278000, 0⟩
private def qTestB : QPt := ⟨515150000, -1300000, 60⟩
private def qTestP : QPt := ⟨515120000, -1400000, 30⟩

#guard qDist qTestA qTestB == 859651577
#guard qDistA qTestA qTestB == 859653814
#guard qChordDist qTestP qTestA qTestB == 741016794
#guard qChordDist qTestP qTestA qTestA == 988259894

-- A straight three-point line simplifies to its endpoints; a genuinely
-- bent one keeps its apex (5 m tolerance, i.e. 5·10⁶ µm).
private def qLine (i : Nat) : QPt :=
  match i with
  | 0 => ⟨515074000, -1278000, 0⟩
  | 1 => ⟨515074500, -1278000, 10⟩
  | _ => ⟨515075000, -1278000, 20⟩

private def qBent (i : Nat) : QPt :=
  match i with
  | 0 => ⟨515074000, -1278000, 0⟩
  | 1 => ⟨515074500, -1279500, 10⟩
  | _ => ⟨515075000, -1278000, 20⟩

#guard qSimplify qLine 3 5000000 == [0, 2]
#guard qSimplify qBent 3 5000000 == [0, 1, 2]

end Verified.Geo
