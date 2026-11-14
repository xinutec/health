import Verified.Hsmm.Observation
import Verified.JsNum

/-!
# Is this fix on the track, or on a road?

The per-minute `roadDistM` / `railDistM` of the observation tensor, and the one
rail-vs-road rule: the decoder never credits a tube line to a fix hugging a
road. `nearbyWays` is an OSM query in Rust; which subtypes count, which
distance wins, minute bucketing and the ~11 m cache key are here.

## ⚠ Trams are not rail here

`RAIL_ONLY_SUBTYPES` excludes `tram`: street track runs down the road, so a tram
way is no evidence for rail over road. {@link Verified.Geo.OsmRailStops} does
include trams; it asks which lines stop here, a different question.
-/

namespace Verified.Hsmm.RailRoadProximity

open Verified.Hsmm.Observation (GpsPoint median bucketIndex)

/-- Rail-only OSM way subtypes. No `tram` — see the module note. -/
def RAIL_ONLY_SUBTYPES : List String := ["rail", "subway", "light_rail", "narrow_gauge"]

/-- Drivable highway subtypes: residential through motorway, plus track and
living_street. Pedestrian and cycle ways are excluded — a towpath beside a
railway is not a road the fix could be driving on. -/
def DRIVABLE_HIGHWAY_SUBTYPES : List String :=
  ["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
   "service", "unclassified", "track", "living_street"]

/-- One way from a `nearbyWays` answer. -/
structure NearbyWay where
  type : String
  subtype : String
  /-- `none` when the shell could not measure it — skipped, never treated as 0. -/
  distanceM : Option Float
  deriving Repr, Inhabited

/-- The nearest rail and the nearest drivable road, in metres. `none` for a kind
with nothing in range — which is a fact about the surroundings, not a failure. -/
structure Proximity where
  railDistM : Option Float
  roadDistM : Option Float
  deriving Repr, Inhabited, BEq

/-- ⚠ A non-finite distance is skipped, not compared: a NaN would otherwise win
every `<` comparison it took part in and pin the minimum at NaN. -/
private def usable (d : Option Float) : Option Float :=
  match d with
  | none => none
  | some x => if x.isFinite then some x else none

/-- Distance from one fix to the nearest rail-only way and to the nearest
drivable road, given that fix's `nearbyWays` list. -/
def railRoadDistFromWays (ways : List NearbyWay) : Proximity := Id.run do
  let mut minRail : Option Float := none
  let mut minRoad : Option Float := none
  for w in ways do
    let some d := usable w.distanceM | continue
    -- `else if`, not two `if`s: a way is rail or road, never both. A way
    -- tagged `railway` whose subtype is not rail-only does not fall through to
    -- the road test — it is simply not evidence either way.
    if w.type == "railway" && RAIL_ONLY_SUBTYPES.contains w.subtype then
      minRail := some (match minRail with | none => d | some m => min m d)
    else if w.type == "highway" && DRIVABLE_HIGHWAY_SUBTYPES.contains w.subtype then
      minRoad := some (match minRoad with | none => d | some m => min m d)
  return { railDistM := minRail, roadDistM := minRoad }

/-! ## Which minutes to ask about, and how few times to ask -/

/-- One minute that had fixes: the top-of-minute timestamp and the
per-coordinate median of its fixes, as the observation tensor aggregates. A mean
would drag a platform minute toward one wild fix near a road.

The bucket is the local-day minute index; fixes outside `[startUtc, endUtc)`
are dropped, not clamped. -/
structure MinuteFix where
  minuteTs : Int
  lat : Float
  lon : Float
  deriving Repr, Inhabited, BEq

