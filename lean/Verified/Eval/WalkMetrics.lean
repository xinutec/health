import Verified.Geo.CorridorStall
import Verified.FloatConst

/-!
# Walk-geometry referee metrics

What `Verified.Eval.WalkGate` measures "worse" with: walk score, plausibility,
building crossings and route correctness. Kept apart from the ratchet, which is
a handful of comparisons.

No single number is truth, so each walk gets a vector; each metric is
confounded alone:

* off-walkable p90 favours a phantom hugging mapped ways, so it is recorded,
  not acted on;
* corridor stall sees an invented detour but not a coherent smear;
* the step budget sees the smear but not where the line went;
* route correctness scores by name, only where the narrative confirmed a street.

## ⚠ `none` is unmeasured and never zero

An `Option` here means the question could not be asked (no footprints, no
named-street truth, no step data). A lost measurement read as `0` would turn an
unanswerable question into the best possible answer.

## Exactness

`tests/golden/walk-baseline.json` was blessed by this arithmetic (planar
lat/lon→metre, 111320 m/deg, `cos` at the midpoint), so different arithmetic
reddens a healthy tree. A `hypot`-style ULP difference and ASCII-only
`String.toLower` are below the gate's 5–30 m and 0.1 epsilons.
-/

namespace Verified.Eval.WalkMetrics

/-! ## Shapes -/

/-- A geographic point. -/
structure LatLon where
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- One per-minute pedometer row: `steps` counted in `[ts, ts+60)`. -/
structure PedStep where
  ts : Float
  steps : Float
  deriving Inhabited, BEq, Repr

/-- A walkable way. `coords` are `(lat, lon)` in order; `name` is `none` for an
unnamed footway, which cannot corroborate a named-street claim either way. -/
structure Way where
  name : Option String
  coords : Array (Float × Float)
  deriving Inhabited

/-- The pedestrian network the line is measured against. -/
structure RoadGeometry where
  ways : Array Way
  deriving Inhabited

/-- A building footprint: a closed ring whose last→first edge is implicit. -/
abbrev Ring := Array LatLon

/-! ## Planar primitives

Not haversine: over a walk's hundreds of metres the equirectangular
approximation is far below the metric's resolution, and changing it would move
every baseline value. -/

open Verified.FloatConst (pi hyp posInf)

/-- Metres between two points, planar, with `cos` taken at the midpoint
latitude. -/
def metersBetween (a b : LatLon) : Float :=
  let dLat := (b.lat - a.lat) * 111320.0
  let dLon := (b.lon - a.lon) * 111320.0 * Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  hyp dLat dLon

/-- `Math.max(1, Math.ceil(x))` as a loop count. -/
private def ceilSteps (x : Float) : Nat :=
  let c := Float.ceil x
  if c ≤ 1 || c.isNaN then 1 else c.toInt64.toInt.toNat

/-- Clamp to `[0, 1]` — `Math.max(0, Math.min(1, t))`. -/
private def clamp01 (t : Float) : Float := max 0 (min 1 t)

/-- Total drawn length (m). -/
def pathLength (pts : Array LatLon) : Float := Id.run do
  let mut t := 0.0
  for hm_i : i in [1:pts.size] do
    have hb_i : i < pts.size := hm_i.upper
    t := t + metersBetween pts[i - 1] pts[i]
  return t

/-- Point on the segment `a→b` at fraction `f`. -/
private def lerp (a b : LatLon) (f : Float) : LatLon :=
  { lat := a.lat + (b.lat - a.lat) * f, lon := a.lon + (b.lon - a.lon) * f }

/-- Planar distance (m) from `p` to the segment `a→b`, `cos` at the segment
midpoint. `t` falls back to 0 on a degenerate segment. -/
private def distToSeg (p a b : LatLon) : Float :=
  let cosLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  let bx := (b.lon - a.lon) * 111320.0 * cosLat
  let byM := (b.lat - a.lat) * 111320.0
  let px := (p.lon - a.lon) * 111320.0 * cosLat
  let py := (p.lat - a.lat) * 111320.0
  let len2 := bx * bx + byM * byM
  let t := if len2 == 0 then 0 else clamp01 ((px * bx + py * byM) / len2)
  hyp (px - t * bx) (py - t * byM)

