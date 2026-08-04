import Verified.Geo.WalkableRoute

/-!
# Corridor road-geometry fetch (port of `src/geo/osm-corridor.ts`)

Read the OSM ways along a GPS track by sampling small discs down the track and
unioning them, instead of one giant disc around the track's centroid. The
motivation is cost, not output: the mirror's spatial query is super-linear in
the query box, so a long drive's centroid disc is a pathological scan while the
drive itself is a thin line.

Two arms, and WHICH ARM A LEG TAKES IS THE OBSERVABLE THING — the read trace a
fixture replay must reproduce:

* **short leg** (every fix within `SINGLE_DISC_MAX_DIST_M` of the centroid) —
  ONE read, at the centroid, with a `Math.round`ed radius. Sampling a short leg
  would only multiply round-trips.
* **long leg** — a corridor: `resamplePolyline` the track at `stepM` spacing and
  read a `radiusM` disc at each sample, unioning by `osmId`, FIRST WINS.

## Termination of the resampler is derived, not budgeted

`resamplePolyline`'s inner walk is a TS `while (nextAt <= acc + segLen)` that
advances `nextAt` by `step`. Its Lean counterpart recurses on a `Nat`, and that
`Nat` is the function's own declared cap: `step = max stepM (total / (maxSamples
- 1))` forces `total / step ≤ maxSamples - 1`, and the walk stops once `nextAt`
passes `total`, so it cannot take more than `maxSamples - 1` steps. The
parameter records that argument for the termination checker — it is a bound
derived from the step choice, not a net thrown over unanalysed control flow.

Reaching zero with the loop condition still true would mean the float walk
outran its real-arithmetic bound. That cannot be ruled out by this argument
(the walk accumulates `nextAt` by repeated addition, so it drifts from
`step × j`), and the guards pin the sample COUNT on a track long enough to take
many steps, which is where such a drift would first show.

Exactness: `metersBetween` is `WalkableRoute`'s — the TS `Math.hypot` against
Lean's `sqrt` of the sum of squares, ≤1 ULP at these magnitudes — and every
sample position is a lerp whose parameter divides by it, so positions inherit
that wobble. The arm choice, the union order and the sample count are EXACT
unless the wobble crosses a comparison; at 600 m against a ≤1 ULP perturbation
it does not.

UNPROVEN; pinned against Node/V8 (`lean/experiments/road-match-annotate-refs.mts`).
-/

namespace Verified.Geo.OsmCorridor

open Verified.Geo.WalkableRoute (Pt metersBetween)

/-! ## Shapes -/

/-- An `OsmRoadWay` from the mirror. `corridorWays` reads only `osmId` (the
union is by identity); the rest rides along untouched to the matcher. -/
structure Way where
  osmId : Int
  name : Option String := none
  subtype : Option String := none
  coords : Array Pt := #[]
  deriving Inhabited, BEq, Repr

/-- One `query(lat, lon, radiusM)` the corridor fetch made. The trace is the
point of the port: a fixture replay that saw a different set of keys would be
replaying different captured data. -/
structure Read where
  lat : Float
  lon : Float
  radiusM : Float
  deriving Inhabited, BEq, Repr

/-- The read trace, in call order. -/
abbrev TraceM := StateM (Array Read)

/-! ## Constants -/

/-- Below this max fix-to-centroid distance the single centroid disc is already
small and fast, so sampling would only add round-trips. -/
def SINGLE_DISC_MAX_DIST_M : Float := 600
/-- Slack on the single disc's radius, so it comfortably covers the matcher's
reach past the farthest fix. -/
def SINGLE_DISC_SLACK_M : Float := 150
/-- The resampler's default cap. A pathologically long leg widens its effective
step rather than firing hundreds of queries. -/
def MAX_SAMPLES : Nat := 48

/-! ## Local arithmetic -/

/-- `Math.round` — halves go UP, towards +∞, unlike `Float.round`'s
away-from-zero. Only ever applied here to a non-negative radius. -/
def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-! ## Resampling -/

/-- The walk across ONE track segment: emit a sample every `step` of arc length
while `nextAt` is still inside `[acc, acc + segLen]`, and hand back where the
walk got to. `budget` is the derived bound argued in the module header. -/
private def sampleRun (a b : Pt) (segLen acc step : Float) :
    Nat → Float → Array Pt → Array Pt × Float
  | 0, nextAt, out => (out, nextAt)
  | budget + 1, nextAt, out =>
    if nextAt ≤ acc + segLen then
      let t := (nextAt - acc) / segLen
      sampleRun a b segLen acc step budget (nextAt + step)
        (out.push ⟨a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)⟩)
    else (out, nextAt)

/--
Resample a polyline at ~`stepM` arc-length spacing. Always includes the first
vertex, and the last one unless a sample already landed within a metre of it, so
the corridor reaches both ends of the leg.

A zero-length track segment is SKIPPED ENTIRELY — the TS `continue` jumps the
`acc += segLen` too, which is harmless only because the length it skips is zero.
-/
def resamplePolyline (track : Array Pt) (stepM : Float) (maxSamples : Nat := MAX_SAMPLES) :
    Array Pt := Id.run do
  if track.isEmpty then return #[]
  if track.size == 1 then return #[⟨track[0]!.lat, track[0]!.lon⟩]

  let mut total : Float := 0
  for i in [1 : track.size] do
    total := total + metersBetween track[i - 1]! track[i]!
  let step := max stepM (total / (Float.ofNat maxSamples - 1))

  let mut out : Array Pt := #[⟨track[0]!.lat, track[0]!.lon⟩]
  let mut acc : Float := 0
  let mut nextAt := step
  for i in [1 : track.size] do
    let a := track[i - 1]!
    let b := track[i]!
    let segLen := metersBetween a b
    if segLen > 0 then
      let (out', nextAt') := sampleRun a b segLen acc step maxSamples nextAt out
      out := out'
      nextAt := nextAt'
      acc := acc + segLen
  let last := track[track.size - 1]!
  if metersBetween out[out.size - 1]! last > 1 then
    out := out.push ⟨last.lat, last.lon⟩
  return out

/-! ## The corridor fetch -/

/-- Union `ways` into `acc` by `osmId`, FIRST WINS — the TS `Map.set` guarded by
`!byId.has(...)`, whose iteration order is insertion order. -/
def unionById (acc : Array Way) (ways : Array Way) : Array Way :=
  ways.foldl (init := acc) fun seen w =>
    if seen.any (·.osmId == w.osmId) then seen else seen.push w

/--
Fetch the ways in a corridor around `track`. Short legs read one centroid disc;
long ones read a `radiusM` disc at every `stepM` sample down the track and union
the results. `query` is `osm.drivableRoads` (roads) or `osm.walkableRoads`
(walks).

The `Float` radius is the TS's: the single-disc arm rounds its own radius to a
whole metre, the corridor arm passes `radiusM` through untouched.
-/
def corridorWays (query : Float → Float → Float → Array Way)
    (track : Array Pt) (stepM radiusM : Float) : TraceM (Array Way) := do
  if track.isEmpty then return #[]

  -- Centroid, and the farthest fix from it: how big a single disc would be.
  let n := Float.ofNat track.size
  let cLat := track.foldl (init := 0.0) (· + ·.lat) / n
  let cLon := track.foldl (init := 0.0) (· + ·.lon) / n
  let c : Pt := ⟨cLat, cLon⟩
  let maxDist := track.foldl (init := 0.0) fun best f =>
    let d := metersBetween c f
    if d > best then d else best

  if maxDist ≤ SINGLE_DISC_MAX_DIST_M then
    let r := jsRound (maxDist + SINGLE_DISC_SLACK_M)
    modify (·.push ⟨cLat, cLon, r⟩)
    return query cLat cLon r

  let samples := resamplePolyline track stepM
  let mut acc : Array Way := #[]
  for s in samples do
    modify (·.push ⟨s.lat, s.lon, radiusM⟩)
    acc := unionById acc (query s.lat s.lon radiusM)
  return acc

/-- `corridorWays` with the read trace discarded. -/
def corridorWaysOf (query : Float → Float → Float → Array Way)
    (track : Array Pt) (stepM radiusM : Float) : Array Way :=
  (corridorWays query track stepM radiusM).run' #[]

/-! ## Guards (V8 reference values)

Every number below is `lean/experiments/road-match-annotate-refs.mts`'s output
on the same fixture, transcribed at V8's own precision.

The `metersBetween` wobble is MEASURED, not assumed: across every distance
this file's fixtures compute, `Math.hypot` and `sqrt(dx² + dy²)` agreed on
145 of 206 calls, worst disagreement 5.684341886080802e-14 m. The
sample positions are therefore pinned exactly, not approximately — but the
guards still compare through `approx`, because that agreement is a fact about
these magnitudes, not a theorem.
-/

section Guards

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def p (la lo : Float) : Pt := ⟨la, lo⟩
private def approxPt (a b : Pt) : Bool := approx a.lat b.lat && approx a.lon b.lon
private def approxPts (a b : Array Pt) : Bool :=
  a.size == b.size && (Array.range a.size).all fun i => approxPt a[i]! b[i]!
private def approxRead (a b : Read) : Bool :=
  approx a.lat b.lat && approx a.lon b.lon && approx a.radiusM b.radiusM
private def approxReads (a b : Array Read) : Bool :=
  a.size == b.size && (Array.range a.size).all fun i => approxRead a[i]! b[i]!
private def r (la lo rad : Float) : Read := ⟨la, lo, rad⟩

/-! ### `resamplePolyline` -/

-- R1: an empty track resamples to nothing
private def R1_TRACK : Array Pt := #[]
#guard (resamplePolyline R1_TRACK 700.0).size == 0
#guard approxPts (resamplePolyline R1_TRACK 700.0) #[]

-- R2: one vertex is copied, not measured
private def R2_TRACK : Array Pt := #[p 51.5 (-0.14)]
#guard (resamplePolyline R2_TRACK 700.0).size == 1
#guard approxPts (resamplePolyline R2_TRACK 700.0) #[p 51.5 (-0.14)]

-- R3: a track shorter than one step keeps only its two endpoints
private def R3_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.50269493352497 (-0.14)]
#guard (resamplePolyline R3_TRACK 700.0).size == 2
#guard approxPts (resamplePolyline R3_TRACK 700.0) #[p 51.5 (-0.14), p 51.50269493352497 (-0.14)]

-- R4: 3.4 km at 700 m: five walked samples, then the far end pushed
private def R4_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)]
#guard (resamplePolyline R4_TRACK 700.0).size == 6
#guard approxPts (resamplePolyline R4_TRACK 700.0) #[p 51.5 (-0.14), p 51.506288178224935 (-0.14), p 51.51257635644988 (-0.14), p 51.51886453467481 (-0.14), p 51.52515271289975 (-0.14), p 51.530542579949696 (-0.14)]

-- R5: a repeated vertex contributes no length and is skipped entirely
private def R5_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.503593244699964 (-0.14), p 51.503593244699964 (-0.14), p 51.50718648939993 (-0.14)]
#guard (resamplePolyline R5_TRACK 300.0).size == 4
#guard approxPts (resamplePolyline R5_TRACK 300.0) #[p 51.5 (-0.14), p 51.50269493352497 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14)]

-- R6: the last vertex is NOT pushed when a sample already landed within 1 m
private def R6_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.50538986704995 (-0.14)]
#guard (resamplePolyline R6_TRACK 300.0).size == 3
#guard approxPts (resamplePolyline R6_TRACK 300.0) #[p 51.5 (-0.14), p 51.50269493352497 (-0.14), p 51.50538986704995 (-0.14)]

-- R7: 48 km at 700 m: the cap widens the step instead of firing 68 queries
private def R7_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.51796622349982 (-0.14), p 51.53593244699964 (-0.14), p 51.553898670499464 (-0.14), p 51.57186489399928 (-0.14), p 51.5898311174991 (-0.14), p 51.60779734099892 (-0.14), p 51.62576356449874 (-0.14), p 51.64372978799856 (-0.14), p 51.661696011498385 (-0.14), p 51.679662234998204 (-0.14), p 51.69762845849802 (-0.14), p 51.71559468199784 (-0.14), p 51.73356090549766 (-0.14), p 51.75152712899749 (-0.14), p 51.76949335249731 (-0.14), p 51.787459575997126 (-0.14), p 51.805425799496945 (-0.14), p 51.823392022996764 (-0.14), p 51.84135824649659 (-0.14), p 51.85932446999641 (-0.14), p 51.87729069349623 (-0.14), p 51.89525691699605 (-0.14), p 51.913223140495866 (-0.14), p 51.931189363995685 (-0.14)]
#guard (resamplePolyline R7_TRACK 700.0).size == 48
#guard approxPts (resamplePolyline R7_TRACK 700.0) #[p 51.5 (-0.14), p 51.50917424178714 (-0.14), p 51.518348483574286 (-0.14), p 51.52752272536143 (-0.14), p 51.53669696714857 (-0.14), p 51.54587120893571 (-0.14), p 51.55504545072285 (-0.14), p 51.564219692509994 (-0.14), p 51.57339393429714 (-0.14), p 51.58256817608428 (-0.14), p 51.59174241787142 (-0.14), p 51.600916659658566 (-0.14), p 51.61009090144571 (-0.14), p 51.61926514323285 (-0.14), p 51.628439385019995 (-0.14), p 51.63761362680713 (-0.14), p 51.646787868594274 (-0.14), p 51.65596211038142 (-0.14), p 51.66513635216856 (-0.14), p 51.6743105939557 (-0.14), p 51.683484835742846 (-0.14), p 51.69265907752999 (-0.14), p 51.70183331931713 (-0.14), p 51.711007561104275 (-0.14), p 51.72018180289141 (-0.14), p 51.72935604467855 (-0.14), p 51.738530286465696 (-0.14), p 51.74770452825284 (-0.14), p 51.75687877003998 (-0.14), p 51.766053011827125 (-0.14), p 51.77522725361427 (-0.14), p 51.78440149540141 (-0.14), p 51.793575737188554 (-0.14), p 51.8027499789757 (-0.14), p 51.81192422076283 (-0.14), p 51.821098462549976 (-0.14), p 51.83027270433712 (-0.14), p 51.83944694612426 (-0.14), p 51.848621187911405 (-0.14), p 51.85779542969855 (-0.14), p 51.86696967148569 (-0.14), p 51.876143913272834 (-0.14), p 51.88531815505998 (-0.14), p 51.89449239684711 (-0.14), p 51.903666638634256 (-0.14), p 51.9128408804214 (-0.14), p 51.92201512220854 (-0.14), p 51.931189363995685 (-0.14)]

-- R8: a two-vertex L — the samples interpolate inside each leg, not across
private def R8_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.5 (-0.12556963769007823), p 51.50898311174991 (-0.12556963769007823)]
#guard (resamplePolyline R8_TRACK 400.0).size == 6
#guard approxPts (resamplePolyline R8_TRACK 400.0) #[p 51.5 (-0.14), p 51.5 (-0.1342278550760313), p 51.5 (-0.12845571015206259), p 51.501796622349985 (-0.12556963769007823), p 51.50538986704995 (-0.12556963769007823), p 51.50898311174991 (-0.12556963769007823)]

-- R9: maxSamples = 2 forces one step for the whole track
private def R9_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14)]
#guard (resamplePolyline R9_TRACK 100.0 2).size == 2
#guard approxPts (resamplePolyline R9_TRACK 100.0 2) #[p 51.5 (-0.14), p 51.50898311174991 (-0.14)]

-- R10: the far end sits 0.5 m past the last sample — under the 1 m bar, NOT pushed
private def R10_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.50539435860582 (-0.14)]
#guard (resamplePolyline R10_TRACK 300.0 48).size == 3
#guard approxPts (resamplePolyline R10_TRACK 300.0 48) #[p 51.5 (-0.14), p 51.50269493352497 (-0.14), p 51.50538986704995 (-0.14)]

-- R11: …and 1.5 m past it, over the bar, so it IS pushed
private def R11_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.505403341717575 (-0.14)]
#guard (resamplePolyline R11_TRACK 300.0 48).size == 4
#guard approxPts (resamplePolyline R11_TRACK 300.0 48) #[p 51.5 (-0.14), p 51.50269493352497 (-0.14), p 51.50538986704995 (-0.14), p 51.505403341717575 (-0.14)]

-- R12: nextAt lands EXACTLY on the segment end (see the unpinned note below)
private def R12_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.50538986704995 (-0.14)]
#guard (resamplePolyline R12_TRACK 600.0000000003515 48).size == 2
#guard approxPts (resamplePolyline R12_TRACK 600.0000000003515 48) #[p 51.5 (-0.14), p 51.50538986704995 (-0.14)]

/-! ### `corridorWays` — the arm choice, the read trace, the union -/

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

-- C1: an empty track reads nothing at all
private def C1_TRACK : Array Pt := #[]
private def C1_RUN := (corridorWays stubRoads C1_TRACK 700.0 50.0).run #[]
#guard approxReads C1_RUN.2 #[]
#guard C1_RUN.1.map (·.osmId) == #[]
#guard C1_RUN.1.map (·.name) == #[]

-- C2: a short leg: ONE centroid disc, radius Math.round(maxDist + 150)
private def C2_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.500179662235 (-0.1382683565228094), p 51.500538986704996 (-0.13624810579942034), p 51.50125763564499 (-0.1349493731915274), p 51.502335609054974 (-0.1343000068875809), p 51.503593244699964 (-0.1342278550760313)]
private def C2_RUN := (corridorWays stubRoads C2_TRACK 700.0 50.0).run #[]
#guard approxReads C2_RUN.2 #[r 51.501317523056656 (-0.1363322829128949) 443.0]
#guard C2_RUN.1.map (·.osmId) == #[1, 2, 3]
#guard C2_RUN.1.map (·.name) == #[some "Main Street", some "Bent Lane", some "Parallel Road"]

-- C3: a 3.4 km leg: the corridor arm, one disc per resampled sample
private def C3_TRACK : Array Pt := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)]
private def C3_RUN := (corridorWays stubRoads C3_TRACK 700.0 50.0).run #[]
#guard approxReads C3_RUN.2 #[r 51.5 (-0.14) 50.0, r 51.506288178224935 (-0.14) 50.0, r 51.51257635644988 (-0.14) 50.0, r 51.51886453467481 (-0.14) 50.0, r 51.52515271289975 (-0.14) 50.0, r 51.530542579949696 (-0.14) 50.0]
#guard C3_RUN.1.map (·.osmId) == #[1, 2, 3, 4]
#guard C3_RUN.1.map (·.name) == #[some "Main Street", some "Bent Lane", some "Parallel Road", some "Cross Street"]

-- C4: just inside the single-disc bar (max fix-to-centroid 599.4 m)
private def C4_TRACK : Array Pt := #[p 51.494619116061806 (-0.14), p 51.5 (-0.14), p 51.505380883938194 (-0.14)]
private def C4_RUN := (corridorWays stubRoads C4_TRACK 700.0 50.0).run #[]
#guard approxReads C4_RUN.2 #[r 51.5 (-0.14) 749.0]
#guard C4_RUN.1.map (·.osmId) == #[1, 2, 3]
#guard C4_RUN.1.map (·.name) == #[some "Main Street", some "Bent Lane", some "Parallel Road"]

-- C5: just past it (601.5 m) — the same shape takes the corridor arm
private def C5_TRACK : Array Pt := #[p 51.4946011498383 (-0.14), p 51.5 (-0.14), p 51.5053988501617 (-0.14)]
private def C5_RUN := (corridorWays stubRoads C5_TRACK 700.0 50.0).run #[]
#guard approxReads C5_RUN.2 #[r 51.4946011498383 (-0.14) 50.0, r 51.50088932806324 (-0.14) 50.0, r 51.5053988501617 (-0.14) 50.0]
#guard C5_RUN.1.map (·.osmId) == #[1, 2, 3]
#guard C5_RUN.1.map (·.name) == #[some "Main Street", some "Bent Lane", some "Parallel Road"]

-- C6: the single-disc arm does NOT dedupe — it returns the query verbatim
private def C6_TRACK : Array Pt := #[p 51.51257635644988 (-0.1407215181154961), p 51.51257635644988 (-0.14), p 51.51257635644988 (-0.13927848188450392)]
private def C6_RUN := (corridorWays stubRoads C6_TRACK 700.0 50.0).run #[]
#guard approxReads C6_RUN.2 #[r 51.51257635644988 (-0.14) 200.0]
#guard C6_RUN.1.map (·.osmId) == #[1, 4, 4]
#guard C6_RUN.1.map (·.name) == #[some "Main Street", some "Cross Street", some "Cross Street (dup record)"]

/-! ### `unionById` — first record wins, insertion order kept -/

private def U_A : Array Way := #[
  { osmId := 1, name := some "Main Street", subtype := some "residential", coords := #[p 51.5 (-0.14), p 51.501796622349985 (-0.14), p 51.503593244699964 (-0.14), p 51.50538986704995 (-0.14), p 51.50718648939993 (-0.14), p 51.50898311174991 (-0.14), p 51.51077973409989 (-0.14), p 51.51257635644988 (-0.14), p 51.514372978799855 (-0.14), p 51.51616960114984 (-0.14), p 51.51796622349982 (-0.14), p 51.519762845849804 (-0.14), p 51.52155946819978 (-0.14), p 51.52335609054977 (-0.14), p 51.52515271289975 (-0.14), p 51.52694933524973 (-0.14), p 51.52874595759971 (-0.14), p 51.530542579949696 (-0.14)] },
  { osmId := 4, name := some "Cross Street", subtype := some "residential", coords := #[p 51.51257635644988 (-0.14432910869297655), p 51.51257635644988 (-0.14), p 51.51257635644988 (-0.13567089130702348)] }]
private def U_B : Array Way := #[
  { osmId := 4, name := some "Cross Street (dup record)", subtype := some "residential", coords := #[p 51.514372978799855 (-0.14), p 51.514372978799855 (-0.13567089130702348)] },
  { osmId := 3, name := some "Parallel Road", subtype := some "residential", coords := #[p 51.5 (-0.13920633007295433), p 51.501796622349985 (-0.13920633007295433), p 51.503593244699964 (-0.13920633007295433), p 51.50538986704995 (-0.13920633007295433), p 51.50718648939993 (-0.13920633007295433), p 51.50898311174991 (-0.13920633007295433)] }]
#guard (unionById U_A U_B).map (·.osmId) == #[1, 4, 3]
#guard (unionById U_A U_B).map (·.name) == #[some "Main Street", some "Cross Street", some "Parallel Road"]
#guard (unionById #[] U_B).map (·.osmId) == #[4, 3]

/-! ### `Math.round` — halves go UP, towards +∞ -/

#guard jsRound 0.0 == 0.0
#guard jsRound 0.5 == 1.0
#guard jsRound 1.5 == 2.0
#guard jsRound 2.5 == 3.0
#guard jsRound (-0.5) == 0.0
#guard jsRound (-1.5) == (-1.0)
#guard jsRound 399.4 == 399.0
#guard jsRound 399.5 == 400.0
#guard jsRound 400.5 == 401.0

/-! ### Deliberately unpinned

A mutation sweep over this module leaves four comparisons that no guard can
distinguish. Each survives for a reason, not for want of a fixture.

* **`nextAt ≤ acc + segLen` vs `<`.** When the walk lands exactly on a
  segment's end, BOTH spellings emit that point: `≤` emits it as this
  segment's `t = 1`, and `<` emits it as the next segment's `t = 0` — the
  same coordinate, at the same position in the array, because the segments
  share the vertex. On the FINAL segment `<` instead leaves it to the
  endpoint push, which fires whenever the gap exceeds 1 m; the gap there is a
  whole `step`, and every caller's step is 700 m. `R12` is the fixture that
  lands on the boundary — its step is the segment's own MEASURED length, not
  a round number — and it shows the two agreeing.
* **`segLen > 0` vs `≥ 0`.** The zero-length branch can never iterate:
  `nextAt > acc` holds on entry to every segment (it starts at `step > 0`
  with `acc = 0`, and each segment exits with `nextAt > acc + segLen`), so a
  segment of length zero fails `nextAt ≤ acc + 0` immediately. It becomes
  reachable only at `step = 0`, which `max stepM …` cannot produce for a
  caller passing a positive `stepM` — the only caller passes 700.
* **`d > best` vs `d ≥ best`** in the farthest-fix fold. The two differ only
  in which of two EQUAL values is retained, and the retained number is the
  same either way.
* **`maxDist ≤ 600` vs `<`.** This one needs `maxDist` to be exactly 600.0,
  and a sweep of the two-point N-S family — the endpoint moved one latitude
  ULP at a time, 4,000,000 steps, 2,000,000 distinct distances — never landed on it.
  The closest approaches were 599.9999999995606 below and 600.0000000003515 above.
  The reason is granularity: at 600 m one latitude ULP moves the distance by
  ~7.9e-10 m while the result's own ULP is ~1.14e-13 m, so each input step
  skips thousands of representable outputs. UNPINNED, and measured to be so.
-/

end Guards

end Verified.Geo.OsmCorridor
