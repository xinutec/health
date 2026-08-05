import Verified.Geo.SegmentMerge
import Verified.Geo.WalkAnchors
import Verified.Geo.WalkSmooth
import Verified.Geo.DisplayGate
import Verified.Geo.EpisodeGeometry
import Verified.Geo.BiometricWindows
/-!
# The walk-annotation pass (port of `annotateWalkMatches`, `pedestrian-match-annotate.ts`)

Attach a pavement-matched geometry to every walking leg the evidence can
confidently place. The pass itself is an ORCHESTRATOR: the Viterbi matcher, the
MAP reconstruction, the corner refinement, the building corrector and the
passage snap are all leaves with their own modules. What lives here is
everything BETWEEN them — which legs are eligible, what disc each one reads,
which arm draws the line, and which of the three output shapes the leg leaves
with.

## What is injected and why

The five heavy leaves arrive as function arguments:

* the **matcher** because its Lean counterpart is the QUANTISED arm
  (`Verified.Geo.Match`), which is measured and ceilinged against the TS rather
  than bit-identical to it (#395 / #403) — wiring it in directly would make this
  module's guards assert the ceiling, not the orchestration;
* the **reconstruction**, **refinement**, **corrector** and **passage snap**
  because each is a solver whose own module already pins it, and re-running a
  PCG solve inside a `#guard` buys nothing this module is responsible for.

The two OSM reads are injected for the usual reason: they are the shell.

Everything the orchestration actually DECIDES with is called directly — the
display gate, the splice salvage, the sharp-turn count, the spike rejection, the
kinematic hold, the step window, the endpoint anchors. A decision this pass
makes is therefore made against the real Lean leaf, not a stub.

## The three asymmetries the guards pin

1. **Decisions read `coarsePath`; the draw reads `path`.** The display gate, the
   splice salvage and the refinement's engagement test were all tuned on the
   coarse line, so they consume it; only the DRAWN line gets the finer
   route-detail geometry (#369). On a straight way the two coincide, which is
   why the curved-way fixture exists.
2. **The matcher sees the DESPIKED fixes; the reconstruction sees the HELD
   ones.** `clean` (spikes dropped) feeds the matcher, `held` (spikes dropped
   AND the teleport run collapsed) feeds both reconstruction arms. That is what
   makes the swap able to dissolve an excursion the matcher drew.
3. **The corrector and the passage snap share one gate but not one effect.**
   Both run only when `buildingEscape` is on AND the leg read a non-empty
   building layer, but the snap runs LAST, on the corrector's output, so it can
   never perturb the accept/reject the corrector already made.

## Prefetch order is observable

Every eligible leg's `walkableRoads` read is fired before any leg's
`buildingsNear` read, and `buildingsNear` fires only when that leg's ways came
back non-empty. Both facts are pinned by the read trace: a fixture replay that
saw a different call order would be seeing different captured keys.

UNPROVEN; pinned against Node/V8 (`lean/experiments/walk-annotate-refs.mts`).
-/

namespace Verified.Geo.WalkAnnotate

open Verified.Geo.WalkableRoute (Pt Ways)
open Verified.Geo.WalkEscape (Ring TPt)
open Verified.Geo.WalkSmooth (WalkFix WalkEvidence countSharpTurns)
open Verified.Geo.DisplayGate (MPt matchImprovesDisplay spliceMatchedWithDivergentRuns)
open Verified.Geo.BiometricWindows (StepPoint stepsInWindow)

/-! ## Shapes -/

/-- A raw GPS fix as drawn — the same set the raw renderer uses. -/
structure PedFix where
  ts : Int
  lat : Float
  lon : Float
  /-- The phone's self-reported accuracy (m). `none` is the TS `null`, and both
  reach the solvers as "no number", not as a number meaning zero. -/
  accuracy : Option Float := none
  deriving Inhabited, BEq, Repr

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- What the pedestrian matcher returns: the display line, and the coarse line
every downstream threshold was tuned against. -/
structure MatchOut where
  path : Array MPt
  coarsePath : Array MPt
  deriving Inhabited, BEq, Repr

/-- The environment switches, as configuration. Defaults are production's:
`WALK_MATCH_DISABLE` unset, `WALK_RECON ≠ "0"`, `WALK_REFINE_DISABLE ≠ "1"`,
`WALK_BUILDING_ESCAPE ≠ "0"`. -/
structure Flags where
  matchDisable : Bool := false
  recon : Bool := true
  refine : Bool := true
  buildingEscape : Bool := true
  deriving Inhabited, BEq, Repr

/-- Which line the leg draws. `matcher` is production; `recon` is the
reconstruction-primary arm (#330 / geometry-roadmap G2). -/
inductive Draw where
  | matcher
  | recon
  deriving Inhabited, BEq, Repr

/-- The shell: the two OSM reads and the five solver leaves. -/
structure Env where
  /-- `osm.walkableRoads(lat, lon, radiusM)`. -/
  walkableRoads : Float → Float → Int → Ways
  /-- `osm.buildingsNear(lat, lon, radiusM)`. -/
  buildingsNear : Float → Float → Int → Array Ring
  /-- `matchWalkSegment(fixes, { ways, buildings })`. -/
  matcher : Array MPt → Ways → Array Ring → Option MatchOut
  /-- `reconstructWalk(fixes, { ways, buildings }, undefined, evidence)`. -/
  reconstruct : Array WalkFix → Ways → Array Ring → WalkEvidence → Option (Array TPt)
  /-- `refineMatchedPath(walkFixes, base)`. -/
  refineMatched : Array WalkFix → Array Pt → Option (Array TPt)
  /-- `correctWalkPath(drawn, { ways }, buildings, opts)` — the diagnostics sink
  is a debug-only side channel and is not modelled. -/
  correct : Array TPt → Ways → Array Ring → Option Float → Array TPt
  /-- `snapPassages(drawn, { ways }, buildings)`. -/
  snapPassages : Array TPt → Ways → Array Ring → Array TPt

/-! ## Constants -/

def MIN_LEG_FIXES : Nat := 4
/-- `MAX_SPEED_FOR_MODE.walking ?? 12`. -/
def WALK_SPEED_CAP_KMH : Float := 12
/-- Slack added to the centroid→farthest-fix radius for the walkable-network
read, so the disc comfortably covers the matcher's reach. -/
def WALK_QUERY_SLACK_M : Float := 120
/-- The raw drawn line must stray at least this far off the walkable surface
before a match is worth having. -/
def WALK_NEEDS_MATCH_M : Float := 18
/-- …and the match must stay within this (p85) of the fixes. Generous by
design: a walker's GPS genuinely sits 10-30 m off the pavement. -/
def WALK_MATCH_MAX_STRAY_M : Float := 40
/-- The reconstruction replaces the drawn line only when it is at most this
fraction of its length… -/
def RECON_SWAP_MAX_LEN_FRACTION : Float := 0.75
/-- …AND at least this many metres shorter. Both must clear. -/
def RECON_SWAP_MIN_ABS_DROP_M : Float := 150
/-- The step-budget bar the corrector shares with the walk ratchet and the
reconstruction's step factor: steps × stride × slack. -/
def STEP_STRIDE_M : Float := 0.75
def STEP_SLACK_RATIO : Float := 1.4

/-! ## Local geometry -/

private def pi : Float := 3.141592653589793

/-- Great-circle metres. NOT `WalkableRoute.metersBetween` — this pass keeps its
own haversine, as the TS does, and the two disagree beyond the flat-earth
approximation's error. -/
def metersBetween (aLat aLon bLat bLon : Float) : Float :=
  let R := 6371000.0
  let dLat := (bLat - aLat) * pi / 180.0
  let dLon := (bLon - aLon) * pi / 180.0
  let lat1 := aLat * pi / 180.0
  let lat2 := bLat * pi / 180.0
  let sLat := Float.sin (dLat / 2.0)
  let sLon := Float.sin (dLon / 2.0)
  let h := sLat * sLat + Float.cos lat1 * Float.cos lat2 * (sLon * sLon)
  2.0 * R * Float.asin (min 1.0 (Float.sqrt h))

/-- Total drawn length (m) of a polyline. -/
def pathLenM (pts : Array TPt) : Float := Id.run do
  let mut total := 0.0
  for i in [1 : pts.size] do
    total := total + metersBetween pts[i - 1]!.lat pts[i - 1]!.lon pts[i]!.lat pts[i]!.lon
  return total

/-- `Math.round` — halves go UP, towards +∞. Exposed because the disc radius
is its only caller and a haversine output never lands exactly on a half, so the
tie rule is pinnable only directly. -/
def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-! ## Per-leg preparation -/

/-- The disc a leg reads, and the fixes it reads it for. -/
structure Prep where
  inWin : Array PedFix
  cLat : Float
  cLon : Float
  discRadiusM : Int
  deriving Inhabited, BEq, Repr

/-- Eligibility and disc geometry for one segment: a WALKING leg (by
`effectiveMode`) with at least `MIN_LEG_FIXES` in-window fixes under the walking
speed cap. `none` means the leg reads nothing at all. -/
def prepFor (seg : Seg) (displayFixes : Array PedFix) (speedByTs : Int → Option Float) :
    Option Prep :=
  if Verified.Geo.WalkAnchors.effectiveMode seg != "walking" then none
  else
    -- The TS sorts by `ts` after filtering. `displayFixes` arrives in ts order
    -- and the filter is stable, so the sort is a no-op — but it is a TOTAL
    -- order on a field the caller owns, not an invariant this pass may assume,
    -- so it is kept.
    let inWin := (displayFixes.filter fun f =>
      decide (f.ts ≥ seg.startTs) && decide (f.ts ≤ seg.endTs)
        && decide ((speedByTs f.ts).getD 0 ≤ WALK_SPEED_CAP_KMH)).insertionSort
        (fun a b => decide (a.ts ≤ b.ts))
    if inWin.size < MIN_LEG_FIXES then none
    else
      let n := Float.ofNat inWin.size
      let cLat := (inWin.foldl (fun a p => a + p.lat) 0.0) / n
      let cLon := (inWin.foldl (fun a p => a + p.lon) 0.0) / n
      let maxDist := inWin.foldl (fun m p =>
        let d := metersBetween cLat cLon p.lat p.lon
        if d > m then d else m) 0.0
      some ⟨inWin, cLat, cLon, (jsRound (maxDist + WALK_QUERY_SLACK_M)).toInt64.toInt⟩

/-! ## The fix pipelines -/

open Verified.Geo (rejectSpikes holdSpeed)
open Verified.Geo.EpisodeGeometry (spikeAt speedOk)

private def PedFix.latLon (p : PedFix) : Verified.Geo.EpisodeGeometry.LatLon :=
  -- A captured fix's `ts` is a whole second; `LatLon.ts` is `Float` because the
  -- DERIVED vertices sharing that field are fractional (#420). Widening here is
  -- exact — every Int in this range is a Float.
  { lat := p.lat, lon := p.lon, ts := some (Float.ofInt p.ts) }
private def PedFix.rawFix (p : PedFix) : Verified.Geo.EpisodeGeometry.RawFix :=
  { ts := p.ts, lat := p.lat, lon := p.lon }

/-- `rejectSpikes` at `PedFix` — the generic scan with the TS's own
out-and-back predicate, instantiated so `accuracy` rides along. -/
def despike (pts : Array PedFix) : Array PedFix :=
  (rejectSpikes (fun a b c => spikeAt a.latLon b.latLon c.latLon)
    (fun i => pts.getD i default) pts.size).toArray

/-- `holdImplausibleSpeed` at `PedFix`, at the walking cap. -/
def hold (pts : Array PedFix) : Array PedFix :=
  (holdSpeed (fun a b => speedOk WALK_SPEED_CAP_KMH a.rawFix b.rawFix)
    (fun i => pts.getD i default) pts.size).toArray

private def PedFix.walkFix (p : PedFix) : WalkFix :=
  { lat := p.lat, lon := p.lon, ts := Float.ofInt p.ts, accuracyM := p.accuracy }
private def PedFix.pathPt (p : PedFix) : PathPt := ⟨p.lat, p.lon, Float.ofInt p.ts⟩

/-! ## The endpoint anchors -/

/-- `WalkSmooth`'s anchor from `WalkAnchors`'. Two records of the same three
fields in two modules, because the leaf that DERIVES an anchor and the solver
that CONSUMES one are separate ports. -/
private def toSmoothAnchor (a : Verified.Geo.WalkAnchors.WalkAnchor) :
    Verified.Geo.WalkSmooth.WalkAnchor :=
  ⟨a.lat, a.lon, a.sigmaM⟩

/-- The evidence the reconstruction gets: both endpoint anchors and the leg's
pedometer count. -/
def evidenceFor (segments : Array Seg) (si : Nat) (stepsWalked : Option Float) : WalkEvidence :=
  let (s, e) := Verified.Geo.WalkAnchors.walkEndpointAnchors segments si
  { start := s.map toSmoothAnchor, finish := e.map toSmoothAnchor, stepsWalked := stepsWalked }

/-! ## The pass -/

/-- Whether the drawn line changed under a corrector: a different vertex count,
or any vertex moved. Position only — the TS compares `lat`/`lon` and not `ts`. -/
private def changed (before after : Array TPt) : Bool :=
  after.size != before.size
    || (List.range after.size).any fun k =>
         after[k]!.lat != before[k]!.lat || after[k]!.lon != before[k]!.lon

/-- One leg's drawn line under the reconstruction-primary arm. -/
private def drawRecon (env : Env) (ways : Ways) (buildings : Array Ring)
    (held : Array PedFix) (ev : WalkEvidence) : Array TPt × Bool :=
  match env.reconstruct (held.map PedFix.walkFix) ways buildings ev with
  | some recon => if recon.size ≥ 2 then (recon, true) else (held.map PedFix.pathPt, false)
  | none => (held.map PedFix.pathPt, false)

/-- One leg's drawn line under the matcher arm: the display gate, the
local-divergence splice salvage, the de-boxing refinement, and the
robust-reconstruction swap. Returns the line, whether a match (or a splice) was
used, and whether the reconstruction replaced it. -/
private def drawMatcher (env : Env) (flags : Flags) (ways : Ways) (buildings : Array Ring)
    (clean held : Array PedFix) (ev : WalkEvidence) : Array TPt × Bool × Bool := Id.run do
  let fixes := clean.map PedFix.pathPt
  let result := env.matcher fixes ways buildings
  -- Decision parity (#369): the gate, the salvage and the refinement's
  -- engagement test all consume `coarsePath`, never the finer display line.
  let decision := result.map fun r =>
    matchImprovesDisplay (fixes.map PathPt.pt) (r.coarsePath.map PathPt.pt) ways
      WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M
  let mut useMatch := match decision with
    | some d => d.use
    | none => false
  -- Salvage-worthy only when the raw fallback is DRASTICALLY off-network and
  -- the match is clean: a systematic parallel-way snap still rejects wholesale.
  let mut spliced : Option (Array MPt) := none
  if !useMatch then
    match result, decision with
    | some r, some d =>
      if d.rawOffRoadM > WALK_NEEDS_MATCH_M * 2 && d.matchedOffRoadM ≤ WALK_NEEDS_MATCH_M / 2 then
        spliced := spliceMatchedWithDivergentRuns fixes r.coarsePath WALK_MATCH_MAX_STRAY_M
        if spliced.isSome then useMatch := true
    | _, _ => pure ()
  let mut drawn : Array TPt := #[]
  match result with
  | some r =>
    if useMatch then
      let base := (spliced.getD r.coarsePath).map PathPt.pt
      drawn := (spliced.getD r.path)
      if flags.refine then
        match env.refineMatched (clean.map PedFix.walkFix) base with
        | some refined =>
          -- Applied only when it actually reduces sharp turns; otherwise the
          -- matched line is already smooth and is kept as-is.
          if countSharpTurns (refined.map PathPt.pt) < countSharpTurns base then drawn := refined
        | none => pure ()
    else
      drawn := held.map PedFix.pathPt
  | none => drawn := held.map PedFix.pathPt
  -- The swap: a large FRACTION shorter AND a wide ABSOLUTE margin shorter. On
  -- an ordinary leg the reconstruction is ~the same length and nothing changes.
  if flags.recon then
    match env.reconstruct (held.map PedFix.walkFix) ways buildings ev with
    | some recon =>
      if recon.size ≥ 2 then
        let drawnLen := pathLenM drawn
        let reconLen := pathLenM recon
        if reconLen ≤ drawnLen * RECON_SWAP_MAX_LEN_FRACTION
            && drawnLen - reconLen ≥ RECON_SWAP_MIN_ABS_DROP_M then
          return (recon, useMatch, true)
    | none => pure ()
  return (drawn, useMatch, false)

/--
Attach `walkMatchedPath` / `walkSmoothedPath` to every walking leg the evidence
can confidently place. Returns a new segment array; the input is not mutated.
`flags.matchDisable` makes the whole pass a no-op — the raw baseline.
-/
def annotateWalkMatches (segments : Array Seg) (displayFixes : Array PedFix)
    (speedByTs : Int → Option Float) (env : Env) (stepPoints : List StepPoint := [])
    (draw : Draw := .matcher) (flags : Flags := {}) : Array Seg := Id.run do
  if flags.matchDisable then return segments
  let prep := segments.map fun s => prepFor s displayFixes speedByTs
  -- Every leg's ways read fires before any leg's buildings read (the TS fires
  -- both promises up front so the DB round-trips overlap). The buildings read
  -- is CONDITIONAL on the ways coming back non-empty, so a fixture replay sees
  -- exactly the captured keys.
  let waysOf := prep.map fun p? => p?.map fun p => env.walkableRoads p.cLat p.cLon p.discRadiusM
  let buildingsOf := (Array.range prep.size).map fun i =>
    match prep[i]!, waysOf[i]! with
    | some p, some w => if w.isEmpty then some #[] else some (env.buildingsNear p.cLat p.cLon p.discRadiusM)
    | _, _ => none
  let mut out : Array Seg := #[]
  for si in [0 : segments.size] do
    let seg := segments[si]!
    match prep[si]!, waysOf[si]!, buildingsOf[si]! with
    | some p, some ways, some buildings =>
      if ways.isEmpty then
        out := out.push seg
      else
        let clean := despike p.inWin
        if clean.size < MIN_LEG_FIXES then
          out := out.push seg
        else
          -- The reconstruction starts from EXACTLY the fix set the raw renderer
          -- draws: without the teleport-RUN collapse a dense indoor jitter that
          -- `despike` cannot see reaches the solver as mutually-consistent
          -- evidence the robust kernel keeps.
          let held := hold clean
          let stepsWalked := stepsInWindow stepPoints seg.startTs seg.endTs
          let ev := evidenceFor segments si stepsWalked
          let (drawn0, useMatch, smoothed0) := match draw with
            | .recon =>
              let (d, s) := drawRecon env ways buildings held ev
              (d, false, s)
            | .matcher => drawMatcher env flags ways buildings clean held ev
          let mut drawn := drawn0
          let mut corrected := false
          if flags.buildingEscape && !buildings.isEmpty then
            let budget := stepsWalked.map (· * STEP_STRIDE_M * STEP_SLACK_RATIO)
            let fixed := env.correct drawn ways buildings budget
            corrected := changed drawn fixed
            if corrected then drawn := fixed
            -- The passage snap runs LAST, on the final line, so it cannot
            -- perturb the gate's or the corrector's accept/reject decisions.
            let snapped := env.snapPassages drawn ways buildings
            if changed drawn snapped then
              drawn := snapped
              corrected := true
          if smoothed0 then out := out.push { seg with walkSmoothedPath := some drawn }
          else if useMatch || corrected then out := out.push { seg with walkMatchedPath := some drawn }
          else out := out.push seg
    | _, _, _ => out := out.push seg
  return out

/-! ## Guards (V8 reference values)

Every number below is `lean/experiments/walk-annotate-refs.mts`'s output on the
same fixture, transcribed at V8's own precision — including the centroid dust
(`51.501099999999994`), which is what pins the summation order.

The stubs DISCRIMINATE: the OSM read answers only at the exact
`(lat, lon, radius)` the leg is expected to ask for, the matcher only for the
exact DESPIKED fix array, the reconstruction only for the exact HELD one, and
the refinement only for the exact base line. A stub that ignored its arguments
could not pin what the pass passes.
-/

private def pt (la lo : Float) : Pt := ⟨la, lo⟩
private def mp (la lo : Float) (ts : Float) : MPt := ⟨la, lo, ts⟩
private def tp (la lo : Float) (ts : Float) : TPt := ⟨la, lo, ts⟩
private def f (ts : Int) (la lo : Float) : PedFix := ⟨ts, la, lo, some 10⟩
private def walkSeg (a b : Int) : Seg := { startTs := a, endTs := b, mode := "walking" }
private def anySpeed : Int → Option Float := fun _ => some 4

/-- A north-south street on the -0.14 meridian and an east-west one crossing it. -/
private def STREETS : Ways :=
  #[#[pt 51.5 (-0.14), pt 51.502 (-0.14), pt 51.504 (-0.14)],
    #[pt 51.502 (-0.14), pt 51.502 (-0.137)]]
/-- The same pair with the meridian BOWED, so the route carries curve geometry
the coarse matched line does not. -/
private def CURVED : Ways :=
  #[#[pt 51.5 (-0.14), pt 51.5005 (-0.1398), pt 51.501 (-0.1397), pt 51.5015 (-0.1398),
      pt 51.502 (-0.14), pt 51.504 (-0.14)],
    #[pt 51.502 (-0.14), pt 51.502 (-0.137)]]
/-- One long approach then a staircase whose corners cluster inside the
refinement's neighbour radius. -/
private def TIGHT : Ways :=
  #[#[pt 51.5 (-0.14), pt 51.502 (-0.14), pt 51.502 (-0.138), pt 51.5021 (-0.138),
      pt 51.5021 (-0.1378), pt 51.5022 (-0.1378), pt 51.5022 (-0.1376), pt 51.5023 (-0.1376),
      pt 51.5023 (-0.1374)]]
private def MERIDIAN : Ways := #[#[pt 51.5 (-0.14), pt 51.502 (-0.14), pt 51.504 (-0.14)]]

private def WALKING : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.501 (-0.14),
    f 1180 51.5015 (-0.14), f 1240 51.502 (-0.14)]
private def CORNER : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.501 (-0.14), f 1120 51.502 (-0.1385),
    f 1180 51.502 (-0.1378), f 1240 51.502 (-0.137)]
