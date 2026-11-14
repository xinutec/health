import Verified.Geo.SegmentMerge
import Verified.Geo.OsmCorridor
import Verified.Geo.WalkAnchors
import Verified.Geo.WalkSmooth
import Verified.Geo.DisplayGate
import Verified.Geo.EpisodeGeometry
import Verified.Geo.BiometricWindows
import Verified.JsNum
import Verified.FloatConst
/-!
# The walk-annotation pass

Attach a pavement-matched line to every walking leg the evidence can place. The
solvers (matcher, reconstruction, corner refinement, building corrector, passage
snap) are injected leaves with their own modules, as are the two OSM reads;
this module decides which legs are eligible, what disc each reads, which arm
draws, and the output shape. Every decision calls its real Lean leaf.

Three asymmetries the guards pin:

1. Decisions read `coarsePath`, the draw reads `path`: the gate, salvage and
   refinement test were tuned on the coarse line.
2. The matcher sees the despiked fixes (`clean`); the reconstruction sees the
   held ones (`held`, teleport runs collapsed), so a swap can dissolve an
   excursion the matcher drew.
3. The corrector and the passage snap share one gate, but the snap runs on the
   corrector's output and cannot perturb its decision.

Prefetch order is observable: every leg's `walkableRoads` read fires before any
`buildingsNear` read, which fires only after non-empty ways, so a fixture
replay sees exactly the captured keys.

UNPROVEN; the guards pin recorded reference values.
-/

namespace Verified.Geo.WalkAnnotate

open Verified.Geo.WalkableRoute (Pt Ways)
open Verified.Geo.OsmCorridor (Way)
open Verified.Geo.WalkEscape (Ring TPt BadnessCtx makeBadnessCtx pathBadnessM)
open Verified.Geo.WalkSmooth (WalkFix WalkEvidence countSharpTurns)
open Verified.Geo.DisplayGate (MPt matchImprovesDisplay spliceMatchedWithDivergentRuns)
open Verified.Geo.BiometricWindows (StepPoint stepsInWindow)

/-! ## Shapes -/

/-- A raw GPS fix as drawn — the same set the raw renderer uses. -/
structure PedFix where
  ts : Int
  lat : Float
  lon : Float
  /-- The phone's self-reported accuracy (m). `none` reaches the solvers as "no
  number", not as zero. -/
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
  /-- Arc length per way name along the route the Viterbi chose, in the
  matcher's own integer units; naming reads only relative weight, so the unit
  never converts. -/
  wayUm : Array (Option String × Nat) := #[]
  deriving Inhabited, BEq, Repr

/-- The walk corrector's switches; defaults are production's.

⚠ Not environment variables, whatever their names: nothing reads an env var
into this, and no day request carries it. The `#guard`s flip these fields. -/
structure Flags where
  matchDisable : Bool := false
  recon : Bool := true
  refine : Bool := true
  buildingEscape : Bool := true
  deriving Inhabited, BEq, Repr

/-- Which line the leg draws. `matcher` is production; `recon` is the
reconstruction-primary arm. -/
inductive Draw where
  | matcher
  | recon
  deriving Inhabited, BEq, Repr

/-! ## Remembering a walk's result

A walk's line is a function of its inputs (fixes, the roads and buildings for
its disc, step evidence, the cascade's name, arm and flags) and the code, so the
host keys it by a hash of those and the code version and draws it once. -/

/-- Two independently seeded 64-bit FNV-1a lanes over the inputs' exact bits. -/
structure MemoKey where
  a : UInt64 := 0xcbf29ce484222325
  b : UInt64 := 0x6c62272e07bb0142
  deriving Inhabited, BEq

namespace MemoKey
def u64 (k : MemoKey) (x : UInt64) : MemoKey :=
  { a := (k.a ^^^ x) * 0x100000001b3
    b := (k.b ^^^ (x * 0x9e3779b97f4a7c15)) * 0x00000100000001b3 }
def nat (k : MemoKey) (n : Nat) : MemoKey := (k.u64 n.toUInt64).u64 (n >>> 64).toUInt64
def int (k : MemoKey) (i : Int) : MemoKey := (k.u64 (if i < 0 then 1 else 0)).nat i.natAbs
def float (k : MemoKey) (x : Float) : MemoKey := k.u64 x.toBits
def bool (k : MemoKey) (b : Bool) : MemoKey := k.u64 (if b then 1 else 2)
def str (k : MemoKey) (s : String) : MemoKey :=
  s.toUTF8.foldl (fun k b => k.u64 b.toUInt64) (k.nat s.utf8ByteSize)
def opt {α : Type} (f : MemoKey → α → MemoKey) (k : MemoKey) : Option α → MemoKey
  | none => k.u64 0
  | some x => f (k.u64 1) x
def arr {α : Type} (f : MemoKey → α → MemoKey) (k : MemoKey) (xs : Array α) : MemoKey :=
  xs.foldl f (k.nat xs.size)
def pt (k : MemoKey) (p : Pt) : MemoKey := (k.float p.lat).float p.lon
private def hex16 (x : UInt64) : String :=
  let s := String.ofList (Nat.toDigits 16 x.toNat)
  String.ofList (List.replicate (16 - s.length) '0') ++ s
def render (k : MemoKey) : String := hex16 k.a ++ hex16 k.b
end MemoKey

/-- A walk's drawn result, as the three branches of the pass write it onto the
    segment. `apply` is those writes; the name falls back to the segment's own,
    so it is resolved where the patch lands, not where it was made. -/
inductive WalkPatch where
  | smoothed (drawn : Array TPt) (wayUm : Array (String × Nat))
  | matched (drawn : Array TPt) (name : Option String) (wayUm : Array (String × Nat))
  | plain (name : Option String) (wayUm : Array (String × Nat))
  deriving Inhabited, BEq, Repr

def WalkPatch.apply (seg : Seg) : WalkPatch → Seg
  | .smoothed drawn wayUm => { seg with walkSmoothedPath := some drawn, walkWayUm := wayUm }
  | .matched drawn name wayUm =>
    { seg with walkMatchedPath := some drawn, wayName := name.orElse (fun _ => seg.wayName),
               walkWayUm := wayUm }
  | .plain name wayUm =>
    { seg with wayName := name.orElse (fun _ => seg.wayName), walkWayUm := wayUm }

