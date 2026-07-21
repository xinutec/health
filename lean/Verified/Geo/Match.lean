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

The Lean side of `src/geo/match-twin.ts`, the pinned integer semantics of
the walk map-matcher (`map-match-core.ts` `matchTrajectory` +
`pedestrian-match.ts` `matchWalkSegment`). Ported literally over the
`Metric.lean` substrate (`qDist`/`cosQ`/`roundDiv`, contract: BigInt `/`
↔ `Int.tdiv`, `>>` ↔ `Int.fdiv`; midpoints are `tdiv` since lons can be
negative). The `compare-match` harness gates this at bit-exact quant↔Lean.

The file runs the whole pipeline in three parts:
- **Part 1 — metric-local primitives**: `qProject` (`projectPointToSegment`'s
  twin — foot + exact fraction `tn/td` + distance), `QCorridor` (the
  GPS-corridor penalty, brute-force nearest chord clamped at `farUm`, ramp
  scaled by `S = farUm − nearUm`), `QBuildings` (the impassable-footprint
  penalty, even-odd ray cast with an integer bbox reject and a fix-support
  scan).
- **Part 2 — graph / candidates / routing**: `buildQGraph`,
  `qCandidatesForFix`, and `qRouteBetween` over the reused `LazyDijkstra`
  cache.
- **Part 3 — Viterbi + walk pipeline**: `qMatchTrajectory` /
  `qMatchWalkSegment`, then the honesty corollaries.

## Theorems (in progress)

The gate (bit-exact quant↔Lean on all 173 golden legs) is the shipped
deliverable; the theorem arc on top of it, easiest first:

- **Honesty corollaries — landed** (`qMatchWalkSegment_{coarse_drop_only,
  path_sound}`): the display tail never fabricates geometry — `coarsePath`
  is a subsequence of the trajectory path, and every drawn `path` vertex is
  a coarse vertex or a route vertex within the splice `dropM` of its chord.
  These specialise the already-proved `Metric.lean` pass theorems.
