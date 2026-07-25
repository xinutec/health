import Verified.Geo.Prefilter
import Verified.Geo.ModeBiometrics
/-!
# Episode geometry — the map's half of "one day, two renderers"

Port of `src/geo/episode-geometry.ts`. The narrative renders the smoothed
`DayState[]` sequence; `buildEpisodes` resolves a display geometry for each of
those states, 1:1, so the map cannot draw a story the timeline does not tell.

Geometry is strictly downstream of classification and never feeds back —
depiction never re-decides what happened. That is why this module produces only
`Episode` records and reads only already-decided fields.

## What is decided here

`resolveEpisode` is a dispatch on the state's mode, and each arm is a *display*
policy, not a classification:

* **train** — a cached rail line (`snappedPath`) clipped to the window wins. A
  reconstructed leg (`pointCount = 0`, i.e. a tube ride whose window holds only
  teleporting cell-network garbage) draws a clean station-to-station connector
  with NO distance cap, because a rail leg legitimately spans kilometres.
  Otherwise the raw GPS, with the two station join points stitched on
  ({@link stitchTrainEnds}) — a train's GPS commonly starts after it pulls away
  and stops before it arrives, and without the stitch the adjacent walk bridges
  green across the missing tail.
* **moving** — four draw sources in strict precedence: road match, walk
  reconstruction, walk match, raw fixes. The raw arm prefers the PRE-Kalman
  `rawFixes`: measured, the road-blind smoother both pulls the line off the
  path and truncates it, so the map bridges the gap with a chord through
  buildings.
* **stay** — one anchor point, the covering segment's centroid or the mean of
  the window fixes.
* **unknown** — a connector capped at 2 km, so a no-GPS gap cannot imply a
  cross-city route we do not have.

## Two metres functions, deliberately different

{@link equirectMeters} here takes `cos` at the FIRST point and combines with
`sqrt`; `metersBetween` (`map-match-core.ts`, ported in
`Verified.Geo.WalkableRoute`) takes `cos` at the MIDPOINT and combines with
`hypot`. Both are in the codebase and they do not agree; this module's
thresholds were tuned against this one.

## Exactness

Everything is comparison, filtering and array sequencing ⇒ EXACT, except
{@link equirectMeters}'s `cos`/`sqrt` and the float mean in
{@link centroidOf}, which are ≤1 ULP and only ever compared against metre
thresholds (100 m stitch bar, 2 km connector cap). UNPROVEN; pinned against
Node/V8 (`lean/experiments/episode-geometry-refs.mts`).

## Shape notes

* `undefined` and `[]` are the same thing for every drawn-path field, because
  the TS tests `(s.path?.length ?? 0) >= 2` — so they are plain `Array` here.
  `rawFixes` is NOT one of those: the TS tests `if (rawFixes)`, and an empty
  array is truthy in JS, so it stays an `Option`.
* Timestamps are `Int`. They are copied through untouched, and the pipeline's
  are whole UTC seconds.
-/

namespace Verified.Geo.EpisodeGeometry

open Verified.Geo (holdSpeed rejectSpikes)

/-! ## Shapes -/

/-- A `DayStateMode`, kept as `String` for the same reason
`Verified.Geo.DayState` does. -/
abbrev Mode := String

/-- Geometry provenance — the only style input the map needs. Solid for
`raw`/`matched`, dashed for `snapped`/`tentative`, a dot for `anchor`. No
confidence field: the only upstream confidence is CLASSIFICATION confidence,
which is not geometry trust. -/
abbrev Kind := String

/-- A drawn vertex. `ts` is present when the vertex came from a timestamped
point (raw GPS, matched, or snapped) and absent for derived geometry with no
single moment — a stay anchor (a centroid) or a connector endpoint. Surfaced so
the map's point-inspector can show *when* a drawn vertex was. -/
structure LatLon where
  lat : Float
  lon : Float
  ts : Option Int := none
  deriving Inhabited, BEq, Repr

/-- A vertex of a derived path (`snappedPath` / `matchedPath` / …), which always
carries an interpolated timestamp. -/
structure SPt where
  lat : Float
  lon : Float
  ts : Int
  deriving Inhabited, BEq, Repr

/-- The `FilteredPoint` fields this module reads — the Kalman-smoothed track. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  deriving Inhabited, BEq, Repr

/-- A raw GPS fix as captured (pre-Kalman). `accuracy` is carried by the TS
type but never read here — the physics of the mode is the constraint, not the
phone's self-reported number — so it is absent. -/
structure RawFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- The `EnrichedSegment` fields `resolveEpisode` reads. A different projection
of the same TS record than `Verified.Geo.DayState.Seg`, which reads the
labelling fields instead. -/
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

/-- A no-GPS `unknown` gap longer than this (metres, straight-line) is not
bridged — drawing a dashed line kilometres across a city would imply a route we
do not have. A display constant, the sibling of `rejectSpikes`'s 500 m spike
bar; not a classifier threshold. -/
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

private def pi : Float := 3.141592653589793

