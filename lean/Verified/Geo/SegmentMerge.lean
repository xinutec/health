import Verified.Geo.PathPoint
import Verified.Hsmm.FloatScore
import Verified.JsNum
import Verified.FloatConst
import Verified.Fix
import Verified.PlaceSource
/-!
# The segment record, and the list rewrites the tail shares (from
`src/geo/passes/moving.ts` and `src/geo/passes/stays.ts`)

`Seg` is the record every pass reads and rewrites. Beside it:

* `composeWayName` — a way label composed from each contributor's DURATION;
* `samePlace` — two stays are one visit when they carry the same name;
* `absorbDarkMoveAtPlace` — a fixless moving run between two stays at one place
  is that stay.

`haversineMeters` (atan2) is ≤ 1 ULP; everything else is exact. UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Geo.SegmentMerge

open Verified.Hsmm.FloatScore (haversineMeters)

abbrev Mode := String

open Verified.JsNum (jsRound)

/-- Per-segment HR, sleep and step aggregates — what `enrichSegmentWithBiometrics`
(`Verified.Geo.BiometricWindows`) computes and the `biomEnrich` pass attaches.

Declared HERE rather than beside the function that fills it in, because `Seg`
carries one and the dependency only runs one way: the segment record is the
leaf every pass shares, so a field of it cannot name a module that imports it. -/
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

/-- The `EnrichedSegment` fields these passes read and rewrite. A wider
projection than `Verified.Geo.SegmentPasses.Seg`: the merges have to carry the
weighted numeric fields, and the stay passes need the centroid and focus id.

