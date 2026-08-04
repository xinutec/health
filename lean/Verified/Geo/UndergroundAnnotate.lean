import Verified.Geo.UndergroundJourney
import Verified.Geo.SegmentMerge
import Verified.Geo.Factors
import Verified.Geo.RefineMode
import Verified.Geo.StaySplit
/-!
# Underground run annotation (port of `annotateUndergroundRuns`,
`src/geo/underground-rail.ts`)

The segment-level pass that carves a reconstructed tube ride out of the host
segment it was hiding inside. Underground, the coarse cell-network fixes either
smear a host into a slow "walk" or sit inside an inferred GPS-gap segment;
either way the host spans `walk → tube → walk`, and this splits it into up to
three, with the middle one reconstructed by
`Verified.Geo.UndergroundJourney.reconstructUndergroundJourney`.

Purely additive: a segment with no coarse-fix run passes through untouched.

## `isUndergroundSignal` — the point of the module

This pass hosts the predicate the whole file turns on, and the distinction it
draws against `isCoarse` is load-bearing:

* `isCoarse` — accuracy in `[100, 800]`. Reliable enough to SNAP to a station.
* `isUndergroundSignal` — accuracy `≥ 100`, **no upper bound**. Marks the
  GPS-dark WINDOW.

A total-loss fix (kilometre-scale uncertainty) cannot be snapped to anything,
but its *presence* is itself the evidence: open-air GPS does not report that,
deep tube does. Counting total-loss fixes when detecting the window and
excluding them when snapping is what lets a deep-tube leg whose coarse fixes
alone are too sparse still be recognised. The `deepTube` guard is exactly that
shape — two coarse fixes spanning only 100 s, carried past
`MIN_RUN_DURATION_S` by two kilometre-scale ones — and it fails if the
`COARSE_ACCURACY_MAX_M` cap is added to the predicate.

## Shell

Nothing. All three OSM lookups are INJECTED (`stationsLookup` / `linesLookup` /
`waysLookup`, each defaulted to the DB adapter at the TS call site), so the pass
is `async` only in its plumbing and the whole of it — including the private
`sideWayName` — ports. Same technique as `upgradeTubeHops`.

UNPROVEN; pinned against Node/V8 (`lean/experiments/underground-annotate-refs.mts`).
-/

namespace Verified.Geo.UndergroundAnnotate

open Verified.Geo.UndergroundRun
  (CoarseFix LatLon UndergroundRun COARSE_ACCURACY_M MIN_COARSE_FIXES equirectMeters
   UNDERGROUND_STATION_RADIUS_M)
open Verified.Geo.UndergroundJourney (MAX_COARSE_GAP_S reconstructUndergroundJourney)
open Verified.Geo.TubeHop (NearbyStation)
open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Factors (NearbyWay)

/-- Shortest underground run worth carving out (s). Below this, a stray pair of
coarse fixes in an ordinary walk is just noise. -/
def MIN_RUN_DURATION_S : Int := 180

/-- A surviving side-piece (the walk before/after the tube) shorter than this is
absorbed into the train segment rather than kept as its own sliver. -/
def MIN_SIDE_DURATION_S : Int := 60

/-- Separator marking a wayName that is already an annotated rail triple. -/
def RAIL_ARROW : String := "→"

/-- `Math.round` — halves go UP, towards +∞. Every value rounded here is
non-negative (a distance-derived speed, or a midpoint of two timestamps). -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)

/-- `?? Infinity` for an absent distance: it loses every comparison. -/
private def posInf : Float := 1.0 / 0.0

/-- Any fix that marks the GPS-dark window — a coarse cell-network fix OR a
total-loss fix. **No upper bound**, unlike `isCoarse`; see the module note. -/
def isUndergroundSignal (f : CoarseFix) : Bool :=
  match f.accuracy with
  | none => false
  | some a => a ≥ COARSE_ACCURACY_M

/-- A well-located fix: the complement of `isUndergroundSignal`. A missing
accuracy counts as GOOD (the source reported none, not a bad one). -/
private def isGood (f : CoarseFix) : Bool :=
  match f.accuracy with
  | none => true
  | some a => a < COARSE_ACCURACY_M

/-- How many points along a side piece are sampled for ways. The same count the
enricher uses (`Enrich.N_SAMPLES`), because this asks the enricher's question —
stated separately because the two constants are `velocity.ts`'s and this
module's, and a change to one is not a change to the other. -/
def SIDE_WAY_SAMPLES : Nat := 5

/--
Way label for a side piece of a split host — the walk left over when a tube ride
is carved out of it.

