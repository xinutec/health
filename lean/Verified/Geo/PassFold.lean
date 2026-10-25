import Verified.Geo.Velocity
import Verified.Geo.SegmentMerge
import Verified.Geo.RailRunAnnotate
import Verified.Geo.RailAbsorbers
import Verified.Geo.RailReconcile
import Verified.Geo.StaySplit
import Verified.Geo.SegmentPasses
import Verified.Geo.TubeHop
import Verified.Geo.Factors
import Verified.Geo.Bus
import Verified.Geo.PlaceOverride
import Verified.Geo.TransitPlace
import Verified.Geo.BiometricWindows
import Verified.Geo.BiometricLabels
import Verified.Geo.RoadMatchAnnotate
import Verified.Geo.WalkAnnotate
import Verified.Geo.Landmarks
/-!
# The naming tail

The decoder draws the day (`DayEntry.decoderSegs`); these passes NAME what it
drew — the track a ride ran on, the bus, the roads of a walk, the zone, the
biometrics, the decoder's places, the station a stay beside a ride is at — and
settle a ride's edges against the fixes. They run in order, each consuming what
the last produced, as one array of entries, because the order is load-bearing:
a station stay named before boarding keeps the chain open, the track is read
again after the passes that relabel a ride. Nothing in this module decides
anything itself: it names passes and their order, and every decision belongs to
the module the entry calls.

## The environment

The day's observations and the shell's lookups arrive as one record rather than
as 20 parameters, so adding a pass that needs a new lookup does not re-thread
every call site. Three kinds of field live in it:

* **Observations** — the Kalman track, the pre-Kalman coarse fixes, the step
  rows.
* **Mirror reads** — station / line / way lookups against the local OSM mirror.
  Functions of a coordinate, which is what the TS passes them as.
* **Shell callbacks** — the two things Lean cannot do and does not pretend to:
  venue re-resolution (`bestPlace`) and the IANA zone at a coordinate (`tzAt`).

## Why the fixes are projected rather than unified

Every pass declares the fix shape it reads, and they differ: some want a speed
per fix, most want only a position and a timestamp. The env carries the RICHEST
one and narrows at each call site.

That is safe HERE in a way it would not be for the segment record, and the
difference is worth stating: a fix is INPUT, which no pass writes. Narrowing an
input to the fields a consumer declares cannot lose a write, because there are
none. The segment record is the opposite — every pass rewrites it — so a
narrowed segment silently drops whatever an earlier pass wrote into a field the
projection omitted. That is why the segment is one shared record and the fix is
not.

Measured, not assumed: unifying the fix would cost 63 fixture literals across
six modules (an anonymous constructor takes every explicit field, so a default
does not save them) to delete six one-line projections.
-/

namespace Verified.Geo.PassFold

/-- A pre-Kalman fix with the accuracy its source reported (`none` when it
reported none). A deep tube ride's fixes come from the cell network, and their
hundred-metre-plus radii are the underground signal. -/
structure CoarseFix where
  ts : Int
  lat : Float
  lon : Float
  accuracy : Option Float := none
  deriving Inhabited, BEq, Repr

/-- A station a line serves, with the coordinate of its canonical node. -/
structure LineStation where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

open Verified.Geo.SegmentMerge (Seg StepPoint)

