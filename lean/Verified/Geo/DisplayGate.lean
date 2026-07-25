import Verified.Geo.WalkableRoute
import Verified.Geo.CellKey
import Std.Data.HashMap
import Std.Data.HashSet

/-!
# Display-acceptance gate (port of the off-network cluster in `src/geo/map-match-core.ts`)

The decision *whether to draw the matched line at all*, and where to fall back
to the raw fixes:

1. `SegmentNearGrid` — exact nearest-chord queries via a rasterised grid and an
   expanding-ring search. `Verified.Geo.RingSearch` already carries the
   exactness argument as a theorem; this is the grid the theorem is about.
2. the off-network metrics (`fractionOffRoad`, `nearestRoadDist`,
   `maxPolylineOffRoad`, `pointDistToPolyline`,
   `quantilePointDistToPolyline`) — measured on the *drawn line*, sampling
   along each chord, not only at the vertices;
3. `matchImprovesDisplay` — the three-part gate: the raw line must genuinely
   stray off-network, the match must follow the network better, and the match
   must stay faithful to where the GPS was;
4. `spliceMatchedWithDivergentRuns` — the salvage for a match rejected on a
   LOCAL divergence: keep the matched line where the fixes support it, splice
   the raw fixes back in over each contiguous run that leaves it.

All of it is pure geometry, so all of it ports. Two notes:

* The TS grid dedupes chords within one query through a generation-stamped
  `Uint32Array`. That is a perf device with no effect on the answer — `best`
  is a running `min` and re-probing a chord yields the same distance — but the
  set is reproduced here anyway, so the port needs no such argument.
* `segmentDistM` is the TS's allocation-free copy of
  `projectPointToSegment(…).distM`; its comment claims identical arithmetic.
  It is written out here in the same shape rather than routed through
  `projectPointToSegment`, so the claim stays checkable side by side.
-/

namespace Verified.Geo.DisplayGate

open Verified.Geo (cellKeyN)
open Verified.Geo.WalkableRoute (Pt Proj metersBetween projectPointToSegment)

private def pi : Float := 3.14159265358979323846
private def posInf : Float := 1.0 / 0.0

/-- `Math.floor` into an `Int`, the JS grid-cell index. -/
private def floorInt (x : Float) : Int := (Float.floor x).toInt64.toInt

/-- A way network as coordinate lists, in way-iteration order —
    `RoadGeometry.ways.map(w => w.coords)`. Way order is the tie-break for the
    brute-force scans and fixes the chord order the grid rasterises. -/
abbrev Ways := Array (Array Pt)

/-- A timestamped vertex: both `RoadFix` and `MatchedPoint`, which are the same
    shape and are used interchangeably across this cluster. -/
structure MPt where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

/-- The positional part, where a caller wants a plain `Pt`. -/
def MPt.pt (m : MPt) : Pt := ⟨m.lat, m.lon⟩

/-- `projectPointToSegment`'s distance only. Identical arithmetic to
    `Verified.Geo.WalkableRoute.projectPointToSegment`, kept separate because
    the TS keeps it separate. -/
def segmentDistM (p a b : Pt) : Float :=
  let cosLat := Float.cos (((a.lat + b.lat) / 2) * pi / 180)
  let bx := (b.lon - a.lon) * 111320.0 * cosLat
  let by' := (b.lat - a.lat) * 111320.0
  let px := (p.lon - a.lon) * 111320.0 * cosLat
  let py := (p.lat - a.lat) * 111320.0
  let len2 := bx * bx + by' * by'
  let t0 := if len2 == 0 then 0 else (px * bx + py * by') / len2
  let t := max 0 (min 1 t0)
  metersBetween p ⟨a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)⟩

/-! ## The nearest-segment grid -/

/-- One polyline chord. -/
structure Chord where
  a : Pt
  b : Pt
  deriving Inhabited, Repr

/-- Grid cell (m) for way-distance queries — off-network excursions of interest
    are a few tens of metres, so most queries resolve within a ring or two. -/
def wayDistGridCellM : Float := 64

/-- Rasterised chord index. `buckets` maps a cell to the chords whose sampled
    points fall in it; `minCy`/`maxCy`/`minCx`/`maxCx` bound the occupied box,
    which bounds the ring search. -/