The host's `wayName` was composed across ALL its fixes, both walks plus the
tunnel, so inheriting it stamps the pre-tube walk's street onto the post-tube
walk at the other end of town (measured: a King's Cross walk labelled with a
Belgravia street, #248).

So the piece is named from the PIECE's own points — but by the SAME rule the OSM
enricher uses for any other moving segment, not a local one. Sampling evenly,
deduping ways by MINIMUM distance across samples, and handing the result to
`refineMode` is exactly what `enrichMovingSegment` does; what is left out is the
city lookup and the mode decision, neither of which a carve remainder needs.

Asking a different question was a real defect rather than a stylistic one. The
old rule — three samples, nearest named highway of any type, ties broken by
insertion order so the FIRST fix won — named the 2026-07-15 walk from Work to
King's Cross "Clarence Passage", 14 m from its opening fix, where the enricher
given the same window says "Argyle Street".

`none` when the piece has no points or no way nearby: an honest blank beats a
leaked label.
-/
def sideWayName (points : Array Shed.PointF) (startTs endTs : Int) (mode : String)
    (waysLookup : Float → Float → Array NearbyWay) : Option String :=
  let inPiece := ((points.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs).toList.mergeSort
    fun a b => a.ts ≤ b.ts).toArray
  if inPiece.isEmpty then none else
  let n := inPiece.size
  let sampleCount := min SIDE_WAY_SAMPLES n
  let byKey := Verified.Geo.RefineMode.dedupNearestWays
    ((Verified.Geo.RefineMode.sampleIdxs n sampleCount).map fun i =>
      let p := inPiece[i]!
      waysLookup p.lat p.lon)
  if byKey.isEmpty then none else
  -- The PIECE's own pace. The host's average is the tunnel's, and a walk handed
  -- a train's speed is refined as one.
  let speeds := (inPiece.toList.mergeSort fun a b => a.speedKmh ≤ b.speedKmh).toArray
  let medianKmh := speeds[speeds.size / 2]!.speedKmh
  (Verified.Geo.RefineMode.refineModeLegacyCascade mode medianKmh byKey).wayName

/-- Whether a segment is already an annotated rail run (its label carries the
`Board → Alight` arrow), and so must be left alone. -/
private def alreadyRail (host : Seg) : Bool :=
  host.mode == "train" && ((host.wayName.getD "").splitOn RAIL_ARROW).length > 1

/-- Cluster the host's GPS-dark fixes into runs. A gap longer than
`MAX_COARSE_GAP_S` means GPS recovered in between — one run ended — so a later
unrelated blip cannot be mistaken for part of the same journey. -/
private def clusterRuns (fixes : Array CoarseFix) : Array (Array CoarseFix) :=
  fixes.foldl (init := #[]) fun runs f =>
    match runs.back? with
    | some cur =>
      if f.ts - cur[cur.size - 1]!.ts ≤ MAX_COARSE_GAP_S
      then runs.set! (runs.size - 1) (cur.push f)
      else runs.push #[f]
    | none => runs.push #[f]

private def spanOf (r : Array CoarseFix) : Int := r[r.size - 1]!.ts - r[0]!.ts

/-- How long good GPS has to hold, inside a gap between two dark fixes, to count
as the phone genuinely having come back rather than blinking. -/
def RECOVERY_SPAN_S : Int := 30

/--
Grow a host's run outward through the day's contiguous dark fixes.

The host said WHETHER there is a ride in here; it does not get to say how long
the tunnel is. GPS goes dark when the train enters and returns when it surfaces,
and where the classifier cut a segment boundary has nothing to do with either —
on 2026-05-22 it cut at two mid-tunnel reacquires, so the clipped window resolved
a King's Cross St Pancras → Finchley Road ride as "Euston Square → St John's
Wood", a station in at BOTH ends.

Two things stop the growth: the `MAX_COARSE_GAP_S` contiguity rule, and a
sustained good-GPS recovery inside the gap. The recovery test is asked ONLY here
and not of the run's own interior — inside the host the classifier has already
judged this one continuous moving leg, so a surfacing there is a surfacing.
Growth annexes fixes the classifier gave to a different segment, and that claim
clears a higher bar.
-/
def growThroughDarkness (run all good : Array CoarseFix) : Array CoarseFix :=
  -- Did GPS genuinely come back between these two dark fixes?
  let recovered (fromTs toTs : Int) : Bool :=
    let between := good.filter fun f => f.ts > fromTs && f.ts < toTs
    !between.isEmpty && between[between.size - 1]!.ts - between[0]!.ts ≥ RECOVERY_SPAN_S
  match all.findIdx? (fun f => f.ts ≥ run[0]!.ts) with
  -- The run's fixes are not in `all` — nothing to grow into.
  | none => run
  | some lo0 => Id.run do
    let mut lo := lo0
    let mut hi := all.size - 1
    -- Each loop moves its index one step and never turns back, so `all.size`
    -- bounds the iterations exactly. Not a fuel cap: it is the trip count.
    for _ in [0:all.size] do
      if hi > lo && all[hi]!.ts > run[run.size - 1]!.ts then hi := hi - 1 else break
    for _ in [0:all.size] do
      if lo > 0 && all[lo]!.ts - all[lo - 1]!.ts ≤ MAX_COARSE_GAP_S
          && !recovered all[lo - 1]!.ts all[lo]!.ts then lo := lo - 1 else break
    for _ in [0:all.size] do
      if hi < all.size - 1 && all[hi + 1]!.ts - all[hi]!.ts ≤ MAX_COARSE_GAP_S
          && !recovered all[hi]!.ts all[hi + 1]!.ts then hi := hi + 1 else break
    return all.extract lo (hi + 1)

/-- How close in time and space a well-located fix has to be, on BOTH sides of a
GPS-dark one, to prove the phone was never actually out of contact with the sky.
Deliberately tight on distance: on 2026-07-16 the blip sat 24 m and 50 m from its
neighbours, while every genuine tunnel fix that day sat 570-3242 m from the
nearest good fix. The two populations do not overlap, and it is POSITION
continuity that separates them — accuracy cannot, since the blip's own accuracy
is what raised the question. -/
def BLIP_NEIGHBOUR_S : Nat := 120
def BLIP_NEIGHBOUR_M : Float := 250

/-- Is this dark fix a lone accuracy wobble inside continuous good coverage,
rather than a tunnel?

Underground the phone loses the sky: the fixes around a real blackout are either
dark themselves or hundreds of metres away, because the train covered that ground
while nobody was looking. A fix reporting 134 m of uncertainty while sitting 30 m
from well-located fixes seconds either side reports on the receiver, not on the
journey.

Array order, not time order — the TS scans `good` as given, both ways. -/
def isAccuracyBlip (f : CoarseFix) (good : Array CoarseFix) : Bool :=
  -- `none` is not near: a run end with no good fix beyond it is not a blip.
  let near (g? : Option CoarseFix) : Bool := g?.any fun g =>
    -- `natAbs` IS `Math.abs` here: the TS takes the absolute difference of two
    -- timestamps, which is what the neighbour bound is about on either side.
    (g.ts - f.ts).natAbs ≤ BLIP_NEIGHBOUR_S
      && equirectMeters f.lat f.lon g.lat g.lon ≤ BLIP_NEIGHBOUR_M
  let before := (good.filter fun g => g.ts < f.ts).back?
  let after := (good.filter fun g => g.ts > f.ts)[0]?
  near before && near after

/--
Drop accuracy blips from the END of a run — the fixes that let it outlive the
ride.

The run's tail is what sets the alight: the window closes at the first good fix
after the last dark one, so a blip four minutes into the walk away from the
station moves the alight four minutes late and swallows the walk (2026-07-16, a
Euston Square ride run over a confirmed 07:47-07:54 walk to UCLH).

The tail ONLY. Measured over the corpus, blips are not uniformly noise: filtering
them everywhere also drops poor-GPS indoor stays and mid-ride surfacings,
fragmenting runs that are right today. What is asymmetric is the consequence — an
over-long tail overwrites a confirmed walk, an over-long head does not, and the
boarding anchor already owns the head.

Being a blip is necessary but not sufficient: the rider must also have moved
CLEAR of the blackout, by more than a station's own footprint. Arriving somewhere
is not a tidy event — the phone reacquires on the platform, loses it again under
the concourse roof, and settles outside — so distance is what separates an
arrival from a blip, and the corpus separates cleanly on it.
-/
def trimBlipTail (run good : Array CoarseFix) : Array CoarseFix :=
  Id.run do
    let mut «end» := run.size
    -- `end` only ever decreases, so `run.size` is the exact trip count.
    for _ in [0:run.size] do
      if «end» > 1 && isAccuracyBlip run[«end» - 1]! good
          && equirectMeters run[«end» - 1]!.lat run[«end» - 1]!.lon
               run[«end» - 2]!.lat run[«end» - 2]!.lon > UNDERGROUND_STATION_RADIUS_M
      then «end» := «end» - 1 else break
    return run.extract 0 «end»

/--
Find underground runs hiding inside the day's segments and carve them out as
their own `train` segments.

For each non-stationary segment that is not already an annotated rail run, this
looks for a run of GPS-dark fixes, reconstructs the line(s) via
`reconstructUndergroundJourney`, and — on success — splits the host into the
walk before, one segment per reconstructed leg, and the walk after. Side pieces
shorter than `MIN_SIDE_DURATION_S` are absorbed so the train covers the host's
full span with no slivers.
-/
def annotateUndergroundRuns (segments : Array Seg) (rawFixes : Array CoarseFix)
    (points : Array Shed.PointF)
    (stationsLookup : Float → Float → Array NearbyStation)
    (linesLookup : Float → Float → Array String)
    (waysLookup : Float → Float → Array NearbyWay)
    (servedLookup : String → Array Verified.Geo.LineMembership.ServedStation) : Array Seg :=
  let good := rawFixes.filter isGood
  -- Every GPS-dark fix of the day, in order — the stream a host's run is grown
  -- back out into once the host has established there IS a ride.
  let darkFixes := ((rawFixes.filter isUndergroundSignal).toList.mergeSort
    fun a b => a.ts ≤ b.ts).toArray
  segments.foldl (init := #[]) fun result host =>
    if host.mode == "stationary" || alreadyRail host then result.push host else
    let hostDark := ((rawFixes.filter fun f =>
      f.ts ≥ host.startTs && f.ts ≤ host.endTs && isUndergroundSignal f).toList.mergeSort
        fun a b => a.ts ≤ b.ts).toArray
    let runs := clusterRuns hostDark
    -- The journey is the longest-spanning run that clears the bar.
    let qualifying := runs.filter fun r => r.size ≥ MIN_COARSE_FIXES && spanOf r ≥ MIN_RUN_DURATION_S
    match (qualifying.toList.mergeSort fun a b => spanOf b ≤ spanOf a).head? with
    | none => result.push host
    | some hostRun =>
      -- Grow the run to the tunnel's own ends, then trim a tail that outlived
      -- the ride. Trimmed AFTER growing, so a blip is caught whichever side
      -- annexed it — the host's clustering or the growth past its boundary.
      -- What survives still has to clear the bar the host run cleared, or the
      -- ride would be reconstructed out of evidence just disowned.
      let runFixes := trimBlipTail (growThroughDarkness hostRun darkFixes good) good
      if runFixes.size < MIN_COARSE_FIXES || spanOf runFixes < MIN_RUN_DURATION_S
      then result.push host else
      let runStart := runFixes[0]!.ts
      let runEnd := runFixes[runFixes.size - 1]!.ts
      -- Array order, not time order: the TS scans `good` as given.
      let boarding? := (good.filter fun f => f.ts ≤ runStart).back?
      let alighting? := (good.filter fun f => f.ts ≥ runEnd)[0]?
      match boarding?, alighting? with
      | some boarding, some alighting =>
        -- Good fixes that surfaced INSIDE the run are interchange candidates —
        -- the platform where the rider changed lines.
        --
        -- The STRICTNESS here is provably unobservable, so no guard pins it (a
        -- probe relaxing both bounds to `≥`/`≤` fails nothing). `reconstruct-
        -- UndergroundJourney` re-filters these candidates to strictly inside
        -- the COARSE span, and the coarse fixes are a subset of the dark ones,
        -- so `coarse[0].ts ≥ runStart` and `coarse[last].ts ≤ runEnd`. A fix at
        -- exactly `runStart` therefore fails the inner `> coarse[0].ts` whether
        -- or not this outer filter let it through. Kept as the TS has it.
        let midGood := good.filter fun f => f.ts > runStart && f.ts < runEnd
        let legs := reconstructUndergroundJourney runFixes midGood
          ⟨boarding.lat, boarding.lon⟩ ⟨alighting.lat, alighting.lon⟩ stationsLookup linesLookup
          servedLookup
        if legs.isEmpty then result.push host else
        -- The train window spans the GPS-dark stretch — last good fix before the
        -- run to the first one after, clamped to the host. That covers the real
        -- ride (entering the station, the tunnel, surfacing), not just the
        -- mid-tunnel coarse-fix span.
        let darkStart := max host.startTs boarding.ts
        let darkEnd := min host.endTs alighting.ts
        let keepPre := darkStart - host.startTs ≥ MIN_SIDE_DURATION_S
        let keepPost := host.endTs - darkEnd ≥ MIN_SIDE_DURATION_S
        let trainStart := if keepPre then darkStart else host.startTs
        let trainEnd := if keepPost then darkEnd else host.endTs
        let distM := equirectMeters boarding.lat boarding.lon alighting.lat alighting.lon
        -- The `max 1` divide-by-zero guard is PROVABLY DEAD, so no guard pins
        -- it: `boarding.ts ≤ runStart` and `alighting.ts ≥ runEnd`, both run
        -- endpoints lie inside the host, so `darkEnd - darkStart ≥ runEnd -
        -- runStart ≥ MIN_RUN_DURATION_S`; and dropping either side only widens
        -- the window. The divisor is therefore always ≥ 180. Kept as the TS
        -- has it.
        let speedKmh :=
          jsRound (distM / Float.ofInt (max 1 (trainEnd - trainStart)) * 3.6 * 10) / 10
        -- The changeover sits between one leg's last coarse fix and the next
        -- leg's first.
        let boundaries : Array Int := (Array.range (legs.size - 1)).map fun li =>
          (jsRound (Float.ofInt (legs[li]!.endTs + legs[li + 1]!.startTs) / 2)).toInt64.toInt
        let withPre :=
          if keepPre then
            result.push { host with
              endTs := trainStart, wayName := sideWayName points host.startTs trainStart host.mode waysLookup }
          else result
        let withLegs := (Array.range legs.size).foldl (init := withPre) fun acc li =>
          let leg := legs[li]!
          let segStart := if li == 0 then trainStart else boundaries[li - 1]!
          let segEnd := if li == legs.size - 1 then trainEnd else boundaries[li]!
          let reason :=
            if legs.size > 1 then
              s!"underground reconstruction (interchange leg {li + 1}/{legs.size} on {leg.line})"
            else
              s!"underground reconstruction ({runFixes.size} coarse fixes on {leg.line})"
          acc.push { host with
            startTs := segStart, endTs := segEnd
            mode := "train", refinedMode := some "train"
            confidence := 0.6, confidenceMargin := 1.5
            avgSpeed := speedKmh, maxSpeed := speedKmh
            linearity := 1, pointCount := 0
            place := none, city := none
            wayName := some s!"{leg.boardingStation} → {leg.alightingStation} · {leg.line}"
            refinedReason := some reason }
        if keepPost then
          withLegs.push { host with
            startTs := trainEnd, wayName := sideWayName points trainEnd host.endTs host.mode waysLookup }
        else withLegs
      | _, _ => result.push host

/-! ## Reference values

Pinned against Node/V8 (`lean/experiments/underground-annotate-refs.mts`). The
synthetic frame is the journey harness's: metres north of `51.52, -0.13`, with
three station zones and way names that differ by zone so a leaked side label
would be visible.
-/

section Guards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def north (n : Float) : LatLon := ⟨lat0 + n * mlat, lon0⟩
#guard (north 4000).lat == 51.55593244699964

private def fx (ts : Int) (metresNorth : Float) (accuracy : Option Float) : CoarseFix :=
  let p := north metresNorth
  { ts, lat := p.lat, lon := p.lon, accuracy }

private def stn (name : String) (distanceM : Float) : NearbyStation := { name, distanceM }

private def stations (lat : Float) (_lon : Float) : Array NearbyStation :=
  let m := (lat - lat0) / mlat
  if m < 1000 then #[stn "Highbury & Islington" 40]
  else if m < 3000 then #[stn "King's Cross" 50]
  else #[stn "Wembley Park" 60]

private def oneLine (_lat _lon : Float) : Array String := #["Victoria Line"]

private def changeLines (lat : Float) (_lon : Float) : Array String :=
  let m := (lat - lat0) / mlat
  if m < 1500 then #["Victoria Line"]
  else if m < 2500 then #["Victoria Line", "Metropolitan Line"]
  else #["Metropolitan Line"]

private def noLines (_lat _lon : Float) : Array String := #[]

private def wy (type : String) (name : Option String) (distanceM : Float) : NearbyWay :=
  { type, subtype := "residential", name, distanceM := some distanceM }

private def ways (lat : Float) (_lon : Float) : Array NearbyWay :=
  let m := (lat - lat0) / mlat
  if m < 1000 then #[wy "highway" (some "Holloway Road") 12, wy "highway" (some "Furthest Street") 40]
  else if m < 3000 then #[wy "highway" (some "Midway Road") 8]
  else #[wy "highway" (some "Wembley Park Drive") 15]

private def unnamedWays (_lat _lon : Float) : Array NearbyWay :=
  #[wy "highway" none 5, wy "railway" (some "Metropolitan Line") 3]

private def emptyNameWays (_lat _lon : Float) : Array NearbyWay :=
  #[wy "highway" (some "") 2, wy "highway" (some "Named Street") 30]

private def noWays (_lat _lon : Float) : Array NearbyWay := #[]

/-- The host: a "walk" spanning walk → tube → walk. -/
private def HOST : Seg :=
  { startTs := 500, endTs := 2100, mode := "walking"
    confidence := 0.8, confidenceMargin := 2
    avgSpeed := 4, maxSpeed := 6, linearity := 0.5, pointCount := 10
    wayName := some "Composed Across Everything" }

private def GOOD : Array CoarseFix :=
  #[fx 500 0 (some 10), fx 700 100 (some 12), fx 900 200 (some 15),
    fx 1700 3900 (some 15), fx 1900 4000 (some 12), fx 2100 4050 none]

private def COARSE : Array CoarseFix :=
  #[fx 1000 200 (some 200), fx 1200 1500 (some 250),
    fx 1400 3200 (some 250), fx 1600 3800 (some 200)]

/-- The output fields this pass decides. `""` stands for an absent string. -/
private structure Row where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : String
  wayName : String
  place : String
  city : String
  avgSpeed : Float
  maxSpeed : Float
  confidence : Float
  confidenceMargin : Float
  linearity : Float
  pointCount : Int
  reason : String
  deriving BEq, Repr

private def vw (segs : Array Seg) : Array Row :=
  segs.map fun s =>
    { startTs := s.startTs, endTs := s.endTs, mode := s.mode
      refinedMode := s.refinedMode.getD "", wayName := s.wayName.getD ""
      place := s.place.getD "", city := s.city.getD ""
      avgSpeed := s.avgSpeed, maxSpeed := s.maxSpeed
      confidence := s.confidence, confidenceMargin := s.confidenceMargin
      linearity := s.linearity, pointCount := s.pointCount
      reason := s.refinedReason.getD "" }

/-- The Kalman track `sideWayName` samples, derived from the case's own fixes so
every case has a track covering its span. Mirrors the refs harness exactly: time
order, and a constant walking pace, because the pace is what `refineMode` reads
and a walk handed a train's speed is refined as one. -/
private def track (fixes : Array CoarseFix) : Array Shed.PointF :=
  ((fixes.toList.mergeSort fun a b => a.ts ≤ b.ts).map fun f =>
    ({ ts := f.ts, lat := f.lat, lon := f.lon, speedKmh := 4 } : Shed.PointF)).toArray

/-- No line's stops are known, so the membership veto never fires. -/
private def servedNothing (_line : String) : Array Verified.Geo.LineMembership.ServedStation := #[]

private def run (segments : Array Seg) (fixes : Array CoarseFix)
    (lines : Float → Float → Array String := oneLine)
    (w : Float → Float → Array NearbyWay := ways) : Array Row :=
  vw (annotateUndergroundRuns segments fixes (track fixes) stations lines w servedNothing)

/-- The host untouched. -/
private def PASS : Array Row := vw #[HOST]

private def preWalk : Row :=
  { startTs := 500, endTs := 900, mode := "walking", refinedMode := ""
    wayName := "Holloway Road", place := "", city := ""
    avgSpeed := 4, maxSpeed := 6, confidence := 0.8, confidenceMargin := 2
    linearity := 0.5, pointCount := 10, reason := "" }

private def postWalk : Row :=
  { startTs := 1700, endTs := 2100, mode := "walking", refinedMode := ""
    wayName := "Wembley Park Drive", place := "", city := ""
    avgSpeed := 4, maxSpeed := 6, confidence := 0.8, confidenceMargin := 2
    linearity := 0.5, pointCount := 10, reason := "" }

private def trainLeg (nFixes : Nat) : Row :=
  { startTs := 900, endTs := 1700, mode := "train", refinedMode := "train"
    wayName := "Highbury & Islington → Wembley Park · Victoria Line", place := "", city := ""
    avgSpeed := 16.6, maxSpeed := 16.6, confidence := 0.6, confidenceMargin := 1.5
    linearity := 1, pointCount := 0
    reason := s!"underground reconstruction ({nFixes} coarse fixes on Victoria Line)" }

-- The whole pass, happy path: walk / train / walk, each side piece carrying its
-- OWN way label rather than the host's composed-across-everything one.
#guard run #[HOST] (GOOD ++ COARSE) == #[preWalk, trainLeg 4, postWalk]

private def legOne : Row :=
  { startTs := 900, endTs := 1250, mode := "train", refinedMode := "train"
    wayName := "Highbury & Islington → King's Cross · Victoria Line", place := "", city := ""
    avgSpeed := 16.6, maxSpeed := 16.6, confidence := 0.6, confidenceMargin := 1.5
    linearity := 1, pointCount := 0
    reason := "underground reconstruction (interchange leg 1/2 on Victoria Line)" }

private def legTwo : Row :=
  { startTs := 1250, endTs := 1700, mode := "train", refinedMode := "train"
    wayName := "King's Cross → Wembley Park · Metropolitan Line", place := "", city := ""
    avgSpeed := 16.6, maxSpeed := 16.6, confidence := 0.6, confidenceMargin := 1.5
    linearity := 1, pointCount := 0
    reason := "underground reconstruction (interchange leg 2/2 on Metropolitan Line)" }

-- TWO legs: the reason switches to the interchange form and a boundary
-- timestamp is minted between them (`round((1100 + 1400) / 2)` = 1250). Needs a
-- GOOD fix surfaced mid-run — the platform at the changeover.
#guard run #[HOST]
  #[fx 500 0 (some 10), fx 900 200 (some 15), fx 1250 2000 (some 20),
    fx 1700 3900 (some 15), fx 2100 4050 none,
    fx 1000 200 (some 200), fx 1100 800 (some 250),
    fx 1400 3200 (some 250), fx 1600 3800 (some 200)] changeLines
  == #[preWalk, legOne, legTwo, postWalk]