/-- The shell: the two OSM reads and the five solver leaves. -/
structure Env where
  /-- `osm.walkableRoads(lat, lon, radiusM)` as full way records, so the matcher
  can report the way it chose. `none` is a decline (no data for this disc), not
  `some #[]` (no road here). -/
  walkableRoads : Float → Float → Int → Option (Array Way)
  /-- `osm.buildingsNear(lat, lon, radiusM)`. Declines as `walkableRoads` does. -/
  buildingsNear : Float → Float → Int → Option (Array Ring)
  /-- The walk matcher. Its way-switch penalty is 0 nats, so names decide nothing
  about the line; they ride along for `MatchOut.wayUm`. -/
  matcher : Array MPt → Array Way → Array Ring → Option MatchOut
  /-- `reconstructWalk(fixes, { ways, buildings }, undefined, evidence)`. -/
  reconstruct : Array WalkFix → Ways → Array Ring → WalkEvidence → Option (Array TPt)
  /-- `refineMatchedPath(walkFixes, base)`. -/
  refineMatched : Array WalkFix → Array Pt → Option (Array TPt)
  /-- The building corrector, over the walk's one `BadnessCtx` (way and
  footprint grids), shared with the display gate and the passage snap. -/
  correct : Array TPt → BadnessCtx → Option Float → Array TPt
  /-- `snapPassages(drawn, { ways }, buildings)`, over the same context. -/
  snapPassages : Array TPt → BadnessCtx → Array TPt
  /-- A walk's remembered result by key, or `none`: the default, and what
  every replay answers, so a gate always draws. -/
  memoGet : String → Option WalkPatch := fun _ => none
  /-- Offer a freshly drawn result to the host; returns it unchanged. -/
  memoPut : String → WalkPatch → WalkPatch := fun _ p => p

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
/-- A match is refused when it stalls beyond this and draws more than the
pedometer justifies; neither half alone (see `matchImprovesDisplay`). Both are
fitted on the blessed floor: 200 m sits in an empty band above stall p98, and
1.5 separates in-budget high-stall walks from the detours. -/
def WALK_MATCH_MAX_STALL_M : Float := 200
/-- …and the drawn line must exceed the step budget by this factor. -/
def WALK_MATCH_MAX_BUDGET_RATIO : Float := 1.5
/-- The building-crossing metres a match must remove before the building ground
alone admits it: `segBadnessM`'s own sampling step, the smallest gain the metric
can resolve. -/
def WALK_MATCH_MIN_BUILDING_GAIN_M : Float := 2

/-- The reconstruction replaces the drawn line only when it is at most this
fraction of its length… -/
def RECON_SWAP_MAX_LEN_FRACTION : Float := 0.75
/-- …and at least this many metres shorter. Both must clear. -/
def RECON_SWAP_MIN_ABS_DROP_M : Float := 150
/-- The step-budget bar the corrector shares with the walk ratchet and the
reconstruction's step factor: steps × stride × slack. -/
def STEP_STRIDE_M : Float := 0.75
def STEP_SLACK_RATIO : Float := 1.4

/-! ## Local geometry -/

open Verified.FloatConst (pi)

/-- Great-circle metres. Not `WalkableRoute.metersBetween`: the two disagree
beyond the flat-earth approximation's error. -/
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
  for hm_i : i in [1 : pts.size] do
    have hb_i : i < pts.size := hm_i.upper
    total := total + metersBetween pts[i - 1].lat pts[i - 1].lon pts[i].lat pts[i].lon
  return total

open Verified.JsNum (jsRound)

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
    -- Sorted by `ts` after filtering. `displayFixes` arrives in order, so this
    -- is a no-op, but the order is the caller's, not an invariant to assume.
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

/-! ## The band around the track

A leg's disc read brings the whole neighbourhood, but nothing the drawing does
reaches beyond tens of metres of the track (the matcher ~150 m), so ways and
footprints outside `BAND_M` are dropped after the ask and before the memo key.
The chords are rasterised into `BAND_CELL_M` cells and dilated, and a way or
ring with any vertex in the band stays whole: a superset of the true band. Not
bit-exact; the corpus gate judges it. -/

/-- How far from the track a way or footprint is still read (m). -/
def BAND_M : Float := 300
/-- Side of a band cell (m). -/
def BAND_CELL_M : Float := 100

structure TrackBand where
  cellLat : Float
  cellLon : Float
  cells : Std.HashSet (Int × Int)

private def bandCell (lat lon cellLat cellLon : Float) : Int × Int :=
  ((Float.floor (lat / cellLat)).toInt64.toInt, (Float.floor (lon / cellLon)).toInt64.toInt)

/-- The cells within `BAND_M` of the track through `fixes` (and then some). -/
def trackBand (fixes : Array PedFix) : TrackBand := Id.run do
  let lat0 := (fixes.getD 0 default).lat
  let cellLat := BAND_CELL_M / 111320.0
  let cellLon := BAND_CELL_M / (111320.0 * Float.cos (lat0 * pi / 180))
  -- Cells to each side: the band in cells, plus one for the point's own cell
  -- and one for the half-cell rasterisation step.
  let r : Int := (Float.ceil (BAND_M / BAND_CELL_M)).toInt64.toInt + 1
  let mut cells : Std.HashSet (Int × Int) := {}
  for h : i in [0:fixes.size] do
    let a := fixes[i]'h.upper
    let b := fixes.getD (i + 1) a
    let steps := max 1 (Float.ceil (metersBetween a.lat a.lon b.lat b.lon / (BAND_CELL_M / 2)))
    let n := steps.toUInt64.toNat
    for k in [0:n + 1] do
      let f := k.toFloat / steps
      let (cy, cx) := bandCell (a.lat + (b.lat - a.lat) * f) (a.lon + (b.lon - a.lon) * f) cellLat cellLon
      let mut dy := -r
      while dy ≤ r do
        let mut dx := -r
        while dx ≤ r do
          cells := cells.insert (cy + dy, cx + dx)
          dx := dx + 1
        dy := dy + 1
  return { cellLat, cellLon, cells }

def TrackBand.holds (b : TrackBand) (p : Pt) : Bool :=
  b.cells.contains (bandCell p.lat p.lon b.cellLat b.cellLon)

/-- The ways with a vertex in the band; all of them when none has (a leg off
    every mapped way draws from what the disc gave, as before). -/
def waysInBand (b : TrackBand) (ways : Array Way) : Array Way :=
  let kept := ways.filter fun w => w.coords.any b.holds
  if kept.isEmpty then ways else kept

/-- The footprints with a vertex in the band. -/
def ringsInBand (b : TrackBand) (rings : Array Ring) : Array Ring :=
  rings.filter fun r => r.any b.holds

/-! ## The fix pipelines -/

open Verified.Geo (rejectSpikes holdSpeed)
open Verified.Geo.EpisodeGeometry (spikeAt speedOk)

