import Verified.Geo.TubeHop
/-!
# Underground line reconstruction (port of `reconstructUndergroundRun`,
`src/geo/underground-rail.ts`)

When the tube goes deep the phone falls back to the cell network, and the fixes
it reports carry hundred-metre-plus accuracy radii. That is not noise to discard
— their PRESENCE is the underground signal, and their positions still hug the
tunnel well enough to say which line the train was on.

Given the coarse fixes inside a GPS-dark stretch, plus the last well-located fix
before it and the first one after, this decides which single line the journey
followed, or refuses. A candidate must serve BOTH ends AND be hugged by at least
one coarse fix, and among survivors the one the most coarse fixes sit on wins —
so a parallel line that merely connects the endpoints loses to the line the
train actually followed.

The TS is `async` ONLY because its station and line lookups are injected; they
are modelled here as plain functions of a coordinate. That is what makes the
private `isCoarse` predicate reference-testable through this public function
rather than needing a test-only export. (I had recorded this module as needing a
stub OSM *adapter*; that was wrong — the signature takes the lookups directly.)

`reconstructUndergroundJourney` (the two-leg interchange split) and
`annotateUndergroundRuns` (the segment-level orchestration) are the larger
follow-on and stay shell for now.

Exactness: every gate is exact; `equirectMeters` is this module's own metric —
`cos` at the FIRST point, as in `EpisodeGeometry`, NOT `metersBetween`'s
midpoint form — so the journey-length test is ≤ 1 ULP. UNPROVEN; pinned against
Node/V8 (`lean/experiments/underground-run-refs.mts`).
-/

namespace Verified.Geo.UndergroundRun

open Verified.Geo.TubeHop (NearbyStation pickBestStation)

/-- A fix that may or may not be coarse. `accuracy` is `none` when the source
reported none at all. -/
structure CoarseFix where
  ts : Int
  lat : Float
  lon : Float
  accuracy : Option Float := none
  deriving Inhabited, BEq, Repr

structure LatLon where
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- One reconstructed single-line leg. -/
structure UndergroundRun where
  line : String
  boardingStation : String
  alightingStation : String
  startTs : Int
  endTs : Int
  deriving Inhabited, BEq, Repr

