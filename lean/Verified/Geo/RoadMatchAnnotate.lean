import Verified.Geo.OsmCorridor
import Verified.Geo.DisplayGate
import Verified.Geo.EpisodeGeometry
import Verified.Geo.ModeBiometrics

/-!
# The road-match pass (port of `annotateRoadMatches`, `src/geo/road-match-annotate.ts`)

Attach a street-matched geometry to every road-vehicle leg the matcher can
confidently place. Purely ADDITIVE: it never rewrites the mode or the raw fixes,
only adds `matchedPath` for the map to draw instead of the raw polyline.

Like the walk pass this is an ORCHESTRATOR, and what is unpinned is everything
between the leaves: which legs are eligible, which fixes reach the matcher, what
the leg reads from the mirror, and whether the drawn line changes.

## What is injected, and what is not

The **matcher** is injected. Its Lean counterpart is `Verified.Geo.Match`'s
`qMatchRoadSegment`, the QUANTISED arm, which is measured and ceilinged against
the TS rather than bit-identical to it (#395 / #403); wiring it in directly
would make these guards assert the ceiling instead of the orchestration. The
**mirror read** is injected for the usual reason: it is the shell.

Everything the pass DECIDES with is the real Lean leaf — the spike rejection
(`Verified.Geo.rejectSpikes` under `EpisodeGeometry.spikeAt`), the speed cap
(`ModeBiometrics.MAX_SPEED_FOR_MODE`), the corridor fetch
(`Verified.Geo.OsmCorridor`) and the display gate
(`Verified.Geo.DisplayGate.matchImprovesDisplay`). Only the two shell values are
stubs.

## The read trace is strictly leg-by-leg

Unlike the walk pass, which fires every eligible leg's read up front so the DB
round-trips overlap, this pass is a plain sequential `for … await`: leg *i*'s
reads all happen before leg *i+1*'s. A leg that bails before the fetch — wrong
mode, or under `MIN_LEG_FIXES` after the cap filter and despike — reads
NOTHING, so its absence from the trace is itself pinned.

## Three asymmetries the guards pin

1. **The cap filter is per-mode and mostly absent.** `MAX_SPEED_FOR_MODE` has no
   entry for `driving` or `bus`, so those legs keep every in-window fix however
   fast; only `cycling` is capped, at 35 km/h. The filter runs BEFORE the
   despike, so a fast outlier is removed by the cap rather than surviving as a
   spike.
2. **The matcher and the gate see the same fixes but different objects.** The
   matcher gets the despiked fixes WITH timestamps; the gate compares the raw
   drawn line against the matched line as bare coordinates. A match that keeps
   the geometry but moves the times cannot change the gate's verdict.
3. **`ways.length === 0` bails before the matcher.** An empty corridor is not
   "the matcher found nothing" — it never runs, which is why a leg over
   unmapped ground makes exactly one read and no match attempt.

The `ROAD_MATCH_DEBUG` branch is a `console.error` diagnostic with no effect on
the returned segments and is not modelled.

UNPROVEN; pinned against Node/V8 (`lean/experiments/road-match-annotate-refs.mts`).
-/

namespace Verified.Geo.RoadMatchAnnotate

open Verified.Geo (rejectSpikes)
open Verified.Geo.WalkableRoute (Pt)
open Verified.Geo.DisplayGate (MPt Ways matchImprovesDisplay)
open Verified.Geo.OsmCorridor (Way corridorWays)
open Verified.Geo.EpisodeGeometry (Fix LatLon spikeAt)

/-! ## Shapes -/

/-- A `DayStateMode`, kept as `String` for the same reason the sibling geo
modules do. -/
abbrev Mode := String

/-- The `EnrichedSegment` fields this pass reads, plus the one it writes. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  /-- The street-matched display line. `none` is the TS `undefined`: the map
  falls back to the raw track. -/
  matchedPath : Option (Array MPt) := none
  deriving Inhabited, BEq, Repr

/-- The shell: the mirror read and the matcher. -/
structure Env where
  /-- `osm.drivableRoads(lat, lon, radiusM)`. -/
  drivableRoads : Float → Float → Float → Array Way
  /-- `matchRoadSegment(fixes, { ways })` — `none` is the TS `null`, i.e. "draw
  the raw fixes". -/
  matcher : Array MPt → Array Way → Option (Array MPt)

/-! ## Constants -/

/-- Effective modes drawn as a raw road polyline today. A SEPARATE literal from
`EpisodeGeometry.ROAD_MATCH_MODES`, as in the TS, where the two agree by
intent rather than by sharing a definition. -/
def ROAD_MODES : List Mode := ["driving", "bus", "cycling"]

/-- Below this many in-window fixes a leg is too sparse to map-match. -/
def MIN_LEG_FIXES : Nat := 4

/-- Corridor sampling for the street-network read. STEP ≈ 2× the disc radius is
the cost optimum; the disc is `drivableRoads`'s own box, wider than the
matcher's reach, so the union is output-identical to a single centroid disc. -/
def ROAD_SAMPLE_STEP_M : Float := 700
def ROAD_SAMPLE_RADIUS_M : Float := 50

/-- The raw drawn line must stray at least this far off the network before a
match is worth having… -/
def NEEDS_MATCH_M : Float := 25
/-- …and the match must stay within this (p85) of the fixes, which is what
rejects a snap onto a far parallel road. -/
def MATCH_MAX_STRAY_M : Float := 40

/-! ## The pieces -/

/-- `refinedMode ?? mode` — `segment-util.ts`'s `effectiveMode`. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Fixes inside a segment's window, INCLUSIVE both ends
(`segment-util.ts`'s `samplesInWindow`). -/
def samplesInWindow (points : Array Fix) (startTs endTs : Int) : Array Fix :=
  points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/-- `MAX_SPEED_FOR_MODE[mode]` — absent for `driving` and `bus`, which is why
those legs keep every in-window fix. -/
def speedCapFor (mode : Mode) : Option Float :=
  (Verified.Geo.ModeBiometrics.MAX_SPEED_FOR_MODE.find? fun p => p.1 == mode).map (·.2)

/-- The generic `rejectSpikes` at this pass's fix type, under
`EpisodeGeometry`'s spike predicate. The whole fix survives — the matcher needs
the timestamps, so this cannot go through `LatLon`. -/
def despike (pts : Array Fix) : Array Fix :=
  (rejectSpikes
    (fun p c n =>
      spikeAt { lat := p.lat, lon := p.lon } { lat := c.lat, lon := c.lon }
        { lat := n.lat, lon := n.lon })
    (fun i => pts.getD i default) pts.size).toArray

/-! ## The pass -/

/--
Attach `matchedPath` to every road-vehicle segment whose leg the matcher can
confidently place. Returns a new segment array; the input is not mutated. The
state is the mirror read trace, in call order.
-/
def annotateRoadMatchesTraced (env : Env) (segments : Array Seg) (points : Array Fix) :
    Verified.Geo.OsmCorridor.TraceM (Array Seg) := do
  let mut out : Array Seg := #[]
  for seg in segments do
    let mode := effectiveMode seg
    if !ROAD_MODES.contains mode then
      out := out.push seg
    else
      -- Match the same fixes the map would draw: speed-plausible window fixes
      -- with lone teleport spikes dropped, so a fast neighbour's tail cannot
      -- drag the match.
      let windowFixes := samplesInWindow points seg.startTs seg.endTs
      let plausible := match speedCapFor mode with
        | none => windowFixes
        | some cap => windowFixes.filter fun p => p.speedKmh ≤ cap
      let clean := despike plausible
      if clean.size < MIN_LEG_FIXES then
        out := out.push seg
      else
        let ways ← corridorWays env.drivableRoads
          (clean.map fun p => ({ lat := p.lat, lon := p.lon } : Pt))
          ROAD_SAMPLE_STEP_M ROAD_SAMPLE_RADIUS_M
        if ways.isEmpty then
          out := out.push seg
        else
          let fixes := clean.map fun p =>
            ({ lat := p.lat, lon := p.lon, ts := Float.ofInt p.ts } : MPt)
          match env.matcher fixes ways with
          | none => out := out.push seg
          | some path =>
            -- Match first, then decide on the DRAWN line.
            let d := matchImprovesDisplay (fixes.map MPt.pt) (path.map MPt.pt)
              (ways.map (·.coords)) NEEDS_MATCH_M MATCH_MAX_STRAY_M
            out := out.push (if d.use then { seg with matchedPath := some path } else seg)
  return out

/-- `annotateRoadMatchesTraced` with the read trace discarded. -/
def annotateRoadMatches (env : Env) (segments : Array Seg) (points : Array Fix) : Array Seg :=
  (annotateRoadMatchesTraced env segments points).run' #[]

/-- The read trace alone. -/
def readsOf (env : Env) (segments : Array Seg) (points : Array Fix) :
    Array Verified.Geo.OsmCorridor.Read :=
  ((annotateRoadMatchesTraced env segments points).run #[]).2

/-! ## Guards (V8 reference values)

Every number below is `lean/experiments/road-match-annotate-refs.mts`'s output
on the same fixture, transcribed at V8's own precision.

The two shell values are ORACLE TABLES, not stubs that re-derive an answer.
`stubRoads` holds every `(lat, lon, radius)` the V8 arm was actually asked
about; `stubMatcher` holds every fix array the V8 matcher was actually handed.
A query outside either table is a query this arm never made: the roads table
answers EMPTY and the matcher table answers `MISS`, an off-Africa vertex that
no output guard can accept. Neither can silently agree with a wrong caller.
-/

section Guards

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def p (la lo : Float) : Pt := ⟨la, lo⟩
private def m (la lo ts : Float) : MPt := ⟨la, lo, ts⟩
private def fx (ts : Int) (la lo sp : Float) : Fix := ⟨ts, la, lo, sp⟩
private def sg (a b : Int) (mode : Mode) (refined : Option Mode := none) : Seg :=
  { startTs := a, endTs := b, mode := mode, refinedMode := refined }
private def approxRead (a b : Verified.Geo.OsmCorridor.Read) : Bool :=
  approx a.lat b.lat && approx a.lon b.lon && approx a.radiusM b.radiusM
private def approxReads (a b : Array Verified.Geo.OsmCorridor.Read) : Bool :=
  a.size == b.size && (Array.range a.size).all fun i => approxRead a[i]! b[i]!
private def r (la lo rad : Float) : Verified.Geo.OsmCorridor.Read := ⟨la, lo, rad⟩
private def approxM (a b : MPt) : Bool :=
  approx a.lat b.lat && approx a.lon b.lon && approx a.ts b.ts
private def approxPath : Option (Array MPt) → Option (Array MPt) → Bool
  | none, none => true
  | some a, some b => a.size == b.size && (Array.range a.size).all fun i => approxM a[i]! b[i]!
  | _, _ => false
private def approxOut (a b : Array Seg) : Bool :=
  a.size == b.size && (Array.range a.size).all fun i =>
    a[i]!.startTs == b[i]!.startTs && a[i]!.endTs == b[i]!.endTs
      && a[i]!.mode == b[i]!.mode && a[i]!.refinedMode == b[i]!.refinedMode
      && approxPath a[i]!.matchedPath b[i]!.matchedPath

private def wy (id : Int) (name subtype : String) (cs : Array Pt) : Way :=
  { osmId := id, name := some name, subtype := some subtype, coords := cs }

private structure RoadsEntry where
  lat : Float
  lon : Float
  radiusM : Float
  ways : Array Way

/-- Every `(lat, lon, radius)` the V8 arm was asked about, with its answer.
A query this table does not hold is a query the reference arm never made —
it comes back EMPTY, which shows up as a leg that bails. -/
private def ROADS : Array RoadsEntry := #[
  { lat := 51.501317523056656, lon := (-0.1363322829128949), radiusM := 443.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.5, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.506288178224935, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] }] },
  { lat := 51.51257635644988, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 4, name := some "Cross Street", subtype := some "residential", coords := #[p 51.51257635644988 (-0.14432910869297655), p 51.51257635644988 (-0.14), p 51.51257635644988 (-0.13567089130702348)] },
      { osmId := 4, name := some "Cross Street (dup record)", subtype := some "residential", coords := #[p 51.514372978799855 (-0.14), p 51.514372978799855 (-0.13567089130702348)] }] },
  { lat := 51.51886453467481, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] }] },
  { lat := 51.52515271289975, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] }] },
  { lat := 51.530542579949696, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] }] },
  { lat := 51.5, lon := (-0.14), radiusM := 749.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.4946011498383, lon := (-0.14), radiusM := 50.0,
    ways := #[] },
  { lat := 51.50088932806324, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] }] },
  { lat := 51.5053988501617, lon := (-0.14), radiusM := 50.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.51257635644988, lon := (-0.14), radiusM := 200.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 4, name := some "Cross Street", subtype := some "residential", coords := #[p 51.51257635644988 (-0.14432910869297655), p 51.51257635644988 (-0.14), p 51.51257635644988 (-0.13567089130702348)] },
      { osmId := 4, name := some "Cross Street (dup record)", subtype := some "residential", coords := #[p 51.514372978799855 (-0.14), p 51.514372978799855 (-0.13567089130702348)] }] },
  { lat := 51.502245777937475, lon := (-0.13933860839412862), radiusM := 404.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.50179662234998, lon := (-0.14), radiusM := 350.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.50134746676249, lon := (-0.14), radiusM := 300.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.50179662234998, lon := 0.14860724619843596, radiusM := 350.0,
    ways := #[] },
  { lat := 51.50107797340999, lon := (-0.1359414606003345), radiusM := 340.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] },
  { lat := 51.50142232602707, lon := (-0.13579114432627282), radiusM := 482.0,
    ways := #[
      { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
      { osmId := 2, name := some "Bent Lane", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.5 (-0.13711392753801566), p 51.5 (-0.1342278550760313), p 51.501796622349985 (-0.1342278550760313), p 51.503593244699964 (-0.1342278550760313)] },
      { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }] }
]