private def PedFix.latLon (p : PedFix) : Verified.Geo.EpisodeGeometry.LatLon :=
  -- A captured fix's `ts` is a whole second; `LatLon.ts` is `Float` because
  -- derived vertices are fractional. Every Int in this range is exact.
  { lat := p.lat, lon := p.lon, ts := some (Float.ofInt p.ts) }
private def PedFix.rawFix (p : PedFix) : Verified.Geo.EpisodeGeometry.RawFix :=
  { ts := p.ts, lat := p.lat, lon := p.lon }

/-- `rejectSpikes` at `PedFix`, with the out-and-back predicate, so `accuracy`
rides along. -/
def despike (pts : Array PedFix) : Array PedFix :=
  (rejectSpikes (fun a b c => spikeAt a.latLon b.latLon c.latLon)
    (fun i => pts.getD i default) pts.size).toArray

/-- `holdImplausibleSpeed` at `PedFix`, at the walking cap. -/
def hold (pts : Array PedFix) : Array PedFix :=
  (holdSpeed (fun a b => speedOk WALK_SPEED_CAP_KMH a.rawFix b.rawFix)
    (fun i => pts.getD i default) pts.size).toArray

/-- Android reports a fix's accuracy as the radius of 68% confidence; under a
    2-D normal the radius of 95% is `√(−2 ln 0.05) / √(−2 ln 0.32)` ≈ 1.62 of it. -/
def ACCURACY_95_PER_68 : Float :=
  Float.sqrt (-2 * Float.log 0.05) / Float.sqrt (-2 * Float.log 0.32)
private def M_PER_DEG : Float := 111320
private def DEG_PER_HALF_TURN : Float := 180
private def F_ZERO : Float := 0
private def F_ONE : Float := 1

/-- How far `b` lies from the segment `a`–`c`, metres (local plane at `b`), and
    where it projects along `a`→`c` (`0` at `a`, `1` at `c`, unclamped). -/
def offChordM (a b c : PedFix) : Float × Float :=
  let cl := Float.cos (b.lat * Verified.FloatConst.pi / DEG_PER_HALF_TURN)
  let x := fun (p : PedFix) => (p.lon - b.lon) * M_PER_DEG * cl
  let y := fun (p : PedFix) => (p.lat - b.lat) * M_PER_DEG
  let (ax, ay, cx, cy) := (x a, y a, x c, y c)
  let dx := cx - ax
  let dy := cy - ay
  let len2 := dx * dx + dy * dy
  let dot := (F_ZERO - ax) * dx + (F_ZERO - ay) * dy
  let raw := if len2 > F_ZERO then dot / len2 else F_ZERO
  let t := max F_ZERO (min F_ONE raw)
  (Float.sqrt ((ax + t * dx) * (ax + t * dx) + (ay + t * dy) * (ay + t * dy)), raw)

/-- Drop a stray only its own noise explains: the least certain of itself and
    its two neighbours, off the line between them beyond either neighbour's 95%
    radius but within its own. Such a fix draws an out-and-back spur. A
    neighbour without an accuracy keeps the fix. -/
def dropUncertain (pts : Array PedFix) : Array PedFix :=
  if pts.size < 3 then pts else
  (Array.range pts.size).filterMap fun i =>
    let p := pts.getD i default
    if i == 0 || i + 1 == pts.size then some p else
    let a := pts.getD (i - 1) default
    let c := pts.getD (i + 1) default
    match p.accuracy, a.accuracy, c.accuracy with
    | some ap, some aa, some ac =>
      let (off, _) := offChordM a p c
      if ap > aa && ap > ac && off > ACCURACY_95_PER_68 * max aa ac
          && off ≤ ACCURACY_95_PER_68 * ap then none else some p
    | _, _, _ => some p

private def KMH_PER_MPS : Float := 3.6

/-- Whether reaching `b` from `a` is a walk even granting both fixes their whole
    stated error: the distance less both accuracies, over the time, within
    `WALK_SPEED_CAP_KMH`. A fix without an accuracy is no evidence either way. -/
def walkable (a b : PedFix) : Bool :=
  match a.accuracy, b.accuracy with
  | some aa, some ab =>
    let dt := Float.ofInt (b.ts - a.ts)
    if dt ≤ F_ZERO then true
    else
      let d := Verified.Geo.EpisodeGeometry.equirectMeters a.lat a.lon b.lat b.lon
      (d - aa - ab) / dt * KMH_PER_MPS ≤ WALK_SPEED_CAP_KMH
  | _, _ => true

/-- Hold the walk at its last fix past every fix it could not have walked to,
    errors granted (10-15 13:36: two fixes 250 m back at ~50 m accuracy, 13 s
    apart, drew the return 250 m back and the detour veto threw the match away). -/
def holdUnwalkable (pts : Array PedFix) : Array PedFix :=
  (holdSpeed walkable (fun i => pts.getD i default) pts.size).toArray

private def pf (lat lon acc : Float) (ts : Int) : PedFix := { ts, lat, lon, accuracy := some acc }
-- 10-15's corner: the 65 m fix 60 m back up the hill between fixes at 17 and
-- 11 m goes; the good fixes stay.
private def BACK : Array PedFix :=
  #[pf 51.565910 (-0.278826) 17 0, pf 51.566399 (-0.278427) 65 29, pf 51.565603 (-0.277717) 11 61]
#guard (dropUncertain BACK).map (·.ts) == #[0, 61]
-- A poor fix near the line between its neighbours carries the timing, and stays.
#guard (dropUncertain #[pf 51.5 (-0.1) 10 0, pf 51.5005 (-0.1002) 40 30, pf 51.501 (-0.1) 10 60]).size == 3
-- A precise fix off the line is evidence, and stays.
#guard (dropUncertain (BACK.modify 1 fun p => { p with accuracy := some 5 })).size == 3
-- A stray beyond the fix's own 95% radius stays: that is not its noise.
#guard (dropUncertain (BACK.modify 1 fun p => { p with accuracy := some 30 })).size == 3
#guard Float.abs (ACCURACY_95_PER_68 - 1.6215) < 1e-3
-- 10-15 13:36: 250 m in 15 s at 54 and 49 m is not a walk; 10 m in 3 s at 10 m is.
#guard !walkable (pf 51.562366 (-0.279642) 54 0) (pf 51.560043 (-0.279352) 49 15)
#guard walkable (pf 51.5 (-0.1) 10 0) (pf 51.50009 (-0.1) 10 3)
#guard walkable { ts := 0, lat := 51.5, lon := -0.1 } { ts := 1, lat := 51.6, lon := -0.1 }

private def PedFix.walkFix (p : PedFix) : WalkFix :=
  { lat := p.lat, lon := p.lon, ts := Float.ofInt p.ts, accuracyM := p.accuracy }