structure NearGrid where
  chords : Array Chord
  buckets : Std.HashMap Nat (Array Nat)
  cellM : Float
  cellLat : Float
  cellLon : Float
  minCy : Int
  maxCy : Int
  minCx : Int
  maxCx : Int

/-- Rasterise `chords` at `cellM`, converting metres to degrees at `refLat`. -/
def NearGrid.ofChords (chords : Array Chord) (cellM refLat : Float) : NearGrid := Id.run do
  let cellLat := cellM / 111320.0
  let cellLon := cellM / (111320.0 * Float.cos (refLat * pi / 180))
  let mut buckets : Std.HashMap Nat (Array Nat) := {}
  let mut first := true
  let mut minCy : Int := 0
  let mut maxCy : Int := 0
  let mut minCx : Int := 0
  let mut maxCx : Int := 0
  for i in [0:chords.size] do
    let c := chords[i]!
    let stepsF := max 1 (Float.ceil ((metersBetween c.a c.b) * 2 / cellM))
    let steps := stepsF.toInt64.toInt.toNat
    let mut lastKey : Option Nat := none
    for k in [0:steps + 1] do
      let f := Float.ofNat k / stepsF
      let cy := floorInt ((c.a.lat + f * (c.b.lat - c.a.lat)) / cellLat)
      let cx := floorInt ((c.a.lon + f * (c.b.lon - c.a.lon)) / cellLon)
      if first || cy < minCy then minCy := cy
      if first || cy > maxCy then maxCy := cy
      if first || cx < minCx then minCx := cx
      if first || cx > maxCx then maxCx := cx
      first := false
      let key := cellKeyN cy cx
      if lastKey == some key then continue
      lastKey := some key
      match buckets[key]? with
      | some b2 => if b2[b2.size - 1]! != i then buckets := buckets.insert key (b2.push i)
      | none => buckets := buckets.insert key #[i]
  return { chords, buckets, cellM, cellLat, cellLon, minCy, maxCy, minCx, maxCx }

/-- From a set of ways — each consecutive coordinate pair becomes a chord.
    `none` when the ways carry no chord at all. -/
def NearGrid.ofWays (ways : Ways) (cellM : Float) : Option NearGrid := Id.run do
  let mut chords : Array Chord := #[]
  for w in ways do
    for i in [1:w.size] do
      chords := chords.push ⟨w[i - 1]!, w[i]!⟩
  if chords.isEmpty then return none
  return some (NearGrid.ofChords chords cellM chords[0]!.a.lat)

/-- From an ordered track polyline — consecutive point pairs become chords. -/
def NearGrid.ofTrack (pts : Array Pt) (cellM : Float) : Option NearGrid := Id.run do
  if pts.size < 2 then return none
  let mut chords : Array Chord := #[]
  for i in [1:pts.size] do
    chords := chords.push ⟨pts[i - 1]!, pts[i]!⟩
  return some (NearGrid.ofChords chords cellM pts[0]!.lat)

/-- Probe one cell: the min over its not-yet-seen chords, and the updated seen
    set. -/
private def NearGrid.probe (g : NearGrid) (key : Nat) (p : Pt) (best : Float)
    (seen : Std.HashSet Nat) : Float × Std.HashSet Nat := Id.run do
  match g.buckets[key]? with
  | none => return (best, seen)
  | some bucket =>
    let mut best := best
    let mut seen := seen
    for i in bucket do
      if seen.contains i then continue
      seen := seen.insert i
      let d := segmentDistM p g.chords[i]!.a g.chords[i]!.b
      if d < best then best := d
    return (best, seen)

/-- Exact `min(distance to nearest chord, clampM)`. Rings are scanned outward
    until no unscanned chord can beat the best projection found. -/