/-- The day's observations and the shell's lookups. -/
structure Env where
  /-- The Kalman-filtered track, carrying the per-fix speed the ride-head and
  rail passes read. Every other pass takes a narrowing of it. -/
  points : Array Shed.PointF
  /-- The RAW, pre-Kalman fixes. The underground reconstruction mines these
  because smoothing destroys the coarse cell-network pattern it looks for. -/
  rawFixes : Array CoarseFix
  /-- Per-minute step rows. -/
  steps : Array StepPoint
  /-- Route-relation stop membership, for the stopping-pattern line picker. -/
  railStops : Array Verified.Geo.LineStoppingPattern.RailStopRelation
  /-- `osm.nearbyStations(lat, lon, radiusM)` — the radius is the caller's, so
  each pass supplies its own. -/
  nearbyStations : Float → Float → Float → Array Verified.Geo.TubeHop.NearbyStation
  /-- `osm.linesAtPoint(lat, lon, radiusM)`. -/
  linesAtPoint : Float → Float → Float → Array String
  /-- `osm.nearbyWays(lat, lon)`. -/
  nearbyWays : Float → Float → Array Verified.Geo.Factors.NearbyWay
  /-- SHELL: re-resolve a merged stay's venue from its combined centre. An OSM
  call in the TS, injected here so the pass around it ports whole. -/
  bestPlace : Float → Float → Int → Int → String → Option Verified.Geo.SegmentMerge.ResolvedPlace
  /-- Name a stay the way the enrichment stage names every stay — election of
  a mined place included — from the fixes in its window
  ({@link Verified.Geo.EnrichFold.nameStay}). `walkDwell` hands its carved
  stops to this; the identity default leaves them unnamed. -/
  nameStay : Seg → Seg := id
  /-- SHELL: the IANA zone at a coordinate. tzdata, not arithmetic.

  The TS wraps this in a `try`/`catch` and falls back to `homeTz`. Total here,
  so the fallback belongs to whoever supplies the function. -/
  tzAt : Float → Float → String
  /-- The user's home zone: what `displayTz` writes for a segment no fix
  covers, and the TS's fallback when `tzLookup` throws. -/
  homeTz : String := "Europe/London"
  /-- `osm.stationsOnLine(line)` — every station the line serves, with the
  coordinate of its canonical node. The RICHEST of the three shapes the passes
  ask for; the other two are projections of it. -/
  stationsOnLine : String → Array LineStation := fun _ => #[]
  /-- `rail_route_cache` rows, filled offline by `refresh-rail-routes`. -/
  railRouteCache : Array Verified.Geo.RailReconcile.RouteRow := #[]
  /-- `bus_route_cache` rows. Empty is the honest "no mirror yet", and the pass
  is a no-op then — which is why capturing routes cannot move a golden day. -/
  busRouteCache : List Verified.Geo.Bus.BusRoute := []
  /-- `osm.nearbyTransitStops(lat, lon, radiusM)`. -/
  transitStops : Float → Float → Float → Array Verified.Geo.Bus.TransitStop := fun _ _ _ => #[]
  /-- The HSMM's decode for this day, or empty when the cron has not run. The
  TS tests the decode for null; empty carries the same meaning here. -/
  hmmDecode : Array Verified.Geo.PlaceOverride.HmmSeg := #[]
  /-- How far a leg's start may sit from its pull-away, for the bus passes'
  boarding wait (`Bus.detectBoardingWait`): 0 for the cascade's legs, a
  minute when the decoder's minute-aligned segments head the fold. -/
  boundarySlackS : Int := 0
  /-- Place id → display name and centroid, for resolving the HSMM's picks. -/
  hsmmPlaces : List (Int × Verified.Geo.PlaceOverride.PlaceLookup) := []
  /-- Mined focus places, for the far-phantom swallow. -/
  knownPlaces : Array Verified.Geo.SegmentMerge.KnownPlaceProjection := #[]
  /-- `focus_places.unique_days` by id — how established a place is. The
  transit-interchange labeller reads it as a PROVENANCE guard: a stay the
  posterior assigned to a place visited on many days is a destination, not a
  platform, and the rename is refused. A separate field because
  `KnownPlaceProjection` carries geometry only. -/
  focusPlaceDays : Int → Option Int := fun _ => none
  /-- Intraday heart-rate samples. -/
  hr : List Verified.Geo.BiometricWindows.HrPoint := []
  /-- Sleep-stage windows. -/
  sleep : List Verified.Geo.BiometricWindows.SleepStage := []
  /-- SHELL: re-derive one split walk's enrichment from its own geometry.
  `none` is a failed re-enrichment, and the TS's answer to that is to leave the
  leg honestly unnamed rather than confidently wrong — so the caller keeps the
  segment as it stands. The only genuinely async pass in the cascade; what is
  ASYNC is the OSM naming, and what is sequencing stays here. -/
  reenrich : Seg → Option Seg := fun _ => none
  /-- The road matcher's shell: the street-network read and the solver.

  ⚠ **THE UNFED READ DECLINES, IT DOES NOT ANSWER EMPTY** (#1667). A shell
  nobody wired has no mirror behind it, and "there are no roads here" is a claim
  about the world that an unwired shell is in no position to make. The pass
  leaves the leg raw either way, so this changes no drawing — what it changes is
  that a host can tell the two apart, and record the ground it could not
  answer for. -/
  roadEnv : Verified.Geo.RoadMatchAnnotate.Env :=
    { drivableRoads := fun _ _ _ => none, matcher := fun _ _ => none }
  /-- The pedestrian matcher's shell: two OSM reads and five solver leaves. The
  two reads decline for the same reason `roadEnv`'s does. -/
  walkEnv : Verified.Geo.WalkAnnotate.Env :=
    { walkableRoads := fun _ _ _ => none
      buildingsNear := fun _ _ _ => none
      matcher := fun _ _ _ => none
      reconstruct := fun _ _ _ _ => none
      refineMatched := fun _ _ => none
      correct := fun drawn _ _ => drawn
      snapPassages := fun drawn _ => drawn }
  /-- The DISPLAY fixes — a different series from `points`, carrying the
  phone's self-reported accuracy the walk draw weighs. -/
  displayFixes : Array Verified.Geo.WalkAnnotate.PedFix := #[]
  /-- Kalman speed at a timestamp, for the walk matcher's pace gate. -/
  speedByTs : Int → Option Float := fun _ => none
  /-- Which line a walking leg draws. `matcher` is production. -/
  walkDraw : Verified.Geo.WalkAnnotate.Draw := .matcher
  /-- The walk draw's toggles. `matchDisable` is the `/api/velocity`
  `walkMatch=0` query param: it skips matching so the map can render raw walks
  for an A/B against the pavement-matched line. -/
  walkFlags : Verified.Geo.WalkAnnotate.Flags := {}

/-! ## Fix projections

Every pass declares a fix as `Verified.GeoFix` (time and position) or
`Verified.SpeedFix` (the env's own `PointF`, speed included) since #1937 — the
nine per-pass projections that copied the same fields are this one, and the
speed-carrying passes read `e.points` itself. Nothing is invented. -/

def Env.geoFixes (e : Env) : Array Verified.GeoFix :=
  e.points.map fun p => ⟨p.ts, p.lat, p.lon⟩

/-- The step rows as the worldline passes declare them. A field-for-field
rename: both carry a `Float` count. -/
def Env.feasSteps (e : Env) : List Verified.Geo.Worldline.FeasibilityStepPoint :=
  (e.steps.map fun s => ⟨s.ts, s.steps⟩).toList

/-- The step rows as the biometric windows declare them. A rename: `Float` both
sides, unlike the two `Int` conversions above. -/
def Env.biomSteps (e : Env) : List Verified.Geo.BiometricWindows.StepPoint :=
  (e.steps.map fun s => ⟨s.ts, s.steps⟩).toList

/-! ## Radii the cascade chooses

The mirror lookups take a radius, and it is the CALLER that picks one — the same
lookup reaches for a different distance depending on which pass is asking. Each
of these is a verbatim copy of the TS constant named beside it.

UNPINNED, and that is a gap rather than a decision: nothing here brackets them,
because the fold has no scenario guards yet. The pass each one feeds does pin
its own behaviour, so a wrong value surfaces as a wrong answer rather than as
silence — but that is weaker than a fixture either side of the bar. -/

/-- `DEFAULT_RADIUS_M.linesAtPoint` (`src/geo/osm.ts`) — what the adapter falls
back to when the caller names none, which is how `railRuns` calls it. -/
def LINES_AT_POINT_DEFAULT_RADIUS_M : Float := 100

/-! ## The two passes with no module of their own

Every other entry names a function some module owns. These two are written
inline in `velocity.ts`, so they are written here — they are pass BODIES, not
wiring, and they belong to the fold in the same way. -/

/-- Fixes covering a segment's window. `samplesInWindow`: INCLUSIVE both ends,
the pipeline's dominant reading. -/
private def inWindow (e : Env) (s : Seg) : Array Shed.PointF :=
  Verified.SpeedFix.within e.points s.startTs s.endTs

/-- The mean of the fixes in a segment's window; `none` when no fix falls in it. -/
private def centroidOf (e : Env) (s : Seg) : Option (Float × Float) :=
  let pts := inWindow e s
  if pts.isEmpty then none
  else
    let n := Float.ofNat pts.size
    some ((pts.foldl (fun a p => a + p.lat) 0) / n, (pts.foldl (fun a p => a + p.lon) 0) / n)

/-- The zone the frontend renders this segment's clock in, so a travel day
reads as it was lived — morning at parents in CEST, evening home in BST.

Stationary takes the centroid, moving the midpoint of the path: a ride's
average position is somewhere it never was, and on a leg that crosses a border
that is the wrong side. Note `mode` and not `effectiveMode`, as the TS has it —
a leg refined to walking keeps the stationary branch. -/
def displayTz (e : Env) (segs : Array Seg) : Array Seg :=
  segs.map fun s =>
    let pts := inWindow e s
    -- No fixes, no midpoint: the home zone.
    match pts[pts.size / 2]? with
    | none => { s with displayTz := some e.homeTz }
    | some mid =>
      let (lat, lon) :=
        if s.mode == "stationary" then (centroidOf e s).getD (mid.lat, mid.lon)
        else (mid.lat, mid.lon)
      { s with displayTz := some (e.tzAt lat lon) }

/-- Name a train-bracketed stay after its station.

Runs LAST because the train adjacency is only final once the rail passes and
`repairHandoff` have absorbed the slivers between the change and the next ride;
the early place enrichment that named the stay had no transit context at all.

The centroid is recomputed here rather than read off `centroidLat`, which is not
reliably attached by this point — the TS does the same, for the same reason.

The scan reads the array it is REWRITING, so a stay renamed at `i` is what index
`i + 1` sees when it looks for its bracketing trains. That is the TS's `out[i] =`
in place, and it is load-bearing for a run of two changes. -/
private def isStationStay (s : Seg) : Bool :=
  Verified.Geo.SegmentMerge.effectiveMode s == "stationary" && s.placeSource.any (·.rule == "station")

/-- The stations in range of a stay's centroid, nearest first, for the alight
rule — or the stay's own name when it must keep it. A name yields only when
the picker found it by rank alone, the weakest source in
`NameConfidence.COUNTS` (06-15: thirty minutes at Green Park's bus stop read
"Pret A Manger"); a name from the stay's own fixes at the venue stands against
the station beside it (06-15: thirteen minutes at a Pret 69 m from Euston's
node; 06-09: a coffee 145 m from Wembley Park's), as does a station's, the
decoder's (its wait arrives with the station and no source), a night's and an
established focus place's (04-23: two hours at Work beside St Pancras). -/
private def stationsAtAlight (e : Env) (s : Seg) : Array String := Id.run do
  if s.place.isSome && !s.placeSource.any (·.rule == "ranked") then return s.place.toArray
  if (s.focusPlaceId.bind e.focusPlaceDays).any
      (· ≥ Verified.Geo.TransitPlace.INTERCHANGE_FOCUS_GUARD_MIN_DAYS) then return #[]
  let some (cLat, cLon) := centroidOf e s | return #[]
  return Verified.Geo.TransitPlace.stationsWithin cLat cLon e.nearbyStations

/-- Name the first stay after a train for the station its label says it
alighted at, when the stay is in range of it
(`TransitPlace.stationsAfterAlighting`): the mirror of `boardingStayLabels`,
and the rule the enrichment's own alight rule cannot reach — under the decoder's
head a walk up from the platform parts the ride from the stay (05-22's nineteen
minutes at Finchley Road, named for the shop beside it). Names only. -/
def alightStayLabels (e : Env) (segs : Array Seg) : Array Seg := Id.run do
  let trainAlight (i : Nat) : Option String := do
    let s ← segs[i]?
    let rail ← Verified.Geo.RailAbsorbers.parseRailWayName s.wayName
    if rail.alight.isEmpty then none else some rail.alight
  let names := Verified.Geo.TransitPlace.stationsAfterAlighting segs
    (fun i => (segs[i]?.map (stationsAtAlight e)).getD #[]) trainAlight
  let mut out := segs
  for i in [0 : out.size] do
    let some s := out[i]? | continue
    let some (some station) := names[i]? | continue
    if s.place == some station then continue
    out := out.set! i { s with place := some station
                               placeSource := some ⟨station, "station", centroidOf e s⟩
                               refinedReason := some (match s.refinedReason with
                                 | some r => s!"{r}; alighted here → named station"
                                 | none => "alighted here → named station") }
  return out

/-- Is `p` within station range of a node named `st`? -/
private def inStation (e : Env) (st : String) (p : Shed.PointF) : Bool :=
  let R := Verified.Geo.TransitPlace.STATION_AT_ALIGHT_RADIUS_M
  (e.nearbyStations p.lat p.lon R).any fun n => n.name == st && n.distanceM ≤ R

/-- The stations in range of a stay's centroid, nearest first — or none when the
stay must keep its name: already a station stay (its own name), or an
established focus place. -/
private def stationsAround (e : Env) (s : Seg) : Array String := Id.run do
  if isStationStay s then return s.place.toArray
  if (s.focusPlaceId.bind e.focusPlaceDays).any
      (· ≥ Verified.Geo.TransitPlace.INTERCHANGE_FOCUS_GUARD_MIN_DAYS) then return #[]
  let some (cLat, cLon) := centroidOf e s | return #[]
  return Verified.Geo.TransitPlace.stationsForWait cLat cLon (s.endTs - s.startTs) e.nearbyStations

/-- Which station names each wait before a train, and why: the chain back from
the train (`TransitPlace.stationsBeforeBoarding`) first, else the chain forward
from a stay the station building encloses (`TransitPlace.stationsFromEnclosed`,
read off `placeKind`). `none` where neither speaks. -/
private def boardingNames (e : Env) (segs : Array Seg) : Array (Option (String × String)) :=
  let stationsAt (i : Nat) : Array String := (segs[i]?.map (stationsAround e)).getD #[]
  let trainBoard (i : Nat) : Option String := do
    let s ← segs[i]?
    let rail ← Verified.Geo.RailAbsorbers.parseRailWayName s.wayName
    if rail.board.isEmpty then none else some rail.board
  let walkWithin (i : Nat) (st : String) : Bool :=
    match segs[i]? with
    | some w => let pts := inWindow e w; !pts.isEmpty && pts.all (inStation e st)
    | none => false
  -- A stay the station BUILDING encloses (`placeKind`, written by the namer
  -- with the name), given the station nodes in range of it.
  let enclosedAt (i : Nat) : Array String := Id.run do
    let some s := segs[i]? | return #[]
    if Verified.Geo.SegmentMerge.effectiveMode s != "stationary" then return #[]
    if !s.placeSource.any (·.rule == "enclosing") then return #[]
    if s.placeKind != some Verified.Geo.Landmarks.STATION_BUILDING then return #[]
    let some (cLat, cLon) := centroidOf e s | return #[]
    return Verified.Geo.TransitPlace.stationsWithin cLat cLon e.nearbyStations
  let back := Verified.Geo.TransitPlace.stationsBeforeBoarding segs stationsAt trainBoard walkWithin
  let inside := Verified.Geo.TransitPlace.stationsFromEnclosed segs enclosedAt stationsAt trainBoard
  (Array.range segs.size).map fun i =>
    match back[i]? with
    | some (some st) => some (st, "the wait before boarding → named station")
    | _ => match inside[i]? with
      | some (some st) => some (st, "inside the station before boarding → named station")
      | _ => none

/-- Name the waits before a train after their station — the chain back from
the train (`TransitPlace.stationsBeforeBoarding`, through a stay or a short
walk inside the board station) and the chain forward from a stay the station
building encloses (`TransitPlace.stationsFromEnclosed`, read off `placeKind`).
Names only: the decoder's walk to the platform between two waits at one station
stands (10-08's 07:13–07:21Z at Hendaye, the journey's first leg to the
narrative and the referee). -/
def boardingStayLabels (e : Env) (segs : Array Seg) : Array Seg := Id.run do
  let names := boardingNames e segs
  let mut out := segs
  for i in [0 : out.size] do
    let some s := out[i]? | continue
    let some (some (station, why)) := names[i]? | continue
    if isStationStay s then continue
    out := out.set! i { s with place := some station
                               placeSource := some ⟨station, "station", centroidOf e s⟩
                               refinedReason := some (match s.refinedReason with
                                 | some r => s!"{r}; {why}"
                                 | none => why) }
  return out

/-- A held position must last this long after a ride to say the rider stayed
underground: out on a street the phone fixes again within a minute or two. -/
def ALIGHT_HOLD_MIN_S : Int := 180
/-- A re-reported cell position wanders by metres (2026-10-01: 544–549 m from
Montparnasse-Bienvenüe over five minutes); within this it is the same reading. -/
def ALIGHT_HOLD_RADIUS_M : Float := 10
/-- The first fresh fix after the hold must lie this near the station it names. -/
def ALIGHT_FRESH_MAX_M : Float := 400

/-- A ride whose last fix the phone then HELD (the same position repeated, the
accuracy growing) alights at the line's station nearest the first fix after the
hold, when that is nearer than the labelled one (#1891). A held fix is one cell
reading, not a place: 2026-10-01's Métro 4 ended on a fix 19 m from Vavin, held
10:16–10:21 London with no street fix, and the first fresh one sat 217 m from
Montparnasse-Bienvenüe, where he got off and walked the corridors to the Gare. -/
def alightAfterHold (e : Env) (segs : Array Seg) : Array Seg := Id.run do
  let mut out := segs
  for i in [0 : out.size] do
    let some s := out[i]? | continue
    if Verified.Geo.SegmentMerge.effectiveMode s != "train" then continue
    let some rail := Verified.Geo.RailAbsorbers.parseRailWayName s.wayName | continue
    let some line := rail.line | continue
    let some last := (e.rawFixes.filter (·.ts ≤ s.endTs)).back? | continue
    let after := e.rawFixes.filter (·.ts > s.endTs)
    let same := fun (f : CoarseFix) =>
      Verified.Hsmm.FloatScore.haversineMeters f.lat f.lon last.lat last.lon ≤ ALIGHT_HOLD_RADIUS_M
    let some k := after.findIdx? (!same ·) | continue
    let some fresh := after[k]? | continue
    let heldTo := if k == 0 then last.ts else (after[k - 1]?.map (·.ts)).getD last.ts
    if heldTo - last.ts < ALIGHT_HOLD_MIN_S then continue
    let dist := fun (st : LineStation) =>
      Verified.Hsmm.FloatScore.haversineMeters fresh.lat fresh.lon st.lat st.lon
    let stations := e.stationsOnLine line
    let some labelled := stations.find? (·.name == rail.alight) | continue
    let some nearest := stations.foldl (fun (b : Option LineStation) st =>
      match b with
      | some x => if dist st < dist x then some st else some x
      | none => some st) none | continue
    if nearest.name == rail.alight || dist nearest > ALIGHT_FRESH_MAX_M
        || dist nearest ≥ dist labelled then continue
    let why := s!"alights at {nearest.name}: the last fix was held {heldTo - last.ts} s, the next one {toString (Verified.JsNum.jsRound (dist nearest)).toInt64.toInt} m from it (was {rail.alight})"
    out := out.set! i { s with
      wayName := some s!"{rail.board} → {nearest.name}{Verified.Geo.Worldline.RAIL_LINE_SEP}{line}"
      refinedReason := some (match s.refinedReason with
        | some r => if r == "" then why else s!"{r}; {why}"
        | none => why) }
  return out

/-- How far from its last fix a ride's labelled alight may lie and still be
where it ended: past a dark stretch of tunnel the last fix trails the train. -/
def ALIGHT_FAR_M : Float := 5000
/-- The last fix must be this close to the ride's end to say where it ended. -/
def ALIGHT_LAST_FIX_MAX_S : Int := 120

/-- A ride whose last fix, taken as it ended, is nowhere near its labelled
alight alights at the mainline station nearest that fix. A merge that extends a
train forward keeps the first leg's label: one high-speed train stood 40
minutes at an intermediate station, the legs either side were joined into one
ride, and it read as ending there, 497 km short of the terminus its last fix
sat 239 m from. The line stays only when it serves the new alight. -/
def alightAtLastFix (e : Env) (segs : Array Seg) : Array Seg := Id.run do
  let mut out := segs
  for i in [0 : out.size] do
    let some s := out[i]? | continue
    if Verified.Geo.SegmentMerge.effectiveMode s != "train" then continue
    let some rail := Verified.Geo.RailAbsorbers.parseRailWayName s.wayName | continue
    let some last := (e.points.filter (fun p => p.ts ≥ s.startTs && p.ts ≤ s.endTs)).back? | continue
    if s.endTs - last.ts > ALIGHT_LAST_FIX_MAX_S then continue
    -- Where the label puts the alight: the line's own station, so no new ask.
    let some line := rail.line | continue
    let some labelled := (e.stationsOnLine line).find? (·.name == rail.alight) | continue
    if Verified.Hsmm.FloatScore.haversineMeters last.lat last.lon labelled.lat labelled.lon
        ≤ ALIGHT_FAR_M then continue
    let R := Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M
    let near := (e.nearbyStations last.lat last.lon R).filter fun n =>
      n.distanceM ≤ R && Verified.Geo.TransitPlace.isMainlineNode n
    let some st := (near.insertionSort (·.distanceM < ·.distanceM))[0]? | continue
    if st.name == rail.board then continue
    let line := if (e.stationsOnLine line).any (·.name == st.name) then some line else none
    let why := s!"alights at {st.name}, {toString (Verified.JsNum.jsRound st.distanceM).toInt64.toInt} m from the ride's last fix (was {rail.alight})"
    out := out.set! i { s with
      wayName := some (match line with
        | some l => s!"{rail.board} → {st.name}{Verified.Geo.Worldline.RAIL_LINE_SEP}{l}"
        | none => s!"{rail.board} → {st.name}")
      refinedReason := some (match s.refinedReason with
        | some r => if r == "" then why else s!"{r}; {why}"
        | none => why) }
  return out

/-! ## The passes

Order is execution order. Do not reorder without reading the rationale on the
TS entry — several of these exist only because they run after another. -/

/-- One entry of the cascade: the name the phase timer and the pass trace use,
and the rewrite. Named because a divergence is reported against a pass, and an
index would not survive an insertion. -/
abbrev Pass := String × (Array Seg → Array Seg)

/-- The cascade, in execution order. -/
def passes (e : Env) : Array Pass := #[
  ("stayArrivalClaim", fun segs => FootArrival.claimStayArrivalFromWalk segs e.points),

  -- A stop of a few minutes inside a walk — a shop, a queue — is its own stay
  -- (#1694). After every rail and vehicle carver, so a platform wait is never
  -- taken for one. The remainders keep the walk's name, so the re-enrichment
  -- that follows leaves them alone. Lean-only: the TS had no pass here.
  ("walkDwell", fun segs =>
    Dwell.splitWalksOnDwell segs e.points e.feasSteps e.nameStay),

  -- A walk out of a stay begins at its first stepped minute: a stepless head
  -- is still the stay (07-15, after the hospital). Lean-only.
  ("staySteplessDeparture", fun segs =>
    StepDeparture.claimSteplessDepartures segs e.points e.feasSteps),

  -- Attach the precomputed track geometry to each train run whose route is in
  -- the cache. One indexed lookup, purely additive — the raw track is untouched.
  ("railSnap", fun segs =>
    Verified.Geo.RailReconcile.annotateSnappedPaths segs e.railRouteCache),

  -- A refined-driving leg whose boarding wait and mid-leg dwells coincide with
  -- bus_stop nodes is a bus. After all mode refinement, so it judges the FINAL
  -- driving legs.
  ("busEvidence", fun segs =>
    Verified.Geo.Bus.annotateBusEvidence segs e.geoFixes.toList e.transitStops e.boundarySlackS),

  -- Stronger than the dwell evidence above: anchor a leg's boarding wait (or,
  -- without one, its first fix) and its last fix to a mirrored route's stops
  -- and, on a match, name the bus. Catches short rides with too few dwells to
  -- score — a non-stopping bus can emit nothing else.
  ("busRoutes", fun segs =>
    Verified.Geo.Bus.annotateBusRoutes segs e.geoFixes.toList e.busRouteCache
      (slackS := e.boundarySlackS)),

  -- Snap each road-vehicle leg onto the street network so the map draws it on
  -- the road instead of the raw GPS zigzag through buildings. After all mode
  -- refinement, so it only matches the FINAL road legs. Purely additive: with
  -- no road data it is a no-op and the raw track draws.
  ("roadMatch", fun segs =>
    Verified.Geo.RoadMatchAnnotate.annotateRoadMatches e.roadEnv segs e.points),

  -- The same for walking legs, onto the walkable network, so the map draws the
  -- pavement instead of a line through buildings. Display geometry only —
  -- states unchanged.
  ("walkMatch", fun segs =>
    Verified.Geo.WalkAnnotate.annotateWalkMatches segs e.displayFixes e.speedByTs
      e.walkEnv e.biomSteps e.walkDraw e.walkFlags),

  -- The zone the frontend renders this segment's clock in.
  ("displayTz", fun segs => displayTz e segs),

  -- Final cross-modal enrichment: HR, sleep and step stats per segment. Missing
  -- Fitbit data leaves the enrichment's own fields empty — which is NOT the
  -- same as the field being absent, and the segment record keeps both readings
  -- apart.
  ("biomEnrich", fun segs =>
    segs.map fun s =>
      let bio := Verified.Geo.BiometricWindows.enrichSegmentWithBiometrics
                   s e.hr e.sleep e.biomSteps
      { s with biometrics := some bio }),

  -- The HSMM's place picks override the pipeline's attribution on stays. Falls
  -- back to the pipeline's label when no decode exists — an EMPTY decode is
  -- that "no decode", matching the TS's null test.
  ("hsmmOverride", fun segs =>
    if e.hmmDecode.isEmpty then segs
    else Verified.Geo.PlaceOverride.applyHsmmPlaceOverride segs e.hmmDecode e.hsmmPlaces),

  -- A stay at a station bracketed by trains on BOTH sides is a change of
  -- trains, not a venue visit — name it the station so a co-located shop cannot
  -- surface as a destination.
  -- The waits before a train are at the station; first, so a change of trains
  -- is named for the train it waits for, as his rows write one.
  ("boardingStayLabel", fun segs => boardingStayLabels e segs),

  -- The first stay after a train is at the station it alighted at.
  ("alightStayLabel", fun segs => alightStayLabels e segs),
  ("alightAfterHold", fun segs => alightAfterHold e segs),
  ("alightAtLastFix", fun segs => alightAtLastFix e segs),

  -- The track again, for each run's FINAL label: the passes since `railSnap`
  -- can relabel a ride, and the early track stays on it otherwise.
  ("railSnapFinal", fun segs =>
    Verified.Geo.RailReconcile.reattachSnappedPaths segs e.railRouteCache),

  -- LAST. `driving` is this cascade's placeholder for "a vehicle-speed run
  -- nobody has identified yet"; the rail and bus passes have now all had their
  -- chance to claim it, so a placeholder still wearing the name of a car must
  -- justify it with road evidence or be demoted to an honest `vehicle`.
  ("vehicleIdentity", fun segs => Verified.Geo.SegmentPasses.resolveVehicleIdentity segs)
]

/-- Run a pass array in order, with each pass's output traced. The day fold
runs its passes through this (`DayEntry.dayResult`), with the names and timing
it wraps them in. -/
def runPassArrayTraced (ps : Array Pass) (segs : Array Seg) :
    Array Seg × Array (String × Array Seg) :=
  ps.foldl (fun (acc, trace) (name, run) =>
    let next := run acc
    (next, trace.push (name, next))) (segs, #[])

/-- The pass names, in order. -/
def passNames (e : Env) : Array String := (passes e).map (·.1)

/-- An environment with no lookups: the guards below add what each needs. -/
private def NO_LOOKUPS : Env :=
  { points := #[], rawFixes := #[], steps := #[], railStops := #[]
    nearbyStations := fun _ _ _ => #[], linesAtPoint := fun _ _ _ => #[]
    nearbyWays := fun _ _ => #[]
    bestPlace := fun _ _ _ _ _ => none, tzAt := fun _ _ => "Europe/London" }

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320

/-! ## Every wired pass, demonstrably doing something

The guards above pin WHICH passes run and in WHAT ORDER, and mutation testing
says they do that well: moving a pass out of its TS slot fails, deleting one
fails. It also says what they do NOT cover. Of eleven wiring mutations put to
them, NINE were silent — `fun segs => segs` in any of the tranche's entries
passed every guard, as did feeding a pass an empty fix array, and as did a
fabricated radius. An order guard cannot see whether an entry is CONNECTED:
wrong function, wrong argument, and no function at all all read the same to it.

So each pass gets a day it demonstrably rewrites. This is a REACHABILITY check,
not a parity check — what a pass decides is pinned in the module that decides
it, and restating that here would be transcription rather than a second check.
What is checked here is the thing only this module can get wrong: that the
fold reaches the pass, with inputs it can act on.

A pass with no witness is named in `unwitnessed` rather than left to be inferred
from a count, and the two lists must partition the wired set — so a pass added
without a witness cannot slip in as covered. -/

section Witnesses

open Verified.Geo.SegmentMerge (Seg)

/-- A day that walks, rides, then walks: 4 km/h for 50 min, 45 km/h for 50 min,
4 km/h for 50 min, one fix a minute. The kinematics the boundary passes look
for, in one track. -/
private def mixedTrack : Array Shed.PointF := Id.run do
  let mut out : Array Shed.PointF := #[]
  let mut d : Float := 0
  for k in [0:151] do
    let fast := k ≥ 50 && k < 100
    out := out.push { ts := 60 * Int.ofNat k, lat := lat0 + d * mlat, lon := lon0
                      speedKmh := if fast then 45 else 4 }
    d := d + (if fast then 750 else 66)
  return out

private def cadence : Array StepPoint :=
  (Array.range 151).map fun k => { ts := 60 * Int.ofNat k, steps := 100 }

/-- Two stations, S and T, either side of the ride. The 22 km bar sits inside
the fast stretch, so a leg spanning it boards at one and alights at the other —
which is what the station-pair passes need to have anything to say. -/
private def stationsAt : Float → Float → Float → Array Verified.Geo.TubeHop.NearbyStation :=
  fun lat lon _ =>
    #[{ name := (if lat < lat0 + 22000 * mlat then "S" else "T")
        distanceM := 40, lat := some lat, lon := some lon }]

private def lineStations : Array LineStation :=
  #[⟨"S", lat0 + 3300 * mlat, lon0⟩, ⟨"M", lat0 + 22000 * mlat, lon0⟩,
    ⟨"T", lat0 + 40800 * mlat, lon0⟩]

private def busRoute : Verified.Geo.Bus.BusRoute :=
  { routeRef := "18", routeName := some "Euston", osmRelationId := 1
    stops := (lineStations.mapIdx fun i s =>
      { name := some s.name, lat := s.lat, lon := s.lon, seq := Int.ofNat i + 1 }).toList }

private def withTrack (pts : Array Shed.PointF) (steps : Array StepPoint) : Env :=
  { NO_LOOKUPS with
    points := pts
    steps := steps
    nearbyStations := stationsAt
    -- RADIUS-SENSITIVE on purpose. A lookup that ignores its radius makes the
    -- constant the caller passes unfalsifiable: `LINES_AT_POINT_DEFAULT_RADIUS_M`
    -- could be anything, including the fabricated `0` this fold nearly shipped.
    -- Answering only for a real radius puts that constant inside the guards.
    linesAtPoint := fun _ _ r => if r ≥ 50 then #["Metropolitan"] else #[]
    -- DIFFERENT from `homeTz`, on purpose: with both answering London a
    -- `displayTz` that never looked anything up would be indistinguishable from
    -- one that did, and the fallback branch would be untestable.
    tzAt := fun _ _ => "Europe/Amsterdam"
    stationsOnLine := fun _ => lineStations
    railRouteCache := #[⟨"A → B", #[⟨lat0, lon0⟩, ⟨lat0 + 1000 * mlat, lon0⟩]⟩]
    busRouteCache := [busRoute]
    transitStops := fun _ _ _ => #[{ subtype := "bus_stop", distanceM := 10 }]
    hmmDecode := #[{ startTs := 0, endTs := 600, mode := "stationary", placeId := some 7 }]
    hsmmPlaces := [(7, { displayName := some "The Office", lat := some lat0, lon := some lon0 })]
    knownPlaces := #[⟨7, lat0, lon0⟩]
    hr := [{ ts := 60, bpm := 60 }, { ts := 120, bpm := 80 }] }

private def MIX : Env := withTrack mixedTrack cadence

private def tr (a b : Int) (way : Option String) : Seg :=
  { startTs := a, endTs := b, mode := "train", wayName := way, pointCount := 50, maxSpeed := 50 }
private def wk (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "walking", linearity := 0.8, pointCount := 50, avgSpeed := 4 }
private def dr (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "driving", refinedMode := some "driving"
    avgSpeed := 45, maxSpeed := 60, pointCount := 50 }
private def st (a b : Int) (place : Option String := none) : Seg :=
  { startTs := a, endTs := b, mode := "stationary", linearity := 0.2, pointCount := 50, place }

/-- Run one named pass. A pass that has vanished returns its input, so `fires`
below reads `false` and the guards catch a deletion. -/
private def runNamed (e : Env) (name : String) (day : Array Seg) : Array Seg :=
  match (passes e).find? (·.1 == name) with
  | some p => p.2 day
  | none => day

/-- Does the named pass rewrite this day? -/
private def fires (e : Env) (name : String) (day : Array Seg) : Bool :=
  runNamed e name day != day

-- A day ending on a ride nobody placed: `driving` is a claim, `vehicle` is not.
#guard fires MIX "vehicleIdentity" #[st 0 600, dr 600 1200]

-- A train run whose route is in the cache gets the track drawn on it.
#guard fires MIX "railSnap" #[tr 1000 2000 (some "A → B")]
-- A run relabelled after the early attach loses the old route's track.
#guard fires MIX "railSnapFinal" #[{ tr 1000 2000 (some "A → C") with
  snappedPath := some #[⟨0, 0, 1000⟩, ⟨0, 1, 2000⟩] }]
-- Any segment a fix covers gets a zone. `tzAt` answers Amsterdam and `homeTz`
-- is London, so a pass that fell back instead of looking up would still differ
-- from the input and pass here — what pins the BRANCH is the pair of guards on
-- `displayTz` itself, below.
#guard fires MIX "displayTz" #[wk 0 3000]
-- Every segment leaves with an enrichment attached. Asserting only that the
-- field went from `none` to `some` would be satisfied by a pass that attached a
-- DEFAULT, so the mean of the two in-window samples is what is checked.
#guard fires MIX "biomEnrich" #[wk 0 3000]
#guard ((runNamed MIX "biomEnrich" #[wk 0 3000])[0]!.biometrics.map (·.hrMean)) == some (some 70)
-- …and a window the samples miss gets an enrichment whose HR fields are empty,
-- which is a different thing from no enrichment at all.
#guard ((runNamed MIX "biomEnrich" #[wk 6000 9000])[0]!.biometrics.map (·.hrMean)) == some none
-- The step total too, which is what pins `biomSteps` — the HR guards above are
-- blind to it, and a projection that handed the pass no rows would pass them.
-- 51 minutes at 100 spm, inclusive both ends.
#guard ((runNamed MIX "biomEnrich" #[wk 0 3000])[0]!.biometrics.map (·.stepsTotal))
  == some (some 5100)

-- A decode with a place pick overrides the pipeline's attribution.
#guard fires MIX "hsmmOverride" #[st 0 600, wk 600 1200]
-- The first stay after a train is at the station its label alighted at: a
-- change of trains, a wait however long, and across the walk up from the
-- platform (05-22's ambulance wait at Finchley Road); for the label's own
-- station, not the nearest; and not after a stay, nor without a train.
#guard fires MIX "alightStayLabel" #[tr 0 600 (some "A → S"), st 600 900, tr 900 1500 (some "S → T")]
#guard fires MIX "alightStayLabel" #[tr 0 600 (some "A → S"), st 600 1800, dr 1800 2400]
#guard (runNamed MIX "alightStayLabel" #[tr 0 600 (some "A → S"), wk 600 720, st 720 1800, dr 1800 2400])[2]!.place
  == some "S"
#guard (runNamed MIX "alightStayLabel" #[tr 0 600 (some "A → S"), st 600 900, wk 900 1000, st 1000 1800])[3]!.place
  == none
#guard !(fires MIX "alightStayLabel" #[tr 0 600 (some "A → X"), st 600 1800, dr 1800 2400])
#guard !(fires MIX "alightStayLabel" #[tr 0 600 (some "Metropolitan Line"), st 600 1800])
#guard !(fires MIX "alightStayLabel" #[wk 0 600, st 600 1800, dr 1800 2400])
-- A stay the decoder named (a place and no source) keeps its name, and so does
-- one the picker named from the stay's own fixes; a name by rank alone yields.
#guard !(fires MIX "alightStayLabel" #[tr 0 600 (some "A → S"), st 600 1800 (some "T")])
#guard !(fires MIX "alightStayLabel"
  #[tr 0 600 (some "A → S"), { st 600 1800 (some "T") with placeSource := some ⟨"T", "nearField", none⟩ }])
#guard (runNamed MIX "alightStayLabel"
  #[tr 0 600 (some "A → S"), { st 600 1800 (some "T") with placeSource := some ⟨"T", "ranked", none⟩ }])[1]!.place
  == some "S"
-- The waits that lead to a train are at its station, across a short walk too;
-- a stay longer than any wait for a train is somewhere he went.
#guard fires MIX "boardingStayLabel" #[st 0 600, wk 600 900, st 900 1500, tr 1500 3000 (some "S → T")]
#guard (runNamed MIX "boardingStayLabel" #[st 0 600, wk 600 900, st 900 1500, tr 1500 3000 (some "S → T")]).all
  fun s => s.mode != "stationary" || s.placeSource.any (·.rule == "station")
#guard !(fires MIX "boardingStayLabel" #[st 0 7200, tr 7200 9000 (some "S → T")])
#guard !(fires MIX "boardingStayLabel" #[tr 0 600 (some "A → S"), st 600 900])
/-! ### `displayTz`, whose branches nothing else owns

The other entries call a function some module pins. This one and
`alightStayLabel` are written here, so their behaviour is pinned here too —
a witness that they merely change something would leave the choice of
coordinate, and the fallback, untested. -/

-- A segment no fix covers takes `homeTz`, not a looked-up zone.
#guard (displayTz MIX #[wk 100000 200000])[0]!.displayTz == some "Europe/London"
-- One a fix covers takes the lookup's answer.
#guard (displayTz MIX #[wk 0 3000])[0]!.displayTz == some "Europe/Amsterdam"
-- Stationary reads the CENTROID, moving the MIDPOINT. The window has to span
-- the pace change for that to be a distinction at all: over a UNIFORM stretch
-- the mean position and the middle sample are the same point, so a pass that
-- used one for both would pass. Across 0-6000 the ride pulls the mean far ahead
-- of the middle sample — centroid ≈ 11.9 km, midpoint 3.3 km — and the lookup
-- below answers by latitude, which makes the choice visible.
private def byLat : Env :=
  { MIX with tzAt := fun lat _ => if lat < lat0 + 7000 * mlat then "south" else "north" }
#guard (displayTz byLat #[{ startTs := 0, endTs := 6000, mode := "stationary" }])[0]!.displayTz
  == some "north"
#guard (displayTz byLat #[{ startTs := 0, endTs := 6000, mode := "walking" }])[0]!.displayTz
  == some "south"

/-- A fix at `metresNorth` of the origin. The boundary passes read TRANSLATION
and PACE out of the track, so a witness for one needs both stated per fix rather
than inferred from the segment. -/
private def fxm (ts : Int) (metresNorth speedKmh : Float) : Shed.PointF :=
  { ts, lat := lat0 + metresNorth * mlat, lon := lon0, speedKmh }

/-- A drive decelerating into its arrival, then a residual parked at the kerb. -/
private def arrivalTrack : Array Shed.PointF :=
  #[fxm 500 (-2000) 40, fxm 700 (-1000) 38, fxm 900 (-200) 30,
    fxm 1000 0 25, fxm 1100 600 22, fxm 1200 1200 21,
    fxm 1300 1210 1, fxm 1400 1215 0.5, fxm 1500 1212 0.4, fxm 1600 1214 0.3,
    fxm 1700 1213 0.2, fxm 1800 1215 0.3, fxm 1900 1212 0.1]

private def ARRIVAL : Env := { NO_LOOKUPS with points := arrivalTrack }

-- `stayArrivalClaim` reads the parked tail as a walker already standing: the
-- trailing still run is 400 s over a 14 m spread, and 200 s of walk is left
-- behind — clearing FOOT_ARRIVAL_MIN_DWELL_S, SPREAD_MAX_M and
-- MIN_WALK_REMAINDER_S respectively.
#guard fires ARRIVAL "stayArrivalClaim" #[wk 1000 1600, st 1600 2200]

-- A walk that stops for five minutes and carries on: north at 1.5 m/s, held
-- within 3 m from 300 to 600, north again. The dwell pass cuts it into
-- walk | stay | walk; with a train beside the walk it would not (its own
-- guards pin that), and nothing else here has a train.
private def dwellTrack : Array Shed.PointF :=
  (Array.range 10).map (fun i => fxm (Int.ofNat i * 30) (Float.ofNat i * 45) 5) ++
  (Array.range 11).map (fun i => fxm (300 + Int.ofNat i * 30) (450 + (if i % 2 == 0 then 0 else 3)) 0.5) ++
  (Array.range 20).map (fun i => fxm (630 + Int.ofNat i * 30) (495 + Float.ofNat i * 45) 5)
private def DWELL : Env := { NO_LOOKUPS with points := dwellTrack }
#guard fires DWELL "walkDwell" #[wk 0 1200]
#guard (runNamed DWELL "walkDwell" #[wk 0 1200]).map (·.mode) == #["walking", "stationary", "walking"]

-- A stay, then a "walk" whose first 300 s have no stepped minute (the stay had
-- step data, 5/min) before 95 steps/min from 1500: the stay runs to 1500.
private def STEPLESS : Env :=
  { NO_LOOKUPS with points := dwellTrack
                    steps := #[{ ts := 1100, steps := 5 }] ++
                      (Array.range 20).map fun k => { ts := 1500 + 60 * Int.ofNat k, steps := 95 } }

#guard (runNamed STEPLESS "staySteplessDeparture" #[st 0 1200, wk 1200 3000]).map (·.startTs) ==
  #[0, 1500]

-- A ride labelled to V whose last fix (at V) is held 300 s, the next fresh fix
-- 100 m from M: it alights at M. Held 120 s, or fresh nearer V, it does not.
private def holdLine : Array LineStation :=
  #[⟨"M", lat0, lon0⟩, ⟨"V", lat0 + 600 * mlat, lon0⟩]
private def heldFixes (holdS : Int) (freshM : Float) : Array CoarseFix :=
  #[⟨1000, lat0 + 600 * mlat, lon0, some 60⟩] ++
  ((Array.range (holdS.toNat / 20)).map fun k => ⟨1000 + 20 * Int.ofNat (k + 1), lat0 + 600 * mlat, lon0, some 80⟩) ++
  #[⟨1000 + holdS + 14, lat0 + freshM * mlat, lon0, some 100⟩]
private def HOLD (holdS : Int) (freshM : Float) : Env :=
  { NO_LOOKUPS with rawFixes := heldFixes holdS freshM, stationsOnLine := fun _ => holdLine }
private def holdRide : Seg := { tr 0 1000 (some "B → V · L") with }
#guard (runNamed (HOLD 300 100) "alightAfterHold" #[holdRide]).map (·.wayName) == #[some "B → M · L"]
#guard !fires (HOLD 120 100) "alightAfterHold" #[holdRide]
#guard !fires (HOLD 300 450) "alightAfterHold" #[holdRide]

-- A ride labelled to V whose last fix, at its end, is 497 km from V and 239 m
-- from a mainline T: it alights at T, and line L, which does not reach T, goes.
-- V within reach, a Métro node, or a last fix long before the end: it does not.
private def lastAt (endFixTs : Int) (stations : Array TubeHop.NearbyStation)
    (vM : Float := 497000) : Env :=
  { NO_LOOKUPS with
    points := #[{ ts := 0, lat := lat0, lon := lon0, speedKmh := 200 },
                { ts := endFixTs, lat := lat0, lon := lon0, speedKmh := 20 }]
    nearbyStations := fun _ _ r => stations.filter (·.distanceM ≤ r)
    stationsOnLine := fun _ => #[⟨"V", lat0 - vM * mlat, lon0⟩] }
private def terminus : TubeHop.NearbyStation := { name := "T", subtype := "rail", distanceM := 239 }
private def longRide : Seg := tr 0 1000 (some "B → V · L")
#guard (runNamed (lastAt 1000 #[terminus]) "alightAtLastFix" #[longRide]).map (·.wayName) == #[some "B → T"]
#guard !fires (lastAt 1000 #[terminus] (vM := 1500)) "alightAtLastFix" #[longRide]
#guard !fires (lastAt 1000 #[{ terminus with subtype := "subway" }]) "alightAtLastFix" #[longRide]
#guard !fires (lastAt 800 #[terminus]) "alightAtLastFix" #[longRide]

/-- A road-vehicle leg at a bus's average pace. ⚠ `dr` declares 45 km/h and the
matcher reads `seg.avgSpeed`, not the trace — `busSpeedPlausibility` is a sigmoid
about `BUS_SPEED_MID_KMH = 38`, so 45 scores 0.24 against a 0.6 floor and a `dr`
leg over this same geometry is REFUSED for being too fast to be a bus. That is
the pass working; the leg has to claim a bus's speed because that is the field
the decision is made on. -/
private def bus (a b : Int) : Seg :=
  { startTs := a, endTs := b, mode := "driving", refinedMode := some "driving"
    avgSpeed := 25, maxSpeed := 30, pointCount := 50 }

-- MIX's bus route is not decoration: its three stops sit at 3300 m, 22000 m and
-- 40800 m, exactly where the track's fast stretch starts, halves and ends. So a
-- leg over 3000-6000 boards at S, alights at T and passes M in between — both
-- ends inside BUS_STOP_ANCHOR_M and the one intermediate stop covered.
#guard fires MIX "busRoutes" #[bus 3000 6000]

/-- Metres per degree of longitude at `lat0`. The zigzag below is east-west, so
it needs the longitude scale rather than `mlat`. -/
private def mlon : Float := 1 / (111320 * 0.62241594)

/-- A road running due north, and a track that zigzags 32 m either side of it.

⚠ THE ZIGZAG IS THE WITNESS, not decoration. `matchImprovesDisplay` asks three
things at once — the raw line must be FARTHER than `NEEDS_MATCH_M` = 25 m from
the ways, the matched line must be CLOSER than the raw one, and the matched line
must stay within `MATCH_MAX_STRAY_M` = 40 m of the fixes. 32 m clears the first
and third with room, and snapping to the road answers the second. MIX cannot
witness this pass at any segment: its track is already a straight line, so
nothing can improve on it and the gate refuses every match. -/
private def raggedRoad : Array Shed.PointF :=
  (Array.range 41).map fun k =>
    { ts := 3000 + 30 * Int.ofNat k
      lat := lat0 + (100 * Float.ofNat k) * mlat
      lon := lon0 + (if k % 2 == 0 then 32 else -32) * mlon
      speedKmh := 30 }

private def straightWay : Verified.Geo.OsmCorridor.Way :=
  { osmId := 1, name := some "North Road", subtype := some "residential"
    coords := #[⟨lat0, lon0⟩, ⟨lat0 + 4000 * mlat, lon0⟩] }

/-- The shell answered: the leg's own fixes pulled onto the road's centreline.

⚠ `roadEnv`'s two leaves are FUNCTIONS defaulting to no ways and `none`, so the
pass is a documented no-op on a bare env and no arrangement of fixes alone can
witness it. What this pins is that the fold reaches the pass and writes what its
shell answered — the solver itself lives outside Lean. -/
private def ROADMATCH : Env :=
  { NO_LOOKUPS with
    points := raggedRoad
    roadEnv :=
      { drivableRoads := fun _ _ _ => some #[straightWay]
        matcher := fun pts _ => some (pts.map fun q => { q with lon := lon0 }) } }

#guard fires ROADMATCH "roadMatch" #[dr 3000 4200]

/-- The same ragged track as `PedFix`, which is the series the walk matcher
reads — `displayFixes` is a DIFFERENT series from `points` and defaults empty, so
a walk witness has to supply it explicitly. -/
private def raggedPed : Array Verified.Geo.WalkAnnotate.PedFix :=
  raggedRoad.map fun p => { ts := p.ts, lat := p.lat, lon := p.lon, accuracy := some 8 }

/-- The pedestrian shell answered on the same geometry, for the same reason as
`ROADMATCH`: seven of `walkEnv`'s leaves are functions and all default to
empty/`none`, so the pass is a no-op on a bare env. Only the two OSM reads and
the matcher need answering; the four solver leaves keep their defaults. -/
private def WALKMATCH : Env :=
  { NO_LOOKUPS with
    points := raggedRoad
    displayFixes := raggedPed
    walkEnv :=
      { NO_LOOKUPS.walkEnv with
        walkableRoads := fun _ _ _ =>
          some #[{ osmId := 0, coords := #[⟨lat0, lon0⟩, ⟨lat0 + 4000 * mlat, lon0⟩] }]
        matcher := fun pts _ _ =>
          let snapped := pts.map fun q => { q with lon := lon0 }
          some { path := snapped, coarsePath := snapped } } }

#guard fires WALKMATCH "walkMatch" #[wk 3000 4200]

/-- A standstill at the stop, then a ride at ~40 km/h with two dwells in it —
`Bus`'s own `AnnotateGuards` fixture, in this module's coordinates.

⚠ THE DWELLS ARE THE WHOLE POINT and are why MIX cannot witness this pass: the
scorer reads a BOARDING WAIT before the leg and mid-leg STOPS inside it, and
MIX's track moves at a constant pace from end to end. The standstill before
`startTs` is not padding either — `detectBoardingWait` looks BACKWARD from the
leg start, so a leg that begins at the first moving fix has no wait to find. -/
private def busEvidenceTrack : Array Shed.PointF := Id.run do
  let mut out : Array Shed.PointF := #[]
  for i in [0:10] do
    out := out.push (fxm (Int.ofNat (30 * i)) 0 0)
  let mut m : Float := 0
  for i in [0:31] do
    let t : Int := 300 + Int.ofNat (30 * i)
    let dwelling := (decide (t ≥ 480) && decide (t ≤ 540)) || (decide (t ≥ 780) && decide (t ≤ 840))
    if !dwelling then m := m + 334
    out := out.push (fxm t m (if dwelling then 0 else 40))
  return out

private def BUSEV : Env :=
  { NO_LOOKUPS with
    points := busEvidenceTrack
    transitStops := fun _ _ _ => #[{ subtype := "bus_stop", distanceM := 10 }] }

#guard fires BUSEV "busEvidence" #[bus 300 1200]

-- A tube ride mined out of the walk that swallowed it.

/-- Wired passes with no witness day here: empty, and kept so — `witnessed` is
its complement, and the two lists partition the wired set, so a pass added
without a witness cannot slip in as covered. To witness a new pass, run it
against the existing fixtures first, then lift a fixture from the guards of the
module that owns it.

⚠ `roadMatch` and `walkMatch` are answered by an injected shell, so their
guards show that the fold REACHES the pass and writes what the shell returned;
the solvers live outside Lean and are not under test. -/
def unwitnessed : Array String :=
  #[]

/-- Wired passes with a witness above. -/
def witnessed : Array String :=
  (passNames NO_LOOKUPS).filter fun n => !unwitnessed.contains n

#guard witnessed.size == 17
#guard unwitnessed.all (passNames NO_LOOKUPS).contains
-- The two lists partition the wired set, so a new pass must be classified.
#guard witnessed.size + unwitnessed.size == (passNames NO_LOOKUPS).size

end Witnesses

end Verified.Geo.PassFold