private def PedFix.pathPt (p : PedFix) : PathPt := ⟨p.lat, p.lon, Float.ofInt p.ts⟩

/-! ## The endpoint anchors -/

/-- `WalkSmooth`'s anchor from `WalkAnchors`'. Two records of the same three
fields in two modules, because the leaf that derives an anchor and the solver
that consumes one are separate ports. -/
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
or any vertex moved. Position only, not `ts`. -/
private def changed (before after : Array TPt) : Bool :=
  after.size != before.size
    || (after.zip before).any fun (a, b) => a.lat != b.lat || a.lon != b.lon

/-- One leg's drawn line under the reconstruction-primary arm. -/
private def drawRecon (env : Env) (ways : Ways) (buildings : Array Ring)
    (held : Array PedFix) (ev : WalkEvidence) : Array TPt × Bool :=
  match env.reconstruct (held.map PedFix.walkFix) ways buildings ev with
  | some recon => if recon.size ≥ 2 then (recon, true) else (held.map PedFix.pathPt, false)
  | none => (held.map PedFix.pathPt, false)

/-- The way the matcher's route ran along farthest (`MatchOut.wayUm`). Only
for naming a leg the cascade left unnamed; as a general naming rule it was
refuted (see `drawMatcher`). A tie keeps the first; `none` keeps the caller's
name. -/
def matchWayName (wayUm : Array (Option String × Nat)) : Option String :=
  (wayUm.foldl (init := (none : Option (String × Nat))) fun best p =>
    match p with
    | (some n, um) =>
      match best with
      | none => some (n, um)
      | some (_, bu) => if um > bu then some (n, um) else best
    | (none, _) => best).map (·.1)

#guard matchWayName #[] == none
-- A route entirely on unnamed ways names nothing, whatever its length.
#guard matchWayName #[(none, 900)] == none
-- The longest named run wins, not the longest run.
#guard matchWayName #[(some "Park Place", 100), (none, 900), (some "Queen's Walk", 400)]
  == some "Queen's Walk"
-- A tie keeps the first — route traversal order, deterministic.
#guard matchWayName #[(some "A", 100), (some "B", 100)] == some "A"

/-- The whole identity report for debugging: every named way the route ran
along with its weight (the matcher's unit, not metres), longest first. Unnamed
arcs are dropped; a tie keeps traversal order. -/
def wayUmReport (wayUm : Array (Option String × Nat)) : Array (String × Nat) :=
  let named := wayUm.filterMap fun (n, um) => n.map (·, um)
  -- A stable sort on a strict comparison: `>` alone would let a tie reorder.
  named.zipIdx.qsort (fun (a, i) (b, j) =>
    if a.2 == b.2 then i < j else a.2 > b.2) |>.map (·.1)

#guard wayUmReport #[] == #[]
-- Unnamed arcs are dropped, however long.
#guard wayUmReport #[(none, 900)] == #[]
-- Longest first, and an unnamed arc between two named ones does not reorder them.
#guard wayUmReport #[(some "Park Place", 100), (none, 900), (some "Queen's Walk", 400)]
  == #[("Queen's Walk", 400), ("Park Place", 100)]
-- The case `matchWayName` cannot see: a way carrying metres, but not the most.
#guard wayUmReport #[(some "Grosvenor Place", 700), (some "Queen's Walk", 3)]
  == #[("Grosvenor Place", 700), ("Queen's Walk", 3)]
#guard matchWayName #[(some "Grosvenor Place", 700), (some "Queen's Walk", 3)]
  == some "Grosvenor Place"
-- A tie keeps traversal order, so a diff between two runs means a real move.
#guard wayUmReport #[(some "A", 100), (some "B", 100)] == #[("A", 100), ("B", 100)]
-- The report's head is `matchWayName`, always — one fact, two shapes.
#guard ((wayUmReport #[(some "Park Place", 100), (none, 900), (some "Queen's Walk", 400)])[0]?.map
  (·.1)) == matchWayName #[(some "Park Place", 100), (none, 900), (some "Queen's Walk", 400)]

/-- One leg's line under the matcher arm: the display gate, the splice
salvage, the de-boxing refinement and the reconstruction swap. Returns the
line, whether a match or splice was used, whether the reconstruction replaced
it, the matcher's way name for a leg the cascade left unnamed, and the full
identity report even when the route is discarded. -/
private def drawMatcher (env : Env) (flags : Flags) (ways : Array Way) (buildings : Array Ring)
    (badCtx : BadnessCtx) (clean held : Array PedFix) (ev : WalkEvidence)
    (cascadeName : Option String) :
    Array TPt × Bool × Bool × Option String × Array (String × Nat) := Id.run do
  let geom : Ways := ways.map Way.coords
  -- The matcher follows every fix it is given, so it is given only the ones
  -- the walk could reach (`holdUnwalkable`); the raw line and the corrector
  -- keep their own sets.
  let fixes := (holdUnwalkable clean).map PedFix.pathPt
  let result := env.matcher fixes ways buildings
  -- The gate, the salvage and the refinement test consume `coarsePath`. The
  -- detour veto's witness is the pedometer: steps × stride × slack.
  let stepBudget := ev.stepsWalked.map (· * STEP_STRIDE_M * STEP_SLACK_RATIO)
  -- The building ground, measured on `coarsePath` too, so every clause judges
  -- the same line.
  let rawBuildingM := pathBadnessM (fixes.map PathPt.pt) badCtx
  let decision := result.map fun r =>
    matchImprovesDisplay (fixes.map PathPt.pt) (r.coarsePath.map PathPt.pt) geom
      WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M
      -- The finer display line: what the veto is judging is what gets drawn.
      (r.path.map PathPt.pt)
      stepBudget WALK_MATCH_MAX_STALL_M WALK_MATCH_MAX_BUDGET_RATIO
      rawBuildingM (pathBadnessM (r.coarsePath.map PathPt.pt) badCtx)
      WALK_MATCH_MIN_BUILDING_GAIN_M
  let mut useMatch := match decision with
    | some d => d.use
    | none => false
  -- Salvage-worthy only when the raw fallback is drastically off-network and
  -- the match is clean: a systematic parallel-way snap still rejects wholesale.
  let mut spliced : Option (Array MPt) := none
  -- The salvage honours the detour veto: a splice of a detoured match is a
  -- detour, and the raw line of a vetoed leg is badly off-network by design.
  if !useMatch && !(decision.map (·.detour) |>.getD false) then
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
  -- The identity report names a leg only when the cascade named it nothing.
  -- Stronger uses were refuted on the named-walk truths: the route rides
  -- squares, forecourts and underpasses a walk is not named after. A splice
  -- keeps raw geometry, so it names nothing. The report comes from `result`,
  -- so it shows the route even where the cascade's name was kept.
  let report := match result with
    | some r => wayUmReport r.wayUm
    | none => #[]
  let matchName :=
    match result, decision with
    | some r, some d =>
      if spliced.isNone && cascadeName.isNone && d.strayM ≤ WALK_MATCH_MAX_STRAY_M then
        matchWayName r.wayUm
      else none
    | _, _ => none
  -- The swap: a large fraction shorter and a wide absolute margin shorter. On
  -- an ordinary leg the reconstruction is ~the same length and nothing changes.
  if flags.recon then
    match env.reconstruct (held.map PedFix.walkFix) geom buildings ev with
    | some recon =>
      if recon.size ≥ 2 then
        let drawnLen := pathLenM drawn
        let reconLen := pathLenM recon
        if reconLen ≤ drawnLen * RECON_SWAP_MAX_LEN_FRACTION
            && drawnLen - reconLen ≥ RECON_SWAP_MIN_ABS_DROP_M then
          return (recon, useMatch, true, none, report)
    | none => pure ()
  return (drawn, useMatch, false, matchName, report)