private def TOO_FEW : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.501 (-0.14)]
private def OFFROAD : Array PedFix :=
  #[f 1000 51.5 (-0.1455), f 1060 51.5005 (-0.1455), f 1120 51.501 (-0.1455),
    f 1180 51.5015 (-0.1455), f 1240 51.502 (-0.1455)]
private def SPIKED : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.5015 (-0.145),
    f 1180 51.5015 (-0.14), f 1240 51.502 (-0.14)]
private def SPIKED_TWICE : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.145), f 1120 51.501 (-0.14),
    f 1180 51.5015 (-0.145), f 1240 51.502 (-0.14)]
private def TELEPORTED : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.507 (-0.14),
    f 1180 51.5075 (-0.14), f 1240 51.508 (-0.14)]
private def TIGHT_FIXES : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.501 (-0.14), f 1120 51.502 (-0.138),
    f 1180 51.50215 (-0.1377), f 1240 51.5023 (-0.1374)]
private def STRAGGLER : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.501 (-0.14),
    f 1180 51.5015 (-0.14), f 1240 51.502 (-0.137)]
private def FORECOURT : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5004 (-0.14), f 1120 51.5008 (-0.14),
    f 1180 51.5012 (-0.14), f 1240 51.5016 (-0.14), f 1300 51.502 (-0.14),
    f 1360 51.5022 (-0.1391), f 1420 51.5024 (-0.1391)]