private def stubRoads (la lo rad : Float) : Array Way :=
  match ROADS.find? fun e => approx e.lat la && approx e.lon lo && approx e.radiusM rad with
  | some e => e.ways
  | none => #[]

private structure MatchEntry where
  fixes : Array MPt
  path : Option (Array MPt)

/-- The answer a table MISS returns: a line 2 km southwest of every fixture,
which no output guard accepts. It is deliberately LOCAL rather than at (0, 0)
— `DisplayGate.NearGrid.nearestDist` scans rings outward to the occupied
bounding box, so a null-island sentinel would make the gate scan ~90,000 rings
(the same shape as #416, where a (0, 0) centroid met a spatial index).

A miss is a second net, not the only one: the matcher key is derived from the
same despiked fix set that builds the corridor track, so any divergence in the
fixes already shows up in the READ TRACE guard before it reaches here. -/
private def MISS : Array MPt := #[m 51.487 (-0.16) 0.0, m 51.487 (-0.159) 0.0]

private def MATCHES : Array MatchEntry := #[
  { fixes := #[m 51.5 (-0.14) 2000.0, m 51.500179662235 (-0.1382683565228094) 2060.0, m 51.500538986704996 (-0.13624810579942034) 2120.0, m 51.50125763564499 (-0.1349493731915274) 2180.0, m 51.502335609054974 (-0.1343000068875809) 2240.0, m 51.503593244699964 (-0.1342278550760313) 2300.0],
    path := some #[m 51.5 (-0.14) 2000.0, m 51.5 (-0.1342278550760313) 2140.0, m 51.503593244699964 (-0.1342278550760313) 2300.0] },
  { fixes := #[m 51.5 (-0.14) 1000.0, m 51.501796622349985 (-0.14) 1060.0, m 51.503593244699964 (-0.14) 1120.0, m 51.50538986704995 (-0.14) 1180.0, m 51.50718648939993 (-0.14) 1240.0, m 51.50898311174991 (-0.14) 1300.0, m 51.51077973409989 (-0.14) 1360.0, m 51.51257635644988 (-0.14) 1420.0, m 51.514372978799855 (-0.14) 1480.0, m 51.51616960114984 (-0.14) 1540.0, m 51.51796622349982 (-0.14) 1600.0, m 51.519762845849804 (-0.14) 1660.0, m 51.52155946819978 (-0.14) 1720.0, m 51.52335609054977 (-0.14) 1780.0, m 51.52515271289975 (-0.14) 1840.0, m 51.52694933524973 (-0.14) 1900.0, m 51.52874595759971 (-0.14) 1960.0, m 51.530542579949696 (-0.14) 2020.0],
    path := some #[m 51.5 (-0.14) 1000.0, m 51.530542579949696 (-0.14) 2020.0] },
  { fixes := #[m 51.5 (-0.14) 3000.0, m 51.50089831117499 (-0.13920633007295433) 3060.0, m 51.501796622349985 (-0.13920633007295433) 3120.0, m 51.50269493352497 (-0.13920633007295433) 3180.0, m 51.503593244699964 (-0.13920633007295433) 3240.0, m 51.50449155587496 (-0.13920633007295433) 3300.0],
    path := none },
  { fixes := #[m 51.5 (-0.14) 4000.0, m 51.50089831117499 (-0.14) 4060.0, m 51.501796622349985 (-0.14) 4180.0, m 51.50269493352497 (-0.14) 4240.0, m 51.503593244699964 (-0.14) 4300.0],
    path := some #[m 51.5 (-0.14) 4000.0, m 51.503593244699964 (-0.14) 4300.0] },
  { fixes := #[m 51.5 (-0.14) 5000.0, m 51.50089831117499 (-0.14) 5060.0, m 51.501796622349985 (-0.14) 5120.0, m 51.50269493352497 (-0.14) 5180.0],
    path := some #[m 51.5 (-0.14) 5000.0, m 51.50269493352497 (-0.14) 5180.0] },
  { fixes := #[m 51.500179662235 (-0.1382683565228094) 2060.0, m 51.500538986704996 (-0.13624810579942034) 2120.0, m 51.50125763564499 (-0.1349493731915274) 2180.0, m 51.502335609054974 (-0.1343000068875809) 2240.0],
    path := some #[m 51.5 (-0.1382683565228094) 2060.0, m 51.5 (-0.1342278550760313) 2140.0, m 51.502335609054974 (-0.1342278550760313) 2240.0] },
  { fixes := #[m 51.5 (-0.14) 8000.0, m 51.5 (-0.13711392753801566) 8060.0, m 51.5 (-0.1349493731915274) 8120.0, m 51.501796622349985 (-0.1342278550760313) 8180.0, m 51.50314408911247 (-0.1342278550760313) 8240.0, m 51.503593244699964 (-0.1342278550760313) 8300.0],
    path := some #[m 51.5 (-0.14) 8000.0, m 51.5 (-0.1342278550760313) 8132.0, m 51.503593244699964 (-0.1342278550760313) 8300.0] },
  { fixes := #[m 51.5 (-0.14) 9000.0, m 51.50089831117499 (-0.14) 9060.0, m 51.501796622349985 (-0.14) 9120.0, m 51.50269493352497 (-0.14) 9180.0],
    path := some #[m 51.5 (-0.14) 9000.0, m 51.50269493352497 (-0.14) 9180.0] }
]

private def stubMatcher (fixes : Array MPt) (_ways : Array Way) : Option (Array MPt) :=
  match MATCHES.find? fun e => e.fixes == fixes with
  | some e => e.path
  | none => some MISS

private def ENV : Env := { drivableRoads := stubRoads, matcher := stubMatcher }

private def LONG_ONROAD : Array Fix :=
  #[fx 1000 51.5 (-0.14) 30.0,
    fx 1060 51.501796622349985 (-0.14) 30.0,
    fx 1120 51.503593244699964 (-0.14) 30.0,
    fx 1180 51.50538986704995 (-0.14) 30.0,
    fx 1240 51.50718648939993 (-0.14) 30.0,
    fx 1300 51.50898311174991 (-0.14) 30.0,
    fx 1360 51.51077973409989 (-0.14) 30.0,
    fx 1420 51.51257635644988 (-0.14) 30.0,
    fx 1480 51.514372978799855 (-0.14) 30.0,
    fx 1540 51.51616960114984 (-0.14) 30.0,
    fx 1600 51.51796622349982 (-0.14) 30.0,
    fx 1660 51.519762845849804 (-0.14) 30.0,
    fx 1720 51.52155946819978 (-0.14) 30.0,
    fx 1780 51.52335609054977 (-0.14) 30.0,
    fx 1840 51.52515271289975 (-0.14) 30.0,
    fx 1900 51.52694933524973 (-0.14) 30.0,
    fx 1960 51.52874595759971 (-0.14) 30.0,
    fx 2020 51.530542579949696 (-0.14) 30.0]
private def CORNER_CUT : Array Fix :=
  #[fx 2000 51.5 (-0.14) 30.0,
    fx 2060 51.500179662235 (-0.1382683565228094) 30.0,
    fx 2120 51.500538986704996 (-0.13624810579942034) 30.0,
    fx 2180 51.50125763564499 (-0.1349493731915274) 30.0,
    fx 2240 51.502335609054974 (-0.1343000068875809) 30.0,
    fx 2300 51.503593244699964 (-0.1342278550760313) 30.0]
private def CORNER_TIGHT : Array Fix :=
  #[fx 8000 51.5 (-0.14) 30.0,
    fx 8060 51.5 (-0.13711392753801566) 30.0,
    fx 8120 51.5 (-0.1349493731915274) 30.0,
    fx 8180 51.501796622349985 (-0.1342278550760313) 30.0,
    fx 8240 51.50314408911247 (-0.1342278550760313) 30.0,
    fx 8300 51.503593244699964 (-0.1342278550760313) 30.0]
private def CORNER_SPIKED : Array Fix :=
  #[fx 8000 51.5 (-0.14) 30.0,
    fx 8060 51.5 (-0.13711392753801566) 30.0,
    fx 8120 51.5 (-0.1349493731915274) 30.0,
    fx 8150 51.51796622349982 (-0.09670891307023463) 30.0,
    fx 8180 51.501796622349985 (-0.1342278550760313) 30.0,
    fx 8240 51.50314408911247 (-0.1342278550760313) 30.0,
    fx 8300 51.503593244699964 (-0.1342278550760313) 30.0]
private def CAP_EXACT : Array Fix :=
  #[fx 9000 51.5 (-0.14) 12.0,
    fx 9060 51.50089831117499 (-0.14) 35.0,
    fx 9120 51.501796622349985 (-0.14) 12.0,
    fx 9180 51.50269493352497 (-0.14) 12.0]
private def NEAR_PARALLEL : Array Fix :=
  #[fx 3000 51.5 (-0.14) 30.0,
    fx 3060 51.50089831117499 (-0.13920633007295433) 30.0,
    fx 3120 51.501796622349985 (-0.13920633007295433) 30.0,
    fx 3180 51.50269493352497 (-0.13920633007295433) 30.0,
    fx 3240 51.503593244699964 (-0.13920633007295433) 30.0,
    fx 3300 51.50449155587496 (-0.13920633007295433) 30.0]
private def SPIKED : Array Fix :=
  #[fx 4000 51.5 (-0.14) 30.0,
    fx 4060 51.50089831117499 (-0.14) 30.0,
    fx 4120 51.50107797340999 (-0.1270126739210704) 30.0,
    fx 4180 51.501796622349985 (-0.14) 30.0,
    fx 4240 51.50269493352497 (-0.14) 30.0,
    fx 4300 51.503593244699964 (-0.14) 30.0]
