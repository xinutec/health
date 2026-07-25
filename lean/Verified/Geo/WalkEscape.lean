import Verified.Geo.WalkableRoute
import Std.Data.HashMap

/-!
# Building-escape walk corrector (port of `src/geo/walk-building-escape.ts`)

The explicit, case-based reconstruction of a drawn walk line so it stops running
through houses:

1. a vertex inside a building is moved OUT onto the nearest street *on that
   building's side*;
2. a gap that is implausible — it crosses a footprint, or it is an urban block
   cut (far off every walkable way in built surroundings) — is routed along the
   walkable streets, or failing that around the footprint's own corners;
3. with no streets nearby, the GPS stands.

The TS module is pure geometry end to end, so ALL of it ports — including the
output records, which here (as in `DayState`) *are* the decision rather than a
re-clone of an input row.

Two boundary notes:

* `correctWalkPath` takes just the way list: `routeOnWalkable` fuses and builds
  its own graph now that `toFixed` is ported (`Verified.JsNum`), so nothing is
  pre-computed for it.
* The TS `diag` sink is optional, and when it is absent the anchor snap
  distances are not even computed. The Lean twin always returns the records —
  i.e. it reproduces the diag-supplied arm, which is the one with observable
  numbers. The `WALK_CORNER_DEBUG` `console.error` tracing stays shell: it is an
  env read with no effect on the geometry.
-/

namespace Verified.Geo.WalkEscape

open Verified.Geo.WalkableRoute
  (Pt Proj Ways metersBetween projectPointToSegment WalkGraph RouteOptions routeOnWalkable)

private def pi : Float := 3.14159265358979323846
private def posInf : Float := 1.0 / 0.0
private def negInf : Float := -1.0 / 0.0

/-- `Math.floor` into an `Int`, the JS grid-cell index. -/
private def floorInt (x : Float) : Int := (Float.floor x).toInt64.toInt

/-- JS `x || 1`: zero and NaN are falsy. -/
private def orOne (x : Float) : Float := if x == 0 || x.isNaN then 1 else x

/-- `Math.sign`. -/
private def jsSign (x : Float) : Float :=
  if x > 0 then 1 else if x < 0 then -1 else x

/-- A closed building footprint ring (the last→first edge is implicit). -/
abbrev Ring := Array Pt


/-- A drawn walk vertex (`CorrectedPoint`). -/
structure TPt where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

def TPt.pt (p : TPt) : Pt := ⟨p.lat, p.lon⟩

/-- A nearest-point answer: the foot of the projection and its distance. -/
structure NearPt where
  lat : Float
  lon : Float
  distM : Float
  deriving Inhabited, Repr

/-! ## Ring and network primitives -/

/-- Even-odd ray cast: is `p` inside the closed polygon `ring`? -/
def pointInRing (p : Pt) (ring : Ring) : Bool := Id.run do
  let n := ring.size
  if n < 3 then return false
  let mut inside := false
  let mut j := n - 1
  for i in [0:n] do
    let yi := ring[i]!.lat
    let xi := ring[i]!.lon
    let yj := ring[j]!.lat
    let xj := ring[j]!.lon
    if ((yi > p.lat) != (yj > p.lat)) && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi then
      inside := !inside
    j := i
  return inside

/-- Nearest point on the closed boundary of `ring` to `p`. Strict improvement,
    so the FIRST edge at the minimum wins; edges run `(n-1,0), (0,1), …`. -/
def nearestOnRing (p : Pt) (ring : Ring) : Option NearPt := Id.run do
  let n := ring.size
  if n == 0 then return none
  let mut best : Option NearPt := none
  let mut j := n - 1
  for i in [0:n] do
    let proj := projectPointToSegment p ring[j]! ring[i]!
    let better := match best with
      | none => true
      | some b => proj.distM < b.distM
    if better then best := some ⟨proj.lat, proj.lon, proj.distM⟩
    j := i
  return best

/-- Nearest point on any walkable way to `p`; `none` when the network is empty. -/
def nearestWalkable (p : Pt) (ways : Ways) : Option NearPt := Id.run do
  let mut best : Option NearPt := none
  for w in ways do
    for i in [1:w.size] do
      let proj := projectPointToSegment p w[i-1]! w[i]!
      let better := match best with
        | none => true
        | some b => proj.distM < b.distM
      if better then best := some ⟨proj.lat, proj.lon, proj.distM⟩
  return best

/-- The building ring `p` is inside, or `none`. First match wins. -/
def containingBuilding (p : Pt) (buildings : Array Ring) : Option Ring := Id.run do
  for ring in buildings do
    if pointInRing p ring then return some ring
  return none

/-! ## Way-segment grid