/-! ### `prepFor` — eligibility and the disc -/

private def prepOf (fx : Array PedFix) (a b : Int) : Option (Float × Float × Int) :=
  (prepFor (walkSeg a b) fx anySpeed).map fun p => (p.cLat, p.cLon, p.discRadiusM)

#guard prepOf WALKING 1000 1240 == some (51.501, -0.14, 231)
#guard prepOf CORNER 1000 1240 == some (51.501400000000004, -0.13866, 301)
#guard prepOf OFFROAD 1000 1240 == some (51.501, -0.1455, 231)
#guard prepOf SPIKED 1000 1240 == some (51.501099999999994, -0.14100000000000001, 400)
#guard prepOf SPIKED_TWICE 1000 1240 == some (51.501, -0.14200000000000002, 335)
#guard prepOf TELEPORTED 1000 1240 == some (51.504599999999996, -0.14, 631)
#guard prepOf TIGHT_FIXES 1000 1240 == some (51.501490000000004, -0.13862000000000002, 311)
#guard prepOf STRAGGLER 1000 1240 == some (51.501, -0.13940000000000002, 320)
#guard prepOf FORECOURT 1000 1420 == some (51.501325, -0.139775, 268)
-- Three fixes is below `MIN_LEG_FIXES`: the leg reads nothing at all.
#guard prepOf TOO_FEW 1000 1120 == none
-- …and so is four minus one excluded by the walking speed cap.
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then some 13 else some 4)).map (·.inWin.size) == some 4
#guard (prepFor (walkSeg 1000 1240) TOO_FEW
  (fun ts => if ts == 1060 then some 13 else some 4)) == none