/-- Distance (m) to the nearest point of any way polyline; `+∞` when the
network is empty. -/
def distToNearestWay (p : LatLon) (roads : RoadGeometry) : Float := Id.run do
  let mut best := posInf
  for w in roads.ways do
    for hm_i : i in [1:w.coords.size] do
      have hb_i : i < w.coords.size := hm_i.upper
      let a : LatLon := ⟨w.coords[i - 1].1, w.coords[i - 1].2⟩
      let b : LatLon := ⟨w.coords[i].1, w.coords[i].2⟩
      let d := distToSeg p a b
      if d < best then best := d
  return best

/-! ## Pedometer -/

/-- Steps overlapping `[from, to)` × stride (m), distributed by time overlap so
a leg boundary does not import a neighbouring minute's steps. -/
def pedometerDistanceM (steps : Array PedStep) (from_ to : Float)
    (strideM : Float := 0.72) : Float := Id.run do
  if to ≤ from_ then return 0
  let mut n := 0.0
  for s in steps do
    let lo := max from_ s.ts
    let hi := min to (s.ts + 60)
    if hi > lo then n := n + s.steps * ((hi - lo) / 60)
  return n * strideM

/-! ## Step budget

Two windowing rules and two strides: `pedometerDistanceM` distributes rows by
overlap at 0.72 m; `stepsInWindow` sums whole rows in an inclusive window and
the budget uses 0.75. Merging them would move every blessed `budgetM`. -/

/-- The reconstruction profile's stride. 0.75 — not `scoreWalk`'s 0.72. -/
def STEP_STRIDE_M : Float := 0.75

/-- Steps whose row timestamp lies in `[startTs, endTs]`, whole rows. `none`
(no rows within a day) is not `some 0`: an empty window near step data is the
pedometer saying the leg walked nothing, the strongest phantom evidence the
referee has. -/
def stepsInWindow (rows : Array PedStep) (startTs endTs : Float) : Option Float := Id.run do
  if rows.isEmpty then return none
  let mut total := 0.0
  let mut anyOverlap := false
  for r in rows do
    if r.ts ≥ startTs && r.ts ≤ endTs then
      total := total + r.steps
      anyOverlap := true
  if anyOverlap || rows.any (fun r => Float.abs (r.ts - startTs) < 86400) then
    return some total
  return none

/-- The leg's pedometer displacement budget (m), with no slack. The gate
applies the reconstruction's slack itself, in `WalkGate.excess`, so that the
recorded floor and the tolerance stay separable. -/
def stepBudgetM (rows : Array PedStep) (startTs endTs : Float) : Option Float :=
  (stepsInWindow rows startTs endTs).map (· * STEP_STRIDE_M)

/-! ## The drawn-path score -/

/-- The witnesses that need only the drawn line, the window and the network. -/
structure WalkScore where
  /-- Drawn length ÷ straight-line distance (≥1). Lower is tighter. -/
  tortuosity : Float
  /-- Drawn length (m). -/
  drawnLengthM : Float
  /-- Pedometer distance (m) over the leg; `none` if no steps. -/
  pedometerM : Option Float
  /-- `|drawn − pedometer| / pedometer`; `none` if no steps. -/
  stepDistanceError : Option Float
  /-- Mean distance (m) from a drawn vertex to the nearest nearby walkable way;
  `none` if no path is ever near. -/
  offWalkableMeanM : Option Float
  /-- p90 distance (m) of the drawn line to the nearest walkable way, sampled
  along the chords and without the openness exclusion — so a chord cutting deep
  across a block counts instead of being filtered out as open ground. -/
  offWalkableP90M : Option Float
  deriving Inhabited, Repr

/-- The `q`-quantile of the drawn line's distance to the network, sampled at
the vertices and every `stepM`, with no openness exclusion. A quantile, so one
GPS spike does not become the metric. -/
def offWalkableQuantile (drawn : Array LatLon) (walkable : RoadGeometry)
    (q : Float) (stepM : Float := 5) : Option Float := Id.run do
  if drawn.isEmpty then return none
  let mut samples : Array Float := #[]
  for hm_i : i in [0:drawn.size] do
    samples := samples.push (distToNearestWay drawn[i] walkable)
    if hi1 : i + 1 < drawn.size then
      let a := drawn[i]
      let b := drawn[i+1]
      let chord := metersBetween a b
      let n := (Float.floor (chord / stepM)).toInt64.toInt.toNat
      for k in [1:n] do
        samples := samples.push
          (distToNearestWay (lerp a b (k.toFloat / n.toFloat)) walkable)
  if samples.isEmpty then return none
  let sorted := (samples.toList.mergeSort (· ≤ ·)).toArray
  let idx := (Float.floor (sorted.size.toFloat * q)).toInt64.toInt.toNat
  -- `samples` is not empty, so neither is `sorted`.
  return sorted[min (sorted.size - 1) idx]?