-- `isUndergroundSignal`, THE LEAF. The two COARSE fixes span only 100 s, under
-- MIN_RUN_DURATION_S, so on their own they are not a run at all. The two
-- kilometre-scale fixes carry the dark window out to 600 s, and reconstruction
-- then re-filters to the coarse pair to snap the line. Restoring
-- COARSE_ACCURACY_MAX_M to the predicate loses the ride entirely.
#guard run #[HOST]
  (GOOD ++ #[fx 1000 200 (some 200), fx 1100 800 (some 250),
             fx 1350 2400 (some 5000), fx 1600 3800 (some 9999)])
  == #[preWalk, trainLeg 4, postWalk]

-- The lower edge, isolated. 100 exactly IS a signal, so the run has two fixes
-- 300 s apart and qualifies.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 100), fx 1300 2400 (some 250)])
  == #[preWalk, trainLeg 2, postWalk]
-- 99 is a GOOD fix, leaving a single dark fix and no run at all.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 99), fx 1300 2400 (some 250)]) == PASS
-- A missing accuracy is never a signal (and counts as good).
#guard run #[HOST] (GOOD ++ #[fx 1000 200 none, fx 1300 2400 (some 250)]) == PASS

-- RUN SELECTION. A gap above MAX_COARSE_GAP_S splits the dark fixes into two
-- runs; neither half clears MIN_RUN_DURATION_S, so nothing is carved out.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200), fx 1100 800 (some 250),
                              fx 1500 3400 (some 250), fx 1600 3800 (some 200)]) == PASS