-- `effectiveMode`, not `mode`: a leg refined TO walking is eligible…
#guard ((prepFor { startTs := 1000, endTs := 1240, mode := "driving", refinedMode := some "walking" }
  WALKING anySpeed).map (·.discRadiusM)) == some 231
-- …and one refined AWAY from walking is not.
#guard (prepFor { startTs := 1000, endTs := 1240, mode := "walking", refinedMode := some "driving" }
  WALKING anySpeed) == none
#guard (prepFor { startTs := 1000, endTs := 1240, mode := "driving" } WALKING anySpeed) == none
-- The window is CLOSED at both ends.
#guard (prepFor (walkSeg 1060 1240) WALKING anySpeed).map (·.inWin.size) == some 4
#guard (prepFor (walkSeg 1061 1240) WALKING anySpeed) == none

/-! ### The fix pipelines -/

private def tsOf (a : Array PedFix) : Array Int := a.map (·.ts)

#guard tsOf (despike WALKING) == #[1000, 1060, 1120, 1180, 1240]
#guard tsOf (despike SPIKED) == #[1000, 1060, 1180, 1240]
#guard tsOf (despike SPIKED_TWICE) == #[1000, 1120, 1240]
#guard tsOf (hold (despike WALKING)) == #[1000, 1060, 1120, 1180, 1240]
#guard tsOf (hold (despike SPIKED)) == #[1000, 1060, 1180, 1240]
-- The teleport survives despiking (it never returns) and is cut by the hold,
-- which keeps the LONGEST plausible run — here the far side, not the near one.
#guard tsOf (despike TELEPORTED) == #[1000, 1060, 1120, 1180, 1240]
#guard tsOf (hold (despike TELEPORTED)) == #[1120, 1180, 1240]
#guard tsOf (hold (despike STRAGGLER)) == #[1000, 1060, 1120, 1180]
-- Accuracy rides along both filters: it is the solvers' input, not the
-- despiker's.
#guard (despike SPIKED).map (·.accuracy) == #[some 10, some 10, some 10, some 10]

/-! ### The endpoint anchors -/

private def stayBefore : Seg :=
  { startTs := 600, endTs := 1000, mode := "stationary", centroidLat := some 51.4999,
    centroidLon := some (-0.1401) }

#guard ((evidenceFor #[stayBefore, walkSeg 1000 1240] 1 (some 330)).start.map
  fun a => (a.lat, a.lon, a.sigmaM)) == some (51.4999, -0.1401, 25)
#guard (evidenceFor #[stayBefore, walkSeg 1000 1240] 1 none).stepsWalked == none
#guard (evidenceFor #[walkSeg 1000 1240] 0 none).start.isNone

/-! ### The pass -/

/-- Accuracy is part of the key, so a pipeline that dropped it on the way to a
solver would stop matching. -/
private def wfKey (a : Array WalkFix) : Array (Float × Float × Float × Option Float) :=
  a.map fun w => (w.lat, w.lon, w.ts, w.accuracyM)
/-- The same key built from the FIXTURE rather than through the projection under
test, so a projection that dropped a field would not also drop it from the
expectation. -/
private def pedKey (a : Array PedFix) : Array (Float × Float × Float × Option Float) :=
  a.map fun p => (p.lat, p.lon, Float.ofInt p.ts, p.accuracy)

/-- The shell, with every stub discriminating on what it is handed: the matcher
on the DESPIKED fixes, the reconstruction on the HELD ones AND on the evidence,
the refinement on the despiked fixes AND on the base line. -/
private def mkEnv (ways : Ways) (key : Float × Float × Int)
    (cleanIn heldIn : Array PedFix) (m : Option MatchOut) (rec : Option (Array TPt))
    (refBase : Array Pt) (ref : Option (Array TPt)) : Env :=
  { walkableRoads := fun la lo r => if (la, lo, r) == key then ways else #[]
    buildingsNear := fun _ _ _ => #[]
    matcher := fun fx _ _ => if fx == cleanIn.map PedFix.pathPt then m else none
    reconstruct := fun fx _ _ ev =>
      if wfKey fx == pedKey heldIn && ev.stepsWalked.isNone then rec else none
    refineMatched := fun fx b =>
      if wfKey fx == pedKey cleanIn && b == refBase then ref else none
    correct := fun d _ _ _ => d
    snapPassages := fun d _ _ => d }

private def outOf (segs : Array Seg) : Array (Option (Array TPt) × Option (Array TPt)) :=
  segs.map fun s => (s.walkMatchedPath, s.walkSmoothedPath)

/-- Nothing attached — the leg draws as its existing raw rendering. -/
private def RAW : Array (Option (Array TPt) × Option (Array TPt)) := #[(none, none)]

-- ── the straight leg: the raw line already rides the network, so the gate has
-- nothing to improve and the reconstruction is the same length as the draw.
-- Nothing is despiked or held on this leg: `clean` and `held` are the window.
private def W_CLEAN : Array PedFix := WALKING
private def W_HELD : Array PedFix := WALKING
private def W_MATCH : MatchOut :=
  { path := #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1240],
    coarsePath := #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1240] }
private def W_RECON : Array TPt :=
  #[tp 51.5 (-0.14) 1000, tp 51.5005 (-0.14) 1060, tp 51.501 (-0.14) 1120,
    tp 51.5015 (-0.14) 1180, tp 51.502 (-0.14) 1240]
private def W_REFINED : Array TPt := W_RECON
private def envW : Env :=
  mkEnv STREETS (51.501, -0.14, 231) W_CLEAN W_HELD (some W_MATCH) (some W_RECON)
    (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed envW) == RAW
-- The reconstruction-primary arm draws the SAME reconstruction as a smoothed
-- line, because there is no gate on that path at all.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed envW [] .recon)
  == #[(none, some W_RECON)]
-- A reconstruction of one vertex is not a line: the recon arm falls back to the
-- held fixes, and with nothing else changed the leg keeps its raw rendering.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed
  (mkEnv STREETS (51.501, -0.14, 231) W_CLEAN W_HELD (some W_MATCH) (some #[tp 51.5 (-0.14) 1000])
    (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED)) [] .recon) == RAW
-- The whole pass off.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed envW [] .matcher
  { matchDisable := true }) == RAW
-- A leg whose ways come back empty reads no buildings and is left alone: the
-- key mismatch below IS the empty read.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed
  (mkEnv STREETS (51.501, -0.14, 999) W_CLEAN W_HELD (some W_MATCH) (some W_RECON)
    (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED))) == RAW
