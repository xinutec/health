import Verified.Geo.PathPoint
import Verified.Hsmm.FloatScore
import Verified.JsNum
import Verified.FloatConst
import Verified.Fix
import Verified.PlaceSource
/-!
# The segment record, and the list rewrites the tail shares

`Seg` is the record every pass reads and rewrites. Beside it:

* `composeWayName` — a way label composed from each contributor's duration;
* `samePlace` — two stays are one visit when they carry the same name;
* `absorbMoveInsidePlace` — a moving run between two stays at one place that
  never left it is that stay.

`haversineMeters` (atan2) is ≤ 1 ULP; everything else is exact. UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Geo.SegmentMerge

open Verified.Hsmm.FloatScore (haversineMeters)

abbrev Mode := String

open Verified.JsNum (jsRound)

/-- Per-segment HR, sleep and step aggregates (`enrichSegmentWithBiometrics`),
declared beside `Seg` because the record carries one and must import nothing. -/
structure BiometricEnrichment where
  hrMean : Option Float
  hrMin : Option Float
  hrMax : Option Float
  hrStd : Option Float
  /-- HR samples that fell inside the segment window. -/
  sampleCount : Nat
  overlapsSleep : Bool
  /-- Fraction of segment duration covered by sleep records (0–1). -/
  sleepFraction : Float
  /-- Total steps inside the segment; `none` when no step rows touched the
      window's DAY — distinct from zero steps actively recorded. -/
  stepsTotal : Option Float
  deriving Inhabited, BEq, Repr

/-- The segment fields these passes read and rewrite, wider than
`Verified.Geo.SegmentPasses.Seg`: merges carry the weighted numbers, stay passes
the centroid and focus id (`Int`, only compared). -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  confidence : Float := 0.8
  confidenceMargin : Float := 2
  avgSpeed : Float := 0
  maxSpeed : Float := 0
  linearity : Float := 0.5
  pointCount : Int := 10
  place : Option String := none
  /-- Which rule named the stay, the name it named, and where it asked. -/
  placeSource : Option Verified.PlaceSource := none
  /-- The OSM key and value of the feature that named the stay, e.g.
      `("railway", "train_station")`, so a later pass knows what enclosed it
      without a second ask, which a golden fixture could not answer. -/
  placeKind : Option (String × String) := none
  /-- `ResolvedPlace.share` of the name in `placeSource`. -/
  placeShare : Option Float := none
  city : Option String := none
  wayName : Option String := none
  refinedReason : Option String := none
  refinedKinds : Array String := #[]
  centroidLat : Option Float := none
  centroidLon : Option Float := none
  focusPlaceId : Option Int := none
  /-- Whether `linearity` means anything here: did the segment move farther than
  its own GPS error (`WindowFeatures.directionResolvable`)? Defaults to `true`:
  no reported accuracy is no reason to doubt the direction. -/
  directionResolvable : Bool := true
  /-- Set by the stay-split rebuilds (`Verified.Geo.StaySplit`) when a segment's
  window changed and its inherited enrichment is therefore no longer evidence
  about it. The `reenrichSplitWalks` pass sends these back through OSM naming. -/
  needsReenrich : Bool := false
  /-- Re-derive the road name from the segment's own geometry, leaving its mode:
  set by `claimStayArrivalFromWalk`, whose carve changes the window but not what
  the walk is. -/
  needsRename : Bool := false
  /-- The bus passes' verdict on a road-vehicle leg's kind. It takes precedence
  over `refinedMode` in the day state, so a pass promoting a leg to `train` must
  clear it (`Verified.Geo.PlaceOverride` does). -/
  vehicleKind : Option String := none
  /-- The share of the leg's samples nearer a drivable road than any rail,
  weighed against the HSMM's line support in `decideHsmmTrainOverride`. `none`
  (no samples, an underground gap) cannot contradict. -/
  roadCorridorFraction : Option Float := none
  /-- The IANA zone the frontend renders this segment's clock times in, rather
  than the browser's. Written by the `displayTz` pass, which stays shell: the
  lookup is tzdata, not arithmetic. -/
  displayTz : Option String := none
  /-- This train leg drawn on the OSM rail track (`annotateSnappedPaths`). -/
  snappedPath : Option (Array PathPt) := none
  /-- This road-vehicle leg drawn on the street network (`annotateRoadMatches`).
  `none` when the leg could not be confidently matched, which is the map's
  signal to fall back to the raw track — distinct from an empty path. -/
  matchedPath : Option (Array PathPt) := none
  /-- This walking leg drawn on the walkable network (`annotateWalkMatches`). -/
  walkMatchedPath : Option (Array PathPt) := none
  /-- This walking leg drawn by the map reconstruction instead of the matcher,
  attached only where the reconstruction is substantially shorter. Takes
  precedence over `walkMatchedPath` when present. -/
  walkSmoothedPath : Option (Array PathPt) := none
  /-- The time spans over which this walking leg's drawn line is backed by
  neither a mapped way nor a sharp fix (`WalkBacked.unbackedSpans`): drawn
  dashed. -/
  walkUnbacked : Array (Float × Float) := #[]
  /-- Whether the walk annotation had building outlines: `some true` when
  `buildingsNear` answered (maybe with none), `some false` when declined, `none`
  when not asked. The wall metric means something only for `some true`. -/
  walkBuildingsMeasured : Option Bool := none
  /-- HR, sleep and step aggregates over this segment's window, attached by the
  `biomEnrich` pass. `none` until it runs — distinct from an enrichment whose
  own fields are empty because Fitbit had nothing for the day. -/
  biometrics : Option BiometricEnrichment := none
  /-- A debug surface nothing reads: the walk matcher's identity report, named
  ways longest first.

  ⚠ The unit is the matcher's own, not metres (see `MatchOut.wayUm`): read
  these as shares.

  Ungated and wider than `wayName`, so it can show a route riding the wrong way
  on a leg that kept its cascade name. -/
  walkWayUm : Array (String × Nat) := #[]
  /-- Every road a moving leg was on, longest first (`Enrich.roadsByTime`);
  `wayName` is the label composed from the first three. Empty where nothing
  wrote it. -/
  roads : Array String := #[]
  deriving Inhabited, BEq, Repr

