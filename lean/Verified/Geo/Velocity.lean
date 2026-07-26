import Verified.Geo.RailRoadProximity
import Verified.Geo.SegmentMerge
import Verified.Geo.Segments
import Verified.JsNum
/-!
# Velocity-owned pure kernels (port of the pure helpers in `src/geo/velocity.ts`)

`velocity.ts` is mostly the post-decode ORCHESTRATOR — it loads GPS/biometrics
from the DB, resolves tz, and sequences ~40 pass modules. That sequencing stays
shell (TS→Rust last); each pass is ported in its own tier. This module ports the
pure numeric kernels velocity.ts itself *owns*:

* `localSolarHour` / `hasOvernightPresence` — solar-time from a unix instant
  (used to mark a stay "residential" by deep-night coverage).
* `computeRailRoadProximity` / `computeRoadNearestFraction` — per-segment
  rail-vs-road GPS evidence aggregated over a segment's sampled `nearbyWays`
  (siblings of `railRoadDistFromWays`; the HSMM train override weighs these).
* `batterySeries` / `appendBatteryTail` — the battery-chart reduction.

`localSolarHour` is pure integer arithmetic on the epoch (`getUTCHours/Minutes`
are deterministic functions of `ts`, no tz): `utcMinutes = ⌊ts/60⌋ mod 1440`.
The proximity kernels are `min`/mean over a filtered list — no transcendentals,
exact. Battery is filter + one linear interpolation (`Math.round`). UNPROVEN;
pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.Velocity

open Verified.Geo.RailRoadProximity (NearbyWay RAIL_ONLY_SUBTYPES DRIVABLE_HIGHWAY_SUBTYPES)

/-- `Math.round` — round half toward +∞. -/
private def roundHalfUp (x : Float) : Float := Float.floor (x + 0.5)

/-! ## Solar time -/

/-- Local solar hour (0..23) at a unix-second instant and longitude. Longitude
    stands in for tz: each 15° ≈ 1 h. Mirrors JS: `utcMinutes` from the epoch,
    shift by `lon/15` hours, wrap into `[0,1440)` minutes, floor to the hour.
    The `((x % m) + m) % m` normaliser equals the Euclidean floor-mod used here. -/
def localSolarHour (ts : Int) (lon : Float) : Float :=
  let utcMinutes : Float := Float.ofInt ((ts / 60) % 1440)
  let localMin := utcMinutes + (lon / 15) * 60
  let wrapped := localMin - Float.floor (localMin / 1440) * 1440
  Float.floor (wrapped / 60)

/-- A `[startTs,endTs]` window has "overnight presence" iff it covers ≥1 h of
    deep-night solar time (hour ∈ [0,6)), sampled every 30 min. -/
def hasOvernightPresence (startTs endTs : Int) (lon : Float) : Bool := Id.run do
  let stepSec : Int := 30 * 60
  let mut overnight : Float := 0
  let mut t := startTs
  while decide (t ≤ endTs) do
    let h := localSolarHour t lon
    if decide (h ≥ 0) && decide (h < 6) then
      overnight := overnight + Float.ofInt stepSec / 3600
    t := t + stepSec
  return decide (overnight ≥ 1)

/-! ## Per-segment rail-vs-road proximity

Each element of `wayResults` is one sample point's `nearbyWays`. Per sample we
take the min distance to any rail-only way and to any drivable road; then mean
across the samples that had each kind in range (`none` when none did). -/

/-- Min rail-only and min drivable-road distance within one sample's ways
    (`+∞` when absent), sharing the subtype rules of `railRoadDistFromWays`. -/
private def sampleMinRailRoad (sample : List NearbyWay) : Float × Float :=
  let inf : Float := 1.0 / 0.0
  sample.foldl (fun (acc : Float × Float) w =>
    match w.distanceM with
    | none => acc
    | some d =>
      if !d.isFinite then acc
      else if w.type == "railway" && RAIL_ONLY_SUBTYPES.contains w.subtype then (min acc.1 d, acc.2)
      else if w.type == "highway" && DRIVABLE_HIGHWAY_SUBTYPES.contains w.subtype then (acc.1, min acc.2 d)
      else acc) (inf, inf)