-- Two spikes leave three fixes: past the disc read, but under `MIN_LEG_FIXES`
-- for the matcher, so the leg bails after the OSM cost is already paid.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] SPIKED_TWICE anySpeed
  (mkEnv STREETS (51.501, -0.14200000000000002, 335) W_CLEAN W_HELD (some W_MATCH)
    (some W_RECON) (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED))) == RAW

-- ── the corner leg: the raw chord cuts the block, the match follows the
-- streets, the refinement does not reduce sharp turns, so the DRAWN line is the
-- matcher's fine path.
private def C_CLEAN : Array PedFix := CORNER
private def C_HELD : Array PedFix := CORNER
private def C_LINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1091, mp 51.502 (-0.137) 1240]
private def C_MATCH : MatchOut := { path := C_LINE, coarsePath := C_LINE }
private def C_REFINED : Array TPt :=
  #[tp 51.500316207202864 (-0.1400360761560773) 1000, tp 51.50095048008434 (-0.14) 1060,
    tp 51.502 (-0.14) 1094, tp 51.502 (-0.1387156089809791) 1120,
    tp 51.50197754222063 (-0.13786749534014986) 1180,
    tp 51.502022457779375 (-0.13701548976444897) 1240]
private def C_RECON : Array TPt :=
  #[tp 51.50000395536839 (-0.14000085031941317) 1000,
    tp 51.50067078515404 (-0.13926904128737683) 1060,
    tp 51.50133619246671 (-0.13853570205553722) 1120,
    tp 51.50199977659411 (-0.13780157104868454) 1180,
    tp 51.50266224806768 (-0.13706732692476112) 1240]
private def envC : Env :=
  mkEnv STREETS (51.501400000000004, -0.13866, 301) C_CLEAN C_HELD (some C_MATCH) (some C_RECON)
    (C_LINE.map PathPt.pt) (some C_REFINED)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envC)
  == #[(some (C_LINE), none)]
-- The refinement is offered and declined on its own terms (4 sharp turns
-- either side), so switching it off changes nothing here.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envC [] .matcher
  { refine := false }) == #[(some (C_LINE), none)]
-- The reconstruction is 358 m against a 430 m draw: shorter, but not by the
-- fraction the swap demands, so the matched line stands.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envC [] .matcher
  { recon := false }) == #[(some (C_LINE), none)]

-- ── the curved way: `path` carries the route's curve geometry, `coarsePath`
-- does not. The gate and the refinement read COARSE; the DRAW is FINE.
private def V_FINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.5005 (-0.1398) 1021, mp 51.501 (-0.1397) 1041,
    mp 51.5015 (-0.1398) 1061, mp 51.502 (-0.14) 1082, mp 51.502 (-0.137) 1240]
private def V_COARSE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.501 (-0.1397) 1041, mp 51.502 (-0.14) 1082,
    mp 51.502 (-0.137) 1240]
private def V_REFINED : Array TPt :=
  #[tp 51.500279640667564 (-0.13995280765459872) 1000,
    tp 51.50097369416754 (-0.139707891749736) 1060, tp 51.501 (-0.1397) 1061,
    tp 51.502 (-0.14) 1094, tp 51.502 (-0.13868557474337706) 1120,
    tp 51.50197754222063 (-0.13785539678737613) 1180,
    tp 51.502022457779375 (-0.13702015584838892) 1240]
private def V_RECON : Array TPt :=
  #[tp 51.500513238690104 (-0.14067746999633854) 1000,
    tp 51.501009877942124 (-0.1397199930358188) 1060,
    tp 51.501505667113534 (-0.13876139397729717) 1120,
    tp 51.50199885581964 (-0.1378031354745128) 1180,
    tp 51.50248971481124 (-0.13684561144259644) 1240]
private def envV : Env :=
  mkEnv CURVED (51.501400000000004, -0.13866, 301) C_CLEAN C_HELD
    (some { path := V_FINE, coarsePath := V_COARSE }) (some V_RECON)
    (V_COARSE.map PathPt.pt) (some V_REFINED)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envV)
  == #[(some (V_FINE), none)]

-- ── the tight staircase: the ONLY fixture where the refinement engages
-- (2 sharp turns against the coarse line's 3), and it replaces the fine path.
private def T_CLEAN : Array PedFix := TIGHT_FIXES
private def T_HELD : Array PedFix := TIGHT_FIXES
private def T_FINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1087, mp 51.502 (-0.138) 1120,
    mp 51.5021 (-0.138) 1139, mp 51.5022 (-0.1378) 1168, mp 51.5022 (-0.1377) 1180,
    mp 51.5022 (-0.1376) 1197, mp 51.5023 (-0.1374) 1240]
private def T_COARSE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1087, mp 51.502 (-0.138) 1120,
    mp 51.5021 (-0.138) 1139, mp 51.5023 (-0.1374) 1240]
private def T_REFINED : Array TPt :=
  #[tp 51.50029507106613 (-0.14003607613934627) 1000, tp 51.50099808742754 (-0.14) 1060,
    tp 51.502 (-0.14) 1092, tp 51.502 (-0.13863248303385617) 1120, tp 51.502 (-0.138) 1163,
    tp 51.502127430645515 (-0.13791770806343945) 1180,
    tp 51.50232018458471 (-0.1373841834299447) 1240]
private def T_RECON : Array TPt :=
  #[tp 51.50000405963558 (-0.14000064748058988) 1000,
    tp 51.50072014586875 (-0.13926188388175464) 1060,
    tp 51.50143477217978 (-0.1385219550819629) 1120,
    tp 51.502147483072676 (-0.13778234505722872) 1180,
    tp 51.50285884057231 (-0.1370435981621079) 1240]
private def envT : Env :=
  mkEnv TIGHT (51.501490000000004, -0.13862000000000002, 311) T_CLEAN T_HELD
    (some { path := T_FINE, coarsePath := T_COARSE }) (some T_RECON)
    (T_COARSE.map PathPt.pt) (some T_REFINED)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TIGHT_FIXES anySpeed envT)
  == #[(some T_REFINED, none)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TIGHT_FIXES anySpeed envT [] .matcher
  { refine := false }) == #[(some (T_FINE), none)]
-- The engagement test is STRICT: an equal count keeps the matched line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TIGHT_FIXES anySpeed
  (mkEnv TIGHT (51.501490000000004, -0.13862000000000002, 311) T_CLEAN T_HELD
    (some { path := T_FINE, coarsePath := T_COARSE }) (some T_RECON)
    (T_COARSE.map PathPt.pt) (some (T_COARSE))))
  == #[(some (T_FINE), none)]

-- ── the straggler: the matcher sees the DESPIKED fixes and draws out to the
-- 215 m hop; the reconstruction sees the HELD ones and draws the honest short
-- line. 167 m against 430 m clears both swap bars.
private def S_CLEAN : Array PedFix := STRAGGLER
-- The 215 m hop at 1240 is over the walking cap, so the hold drops it: the
-- reconstruction never sees the fix the matcher drew out to.
private def S_HELD : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1120 51.501 (-0.14), f 1180 51.5015 (-0.14)]
private def S_LINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1193, mp 51.502 (-0.137) 1240]
private def S_RECON : Array TPt :=
  #[tp 51.5 (-0.14) 1000, tp 51.5005 (-0.14) 1060, tp 51.501 (-0.14) 1120,
    tp 51.5015 (-0.14) 1180]
private def S_REFINED : Array TPt :=
  #[tp 51.5 (-0.14003607590577483) 1000, tp 51.5005 (-0.14003607630156562) 1060,
    tp 51.501 (-0.14) 1120, tp 51.502 (-0.14) 1156,
    tp 51.502 (-0.1389651990520854) 1180, tp 51.502 (-0.13803799492368768) 1240]
private def envS : Env :=
  mkEnv STREETS (51.501, -0.13940000000000002, 320) S_CLEAN S_HELD
    (some { path := S_LINE, coarsePath := S_LINE }) (some S_RECON)
    (S_LINE.map PathPt.pt) (some S_REFINED)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed envS)
  == #[(none, some S_RECON)]