- **Cache purity — foundation landed** (`LazyResume.lean` + `LazyPrev.lean`).
  Two facts together make `qRouteBetween`'s route result a pure function of
  the graph rather than of the trellis's fill order:
  - `lsettle_read_stable` — a source's target reads (`dist`/`prev`/`done`)
    are identical no matter where along its trajectory the settle resumes
    (`lsettle_from_iter` + `settled_final`);
  - `PInv` / `PInv.done_prev` — a settled vertex's whole `prev` chain is
    settled, so the *reconstructed path* (not just the target) is
    resume-stable (`iter_done_stable` freezes every chain vertex).

  The atoms are all proved:
  - `settleTo_onTraj` / `settleTo_state_onTraj` — `OnTrajCache` (every cached
    state is on its source's search trajectory) is preserved by `settleTo`,
    and the returned state is on-trajectory (via `lsettle_spec` + `iter_add`);
  - `qReconstruct_congr` — two `prev` arrays that agree on a start-closed
    predicate reconstruct identically (`reconGo` structural form). Its
    instances: `P v =` "settled at the reference state", discharged by
    `iter_done_stable` (agree) + `PInv.done_prev` (closed).

  `qRouteBetween`'s 2×2 loop is a `List.foldl` of `comboStep` over
  `routeCombos` (gate re-verified bit-exact), the structural form the purity
  induction needs. **Route-result purity — landed** (`qRouteBetween_route_pure`):
  the route result is the same for any two valid caches — a pure function of
  the graph, not of the trellis's fill order. The chain, each atom proved:
  - `settleTo_reads_eq` — a source's target `dist` and reconstructed chain
    read the same from any valid cache as from a fresh per-source settle
    (`iter_stop_read_stable` for `dist`, `qReconstruct_resume_stable` for the
    chain; `lsettle_stops` discharges stop-reachability at `totalOut+1` fuel);
  - `comboStep_best_indep` — hence one endpoint combo's `best` update is
    cache-independent (factored through the pure `comboBest`);
  - `comboStep_onTraj` — `comboStep` preserves `OnTrajCache` (its cache output
    is `settleTo`'s);
  - `comboFold_best_indep` — folding the two over the combo list carries both:
    each step's `best` is cache-invariant while the cache stays valid.

  Route-result purity is what makes the trellis's edge weights (`τ(i,j)`, from
  `qRouteBetween`'s `distUm`) a well-defined *pure function of the graph*, so
  the declarative score model below is well-formed.
- **Flagship — Viterbi argmax — landed** (`MatchViterbi.lean`): on an abstract
  first-order max-sum `Trellis` (the matcher's trajectory decoder shape, one
  dimension simpler than the HSMM — no durations):
  - `cell_eq_listMax` — the forward DP cell equals the max declarative
    `pathScore` over all enumerated chains reaching it (the tropical-semiring
    heart: `+` distributes over the running max, reusing `Hsmm.Score`);
  - `decode_argmax` — the backtracked decoder's chain attains the maximum
    `pathScore` over every full candidate chain;
  - `decode_none_iff` — the decoder returns `none` exactly when no candidate
    chain has a finite score.

  These are the matcher analogue of the HSMM `decode_correct` / `decode_none_iff`.
- **Wired into production — landed.** `qMatchTrajectory` no longer runs an
  unverified imperative Viterbi. It hoists the route matrix (`routeOf[t-1][j][i]`,
  filled in the trellis's exact `(t, j, i)` order — the same `qRouteBetween` call
  sequence, so the cache and every value are unchanged; `qRouteBetween_route_pure`
  shows the order never mattered), instantiates a concrete `MatchViterbi.Trellis`
  (node score = `emissionScaled`, edge weight = `τ − switchPen`, `-∞` when
  unrouteable, read from that finished array), and *runs* the verified
  `MatchViterbi.decodeFast` — the `O(T·W²)` memoised decoder (`decodeFast_eq :
  decodeFast = decode`, so `decodeFast_argmax` / `decodeFast_none_iff` hold). The
  returned chain is thus, by construction, the maximum-`pathScore` candidate
  chain; the display tail then reads it against the same matrix. The
  `compare-match` gate (173/173 quant↔Lean EXACT) confirms the restructure is
  bit-identical to the old imperative trellis — the referee that the rewiring
  did not drift.

Sorry-free convention: a theorem is stated only when proved.
-/

namespace Verified.Geo

/-! ## `qProject` and polyline length -/

/-- The clamped foot on the 1e-7° grid, the fraction as the exact
rational `tn/td`, and `qDist` to the foot — `qChordDist`'s body, foot
kept (`match-twin.ts` `qProject`). -/
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
once instead of once per query: `c` is `cosQ` at the chord's mid-latitude, `bx`
/ `vy` the chord vector in that local µm frame, `len2` its squared length.
`loLa`…`hiLo` is the endpoint bounding box **dilated by one coordinate unit** —
the clamped foot is a rounded convex combination of the endpoints, so it can sit
at most half a unit outside the raw box.

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

/-- Gap from `x` to the interval `[lo, hi]` in µm **times `2^20`**, with `k` the
Q20 cos it is projected through (`2^20` itself for latitude, a `cosQ` lower bound
for longitude). Kept scaled so the hot reject `gap ≥ best` is
`gapScaled ≥ best · 2^20` — a comparison, not a division: for integers,
`⌊S/2^20⌋ ≥ best ↔ S ≥ best · 2^20`. A `Nat`: the value runs to ~10^16, past
the `2^31` where Lean's `Int` turns into a GMP bignum. -/
def boxGapScaled (x lo hi k : Int) : Nat :=
  if x < lo then (lo - x).toNat * 11132 * k.toNat
  else if x > hi then (x - hi).toNat * 11132 * k.toNat
  else 0

/-- The corridor's tuned parameters, `S = farUm − nearUm` precomputed, plus the
chord index `distToFast` reads.

`cellLa`/`cellLo` are one `farUm` step in latitude / longitude coordinate units
(the longitude step uses `cmin`, a corridor-wide `cosQ` lower bound, so it is
never too narrow). `grid` files each chord `i` (`fixes[i-1] → fixes[i]`) in every
cell its bounding box **dilated by one cell** touches. Consequence — the whole
basis for `distToFast`: any chord within `farUm` of a point `p` differs from
`p` by at most `cellLa`/`cellLo` per axis, so `p` lies in that chord's dilated
box, so the chord is filed in `p`'s own cell. One bucket therefore holds every
chord that could beat the `farUm` clamp.

`cmin` lower-bounds `cosQ` over the whole corridor **plus a 0.1° latitude
margin** — far more than any point `distToFast` is asked about can stray — so it
is a sound cos bound for the longitude gap as well as a safe (never too narrow)
cell width. `chords` carries each chord's solved projection frame. -/
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

def mkQCorridor (fixes : Array QPt) (nearUm farUm maxPen : Nat) : QCorridor := Id.run do
  -- Corridor-wide cos lower bound (≥ 1 so the cell stays finite). `cosQ` falls
  -- with |latitude|, so the extreme of the margin-widened band is the minimum.
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
  let mut cmin : Int := cosQ (if loEnd.natAbs ≥ hiEnd.natAbs then loEnd else hiEnd)
  if cmin < 1 then cmin := 1
  let cellLa : Int := (farUm : Int) / 11132 + 1
  let cellLo : Int := ((farUm : Int) * 1048576) / (11132 * cmin) + 1
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

/-- Brute-force nearest-chord distance (the float grid is exact by its
own argument), clamped at `farUm` (`QCorridor.distTo`). -/
def QCorridor.distTo (co : QCorridor) (p : QPt) : Nat := Id.run do
  if co.fixes.size == 0 then return 0
  if co.fixes.size == 1 then return qDist p (co.fixes.getD 0 default)
  let mut best : Nat := co.farUm
  for i in [1:co.fixes.size] do
    let a := co.fixes.getD (i - 1) default
    let b := co.fixes.getD i default
    if latGapUm p a b ≥ best then continue
    let c : Int := cosQ ((a.la + b.la).tdiv 2)
    let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
    let vy : Int := (b.la - a.la) * 11132
    let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
    let py : Int := (p.la - a.la) * 11132
    let len2 : Int := bx * bx + vy * vy
    let d : Nat :=
      if len2 = 0 then qDist p a
      else
        let dot : Int := max 0 (min (px * bx + py * vy) len2)
        qDist p { la := a.la + roundDiv (dot * (b.la - a.la)) len2
                  lo := a.lo + roundDiv (dot * (b.lo - a.lo)) len2, ts := 0 }
    if d < best then best := d
  return best

/-- **Grid-indexed `distTo`** — same value, one bucket instead of every chord.
`distTo` was the matcher's hot spot (O(chords) per graph edge, and there is one
`distTo` per edge weight); the float matcher hit the same wall and answered it
with a chord grid. Reading only `p`'s own cell is exact here because the bucket
holds every chord within `farUm` (see `QCorridor`), and `distTo` clamps at
`farUm`: a chord filed elsewhere is ≥ `farUm` away, and the box gap lower-bounds
the chord distance, so neither the running `best` reject nor the final minimum
can differ.

Two further departures from the spec's shape, both value-preserving:

* the projection frame (`c`, `bx`, `vy`, `len2`) is read from `co.chords`
  instead of recomputed — same numbers, solved once per chord in `mkQCorridor`
  rather than once per (chord, query) pair;
* the reject is the **two-axis** box gap, not `latGapUm`'s latitude alone. The
  foot lies in the chord's unit-dilated box, `qDist` is `isqrt` of the sum of
  the two axis components, and `cmin ≤ cosQ` everywhere it is applied, so
  `gLa² + gLo²` under-estimates `qDist(p, foot)²`. A chord it rejects has
  `d ≥ best`, so it could not have lowered `best` — dropping it leaves both the
  `best` sequence and the minimum unchanged. -/
def QCorridor.distToFast (co : QCorridor) (p : QPt) : Nat := Id.run do
  if co.fixes.size == 0 then return 0
  if co.fixes.size == 1 then return qDist p (co.fixes.getD 0 default)
  let cands := co.grid.getD (cellKeyN (p.la.fdiv co.cellLa) (p.lo.fdiv co.cellLo)) #[]
  let mut best : Nat := co.farUm
  for i in cands do
    let ch := co.chords.getD i default
    let bestS : Nat := best * 1048576
    let gLaS := boxGapScaled p.la ch.loLa ch.hiLa 1048576
    if gLaS ≥ bestS then continue
    let gLoS := boxGapScaled p.lo ch.loLo ch.hiLo co.cmin
    if gLoS ≥ bestS then continue
    -- Both axes are inside `best`, so the (rarer) combined test can afford the
    -- two divisions back to µm, where the squares stay well inside `Nat`.
    let gLa := gLaS / 1048576
    let gLo := gLoS / 1048576
    if gLa * gLa + gLo * gLo ≥ best * best then continue
    let d : Nat :=
      if ch.len2 = 0 then qDist p ch.a
      else
        -- The spec's `max 0 (min (px·bx + py·vy) len2)` and its two `roundDiv`s,
        -- with every product carried as a `Nat` magnitude and the sign in the
        -- shape: `px·bx` reaches ~10^14 and `dot·Δ` ~10^16, both far past the
        -- `2^31` where an `Int` becomes a GMP bignum, and `Nat` keeps the exact
        -- value at any size (it degrades to a bignum too, just far later).
        let px : Int := ((p.lo - ch.a.lo) * 11132 * ch.c).fdiv 1048576
        let py : Int := (p.la - ch.a.la) * 11132
        let m1 : Nat := px.natAbs * ch.bx.natAbs
        let n1 : Bool := decide (px < 0) != decide (ch.bx < 0)
        let m2 : Nat := py.natAbs * ch.vy.natAbs
        let n2 : Bool := decide (py < 0) != decide (ch.vy < 0)
        let dot : Nat :=
          if n1 == n2 then (if n1 then 0 else min (m1 + m2) ch.len2)
          else if n1 then (if m2 ≥ m1 then min (m2 - m1) ch.len2 else 0)
          else (if m1 ≥ m2 then min (m1 - m2) ch.len2 else 0)
        -- `roundDiv (dot·Δ) len2` with `dot ≥ 0` and `len2 > 0`: half-away-from-
        -- zero is `⌊(dot·|Δ| + ⌊len2/2⌋)/len2⌋`, negated iff `Δ` is.
        let half : Nat := ch.len2 / 2
        let sLa : Nat := (dot * ch.dLaAbs + half) / ch.len2
        let sLo : Nat := (dot * ch.dLoAbs + half) / ch.len2
        qDist p { la := ch.a.la + (if ch.dLaNeg then -(sLa : Int) else (sLa : Int))
                  lo := ch.a.lo + (if ch.dLoNeg then -(sLo : Int) else (sLo : Int)), ts := 0 }
    if d < best then best := d
  return best

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

/-- Even-odd ray cast, cross-multiplied exact (the float side divides;
`qPointInRing`). -/
def qPointInRing (p : QPt) (ring : Array QPt) : Bool := Id.run do
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

/-- An axis-aligned integer bounding box (the exact bbox reject). -/
structure QBox where
  minLa : Int
  maxLa : Int
  minLo : Int
  maxLo : Int
  deriving Repr, Inhabited

/-- Side of one footprint-grid cell, in µm. A pure bucketing knob: `inAnyRingFast`
files a ring into every cell its bbox meets and reads only the query point's own
cell, so *any* positive side gives the identical answer — this one is chosen to
sit near a typical building's own size, which keeps both the filing and the
buckets small. -/
def buildingCellUm : Nat := 30000000

/-- Prepared building set: rings (≥ 3 vertices), their bounding boxes,
the fixes, and the two tuned thresholds (`QBuildings` constructor), plus the
footprint index `inAnyRingFast` reads.

`grid` files ring `i` in every cell its bounding box meets. So if `p` is inside
ring `i`'s box it is inside one of those cells, i.e. ring `i` is in `p`'s own
bucket — the bucket therefore holds every ring that survives the box reject,
which is exactly the set `inAnyRing`'s scan would test. -/
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

/-- Brute-force footprint test — box reject, then the exact ray cast. -/
def QBuildings.inAnyRing (bld : QBuildings) (p : QPt) : Bool := Id.run do
  for i in [0:bld.rings.size] do
    let b := bld.boxes.getD i default
    if p.la < b.minLa || p.la > b.maxLa || p.lo < b.minLo || p.lo > b.maxLo then
      continue
    if qPointInRing p (bld.rings.getD i default) then return true
  return false

/-- **Grid-indexed `inAnyRing`** — same value, one bucket instead of every ring.
The brute-force scan was the matcher's dominant cost (two `factor` samples per
graph edge, each scanning all ~3k corridor footprints); `p`'s bucket contains
every ring whose box contains `p` (see `QBuildings`), and a ring the scan would
reject on its box cannot change a disjunction of ray casts, so the two agree.
Bucket order is ascending ring index, as in the scan. -/
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