private def meanOpt (xs : List Float) : Option Float :=
  if xs.isEmpty then none else some (xs.foldl (· + ·) 0 / xs.length.toFloat)

/-- Mean nearest rail / mean nearest drivable-road distance over the segment's
    samples (per-kind, skipping samples with that kind out of range). -/
def computeRailRoadProximity (wayResults : List (List NearbyWay)) : Option Float × Option Float :=
  let (railDists, roadDists) := wayResults.foldl (fun (acc : List Float × List Float) sample =>
    let (minRail, minRoad) := sampleMinRailRoad sample
    (if minRail.isFinite then acc.1 ++ [minRail] else acc.1,
     if minRoad.isFinite then acc.2 ++ [minRoad] else acc.2)) ([], [])
  (meanOpt railDists, meanOpt roadDists)

/-- Minimum usable samples before a road-vs-rail verdict is emitted. -/
def ROAD_FRACTION_MIN_SAMPLES : Nat := 3

/-- Fraction of usable samples whose nearest drivable road is closer than any
    rail-only way. `none` when fewer than `ROAD_FRACTION_MIN_SAMPLES` samples
    carry usable proximity. -/
def computeRoadNearestFraction (wayResults : List (List NearbyWay)) : Option Float := Id.run do
  let mut roadNearer : Nat := 0
  let mut total : Nat := 0
  for sample in wayResults do
    let (minRail, minRoad) := sampleMinRailRoad sample
    if minRail.isFinite || minRoad.isFinite then
      total := total + 1
      if decide (minRoad < minRail) then roadNearer := roadNearer + 1
  if total < ROAD_FRACTION_MIN_SAMPLES then return none
  return some (roadNearer.toFloat / total.toFloat)

/-! ## Battery chart -/

/-- One battery reading: `(ts, level%)`. -/
abbrev BatterySample := Int × Int

/-- Reduce per-fix battery readings to chart endpoints: drop null readings,
    collapse same-`ts` runs to their first, then keep a reading iff it is a
    series endpoint or its level differs from the neighbour before or after.
    Assumes ascending `ts`. -/
def batterySeries (points : List (Int × Option Int)) : List BatterySample := Id.run do
  let all : Array BatterySample := points.foldl (fun acc (ts, b) =>
    match b with | some lvl => acc.push (ts, lvl) | none => acc) #[]
  -- collapse runs sharing a timestamp to the first sample
  let mut read : Array BatterySample := #[]
  for i in [0:all.size] do
    if i == 0 || (all[i]!).1 != (all[i-1]!).1 then read := read.push all[i]!
  let mut out : List BatterySample := []
  for i in [0:read.size] do
    let s := read[i]!
    let prevDiff := i == 0 || s.2 != (read[i-1]!).2
    let nextDiff := i + 1 ≥ read.size || s.2 != (read[i+1]!).2
    if prevDiff || nextDiff then out := out ++ [s]
  return out

/-- Extend the series to the day boundary when the phone reported again only
    after midnight: interpolate the level where the last-reading→`tail` line
    crosses `dayEndTs` and append it. No-op without a tail / in-day series, or
    when the tail does not postdate the last in-day sample. -/
def appendBatteryTail (series : List BatterySample) (tail : Option BatterySample)
    (dayEndTs : Int) : List BatterySample :=
  match tail, series.getLast? with
  | some (tailTs, tailLvl), some (lastTs, lastLvl) =>
    if decide (tailTs ≤ lastTs) || decide (dayEndTs ≤ lastTs) then series
    else
      let frac := min 1 (Float.ofInt (dayEndTs - lastTs) / Float.ofInt (tailTs - lastTs))
      let level := roundHalfUp (Float.ofInt lastLvl + Float.ofInt (tailLvl - lastLvl) * frac)
      series ++ [(dayEndTs, level.toInt64.toInt)]
  | _, _ => series