Grid index over way segments for the badness THRESHOLD tests ("is any way
within `maxM`?"), which run per 2 m sample over whole legs. Cells are sized to
the largest query radius, so a 3×3 probe is exact. Reproduced faithfully rather
than replaced by a linear scan: the cell sizing converts metres to degrees at
ONE reference latitude (the network's first coordinate), so the 3×3 window is
exact only up to that `cos`-latitude approximation — a linear scan would be a
different function, not the same one implemented better.
-/

structure WaySegmentGrid where
  buckets : Std.HashMap (Int × Int) (Array (Pt × Pt))
  cellLat : Float
  cellLon : Float
  /-- Largest radius (m) `within` may be asked for — fixed at build time. -/
  maxQueryM : Float

def mkWaySegmentGrid (ways : Ways) (maxQueryM : Float) : WaySegmentGrid := Id.run do
  let refLat : Float :=
    match ways[0]? with
    | none => 51
    | some w => match w[0]? with
      | none => 51
      | some p => p.lat
  let cellLat := maxQueryM / 111320.0
  let cellLon := maxQueryM / (111320.0 * Float.cos (refLat * pi / 180))
  let mut buckets : Std.HashMap (Int × Int) (Array (Pt × Pt)) := {}
  for w in ways do
    for i in [1:w.size] do
      let a := w[i-1]!
      let b := w[i]!
      let loLat := floorInt (min a.lat b.lat / cellLat)
      let hiLat := floorInt (max a.lat b.lat / cellLat)
      let loLon := floorInt (min a.lon b.lon / cellLon)
      let hiLon := floorInt (max a.lon b.lon / cellLon)
      let mut cy := loLat
      while cy <= hiLat do
        let mut cx := loLon
        while cx <= hiLon do
          buckets := buckets.insert (cy, cx) ((buckets.getD (cy, cx) #[]).push (a, b))
          cx := cx + 1
        cy := cy + 1
  return { buckets, cellLat, cellLon, maxQueryM }

/-- Is any way segment within `maxM` (≤ `maxQueryM`) of `p`? -/
def WaySegmentGrid.within (g : WaySegmentGrid) (p : Pt) (maxM : Float) : Bool := Id.run do
  let cy := floorInt (p.lat / g.cellLat)
  let cx := floorInt (p.lon / g.cellLon)
  for dy in [0:3] do
    for dx in [0:3] do
      let key := (cy + Int.ofNat dy - 1, cx + Int.ofNat dx - 1)
      for (a, b) in g.buckets.getD key #[] do
        if (projectPointToSegment p a b).distM <= maxM then return true
  return false

/-! ## Case 1 + case 3: per-vertex escape -/

structure EscapeOptions where
  /-- Step (m) past the escaped wall, so the point clears the footprint. -/
  wallMarginM : Float := 2
  /-- Only snap the escaped point to a street within this radius (m). -/
  streetSnapRadiusM : Float := 20
  deriving Inhabited

/-- The escaped position for `p`, or `none` when it is not inside a building or
    there is no near-side street to move it onto (case 3 — trust the GPS). -/
def escapedPosition (p : Pt) (walkable : Ways) (buildings : Array Ring)
    (opts : EscapeOptions) : Option Pt :=
  match containingBuilding p buildings with
  | none => none
  | some ring =>
    match nearestOnRing p ring with
    | none => none
    | some wall =>
      if wall.distM < 1e-6 then none
      else
        let cosLat := Float.cos (p.lat * pi / 180)
        let dxE := (wall.lon - p.lon) * 111320.0 * cosLat
        let dyN := (wall.lat - p.lat) * 111320.0
        let norm := orOne (Float.sqrt (dxE * dxE + dyN * dyN))
        let outside : Pt :=
          ⟨wall.lat + ((dyN / norm) * opts.wallMarginM) / 111320.0,
           wall.lon + ((dxE / norm) * opts.wallMarginM) / (111320.0 * cosLat)⟩
        match nearestWalkable outside walkable with
        | some near => if near.distM <= opts.streetSnapRadiusM then some ⟨near.lat, near.lon⟩ else none
        | none => none

/-- Apply the escape to a drawn line. Only `lat`/`lon` are rewritten; the TS is
    generic over the vertex type so every other field rides through — that
    record-preserving wrapper is shell, the decision is `escapedPosition`. -/
def escapeBuildings (drawn : Array TPt) (walkable : Ways) (buildings : Array Ring)
    (opts : EscapeOptions := {}) : Array TPt :=
  if buildings.isEmpty then drawn
  else drawn.map fun p =>
    match escapedPosition p.pt walkable buildings opts with
    | some m => { p with lat := m.lat, lon := m.lon }
    | none => p

/-! ## Badness — the implausible-walk metric -/

structure CorrectOptions extends EscapeOptions where
  densifyStepM : Float := 6
  maxDetourRatio : Float := 2.5
  routeSnapRadiusM : Float := 35
  minCrossingM : Float := 3
  maxLegInflation : Float := 0.5
  minRouteBudgetM : Float := 150
  offNetworkM : Float := 25
  buildingProxM : Float := 30
  onWayM : Float := 8
  /-- Pedometer length bar for the leg (m); `none` = no step data, invariant off. -/
  stepBudgetM : Option Float := none
  deriving Inhabited

structure Box where
  minLat : Float
  maxLat : Float
  minLon : Float
  maxLon : Float
  deriving Inhabited, Repr

/-- The ring-geometry slice: footprints plus their (possibly expanded) bboxes.
    Narrow on purpose so the corner router is reusable without a walkable
    network in scope. -/
structure RingCtx where
  buildings : Array Ring
  boxes : Array Box
  deriving Inhabited

structure BadnessCtx where
  ring : RingCtx
  walkable : Ways
  grid : WaySegmentGrid
  opts : CorrectOptions

/-- Per-ring bbox, expanded by `expandM` (`0` for the bare corner router). An
    EMPTY ring yields `±∞` bounds whose midpoint is NaN, so its box compares
    false everywhere and the exact ray cast decides — mirrored, not repaired. -/
def ringBoxes (buildings : Array Ring) (expandM : Float) : Array Box :=
  buildings.map fun ring => Id.run do
    let mut minLat := posInf
    let mut maxLat := negInf
    let mut minLon := posInf
    let mut maxLon := negInf
    for p in ring do
      if p.lat < minLat then minLat := p.lat
      if p.lat > maxLat then maxLat := p.lat
      if p.lon < minLon then minLon := p.lon
      if p.lon > maxLon then maxLon := p.lon
    if expandM == 0 then
      return { minLat, maxLat, minLon, maxLon }
    let dLat := expandM / 111320.0
    let dLon := expandM / (111320.0 * Float.cos (((minLat + maxLat) / 2) * pi / 180))
    return { minLat := minLat - dLat, maxLat := maxLat + dLat,
             minLon := minLon - dLon, maxLon := maxLon + dLon }

def makeBadnessCtx (walkable : Ways) (buildings : Array Ring) (opts : CorrectOptions) : BadnessCtx :=
  { ring := { buildings, boxes := ringBoxes buildings opts.buildingProxM }
    walkable
    grid := mkWaySegmentGrid walkable (max opts.onWayM opts.offNetworkM)
    opts }

/-- Is `p` inside a building? The bbox prefilter rejects almost every ring
    before the ray cast. -/
def insideBuildingCtx (p : Pt) (ctx : RingCtx) : Bool := Id.run do
  for i in [0:ctx.buildings.size] do
    let b := ctx.boxes[i]!
    if p.lat < b.minLat || p.lat > b.maxLat || p.lon < b.minLon || p.lon > b.maxLon then
      continue
    if pointInRing p ctx.buildings[i]! then return true
  return false

/-- Is a building within `buildingProxM` of `p` (or `p` inside one)? -/
def nearBuilding (p : Pt) (ctx : BadnessCtx) : Bool := Id.run do
  for i in [0:ctx.ring.buildings.size] do
    let b := ctx.ring.boxes[i]!
    if p.lat < b.minLat || p.lat > b.maxLat || p.lon < b.minLon || p.lon > b.maxLon then
      continue
    if pointInRing p ctx.ring.buildings[i]! then return true
    match nearestOnRing p ctx.ring.buildings[i]! with
    | some near => if near.distM <= ctx.opts.buildingProxM then return true
    | none => pure ()
  return false

/-- `Math.max(1, Math.ceil(x))` as both the float divisor and the loop count. -/
private def sampleSteps (x : Float) : Float × Nat :=
  let f := max 1 (Float.ceil x)
  (f, f.toUInt64.toNat)

/--
Badness length (m) of the segment `a→b` — the drawn distance implausible for a
walk, at 2 m midpoint sampling:

* INSIDE a footprint while more than `onWayM` off every way (a line riding a
  mapped through-building footway is a legitimate passage, never badness), or
* an URBAN BLOCK CUT: farther than `offNetworkM` from every way while a
  building sits within `buildingProxM`.

Open-ground samples (off-network, no buildings near) contribute nothing.
-/
def segBadnessM (a b : Pt) (ctx : BadnessCtx) : Float := Id.run do
  let segLen := metersBetween a b
  if segLen == 0 || ctx.ring.buildings.isEmpty then return 0
  let (stepsF, stepsN) := sampleSteps (segLen / 2)
  let mut bad := 0.0
  for k in [0:stepsN] do
    let f := (k.toFloat + 0.5) / stepsF
    let mid : Pt := ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f⟩
    if insideBuildingCtx mid ctx.ring then
      if !ctx.grid.within mid ctx.opts.onWayM then bad := bad + segLen / stepsF
    else if nearBuilding mid ctx then
      if !ctx.grid.within mid ctx.opts.offNetworkM then bad := bad + segLen / stepsF
  return bad

/-- Total badness (m) over a polyline. -/
def pathBadnessM (pts : Array Pt) (ctx : BadnessCtx) : Float := Id.run do
  let mut total := 0.0
  for i in [1:pts.size] do
    total := total + segBadnessM pts[i-1]! pts[i]! ctx
  return total

/-! ## Case 2.5: geometric corner detour

When the street network cannot route a crossing run around a block, the walk
still did not go through the wall. Humans skirt a building along its perimeter,
so the detour is derivable from the footprint itself: leave the chord at the
wall, follow the ring's corners (offset a step outside) to the far side, rejoin.
-/

/-- How far outside the wall a corner-detour vertex stands (m). -/
private def CORNER_CLEARANCE_M : Float := 2
/-- Recursion bound: beyond this many nested footprints the area is dense —
    decline (honest trust-GPS). -/
private def CORNER_MAX_DEPTH : Nat := 3

/-- Intersection parameters `t ∈ (0,1)` along `a→b` where it crosses the ring's
    boundary, ascending. -/
def segRingCrossingTs (a b : Pt) (ring : Ring) : Array Float := Id.run do
  let n := ring.size
  if n == 0 then return #[]
  let mut ts : Array Float := #[]
  let mut j := n - 1
  for i in [0:n] do
    let p := ring[j]!
    let q := ring[i]!
    let d1x := b.lon - a.lon
    let d1y := b.lat - a.lat
    let d2x := q.lon - p.lon
    let d2y := q.lat - p.lat
    let denom := d1x * d2y - d1y * d2x
    if Float.abs denom ≥ 1e-18 then
      let t := ((p.lon - a.lon) * d2y - (p.lat - a.lat) * d2x) / denom
      let u := ((p.lon - a.lon) * d1y - (p.lat - a.lat) * d1x) / denom
      if t > 1e-9 && t < 1 - 1e-9 && u ≥ 0 && u ≤ 1 then ts := ts.push t
    j := i
  return ts.qsort (· < ·)

/-- The ring's vertices from just past the edge crossed first to the edge
    crossed last, walking forward or backward, each pushed `CORNER_CLEARANCE_M`
    outward from the ring centroid. -/
def ringCornersBetween (a b : Pt) (ring : Ring) (forward : Bool) : Array Pt := Id.run do
  let n := ring.size
  if n == 0 then return #[]
  let mut entryEdge : Int := -1
  let mut exitEdge : Int := -1
  let mut tEntry := posInf
  let mut tExit := negInf
  for k in [0:n] do
    let p := ring[k]!
    let q := ring[(k + 1) % n]!
    let d1x := b.lon - a.lon
    let d1y := b.lat - a.lat
    let d2x := q.lon - p.lon
    let d2y := q.lat - p.lat
    let denom := d1x * d2y - d1y * d2x
    if Float.abs denom ≥ 1e-18 then
      let t := ((p.lon - a.lon) * d2y - (p.lat - a.lat) * d2x) / denom
      let u := ((p.lon - a.lon) * d1y - (p.lat - a.lat) * d1x) / denom
      if t > 1e-9 && t < 1 - 1e-9 && u ≥ 0 && u ≤ 1 then
        if t < tEntry then
          tEntry := t
          entryEdge := Int.ofNat k
        if t > tExit then
          tExit := t
          exitEdge := Int.ofNat k
  if entryEdge == -1 || exitEdge == -1 || entryEdge == exitEdge then return #[]
  let mut cLat := 0.0
  let mut cLon := 0.0
  for p in ring do
    cLat := cLat + p.lat / n.toFloat
    cLon := cLon + p.lon / n.toFloat
  let cosLat := Float.cos (cLat * pi / 180)
  let entry := entryEdge.toNat
  let exitE := exitEdge.toNat
  let mut corners : Array Pt := #[]
  let mut overrun := false
  if forward then
    let mut k := (entry + 1) % n
    let mut go := true
    while go do
      corners := corners.push ring[k]!
      if k == exitE then go := false
      else if corners.size > n then
        overrun := true
        go := false
      else k := (k + 1) % n
  else
    let mut k := entry
    let mut go := true
    while go do
      corners := corners.push ring[k]!
      if k == (exitE + 1) % n then go := false
      else if corners.size > n then
        overrun := true
        go := false
      else k := (k + n - 1) % n
  if overrun then return #[]
  return corners.map fun p =>
    let dy := (p.lat - cLat) * 111320.0
    let dx := (p.lon - cLon) * 111320.0 * cosLat
    let len := orOne (Float.sqrt (dx * dx + dy * dy))
    ⟨p.lat + ((dy / len) * CORNER_CLEARANCE_M) / 111320.0,
     p.lon + ((dx / len) * CORNER_CLEARANCE_M) / (111320.0 * cosLat)⟩

/-- Does the polyline enter any footprint? 2 m midpoint sampling. -/
def polylineEntersBuilding (pts : Array Pt) (ctx : RingCtx) : Bool := Id.run do
  for i in [1:pts.size] do
    let a := pts[i-1]!
    let b := pts[i]!
    let (stepsF, stepsN) := sampleSteps (metersBetween a b / 2)
    for k in [0:stepsN+1] do
      let f := k.toFloat / stepsF
      if insideBuildingCtx ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f⟩ ctx then
        return true
  return false

/-- First footprint the segment `a→b` passes THROUGH (two boundary crossings). -/
def firstCrossedRing (a b : Pt) (ctx : RingCtx) : Option Ring := Id.run do
  let mut best : Option Ring := none
  let mut bestT := posInf
  for i in [0:ctx.buildings.size] do
    let box := ctx.boxes[i]!
    if max a.lat b.lat < box.minLat || min a.lat b.lat > box.maxLat
       || max a.lon b.lon < box.minLon || min a.lon b.lon > box.maxLon then
      continue
    let ts := segRingCrossingTs a b ctx.buildings[i]!
    if ts.size ≥ 2 && ts[0]! < bestT then
      bestT := ts[0]!
      best := some ctx.buildings[i]!
  return best

private def polylineLenM (pts : Array Pt) : Float := Id.run do
  let mut len := 0.0
  for k in [1:pts.size] do
    len := len + metersBetween pts[k-1]! pts[k]!
  return len

/-- Cumulative along-path distances (`cum[0] = 0`) and the total. -/
private def cumLengths (pts : Array Pt) : Array Float × Float := Id.run do
  let mut total := 0.0
  let mut cum : Array Float := #[0.0]
  for k in [1:pts.size] do
    total := total + metersBetween pts[k-1]! pts[k]!
    cum := cum.push total
  return (cum, total)

/-- A replacement path's vertices, timestamps interpolated along it by cumulative
    distance between the two anchors' real times. The route's (street-snapped)
    start supersedes the copied anchor position; its timestamp is kept. -/
private def timedAlong (pts : Array Pt) (cum : Array Float) (total tsA tsB : Float) :
    Array TPt := Id.run do
  let mut out : Array TPt := #[]
  for k in [0:pts.size] do
    let f := if total > 0 then cum[k]! / total else 0
    out := out.push ⟨pts[k]!.lat, pts[k]!.lon, tsA + (tsB - tsA) * f⟩
  return out

/-- Repair a chord recursively: replace each pass-through with the shorter
    crossing-free corner path around that ring, then fix the sub-chords the
    corners created. `fuel` counts down from `CORNER_MAX_DEPTH`. `none` when no
    crossing-free bounded path exists — dense surroundings, decline. -/
def repairChord (fuel : Nat) (a b : Pt) (ctx : RingCtx) : Option (Array Pt) :=
  match firstCrossedRing a b ctx with
  | none => some #[a, b]
  | some ring =>
    match fuel with
    | 0 => none
    | fuel' + 1 =>
      let tryDir (forward : Bool) : Option (Array Pt) :=
        let corners := ringCornersBetween a b ring forward
        if corners.isEmpty then none
        else
          let stitched := (corners.push b).foldl
            (fun acc next =>
              match acc with
              | none => none
              | some (pts, prev) =>
                match repairChord fuel' prev next ctx with
                | none => none
                | some sub => some (pts ++ sub.extract 1 sub.size, next))
            (some (#[a], a))
          match stitched with
          | none => none
          | some (pts, _) => if polylineEntersBuilding pts ctx then none else some pts
      let consider (best : Option (Array Pt) × Float) (cand : Option (Array Pt)) :
          Option (Array Pt) × Float :=
        match cand with
        | none => best
        | some pts => let len := polylineLenM pts; if len < best.2 then (some pts, len) else best
      (consider (consider (none, posInf) (tryDir true)) (tryDir false)).1
termination_by fuel

/-- Route the chord `a→b` around any footprints it passes through, via the
    footprints' own corners. The narrow, reusable form of case 2.5 for callers
    that have footprints but no walkable network in scope. -/
def routeChordAroundBuildings (a b : Pt) (buildings : Array Ring) : Option (Array Pt) :=
  if buildings.isEmpty then some #[a, b]
  else repairChord CORNER_MAX_DEPTH a b { buildings, boxes := ringBoxes buildings 0 }

/-! ## The corrector -/

/-- Insert intermediate vertices so no chord exceeds `stepM`; timestamps are
    interpolated linearly. Original vertices are kept exactly. -/
def densify (drawn : Array TPt) (stepM : Float) : Array TPt := Id.run do
  let mut out : Array TPt := #[]
  for i in [0:drawn.size] do
    if i > 0 then
      let a := drawn[i-1]!
      let b := drawn[i]!
      let len := metersBetween a.pt b.pt
      let extraF := Float.floor (len / stepM)
      let extra := extraF.toUInt64.toNat
      for k in [1:extra+1] do
        let f := k.toFloat / (extraF + 1)
        out := out.push ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f,
                         a.ts + (b.ts - a.ts) * f⟩
    out := out.push drawn[i]!
  return out

inductive Outcome where
  /-- case 2 accepted: routed along the streets. -/
  | routed
  /-- case 2.5 accepted: geometric corner detour. -/
  | cornered
  /-- case 1 accepted: per-vertex escape. -/
  | escaped
  /-- all refused: the crossing stands. -/
  | trustGPS
  /-- the whole leg was discarded: corrections made it worse overall. -/
  | invariantRevert
  /-- the whole leg was discarded: it crossed the pedometer bar. -/
  | budgetRevert
  deriving BEq, Repr, Inhabited

/-- One crossing-run decision record. Diagnostic only — it lets the referee
    tally WHY a residual crossing survives (graph gap vs budget vs dense area vs
    the whole-line invariant), which forks the fix entirely. -/
structure RunDiag where
  outcome : Outcome
  straightM : Float
  runBadM : Float
  routeFound : Bool
  routeBadM : Option Float
  addedM : Option Float
  budgetM : Float
  /-- Nearest-way distance at each anchor: both within `routeSnapRadiusM` on a
      no-route survivor ⇒ the graph is FRAGMENTED (fixable); beyond it ⇒
      genuinely unmapped (accept, trust GPS). -/
  anchorASnapM : Option Float
  anchorBSnapM : Option Float
  deriving Repr, Inhabited

/--
The full case-based corrector: densify → route the gap along the streets →
failing that, around the footprint's corners → failing that, escape each
interior vertex → failing that, trust the GPS.

Honesty invariants, all enforced here: a reroute needs a route that is at most
`maxDetourRatio`× the straight line AND reduces the gap's crossing; the whole
corrected line must cross LESS building than the input; and a correction may not
take the leg from within its pedometer budget to beyond it.
-/
def correctWalkPath (drawn : Array TPt) (ways : Ways) (buildings : Array Ring)
    (opts : CorrectOptions := {}) : Array TPt × Array RunDiag := Id.run do
  if drawn.size < 2 || buildings.isEmpty then return (drawn, #[])
  let ctx := makeBadnessCtx ways buildings opts
  -- Fast path: nothing implausible → the common clean walk is returned
  -- untouched and un-densified after one sampling sweep.
  let originalBadM := pathBadnessM (drawn.map TPt.pt) ctx
  if originalBadM < opts.minCrossingM then return (drawn, #[])

  let pts := densify drawn opts.densifyStepM
  let mut segCross : Array Float := #[]
  for k in [1:pts.size] do
    segCross := segCross.push (segBadnessM pts[k-1]!.pt pts[k]!.pt ctx)

  let mut originalLenM := 0.0
  for k in [1:drawn.size] do
    originalLenM := originalLenM + metersBetween drawn[k-1]!.pt drawn[k]!.pt
  let mut budgetM := max (originalLenM * opts.maxLegInflation) opts.minRouteBudgetM

  let mut out : Array TPt := #[]
  let mut diags : Array RunDiag := #[]
  let mut i := 0
  while i < pts.size do
    -- Next crossing run at or after vertex i.
    let mut runStart : Int := -1
    for s in [i:segCross.size] do
      if segCross[s]! > 0 then
        runStart := Int.ofNat s
        break
    if runStart == -1 then
      for k in [i:pts.size] do out := out.push pts[k]!
      i := pts.size
    else
      let rs := runStart.toNat
      let mut runEnd := rs
      while runEnd + 1 < segCross.size && segCross[runEnd+1]! > 0 do
        runEnd := runEnd + 1

      -- Anchors: the nearest vertices OUTSIDE any building bracketing the run —
      -- routing from inside a footprint would start the path dishonestly.
      let mut a := rs
      while a > i && (containingBuilding pts[a]!.pt buildings).isSome do
        a := a - 1
      let mut b := runEnd + 1
      while b < pts.size - 1 && (containingBuilding pts[b]!.pt buildings).isSome do
        b := b + 1

      -- Copy the clean prefix up to (and including) the start anchor.
      for k in [i:a+1] do out := out.push pts[k]!
      i := a + 1

      let anchorA := pts[a]!
      let anchorB := pts[b]!
      let mut runBadM := 0.0
      for s in [a:b] do runBadM := runBadM + (segCross[s]?.getD 0)

      let mut replaced := false
      let mut dStraightM := metersBetween anchorA.pt anchorB.pt
      let mut dRouteFound := false
      let mut dRouteBadM : Option Float := none
      let mut dRouteAddedM : Option Float := none
      let dAnchorASnapM := (nearestWalkable anchorA.pt ways).map (·.distM)
      let dAnchorBSnapM := (nearestWalkable anchorB.pt ways).map (·.distM)

      -- CASE 2 FIRST — one run, one route. Holistic: this is what avoids the
      -- zigzag a per-vertex escape produces mid-block.
      if runBadM ≥ opts.minCrossingM then
        let straightM := metersBetween anchorA.pt anchorB.pt
        dStraightM := straightM
        -- The route bound is floored like the budget: going around a block is
        -- legitimately several times a NARROW gap's straight line.
        let route := routeOnWalkable anchorA.pt anchorB.pt ways
          { snapRadiusM := opts.routeSnapRadiusM,
            maxRouteM := max opts.minRouteBudgetM (straightM * opts.maxDetourRatio) }
        match route with
        | none => pure ()
        | some r =>
          if r.size ≥ 2 then
            let routeBadM := pathBadnessM r ctx
            let (cum, total) := cumLengths r
            let addedM := total - straightM
            dRouteFound := true
            dRouteBadM := some routeBadM
            dRouteAddedM := some addedM
            if routeBadM < runBadM && addedM ≤ budgetM then
              diags := diags.push
                { outcome := .routed, straightM, runBadM, routeFound := true,
                  routeBadM := some routeBadM, addedM := some addedM, budgetM,
                  anchorASnapM := dAnchorASnapM, anchorBSnapM := dAnchorBSnapM }
              budgetM := budgetM - max 0 addedM
              out := out.pop
              out := out ++ timedAlong r cum total anchorA.ts anchorB.ts
              replaced := true

      -- CASE 2.5 — corner detour around the footprint(s) themselves. Accepted
      -- only when it eliminates the run's crossings, obeys the same
      -- detour-ratio bound routes obey, and fits the budget.
      if !replaced && runBadM ≥ opts.minCrossingM then
        match repairChord CORNER_MAX_DEPTH anchorA.pt anchorB.pt ctx.ring with
        | none => pure ()
        | some detour =>
          if detour.size > 2 then
            let (cum, total) := cumLengths detour
            let addedM := total - dStraightM
            let lenOK := total ≤ max opts.minRouteBudgetM (dStraightM * opts.maxDetourRatio)
            let detourBadM := pathBadnessM detour ctx
            if lenOK && detourBadM < runBadM && addedM ≤ budgetM then
              diags := diags.push
                { outcome := .cornered, straightM := dStraightM, runBadM,
                  routeFound := dRouteFound, routeBadM := some detourBadM,
                  addedM := some addedM, budgetM,
                  anchorASnapM := dAnchorASnapM, anchorBSnapM := dAnchorBSnapM }
              budgetM := budgetM - max 0 addedM
              out := out.pop
              out := out ++ timedAlong detour cum total anchorA.ts anchorB.ts
              replaced := true

      -- CASE 1 FALLBACK — escape each interior vertex onto its near-side
      -- street, kept only if it reduces the crossing AND fits the same
      -- whole-leg budget the routes draw from. Else CASE 3: the gap stands.
      if !replaced then
        let gap := pts.extract a (b+1)
        let escaped := escapeBuildings gap ways buildings opts.toEscapeOptions
        let lenOf (xs : Array TPt) : Float := polylineLenM (xs.map TPt.pt)
        let addedM := lenOf escaped - lenOf gap
        let mut kept := gap
        if pathBadnessM (escaped.map TPt.pt) ctx < runBadM && addedM ≤ budgetM then
          budgetM := budgetM - max 0 addedM
          kept := escaped
          diags := diags.push
            { outcome := .escaped, straightM := dStraightM, runBadM,
              routeFound := dRouteFound, routeBadM := dRouteBadM, addedM := dRouteAddedM,
              budgetM, anchorASnapM := dAnchorASnapM, anchorBSnapM := dAnchorBSnapM }
        else
          diags := diags.push
            { outcome := .trustGPS, straightM := dStraightM, runBadM,
              routeFound := dRouteFound, routeBadM := dRouteBadM, addedM := dRouteAddedM,
              budgetM, anchorASnapM := dAnchorASnapM, anchorBSnapM := dAnchorBSnapM }
        for k in [1:b-a+1] do out := out.push kept[k]!

      -- Continue after the end anchor (already in `out`).
      i := b + 1

  -- Whole-line honesty invariant: never return a line more implausible than the
  -- input.
  if pathBadnessM (out.map TPt.pt) ctx > originalBadM then
    diags := diags.push
      { outcome := .invariantRevert, straightM := 0, runBadM := 0, routeFound := false,
        routeBadM := none, addedM := none, budgetM,
        anchorASnapM := none, anchorBSnapM := none }
    return (drawn, diags)

  -- Step-budget honesty invariant: the pedometer is the one length witness
  -- independent of GPS, and the per-run guards cannot see compounding. Only the
  -- under→over transition is the invented-distance signature — a leg already
  -- over the bar (GPS-long by nature) keeps its corrections.
  match opts.stepBudgetM with
  | none => pure ()
  | some stepBudgetM =>
    if originalLenM ≤ stepBudgetM then
      let outLenM := polylineLenM (out.map TPt.pt)
      if outLenM > stepBudgetM then
        diags := diags.push
          { outcome := .budgetRevert, straightM := 0, runBadM := 0, routeFound := false,
            routeBadM := none, addedM := some (outLenM - originalLenM), budgetM,
            anchorASnapM := none, anchorBSnapM := none }
        return (drawn, diags)
  return (out, diags)

/-! ## Passage snap -/

/-- Furthest a passage-snap may MOVE a point (m). Qualification uses `onWayM`
    (the badness exemption's band), but the measured true passage offsets are
    2–3 m; snapping from deeper pulls the line off the raw corridor. -/
private def PASSAGE_SNAP_REACH_M : Float := 4

/-- A nearest-way answer carrying the way identity and a monotone parameter
    along it — the coherence key. -/
structure SnapWay where
  lat : Float
  lon : Float
  distM : Float
  wayIdx : Nat
  t : Float
  deriving Inhabited, Repr

def snapWithWay (q : Pt) (ways : Ways) : Option SnapWay := Id.run do
  let mut best : Option SnapWay := none
  for w in [0:ways.size] do
    let coords := ways[w]!
    for i in [1:coords.size] do
      let a := coords[i-1]!
      let b := coords[i]!
      let proj := projectPointToSegment q a b
      let better := match best with
        | none => true
        | some bb => proj.distM < bb.distM
      if better then
        let segLen := orOne (metersBetween a b)
        let f := metersBetween a ⟨proj.lat, proj.lon⟩ / segLen
        best := some ⟨proj.lat, proj.lon, proj.distM, w, (i-1).toFloat + min 1 f⟩
  return best

/--
The drawing half of the mapped-passage exemption. The badness metric exempts a
line riding an OSM way through a building, but the exemption tolerates `onWayM`
of lateral error — which draws the walker over the buildings BESIDE the passage.
If a stretch is excused as riding the passage, it must be DRAWN riding it.

Strictly scoped: a segment qualifies only when it is SUBSTANTIALLY inside
(≥ `minCrossingM` of in-building sampled length with a way in reach), and the
snaps must be COHERENT — same way, monotone along it — which is what traversing
a passage looks like. Incoherent snaps would zigzag, so the stretch is left
alone instead.
-/
def snapPassages (pts : Array TPt) (walkable : Ways) (buildings : Array Ring)
    (opts : CorrectOptions := {}) : Array TPt := Id.run do
  if walkable.isEmpty || buildings.isEmpty || pts.size < 2 then return pts
  let ctx := makeBadnessCtx walkable buildings opts
  let mut out : Array TPt := #[]
  for i in [0:pts.size] do
    if i > 0 then
      let a := pts[i-1]!
      let b := pts[i]!
      let segLen := metersBetween a.pt b.pt
      let (stepsF, stepsN) := sampleSteps (segLen / 2)
      -- A line that merely nicks a footprint corner beside the pavement must
      -- not be yanked onto the way.
      let mut insideM := 0.0
      for k in [0:stepsN+1] do
        let f := k.toFloat / stepsF
        let mid : Pt := ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f⟩
        if insideBuildingCtx mid ctx.ring && ctx.grid.within mid ctx.opts.onWayM then
          insideM := insideM + segLen / (stepsF + 1)
      if insideM ≥ ctx.opts.minCrossingM then
        let (nF, nN) := sampleSteps (segLen / 3)
        let mut snapped : Array TPt := #[]
        let mut coherent := true
        let mut wayIdx : Int := -1
        let mut dir := 0.0
        let mut prevT : Option Float := none
        let mut k := 1
        while k < nN && coherent do
          let f := k.toFloat / nF
          let q : TPt := ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f,
                          a.ts + (b.ts - a.ts) * f⟩
          if insideBuildingCtx q.pt ctx.ring then
            match snapWithWay q.pt ctx.walkable with
            | none => coherent := false
            | some near =>
              if near.distM > PASSAGE_SNAP_REACH_M then coherent := false
              else
                if wayIdx == -1 then wayIdx := Int.ofNat near.wayIdx
                else if Int.ofNat near.wayIdx != wayIdx then coherent := false
                if coherent then
                  match prevT with
                  | some pv =>
                    if near.t != pv then
                      let step := jsSign (near.t - pv)
                      if dir == 0 then dir := step
                      else if step != dir then coherent := false
                  | none => pure ()
                if coherent then
                  prevT := some near.t
                  snapped := snapped.push { q with lat := near.lat, lon := near.lon }
          k := k + 1
        if coherent then
          for q in snapped do out := out.push q
    let p := pts[i]!
    if insideBuildingCtx p.pt ctx.ring then
      match snapWithWay p.pt ctx.walkable with
      | some near =>
        if near.distM ≤ PASSAGE_SNAP_REACH_M then
          out := out.push { p with lat := near.lat, lon := near.lon }
        else out := out.push p
      | none => out := out.push p
    else out := out.push p
  return out

/-- Nudge each vertex fully onto its nearest walkable way when that way is
    within `nudgeReachM`, and otherwise leave it EXACTLY where the GPS put it.
    Deliberately never a partial move: half-way would strand the point in
    no-man's-land, neither the GPS truth nor the pavement. -/
def nudgeTowardWays (drawn : Array TPt) (walkable : Ways) (nudgeReachM : Float) : Array TPt :=
  if walkable.isEmpty then drawn
  else drawn.map fun p =>
    match nearestWalkable p.pt walkable with
    | some near =>
      if near.distM ≤ nudgeReachM then { p with lat := near.lat, lon := near.lon } else p
    | none => p

/-! ## Parity with Node/V8 (`lean/experiments/walk-escape-refs.mts`)

Reference geometry: a 100 m × 100 m block ring of streets at a London origin,
with footprints placed against it. Everything below is the V8 output verbatim.
The corrector's private helpers are pinned THROUGH these exported callers —
`nudgeTowardWays` reads `nearestWalkable` out directly, and the diag records
expose `segBadnessM` / `pathBadnessM` / the way grid as exact numbers.
-/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def approxO : Option Float → Option Float → Bool
  | none, none => true
  | some x, some y => approx x y
  | _, _ => false

private def ptsApprox (a : Array Pt) (b : List Pt) : Bool :=
  a.size == b.length && (a.toList.zip b).all fun (x, y) => approx x.lat y.lat && approx x.lon y.lon

private def tptsApprox (a : Array TPt) (b : List TPt) : Bool :=
  a.size == b.length
    && (a.toList.zip b).all fun (x, y) =>
      approx x.lat y.lat && approx x.lon y.lon && approx x.ts y.ts

private def LAT0 : Float := 51.52
private def LON0 : Float := -0.13
private def MLAT : Float := 1.0 / 111320.0
private def MLON : Float := 1.0 / (111320.0 * Float.cos (LAT0 * pi / 180))
/-- `(north metres, east metres)` from the origin. -/
private def P (n e : Float) : Pt := ⟨LAT0 + n * MLAT, LON0 + e * MLON⟩
private def TP (p : Pt) (ts : Float) : TPt := ⟨p.lat, p.lon, ts⟩
private def T (n e ts : Float) : TPt := TP (P n e) ts

private def STREETS : Ways :=
  #[#[P 0 0, P 0 100], #[P 100 0, P 100 100], #[P 0 0, P 100 0], #[P 0 100, P 100 100]]
/-- A house near the south street: north 10..30, east 30..70. -/
private def HOUSE : Ring := #[P 10 30, P 10 70, P 30 70, P 30 30]
/-- A bigger block-filling footprint: north 40..80, east 20..80. -/
private def BLOCKHOUSE : Ring := #[P 40 20, P 40 80, P 80 80, P 80 20]
/-- A footprint whose south wall sits ON the south street. -/
private def LOWHOUSE : Ring := #[P 0 30, P 0 70, P 30 70, P 30 30]

private def n0 : Pt := P 0 0
private def n1 : Pt := P 0 100
private def n2 : Pt := P 100 0
private def n3 : Pt := P 100 100
private def dSouth : Float := metersBetween n0 n1
private def dNorth : Float := metersBetween n2 n3
private def dSide : Float := metersBetween n0 n2

/-! ### `nudgeTowardWays` — i.e. `nearestWalkable`, read out directly -/

#guard tptsApprox (nudgeTowardWays #[T 0 50 0] STREETS 8) [T 0 50 0]
#guard tptsApprox (nudgeTowardWays #[T 3 50 0] STREETS 8) [T 0 50 0]
-- At the reach exactly: `<=`, so it still moves.
#guard tptsApprox (nudgeTowardWays #[T 8 50 0] STREETS 8) [T 0 50 0]
#guard tptsApprox (nudgeTowardWays #[T 9 50 0] STREETS 8) [T 9 50 0]
-- Near the SW corner the WEST street wins (way order breaks the near-tie).
#guard tptsApprox (nudgeTowardWays #[T 2 2 0] STREETS 8) [T 2 0 0]
#guard tptsApprox (nudgeTowardWays #[T 50 50 0] STREETS 8) [T 50 50 0]
#guard tptsApprox (nudgeTowardWays #[T 50 50 0] #[] 8) [T 50 50 0]

/-! ### `pointInRing` -/

#guard pointInRing (P 20 50) HOUSE
#guard !pointInRing (P 50 50) HOUSE
-- A point ON the south wall reads INSIDE: the cast toggles on the east edge
-- (whose span is half-open at the bottom) and not on the coincident south one.
#guard pointInRing (P 10 50) HOUSE
#guard !pointInRing (P 20 50) #[P 10 30, P 10 70]

/-! ### `escapeBuildings` (case 1 + case 3) -/

-- Nearest wall is the south wall 5 m away; 2 m past it is 8 m from the south
-- street, inside the 20 m snap → the vertex lands on the street.
#guard tptsApprox (escapeBuildings #[T 15 50 0] STREETS #[HOUSE]) [T 0 50 0]
-- Nearest wall is the NORTH wall; 2 m past it the nearest street is 68 m away
-- → case 3, the vertex stands.
#guard tptsApprox (escapeBuildings #[T 25 50 0] STREETS #[HOUSE]) [T 25 50 0]
#guard tptsApprox (escapeBuildings #[T 50 50 0] STREETS #[HOUSE]) [T 50 50 0]
-- ON the wall: inside the ring, but the nearest wall is 0 m away, so the
-- outward direction is undefined — the degenerate guard leaves the vertex.
#guard tptsApprox (escapeBuildings #[T 10 50 0] STREETS #[HOUSE]) [T 10 50 0]
#guard tptsApprox (escapeBuildings #[T 15 50 0] STREETS #[]) [T 15 50 0]
#guard tptsApprox (escapeBuildings #[T 15 50 0] STREETS #[#[P 10 30, P 10 70]]) [T 15 50 0]

/-! ### `routeChordAroundBuildings` (case 2.5) -/

#guard match routeChordAroundBuildings (P 0 50) (P 100 50) #[] with
  | some r => ptsApprox r [P 0 50, P 100 50]
  | none => false
#guard match routeChordAroundBuildings (P 0 10) (P 100 10) #[HOUSE] with
  | some r => ptsApprox r [P 0 10, P 100 10]
  | none => false
-- Through the house: out at the east wall, round the two east corners, back.
#guard match routeChordAroundBuildings (P 0 50) (P 100 50) #[HOUSE] with
  | some r => ptsApprox r
      [P 0 50,
       ⟨51.520081796352734, -0.12896360586988509⟩,
       ⟨51.520277528117269, -0.12896360586988589⟩,
       P 100 50]
  | none => false
#guard match routeChordAroundBuildings (P 20 0) (P 20 100) #[HOUSE] with
  | some r => ptsApprox r
      [P 20 0,
       ⟨51.520277528117269, -0.12959272427699667⟩,
       ⟨51.520277528117269, -0.12896360586988589⟩,
       P 20 100]
  | none => false
-- Two footprints: the recursion fixes the sub-chord the first detour created.
#guard match routeChordAroundBuildings (P 0 50) (P 100 50) #[HOUSE, BLOCKHOUSE] with
  | some r => ptsApprox r
      [P 0 50,
       ⟨51.520081796352734, -0.12896360586988509⟩,
       ⟨51.520277528117269, -0.12896360586988589⟩,
       ⟨51.520349358520647, -0.12882103980214221⟩,
       ⟨51.520728614889350, -0.12882103980214221⟩,
       P 100 50]
  | none => false
-- An endpoint INSIDE a footprint is not a pass-through (needs two boundary
-- crossings), so the chord stands.
#guard match routeChordAroundBuildings (P 15 50) (P 100 50) #[HOUSE] with
  | some r => ptsApprox r [P 15 50, P 100 50]
  | none => false

/-! ### `correctWalkPath` -/

private def diagIs (d : RunDiag) (o : Outcome) (straight runBad : Float) (rf : Bool)
    (routeBad added : Option Float) (budget : Float) (sa sb : Option Float) : Bool :=
  d.outcome == o && approx d.straightM straight && approx d.runBadM runBad
    && d.routeFound == rf && approxO d.routeBadM routeBad && approxO d.addedM added
    && approx d.budgetM budget && approxO d.anchorASnapM sa && approxO d.anchorBSnapM sb

/-- The corner-detour line the block-crossing walk is redrawn as (V8 verbatim). -/
private def CORNERED : List TPt :=
  [⟨51.520000000000003, -0.12927816507344128, 1000.0000000000000⟩,
   ⟨51.520052841833824, -0.12927816507344128, 1005.8823529411765⟩,
   ⟨51.520081796352734, -0.12896360586988509, 1021.2995844222652⟩,
   ⟨51.520277528117269, -0.12896360586988589, 1036.5508681193558⟩,
   ⟨51.520581260172058, -0.12927816507344128, 1064.7058823529412⟩,
   ⟨51.520634102005879, -0.12927816507344128, 1070.5882352941176⟩,
   ⟨51.520686943839706, -0.12927816507344128, 1076.4705882352941⟩,
   ⟨51.520739785673527, -0.12927816507344128, 1082.3529411764705⟩,
   ⟨51.520792627507348, -0.12927816507344128, 1088.2352941176471⟩,
   ⟨51.520845469341175, -0.12927816507344128, 1094.1176470588234⟩,
   ⟨51.520898311174996, -0.12927816507344128, 1100.0000000000000⟩]

private def CROSSING : Array TPt := #[T 0 50 1000, T 100 50 1100]

-- A clean walk along the street: one sampling sweep, returned untouched and
-- UN-densified.
#guard (correctWalkPath #[T 0 10 1000, T 0 50 1030, T 0 90 1060] STREETS #[HOUSE]).1.size == 3
#guard (correctWalkPath #[T 0 10 1000, T 0 50 1030, T 0 90 1060] STREETS #[HOUSE]).2.isEmpty

-- Case 2 is tried FIRST and fails here (the far anchor is 35.29 m out, past the
-- 35 m snap radius), so case 2.5's corner detour carries the fix.
#guard tptsApprox (correctWalkPath CROSSING STREETS #[HOUSE]).1 CORNERED
#guard match (correctWalkPath CROSSING STREETS #[HOUSE]).2.toList with
  | [d] => diagIs d .cornered 58.823529412248945 50.980392157176951 false
             (some 40.420019872366069) (some 25.215143932469758) 150.0
             (some 5.8823529409085040) (some 35.294117647032976)
  | _ => false

-- No network at all: nothing to route to, nothing to escape onto. The kept
-- (densified) line then samples marginally WORSE than the input, so the
-- whole-line invariant hands the raw GPS back.
#guard tptsApprox (correctWalkPath CROSSING #[] #[HOUSE]).1 CROSSING.toList
#guard match (correctWalkPath CROSSING #[] #[HOUSE]).2.toList with
  | [d1, d2] =>
    diagIs d1 .trustGPS 64.705882353157449 60.784313725885113 false none none 150.0 none none
      && diagIs d2 .invariantRevert 0 0 false none none 150.0 none none
  | _ => false

-- One street only: the graph cannot get around the block, so again the corner
-- detour — and the far anchor's snap distance records the fragmentation.
#guard tptsApprox (correctWalkPath CROSSING #[#[P 0 0, P 0 100]] #[HOUSE]).1 CORNERED
#guard match (correctWalkPath CROSSING #[#[P 0 0, P 0 100]] #[HOUSE]).2.toList with
  | [d] => diagIs d .cornered 58.823529412248945 50.980392157176951 false
             (some 40.420019872366069) (some 25.215143932469758) 150.0
             (some 5.8823529409085040) (some 64.705882353157449)
  | _ => false

-- Widen the anchor snap and the route bound: now case 2 wins outright and the
-- walk is redrawn along the streets, round the west side of the block.
#guard tptsApprox
    (correctWalkPath CROSSING STREETS #[HOUSE] { routeSnapRadiusM := 60, minRouteBudgetM := 400 }).1
    [⟨51.520000000000003, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.520000000000003, -0.12927816507344128, 1005.8823529411765⟩,
     ⟨51.520000000000003, -0.13000000000000000, 1020.5883078121527⟩,
     ⟨51.520898311174996, -0.13000000000000000, 1050.0002175541611⟩,
     ⟨51.520898311174996, -0.12927816507344128, 1064.7058823529412⟩,
     ⟨51.520634102005879, -0.12927816507344128, 1070.5882352941176⟩,
     ⟨51.520686943839706, -0.12927816507344128, 1076.4705882352941⟩,
     ⟨51.520739785673527, -0.12927816507344128, 1082.3529411764705⟩,
     ⟨51.520792627507348, -0.12927816507344128, 1088.2352941176471⟩,
     ⟨51.520845469341175, -0.12927816507344128, 1094.1176470588234⟩,
     ⟨51.520898311174996, -0.12927816507344128, 1100.0000000000000⟩]
#guard match (correctWalkPath CROSSING STREETS #[HOUSE]
                { routeSnapRadiusM := 60, minRouteBudgetM := 400 }).2.toList with
  | [d] => diagIs d .routed 58.823529412248945 50.980392157176951 true
             (some 0) (some 141.17548434733800) 400.0
             (some 5.8823529409085040) (some 35.294117647032976)
  | _ => false

-- A sub-1 detour ratio refuses every route and every corner detour by
-- construction, so the per-vertex escape is the only lever left: the clipped
-- vertices drop onto the south street the footprint sits against.
private def ESCAPE_OPTS : CorrectOptions :=
  { maxDetourRatio := 0.9, minRouteBudgetM := 0, routeSnapRadiusM := 5 }

#guard tptsApprox (correctWalkPath #[T 12 10 1000, T 12 90 1080] STREETS #[LOWHOUSE] ESCAPE_OPTS).1
    [⟨51.520107797341005, -0.12985563301468825, 1000.0000000000000⟩,
     ⟨51.520107797341005, -0.12977313759451012, 1005.7142857142857⟩,
     ⟨51.520107797341005, -0.12969064217433196, 1011.4285714285714⟩,
     ⟨51.520107797341005, -0.12960814675415383, 1017.1428571428571⟩,
     ⟨51.520000000000003, -0.12959577250946958, 1022.8571428571429⟩,
     ⟨51.520000000000003, -0.12959577250946958, 1028.5714285714287⟩,
     ⟨51.520000000000003, -0.12936066049361941, 1034.2857142857142⟩,
     ⟨51.520000000000003, -0.12927816507344128, 1040.0000000000000⟩,
     ⟨51.520000000000003, -0.12919566965326315, 1045.7142857142858⟩,
     ⟨51.520000000000003, -0.12896055763741299, 1051.4285714285713⟩,
     ⟨51.520000000000003, -0.12896055763741299, 1057.1428571428571⟩,
     ⟨51.520107797341005, -0.12894818339272873, 1062.8571428571429⟩,
     ⟨51.520107797341005, -0.12886568797255060, 1068.5714285714287⟩,
     ⟨51.520107797341005, -0.12878319255237244, 1074.2857142857142⟩,
     ⟨51.520107797341005, -0.12870069713219431, 1080.0000000000000⟩]
#guard match (correctWalkPath #[T 12 10 1000, T 12 90 1080] STREETS #[LOWHOUSE] ESCAPE_OPTS).2.toList with
  | [d] => diagIs d .escaped 45.714177510194318 39.999905321420506 false none none
             17.652927586245148 (some 12.000000000339242) (some 12.000000000339242)
  | _ => false

-- Urban block cut: mid-block, past `offNetworkM` from every street with the
-- house wall inside `buildingProxM`. Bad, but no footprint is crossed, so the
-- corner router has nothing to work with and no vertex has anything to escape
-- from — case 3, the densified GPS stands.
#guard (correctWalkPath #[T 35 40 1000, T 35 70 1030] STREETS #[HOUSE]).1.size == 6
#guard match (correctWalkPath #[T 35 40 1000, T 35 70 1030] STREETS #[HOUSE]).2.toList with
  | [d] => diagIs d .trustGPS 29.999792890312513 29.999792890312513 false none none 150.0
             (some 34.999999999671161) (some 29.999792890312513)
  | _ => false
-- Same geometry, no buildings: open ground is never badness (case 3).
#guard (correctWalkPath #[T 35 40 1000, T 35 70 1030] STREETS #[]).1.size == 2
#guard (correctWalkPath #[T 35 40 1000, T 35 70 1030] STREETS #[]).2.isEmpty

-- Step-budget invariant: the corner detour is accepted per-run, then the whole
-- leg is discarded because it crossed the pedometer bar.
#guard tptsApprox (correctWalkPath CROSSING STREETS #[HOUSE] { stepBudgetM := some 105 }).1 CROSSING.toList
#guard match (correctWalkPath CROSSING STREETS #[HOUSE] { stepBudgetM := some 105 }).2.toList with
  | [d1, d2] =>
    diagIs d1 .cornered 58.823529412248945 50.980392157176951 false
      (some 40.420019872366069) (some 25.215143932469758) 150.0
      (some 5.8823529409085040) (some 35.294117647032976)
    && diagIs d2 .budgetRevert 0 0 false none (some 25.215143932469758) 124.78485606753024 none none
  | _ => false

-- A zero reroute budget refuses everything.
#guard tptsApprox
    (correctWalkPath CROSSING STREETS #[HOUSE] { minRouteBudgetM := 0, maxLegInflation := 0 }).1
    CROSSING.toList
#guard match (correctWalkPath CROSSING STREETS #[HOUSE]
                { minRouteBudgetM := 0, maxLegInflation := 0 }).2.toList with
  | [d1, d2] =>
    diagIs d1 .trustGPS 58.823529412248945 50.980392157176951 false none none 0
      (some 5.8823529409085040) (some 35.294117647032976)
    && diagIs d2 .invariantRevert 0 0 false none none 0 none none
  | _ => false

/-! ### `snapPassages` -/

/-- The block streets plus a mapped passage THROUGH the house, with a bend the
    drawn chord cuts. -/
private def PASSAGE_WAYS : Ways := STREETS.push #[P 0 50, P 15 52, P 25 48, P 100 50]
private def PASSAGE_DRAWN : Array TPt := #[T 0 50 1000, T 20 50 1020, T 100 50 1100]

#guard tptsApprox (snapPassages PASSAGE_DRAWN PASSAGE_WAYS #[HOUSE])
    [⟨51.520000000000003, -0.12927816507344128, 1000.0000000000000⟩,
     ⟨51.520100870879510, -0.12925655055175364, 1011.4285714285714⟩,
     ⟨51.520126088599390, -0.12925114692133136, 1014.2857142857143⟩,
     ⟨51.520157536319914, -0.12926394170965741, 1017.1428571428571⟩,
     ⟨51.520179662235002, -0.12927816507344325, 1020.0000000000000⟩,
     ⟨51.520202607628427, -0.12929291522848069, 1022.9629629629629⟩,
     ⟨51.520233368326409, -0.12930666174501107, 1025.9259259259259⟩,
     ⟨51.520259966040349, -0.12930552187814850, 1028.8888888888889⟩,
     ⟨51.520898311174996, -0.12927816507344128, 1100.0000000000000⟩]
#guard (snapPassages PASSAGE_DRAWN PASSAGE_WAYS #[]).size == 3
#guard (snapPassages PASSAGE_DRAWN #[] #[HOUSE]).size == 3
-- Without a way through the footprint nothing is in reach, so the in-building
-- vertex keeps its place: the exemption's drawing half is strictly scoped.
#guard tptsApprox (snapPassages PASSAGE_DRAWN STREETS #[HOUSE]) PASSAGE_DRAWN.toList

end Verified.Geo.WalkEscape