/-- The 3 m sample scan: `crossFactor` if any grid-quantised sample lands
in a footprint without a nearby fix, else `1` (`QBuildings.factorOnce`;
the memo of the twin is transparency-only). -/
def QBuildings.factor (bld : QBuildings) (a b : QPt) : Nat := Id.run do
  let len := qDist a b
  let step : Nat := 3000000
  let mut n : Nat := (len + step - 1) / step
  if n < 1 then n := 1
  for k in [0:n + 1] do
    let s : QPt := { la := a.la + roundDiv ((k : Int) * (b.la - a.la)) (n : Int)
                     lo := a.lo + roundDiv ((k : Int) * (b.lo - a.lo)) (n : Int), ts := 0 }
    if bld.inAnyRingFast s && !bld.fixSupports s then return bld.crossFactor
  return 1

/-! ## Graph build (part 2)

The routing graph reuses `Verified/Rail/Graph.lean`'s `Graph` (weighted
adjacency, `Nat` scalars) with weights precomputed eagerly in the µm·S
scale — memo-transparent to the twin's lazy `weightOf`, and routing then
reuses the fully-proved `LazyDijkstra` machinery (`linit`/`lsettle`). -/

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

/-- `buildRoadGraph`'s twin: vertices deduped by the integer coord pair,
way edges in iteration order, then `bridgeGaps` as the plain `i < j`
scan; every edge weight precomputed eagerly. -/
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