/-- Accuracy at or above which a fix is cell-network rather than GPS. -/
def COARSE_ACCURACY_M : Float := 100
/-- …and above which it is total-loss garbage: a kilometre-scale radius that
cannot be snapped to a station. Such a fix still MARKS the dark window (that is
`isUndergroundSignal`'s job, in the segment-level pass), but it cannot locate
anything, so it is excluded here. -/
def COARSE_ACCURACY_MAX_M : Float := 800
/-- Fewer coarse fixes than this is not enough evidence to name a line. -/
def MIN_COARSE_FIXES : Nat := 2
/-- A run must cover a real distance. Coarse fixes clustered at one station — a
platform wait, a same-station interchange — are not a journey. -/
def MIN_JOURNEY_M : Float := 800

/-- A coarse cell-network fix whose coordinate is reliable enough to snap to a
station: accuracy in `[100, 800]`. A `none` accuracy is NOT coarse. -/
def isCoarse (f : CoarseFix) : Bool :=
  f.accuracy.any fun a => a ≥ COARSE_ACCURACY_M && a ≤ COARSE_ACCURACY_MAX_M

private def pi : Float := 3.141592653589793

/-- This module's own metric: equirectangular with `cos` taken at the FIRST
point. The same form as `Verified.Geo.EpisodeGeometry.equirectMeters`, and NOT
`metersBetween`'s midpoint-`cos` + `hypot` — the repo has both and they
disagree.

NO `#guard` CAN CATCH THE DIFFERENCE HERE, and that is not a gap in the guards.
The only thing this module does with the distance is compare it to an 800 m bar,
and at that scale the two `cos` points differ by ~1e-5 m: separating them would
need an input within that of the bar, which is the float-wobble trap. Matching
the TS form anyway, because the choice is load-bearing for other consumers of the
same coordinates and a future caller should not inherit a silent substitution. -/
def equirectMeters (aLat aLon bLat bLon : Float) : Float :=
  let dLat := (bLat - aLat) * 111320.0
  let dLon := (bLon - aLon) * 111320.0 * Float.cos (aLat * pi / 180.0)
  Float.sqrt (dLat * dLat + dLon * dLon)

/-- Identify the underground line of a journey from its coarse fixes.

`fixes` is every fix inside the suspected underground stretch; `boardingFix` and
`alightingFix` are the last well-located fix before it and the first one after.
`none` when the evidence does not single out one line, or when what it describes
is not a journey. -/
def reconstructUndergroundRun (fixes : Array CoarseFix) (boardingFix alightingFix : LatLon)
    (stationsLookup : Float → Float → Array NearbyStation)
    (linesLookup : Float → Float → Array String) : Option UndergroundRun :=
  let coarse := ((fixes.filter isCoarse).toList.mergeSort fun a b => a.ts ≤ b.ts).toArray
  if coarse.size < MIN_COARSE_FIXES then none else
  let boardLines := linesLookup boardingFix.lat boardingFix.lon
  let alightLines := linesLookup alightingFix.lat alightingFix.lon
  if boardLines.isEmpty || alightLines.isEmpty then none else
  -- Lines under each coarse fix — the path the train actually hugged.
  let coarseLineSets := coarse.map fun f => linesLookup f.lat f.lon
  -- A candidate serves both ends AND is hugged by at least one coarse fix.
  -- Scored by how many hug it, so a parallel line that merely connects the
  -- endpoints loses to the one the journey followed.
  let candidates := boardLines.filterMap fun line =>
    if !alightLines.contains line then none
    else
      let onCoarse := coarseLineSets.foldl (fun n s => if s.contains line then n + 1 else n) 0
      if onCoarse > 0 then some (line, onCoarse) else none
  if candidates.isEmpty then none else
  -- Highest count wins; a stable descending sort, so ties keep board-line order.
  let line := ((candidates.toList.mergeSort fun a b => b.2 ≤ a.2).head!).1
  -- `prefer := "subway"`, as `underground-rail.ts:172-173` passes. A shared site
  -- offers a mainline node and a tube node, and a tube ride is named after the
  -- tube one even when the mainline node is nearer. This is the ONLY caller in
  -- the repo that expresses a preference.
  match pickBestStation (stationsLookup boardingFix.lat boardingFix.lon) (some "subway"),
        pickBestStation (stationsLookup alightingFix.lat alightingFix.lon) (some "subway") with
  | some board, some alight =>
    if board.name == alight.name then none
    else if equirectMeters boardingFix.lat boardingFix.lon alightingFix.lat alightingFix.lon < MIN_JOURNEY_M
    then none
    else some { line, boardingStation := board.name, alightingStation := alight.name,
                startTs := coarse[0]!.ts, endTs := coarse[coarse.size - 1]!.ts }
  | _, _ => none

/-! ## Guards (V8 reference values) -/

private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def north (n : Float) : LatLon := ⟨lat0 + n * mlat, lon0⟩
#guard (north 2000).lat == 51.53796622349982

private def fx (ts : Int) (metresNorth : Float) (accuracy : Option Float) : CoarseFix :=
  { ts, lat := (north metresNorth).lat, lon := (north metresNorth).lon, accuracy }

private def BOARD : LatLon := north 0
private def ALIGHT : LatLon := north 2000

private def stn (name : String) (distanceM : Float) : NearbyStation :=
  { name, subtype := "station", distanceM }

/-- Stations split at 400 m — deliberately BELOW the 800 m journey bar, so a
short case still resolves to two distinct stations and the length gate is the
one that decides it. -/
private def stations (lat : Float) (_lon : Float) : Array NearbyStation :=
  if lat < lat0 + 400 * mlat then #[stn "Highbury & Islington" 40] else #[stn "Wembley Park" 60]
private def sameStation (_lat _lon : Float) : Array NearbyStation := #[stn "Highbury & Islington" 40]
private def noStations (_lat _lon : Float) : Array NearbyStation := #[]

private def victoria (_lat _lon : Float) : Array String := #["Victoria Line"]
private def twoAtEnds (lat _lon : Float) : Array String :=
  if lat == BOARD.lat || lat == ALIGHT.lat then #["Victoria Line", "Piccadilly Line"] else #["Victoria Line"]
private def weightedTie (lat _lon : Float) : Array String :=
  if lat == BOARD.lat || lat == ALIGHT.lat then #["Victoria Line", "Piccadilly Line"]
  else if lat == (north 600).lat then #["Piccadilly Line"] else #["Victoria Line"]
private def noCoarseSupport (lat _lon : Float) : Array String :=
  if lat == BOARD.lat || lat == ALIGHT.lat then #["Victoria Line"] else #["Jubilee Line"]
private def disjoint (lat _lon : Float) : Array String :=
  if lat < lat0 + 400 * mlat then #["Victoria Line"] else #["Metropolitan Line"]
private def noLines (_lat _lon : Float) : Array String := #[]

private def COARSE : Array CoarseFix := #[fx 1000 300 (some 200), fx 1100 600 (some 300), fx 1200 1500 (some 250)]

private def RESOLVED : Option UndergroundRun :=
  some { line := "Victoria Line", boardingStation := "Highbury & Islington",
         alightingStation := "Wembley Park", startTs := 1000, endTs := 1200 }

-- The Victoria Line serves both ends and the coarse fixes hug it.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations victoria == RESOLVED
-- Two lines at both ends, only one hugged: the hugged one wins.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations twoAtEnds == RESOLVED
-- Both hugged, but Victoria by two coarse fixes to one — the COUNT decides, so
-- a parallel line the journey merely brushed cannot win.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations weightedTie == RESOLVED
-- The ends share a line but NO coarse fix hugs it: a parallel line that merely
-- connects the endpoints.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations noCoarseSupport == none
-- The ends share nothing; or one end resolves no line at all.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations disjoint == none
#guard reconstructUndergroundRun COARSE BOARD ALIGHT stations noLines == none
-- Fewer than two coarse fixes is not enough evidence.
#guard reconstructUndergroundRun #[fx 1000 300 (some 200)] BOARD ALIGHT stations victoria == none
-- THE ACCURACY BAND, isolated: each of these leaves only ONE fix in the band,
-- so a fix admitted or rejected flips the whole result. 100 m exactly is coarse
-- (`≥`) and 800 m exactly is coarse (`≤`); 99 is a good GPS fix and 801 is
-- total-loss garbage that cannot locate anything.
#guard reconstructUndergroundRun #[fx 1000 300 (some 99), fx 1100 600 (some 300)] BOARD ALIGHT stations victoria
  == none
#guard (reconstructUndergroundRun #[fx 1000 300 (some 100), fx 1100 600 (some 300)] BOARD ALIGHT
    stations victoria).map (·.endTs) == some 1100
