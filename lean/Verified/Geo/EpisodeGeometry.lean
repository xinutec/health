import Verified.Geo.Prefilter
import Verified.Geo.Segments
import Verified.FloatConst
import Verified.Fix
/-!
# Episode geometry

`buildEpisodes` resolves a display geometry for each `DayState` 1:1, so the map
cannot draw a story the timeline does not tell. Geometry is downstream of
classification and never feeds back.

Per mode, a display policy:

* train: a cached rail line (`snappedPath`) clipped to the window; for a
  reconstructed leg (`pointCount = 0`, an underground ride) a station-to-station
  connector with no distance cap; otherwise the raw GPS with the station join
  points stitched on ({@link stitchTrainEnds}), since a train's GPS starts late
  and stops early.
* moving: road match, walk reconstruction, walk match, raw fixes, in that
  order. Raw prefers the pre-Kalman `rawFixes`: the road-blind smoother pulls
  the line off the path and truncates it.
* stay: one anchor, the covering segment's centroid or the fixes' mean.
* unknown: a connector capped at 2 km, so a gap implies no cross-city route.

{@link equirectMeters} (cos at the first point, `sqrt`) is not
`metersBetween` (cos at the midpoint, `hypot`); this module's thresholds were
tuned on the former. Exact except those ≤1 ULP metre values, compared only
against the 100 m stitch bar and the 2 km cap. UNPROVEN; pinned by the
`#guard`s.

An absent drawn path and an empty one are the same (both under two vertices),
but an empty `rawFixes` is present, so it stays an `Option`. Fix timestamps are
whole seconds; derived vertices' are `Float` ({@link SPt}).
-/

namespace Verified.Geo.EpisodeGeometry

open Verified.Geo (holdSpeed rejectSpikes)

/-! ## Shapes -/

/-- A `DayStateMode`, kept as `String` for the same reason
`Verified.Geo.DayState` does. -/
abbrev Mode := String

/-- Geometry provenance, the map's only style input: solid for `raw`/`matched`,
dashed for `snapped`/`tentative`, a dot for `anchor`. No confidence field:
classification confidence is not geometry trust. -/
abbrev Kind := String

/-- A drawn vertex, with `ts` when it came from a timestamped point and none for
a centroid or connector end; the map's point inspector shows it. -/
structure LatLon where
  lat : Float
  lon : Float
  /-- `Float`, not `Int`: the derived-path vertices that feed it carry
  fractional timestamps (see {@link SPt}). Rounding on the way out would change
  the emitted value for about a sixth of the corpus's drawn vertices. -/
  ts : Option Float := none
  deriving Inhabited, BEq, Repr

/-- A vertex of a derived path. `ts` is `Float`: the snapped path is integral,
but the over-route trim and the walk escape interpolate without rounding. -/
structure SPt where
  lat : Float
  lon : Float
  ts : Float
  deriving Inhabited, BEq, Repr

/-- The `FilteredPoint` fields this module reads — the Kalman-smoothed track. -/
abbrev Fix := Verified.SpeedFix