private def FAST_CYCLE : Array Fix :=
  #[fx 5000 51.5 (-0.14) 12.0,
    fx 5060 51.50089831117499 (-0.14) 40.0,
    fx 5120 51.501796622349985 (-0.14) 44.0,
    fx 5180 51.50269493352497 (-0.14) 15.0]
private def TOO_FEW : Array Fix :=
  #[fx 6000 51.5 (-0.14) 30.0,
    fx 6060 51.50089831117499 (-0.14) 30.0,
    fx 6120 51.501796622349985 (-0.14) 30.0]
private def NOWHERE : Array Fix :=
  #[fx 7000 51.5 0.14860724619843596 30.0,
    fx 7060 51.50089831117499 0.14860724619843596 30.0,
    fx 7120 51.501796622349985 0.14860724619843596 30.0,
    fx 7180 51.50269493352497 0.14860724619843596 30.0,
    fx 7240 51.503593244699964 0.14860724619843596 30.0]

/-! ### The fix pipeline — window, cap, despike -/

-- CORNER_CUT 2000-2300 as driving: window 6 -> cap 6 -> despike 6
#guard (samplesInWindow CORNER_CUT 2000 2300).size == 6
#guard (despike ((samplesInWindow CORNER_CUT 2000 2300).filter fun q =>
  match speedCapFor "driving" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[2000, 2060, 2120, 2180, 2240, 2300]