/-- Bucket a day's fixes into local-day minutes and take each minute's median
position. Minutes with no fixes are absent, not zero. -/
def minuteMedians (startUtc endUtc : Int) (points : List GpsPoint) : Array MinuteFix :=
  Id.run do
    let mut acc : Array (Nat × Array GpsPoint) := #[]
    -- Insertion-ordered by first appearance of each minute, which is ascending
    -- for the sorted input the loader supplies and stable for any other.
    for p in points do
      match bucketIndex startUtc endUtc p.ts with
      | none => pure ()
      | some m =>
        match acc.findFinIdx? (fun q => q.1 == m) with
        | some k => acc := acc.set k (m, acc[k].2.push p)
        | none => acc := acc.push (m, #[p])
    return acc.map (fun (m, ps) =>
      { minuteTs := startUtc + Int.ofNat m * 60
      , lat := median (ps.toList.map GpsPoint.lat)
      , lon := median (ps.toList.map GpsPoint.lon) })

/-- The coarse cache key, 4 decimals (~11 m), far below any distance this module
distinguishes. Minute-medians sharing it share one `nearbyWays` lookup, so a
stationary day is one query, not hundreds. -/
def coordKey (lat lon : Float) : String :=
  let f := fun (x : Float) => (Verified.JsNum.toFixed x 4).getD (toString x)
  s!"{f lat},{f lon}"

/-- The distinct locations a day must be asked about, in first-seen order. Each
answer goes through {@link railRoadDistFromWays} and serves every minute with
that key. -/
def distinctQueryPoints (ms : Array MinuteFix) : Array MinuteFix :=
  Id.run do
    let mut seen : Array String := #[]
    let mut out : Array MinuteFix := #[]
    for m in ms do
      let k := coordKey m.lat m.lon
      if !seen.contains k then
        seen := seen.push k
        out := out.push m
    return out

/-- One answered query: the location asked about and the ways found. A failed
query is absent, not `[]`: `[]` is "nothing within 300 m", which is evidence.
{@link proximityTable} counts the minutes left unanswered. -/
structure WayAnswer where
  lat : Float
  lon : Float
  ways : List NearbyWay
  deriving Repr, Inhabited

/-- Join the day's minute-medians to the `nearbyWays` answers by {@link coordKey}
(here, so the key has one copy), returning the sparse per-minute table and the
count of minutes no answer covered.

A minute with nothing in range is omitted, the same as `(none, none)` to
`buildObservationTensor`: not known near either, never "far from both". -/
def proximityTable (ms : Array MinuteFix) (answers : Array WayAnswer)
    : Array (Int × Proximity) × Nat := Id.run do
  let mut byKey : Array (String × Proximity) := #[]
  for a in answers do
    let k := coordKey a.lat a.lon
    if (byKey.findIdx? (fun q => q.1 == k)).isNone then
      byKey := byKey.push (k, railRoadDistFromWays a.ways)
  let mut rows : Array (Int × Proximity) := #[]
  let mut unanswered : Nat := 0
  for m in ms do
    match byKey.findFinIdx? (fun q => q.1 == coordKey m.lat m.lon) with
    | none => unanswered := unanswered + 1
    | some i =>
      let p := byKey[i].2
      -- Omit a minute that carries no distance at all: see the note above.
      if p.railDistM.isSome || p.roadDistM.isSome then
        rows := rows.push (m.minuteTs, p)
  return (rows, unanswered)

/-! ## Guards -/

private def W (t s : String) (d : Float) : NearbyWay :=
  { type := t, subtype := s, distanceM := some d }

#guard (railRoadDistFromWays []) == { railDistM := none, roadDistM := none }

-- The nearest of each kind wins, independently.
#guard (railRoadDistFromWays [W "railway" "subway" 40, W "railway" "rail" 12,
                              W "highway" "primary" 80])
        == { railDistM := some 12, roadDistM := some 80 }

-- A tram is neither. Mixed-traffic track is not rail-vs-road evidence, and it
-- must not be counted as a road either.
#guard (railRoadDistFromWays [W "railway" "tram" 5])
        == { railDistM := none, roadDistM := none }

-- A railway that is not rail-only does not fall through to the road test.
-- `else if` is what stops a siding counting as a road.
#guard (railRoadDistFromWays [W "railway" "disused" 5])
        == { railDistM := none, roadDistM := none }