-- Exactly 300 s apart is still ONE run — the test is `≤`.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200), fx 1300 2400 (some 250),
                              fx 1600 3800 (some 200)])
  == #[preWalk, trainLeg 3, postWalk]
-- A span of exactly 180 s clears the bar (`≥`); 179 does not.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200), fx 1180 3800 (some 200)])
  == #[preWalk, trainLeg 2, postWalk]
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200), fx 1179 3800 (some 200)]) == PASS
-- One dark fix is below MIN_COARSE_FIXES.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200)]) == PASS

private def longRunTrain : Row :=
  { startTs := 900, endTs := 1900, mode := "train", refinedMode := "train"
    wayName := "Highbury & Islington → Wembley Park · Victoria Line", place := "", city := ""
    avgSpeed := 13.7, maxSpeed := 13.7, confidence := 0.6, confidenceMargin := 1.5
    linearity := 1, pointCount := 0
    reason := "underground reconstruction (2 coarse fixes on Victoria Line)" }

-- TWO qualifying runs: the LONGEST-spanning wins, not the first. Run A spans
-- 200 s and would give a train window of 900-1700; run B spans 250 s and gives
-- 900-1900, so the choice is visible in the output.
#guard run #[HOST] (GOOD ++ #[fx 1000 200 (some 200), fx 1200 300 (some 250),
                              fx 1600 3400 (some 250), fx 1850 3800 (some 200)])
  == #[preWalk, longRunTrain, { postWalk with startTs := 1900 }]