def NearGrid.nearestDist (g : NearGrid) (lat lon : Float) (clampM : Float := posInf) : Float :=
  Id.run do
    let cy := floorInt (lat / g.cellLat)
    let cx := floorInt (lon / g.cellLon)
    -- Rings past the occupied bounding box (plus one) cannot contain a bucket.
    let maxK :=
      (max (cy - g.minCy) (max (g.maxCy - cy) (max (cx - g.minCx) (max (g.maxCx - cx) 0)))) + 1
    let p : Pt := ⟨lat, lon⟩
    let mut best := posInf
    let mut seen : Std.HashSet Nat := {}
    for kn in [0:maxK.toNat + 1] do
      let k : Int := Int.ofNat kn
      if (Float.ofInt k - 1.5) * g.cellM ≥ min best clampM then break
      -- Cells at Chebyshev distance exactly k.
      let yLo := cy - k
      let yHi := cy + k
      for xi in [0:2 * kn + 1] do
        let x := cx - k + Int.ofNat xi
        let (b1, s1) := g.probe (cellKeyN yLo x) p best seen
        best := b1; seen := s1
        if kn > 0 then
          let (b2, s2) := g.probe (cellKeyN yHi x) p best seen
          best := b2; seen := s2
      for yi in [0:2 * kn - 1] do
        let y := yLo + 1 + Int.ofNat yi
        let (b1, s1) := g.probe (cellKeyN y (cx - k)) p best seen
        best := b1; seen := s1
        let (b2, s2) := g.probe (cellKeyN y (cx + k)) p best seen
        best := b2; seen := s2
    return min best clampM

/-! ## Off-network metrics -/

/-- Fraction of `fixes` whose nearest way is further than `thresholdM`. A low
    value means the raw GPS already hugs the network. -/
def fractionOffRoad (fixes : Array MPt) (ways : Ways) (thresholdM : Float) : Float := Id.run do
  if fixes.isEmpty then return 0
  let mut off : Nat := 0
  for fx in fixes do
    let mut best := posInf
    for w in ways do
      for i in [1:w.size] do
        let d := (projectPointToSegment fx.pt w[i - 1]! w[i]!).distM
        if d < best then best := d
        if best ≤ thresholdM then break
      if best ≤ thresholdM then break
    if best > thresholdM then off := off + 1
  return Float.ofNat off / Float.ofNat fixes.size

/-- Nearest distance from a point to any way. With an `index` the query is
    near-constant time; without one it is a full scan of every chord. -/
def nearestRoadDist (p : Pt) (ways : Ways) (index : Option NearGrid := none) : Float := Id.run do
  match index with
  | some g => return g.nearestDist p.lat p.lon
  | none =>
    let mut best := posInf
    for w in ways do
      for i in [1:w.size] do
        let d := (projectPointToSegment p w[i - 1]! w[i]!).distM
        if d < best then best := d
    return best

/-- Maximum off-network distance of a *drawn polyline* — sampling not just the
    vertices but points every `stepM` along each chord. The signal
    `fractionOffRoad` misses: sparse fixes each on a way, joined by a chord that
    cuts across a block. The map draws the chords, so the chords are measured. -/
def maxPolylineOffRoad (path : Array Pt) (ways : Ways) (stepM : Float := 15)
    (index : Option NearGrid := none) : Float := Id.run do
  if path.isEmpty || ways.isEmpty then return 0
  let idx := match index with
    | some g => some g
    | none => NearGrid.ofWays ways wayDistGridCellM
  let mut worst : Float := 0
  for i in [0:path.size] do
    let d := nearestRoadDist path[i]! ways idx
    if d > worst then worst := d
    if i + 1 < path.size then
      let a := path[i]!
      let b := path[i + 1]!
      let chord := metersBetween a b
      let n := Float.floor (chord / stepM)
      let nN := n.toInt64.toInt.toNat
      for k in [1:nN] do
        let fk := Float.ofNat k
        let q : Pt := ⟨a.lat + (b.lat - a.lat) * fk / n, a.lon + (b.lon - a.lon) * fk / n⟩
        let d := nearestRoadDist q ways idx
        if d > worst then worst := d
  return worst

/-- Distance from a single point to the nearest segment of `path`. -/
def pointDistToPolyline (p : Pt) (path : Array Pt) : Float := Id.run do
  if path.isEmpty then return posInf
  if path.size == 1 then return metersBetween p path[0]!
  let mut best := posInf
  for i in [1:path.size] do
    best := min best (projectPointToSegment p path[i - 1]! path[i]!).distM
  return best

/-- Quantile of fix-to-path distances used for the faithfulness check — high
    enough to catch a systematic parallel-way snap (most fixes off), below 1 so
    one or two outlier fixes don't veto an otherwise-good match. -/
def strayQuantile : Float := 0.85

/-- How far a candidate matched path strays from where the GPS actually was, as
    the `q`-quantile of the fixes' distances to the path — NOT the max. -/
