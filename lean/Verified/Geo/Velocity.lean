import Verified.Geo.RailRoadProximity
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