#guard (reconstructUndergroundRun #[fx 1000 300 (some 800), fx 1100 600 (some 300)] BOARD ALIGHT
    stations victoria).map (·.endTs) == some 1100
#guard reconstructUndergroundRun #[fx 1000 300 (some 801), fx 1100 600 (some 300)] BOARD ALIGHT stations victoria
  == none
-- A missing accuracy is NOT coarse.
#guard reconstructUndergroundRun #[fx 1000 300 none, fx 1100 600 (some 300)] BOARD ALIGHT stations victoria == none
-- Both ends at the SAME station is a platform wait, not a journey; and a end
-- with no station at all cannot anchor one.
#guard reconstructUndergroundRun COARSE BOARD ALIGHT sameStation victoria == none
#guard reconstructUndergroundRun COARSE BOARD ALIGHT noStations victoria == none
-- The JOURNEY-LENGTH bar, from either side. A pair rather than a point ON the
-- bar: the frame's 800 m round-trips through `equirectMeters` a hair short, so
-- an exactly-at-the-bar case would test the float wobble, not the constant.
#guard reconstructUndergroundRun COARSE BOARD (north 790) stations victoria == none
#guard (reconstructUndergroundRun COARSE BOARD (north 810) stations victoria).map (·.alightingStation)
  == some "Wembley Park"
-- The span comes from the SORTED coarse fixes, so input order is irrelevant.
#guard reconstructUndergroundRun
  #[fx 1200 1500 (some 250), fx 1000 300 (some 200), fx 1100 600 (some 300)] BOARD ALIGHT stations victoria
  == RESOLVED
#guard reconstructUndergroundRun #[] BOARD ALIGHT stations victoria == none

end Verified.Geo.UndergroundRun