-- BRACKETING GOOD FIXES. No good fix at or before the run start: nothing to
-- board from; and none after it: nothing to alight at.
#guard run #[HOST] (#[fx 1700 3900 (some 15), fx 1900 4000 (some 12)] ++ COARSE) == PASS
#guard run #[HOST] (#[fx 500 0 (some 10), fx 900 200 (some 15)] ++ COARSE) == PASS
-- No line resolves anywhere: reconstruction yields no legs.
#guard run #[HOST] (GOOD ++ COARSE) noLines == PASS

-- HOST FILTERING. A stationary host is never touched.
#guard run #[{ HOST with mode := "stationary" }] (GOOD ++ COARSE)
  == vw #[{ HOST with mode := "stationary" }]
-- An already-annotated rail run (its label carries the arrow) is left alone.
#guard run #[{ HOST with mode := "train", wayName := some "A → B · Victoria Line" }] (GOOD ++ COARSE)
  == vw #[{ HOST with mode := "train", wayName := some "A → B · Victoria Line" }]
-- A train segment WITHOUT the arrow is not already-rail, so it is processed —
-- and the side pieces keep the host's `train` mode.
--
-- They also come out UNNAMED, which is the enricher's rule doing its job rather
-- than a loss: `sideWayName` hands the host's mode to the cascade, and a `train`
-- with no railway in the sampled ways takes the "no rail evidence" arm, whose
-- answer carries no `wayName` at all. The old local rule ignored the mode and
-- named it anyway.
#guard run #[{ HOST with mode := "train", wayName := some "Some Street" }] (GOOD ++ COARSE)
  == #[{ preWalk with mode := "train", wayName := "" }, trainLeg 4,
       { postWalk with mode := "train", wayName := "" }]