-- The swap is the ONLY difference: switched off, the leg draws the matched line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed envS [] .matcher
  { recon := false }) == #[(some (S_LINE), none)]

-- ── the forecourt: the stray gate rejects (p85 = 66 m), but the raw line is
-- 62 m off-network and the match is 0 m off it, so the salvage splices the two.
-- The splice itself is the real Lean leaf, not a stub.
private def F_CLEAN : Array PedFix := FORECOURT
private def F_HELD : Array PedFix := FORECOURT
private def F_LINE : Array MPt := #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1300]
private def F_SPLICED : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.502 (-0.14) 1300, mp 51.5022 (-0.1391) 1360,
    mp 51.5024 (-0.1391) 1420]
private def F_RECON : Array TPt :=
  #[tp 51.50000124999124 (-0.13999993264865337) 1000,
    tp 51.500401850580886 (-0.14000012269364565) 1060,
    tp 51.500802001935526 (-0.14000043392822695) 1120,
    tp 51.501200590602735 (-0.14000076686252644) 1180,
    tp 51.50159578483107 (-0.1400002425033058) 1240,
    tp 51.50198554050018 (-0.13999660539205694) 1300,
    tp 51.50236929673723 (-0.13998716583136403) 1360,
    tp 51.50275053417979 (-0.13997434128438324) 1420]
private def envF : Env :=
  mkEnv MERIDIAN (51.501325, -0.139775, 268) F_CLEAN F_HELD
    (some { path := F_LINE, coarsePath := F_LINE }) (some F_RECON)
    -- The refinement's base is the SPLICED line, not the coarse one.
    (F_SPLICED.map PathPt.pt) none

-- The Lean splice agrees with V8's, vertex for vertex.
#guard spliceMatchedWithDivergentRuns (F_CLEAN.map PedFix.pathPt) F_LINE WALK_MATCH_MAX_STRAY_M
  == some F_SPLICED
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed envF)
  == #[(some (F_SPLICED), none)]

/-! ### The corrector and the passage snap

Both leaves are stubbed with synthetic edits here. What is under test is the
ORCHESTRATION — that a corrector-changed line attaches as `walkMatchedPath` even
though no match was used, that an unchanged one attaches nothing, that the snap
runs on the corrector's output rather than the corrector's input, and that the
step budget reaching the corrector is `steps × stride × slack`.
-/

private def OFF_HELD : Array PedFix := OFFROAD
private def OFF_RAW : Array TPt :=
  #[tp 51.5 (-0.1455) 1000, tp 51.5005 (-0.1455) 1060, tp 51.501 (-0.1455) 1120,
    tp 51.5015 (-0.1455) 1180, tp 51.502 (-0.1455) 1240]
private def BLOCK : Array Ring := #[#[pt 51.5 (-0.146), pt 51.5 (-0.1445), pt 51.502 (-0.1445), pt 51.502 (-0.146)]]
/-- The corrector's edit: every vertex nudged east onto the arcade. -/
private def OFF_FIXED : Array TPt := OFF_RAW.map fun p => { p with lon := -0.14512 }
/-- The snap's edit, applied to the CORRECTOR's output. -/
private def OFF_SNAPPED : Array TPt := OFF_FIXED.map fun p => { p with lat := p.lat + 0.00001 }

private def envOff (correct : Array TPt → Ways → Array Ring → Option Float → Array TPt)
    (snap : Array TPt → Ways → Array Ring → Array TPt) : Env :=
  { (mkEnv STREETS (51.501, -0.1455, 231) #[] OFF_HELD none none #[] none) with
      buildingsNear := fun la lo r => if (la, lo, r) == (51.501, -0.1455, 231) then BLOCK else #[]
      correct := correct
      snapPassages := snap }

-- The matcher bailed and the corrector changed nothing: the leg keeps its raw
-- rendering even though buildings were read.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ _ => d) (fun d _ _ => d))) == RAW
-- The corrector changed it: `walkMatchedPath`, with no match anywhere in sight.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ _ => OFF_FIXED) (fun d _ _ => d))) == #[(some OFF_FIXED, none)]
-- The snap runs LAST, on the corrector's output.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ _ => OFF_FIXED)
    (fun d _ _ => if d == OFF_FIXED then OFF_SNAPPED else d))) == #[(some OFF_SNAPPED, none)]
-- …and can attach a leg the corrector left alone.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ _ => d) (fun _ _ _ => OFF_SNAPPED))) == #[(some OFF_SNAPPED, none)]
-- Both leaves are behind one switch.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ _ => OFF_FIXED) (fun _ _ _ => OFF_SNAPPED)) [] .matcher
  { buildingEscape := false }) == RAW
-- A LENGTH change counts as changed even when every surviving vertex is where
-- it was: the test is `!==` on the count OR on any coordinate.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ _ => d.push (tp 51.502 (-0.1455) 1240)) (fun d _ _ => d)))
  == #[(some (OFF_RAW.push (tp 51.502 (-0.1455) 1240)), none)]
-- A `ts`-only change does NOT: the comparison reads lat/lon only.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ _ => d.map fun p => { p with ts := p.ts + 1 }) (fun d _ _ => d))) == RAW

/-- 330 steps in the window × 0.75 m stride × 1.4 slack. -/
private def STEPS : List StepPoint := [⟨1020, 100⟩, ⟨1080, 120⟩, ⟨1140, 110⟩]
private def budgetProbe : Env :=
  envOff (fun d _ _ b => if b == some 346.5 then OFF_FIXED else d) (fun d _ _ => d)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed budgetProbe STEPS)
  == #[(some OFF_FIXED, none)]
-- No step series at all: the factor is off, and `none` is not a budget of zero.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed budgetProbe []) == RAW
-- Steps outside the leg's window leave a budget of zero, which is still a
-- budget — the presence of rows for the day is what makes it one.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ b => if b == some 0 then OFF_FIXED else d) (fun d _ _ => d))
  [⟨1020, 0⟩]) == #[(some OFF_FIXED, none)]

/-! ### Two legs -/

-- Each leg reads its OWN disc, and a non-walking neighbour reads nothing.
#guard outOf (annotateWalkMatches
  #[{ startTs := 600, endTs := 1000, mode := "stationary" }, walkSeg 1000 1240]
  WALKING anySpeed envW) == #[(none, none), (none, none)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240, walkSeg 1000 1240] CORNER anySpeed envC)
  == #[(some (C_LINE), none), (some (C_LINE), none)]

/-! ### The haversine and the JS rounding

`metersBetween` feeds only two things — the disc radius (rounded to a metre) and
the swap's length comparison (never near its bars on a real leg) — so on a
walk-sized fixture the radius constant, the two cosines and the arcsine are all
below decision resolution. Pinned directly instead, at separations where each
is individually visible.
-/

#guard metersBetween 51.5 (-0.14) 51.502 (-0.14) == 222.38985328938924
#guard metersBetween 51.5 (-0.14) 51.5 (-0.137) == 207.66140805372413
#guard metersBetween 0 0 51.5 (-0.14) == 5726553.85059435
#guard metersBetween (-33.86) 151.21 51.5 (-0.14) == 16994374.324219495
-- Symmetric, which is what fixes the cosine PRODUCT rather than one factor.
#guard metersBetween 51.5 (-0.14) (-33.86) 151.21 == 16994374.324219495

-- `Math.round`: halves go towards +∞, so -0.5 rounds to zero and not to -1. A
-- haversine output never lands exactly on a half, so no leg fixture can see
-- this and it is asserted directly.
#guard jsRound 0.5 == 1.0
#guard jsRound 1.5 == 2.0
#guard jsRound (-0.5) == 0.0
#guard jsRound (-1.5) == (-1.0)
#guard jsRound 2.4999999999 == 2.0

/-! ### More of `prepFor` -/