/-- The key of one walk's result: every input the per-walk branch of
    `annotateWalkMatches` reads. The host adds the code version. -/
def walkMemoKey (draw : Draw) (flags : Flags) (inWin : Array PedFix) (ways : Array Way)
    (buildings : Array Ring) (stepsWalked : Option Float) (ev : WalkEvidence)
    (cascadeName : Option String) : String :=
  let anchor := fun (k : MemoKey) (a : Verified.Geo.WalkSmooth.WalkAnchor) =>
    ((k.float a.lat).float a.lon).float a.sigmaM
  let k : MemoKey := {}
  let k := k.u64 (match draw with | .matcher => 1 | .recon => 2)
  let k := (((k.bool flags.matchDisable).bool flags.recon).bool flags.refine).bool flags.buildingEscape
  let k := k.arr (fun k f => (((k.int f.ts).float f.lat).float f.lon).opt MemoKey.float f.accuracy) inWin
  let k := k.arr (fun k w =>
    (((k.int w.osmId).opt MemoKey.str w.name).opt MemoKey.str w.subtype).arr MemoKey.pt w.coords) ways
  let k := k.arr (fun k r => k.arr MemoKey.pt r) buildings
  let k := k.opt MemoKey.float stepsWalked
  let k := ((k.opt anchor ev.start).opt anchor ev.finish).opt MemoKey.float ev.stepsWalked
  let k := k.opt MemoKey.str cascadeName
  k.render

/-- One walk's drawing, from exactly the inputs `walkMemoKey` hashes: a new
    input must become an argument here and so a field of the key. `env`
    contributes code only, which the host versions by the binary. -/
def drawWalk (env : Env) (draw : Draw) (flags : Flags) (inWin : Array PedFix) (ways : Array Way)
    (buildings : Array Ring) (stepsWalked : Option Float) (ev : WalkEvidence)
    (cascadeName : Option String) : WalkPatch := Id.run do
  let clean := dropUncertain (despike inWin)
  let held := hold clean
  -- The walk's one badness context (way grid and footprint grid), for the
  -- display gate, the corrector and the passage snap alike. A thunk, so the
  -- recon arm without building escape never builds it.
  let badCtx : Thunk BadnessCtx := Thunk.mk fun _ => makeBadnessCtx (ways.map Way.coords) buildings {}
  let (drawn0, useMatch, smoothed0, matchName, wayUm) := match draw with
    | .recon =>
      -- The recon arm runs no matcher: an empty report means "not measured",
      -- not "the route named nothing".
      let (d, s) := drawRecon env (ways.map Way.coords) buildings held ev
      (d, false, s, none, #[])
    | .matcher => drawMatcher env flags ways buildings badCtx.get clean held ev cascadeName
  let mut drawn := drawn0
  let mut corrected := false
  if flags.buildingEscape && !buildings.isEmpty then
    let budget := stepsWalked.map (· * STEP_STRIDE_M * STEP_SLACK_RATIO)
    let fixed := env.correct drawn badCtx.get budget
    corrected := changed drawn fixed
    if corrected then drawn := fixed
    -- The passage snap runs last, on the final line, so it cannot
    -- perturb the gate's or the corrector's accept/reject decisions.
    let snapped := env.snapPassages drawn badCtx.get
    if changed drawn snapped then
      drawn := snapped
      corrected := true
  -- `walkWayUm` is attached on every branch, including those that discard
  -- the matcher's line, so it can show what the matcher wanted where it was
  -- overridden.
  if smoothed0 then
    return WalkPatch.smoothed drawn wayUm
  else if useMatch || corrected then
    -- When the full match ships, its own route names the leg; the corrector
    -- only escapes buildings locally. A route on no named way keeps the
    -- cascade's name.
    return WalkPatch.matched drawn matchName wayUm
  else
    return WalkPatch.plain matchName wayUm

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
  -- Every leg's ways read fires before any buildings read, which follows only
  -- non-empty ways. A declined ways read leaves the leg raw, as an empty one
  -- does; the host records the disc so it is fetched, not re-asked.
  let waysOf := prep.map fun p? => p?.bind fun p => env.walkableRoads p.cLat p.cLon p.discRadiusM
  -- A declined buildings read draws the leg as if there were no walls; the
  -- segment records it (`walkBuildingsMeasured`) so the referee skips walls.
  let buildingsOf := (prep.zip waysOf).map fun (p?, w?) =>
    match p?, w? with
    | some p, some w =>
      if w.isEmpty then some (#[], false)
      else match env.buildingsNear p.cLat p.cLon p.discRadiusM with
        | some b => some (b, true)
        | none => some (#[], false)
    | _, _ => none
  let mut out : Array Seg := #[]
  for hs : si in [0 : segments.size] do
    let seg := segments[si]'hs.upper
    -- The three tables are maps of `segments`; an entry missing reads as `none`.
    match (prep[si]?).bind id, (waysOf[si]?).bind id, (buildingsOf[si]?).bind id with
    | some p, some ways, some (buildings, measured) =>
      if ways.isEmpty then
        out := out.push seg
      else
        -- From here on a buildings read was made for this ground, and every
        -- branch below says so — including the ones that keep the raw line.
        let seg := { seg with walkBuildingsMeasured := some measured }
        let clean := dropUncertain (despike p.inWin)
        if clean.size < MIN_LEG_FIXES then
          out := out.push seg
        else
          -- The reconstruction starts from the fix set the raw renderer draws:
          -- without the teleport collapse, indoor jitter reaches the solver as
          -- consistent evidence.
          let stepsWalked := stepsInWindow stepPoints seg.startTs seg.endTs
          let ev := evidenceFor segments si stepsWalked
          -- Only the band around the track reaches the drawing (and the key).
          let band := trackBand p.inWin
          let ways := waysInBand band ways
          let buildings := ringsInBand band buildings
          -- Remembered, or drawn and offered to the host. A replay remembers
          -- nothing, so every gate draws.
          let key := walkMemoKey draw flags p.inWin ways buildings stepsWalked ev seg.wayName
          let patch : WalkPatch := match env.memoGet key with
            | some pt => pt
            | none => env.memoPut key
                (drawWalk env draw flags p.inWin ways buildings stepsWalked ev seg.wayName)
          out := out.push (patch.apply seg)
    | _, _, _ => out := out.push seg
  return out

/-! ## Guards

Reference numbers are recorded output at full precision, including the
centroid dust (`51.501099999999994`) that pins the summation order. The stubs
answer only the exact arguments the pass should pass (the disc, the despiked or
held fixes, the base line), so they pin what it passes.
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
/-- The same pair with the meridian bowed, so the route carries curve geometry
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
-- `effectiveMode`, not `mode`: a leg refined to walking is eligible…
#guard ((prepFor { startTs := 1000, endTs := 1240, mode := "driving", refinedMode := some "walking" }
  WALKING anySpeed).map (·.discRadiusM)) == some 231
-- …and one refined away from walking is not.
#guard (prepFor { startTs := 1000, endTs := 1240, mode := "walking", refinedMode := some "driving" }
  WALKING anySpeed) == none