/-- **The O(V) executable twin of `buildQGraph`.** Same graph, byte-identical,
but linear instead of quadratic: the two O(V²) hotspots of `buildQGraph` are
replaced by hash indices.

* **Vertex dedup** — a `(la, lo) → id` hash replaces the per-coordinate linear
  `findIdx?` scan. First-seen order (and hence vertex numbering) is unchanged.
* **`bridgeGaps`** — candidate pairs come from a spatial grid keyed by `cellKeyN`
  (cells span `gapUm` µm) instead of the all-pairs scan. A within-`gapUm` pair
  lands within the 3×3 cell neighbourhood: the latitude cell is `gapUm`-wide by
  construction, and the longitude cell uses a corridor-wide cos lower bound
  `cmin` (`cosQ` only grows toward any pair's mid-latitude, so the cell is never
  too narrow). Grid `cellKeyN` collisions can only *add* candidates, never drop
  them, so they cost an extra exact check but never a missed edge.

The exact accept/reject predicate and the ascending-`(i, j)` push order are
copied verbatim from `buildQGraph`, so the output is identical (the intended
`buildQGraphFast = buildQGraph` refinement; the executable path uses this, every
theorem still speaks of `buildQGraph` via that equality). -/
def buildQGraphFast (ways : Array QWay) (co : QCorridor) (bld : Option QBuildings)
    (gapUm : Nat) : QGraph := Id.run do
  let mut vertices : Array QPt := #[]
  let mut adj : Array (Array (Nat × Nat)) := #[]
  let mut segments : Array QSeg := #[]
  let mut vidx : Std.HashMap (Int × Int) Nat := ∅
  let wt := fun (ap bp : QPt) =>
    co.edgeWeightScaled ap bp * (match bld with | some bl => bl.factor ap bp | none => 1)
  for way in ways do
    let mut prev : Int := -1
    let mut prevPt : QPt := default
    for p in way.coords do
      let found := vidx.get? (p.la, p.lo)
      let id : Nat := found.getD vertices.size
      if found.isNone then
        vertices := vertices.push { la := p.la, lo := p.lo, ts := 0 }
        adj := adj.push #[]
        vidx := vidx.insert (p.la, p.lo) id
      if prev ≥ 0 && (id : Int) ≠ prev then
        let a := prev.toNat
        let w := wt prevPt p
        -- `modify`, not `setIfInBounds (getD … |>.push …)`: the latter holds a
        -- second reference to the row while pushing, so every push reallocates
        -- and copies the whole row. Same value, one owner.
        adj := adj.modify a (·.push (id, w))
        adj := adj.modify id (·.push (a, w))
        segments := segments.push { u := a, v := id, lenUm := qDist prevPt p, name := way.name }
      prev := (id : Int)
      prevPt := p
  -- bridgeGaps via a spatial grid.
  -- Everything below the cell index is carried as a `Nat` magnitude with the
  -- sign in the shape: these products reach ~10^13 (cells) and ~10^15 (the gap
  -- test), and Lean's `Int` is a GMP bignum past 2^31 while `Nat` is an unboxed
  -- scalar to 2^63. `Int.fdiv` by a positive divisor is `⌊·⌋` on a non-negative
  -- numerator and `−⌈·⌉` on a negative one, which is what the branches spell out.
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
    for j in cand.qsort (· < ·) do
      let vj := vertices.getD j default
      let dla : Nat := (vj.la - vi.la).natAbs * 11132
      if dla > gapUm then continue
      let c : Int := cosQ ((vi.la + vj.la).tdiv 2)
      let y : Nat := (vj.lo - vi.lo).natAbs * 11132 * c.natAbs
      let negY : Bool := decide ((vj.lo - vi.lo) < 0) != decide (c < 0)
      let dlo : Nat := if negY then (y + 1048575) / 1048576 else y / 1048576
      if dla * dla + dlo * dlo > gapSq then continue
      if (adj.getD i #[]).any (fun e => e.1 == j) then continue
      let w := wt vi vj
      adj := adj.modify i (·.push (j, w))
      adj := adj.modify j (·.push (i, w))
  return { vertices, segments, g := ⟨adj⟩ }

/-! ## Candidates -/

/-- `candidatesForFix`'s twin: scan every segment, keep projections
within the radius, sort by `(dist, si)` (a strict total order — `si`
distinct — so `qsort` is deterministic), take the first `maxCands`. -/
def qCandidatesForFix (fix : QPt) (gr : QGraph) (radiusUm maxCands : Nat) :
    Array QCand := Id.run do
  let mut cands : Array QCand := #[]
  for si in [0:gr.segments.size] do
    let s := gr.segments.getD si default
    let a := gr.vertices.getD s.u default
    let b := gr.vertices.getD s.v default
    if latGapUm fix a b > radiusUm then continue
    let proj := qProject fix a b
    if proj.dist ≤ radiusUm then
      cands := cands.push { la := proj.la, lo := proj.lo, dist := proj.dist, si, tn := proj.tn, td := proj.td }
  let sorted := cands.qsort (fun p q => p.dist < q.dist || (p.dist == q.dist && p.si < q.si))
  return sorted.extract 0 maxCands

/-- Spatial index over a graph's segments, cells one `radiusUm` wide, each
segment filed in every cell its endpoint box **dilated by one cell** touches. A
segment within `radiusUm` of `fix` is within `radiusUm` of its own box, hence at
most one cell away from it on each axis, hence filed in `fix`'s own cell — so
one bucket holds every segment `qCandidatesForFix` could keep. -/
structure QSegIndex where
  cellLa : Int
  cellLo : Int
  grid : Std.HashMap Nat (Array Nat)

def mkQSegIndex (gr : QGraph) (radiusUm : Nat) (cmin : Int) : QSegIndex := Id.run do
  let cellLa : Int := (radiusUm : Int) / 11132 + 1
  let cellLo : Int := ((radiusUm : Int) * 1048576) / (11132 * cmin) + 1
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

/-- **Grid-indexed `qCandidatesForFix`** — same value, one bucket instead of
every segment. The all-segments scan is `candidatesForFix`'s shape and was the
matcher's largest single cost once the corridor was indexed (one scan of ~25 k
segments per GPS fix). The bucket holds every segment that can pass the radius
test (see `QSegIndex`), and the `(dist, si)` order the result is sorted by is
*strict total* (`si` is unique), so the sorted prefix does not depend on the
order candidates were collected in. -/
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
  return sorted.extract 0 maxCands

