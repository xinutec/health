/-!
# Walk-geometry referee metrics (#1048 Group B)

The metric PRODUCER behind `Verified.Eval.WalkGate` — a port of the four pure
modules the deleted `score-walk-match` called: `src/eval/walk-score.ts`,
`walk-plausibility.ts`, `walk-buildings.ts` and `walk-route-correctness.ts`.

The gate asks "did this walk get worse?"; this file is what "worse" is measured
with. It is separate from the ratchet on purpose: the ratchet is a handful of
comparisons and could be read at a glance, whereas these are the geometry, and
mixing them would hide the one inside the other.

## No single number is truth

That is the lesson of #293/#295, and it is why this reports a VECTOR per walk
rather than a score. Each metric is confounded alone:

* off-walkable p90 is snapper-biased — a phantom that hugs mapped ways scores
  well, and a reconstruction that rightly dissolves it scores worse. The gate
  records it and does not act on it.
* corridor stall sees an invented detour but is blind to a coherent smear.
* the step budget sees the smear — a line cannot draw more metres than the
  pedometer counted — but says nothing about WHERE the line went.
* route-correctness is the only one that scores by NAME rather than geometry,
  and it exists only where the ground-truth narrative confirmed a street.

A change is judged across all of them at once, which is what the gate does.

## ⚠ `none` is UNMEASURED and never zero

Every `Option` here means the question could not be asked — no building
footprints in the fixture, no named-street truth over the leg, no step data for
the day. A lost measurement that reads as a clean `0` is the failure mode this
whole file is shaped against: it would turn an unanswerable question into the
best possible answer.

## Exactness

The arithmetic is float-for-float what V8 ran: the same planar
lat/lon→metre approximation (111320 m/deg, `cos` at the segment midpoint), the
same clamps, the same sampling steps. That matters because
`tests/golden/walk-baseline.json` was blessed by the TypeScript, so a
structurally different port would redden the gate on a healthy tree.

⚠ Two known divergences, both argued to be below the gate's resolution:

* `Math.hypot` is not `sqrt(x²+y²)` — V8's is overflow-careful — so a metre
  value can differ in the last ULP. The gate's epsilons are 0.1 (a fraction)
  and 5–30 m, so a ULP cannot move a verdict.
* `String.toLower` is ASCII-only where JS `toLowerCase` is Unicode-aware, so a
  non-ASCII street name could normalise differently. Same caveat as
  `Verified.Hsmm.ServedStations`.

Neither is assumed. The port is checked against the blessed baseline over the
real corpus by the Rust harness — that is the oracle, and it is a file, which is
what makes this Group B rather than a parity gate against itself.
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

⚠ Not haversine. The referee measures a walk — hundreds of metres — where the
equirectangular approximation is exact to well under the metric's resolution,
and it is what the TypeScript used, so changing it here would move every value
in the blessed baseline. -/

private def pi : Float := 3.14159265358979323846

/-- `Math.hypot(x, y)`. See the ULP caveat in the module header. -/
private def hyp (x y : Float) : Float := Float.sqrt (x * x + y * y)

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

private def posInf : Float := 1.0 / 0.0

/-- Total drawn length (m). -/
def pathLength (pts : Array LatLon) : Float := Id.run do
  let mut t := 0.0
  for i in [1:pts.size] do
    t := t + metersBetween pts[i-1]! pts[i]!
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
    for i in [1:w.coords.size] do
      let a : LatLon := ⟨w.coords[i-1]!.1, w.coords[i-1]!.2⟩
      let b : LatLon := ⟨w.coords[i]!.1, w.coords[i]!.2⟩
      let d := distToSeg p a b
      if d < best then best := d
  return best

/-! ## Pedometer -/

/-- Steps overlapping `[from, to)` × stride (m). Per-minute rows are
distributed by TIME OVERLAP, so a sub-minute window gets its fraction rather
than the whole row — a leg boundary must not import a neighbouring minute's
steps wholesale. -/
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

⚠ TWO windowing rules and TWO strides live a few lines apart in the original,
and the referee uses the SECOND of each. `pedometerDistanceM` above distributes
per-minute rows by time OVERLAP at a 0.72 m stride; `stepsInWindow` here sums
WHOLE rows whose timestamp falls in an INCLUSIVE window, and the budget
multiplies by 0.75. They are not interchangeable, and a port that tidied them
into one would move every `budgetM` in the blessed baseline. -/