-- SIDE-PIECE TRIMMING. A host starting exactly MIN_SIDE_DURATION_S before the
-- boarding fix keeps its pre piece (`≥`).
#guard run #[{ HOST with startTs := 840 }] (GOOD ++ COARSE)
  == #[{ preWalk with startTs := 840 }, trainLeg 4, postWalk]
-- One second under, the sliver is absorbed and the train starts at the host's
-- own start — which also lengthens the window, so the speed drops.
#guard run #[{ HOST with startTs := 841 }] (GOOD ++ COARSE)
  == #[{ trainLeg 4 with startTs := 841, avgSpeed := 15.5, maxSpeed := 15.5 }, postWalk]
#guard run #[{ HOST with endTs := 1760 }] (GOOD ++ COARSE)
  == #[preWalk, trainLeg 4, { postWalk with endTs := 1760 }]
#guard run #[{ HOST with endTs := 1759 }] (GOOD ++ COARSE)
  == #[preWalk, { trainLeg 4 with endTs := 1759, avgSpeed := 15.5, maxSpeed := 15.5 }]

-- sideWayName. No named highway near the side pieces: an honest blank, not a
-- leaked label. The nearer `railway` must not be picked.
#guard run #[HOST] (GOOD ++ COARSE) oneLine unnamedWays
  == #[{ preWalk with wayName := "" }, trainLeg 4, { postWalk with wayName := "" }]