`focusPlaceId` is `string | number` in the TS; the mined ids are numeric and
only EQUALITY is tested, so `Int` loses nothing here. -/
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
  /-- The OSM key and value of the feature that named the stay, when the
      namer said (`ResolvedPlace.category`, `.type_`): `("railway",
      "train_station")` for a station building. Read by a later pass that needs
      to know WHAT enclosed the stay without asking the namer again — a second
      ask is a new question a golden fixture cannot answer. -/
  placeKind : Option (String × String) := none
  city : Option String := none
  wayName : Option String := none
  refinedReason : Option String := none
  refinedKinds : Array String := #[]
  centroidLat : Option Float := none
  centroidLon : Option Float := none
  focusPlaceId : Option Int := none
  /-- Whether `linearity` MEANS anything for this segment — whether it moved
  farther than its own GPS error (#185). See
  `Verified.Geo.Segments.WindowFeatures.directionResolvable`.

  ⚠ DEFAULT `true`. Every existing construction omits it and must keep its
  behaviour: "we have no reason to doubt the direction" is the status quo, and
  a segment with no accuracy reported is not thereby suspect. -/
  directionResolvable : Bool := true
  /-- Set by the stay-split rebuilds (`Verified.Geo.StaySplit`) when a segment's
  window changed and its inherited enrichment is therefore no longer evidence
  about it. The `reenrichSplitWalks` pass sends these back through OSM naming. -/
  needsReenrich : Bool := false
  /-- The weaker sibling of `needsReenrich`: re-derive this segment's road NAME
  from its own geometry, but leave its mode alone. Set by
  `claimStayArrivalFromWalk`, whose carve changes a walk's window but never what
  it IS — so the inherited name is stale while the inherited mode is still
  right. Asking for the full re-derivation instead cost a mode on 2026-04-29
  (#782). -/
  needsRename : Bool := false
  /-- The bus passes' judgement of a road-vehicle leg: which KIND of vehicle it
  is. The day-state flattening gives this precedence over `refinedMode`, so a
  pass that promotes a leg to `train` must CLEAR it or the timeline renders the
  train as a bus (#365). `Verified.Geo.PlaceOverride` is the pass that does. -/
  vehicleKind : Option String := none
  /-- The share of this leg's GPS samples that sit nearer a drivable road than
  any rail — the evidence weighed against the HSMM's line support in
  `decideHsmmTrainOverride`. `none` means no samples (an underground gap the
  HSMM reconstructed), which cannot contradict, so the HSMM stands. -/
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
  /-- This walking leg drawn by the MAP reconstruction instead of the matcher,
  attached only where the reconstruction is substantially shorter. Takes
  precedence over `walkMatchedPath` when present. -/
  walkSmoothedPath : Option (Array PathPt) := none
  /-- Whether the walk annotation had building outlines for THIS leg's ground
  (#1501, #1678): `some true` when the `buildingsNear` read answered (possibly
  with no rings: ground with none), `some false` when it was DECLINED, `none`
  when no read was made (no ways to draw on, or the pass did not run). The
  wall metric means something only when this is `some true`: over unmeasured
  ground a line crosses no wall for the wrong reason. -/
  walkBuildingsMeasured : Option Bool := none
  /-- HR, sleep and step aggregates over this segment's window, attached by the
  `biomEnrich` pass. `none` until it runs — distinct from an enrichment whose
  own fields are empty because Fitbit had nothing for the day. -/
  biometrics : Option BiometricEnrichment := none
  /-- **A DEBUG SURFACE, AND NOTHING READS IT (#1464).** The walk matcher's
  identity report for this leg: how much of the chosen route ran along each NAMED
  way, longest first. Unnamed arcs are dropped.

  ⚠ **THE UNIT IS THE MATCHER'S OWN AND DOES NOT CONVERT TO METRES** — see
  `MatchOut.wayUm`. Read these as SHARES; an `m` suffix would invent a precision
  nobody measured.

  ⚠ **UNGATED, AND DELIBERATELY WIDER THAN `wayName`.** `drawMatcher` adopts a
  route name only on an unnamed, unspliced leg inside the stray bar (#445). A
  diagnostic filtered the same way could not show a route riding the wrong way
  on a leg that kept its cascade name. -/
  walkWayUm : Array (String × Nat) := #[]
  /-- Every road a moving leg was on, longest first (`Enrich.roadsByTime`);
  `wayName` is the label composed from the first three. Empty where nothing
  wrote it. -/
  roads : Array String := #[]
  deriving Inhabited, BEq, Repr

/-- A GPS fix, as these passes see it. -/
abbrev Fix := Verified.GeoFix

/-- A per-minute step count. -/
structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited, BEq, Repr

/-- `refinedMode ?? mode`. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Fixes inside a segment's window. INCLUSIVE both ends, the pipeline's
dominant convention (`samplesInWindow`). -/
def samplesInWindow (fixes : Array Fix) (startTs endTs : Int) : Array Fix :=
  Verified.GeoFix.within fixes startTs endTs

/-! ## `composeWayName` -/

def WAY_LABEL_MAX_CHARS : Nat := 30
def WAY_LABEL_MIN_COVERAGE : Float := 0.15
def WAY_LABEL_MAX_NAMES : Nat := 3

/-- Compose a way label from per-name DURATION contributions.

Ranked longest-first (a STABLE sort, so equal durations keep insertion order —
JS `Array#sort` is TimSort and `List.mergeSort` merges left-biased), filtered to
contributors covering ≥ 15% of the total, capped at three names, then joined
while the running label stays inside 30 characters.

Note the join BREAKS rather than skips: once a candidate would overflow the
budget the loop stops, so a shorter fourth-ranked name never sneaks in behind a
long second. `none` when nothing survives, and when the durations total zero —
which is a real case (`total === 0`), not just an empty map.

LIMIT: JS `.length` counts UTF-16 code units and Lean's counts codepoints. Way
names outside the BMP would budget differently; street names in this corpus are
ASCII. -/
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

⚠ NOT the same mined place. Tried 2026-09-29 for the carved stop that comes
out `Subway` beside a stay the same election named `O2 Centre` (05-22): the
identity test also merged Currys and Lidl, 57 m apart under one mined cluster
on 06-24, and lost a confirmed row. A mined cluster is wider than a venue, so
its id cannot say two stays are one visit; the name still can. -/
def samePlace (a b : Seg) : Bool :=
  a.place.any (· != "") && a.place == b.place

/-! ## `absorbDarkMoveAtPlace` -/

/-- A run of moving segments with no fix at all, between two stays at one
place, is that stay: the decoder labels such a stretch by its steps (walking
about the office on 2026-07-06, 11:31–11:36Z and 14:54–15:09Z), and without a
fix nothing says the place was left. Each segment of the run becomes the stay
it sits in. -/
def absorbDarkMoveAtPlace (segments : Array Seg) (fixes : Array Fix) : Array Seg := Id.run do
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
    let absorbed := match out[i - 1]?, out[j]? with
      | some prev, some next =>
        i > 0 && effectiveMode prev == "stationary" && samePlace prev next
          && (samplesInWindow fixes seg.startTs (out[j - 1]!).endTs).isEmpty
      | _, _ => false
    if absorbed then
      let prev := out[i - 1]!
      let reason := s!"no fix between two stays at {prev.place.getD ""} — the place was not left"
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

/-- A mined place's id and centre, as the fold's `Env` carries it. -/
structure KnownPlaceProjection where
  id : Int
  centroidLat : Float
  centroidLon : Float
  deriving Inhabited, BEq, Repr

/-! ## Guards (V8 reference values, `lean/experiments/stay-passes-refs.mts`) -/

open Verified.FloatConst (pi)

/-! ### `composeWayName` -/

private def cw (xs : List (String × Float)) : Option String := composeWayName xs.toArray

#guard cw [("Euston Road", 600)] == some "Euston Road"
-- Both over the coverage floor and inside the 30-char budget.
#guard cw [("Gower St", 600), ("Store St", 300)] == some "Gower St, Store St"
-- The join BREAKS on overflow rather than skipping: a shorter third-ranked name
-- never sneaks in behind a long second.
#guard cw [("Tottenham Court Road", 600), ("Great Russell Street", 500), ("Bury Pl", 400)]
  == some "Tottenham Court Road"
-- Ranked by duration DESC, so insertion order is irrelevant.
#guard cw [("B St", 100), ("A St", 900)] == some "A St"
-- Under 15% coverage: dropped even though it is a real contributor…
#guard cw [("Main St", 900), ("Alley", 100)] == some "Main St"
-- …and exactly at the floor it survives.
#guard cw [("Main St", 850), ("Alley", 150)] == some "Main St, Alley"
-- At most three names, and the CAP is what excludes the fourth: all four clear
-- the coverage floor here, so nothing else can be doing it.
#guard cw [("A", 250), ("B", 250), ("C", 250), ("D", 250)] == some "A, B, C"
-- The char budget from both sides: a 30-character join is accepted (`> 30`
-- rejects), 31 breaks and leaves the leader alone.
#guard cw [("Abbey Road", 600), ("Seventeen Chars Xx", 500)] == some "Abbey Road, Seventeen Chars Xx"
#guard cw [("Abbey Road", 600), ("Nineteen Chars Xxxx", 500)] == some "Abbey Road"
-- A zero TOTAL is its own arm, distinct from an empty map.
#guard cw [("Nowhere", 0)] == none
#guard cw [] == none

/-- A segment carrying the STRUCTURE's field defaults. `default` (from
`Inhabited`) does NOT: it zeroes every field, so a guard built on it silently
merges point counts of 0. -/
private def blank : Seg := { startTs := 0, endTs := 0, mode := "" }

/-! ### `samePlace` -/

private def named (n : String) (id : Option Int := none) : Seg :=
  { blank with mode := "stationary", place := some n, focusPlaceId := id }
-- The same name is the same place, with or without an election.
#guard samePlace (named "Costa") (named "Costa") == true
#guard samePlace (named "Costa" (some 3)) (named "Costa" (some 4)) == true
-- The same mined place under two names is NOT — see the doc: Currys and Lidl
-- share a cluster.
#guard samePlace (named "Subway" (some 9)) (named "O2 Centre" (some 9)) == false
-- Two unnamed stays are not the same place either: an absent name never
-- matches an absent name.
#guard samePlace { blank with mode := "stationary" } { blank with mode := "stationary" } == false
#guard samePlace { blank with mode := "stationary", place := some "" } { blank with mode := "stationary", place := some "" } == false

/-- What the passes read off a resolved place. The label and the city are
computed by `osm.ts` (`placeLabel` / `extractCity`) from the Nominatim result,
so they arrive here already derived. -/
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
  deriving Inhabited, BEq, Repr

end Verified.Geo.SegmentMerge