/-! ## Parity with Node/V8 (values from `lean/experiments/velocity-refs.mts`) -/

private def t0 : Int := 1768435200  -- 2026-01-15 00:00:00 UTC
#guard localSolarHour t0 (-0.1) == 23
#guard localSolarHour (t0 + 3 * 3600) (-0.1) == 2
#guard localSolarHour (t0 + 12 * 3600) (-0.1) == 11
#guard localSolarHour (t0 + 6 * 3600) 100.0 == 12
#guard localSolarHour t0 (-120.0) == 16
#guard hasOvernightPresence t0 (t0 + 5 * 3600) (-0.1) == true
#guard hasOvernightPresence (t0 + 12 * 3600) (t0 + 14 * 3600) (-0.1) == false
#guard hasOvernightPresence (t0 + 2 * 3600) (t0 + 2 * 3600 + 30 * 60) (-0.1) == true

private def w (d : Float) (ty sub : String) : NearbyWay := ⟨some d, ty, sub⟩
private def nd (ty sub : String) : NearbyWay := ⟨none, ty, sub⟩
private def sampleWays : List (List NearbyWay) := [
  [w 100 "railway" "rail", w 60 "railway" "subway", w 40 "highway" "primary",
   w 5 "railway" "tram", w 3 "highway" "footway"],
  [w 20 "highway" "motorway", w 200 "railway" "rail"],
  [nd "highway" "service", w 10 "waterway" "river"],
  [w 15 "railway" "light_rail"]]
