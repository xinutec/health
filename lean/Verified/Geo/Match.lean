import Std.Data.HashMap
import Verified.Geo.Metric
import Verified.Geo.CellKey
import Verified.Geo.LazyFuel
import Verified.Geo.LazyResume
import Verified.Geo.LazyPrev
import Verified.Geo.LazyEdge
import Verified.Geo.LazyWeight
import Verified.Geo.MatchViterbi

/-!
# Matcher core

The pinned integer semantics of the walk map-matcher over the `Metric.lean`
substrate. Divisions are `Int.tdiv` or `Int.fdiv` as the arithmetic requires;
midpoints are `tdiv` since longitudes can be negative.

- Part 1, primitives: `qProject` (foot, exact fraction `tn/td`, distance),
  `QCorridor` (the GPS-corridor penalty), `QBuildings` (the footprint penalty).
- Part 2, graph and routing: `buildQGraph`, `qCandidatesForFixFast`,
  `qRouteBetween` over the `LazyDijkstra` cache.
- Part 3, Viterbi and the walk pipeline: `qMatchTrajectory`, `qMatchWalkSegment`.

## What is proved

- Honesty (`qMatchWalkSegment_{coarse_drop_only, path_sound}`): `coarsePath` is
  a subsequence of the trajectory path, and every drawn vertex is a coarse
  vertex or a route vertex within the splice `dropM` of its chord.
- Route purity (`qRouteBetween_route_pure`): the route is the same from any
  valid cache, so the trellis's edge weights depend on the graph, not on fill
  order (`settleTo_reads_eq`, `comboFold_best_indep`).
- Viterbi argmax (`MatchViterbi`): `qMatchTrajectory` runs the verified
  `decodeFast` (`decodeFast = decode`), so its chain attains the maximum
  `pathScore` (`decode_argmax`, `decode_none_iff`).

A theorem is stated only when proved.
-/

namespace Verified.Geo

/-! ## `qProject` and polyline length -/

/-- The clamped foot on the 1e-7° grid, the fraction as the exact
rational `tn/td`, and `qDist` to the foot — `qChordDist`'s body, foot
kept. -/
structure QProj where
  la : Int
  lo : Int
  tn : Int
  td : Int
  dist : Nat
  deriving Repr

def qProject (p a b : QPt) : QProj :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (p.la - a.la) * 11132
  let len2 : Int := bx * bx + vy * vy
  if len2 = 0 then { la := a.la, lo := a.lo, tn := 0, td := 1, dist := qDist p a }
  else
    let dot : Int := max 0 (min (px * bx + py * vy) len2)
    let la : Int := a.la + roundDiv (dot * (b.la - a.la)) len2
    let lo : Int := a.lo + roundDiv (dot * (b.lo - a.lo)) len2
    { la, lo, tn := dot, td := len2, dist := qDist p { la, lo, ts := 0 } }

/-- Polyline length in µm (`qPathLength`). -/
def qPathLength (pts : Array QPt) : Nat := Id.run do
  let mut total : Nat := 0
  for i in [1:pts.size] do
    total := total + qDist (pts.getD (i - 1) default) (pts.getD i default)
  return total

/-- Lower bound (µm) of any distance from `p` to the chord `a`–`b` by
latitude separation alone — exact-conservative (`qDist ≥ |Δla|·11132`,
and the clamped foot's latitude lies between the endpoints'). -/
def latGapUm (p a b : QPt) : Nat :=
  let lo : Int := if a.la < b.la then a.la else b.la
  let hi : Int := if a.la < b.la then b.la else a.la
  -- `.toNat` before the scale, not after: the µm product runs to ~10^13 and
  -- Lean's `Int` is a GMP bignum past 2^31, while `Nat` is a scalar to 2^63.
  if p.la < lo then (lo - p.la).toNat * 11132
  else if p.la > hi then (p.la - hi).toNat * 11132
  else 0

/-! ## `QCorridor` — the GPS-corridor penalty -/

/-- One corridor chord `fixes[i-1] → fixes[i]` with its projection frame solved
once: `c` is `cosQ` at the mid-latitude, `bx`/`vy` the chord vector in µm,
`len2` its squared length. `loLa`…`hiLo` is the endpoint box dilated by one
unit, since the rounded foot can sit half a unit outside the raw box.

`len2` is a `Nat` (`bx`/`vy` are µm, so it reaches ~10^13) and the chord deltas
are carried pre-split into magnitude and sign, because the projection multiplies
them: as `Int` every one of those products would be a GMP bignum. -/
structure QChord where
  a : QPt
  b : QPt
  c : Int
  bx : Int
  vy : Int
  len2 : Nat
  dLaAbs : Nat
  dLaNeg : Bool
  dLoAbs : Nat
  dLoNeg : Bool
  loLa : Int
  hiLa : Int
  loLo : Int
  hiLo : Int
  deriving Inhabited

/-- A chord's cached fields agree with its endpoints: the contract the box
argument needs, which `mkQCorridor` fills in and the type cannot enforce. -/
structure QChord.WF (ch : QChord) : Prop where
  dLaAbs : ch.dLaAbs = (ch.b.la - ch.a.la).natAbs
  dLaNeg : ch.dLaNeg = decide (ch.b.la < ch.a.la)
  dLoAbs : ch.dLoAbs = (ch.b.lo - ch.a.lo).natAbs
  dLoNeg : ch.dLoNeg = decide (ch.b.lo < ch.a.lo)
  loLa : ch.loLa = min ch.a.la ch.b.la - 1
  hiLa : ch.hiLa = max ch.a.la ch.b.la + 1
  loLo : ch.loLo = min ch.a.lo ch.b.lo - 1
  hiLo : ch.hiLo = max ch.a.lo ch.b.lo + 1

/-- The projection parameter `max 0 (min (px·bx + py·vy) len2)`, carried as
`Nat` magnitudes with the sign in the case split: `px·bx` reaches ~10¹⁴, past
where `Int` becomes a GMP bignum. Two negative products clamp to zero; opposite
signs subtract the smaller from the larger. -/
@[inline] def qDot (px py : Int) (ch : QChord) : Nat :=
  let m1 : Nat := px.natAbs * ch.bx.natAbs
  let n1 : Bool := decide (px < 0) != decide (ch.bx < 0)
  let m2 : Nat := py.natAbs * ch.vy.natAbs
  let n2 : Bool := decide (py < 0) != decide (ch.vy < 0)
  if n1 == n2 then (if n1 then 0 else min (m1 + m2) ch.len2)
  else if n1 then (if m2 ≥ m1 then min (m2 - m1) ch.len2 else 0)
  else (if m1 ≥ m2 then min (m1 - m2) ch.len2 else 0)

/-- The clamp holds. Every branch is either `0` or a `min` against `len²`,
so the parameter never leaves `[0, len²]` — which is what keeps the foot on the
chord instead of running off its extension. -/
theorem qDot_le (px py : Int) (ch : QChord) : qDot px py ch ≤ ch.len2 := by
  unfold qDot
  simp only []
  split
  · split
    · exact Nat.zero_le _
    · exact Nat.min_le_right _ _
  · split <;> split
    · exact Nat.min_le_right _ _
    · exact Nat.zero_le _
    · exact Nat.min_le_right _ _
    · exact Nat.zero_le _

/-- The foot of the projection at parameter `dot`: the spec's two `roundDiv`s.
With `dot ≥ 0` and `len² > 0`, half-away-from-zero is `⌊(dot·|Δ| + ⌊len²/2⌋)/len²⌋`,
negated exactly when `Δ` is. -/
@[inline] def QChord.foot (ch : QChord) (dot : Nat) : QPt :=
  let half : Nat := ch.len2 / 2
  let sLa : Nat := (dot * ch.dLaAbs + half) / ch.len2
  let sLo : Nat := (dot * ch.dLoAbs + half) / ch.len2
  { la := ch.a.la + (if ch.dLaNeg then -(sLa : Int) else (sLa : Int))
    lo := ch.a.lo + (if ch.dLoNeg then -(sLo : Int) else (sLo : Int)), ts := 0 }

/-- Rounding a fraction of `Δ` cannot overshoot `Δ`: with `0 ≤ dot ≤ len²`, the
rounded step lands in `[0, |Δ|]`. The `+ ⌊len²/2⌋` is what makes this tight —
it is still strictly under `len²·(|Δ|+1)`. -/
theorem roundedStep_le {dot dAbs len2 : Nat} (hlen : 0 < len2) (hdot : dot ≤ len2) :
    (dot * dAbs + len2 / 2) / len2 ≤ dAbs := by
  have h1 : dot * dAbs ≤ len2 * dAbs := Nat.mul_le_mul hdot (Nat.le_refl _)
  have hlt : dot * dAbs + len2 / 2 < len2 * (dAbs + 1) := by
    rw [Nat.mul_add]; omega
  exact Nat.le_of_lt_succ (Nat.div_lt_of_lt_mul hlt)

/-- One axis of the foot lies between the two endpoints (and so inside the
stored box, which is dilated by a further unit). -/
theorem foot_axis_mem {a b : Int} {s : Nat} {neg : Bool} (hneg : neg = decide (b < a))
    (h : s ≤ (b - a).natAbs) :
    min a b - 1 ≤ a + (if neg then -(s : Int) else (s : Int))
    ∧ a + (if neg then -(s : Int) else (s : Int)) ≤ max a b + 1 := by
  cases neg with
  | false =>
    have hb : ¬ (b < a) := by simp at hneg; omega
    rw [show (if (false : Bool) then -(s : Int) else (s : Int)) = (s : Int) from rfl]
    exact ⟨by omega, by omega⟩
  | true =>
    have hb : b < a := by simp at hneg; omega
    rw [show (if (true : Bool) then -(s : Int) else (s : Int)) = -(s : Int) from rfl]
    exact ⟨by omega, by omega⟩

/-- The foot never leaves the chord's box: the premise `boxRejects_sound`
needs. The one-unit dilation is slack, not necessity. -/
theorem foot_mem_box {ch : QChord} (wf : ch.WF) {dot : Nat}
    (hlen : 0 < ch.len2) (hdot : dot ≤ ch.len2) :
    ch.loLa ≤ (ch.foot dot).la ∧ (ch.foot dot).la ≤ ch.hiLa ∧
    ch.loLo ≤ (ch.foot dot).lo ∧ (ch.foot dot).lo ≤ ch.hiLo := by
  have h1 : (dot * ch.dLaAbs + ch.len2 / 2) / ch.len2 ≤ (ch.b.la - ch.a.la).natAbs := by
    rw [← wf.dLaAbs]; exact roundedStep_le hlen hdot
  have h2 : (dot * ch.dLoAbs + ch.len2 / 2) / ch.len2 ≤ (ch.b.lo - ch.a.lo).natAbs := by
    rw [← wf.dLoAbs]; exact roundedStep_le hlen hdot
  have ka := foot_axis_mem wf.dLaNeg h1
  have ko := foot_axis_mem wf.dLoNeg h2
  simp only [QChord.foot, wf.loLa, wf.hiLa, wf.loLo, wf.hiLo]
  exact ⟨ka.1, ka.2, ko.1, ko.2⟩

/-- Gap from `x` to `[lo, hi]` in µm times `2^20`, through the Q20 cos `k`
(`2^20` for latitude, a `cosQ` lower bound for longitude). Scaled so the hot
reject is a comparison, `S ≥ best · 2^20`, not a division; a `Nat` because it
reaches ~10^16. -/
def boxGapScaled (x lo hi k : Int) : Nat :=
  if x < lo then (lo - x).toNat * 11132 * k.toNat
  else if x > hi then (x - hi).toNat * 11132 * k.toNat
  else 0