/-- The reconstruction profile's stride. ⚠ 0.75 — NOT `scoreWalk`'s 0.72. -/
def STEP_STRIDE_M : Float := 0.75

/-- Steps whose row timestamp lies in `[startTs, endTs]` — inclusive at both
ends, whole rows, no overlap distribution.

⚠ `none` means NO STEP DATA, and it is NOT the same as `some 0`. A window that
contains no steps but sits within a day of some step row returns `some 0` —
the pedometer positively saying the leg covered no counted steps, which is the
strongest phantom evidence the referee has. Only a window with no rows at all,
or none within 86400 s, declines to answer. Collapsing the two would turn the
loudest signal into silence. -/
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

/-- The leg's pedometer displacement budget (m), with NO slack. The gate
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
  /-- Mean distance (m) from a drawn VERTEX to the nearest NEARBY walkable way;
  `none` if no path is ever near. -/
  offWalkableMeanM : Option Float
  /-- p90 distance (m) of the drawn LINE to the nearest walkable way, sampled
  along the chords and WITHOUT the openness exclusion — so a chord cutting deep
  across a block counts instead of being filtered out as open ground. -/
  offWalkableP90M : Option Float
  deriving Inhabited, Repr

/-- The `q`-quantile of the drawn LINE's distance to the network, sampled at
the vertices AND every `stepM` along the chords, with no openness exclusion.

⚠ p90 rather than max: a single GPS spike must not become the metric. -/
def offWalkableQuantile (drawn : Array LatLon) (walkable : RoadGeometry)
    (q : Float) (stepM : Float := 5) : Option Float := Id.run do
  if drawn.isEmpty then return none
  let mut samples : Array Float := #[]
  for i in [0:drawn.size] do
    samples := samples.push (distToNearestWay drawn[i]! walkable)
    if i + 1 < drawn.size then
      let a := drawn[i]!
      let b := drawn[i+1]!
      let chord := metersBetween a b
      let n := (Float.floor (chord / stepM)).toInt64.toInt.toNat
      for k in [1:n] do
        samples := samples.push
          (distToNearestWay (lerp a b (k.toFloat / n.toFloat)) walkable)
  if samples.isEmpty then return none
  let sorted := (samples.toList.mergeSort (· ≤ ·)).toArray
  let idx := (Float.floor (sorted.size.toFloat * q)).toInt64.toInt.toNat
  return some sorted[min (sorted.size - 1) idx]!