def quantilePointDistToPolyline (pts : Array Pt) (path : Array Pt) (q : Float) : Float :=
  Id.run do
    if pts.isEmpty || path.isEmpty then return 0
    let dists := (pts.map (pointDistToPolyline · path)).qsort (· < ·)
    let idxF := Float.floor (Float.ofNat dists.size * q)
    let idx := min (dists.size - 1) idxF.toInt64.toInt.toNat
    return dists[idx]!

/-! ## The gate -/

/-- The gate's verdict, with the metrics that drove it (so callers can log why a
    leg was / wasn't snapped). -/
structure DisplayMatchDecision where
  use : Bool
  rawOffRoadM : Float
  matchedOffRoadM : Float
  strayM : Float
  deriving Inhabited, Repr

/-- Whether to draw the matched path instead of the raw fixes, judged on the
    *drawn line* rather than the fix vertices. Use the match when all three
    hold: the raw drawn line genuinely strays off-network (worst chord
    excursion exceeds `needsMatchM`); the matched line follows the network
    better than the raw line did; and the match stays faithful to where the GPS
    was (its `strayQuantile` of fix-to-path distances is within `maxStrayM`,
    the parallel-way guard). -/
def matchImprovesDisplay (fixes matchedPath : Array Pt) (ways : Ways)
    (needsMatchM maxStrayM : Float) : DisplayMatchDecision :=
  let index := if ways.size > 0 then NearGrid.ofWays ways wayDistGridCellM else none
  let rawOffRoadM := maxPolylineOffRoad fixes ways 15 index
  let matchedOffRoadM := maxPolylineOffRoad matchedPath ways 15 index
  let strayM := quantilePointDistToPolyline fixes matchedPath strayQuantile
  { use := rawOffRoadM > needsMatchM && matchedOffRoadM < rawOffRoadM && strayM ≤ maxStrayM
    rawOffRoadM, matchedOffRoadM, strayM }

/-! ## The divergent-run splice -/

/-- Below this many fixes a supported/divergent split is noise, not signal. -/
def minSpliceFixes : Nat := 4
/-- A splice must keep the matched line for at least this fraction of fixes;
    below it the divergence is systematic (a parallel-way snap) and the whole
    match is untrustworthy. -/
def spliceMinSupportedFraction : Float := 0.5
/-- A divergent fix farther than this from the matched path is a teleport /
    reacquire smear, not walking through an unmapped forecourt. -/
def spliceMaxDivergenceM : Float := 150
/-- More contiguous divergent runs than this is jitter straddling the stray
    bound, not one coherent unmapped area. -/
def spliceMaxDivergentRuns : Nat := 2
/-- The spliced line may not be longer than the raw fix line by more than this
    factor (plus the slack below). -/
def spliceMaxLenFactor : Float := 1.15
def spliceMaxLenSlackM : Float := 30

/-- Nearest distance to a polyline plus the arc-length position of that nearest
    point (`cum` = precomputed cumulative vertex arcs). -/
private def projectToPolylineArc (p : Pt) (path : Array MPt) (cum : Array Float) :
    Float × Float := Id.run do
  let mut distM := posInf
  let mut arcM : Float := 0
  for i in [1:path.size] do
    let proj := projectPointToSegment p path[i - 1]!.pt path[i]!.pt
    if proj.distM < distM then
      distM := proj.distM
      arcM := cum[i - 1]! + (cum[i]! - cum[i - 1]!) * proj.t
  return (distM, arcM)

/-- The vertex at arc position `s`, interpolated within its segment (position
    and `ts` both). The final `path.back` is unreachable for a path of two or
    more vertices — the loop's last iteration always returns — and is kept only
    because the TS keeps it. -/
private def sliceAt (path : Array MPt) (cum : Array Float) (s : Float) : MPt := Id.run do
  for i in [1:path.size] do
    if s ≤ cum[i]! || i == path.size - 1 then
      let span := cum[i]! - cum[i - 1]!
      let t := if span > 0 then min 1 (max 0 ((s - cum[i - 1]!) / span)) else 0
      let a := path[i - 1]!
      let b := path[i]!
      return ⟨a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, a.ts + (b.ts - a.ts) * t⟩
  return path[path.size - 1]!