/-- The box gap never exceeds the distance to any point of `[lo, hi]`. Only
this direction matters: an over-estimate would drop a chord that could win. -/
theorem boxGapScaled_le {x lo hi f k : Int} (hf : lo ≤ f) (hf' : f ≤ hi) :
    boxGapScaled x lo hi k ≤ (f - x).natAbs * 11132 * k.toNat := by
  unfold boxGapScaled
  split
  · next h =>
    exact Nat.mul_le_mul (Nat.mul_le_mul (by omega) (Nat.le_refl 11132)) (Nat.le_refl k.toNat)
  · split
    · next h =>
      exact Nat.mul_le_mul (Nat.mul_le_mul (by omega) (Nat.le_refl 11132)) (Nat.le_refl k.toNat)
    · exact Nat.zero_le _

/-- `distToFast`'s reject before paying for a projection: the chord's box gap
from `p` against the incumbent `best`, each axis alone first, then both. Kept
scaled by `2^20` so the first two tests are comparisons. `cmin` is the
corridor's `cosQ` lower bound, which makes the longitude gap an under-estimate. -/
@[inline] def boxRejects (p : QPt) (ch : QChord) (cmin : Int) (best : Nat) : Bool :=
  let bestS : Nat := best * 1048576
  let gLaS := boxGapScaled p.la ch.loLa ch.hiLa 1048576
  if gLaS ≥ bestS then true
  else
    let gLoS := boxGapScaled p.lo ch.loLo ch.hiLo cmin
    if gLoS ≥ bestS then true
    else
      let gLa := gLaS / 1048576
      let gLo := gLoS / 1048576
      gLa * gLa + gLo * gLo ≥ best * best

/-- The reject only ever discards losers. If `boxRejects` fires for a point
`f` in the chord's box, then `f` is at least `best` away — so skipping the chord
can change neither the running minimum nor the final answer.

The one non-local premise is `hcos`: `cmin` must lower-bound `cosQ` at the
query's mid-latitude. `mkQCorridor` takes it from `cosQLowerBound`, proved under
`cosQ` throughout the band; what remains assumed is that the query lies in the
widened band. -/
theorem boxRejects_sound {p f : QPt} {ch : QChord} {cmin : Int} {best : Nat}
    (hLa : ch.loLa ≤ f.la) (hLa' : f.la ≤ ch.hiLa)
    (hLo : ch.loLo ≤ f.lo) (hLo' : f.lo ≤ ch.hiLo)
    (hcos : cmin ≤ cosQ ((p.la + f.la).tdiv 2))
    (h : boxRejects p ch cmin best = true) :
    best ≤ qDist p f := by
  -- Each axis gap, divided back to µm, under-estimates that axis of `qDist`.
  have hgLa : boxGapScaled p.la ch.loLa ch.hiLa 1048576 / 1048576
      ≤ (f.la - p.la).natAbs * 11132 := by
    have := Nat.div_le_div_right (c := 1048576) (boxGapScaled_le (x := p.la) (k := 1048576) hLa hLa')
    rwa [show ((1048576 : Int)).toNat = 1048576 from rfl,
      Nat.mul_div_cancel _ (by omega)] at this
  have hgLo : boxGapScaled p.lo ch.loLo ch.hiLo cmin / 1048576
      ≤ (f.lo - p.lo).natAbs * 11132 * (cosQ ((p.la + f.la).tdiv 2)).natAbs / 1048576 :=
    Nat.div_le_div_right
      (Nat.le_trans (boxGapScaled_le (x := p.lo) hLo hLo')
        (Nat.mul_le_mul (Nat.le_refl _) (by omega)))
  refine le_qDist_of_axes hgLa hgLo ?_
  -- All three exits imply the same squared bound; the first two are one axis on
  -- its own, which is only a weaker version of the combined test.
  unfold boxRejects at h
  simp only [] at h
  split at h
  · next hr =>
    have : best ≤ boxGapScaled p.la ch.loLa ch.hiLa 1048576 / 1048576 :=
      (Nat.le_div_iff_mul_le (by omega)).mpr hr
    exact Nat.le_trans (Nat.mul_le_mul this this) (Nat.le_add_right _ _)
  · split at h
    · next hr =>
      have : best ≤ boxGapScaled p.lo ch.loLo ch.hiLo cmin / 1048576 :=
        (Nat.le_div_iff_mul_le (by omega)).mpr hr
      exact Nat.le_trans (Nat.mul_le_mul this this) (Nat.le_add_left _ _)
    · exact of_decide_eq_true h

/-- The corridor's tuned parameters, `S = farUm − nearUm` precomputed, plus the
chord index `distToFast` reads.

`cellLa`/`cellLo` are one `farUm` step per axis (longitude through `cmin`, so
never too narrow). `grid` files each chord in every cell its box, dilated by one
cell, touches, so `distToFast` can read one bucket (`near_chord_cell_range`).
`cmin` lower-bounds `cosQ` over the corridor plus 0.1° of latitude, proved by
`cosQLowerBound_le`. `chords` carries each chord's solved frame. -/
structure QCorridor where
  fixes : Array QPt
  nearUm : Nat
  farUm : Nat
  maxPen : Nat
  S : Nat
  cellLa : Int
  cellLo : Int
  cmin : Int
  grid : Std.HashMap Nat (Array Nat)
  chords : Array QChord

/-- The corridor-wide `cosQ` lower bound `mkQCorridor` sizes its cells with —
one definition, so the cell budget below counts the cells the corridor builds. -/
def corridorCmin (fixes : Array QPt) : Int := Id.run do
  -- Corridor-wide `cosQ` lower bound for the longitude reject and the cell
  -- widths. Erring low only widens cells and loosens the reject; erring high
  -- would be unsound. `cosQLowerBound` is proved, about 4% loose, and "cosQ
  -- falls with |latitude|" is false (see `cosQLowerBound`).
  let mut mnLa : Int := 0
  let mut mxLa : Int := 0
  if 0 < fixes.size then
    mnLa := (fixes.getD 0 default).la
    mxLa := mnLa
    for f in fixes do
      if f.la < mnLa then mnLa := f.la
      if f.la > mxLa then mxLa := f.la
  let margin : Int := 1000000
  let loEnd : Int := mnLa - margin
  let hiEnd : Int := mxLa + margin
  let mut cmin : Int :=
    cosQLowerBound (if loEnd.natAbs ≥ hiEnd.natAbs then loEnd else hiEnd)
  if cmin < 1 then cmin := 1
  return cmin

/-- How many (cell, chord) entries `mkQCorridor` would file, without filing them:
each chord goes into every cell of its bounding box dilated by one cell, so a
chord between fixes kilometres apart costs the square of its length in cells. -/
def corridorEntries (fixes : Array QPt) (farUm : Nat) : Nat := Id.run do
  let cmin := corridorCmin fixes
  let cellLa : Int := ((farUm / 11132 : Nat) : Int) + 1
  let cellLo : Int := ((farUm * 1048576 / (11132 * cmin.toNat) : Nat) : Int) + 1
  let mut n : Nat := 0
  for i in [1:fixes.size] do
    let a := fixes.getD (i - 1) default
    let b := fixes.getD i default
    let rows := (((max a.la b.la) + cellLa).fdiv cellLa - ((min a.la b.la) - cellLa).fdiv cellLa + 1).toNat
    let cols := (((max a.lo b.lo) + cellLo).fdiv cellLo - ((min a.lo b.lo) - cellLo).fdiv cellLo + 1).toNat
    n := n + rows * cols
  return n

def mkQCorridor (fixes : Array QPt) (nearUm farUm maxPen : Nat) : QCorridor := Id.run do
  let cmin := corridorCmin fixes
  -- Stated as `Nat` divisions cast up, which is both what the machine wants and
  -- the exact form `near_chord_cell_range` is proved about.
  let cellLa : Int := ((farUm / 11132 : Nat) : Int) + 1
  let cellLo : Int := ((farUm * 1048576 / (11132 * cmin.toNat) : Nat) : Int) + 1
  let mut grid : Std.HashMap Nat (Array Nat) := ∅
  let mut chords : Array QChord := #[default]
  for i in [1:fixes.size] do
    let a := fixes.getD (i - 1) default
    let b := fixes.getD i default
    let c : Int := cosQ ((a.la + b.la).tdiv 2)
    let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
    let vy : Int := (b.la - a.la) * 11132
    chords := chords.push
      { a, b, c, bx, vy
        len2 := bx.natAbs * bx.natAbs + vy.natAbs * vy.natAbs
        dLaAbs := (b.la - a.la).natAbs, dLaNeg := b.la < a.la
        dLoAbs := (b.lo - a.lo).natAbs, dLoNeg := b.lo < a.lo
        loLa := (min a.la b.la) - 1, hiLa := (max a.la b.la) + 1
        loLo := (min a.lo b.lo) - 1, hiLo := (max a.lo b.lo) + 1 }
    let loLa := (min a.la b.la) - cellLa
    let hiLa := (max a.la b.la) + cellLa
    let loLo := (min a.lo b.lo) - cellLo
    let hiLo := (max a.lo b.lo) + cellLo
    let cy0 := loLa.fdiv cellLa
    let cy1 := hiLa.fdiv cellLa
    let cx0 := loLo.fdiv cellLo
    let cx1 := hiLo.fdiv cellLo
    let mut cy := cy0
    while cy ≤ cy1 do
      let mut cx := cx0
      while cx ≤ cx1 do
        let key := cellKeyN cy cx
        grid := grid.alter key fun o =>
          let b2 := o.getD #[]
          if b2.isEmpty || b2.getD (b2.size - 1) 0 != i then some (b2.push i) else some b2
        cx := cx + 1
      cy := cy + 1
  return { fixes, nearUm, farUm, maxPen, S := farUm - nearUm, cellLa, cellLo, cmin, grid, chords }

/-! ### The corridor grid holds every chord that could win

`distToFast` reads one bucket, exact only if it holds every chord that can
beat the `farUm` clamp: cells are at least the reach (`la_near_within_cell`,
`lo_near_within_cell`), a query within one cell of a box lands in the filed
range (`cell_mem_range`), and the fill loop covers that range. Dilating before
filing makes the middle step interval containment, with no rasterisation
argument. -/

/-- Floor division is monotone: a smaller coordinate cannot land in a later
cell. Every grid here rests on this. -/
theorem fdiv_le_fdiv {a b c : Int} (hc : 0 < c) (h : a ≤ b) : a.fdiv c ≤ b.fdiv c := by
  rw [Int.fdiv_eq_ediv, Int.fdiv_eq_ediv, if_pos (Or.inl (Int.le_of_lt hc)),
    if_pos (Or.inl (Int.le_of_lt hc))]
  have := Int.ediv_le_ediv hc h
  omega

/-- A point of `[lo, hi]` has a cell index inside the range its endpoints were
filed under. Every grid here reduces to this; proximity grids dilate the
interval by a cell first. -/
theorem fdiv_mem_range {lo hi p cell : Int} (hcell : 0 < cell)
    (h1 : lo ≤ p) (h2 : p ≤ hi) :
    lo.fdiv cell ≤ p.fdiv cell ∧ p.fdiv cell ≤ hi.fdiv cell :=
  ⟨fdiv_le_fdiv hcell h1, fdiv_le_fdiv hcell h2⟩

/-- The dilated form, as the corridor grid files chords. -/
theorem cell_mem_range {lo hi p cell : Int} (hcell : 0 < cell)
    (h1 : lo - cell ≤ p) (h2 : p ≤ hi + cell) :
    (lo - cell).fdiv cell ≤ p.fdiv cell ∧ p.fdiv cell ≤ (hi + cell).fdiv cell :=
  fdiv_mem_range hcell h1 h2

/-- Latitude reach: closer than `farUm` means less than one `cellLa` apart. One
latitude unit is 11 132 µm flat, so this needs no cosine. -/
theorem la_near_within_cell {p f : QPt} {farUm : Nat} (h : qDist p f < farUm) :
    (f.la - p.la).natAbs ≤ farUm / 11132 := by
  have := le_qDist_la p f
  omega

/-- Longitude reach: closer than `farUm` means less than one `cellLo` apart, for
any cos lower bound. The strict `<` absorbs `qDist`'s floor, and is exactly when
a chord can still lower `distToFast`'s best. -/
theorem lo_near_within_cell {p f : QPt} {farUm : Nat} {cmin : Int}
    (hc : 0 < cmin) (hcos : cmin ≤ cosQ ((p.la + f.la).tdiv 2))
    (h : qDist p f < farUm) :
    (f.lo - p.lo).natAbs ≤ farUm * 1048576 / (11132 * cmin.toNat) := by
  have hlo := le_qDist_lo p f
  have hA : (f.lo - p.lo).natAbs * 11132 * (cosQ ((p.la + f.la).tdiv 2)).natAbs
      < farUm * 1048576 := by omega
  have hcm : cmin.toNat ≤ (cosQ ((p.la + f.la).tdiv 2)).natAbs := by omega
  have hmono := Nat.mul_le_mul (Nat.le_refl ((f.lo - p.lo).natAbs * 11132)) hcm
  have hassoc : (f.lo - p.lo).natAbs * 11132 * cmin.toNat
      = (f.lo - p.lo).natAbs * (11132 * cmin.toNat) := Nat.mul_assoc _ _ _
  exact (Nat.le_div_iff_mul_le (by omega)).mpr (by omega)

/-- The bucket `distToFast` reads holds every chord that matters: a box point
within `farUm` of `p` puts `p`'s cell inside the chord's filed range on both
axes, and `foot_mem_box` supplies that point.

`hcos` is the same corridor-wide cosine bound `boxRejects_sound` needs, and
`cosQLowerBound_le` discharges it the same way. -/
theorem near_chord_cell_range {p f : QPt} {farUm : Nat}
    {cmin loLa hiLa loLo hiLo cellLa cellLo : Int}
    (hLaDef : cellLa = ((farUm / 11132 : Nat) : Int) + 1)
    (hLoDef : cellLo = ((farUm * 1048576 / (11132 * cmin.toNat) : Nat) : Int) + 1)
    (hcm : 0 < cmin) (hcos : cmin ≤ cosQ ((p.la + f.la).tdiv 2))
    (hnear : qDist p f < farUm)
    (hfLa : loLa ≤ f.la) (hfLa' : f.la ≤ hiLa)
    (hfLo : loLo ≤ f.lo) (hfLo' : f.lo ≤ hiLo) :
    ((loLa - cellLa).fdiv cellLa ≤ p.la.fdiv cellLa
      ∧ p.la.fdiv cellLa ≤ (hiLa + cellLa).fdiv cellLa)
    ∧ ((loLo - cellLo).fdiv cellLo ≤ p.lo.fdiv cellLo
      ∧ p.lo.fdiv cellLo ≤ (hiLo + cellLo).fdiv cellLo) := by
  have hla := la_near_within_cell hnear
  have hlo := lo_near_within_cell hcm hcos hnear
  exact ⟨cell_mem_range (by omega) (by omega) (by omega),
    cell_mem_range (by omega) (by omega) (by omega)⟩

/-- Grid-indexed distance to the corridor: the value a scan of every chord
gives, from one bucket, since the bucket holds every chord within `farUm`
(`near_chord_cell_range`) and the distance clamps there. Also value-preserving:
the frame is read from `co.chords`, and the reject is the two-axis box gap
(`chordReject_sound`). Both take `cmin ≤ cosQ` as a hypothesis, which
`cosQLowerBound_le` discharges across the band. -/
def QCorridor.distToFast (co : QCorridor) (p : QPt) : Nat := Id.run do
  if co.fixes.size == 0 then return 0
  if co.fixes.size == 1 then return qDist p (co.fixes.getD 0 default)
  let cands := co.grid.getD (cellKeyN (p.la.fdiv co.cellLa) (p.lo.fdiv co.cellLo)) #[]
  let mut best : Nat := co.farUm
  for i in cands do
    let ch := co.chords.getD i default
    if boxRejects p ch co.cmin best then continue
    let d : Nat :=
      if ch.len2 = 0 then qDist p ch.a
      else
        let px : Int := ((p.lo - ch.a.lo) * 11132 * ch.c).fdiv 1048576
        let py : Int := (p.la - ch.a.la) * 11132
        qDist p (ch.foot (qDot px py ch))
    if d < best then best := d
  return best

/-- `distToFast`'s reject only drops chords that could not have won: the clamp
(`qDot_le`) and rounding (`roundedStep_le`) keep the foot in the chord's box
(`foot_mem_box`), so a firing reject puts it at least `best` away
(`boxRejects_sound`). Still assumed, as the hypothesis `hcos`: `cmin`
lower-bounds `cosQ` at this query's mid-latitude. -/
theorem chordReject_sound {p : QPt} {ch : QChord} {cmin : Int} {best dot : Nat}
    (wf : ch.WF) (hlen : 0 < ch.len2) (hdot : dot ≤ ch.len2)
    (hcos : cmin ≤ cosQ ((p.la + (ch.foot dot).la).tdiv 2))
    (h : boxRejects p ch cmin best = true) :
    best ≤ qDist p (ch.foot dot) := by
  obtain ⟨hb1, hb2, hb3, hb4⟩ := foot_mem_box wf hlen hdot
  exact boxRejects_sound hb1 hb2 hb3 hb4 hcos h

/-- The ramp times `S`: `S` at/below `nearUm`, `S·maxPen` at/above
`farUm`, linear between — the float penalty's exact total order
(`QCorridor.penScaled`). -/
def QCorridor.penScaled (co : QCorridor) (d : Nat) : Nat :=
  if d ≤ co.nearUm then co.S
  else if d ≥ co.farUm then co.S * co.maxPen
  else co.S + (co.maxPen - 1) * (d - co.nearUm)

/-- `qDist(a,b) · penScaled(distTo(mid))` — the `S`-scaled edge weight
(`QCorridor.edgeWeightScaled`). -/
def QCorridor.edgeWeightScaled (co : QCorridor) (a b : QPt) : Nat :=
  let mid : QPt := { la := (a.la + b.la).tdiv 2, lo := (a.lo + b.lo).tdiv 2, ts := 0 }
  qDist a b * co.penScaled (co.distToFast mid)

/-! ## `QBuildings` — the impassable-footprint penalty -/

/-- An axis-aligned integer bounding box (the exact bbox reject). -/
structure QBox where
  minLa : Int
  maxLa : Int
  minLo : Int
  maxLo : Int
  deriving Repr, Inhabited

/-- Side of one footprint-grid cell, in µm: a bucketing knob only, since any
positive side gives the same answer. Sized near a typical building. -/
def buildingCellUm : Nat := 30000000

/-- Prepared building set: rings (≥ 3 vertices), their bounding boxes,
the fixes, and the two tuned thresholds (`QBuildings` constructor), plus the
footprint index `inAnyRingFast` reads.

`grid` files ring `i` in every cell its box meets. Containment needs no
dilation: a `p` inside the box is in one of those cells (`fdiv_mem_range`), so
the bucket holds every ring a scan would test past its box reject. -/
structure QBuildings where
  rings : Array (Array QPt)
  boxes : Array QBox
  fixes : Array QPt
  crossFactor : Nat
  supportUm : Nat
  cellLa : Int
  cellLo : Int
  grid : Std.HashMap Nat (Array Nat)

def mkQBuildings (buildings : Array (Array QPt)) (fixes : Array QPt)
    (crossFactor supportUm : Nat) : QBuildings := Id.run do
  let mut rings : Array (Array QPt) := #[]
  let mut boxes : Array QBox := #[]
  for r in buildings do
    if r.size ≥ 3 then
      let mut minLa := (r.getD 0 default).la
      let mut maxLa := (r.getD 0 default).la
      let mut minLo := (r.getD 0 default).lo
      let mut maxLo := (r.getD 0 default).lo
      for p in r do
        if p.la < minLa then minLa := p.la
        if p.la > maxLa then maxLa := p.la
        if p.lo < minLo then minLo := p.lo
        if p.lo > maxLo then maxLo := p.lo
      rings := rings.push r
      boxes := boxes.push { minLa, maxLa, minLo, maxLo }
  -- Cell sides in coordinate units. The longitude side uses a corridor-wide
  -- `cosQ` lower bound purely so the cell stays roughly square in metres.
  let mut cmin : Int := 1048576
  for f in fixes do
    let c := cosQ f.la
    if c < cmin then cmin := c
  if cmin < 1 then cmin := 1
  let cellLa : Int := (buildingCellUm : Int) / 11132 + 1
  let cellLo : Int := ((buildingCellUm : Int) * 1048576) / (11132 * cmin) + 1
  let mut grid : Std.HashMap Nat (Array Nat) := ∅
  for i in [0:boxes.size] do
    let b := boxes.getD i default
    let mut cy := b.minLa.fdiv cellLa
    let cy1 := b.maxLa.fdiv cellLa
    let cx0 := b.minLo.fdiv cellLo
    let cx1 := b.maxLo.fdiv cellLo
    while cy ≤ cy1 do
      let mut cx := cx0
      while cx ≤ cx1 do
        let key := cellKeyN cy cx
        grid := grid.alter key fun o => some ((o.getD #[]).push i)
        cx := cx + 1
      cy := cy + 1
  return { rings, boxes, fixes, crossFactor, supportUm, cellLa, cellLo, grid }

/-- Grid-indexed footprint test: the value a scan of every ring gives, from
`p`'s bucket, which holds every ring whose box contains `p`. Bucket order is
ascending ring index, as in the scan. -/
def QBuildings.inAnyRingFast (bld : QBuildings) (p : QPt) : Bool := Id.run do
  let cands := bld.grid.getD (cellKeyN (p.la.fdiv bld.cellLa) (p.lo.fdiv bld.cellLo)) #[]
  for i in cands do
    let b := bld.boxes.getD i default
    if p.la < b.minLa || p.la > b.maxLa || p.lo < b.minLo || p.lo > b.maxLo then
      continue
    if qPointInRing p (bld.rings.getD i default) then return true
  return false

def QBuildings.fixSupports (bld : QBuildings) (p : QPt) : Bool := Id.run do
  for f in bld.fixes do
    if ((f.la - p.la).natAbs * 11132 : Nat) > bld.supportUm then continue
    if qDist p f ≤ bld.supportUm then return true
  return false

/-- One sample's verdict: in a footprint, and no fix within `supportUm`. -/
def QBuildings.sampleBad (bld : QBuildings) (s : QPt) : Bool :=
  bld.inAnyRingFast s && !bld.fixSupports s

/-- The number of 3 m steps `factor` samples `a → b` at: `⌈len / 3 m⌉`, at least 1. -/
def QBuildings.sampleSteps (len : Nat) : Nat :=
  let step : Nat := 3000000
  let n : Nat := (len + step - 1) / step
  if n < 1 then 1 else n

/-- The `k`-th of `n` steps along `a → b`, on the coordinate grid. `k = 0` is
`a` itself and `k = n` is `b` itself (`roundDiv` of an exact multiple). -/
def QBuildings.sampleAt (a b : QPt) (n k : Nat) : QPt :=
  { la := a.la + roundDiv ((k : Int) * (b.la - a.la)) (n : Int)
    lo := a.lo + roundDiv ((k : Int) * (b.lo - a.lo)) (n : Int), ts := 0 }

/-- The sample scan over the steps `lo ≤ k < hi` only. -/
def QBuildings.anyBad (bld : QBuildings) (a b : QPt) (n lo hi : Nat) : Bool := Id.run do
  for k in [lo:hi] do
    if bld.sampleBad (QBuildings.sampleAt a b n k) then return true
  return false

/-- The 3 m sample scan with the edge length given: `crossFactor` if any
sample lands in a footprint no fix supports, else `1`. -/
def QBuildings.factorLen (bld : QBuildings) (a b : QPt) (len : Nat) : Nat :=
  let n := QBuildings.sampleSteps len
  if bld.anyBad a b n 0 (n + 1) then bld.crossFactor else 1

def QBuildings.factor (bld : QBuildings) (a b : QPt) : Nat := bld.factorLen a b (qDist a b)

/-- `factorLen` with the end samples read from a per-vertex memo and only the
interior sampled. The scan is a disjunction, so the order does not matter, and
a vertex ends many edges. Same value when the memo is honest (`#guard`ed). -/
def QBuildings.factorMemo (bld : QBuildings) (a b : QPt) (len : Nat) (badA badB : Bool) : Nat :=
  let n := QBuildings.sampleSteps len
  if badA || badB || bld.anyBad a b n 1 n then bld.crossFactor else 1

/-! ## Graph build (part 2)

The routing graph is `Verified/Rail/Graph.lean`'s `Graph` with weights
precomputed in the µm·S scale, so routing reuses the proved `LazyDijkstra`. -/

open Verified.Rail (Graph WFEdges)

/-- A way: its coordinate polyline and optional name. -/
structure QWay where
  coords : Array QPt
  name : Option String
  deriving Inhabited

/-- A directed way segment `u → v` of length `lenUm`, carrying the way
name for the switch penalty (`QSeg`). -/
structure QSeg where
  u : Nat
  v : Nat
  lenUm : Nat
  name : Option String
  deriving Repr, Inhabited

/-- A projection candidate: the foot, its distance, the source segment,
and the exact fraction `tn/td` (`QCand`). -/
structure QCand where
  la : Int
  lo : Int
  dist : Nat
  si : Nat
  tn : Int
  td : Int
  deriving Repr, Inhabited

def candPt (c : QCand) : QPt := { la := c.la, lo := c.lo, ts := 0 }

/-- The built matcher graph: deduped vertices, way segments (candidate
sources), and the weighted `Rail.Graph` for routing. -/
structure QGraph where
  vertices : Array QPt
  segments : Array QSeg
  g : Graph
  deriving Inhabited

/-- The routing graph, as specified: vertices deduped by the integer coord
pair, way edges in iteration order, then `bridgeGaps` as the plain `i < j`
scan; every edge weight precomputed. -/
def buildQGraph (ways : Array QWay) (co : QCorridor) (bld : Option QBuildings)
    (gapUm : Nat) : QGraph := Id.run do
  let mut vertices : Array QPt := #[]
  let mut adj : Array (Array (Nat × Nat)) := #[]
  let mut segments : Array QSeg := #[]
  let wt := fun (ap bp : QPt) =>
    co.edgeWeightScaled ap bp * (match bld with | some bl => bl.factor ap bp | none => 1)
  for way in ways do
    let mut prev : Int := -1
    let mut prevPt : QPt := default
    for p in way.coords do
      let found := vertices.findIdx? (fun q => q.la == p.la && q.lo == p.lo)
      let id : Nat := found.getD vertices.size
      if found.isNone then
        vertices := vertices.push { la := p.la, lo := p.lo, ts := 0 }
        adj := adj.push #[]
      if prev ≥ 0 && (id : Int) ≠ prev then
        let a := prev.toNat
        let w := wt prevPt p
        adj := adj.setIfInBounds a ((adj.getD a #[]).push (id, w))
        adj := adj.setIfInBounds id ((adj.getD id #[]).push (a, w))
        segments := segments.push { u := a, v := id, lenUm := qDist prevPt p, name := way.name }
      prev := (id : Int)
      prevPt := p
  -- bridgeGaps: connect near-coincident vertices of different ways.
  let gapSq : Int := (gapUm : Int) * (gapUm : Int) + 2 * (gapUm : Int)
  for i in [0:vertices.size] do
    let vi := vertices.getD i default
    for j in [i + 1:vertices.size] do
      let vj := vertices.getD j default
      let dla : Int := (vj.la - vi.la) * 11132
      if dla.natAbs > gapUm then continue
      let c : Int := cosQ ((vi.la + vj.la).tdiv 2)
      let dlo : Int := ((vj.lo - vi.lo) * 11132 * c).fdiv 1048576
      if dla * dla + dlo * dlo > gapSq then continue
      if (adj.getD i #[]).any (fun e => e.1 == j) then continue
      let w := wt vi vj
      adj := adj.setIfInBounds i ((adj.getD i #[]).push (j, w))
      adj := adj.setIfInBounds j ((adj.getD j #[]).push (i, w))
  return { vertices, segments, g := ⟨adj⟩ }

/-- One edge's weight, `edgeWeightScaled × factor`, with `len = qDist a b` taken
once by the caller and the endpoint verdicts read from the memo `vBad`. -/
def edgeWeightMemo (co : QCorridor) (bld : Option QBuildings) (vBad : Array Bool)
    (ia ib : Nat) (a b : QPt) (len : Nat) : Nat :=
  let mid : QPt := { la := (a.la + b.la).tdiv 2, lo := (a.lo + b.lo).tdiv 2, ts := 0 }
  let f : Nat := match bld with
    | some bl => bl.factorMemo a b len (vBad.getD ia false) (vBad.getD ib false)
    | none => 1
  len * co.penScaled (co.distToFast mid) * f

/-- `buildQGraph` in O(V): the same graph, with its two O(V²) scans replaced
by hash indices.

* Vertex dedup by a `(la, lo) → id` hash; numbering stays first-seen.
* `bridgeGaps` candidates from a `gapUm` grid (`cellKeyN`) rather than all
  pairs. A within-`gapUm` pair lands in the 3×3 neighbourhood, since the
  longitude cell uses a cos lower bound; key collisions only add candidates.

The accept predicate and the ascending-`(i, j)` push order are `buildQGraph`'s,
so the output is identical and the theorems about `buildQGraph` apply. -/
def buildQGraphFast (ways : Array QWay) (co : QCorridor) (bld : Option QBuildings)
    (gapUm : Nat) : QGraph := Id.run do
  let mut vertices : Array QPt := #[]
  let mut adj : Array (Array (Nat × Nat)) := #[]
  let mut segments : Array QSeg := #[]
  let mut vidx : Std.HashMap (Int × Int) Nat := ∅
  -- The way edges, weighed once every vertex is known, so each endpoint's
  -- building verdict (`vBad`) is computed once rather than per edge.
  let mut wayEdges : Array (Nat × Nat × Option String) := #[]
  for way in ways do
    let mut prev : Int := -1
    for p in way.coords do
      let found := vidx.get? (p.la, p.lo)
      let id : Nat := found.getD vertices.size
      if found.isNone then
        vertices := vertices.push { la := p.la, lo := p.lo, ts := 0 }
        adj := adj.push #[]
        vidx := vidx.insert (p.la, p.lo) id
      if prev ≥ 0 && (id : Int) ≠ prev then
        wayEdges := wayEdges.push (prev.toNat, id, way.name)
      prev := (id : Int)
  let vBad : Array Bool := match bld with
    | some bl => vertices.map bl.sampleBad
    | none => #[]
  for (a, id, name) in wayEdges do
    let pa := vertices.getD a default
    let pb := vertices.getD id default
    let len := qDist pa pb
    let w := edgeWeightMemo co bld vBad a id pa pb len
    -- `modify`, not `setIfInBounds (getD … |>.push …)`: the latter holds a
    -- second reference to the row while pushing, so every push reallocates
    -- and copies the whole row. Same value, one owner.
    adj := adj.modify a (·.push (id, w))
    adj := adj.modify id (·.push (a, w))
    segments := segments.push { u := a, v := id, lenUm := len, name }
  -- bridgeGaps via a spatial grid. Below the cell index, values are `Nat`
  -- magnitudes with the sign in the branches, since they reach ~10^15 and `Int`
  -- turns into a GMP bignum past 2^31.
  let gapSq : Nat := gapUm * gapUm + 2 * gapUm
  let gY : Nat := if gapUm == 0 then 1 else gapUm
  let gX : Nat := gY * 1048576
  -- conservative cos lower bound over the vertices (≥ 1 so the cell is finite).
  let mut cmin : Int := 1048576
  for v in vertices do
    let c := cosQ v.la
    if c < cmin then cmin := c
  if cmin < 1 then cmin := 1
  let cminN : Nat := cmin.toNat
  let cellY := fun (v : QPt) =>
    let m : Nat := v.la.natAbs * 11132
    if v.la ≥ 0 then ((m / gY : Nat) : Int) else -(((m + gY - 1) / gY : Nat) : Int)
  let cellX := fun (v : QPt) =>
    let m : Nat := v.lo.natAbs * 11132 * cminN
    if v.lo ≥ 0 then ((m / gX : Nat) : Int) else -(((m + gX - 1) / gX : Nat) : Int)
  let mut grid : Std.HashMap Nat (Array Nat) := ∅
  for i in [0:vertices.size] do
    let v := vertices.getD i default
    let key := cellKeyN (cellY v) (cellX v)
    grid := grid.alter key fun o => some ((o.getD #[]).push i)
  for i in [0:vertices.size] do
    let vi := vertices.getD i default
    let byc := cellY vi
    let bxc := cellX vi
    let mut cand : Array Nat := #[]
    for dy in [(-1 : Int), 0, 1] do
      for dx in [(-1 : Int), 0, 1] do
        for j in grid.getD (cellKeyN (byc + dy) (bxc + dx)) #[] do
          if j > i then cand := cand.push j
    -- A few dozen distinct ids from nine already-ascending buckets: an
    -- insertion sort, not a quicksort (the same order; `qsort`'s partitioning
    -- was 7% of the build on a dense walk).
    for j in cand.insertionSort (· < ·) do
      let vj := vertices.getD j default
      let dla : Nat := (vj.la - vi.la).natAbs * 11132
      if dla > gapUm then continue
      let c : Int := cosQ ((vi.la + vj.la).tdiv 2)
      let y : Nat := (vj.lo - vi.lo).natAbs * 11132 * c.natAbs
      let negY : Bool := decide ((vj.lo - vi.lo) < 0) != decide (c < 0)
      let dlo : Nat := if negY then (y + 1048575) / 1048576 else y / 1048576
      if dla * dla + dlo * dlo > gapSq then continue
      if (adj.getD i #[]).any (fun e => e.1 == j) then continue
      -- `c` is `qDist`'s own cosine for this pair (same mid-latitude).
      let w := edgeWeightMemo co bld vBad i j vi vj (qDistC vi vj c)
      adj := adj.modify i (·.push (j, w))
      adj := adj.modify j (·.push (i, w))
  return { vertices, segments, g := ⟨adj⟩ }

/-! ### `buildQGraphFast` is `buildQGraph`, on an instance with every arm live

A corridor, supported and unsupported footprints, shared vertices and gap
pairs: the memoised weights and the two-pass way loop must reproduce the
spec's graph edge for edge. This fails at build time; the corpus gate checks
real walks. -/

private def gwWays : Array QWay := #[
  { coords := #[⟨515000000, -1300000, 0⟩, ⟨515005000, -1300000, 0⟩, ⟨515010000, -1300000, 0⟩,
      ⟨515015000, -1300000, 0⟩], name := some "Main Street" },
  -- Shares the second vertex; its far end is ~15 m from Main Street's third,
  -- so the gap bridge connects them.
  { coords := #[⟨515005000, -1300000, 0⟩, ⟨515005000, -1294000, 0⟩, ⟨515011000, -1298500, 0⟩],
    name := some "Side Street" },
  -- Through the unsupported footprint.
  { coords := #[⟨515008000, -1305000, 0⟩, ⟨515008000, -1295000, 0⟩], name := none }]

private def gwFixes : Array QPt := #[⟨515000000, -1300000, 0⟩, ⟨515005000, -1300000, 60⟩,
  ⟨515010000, -1300000, 120⟩, ⟨515005000, -1294000, 180⟩]

private def gwRings : Array (Array QPt) := #[
  -- Around the second fix, within its 15 m support: no penalty from it.
  #[⟨515004000, -1301000, 0⟩, ⟨515004000, -1299000, 0⟩, ⟨515006000, -1299000, 0⟩,
    ⟨515006000, -1301000, 0⟩],
  -- On the unnamed way, 22 m and more from every fix: the penalty fires on its edge.
  #[⟨515007000, -1302000, 0⟩, ⟨515007000, -1298000, 0⟩, ⟨515009000, -1298000, 0⟩,
    ⟨515009000, -1302000, 0⟩]]

private def gwCo : QCorridor := mkQCorridor gwFixes 25000000 80000000 40
-- The budget counts exactly what the corridor files.
#guard corridorEntries gwFixes 80000000 == gwCo.grid.fold (fun a _ v => a + v.size) 0
private def gwBld : QBuildings := mkQBuildings gwRings gwFixes 25 15000000

private def graphEq (a b : QGraph) : Bool :=
  a.vertices == b.vertices && a.g.adj == b.g.adj
    && a.segments.size == b.segments.size
    && (a.segments.zip b.segments).all fun (s, t) =>
      s.u == t.u && s.v == t.v && s.lenUm == t.lenUm && s.name == t.name

#guard graphEq (buildQGraphFast gwWays gwCo (some gwBld) 18000000)
  (buildQGraph gwWays gwCo (some gwBld) 18000000)
#guard graphEq (buildQGraphFast gwWays gwCo none 18000000) (buildQGraph gwWays gwCo none 18000000)
-- The instance exercises what it claims: a shared vertex, a bridge, and a
-- penalised edge next to an unpenalised one.
#guard (buildQGraphFast gwWays gwCo (some gwBld) 18000000).vertices.size == 8
#guard totalOut (buildQGraphFast gwWays gwCo (some gwBld) 18000000).g
  > 2 * (buildQGraphFast gwWays gwCo (some gwBld) 18000000).segments.size
#guard (buildQGraphFast gwWays gwCo (some gwBld) 18000000).g.adj.any fun row =>
  row.any fun (_, w) => w % 25 == 0 && w > 0
#guard gwBld.factor ⟨515008000, -1305000, 0⟩ ⟨515008000, -1295000, 0⟩ == 25
#guard gwBld.factor ⟨515000000, -1300000, 0⟩ ⟨515005000, -1300000, 0⟩ == 1

/-! ## Candidates -/

/-- The tie tolerance at the candidate cut, in µm: the most quantising to
1e-7° can move a point-to-segment distance (1.97 cm at London's latitude).
Below it, "nearer" is an artefact of the arithmetic. A wider band is not safer:
5 cm introduced a 16 m divergence. -/
def candidateTieUm : Nat := 20000

/-- Ceiling on the tie-inclusive extension, as a multiple of the cut — keeps
the decode O(F·K²) when a junction puts many segments inside one band. -/
def candidateTieCeiling : Nat := 2

/-- Cut a sorted candidate list at `maxCands`, keeping the following
candidates within `candidateTieUm` of the `maxCands`-th. Measured from that one
fixed candidate, so a run of close candidates cannot chain the band onward. -/
def cutTieInclusive (sorted : Array QCand) (maxCands : Nat) : Array QCand := Id.run do
  if sorted.size ≤ maxCands then return sorted
  let cutoff := (sorted.getD (maxCands - 1) default).dist + candidateTieUm
  let ceiling := min sorted.size (maxCands * candidateTieCeiling)
  let mut n := maxCands
  for i in [maxCands:ceiling] do
    if (sorted.getD i default).dist ≤ cutoff then n := n + 1 else break
  return sorted.extract 0 n

/-- Spatial index over a graph's segments, cells one `radiusUm` wide, each
segment filed in every cell its box dilated by one cell touches, so a segment
within `radiusUm` of a fix is in the fix's cell (`near_segment_cell_range`).

The longitude cell is `(radiusUm + 1)·2^20`: the radius test is inclusive, so
`qDist`'s floor must be paid explicitly (the corridor's strict `<` absorbs it).
Without the `+1` the cell is a unit too narrow within 0.005° of a pole. -/
structure QSegIndex where
  cellLa : Int
  cellLo : Int
  grid : Std.HashMap Nat (Array Nat)

def mkQSegIndex (gr : QGraph) (radiusUm : Nat) (cmin : Int) : QSegIndex := Id.run do
  let cellLa : Int := ((radiusUm / 11132 : Nat) : Int) + 1
  let cellLo : Int := (((radiusUm + 1) * 1048576 / (11132 * cmin.toNat) : Nat) : Int) + 1
  let mut grid : Std.HashMap Nat (Array Nat) := ∅
  for si in [0:gr.segments.size] do
    let s := gr.segments.getD si default
    let a := gr.vertices.getD s.u default
    let b := gr.vertices.getD s.v default
    let cy1 := ((max a.la b.la) + cellLa).fdiv cellLa
    let cx0 := ((min a.lo b.lo) - cellLo).fdiv cellLo
    let cx1 := ((max a.lo b.lo) + cellLo).fdiv cellLo
    let mut cy := ((min a.la b.la) - cellLa).fdiv cellLa
    while cy ≤ cy1 do
      let mut cx := cx0
      while cx ≤ cx1 do
        let key := cellKeyN cy cx
        -- `alter`, not `insert (getD … |>.push …)`: the latter holds a second
        -- reference to the bucket while pushing, so every push copies the whole
        -- bucket — quadratic in bucket size. Same value, one owner.
        grid := grid.alter key fun o =>
          let bkt := o.getD #[]
          if bkt.isEmpty || bkt.getD (bkt.size - 1) 0 != si then some (bkt.push si) else some bkt
        cx := cx + 1
      cy := cy + 1
  return { cellLa, cellLo, grid }

/-- Latitude reach under the *inclusive* radius test. -/
theorem la_within_cell_le {p f : QPt} {radiusUm : Nat} (h : qDist p f ≤ radiusUm) :
    (f.la - p.la).natAbs ≤ radiusUm / 11132 := by
  have := le_qDist_la p f
  omega

/-- Longitude reach under the inclusive radius test, hence `radiusUm + 1` in
the numerator (see `QSegIndex`). -/
theorem lo_within_cell_le {p f : QPt} {radiusUm : Nat} {cmin : Int}
    (hc : 0 < cmin) (hcos : cmin ≤ cosQ ((p.la + f.la).tdiv 2))
    (h : qDist p f ≤ radiusUm) :
    (f.lo - p.lo).natAbs ≤ (radiusUm + 1) * 1048576 / (11132 * cmin.toNat) := by
  have hlo := le_qDist_lo p f
  have hA : (f.lo - p.lo).natAbs * 11132 * (cosQ ((p.la + f.la).tdiv 2)).natAbs
      < (radiusUm + 1) * 1048576 := by omega
  have hcm : cmin.toNat ≤ (cosQ ((p.la + f.la).tdiv 2)).natAbs := by omega
  have hmono := Nat.mul_le_mul (Nat.le_refl ((f.lo - p.lo).natAbs * 11132)) hcm
  have hassoc : (f.lo - p.lo).natAbs * 11132 * cmin.toNat
      = (f.lo - p.lo).natAbs * (11132 * cmin.toNat) := Nat.mul_assoc _ _ _
  exact (Nat.le_div_iff_mul_le (by omega)).mpr (by omega)

/-- The bucket `qCandidatesForFixFast` reads holds every segment that could be
kept: `qProject`'s foot lies within the segment's box, so a segment passing
`proj.dist ≤ radiusUm` puts the fix's cell inside its filed range. -/
theorem near_segment_cell_range {p f : QPt} {radiusUm : Nat}
    {cmin loLa hiLa loLo hiLo cellLa cellLo : Int}
    (hLaDef : cellLa = ((radiusUm / 11132 : Nat) : Int) + 1)
    (hLoDef : cellLo = (((radiusUm + 1) * 1048576 / (11132 * cmin.toNat) : Nat) : Int) + 1)
    (hcm : 0 < cmin) (hcos : cmin ≤ cosQ ((p.la + f.la).tdiv 2))
    (hnear : qDist p f ≤ radiusUm)
    (hfLa : loLa ≤ f.la) (hfLa' : f.la ≤ hiLa)
    (hfLo : loLo ≤ f.lo) (hfLo' : f.lo ≤ hiLo) :
    ((loLa - cellLa).fdiv cellLa ≤ p.la.fdiv cellLa
      ∧ p.la.fdiv cellLa ≤ (hiLa + cellLa).fdiv cellLa)
    ∧ ((loLo - cellLo).fdiv cellLo ≤ p.lo.fdiv cellLo
      ∧ p.lo.fdiv cellLo ≤ (hiLo + cellLo).fdiv cellLo) := by
  have hla := la_within_cell_le hnear
  have hlo := lo_within_cell_le hcm hcos hnear
  exact ⟨cell_mem_range (by omega) (by omega) (by omega),
    cell_mem_range (by omega) (by omega) (by omega)⟩

/-- Grid-indexed candidates: the value a scan of every segment gives, from one
bucket (`near_segment_cell_range`). Both arms build the same array, since the
bucket is strictly ascending and omits nothing the filter keeps, so `qsort` and
`cutTieInclusive` give the same result without a `qsort` lemma. -/
def qCandidatesForFixFast (fix : QPt) (gr : QGraph) (idx : QSegIndex)
    (radiusUm maxCands : Nat) : Array QCand := Id.run do
  let cands0 := idx.grid.getD (cellKeyN (fix.la.fdiv idx.cellLa) (fix.lo.fdiv idx.cellLo)) #[]
  let mut cands : Array QCand := #[]
  for si in cands0 do
    let s := gr.segments.getD si default
    let a := gr.vertices.getD s.u default
    let b := gr.vertices.getD s.v default
    if latGapUm fix a b > radiusUm then continue
    let proj := qProject fix a b
    if proj.dist ≤ radiusUm then
      cands := cands.push { la := proj.la, lo := proj.lo, dist := proj.dist, si, tn := proj.tn, td := proj.td }
  let sorted := cands.qsort (fun p q => p.dist < q.dist || (p.dist == q.dist && p.si < q.si))
  return cutTieInclusive sorted maxCands

/-! ## Routing over the LazyDijkstra model

`RouteCache = Array (Option LState)` is a per-source lazy Dijkstra that pauses
at the requested target and resumes on the next `settleTo`. A settled vertex's
`dist`/`prev` are frozen (`settled_final`), so the reads equal a
run-to-terminal search while only the nearby corridor is explored.

The take-`none`/put-`some` around `lsettle` keeps the pulled state uniquely
referenced, so the search updates its arrays in place rather than copying. -/

abbrev RouteCache := Array (Option LState)

/-- Resume source `src`'s search until `tgt` settles (or termination),
returning the advanced state and cache. -/
def settleTo (g : Graph) (maxR fuel n src tgt : Nat) (cache : RouteCache) :
    LState × RouteCache :=
  let st0 := (cache.getD src none).getD (linit n src)
  let cache := cache.setIfInBounds src none
  let st := lsettle g maxR tgt fuel st0
  (st, cache.setIfInBounds src (some st))

/-! ### Cache purity, step 1: the `OnTraj` invariant

A cache is valid when every state it holds lies on its source's search
trajectory (`iter m (linit n src)`). `settleTo` preserves this (`lsettle_spec`),
and it is the invariant under which `LazyResume` and `LazyPrev` make
`qRouteBetween` a pure function of the graph. -/

/-- Every cached state for a source lies on that source's search
trajectory. -/
def OnTrajCache (g : Graph) (maxR n : Nat) (c : RouteCache) : Prop :=
  ∀ src st, c.getD src none = some st → ∃ m, st = iter g maxR m (linit n src)

theorem settleTo_fst {g : Graph} {maxR fuel n src tgt : Nat} {c : RouteCache} :
    (settleTo g maxR fuel n src tgt c).1
      = lsettle g maxR tgt fuel ((c.getD src none).getD (linit n src)) := rfl

theorem settleTo_snd {g : Graph} {maxR fuel n src tgt : Nat} {c : RouteCache} :
    (settleTo g maxR fuel n src tgt c).2
      = (c.setIfInBounds src none).setIfInBounds src
          (some (settleTo g maxR fuel n src tgt c).1) := rfl

/-- The state `settleTo` returns lies on the source's trajectory. -/
theorem settleTo_state_onTraj {g : Graph} {maxR fuel n src tgt : Nat} {c : RouteCache}
    (hc : OnTrajCache g maxR n c) :
    ∃ m, (settleTo g maxR fuel n src tgt c).1 = iter g maxR m (linit n src) := by
  obtain ⟨m0, hm0⟩ : ∃ m0, (c.getD src none).getD (linit n src)
      = iter g maxR m0 (linit n src) := by
    cases hcs : c.getD src none with
    | none => exact ⟨0, rfl⟩
    | some s0 => obtain ⟨m0, hm0⟩ := hc src s0 hcs; exact ⟨m0, hm0⟩
  obtain ⟨k, _, heq, _, _⟩ := lsettle_spec g maxR tgt fuel ((c.getD src none).getD (linit n src))
  exact ⟨m0 + k, by rw [settleTo_fst, heq, hm0, iter_add]⟩

/-- `settleTo` preserves the cache invariant. -/
theorem settleTo_onTraj {g : Graph} {maxR fuel n src tgt : Nat} {c : RouteCache}
    (hc : OnTrajCache g maxR n c) :
    OnTrajCache g maxR n (settleTo g maxR fuel n src tgt c).2 := by
  obtain ⟨m, hm⟩ := settleTo_state_onTraj (g := g) (maxR := maxR) (fuel := fuel)
    (n := n) (src := src) (tgt := tgt) (c := c) hc
  intro s' st' hst'
  rw [settleTo_snd] at hst'
  by_cases hs : s' = src
  · rw [hs] at hst' ⊢
    by_cases hbnd : src < c.size
    · rw [getD_sib_lt (by rw [Array.size_setIfInBounds]; exact hbnd)] at hst'
      exact ⟨m, (Option.some.inj hst').symm.trans hm⟩
    · exfalso
      have hsz : ((c.setIfInBounds src none).setIfInBounds src
          (some (settleTo g maxR fuel n src tgt c).1)).size = c.size := by
        rw [Array.size_setIfInBounds, Array.size_setIfInBounds]
      rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_none (by rw [hsz]; omega)] at hst'
      simp at hst'
  · rw [getD_sib_ne (fun e => hs e.symm), getD_sib_ne (fun e => hs e.symm)] at hst'
    exact hc s' st' hst'

/-- The prev-walk as structural recursion on a step budget, the form the
congruence proof inducts on. -/
def reconGo (prev : Array Nat) (n : Nat) : Nat → Nat → Array Nat → Array Nat
  | 0, _, acc => acc
  | fuel + 1, v, acc => if v ≥ n then acc else reconGo prev n fuel (prev.getD v n) (acc.push v)

/-- The prev-chain from `start` back to the sentinel `n`, reversed so
`idPath[0]` is the source. A valid chain has at most `n` vertices, so the budget
is never exceeded. -/
def qReconstruct (prev : Array Nat) (start n : Nat) : Array Nat :=
  (reconGo prev n n start #[]).reverse

/-- Reconstruction congruence: if `P` holds at the start, is closed under the
`prev₁` step and `prev₁`/`prev₂` agree on it, the reconstructions coincide. With
`P` = "settled", it makes the reconstructed path resume-stable. -/
theorem reconGo_congr {prev₁ prev₂ : Array Nat} {n : Nat} {P : Nat → Prop}
    (hagree : ∀ v, P v → prev₁.getD v n = prev₂.getD v n)
    (hclosed : ∀ v, P v → n ≤ prev₁.getD v n ∨ P (prev₁.getD v n)) :
    ∀ (fuel v : Nat) (acc : Array Nat), (v < n → P v) →
      reconGo prev₁ n fuel v acc = reconGo prev₂ n fuel v acc := by
  intro fuel
  induction fuel with
  | zero => intro v acc _; rfl
  | succ fuel ih =>
    intro v acc hPv
    unfold reconGo
    by_cases hvn : n ≤ v
    · rw [if_pos hvn, if_pos hvn]
    · have hP : P v := hPv (by omega)
      rw [if_neg hvn, if_neg hvn, hagree v hP]
      apply ih
      intro hlt
      rcases hclosed v hP with hge | hP'
      · rw [hagree v hP] at hge; omega
      · rwa [hagree v hP] at hP'

theorem qReconstruct_congr {prev₁ prev₂ : Array Nat} {start n : Nat} {P : Nat → Prop}
    (hstart : start < n → P start)
    (hagree : ∀ v, P v → prev₁.getD v n = prev₂.getD v n)
    (hclosed : ∀ v, P v → n ≤ prev₁.getD v n ∨ P (prev₁.getD v n)) :
    qReconstruct prev₁ start n = qReconstruct prev₂ start n := by
  unfold qReconstruct
  rw [reconGo_congr hagree hclosed n start #[] hstart]

/-! ### Cache purity, step 2: the reconstruction is resume-stable

The reconstructed chain to `tgt` is the same at a later trajectory point as at
the first stop: the target settled (its chain frozen and closed) or the search
terminated. Lifts `iter_stop_read_stable` from one vertex to the whole path. -/

/-- The reconstructed chain to `tgt` is identical at `iter (max m k)` and at
the fresh first-stop `iter k`. -/
theorem qReconstruct_resume_stable {g : Graph} {maxR src tgt k m : Nat}
    (hwf : WFEdges g) (hsrc : src < g.n)
    (hstop : stopAt tgt (iter g maxR k (linit g.n src)) = true) :
    qReconstruct (iter g maxR (Nat.max m k) (linit g.n src)).prev tgt g.n
      = qReconstruct (iter g maxR k (linit g.n src)).prev tgt g.n := by
  have hLinit : LInv g 0 (linit g.n src) := linit_inv hsrc
  by_cases hdone : (iter g maxR k (linit g.n src)).done.getD tgt false = true
  · -- Target settled: reconstruction walks only frozen, done vertices.
    have hbdsz : (iter g maxR k (linit g.n src)).done.size = g.n := by
      rw [iter_done_size, linit_done_size]
    have hdone_lt : ∀ v, (iter g maxR k (linit g.n src)).done.getD v false = true →
        v < g.n := by
      intro v hv
      rcases Nat.lt_or_ge v g.n with h | h
      · exact h
      · exfalso
        rw [Array.getD_eq_getD_getElem?,
          Array.getElem?_eq_none (by rw [hbdsz]; omega)] at hv
        exact absurd hv (by simp)
    obtain ⟨La, _, hLa⟩ := (iter_inv (maxR := maxR) hwf (Nat.max m k) hLinit).1
    obtain ⟨Lb, _, hLb⟩ := (iter_inv (maxR := maxR) hwf k hLinit).1
    have hPb : PInv g src (iter g maxR k (linit g.n src)) :=
      iter_pinv hwf k (linit_done_size g.n src) hLinit linit_pinv
    have hagree : ∀ v, (iter g maxR k (linit g.n src)).done.getD v false = true →
        (iter g maxR (Nat.max m k) (linit g.n src)).prev.getD v g.n
          = (iter g maxR k (linit g.n src)).prev.getD v g.n := by
      intro v hv
      have hvn := hdone_lt v hv
      have hfrz := iter_done_stable (maxR := maxR) hwf hLinit hv (Nat.max m k)
      have hmk : Nat.max (Nat.max m k) k = Nat.max m k :=
        Nat.max_eq_left (Nat.le_max_right m k)
      rw [hmk] at hfrz
      have hpa : (iter g maxR (Nat.max m k) (linit g.n src)).prev.getD v g.n
          = (iter g maxR (Nat.max m k) (linit g.n src)).prev.getD v 0 :=
        getD_lt_indep (by rw [hLa.psz]; exact hvn) g.n 0
      have hpb : (iter g maxR k (linit g.n src)).prev.getD v g.n
          = (iter g maxR k (linit g.n src)).prev.getD v 0 :=
        getD_lt_indep (by rw [hLb.psz]; exact hvn) g.n 0
      rw [hpa, hpb]; exact hfrz.2.1
    apply qReconstruct_congr
      (P := fun v => (iter g maxR k (linit g.n src)).done.getD v false = true)
    · exact fun _ => hdone
    · exact hagree
    · intro v hv
      rcases PInv.done_prev hPb hv hLb with hsent | hnext
      · have hag := hagree v hv
        exact Or.inl (by omega)
      · exact Or.inr (by rw [hagree v hv]; exact hnext)
  · -- Target never settled: the stop was a termination, hence a fixpoint.
    have hterm : lterminal (iter g maxR k (linit g.n src)) = true := by
      unfold stopAt at hstop
      rcases Bool.or_eq_true _ _ ▸ hstop with h | h
      · exact absurd h hdone
      · exact h
    have hcoin : iter g maxR (Nat.max m k) (linit g.n src)
        = iter g maxR k (linit g.n src) := by
      obtain ⟨d, hd⟩ : ∃ d, Nat.max m k = k + d :=
        ⟨Nat.max m k - k, (Nat.add_sub_cancel' (Nat.le_max_right m k)).symm⟩
      rw [hd, iter_add, iter_terminal_fix d hterm]
    rw [hcoin]

/-! ### Cache purity, step 3: `settleTo` reads-equality

The target `dist` and reconstructed chain `settleTo` returns from a valid cache
equal a fresh per-source settle's (`iter_stop_read_stable`,
`qReconstruct_resume_stable`), given `totalOut g + 1` fuel. -/

/-- `settleTo` reads-equality. Under `OnTrajCache` and sufficient fuel,
`settleTo`'s target-distance read and reconstructed chain equal the fresh
per-source settle's. -/
theorem settleTo_reads_eq {g : Graph} {maxR fuel src tgt : Nat} {c : RouteCache}
    (hwf : WFEdges g) (hsrc : src < g.n) (hfuel : totalOut g + 1 ≤ fuel)
    (hc : OnTrajCache g maxR g.n c) :
    (settleTo g maxR fuel g.n src tgt c).1.dist.getD tgt none
        = (lsettle g maxR tgt fuel (linit g.n src)).dist.getD tgt none ∧
    qReconstruct (settleTo g maxR fuel g.n src tgt c).1.prev tgt g.n
        = qReconstruct (lsettle g maxR tgt fuel (linit g.n src)).prev tgt g.n := by
  obtain ⟨m, hm⟩ : ∃ m, (c.getD src none).getD (linit g.n src)
      = iter g maxR m (linit g.n src) := by
    cases hcs : c.getD src none with
    | none => exact ⟨0, rfl⟩
    | some s0 => obtain ⟨m, hm0⟩ := hc src s0 hcs; exact ⟨m, hm0⟩
  obtain ⟨k, hkf, hlseq, hmin, -⟩ := lsettle_spec g maxR tgt fuel (linit g.n src)
  have hstop : stopAt tgt (iter g maxR k (linit g.n src)) = true := by
    have hs0 := lsettle_stops (g := g) (maxR := maxR) (t := tgt) (src := src)
      (m := 0) (fuel := fuel) hfuel
    rw [show iter g maxR 0 (linit g.n src) = linit g.n src from rfl, hlseq] at hs0
    exact hs0
  have hS1 : (settleTo g maxR fuel g.n src tgt c).1
      = iter g maxR (Nat.max m k) (linit g.n src) := by
    rw [settleTo_fst, hm]
    exact lsettle_from_iter (m := m) hkf hstop hmin
  rw [hS1, hlseq]
  exact ⟨(iter_stop_read_stable hwf (linit_inv hsrc) hstop m).1,
    qReconstruct_resume_stable hwf hsrc hstop⟩

def qOffsetFactor (bld : Option QBuildings) (gr : QGraph) (c : QCand) (vid : Nat) : Nat :=
  match bld with
  | some bl => bl.factor (candPt c) (gr.vertices.getD vid default)
  | none => 1

/-- The routed polyline for one combo: the source foot `candPt a`, the
reconstructed interior vertices, the target foot `candPt b`, then the
`0.5 m` dedupe. A pure function of the reconstructed `idPath`. -/
def buildVerts (a b : QCand) (gr : QGraph) (idPath : Array Nat) : Array QPt :=
  let verts := (idPath.foldl (fun acc vid => acc.push (gr.vertices.getD vid default))
    #[candPt a]).push (candPt b)
  (qDedupe (fun i => verts.getD i default) verts.size).toArray

/-- One endpoint combo of `routeBetween`: settle `ae.1 → be.1`, threading the
cache, and keep the strictly lighter well-formed route in `best`. -/
def comboStep (a b : QCand) (gr : QGraph) (n maxR fuel : Nat)
    (acc : Option (Int × Array QPt) × RouteCache)
    (combo : (Nat × Int) × (Nat × Int)) : Option (Int × Array QPt) × RouteCache :=
  let best := acc.1
  let ae := combo.1
  let be := combo.2
  let (st, c') := settleTo gr.g maxR fuel n ae.1 be.1 acc.2
  match st.dist.getD be.1 none with
  | none => (best, c')
  | some mid =>
    let weighted : Int := ae.2 + (mid : Int) + be.2
    let worse := match best with | some (bw, _) => decide (weighted ≥ bw) | none => false
    if worse then (best, c')
    else
      let idPath := qReconstruct st.prev be.1 n
      if idPath.size == 0 || idPath.getD 0 0 ≠ ae.1 then (best, c')
      else (some (weighted, buildVerts a b gr idPath), c')

/-- The four endpoint combos `{sa.u, sa.v} × {sb.u, sb.v}` with their
`S`-scaled offsets, in a fixed order. -/
def routeCombos (a b : QCand) (sa sb : QSeg) (gr : QGraph) (bld : Option QBuildings)
    (S : Nat) : List ((Nat × Int) × (Nat × Int)) :=
  let aEnds : Array (Nat × Int) := #[
    (sa.u, roundDiv (a.tn * (sa.lenUm : Int)) a.td * (qOffsetFactor bld gr a sa.u : Int) * (S : Int)),
    (sa.v, roundDiv ((a.td - a.tn) * (sa.lenUm : Int)) a.td * (qOffsetFactor bld gr a sa.v : Int) * (S : Int))]
  let bEnds : Array (Nat × Int) := #[
    (sb.u, roundDiv (b.tn * (sb.lenUm : Int)) b.td * (qOffsetFactor bld gr b sb.u : Int) * (S : Int)),
    (sb.v, roundDiv ((b.td - b.tn) * (sb.lenUm : Int)) b.td * (qOffsetFactor bld gr b sb.v : Int) * (S : Int))]
  [(aEnds.getD 0 default, bEnds.getD 0 default),
   (aEnds.getD 0 default, bEnds.getD 1 default),
   (aEnds.getD 1 default, bEnds.getD 0 default),
   (aEnds.getD 1 default, bEnds.getD 1 default)]

/-- The route between two candidates. Offsets and the same-segment hop are µm
via `roundDiv`, lifted into the `S`-scaled domain for the four endpoint combos;
the reported distance is the winning polyline's true length. The combos are a
`List.foldl` of `comboStep`, the form the purity proof inducts over. -/
def qRouteBetween (a b : QCand) (gr : QGraph) (bld : Option QBuildings)
    (S maxR fuel : Nat) (cache : RouteCache) :
    Option (Int × Array QPt) × RouteCache :=
  let sa := gr.segments.getD a.si default
  let sb := gr.segments.getD b.si default
  let bfSame : Nat := match bld with | some bl => bl.factor (candPt a) (candPt b) | none => 1
  let distUmSame : Int := roundDiv (((b.tn - a.tn).natAbs : Int) * (sa.lenUm : Int)) a.td
  if sa.u == sb.u && sa.v == sb.v && bfSame == 1 then
    (some (distUmSame, #[candPt a, candPt b]), cache)
  else
    let best0 : Option (Int × Array QPt) :=
      if sa.u == sb.u && sa.v == sb.v then
        some (distUmSame * (S : Int) * (bfSame : Int), #[candPt a, candPt b])
      else none
    let res := (routeCombos a b sa sb gr bld S).foldl
      (comboStep a b gr gr.vertices.size maxR fuel) (best0, cache)
    match res.1 with
    | some (_, verts) => (some ((qPathLength verts : Int), verts), res.2)
    | none => (none, res.2)

/-! ### Cache purity, step 4: `comboStep`, the fold, and the route result

`comboStep` preserves `OnTrajCache` (`comboStep_onTraj`) and reads the cache
only through cache-invariant values (`settleTo_reads_eq`), so its `best` does
not depend on the cache (`comboStep_best_indep`). Folded over the combos this
gives `qRouteBetween_route_pure`. -/

/-- The `best`-update `comboStep` computes from an already-settled state,
factored out so the `best` output is visibly a function of the target `dist`
and the reconstructed chain — the two reads `settleTo_reads_eq` pins. -/
def comboBest (a b : QCand) (gr : QGraph) (n : Nat)
    (best : Option (Int × Array QPt))
    (combo : (Nat × Int) × (Nat × Int)) (st : LState) : Option (Int × Array QPt) :=
  match st.dist.getD combo.2.1 none with
  | none => best
  | some mid =>
    let weighted : Int := combo.1.2 + (mid : Int) + combo.2.2
    let worse := match best with | some (bw, _) => decide (weighted ≥ bw) | none => false
    if worse then best
    else
      let idPath := qReconstruct st.prev combo.2.1 n
      if idPath.size == 0 || idPath.getD 0 0 ≠ combo.1.1 then best
      else some (weighted, buildVerts a b gr idPath)

/-- `comboStep`'s `best` output is `comboBest` applied to the settled state. -/
theorem comboStep_fst {a b : QCand} {gr : QGraph} {n maxR fuel : Nat}
    {acc : Option (Int × Array QPt) × RouteCache}
    {combo : (Nat × Int) × (Nat × Int)} :
    (comboStep a b gr n maxR fuel acc combo).1
      = comboBest a b gr n acc.1 combo
          (settleTo gr.g maxR fuel n combo.1.1 combo.2.1 acc.2).1 := by
  unfold comboStep comboBest
  dsimp only
  repeat' split
  all_goals rfl

/-- `comboStep`'s cache output is `settleTo`'s (every branch returns it). -/
theorem comboStep_snd {a b : QCand} {gr : QGraph} {n maxR fuel : Nat}
    {acc : Option (Int × Array QPt) × RouteCache}
    {combo : (Nat × Int) × (Nat × Int)} :
    (comboStep a b gr n maxR fuel acc combo).2
      = (settleTo gr.g maxR fuel n combo.1.1 combo.2.1 acc.2).2 := by
  unfold comboStep
  dsimp only
  repeat' split
  all_goals rfl

/-- `comboStep` preserves the on-trajectory cache invariant. -/
theorem comboStep_onTraj {a b : QCand} {gr : QGraph} {n maxR fuel : Nat}
    {acc : Option (Int × Array QPt) × RouteCache}
    {combo : (Nat × Int) × (Nat × Int)}
    (hc : OnTrajCache gr.g maxR n acc.2) :
    OnTrajCache gr.g maxR n (comboStep a b gr n maxR fuel acc combo).2 := by
  rw [comboStep_snd]; exact settleTo_onTraj hc

/-- `comboStep`'s `best` output is independent of which valid cache it
threads: both resolve to the fresh per-source settle's reads. -/
theorem comboStep_best_indep {a b : QCand} {gr : QGraph} {n maxR fuel : Nat}
    {best : Option (Int × Array QPt)} {c₁ c₂ : RouteCache}
    {combo : (Nat × Int) × (Nat × Int)}
    (hwf : WFEdges gr.g) (hfuel : totalOut gr.g + 1 ≤ fuel) (hn : n = gr.g.n)
    (hsrc : combo.1.1 < gr.g.n)
    (hc₁ : OnTrajCache gr.g maxR n c₁) (hc₂ : OnTrajCache gr.g maxR n c₂) :
    (comboStep a b gr n maxR fuel (best, c₁) combo).1
      = (comboStep a b gr n maxR fuel (best, c₂) combo).1 := by
  subst hn
  rw [comboStep_fst, comboStep_fst]
  have hd₁ := settleTo_reads_eq (g := gr.g) (maxR := maxR) (fuel := fuel)
    (src := combo.1.1) (tgt := combo.2.1) (c := c₁) hwf hsrc hfuel hc₁
  have hd₂ := settleTo_reads_eq (g := gr.g) (maxR := maxR) (fuel := fuel)
    (src := combo.1.1) (tgt := combo.2.1) (c := c₂) hwf hsrc hfuel hc₂
  unfold comboBest
  dsimp only
  rw [hd₁.1, hd₁.2, hd₂.1, hd₂.2]

/-- Folding `comboStep` over the combos from a valid cache gives a `best`
independent of the cache. -/
theorem comboFold_best_indep {a b : QCand} {gr : QGraph} {n maxR fuel : Nat}
    (hwf : WFEdges gr.g) (hfuel : totalOut gr.g + 1 ≤ fuel) (hn : n = gr.g.n) :
    ∀ (combos : List ((Nat × Int) × (Nat × Int)))
      (best : Option (Int × Array QPt)) (c₁ c₂ : RouteCache),
      OnTrajCache gr.g maxR n c₁ → OnTrajCache gr.g maxR n c₂ →
      (∀ combo ∈ combos, combo.1.1 < gr.g.n) →
      (combos.foldl (comboStep a b gr n maxR fuel) (best, c₁)).1
        = (combos.foldl (comboStep a b gr n maxR fuel) (best, c₂)).1 := by
  intro combos
  induction combos with
  | nil => intro best c₁ c₂ _ _ _; rfl
  | cons combo rest ih =>
    intro best c₁ c₂ hc₁ hc₂ hsrc
    rw [List.foldl_cons, List.foldl_cons]
    have hbest := comboStep_best_indep (a := a) (b := b) (best := best)
      (combo := combo) hwf hfuel hn (hsrc combo (List.mem_cons_self ..)) hc₁ hc₂
    have hv₁ := comboStep_onTraj (a := a) (b := b) (n := n) (maxR := maxR)
      (fuel := fuel) (acc := (best, c₁)) (combo := combo) hc₁
    have hv₂ := comboStep_onTraj (a := a) (b := b) (n := n) (maxR := maxR)
      (fuel := fuel) (acc := (best, c₂)) (combo := combo) hc₂
    have hsrc' : ∀ combo ∈ rest, combo.1.1 < gr.g.n :=
      fun combo hc => hsrc combo (List.mem_cons_of_mem _ hc)
    have key := ih (comboStep a b gr n maxR fuel (best, c₁) combo).1
      (comboStep a b gr n maxR fuel (best, c₁) combo).2
      (comboStep a b gr n maxR fuel (best, c₂) combo).2 hv₁ hv₂ hsrc'
    refine Eq.trans key ?_
    rw [hbest]

/-- Route-result purity. `qRouteBetween`'s route result is the same for
any two valid caches — it is a pure function of the graph, not of the
trellis's fill order. -/
theorem qRouteBetween_route_pure {a b : QCand} {gr : QGraph}
    {bld : Option QBuildings} {S maxR fuel : Nat} {c₁ c₂ : RouteCache}
    (hwf : WFEdges gr.g) (hfuel : totalOut gr.g + 1 ≤ fuel)
    (hn : gr.vertices.size = gr.g.n)
    (hsrc : ∀ combo ∈ routeCombos a b (gr.segments.getD a.si default)
      (gr.segments.getD b.si default) gr bld S, combo.1.1 < gr.g.n)
    (hc₁ : OnTrajCache gr.g maxR gr.vertices.size c₁)
    (hc₂ : OnTrajCache gr.g maxR gr.vertices.size c₂) :
    (qRouteBetween a b gr bld S maxR fuel c₁).1
      = (qRouteBetween a b gr bld S maxR fuel c₂).1 := by
  unfold qRouteBetween
  cases bld with
  | none =>
    dsimp only
    split
    · rfl
    · rw [comboFold_best_indep hwf hfuel hn
        (routeCombos a b (gr.segments.getD a.si default)
          (gr.segments.getD b.si default) gr none S)
        _ c₁ c₂ hc₁ hc₂ hsrc]
      split <;> rfl
  | some bl =>
    dsimp only
    split
    · rfl
    · rw [comboFold_best_indep hwf hfuel hn
        (routeCombos a b (gr.segments.getD a.si default)
          (gr.segments.getD b.si default) gr (some bl) S)
        _ c₁ c₂ hc₁ hc₂ hsrc]
      split <;> rfl

/-! ## Trajectory Viterbi + walk pipeline (part 3) -/

/-- `WALK_PROFILE` in the pinned representation (`QMatchProfile`). -/
structure QMatchProfile where
  minFixes : Nat
  radiusUm : Nat
  maxCandidatesPerFix : Nat
  sigmaUm : Nat
  betaUm : Nat
  gapBridgeUm : Nat
  detourFactor : Nat
  detourSlackUm : Nat
  maxLenNum : Nat
  maxLenDen : Nat
  maxLenSlackUm : Nat
  maxRoadlessNum : Nat
  maxRoadlessDen : Nat
  corridorNearUm : Nat
  corridorFarUm : Nat
  corridorMaxPenalty : Nat
  wayContinuityNats : Nat
  spurReturnUm : Nat
  spurMaxSpanVerts : Nat
  simplifyTolUm : Nat
  buildingCrossFactor : Nat
  buildingSupportUm : Nat
  /-- When attributing route length per way name (`QMatchResult.wayUm`), an
  edge on an unnamed way is charged to the nearest named way within this
  distance; 0 disables. OSM maps a pavement as its own, usually unnamed, way,
  so without it the street a walk follows loses its metres. -/
  nameBorrowUm : Nat := 0

def WALK_QPROFILE : QMatchProfile :=
  { minFixes := 3, radiusUm := 20000000, maxCandidatesPerFix := 6
    sigmaUm := 8000000, betaUm := 12000000, gapBridgeUm := 18000000
    detourFactor := 4, detourSlackUm := 250000000
    maxLenNum := 7, maxLenDen := 5, maxLenSlackUm := 200000000
    maxRoadlessNum := 2, maxRoadlessDen := 5
    corridorNearUm := 25000000, corridorFarUm := 80000000, corridorMaxPenalty := 40
    wayContinuityNats := 0, spurReturnUm := 25000000, spurMaxSpanVerts := 4
    simplifyTolUm := 5000000, buildingCrossFactor := 25, buildingSupportUm := 15000000
    nameBorrowUm := 30000000 }

/-- The road tuning in the pinned representation, of which `WALK_QPROFILE` is a
delta.

`wayContinuityNats := 5` is the road turn prior: a way change costs 5 nats,
keeping a drive on its street when fixes drift onto a parallel service road.
`buildingCrossFactor := 1` turns buildings off: a vehicle under a bridge deck
is not a routing error. -/
def ROAD_QPROFILE : QMatchProfile :=
  { minFixes := 3, radiusUm := 50000000, maxCandidatesPerFix := 5
    sigmaUm := 12000000, betaUm := 10000000, gapBridgeUm := 8000000
    detourFactor := 4, detourSlackUm := 250000000
    maxLenNum := 9, maxLenDen := 5, maxLenSlackUm := 200000000
    maxRoadlessNum := 2, maxRoadlessDen := 5
    corridorNearUm := 25000000, corridorFarUm := 80000000, corridorMaxPenalty := 40
    wayContinuityNats := 5, spurReturnUm := 25000000, spurMaxSpanVerts := 4
    simplifyTolUm := 5000000, buildingCrossFactor := 1, buildingSupportUm := 0 }

/-- The corridor grid's entry budget: thirty-five times the corpus's largest
(2,845, a 195-fix drive), and near 10 MB of grid. A mislabelled train stretch
reaches millions. -/
def CORRIDOR_MAX_ENTRIES : Nat := 100000

structure QObs where
  fix : QPt
  cands : Array QCand
  deriving Inhabited

structure QMatchResult where
  path : Array QPt
  routeDetail : Array QPt
  /-- Arc length per way name along the chosen route, in `qDist` units: the
  identity the matcher resolved, so naming need not guess by nearest neighbour.
  `none` collects unnamed ways; gap bridges are charged to nothing. -/
  wayUm : Array (Option String × Nat) := #[]
  deriving Inhabited, BEq

structure QWalkMatchResult where
  path : Array QPt
  coarsePath : Array QPt
  /-- `QMatchResult.wayUm`, passed through untouched. -/
  wayUm : Array (Option String × Nat) := #[]
  deriving Inhabited

/-- Time-interpolate a route's vertices onto `out` by cumulative arc
length (`qAppendInterpolated`). -/
def qAppendInterpolated (out verts : Array QPt) (startTs endTs : Int) : Array QPt := Id.run do
  if verts.size == 0 then return out
  let mut cum : Array Nat := #[0]
  for i in [1:verts.size] do
    cum := cum.push (cum.getD (i - 1) 0 + qDist (verts.getD (i - 1) default) (verts.getD i default))
  let total := cum.getD (verts.size - 1) 0
  let mut o := out
  for i in [1:verts.size] do
    let v := verts.getD i default
    let ts : Int := if total > 0 then startTs + roundDiv ((endTs - startTs) * (cum.getD i 0 : Int)) (total : Int) else endTs
    o := o.push { la := v.la, lo := v.lo, ts }
  return o

/-- Match a trajectory: candidate generation, the `2σ²β`-scaled Viterbi over
`qRouteBetween`, interpolation, then simplify, spur removal and length bail. -/
def qMatchTrajectory (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) (P : QMatchProfile) : Option QMatchResult := Id.run do
  if fixes.size < P.minFixes then return none
  -- A corridor whose grid would exceed the budget is declined and the leg drawn
  -- from its fixes: fixes kilometres apart give nothing to hold to, and the grid
  -- grows with the square of the gap.
  if corridorEntries fixes P.corridorFarUm > CORRIDOR_MAX_ENTRIES then return none
  let co := mkQCorridor fixes P.corridorNearUm P.corridorFarUm P.corridorMaxPenalty
  let bld : Option QBuildings :=
    if P.buildingCrossFactor > 1 && buildings.size > 0 then
      some (mkQBuildings buildings fixes P.buildingCrossFactor P.buildingSupportUm)
    else none
  let graph := buildQGraphFast ways co bld P.gapBridgeUm
  if graph.segments.size == 0 then return none

  let segIdx := mkQSegIndex graph P.radiusUm co.cmin
  let mut obs : Array QObs := #[]
  let mut roadless : Nat := 0
  for fix in fixes do
    let cands := qCandidatesForFixFast fix graph segIdx P.radiusUm P.maxCandidatesPerFix
    if cands.size == 0 then roadless := roadless + 1
    else obs := obs.push { fix, cands }
  if roadless * P.maxRoadlessDen > fixes.size * P.maxRoadlessNum then return none
  if obs.size < P.minFixes then return none

  let mut maxStep : Nat := 0
  for i in [1:obs.size] do
    let d := qDist (obs.getD (i - 1) default).fix (obs.getD i default).fix
    if d > maxStep then maxStep := d
  let S := co.S
  let maxR := (maxStep * P.detourFactor + P.detourSlackUm) * P.corridorMaxPenalty * S

  -- The per-source lazy-Dijkstra cache, threaded through the trellis.
  let n := graph.vertices.size
  let fuel := totalOut graph.g + 1
  let mut routeCache : RouteCache := Array.replicate n none
  -- The sources whose cache entry may be `some` — kept from the last layer.
  let mut live : Array Nat := #[]

  -- Score scale 2σ²β. null = −∞ (modelled as `Option Int`, `none`).
  let sig2x2 := 2 * P.sigmaUm * P.sigmaUm
  let switchPenScaled : Int := (P.wayContinuityNats * sig2x2 * P.betaUm : Nat)
  let emissionScaled := fun (d : Nat) => -((d * d * P.betaUm : Nat) : Int)

  let nObs := obs.size

  -- Phase A: the route matrix `routeOf[t-1][j][i]`, filled in the trellis's
  -- `(t, j, i)` order, so the edge weights are read from a finished array
  -- (`qRouteBetween_route_pure`: the order does not matter).
  let mut routeAcc : Array (Array (Array (Option (Int × Array QPt)))) := #[]
  for t in [1:nObs] do
    let prev := obs.getD (t - 1) default
    let cur := obs.getD t default
    let mut rmat : Array (Array (Option (Int × Array QPt))) := #[]
    for j in [0:cur.cands.size] do
      let mut rrow : Array (Option (Int × Array QPt)) := #[]
      for i in [0:prev.cands.size] do
        let (route, rc) := qRouteBetween (prev.cands.getD i default) (cur.cands.getD j default)
          graph bld S maxR fuel routeCache
        routeCache := rc
        rrow := rrow.push route
      rmat := rmat.push rrow
    routeAcc := routeAcc.push rmat
    -- Drop cached searches whose source is not an endpoint of this layer's
    -- candidates: each `LState` holds three arrays of `n`, so an unbounded
    -- cache grows to hundreds of MiB. Value-preserving by
    -- `qRouteBetween_route_pure`; only re-use across non-adjacent layers is lost.
    let keep : Array Nat := cur.cands.foldl (init := #[]) fun acc c =>
      let s := graph.segments.getD c.si default
      (acc.push s.u).push s.v
    -- Only an entry this layer searched from, or one kept before, can be
    -- `some`: clear those not kept, without rebuilding all `n` entries.
    let sources : Array Nat := prev.cands.foldl (init := live) fun acc c =>
      let s := graph.segments.getD c.si default
      (acc.push s.u).push s.v
    live := #[]
    for src in sources do
      if keep.contains src then
        if !live.contains src then live := live.push src
      else routeCache := routeCache.setIfInBounds src none
  let routeOf := routeAcc

  -- Phase B: the first-order max-sum trellis (`MatchViterbi`). Node score is
  -- the `2σ²β`-scaled emission, edge weight is transition minus switch penalty
  -- (`-∞` when unrouteable). The verified `decodeFast` picks the chain
  -- (`decodeFast_argmax`); `none` means no chain scores finitely.
  let Tr : MatchViterbi.Trellis := {
    T := nObs
    width := fun t => (obs.getD t default).cands.size
    emit := fun t j =>
      Verified.Hsmm.Score.val (emissionScaled ((obs.getD t default).cands.getD j default).dist)
    step := fun t i j =>
      match ((routeOf.getD (t - 1) #[]).getD j #[]).getD i none with
      | none => Verified.Hsmm.Score.negInf
      | some (distUm, _) =>
        let prev := obs.getD (t - 1) default
        let cur := obs.getD t default
        let gpsStep := qDist prev.fix cur.fix
        let trans : Int := -(((distUm - (gpsStep : Int)).natAbs : Int) * (sig2x2 : Int))
        let wa := (graph.segments.getD (prev.cands.getD i default).si default).name
        let wb := (graph.segments.getD (cur.cands.getD j default).si default).name
        let switchPen : Int :=
          match wa, wb with
          | some sa, some sb => if sa ≠ "" && sb ≠ "" && sa ≠ sb then switchPenScaled else 0
          | _, _ => 0
        Verified.Hsmm.Score.val (trans - switchPen) }
  let decoded := MatchViterbi.decodeFast Tr
  if decoded.isNone then return none
  let chosen : Array Nat := (decoded.getD []).toArray

  -- Assemble the route detail, attributing each edge to its way. Interior
  -- edges are looked up by exact endpoint coordinates. A hop's first and last
  -- edges touch a candidate foot, not a vertex, so they are charged to the
  -- segment the candidate projected onto (`QCand.si`); a middle edge that
  -- misses is a gap bridge and is charged to nothing.
  let mut edgeName : Std.HashMap (Int × Int × Int × Int) (Option String) := ∅
  for s in graph.segments do
    let u := graph.vertices.getD s.u default
    let v := graph.vertices.getD s.v default
    edgeName := edgeName.insert (u.la, u.lo, v.la, v.lo) s.name
    edgeName := edgeName.insert (v.la, v.lo, u.la, u.lo) s.name
  let addUm := fun (acc : Array (Option String × Nat)) (n : Option String) (d : Nat) =>
    match acc.findIdx? (fun p => p.1 == n) with
    | some i => acc.set! i (n, (acc.getD i default).2 + d)
    | none => acc.push (n, d)
  -- The per-edge name borrow (`P.nameBorrowUm`): the nearest named segment
  -- within the bar of the edge's midpoint, over the 3×3 cell block since the
  -- cells are sized for the 20 m radius and the bar is 30 m. A tie keeps the
  -- lower index.
  let borrowName := fun (pt qt : QPt) => Id.run do
    let mid : QPt := { la := (pt.la + qt.la) / 2, lo := (pt.lo + qt.lo) / 2, ts := 0 }
    let cy := mid.la.fdiv segIdx.cellLa
    let cx := mid.lo.fdiv segIdx.cellLo
    let mut best : Option (Nat × Nat) := none
    for dy in [0:3] do
      for dx in [0:3] do
        let bucket := segIdx.grid.getD (cellKeyN (cy + (dy : Int) - 1) (cx + (dx : Int) - 1)) #[]
        for si in bucket do
          let sSeg := graph.segments.getD si default
          match sSeg.name with
          | some nm =>
            if nm == "" then continue
            let a := graph.vertices.getD sSeg.u default
            let b := graph.vertices.getD sSeg.v default
            if latGapUm mid a b > P.nameBorrowUm then continue
            let d := (qProject mid a b).dist
            if d ≤ P.nameBorrowUm then
              match best with
              | none => best := some (si, d)
              | some (bsi, bd) =>
                if d < bd || (d == bd && si < bsi) then best := some (si, d)
          | none => continue
    return best.bind fun (si, _) => (graph.segments.getD si default).name
  let mut wayUm : Array (Option String × Nat) := #[]
  let first := (obs.getD 0 default).cands.getD (chosen.getD 0 0) default
  let mut out : Array QPt := #[{ la := first.la, lo := first.lo, ts := (obs.getD 0 default).fix.ts }]
  for t in [1:nObs] do
    match ((routeOf.getD (t - 1) #[]).getD (chosen.getD t 0) #[]).getD (chosen.getD (t - 1) 0) none with
    | none => return none
    | some (_, verts) =>
      let segName := fun (cand : QCand) => (graph.segments.getD cand.si default).name
      let sa := segName ((obs.getD (t - 1) default).cands.getD (chosen.getD (t - 1) 0) default)
      let sb := segName ((obs.getD t default).cands.getD (chosen.getD t 0) default)
      for k in [1:verts.size] do
        let p := verts.getD (k - 1) default
        let q := verts.getD k default
        let attributed : Option (Option String) :=
          match edgeName.get? (p.la, p.lo, q.la, q.lo) with
          | some n => some n
          | none =>
            if k == 1 then some sa
            else if k == verts.size - 1 then some sb
            else none
        match attributed with
        | some n =>
          let n := if n.isNone && P.nameBorrowUm > 0 then borrowName p q else n
          wayUm := addUm wayUm n (qDist p q)
        | none => pure ()
      out := qAppendInterpolated out verts (obs.getD (t - 1) default).fix.ts (obs.getD t default).fix.ts

  let simplified := ((qSimplify (fun i => out.getD i default) out.size P.simplifyTolUm).map
    (fun i => out.getD i default))
  let cleaned := qRemoveSpurs P.spurReturnUm P.spurMaxSpanVerts simplified
  if cleaned.length < 2 then return none
  let cleanedArr := cleaned.toArray
  let rawLen := qPathLength fixes
  if qPathLength cleanedArr * P.maxLenDen > rawLen * P.maxLenNum + P.maxLenSlackUm * P.maxLenDen then
    return none
  return some { path := cleanedArr, routeDetail := out, wayUm }

/-- Match a walk leg: the walk profile, then trim, despike and splice. -/
def qMatchWalkSegment (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) : Option QWalkMatchResult := Id.run do
  match qMatchTrajectory fixes ways buildings WALK_QPROFILE with
  | none => return none
  | some r =>
    let trimmed := (qTrim (fun i => fixes.getD i default) fixes.size
      (fun i => r.path.getD i default) r.path.size).toArray
    let cleaned := (qDespike 15000000 12000000 fixes.toList
      (fun i => trimmed.getD i default) trimmed.size).toArray
    let path := (qSplice (fun i => r.routeDetail.getD i default) r.routeDetail.size
      1500000 WALK_QPROFILE.simplifyTolUm (fun i => cleaned.getD i default) cleaned.size).toArray
    return some { path, coarsePath := cleaned, wayUm := r.wayUm }

/-- A road leg's match: the trajectory match with no trim, despike or splice,
so the leg is drawn as the Viterbi routed it. `radiusUm` overrides the
profile's 50 m. `none` means draw the raw fixes, never an invented path. -/
def qMatchRoadSegment (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) (radiusUm : Option Nat := none) : Option QMatchResult :=
  let P := match radiusUm with
    | some r => { ROAD_QPROFILE with radiusUm := r }
    | none => ROAD_QPROFILE
  qMatchTrajectory fixes ways buildings P

/-! ## Honesty corollaries

The matcher never fabricates geometry: its display tail (`qTrim → qDespike →
qSplice`) only re-inserts real vertices near the coarse line.

- `qMatchWalkSegment_coarse_drop_only`: every `coarsePath` vertex is a vertex
  of the trajectory path (trim and despike only drop).
- `qMatchWalkSegment_path_sound`: every drawn vertex is a `coarsePath` vertex
  or a route vertex within the splice `dropM` (5 m) of its coarse chord.

Both are corollary-grade — the flagship is the Viterbi argmax below. The
`qMatchWalkSegment_eq` bridge isolates the one `Id.run do` reduction so the
tail lemmas reason over plain terms. -/

/-- Membership through `getD` over the index range lands in the array. -/
private theorem mem_range_map_getD {α : Type} [Inhabited α] (arr : Array α)
    {v : α} (h : v ∈ (List.range arr.size).map (fun i => arr.getD i default)) :
    v ∈ arr.toList := by
  simp only [List.mem_map, List.mem_range] at h
  obtain ⟨i, hi, rfl⟩ := h
  rw [Array.getD_eq_getD_getElem?, Array.getElem?_eq_getElem hi, Option.getD_some]
  exact Array.getElem_mem_toList hi

/-- `qMatchWalkSegment` in pure form: `qMatchTrajectory` mapped through the
trim / despike / splice tail (the sole `Id.run do` reduction, done once). -/
theorem qMatchWalkSegment_eq (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) :
    qMatchWalkSegment fixes ways buildings =
      (qMatchTrajectory fixes ways buildings WALK_QPROFILE).map (fun r =>
        let trimmed := (qTrim (fun i => fixes.getD i default) fixes.size
          (fun i => r.path.getD i default) r.path.size).toArray
        let cleaned := (qDespike 15000000 12000000 fixes.toList
          (fun i => trimmed.getD i default) trimmed.size).toArray
        let path := (qSplice (fun i => r.routeDetail.getD i default) r.routeDetail.size
          1500000 WALK_QPROFILE.simplifyTolUm (fun i => cleaned.getD i default) cleaned.size).toArray
        ({ path, coarsePath := cleaned, wayUm := r.wayUm } : QWalkMatchResult)) := by
  unfold qMatchWalkSegment
  cases qMatchTrajectory fixes ways buildings WALK_QPROFILE <;> rfl

/-- The trim → despike tail is drop-only: its coarse output is a
subsequence of the trajectory path it refines. -/
theorem walkTail_coarse_sub (fixes rp : Array QPt) :
    ∀ v ∈ ((qDespike 15000000 12000000 fixes.toList
        (fun i => (qTrim (fun i => fixes.getD i default) fixes.size
          (fun i => rp.getD i default) rp.size).toArray.getD i default)
        (qTrim (fun i => fixes.getD i default) fixes.size
          (fun i => rp.getD i default) rp.size).toArray.size).toArray).toList,
      v ∈ rp.toList := by
  intro v hv
  rw [List.toList_toArray] at hv
  have h2 := (qDespike_sublist 15000000 12000000 fixes.toList
    (fun i => (qTrim (fun i => fixes.getD i default) fixes.size
      (fun i => rp.getD i default) rp.size).toArray.getD i default)
    (qTrim (fun i => fixes.getD i default) fixes.size
      (fun i => rp.getD i default) rp.size).toArray.size).subset hv
  have h3 := mem_range_map_getD (qTrim (fun i => fixes.getD i default) fixes.size
    (fun i => rp.getD i default) rp.size).toArray h2
  rw [List.toList_toArray] at h3
  have h5 := (qTrim_sublist (fun i => fixes.getD i default) fixes.size
    (fun i => rp.getD i default) rp.size).subset h3
  exact mem_range_map_getD rp h5

/-- Every `coarsePath` vertex is a trajectory-path vertex. -/
theorem qMatchWalkSegment_coarse_drop_only (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) {res : QWalkMatchResult}
    (h : qMatchWalkSegment fixes ways buildings = some res) :
    ∃ r, qMatchTrajectory fixes ways buildings WALK_QPROFILE = some r ∧
      ∀ v ∈ res.coarsePath.toList, v ∈ r.path.toList := by
  rw [qMatchWalkSegment_eq] at h
  cases hm : qMatchTrajectory fixes ways buildings WALK_QPROFILE with
  | none => rw [hm] at h; simp at h
  | some r =>
    rw [hm] at h
    rw [Option.map_some, Option.some.injEq] at h
    subst h
    exact ⟨r, rfl, walkTail_coarse_sub fixes r.path⟩

/-- The splice tail is sound: every drawn vertex is a coarse vertex or a
clamped route vertex within `simplifyTolUm` (5 m — the splice `dropM`) of
the coarse chord it spans. -/
theorem walkTail_path_sound (fixes : Array QPt) (r : QMatchResult) :
    let cleaned := (qDespike 15000000 12000000 fixes.toList
      (fun i => (qTrim (fun i => fixes.getD i default) fixes.size
        (fun i => r.path.getD i default) r.path.size).toArray.getD i default)
      (qTrim (fun i => fixes.getD i default) fixes.size
        (fun i => r.path.getD i default) r.path.size).toArray.size).toArray
    ∀ v ∈ (qSplice (fun i => r.routeDetail.getD i default) r.routeDetail.size
        1500000 WALK_QPROFILE.simplifyTolUm (fun i => cleaned.getD i default) cleaned.size).toArray.toList,
      (∃ i, i < cleaned.size ∧ v = cleaned.getD i default) ∨
      ∃ i j, 1 ≤ i ∧ i < cleaned.size ∧ j < r.routeDetail.size ∧
        v = qClampTs (cleaned.getD (i - 1) default) (cleaned.getD i default)
              (r.routeDetail.getD j default) ∧
        qChordDist (r.routeDetail.getD j default)
          (cleaned.getD (i - 1) default) (cleaned.getD i default) ≤ WALK_QPROFILE.simplifyTolUm := by
  intro cleaned v hv
  rw [List.toList_toArray] at hv
  have hs := qSplice_sound (fun i => r.routeDetail.getD i default) r.routeDetail.size
    1500000 WALK_QPROFILE.simplifyTolUm (fun i => cleaned.getD i default) cleaned.size v hv
  simpa using hs

/-- Every drawn `path` vertex is a `coarsePath` vertex or a clamped route
vertex within `simplifyTolUm` (5 m) of the coarse chord (no fabricated
geometry). -/
theorem qMatchWalkSegment_path_sound (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) {res : QWalkMatchResult}
    (h : qMatchWalkSegment fixes ways buildings = some res) :
    ∃ r, qMatchTrajectory fixes ways buildings WALK_QPROFILE = some r ∧
      ∀ v ∈ res.path.toList,
        (∃ i, i < res.coarsePath.size ∧ v = res.coarsePath.getD i default) ∨
        ∃ i j, 1 ≤ i ∧ i < res.coarsePath.size ∧ j < r.routeDetail.size ∧
          v = qClampTs (res.coarsePath.getD (i - 1) default) (res.coarsePath.getD i default)
                (r.routeDetail.getD j default) ∧
          qChordDist (r.routeDetail.getD j default)
            (res.coarsePath.getD (i - 1) default) (res.coarsePath.getD i default) ≤ WALK_QPROFILE.simplifyTolUm := by
  rw [qMatchWalkSegment_eq] at h
  cases hm : qMatchTrajectory fixes ways buildings WALK_QPROFILE with
  | none => rw [hm] at h; simp at h
  | some r =>
    rw [hm] at h
    rw [Option.map_some, Option.some.injEq] at h
    subst h
    exact ⟨r, rfl, walkTail_path_sound fixes r⟩

/-! ## Smoke tests -/

private def sq : Array QPt :=
  #[⟨0, 0, 0⟩, ⟨0, 100, 0⟩, ⟨100, 100, 0⟩, ⟨100, 0, 0⟩]

/-- The classic two-index loop `qPointInRing` replaced, kept to pin it. -/
private def qPointInRingRef (p : QPt) (ring : Array QPt) : Bool := Id.run do
  let n := ring.size
  let mut inside := false
  let mut j := n - 1
  for i in [0:n] do
    let yi := (ring.getD i default).la
    let xi := (ring.getD i default).lo
    let yj := (ring.getD j default).la
    let xj := (ring.getD j default).lo
    if (yi > p.la) ≠ (yj > p.la) then
      let dy := yj - yi
      let lhs := (p.lo - xi) * dy
      let rhs := (xj - xi) * (p.la - yi)
      if (if dy > 0 then lhs < rhs else lhs > rhs) then inside := !inside
    j := i
  return inside

/-- A concave "C" with a collinear run, so the grid below lands on vertices,
    on edges and inside the notch. -/
private def cRing : Array QPt :=
  #[⟨0, 0, 0⟩, ⟨0, 60, 0⟩, ⟨20, 60, 0⟩, ⟨20, 20, 0⟩, ⟨40, 20, 0⟩, ⟨60, 20, 0⟩,
    ⟨60, 60, 0⟩, ⟨80, 60, 0⟩, ⟨80, 0, 0⟩]

-- The one-pass loop agrees with the classic one at every point of a grid over
-- (and beyond) the C, and on the empty and one-vertex rings.
#guard (List.range 21).all fun a => (List.range 17).all fun b =>
  let q : QPt := ⟨(a : Int) * 5 - 10, (b : Int) * 5 - 10, 0⟩
  qPointInRing q cRing == qPointInRingRef q cRing && qPointInRing q sq == qPointInRingRef q sq
#guard qPointInRing ⟨0, 0, 0⟩ #[] == qPointInRingRef ⟨0, 0, 0⟩ #[]
#guard qPointInRing ⟨0, 0, 0⟩ #[⟨0, 0, 0⟩] == qPointInRingRef ⟨0, 0, 0⟩ #[⟨0, 0, 0⟩]

-- A point inside the unit-ish square is inside; one outside is not.
#guard qPointInRing ⟨50, 50, 0⟩ sq == true
#guard qPointInRing ⟨150, 50, 0⟩ sq == false
#guard qPointInRing ⟨50, 150, 0⟩ sq == false

-- Projection of a point onto a chord it lies on has zero distance and a
-- fraction inside `[0, td]`.
private def pa : QPt := ⟨515074000, -1278000, 0⟩
private def pb : QPt := ⟨515075000, -1278000, 60⟩
#guard (qProject ⟨515074500, -1278000, 30⟩ pa pb).dist == 0

-- latGap of a point between the endpoints' latitudes is 0; above is the
-- gap times 11132.
#guard latGapUm ⟨515074500, 0, 0⟩ pa pb == 0
#guard latGapUm ⟨515076000, 0, 0⟩ pa pb == (1000 * 11132)

-- penScaled pins the ramp ends.
private def co : QCorridor := mkQCorridor #[] 25000000 80000000 40
#guard co.penScaled 10000000 == co.S
#guard co.penScaled 90000000 == co.S * 40
#guard co.S == 55000000

/-! ### `ROAD_QPROFILE` and `qMatchRoadSegment`

The reference values derive the quantised fields from the float `ROAD_PROFILE`
and run the scenario below through the integer arithmetic. -/

-- Every field, against the harness's derivation from `ROAD_PROFILE`.
#guard ROAD_QPROFILE.minFixes == 3
#guard ROAD_QPROFILE.radiusUm == 50000000
#guard ROAD_QPROFILE.maxCandidatesPerFix == 5
#guard ROAD_QPROFILE.sigmaUm == 12000000
#guard ROAD_QPROFILE.betaUm == 10000000
#guard ROAD_QPROFILE.gapBridgeUm == 8000000
#guard ROAD_QPROFILE.detourFactor == 4
#guard ROAD_QPROFILE.detourSlackUm == 250000000
#guard ROAD_QPROFILE.maxLenNum == 9
#guard ROAD_QPROFILE.maxLenDen == 5
#guard ROAD_QPROFILE.maxLenSlackUm == 200000000
#guard ROAD_QPROFILE.maxRoadlessNum == 2
#guard ROAD_QPROFILE.maxRoadlessDen == 5
#guard ROAD_QPROFILE.corridorNearUm == 25000000
#guard ROAD_QPROFILE.corridorFarUm == 80000000
#guard ROAD_QPROFILE.corridorMaxPenalty == 40
#guard ROAD_QPROFILE.wayContinuityNats == 5
#guard ROAD_QPROFILE.spurReturnUm == 25000000
#guard ROAD_QPROFILE.spurMaxSpanVerts == 4
#guard ROAD_QPROFILE.simplifyTolUm == 5000000
#guard ROAD_QPROFILE.buildingCrossFactor == 1
#guard ROAD_QPROFILE.buildingSupportUm == 0

-- The nine fields where road and walk differ (the walk profile is a delta on
-- the road one, so the rest must coincide field-for-field).
#guard ROAD_QPROFILE.radiusUm != WALK_QPROFILE.radiusUm
#guard ROAD_QPROFILE.maxCandidatesPerFix != WALK_QPROFILE.maxCandidatesPerFix
#guard ROAD_QPROFILE.sigmaUm != WALK_QPROFILE.sigmaUm
#guard ROAD_QPROFILE.betaUm != WALK_QPROFILE.betaUm
#guard ROAD_QPROFILE.gapBridgeUm != WALK_QPROFILE.gapBridgeUm
#guard ROAD_QPROFILE.maxLenNum != WALK_QPROFILE.maxLenNum
#guard ROAD_QPROFILE.wayContinuityNats != WALK_QPROFILE.wayContinuityNats
#guard ROAD_QPROFILE.buildingCrossFactor != WALK_QPROFILE.buildingCrossFactor
#guard ROAD_QPROFILE.buildingSupportUm != WALK_QPROFILE.buildingSupportUm
#guard ROAD_QPROFILE.minFixes == WALK_QPROFILE.minFixes
#guard ROAD_QPROFILE.detourFactor == WALK_QPROFILE.detourFactor
#guard ROAD_QPROFILE.detourSlackUm == WALK_QPROFILE.detourSlackUm
#guard ROAD_QPROFILE.maxLenDen == WALK_QPROFILE.maxLenDen
#guard ROAD_QPROFILE.maxLenSlackUm == WALK_QPROFILE.maxLenSlackUm
#guard ROAD_QPROFILE.maxRoadlessNum == WALK_QPROFILE.maxRoadlessNum
#guard ROAD_QPROFILE.maxRoadlessDen == WALK_QPROFILE.maxRoadlessDen
#guard ROAD_QPROFILE.corridorNearUm == WALK_QPROFILE.corridorNearUm
#guard ROAD_QPROFILE.corridorFarUm == WALK_QPROFILE.corridorFarUm
#guard ROAD_QPROFILE.corridorMaxPenalty == WALK_QPROFILE.corridorMaxPenalty
#guard ROAD_QPROFILE.spurReturnUm == WALK_QPROFILE.spurReturnUm
#guard ROAD_QPROFILE.spurMaxSpanVerts == WALK_QPROFILE.spurMaxSpanVerts
#guard ROAD_QPROFILE.simplifyTolUm == WALK_QPROFILE.simplifyTolUm

-- The scenario: `High Street` running 400 m east, and `Service Road` beside
-- its eastern half 6 m north (inside the 8 m road bridge, so the hop between
-- them is routable). A drive runs the street, then pulls onto the service road.
private def rdHigh : QWay :=
  { coords := #[⟨515200000, -1300000, 0⟩, ⟨515200000, -1292782, 0⟩, ⟨515200000, -1285563, 0⟩,
      ⟨515200000, -1278345, 0⟩, ⟨515200000, -1271127, 0⟩, ⟨515200000, -1263908, 0⟩,
      ⟨515200000, -1256690, 0⟩, ⟨515200000, -1249472, 0⟩, ⟨515200000, -1242253, 0⟩]
    name := some "High Street" }
private def rdService : QWay :=
  { coords := #[⟨515200539, -1271127, 0⟩, ⟨515200539, -1263908, 0⟩, ⟨515200539, -1256690, 0⟩,
      ⟨515200539, -1249472, 0⟩, ⟨515200539, -1242253, 0⟩]
    name := some "Service Road" }
private def rdWays : Array QWay := #[rdHigh, rdService]

private def rdDrift : Array QPt :=
  #[⟨515200000, -1297113, 1000⟩, ⟨515200000, -1288451, 1030⟩, ⟨515200000, -1279789, 1060⟩,
    ⟨515200000, -1272570, 1090⟩, ⟨515200539, -1270405, 1120⟩, ⟨515200539, -1267517, 1150⟩,
    ⟨515200539, -1264630, 1180⟩, ⟨515200539, -1261743, 1210⟩, ⟨515200539, -1258855, 1240⟩,
    ⟨515200539, -1255968, 1270⟩, ⟨515200539, -1253081, 1300⟩, ⟨515200539, -1250193, 1330⟩,
    ⟨515200539, -1247306, 1360⟩, ⟨515200539, -1244419, 1390⟩]

private def rdStraight : Array QPt :=
  #[⟨515199820, -1300000, 1000⟩, ⟨515199820, -1295669, 1030⟩, ⟨515199820, -1291338, 1060⟩,
    ⟨515199820, -1287007, 1090⟩, ⟨515199820, -1282676, 1120⟩, ⟨515199820, -1278345, 1150⟩,
    ⟨515199820, -1274014, 1180⟩]

private def rdPath (r : Option QMatchResult) : Array QPt := (r.map (·.path)).getD #[]
private def rdDetail (r : Option QMatchResult) : Array QPt := (r.map (·.routeDetail)).getD #[]

-- The turn prior decides: at 5 nats the drive stays on `High Street`; at 0 it
-- follows the fixes onto `Service Road`.
#guard rdPath (qMatchRoadSegment rdDrift rdWays #[]) ==
  #[⟨515200000, -1297113, 1000⟩, ⟨515200000, -1244419, 1390⟩]
-- The `routeDetail` is the full route the Viterbi walked, time-interpolated by
-- cumulative arc length — every `High Street` vertex, and no `Service Road` one.
#guard rdDetail (qMatchRoadSegment rdDrift rdWays #[]) ==
  #[⟨515200000, -1297113, 1000⟩, ⟨515200000, -1292782, 1015⟩, ⟨515200000, -1288451, 1030⟩,
    ⟨515200000, -1285563, 1040⟩, ⟨515200000, -1279789, 1060⟩, ⟨515200000, -1278345, 1066⟩,
    ⟨515200000, -1272570, 1090⟩, ⟨515200000, -1271127, 1110⟩, ⟨515200000, -1270405, 1120⟩,
    ⟨515200000, -1267517, 1150⟩, ⟨515200000, -1264630, 1180⟩, ⟨515200000, -1263908, 1188⟩,
    ⟨515200000, -1261743, 1210⟩, ⟨515200000, -1258855, 1240⟩, ⟨515200000, -1256690, 1262⟩,
    ⟨515200000, -1255968, 1270⟩, ⟨515200000, -1253081, 1300⟩, ⟨515200000, -1250193, 1330⟩,
    ⟨515200000, -1249472, 1337⟩, ⟨515200000, -1247306, 1360⟩, ⟨515200000, -1244419, 1390⟩]
#guard rdPath (qMatchTrajectory rdDrift rdWays #[] { ROAD_QPROFILE with wayContinuityNats := 0 }) ==
  #[⟨515200000, -1297113, 1000⟩, ⟨515200539, -1244419, 1390⟩]

-- A run down the western half, where only `High Street` exists.
#guard rdPath (qMatchRoadSegment rdStraight rdWays #[]) ==
  #[⟨515200000, -1300000, 1000⟩, ⟨515200000, -1274014, 1180⟩]

-- Buildings are inert at `buildingCrossFactor := 1`: a footprint over the
-- eastern half changes nothing, so a road caller may pass its geometry layer.
private def rdBlock : Array QPt :=
  #[⟨515199102, -1271127, 0⟩, ⟨515200898, -1271127, 0⟩, ⟨515200898, -1242253, 0⟩,
    ⟨515199102, -1242253, 0⟩, ⟨515199102, -1271127, 0⟩]
#guard qMatchRoadSegment rdDrift rdWays #[rdBlock] == qMatchRoadSegment rdDrift rdWays #[]

-- The wrapper's bails: below `minFixes`, no network, and off-network past the
-- radius all draw the raw fixes instead.
#guard (qMatchRoadSegment (rdStraight.take 2) rdWays #[]).isNone
#guard (qMatchRoadSegment rdStraight #[] #[]).isNone
private def rdFar : Array QPt :=
  #[⟨515226949, -1300000, 1000⟩, ⟨515226949, -1292782, 1030⟩, ⟨515226949, -1285563, 1060⟩,
    ⟨515226949, -1278345, 1090⟩, ⟨515226949, -1271127, 1120⟩]
#guard (qMatchRoadSegment rdFar rdWays #[]).isNone

-- `matchRadiusM` is the wrapper's one knob. At 400 m the same 300 m-off track
-- matches; at 3 m only the way a fix actually sits on is a candidate, so the
-- drive follows the fixes onto `Service Road` despite the turn prior.
#guard rdPath (qMatchRoadSegment rdFar rdWays #[] (some 400000000)) ==
  #[⟨515200000, -1300000, 1000⟩, ⟨515200000, -1271127, 1117⟩, ⟨515200539, -1271127, 1120⟩]
#guard rdPath (qMatchRoadSegment rdDrift rdWays #[] (some 3000000)) ==
  #[⟨515200000, -1297113, 1000⟩, ⟨515200539, -1244419, 1390⟩]
-- The default is the profile's 50 m.
#guard qMatchRoadSegment rdDrift rdWays #[] == qMatchRoadSegment rdDrift rdWays #[] (some 50000000)

/-! ## The reconstructed route is a valid costed path (routing-optimality, brick 1)

`reconGo` computes `LazyEdge`'s `chainList`, so the reconstructed route is the
reversed chain. With `chainList_reverse_pathCost_isSome`, under `EInv` every
step is a real edge of `g`: the route is a valid costed path
(`dijkstraC_correct`'s `isValidPath`). `qReconstruct_pathCost_eq_iter` below
gives the exact cost. -/

/-- `reconGo` is `chainList` prepended by its accumulator. -/
theorem reconGo_toList_chainList (prev : Array Nat) (n : Nat) :
    ∀ (fuel v : Nat) (acc : Array Nat),
      (reconGo prev n fuel v acc).toList = acc.toList ++ chainList prev n fuel v := by
  intro fuel
  induction fuel with
  | zero => intro v acc; simp [reconGo, chainList]
  | succ fuel ih =>
    intro v acc
    show ((if v ≥ n then acc else reconGo prev n fuel (prev.getD v n) (acc.push v)) : Array Nat).toList
      = acc.toList ++ chainList prev n (fuel + 1) v
    have hcl : chainList prev n (fuel + 1) v
        = if v ≥ n then [] else v :: chainList prev n fuel (prev.getD v n) := rfl
    by_cases hv : v ≥ n
    · rw [if_pos hv, hcl, if_pos hv, List.append_nil]
    · rw [if_neg hv, ih (prev.getD v n) (acc.push v), Array.toList_push, hcl, if_neg hv,
        List.append_assoc, List.singleton_append]

/-- `qReconstruct`'s output as a list: the reversed chain. -/
theorem qReconstruct_toList (prev : Array Nat) (start n : Nat) :
    (qReconstruct prev start n).toList = (chainList prev n n start).reverse := by
  unfold qReconstruct
  rw [Array.toList_reverse, reconGo_toList_chainList]
  simp

/-- The matcher's reconstructed route is a valid costed path: under `EInv`,
from any seed below the sentinel, every step is an edge of `g`. -/
theorem qReconstruct_pathCost_isSome {g : Graph} {s : LState} (hE : EInv g s)
    {start : Nat} (hstart : start < g.n) :
    (Verified.Rail.pathCost g (qReconstruct s.prev start g.n).toList).isSome := by
  rw [qReconstruct_toList]
  exact chainList_reverse_pathCost_isSome hE g.n start
    (chainList_ne_nil hstart (by omega))

/-- Specialised to a concrete search trajectory: the route reconstructed from
any `iter`-reached state of a per-source lazy search is a valid costed path.
This is the form the matcher's cache states (`OnTrajCache`) satisfy. -/
theorem qReconstruct_pathCost_isSome_iter {g : Graph} {maxR src start k : Nat}
    (hstart : start < g.n) :
    (Verified.Rail.pathCost g
      (qReconstruct (iter g maxR k (linit g.n src)).prev start g.n).toList).isSome :=
  qReconstruct_pathCost_isSome (iter_einv k linit_einv) hstart

/-- The matcher's reconstructed route costs exactly the search's answer: once
the target is settled and its chain complete, its `pathCost` is `dist[start]`
(`qReconstruct_toList` with `iter_route_pathCost_eq`). -/
theorem qReconstruct_pathCost_eq_iter {g : Graph} {maxR src start k dt : Nat}
    (hwf : WFEdges g) (hsrc : src < g.n)
    (hdone : (iter g maxR k (linit g.n src)).done.getD start false = true)
    (hcomp : chainList (iter g maxR k (linit g.n src)).prev g.n g.n start
           = chainList (iter g maxR k (linit g.n src)).prev g.n (g.n + 1) start)
    (hdt : (iter g maxR k (linit g.n src)).dist.getD start none = some dt) :
    Verified.Rail.pathCost g
      (qReconstruct (iter g maxR k (linit g.n src)).prev start g.n).toList = some dt := by
  rw [qReconstruct_toList]
  exact iter_route_pathCost_eq hwf hsrc k hdone hcomp hdt

end Verified.Geo