#guard (prepFor { startTs := 1000, endTs := 1240, mode := "driving" } WALKING anySpeed) == none
-- The window is closed at both ends.
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
-- which keeps the longest plausible run — here the far side, not the near one.
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
/-- The same key built from the fixture rather than through the projection under
test, so a projection that dropped a field would not also drop it from the
expectation. -/
private def pedKey (a : Array PedFix) : Array (Float × Float × Float × Option Float) :=
  a.map fun p => (p.lat, p.lon, Float.ofInt p.ts, p.accuracy)

/-- The shell, with every stub discriminating on what it is handed: the matcher
on the despiked fixes, the reconstruction on the held ones and on the evidence,
the refinement on the despiked fixes and on the base line. -/
private def mkEnv (ways : Ways) (key : Float × Float × Int)
    (cleanIn heldIn : Array PedFix) (m : Option MatchOut) (rec : Option (Array TPt))
    (refBase : Array Pt) (ref : Option (Array TPt)) : Env :=
  -- The stub wraps plain geometry in anonymous `Way`s. Off-key answers
  -- `some #[]`, not `none`, so misses stay on the key path.
  { walkableRoads := fun la lo r =>
      some (if (la, lo, r) == key then ways.map (fun w => { osmId := 0, coords := w }) else #[])
    buildingsNear := fun _ _ _ => some #[]
    matcher := fun fx _ _ => if fx == cleanIn.map PedFix.pathPt then m else none
    reconstruct := fun fx _ _ ev =>
      if wfKey fx == pedKey heldIn && ev.stepsWalked.isNone then rec else none
    refineMatched := fun fx b =>
      if wfKey fx == pedKey cleanIn && b == refBase then ref else none
    correct := fun d _ _ => d
    snapPassages := fun d _ => d }

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
-- The reconstruction-primary arm draws the same reconstruction as a smoothed
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
-- key mismatch below is the empty read.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] WALKING anySpeed
  (mkEnv STREETS (51.501, -0.14, 999) W_CLEAN W_HELD (some W_MATCH) (some W_RECON)
    (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED))) == RAW
-- Two spikes leave three fixes: past the disc read, but under `MIN_LEG_FIXES`
-- for the matcher, so the leg bails after the OSM cost is already paid.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] SPIKED_TWICE anySpeed
  (mkEnv STREETS (51.501, -0.14200000000000002, 335) W_CLEAN W_HELD (some W_MATCH)
    (some W_RECON) (W_MATCH.coarsePath.map PathPt.pt) (some W_REFINED))) == RAW

-- ── the corner leg: the raw chord cuts the block, the match follows the
-- streets, the refinement does not reduce sharp turns, so the drawn line is the
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
-- does not. The gate and the refinement read coarse; the draw is fine.
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

-- ── the tight staircase: the only fixture where the refinement engages
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
-- The engagement test is strict: an equal count keeps the matched line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TIGHT_FIXES anySpeed
  (mkEnv TIGHT (51.501490000000004, -0.13862000000000002, 311) T_CLEAN T_HELD
    (some { path := T_FINE, coarsePath := T_COARSE }) (some T_RECON)
    (T_COARSE.map PathPt.pt) (some (T_COARSE))))
  == #[(some (T_FINE), none)]

-- ── the straggler: the matcher sees the despiked fixes and draws out to the
-- 215 m hop; the reconstruction sees the held ones and draws the honest short
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
-- The swap is the only difference: switched off, the leg draws the matched line.
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
    -- The refinement's base is the spliced line, not the coarse one.
    (F_SPLICED.map PathPt.pt) none

-- The Lean splice agrees with the reference, vertex for vertex.
#guard spliceMatchedWithDivergentRuns (F_CLEAN.map PedFix.pathPt) F_LINE WALK_MATCH_MAX_STRAY_M
  == some F_SPLICED
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed envF)
  == #[(some (F_SPLICED), none)]

/-! ### The corrector and the passage snap

Stubbed with synthetic edits: a corrector-changed line attaches though no match
was used, an unchanged one attaches nothing, the snap runs on the corrector's
output, and the corrector's budget is `steps × stride × slack`.
-/

private def OFF_HELD : Array PedFix := OFFROAD
private def OFF_RAW : Array TPt :=
  #[tp 51.5 (-0.1455) 1000, tp 51.5005 (-0.1455) 1060, tp 51.501 (-0.1455) 1120,
    tp 51.5015 (-0.1455) 1180, tp 51.502 (-0.1455) 1240]
private def BLOCK : Array Ring := #[#[pt 51.5 (-0.146), pt 51.5 (-0.1445), pt 51.502 (-0.1445), pt 51.502 (-0.146)]]
/-- The corrector's edit: every vertex nudged east onto the arcade. -/
private def OFF_FIXED : Array TPt := OFF_RAW.map fun p => { p with lon := -0.14512 }
/-- The snap's edit, applied to the corrector's output. -/
private def OFF_SNAPPED : Array TPt := OFF_FIXED.map fun p => { p with lat := p.lat + 0.00001 }