/-- A per-minute step count. -/
structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited, BEq, Repr

/-- `refinedMode ?? mode`. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `composeWayName` -/

def WAY_LABEL_MAX_CHARS : Nat := 30
def WAY_LABEL_MIN_COVERAGE : Float := 0.15
def WAY_LABEL_MAX_NAMES : Nat := 3

/-- Compose a way label from per-name durations: longest first (stable, so
ties keep insertion order), those covering 15% or more, at most three, joined
while the label stays within 30 characters. The join stops at the first
overflow, so a short fourth name never slips in. `none` when nothing survives
or the durations total zero. Lengths count codepoints, so a non-BMP name would
budget differently from UTF-16. -/
def composeWayName (contribs : Array (String × Float)) : Option String :=
  let total := contribs.foldl (fun acc c => acc + c.2) 0
  if total == 0 then none else
  let ranked := ((contribs.toList.mergeSort fun a b => b.2 ≤ a.2).filter
      (fun c => c.2 / total ≥ WAY_LABEL_MIN_COVERAGE)).take WAY_LABEL_MAX_NAMES
      |>.map (·.1)
  match ranked with
  | [] => none
  | first :: rest =>
    some (rest.foldl (fun (st : String × Bool) name =>
      if !st.2 then st
      else
        let tentative := s!"{st.1}, {name}"
        if tentative.length > WAY_LABEL_MAX_CHARS then (st.1, false) else (tentative, true))
      (first, true)).1

/-! ## `samePlace` -/

/-- Two stays are at the same place when they carry the same non-empty name.
Not the same mined place: a cluster is wider than a venue (two shops 57 m apart
share one), and merging them lost a confirmed row. -/
def samePlace (a b : Seg) : Bool :=
  a.place.any (· != "") && a.place == b.place

/-! ## `absorbMoveInsidePlace` -/

/-- A fix with its reported accuracy in metres (`0` where none was reported:
no allowance). -/
structure AccFix where
  ts : Int
  lat : Float
  lon : Float
  acc : Float := 0
  deriving Inhabited, BEq, Repr

