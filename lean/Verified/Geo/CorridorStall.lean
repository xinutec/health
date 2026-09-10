import Verified.Geo.WalkableRoute

/-!
# Corridor stall — how far a drawn line travels without advancing along the GPS

The witness `scoreWalk` cannot see, because `scoreWalk` never looks at the raw
fixes: how far the drawn line travels while making no progress ALONG the GPS
corridor. High for an invented detour, ~0 for a faithful line, a gap-fill (the
corridor advances) or a there-and-back the GPS actually traced.

## ⚠ WHY THIS IS IN `Geo` AND NOT IN THE REFEREE THAT MEASURES IT

It began in `Verified.Eval.WalkMetrics`, which is where the walk referee was
ported. That is the wrong home for it: it is a geometry primitive over two
polylines, and the DECISION gate needs it too — `matchImprovesDisplay` accepts
detours precisely because it has no path→fixes term (#1497). `Verified.Geo`
imports `Verified.Eval` nowhere and must not start; the direction is Eval → Geo.
So the primitive moved DOWN and the referee calls it.

⚠ **THE MOVE IS FLOAT-SAFE AND THAT WAS CHECKED, NOT ASSUMED.** `WalkMetrics`
carried its own `LatLon` and `metersBetween`; the structures are identical
(`{lat, lon : Float}`) and the two distance functions are arithmetically the
same expression — same `pi`, same 111320.0, same midpoint `cos`, and
`hyp x y` is literally `Float.sqrt (x*x + y*y)`. The six `#guard`s that pin
stall stayed in `WalkMetrics` and now run THROUGH the conversion, so they are
the equivalence test for this move rather than a copy of it.

## ⚠ AND IT IS NOT A COVERAGE MEASURE

Stall catches a path that travels while the corridor does not — an invented
detour. It says NOTHING about a path that covers LESS of the walk than the
fixes did: there the corridor advances fine and the path simply stops short.
That is a different defect with the opposite signature, and reading a low stall
as "the line is faithful" is how it would be missed.
-/

namespace Verified.Geo.CorridorStall

open Verified.Geo.WalkableRoute (Pt metersBetween)

private def posInf : Float := 1.0 / 0.0
private def clamp01 (t : Float) : Float := max 0 (min 1 t)
private def hyp (x y : Float) : Float := Float.sqrt (x * x + y * y)
private def pi : Float := 3.14159265358979323846

/-- The DP allocates `V*S` floats TWICE (`dist`, `arc`). Above this it declines
to answer.

⚠ **IT IS A SERVING-PATH BOUND, NOT A TUNING KNOB.** The referee runs this once
per FINAL walk and can afford anything the corpus contains. The DECISION gate
runs it per CANDIDATE match, on the finer display line — more vertices, more
calls — and an unbounded allocation there is a defect whatever today's corpus
happens to hold. 4e6 is ~32 MB per array, which is affordable; the largest walk
measured is far below it.

⚠ **IT FAILS OPEN, and that direction is deliberate.** Above the cap this
returns 0, which reads as "no stall" and so casts no vote. The alternative —
returning something large — would VETO a match on the strength of a measurement
that was never taken. Same principle as the absent pedometer in
`matchImprovesDisplay`: no evidence means no veto, never a veto by default. -/
def maxCorridorStallCap : Nat := 4000000

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
def maxCorridorStall (fixes path : Array Pt) (tolM : Float := 15) : Float := Id.run do
  if path.size < 2 || fixes.size < 2 then return 0
  if path.size * (fixes.size - 1) > maxCorridorStallCap then return 0
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

end Verified.Geo.CorridorStall
