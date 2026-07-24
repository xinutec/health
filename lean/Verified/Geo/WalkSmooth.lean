import Verified.Geo.WalkEscape
import Std.Data.HashMap
import Std.Data.HashSet

/-!
# Continuous MAP walk reconstruction (port of `src/geo/walk-smooth-map.ts`)

A walk is drawn as the maximum-a-posteriori continuous trajectory rather than
the cheapest network path that touches the GPS dots. Three factors are fused —
an accuracy-weighted GPS emission, a smoothness/physics prior on the second
difference, and SOFT walkable-surface adherence — so the artifacts the cleanup
passes chase (invented out-and-back detours, apex spikes, right-angle
staircases) are low-probability under the model and never form.

All factors are quadratic once the attractor targets are fixed, so each outer
iteration is a linear least squares; the two coordinates decouple and the normal
matrix is SPD and pentadiagonal, solved by Jacobi-preconditioned conjugate
gradient with the targets recomputed each outer iteration (ICP-style).

`reconstructWalk` is the robust upgrade: a redescending Geman-McClure emission
annealed by graduated non-convexity (deterministic, no RNG — the golden corpus
needs reproducibility), plus building repulsion, endpoint anchors and a
pedometer-derived step-magnitude contraction.

The module is pure geometry and linear algebra, so all of it ports. What stays
shell: `reconstructProfileFromEnv` (env reads — the caller passes a resolved
profile) and the `WALK_RECON_DEBUG` tracing.

`Math.hypot` is `sqrt (x² + y²)` here, as elsewhere in this port. It agrees to
≤1 ULP, and the PCG converges to a relative residual of 1e-14, so the solved
positions agree far below any geographic significance — but they are NOT
bit-identical, and the guards below compare with a tolerance rather than `==`.
-/

namespace Verified.Geo.WalkSmooth

open Verified.Geo.WalkableRoute (Pt metersBetween projectPointToSegment)
open Verified.Geo.WalkEscape (Ring Ways TPt nearestWalkable routeChordAroundBuildings)

private def pi : Float := 3.14159265358979323846
private def posInf : Float := 1.0 / 0.0
private def negInf : Float := -1.0 / 0.0

/-- JS `x || 1`: zero and NaN are falsy. -/
private def orOne (x : Float) : Float := if x == 0 || x.isNaN then 1 else x
/-- `Math.round`. -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)
private def floorInt (x : Float) : Int := (Float.floor x).toInt64.toInt
private def hyp (x y : Float) : Float := Float.sqrt (x * x + y * y)

/-- One GPS fix to reconstruct. `accuracyM` is the reported horizontal accuracy;
    when absent the profile fallback σ is used. -/
structure WalkFix where
  lat : Float
  lon : Float
  ts : Float
  accuracyM : Option Float := none
  deriving Inhabited, Repr

/-- One reconstructed path vertex with its (fix) timestamp. -/
abbrev SmoothedPoint := TPt

/-! ## The linear solve

`A = diag(d) + wAcc·LᵀL + wEdge·D₁ᵀD₁`, with `L` the second-difference
(biharmonic) stencil `[1, −2, 1]` and `D₁` the first-difference stencil
`[−1, 1]`. `d` is the combined GPS + network diagonal; `wEdge` (0 = absent) is
the uniform edge weight of the step-magnitude contraction factor.
-/

/-- Apply `A` to a vector, matrix-free. -/
def applyA (v d : Array Float) (wAcc : Float) (wEdge : Float := 0) : Array Float := Id.run do
  let n := v.size
  let mut out := Array.replicate n 0.0
  for i in [0:n] do
    out := out.set! i (d[i]! * v[i]!)
  -- Lv has length n-2: (Lv)[k] = v[k] − 2v[k+1] + v[k+2]; scatter LᵀLv back
  -- onto rows k (+1), k+1 (−2), k+2 (+1).
  for k in [0:n] do
    if k + 2 < n then
      let lv := wAcc * (v[k]! - 2 * v[k+1]! + v[k+2]!)
      out := out.set! k (out[k]! + lv)
      out := out.set! (k+1) (out[k+1]! - 2 * lv)
      out := out.set! (k+2) (out[k+2]! + lv)
  if wEdge > 0 then
    -- Scatter D₁ᵀD₁v: edge k couples rows k (−) and k+1 (+).
    for k in [0:n] do
      if k + 1 < n then
        let f := wEdge * (v[k+1]! - v[k]!)
        out := out.set! k (out[k]! - f)
        out := out.set! (k+1) (out[k+1]! + f)
  return out

/-- Diagonal of `A`, for Jacobi preconditioning. The biharmonic stencil
    contributes 1/5/6/5/1 down the band; the first-difference stencil 1/2/…/2/1. -/
def diagOfA (d : Array Float) (wAcc : Float) (wEdge : Float := 0) : Array Float := Id.run do
  let n := d.size
  let mut out := Array.replicate n 0.0
  for i in [0:n] do
    let mut ltl := 0.0
    -- `i ≤ n-3`, `0 ≤ i-1 ≤ n-3`, `0 ≤ i-2 ≤ n-3` — written additively because
    -- Nat subtraction truncates where the JS number goes negative.
    if i + 3 ≤ n then ltl := ltl + 1
    if i ≥ 1 && i + 2 ≤ n then ltl := ltl + 4
    if i ≥ 2 && i + 1 ≤ n then ltl := ltl + 1
    let mut d1 := 0.0
    if i + 2 ≤ n then d1 := d1 + 1
    if i ≥ 1 then d1 := d1 + 1
    out := out.set! i (d[i]! + wAcc * ltl + wEdge * d1)
  return out

/-- Solve the SPD system `A x = b` by Jacobi-preconditioned conjugate gradient,
    seeded at `x0`. -/
def solvePCG (d : Array Float) (wAcc : Float) (b x0 : Array Float)
    (wEdge : Float := 0) : Array Float := Id.run do
  let n := b.size
  let mut invDiag := diagOfA d wAcc wEdge
  for i in [0:n] do
    invDiag := invDiag.set! i (1 / invDiag[i]!)
  let mut x := x0
  let ax0 := applyA x d wAcc wEdge
  let mut r := Array.replicate n 0.0
  for i in [0:n] do
    r := r.set! i (b[i]! - ax0[i]!)
  let mut z := Array.replicate n 0.0
  for i in [0:n] do
    z := z.set! i (invDiag[i]! * r[i]!)
  let mut p := z
  let mut rz := 0.0
  for i in [0:n] do
    rz := rz + r[i]! * z[i]!
  let mut bNorm := 0.0
  for i in [0:n] do
    bNorm := bNorm + b[i]! * b[i]!
  let tol2 := max 1e-18 (bNorm * 1e-14)
  let maxIter := min (2 * n + 50) 2000
  let mut it := 0
  let mut stop := false
  while it < maxIter && !stop do
    let ap := applyA p d wAcc wEdge
    let mut pap := 0.0
    for i in [0:n] do
      pap := pap + p[i]! * ap[i]!
    -- Numerical guard: A is SPD, so this is only round-off.
    if pap ≤ 0 then
      stop := true
    else
      let alpha := rz / pap
      for i in [0:n] do
        x := x.set! i (x[i]! + alpha * p[i]!)
        r := r.set! i (r[i]! - alpha * ap[i]!)
      let mut rNorm := 0.0
      for i in [0:n] do
        rNorm := rNorm + r[i]! * r[i]!
      if rNorm ≤ tol2 then
        stop := true
      else
        for i in [0:n] do
          z := z.set! i (invDiag[i]! * r[i]!)
        let mut rzNew := 0.0
        for i in [0:n] do
          rzNew := rzNew + r[i]! * z[i]!
        let beta := rzNew / rz
        for i in [0:n] do
          p := p.set! i (z[i]! + beta * p[i]!)
        rz := rzNew
        it := it + 1
  return x

/-! ## `smoothWalkMap` -/

/-- Tuning for {@link smoothWalkMap}. All σ are metres; a weight is `1/σ²`, so a
    SMALLER σ means that factor is trusted MORE. -/
structure MapSmoothProfile where
  /-- Below this many fixes there is nothing to smooth — return `none`. -/
  minFixes : Nat := 4
  gpsSigmaFallbackM : Float := 15
  gpsSigmaMinM : Float := 4
  /-- Scale of the tolerated second difference: smaller → stiffer, straighter. -/
  smoothSigmaM : Float := 6
  /-- How tightly to hug the walkable surface. -/
  networkSigmaM : Float := 12
  /-- Only attract within this radius; beyond it the state is on open ground. -/
  networkRadiusM : Float := 25
  /-- Outer ICP iterations (attractor re-linearisation). -/
  iterations : Nat := 6
  deriving Inhabited

/-- Refining an already map-matched line: the attractor is the vetted matched
    path itself (a single corridor), so there is no wrong-parallel-way to flip
    onto. The network σ is deliberately loose so the corners can round; it is the
    raw GPS that says where the true diagonal was. -/
def REFINE_MATCHED_PROFILE : MapSmoothProfile :=
  { minFixes := 4, gpsSigmaFallbackM := 12, gpsSigmaMinM := 4,
    smoothSigmaM := 5, networkSigmaM := 14, networkRadiusM := 45, iterations := 6 }