/-- A raw GPS fix as captured (pre-Kalman). `accuracy` is never read here (the
physics of the mode is the constraint, not the phone's self-reported number),
so it is absent. -/
abbrev RawFix := Verified.GeoFix

/-- The `EnrichedSegment` fields `resolveEpisode` reads; a different projection
of the same record than `Verified.Geo.DayState.Seg`, which reads the labelling
fields instead. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  /-- Zero marks a reconstructed leg: no real GPS for the ride at all. -/
  pointCount : Int := 0
  centroidLat : Option Float := none
  centroidLon : Option Float := none
  snappedPath : Array SPt := #[]
  matchedPath : Array SPt := #[]
  walkMatchedPath : Array SPt := #[]
  walkSmoothedPath : Array SPt := #[]
  deriving Inhabited, BEq

/-- The `DayState` fields this module reads. -/
structure State where
  startTs : Int
  endTs : Int
  mode : Mode
  place : Option String := none
  deriving Inhabited, BEq

/-- One episode's display geometry, 1:1 with a `State`. Self-describing so the
map renders it without re-joining to the states. `points` may be empty — the
map then draws nothing (e.g. a synthesized pre-fix sleep). -/
structure Episode where
  startTs : Int
  endTs : Int
  mode : Mode
  kind : Kind
  points : Array LatLon
  /-- Stay label for an `anchor` episode (the map's marker popup), lifted from
      the state's `place` so the frontend draws markers from episodes alone. -/
  place : Option String := none
  deriving Inhabited, BEq, Repr

/-! ## Constants -/

/-- A no-GPS `unknown` gap longer than this (m, straight line) is not bridged:
a dashed line across a city would imply a route there is none of. A display
constant, like `rejectSpikes`'s 500 m. -/
def UNKNOWN_CONNECTOR_MAX_M : Float := 2000

/-- A raw train leg whose drawn end sits more than this from its station join
point gets that point stitched on. Below it the gap is negligible and stitching
would add a redundant near-duplicate. -/
def STATION_STITCH_MIN_M : Float := 100

/-- Modes drawn as a travelled line rather than a stay marker. `vehicle` — a
ride no pass could identify — is still unambiguously *movement*, so it draws
its track like any other leg; only its label is uncertain, not its geometry. -/
def MOVING_MODES : List Mode :=
  ["walking", "cycling", "driving", "vehicle", "bus", "boat", "plane"]

/-- Road-vehicle modes eligible for road map-matching. Walking (often
off-carriageway pavement) and plane are excluded — the matcher routes only over
drivable ways. -/
def ROAD_MATCH_MODES : List Mode := ["driving", "bus", "cycling"]

/-! ## Geometry -/

open Verified.FloatConst (pi)

/-- Equirectangular metres, `cos` at the first point and `sqrt` (not `hypot`).
See the module docstring: this is not `metersBetween`. -/
def equirectMeters (aLat aLon bLat bLon : Float) : Float :=
  let dLat := (bLat - aLat) * 111320.0
  let dLon := (bLon - aLon) * 111320.0 * Float.cos (aLat * pi / 180.0)
  Float.sqrt (dLat * dLat + dLon * dLon)

/-- The mean of a set of points, or `none` when there are none. Sums in array
order. -/
def centroidOf (pts : Array LatLon) : Option LatLon :=
  if pts.isEmpty then none
  else Id.run do
    let mut sumLat : Float := 0
    let mut sumLon : Float := 0
    for p in pts do
      sumLat := sumLat + p.lat
      sumLon := sumLon + p.lon
    let n := pts.size.toFloat
    return some { lat := sumLat / n, lon := sumLon / n }

/-! ## Pre-filters, specialised to this module's metric

`Verified.Geo.Prefilter` owns the recursions and their invariants
(`holdSpeed_chain`, `rejectSpikes_sublist`); here they get the float
predicates. -/

/-- `rejectSpikes`'s predicate: a point juts out and back when the detour
through it is both several times longer than going straight past it and a large
absolute excess. A gentle curve or a sharp corner stays well under that bar. -/
def spikeAt (prev cur next : LatLon) : Bool :=
  let direct := equirectMeters prev.lat prev.lon next.lat next.lon
  let through :=
    equirectMeters prev.lat prev.lon cur.lat cur.lon
      + equirectMeters cur.lat cur.lon next.lat next.lon
  through > direct * 3.0 && through - direct > 500.0

/-- Drop lone teleport spikes — display only; the underlying data keeps every
fix. -/
def despike (pts : Array LatLon) : Array LatLon :=
  (rejectSpikes spikeAt (fun i => pts.getD i default) pts.size).toArray

/-- `holdImplausibleSpeed`'s predicate: keep a fix only if its implied speed
from the last kept fix is within `capKmh`. A non-positive `dt` fails. -/
def speedOk (capKmh : Float) (last cur : RawFix) : Bool :=
  let dt := Float.ofInt (cur.ts - last.ts)
  if dt ≤ 0 then false
  else equirectMeters last.lat last.lon cur.lat cur.lon / dt * 3.6 ≤ capKmh

/-- The kinematic hold: a run of fixes each needing impossible speed (an indoor
teleport with good self-reported accuracy) is held at the last plausible
position. A `none` cap drops nothing. -/
def holdImplausibleSpeed (fixes : Array RawFix) (capKmh : Option Float) : Array RawFix :=
  match capKmh with
  | none => fixes
  | some cap => (holdSpeed (speedOk cap) (fun i => fixes.getD i default) fixes.size).toArray

/-! ## The three private helpers -/

/-- The refined mode where there is one, else the mode. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Whether a timestamp lies in a window, inclusive at both ends (the dominant
convention across the pipeline). -/
def inWindow (ts start finish : Int) : Bool := ts ≥ start && ts ≤ finish

/-- The same window test for a derived-path vertex, whose `ts` is fractional:
the fraction takes part in the comparison rather than being rounded away first. -/
def inWindowF (ts : Float) (start finish : Int) : Bool :=
  ts ≥ Float.ofInt start && ts ≤ Float.ofInt finish

/-- Segments overlapping a state's window — strict on both sides, so a segment
merely touching a boundary does not cover it. -/
def coveringSegs (segments : Array Seg) (st : State) : Array Seg :=
  segments.filter (fun s => s.startTs < st.endTs && s.endTs > st.startTs)

/-- Anchor a raw train leg to its station join points: prepend `from` and append
`to` when more than `STATION_STITCH_MIN_M` from the existing end, so the leg
stays train-coloured. `to` is compared after a possible `from` prepend. -/
def stitchTrainEnds (raw : Array LatLon) (from? to? : Option LatLon) : Array LatLon := Id.run do
  let farFromEnd (p : LatLon) (endp : Option LatLon) : Bool :=
    match endp with
    | none => true
    | some e => equirectMeters p.lat p.lon e.lat e.lon > STATION_STITCH_MIN_M
  let mut pts := raw
  match from? with
  | some f => if farFromEnd f pts[0]? then pts := #[f] ++ pts
  | none => pure ()
  match to? with
  | some t => if farFromEnd t pts[pts.size - 1]? then pts := pts.push t
  | none => pure ()
  return pts

/-- A stay's single anchor point: the covering stationary segment's precomputed
centroid if present, else the mean of the window fixes, else none (a
synthesized pre-fix sleep has no fix to anchor to). -/
def stayAnchor (covering : Array Seg) (windowFixes : Array LatLon) : Option LatLon :=
  match covering.find? (fun s => s.centroidLat.isSome && s.centroidLon.isSome) with
  | some s =>
    match s.centroidLat, s.centroidLon with
    | some la, some lo => some { lat := la, lon := lo }
    | _, _ => centroidOf windowFixes
  | none => centroidOf windowFixes

/-- A representative entry coordinate for a state — its first window fix, else
its stay centroid. Used as the far end of a connector. Note the fix's timestamp
is dropped: the connector endpoint is derived geometry with no single moment. -/
def entryPoint (st? : Option State) (segments : Array Seg) (points : Array Fix) : Option LatLon :=
  match st? with
  | none => none
  | some st =>
    match points.find? (fun p => inWindow p.ts st.startTs st.endTs) with
    | some f => some { lat := f.lat, lon := f.lon }
    | none => stayAnchor (coveringSegs segments st) #[]

/-! ## The dispatch -/

/-- A `Fix` as a drawn vertex, keeping its moment. -/
def toLatLon (p : Fix) : LatLon := { lat := p.lat, lon := p.lon, ts := some (Float.ofInt p.ts) }

/-- A `RawFix` as a drawn vertex. -/
def rawToLatLon (p : RawFix) : LatLon := { lat := p.lat, lon := p.lon, ts := some (Float.ofInt p.ts) }

/-- A derived path clipped to a window, as drawn vertices. -/
def clipPath (path : Array SPt) (st : State) : Array LatLon :=
  (path.filter (fun sp => inWindowF sp.ts st.startTs st.endTs)).map
    (fun sp => { lat := sp.lat, lon := sp.lon, ts := some sp.ts })

/-- The per-mode speed ceiling, `none` where the mode has none. -/
def capForMode (mode : Mode) : Option Float :=
  (Verified.Geo.Segments.MAX_SPEED_FOR_MODE.find? (fun p => p.1 == mode)).map (·.2)

/-- Resolve one state's display geometry. Sequence-aware: the train and
`unknown` connectors read the previous resolved episode and the next state's
entry point, so this must be folded in order. -/
def resolveEpisode (st : State) (index : Nat) (states : Array State) (segments : Array Seg)
    (points : Array Fix) (resolved : Array Episode) (rawFixes : Option (Array RawFix))
    : Episode := Id.run do
  let mode := st.mode
  let covering := coveringSegs segments st
  let windowFixes := points.filter (fun p => inWindow p.ts st.startTs st.endTs)
  let base : Array LatLon → Kind → Option String → Episode := fun pts k pl =>
    { startTs := st.startTs, endTs := st.endTs, mode, kind := k, points := pts, place := pl }

  if mode == "train" then
    -- A cached route carries a snapped rail line: draw it. An uncached ride
    -- keeps no snappedPath but still has real GPS for the overground stretch.
    match covering.find? (fun s => effectiveMode s == "train" && s.snappedPath.size ≥ 2) with
    | some trainSeg =>
      let snapped := clipPath trainSeg.snappedPath st
      if snapped.size ≥ 2 then return base snapped "snapped" none
    | none => pure ()

    -- The join points: where the previous episode ended and the next begins.
    -- At index 0 `resolved` is empty, so the truncating `0 - 1` still misses.
    let from? := (resolved[index - 1]?).bind (fun e => e.points[e.points.size - 1]?)
    let to? := entryPoint states[index + 1]? segments points

    -- A reconstructed underground leg has no ride GPS: a station-to-station
    -- connector in train colour, uncapped since rail spans kilometres.
    if covering.any (fun s => effectiveMode s == "train" && s.pointCount == 0) then
      return base (match from?, to? with
        | some f, some t => #[f, t]
        | _, _ => #[]) "tentative" none

    let raw := despike (windowFixes.map toLatLon)
    return base (stitchTrainEnds raw from? to?) "raw" none

  if MOVING_MODES.contains mode then
    -- Road map-matching: a road-vehicle leg whose covering segment carries a
    -- `matchedPath` draws on the OSM streets instead of the raw GPS.
    match covering.find? (fun s => s.matchedPath.size ≥ 2 && ROAD_MATCH_MODES.contains (effectiveMode s)) with
    | some roadSeg =>
      let matched := clipPath roadSeg.matchedPath st
      if matched.size ≥ 2 then return base matched "matched" none
    | none => pure ()

    -- Robust reconstruction: a walking leg whose matched line was a phantom
    -- out-and-back (bad-GPS reacquire) is drawn by `reconstructWalk` instead,
    -- which takes precedence over the matched line when present.
    match covering.find? (fun s => s.walkSmoothedPath.size ≥ 2 && effectiveMode s == "walking") with
    | some sm =>
      let smoothed := clipPath sm.walkSmoothedPath st
      if smoothed.size ≥ 2 then return base smoothed "smoothed" none
    | none => pure ()

    -- Pedestrian map-matching: draw on the OSM walkable network instead of the
    -- raw GPS cutting across buildings.
    match covering.find? (fun s => s.walkMatchedPath.size ≥ 2 && effectiveMode s == "walking") with
    | some wm =>
      let walkMatched := clipPath wm.walkMatchedPath st
      if walkMatched.size ≥ 2 then return base walkMatched "matched" none
    | none => pure ()

    -- Unmatched moving leg: the raw GPS, not the Kalman points, which swing up
    -- to ~75 m off a road and truncate a walk. `despike` drops lone teleports
    -- and `holdImplausibleSpeed` a monotonic teleport run.
    match rawFixes with
    | some rf =>
      let sw := rf.filter (fun p => inWindow p.ts st.startTs st.endTs)
      let kept := (rejectSpikes (fun a b c => spikeAt (rawToLatLon a) (rawToLatLon b) (rawToLatLon c))
        (fun i => sw.getD i default) sw.size).toArray
      let rawWin := holdImplausibleSpeed kept (capForMode mode)
      if rawWin.size ≥ 2 then return base (rawWin.map rawToLatLon) "raw" none
    | none => pure ()

    -- Speed plausibility drops a faster neighbour's smooth bleed across the
    -- boundary (a train's tail inside the walk), which despiking cannot see.
    let plausible := match capForMode mode with
      | none => windowFixes
      | some cap => windowFixes.filter (fun p => p.speedKmh ≤ cap)
    return base (despike (plausible.map toLatLon)) "raw" none

  if mode == "stationary" || mode == "sleeping" then
    let anchor := stayAnchor covering (windowFixes.map toLatLon)
    -- An empty place string is dropped.
    let pl := match st.place with
      | some p => if p == "" then none else some p
      | none => none
    return base (match anchor with | some a => #[a] | none => #[]) "anchor" pl

  if mode == "unknown" then
    -- A no-GPS gap: a tentative connector between the previous drawn point and
    -- the next state's entry point, capped so it cannot imply a cross-city
    -- route. Either endpoint missing → draw nothing.
    let from? := (resolved[index - 1]?).bind (fun e => e.points[e.points.size - 1]?)
    let to? := entryPoint states[index + 1]? segments points
    match from?, to? with
    | some f, some t =>
      if equirectMeters f.lat f.lon t.lat t.lon ≤ UNKNOWN_CONNECTOR_MAX_M then
        return base #[f, t] "tentative" none
    | _, _ => pure ()
    return base #[] "tentative" none

  return base (despike (windowFixes.map toLatLon)) "raw" none

/-- Resolve a display geometry for every state, in order. -/
def buildEpisodes (states : Array State) (segments : Array Seg) (points : Array Fix)
    (rawFixes : Option (Array RawFix) := none) : Array Episode := Id.run do
  let mut episodes : Array Episode := #[]
  for i in [0:states.size] do
    episodes := episodes.push
      (resolveEpisode (states.getD i default) i states segments points episodes rawFixes)
  return episodes

/-! ## Smoke tests

Recorded `buildEpisodes` answers. Coordinates are built from the frame
arithmetic, tied to the references by the first block of guards, so both sides
compute the same doubles. -/

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320.0
private def mlon : Float := 1 / (111320.0 * Float.cos (lat0 * pi / 180))
/-- North/east metres from the frame origin. -/
private def pt (n e : Float) : Float × Float := (lat0 + n * mlat, lon0 + e * mlon)

-- The frame, against the harness's printed coordinates.
#guard (pt 0 0).1 == 51.52
#guard (pt 0 0).2 == -0.13
#guard (pt 0 50).2 == -0.12927816507344128
#guard (pt 0 100).2 == -0.12855633014688256
#guard (pt 0 500).2 == -0.12278165073441279
#guard (pt 0 1000).2 == -0.11556330146882557
#guard (pt 0 4000).2 == -0.07225320587530223
#guard (pt 1 0).1 == 51.52000898311175
#guard (pt 2 0).1 == 51.520017966223506
#guard (pt 3 0).1 == 51.520026949335254
#guard (pt 5 5).1 == 51.52004491555875

private def ll (n e : Float) (ts : Option Float := none) : LatLon :=
  { lat := (pt n e).1, lon := (pt n e).2, ts }
private def fx (ts : Int) (n e : Float) (v : Float := 4) : Fix :=
  { ts, lat := (pt n e).1, lon := (pt n e).2, speedKmh := v }
private def rx (ts : Int) (n e : Float) : RawFix :=
  { ts, lat := (pt n e).1, lon := (pt n e).2 }
private def spt (ts : Float) (n e : Float) : SPt :=
  { lat := (pt n e).1, lon := (pt n e).2, ts }
private def stt (a b : Int) (m : Mode) (p : Option String := none) : State :=
  { startTs := a, endTs := b, mode := m, place := p }
private def sg (a b : Int) (m : Mode) : Seg :=
  { startTs := a, endTs := b, mode := m, pointCount := 10 }
private def anchored (a b : Int) (n e : Float) : Seg :=
  { sg a b "stationary" with centroidLat := some (pt n e).1, centroidLon := some (pt n e).2 }

/-- Episodes as `(mode, kind, place, points)` — the whole decision minus the
window, which the day-shape guard checks separately. -/
private def render (eps : Array Episode) : Array (Mode × Kind × Option String × Array LatLon) :=
  eps.map (fun e => (e.mode, e.kind, e.place, e.points))

/-! ### train — `snappedPath` wins, clipped to the window -/

private def trSt : Array State := #[stt 1000 1200 "train"]
private def trPts : Array Fix := #[fx 1050 1 500, fx 1150 1 1000]

#guard render (buildEpisodes trSt
    #[{ sg 1000 1200 "train" with
        snappedPath := #[spt 900 0 0, spt 1050 0 500, spt 1150 0 1000, spt 1300 0 1500] }] trPts)
  == #[("train", "snapped", none, #[ll 0 500 (some 1050), ll 0 1000 (some 1150)])]

-- Only one vertex lands in the window → falls through to the raw arm, which
-- draws the Kalman fixes (at n = 1, not the snapped line's n = 0).
#guard render (buildEpisodes trSt
    #[{ sg 1000 1200 "train" with snappedPath := #[spt 900 0 0, spt 1050 0 500, spt 1300 0 1500] }] trPts)
  == #[("train", "raw", none, #[ll 1 500 (some 1050), ll 1 1000 (some 1150)])]

-- `effectiveMode` is `refinedMode ?? mode`: a leg classified driving but
-- refined to train still supplies the snapped path.
#guard render (buildEpisodes trSt
    #[{ sg 1000 1200 "driving" with
        refinedMode := some "train", snappedPath := #[spt 1050 0 500, spt 1150 0 1000] }] #[fx 1050 1 500])
  == #[("train", "snapped", none, #[ll 0 500 (some 1050), ll 0 1000 (some 1150)])]

/-! ### train — a reconstructed leg draws an uncapped station connector -/

private def reconSt : Array State :=
  #[stt 900 1000 "stationary" (some "Baker Street"), stt 1000 1200 "train", stt 1200 1300 "walking"]
private def reconSg : Array Seg :=
  #[anchored 900 1000 0 0, { sg 1000 1200 "train" with pointCount := 0 }, sg 1200 1300 "walking"]

-- 4 km apart and still drawn — unlike the `unknown` connector's 2 km cap.
#guard render (buildEpisodes reconSt reconSg #[fx 1250 0 4000, fx 1280 0 4100])
  == #[("stationary", "anchor", some "Baker Street", #[ll 0 0]),
       ("train", "tentative", none, #[ll 0 0, ll 0 4000]),
       ("walking", "raw", none, #[ll 0 4000 (some 1250), ll 0 4100 (some 1280)])]

-- No next state at all → no `to`, so nothing is drawn.
#guard render (buildEpisodes reconSt.pop reconSg.pop #[])
  == #[("stationary", "anchor", some "Baker Street", #[ll 0 0]),
       ("train", "tentative", none, #[])]

/-! ### train — `stitchTrainEnds` -/

private def stSt : Array State :=
  #[stt 900 1000 "stationary" (some "Board"), stt 1000 1200 "train", stt 1200 1300 "walking"]
private def stSg : Array Seg := #[anchored 900 1000 0 0, sg 1000 1200 "train", sg 1200 1300 "walking"]

-- The raw GPS starts 900 m past the boarding station and stops 900 m short of
-- the alighting one: both join points are stitched on.
#guard (buildEpisodes stSt stSg #[fx 1050 0 900, fx 1100 0 2000, fx 1150 0 3100, fx 1250 0 4000])[1]!.points
  == #[ll 0 0, ll 0 900 (some 1050), ll 0 2000 (some 1100), ll 0 3100 (some 1150), ll 0 4000]

-- Both join points land within 100 m of the existing ends → neither is added;
-- stitching would only duplicate a point already there.
#guard (buildEpisodes stSt stSg #[fx 1050 0 50, fx 1100 0 2000, fx 1150 0 3950, fx 1250 0 4000])[1]!.points
  == #[ll 0 50 (some 1050), ll 0 2000 (some 1100), ll 0 3950 (some 1150)]

-- A nominal 100 m separation. The bar is strict (`> 100`), but the frame's
-- float value lands a hair above it, so the join point is stitched — the exact
-- tie is not constructible from these coordinates.
#guard (buildEpisodes stSt.pop stSg.pop #[fx 1050 0 100, fx 1100 0 2000, fx 1150 0 3000])[1]!.points
  == #[ll 0 0, ll 0 100 (some 1050), ll 0 2000 (some 1100), ll 0 3000 (some 1150)]
#guard equirectMeters (pt 0 0).1 (pt 0 0).2 (pt 0 100).1 (pt 0 100).2 > 100.0

-- A leg with no in-window fixes: `farFromEnd` sees `none` at both ends, so both
-- join points go in and the leg becomes the bare station-to-station chord. The
-- two tests are sequenced — the second sees the first's insertion.
#guard (buildEpisodes stSt stSg #[fx 1250 0 4000, fx 1280 0 4100])[1]!.points == #[ll 0 0, ll 0 4000]

-- A train episode at index 0: the day opens on a ride, so there is no previous
-- episode and only the alighting end is stitched. This is the train arm's half
-- of the empty-`resolved` case above.
#guard render (buildEpisodes #[stt 1000 1200 "train", stt 1200 1300 "walking"]
    #[sg 1000 1200 "train", sg 1200 1300 "walking"] #[fx 1050 0 900, fx 1150 0 3100, fx 1250 0 4000])
  == #[("train", "raw", none, #[ll 0 900 (some 1050), ll 0 3100 (some 1150), ll 0 4000]),
       ("walking", "raw", none, #[ll 0 4000 (some 1250)])]

/-! ### moving — the four draw precedences -/

private def mvSt : Array State := #[stt 1000 1200 "walking"]
private def mvPts : Array Fix := #[fx 1020 0 0, fx 1080 0 60, fx 1140 0 120]

-- `walkSmoothedPath` outranks `walkMatchedPath` (a reconstruction that beat a
-- phantom out-and-back).
#guard render (buildEpisodes mvSt
    #[{ sg 1000 1200 "walking" with
        walkMatchedPath := #[spt 1020 1 0, spt 1140 1 120]
        walkSmoothedPath := #[spt 1020 2 0, spt 1140 2 120] }] mvPts)
  == #[("walking", "smoothed", none, #[ll 2 0 (some 1020), ll 2 120 (some 1140)])]

#guard render (buildEpisodes mvSt
    #[{ sg 1000 1200 "walking" with walkMatchedPath := #[spt 1020 1 0, spt 1140 1 120] }] mvPts)
  == #[("walking", "matched", none, #[ll 1 0 (some 1020), ll 1 120 (some 1140)])]

-- The road arm is tested first but applies to driving/bus/cycling only: a
-- walking leg carrying a `matchedPath` does not take it.
#guard render (buildEpisodes mvSt
    #[{ sg 1000 1200 "walking" with matchedPath := #[spt 1020 3 0, spt 1140 3 120] }] mvPts)
  == #[("walking", "raw", none, #[ll 0 0 (some 1020), ll 0 60 (some 1080), ll 0 120 (some 1140)])]
#guard render (buildEpisodes #[stt 1000 1200 "cycling"]
    #[{ sg 1000 1200 "cycling" with matchedPath := #[spt 1020 3 0, spt 1140 3 120] }] mvPts)
  == #[("cycling", "matched", none, #[ll 3 0 (some 1020), ll 3 120 (some 1140)])]

/-! ### moving — `rawFixes` preferred, and the speed ceiling -/

-- With `rawFixes` the pre-Kalman track is drawn and the hold collapses the
-- teleport run (walking cap 12 km/h).
#guard render (buildEpisodes mvSt #[sg 1000 1200 "walking"] mvPts
    (some #[rx 1000 0 0, rx 1030 0 60, rx 1060 0 2000, rx 1090 0 120, rx 1120 0 180]))
  == #[("walking", "raw", none,
        #[ll 0 0 (some 1000), ll 0 60 (some 1030), ll 0 120 (some 1090), ll 0 180 (some 1120)])]

-- Fewer than two survive → falls through to the Kalman points.
#guard render (buildEpisodes mvSt #[sg 1000 1200 "walking"] mvPts (some #[rx 1000 0 0]))
  == #[("walking", "raw", none, #[ll 0 0 (some 1020), ll 0 60 (some 1080), ll 0 120 (some 1140)])]

-- Without `rawFixes` the Kalman branch filters on the reported `speed_kmh`
-- instead — a different mechanism from the hold, so it drops a different fix.
#guard render (buildEpisodes mvSt #[sg 1000 1200 "walking"]
    #[fx 1020 0 0, fx 1050 0 60 40, fx 1080 0 120, fx 1140 0 180])
  == #[("walking", "raw", none, #[ll 0 0 (some 1020), ll 0 120 (some 1080), ll 0 180 (some 1140)])]

-- A mode with no ceiling keeps every fix.
#guard render (buildEpisodes #[stt 1000 1200 "driving"] #[sg 1000 1200 "driving"]
    #[fx 1020 0 0, fx 1050 0 60 90, fx 1080 0 120, fx 1140 0 180])
  == #[("driving", "raw", none,
        #[ll 0 0 (some 1020), ll 0 60 (some 1050), ll 0 120 (some 1080), ll 0 180 (some 1140)])]

/-! ### stay — `stayAnchor` -/

private def stayPts : Array Fix := #[fx 1020 0 0, fx 1100 0 100]
private def cafe : Array State := #[stt 1000 1200 "stationary" (some "Cafe")]

-- The covering segment's precomputed centroid wins over the window fixes.
#guard render (buildEpisodes cafe #[anchored 1000 1200 5 5] stayPts)
  == #[("stationary", "anchor", some "Cafe", #[ll 5 5])]

-- No centroid → the mean of the window fixes, with no timestamp.
#guard render (buildEpisodes cafe #[sg 1000 1200 "stationary"] stayPts)
  == #[("stationary", "anchor", some "Cafe",
        #[{ lat := ((pt 0 0).1 + (pt 0 100).1) / 2.0, lon := ((pt 0 0).2 + (pt 0 100).2) / 2.0 }])]

-- A segment carrying only one of the two centroid fields is not a centroid.
#guard render (buildEpisodes cafe
    #[{ sg 1000 1200 "stationary" with centroidLat := some (pt 5 5).1 }] stayPts)
  == #[("stationary", "anchor", some "Cafe",
        #[{ lat := ((pt 0 0).1 + (pt 0 100).1) / 2.0, lon := ((pt 0 0).2 + (pt 0 100).2) / 2.0 }])]

-- Neither → an anchor episode with no points (a synthesized pre-fix sleep).
-- The place is still carried; an empty place string is dropped.
#guard render (buildEpisodes #[stt 1000 1200 "sleeping" (some "Home")] #[] #[])
  == #[("sleeping", "anchor", some "Home", #[])]
#guard render (buildEpisodes #[stt 1000 1200 "sleeping"] #[] #[])
  == #[("sleeping", "anchor", none, #[])]
#guard render (buildEpisodes #[stt 1000 1200 "sleeping" (some "")] #[] #[])
  == #[("sleeping", "anchor", none, #[])]

/-! ### unknown — the capped connector and `entryPoint` -/

private def gapSt : Array State :=
  #[stt 900 1000 "walking", stt 1000 1100 "unknown", stt 1100 1200 "walking"]
private def gapSg : Array Seg := #[sg 900 1000 "walking", sg 1100 1200 "walking"]

-- Under 2 km: drawn. The `from` end keeps its fix's timestamp; the `to` end is
-- the next state's first window fix with its timestamp dropped.
#guard render (buildEpisodes gapSt gapSg #[fx 920 0 0, fx 980 0 100, fx 1120 0 1000, fx 1180 0 1100])
  == #[("walking", "raw", none, #[ll 0 0 (some 920), ll 0 100 (some 980)]),
       ("unknown", "tentative", none, #[ll 0 100 (some 980), ll 0 1000]),
       ("walking", "raw", none, #[ll 0 1000 (some 1120), ll 0 1100 (some 1180)])]

-- Over 2 km: refused.
#guard (buildEpisodes gapSt gapSg #[fx 920 0 0, fx 980 0 100, fx 1120 0 5000, fx 1180 0 5100])[1]!.points
  == #[]

-- `entryPoint` falls back to the next state's stay centroid when it has no
-- window fix of its own.
#guard (buildEpisodes #[stt 900 1000 "walking", stt 1000 1100 "unknown", stt 1100 1200 "stationary" (some "Shop")]
    #[sg 900 1000 "walking", anchored 1100 1200 0 500] #[fx 920 0 0, fx 980 0 100])[1]!.points
  == #[ll 0 100 (some 980), ll 0 500]

-- No previous episode at all (the gap opens the day) → nothing drawn. `resolved`
-- is empty here, so Nat's `0 - 1 = 0` reads out of bounds and yields `none`.
#guard (buildEpisodes #[stt 1000 1100 "unknown", stt 1100 1200 "walking"] #[sg 1100 1200 "walking"]
    #[fx 1120 0 100, fx 1180 0 200])[0]!.points == #[]

-- The previous episode exists but drew nothing.
#guard (buildEpisodes #[stt 900 1000 "sleeping", stt 1000 1100 "unknown", stt 1100 1200 "walking"]
    #[sg 1100 1200 "walking"] #[fx 1120 0 100, fx 1180 0 200])[1]!.points == #[]

/-! ### the whole-day shape — 1:1 with the states, in order -/

private def dayEps : Array Episode :=
  buildEpisodes
    #[stt 0 1000 "sleeping" (some "Home"), stt 1000 1200 "walking", stt 1200 1400 "train",
      stt 1400 1500 "unknown", stt 1500 2000 "stationary" (some "Work")]
    #[anchored 0 1000 0 0, sg 1000 1200 "walking",
      { sg 1200 1400 "train" with snappedPath := #[spt 1250 0 500, spt 1350 0 1500] },
      anchored 1500 2000 0 1800]
    #[fx 1020 0 0, fx 1100 0 100, fx 1180 0 200, fx 1550 0 1800]

#guard dayEps.size == 5
#guard dayEps.map (fun e => (e.startTs, e.endTs))
  == #[(0, 1000), (1000, 1200), (1200, 1400), (1400, 1500), (1500, 2000)]
#guard dayEps.map (·.kind) == #["anchor", "raw", "snapped", "tentative", "anchor"]
-- The gap connector runs from the train's last drawn vertex to the stay's
-- centroid, and the stay draws that same centroid.
#guard dayEps[3]!.points == #[ll 0 1500 (some 1350), ll 0 1800]
#guard dayEps[4]!.points == #[ll 0 1800]

end Verified.Geo.EpisodeGeometry
