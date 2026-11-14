import Verified.Geo.RailRoadProximity
import Verified.Geo.SegmentMerge
import Verified.Geo.Segments
import Verified.JsNum
import Verified.Fix
/-!
# Velocity-owned pure kernels

The velocity pipeline's own numeric kernels (each pass has its own module):

* `localSolarHour` — solar time from a unix instant.
* `computeRoadNearestFraction` — per-segment rail-vs-road GPS evidence over a
  segment's sampled `nearbyWays` (a sibling of `railRoadDistFromWays`).
* `batterySeries` / `appendBatteryTail` — the battery-chart reduction.

Integer arithmetic, `min`/mean, and one rounded interpolation: exact.
UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.Velocity

open Verified.Geo.RailRoadProximity (NearbyWay RAIL_ONLY_SUBTYPES DRIVABLE_HIGHWAY_SUBTYPES)

/-- `Math.round` — round half toward +∞. -/
private def roundHalfUp (x : Float) : Float := Float.floor (x + 0.5)

/-! ## Solar time -/

/-- Local solar hour (0..23) at a unix-second instant and longitude, each 15°
    ≈ 1 h: UTC minutes of the day, shifted by `lon/15` hours, wrapped into
    `[0,1440)` with Euclidean mod, floored to the hour. -/
def localSolarHour (ts : Int) (lon : Float) : Float :=
  let utcMinutes : Float := Float.ofInt ((ts / 60) % 1440)
  let localMin := utcMinutes + (lon / 15) * 60
  let wrapped := localMin - Float.floor (localMin / 1440) * 1440
  Float.floor (wrapped / 60)

/-! ## Per-segment rail-vs-road proximity

Each element of `wayResults` is one sample's `nearbyWays`. Per sample, the min
distance to a rail-only way and to a drivable road; then the mean over samples
that had each in range (`none` if none did). -/

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
  for hm_i : i in [0:all.size] do
    have hb_i : i < all.size := hm_i.upper
    if i == 0 || (all[i]).1 != (all[i - 1]).1 then read := read.push all[i]
  let mut out : List BatterySample := []
  for hm_i : i in [0:read.size] do
    have hb_i : i < read.size := hm_i.upper
    let s := read[i]
    let prevDiff := i == 0 || s.2 != (read[i - 1]).2
    let nextDiff := match read[i+1]? with
      | none => true
      | some nx => s.2 != nx.2
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

/-! ### The watch trace

`device_battery_log` for one day, on the phone series' axis. A different
reduction from `batterySeries`: the watch reports a handful of levels a day, not
one per fix. The host resolves each row's instant; `none` (an unresolved
legacy wall clock) is dropped, not guessed. -/

/-- Fitbit's pseudo-name for phone step tracking. Not a wearable, and it reports
battery 0, so a series that keeps it draws the watch flat-lining at empty. -/
def PHONE_PSEUDO_DEVICE : String := "MobileTrack"

/-- One row of `device_battery_log`, with its instant already resolved. -/
structure WatchRow where
  /-- `none` when the wall clock did not resolve. -/
  ts : Option Int
  level : Int
  /-- `none` is kept. An untagged row is an unknown device, not the phone. -/
  deviceVersion : Option String := none
  deriving Repr, Inhabited