#guard run #[HOST] (GOOD ++ COARSE) oneLine noWays
  == #[{ preWalk with wayName := "" }, trainLeg 4, { postWalk with wayName := "" }]
-- An EMPTY name now WINS, and that is the enricher's rule, not a defect here.
-- The old local rule filtered to named highways, so a 2 m empty-named way lost
-- to a 30 m named one. The cascade does not filter: `pickBestHighway` takes the
-- nearest outright, the empty name is inside `WALK_NAME_BORROW_MAX_M` so the
-- borrow is never reached, and the piece comes out blank.
--
-- Kept as a guard because it is exactly the case that separates the two rules —
-- and because if this is wrong it is wrong in `refineMode`, for every walk in
-- the app, not just for a carve remainder.
#guard run #[HOST] (GOOD ++ COARSE) oneLine emptyNameWays
  == #[{ preWalk with wayName := "" }, trainLeg 4, { postWalk with wayName := "" }]

private def homeStay : Seg :=
  { startTs := 0, endTs := 400, mode := "stationary"
    avgSpeed := 4, maxSpeed := 6, linearity := 0.5, pointCount := 10, place := some "Home" }

private def afterWalk : Seg :=
  { startTs := 2100, endTs := 2500, mode := "walking"
    avgSpeed := 4, maxSpeed := 6, linearity := 0.5, pointCount := 10
    wayName := some "After Street" }