-- CORNER_CUT 2060-2240 as driving: window 4 -> cap 4 -> despike 4
#guard (samplesInWindow CORNER_CUT 2060 2240).size == 4
#guard (despike ((samplesInWindow CORNER_CUT 2060 2240).filter fun q =>
  match speedCapFor "driving" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[2060, 2120, 2180, 2240]
-- SPIKED 4000-4300 as driving: window 6 -> cap 6 -> despike 5
#guard (samplesInWindow SPIKED 4000 4300).size == 6
#guard (despike ((samplesInWindow SPIKED 4000 4300).filter fun q =>
  match speedCapFor "driving" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[4000, 4060, 4180, 4240, 4300]
-- FAST_CYCLE 5000-5180 as cycling: window 4 -> cap 2 -> despike 2
#guard (samplesInWindow FAST_CYCLE 5000 5180).size == 4
#guard (despike ((samplesInWindow FAST_CYCLE 5000 5180).filter fun q =>
  match speedCapFor "cycling" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[5000, 5180]
-- FAST_CYCLE 5000-5180 as bus: window 4 -> cap 4 -> despike 4
#guard (samplesInWindow FAST_CYCLE 5000 5180).size == 4
#guard (despike ((samplesInWindow FAST_CYCLE 5000 5180).filter fun q =>
  match speedCapFor "bus" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[5000, 5060, 5120, 5180]