/-- The sub-polyline between arc positions `s0 ≤ s1`, endpoints interpolated. -/
private def slicePathByArc (path : Array MPt) (cum : Array Float) (s0 s1 : Float) :
    Array MPt := Id.run do
  let mut out : Array MPt := #[sliceAt path cum s0]
  for i in [0:path.size] do
    if cum[i]! > s0 && cum[i]! < s1 then out := out.push path[i]!
  if s1 > s0 then out := out.push (sliceAt path cum s1)
  return out

/--
Salvage a match the stray gate rejected for a LOCAL divergence: keep the matched
line over the spans the fixes support, splice the raw fixes back in over each
contiguous run that genuinely leaves the matched path (an unmapped station
forecourt / courtyard the network has no way through).

Refuses (`none`) when the divergence is systematic rather than local — fewer
than `spliceMinSupportedFraction` of fixes support the match, the leg is too
short to judge, there is nothing to splice, or a supported run projects
non-monotonically onto the path.
-/
def spliceMatchedWithDivergentRuns (fixes matchedPath : Array MPt) (maxStrayM : Float) :
    Option (Array MPt) := Id.run do
  if fixes.size < minSpliceFixes || matchedPath.size < 2 then return none
  let mut cum : Array Float := #[0]
  for i in [1:matchedPath.size] do
    cum := cum.push (cum[i - 1]! + metersBetween matchedPath[i - 1]!.pt matchedPath[i]!.pt)
  let proj := fixes.map (fun fx => projectToPolylineArc fx.pt matchedPath cum)
  let divergent : Array Bool := proj.map (fun pr => (pr.1 > maxStrayM : Bool))
  let nDivergent := divergent.foldl (fun acc d => if d then acc + 1 else acc) 0
  if nDivergent == 0 then return none
  if Float.ofNat (fixes.size - nDivergent) / Float.ofNat fixes.size < spliceMinSupportedFraction then
    return none
  -- Forecourt signature only: the divergence must be NEAR the network (not a
  -- teleport smear) and coherent (few contiguous runs, not jitter).
  for k in [0:fixes.size] do
    if divergent[k]! && proj[k]!.1 > spliceMaxDivergenceM then return none
  let mut nRuns : Nat := 0
  for k in [0:fixes.size] do
    if divergent[k]! && (k == 0 || !divergent[k - 1]!) then nRuns := nRuns + 1
  if nRuns > spliceMaxDivergentRuns then return none

  let mut out : Array MPt := #[]
  let mut i : Nat := 0
  while i < fixes.size do
    let mut j := i
    while j + 1 < fixes.size && divergent[j + 1]! == divergent[i]! do
      j := j + 1
    if divergent[i]! then
      -- Divergent run: the honest line is the raw fixes themselves.
      for k in [i:j + 1] do
        out := out.push ⟨fixes[k]!.lat, fixes[k]!.lon, fixes[k]!.ts⟩
    else
      let s0 := proj[i]!.2
      let s1 := proj[j]!.2
      -- A supported run that walks BACKWARD along the path is not a clean local
      -- divergence — bail rather than draw a scrambled line.
      if s1 < s0 then return none
      out := out ++ slicePathByArc matchedPath cum s0 s1
    i := j + 1
  -- Collapse consecutive near-duplicate vertices from slice endpoints.
  let mut deduped : Array MPt := #[]
  for p in out do
    let skip :=
      if deduped.size > 0 then
        let last := deduped[deduped.size - 1]!
        Float.abs (last.lat - p.lat) < 1e-9 && Float.abs (last.lon - p.lon) < 1e-9
      else false
    if !skip then deduped := deduped.push p
  if deduped.size < 2 then return none
  -- Length-honesty guard: refuse when the splice draws meaningfully more line
  -- than the raw fixes support (an over-route inside a fix-free span).
  let mut rawLenM : Float := 0
  for k in [1:fixes.size] do
    rawLenM := rawLenM + metersBetween fixes[k - 1]!.pt fixes[k]!.pt
  let mut splicedLenM : Float := 0
  for k in [1:deduped.size] do
    splicedLenM := splicedLenM + metersBetween deduped[k - 1]!.pt deduped[k]!.pt
  if splicedLenM > rawLenM * spliceMaxLenFactor + spliceMaxLenSlackM then return none
  return some deduped

/-! ## Guards

Reference values from `lean/experiments/display-gate-refs.mts`, run under the
same V8 the backend runs on. Comparison is to within 1e-9 because the metric
uses `Math.hypot` where Lean uses `sqrt` of the sum of squares. -/