-- The speed test is `≤`, so a fix AT the cap is kept.
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then some 12 else some 4)).map (·.inWin.size) == some 5
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then some 12.000000000000002 else some 4)).map (·.inWin.size) == some 4
-- A fix with NO speed row reads as zero — kept, not dropped. `?? 0`, not `?? cap`.
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then none else some 4)).map (·.inWin.size) == some 5

/-! ### The display gate reads the COARSE line

The forecourt leg again, but with a fine path that dives 41 m off the network
between the coarse line's two vertices. The gate's verdict on the two differs —
`matchedOffRoadM` 0 against 41.6 — and the salvage's ÷2 bar sits between them,
so which line the gate is handed decides whether the leg draws at all.
-/

private def F_FINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.501 (-0.1394) 1150, mp 51.502 (-0.14) 1300]
/-- The splice over the FINE line keeps its mid vertex: five, not four. -/
private def F_FINE_SPLICED : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.501 (-0.1394) 1150, mp 51.502 (-0.14) 1300,
    mp 51.5022 (-0.1391) 1360, mp 51.5024 (-0.1391) 1420]
/-- A straight line — no sharp turns at all, against the spliced line's two, so
it engages. Offered ONLY for the spliced base: a base that skipped the splice
gets nothing back and the leg draws the splice instead. -/
private def F_STRAIGHT : Array TPt :=
  #[tp 51.5 (-0.14) 1000, tp 51.501 (-0.14) 1150, tp 51.502 (-0.14) 1300]
private def envFF : Env :=
  { mkEnv MERIDIAN (51.501325, -0.139775, 268) F_CLEAN F_HELD
      (some { path := F_FINE, coarsePath := F_LINE }) none (F_SPLICED.map PathPt.pt) none with
      refineMatched := fun _ b =>
        if b == F_SPLICED.map PathPt.pt then some F_STRAIGHT else none }

#guard (matchImprovesDisplay ((F_CLEAN.map PedFix.pathPt).map PathPt.pt) (F_FINE.map PathPt.pt) MERIDIAN
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M).matchedOffRoadM == 41.57808528608979
#guard spliceMatchedWithDivergentRuns (F_CLEAN.map PedFix.pathPt) F_FINE WALK_MATCH_MAX_STRAY_M
  == some F_FINE_SPLICED
#guard countSharpTurns (F_SPLICED.map PathPt.pt) == 2
#guard countSharpTurns (F_STRAIGHT.map PathPt.pt) == 0
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed envFF)
  == #[(some F_STRAIGHT, none)]

/-! ### The salvage runs only when the gate REFUSED

Twelve fixes with a single 62 m outlier: p85 lands on a supported fix, so the
gate passes at stray 0 — and the splice would still have produced a line.
-/

private def ONEOFF : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1030 51.5002 (-0.14), f 1060 51.5004 (-0.14),
    f 1090 51.5006 (-0.14), f 1120 51.5008 (-0.14), f 1150 51.501 (-0.14),
    f 1180 51.5012 (-0.14), f 1210 51.5014 (-0.14), f 1240 51.5016 (-0.14),
    f 1270 51.5018 (-0.14), f 1300 51.502 (-0.14), f 1330 51.5021 (-0.1391)]
private def envOne : Env :=
  mkEnv MERIDIAN (51.50109166666667, -0.13992500000000005, 246) ONEOFF ONEOFF
    (some { path := F_LINE, coarsePath := F_LINE }) none (F_LINE.map PathPt.pt) none

#guard (matchImprovesDisplay ((ONEOFF.map PedFix.pathPt).map PathPt.pt) (F_LINE.map PathPt.pt) MERIDIAN
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M).use
#guard (spliceMatchedWithDivergentRuns (ONEOFF.map PedFix.pathPt) F_LINE
  WALK_MATCH_MAX_STRAY_M).isSome
#guard outOf (annotateWalkMatches #[walkSeg 1000 1330] ONEOFF anySpeed envOne)
  == #[(some (F_LINE), none)]

/-! ### The salvage's two bars

The forecourt leg with the matched line held a fixed distance off the meridian,
so `matchedOffRoadM` can be placed either side of the ÷2 bar; and a
parallel-way crossover, whose raw excursion is 30 m — past the needs-match bar
but under the ×2 one — so the rawOff bar is the sole blocker.
-/

private def OFFSET6 : Array MPt := #[mp 51.5 (-0.140086) 1000, mp 51.502 (-0.140086) 1300]
private def OFFSET6_SPLICED : Array MPt :=
  #[mp 51.5 (-0.140086) 1000, mp 51.502 (-0.140086) 1300, mp 51.5022 (-0.1391) 1360,
    mp 51.5024 (-0.1391) 1420]
private def OFFSET25 : Array MPt := #[mp 51.5 (-0.14036) 1000, mp 51.502 (-0.14036) 1300]

private def envOffset (line spliced : Array MPt) : Env :=
  mkEnv MERIDIAN (51.501325, -0.139775, 268) F_CLEAN F_HELD
    (some { path := line, coarsePath := line }) none (spliced.map PathPt.pt) none

-- 5.96 m off: inside the ÷2 bar, so the leg is salvaged.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed
  (envOffset OFFSET6 OFFSET6_SPLICED)) == #[(some (OFFSET6_SPLICED), none)]
-- 24.95 m off: outside it, and the leg draws nothing. A ×2 loosening would take
-- this one, which is what makes the bar's DIRECTION visible.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed
  (envOffset OFFSET25 #[])) == RAW

private def PARALLEL : Ways :=
  #[#[pt 51.5 (-0.14), pt 51.502 (-0.14), pt 51.504 (-0.14)],
    #[pt 51.5 (-0.13913), pt 51.504 (-0.13913)]]
private def CROSSOVER : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5004 (-0.14), f 1120 51.5008 (-0.14),
    f 1180 51.5012 (-0.14), f 1240 51.5016 (-0.14), f 1300 51.502 (-0.14),
    f 1360 51.5022 (-0.13913), f 1420 51.5026 (-0.13913)]
private def envCross : Env :=
  mkEnv PARALLEL (51.50135, -0.1397825, 271) CROSSOVER CROSSOVER
    (some { path := F_LINE, coarsePath := F_LINE }) none #[] none

-- The gate refuses on STRAY alone (64.3 m), the match is clean, and the raw
-- excursion is 30.1 m — under `2 × 18`, so the salvage stays out.
#guard (matchImprovesDisplay ((CROSSOVER.map PedFix.pathPt).map PathPt.pt) (F_LINE.map PathPt.pt)
  PARALLEL WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M).rawOffRoadM == 30.143384243249393
#guard (spliceMatchedWithDivergentRuns (CROSSOVER.map PedFix.pathPt) F_LINE
  WALK_MATCH_MAX_STRAY_M).isSome
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] CROSSOVER anySpeed envCross) == RAW

/-! ### The swap's two bars, separated

They can only be told apart on legs of a particular length: the fraction bar can
block alone only above ~600 m of drawn line, the absolute-drop bar only below
it. Both legs below have the matcher bail, so the drawn line is the raw one and
its length is the fixtures'.
-/

/-- 144.6 m against a 222.4 m draw: inside the fraction bar (0.65), outside the
absolute one (77.8 m short of 150). -/
private def SHORT_RECON : Array TPt := #[tp 51.5 (-0.14) 1000, tp 51.5013 (-0.14) 1240]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed
  (mkEnv STREETS (51.501, -0.14, 231) W_CLEAN W_HELD none (some SHORT_RECON) #[] none)) == RAW

private def LONGWALK : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1100 51.50175 (-0.14), f 1200 51.5035 (-0.14),
    f 1300 51.50525 (-0.14), f 1400 51.507 (-0.14)]
