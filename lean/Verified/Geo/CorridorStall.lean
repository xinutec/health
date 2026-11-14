import Verified.Geo.WalkableRoute
import Verified.FloatConst

/-!
# Corridor stall — how far a drawn line travels without advancing along the GPS

High for an invented detour; ~0 for a faithful line, a gap-fill (the corridor
advances) or a there-and-back the GPS traced. `scoreWalk` cannot see this: it
never looks at the raw fixes.

In `Geo`, not the referee, because the display gate needs it too
(`matchImprovesDisplay` has no path→fixes term) and `Geo` must not import
`Eval`. The stall `#guard`s in `WalkMetrics` run through the conversion.

Not a coverage measure: a path that stops short of the fixes scores no stall.
-/

namespace Verified.Geo.CorridorStall

open Verified.Geo.WalkableRoute (Pt metersBetween)

open Verified.FloatConst (posInf hyp pi)
private def clamp01 (t : Float) : Float := max 0 (min 1 t)

/-- The DP allocates `V*S` floats twice (`dist`, `arc`); above this it declines.
A serving-path bound: the display gate runs this per candidate match. 4e6 is
~32 MB per array, far above the largest walk measured.

Fails open: above the cap it returns 0, no stall, so an untaken measurement
casts no veto, as with the absent pedometer in `matchImprovesDisplay`. -/
def maxCorridorStallCap : Nat := 4000000

/-- The longest run of `path` that travels far while its monotone projection
onto the time-ordered `fixes` barely advances (m).

The projection is the min-cost monotone assignment (a DP), not a greedy
ratchet: on a street walked twice, greedy can project an early vertex onto the
return pass and read the rest as one stall. An invented detour still cannot
advance, having no fixes ahead of it. -/
def maxCorridorStall (fixes path : Array Pt) (tolM : Float := 15) : Float := Id.run do
  if path.size < 2 || fixes.size < 2 then return 0
  if path.size * (fixes.size - 1) > maxCorridorStallCap then return 0
  -- The grids are flat, `k * S + i`, and in range by construction (`k < V`,
  -- `i < S`), a product no index tactic bounds, so reads give a default: `0`,
  -- and `-1` (no parent) for `parent`.
  -- Prefix arc lengths: `fArc[i]` is the corridor distance to fix `i`.
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

end Verified.Geo.CorridorStall