-- Several hosts in one call, including ones that pass through untouched.
#guard run #[homeStay, HOST, afterWalk] (GOOD ++ COARSE)
  == (vw #[homeStay]) ++ #[preWalk, trainLeg 4, postWalk] ++ (vw #[afterWalk])

-- SAMPLING ACROSS ZONES. The pre-walk piece has its FIRST point in one way-zone
-- and its other two in another, so the samples disagree about what is nearby.
--
-- The answer is "Holloway Road" at 12 m, even though "Midway Road" at 8 m is in
-- the deduped set and is NEARER. The cascade's `pickBestHighway` reads
-- `highways[0]` at walking pace, trusting the adapter's closest-first order —
-- and the dedup does not preserve it: entries land in first-SAMPLE order, so
-- the first sample's ways precede every later sample's however far away they
-- are. Recorded as the behaviour, not endorsed; if it is wrong it is wrong for
-- every segment the enricher names, not only for a carve remainder.
#guard run #[HOST]
  (#[fx 500 200 (some 10), fx 700 1200 (some 12), fx 900 1500 (some 15),
     fx 1700 3900 (some 15), fx 1900 4000 (some 12), fx 2100 4050 none] ++ COARSE)
  == #[{ preWalk with wayName := "Holloway Road" },
       { trainLeg 4 with wayName := "King's Cross → Wembley Park · Victoria Line"
                         avgSpeed := 10.8, maxSpeed := 10.8 },
       postWalk]

-- A THREE-WAY TIE on one vote each: the FIRST-inserted name wins, because the
-- TS sorts the entries descending with a stable sort and takes the head. The
-- LAST pre-piece fix has to stay near the boarding station, or both ends of the
-- run resolve to the same station and it is refused before this is reached.
#guard run #[HOST]
  (#[fx 500 1500 (some 10), fx 700 3500 (some 12), fx 900 200 (some 15),
     fx 1700 3900 (some 15), fx 1900 4000 (some 12), fx 2100 4050 none] ++ COARSE)
  == #[{ preWalk with wayName := "Midway Road" }, trainLeg 4, postWalk]

-- A GOOD fix at exactly the run's first timestamp: the boarding scan is `≤`, so
-- it — not the earlier one — boards, which moves the train window.
#guard run #[HOST] (GOOD ++ #[fx 1000 250 (some 15)] ++ COARSE)
  == #[{ preWalk with endTs := 1000 },
       { trainLeg 4 with startTs := 1000, avgSpeed := 18.8, maxSpeed := 18.8 },
       postWalk]

-- A dark fix at exactly the host's END: the host window is INCLUSIVE both ends,
-- so it belongs to the run. Excluding it drops the run below the span bar.
#guard run #[{ HOST with endTs := 1300 }]
  #[fx 500 0 (some 10), fx 900 200 (some 15), fx 1900 4000 (some 12),
    fx 1000 200 (some 200), fx 1300 2400 (some 250)]
  == #[preWalk, { trainLeg 2 with endTs := 1300, avgSpeed := 34.2, maxSpeed := 34.2 }]

-- A NON-train segment whose label happens to carry an arrow is NOT an
-- already-annotated rail run — the mode half of the test is load-bearing.
#guard run #[{ HOST with wayName := some "A → B" }] (GOOD ++ COARSE)
  == #[preWalk, trainLeg 4, postWalk]
-- The already-rail test is on the ARROW alone: the arrow with no line separator
-- still counts...
#guard run #[{ HOST with mode := "train", wayName := some "A → B" }] (GOOD ++ COARSE)
  == vw #[{ HOST with mode := "train", wayName := some "A → B" }]
-- ...and the line separator without an arrow does NOT. (Side pieces unnamed for
-- the same reason as the `Some Street` case above: a `train` host, no railway.)
#guard run #[{ HOST with mode := "train", wayName := some "Some · Street" }] (GOOD ++ COARSE)
  == #[{ preWalk with mode := "train", wayName := "" }, trainLeg 4,
       { postWalk with mode := "train", wayName := "" }]

-- A host carrying a place: the train legs CLEAR it (the ride is not at the
-- place), while the side walks inherit it through the record spread.
#guard run #[{ HOST with place := some "Home", city := some "London" }] (GOOD ++ COARSE)
  == #[{ preWalk with place := "Home", city := "London" }, trainLeg 4,
       { postWalk with place := "Home", city := "London" }]

#guard run #[] #[] == #[]

end Guards

end Verified.Geo.UndergroundAnnotate