private def envOff (correct : Array TPt → BadnessCtx → Option Float → Array TPt)
    (snap : Array TPt → BadnessCtx → Array TPt) : Env :=
  { (mkEnv STREETS (51.501, -0.1455, 231) #[] OFF_HELD none none #[] none) with
      buildingsNear := fun la lo r =>
        some (if (la, lo, r) == (51.501, -0.1455, 231) then BLOCK else #[])
      correct := correct
      snapPassages := snap }

-- The matcher bailed and the corrector changed nothing: the leg keeps its raw
-- rendering even though buildings were read.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ => d) (fun d _ => d))) == RAW
-- The corrector changed it: `walkMatchedPath`, with no match anywhere in sight.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ => OFF_FIXED) (fun d _ => d))) == #[(some OFF_FIXED, none)]
-- The snap runs last, on the corrector's output.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ => OFF_FIXED)
    (fun d _ => if d == OFF_FIXED then OFF_SNAPPED else d))) == #[(some OFF_SNAPPED, none)]
-- …and can attach a leg the corrector left alone.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ => d) (fun _ _ => OFF_SNAPPED))) == #[(some OFF_SNAPPED, none)]
-- Both leaves are behind one switch.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun _ _ _ => OFF_FIXED) (fun _ _ => OFF_SNAPPED)) [] .matcher
  { buildingEscape := false }) == RAW
-- A length change counts as changed even when every surviving vertex is where
-- it was: the test is `!==` on the count or on any coordinate.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ => d.push (tp 51.502 (-0.1455) 1240)) (fun d _ => d)))
  == #[(some (OFF_RAW.push (tp 51.502 (-0.1455) 1240)), none)]
-- A `ts`-only change does not: the comparison reads lat/lon only.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ _ => d.map fun p => { p with ts := p.ts + 1 }) (fun d _ => d))) == RAW

/-- 330 steps in the window × 0.75 m stride × 1.4 slack. -/
private def STEPS : List StepPoint := [⟨1020, 100⟩, ⟨1080, 120⟩, ⟨1140, 110⟩]
private def budgetProbe : Env :=
  envOff (fun d _ b => if b == some 346.5 then OFF_FIXED else d) (fun d _ => d)

#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed budgetProbe STEPS)
  == #[(some OFF_FIXED, none)]
-- No step series at all: the factor is off, and `none` is not a budget of zero.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed budgetProbe []) == RAW
-- Steps outside the leg's window leave a budget of zero, which is still a
-- budget — the presence of rows for the day is what makes it one.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] OFFROAD anySpeed
  (envOff (fun d _ b => if b == some 0 then OFF_FIXED else d) (fun d _ => d))
  [⟨1020, 0⟩]) == #[(some OFF_FIXED, none)]

/-! ### Two legs -/

-- Each leg reads its own disc, and a non-walking neighbour reads nothing.
#guard outOf (annotateWalkMatches
  #[{ startTs := 600, endTs := 1000, mode := "stationary" }, walkSeg 1000 1240]
  WALKING anySpeed envW) == #[(none, none), (none, none)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240, walkSeg 1000 1240] CORNER anySpeed envC)
  == #[(some (C_LINE), none), (some (C_LINE), none)]

/-! ### The haversine and the rounding

`metersBetween` feeds only the disc radius and the swap's length comparison,
both below decision resolution on a walk-sized fixture, so it is pinned
directly.
-/

#guard metersBetween 51.5 (-0.14) 51.502 (-0.14) == 222.38985328938924
#guard metersBetween 51.5 (-0.14) 51.5 (-0.137) == 207.66140805372413
#guard metersBetween 0 0 51.5 (-0.14) == 5726553.85059435
#guard metersBetween (-33.86) 151.21 51.5 (-0.14) == 16994374.324219495
-- Symmetric, which is what fixes the cosine product rather than one factor.
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

-- The speed test is `≤`, so a fix at the cap is kept.
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then some 12 else some 4)).map (·.inWin.size) == some 5
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then some 12.000000000000002 else some 4)).map (·.inWin.size) == some 4
-- A fix with no speed row reads as zero — kept, not dropped. `?? 0`, not `?? cap`.
#guard (prepFor (walkSeg 1000 1240) WALKING
  (fun ts => if ts == 1120 then none else some 4)).map (·.inWin.size) == some 5

/-! ### The display gate reads the coarse line

The forecourt leg with a fine path diving 41 m off the network between the
coarse vertices: `matchedOffRoadM` is 0 against 41.6, and the salvage's ÷2 bar
sits between them.
-/

private def F_FINE : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.501 (-0.1394) 1150, mp 51.502 (-0.14) 1300]
/-- The splice over the fine line keeps its mid vertex: five, not four. -/
private def F_FINE_SPLICED : Array MPt :=
  #[mp 51.5 (-0.14) 1000, mp 51.501 (-0.1394) 1150, mp 51.502 (-0.14) 1300,
    mp 51.5022 (-0.1391) 1360, mp 51.5024 (-0.1391) 1420]
/-- A straight line — no sharp turns at all, against the spliced line's two, so
it engages. Offered only for the spliced base: a base that skipped the splice
gets nothing back and the leg draws the splice instead. -/
private def F_STRAIGHT : Array TPt :=
  #[tp 51.5 (-0.14) 1000, tp 51.501 (-0.14) 1150, tp 51.502 (-0.14) 1300]
private def envFF : Env :=
  { mkEnv MERIDIAN (51.501325, -0.139775, 268) F_CLEAN F_HELD
      (some { path := F_FINE, coarsePath := F_LINE }) none (F_SPLICED.map PathPt.pt) none with
      refineMatched := fun _ b =>
        if b == F_SPLICED.map PathPt.pt then some F_STRAIGHT else none }

#guard (matchImprovesDisplay ((F_CLEAN.map PedFix.pathPt).map PathPt.pt) (F_FINE.map PathPt.pt) MERIDIAN
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M (F_FINE.map PathPt.pt) none WALK_MATCH_MAX_STALL_M WALK_MATCH_MAX_BUDGET_RATIO).matchedOffRoadM == 41.57808528608979
#guard spliceMatchedWithDivergentRuns (F_CLEAN.map PedFix.pathPt) F_FINE WALK_MATCH_MAX_STRAY_M
  == some F_FINE_SPLICED
#guard countSharpTurns (F_SPLICED.map PathPt.pt) == 2
#guard countSharpTurns (F_STRAIGHT.map PathPt.pt) == 0
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] FORECOURT anySpeed envFF)
  == #[(some F_STRAIGHT, none)]

/-! ### The salvage runs only when the gate refused

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
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M (F_LINE.map PathPt.pt) none WALK_MATCH_MAX_STALL_M WALK_MATCH_MAX_BUDGET_RATIO).use
#guard (spliceMatchedWithDivergentRuns (ONEOFF.map PedFix.pathPt) F_LINE
  WALK_MATCH_MAX_STRAY_M).isSome
