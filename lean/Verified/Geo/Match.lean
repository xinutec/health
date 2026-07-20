import Verified.Geo.Metric
import Verified.Geo.LazyFuel
import Verified.Geo.LazyResume
import Verified.Geo.LazyPrev

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

  `qRouteBetween`'s 2×2 loop is now a `List.foldl` of `comboStep` over
  `routeCombos` (gate re-verified bit-exact), the structural form the purity
  induction needs. *Remaining*: `comboStep` best-purity (its `best` output,
  under a valid cache, equals the fresh-settle `comboStepPure` — via the
  `settleTo` reads-equality: `dist` at the target by `lsettle_read_stable`,
  the reconstructed `verts` by `qReconstruct_congr`) + `OnTrajCache`
  preservation, folded over the combo list ⇒ route-result purity. Then the
  trellis `forIn` invariant and the argmax DP.
- **Flagship — Viterbi argmax** (planned): the returned coarse chain attains
  the maximum declarative score over all route-connected candidate chains,
  with the `none ⟺ no finite-score chain` companion — the matcher analogue
  of the HSMM `decode_correct`. First-order (no duration dimension), so a
  strictly simpler induction than the HSMM one; the one genuinely new
  obligation is the cache-purity bridge above.

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
  if p.la < lo then ((lo - p.la) * 11132).toNat
  else if p.la > hi then ((p.la - hi) * 11132).toNat
  else 0

/-! ## `QCorridor` — the GPS-corridor penalty -/

/-- The corridor's tuned parameters, `S = farUm − nearUm` precomputed. -/
structure QCorridor where
  fixes : Array QPt
  nearUm : Nat
  farUm : Nat
  maxPen : Nat
  S : Nat

def mkQCorridor (fixes : Array QPt) (nearUm farUm maxPen : Nat) : QCorridor :=
  { fixes, nearUm, farUm, maxPen, S := farUm - nearUm }

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
  qDist a b * co.penScaled (co.distTo mid)

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

/-- Prepared building set: rings (≥ 3 vertices), their bounding boxes,
the fixes, and the two tuned thresholds (`QBuildings` constructor). -/
structure QBuildings where
  rings : Array (Array QPt)
  boxes : Array QBox
  fixes : Array QPt
  crossFactor : Nat
  supportUm : Nat

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
  return { rings, boxes, fixes, crossFactor, supportUm }

def QBuildings.inAnyRing (bld : QBuildings) (p : QPt) : Bool := Id.run do
  for i in [0:bld.rings.size] do
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
    if bld.inAnyRing s && !bld.fixSupports s then return bld.crossFactor
  return 1

/-! ## Graph build (part 2)

The routing graph reuses `Verified/Rail/Graph.lean`'s `Graph` (weighted
adjacency, `Nat` scalars) with weights precomputed eagerly in the µm·S
scale — memo-transparent to the twin's lazy `weightOf`, and routing then
reuses the fully-proved `LazyDijkstra` machinery (`linit`/`lsettle`). -/

open Verified.Rail (Graph)

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
  let graph := buildQGraph ways co bld P.gapBridgeUm
  if graph.segments.size == 0 then return none

  let mut obs : Array QObs := #[]
  let mut roadless : Nat := 0
  for fix in fixes do
    let cands := qCandidatesForFix fix graph P.radiusUm P.maxCandidatesPerFix
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
  let mut score : Array (Array (Option Int)) := #[]
  let mut back : Array (Array Int) := #[]
  let mut routeOf : Array (Array (Array (Option (Int × Array QPt)))) := #[]
  score := score.push ((obs.getD 0 default).cands.map (fun c => some (emissionScaled c.dist)))
  back := back.push ((obs.getD 0 default).cands.map (fun _ => (-1 : Int)))

  for t in [1:nObs] do
    let prev := obs.getD (t - 1) default
    let cur := obs.getD t default
    let gpsStep := qDist prev.fix cur.fix
    let mut row : Array (Option Int) := #[]
    let mut brow : Array Int := #[]
    let mut rmat : Array (Array (Option (Int × Array QPt))) := #[]
    for j in [0:cur.cands.size] do
      let mut bestScore : Option Int := none
      let mut bestPrev : Int := -1
      let mut rrow : Array (Option (Int × Array QPt)) := #[]
      for i in [0:prev.cands.size] do
        let (route, rc) := qRouteBetween (prev.cands.getD i default) (cur.cands.getD j default)
          graph bld S maxR fuel routeCache
        routeCache := rc
        rrow := rrow.push route
        match route with
        | none => pure ()
        | some (distUm, _) =>
          match (score.getD (t - 1) #[]).getD i none with
          | none => pure ()
          | some ps =>
            let trans : Int := -(((distUm - (gpsStep : Int)).natAbs : Int) * (sig2x2 : Int))
            let wa := (graph.segments.getD (prev.cands.getD i default).si default).name
            let wb := (graph.segments.getD (cur.cands.getD j default).si default).name
            let switchPen : Int :=
              match wa, wb with
              | some sa, some sb => if sa ≠ "" && sb ≠ "" && sa ≠ sb then switchPenScaled else 0
              | _, _ => 0
            let s := ps + trans - switchPen + emissionScaled (cur.cands.getD j default).dist
            match bestScore with
            | none => bestScore := some s; bestPrev := (i : Int)
            | some bs => if s > bs then bestScore := some s; bestPrev := (i : Int)
      row := row.push bestScore
      brow := brow.push bestPrev
      rmat := rmat.push rrow
    if row.all (·.isNone) then return none
    score := score.push row
    back := back.push brow
    routeOf := routeOf.push rmat

  -- Terminal argmax + backtrack.
  let lastRow := score.getD (nObs - 1) #[]
  let mut endJ : Nat := 0
  let mut endBest : Option Int := none
  for j in [0:lastRow.size] do
    match lastRow.getD j none with
    | none => pure ()
    | some s =>
      match endBest with
      | none => endBest := some s; endJ := j
      | some eb => if s > eb then endBest := some s; endJ := j
  if endBest.isNone then return none
  let mut chosen : Array Nat := Array.replicate nObs 0
  chosen := chosen.setIfInBounds (nObs - 1) endJ
  for k in [0:nObs - 1] do
    let t := nObs - 1 - k
    let bp := (back.getD t #[]).getD (chosen.getD t 0) (-1)
    if bp < 0 then return none
    chosen := chosen.setIfInBounds (t - 1) bp.toNat

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

end Verified.Geo