/-- The watch series for one day: drop the phone pseudo-tracker and unresolved
clocks, keep `[startUtc, endUtc)`, sort stably by time, then collapse runs of
equal levels to their first reading. Same-instant rows keep the later input row
(the table's order). A level returning to an earlier value is a real step. -/
def watchBatterySeries (rows : List WatchRow) (startUtc endUtc : Int) : List BatterySample :=
  let inWindow : List BatterySample :=
    rows.filterMap fun r =>
      if r.deviceVersion == some PHONE_PSEUDO_DEVICE then none
      else match r.ts with
        | none => none
        | some ts => if ts ≥ startUtc && ts < endUtc then some (ts, r.level) else none
  let sorted := inWindow.mergeSort (fun a b => a.1 ≤ b.1)
  sorted.foldl (init := []) fun acc s =>
    match acc.getLast? with
    | some prev =>
      -- Same instant: replace, so the later row in input order wins.
      if prev.1 == s.1 then acc.dropLast ++ [s]
      -- Unchanged level: the step is already drawn from the previous point.
      else if prev.2 == s.2 then acc
      else acc ++ [s]
    | none => [s]

/-! ## Guards -/

private def t0 : Int := 1768435200  -- 2026-01-15 00:00:00 UTC
#guard localSolarHour t0 (-0.1) == 23
#guard localSolarHour (t0 + 3 * 3600) (-0.1) == 2
#guard localSolarHour (t0 + 12 * 3600) (-0.1) == 11
#guard localSolarHour (t0 + 6 * 3600) 100.0 == 12
#guard localSolarHour t0 (-120.0) == 16

private def w (d : Float) (ty sub : String) : NearbyWay := ⟨some d, ty, sub⟩
private def nd (ty sub : String) : NearbyWay := ⟨none, ty, sub⟩
private def sampleWays : List (List NearbyWay) := [
  [w 100 "railway" "rail", w 60 "railway" "subway", w 40 "highway" "primary",
   w 5 "railway" "tram", w 3 "highway" "footway"],
  [w 20 "highway" "motorway", w 200 "railway" "rail"],
  [nd "highway" "service", w 10 "waterway" "river"],
  [w 15 "railway" "light_rail"]]
private def approxV (a b : Float) : Bool := Float.abs (a - b) < 1e-9

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

/-! ### Watch trace -/

private def D0 : Int := 1767225600  -- 2026-01-01 00:00:00 UTC
private def D1 : Int := D0 + 86400
private def wr (offset level : Int) (dev : Option String := some "Charge 5") : WatchRow :=
  { ts := some (D0 + offset), level := level, deviceVersion := dev }
/-- Offsets from the day start, so the expectations read as the refs printed. -/
private def rel (xs : List BatterySample) : List (Int × Int) := xs.map fun (ts, l) => (ts - D0, l)

#guard rel (watchBatterySeries [] D0 D1) == []
#guard rel (watchBatterySeries [wr 100 90] D0 D1) == [(100, 90)]
-- The phone pseudo-tracker reports 0 and must never reach the watch series.
#guard rel (watchBatterySeries [wr 100 0 (some PHONE_PSEUDO_DEVICE), wr 200 90] D0 D1)
  == [(200, 90)]
-- An untagged row is an unknown device, not the phone.
#guard rel (watchBatterySeries [wr 100 90 none] D0 D1) == [(100, 90)]
-- Half-open: the start instant is in, the end instant is out.
#guard rel (watchBatterySeries [wr (-1) 99, wr 0 90, wr 86399 50, wr 86400 49] D0 D1)
  == [(0, 90), (86399, 50)]
-- The table is not ordered.
#guard rel (watchBatterySeries [wr 300 80, wr 100 90, wr 200 85] D0 D1)
  == [(100, 90), (200, 85), (300, 80)]
-- A flat run collapses to its first reading.
#guard rel (watchBatterySeries [wr 100 90, wr 200 90, wr 300 90, wr 400 85] D0 D1)
  == [(100, 90), (400, 85)]
-- Same instant: the later row in input order wins, both ways round.
#guard rel (watchBatterySeries [wr 100 90, wr 100 70] D0 D1) == [(100, 70)]
#guard rel (watchBatterySeries [wr 100 70, wr 100 90] D0 D1) == [(100, 90)]
-- A level returning to an earlier value is a real step, not a flat run.
#guard rel (watchBatterySeries [wr 100 90, wr 200 85, wr 300 90] D0 D1)
  == [(100, 90), (200, 85), (300, 90)]
-- An unresolved clock is dropped, never defaulted.
#guard rel (watchBatterySeries [{ ts := none, level := 90 }, wr 200 85] D0 D1) == [(200, 85)]
#guard rel (watchBatterySeries [wr (-10) 90, wr 86410 80] D0 D1) == []

end Verified.Geo.Velocity