#guard outOf (annotateWalkMatches #[walkSeg 1000 1330] ONEOFF anySpeed envOne)
  == #[(some (F_LINE), none)]

/-! ### The salvage's two bars

The forecourt leg with the matched line held off the meridian, placing
`matchedOffRoadM` either side of the ÷2 bar; and a parallel-way crossover whose
30 m raw excursion leaves the rawOff bar as the sole blocker.
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
-- this one, which is what makes the bar's direction visible.
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

-- The gate refuses on stray alone (64.3 m), the match is clean, and the raw
-- excursion is 30.1 m — under `2 × 18`, so the salvage stays out.
#guard (matchImprovesDisplay ((CROSSOVER.map PedFix.pathPt).map PathPt.pt) (F_LINE.map PathPt.pt)
  PARALLEL WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M (F_LINE.map PathPt.pt) none WALK_MATCH_MAX_STALL_M WALK_MATCH_MAX_BUDGET_RATIO).rawOffRoadM == 30.143384243249393
#guard (spliceMatchedWithDivergentRuns (CROSSOVER.map PedFix.pathPt) F_LINE
  WALK_MATCH_MAX_STRAY_M).isSome
#guard outOf (annotateWalkMatches #[walkSeg 1000 1420] CROSSOVER anySpeed envCross) == RAW

/-! ### The swap's two bars, separated

The fraction bar can block alone only above ~600 m of drawn line, the
absolute-drop bar only below. Both legs have the matcher bail, so the drawn
line is the raw one.
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

The corrector stub nudges every vertex, so the attached line shows which fix
set reached it.
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
      buildingsNear := fun la lo r => some (if (la, lo, r) == key then BLOCK else #[])
      correct := fun d _ _ => nudge d }

-- The matcher bailed: the drawn line is the held fixes, not the despiked ones.
-- On the teleported leg those differ — five against three.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  (echoEnv (51.504599999999996, -0.14, 631)))
  == #[(some (nudge (TELE_HELD.map PedFix.pathPt)), none)]
-- One spike: four fixes reach the corrector, not the window's five.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] SPIKED anySpeed
  (echoEnv (51.501099999999994, -0.14100000000000001, 400)))
  == #[(some (nudge (SPIKE_CLEAN.map PedFix.pathPt)), none)]
-- Two spikes leave three, and the bar is applied to the despiked count, so the
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
  { echoEnv (51.504599999999996, -0.14, 631) with buildingsNear := fun _ _ _ => some #[] }) == RAW
-- With the pass switched off the corner leg, which otherwise draws a match,
-- draws nothing.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] CORNER anySpeed envC [] .matcher
  { matchDisable := true }) == RAW

/-! ### The evidence reaches the reconstruction

`mkEnv`'s reconstruction answers only without a step count; this one answers
only with one.
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

/-! ### The refinement is fed the despiked fixes

On the straggler leg the two sets differ: a refinement handed the wrong one
declines, and the swap takes the leg as smoothed.
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
      correct := fun d _ b => if b.isNone then nudge d else d })
  == #[(some (nudge (TELE_HELD.map PedFix.pathPt)), none)]
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with
      correct := fun d _ b => if b.isNone then nudge d else d } STEPS330) == RAW

/-! ### The remaining orchestration edges

The raw fallback inside the matcher's else-branch, a one-vertex reconstruction
on the matcher arm, a corrector that shortens the line, and a leg whose ways
came back empty.
-/

/-- A matched line 350 m west of every way: the gate refuses because the match
is farther off-network than the raw line, not because of stray — so the leg
takes the else-branch's raw fallback rather than the matcher's bail. -/
private def S_BADLINE : Array MPt := #[mp 51.5 (-0.145) 1000, mp 51.5015 (-0.145) 1180]
private def envSBad : Env :=
  { mkEnv STREETS (51.501, -0.13940000000000002, 320) S_CLEAN S_HELD
      (some { path := S_BADLINE, coarsePath := S_BADLINE }) none #[] none with
      buildingsNear := fun la lo r =>
        some (if (la, lo, r) == (51.501, -0.13940000000000002, 320) then BLOCK else #[])
      correct := fun d _ _ => nudge d }

#guard !(matchImprovesDisplay ((S_CLEAN.map PedFix.pathPt).map PathPt.pt) (S_BADLINE.map PathPt.pt) STREETS
  WALK_NEEDS_MATCH_M WALK_MATCH_MAX_STRAY_M (S_BADLINE.map PathPt.pt) none WALK_MATCH_MAX_STALL_M WALK_MATCH_MAX_BUDGET_RATIO).use
-- Four vertices, not five: the fallback draws the held fixes.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed envSBad)
  == #[(some (nudge (S_HELD.map PedFix.pathPt)), none)]

-- A single-vertex reconstruction is not a line: the swap declines it even
-- though a zero-length line clears both of its bars trivially.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] STRAGGLER anySpeed
  { envS with reconstruct := fun _ _ _ _ => some #[tp 51.5 (-0.14) 1000] })
  == #[(some (S_LINE), none)]

-- A corrector that drops a vertex: every surviving vertex is where it was, so
-- only the length test sees the change.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with correct := fun d _ _ => d.pop })
  == #[(some ((TELE_HELD.map PedFix.pathPt).pop), none)]

-- A leg whose ways came back empty is returned untouched even where the
-- corrector would have had something to say about its raw line.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with walkableRoads := fun _ _ _ => some #[] }) == RAW

-- A declined ways read leaves it raw too: nothing to draw from, and never a
-- leg drawn from roads nobody looked up.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with walkableRoads := fun _ _ _ => none }) == RAW

-- A declined building read takes the empty-layer path: the leg stays eligible
-- and only the wall leaves stay out. Refusing the leg would blank most walks,
-- since the building layer is the mirror's thinnest.
#guard outOf (annotateWalkMatches #[walkSeg 1000 1240] TELEPORTED anySpeed
  { echoEnv (51.504599999999996, -0.14, 631) with buildingsNear := fun _ _ _ => none }) == RAW

/-! ### Deliberately unpinned

Four mutations survive every fixture, each vacuous:

* `maxDist`'s `>` against `≥`: same maximum, only the discarded witness differs.
* The conditional `buildingsNear` read: unconditional costs one query (visible
  in the shell's trace) but a ways-less leg returns before reading it.
* The haversine's `min 1` clamp: `h` stays well under 1 even at 17 000 km.
* The `ways.isEmpty` early return: without it the body runs and still changes
  nothing (no walls, every line 0 m off an empty network). It saves work.
-/

end Verified.Geo.WalkAnnotate
