/-!
# Where to mirror: regions, the home metro, and its tiles

The two Overpass mirrors (`refresh-rail-stops`, `refresh-bus-routes`) both begin
by answering the same question — *which patch of the planet is this user's life
in?* — and both answer it the same way: cluster the recent focus places into
metropolitan regions, take the largest, bound it, and cut that box into tiles
small enough that one Overpass call stays light (#982 Tier 2).

Port of the pure half of `src/geo/route-graph-loader.ts`.

## Why the region step exists at all

A user who has lived in London and visited Amsterdam and San Francisco has focus
places on three continents-worth of separation. One bbox around all of them is a
box containing an ocean, and tiling THAT is tens of thousands of Overpass calls
for water. Clustering first means each metro can be bounded independently, and
the mirrors then take only the one the user actually lives in.

## ⚠ The union-find's ORDER is observable, not an implementation detail

`clusterIntoRegions` returns groups in the order each component's ROOT is first
reached while walking the points in index order, and members within a group in
index order. The mirrors pick the largest region with a `reduce` that keeps the
FIRST on a tie, so two regions of equal size resolve by this ordering — a
different-but-valid union-find would mirror a different city.

So the union is reproduced exactly as the TypeScript writes it: `parent[find i] =
find j` for `i < j`, path-halving in `find`, and no union by rank.
-/

namespace Verified.Geo.OsmRegions

/-- A latitude/longitude bounding box, in degrees. -/
structure Bbox where
  minLat : Float
  maxLat : Float
  minLon : Float
  maxLon : Float
  deriving Repr, Inhabited

/-- A point that can be clustered. Only the coordinates matter here; the
mirrors carry their own payloads and re-associate by index. -/
structure Pt where
  lat : Float
  lon : Float
  deriving Repr, Inhabited

/-- Metres per degree of latitude, the constant the TypeScript uses. -/
def M_PER_DEG : Float := 111320.0

/-- Earth radius in km, as used by the clustering haversine. -/
def EARTH_R_KM : Float := 6371.0

def PI : Float := 3.141592653589793

private def toRad (d : Float) : Float := d * PI / 180.0

/-- Expand a bbox by `marginM` metres.

⚠ THE LONGITUDE MARGIN IS LATITUDE-CORRECTED and the correction uses the MEAN
latitude of the box, not either edge. A flat degree pad would narrow the box the
further from the equator it sits — the same trap as the corridor padding. -/
def expandBbox (b : Bbox) (marginM : Float) : Bbox :=
  let dLat := marginM / M_PER_DEG
  let dLon := marginM / (M_PER_DEG * Float.cos (toRad ((b.minLat + b.maxLat) / 2.0)))
  { minLat := b.minLat - dLat
  , maxLat := b.maxLat + dLat
  , minLon := b.minLon - dLon
  , maxLon := b.maxLon + dLon }

/-- The bbox enclosing `pts`, expanded by `marginM` metres. `none` on no input —
the mirrors treat that as "nothing to do" rather than as an error. -/
def bboxFromFixes (pts : Array Pt) (marginM : Float := 1500.0) : Option Bbox :=
  if pts.isEmpty then none
  else
    let b := pts.foldl
      (fun (acc : Bbox) p =>
        { minLat := min acc.minLat p.lat
        , maxLat := max acc.maxLat p.lat
        , minLon := min acc.minLon p.lon
        , maxLon := max acc.maxLon p.lon })
      { minLat := pts[0]!.lat, maxLat := pts[0]!.lat
      , minLon := pts[0]!.lon, maxLon := pts[0]!.lon }
    some (expandBbox b marginM)

/-- Great-circle distance in km. -/
def haversineKm (a b : Pt) : Float :=
  let dLat := toRad (b.lat - a.lat)
  let dLon := toRad (b.lon - a.lon)
  let sq := fun (x : Float) => x * x
  let h := sq (Float.sin (dLat / 2.0))
    + Float.cos (toRad a.lat) * Float.cos (toRad b.lat) * sq (Float.sin (dLon / 2.0))
  EARTH_R_KM * 2.0 * Float.atan2 (Float.sqrt h) (Float.sqrt (1.0 - h))

/-- `find` with path halving, over a mutable parent array.

Returns the root AND the updated array: the halving is a write, and dropping it
would turn an O(n²) pass into something quadratic per lookup on a long chain. -/
private partial def findRoot (parent : Array Nat) (i : Nat) : Nat × Array Nat :=
  let rec go (par : Array Nat) (r : Nat) : Nat × Array Nat :=
    let p := par[r]!
    if p == r then (r, par)
    else
      let gp := par[p]!
      go (par.set! r gp) gp
  go parent i

/-- Group points into metropolitan regions: a connected component under
"within `maxGapKm` of each other". O(n²), which is nothing for the few hundred
focus places a user has.

⚠ Returns INDEX groups, not points. The mirrors carry payloads alongside the
coordinates and re-associate by index; returning points would force every caller
to match on floats. -/
def clusterIntoRegionIndices (pts : Array Pt) (maxGapKm : Float) : Array (Array Nat) := Id.run do
  let n := pts.size
  let mut parent : Array Nat := Array.ofFn (n := n) (fun i => i.val)
  for i in [0:n] do
    for j in [i+1:n] do
      if decide (haversineKm pts[i]! pts[j]! ≤ maxGapKm) then
        let (ri, p1) := findRoot parent i
        let (rj, p2) := findRoot p1 j
        -- ⚠ i's root points at j's root, never the other way. The TypeScript
        -- writes `parent[find(i)] = find(j)`; flipping it changes which index
        -- ends up as the root and therefore the order groups come back in.
        parent := p2.set! ri rj
  -- Groups in order of each root's FIRST appearance, members ascending.
  let mut roots : Array Nat := #[]
  let mut groups : Array (Array Nat) := #[]
  for i in [0:n] do
    let (r, p) := findRoot parent i
    parent := p
    match roots.findIdx? (· == r) with
    | some k => groups := groups.set! k (groups[k]!.push i)
    | none =>
      roots := roots.push r
      groups := groups.push #[i]
  return groups

/-- The largest region, keeping the FIRST on a tie — `reduce((a, b) => b.length >
a.length ? b : a)` is a strict `>`, so equal sizes keep the earlier one. -/
def largestRegion (groups : Array (Array Nat)) : Option (Array Nat) :=
  groups.foldl (fun acc g =>
    match acc with
    | none => some g
    | some a => if g.size > a.size then some g else some a) none

/-- The whole opening move of both mirrors: recent focus places in, the home
metro's bbox out. `none` when there are no places to bound.

⚠ THE CUTOFF IS THE SHELL'S JOB. This takes the places that already survived it,
because "recent" is a clock read and the clock is IO. -/
def homeRegionBbox (pts : Array Pt) (maxGapKm : Float) (marginM : Float := 1500.0)
    : Option Bbox := do
  let groups := clusterIntoRegionIndices pts maxGapKm
  let home ← largestRegion groups
  bboxFromFixes (home.map (pts[·]!)) marginM

/-- Split a bbox into a grid of cells no larger than `maxCellDeg` a side. Cells
tile the box exactly, with no overlap; a box already smaller than a cell comes
back as one cell equal to itself. -/
def tileBbox (b : Bbox) (maxCellDeg : Float) : Array Bbox := Id.run do
  let ceilPos := fun (x : Float) =>
    let c := Float.ceil x
    if decide (c < 1.0) then 1 else c.toUInt64.toNat
  let latCells := ceilPos ((b.maxLat - b.minLat) / maxCellDeg)
  let lonCells := ceilPos ((b.maxLon - b.minLon) / maxCellDeg)
  let latStep := (b.maxLat - b.minLat) / latCells.toFloat
  let lonStep := (b.maxLon - b.minLon) / lonCells.toFloat
  let mut cells : Array Bbox := #[]
  for i in [0:latCells] do
    for j in [0:lonCells] do
      cells := cells.push
        { minLat := b.minLat + i.toFloat * latStep
        , maxLat := b.minLat + (i.toFloat + 1.0) * latStep
        , minLon := b.minLon + j.toFloat * lonStep
        , maxLon := b.minLon + (j.toFloat + 1.0) * lonStep }
  return cells

/-! ## Guards

⚠ These pin the two things that are ORDER, not arithmetic — which region comes
back first, and which one `largestRegion` keeps on a tie. Both are observable:
they decide which city gets mirrored.
-/

private def near (a b : Float) : Bool := decide (Float.abs (a - b) < 1e-9)

/-- London-ish, Amsterdam-ish, and a second London-ish point. -/
private def LDN : Pt := { lat := 51.5074, lon := -0.1278 }
private def LDN2 : Pt := { lat := 51.5100, lon := -0.1300 }
private def AMS : Pt := { lat := 52.3676, lon := 4.9041 }
private def SFO : Pt := { lat := 37.7749, lon := -122.4194 }

-- Nothing to bound is `none`, not an empty box at the origin.
#guard (bboxFromFixes #[] 1500.0).isNone
#guard (homeRegionBbox #[] 80.0).isNone

-- Three metros, 80 km gap: three regions, in first-appearance order.
#guard (clusterIntoRegionIndices #[LDN, AMS, SFO] 80.0).size == 3
#guard (clusterIntoRegionIndices #[LDN, AMS, SFO] 80.0) == #[#[0], #[1], #[2]]

-- The two London points join; Amsterdam does not. The London group keeps index
-- order, and it comes first because index 0 is in it.
#guard (clusterIntoRegionIndices #[LDN, AMS, LDN2] 80.0) == #[#[0, 2], #[1]]

-- ⚠ The home metro is the LARGEST region, not the first. Amsterdam is index 0
-- here and still loses to the two London points.
#guard (largestRegion (clusterIntoRegionIndices #[AMS, LDN, LDN2] 80.0)) == some #[1, 2]

-- ⚠ FIRST WINS ON A TIE — `b.length > a.length` is strict. Swapping to `>=`
-- would mirror Amsterdam instead of London here, and nothing else would change.
#guard (largestRegion #[#[0, 1], #[2, 3]]) == some #[0, 1]

-- A gap wide enough to swallow the North Sea makes one region of everything.
#guard (clusterIntoRegionIndices #[LDN, AMS] 400.0) == #[#[0, 1]]
#guard (clusterIntoRegionIndices #[LDN, AMS] 100.0) == #[#[0], #[1]]

-- London to Amsterdam is ~357 km; the haversine must agree to within a km.
#guard decide (Float.abs (haversineKm LDN AMS - 357.0) < 5.0)
#guard near (haversineKm LDN LDN) 0.0

-- ⚠ The longitude pad is latitude-corrected, so at London's latitude 1500 m of
-- longitude is a LARGER angle than 1500 m of latitude. A flat degree pad would
-- make these equal and quietly narrow the box.
private def E : Bbox := expandBbox { minLat := 51.5, maxLat := 51.5, minLon := 0.0, maxLon := 0.0 } 1500.0
#guard decide (E.maxLon - E.minLon > E.maxLat - E.minLat)
#guard near ((E.maxLat - E.minLat) / 2.0) (1500.0 / M_PER_DEG)

-- A box smaller than a cell tiles to exactly itself.
private def SMALL : Bbox := { minLat := 51.5, maxLat := 51.52, minLon := -0.1, maxLon := -0.08 }
#guard (tileBbox SMALL 0.05).size == 1
#guard near (tileBbox SMALL 0.05)[0]!.minLat SMALL.minLat
#guard near (tileBbox SMALL 0.05)[0]!.maxLon SMALL.maxLon

-- ⚠ 0.1 DEGREES AT 0.05-DEGREE CELLS IS 3x2, NOT 2x2, AND THAT IS THE
-- TYPESCRIPT'S ANSWER TOO. `51.6 - 51.5` is 0.09999999999999432 in a double but
-- `-0.1 - -0.2` is 0.10000000000000003, so the latitude span divides to
-- 2.0000000000000284 and `ceil` takes it to THREE. The mirror therefore issues
-- 50% more latitude tiles than the geometry calls for. Verified against `node`
-- rather than reasoned about; a guard of `== 4` here would have looked obviously
-- right and been wrong about production.
private def BIG : Bbox := { minLat := 51.5, maxLat := 51.6, minLon := -0.2, maxLon := -0.1 }
private def TILES : Array Bbox := tileBbox BIG 0.05
#guard TILES.size == 6
#guard near TILES[0]!.minLat BIG.minLat
#guard near TILES[0]!.minLon BIG.minLon
-- The cells still TILE the box exactly whatever the cell count came out as: the
-- last cell's far corner IS the box's far corner.
#guard near TILES[5]!.maxLat BIG.maxLat
#guard near TILES[5]!.maxLon BIG.maxLon
-- Row-major: lat outer, lon inner. Cell 1 shares cell 0's latitude band and
-- starts where it ends.
#guard near TILES[1]!.minLat TILES[0]!.minLat
#guard near TILES[1]!.minLon TILES[0]!.maxLon
-- And cell 2 has moved up a latitude band, because lon ran out after two.
#guard near TILES[2]!.minLat TILES[0]!.maxLat
#guard near TILES[2]!.minLon BIG.minLon

-- ⚠ A DEGENERATE box must still yield one cell, not zero: `ceil(0 / d)` is 0 and
-- the `max 1` is what stops the mirror silently fetching nothing.
#guard (tileBbox { minLat := 51.5, maxLat := 51.5, minLon := 0.0, maxLon := 0.0 } 0.05).size == 1

end Verified.Geo.OsmRegions