/-- Reconstruct a walk leg as the MAP continuous trajectory. One vertex per fix,
    timestamps preserved; `none` when the leg is too short. -/
def smoothWalkMap (fixes : Array WalkFix) (walkable : Ways)
    (profile : MapSmoothProfile := {}) : Option (Array SmoothedPoint) := Id.run do
  let n := fixes.size
  if n < profile.minFixes then return none

  -- Local equirectangular frame (metres) anchored at the first fix.
  let lat0 := fixes[0]!.lat
  let lon0 := fixes[0]!.lon
  let cosLat := Float.cos (lat0 * pi / 180)
  let toE := fun (lon : Float) => (lon - lon0) * 111320.0 * cosLat
  let toN := fun (lat : Float) => (lat - lat0) * 111320.0
  let toLon := fun (e : Float) => lon0 + e / (111320.0 * cosLat)
  let toLat := fun (m : Float) => lat0 + m / 111320.0

  let mut ze := Array.replicate n 0.0
  let mut zn := Array.replicate n 0.0
  let mut wGps := Array.replicate n 0.0
  for i in [0:n] do
    ze := ze.set! i (toE fixes[i]!.lon)
    zn := zn.set! i (toN fixes[i]!.lat)
    let sigma := max profile.gpsSigmaMinM (fixes[i]!.accuracyM.getD profile.gpsSigmaFallbackM)
    wGps := wGps.set! i (1 / (sigma * sigma))
  let wAcc := 1 / (profile.smoothSigmaM * profile.smoothSigmaM)
  let wNetFull := 1 / (profile.networkSigmaM * profile.networkSigmaM)

  -- Initialise the estimate at the raw fixes.
  let mut e := ze
  let mut nn := zn

  for _iter in [0:profile.iterations] do
    -- Re-linearise the network attractor at the current estimate.
    let mut d := Array.replicate n 0.0
    let mut be := Array.replicate n 0.0
    let mut bn := Array.replicate n 0.0
    for i in [0:n] do
      d := d.set! i wGps[i]!
      be := be.set! i (wGps[i]! * ze[i]!)
      bn := bn.set! i (wGps[i]! * zn[i]!)
      if !walkable.isEmpty then
        let cur : Pt := ⟨toLat nn[i]!, toLon e[i]!⟩
        match nearestWalkable cur walkable with
        | none => pure ()
        | some near =>
          if near.distM ≤ profile.networkRadiusM then
            d := d.set! i (d[i]! + wNetFull)
            be := be.set! i (be[i]! + wNetFull * toE near.lon)
            bn := bn.set! i (bn[i]! + wNetFull * toN near.lat)
    e := solvePCG d wAcc be e
    nn := solvePCG d wAcc bn nn

  let mut out : Array SmoothedPoint := #[]
  for i in [0:n] do
    out := out.push ⟨toLat nn[i]!, toLon e[i]!, fixes[i]!.ts⟩
  return some out

/-! ## Path shape metrics -/

/-- Count the sharp direction changes — turns of at least `thresholdDeg`. This is
    the de-boxing witness the off-walkable metric is blind to: a graph-snapped
    line is full of ~90° staircase corners the true walk cut across. -/
def countSharpTurns (pts : Array Pt) (thresholdDeg : Float := 50) : Nat := Id.run do
  if pts.size < 3 then return 0
  let mut count := 0
  for i in [1:pts.size - 1] do
    let cl := Float.cos (pts[i]!.lat * pi / 180)
    let ux := (pts[i]!.lon - pts[i-1]!.lon) * cl
    let uy := pts[i]!.lat - pts[i-1]!.lat
    let vx := (pts[i+1]!.lon - pts[i]!.lon) * cl
    let vy := pts[i+1]!.lat - pts[i]!.lat
    let un := hyp ux uy
    let vn := hyp vx vy
    if un ≥ 1e-12 && vn ≥ 1e-12 then
      let turnDeg := (Float.acos (max (-1) (min 1 ((ux * vx + uy * vy) / (un * vn)))) * 180) / pi
      if turnDeg ≥ thresholdDeg then count := count + 1
  return count

/-- Straight-line-normalised path length (drawn ÷ end-to-end) — the smoother's
    headline effect is a lower tortuosity. -/
def tortuosity (pts : Array Pt) : Float := Id.run do
  if pts.size < 2 then return 1
  let mut len := 0.0
  for i in [1:pts.size] do
    len := len + metersBetween pts[i-1]! pts[i]!
  let straight := metersBetween pts[0]! pts[pts.size - 1]!
  return if straight > 1 then len / straight else 1

/-! ## `refineMatchedPath` -/

/-- How far (m) from a staircase-artifact corner the full de-boxing budget
    reaches; it tapers linearly to the tight budget at this distance. -/
private def REFINE_CORNER_REACH_M : Float := 30
/-- Sharp corners clustered within this of each other are the STAIRCASE-ARTIFACT
    signature. An isolated sharp corner is real street geometry: the walked
    pavement goes AROUND it, so "rounding" it puts the line through the corner
    building. -/
private def REFINE_STAIRCASE_NEIGHBOR_M : Float := 25
/-- A real pedestrian-crossing double-back is exactly TWO clustered sharp
    corners; a genuine staircase has many. -/
private def REFINE_STAIRCASE_MIN_NEIGHBORS : Nat := 2
/-- Deviation budget (m) outside a staircase artifact — enough to soften vertex
    hairlines, far too little to split the difference toward GPS wobble. -/
private def REFINE_STRAIGHT_DEVIATION_M : Float := 2.5
/-- A gap whose insertions would grow the chord past BOTH bounds is not a skipped
    corner but a matcher route spur. Two bounds because a right angle fits under
    √2 while an ACUTE double-back junction measured ~1.68×. -/
private def SPLICE_MAX_LEN_RATIO : Float := 1.6
private def SPLICE_MAX_EXTRA_M : Float := 50

/-- Refine an already map-matched walk line: round its corners toward where the
    raw GPS actually was, using the matched path itself as the on-route
    corridor. `none` when the matched path or the fix count is too thin.

    The robust half of the continuous smoother — attracting to the one vetted
    line rather than the whole walkable network keeps the matcher's
    route-faithfulness while gaining the smoother's natural geometry. -/