/-- 611.6 m against a 778.4 m draw: outside the fraction bar (0.786), inside the
absolute one (166.8 m shorter). The mirror image of the case above. -/
private def LONG_RECON : Array TPt := #[tp 51.5 (-0.14) 1000, tp 51.5055 (-0.14) 1400]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1400] LONGWALK anySpeed
  (mkEnv STREETS (51.503499999999995, -0.14, 509) LONGWALK LONGWALK none (some LONG_RECON) #[] none))
  == RAW
-- Both fixtures' drawn lengths, so the two bars' arithmetic is legible.
#guard pathLenM (W_HELD.map PedFix.pathPt) == 222.3898532893893
#guard pathLenM (LONGWALK.map PedFix.pathPt) == 778.3644865116772

/-! ### What the raw fallback draws, and what the corrector is handed

The corrector stub below ECHOES its input with every vertex nudged, so the
attached line reveals exactly which fix set reached it — the despiked one or
the held one, or none at all.
-/

private def nudge (d : Array TPt) : Array TPt := d.map fun p => { p with lon := p.lon + 0.001 }
/-- The three fixes the kinematic hold leaves of the teleported leg. -/
private def TELE_HELD : Array PedFix :=
  #[f 1120 51.507 (-0.14), f 1180 51.5075 (-0.14), f 1240 51.508 (-0.14)]
/-- The four the despiker leaves of the spiked one. -/
private def SPIKE_CLEAN : Array PedFix :=
  #[f 1000 51.5 (-0.14), f 1060 51.5005 (-0.14), f 1180 51.5015 (-0.14), f 1240 51.502 (-0.14)]
private def echoEnv (key : Float × Float × Int) : Env :=
  { mkEnv STREETS key #[] #[] none none #[] none with
      buildingsNear := fun la lo r => if (la, lo, r) == key then BLOCK else #[]
      correct := fun d _ _ _ => nudge d }

-- The matcher bailed: the drawn line is the HELD fixes, not the despiked ones.
-- On the teleported leg those differ — five against three.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  (echoEnv (51.504599999999996, -0.14, 631)))
  == #[(some (nudge (TELE_HELD.map PedFix.pathPt)), none)]
-- One spike: four fixes reach the corrector, not the window's five.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] SPIKED anySpeed
  (echoEnv (51.501099999999994, -0.14100000000000001, 400)))
  == #[(some (nudge (SPIKE_CLEAN.map PedFix.pathPt)), none)]
-- Two spikes leave three, and the bar is applied to the DESPIKED count, so the
-- leg bails even though the window held five.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] SPIKED_TWICE anySpeed
  (echoEnv (51.501, -0.14200000000000002, 335))) == RAW
-- The reconstruction arm's own fallback is the held fixes too.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed
  { echoEnv (51.501, -0.14, 231) with
      reconstruct := fun _ _ _ _ => some #[tp 51.5 (-0.14) 1000] } [] .recon)
  == #[(some (nudge (W_HELD.map PedFix.pathPt)), none)]
-- An empty building layer keeps both leaves out even when they would have
-- changed the line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with buildingsNear := fun _ _ _ => #[] }) == RAW
-- With the pass switched off the corner leg, which otherwise draws a match,
-- draws nothing.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envC [] .matcher
  { matchDisable := true }) == RAW

/-! ### The evidence reaches the reconstruction

`mkEnv`'s reconstruction answers only for an evidence record with NO step count,
so the guards above already fail if a step total leaks in. Here is the mirror:
a reconstruction that answers only WITH one.
-/

private def STEPS330 : List StepPoint := [⟨1020, 100⟩, ⟨1080, 120⟩, ⟨1140, 110⟩]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed
  { envS with reconstruct := fun _ _ _ ev =>
      if ev.stepsWalked == some 330 then some S_RECON else none } STEPS330)
  == #[(none, some S_RECON)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed
  { envS with reconstruct := fun _ _ _ ev =>
      if ev.stepsWalked == some 330 then some S_RECON else none })
  == #[(some (S_LINE), none)]

/-! ### The refinement is fed the DESPIKED fixes

On the straggler leg the despiked and held sets differ, so a refinement handed
the wrong one is visible: it declines, the matched line stands, and the swap
then takes the leg as a smoothed one instead.
-/

/-- Two vertices, no sharp turns at all — so it beats the matched line's one and
engages. Same length as the reconstruction, which keeps the swap out. -/
private def S_REFINED_ENG : Array TPt := #[tp 51.5 (-0.14) 1000, tp 51.5015 (-0.14) 1180]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed
  { envS with refineMatched := fun fx b =>
      if wfKey fx == pedKey S_CLEAN && b == S_LINE.map PathPt.pt
      then some S_REFINED_ENG else none })
  == #[(some S_REFINED_ENG, none)]

/-! ### The step budget

`none` is not a budget of zero: the corrector is handed `undefined` and falls
back to its own defaults.
-/

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with
      correct := fun d _ _ b => if b.isNone then nudge d else d })
  == #[(some (nudge (TELE_HELD.map PedFix.pathPt)), none)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with
      correct := fun d _ _ b => if b.isNone then nudge d else d } STEPS330) == RAW

/-! ### The remaining orchestration edges

Four decisions that no leg-shaped fixture above happens to reach: the raw
fallback INSIDE the matcher's else-branch (as opposed to its bail), a
reconstruction of a single vertex on the matcher arm, a corrector that SHORTENS
the line, and a leg whose ways came back empty.
-/

/-- A matched line 350 m west of every way: the gate refuses because the match
is FARTHER off-network than the raw line, not because of stray — so the leg
takes the else-branch's raw fallback rather than the matcher's bail. -/
private def S_BADLINE : Array MPt := #[mp 51.5 (-0.145) 1000, mp 51.5015 (-0.145) 1180]
private def envSBad : Env :=
  { mkEnv STREETS (51.501, -0.13940000000000002, 320) S_CLEAN S_HELD
      (some { path := S_BADLINE, coarsePath := S_BADLINE }) none #[] none with
      buildingsNear := fun la lo r =>
        if (la, lo, r) == (51.501, -0.13940000000000002, 320) then BLOCK else #[]
      correct := fun d _ _ _ => nudge d }

#guard !(matchImprovesDisplay ((S_CLEAN.map PedFix.pathPt).map PathPt.pt) (S_BADLINE.map PathPt.pt) STREETS
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M).use
-- Four vertices, not five: the fallback draws the HELD fixes.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed envSBad)
  == #[(some (nudge (S_HELD.map PedFix.pathPt)), none)]

-- A single-vertex reconstruction is not a line: the swap declines it even
-- though a zero-length line clears both of its bars trivially.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed
  { envS with reconstruct := fun _ _ _ _ => some #[tp 51.5 (-0.14) 1000] })
  == #[(some (S_LINE), none)]

-- A corrector that DROPS a vertex: every surviving vertex is where it was, so
-- only the length test sees the change. (In the TS the same test is what keeps
-- the coordinate scan from indexing past the end.)
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with correct := fun d _ _ _ => d.pop })
  == #[(some ((TELE_HELD.map PedFix.pathPt).pop), none)]

-- A leg whose ways came back empty is returned untouched even where the
-- corrector would have had something to say about its raw line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with walkableRoads := fun _ _ _ => #[] }) == RAW

/-! ### Deliberately unpinned

Three mutations survive every fixture above, and all three are vacuous rather
than unguarded. A fourth pair — the `ways.isEmpty` early return and the
conditional building read — is vacuous TOGETHER:

* **`maxDist`'s `>` against `≥`.** Both pick the same maximum; only the WITNESS
  would differ, and the witness is discarded.
* **The conditional `buildingsNear` read.** Making it unconditional changes an
  EFFECT — one extra query, one extra captured key — not a value: the leg whose
  ways came back empty returns before the building layer is looked at. The
  conditional is observable in the recording adapter's trace, which is shell.
* **The haversine's `min 1` clamp.** `h > 1` needs a floating-point overshoot at
  antipodal points; at 17 000 km, the widest separation on Earth's surface bar
  a few hundred km, `h` is still well under 1.
* **The `ways.isEmpty` early return.** Remove it and a ways-less leg runs the
  whole body — and still comes out unchanged, because the building read is
  short-circuited to `[]` (so neither corrector runs) and the display gate
  measures every line as 0 m off a network with no ways (so `use` cannot be
  true, and the salvage's `rawOff > 36` cannot hold either). The line it
  computes is discarded. It saves the work, and decides nothing.
-/

end Verified.Geo.WalkAnnotate