-- Footpaths and cycleways are not drivable.
#guard (railRoadDistFromWays [W "highway" "footway" 3, W "highway" "cycleway" 4])
        == { railDistM := none, roadDistM := none }
#guard (railRoadDistFromWays [W "highway" "footway" 3, W "highway" "residential" 90])
        == { railDistM := none, roadDistM := some 90 }

-- Every drivable subtype counts, and every rail-only one.
#guard (DRIVABLE_HIGHWAY_SUBTYPES.map (fun s => railRoadDistFromWays [W "highway" s 10])).all
        (fun p => p.roadDistM == some 10)
#guard (RAIL_ONLY_SUBTYPES.map (fun s => railRoadDistFromWays [W "railway" s 10])).all
        (fun p => p.railDistM == some 10)

-- A missing distance is skipped, not zero. Treating it as 0 would put the fix
-- on top of a way nobody measured.
#guard (railRoadDistFromWays [{ type := "railway", subtype := "rail", distanceM := none },
                              W "railway" "rail" 50])
        == { railDistM := some 50, roadDistM := none }
#guard (railRoadDistFromWays [{ type := "railway", subtype := "rail", distanceM := none }])
        == { railDistM := none, roadDistM := none }

-- NaN must be skipped, and way order decides whether a test sees it: `min NaN 25`
-- is 25 but `min 25 NaN` is NaN. Both orders are guarded.
private def NAN_WAY : NearbyWay :=
  { type := "railway", subtype := "rail", distanceM := some (0.0 / 0.0) }
#guard (railRoadDistFromWays [NAN_WAY, W "railway" "rail" 25]).railDistM == some 25
#guard (railRoadDistFromWays [W "railway" "rail" 25, NAN_WAY]).railDistM == some 25
-- And alone it is nothing in range, not a measured zero.
#guard (railRoadDistFromWays [NAN_WAY]).railDistM == none

-- Zero is a real distance: a fix on the way.
#guard (railRoadDistFromWays [W "highway" "primary" 0]).roadDistM == some 0

-- Minute bucketing. A fix before the day starts or at/after it ends is
-- dropped, not clamped — clamping would put a 23:59 fix from yesterday into
-- minute 0 and give the day a phantom starting location.
private def P (ts : Int) (lat lon : Float) : GpsPoint :=
  { ts := ts, lat := lat, lon := lon, speedKmh := 0 }
private def T0 : Int := 1000000
private def T1 : Int := T0 + 1440 * 60

#guard (minuteMedians T0 T1 []).isEmpty
#guard (minuteMedians T0 T1 [P (T0 - 1) 51.5 (-0.1)]).isEmpty
#guard (minuteMedians T0 T1 [P T1 51.5 (-0.1)]).isEmpty
#guard (minuteMedians T0 T1 [P T0 51.5 (-0.1)]).size == 1
#guard (minuteMedians T0 T1 [P T0 51.5 (-0.1)])[0]!.minuteTs == T0

-- Fixes inside one minute collapse to one entry at the top of that minute.
#guard (minuteMedians T0 T1 [P (T0 + 5) 51.0 0, P (T0 + 30) 53.0 0, P (T0 + 59) 52.0 0]).size == 1
#guard (minuteMedians T0 T1 [P (T0 + 5) 51.0 0, P (T0 + 30) 53.0 0, P (T0 + 59) 52.0 0])[0]!
        == { minuteTs := T0, lat := 52.0, lon := 0.0 }

-- Median, not mean: one wild fix must not drag the query point. The mean of
-- 51/52/99 is 67.3; the median is 52.
#guard (minuteMedians T0 T1 [P (T0+1) 51.0 0, P (T0+2) 52.0 0, P (T0+3) 99.0 0])[0]!.lat == 52.0