/-- Equirectangular metres, `cos` at the FIRST point and `sqrt` (not `hypot`).
See the module docstring: this is NOT `metersBetween`. -/
def equirectMeters (aLat aLon bLat bLon : Float) : Float :=
  let dLat := (bLat - aLat) * 111320.0
  let dLon := (bLon - aLon) * 111320.0 * Float.cos (aLat * pi / 180.0)
  Float.sqrt (dLat * dLat + dLon * dLon)

/-- The mean of a set of points, or `none` when there are none. Sums in array
order, as the TS loop does. -/
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

`Verified.Geo.Prefilter` (namespace `Verified.Geo`) owns the two recursions and their invariants
(`holdSpeed_chain`, `rejectSpikes_sublist`); here they are only instantiated
with the float predicates the TS uses. -/

/-- `rejectSpikes`'s predicate: a point juts out and back when the detour
through it is both several times longer than going straight past it AND a large
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
from the last KEPT fix is within `capKmh`. A non-positive `dt` fails, matching
the TS `continue`. -/
def speedOk (capKmh : Float) (last cur : RawFix) : Bool :=
  let dt := Float.ofInt (cur.ts - last.ts)
  if dt ≤ 0 then false
  else equirectMeters last.lat last.lon cur.lat cur.lon / dt * 3.6 ≤ capKmh

/-- The kinematic hold. A run of fixes that each require impossible speed — an
underground/indoor GPS teleport, which reports GOOD self-reported accuracy — is
held at the last plausible position, so the leg collapses toward stationary
instead of drawing an impossible sprint. `none` for the cap is the TS
`Number.isFinite` bypass: no ceiling for this mode, so nothing is dropped. -/
def holdImplausibleSpeed (fixes : Array RawFix) (capKmh : Option Float) : Array RawFix :=
  match capKmh with
  | none => fixes
  | some cap => (holdSpeed (speedOk cap) (fun i => fixes.getD i default) fixes.size).toArray

/-! ## The three private helpers -/

/-- `refinedMode ?? mode` — `segment-util.ts`'s `effectiveMode`. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Whether a timestamp lies in a window, INCLUSIVE at both ends (the dominant
convention across the pipeline). -/
def inWindow (ts start finish : Int) : Bool := ts ≥ start && ts ≤ finish

/-- Segments overlapping a state's window — strict on both sides, so a segment
merely touching a boundary does not cover it. -/
def coveringSegs (segments : Array Seg) (st : State) : Array Seg :=
  segments.filter (fun s => s.startTs < st.endTs && s.endTs > st.startTs)

/-- Anchor a raw train leg's geometry to its station join points. Prepend
`from` / append `to` when present and more than `STATION_STITCH_MIN_M` from the
existing end, so the whole leg stays train-coloured and its neighbours bridge
from zero. The fixes in between are untouched.

The two tests are SEQUENCED, not independent: `to` is compared against the end
of the array *after* a possible `from` prepend, so on an empty leg the second
test sees the first's insertion. -/
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
is DROPPED: the connector endpoint is derived geometry with no single moment. -/
def entryPoint (st? : Option State) (segments : Array Seg) (points : Array Fix) : Option LatLon :=
  match st? with
  | none => none
  | some st =>
    match points.find? (fun p => inWindow p.ts st.startTs st.endTs) with
    | some f => some { lat := f.lat, lon := f.lon }
    | none => stayAnchor (coveringSegs segments st) #[]

/-! ## The dispatch -/

/-- A `Fix` as a drawn vertex, keeping its moment. -/
def toLatLon (p : Fix) : LatLon := { lat := p.lat, lon := p.lon, ts := some p.ts }

/-- A `RawFix` as a drawn vertex. -/
def rawToLatLon (p : RawFix) : LatLon := { lat := p.lat, lon := p.lon, ts := some p.ts }

/-- A derived path clipped to a window, as drawn vertices. -/
def clipPath (path : Array SPt) (st : State) : Array LatLon :=
  (path.filter (fun sp => inWindow sp.ts st.startTs st.endTs)).map
    (fun sp => { lat := sp.lat, lon := sp.lon, ts := some sp.ts })

/-- The per-mode speed ceiling, `none` where the mode has none. -/
def capForMode (mode : Mode) : Option Float :=
  (Verified.Geo.ModeBiometrics.MAX_SPEED_FOR_MODE.find? (fun p => p.1 == mode)).map (·.2)

