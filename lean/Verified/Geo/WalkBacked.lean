import Verified.Geo.WalkEscape
import Verified.FloatConst

/-!
# A drawn walk is backed by the map or by the track

A stretch of a drawn walk is *backed* when it runs along a mapped walkable way
or sharp fixes lie along it. An edge that is neither, between two vertices that
are both on the map, is the drawing's own: a clean-up pass joined two route
vertices straight across a block, or a gap in the track was bridged by a line.
`backEdges` replaces such an edge by the shortest walkable route between its
ends when that route is the edge with its corner restored, and leaves it
otherwise: a longer route is a guess at where he went. What stays unbacked,
`unbackedSpans` reports, and the map draws it dashed.

It runs last, on the line that ships, so no accept or reject decision upstream
reads its output.

Measured by `tests/golden/fits/instruments/walk/unbacked.py`, whose definition
of backed this is.

UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.WalkBacked

open Verified.Geo.WalkableRoute (Pt Ways metersBetween routeOnWalkableIn buildWalkGraph WalkGraph)
open Verified.Geo.WalkEscape (BadnessCtx TPt makeBadnessCtx)
open Verified.FloatConst (natToFloat)

-- Float literals at module level: one in a loop is rebuilt on every pass.
private def ZERO : Float := 0
private def HALF : Float := 0.5
private def ONE : Float := 1
/-- Route vertices this near an end are the end. -/
private def SAME_M : Float := 0.5