def refineMatchedPath (fixes : Array WalkFix) (matchedPath : Array Pt)
    (profile : MapSmoothProfile := REFINE_MATCHED_PROFILE)
    (maxDeviationM : Float := 12) : Option (Array SmoothedPoint) := Id.run do
  if matchedPath.size < 2 then return none
  let corridor : Ways := #[matchedPath]
  let some smoothed := smoothWalkMap fixes corridor profile | return none

  -- The refinement's mandate is the STAIRCASE ARTIFACT, so its licence to leave
  -- the matched line is LOCAL: the full budget within reach of a CLUSTERED sharp
  -- corner, tapering to a tight budget everywhere else.
  let cl := Float.cos (matchedPath[0]!.lat * pi / 180)
  let distM := fun (a b : Pt) => hyp ((a.lat - b.lat) * 111320.0) ((a.lon - b.lon) * 111320.0 * cl)
  let mut corners : Array Pt := #[]
  for i in [1:matchedPath.size - 1] do
    if countSharpTurns (matchedPath.extract (i-1) (i+2)) > 0 then
      corners := corners.push matchedPath[i]!
  let mut artifactCorners : Array Pt := #[]
  for i in [0:corners.size] do
    let mut near := 0
    for j in [0:corners.size] do
      if j != i && distM corners[i]! corners[j]! ≤ REFINE_STAIRCASE_NEIGHBOR_M then
        near := near + 1
    if near ≥ REFINE_STAIRCASE_MIN_NEIGHBORS then artifactCorners := artifactCorners.push corners[i]!
  let budgetAt := fun (p : Pt) => Id.run do
    let mut dMin := posInf
    for c in artifactCorners do
      dMin := min dMin (distM p c)
    let t := min 1 (dMin / REFINE_CORNER_REACH_M)
    return maxDeviationM + (REFINE_STRAIGHT_DEVIATION_M - maxDeviationM) * t

  -- Faithfulness clamp: any vertex past its local budget is pulled radially back
  -- to the budget radius, so a corner-cut survives while a straight stretch stays
  -- on the line and a block-crossing excursion is capped everywhere.
  let clamped := smoothed.map fun p =>
    match nearestWalkable p.pt corridor with
    | none => p
    | some near =>
      let budget := budgetAt p.pt
      if near.distM ≤ budget then p
      else
        let f := budget / near.distM
        ⟨near.lat + (p.lat - near.lat) * f, near.lon + (p.lon - near.lon) * f, p.ts⟩

  -- Splice back skipped route vertices: the smoother resamples the matched line
  -- one-vertex-per-FIX, so a route corner with no fix near it vanishes and the
  -- chord cuts the block — a defect the per-vertex clamp is structurally blind to
  -- (every VERTEX is on-route; the EDGE shortcuts).
  let toXY := fun (p : Pt) =>
    ((p.lon - matchedPath[0]!.lon) * 111320.0 * cl, (p.lat - matchedPath[0]!.lat) * 111320.0)
  let mut cum : Array Float := #[0.0]
  for i in [1:matchedPath.size] do
    cum := cum.push (cum[i-1]! + distM matchedPath[i-1]! matchedPath[i]!)
  -- Arclength of the nearest point on the matched line to `p`.
  let arcOf := fun (p : Pt) => Id.run do
    let (px, py) := toXY p
    let mut bestD := posInf
    let mut bestS := 0.0
    for i in [1:matchedPath.size] do
      let (ax, ay) := toXY matchedPath[i-1]!
      let (bx, by') := toXY matchedPath[i]!
      let dx := bx - ax
      let dy := by' - ay
      let len2 := if dx * dx + dy * dy == 0 then 1e-9 else dx * dx + dy * dy
      let t := max 0 (min 1 (((px - ax) * dx + (py - ay) * dy) / len2))
      let dd := hyp (px - (ax + t * dx)) (py - (ay + t * dy))
      if dd < bestD then
        bestD := dd
        bestS := cum[i-1]! + Float.sqrt len2 * t
    return bestS
  let chordDistM := fun (v a b : Pt) =>
    let (px, py) := toXY v
    let (ax, ay) := toXY a
    let (bx, by') := toXY b
    let dx := bx - ax
    let dy := by' - ay
    let len2 := if dx * dx + dy * dy == 0 then 1e-9 else dx * dx + dy * dy
    let t := max 0 (min 1 (((px - ax) * dx + (py - ay) * dy) / len2))
    hyp (px - (ax + t * dx)) (py - (ay + t * dy))
  let arcs := clamped.map (fun p => arcOf p.pt)

  -- Which route vertices does each gap owe? A gap's endpoints get SNAPPED onto
  -- the route when it receives an insertion — a restored corner entered and left
  -- from 2.5 m beside the line would otherwise kink at the seams.
  let mut inserts : Array (Array Nat) := Array.replicate clamped.size #[]
  let mut snapToRoute : Std.HashSet Nat := {}
  for i in [0:clamped.size] do
    if i + 1 < clamped.size then
      let sA := arcs[i]!
      let sB := arcs[i+1]!
      -- Forward progress only — never splice across a backtracking pair.
      if sB > sA then
        let mut gap : Array Nat := #[]
        for k in [0:matchedPath.size] do
          if cum[k]! > sA && cum[k]! < sB
             && chordDistM matchedPath[k]! clamped[i]!.pt clamped[i+1]!.pt > budgetAt matchedPath[k]! then
            gap := gap.push k
        if !gap.isEmpty then
          let mut chain : Array Pt := #[clamped[i]!.pt]
          for k in gap do chain := chain.push matchedPath[k]!
          chain := chain.push clamped[i+1]!.pt
          let mut pathLen := 0.0
          for k in [1:chain.size] do
            pathLen := pathLen + distM chain[k-1]! chain[k]!
          let chord := max 1 (distM clamped[i]!.pt clamped[i+1]!.pt)
          -- BOUNDED DETOUR ONLY: past both bounds this is a route spur, not a
          -- skipped corner, and reinstating one measured a leg 11→300 m.
          if !(pathLen > chord * SPLICE_MAX_LEN_RATIO && pathLen - chord > SPLICE_MAX_EXTRA_M) then
            inserts := inserts.set! i gap
            snapToRoute := (snapToRoute.insert i).insert (i+1)
  if snapToRoute.isEmpty then return some clamped

  let positioned := clamped.mapIdx fun i p =>
    if !snapToRoute.contains i then p
    else match nearestWalkable p.pt corridor with
      | some near => ⟨near.lat, near.lon, p.ts⟩
      | none => p
  let mut out : Array SmoothedPoint := #[positioned[0]!]
  for i in [0:positioned.size] do
    if i + 1 < positioned.size then
      let a := positioned[i]!
      let b := positioned[i+1]!
      for k in inserts[i]! do
        let frac := (cum[k]! - arcs[i]!) / (arcs[i+1]! - arcs[i]!)
        out := out.push ⟨matchedPath[k]!.lat, matchedPath[k]!.lon,
                         jsRound (a.ts + (b.ts - a.ts) * frac)⟩
      out := out.push b
  return some out

/-! ## `reconstructWalk` — the robust, annealed MAP reconstruction

The upgrade over `smoothWalkMap`: NO input is trusted as ground truth. The plain
smoother is a convex weighted least-squares — it believes every fix's position,
so a tight cluster of confidently-wrong fixes (a post-tunnel GPS reacquire
smear) still wins and the line detours to follow it. This fixes that with a
SMARTER MINIMISER, not more trust in the numbers: a redescending Geman-McClure
emission (outliers inferred from mutual inconsistency, not the reported
accuracy), graduated non-convexity as deterministic annealing, accuracy as a
weak clamped scale prior only, the map as first-class factors including a
one-sided building repulsion, and optional endpoint anchors.
-/

/-- A soft endpoint anchor: pull a terminal state toward a confident coordinate. -/
structure WalkAnchor where
  lat : Float
  lon : Float
  /-- Trust as a Gaussian σ (m); smaller pins harder. -/
  sigmaM : Float
  deriving Inhabited, Repr

/-- Independent evidence beyond the GPS/map factors: endpoint anchors and the
    leg's pedometer count. -/
structure WalkEvidence where
  start : Option WalkAnchor := none
  finish : Option WalkAnchor := none
  /-- Steps recorded within the leg's window; `none` = no step data, factor off. -/
  stepsWalked : Option Float := none
  deriving Inhabited, Repr

structure ReconstructProfile where
  minFixes : Nat := 4
  /-- Accuracy → weak per-fix trust: the reported accuracy is CLAMPED to this
      band before becoming the base σ — a nudge, not a verdict. -/
  accClampMinM : Float := 10
  accClampMaxM : Float := 35
  accFallbackM : Float := 20
  /-- Anneal the GM kernel scale from `gncStartM` (large → convex, everything an
      inlier) down to `gncTargetM` (redescending → rejects gross outliers). -/
  gncStartM : Float := 60
  gncTargetM : Float := 20
  gncSteps : Nat := 8
  /-- IRLS / attractor re-linearisations per anneal step. -/
  innerIters : Nat := 2
  /-- What carries the path THROUGH a rejected outlier. -/
  smoothSigmaM : Float := 6
  networkSigmaM : Float := 5
  networkRadiusM : Float := 25
  /-- Redescending scale for the network attraction: a state CLOSE to a way is
      hugged hard (matcher-like on clean GPS) while a state far from any way
      barely tugs. The hard/soft unification — adaptive by distance-to-network. -/
  networkRobustM : Float := 12
  /-- Building-repulsion σ; small → buildings are near-impassable. -/
  buildingSigmaM : Float := 1.5
  /-- Clearance band (m): a state is repelled to at least this far OUTSIDE the
      nearest wall whenever it is inside a footprint OR within the band outside
      it. A field, so a chord grazing a corner is pushed off the wall even with
      no vertex inside it. -/
  buildingClearM : Float := 4
  /-- Densify the state chain to ≤ this spacing by inserting FREE states.
      Effectively OFF by default (vertex-per-fix): measured 2026-07-07, free
      states did NOT reduce building-crossing (those residuals are OSM graph
      gaps) and inflated corridor-stall ~2×. -/
  targetSpacingM : Float := 100000
  /-- A FREE state's weak, non-robust tether toward its interpolated position on
      the raw GPS corridor. Large → nearly free. -/
  freeTetherSigmaM : Float := 40
  /-- Mean stride (m/step) converting the leg's pedometer count into a
      displacement budget. -/
  stepStrideM : Float := 0.75
  /-- Drawn length up to `budget × slack` draws no force — stride variance, GPS
      length inflation, honest pedometer undercount. -/
  stepSlackRatio : Float := 1.4
  stepSigmaM : Float := 20
  /-- Width (in excess ratio above 1) over which the quadratic ramp reaches
      σ-strength. The slack already absorbs all LEGITIMATE variance, so beyond it
      the violation turns physically impossible over a narrow band. -/
  stepRampWidthRatio : Float := 0.25
  stepRampCap : Float := 16
  /-- Extra re-linearisations at the final GNC scale while the step budget is
      still violated: a smear contracts a bounded distance per solve, so the
      fixed schedule alone leaves a gross one half-collapsed. -/
  stepExtraIters : Nat := 12
  /-- REFUTED on the corpus (2026-07-14) — it INTRODUCED crossings on 2 clean
      walks and netted ~nothing, the soft clearance field already doing the
      vertex work. Ported and pinned; shipped OFF. -/
  hardProjectBuildings : Bool := false
  /-- SHIPS: ΣoffPath 1081→987 m, walks-with-crossings 36→30, zero introduced
      crossings. Routes an output edge that still passes through a footprint
      around that ring's own corners. -/
  insertCornerDetours : Bool := true
  /-- ≥ this many CONSECUTIVE observed fixes raw-inside the SAME footprint =
      genuine indoor presence: the building is occupied, not an obstacle.
      Weight-don't-filter — evidence of entry beats the impossibility prior. -/
  indoorPresenceMinFixes : Nat := 3
  /-- A state within this of a walkable way is never hard-projected: the
      mapped-passage class is owned by the way attraction, not the building
      constraint. -/
  passageWayReachM : Float := 8
  deriving Inhabited

/-- Geman-McClure IRLS weight for residual `r` at kernel scale `c`:
    `(c²/(c²+r²))²` ∈ (0,1]. Redescending — →1 as r→0 (full trust), →0 as r≫c
    (rejected). Large c ⇒ ≈1 everywhere (quadratic); small c ⇒ sharp rejection. -/
def gmWeight (r c : Float) : Float :=
  let c2 := c * c
  let t := c2 / (c2 + r * r)
  t * t

/-- Closest point on the metric segment `a→b` to `(px,py)`, clamped, with its
    SQUARED distance (avoids a sqrt in the hot loop). -/
structure MetricProj where
  x : Float
  y : Float
  d2 : Float
  deriving Inhabited, Repr

def projMetric (px py ax ay bx by' : Float) : MetricProj :=
  let dx := bx - ax
  let dy := by' - ay
  let len2 := if dx * dx + dy * dy == 0 then 1e-9 else dx * dx + dy * dy
  let t0 := ((px - ax) * dx + (py - ay) * dy) / len2
  let t := if t0 < 0 then 0 else if t0 > 1 then 1 else t0
  let x := ax + t * dx
  let y := ay + t * dy
  let ex := px - x
  let ey := py - y
  { x, y, d2 := ex * ex + ey * ey }

/-- One building ring in the metric frame: flat `[x,y,…]` plus its bbox. -/
structure MetricRing where
  pts : Array Float
  minx : Float
  miny : Float
  maxx : Float
  maxy : Float
  deriving Inhabited

/-- A uniform-grid spatial index over the leg's walkable segments and building
    rings, in the local metric frame — an O(states × local-cell) lookup instead
    of O(states × all-segments). Built once per leg. -/
structure WalkGrid where
  cell : Float
  /-- Flat `[ax,ay,bx,by]` × nSeg, metric. -/
  seg : Array Float
  segCells : Std.HashMap Int (Array Nat)
  rings : Array MetricRing
  ringCells : Std.HashMap Int (Array Nat)
  deriving Inhabited

/-- Cell key: pack signed cell coords into one number (cells fit in ±32k). -/
private def gridKey (cx cy : Int) : Int := (cx + 32768) * 65536 + (cy + 32768)

private def insertBox (m : Std.HashMap Int (Array Nat)) (cell : Float) (id : Nat)
    (minx miny maxx maxy : Float) : Std.HashMap Int (Array Nat) := Id.run do
  let mut m := m
  let mut cx := floorInt (minx / cell)
  let hiX := floorInt (maxx / cell)
  let loY := floorInt (miny / cell)
  let hiY := floorInt (maxy / cell)
  while cx ≤ hiX do
    let mut cy := loY
    while cy ≤ hiY do
      let k := gridKey cx cy
      m := m.insert k ((m.getD k #[]).push id)
      cy := cy + 1
    cx := cx + 1
  return m

def mkWalkGrid (segs : Array (Array Float)) (ringPts : Array (Array Float)) (cell : Float) : WalkGrid := Id.run do
  let mut seg := Array.replicate (segs.size * 4) 0.0
  let mut segCells : Std.HashMap Int (Array Nat) := {}
  for i in [0:segs.size] do
    let s := segs[i]!
    seg := seg.set! (i*4) s[0]!
    seg := seg.set! (i*4+1) s[1]!
    seg := seg.set! (i*4+2) s[2]!
    seg := seg.set! (i*4+3) s[3]!
    segCells := insertBox segCells cell i
      (min s[0]! s[2]!) (min s[1]! s[3]!) (max s[0]! s[2]!) (max s[1]! s[3]!)
  let mut rings : Array MetricRing := #[]
  let mut ringCells : Std.HashMap Int (Array Nat) := {}
  for r in [0:ringPts.size] do
    let pts := ringPts[r]!
    let mut minx := posInf
    let mut miny := posInf
    let mut maxx := negInf
    let mut maxy := negInf
    let mut k := 0
    while k < pts.size do
      minx := min minx pts[k]!
      maxx := max maxx pts[k]!
      miny := min miny pts[k+1]!
      maxy := max maxy pts[k+1]!
      k := k + 2
    rings := rings.push { pts, minx, miny, maxx, maxy }
    ringCells := insertBox ringCells cell r minx miny maxx maxy
  return { cell, seg, segCells, rings, ringCells }

/-- Nearest point on any walkable segment to `(px,py)` within `maxR`, with the
    winning segment's unit tangent — so the caller can build a NORMAL-ONLY
    (point-to-line) attraction: hugging the way must not resist sliding along it. -/
structure NearSeg where
  x : Float
  y : Float
  distM : Float
  tx : Float
  ty : Float
  deriving Inhabited, Repr

def WalkGrid.nearest (g : WalkGrid) (px py maxR : Float) : Option NearSeg := Id.run do
  let c := g.cell
  let R := floorInt (max 1 (Float.ceil (maxR / c)))
  let cx0 := floorInt (px / c)
  let cy0 := floorInt (py / c)
  let mut best := maxR * maxR
  let mut bx := 0.0
  let mut by' := 0.0
  let mut bestSeg : Int := -1
  let mut seen : Std.HashSet Nat := {}
  let mut cx := cx0 - R
  while cx ≤ cx0 + R do
    let mut cy := cy0 - R
    while cy ≤ cy0 + R do
      for i in g.segCells.getD (gridKey cx cy) #[] do
        if !seen.contains i then
          seen := seen.insert i
          let p := projMetric px py g.seg[i*4]! g.seg[i*4+1]! g.seg[i*4+2]! g.seg[i*4+3]!
          if p.d2 < best then
            best := p.d2
            bx := p.x
            by' := p.y
            bestSeg := Int.ofNat i
      cy := cy + 1
    cx := cx + 1
  if bestSeg < 0 then return none
  let i := bestSeg.toNat
  let dx := g.seg[i*4+2]! - g.seg[i*4]!
  let dy := g.seg[i*4+3]! - g.seg[i*4+1]!
  let len := orOne (hyp dx dy)
  return some ⟨bx, by', Float.sqrt best, dx / len, dy / len⟩

/-- The point `clearM` OUTSIDE the nearest wall, whenever the state is inside a
    footprint OR within `clearM` of a wall from outside; else `none`. -/
structure Clearance where
  x : Float
  y : Float
  inside : Bool
  deriving Inhabited, Repr

/-- Even-odd ray cast against a flat metric ring. -/
private def ringContains (pts : Array Float) (px py : Float) : Bool := Id.run do
  let n := pts.size / 2
  if n == 0 then return false
  let mut ins := false
  let mut j := n - 1
  for i in [0:n] do
    let yi := pts[i*2+1]!
    let xi := pts[i*2]!
    let yj := pts[j*2+1]!
    let xj := pts[j*2]!
    if ((yi > py) != (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi then
      ins := !ins
    j := i
  return ins

def WalkGrid.clearanceTarget (g : WalkGrid) (px py clearM : Float) : Option Clearance := Id.run do
  let c := g.cell
  let cx0 := floorInt (px / c)
  let cy0 := floorInt (py / c)
  let mut inside := false
  let mut bestD2 := posInf
  let mut wx := 0.0
  let mut wy := 0.0
  let mut found := false
  let mut seen : Std.HashSet Nat := {}
  let mut cx := cx0 - 1
  while cx ≤ cx0 + 1 do
    let mut cy := cy0 - 1
    while cy ≤ cy0 + 1 do
      for r in g.ringCells.getD (gridKey cx cy) #[] do
        if !seen.contains r then
          seen := seen.insert r
          let ring := g.rings[r]!
          let pts := ring.pts
          let n := pts.size / 2
          if px ≥ ring.minx && px ≤ ring.maxx && py ≥ ring.miny && py ≤ ring.maxy then
            if ringContains pts px py then inside := true
          let mut j := n - 1
          for i in [0:n] do
            let p := projMetric px py pts[j*2]! pts[j*2+1]! pts[i*2]! pts[i*2+1]!
            if p.d2 < bestD2 then
              bestD2 := p.d2
              wx := p.x
              wy := p.y
              found := true
            j := i
      cy := cy + 1
    cx := cx + 1
  if !found then return none
  let dist := Float.sqrt bestD2
  if !inside && dist > clearM then return none   -- already clear
  if dist < 1e-6 then return none                -- exactly on the wall — no normal
  -- Outward unit: toward the wall when inside (escape), away when outside.
  let ux := if inside then (wx - px) / dist else (px - wx) / dist
  let uy := if inside then (wy - py) / dist else (py - wy) / dist
  return some ⟨wx + ux * clearM, wy + uy * clearM, inside⟩

/-- Index of the ring containing `(px,py)`, or `-1`. Exposed for the
    indoor-presence exemption: raw observations are classified once, so the
    exemption is stable evidence the solver cannot drag. -/
def WalkGrid.ringContaining (g : WalkGrid) (px py : Float) : Int := Id.run do
  let c := g.cell
  let cx0 := floorInt (px / c)
  let cy0 := floorInt (py / c)
  let mut seen : Std.HashSet Nat := {}
  let mut cx := cx0 - 1
  while cx ≤ cx0 + 1 do
    let mut cy := cy0 - 1
    while cy ≤ cy0 + 1 do
      for r in g.ringCells.getD (gridKey cx cy) #[] do
        if !seen.contains r then
          seen := seen.insert r
          let ring := g.rings[r]!
          if !(px < ring.minx || px > ring.maxx || py < ring.miny || py > ring.maxy) then
            if ringContains ring.pts px py then return Int.ofNat r
      cy := cy + 1
    cx := cx + 1
  return -1

/-- Reconstruct a walk leg as the robust, annealed MAP continuous trajectory.
    One vertex per fix, timestamps preserved; `none` when too short. -/
def reconstructWalk (fixes : Array WalkFix) (ways : Ways) (buildings : Array Ring)
    (profile : ReconstructProfile := {}) (evidence : WalkEvidence := {}) :
    Option (Array SmoothedPoint) := Id.run do
  if fixes.size < profile.minFixes then return none

  let lat0 := fixes[0]!.lat
  let lon0 := fixes[0]!.lon
  let cosLat := Float.cos (lat0 * pi / 180)
  let toE := fun (lon : Float) => (lon - lon0) * 111320.0 * cosLat
  let toN := fun (lat : Float) => (lat - lat0) * 111320.0
  let toLon := fun (e : Float) => lon0 + e / (111320.0 * cosLat)
  let toLat := fun (m : Float) => lat0 + m / 111320.0

  -- Densify: keep every fix as an OBSERVED state and insert FREE states (no GPS
  -- term) so the spacing is ≤ targetSpacingM. Free states are placed purely by
  -- smoothness + network + building, so the line can bend AROUND a block between
  -- two fixes.
  let mut seedE : Array Float := #[]
  let mut seedN : Array Float := #[]
  let mut obsE : Array Float := #[]
  let mut obsN : Array Float := #[]
  let mut obsW : Array Float := #[]
  let mut ts : Array Float := #[]
  for i in [0:fixes.size] do
    let fe := toE fixes[i]!.lon
    let fn := toN fixes[i]!.lat
    let acc := fixes[i]!.accuracyM.getD profile.accFallbackM
    let sigma := min profile.accClampMaxM (max profile.accClampMinM acc)
    seedE := seedE.push fe
    seedN := seedN.push fn
    obsE := obsE.push fe
    obsN := obsN.push fn
    obsW := obsW.push (1 / (sigma * sigma))
    ts := ts.push fixes[i]!.ts
    if i + 1 < fixes.size then
      let ne := toE fixes[i+1]!.lon
      let nn2 := toN fixes[i+1]!.lat
      let segLen := hyp (ne - fe) (nn2 - fn)
      let kF := max 0 (Float.floor (segLen / profile.targetSpacingM) - 1)
      let k := kF.toUInt64.toNat
      for j in [1:k+1] do
        let f := j.toFloat / (kF + 1)
        seedE := seedE.push (fe + (ne - fe) * f)
        seedN := seedN.push (fn + (nn2 - fn) * f)
        obsE := obsE.push 0
        obsN := obsN.push 0
        obsW := obsW.push 0   -- free state — no GPS emission
        ts := ts.push (jsRound (fixes[i]!.ts + (fixes[i+1]!.ts - fixes[i]!.ts) * f))
  let m := seedE.size

  let wSmooth := 1 / (profile.smoothSigmaM * profile.smoothSigmaM)
  let wNet := 1 / (profile.networkSigmaM * profile.networkSigmaM)
  let wBuild := 1 / (profile.buildingSigmaM * profile.buildingSigmaM)
  let wFreeTether := 1 / (profile.freeTetherSigmaM * profile.freeTetherSigmaM)

  -- The spatial index (metric frame): walkable segments + building rings.
  let mut segs : Array (Array Float) := #[]
  for w in ways do
    for i in [1:w.size] do
      segs := segs.push #[toE w[i-1]!.lon, toN w[i-1]!.lat, toE w[i]!.lon, toN w[i]!.lat]
  let mut ringPts : Array (Array Float) := #[]
  for ring in buildings do
    if ring.size ≥ 3 then
      let mut arr := Array.replicate (ring.size * 2) 0.0
      for k in [0:ring.size] do
        arr := arr.set! (k*2) (toE ring[k]!.lon)
        arr := arr.set! (k*2+1) (toN ring[k]!.lat)
      ringPts := ringPts.push arr
  let grid : Option WalkGrid :=
    if segs.size > 0 || ringPts.size > 0 then
      some (mkWalkGrid segs ringPts (max profile.networkRadiusM 15))
    else none

  -- Indoor-presence exemption: a run of ≥ indoorPresenceMinFixes consecutive
  -- OBSERVED fixes whose RAW positions sit inside the SAME footprint is evidence
  -- of genuine entry — for those states (and the free states between them) the
  -- building is occupied space, not an obstacle.
  let mut exempt := Array.replicate m false
  match grid with
  | none => pure ()
  | some g =>
    let mut obsIdx : Array Nat := #[]
    for i in [0:m] do
      if obsW[i]! > 0 then obsIdx := obsIdx.push i
    let mut runStart := 0
    let mut runRing : Int := -2
    let markRun := fun (ex : Array Bool) (from_ to : Nat) => Id.run do
      let mut ex := ex
      if to + 1 ≥ from_ + profile.indoorPresenceMinFixes then
        for s in [obsIdx[from_]!:obsIdx[to]! + 1] do
          ex := ex.set! s true
      return ex
    for k in [0:obsIdx.size] do
      let i := obsIdx[k]!
      let ring := g.ringContaining seedE[i]! seedN[i]!
      if ring != runRing || ring == -1 then
        if runRing ≥ 0 && k ≥ 1 then exempt := markRun exempt runStart (k-1)
        runStart := k
        runRing := ring
    if runRing ≥ 0 && obsIdx.size ≥ 1 then exempt := markRun exempt runStart (obsIdx.size - 1)

  let mut e := seedE
  let mut nn := seedN

  -- Step-magnitude displacement budget: the drawn length may not grossly exceed
  -- what the pedometer says was walked. Soft, never a gate.
  let stepTargetM : Option Float :=
    evidence.stepsWalked.map fun s => max 1 (s * profile.stepStrideM * profile.stepSlackRatio)

  -- GNC: geometric anneal of the GPS kernel scale from start → target. When the
  -- step budget or an anchor is still grossly violated after the schedule, keep
  -- re-linearising at the target scale: a coherent smear contracts a bounded
  -- distance per solve (its GPS is rejected, so only the map priors resist),
  -- while an honest leg sits at a static equilibrium and extra iterations move
  -- nothing.
  let ratio :=
    if profile.gncSteps > 1 then
      Float.pow (profile.gncTargetM / profile.gncStartM) (1 / (profile.gncSteps - 1).toFloat)
    else 1
  let mut c := profile.gncStartM
  let mut halted := false
  for step in [0:profile.gncSteps + profile.stepExtraIters] do
    if !halted then
      -- Is a piece of hard evidence still grossly unsatisfied? Length beyond the
      -- step budget (>5 %), or a terminal state further than 3σ from its anchor.
      let pathLen : Float := Id.run do
        let mut len := 0.0
        for i in [0:m] do
          if i + 1 < m then len := len + hyp (e[i+1]! - e[i]!) (nn[i+1]! - nn[i]!)
        return len
      let off := fun (a : Option WalkAnchor) (i : Nat) =>
        match a with
        | none => false
        | some an => hyp (e[i]! - toE an.lon) (nn[i]! - toN an.lat) > 3 * an.sigmaM
      let evidenceViolated :=
        (match stepTargetM with | some t => pathLen > t * 1.05 | none => false)
          || off evidence.start 0 || off evidence.finish (m-1)
      if step ≥ profile.gncSteps && !evidenceViolated then
        halted := true
      else
        for _inner in [0:profile.innerIters] do
          -- Per-axis diagonals: the network attraction is ANISOTROPIC
          -- (normal-only, point-to-line), so east and north see different weights
          -- there. All other factors contribute identically to both.
          let mut dE := Array.replicate m 0.0
          let mut dN := Array.replicate m 0.0
          let mut be := Array.replicate m 0.0
          let mut bn := Array.replicate m 0.0
          -- Step-magnitude contraction, re-linearised at the current estimate:
          -- when the current length L exceeds the budget, every edge gets a
          -- first-difference target of `s·(current edge)` with s = target/L — a
          -- uniform shrink whose force fades to zero as L reaches the target
          -- (self-limiting; it cannot over-collapse).
          let mut wEdge := 0.0
          match stepTargetM with
          | none => pure ()
          | some target =>
            let curLen : Float := Id.run do
              let mut len := 0.0
              for i in [0:m] do
                if i + 1 < m then len := len + hyp (e[i+1]! - e[i]!) (nn[i+1]! - nn[i]!)
              return len
            let excess := curLen / target
            if excess > 1 then
              let over := (excess - 1) / profile.stepRampWidthRatio
              let ramp := min profile.stepRampCap (over * over)
              wEdge := ramp / (profile.stepSigmaM * profile.stepSigmaM)
              let shrink := 1 / excess
              for k in [0:m] do
                if k + 1 < m then
                  let tE := shrink * (e[k+1]! - e[k]!)
                  let tN := shrink * (nn[k+1]! - nn[k]!)
                  be := be.set! k (be[k]! - wEdge * tE)
                  be := be.set! (k+1) (be[k+1]! + wEdge * tE)
                  bn := bn.set! k (bn[k]! - wEdge * tN)
                  bn := bn.set! (k+1) (bn[k+1]! + wEdge * tN)
          for i in [0:m] do
            let px := e[i]!
            let py := nn[i]!
            if obsW[i]! > 0 then
              -- Robust GPS emission: reject a fix that disagrees with the
              -- consensus trajectory.
              let rGps := hyp (px - obsE[i]!) (py - obsN[i]!)
              let wg := obsW[i]! * gmWeight rGps c
              dE := dE.set! i (dE[i]! + wg)
              dN := dN.set! i (dN[i]! + wg)
              be := be.set! i (be[i]! + wg * obsE[i]!)
              bn := bn.set! i (bn[i]! + wg * obsN[i]!)
            else
              -- Free state: weak, non-robust tether to its interpolated position
              -- on the raw corridor — keeps it from drifting off without pinning
              -- it, so it can still bow around a building.
              dE := dE.set! i (dE[i]! + wFreeTether)
              dN := dN.set! i (dN[i]! + wFreeTether)
              be := be.set! i (be[i]! + wFreeTether * seedE[i]!)
              bn := bn.set! i (bn[i]! + wFreeTether * seedN[i]!)
            match grid with
            | none => pure ()
            | some g =>
              -- Adaptive walkable attraction — hug hard when close to a way,
              -- redescend to weak when far. NORMAL-ONLY (point-to-line): an
              -- isotropic point spring also resists sliding ALONG the way, which
              -- drags every anchor/step correction to a crawl. Keeping the
              -- east/north systems separable means dropping the nx·ny cross term:
              -- exact for an axis-aligned way, mildly soft for a diagonal one.
              match g.nearest px py profile.networkRadiusM with
              | none => pure ()
              | some near =>
                let wN := wNet * gmWeight near.distM profile.networkRobustM
                let nx := -near.ty
                let ny := near.tx
                dE := dE.set! i (dE[i]! + wN * nx * nx)
                dN := dN.set! i (dN[i]! + wN * ny * ny)
                be := be.set! i (be[i]! + wN * nx * nx * near.x)
                bn := bn.set! i (bn[i]! + wN * ny * ny * near.y)
              -- Building clearance field. Presence-exempt states are genuinely
              -- indoors: no pull at all.
              if !exempt[i]! then
                match g.clearanceTarget px py profile.buildingClearM with
                | none => pure ()
                | some esc =>
                  dE := dE.set! i (dE[i]! + wBuild)
                  dN := dN.set! i (dN[i]! + wBuild)
                  be := be.set! i (be[i]! + wBuild * esc.x)
                  bn := bn.set! i (bn[i]! + wBuild * esc.y)
          -- Endpoint anchors — reconstruct between confident truths.
          match evidence.start with
          | none => pure ()
          | some a =>
            let w := 1 / (a.sigmaM * a.sigmaM)
            dE := dE.set! 0 (dE[0]! + w)
            dN := dN.set! 0 (dN[0]! + w)
            be := be.set! 0 (be[0]! + w * toE a.lon)
            bn := bn.set! 0 (bn[0]! + w * toN a.lat)
          match evidence.finish with
          | none => pure ()
          | some a =>
            let w := 1 / (a.sigmaM * a.sigmaM)
            dE := dE.set! (m-1) (dE[m-1]! + w)
            dN := dN.set! (m-1) (dN[m-1]! + w)
            be := be.set! (m-1) (be[m-1]! + w * toE a.lon)
            bn := bn.set! (m-1) (bn[m-1]! + w * toN a.lat)
          e := solvePCG dE wSmooth be e wEdge
          nn := solvePCG dN wSmooth bn nn wEdge
          -- Hard projection: occupancy of a footprint is impossible for the
          -- iterate — a non-exempt interior state inside a ring is MOVED to its
          -- clearance target, not merely pulled. Terminals are spared (a walk may
          -- start at an indoor doorway); states riding a mapped way through the
          -- building are the passage class.
          if profile.hardProjectBuildings then
            match grid with
            | none => pure ()
            | some g =>
              for i in [1:m-1] do
                if !exempt[i]! then
                  match g.clearanceTarget e[i]! nn[i]! profile.buildingClearM with
                  | none => pure ()
                  | some esc =>
                    if esc.inside && (g.nearest e[i]! nn[i]! profile.passageWayReachM).isNone then
                      e := e.set! i esc.x
                      nn := nn.set! i esc.y
        c := max profile.gncTargetM (c * ratio)

  let mut out : Array SmoothedPoint := #[]
  for i in [0:m] do
    out := out.push ⟨toLat nn[i]!, toLon e[i]!, ts[i]!⟩

  -- Corner insertion: the clearance field keeps VERTICES out of footprints, but
  -- an edge between two exterior vertices can still pass through one (the
  -- between-vertex gap). Route each such edge around the ring's own corners —
  -- only when a bounded, crossing-free corner path exists, and never across a
  -- presence-exempt endpoint (an edge entering an occupied café is honest).
  if profile.insertCornerDetours && !buildings.isEmpty then
    let CORNER_DETOUR_MAX_RATIO := 2.5
    let mut repaired : Array SmoothedPoint := #[out[0]!]
    for i in [0:m] do
      if i + 1 < m then
        let a := out[i]!
        let b := out[i+1]!
        if !exempt[i]! && !exempt[i+1]! then
          let chordM := hyp (toE b.lon - toE a.lon) (toN b.lat - toN a.lat)
          let path := if chordM > 1 then routeChordAroundBuildings a.pt b.pt buildings else none
          match path with
          | none => pure ()
          | some path =>
            if path.size > 2 then
              let mut lenM := 0.0
              for k in [1:path.size] do
                lenM := lenM + hyp (toE path[k]!.lon - toE path[k-1]!.lon)
                                   (toN path[k]!.lat - toN path[k-1]!.lat)
              if lenM ≤ chordM * CORNER_DETOUR_MAX_RATIO then
                -- Interior corners, timestamps interpolated by along-path distance.
                let mut acc := 0.0
                for k in [1:path.size] do
                  if k + 1 < path.size then
                    acc := acc + hyp (toE path[k]!.lon - toE path[k-1]!.lon)
                                     (toN path[k]!.lat - toN path[k-1]!.lat)
                    repaired := repaired.push
                      ⟨path[k]!.lat, path[k]!.lon, jsRound (a.ts + (b.ts - a.ts) * (acc / lenM))⟩
        repaired := repaired.push b
    return some repaired
  return some out

/-! ## Parity with Node/V8 (`lean/experiments/walk-smooth-refs.mts`)

Reference geometry: a straight east-west street with a north-south cross street,
footprints placed against them, and a GPS-wobbly walk along the street. Profiles
are passed explicitly (never read from the environment), and the V8 output is
reproduced verbatim.

The tolerance is `1e-9` degrees (~0.1 mm) rather than `==`: `Math.hypot` is not
guaranteed to equal `sqrt (x²+y²)`, and the PCG only converges to a relative
residual of `1e-14`. On these references the residual measured EXACTLY zero —
every value below is bit-identical — but the tolerance is the honest contract.
-/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def tptsApprox (a : Array SmoothedPoint) (b : List SmoothedPoint) : Bool :=
  a.size == b.length
    && (a.toList.zip b).all fun (x, y) =>
      approx x.lat y.lat && approx x.lon y.lon && approx x.ts y.ts

private def optApprox (a : Option (Array SmoothedPoint)) (b : List SmoothedPoint) : Bool :=
  match a with
  | none => false
  | some r => tptsApprox r b

private def LAT0 : Float := 51.52
private def LON0 : Float := -0.13
private def MLAT : Float := 1.0 / 111320.0
private def MLON : Float := 1.0 / (111320.0 * Float.cos (LAT0 * pi / 180))
/-- `(north metres, east metres)` from the origin. -/
private def P (n e : Float) : Pt := ⟨LAT0 + n * MLAT, LON0 + e * MLON⟩
private def F (n e ts : Float) (acc : Option Float) : WalkFix :=
  ⟨LAT0 + n * MLAT, LON0 + e * MLON, ts, acc⟩

/-- A straight east-west street along n=0, and a north-south one at e=100. -/
private def STREETS : Ways := #[#[P 0 0, P 0 200], #[P 0 100, P 200 100]]
/-- A house north of the east-west street: north 5..25, east 30..70. -/
private def HOUSE : Ring := #[P 5 30, P 5 70, P 25 70, P 25 30]
/-- The same house, narrow enough that going around it is cheap. -/
private def NARROW : Ring := #[P 5 45, P 5 55, P 25 55, P 25 45]

/-- A walk east along the street with GPS wobble, at 10 m intervals. -/
private def WOBBLE : Array WalkFix :=
  #[F 3 0 1000 (some 8), F (-4) 10 1010 (some 12), F 2 20 1020 (some 20),
    F (-3) 30 1030 none,   -- no reported accuracy → the profile fallback
    F 5 40 1040 (some 6), F (-1) 50 1050 (some 30), F 2 60 1060 (some 10),
    F 0 70 1070 (some 9)]

/-! ### `countSharpTurns` -/

#guard countSharpTurns #[P 0 0, P 0 10] == 0
#guard countSharpTurns #[P 0 0, P 0 10, P 0 20] == 0
#guard countSharpTurns #[P 0 0, P 0 10, P 10 10] == 1
#guard countSharpTurns #[P 0 0, P 0 10, P 10 10, P 10 20, P 20 20] == 3
-- A 30° turn is below the 50° default but above an explicit 25° threshold.
#guard countSharpTurns #[P 0 0, P 0 10, P 5.7735 20] == 0
#guard countSharpTurns #[P 0 0, P 0 10, P 5.7735 20] 25 == 1
-- A duplicated vertex has no direction, so it is skipped rather than counted.
#guard countSharpTurns #[P 0 0, P 0 0, P 10 10] == 0
#guard countSharpTurns #[P 0 0, P 0 10, P 0 0] == 1

/-! ### `tortuosity` -/

#guard tortuosity #[P 0 0] == 1
#guard tortuosity #[P 0 0, P 0 50, P 0 100] == 1
#guard approx (tortuosity #[P 0 0, P 0 50, P 50 50, P 50 100]) 1.3416416686105039
-- Under a metre end-to-end the ratio is meaningless, so it is pinned at 1.
#guard tortuosity #[P 0 0, P 0 0.4] == 1

/-! ### `smoothWalkMap` -/

#guard (smoothWalkMap (WOBBLE.extract 0 3) STREETS).isNone
#guard optApprox (smoothWalkMap WOBBLE STREETS)
    [⟨51.520009182807307, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520003428772867, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520005372708567, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520012015086373, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520020146617448, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520017319933892, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520010819954763, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520002549493817, -0.12898943110281780, 1070.0000000000000⟩]
#guard optApprox (smoothWalkMap WOBBLE #[])
    [⟨51.520013412188788, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520009643106434, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520013488668965, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520021169632912, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520029309734717, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520026833675907, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520018271982053, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520006722507219, -0.12898943110281780, 1070.0000000000000⟩]
-- 100 m north of every way: the 25 m network gate never fires, so this is the
-- GPS + smoothness fit alone.
#guard optApprox (smoothWalkMap (WOBBLE.map fun x => { x with lat := x.lat + 100 * MLAT }) STREETS)
    [⟨51.520911723363781, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520907954281427, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520911799843958, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520919480807905, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520927620909710, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520925144850899, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520916583157046, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520905033682212, -0.12898943110281780, 1070.0000000000000⟩]

/-! ### `refineMatchedPath` -/

private def STAIR : Array Pt :=
  #[P 0 0, P 0 15, P 8 15, P 8 30, P 0 30, P 0 45, P 8 45, P 8 70]
private def ELBOW : Array Pt := #[P 0 0, P 0 40, P 60 40]
private def ELBOW_FIXES : Array WalkFix :=
  #[F 1 0 1000 (some 10), F (-1) 20 1020 (some 10), F 2 38 1040 (some 10),
    F 20 42 1060 (some 10), F 45 39 1080 (some 10), F 60 41 1100 (some 10)]

#guard (refineMatchedPath WOBBLE #[P 0 0]).isNone
#guard (refineMatchedPath (WOBBLE.extract 0 3) #[P 0 0, P 0 70]).isNone
-- A straight corridor has no corners at all, so the tight budget holds
-- everywhere and the refinement barely moves the line.
#guard optApprox (refineMatchedPath WOBBLE #[P 0 0, P 0 70])
    [⟨51.520009171435284, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520005043826757, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520006690884486, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520012129993042, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520019229816562, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520017527220581, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520011943608871, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520004428372218, -0.12898943110281780, 1070.0000000000000⟩]
-- A STAIRCASE artifact: many clustered sharp corners earn the full budget.
#guard optApprox (refineMatchedPath WOBBLE STAIR)
    [⟨51.520008334297295, -0.13000352867712228, 1000.0000000000000⟩,
     ⟨51.520005601172656, -0.12986322253058125, 1010.0000000000000⟩,
     ⟨51.520009076499093, -0.12972108790817166, 1020.0000000000000⟩,
     ⟨51.520017043594542, -0.12957397864555084, 1030.0000000000000⟩,
     ⟨51.520028341396518, -0.12942608899843352, 1040.0000000000000⟩,
     ⟨51.520034171191782, -0.12927948111466064, 1050.0000000000000⟩,
     ⟨51.520033629127916, -0.12913374738768210, 1060.0000000000000⟩,
     ⟨51.520035988087486, -0.12898859687265649, 1070.0000000000000⟩]
-- An ISOLATED corner is real street geometry: the tight budget holds, and the
-- route vertex the fixes skipped past is spliced back (7 points from 6 fixes).
#guard optApprox (refineMatchedPath ELBOW_FIXES ELBOW)
    [⟨51.519977542220630, -0.12988806318988472, 1000.0000000000000⟩,
     ⟨51.520000000000003, -0.12970472113350348, 1020.0000000000000⟩,
     ⟨51.520000000000003, -0.12942253205875304, 1033.0000000000000⟩,
     ⟨51.520100450441014, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520218319829098, -0.12945169381012894, 1060.0000000000000⟩,
     ⟨51.520361063307909, -0.12940063429988541, 1080.0000000000000⟩,
     ⟨51.520510845740858, -0.12938643990758134, 1100.0000000000000⟩]
-- Same, with the full budget cut to 4 m. The isolated corner is governed by the
-- STRAIGHT budget either way, so the outcome is unchanged.
#guard optApprox (refineMatchedPath ELBOW_FIXES ELBOW REFINE_MATCHED_PROFILE 4)
    [⟨51.519977542220630, -0.12988806318988472, 1000.0000000000000⟩,
     ⟨51.520000000000003, -0.12970472113350348, 1020.0000000000000⟩,
     ⟨51.520000000000003, -0.12942253205875304, 1033.0000000000000⟩,
     ⟨51.520100450441014, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520218319829098, -0.12945169381012894, 1060.0000000000000⟩,
     ⟨51.520361063307909, -0.12940063429988541, 1080.0000000000000⟩,
     ⟨51.520510845740858, -0.12938643990758134, 1100.0000000000000⟩]
-- Fixes 20 m off a straight matched line: every vertex is clamped radially back
-- to the 2.5 m straight budget.
#guard optApprox
    (refineMatchedPath (WOBBLE.map fun x => { x with lat := x.lat + 20 * MLAT, accuracyM := some 5 })
      #[P 0 0, P 0 70])
    [⟨51.520022457779376, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520022457779376, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520022457779376, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520022457779376, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520022457779376, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520022457779376, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520022457779376, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520022457779376, -0.12898943110281780, 1070.0000000000000⟩]

/-! ### `reconstructWalk` -/

private def CROSS : Array WalkFix :=
  #[F (-15) 50 1000 (some 8), F (-5) 50 1010 (some 8), F 8 50 1020 (some 8),
    F 18 50 1030 (some 8), F 28 50 1040 (some 8), F 38 50 1050 (some 8)]
private def SPARSE : Array WalkFix :=
  #[F (-60) 50 1000 (some 8), F (-30) 50 1030 (some 8), F 0 50 1060 (some 8),
    F 30 50 1090 (some 8), F 60 50 1120 (some 8)]
private def INDOOR : Array WalkFix :=
  #[F 0 20 1000 (some 8), F 10 35 1010 (some 8), F 15 45 1020 (some 8),
    F 12 55 1030 (some 8), F 15 65 1040 (some 8), F 0 80 1050 (some 8)]
/-- A gross mid-leg outlier: 120 m north of a walk that never leaves the street. -/
private def OUTLIER : Array WalkFix := WOBBLE.set! 4 (F 120 40 1040 (some 6))

#guard (reconstructWalk (WOBBLE.extract 0 3) STREETS #[]).isNone
#guard optApprox (reconstructWalk WOBBLE STREETS #[])
    [⟨51.520002937237543, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.519999139546407, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.519999462115706, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520001127995734, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520003765344676, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520002970464589, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520002304964834, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520000585542604, -0.12898943110281780, 1070.0000000000000⟩]
#guard optApprox (reconstructWalk WOBBLE #[] #[])
    [⟨51.520009807974148, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520006645289754, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.520009542288605, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520015014568784, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520020332535083, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520019370068397, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520014528194871, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520007128226503, -0.12898943110281780, 1070.0000000000000⟩]
-- The redescending kernel REJECTS the outlier rather than detouring to it: the
-- line stays on the street and the smoothness prior carries it through.
#guard optApprox (reconstructWalk OUTLIER STREETS #[])
    [⟨51.520003174543795, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.519999144643236, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.519998818175708, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.519998993017076, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.519999853293548, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520000792518623, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520001698813971, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520000930474644, -0.12898943110281780, 1070.0000000000000⟩]
-- Endpoint anchors: the leg is reconstructed BETWEEN confident truths, so both
-- terminals move to meet them.
#guard optApprox
    (reconstructWalk WOBBLE STREETS #[] {}
      { start := some ⟨(P 0 (-5)).lat, (P 0 (-5)).lon, 2⟩,
        finish := some ⟨(P 0 75).lat, (P 0 75).lon, 2⟩ })
    [⟨51.520000504323278, -0.13006897208224719, 1000.0000000000000⟩,
     ⟨51.519998443692231, -0.12989775871619347, 1010.0000000000000⟩,
     ⟨51.519999484391562, -0.12973410985032241, 1020.0000000000000⟩,
     ⟨51.520001288682927, -0.12957617961153686, 1030.0000000000000⟩,
     ⟨51.520003870000380, -0.12942013343182318, 1040.0000000000000⟩,
     ⟨51.520002971126331, -0.12926134263011904, 1050.0000000000000⟩,
     ⟨51.520002121571423, -0.12909595836527940, 1060.0000000000000⟩,
     ⟨51.520000108142909, -0.12892079395569978, 1070.0000000000000⟩]
-- 40 steps ≈ 42 m of budget against a ~70 m draw: the contraction fires and the
-- extra iterations run until the length is within 5 % of the budget.
#guard optApprox (reconstructWalk WOBBLE STREETS #[] {} { stepsWalked := some 40 })
    [⟨51.520002652194442, -0.12995768123282034, 1000.0000000000000⟩,
     ⟨51.519999236711946, -0.12982935422161576, 1010.0000000000000⟩,
     ⟨51.519999608851407, -0.12969676609928882, 1020.0000000000000⟩,
     ⟨51.520001170215345, -0.12956104401475338, 1030.0000000000000⟩,
     ⟨51.520003665873567, -0.12942413872324895, 1040.0000000000000⟩,
     ⟨51.520002880553648, -0.12928833341409623, 1050.0000000000000⟩,
     ⟨51.520002262215094, -0.12915554669908710, 1060.0000000000000⟩,
     ⟨51.520000671343062, -0.12902772667839166, 1070.0000000000000⟩]
-- Ample steps → the factor stays fully off, identical to no evidence at all.
#guard optApprox (reconstructWalk WOBBLE STREETS #[] {} { stepsWalked := some 400 })
    [⟨51.520002937237543, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.519999139546407, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.519999462115706, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.520001127995734, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520003765344676, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520002970464589, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520002304964834, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520000585542604, -0.12898943110281780, 1070.0000000000000⟩]
-- Free-state densification (a knob; refuted for production).
#guard optApprox (reconstructWalk WOBBLE STREETS #[HOUSE] { targetSpacingM := 5 })
    [⟨51.520004281775115, -0.13000000000000000, 1000.0000000000000⟩,
     ⟨51.520000109986682, -0.12992781650734414, 1005.0000000000000⟩,
     ⟨51.519997698466597, -0.12985563301468825, 1010.0000000000000⟩,
     ⟨51.519998545569770, -0.12978344952203238, 1015.0000000000000⟩,
     ⟨51.519999612730317, -0.12971126602937652, 1020.0000000000000⟩,
     ⟨51.519999785610466, -0.12963908253672066, 1025.0000000000000⟩,
     ⟨51.520000125396557, -0.12956689904406476, 1030.0000000000000⟩,
     ⟨51.520001905751101, -0.12949471555140890, 1035.0000000000000⟩,
     ⟨51.520003890062213, -0.12942253205875304, 1040.0000000000000⟩,
     ⟨51.520002258397867, -0.12935034856609715, 1045.0000000000000⟩,
     ⟨51.520000945408050, -0.12927816507344128, 1050.0000000000000⟩,
     ⟨51.520000989929308, -0.12920598158078542, 1055.0000000000000⟩,
     ⟨51.520001674893543, -0.12913379808812953, 1060.0000000000000⟩,
     ⟨51.520000936766827, -0.12906161459547366, 1065.0000000000000⟩,
     ⟨51.520000070943198, -0.12898943110281780, 1070.0000000000000⟩]

-- A walk crossing a footprint. Two fixes land inside it, BELOW the
-- indoor-presence bar, so the clearance field repels the line out of the house.
#guard optApprox (reconstructWalk CROSS STREETS #[HOUSE])
    [⟨51.519857489267856, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519925692041127, -0.12927816507344128, 1010.0000000000000⟩,
     ⟨51.520024722076045, -0.12927816507344128, 1020.0000000000000⟩,
     ⟨51.520245729043296, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520410939025439, -0.12927816507344128, 1040.0000000000000⟩,
     ⟨51.520558546893746, -0.12927816507344128, 1050.0000000000000⟩]
-- The SAME crossing with the bar lowered to 2: those two fixes now read as
-- genuine entry, the building is occupied space, and nothing repels.
#guard optApprox (reconstructWalk CROSS STREETS #[HOUSE] { indoorPresenceMinFixes := 2 })
    [⟨51.519962281995163, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519992015872440, -0.12927816507344128, 1010.0000000000000⟩,
     ⟨51.520043387357923, -0.12927816507344128, 1020.0000000000000⟩,
     ⟨51.520137146832091, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520257540217500, -0.12927816507344128, 1040.0000000000000⟩,
     ⟨51.520368570300860, -0.12927816507344128, 1050.0000000000000⟩]
-- Corner insertion and hard projection both change nothing here: no output edge
-- passes through with both ends outside, and no vertex is left inside.
#guard optApprox (reconstructWalk CROSS STREETS #[HOUSE] { insertCornerDetours := false })
    [⟨51.519857489267856, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519925692041127, -0.12927816507344128, 1010.0000000000000⟩,
     ⟨51.520024722076045, -0.12927816507344128, 1020.0000000000000⟩,
     ⟨51.520245729043296, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520410939025439, -0.12927816507344128, 1040.0000000000000⟩,
     ⟨51.520558546893746, -0.12927816507344128, 1050.0000000000000⟩]
#guard optApprox (reconstructWalk CROSS STREETS #[HOUSE] { hardProjectBuildings := true })
    [⟨51.519857489267856, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519925692041127, -0.12927816507344128, 1010.0000000000000⟩,
     ⟨51.520024722076045, -0.12927816507344128, 1020.0000000000000⟩,
     ⟨51.520245729043296, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520410939025439, -0.12927816507344128, 1040.0000000000000⟩,
     ⟨51.520558546893746, -0.12927816507344128, 1050.0000000000000⟩]

-- Corner insertion only ever fires on an edge that passes THROUGH a ring with
-- BOTH ends outside — the between-vertex gap the per-state field is structurally
-- blind to. Sparse fixes (30 m apart) with the soft field all but switched off
-- put a whole edge across the narrow footprint, which is exactly that case:
-- 5 solved vertices become 7 as the two interior corners are spliced in.
#guard optApprox (reconstructWalk SPARSE STREETS #[NARROW] { buildingSigmaM := 1000 })
    [⟨51.519461013295007, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519730506647505, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520000000000003, -0.12927816507344128, 1060.0000000000000⟩,
     ⟨51.520028846070424, -0.12919306899742999, 1065.0000000000000⟩,
     ⟨51.520240647282073, -0.12919306899742999, 1085.0000000000000⟩,
     ⟨51.520269493352501, -0.12927816507344128, 1090.0000000000000⟩,
     ⟨51.520538986704999, -0.12927816507344128, 1120.0000000000000⟩]
#guard optApprox
    (reconstructWalk SPARSE STREETS #[NARROW]
      { buildingSigmaM := 1000, insertCornerDetours := false })
    [⟨51.519461013295007, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.519730506647505, -0.12927816507344128, 1030.0000000000000⟩,
     ⟨51.520000000000003, -0.12927816507344128, 1060.0000000000000⟩,
     ⟨51.520269493352501, -0.12927816507344128, 1090.0000000000000⟩,
     ⟨51.520538986704999, -0.12927816507344128, 1120.0000000000000⟩]

-- Indoor presence: four consecutive raw fixes inside the SAME footprint is
-- genuine entry, so those states feel no clearance pull at all.
#guard optApprox (reconstructWalk INDOOR STREETS #[HOUSE])
    [⟨51.520002361474120, -0.12969759990198562, 1000.0000000000000⟩,
     ⟨51.520010848743446, -0.12952584140521173, 1010.0000000000000⟩,
     ⟨51.520015092841973, -0.12935897862280318, 1020.0000000000000⟩,
     ⟨51.520015174062891, -0.12919417459696203, 1030.0000000000000⟩,
     ⟨51.520011030139457, -0.12902709765976536, 1040.0000000000000⟩,
     ⟨51.520002461817903, -0.12885607148278291, 1050.0000000000000⟩]
-- Raise the bar above the run length and the exemption lapses — the same fixes
-- are now pushed out of the footprint.
#guard optApprox (reconstructWalk INDOOR STREETS #[HOUSE] { indoorPresenceMinFixes := 5 })
    [⟨51.520002420952089, -0.12972012991052850, 1000.0000000000000⟩,
     ⟨51.520008179028146, -0.12954544232333140, 1010.0000000000000⟩,
     ⟨51.520009587276633, -0.12936758087630637, 1020.0000000000000⟩,
     ⟨51.520009587714711, -0.12917160380156670, 1030.0000000000000⟩,
     ⟨51.520008115744922, -0.12899655820684117, 1040.0000000000000⟩,
     ⟨51.520002411540290, -0.12882726768854760, 1050.0000000000000⟩]

end Verified.Geo.WalkSmooth