/-- The last stretch of each stay beside the run the visit's recent extent is
read from. -/
def EXTENT_WINDOW_S : Int := 3600
/-- Too few of the stays' fixes to read an extent from: nothing is absorbed. -/
def EXTENT_MIN_FIXES : Nat := 5
/-- The share of the stays' fixes the extent holds: far strays are ~2% of a
stay's fixes and a second spot ~14% (`docs/proposals/2026-11-stay-position.md`),
so the 95th percentile keeps the spots and drops the strays. -/
def EXTENT_SHARE : Float := 0.95

/-- The median, as `quantile` reads it. -/
private def MEDIAN : Float := 0.5

/-- The `q`-quantile of `xs` (the element at `⌊q·n⌋`, the last at most). -/
private def quantile (xs : Array Float) (q : Float) : Float :=
  let ys := xs.qsort (· < ·)
  if ys.isEmpty then 0 else
  ys[min (ys.size - 1) (q * Verified.FloatConst.natToFloat ys.size).toUInt64.toNat]!

/-- A run of moving segments between two stays at one place is that stay when it
never left: it has no fix (a dark stretch labelled by its steps), or every fix
lies inside the place as the stays' own fixes show it (within `EXTENT_SHARE` of
their distances from the median, plus each fix's accuracy). Steps and a few
tens of metres inside a building are moving about in the place. -/
def absorbMoveInsidePlace (segments : Array Seg) (fixes : Array AccFix) : Array Seg := Id.run do
  let mut out := segments
  let mut i := 0
  while i < out.size do
    let seg := out[i]!
    if effectiveMode seg == "stationary" then
      i := i + 1
      continue
    -- The run of moving segments from `i`.
    let mut j := i
    while j < out.size && effectiveMode out[j]! != "stationary" do
      j := j + 1
    let verdict : Option String := match out[i - 1]?, out[j]? with
      | some prev, some next =>
        if !(i > 0 && effectiveMode prev == "stationary" && samePlace prev next) then none else
        let run := fixes.filter fun f => f.ts ≥ seg.startTs && f.ts < next.startTs
        if run.isEmpty then some "no fix between two stays at" else
        -- Inside the visit as its last hour either side shows it, or as both
        -- whole stays do: a hospital visit spans buildings, and a quiet evening
        -- at home keeps its arrival's fixes.
        let insideOf := fun (own : Array AccFix) =>
          if own.size < EXTENT_MIN_FIXES then false else
          let cLat := quantile (own.map (·.lat)) MEDIAN
          let cLon := quantile (own.map (·.lon)) MEDIAN
          let extent := quantile (own.map fun f => haversineMeters cLat cLon f.lat f.lon) EXTENT_SHARE
          run.all fun f => haversineMeters cLat cLon f.lat f.lon - f.acc ≤ extent
        let recent := fixes.filter fun f =>
          (f.ts ≥ max prev.startTs (prev.endTs - EXTENT_WINDOW_S) && f.ts < prev.endTs)
            || (f.ts ≥ next.startTs && f.ts < min next.endTs (next.startTs + EXTENT_WINDOW_S))
        let whole := fixes.filter fun f =>
          (f.ts ≥ prev.startTs && f.ts < prev.endTs) || (f.ts ≥ next.startTs && f.ts < next.endTs)
        if insideOf recent || insideOf whole then some "every fix inside" else none
      | _, _ => none
    if let some why := verdict then
      let prev := out[i - 1]!
      let reason := s!"{why} {prev.place.getD ""} — the place was not left"
      for k in [i : j] do
        let w := out[k]!
        out := out.set! k { w with
          refinedMode := some "stationary"
          place := prev.place
          placeSource := prev.placeSource
          city := prev.city
          wayName := none
          centroidLat := prev.centroidLat
          centroidLon := prev.centroidLon
          refinedReason := some (match w.refinedReason with
            | some r => if r == "" then reason else s!"{r}; {reason}"
            | none => reason) }
    i := j
  return out