section Guards

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def approxM (m : MPt) (lat lon ts : Float) : Bool :=
  approx m.lat lat && approx m.lon lon && approx m.ts ts

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320.0
private def mlon : Float := 1 / (111320.0 * Float.cos (lat0 * pi / 180))
/-- (north metres, east metres) → a point in the local frame. -/
private def P (n e : Float) : Pt := ⟨lat0 + n * mlat, lon0 + e * mlon⟩
private def T (n e ts : Float) : MPt := ⟨lat0 + n * mlat, lon0 + e * mlon, ts⟩

-- A city block: four streets bounding n ∈ [0,100], e ∈ [0,200].
private def geoWays : Ways :=
  #[#[P 0 (-50), P 0 250], #[P 100 (-50), P 100 250], #[P 0 0, P 100 0], #[P 0 200, P 100 200]]
private def noWays : Ways := #[]

-- metersBetween / projectPointToSegment
#guard approx (metersBetween (P 0 0) (P 100 200)) 223.60503351647537
#guard approx (metersBetween (P 0 0) (P 0 0)) 0
#guard approx (projectPointToSegment (P 10 50) (P 0 0) (P 0 100)).t 0.5
#guard approx (projectPointToSegment (P 10 50) (P 0 0) (P 0 100)).distM 10.000000000019043
#guard approx (projectPointToSegment (P 10 50) (P 0 0) (P 0 100)).lat 51.520000000000003
#guard approx (projectPointToSegment (P 10 50) (P 0 0) (P 0 100)).lon (-0.12927816507344128)
#guard approx (projectPointToSegment (P 10 (-30)) (P 0 0) (P 0 100)).t 0
#guard approx (projectPointToSegment (P 10 (-30)) (P 0 0) (P 0 100)).distM 31.622748532958102
#guard approx (projectPointToSegment (P 10 300) (P 0 0) (P 0 100)).t 1
#guard approx (projectPointToSegment (P 10 300) (P 0 0) (P 0 100)).distM 200.24964694415362
#guard approx (projectPointToSegment (P 10 50) (P 0 50) (P 0 50)).t 0
#guard approx (projectPointToSegment (P 10 50) (P 0 50) (P 0 50)).distM 10.000000000019043
-- `segmentDistM` is the TS's allocation-free copy — same arithmetic, same float.
#guard segmentDistM (P 10 50) (P 0 0) (P 0 100)
  == (projectPointToSegment (P 10 50) (P 0 0) (P 0 100)).distM