/-- Resolve one state's display geometry. Sequence-aware: the train and
`unknown` connectors read the PREVIOUS resolved episode and the NEXT state's
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

    -- Boarding / alighting join points: where the previous episode left off and
    -- where the next one begins — i.e. this leg's two stations.
    -- `resolved` holds exactly the `index` episodes already built, so at index 0
    -- it is empty and Nat's truncating `0 - 1 = 0` still reads out of bounds.
    -- No index guard is needed, and adding one would be dead code.
    let from? := (resolved[index - 1]?).bind (fun e => e.points[e.points.size - 1]?)
    let to? := entryPoint states[index + 1]? segments points

    -- A reconstructed underground leg has no real GPS for the ride. Draw a
    -- clean connector station-to-station in train colour, so the tube leg reads
    -- as a line between its stations and the onward walk bridges from the
    -- alighting end. No cap (cf. the `unknown` connector): rail spans km.
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

    -- Unmatched moving leg: draw the RAW GPS, not the Kalman-smoothed points.
    -- Measured: the road-blind smoother makes good data worse two ways — on a
    -- road leg it swings up to ~75 m off the reliable GPS, and on a walk it
    -- TRUNCATES, so the line stops short and the map bridges the gap with a
    -- chord through buildings. `despike` drops lone teleports;
    -- `holdImplausibleSpeed` then collapses a monotonic teleport RUN that both
    -- despiking and the accuracy field miss.
    match rawFixes with
    | some rf =>
      let sw := rf.filter (fun p => inWindow p.ts st.startTs st.endTs)
      let kept := (rejectSpikes (fun a b c => spikeAt (rawToLatLon a) (rawToLatLon b) (rawToLatLon c))
        (fun i => sw.getD i default) sw.size).toArray
      let rawWin := holdImplausibleSpeed kept (capForMode mode)
      if rawWin.size ≥ 2 then return base (rawWin.map rawToLatLon) "raw" none
    | none => pure ()

    -- Speed-plausibility filter THEN geometric spike rejection. The filter drops
    -- a faster neighbour's fixes that bled across the boundary (a decelerating
    -- train's tail landing inside the following walk at vehicle speed);
    -- despiking drops teleports. They are complementary — the bleed is smooth
    -- and monotonic, so despiking alone would miss it.
    let plausible := match capForMode mode with
      | none => windowFixes
      | some cap => windowFixes.filter (fun p => p.speedKmh ≤ cap)
    return base (despike (plausible.map toLatLon)) "raw" none

  if mode == "stationary" || mode == "sleeping" then
    let anchor := stayAnchor covering (windowFixes.map toLatLon)
    -- An empty place string is falsy in the TS spread, so it is dropped here too.
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

References: `lean/experiments/episode-geometry-refs.mts`, which drives these
same scenarios through the production `buildEpisodes`.

Scenario coordinates are built from the frame arithmetic rather than pasted as
decimals, so the Lean and V8 sides compute the same doubles instead of both
parsing a rounded literal. The frame itself is tied to V8's printed values by
the first block of guards — that is what makes the constructed expectations
below sound. -/

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

private def ll (n e : Float) (ts : Option Int := none) : LatLon :=
  { lat := (pt n e).1, lon := (pt n e).2, ts }
private def fx (ts : Int) (n e : Float) (v : Float := 4) : Fix :=
  { ts, lat := (pt n e).1, lon := (pt n e).2, speedKmh := v }
private def rx (ts : Int) (n e : Float) : RawFix :=
  { ts, lat := (pt n e).1, lon := (pt n e).2 }
private def spt (ts : Int) (n e : Float) : SPt :=
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

-- Only ONE vertex lands in the window → falls through to the raw arm, which
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

/-! ### train — a reconstructed leg draws an UNCAPPED station connector -/

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

-- A nominal 100 m separation. The bar is STRICT (`> 100`), but the frame's
-- float value lands a hair above it, so the join point IS stitched — the exact
-- tie is not constructible from these coordinates.
#guard (buildEpisodes stSt.pop stSg.pop #[fx 1050 0 100, fx 1100 0 2000, fx 1150 0 3000])[1]!.points
  == #[ll 0 0, ll 0 100 (some 1050), ll 0 2000 (some 1100), ll 0 3000 (some 1150)]
#guard equirectMeters (pt 0 0).1 (pt 0 0).2 (pt 0 100).1 (pt 0 100).2 > 100.0

-- A leg with no in-window fixes: `farFromEnd` sees `none` at both ends, so BOTH
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

-- The road arm is tested FIRST but applies to driving/bus/cycling only: a
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

-- Without `rawFixes` the Kalman branch filters on the REPORTED `speed_kmh`
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

-- No centroid → the mean of the window fixes, with NO timestamp.
#guard render (buildEpisodes cafe #[sg 1000 1200 "stationary"] stayPts)
  == #[("stationary", "anchor", some "Cafe",
        #[{ lat := ((pt 0 0).1 + (pt 0 100).1) / 2.0, lon := ((pt 0 0).2 + (pt 0 100).2) / 2.0 }])]

-- A segment carrying only ONE of the two centroid fields is not a centroid.
#guard render (buildEpisodes cafe
    #[{ sg 1000 1200 "stationary" with centroidLat := some (pt 5 5).1 }] stayPts)
  == #[("stationary", "anchor", some "Cafe",
        #[{ lat := ((pt 0 0).1 + (pt 0 100).1) / 2.0, lon := ((pt 0 0).2 + (pt 0 100).2) / 2.0 }])]

-- Neither → an anchor episode with no points (a synthesized pre-fix sleep).
-- The place is still carried; an EMPTY place string is falsy in the TS spread
-- and is dropped here too.
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
-- the next state's first window fix with its timestamp DROPPED.
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