/-- Score a drawn walk. `opennessRadiusM` excludes vertices with no nearby path
(open ground) from the off-walkable mean — but deliberately not from the p90,
which is where a deep building cut shows. -/
def scoreWalk (drawn : Array LatLon) (startTs endTs : Float)
    (steps : Array PedStep := #[]) (walkable : Option RoadGeometry := none)
    (strideM : Float := 0.72) (opennessRadiusM : Float := 35)
    (wantP90 : Bool := true) : WalkScore := Id.run do
  let drawnLengthM := pathLength drawn
  let straight := if h2 : drawn.size ≥ 2
    then metersBetween (drawn[0]'(by omega)) (drawn[drawn.size-1]'(by omega)) else 0
  let tortuosity := if straight > 1 then drawnLengthM / straight else 1
  let ped := if steps.isEmpty then none
             else some (pedometerDistanceM steps startTs endTs strideM)
  -- A pedometer distance of 1 m or less yields no step error, not a division:
  -- a leg with no counted steps has no step error, not an infinite one.
  let stepDistanceError := match ped with
    | some p => if p > 1 then some ((drawnLengthM - p).abs / p) else none
    | none => none
  let mut offWalkableMeanM : Option Float := none
  let mut offWalkableP90M : Option Float := none
  match walkable with
  | some w =>
    if !w.ways.isEmpty then
      let near := (drawn.map (fun p => distToNearestWay p w)).filter (· ≤ opennessRadiusM)
      offWalkableMeanM := if near.isEmpty then none
                          else some ((near.foldl (· + ·) 0) / near.size.toFloat)
      -- `wantP90` exists for cost: the p90 samples every 5 m against every
      -- walkable way and is most of the referee's runtime, while the ratchet
      -- does not act on it. Defaults to true; the gating harness turns it off.
      offWalkableP90M := if wantP90 then offWalkableQuantile drawn w 0.9 else none
  | none => pure ()
  return { tortuosity, drawnLengthM, pedometerM := ped, stepDistanceError,
           offWalkableMeanM, offWalkableP90M }

/-! The referee keeps its own copy of the stall DP. `Verified.Geo.CorridorStall`
holds the same one for the decision gate, and `Verified.Geo` cannot import
`Verified.Eval`; delegating across the boundary SIGSEGVs the corpus gate even
with the fold's DP disabled. Both copies carry the same six fixtures, so a
divergence fails the build. Collapse them if that crash is ever explained.
-/

/-- The longest run of `path` that travels far while its monotone projection
onto the time-ordered `fixes` barely advances (m).

The projection is the min-cost monotone assignment (a DP). A greedy nearest
projection was refuted: on a street walked twice an early vertex lands on the
return pass and the rest reads as one giant stall (2169 m for a 118 m line). An
invented detour still cannot advance, having no fixes ahead of it. -/
def maxCorridorStall (fixes path : Array LatLon) (tolM : Float := 15) : Float := Id.run do
  if path.size < 2 || fixes.size < 2 then return 0
  -- The grids are flat (`k * S + i`) and every index is in range by
  -- construction, which no tactic can bound, so reads give their default (`0`,
  -- or `-1` for `parent`), as in `Geo.CorridorStall`.
  let fArc : Array Float := (fixes.zip (fixes.extract 1 fixes.size)).foldl
    (init := #[0.0]) fun acc (a, b) => acc.push (acc.back?.getD 0 + metersBetween a b)
  let pArc : Array Float := (path.zip (path.extract 1 path.size)).foldl
    (init := #[0.0]) fun acc (a, b) => acc.push (acc.back?.getD 0 + metersBetween a b)
  let V := path.size
  let S := fixes.size - 1
  -- `dist` is each vertex's distance to each fix-segment; `arc` is where on the
  -- corridor that projection lands.
  let mut dist : Array Float := Array.replicate (V * S) 0
  let mut arc : Array Float := Array.replicate (V * S) 0
  for hk : k in [0:V] do
    let v := path[k]'hk.upper
    for hi : i in [0:S] do
      have hs : i < fixes.size - 1 := hi.upper
      let a := fixes[i]'(by omega)
      let b := fixes[i+1]'(by omega)
      let cosLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
      let bx := (b.lon - a.lon) * 111320.0 * cosLat
      let byM := (b.lat - a.lat) * 111320.0
      let px := (v.lon - a.lon) * 111320.0 * cosLat
      let py := (v.lat - a.lat) * 111320.0
      -- A zero-length segment (two identical fixes) divides by 1e-9 here, not
      -- the `0` used elsewhere in this file; the baseline was blessed with both.
      let l2raw := bx * bx + byM * byM
      let l2 := if l2raw == 0 || l2raw.isNaN then 1e-9 else l2raw
      let t := clamp01 ((px * bx + py * byM) / l2)
      dist := dist.set! (k * S + i) (hyp (px - t * bx) (py - t * byM))
      let f0 := fArc[i]?.getD 0
      arc := arc.set! (k * S + i) (f0 + t * (fArc[i+1]?.getD 0 - f0))
  -- DP over (vertex, fix-segment): cost = own projection distance + cheapest
  -- predecessor whose arc position is ≤ ours + 1 m (a backtrack tolerance).
  -- Prefix-min over predecessors sorted by arc makes each step O(S log S).
  let mut prevCost : Array Float := Array.replicate S 0
  let mut cost : Array Float := Array.replicate S 0
  let mut parent : Array Int := Array.replicate (V * S) (-1)
  for i in [0:S] do prevCost := prevCost.set! i (dist[i]?.getD 0)
  for k in [1:V] do
    let prevBase := (k - 1) * S
    -- Stable ascending by predecessor arc.
    let order := (((List.range S).mergeSort
      (fun x y => arc[prevBase + x]?.getD 0 ≤ arc[prevBase + y]?.getD 0))).toArray
    let mut prefixMinCost : Array Float := Array.replicate S 0
    let mut prefixMinIdx : Array Nat := Array.replicate S 0
    for r in [0:S] do
      let o := order[r]?.getD 0
      let c := prevCost[o]?.getD 0
      if r == 0 || c < prefixMinCost[r-1]?.getD 0 then
        prefixMinCost := prefixMinCost.set! r c
        prefixMinIdx := prefixMinIdx.set! r o
      else
        prefixMinCost := prefixMinCost.set! r (prefixMinCost[r-1]?.getD 0)
        prefixMinIdx := prefixMinIdx.set! r (prefixMinIdx[r-1]?.getD 0)
    for i in [0:S] do
      let sMax := arc[k * S + i]?.getD 0 + 1
      -- Last rank whose predecessor arc ≤ sMax. Bounded binary search: 64
      -- halvings cover any S a day of fixes can produce, and the bound makes
      -- the loop total rather than partial.
      let mut lo : Int := 0
      let mut hi : Int := (S : Int) - 1
      let mut r : Int := -1
      for _ in [0:64] do
        if lo ≤ hi then
          let mid := (lo + hi) / 2
          if arc[prevBase + order[mid.toNat]?.getD 0]?.getD 0 ≤ sMax then
            r := mid
            lo := mid + 1
          else
            hi := mid - 1
      if r < 0 then
        cost := cost.set! i posInf
      else
        cost := cost.set! i (dist[k * S + i]?.getD 0 + prefixMinCost[r.toNat]?.getD 0)
        parent := parent.set! (k * S + i) (prefixMinIdx[r.toNat]?.getD 0 : Int)
    let swap := prevCost
    prevCost := cost
    cost := swap
  -- Backtrack the optimal assignment into per-vertex corridor positions.
  let mut bestI := 0
  for i in [1:S] do
    if prevCost[i]?.getD 0 < prevCost[bestI]?.getD 0 then bestI := i
  let mut cp : Array Float := Array.replicate V 0
  for kk in [0:V] do
    let k := V - 1 - kk
    cp := cp.set! k (arc[k * S + bestI]?.getD 0)
    if k > 0 then
      let p := parent[k * S + bestI]?.getD (-1)
      if p ≥ 0 then bestI := p.toNat
  -- The stall itself: the widest window of drawn length spanned while the
  -- corridor position advanced by no more than `tolM`.
  let mut j := 0
  let mut worst := 0.0
  for k in [0:V] do
    while cp[k]?.getD 0 - cp[j]?.getD 0 > tolM do
      j := j + 1
    worst := max worst (pArc[k]?.getD 0 - pArc[j]?.getD 0)
  return worst

/-! ## Coverage — does the drawn line still reach where the fixes went? -/

/--
The farthest a raw fix falls from the drawn line (m); `0` with no line. A
maximum, unlike the display gate's quantile `strayM`, so a match that stops
halfway cannot hide under a quantile. Stall is the converse question (did the
line go where the fixes did not), so neither substitutes.
-/
def maxFixDistToLine (fixes drawn : Array LatLon) : Float := Id.run do
  if drawn.size < 2 || fixes.isEmpty then return 0
  let mut worst : Float := 0
  for p in fixes do
    let mut best := posInf
    for hm_i : i in [1:drawn.size] do
      have hb_i : i < drawn.size := hm_i.upper
      best := min best (distToSeg p drawn[i - 1] drawn[i])
    worst := max worst best
  return worst

/--
The `q`-quantile of the raw fixes' distance to the drawn line (m), and the
share of fixes beyond `radiusM`. The maximum alone is set by one GPS spike,
and the corpus is full of them; a quantile misses an abandoned half. The share
survives both: a spike is `1/n`, an abandoned half `0.5`. `(0, 0)` with no
line or fixes.
-/
def fixCoverage (fixes drawn : Array LatLon) (q radiusM : Float) : Float × Float := Id.run do
  if drawn.size < 2 || fixes.isEmpty then return (0, 0)
  let mut ds : Array Float := #[]
  for p in fixes do
    let mut best := posInf
    for hm_i : i in [1:drawn.size] do
      have hb_i : i < drawn.size := hm_i.upper
      best := min best (distToSeg p drawn[i - 1] drawn[i])
    ds := ds.push best
  let far := (ds.filter (· > radiusM)).size
  let sorted := ds.qsort (· < ·)
  let idx := min (sorted.size - 1) (ceilSteps (q * Float.ofNat sorted.size) - 1)
  -- One distance per fix and `fixes` is not empty, so `idx` lands.
  let some at_ := sorted[idx]? | return (0, 0)
  return (at_, Float.ofNat far / Float.ofNat ds.size)

/--
How far the drawn line's ends sit from the raw track's ends (m), `(head,
tail)`; `(0, 0)` when either is empty. Never zero for a real match, since the
matcher joins snapped endpoints, so a bar here must be placed from the corpus
distribution.
-/
def endpointGapsM (fixes drawn : Array LatLon) : Float × Float :=
  match fixes[0]?, fixes.back?, drawn[0]?, drawn.back? with
  | some f0, some fl, some d0, some dl => (metersBetween f0 d0, metersBetween fl dl)
  | _, _, _, _ => (0, 0)

/-! ## Buildings -/

/-- Even-odd ray cast: is `p` inside the ring (closed implicitly)? A point on an
edge may go either way, which is harmless here: callers sample at sub-metre
spacing and sum length. -/
def pointInRing (p : LatLon) (ring : Ring) : Bool := Id.run do
  if ring.size < 3 then return false
  let mut inside := false
  -- `j` is the previous vertex, starting from the last: the ring is closed.
  let some last := ring.back? | return false
  let mut pj := last
  for pi in ring do
    let yi := pi.lat
    let xi := pi.lon
    let yj := pj.lat
    let xj := pj.lon
    let crosses := (decide (yi > p.lat) != decide (yj > p.lat))
                   && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    if crosses then inside := !inside
    pj := pi
  return inside

/-- A ring's bounding box. An empty ring gets a box no point satisfies
(`minLat > maxLat`), which matches `pointInRing`'s own `size < 3 → false`. -/
private structure Box where
  minLat : Float
  maxLat : Float
  minLon : Float
  maxLon : Float
  deriving Inhabited

private def ringBox (ring : Ring) : Box := Id.run do
  let some p0 := ring[0]?
    | return { minLat := 1.0, maxLat := 0.0, minLon := 1.0, maxLon := 0.0 }
  let mut b : Box := { minLat := p0.lat, maxLat := p0.lat, minLon := p0.lon, maxLon := p0.lon }
  for q in ring do
    b := { minLat := min b.minLat q.lat, maxLat := max b.maxLat q.lat,
           minLon := min b.minLon q.lon, maxLon := max b.maxLon q.lon }
  return b

private def inBox (p : LatLon) (b : Box) : Bool :=
  p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon

/-- Whether `p` is inside any building ring, the ray cast gated behind an
inclusive bounding box. Exact: a point outside the box already answers `false`.
Unlike the refuted nearest-way prune (3.3x slower: it needs a running best),
containment judges each ring alone. -/
private def inAnyBuildingBoxed (p : LatLon) (boxed : Array (Box × Ring)) : Bool :=
  boxed.any (fun br => inBox p br.1 && pointInRing p br.2)

/-- A drawn point within this many metres of a walkable way is on the mapped
path. -/
def ON_WAY_M : Float := 8

/-- The true-defect lens: length (m) of the drawn line inside a building and
more than `onWayM` from every walkable way. The gate acts on this. A mapped
through-building footway (a concourse) reads 0; gating all in-building length
would make every concourse a defect. -/
def offPathBuildingCrossingM (drawn : Array LatLon) (buildings : Array Ring)
    (walkable : RoadGeometry) (onWayM : Float := ON_WAY_M)
    (stepM : Float := 2) : Float := Id.run do
  if drawn.size < 2 || buildings.isEmpty then return 0
  let boxed := buildings.map (fun r => (ringBox r, r))
  let mut crossed := 0.0
  for hm_i : i in [1:drawn.size] do
    have hb_i : i < drawn.size := hm_i.upper
    let a := drawn[i - 1]
    let b := drawn[i]
    let segLen := metersBetween a b
    if segLen == 0 then continue
    let steps := ceilSteps (segLen / stepM)
    for k in [0:steps] do
      let mid := lerp a b ((k.toFloat + 0.5) / steps.toFloat)
      if inAnyBuildingBoxed mid boxed && distToNearestWay mid walkable > onWayM then
        crossed := crossed + segLen / steps.toFloat
  return crossed

/-! ## Route correctness

The only witness that scores by name: geometry cannot tell a faithful line from
an invention down the next street, the narrative can, where it confirmed a
street. So this is usually `none`. -/

/-- Lowercase, collapse internal whitespace, trim. `"  Example   Rise "` and
`"example rise"` compare equal. See the ASCII caveat in the module header. -/
def normaliseWayName (name : String) : String := Id.run do
  let mut out : String := ""
  let mut pendingSpace := false
  let mut started := false
  for c in name.toLower.toList do
    if c.isWhitespace then
      if started then pendingSpace := true
    else
      if pendingSpace then out := out.push ' '
      pendingSpace := false
      started := true
      out := out.push c
  return out

/-- Nearest named walkable way to `p` within `radiusM`, as `(name, distM)`.
Unnamed ways are skipped: the map's silence cannot count against the line. -/
def nearestNamedWay (p : LatLon) (roads : RoadGeometry) (radiusM : Float) :
    Option (String × Float) := Id.run do
  let mut best : Option (String × Float) := none
  for w in roads.ways do
    match w.name with
    | none => pure ()
    | some nm =>
      for hm_i : i in [1:w.coords.size] do
        have hb_i : i < w.coords.size := hm_i.upper
        let a : LatLon := ⟨w.coords[i - 1].1, w.coords[i - 1].2⟩
        let b : LatLon := ⟨w.coords[i].1, w.coords[i].2⟩
        let d := distToSeg p a b
        if d ≤ radiusM then
          match best with
          | none => best := some (normaliseWayName nm, d)
          | some (_, bd) => if d < bd then best := some (normaliseWayName nm, d)
  return best

/-- Fraction in `[0,1]` of the drawn line's length whose nearest named walkable
way is one of `acceptedNames`. `none`, the common case, when there is nothing to
score against. -/
def onNamedWayFraction (drawn : Array LatLon) (acceptedNames : Array String)
    (walkable : RoadGeometry) (matchRadiusM : Float := 25)
    (stepM : Float := 5) : Option Float := Id.run do
  if acceptedNames.isEmpty || walkable.ways.isEmpty || drawn.size < 2 then return none
  let accepted := acceptedNames.map normaliseWayName
  let mut total := 0.0
  let mut onNamed := 0.0
  for hm_i : i in [1:drawn.size] do
    have hb_i : i < drawn.size := hm_i.upper
    let a := drawn[i - 1]
    let b := drawn[i]
    let segLen := metersBetween a b
    if segLen == 0 then continue
    let steps := ceilSteps (segLen / stepM)
    for k in [0:steps] do
      let f0 := k.toFloat / steps.toFloat
      let f1 := (k.toFloat + 1) / steps.toFloat
      let subLen := segLen * (f1 - f0)
      total := total + subLen
      match nearestNamedWay (lerp a b ((f0 + f1) / 2)) walkable matchRadiusM with
      | some (nm, _) => if accepted.contains nm then onNamed := onNamed + subLen
      | none => pure ()
  if total == 0 then return none
  return some (onNamed / total)

/-! ## Witnesses

Recorded outputs at 1e-9, pinning the arithmetic before the corpus is asked: a
merely plausible metric would sit inside the gate's epsilons. The fixtures are
a synthetic street grid near (51.5, −0.12). -/

section Witnesses

-- The repo's float-guard convention. 1e-9 is far above the ULP of a metre
-- value at these magnitudes (~3e-14 at 172 m), so this pins the double and not
-- a neighbourhood of it.
private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def P (lat lon : Float) : LatLon := ⟨lat, lon⟩

-- An L-shaped walk: north along one street, then east along the next.
private def line : Array LatLon := #[P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5008 (-0.1188)]

-- The raw GPS the line is measured against — the same corner, one fix more.
private def fixes : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5004 (-0.12), P 51.5008 (-0.1194), P 51.5008 (-0.1188)]

-- The same walk with an invented out-and-back down the first street. Its
-- length differs from `line`, but that is not what the stall metric sees: it
-- sees that the excursion made no progress along the corridor.
private def detour : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5008 (-0.1188)]

private def ways : RoadGeometry :=
  { ways := #[
      { name := some "Example Rise", coords := #[(51.5, -0.12), (51.5008, -0.12)] },
      -- Deliberately mis-spaced: the normaliser is exercised through the
      -- metric, not only in isolation.
      { name := some "  Elm   Way ", coords := #[(51.5008, -0.12), (51.5008, -0.1188)] },
      -- Unnamed, and it sits between the two named ones. It must be skipped
      -- rather than counted as "not the accepted street".
      { name := none, coords := #[(51.5004, -0.1206), (51.5004, -0.1194)] }] }

-- A building straddling the first street.
private def ring : Ring :=
  #[P 51.5002 (-0.1202), P 51.5006 (-0.1202), P 51.5006 (-0.1198), P 51.5002 (-0.1198)]

/-! ### Lengths -/

#guard approx (pathLength #[P 51.5 (-0.12), P 51.5008 (-0.12)]) 89.055999999792448
#guard approx (pathLength line) 172.21253550368013
#guard approx (pathLength detour) 350.32453550326500

/-! ### Pedometer

Rows are distributed by overlap: half of a 120-step minute is 60 steps, 43.2 m,
where whole rows would read 86.4. -/

#guard approx (pedometerDistanceM #[⟨1000, 120⟩, ⟨1060, 90⟩] 1000 1120) 151.19999999999999
#guard approx (pedometerDistanceM #[⟨1000, 120⟩] 1030 1060) 43.199999999999996
#guard approx (pedometerDistanceM #[⟨1000, 120⟩] 1000 1000) 0

/-! ### The drawn-path score -/

#guard
  let s := scoreWalk line 1000 1600 #[⟨1000, 500⟩] (some ways)
  approx s.tortuosity 1.4133787000758433
    && approx s.drawnLengthM 172.21253550368013
    && (match s.pedometerM with | some p => approx p 360.0 | none => false)
    && (match s.stepDistanceError with
        | some e => approx e 0.52163184582311073 | none => false)

-- The line rides the ways exactly, so both off-walkable metrics are ~0; the
-- p90's 7.1e-15 is the projection's own rounding, pinned on purpose.
#guard
  let s := scoreWalk line 1000 1600 #[⟨1000, 500⟩] (some ways)
  (match s.offWalkableMeanM with | some m => approx m 0 | none => false)
    && (match s.offWalkableP90M with
        | some p => approx p 7.1054273576010019e-15 | none => false)

/-! ### Corridor stall

Both arms draw the same two streets; only the detour doubles back and is
charged. -/

#guard approx (maxCorridorStall fixes line) 0
#guard approx (maxCorridorStall fixes detour) 89.055999999792448

-- The pair that constrains the monotone assignment: the guards above also pass
-- under a greedy projection. Both walk one street twice, where greedy reads
-- the rest of the walk as one stall.
private def twoPassFixes : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5004 (-0.12), P 51.5008 (-0.12),
    P 51.5004 (-0.12), P 51.5 (-0.12), P 51.5 (-0.1188)]

-- The drawn line is the two-pass walk. A faithful there-and-back the GPS
-- traced is not a stall, and the monotone assignment is the only thing that
-- knows that.
private def twoPassFaithful : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5 (-0.12), P 51.5 (-0.1188)]

-- The same two-pass walk with an invented ~100 m westward excursion the GPS
-- never saw. It cannot advance the corridor, so it is charged in full.
private def twoPassInvented : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5008 (-0.1215),
    P 51.5008 (-0.12), P 51.5 (-0.12), P 51.5 (-0.1188)]

#guard approx (maxCorridorStall twoPassFixes twoPassFaithful) 0
#guard approx (maxCorridorStall twoPassFixes twoPassInvented) 207.89133875972067

-- A line that follows the fixes leaves none of them behind.
#guard maxFixDistToLine fixes line < 10
-- The invented out-and-back still covers every fix: the excursion adds line,
-- it does not withdraw any. This is the case that separates coverage from
-- stall, which scores the same pair high.
#guard maxFixDistToLine fixes detour < 10
#guard maxCorridorStall fixes detour > 50
-- A line that stops at the corner abandons the fixes past it. The last fix is
-- ~84 m east of where the line ends.
private def halfLine : Array LatLon := #[P 51.5 (-0.12), P 51.5008 (-0.12)]
#guard maxFixDistToLine fixes halfLine > 70
#guard maxCorridorStall fixes halfLine == 0
-- Nothing to measure is 0, never a fabricated distance.
#guard maxFixDistToLine #[] line == 0
#guard maxFixDistToLine fixes #[] == 0
#guard (endpointGapsM fixes halfLine).1 < 1
#guard (endpointGapsM fixes halfLine).2 > 70
#guard (endpointGapsM fixes line).2 < 1
#guard endpointGapsM #[] line == (0, 0)

-- A faithful line leaves nobody far away, at either shape.
#guard (fixCoverage fixes line 0.9 30).2 == 0
-- Half a line abandons half the fixes — the share sees it where a low quantile
-- would not, and the quantile sees it where a high one would not. Two of the
-- four fixes lie past the corner the half-line stops at.
#guard (fixCoverage fixes halfLine 0.9 30).2 == 0.5
#guard (fixCoverage fixes halfLine 0.5 50).1 < 50
#guard (fixCoverage fixes halfLine 0.9 50).1 > 70
-- One wild fix moves the share by 1/n and the max by its whole distance.
private def spiked : Array LatLon := fixes.push (P 51.6 (-0.12))
#guard maxFixDistToLine spiked line > 10000
#guard (fixCoverage spiked line 0.9 30).2 == 0.2
#guard (fixCoverage spiked line 0.5 50).1 < 50
#guard fixCoverage #[] line 0.9 50 == (0, 0)

-- One constant is unwitnessed: the DP's 1 m backtrack tolerance (`sMax := arc
-- + 1`); 0 leaves every guard green. A separating fixture needs a sub-metre
-- optimal backtrack, finer than the gate's 5 m epsilon. If the stall metric is
-- ever wrong in a way the two-pass witnesses do not explain, look here first.

/-! ### Buildings -/

#guard pointInRing (P 51.5004 (-0.12)) ring == true
#guard pointInRing (P 51.5 (-0.12)) ring == false

-- The pair that defines the gated metric: with the walkable network present
-- the crossing is a mapped passage (0); without, a chord through a house.
#guard approx (offPathBuildingCrossingM line #[ring] ways) 0
#guard approx (offPathBuildingCrossingM line #[ring] { ways := #[] }) 45.517511111005007

/-! ### Route correctness -/

#guard normaliseWayName "  Example   Rise " == "example rise"

-- Both streets accepted: the whole line is on confirmed ground. Note "elm way"
-- is accepted in its already-normalised spelling and matches the way whose OSM
-- name is "  Elm   Way ", so the normaliser is doing work on both sides.
#guard
  match onNamedWayFraction line #["Example Rise", "elm way"] ways with
  | some v => approx v 1.0
  | none => false

-- Only the first street accepted: the fraction is the first leg's share of the
-- length, and the unnamed way between them changed nothing.
#guard
  match onNamedWayFraction line #["Example Rise"] ways with
  | some v => approx v 0.51712844096583976
  | none => false

-- `none`, not 0. Nothing to score against is not a score of zero — it is the
-- metric declining to answer, and the gate treats the two differently.
#guard (onNamedWayFraction line #[] ways).isNone
#guard (onNamedWayFraction line #["Example Rise"] { ways := #[] }).isNone

/-! ### Step budget

The last two matter: an empty window near data is `some 0` (walked nothing),
far from any row it is `none`. The gate acts hard on the first only. -/

private def stepRows : Array PedStep := #[⟨1000, 100⟩, ⟨1060, 120⟩, ⟨1120, 90⟩]

#guard match stepBudgetM stepRows 1000 1120 with
       | some v => approx v 232.50000000000000 | none => false
-- Inclusive at both ends: a zero-width window on a row's timestamp still
-- collects that whole row.
#guard match stepBudgetM stepRows 1060 1060 with
       | some v => approx v 90.000000000000000 | none => false
#guard match stepBudgetM stepRows 5000 5060 with
       | some v => approx v 0 | none => false
#guard (stepsInWindow #[] 1000 1120).isNone
#guard (stepsInWindow stepRows 9000000 9000060).isNone

end Witnesses

end Verified.Eval.WalkMetrics