private def approxV (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard match computeRailRoadProximity sampleWays with
  | (some r, some d) => approxV r 91.66666666666667 && approxV d 30
  | _ => false
#guard match computeRoadNearestFraction sampleWays with
  | some f => approxV f 0.6666666666666666
  | none => false
#guard computeRoadNearestFraction (sampleWays.take 2) == none

private def batPts : List (Int × Option Int) :=
  [(0, some 90), (10, some 90), (20, some 90), (30, some 85), (30, some 84),
   (40, none), (50, some 84), (60, some 80)]
#guard batterySeries batPts == [(0, 90), (20, 90), (30, 85), (50, 84), (60, 80)]
#guard appendBatteryTail (batterySeries batPts) (some (120, 60)) 90
  == [(0, 90), (20, 90), (30, 85), (50, 84), (60, 80), (90, 70)]
#guard appendBatteryTail (batterySeries batPts) (some (55, 60)) 90
  == [(0, 90), (20, 90), (30, 85), (50, 84), (60, 80)]

end Verified.Geo.Velocity

/-! ## `stationaryCoherence`

One of the two pass bodies written INLINE in `computeVelocityFromInputs` rather
than in a module of its own, so it is ported here beside velocity's other owned
kernels.

The constraint: a segment the classifier called `stationary` but whose fixes
march in a directed line over real ground is slow LOCOMOTION — a walk to a
platform — not a stay. Low per-fix speed is what misread it.

It runs FIRST in the pass order, before merge and before place attribution, so a
reclassified walk both coalesces with the adjacent walk and never gets named
after a POI it merely drifted past (the 2026-06-12 "Bleecker" / "The Other
Palace" phantoms). That ordering is the reason the pass exists where it does.

The subtlety is #354: the decision reads TWO displacements. The raw one is
first→last across the whole window; the CORE one severs the window at every
vehicle-paced step and measures only the largest pedestrian run. A ride's head
stranded in a long stay's tail shows a kilometre-scale raw displacement, and
without the core figure it would flip hours of real dwelling into one giant walk.
The guards carry that case at 5993 m raw against 4 m core.

The `place` label is DROPPED on a flip: it was attributed to a stay that no
longer exists, and is not evidence about a walk.

Shell: the `STAY_FLIP_DEBUG` tracing arm.

UNPROVEN; pinned against Node/V8
(`lean/experiments/stationary-coherence-refs.mts`).
-/

namespace StationaryCoherence

open Verified.Geo.SegmentMerge (Seg)
open Verified.Geo.Segments (PedFix isStationaryIncoherent pedestrianCoreDisplacementM)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- `refinedMode ?? mode` — the TS `effectiveMode` that velocity.ts imports from
`passes/vehicle-identity.ts`. The same rule as `SegmentPasses.effectiveMode` and
`Shed.segMode`, restated here because each is typed on its own record. -/
private def effectiveMode (s : Seg) : String := s.refinedMode.getD s.mode

/-- A Kalman fix as this pass reads it. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- `samplesInWindow` — inclusive at both ends. -/
private def inWindow (points : Array Fix) (s : Seg) : Array Fix :=
  points.filter fun p => p.ts ≥ s.startTs && p.ts ≤ s.endTs

/-- Reclassify a "stay" that is really a directed march as walking. -/
def stationaryCoherence (segs : Array Seg) (points : Array Fix) : Array Seg :=
  segs.map fun seg =>
    if effectiveMode seg != "stationary" then seg
    else
      let segPoints := inWindow points seg
      if segPoints.size < 2 then seg
      else
        let first := segPoints[0]!
        let last := segPoints[segPoints.size - 1]!
        let netDisplacementM := haversineMeters first.lat first.lon last.lat last.lon
        let coreDisplacementM :=
          pedestrianCoreDisplacementM (segPoints.map fun p => ({ ts := p.ts, lat := p.lat, lon := p.lon } : PedFix))
        let durationS := Float.ofInt (seg.endTs - seg.startTs)
        if !isStationaryIncoherent seg.linearity netDisplacementM coreDisplacementM durationS then seg
        else
          let netStr := (Verified.JsNum.toFixed netDisplacementM 0).getD ""
          let linStr := (Verified.JsNum.toFixed seg.linearity 2).getD ""
          { seg with
            mode := "walking", refinedMode := some "walking", place := none
            refinedReason := some
              s!"stationary-coherence override (linear {netStr} m progress, lin {linStr} — moving, not a stay)" }

/-! ### Reference values -/

section CoherenceGuards

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def cfx (ts : Int) (metresNorth : Float) : Fix :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0 }

private def cseg : Seg :=
  { startTs := 0, endTs := 600, mode := "stationary", linearity := 0.9
    place := some "The Other Palace" }

/-- A directed 300 m march over 10 minutes: locomotion misread as a stay. -/
private def MARCH : Array Fix := (Array.range 11).map fun k => cfx (60 * Int.ofNat k) (30 * Float.ofNat k)
/-- Barely moving: 20 m of drift over the same window. -/
private def DRIFT : Array Fix := (Array.range 11).map fun k => cfx (60 * Int.ofNat k) (2 * Float.ofNat k)

/-- Hours of real dwelling, then a ride's head stranded in the tail (#354). -/
private def DWELL_RIDE_TAIL : Array Fix :=
  ((Array.range 20).map fun k => cfx (600 * Int.ofNat k) (if k % 2 == 0 then 0 else 4))
    ++ #[cfx 11700 3000, cfx 12000 6000]

private structure CRow where
  mode : String
  refinedMode : String
  place : String
  reason : String
  deriving Inhabited, BEq, Repr

private def cv (segs : Array Seg) : Array CRow :=
  segs.map fun s =>
    { mode := s.mode, refinedMode := s.refinedMode.getD "", place := s.place.getD ""
      reason := s.refinedReason.getD "" }

private def crun (segs : Array Seg) (pts : Array Fix) : Array CRow :=
  cv (stationaryCoherence segs pts)

/-- The stay as it went in: nothing touched. -/
private def held : CRow :=
  { mode := "stationary", refinedMode := "", place := "The Other Palace", reason := "" }
private def flipped (m lin : String) : CRow :=
  { mode := "walking", refinedMode := "walking", place := ""
    reason := s!"stationary-coherence override (linear {m} m progress, lin {lin} — moving, not a stay)" }

-- The two displacements the decision reads, pinned before the verdicts so the
-- guards cover the arithmetic and not just the outcome.
private def approxM (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def pedOf (pts : Array Fix) : Array PedFix :=
  pts.map fun p => { ts := p.ts, lat := p.lat, lon := p.lon }
#guard approxM (haversineMeters MARCH[0]!.lat MARCH[0]!.lon MARCH[10]!.lat MARCH[10]!.lon) 299.662935621121
#guard approxM (pedestrianCoreDisplacementM (pedOf MARCH)) 299.662935621121
#guard approxM (haversineMeters DWELL_RIDE_TAIL[0]!.lat DWELL_RIDE_TAIL[0]!.lon
  DWELL_RIDE_TAIL[21]!.lat DWELL_RIDE_TAIL[21]!.lon) 5993.258712427161
#guard approxM (pedestrianCoreDisplacementM (pedOf DWELL_RIDE_TAIL)) 3.9955058081341304

-- A directed march the classifier called a stay: flipped, and the place label is
-- DROPPED — it was never evidence about a walk.
#guard crun #[cseg] MARCH == #[flipped "300" "0.90"]
-- Barely-moving drift, and wandering rather than marching, are left alone.
#guard crun #[cseg] DRIFT == #[held]
#guard crun #[{ cseg with linearity := 0.3 }] MARCH == cv #[{ cseg with linearity := 0.3 }]

-- WHO PARTICIPATES: the EFFECTIVE mode, so a refinement in either direction
-- counts — the OPPOSITE of the stay-split passes, which read the raw mode.
#guard crun #[{ cseg with mode := "walking" }] MARCH == cv #[{ cseg with mode := "walking" }]
#guard crun #[{ cseg with mode := "walking", refinedMode := some "stationary" }] MARCH
  == #[flipped "300" "0.90"]
#guard crun #[{ cseg with refinedMode := some "walking" }] MARCH
  == cv #[{ cseg with refinedMode := some "walking" }]

-- Fewer than two fixes in the window: nothing to measure.
#guard crun #[{ cseg with endTs := 30 }] MARCH == cv #[{ cseg with endTs := 30 }]
#guard crun #[{ cseg with startTs := 20000, endTs := 20600 }] MARCH
  == cv #[{ cseg with startTs := 20000, endTs := 20600 }]

-- #354: 6 km of raw displacement against a 4 m pedestrian core — the hours of
-- dwelling survive the ride head stranded in the tail. Without the core figure
-- this is the 07-07 phantom: a whole afternoon redrawn as one giant walk.
#guard crun #[{ cseg with endTs := 13200, linearity := 0.95 }] DWELL_RIDE_TAIL
  == cv #[{ cseg with endTs := 13200, linearity := 0.95 }]

-- The window is a STRICT SUBSET of the fix array, and that is what is measured:
-- the first two minutes of the march cover 60 m, under the bar, so this stay is
-- held — where the whole 300 m array would have flipped it.
#guard crun #[{ cseg with endTs := 120 }] MARCH == cv #[{ cseg with endTs := 120 }]

-- The duration is the SEGMENT's, not the fixes' span. A 90-minute declared stay
-- whose only fixes are a 10-minute march at the start: 300 m of linear progress,
-- but spread over 90 minutes that is 0.2 km/h — dwelling with a departure tail,
-- not a walk. Measured over the fixes' own 10 minutes it falls under the dwell
-- floor and flips.
#guard crun #[{ cseg with endTs := 5400 }] MARCH == cv #[{ cseg with endTs := 5400 }]

-- The `< 2` fix floor is PROTECTIVE, not decisive, and no guard can pin it: at
-- one fix `first` and `last` are the same sample, so the net displacement is 0
-- and the bar refuses the flip anyway. At ZERO fixes the TS would throw reading
-- `segPoints[0].lat`, which is what the check is really for.
#guard crun (#[] : Array Seg) (#[] : Array Fix) == (#[] : Array CRow)

end CoherenceGuards

end StationaryCoherence