-- TOO_FEW 6000-6120 as driving: window 3 -> cap 3 -> despike 3
#guard (samplesInWindow TOO_FEW 6000 6120).size == 3
#guard (despike ((samplesInWindow TOO_FEW 6000 6120).filter fun q =>
  match speedCapFor "driving" with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)
  == #[6000, 6060, 6120]

#guard speedCapFor "driving" == none
#guard speedCapFor "bus" == none
#guard speedCapFor "cycling" == some 35.0
#guard speedCapFor "walking" == some 12.0
#guard speedCapFor "stationary" == some 5.0

#guard effectiveMode (sg 0 1 "driving" none) == "driving"
#guard effectiveMode (sg 0 1 "walking" (some "driving")) == "driving"
#guard effectiveMode (sg 0 1 "driving" (some "walking")) == "walking"

/-! ### The pass -/

private def outOf (segs : Array Seg) (fixes : Array Fix) : Array Seg :=
  annotateRoadMatches ENV segs fixes

-- S1: a walking leg is not a road mode — untouched, and it reads nothing
private def S1_SEGS : Array Seg := #[sg 2000 2300 "walking" none]
private def S1_FIXES : Array Fix := CORNER_CUT
--   leg 0: ineligible or too sparse — no match attempted
#guard approxReads (readsOf ENV S1_SEGS S1_FIXES)
  #[]