/-- A fix backs the line this near it. -/
def FIX_REACH_M : Float := 15
/-- Only a fix this accurate says where he was to within `FIX_REACH_M`. -/
def SHARP_FIX_M : Float := 25
/-- The line is sampled this often. -/
def SAMPLE_M : Float := 2
/-- A route may be this much longer than its edge: a corner the edge cut. More
    is a choice among paths the track did not see, which this pass does not
    make (the refinement splice's absolute bound). -/
def MAX_DETOUR_EXTRA_M : Float := 50

/-- A raw fix and its reported accuracy. -/
structure Fix where
  pt : Pt
  accuracy : Option Float := none
  deriving Inhabited

/-- The fixes that can back a stretch: accuracy known and sharp. -/
def sharpFixes (fixes : Array Fix) : Array Pt :=
  fixes.filterMap fun f =>
    match f.accuracy with
    | some a => if a ≤ SHARP_FIX_M then some f.pt else none
    | none => none

/-- On the map: within the corrector's way tolerance of a walkable way. -/
def onMap (ctx : BadnessCtx) (p : Pt) : Bool := ctx.grid.within p ctx.opts.onWayM

def backed (ctx : BadnessCtx) (sharp : Array Pt) (p : Pt) : Bool :=
  onMap ctx p || sharp.any fun f => metersBetween p f ≤ FIX_REACH_M

/-- Metres of `a→b` that nothing backs. -/
def unbackedM (ctx : BadnessCtx) (sharp : Array Pt) (a b : Pt) : Float := Id.run do
  let len := metersBetween a b
  if len == ZERO then return ZERO
  let stepsF := max ONE (Float.ceil (len / SAMPLE_M))
  let stepsN := stepsF.toUInt64.toNat
  let mut bad := ZERO
  for k in [0:stepsN] do
    let f := (natToFloat k + HALF) / stepsF
    let mid : Pt := ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f⟩
    if !backed ctx sharp mid then bad := bad + len / stepsF
  return bad

/-- Metres of a whole line that nothing backs. -/
def pathUnbackedM (ctx : BadnessCtx) (sharp : Array Pt) (pts : Array Pt) : Float := Id.run do
  let mut bad := ZERO
  for h : k in [1:pts.size] do
    have hk : k < pts.size := h.upper
    bad := bad + unbackedM ctx sharp pts[k - 1] pts[k]
  return bad

/-- Per edge of `pts` (edge `i` runs `pts[i]→pts[i+1]`): whether it carries
    part of an unbacked run longer than the way tolerance. A run is judged whole,
    across edges, so a dense line is held to what a sparse one is. -/
def unbackedEdges (ctx : BadnessCtx) (sharp : Array Pt) (pts : Array Pt) : Array Bool := Id.run do
  let mut marks : Array Bool := Array.replicate (pts.size - 1) false
  let mut run := ZERO
  let mut runFrom := 0
  for h : k in [1:pts.size] do
    have hk : k < pts.size := h.upper
    let a := pts[k - 1]
    let b := pts[k]
    let len := metersBetween a b
    if len == ZERO then continue
    let stepsF := max ONE (Float.ceil (len / SAMPLE_M))
    for j in [0:stepsF.toUInt64.toNat] do
      let f := (natToFloat j + HALF) / stepsF
      let mid : Pt := ⟨a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f⟩
      if backed ctx sharp mid then
        run := ZERO
      else
        if run == ZERO then runFrom := k - 1
        run := run + len / stepsF
        if run > ctx.opts.onWayM then
          for e in [runFrom:k] do marks := marks.set! e true
          runFrom := k - 1
  return marks

/-- The time spans over which `drawn` is unbacked: its marked edges, a run of
    them as one span. What the map draws dashed. -/
def unbackedSpans (ctx : BadnessCtx) (fixes : Array Fix) (drawn : Array TPt) :
    Array (Float × Float) := Id.run do
  if drawn.size < 2 || ctx.walkable.isEmpty then return #[]
  let marks := unbackedEdges ctx (sharpFixes fixes) (drawn.map (·.pt))
  let mut out : Array (Float × Float) := #[]
  let mut open_ : Option Float := none
  for h : k in [1:drawn.size] do
    have hk : k < drawn.size := h.upper
    if marks.getD (k - 1) false then
      if open_.isNone then open_ := some drawn[k - 1].ts
    else
      match open_ with
      | some t0 => out := out.push (t0, drawn[k - 1].ts); open_ := none
      | none => pure ()
  match open_, drawn.back? with
  | some t0, some last => out := out.push (t0, last.ts)
  | _, _ => pure ()
  return out

private def lenM (pts : Array Pt) : Float := Id.run do
  let mut len := ZERO
  for h : k in [1:pts.size] do
    have hk : k < pts.size := h.upper
    len := len + metersBetween pts[k - 1] pts[k]
  return len

/-- The route for one unbacked edge, ends included, or `none`: an end off the
    map, no route, or a real detour. -/
def routeFor (ctx : BadnessCtx) (graph : WalkGraph) (a b : Pt) : Option (Array Pt) :=
  if !(onMap ctx a && onMap ctx b) then none else
  let chord := metersBetween a b
  let bound := chord + MAX_DETOUR_EXTRA_M
  match routeOnWalkableIn graph a b ctx.walkable
      { snapRadiusM := ctx.opts.onWayM, maxRouteM := bound } with
  | none => none
  | some r =>
    let pts := (#[a] ++ r).push b
    if lenM pts ≤ bound then some pts else none

/-- `drawn` with each unbacked edge between two on-map vertices routed along
    the map. An edge counts once more than the way tolerance of it is unbacked;
    a route is taken only when less of it is. Timestamps run along the route by
    distance. `budgetM` is the leg's pedometer bar, when its steps are known. -/
def backEdges (ctx : BadnessCtx) (fixes : Array Fix) (drawn : Array TPt)
    (budgetM : Option Float := none) : Array TPt := Id.run do
  if drawn.size < 2 || ctx.walkable.isEmpty then return drawn
  let sharp := sharpFixes fixes
  -- Built only for a line with an unbacked edge.
  let graph : Thunk WalkGraph := Thunk.mk fun _ => buildWalkGraph ctx.walkable
  let mut out : Array TPt := #[drawn[0]!]
  for h : i in [1:drawn.size] do
    have hi : i < drawn.size := h.upper
    let a := drawn[i - 1]
    let b := drawn[i]
    let bad := unbackedM ctx sharp a.pt b.pt
    let route := if bad > ctx.opts.onWayM then routeFor ctx graph.get a.pt b.pt else none
    match route with
    | some pts =>
      if pathUnbackedM ctx sharp pts < bad then
        let total := lenM pts
        let mut run := ZERO
        for hk : k in [1:pts.size] do
          have hk' : k < pts.size := hk.upper
          let p := pts[k]
          run := run + metersBetween pts[k - 1] p
          -- The ends keep their own positions; a route vertex on one is it.
          if k + 1 < pts.size && metersBetween p a.pt > SAME_M && metersBetween p b.pt > SAME_M then
            let f := if total > ZERO then run / total else ZERO
            out := out.push ⟨p.lat, p.lon, a.ts + (b.ts - a.ts) * f⟩
        out := out.push b
      else out := out.push b
    | none => out := out.push b
  -- The pedometer's bar, as the corrector holds it: routes may not take a leg
  -- from within what the steps allow to beyond it.
  match budgetM with
  | some bar =>
    if lenM (drawn.map (·.pt)) ≤ bar && lenM (out.map (·.pt)) > bar then return drawn
  | none => pure ()
  return out

/-! ## Guards

A block: two streets meeting at a corner, and the diagonal across it. -/

private def LAT0 : Float := 51.52
private def LON0 : Float := -0.13
private def D : Float := 0.0009
private def corner : Pt := ⟨LAT0, LON0⟩
private def east : Pt := ⟨LAT0, LON0 + D⟩
private def north : Pt := ⟨LAT0 + D, LON0⟩
private def block : BadnessCtx := makeBadnessCtx #[#[north, corner], #[corner, east]] #[] {}
private def tp (p : Pt) (ts : Float) : TPt := ⟨p.lat, p.lon, ts⟩
private def diagonal : Array TPt := #[tp north 0, tp east 100]
private def mid : Pt := ⟨LAT0 + D / 2, LON0 + D / 2⟩

-- The diagonal is off the map in its middle; the streets themselves are not.
#guard unbackedM block #[] north east > 50
#guard unbackedM block #[] north corner == 0
-- With nothing on the track, the diagonal goes round by the corner.
#guard (backEdges block #[] diagonal).size == 3
#guard ((backEdges block #[] diagonal)[1]?.map fun p => decide (metersBetween p.pt corner < 1)) == some true
-- The ends and their times stand, and the corner's time lies between.
#guard (backEdges block #[] diagonal)[0]? == some (tp north 0)
#guard (backEdges block #[] diagonal)[2]? == some (tp east 100)
#guard ((backEdges block #[] diagonal)[1]?.map fun p => decide (p.ts > 0) && decide (p.ts < 100)) == some true
-- Sharp fixes along the diagonal back it: he did cut across.
private def along : Array Fix := (Array.range 9).map fun k =>
  { pt := ⟨LAT0 + D * (8 - natToFloat k) / 8, LON0 + D * natToFloat k / 8⟩, accuracy := some 8 }
#guard backEdges block along diagonal == diagonal
-- A leg the steps cover as drawn is not routed past them.
#guard backEdges block #[] diagonal (some 130) == diagonal
#guard (backEdges block #[] diagonal (some 200)).size == 3
-- Coarse fixes there back nothing.
#guard (backEdges block (along.map fun f => { f with accuracy := some 60 }) diagonal).size == 3
-- An end off the map is the track's business, not this pass's.
#guard backEdges block #[] #[tp mid 0, tp east 100] == #[tp mid 0, tp east 100]
-- The diagonal is one unbacked span, start to end; routed, the line has none.
#guard unbackedSpans block #[] diagonal == #[(0, 100)]
#guard unbackedSpans block #[] (backEdges block #[] diagonal) == #[]
#guard unbackedSpans block along diagonal == #[]
-- A dense line across the block is unbacked as the single edge is: its short
-- edges make one run.
private def dense : Array TPt := (Array.range 21).map fun k =>
  tp ⟨LAT0 + D * (20 - natToFloat k) / 20, LON0 + D * natToFloat k / 20⟩ (natToFloat k * 5)
#guard (unbackedSpans block #[] dense).size == 1
#guard ((unbackedSpans block #[] dense)[0]?.map fun (p : Float × Float) =>
  decide (p.1 ≤ 10) && decide (p.2 ≥ 90)) == some true
-- On the street, nothing is.
#guard unbackedSpans block #[] #[tp north 0, tp corner 50, tp east 100] == #[]
-- A route that is a real detour is refused: the same diagonal across a block
-- whose only way round is far longer.
private def far : Pt := ⟨LAT0 - 20 * D, LON0⟩
private def longWay : BadnessCtx :=
  makeBadnessCtx #[#[north, ⟨LAT0 + D, LON0 - D⟩, far, ⟨LAT0 - 20 * D, LON0 + D⟩, east]] #[] {}
#guard backEdges longWay #[] diagonal == diagonal

end Verified.Geo.WalkBacked