-- Separate minutes stay separate, at their own top-of-minute stamps.
#guard (minuteMedians T0 T1 [P T0 51.0 0, P (T0 + 60) 52.0 0]).size == 2
#guard (minuteMedians T0 T1 [P T0 51.0 0, P (T0 + 60) 52.0 0])[1]!.minuteTs == T0 + 60

-- The cache key is the whole cost argument. Two positions ~1 m apart share a
-- lookup; a stationary day collapses to one query.
#guard coordKey 51.512345 (-0.123456) == coordKey 51.512349 (-0.123451)
#guard coordKey 51.5123 (-0.1234) != coordKey 51.5124 (-0.1234)
#guard (distinctQueryPoints (minuteMedians T0 T1
          [P T0 51.512345 (-0.1), P (T0+60) 51.512349 (-0.1), P (T0+120) 51.9 (-0.1)])).size == 2
-- First-seen order, so the shell's query order is stable run to run.
#guard (distinctQueryPoints #[{ minuteTs := 2, lat := 51.9, lon := 0 },
                              { minuteTs := 1, lat := 51.5, lon := 0 }])[0]!.lat == 51.9

-- The JOIN. One answer serves every minute whose median rounds to the same
-- ~11 m key, which is the whole reason a stationary day costs one query.
private def A (lat lon : Float) (ws : List NearbyWay) : WayAnswer :=
  { lat := lat, lon := lon, ways := ws }
private def M (ts : Int) (lat lon : Float) : MinuteFix :=
  { minuteTs := ts, lat := lat, lon := lon }

#guard (proximityTable #[M 60 51.512345 (-0.1), M 120 51.512349 (-0.1)]
          #[A 51.512345 (-0.1) [W "highway" "primary" 30]])
        == (#[(60, { railDistM := none, roadDistM := some 30 }),
              (120, { railDistM := none, roadDistM := some 30 })], 0)

-- A minute no answer covers is counted, not invented. It leaves no row, so
-- the decoder reads it as "not known to be near either" — and the shell can
-- still say how much of the day that was.
#guard (proximityTable #[M 60 51.5 0, M 120 52.9 0]
          #[A 51.5 0 [W "railway" "rail" 12]])
        == (#[(60, { railDistM := some 12, roadDistM := none })], 1)
#guard (proximityTable #[M 60 51.5 0] #[]) == ((#[] : Array (Int × Proximity)), 1)

-- Answered-but-empty is a row-less minute that is not unanswered. Both read
-- as no evidence downstream; only this count tells the shell which it was.
#guard (proximityTable #[M 60 51.5 0] #[A 51.5 0 []])
        == ((#[] : Array (Int × Proximity)), 0)
-- Ways that are neither rail nor road are the same case.
#guard (proximityTable #[M 60 51.5 0] #[A 51.5 0 [W "highway" "footway" 3]])
        == ((#[] : Array (Int × Proximity)), 0)

-- Rows come out in minute order, not answer order, so the table reads as a day.
#guard ((proximityTable #[M 180 51.9 0, M 60 51.5 0]
          #[A 51.5 0 [W "railway" "rail" 1], A 51.9 0 [W "railway" "rail" 2]]).1.map (·.1))
        == #[180, 60]

-- A duplicate answer for one key does not change the value: the first wins, and
-- a cached hit is never overwritten.
#guard (proximityTable #[M 60 51.5 0]
          #[A 51.5 0 [W "railway" "rail" 10], A 51.5 0 [W "railway" "rail" 99]])
        == (#[(60, { railDistM := some 10, roadDistM := none })], 0)

-- End to end on a day: bucket, dedupe, ask twice, join back to three minutes.
#guard (let ms := minuteMedians T0 T1
          [P T0 51.512345 (-0.1), P (T0+60) 51.512349 (-0.1), P (T0+120) 51.9 (-0.1)]
        let qs := distinctQueryPoints ms
        let answers := qs.map (fun q => A q.lat q.lon [W "highway" "primary" 40])
        (proximityTable ms answers).1.size == 3 && qs.size == 2)

end Verified.Hsmm.RailRoadProximity