#guard approxOut (outOf S1_SEGS S1_FIXES) #[
  sg 2000 2300 "walking" none]

-- S2: three in-window fixes: under MIN_LEG_FIXES before any read
private def S2_SEGS : Array Seg := #[sg 6000 6120 "driving" none]
private def S2_FIXES : Array Fix := TOO_FEW
--   leg 0: ineligible or too sparse — no match attempted
#guard approxReads (readsOf ENV S2_SEGS S2_FIXES)
  #[]
#guard approxOut (outOf S2_SEGS S2_FIXES) #[
  sg 6000 6120 "driving" none]

-- S3: the p85 stray bar is the SOLE blocker: 95 m off-road, match 60 m away
private def S3_SEGS : Array Seg := #[sg 2000 2300 "driving" none]
private def S3_FIXES : Array Fix := CORNER_CUT
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
#guard approxReads (readsOf ENV S3_SEGS S3_FIXES)
  #[r 51.501317523056656 (-0.1363322829128949) 443.0]
#guard approxOut (outOf S3_SEGS S3_FIXES) #[
  sg 2000 2300 "driving" none]

-- S4: the same leg as bus: same verdict, so the mode only gates eligibility
private def S4_SEGS : Array Seg := #[sg 2000 2300 "bus" none]
private def S4_FIXES : Array Fix := CORNER_CUT
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
#guard approxReads (readsOf ENV S4_SEGS S4_FIXES)
  #[r 51.501317523056656 (-0.1363322829128949) 443.0]
#guard approxOut (outOf S4_SEGS S4_FIXES) #[
  sg 2000 2300 "bus" none]

-- S5: refinedMode makes a walking-classified leg eligible
private def S5_SEGS : Array Seg := #[sg 2000 2300 "walking" (some "driving")]
private def S5_FIXES : Array Fix := CORNER_CUT
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
#guard approxReads (readsOf ENV S5_SEGS S5_FIXES)
  #[r 51.501317523056656 (-0.1363322829128949) 443.0]