-- An office morning and afternoon around a three-minute walk: the stays' fixes
-- within ~10 m of the desk, one in ten at a second spot 40 m off.
private def DESK_LAT : Float := 51.5
private def DESK_LON : Float := -0.1
private def SECOND_SPOT : Float := 0.00036
private def JITTER : Float := 0.00001
private def STAY_ACC : Float := 5
private def officeStays : Array AccFix := Id.run do
  let mut out := #[]
  for k in [0:60] do
    let off := if k % 10 == 0 then SECOND_SPOT else JITTER * Verified.FloatConst.natToFloat (k % 7)
    out := out.push { ts := k * 60, lat := DESK_LAT + off, lon := DESK_LON, acc := STAY_ACC }
    out := out.push { ts := 3780 + k * 60, lat := DESK_LAT + off, lon := DESK_LON, acc := STAY_ACC }
  return out
private def walkOut : Array Seg :=
  #[{ startTs := 0, endTs := 3600, mode := "stationary", place := some "Work" },
    { startTs := 3600, endTs := 3780, mode := "walking" },
    { startTs := 3780, endTs := 7380, mode := "stationary", place := some "Work" }]
private def runFixes (dLat : Float) : Array AccFix :=
  #[{ ts := 3620, lat := DESK_LAT + dLat, lon := DESK_LON, acc := 10 },
    { ts := 3700, lat := DESK_LAT + dLat, lon := DESK_LON, acc := 10 }]
-- Dark: the stay.
#guard effectiveMode (absorbMoveInsidePlace walkOut officeStays)[1]! == "stationary"
-- 30 m from the desk, inside the second spot's reach: the stay.
#guard effectiveMode (absorbMoveInsidePlace walkOut (officeStays ++ runFixes 0.00027))[1]! == "stationary"
-- 300 m away: he left; the walk stands.
#guard effectiveMode (absorbMoveInsidePlace walkOut (officeStays ++ runFixes 0.0027))[1]! == "walking"
-- Two different places either side: the walk stands, inside or not.
#guard effectiveMode (absorbMoveInsidePlace (walkOut.set! 2 { walkOut[2]! with place := some "Home" })
  (officeStays ++ runFixes 0.00027))[1]! == "walking"

/-! ## `mergePausesInWalks` -/

/-- The longest still stretch between two walks that is a pause, not a stop:
the shortest narrated stop between walks is 3 minutes. -/
def PAUSE_MAX_S : Int := 120