/-! ## Routing over the LazyDijkstra model

The twin's `QRouteCache` is a per-source lazy Dijkstra that pauses at the
requested target and *resumes* on the next `settle`, memoised per source.
We reproduce it as `RouteCache = Array (Option LState)`: `settleTo` pulls
a source's paused state (or `linit`), advances it just far enough for the
target to settle (`lsettle`, which stops at `done[tgt] ∨ lterminal`), and
stores it back. Because a settled vertex's `dist`/`prev` are frozen
(`settled_final`) and an unsettled target's `lsettle` runs to terminal
anyway, the reads are value-identical to a run-to-terminal search — but
only the *nearby* corridor is explored, matching the twin's cost.

The take-`none`/put-`some` around `lsettle` keeps the pulled state
uniquely referenced, so the search updates its arrays in place rather
than copying them (the twin's typed mutable arrays). -/

abbrev RouteCache := Array (Option LState)

/-- Resume source `src`'s search until `tgt` settles (or termination),
returning the advanced state and cache (the twin's `cache.from(src)`
then `rd.settle(tgt)`). -/
def settleTo (g : Graph) (maxR fuel n src tgt : Nat) (cache : RouteCache) :
    LState × RouteCache :=
  let st0 := (cache.getD src none).getD (linit n src)
  let cache := cache.setIfInBounds src none
  let st := lsettle g maxR tgt fuel st0
  (st, cache.setIfInBounds src (some st))

/-! ### Cache purity, step 1: the `OnTraj` invariant

A cache is *valid* when every state it holds for a source is a point on
that source's own search trajectory (`iter m (linit n src)`). `settleTo`
preserves this — it resumes from a trajectory point and `lsettle` advances
along the same trajectory (`lsettle_spec` lands on `iter k`), so the
returned state and the stored-back cache are both still on-trajectory. This
is the invariant under which the resume-read stability (`LazyResume`) and
prev-chain closure (`LazyPrev`) apply, making `qRouteBetween`'s result a
pure function of the graph rather than of the trellis's fill order. -/

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

/-- The prev-walk as a structural recursion on a step budget: from `v`,
push `v` and follow `prev` until a `≥ n` sentinel or the budget runs out.
This is the `Id.run do` loop's body in the form the congruence proof can
induct on — same output, so the gate is unaffected. -/
def reconGo (prev : Array Nat) (n : Nat) : Nat → Nat → Array Nat → Array Nat
  | 0, _, acc => acc
  | fuel + 1, v, acc => if v ≥ n then acc else reconGo prev n fuel (prev.getD v n) (acc.push v)

/-- The prev-chain from `start` back to a `≥ n` sentinel (the twin's
`for v; v!==-1; v=prev[v]`, then reversed so `idPath[0]` is the source).
`prev` seeds to `n` at `linit`, so the walk stops at `prev[v] = n`. The
budget `n` can never be exceeded (a valid chain has ≤ `n` distinct
vertices). -/
def qReconstruct (prev : Array Nat) (start n : Nat) : Array Nat :=
  (reconGo prev n n start #[]).reverse

/-- **Reconstruction congruence.** If a predicate `P` holds at the start,
is closed under the `prev₁`-step (up to the sentinel), and `prev₁`/`prev₂`
agree on it, the two reconstructions coincide. Instantiated with `P v =`
"`v` is settled at the reference state", this is what makes the
reconstructed path resume-stable: the walk stays inside settled vertices
(`PInv.done_prev`), where `prev` is frozen (`iter_done_stable`). -/
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

The reconstructed `prev`-chain to `tgt`, read at a later trajectory point,
is the same as at the fresh first-stop — either the target *settled* (its
whole `prev` chain is done, frozen by `iter_done_stable`, closed by
`PInv.done_prev`) or the search *terminated* (a fixpoint, so the two states
coincide). This lifts the single-vertex `iter_stop_read_stable` to the whole
path the route result depends on. -/

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

The target `dist` and the whole reconstructed `prev`-chain that `settleTo`
returns from a valid (on-trajectory) cache are identical to those of a fresh
per-source settle — the route result reads nothing the cache's fill order
could vary. `dist` at the target is `iter_stop_read_stable`; the chain is
`qReconstruct_resume_stable`. Enough fuel (`totalOut g + 1`) discharges the
stop-reachability the resume lemmas assume. -/

/-- **`settleTo` reads-equality.** Under `OnTrajCache` and sufficient fuel,
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

/-- One endpoint-combo step of `routeBetween`: settle `ae.1 → be.1`
(threading the cache), and keep the lighter `(weighted, verts)` in `best`.
The cache is advanced on every branch; `best` changes only on a strictly
lighter, well-formed route. -/
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
`S`-scaled offsets, in the twin's iteration order. -/
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

/-- `routeBetween`'s twin. Offsets and the same-segment hop are µm via
`roundDiv`, lifted into the `S`-scaled weighted domain for the four
endpoint-combo comparisons; the reported distance is the true metric
length of the winning polyline. Threads the per-source `RouteCache`. The
2×2 loop is a `List.foldl` of `comboStep` over `routeCombos` (same output
as the twin's nested loop — the gate re-verifies), so the cache-purity
proof can induct over the combo list. -/
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

`comboStep`'s cache output is exactly `settleTo`'s, so `OnTrajCache` is
preserved (`comboStep_onTraj`); its `best` output reads the cache only
through the target `dist` and the reconstructed chain, both cache-invariant
(`settleTo_reads_eq`), so it is independent of which valid cache is threaded
(`comboStep_best_indep`). Folding those two facts over the combo list gives
`comboFold_best_indep`, and hence `qRouteBetween_route_pure`: the route
result is a pure function of the graph — not of the trellis's fill order —
which is what makes the matcher's declarative score model well-defined. -/

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

/-- **Combo-fold cache-independence.** Folding `comboStep` over the combos
from a valid cache yields a `best` independent of the cache (both stay valid
via `comboStep_onTraj`; each step's `best` is cache-invariant via
`comboStep_best_indep`). -/
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

/-- **Route-result purity.** `qRouteBetween`'s route result is the same for
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

def WALK_QPROFILE : QMatchProfile :=
  { minFixes := 3, radiusUm := 20000000, maxCandidatesPerFix := 6
    sigmaUm := 8000000, betaUm := 12000000, gapBridgeUm := 18000000
    detourFactor := 4, detourSlackUm := 250000000
    maxLenNum := 7, maxLenDen := 5, maxLenSlackUm := 200000000
    maxRoadlessNum := 2, maxRoadlessDen := 5
    corridorNearUm := 25000000, corridorFarUm := 80000000, corridorMaxPenalty := 40
    wayContinuityNats := 0, spurReturnUm := 25000000, spurMaxSpanVerts := 4
    simplifyTolUm := 5000000, buildingCrossFactor := 25, buildingSupportUm := 15000000 }

structure QObs where
  fix : QPt
  cands : Array QCand
  deriving Inhabited

structure QMatchResult where
  path : Array QPt
  routeDetail : Array QPt
  deriving Inhabited

structure QWalkMatchResult where
  path : Array QPt
  coarsePath : Array QPt
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

/-- `matchTrajectory`'s twin: candidate generation, the `2σ²β`-scaled
Viterbi over `qRouteBetween`, backtrack, interpolation, then simplify /
spur removal / length bail. -/
def qMatchTrajectory (fixes : Array QPt) (ways : Array QWay)
    (buildings : Array (Array QPt)) (P : QMatchProfile) : Option QMatchResult := Id.run do
  if fixes.size < P.minFixes then return none
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

  -- Score scale 2σ²β. null = −∞ (modelled as `Option Int`, `none`).
  let sig2x2 := 2 * P.sigmaUm * P.sigmaUm
  let switchPenScaled : Int := (P.wayContinuityNats * sig2x2 * P.betaUm : Nat)
  let emissionScaled := fun (d : Nat) => -((d * d * P.betaUm : Nat) : Int)

  let nObs := obs.size

  -- Phase A — route matrix. Fill `routeOf[t-1][j][i]` = the route from
  -- candidate `i` at layer `t-1` to candidate `j` at layer `t`, in the
  -- trellis's exact `(t, j, i)` order, threading the per-source cache. This is
  -- the same sequence of `qRouteBetween` calls the fused loop made — so the
  -- cache evolution and every route value are unchanged — hoisted ahead of the
  -- scoring so the trellis's edge weights are a pure function of a finished
  -- array (`qRouteBetween_route_pure` shows the fill order never mattered).
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
  let routeOf := routeAcc

  -- Phase B — the concrete first-order max-sum trellis (`MatchViterbi`): node
  -- score = the `2σ²β`-scaled emission, edge weight = transition − switch
  -- penalty (`-∞` when unrouteable), both read from the hoisted matrix. The
  -- production matcher *runs* the verified decoder `decodeFast`, whose returned
  -- chain is proved to attain the maximum declarative `pathScore` over every
  -- candidate chain (`MatchViterbi.decodeFast_argmax`) — no unverified
  -- imperative backtrack in the trust path. `none` (no finite-scoring chain)
  -- returns `none`, exactly the old terminal-argmax / all-unreachable bail.
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

  -- Assemble the interpolated route detail.
  let first := (obs.getD 0 default).cands.getD (chosen.getD 0 0) default
  let mut out : Array QPt := #[{ la := first.la, lo := first.lo, ts := (obs.getD 0 default).fix.ts }]
  for t in [1:nObs] do
    match ((routeOf.getD (t - 1) #[]).getD (chosen.getD t 0) #[]).getD (chosen.getD (t - 1) 0) none with
    | none => return none
    | some (_, verts) =>
      out := qAppendInterpolated out verts (obs.getD (t - 1) default).fix.ts (obs.getD t default).fix.ts

  let simplified := ((qSimplify (fun i => out.getD i default) out.size P.simplifyTolUm).map
    (fun i => out.getD i default))
  let cleaned := qRemoveSpurs P.spurReturnUm P.spurMaxSpanVerts simplified
  if cleaned.length < 2 then return none
  let cleanedArr := cleaned.toArray
  let rawLen := qPathLength fixes
  if qPathLength cleanedArr * P.maxLenDen > rawLen * P.maxLenNum + P.maxLenSlackUm * P.maxLenDen then
    return none
  return some { path := cleanedArr, routeDetail := out }

/-- `matchWalkSegment`'s twin (walk profile, trim + despike + splice). -/
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
    return some { path, coarsePath := cleaned }

/-! ## Honesty corollaries

The matcher never fabricates geometry: its display tail (`qTrim →
qDespike → qSplice`) only ever re-inserts real vertices near the tuned
coarse line. These specialise the already-proved pass theorems
(`Metric.lean`) to the walk result:

- `qMatchWalkSegment_coarse_drop_only` — every `coarsePath` vertex is a
  vertex of the trajectory path `r.path` (trim and despike are drop-only,
  so the decision layer is a subsequence of what the Viterbi produced);
- `qMatchWalkSegment_path_sound` — every drawn `path` vertex is either a
  `coarsePath` vertex or a timestamp-clamped route vertex lying within the
  splice `dropM` (`simplifyTolUm`, 5 m) of the coarse chord it was inserted
  against (`qSplice_sound`: an excision window past `dropM` inserts nothing;
  the `1.5 m` `tol` is the splice's internal simplify floor, #369's lower
  band).

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
        ({ path, coarsePath := cleaned } : QWalkMatchResult)) := by
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

/-! ## The reconstructed route is a valid costed path (routing-optimality, brick 1)

`reconGo` (the accumulator-threaded `prev`-walk) computes exactly `LazyEdge`'s
accumulator-free `chainList`, so the reconstructed vertex list is the reversed
chain. Composing with `LazyEdge`'s `chainList_reverse_pathCost_isSome` lifts
the per-`prev`-link edge fact (`EInv`) to the whole route: **under `EInv`, and
from any seed below the sentinel, `qReconstruct`'s output has a defined
`pathCost` in the shared `Verified.Rail.Graph` spec** — every step is a real
edge, so the matcher's route is a genuine costed walk of `g`, the "valid path"
half of the routing-optimality contract (`dijkstraC_correct`'s
`isValidPath`). The remaining half — that the cost equals `oracleDist` — is
the LoopInv-scale weight-optimality brick still to come. -/

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

/-- **The matcher's reconstructed route is a valid costed path.** Under the
edge-provenance invariant `EInv` (which holds along every lazy-search
trajectory — `iter_einv`/`linit_einv`), for any seed `start` below the
sentinel `g.n`, the reconstructed route has a defined `pathCost`: every
consecutive step is a genuine edge of `g`. -/
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

/-- **The matcher's reconstructed route costs exactly the search's answer.**
Composing `qReconstruct_toList` (the reconstruction is the reversed `prev`-chain)
with `iter_route_pathCost_eq` (the chain telescopes to the target distance): at
any trajectory state of a per-source lazy search, once the target `start` is
settled and its `prev`-chain has completed (enough reconstruction fuel — `g.n`),
the route's `pathCost` in the shared `Verified.Rail.Graph` spec is exactly
`dist[start]`. This is the exact-cost half of the null-over-wrong routing
contract: not just a valid path (`qReconstruct_pathCost_isSome_iter`) but a path
whose cost *is* the distance the search recorded. -/
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