#guard approxOut (outOf S5_SEGS S5_FIXES) #[
  sg 2000 2300 "walking" (some "driving")]

-- S6: refinedMode takes a driving-classified leg OUT of scope
private def S6_SEGS : Array Seg := #[sg 2000 2300 "driving" (some "walking")]
private def S6_FIXES : Array Fix := CORNER_CUT
--   leg 0: ineligible or too sparse — no match attempted
#guard approxReads (readsOf ENV S6_SEGS S6_FIXES)
  #[]
#guard approxOut (outOf S6_SEGS S6_FIXES) #[
  sg 2000 2300 "driving" (some "walking")]

-- S7: a 3.4 km run on the carriageway — the corridor arm, many reads
private def S7_SEGS : Array Seg := #[sg 1000 2020 "driving" none]
private def S7_FIXES : Array Fix := LONG_ONROAD
--   leg 0: use=false rawOff=0 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S7_SEGS S7_FIXES)
  #[r 51.5 (-0.14) 50.0,
    r 51.506288178224935 (-0.14) 50.0,
    r 51.51257635644988 (-0.14) 50.0,
    r 51.51886453467481 (-0.14) 50.0,
    r 51.52515271289975 (-0.14) 50.0,
    r 51.530542579949696 (-0.14) 50.0]
#guard approxOut (outOf S7_SEGS S7_FIXES) #[
  sg 1000 2020 "driving" none]

-- S8: the matcher declines outright — the gate never runs
private def S8_SEGS : Array Seg := #[sg 3000 3300 "driving" none]
private def S8_FIXES : Array Fix := NEAR_PARALLEL
--   leg 0: matcher returned null
#guard approxReads (readsOf ENV S8_SEGS S8_FIXES)
  #[r 51.502245777937475 (-0.13933860839412862) 404.0]
#guard approxOut (outOf S8_SEGS S8_FIXES) #[
  sg 3000 3300 "driving" none]

-- S9: a lone teleport: the matcher sees the despiked five, not six
private def S9_SEGS : Array Seg := #[sg 4000 4300 "driving" none]
private def S9_FIXES : Array Fix := SPIKED
--   leg 0: use=false rawOff=0 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S9_SEGS S9_FIXES)
  #[r 51.50179662234998 (-0.14) 350.0]
#guard approxOut (outOf S9_SEGS S9_FIXES) #[
  sg 4000 4300 "driving" none]

-- S10: cycling caps at 35 km/h — two fixes survive, under MIN_LEG_FIXES
private def S10_SEGS : Array Seg := #[sg 5000 5180 "cycling" none]
private def S10_FIXES : Array Fix := FAST_CYCLE
--   leg 0: ineligible or too sparse — no match attempted
#guard approxReads (readsOf ENV S10_SEGS S10_FIXES)
  #[]
#guard approxOut (outOf S10_SEGS S10_FIXES) #[
  sg 5000 5180 "cycling" none]

-- S11: the same fixes as bus: no cap entry, so all four survive
private def S11_SEGS : Array Seg := #[sg 5000 5180 "bus" none]
private def S11_FIXES : Array Fix := FAST_CYCLE
--   leg 0: use=false rawOff=0 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S11_SEGS S11_FIXES)
  #[r 51.50134746676249 (-0.14) 300.0]
#guard approxOut (outOf S11_SEGS S11_FIXES) #[
  sg 5000 5180 "bus" none]

-- S12: empty corridor: one read, then a bail before the matcher
private def S12_SEGS : Array Seg := #[sg 7000 7240 "driving" none]
private def S12_FIXES : Array Fix := NOWHERE
--   leg 0: empty corridor after 1 read — no match attempted
#guard approxReads (readsOf ENV S12_SEGS S12_FIXES)
  #[r 51.50179662234998 0.14860724619843596 350.0]
#guard approxOut (outOf S12_SEGS S12_FIXES) #[
  sg 7000 7240 "driving" none]

-- S13: two legs — the trace is leg-by-leg, not interleaved
private def S13_SEGS : Array Seg := #[sg 2000 2300 "driving" none, sg 3000 3300 "driving" none]
private def S13_FIXES : Array Fix := (CORNER_CUT ++ NEAR_PARALLEL)
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
--   leg 1: matcher returned null
#guard approxReads (readsOf ENV S13_SEGS S13_FIXES)
  #[r 51.501317523056656 (-0.1363322829128949) 443.0,
    r 51.502245777937475 (-0.13933860839412862) 404.0]
#guard approxOut (outOf S13_SEGS S13_FIXES) #[
  sg 2000 2300 "driving" none,
  sg 3000 3300 "driving" none]