/-- Score a drawn walk. `opennessRadiusM` excludes vertices with no nearby path
(open ground) from the off-walkable MEAN — but deliberately not from the p90,
which is where a deep building cut shows. -/
def scoreWalk (drawn : Array LatLon) (startTs endTs : Float)
    (steps : Array PedStep := #[]) (walkable : Option RoadGeometry := none)
    (strideM : Float := 0.72) (opennessRadiusM : Float := 35) : WalkScore := Id.run do
  let drawnLengthM := pathLength drawn
  let straight := if drawn.size ≥ 2 then metersBetween drawn[0]! drawn[drawn.size-1]! else 0
  let tortuosity := if straight > 1 then drawnLengthM / straight else 1
  let ped := if steps.isEmpty then none
             else some (pedometerDistanceM steps startTs endTs strideM)
  -- ⚠ `ped && ped > 1` in the TS: a ZERO pedometer distance is falsy there and
  -- yields null, not a division. Preserved — a leg with no counted steps has no
  -- step error, it does not have an infinite one.
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
      offWalkableP90M := offWalkableQuantile drawn w 0.9
  | none => pure ()
  return { tortuosity, drawnLengthM, pedometerM := ped, stepDistanceError,
           offWalkableMeanM, offWalkableP90M }

/-! ## Corridor stall

The witness `scoreWalk` cannot see, because `scoreWalk` never looks at the raw
fixes: how far the drawn line travels while making no progress ALONG the GPS
corridor. High for an invented detour, ~0 for a faithful line, a gap-fill (the
corridor advances) or a there-and-back the GPS actually traced. -/

/-- The longest run of `path` that travels far while its monotone projection
onto the time-ordered `fixes` polyline barely advances (m).

⚠ The projection is the MIN-COST MONOTONE ASSIGNMENT (a DP), not a greedy
nearest-projection ratchet. The greedy version mis-scored out-and-back walks: on
a street walked TWICE, the locally-nearest projection of an early vertex could
land on the RETURN pass, ratcheting the floor forward so the whole rest of the
walk read as one giant stall — measured, a line ≤12 m off a 118 m-stall matched
line scored 2169 m. Choosing the jointly-cheapest assignment puts each pass of
the drawn line on the pass of the fixes it actually follows. An invented detour
still cannot advance, because there are no nearby fixes ahead of it, so the
signal this exists to catch is unchanged. -/
def maxCorridorStall (fixes path : Array LatLon) (tolM : Float := 15) : Float := Id.run do
  if path.size < 2 || fixes.size < 2 then return 0
  let mut fArc : Array Float := #[0]
  for i in [1:fixes.size] do
    fArc := fArc.push (fArc[i-1]! + metersBetween fixes[i-1]! fixes[i]!)
  let mut pArc : Array Float := #[0]
  for i in [1:path.size] do
    pArc := pArc.push (pArc[i-1]! + metersBetween path[i-1]! path[i]!)
  let V := path.size
  let S := fixes.size - 1
  -- `dist` is each vertex's distance to each fix-segment; `arc` is where on the
  -- corridor that projection lands.
  let mut dist : Array Float := Array.replicate (V * S) 0
  let mut arc : Array Float := Array.replicate (V * S) 0
  for k in [0:V] do
    let v := path[k]!
    for i in [0:S] do
      let a := fixes[i]!
      let b := fixes[i+1]!
      let cosLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
      let bx := (b.lon - a.lon) * 111320.0 * cosLat
      let byM := (b.lat - a.lat) * 111320.0
      let px := (v.lon - a.lon) * 111320.0 * cosLat
      let py := (v.lat - a.lat) * 111320.0
      -- ⚠ `|| 1e-9` in the TS, which fires on a ZERO-length segment (two
      -- identical fixes). Not the `=== 0 ? 0` used elsewhere in this file —
      -- the two idioms differ and both are preserved as written.
      let l2raw := bx * bx + byM * byM
      let l2 := if l2raw == 0 || l2raw.isNaN then 1e-9 else l2raw
      let t := clamp01 ((px * bx + py * byM) / l2)
      dist := dist.set! (k * S + i) (hyp (px - t * bx) (py - t * byM))
      arc := arc.set! (k * S + i) (fArc[i]! + t * (fArc[i+1]! - fArc[i]!))
  -- DP over (vertex, fix-segment): cost = own projection distance + cheapest
  -- predecessor whose arc position is ≤ ours + 1 m (a backtrack tolerance).
  -- Prefix-min over predecessors sorted by arc makes each step O(S log S).
  let mut prevCost : Array Float := Array.replicate S 0
  let mut cost : Array Float := Array.replicate S 0
  let mut parent : Array Int := Array.replicate (V * S) (-1)
  for i in [0:S] do prevCost := prevCost.set! i dist[i]!
  for k in [1:V] do
    let prevBase := (k - 1) * S
    -- Stable ascending by predecessor arc, matching V8's sort.
    let order := (((List.range S).mergeSort
      (fun x y => arc[prevBase + x]! ≤ arc[prevBase + y]!))).toArray
    let mut prefixMinCost : Array Float := Array.replicate S 0
    let mut prefixMinIdx : Array Nat := Array.replicate S 0
    for r in [0:S] do
      let c := prevCost[order[r]!]!
      if r == 0 || c < prefixMinCost[r-1]! then
        prefixMinCost := prefixMinCost.set! r c
        prefixMinIdx := prefixMinIdx.set! r order[r]!
      else
        prefixMinCost := prefixMinCost.set! r prefixMinCost[r-1]!
        prefixMinIdx := prefixMinIdx.set! r prefixMinIdx[r-1]!
    for i in [0:S] do
      let sMax := arc[k * S + i]! + 1
      -- Last rank whose predecessor arc ≤ sMax. Bounded binary search: 64
      -- halvings cover any S a day of fixes can produce, and the bound makes
      -- the loop total rather than partial.
      let mut lo : Int := 0
      let mut hi : Int := (S : Int) - 1
      let mut r : Int := -1
      for _ in [0:64] do
        if lo ≤ hi then
          let mid := (lo + hi) / 2
          if arc[prevBase + order[mid.toNat]!]! ≤ sMax then
            r := mid
            lo := mid + 1
          else
            hi := mid - 1
      if r < 0 then
        cost := cost.set! i posInf
      else
        cost := cost.set! i (dist[k * S + i]! + prefixMinCost[r.toNat]!)
        parent := parent.set! (k * S + i) (prefixMinIdx[r.toNat]! : Int)
    let swap := prevCost
    prevCost := cost
    cost := swap
  -- Backtrack the optimal assignment into per-vertex corridor positions.
  let mut bestI := 0
  for i in [1:S] do
    if prevCost[i]! < prevCost[bestI]! then bestI := i
  let mut cp : Array Float := Array.replicate V 0
  for kk in [0:V] do
    let k := V - 1 - kk
    cp := cp.set! k arc[k * S + bestI]!
    if k > 0 then
      let p := parent[k * S + bestI]!
      if p ≥ 0 then bestI := p.toNat
  -- The stall itself: the widest window of drawn length spanned while the
  -- corridor position advanced by no more than `tolM`.
  let mut j := 0
  let mut worst := 0.0
  for k in [0:V] do
    while cp[k]! - cp[j]! > tolM do
      j := j + 1
    worst := max worst (pArc[k]! - pArc[j]!)
  return worst

/-! ## The full per-walk verdict -/

/-- Every independent witness for one drawn leg, reported together. -/
structure WalkPlausibility extends WalkScore where
  /-- Out-and-back distance the drawn line makes without advancing along the
  raw GPS corridor (m). -/
  corridorStallM : Float
  /-- Length of the raw GPS track (m) — the honest baseline the drawn line is
  measured against. -/
  rawLengthM : Float
  /-- Mean speed implied by the DRAWN line over the leg window (km/h). The
  off-walkable and stall witnesses are both blind to a line that sprints along
  a real pavement — a run of low-accuracy fixes drawn as motion (underground,
  indoors) shows up ONLY here, as an impossible walking speed. 0 when the leg
  has no duration. -/
  avgDrawnSpeedKmh : Float
  deriving Inhabited, Repr

/-- Score a drawn walk against every witness at once. `drawn` is the line the
map shows — matched, or raw when the matcher bailed. -/
def walkPlausibility (fixes drawn : Array LatLon) (startTs endTs : Float)
    (steps : Array PedStep := #[]) (walkable : Option RoadGeometry := none) :
    WalkPlausibility :=
  let base := scoreWalk drawn startTs endTs steps walkable
  let rawLengthM := pathLength fixes
  let spanSec := endTs - startTs
  let avgDrawnSpeedKmh := if spanSec > 0 then (base.drawnLengthM / spanSec) * 3.6 else 0
  { toWalkScore := base
    corridorStallM := maxCorridorStall fixes drawn
    rawLengthM, avgDrawnSpeedKmh }

/-! ## Buildings -/

/-- Even-odd ray cast: is `p` inside the closed ring? The ring need not repeat
its first vertex — the last→first edge is closed implicitly.

Points exactly ON an edge are reported inconsistently, as with any ray cast.
That is acceptable here and only here: the callers sample at sub-metre spacing
and sum LENGTH, so a single ambiguous sample moves the metric by its own step
size, not by a whole crossing. -/
def pointInRing (p : LatLon) (ring : Ring) : Bool := Id.run do
  if ring.size < 3 then return false
  let mut inside := false
  let mut j := ring.size - 1
  for i in [0:ring.size] do
    let yi := ring[i]!.lat
    let xi := ring[i]!.lon
    let yj := ring[j]!.lat
    let xj := ring[j]!.lon
    let crosses := (decide (yi > p.lat) != decide (yj > p.lat))
                   && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    if crosses then inside := !inside
    j := i
  return inside

private def inAnyBuilding (p : LatLon) (buildings : Array Ring) : Bool :=
  buildings.any (fun ring => pointInRing p ring)

/-- Total length (m) of the drawn line inside ANY building footprint.

The line is sampled into `stepM` sub-segments and each is attributed by its
MIDPOINT, so the result is length-weighted rather than a vertex count. 0 for a
degenerate line or an empty building set — and note that an empty building set
is `0` here and `none` at the caller, which is the distinction the whole file
turns on. -/
def buildingCrossingM (drawn : Array LatLon) (buildings : Array Ring)
    (stepM : Float := 2) : Float := Id.run do
  if drawn.size < 2 || buildings.isEmpty then return 0
  let mut crossed := 0.0
  for i in [1:drawn.size] do
    let a := drawn[i-1]!
    let b := drawn[i]!
    let segLen := metersBetween a b
    if segLen == 0 then continue
    let steps := ceilSteps (segLen / stepM)
    for k in [0:steps] do
      let mid := lerp a b ((k.toFloat + 0.5) / steps.toFloat)
      if inAnyBuilding mid buildings then crossed := crossed + segLen / steps.toFloat
  return crossed

/-- A drawn point within this many metres of a walkable way is ON the mapped
path. -/
def ON_WAY_M : Float := 8

/-- The TRUE-DEFECT lens: length (m) of the drawn line inside a building while
more than `onWayM` from EVERY walkable way.

⚠ This is the metric the gate acts on, and the exclusion is the whole point. A
line riding a mapped through-building footway — a station concourse, an arcade
— is a legitimate passage that OSM says is walkable, and it reads 0 here while
`buildingCrossingM` charges it in full. A chord through a house with no path
counts in full in both. Gating the superset would have made every concourse a
defect. -/
def offPathBuildingCrossingM (drawn : Array LatLon) (buildings : Array Ring)
    (walkable : RoadGeometry) (onWayM : Float := ON_WAY_M)
    (stepM : Float := 2) : Float := Id.run do
  if drawn.size < 2 || buildings.isEmpty then return 0
  let mut crossed := 0.0
  for i in [1:drawn.size] do
    let a := drawn[i-1]!
    let b := drawn[i]!
    let segLen := metersBetween a b
    if segLen == 0 then continue
    let steps := ceilSteps (segLen / stepM)
    for k in [0:steps] do
      let mid := lerp a b ((k.toFloat + 0.5) / steps.toFloat)
      if inAnyBuilding mid buildings && distToNearestWay mid walkable > onWayM then
        crossed := crossed + segLen / steps.toFloat
  return crossed

/-! ## Route correctness

The only witness that scores by NAME. Everything else in this file is geometry
against geometry, which cannot tell a faithful line from a plausible invention
down the next street over; the ground-truth narrative can, but only where it
confirmed a street, which is why this metric is `none` far more often than it
is a number. -/

/-- Lowercase, collapse internal whitespace, trim. `"  Barn   Rise "` and
`"barn rise"` compare equal. See the ASCII caveat in the module header. -/
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

/-- Nearest NAMED walkable way to `p` within `radiusM`, as `(name, distM)`.

Unnamed ways are skipped rather than treated as a mismatch: an unnamed footway
cannot corroborate a named-street claim either way, and counting it as "not the
accepted street" would charge the line for the map's silence. -/
def nearestNamedWay (p : LatLon) (roads : RoadGeometry) (radiusM : Float) :
    Option (String × Float) := Id.run do
  let mut best : Option (String × Float) := none
  for w in roads.ways do
    match w.name with
    | none => pure ()
    | some nm =>
      for i in [1:w.coords.size] do
        let a : LatLon := ⟨w.coords[i-1]!.1, w.coords[i-1]!.2⟩
        let b : LatLon := ⟨w.coords[i]!.1, w.coords[i]!.2⟩
        let d := distToSeg p a b
        if d ≤ radiusM then
          match best with
          | none => best := some (normaliseWayName nm, d)
          | some (_, bd) => if d < bd then best := some (normaliseWayName nm, d)
  return best

/-- Fraction in `[0,1]` of the drawn line's LENGTH whose nearest named walkable
way (within `matchRadiusM`) is one of `acceptedNames`.

`none` when there is nothing to score against — no accepted name, no walkable
geometry, or a zero-length line. That is the common case and it is not a
failure; it is the metric declining to answer. -/
def onNamedWayFraction (drawn : Array LatLon) (acceptedNames : Array String)
    (walkable : RoadGeometry) (matchRadiusM : Float := 25)
    (stepM : Float := 5) : Option Float := Id.run do
  if acceptedNames.isEmpty || walkable.ways.isEmpty || drawn.size < 2 then return none
  let accepted := acceptedNames.map normaliseWayName
  let mut total := 0.0
  let mut onNamed := 0.0
  for i in [1:drawn.size] do
    let a := drawn[i-1]!
    let b := drawn[i]!
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

⚠ EVERY NUMBER BELOW CAME OUT OF V8, not out of my arithmetic. The four
TypeScript modules were checked out UNMODIFIED from `06346bd^` — #1048's
recorded recovery point — and called directly; the harness that printed these is
kept beside this file's history rather than in the tree, because it can only run
against a deleted `src/` and would be a broken script here.

That matters more than usual for this port. `tests/golden/walk-baseline.json`
was blessed BY that TypeScript, so a port that is merely plausible would sit
inside the gate's 5–30 m epsilons and read as agreement while being a different
metric. These pin the arithmetic itself, at 1e-9, before the corpus is asked.

The fixtures are a synthetic street grid near (51.5, −0.12) — a corner, a ring,
three ways. No real coordinates (#860); the referee has no opinion about which
city it is in. -/

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

-- The SAME walk with an invented out-and-back down the first street. Its
-- length differs from `line`, but that is not what the stall metric sees: it
-- sees that the excursion made no progress along the corridor.
private def detour : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5 (-0.12), P 51.5008 (-0.12), P 51.5008 (-0.1188)]

private def ways : RoadGeometry :=
  { ways := #[
      { name := some "Barn Rise", coords := #[(51.5, -0.12), (51.5008, -0.12)] },
      -- ⚠ Deliberately mis-spaced: the normaliser is exercised through the
      -- metric, not only in isolation.
      { name := some "  Elm   Way ", coords := #[(51.5008, -0.12), (51.5008, -0.1188)] },
      -- Unnamed, and it sits between the two named ones. It must be SKIPPED
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

The per-minute rows are distributed by TIME OVERLAP. `ped_partial` is the one
that shows it: half of one 120-step minute is 60 steps, 43.2 m — a whole-row
implementation would read 86.4. -/

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

-- ⚠ The line rides the ways exactly, so both off-walkable metrics are ~0 —
-- and the p90 is 7.1e-15 rather than a clean zero. That residue is the planar
-- projection's own rounding, and pinning it is the point: a port that produced
-- a tidy 0 here would be computing something else.
#guard
  let s := scoreWalk line 1000 1600 #[⟨1000, 500⟩] (some ways)
  (match s.offWalkableMeanM with | some m => approx m 0 | none => false)
    && (match s.offWalkableP90M with
        | some p => approx p 7.1054273576010019e-15 | none => false)

/-! ### Corridor stall

The witness `scoreWalk` cannot see. Both arms below draw the SAME two streets;
only the detour doubles back, and only the detour is charged. -/

#guard approx (maxCorridorStall fixes line) 0
#guard approx (maxCorridorStall fixes detour) 89.055999999792448

-- ⚠ THE PAIR THAT CONSTRAINS THE MONOTONE ASSIGNMENT, and the reason the two
-- guards above are not enough. They pass under a GREEDY nearest-projection
-- ratchet too, so on their own they say nothing about the DP the comment above
-- calls load-bearing. (Found by ablation: perturbing the projection left them
-- green.)
--
-- Both fixtures below walk one street TWICE — north, back south, then east —
-- which is the case the greedy version got wrong: an early vertex projects
-- onto the RETURN pass, ratchets the corridor floor forward, and the rest of
-- the walk reads as one giant stall.
private def twoPassFixes : Array LatLon :=
  #[P 51.5 (-0.12), P 51.5004 (-0.12), P 51.5008 (-0.12),
    P 51.5004 (-0.12), P 51.5 (-0.12), P 51.5 (-0.1188)]

-- The drawn line IS the two-pass walk. A faithful there-and-back the GPS
-- traced is NOT a stall, and the monotone assignment is the only thing that
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

-- ⚠ ONE CONSTANT IN THIS FILE IS UNWITNESSED, stated here rather than left to
-- be discovered: the DP's 1 m BACKTRACK TOLERANCE (`sMax := arc + 1`). Setting
-- it to 0 leaves every guard above green, so nothing here constrains it.
--
-- It is not covered because a fixture that separates 1 m of permitted
-- backtrack from 0 needs an optimal assignment that backtracks by less than a
-- metre, and the sampling that would produce one is finer than the metric it
-- feeds — the gate's smallest epsilon is 5 m. The value is inherited from the
-- greedy implementation this DP replaced, where it was the same tolerance.
--
-- Recorded, not waived: if the stall metric is ever wrong in a way the two-pass
-- witnesses do not explain, this is the first place to look.

#guard
  let w := walkPlausibility fixes line 1000 1600 #[⟨1000, 500⟩] (some ways)
  approx w.corridorStallM 0
    && approx w.rawLengthM 147.02843372172879
    && approx w.avgDrawnSpeedKmh 1.0332752130220808

/-! ### Buildings -/

#guard pointInRing (P 51.5004 (-0.12)) ring == true
#guard pointInRing (P 51.5 (-0.12)) ring == false
#guard approx (buildingCrossingM line #[ring]) 45.517511111005007
-- An empty building set is 0 here. The CALLER turns that into `none`; this
-- function has no way to tell "no buildings crossed" from "no buildings known",
-- which is exactly why the caller must.
#guard approx (buildingCrossingM line #[]) 0

-- ⚠ THE PAIR THAT DEFINES THE GATED METRIC. Same line, same building. With
-- the walkable network present the crossing is a mapped passage and counts 0;
-- with no network it is a chord through a house and counts in full. Gating the
-- superset would have made every station concourse a defect.
#guard approx (offPathBuildingCrossingM line #[ring] ways) 0
#guard approx (offPathBuildingCrossingM line #[ring] { ways := #[] }) 45.517511111005007

/-! ### Route correctness -/

#guard normaliseWayName "  Barn   Rise " == "barn rise"

-- Both streets accepted: the whole line is on confirmed ground. Note "elm way"
-- is accepted in its already-normalised spelling and matches the way whose OSM
-- name is "  Elm   Way ", so the normaliser is doing work on both sides.
#guard
  match onNamedWayFraction line #["Barn Rise", "elm way"] ways with
  | some v => approx v 1.0
  | none => false

-- Only the first street accepted: the fraction is the first leg's share of the
-- length, and the unnamed way between them changed nothing.
#guard
  match onNamedWayFraction line #["Barn Rise"] ways with
  | some v => approx v 0.51712844096583976
  | none => false

-- ⚠ `none`, NOT 0. Nothing to score against is not a score of zero — it is the
-- metric declining to answer, and the gate treats the two differently.
#guard (onNamedWayFraction line #[] ways).isNone
#guard (onNamedWayFraction line #["Barn Rise"] { ways := #[] }).isNone


/-! ### Step budget

⚠ The last two are the pair that matters. An empty window NEAR the data is
`some 0` — the pedometer says this leg walked nothing — while a window far from
any row is `none`, no data. The gate acts hard on the first and not at all on
the second. -/

private def stepRows : Array PedStep := #[⟨1000, 100⟩, ⟨1060, 120⟩, ⟨1120, 90⟩]

#guard match stepBudgetM stepRows 1000 1120 with
       | some v => approx v 232.50000000000000 | none => false
-- Inclusive at BOTH ends: a zero-width window on a row's timestamp still
-- collects that whole row.
#guard match stepBudgetM stepRows 1060 1060 with
       | some v => approx v 90.000000000000000 | none => false
#guard match stepBudgetM stepRows 5000 5060 with
       | some v => approx v 0 | none => false
#guard (stepsInWindow #[] 1000 1120).isNone
#guard (stepsInWindow stepRows 9000000 9000060).isNone

end Witnesses

end Verified.Eval.WalkMetrics