-- SegmentNearGrid
private def grid : NearGrid := (NearGrid.ofWays geoWays 64).getD (NearGrid.ofChords #[] 64 0)
private def gq (n e : Float) : Float := grid.nearestDist (P n e).lat (P n e).lon
private def gqc (n e clamp : Float) : Float := grid.nearestDist (P n e).lat (P n e).lon clamp
private def bf (n e : Float) : Float := nearestRoadDist (P n e) geoWays

#guard approx (gq 1 100) 0.99999999976461140
#guard approx (gqc 1 100 20) 0.99999999976461140
#guard approx (bf 1 100) 0.99999999976461140
#guard approx (gq 50 100) 50.000000000095213
#guard approx (gqc 50 100 20) 20
#guard approx (bf 50 100) 50.000000000095213
#guard approx (gq 50 5) 4.9999506881228823
#guard approx (gqc 50 5 20) 4.9999506881228823
#guard approx (bf 50 5) 4.9999506881228823
#guard approx (gq (-300) 100) 299.99999999978030
#guard approx (gqc (-300) 100 20) 20
#guard approx (bf (-300) 100) 299.99999999978030
#guard approx (gq 0 0) 0
#guard approx (gqc 0 0 20) 0
#guard approx (bf 0 0) 0
#guard approx (gq 99.5 250) 0.50000000027779379
#guard approx (gqc 99.5 250 20) 0.50000000027779379
#guard approx (bf 99.5 250) 0.50000000027779379
#guard (NearGrid.ofWays #[] 64).isNone
#guard (NearGrid.ofWays #[#[P 0 0]] 64).isNone
#guard approx
  (((NearGrid.ofTrack #[P 0 0, P 0 100, P 50 100] 64).getD (NearGrid.ofChords #[] 64 0)).nearestDist
    (P 10 50).lat (P 10 50).lon) 10.000000000019043
#guard (NearGrid.ofTrack #[P 0 0] 64).isNone

-- fractionOffRoad
private def onStreet : Array MPt := #[T 1 0 0, T 1 40 10, T 1 80 20, T 1 120 30]
private def inBlock : Array MPt := #[T 50 40 0, T 50 80 10, T 50 120 20]
private def mixedFixes : Array MPt := #[T 1 0 0, T 1 40 10] ++ inBlock

#guard approx (fractionOffRoad onStreet geoWays 10) 0
#guard approx (fractionOffRoad inBlock geoWays 10) 1
#guard approx (fractionOffRoad mixedFixes geoWays 10) 0.59999999999999998
#guard approx (fractionOffRoad inBlock geoWays 60) 0
#guard approx (fractionOffRoad #[] geoWays 10) 0
#guard approx (fractionOffRoad onStreet noWays 10) 1

-- maxPolylineOffRoad
private def hugging : Array Pt := #[P 1 0, P 1 60, P 1 120]
private def blockCut : Array Pt := #[P 0 0, P 100 200]

#guard approx (maxPolylineOffRoad hugging geoWays) 0.99999999976461140
#guard approx (maxPolylineOffRoad blockCut geoWays) 50.000000000095213
#guard approx (maxPolylineOffRoad blockCut geoWays 40) 40.000000000076170
#guard approx (maxPolylineOffRoad #[P 0 0, P 0 200] geoWays) 0
#guard approx (maxPolylineOffRoad #[] geoWays) 0
#guard approx (maxPolylineOffRoad hugging noWays) 0
#guard approx (maxPolylineOffRoad #[P 50 100] geoWays) 50.000000000095213
#guard approx (maxPolylineOffRoad #[P 50 100, P 50 105] geoWays) 50.000000000095213

-- pointDistToPolyline / quantile
private def bentPath : Array Pt := #[P 0 0, P 0 100, P 50 100]
private def quantPts : Array Pt := #[P 1 10, P 2 20, P 3 30, P 40 40, P 5 50]

#guard approx (pointDistToPolyline (P 10 50) bentPath) 10.000000000019043
#guard approx (pointDistToPolyline (P 80 100) bentPath) 30.000000000057128
#guard (pointDistToPolyline (P 0 0) #[]).isInf
#guard approx (pointDistToPolyline (P 10 0) #[P 0 0]) 10.000000000019043
#guard approx (quantilePointDistToPolyline quantPts bentPath 0) 0.99999999976461140
#guard approx (quantilePointDistToPolyline quantPts bentPath 0.5) 3.0000000000848104
#guard approx (quantilePointDistToPolyline quantPts bentPath 0.85) 40.000000000076170
#guard approx (quantilePointDistToPolyline quantPts bentPath 1) 40.000000000076170
#guard approx (quantilePointDistToPolyline #[] bentPath 0.85) 0
#guard approx (quantilePointDistToPolyline quantPts #[] 0.85) 0

-- matchImprovesDisplay
private def cutting : Array Pt := #[P 0 0, P 50 100, P 100 200]
private def routed : Array Pt := #[P 0 0, P 0 200, P 100 200]
private def parallelWay : Array Pt := #[P 100 (-50), P 100 250]

private def dHugs := matchImprovesDisplay hugging #[P 0 0, P 0 120] geoWays 10 25
#guard dHugs.use == false
#guard approx dHugs.rawOffRoadM 0.99999999976461140
#guard approx dHugs.matchedOffRoadM 0
#guard approx dHugs.strayM 0.99999999976461140

private def dRoutes := matchImprovesDisplay cutting routed geoWays 10 200
#guard dRoutes.use == true
#guard approx dRoutes.rawOffRoadM 50.000000000095213
#guard approx dRoutes.matchedOffRoadM 0
#guard approx dRoutes.strayM 50.000000000095213

private def dStray := matchImprovesDisplay cutting routed geoWays 10 25
#guard dStray.use == false
#guard approx dStray.strayM 50.000000000095213

private def dParallel := matchImprovesDisplay cutting parallelWay geoWays 10 25
#guard dParallel.use == false
#guard approx dParallel.rawOffRoadM 50.000000000095213
#guard approx dParallel.matchedOffRoadM 0
#guard approx dParallel.strayM 100.00000000019043

private def dSame := matchImprovesDisplay cutting cutting geoWays 10 500
#guard dSame.use == false
#guard approx dSame.rawOffRoadM 50.000000000095213
#guard approx dSame.matchedOffRoadM 50.000000000095213
#guard approx dSame.strayM 0

private def dNoWays := matchImprovesDisplay cutting routed noWays 10 25
#guard dNoWays.use == false
#guard approx dNoWays.rawOffRoadM 0
#guard approx dNoWays.matchedOffRoadM 0
#guard approx dNoWays.strayM 50.000000000095213

private def dNoFixes := matchImprovesDisplay #[] routed geoWays 10 25
#guard dNoFixes.use == false
#guard approx dNoFixes.rawOffRoadM 0
#guard approx dNoFixes.strayM 0

-- spliceMatchedWithDivergentRuns
private def matchedLine : Array MPt := #[T 0 0 0, T 0 100 100, T 0 200 200]
private def densePath : Array MPt := #[T 0 0 0, T 0 50 50, T 0 100 100, T 0 150 150, T 0 200 200]
private def forecourt : Array MPt :=
  #[T 1 0 0, T 1 20 10, T 1 40 20, T 1 60 30, T 1 80 40, T 1 100 50,
    T 20 110 60, T 20 120 70, T 20 130 80, T 20 140 90,
    T 1 160 100, T 1 180 110, T 1 200 120]

private def spForecourt : Array MPt :=
  (spliceMatchedWithDivergentRuns forecourt matchedLine 10).getD #[]
#guard spForecourt.size == 8
#guard approxM spForecourt[0]! 51.520000000000003 (-0.13000000000000000) 0
#guard approxM spForecourt[1]! 51.520000000000003 (-0.12855633014688256) 100
#guard approxM spForecourt[2]! 51.520179662235002 (-0.12841196316157080) 60
#guard approxM spForecourt[3]! 51.520179662235002 (-0.12826759617625907) 70
#guard approxM spForecourt[4]! 51.520179662235002 (-0.12812322919094732) 80
#guard approxM spForecourt[5]! 51.520179662235002 (-0.12797886220563559) 90
#guard approxM spForecourt[6]! 51.520000000000003 (-0.12769012823501211) 159.99999999999883
#guard approxM spForecourt[7]! 51.520000000000003 (-0.12711266029376511) 200

/-- The same fixes against a denser matched line, so a supported run spans
    matched vertices strictly between its endpoints (the slice's interior push). -/
private def spDense : Array MPt := (spliceMatchedWithDivergentRuns forecourt densePath 10).getD #[]
#guard spDense.size == 9
#guard approxM spDense[0]! 51.520000000000003 (-0.13000000000000000) 0
#guard approxM spDense[1]! 51.520000000000003 (-0.12927816507344128) 50
#guard approxM spDense[2]! 51.520000000000003 (-0.12855633014688256) 100
#guard approxM spDense[3]! 51.520179662235002 (-0.12841196316157080) 60
#guard approxM spDense[8]! 51.520000000000003 (-0.12711266029376511) 200

-- Every refusal arm.
#guard (spliceMatchedWithDivergentRuns forecourt matchedLine 40).isNone
#guard (spliceMatchedWithDivergentRuns (forecourt.take 3) matchedLine 10).isNone
#guard (spliceMatchedWithDivergentRuns forecourt #[T 0 0 0] 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 30 0 0, T 30 40 10, T 30 80 20, T 30 120 30, T 30 160 40, T 30 200 50] matchedLine 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 1 0 0, T 1 20 10, T 1 40 20, T 1 60 30, T 400 80 40, T 1 120 50, T 1 160 60, T 1 200 70]
  matchedLine 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 1 0 0, T 20 20 10, T 1 40 20, T 20 60 30, T 1 80 40, T 20 100 50, T 1 120 60, T 1 140 70]
  matchedLine 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 20 10 0, T 20 20 10, T 1 150 20, T 1 100 30, T 1 50 40] matchedLine 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 0 0 0, T 0 40 10, T 20 60 20, T 20 70 30]
  #[T 0 0 0, T 100 0 100, T 100 40 140, T 0 40 240] 10).isNone
#guard (spliceMatchedWithDivergentRuns
  #[T 1 0 0, T 1 50 10, T 1 100 20, T 1 150 30, T 1 200 40] matchedLine 10).isNone

end Guards

end Verified.Geo.DisplayGate