/-- A still stretch of at most `PAUSE_MAX_S` between two walks is part of one
walk with them (the user's rule: a pause at a crossing is not a stay). The three
become one walk, named from all its fixes. -/
def mergePausesInWalks (segments : Array Seg) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  let mut i := 0
  while i < segments.size do
    let seg := segments[i]!
    match out.back?, segments[i + 1]? with
    | some prev, some next =>
      if effectiveMode seg == "stationary" && seg.endTs - seg.startTs ≤ PAUSE_MAX_S
          && effectiveMode prev == "walking" && effectiveMode next == "walking"
          && prev.endTs == seg.startTs && seg.endTs == next.startTs then
        let reason := s!"a pause of {seg.endTs - seg.startTs} s in a walk"
        out := out.pop.push { prev with
          endTs := next.endTs
          wayName := none
          roads := #[]
          refinedReason := some (match prev.refinedReason with
            | some r => if r == "" then reason else s!"{r}; {reason}"
            | none => reason) }
        i := i + 2
      else
        out := out.push seg
        i := i + 1
    | _, _ =>
      out := out.push seg
      i := i + 1
  return out

private def walkSeg (a b : Int) : Seg := { startTs := a, endTs := b, mode := "walking" }
private def stillSeg (a b : Int) : Seg := { startTs := a, endTs := b, mode := "stationary", place := some "JFS" }
-- Two minutes still between two walks: one walk.
#guard (mergePausesInWalks #[walkSeg 0 600, stillSeg 600 720, walkSeg 720 1200]).map (fun s => (s.startTs, s.endTs, s.mode))
  == #[(0, 1200, "walking")]
-- Three minutes: a stop, kept.
#guard (mergePausesInWalks #[walkSeg 0 600, stillSeg 600 780, walkSeg 780 1200]).size == 3
-- Two pauses in one walk: one walk.
#guard (mergePausesInWalks #[walkSeg 0 600, stillSeg 600 660, walkSeg 660 900, stillSeg 900 960, walkSeg 960 1200]).size == 1
-- Still between a walk and a train: a wait, kept.
#guard (mergePausesInWalks #[walkSeg 0 600, stillSeg 600 660, { walkSeg 660 900 with mode := "train" }]).size == 3

/-- A mined place's id and centre, as the fold's `Env` carries it. -/
structure KnownPlaceProjection where
  id : Int
  centroidLat : Float
  centroidLon : Float
  deriving Inhabited, BEq, Repr

/-! ## Guards -/

open Verified.FloatConst (pi)

/-! ### `composeWayName` -/

private def cw (xs : List (String × Float)) : Option String := composeWayName xs.toArray

#guard cw [("Euston Road", 600)] == some "Euston Road"
-- Both over the coverage floor and inside the 30-char budget.
#guard cw [("Gower St", 600), ("Store St", 300)] == some "Gower St, Store St"
-- The join breaks on overflow rather than skipping: a shorter third-ranked name
-- never sneaks in behind a long second.
#guard cw [("Tottenham Court Road", 600), ("Great Russell Street", 500), ("Bury Pl", 400)]
  == some "Tottenham Court Road"
-- Ranked by duration DESC, so insertion order is irrelevant.
#guard cw [("B St", 100), ("A St", 900)] == some "A St"
-- Under 15% coverage: dropped even though it is a real contributor…
#guard cw [("Main St", 900), ("Alley", 100)] == some "Main St"
-- …and exactly at the floor it survives.
#guard cw [("Main St", 850), ("Alley", 150)] == some "Main St, Alley"
-- At most three names, and the cap is what excludes the fourth: all four clear
-- the coverage floor here, so nothing else can be doing it.
#guard cw [("A", 250), ("B", 250), ("C", 250), ("D", 250)] == some "A, B, C"
-- The char budget from both sides: a 30-character join is accepted (`> 30`
-- rejects), 31 breaks and leaves the leader alone.
#guard cw [("Abbey Road", 600), ("Seventeen Chars Xx", 500)] == some "Abbey Road, Seventeen Chars Xx"
#guard cw [("Abbey Road", 600), ("Nineteen Chars Xxxx", 500)] == some "Abbey Road"
-- A zero total is its own arm, distinct from an empty map.
#guard cw [("Nowhere", 0)] == none
#guard cw [] == none

/-- A segment carrying the structure's field defaults. `default` (from
`Inhabited`) does not: it zeroes every field, so a guard built on it silently
merges point counts of 0. -/
private def blank : Seg := { startTs := 0, endTs := 0, mode := "" }

/-! ### `samePlace` -/

private def named (n : String) (id : Option Int := none) : Seg :=
  { blank with mode := "stationary", place := some n, focusPlaceId := id }
-- The same name is the same place, with or without an election.
#guard samePlace (named "Costa") (named "Costa") == true
#guard samePlace (named "Costa" (some 3)) (named "Costa" (some 4)) == true
-- The same mined place under two names is not — see the doc: Currys and Lidl
-- share a cluster.
#guard samePlace (named "Subway" (some 9)) (named "O2 Centre" (some 9)) == false
-- Two unnamed stays are not the same place either: an absent name never
-- matches an absent name.
#guard samePlace { blank with mode := "stationary" } { blank with mode := "stationary" } == false
#guard samePlace { blank with mode := "stationary", place := some "" } { blank with mode := "stationary", place := some "" } == false

/-- What the passes read off a resolved place. The label and the city are
derived from the Nominatim result before they arrive here. -/
structure ResolvedPlace where
  label : String
  city : Option String := none
  /-- The naming chain's branch (`BestPlace.Source.key`); empty from a reader
      that does not say. -/
  source : String := ""
  /-- The winning feature's OSM key and value (`BestPlace.Result.category`,
      `.type`): `("railway", "train_station")` for a station building. Empty
      from a reader that does not say. -/
  category : String := ""
  type_ : String := ""
  /-- A guessed venue's share of its candidates' evidence
      (`BestPlace.evidenceShare`); absent for every other rule. -/
  share : Option Float := none
  deriving Inhabited, BEq, Repr

end Verified.Geo.SegmentMerge