-- S14: an ineligible leg between two eligible ones contributes no reads
private def S14_SEGS : Array Seg := #[sg 2000 2300 "driving" none, sg 6000 6120 "driving" none, sg 3000 3300 "driving" none]
private def S14_FIXES : Array Fix := (CORNER_CUT ++ TOO_FEW ++ NEAR_PARALLEL)
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
--   leg 1: ineligible or too sparse — no match attempted
--   leg 2: matcher returned null
#guard approxReads (readsOf ENV S14_SEGS S14_FIXES)
  #[r 51.501317523056656 (-0.1363322829128949) 443.0,
    r 51.502245777937475 (-0.13933860839412862) 404.0]
#guard approxOut (outOf S14_SEGS S14_FIXES) #[
  sg 2000 2300 "driving" none,
  sg 6000 6120 "driving" none,
  sg 3000 3300 "driving" none]

-- S15: the window is INCLUSIVE at both ends: a boundary fix is in
private def S15_SEGS : Array Seg := #[sg 2060 2240 "driving" none]
private def S15_FIXES : Array Fix := CORNER_CUT
--   leg 0: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
#guard approxReads (readsOf ENV S15_SEGS S15_FIXES)
  #[r 51.50107797340999 (-0.1359414606003345) 340.0]
#guard approxOut (outOf S15_SEGS S15_FIXES) #[
  sg 2060 2240 "driving" none]

-- S16: all three bars clear — the pass attaches a matchedPath
private def S16_SEGS : Array Seg := #[sg 8000 8300 "driving" none]
private def S16_FIXES : Array Fix := CORNER_TIGHT
--   leg 0: use=true rawOff=38.46118856892588 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S16_SEGS S16_FIXES)
  #[r 51.50142232602707 (-0.13579114432627282) 482.0]
#guard approxOut (outOf S16_SEGS S16_FIXES) #[
  { sg 8000 8300 "driving" none with matchedPath := some #[m 51.5 (-0.14) 8000.0, m 51.5 (-0.1342278550760313) 8132.0, m 51.503593244699964 (-0.1342278550760313) 8300.0] }]

-- S17: the accepting leg beside a rejecting one: only the first is rewritten
private def S17_SEGS : Array Seg := #[sg 8000 8300 "driving" none, sg 2000 2300 "driving" none]
private def S17_FIXES : Array Fix := (CORNER_TIGHT ++ CORNER_CUT)
--   leg 0: use=true rawOff=38.46118856892588 matchedOff=0 stray=0
--   leg 1: use=false rawOff=94.99812748508089 matchedOff=0 stray=60.000000000114255
#guard approxReads (readsOf ENV S17_SEGS S17_FIXES)
  #[r 51.50142232602707 (-0.13579114432627282) 482.0,
    r 51.501317523056656 (-0.1363322829128949) 443.0]
#guard approxOut (outOf S17_SEGS S17_FIXES) #[
  { sg 8000 8300 "driving" none with matchedPath := some #[m 51.5 (-0.14) 8000.0, m 51.5 (-0.1342278550760313) 8132.0, m 51.503593244699964 (-0.1342278550760313) 8300.0] },
  sg 2000 2300 "driving" none]

-- S18: a spike inside the accepting leg: despiked, so the match still lands
private def S18_SEGS : Array Seg := #[sg 8000 8300 "driving" none]
private def S18_FIXES : Array Fix := CORNER_SPIKED
--   leg 0: use=true rawOff=38.46118856892588 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S18_SEGS S18_FIXES)
  #[r 51.50142232602707 (-0.13579114432627282) 482.0]
#guard approxOut (outOf S18_SEGS S18_FIXES) #[
  { sg 8000 8300 "driving" none with matchedPath := some #[m 51.5 (-0.14) 8000.0, m 51.5 (-0.1342278550760313) 8132.0, m 51.503593244699964 (-0.1342278550760313) 8300.0] }]

-- S19: a fix exactly ON the cycling cap survives — the bar is inclusive
private def S19_SEGS : Array Seg := #[sg 9000 9180 "cycling" none]
private def S19_FIXES : Array Fix := CAP_EXACT
--   leg 0: use=false rawOff=0 matchedOff=0 stray=0
#guard approxReads (readsOf ENV S19_SEGS S19_FIXES)
  #[r 51.50134746676249 (-0.14) 300.0]
#guard approxOut (outOf S19_SEGS S19_FIXES) #[
  sg 9000 9180 "cycling" none]

/-! ### Deliberately unpinned

One branch of this pass survives a mutation sweep, and it survives because it
cannot change the answer:

* **the `ways.isEmpty` bail.** Deleting it sends an empty corridor on to the
  matcher and then to the gate — and the gate cannot accept there.
  `matchImprovesDisplay` computes `rawOffRoadM` as the worst distance from the
  drawn line to the network, which is 0 when there IS no network, and its
  first conjunct needs `rawOffRoadM > 25`. `DisplayGate`'s own `dNoWays`
  guard pins that. So the bail is a COST decision (do not run a matcher over
  nothing) and not a correctness one, and no output guard can see it.

What WOULD see it is a trace of matcher calls, the way the mirror reads are
traced. That is not modelled: the matcher is a pure `Env` field, and giving
it a call log would put a test-only channel into the pass's shape.
-/

end Guards

end Verified.Geo.RoadMatchAnnotate
