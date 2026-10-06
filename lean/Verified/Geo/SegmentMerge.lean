import Verified.Geo.PathPoint
import Verified.Hsmm.FloatScore
import Verified.JsNum
import Verified.FloatConst
/-!
# Segment-list rewrites (port of the pure passes in `src/geo/passes/moving.ts`
and `src/geo/passes/stays.ts`)

The first slice of the ORCHESTRATION tier. Everything ported so far decided
something *about* a segment; these passes rewrite the LIST — merging neighbours,
dropping a bridged middle, demoting a leg — so here the output records are the
answer, not a by-product.

* `composeWayName` / `mergeAdjacentMoving` — coalesce adjacent same-mode moving
  legs, weighting the numeric fields by point count and composing a way label
  from each contributor's DURATION.
* `mergeAdjacentStays` — collapse same-place stays, and bridge over a middle
  segment in two shapes: a brief GPS-multipath phantom move, or a no-GPS
  blackout of any length.
* `attachStayCentroids` — mean of a stay's in-window fixes.
* `absorbIntraPlaceWalk` — demote a short walk that never left the building.
* `absorbFarFocusPlacePhantom` — swallow a stay the focus place's over-long veto
  radius mislabelled, when the same place also appears at its own centroid.
* `planJitterStayRuns` / `consolidateJitterStays` — plan and then perform the
  collapse of co-located stay fragments into one re-resolved stay. `async` in
  the TS only because the venue re-resolution is an OSM call; it appears here as
  an injected function, so the whole pass ports.

Shell, deliberately: `mapLimit`, a concurrency helper.

## Exactness

Every gate and every merge decision is exact. `haversineMeters` (atan2) puts the
five distance thresholds at ≤ 1 ULP, and the weighted-mean fields go through
`Math.round`, which absorbs that. The one string built here quotes a rounded
distance and is reproduced verbatim.

UNPROVEN; pinned against Node/V8 (`lean/experiments/stay-passes-refs.mts`).
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
  /-- Which rule named the stay, WITH the name it named: `(name, source)`
      (#325, 2026-09-30). A later pass that renames the stay leaves the pair
      behind, and a name that no longer matches its pair has no source — so a
      confidence can never outlive the name it was measured for. -/
  placeSource : Option (String × String) := none
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
  deriving Inhabited, BEq, Repr

/-- A GPS fix, as these passes see it. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- A per-minute step count. -/
structure StepPoint where
  ts : Int
  steps : Float
  deriving Inhabited, BEq, Repr

/-- `refinedMode ?? mode`. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- Whether a segment carries a refinement tag — `hasRefinedKind`. -/
def hasRefinedKind (s : Seg) (kind : String) : Bool := s.refinedKinds.contains kind

/-- `existing ? [...existing, kind] : [kind]` — the TS `addRefinedKind`. Lean's
`refinedKinds` is a plain `Array` because the pipeline's readers collapse
`undefined` and `[]`, and both branches of the TS produce the same list, so the
push is faithful for either.

Beside `hasRefinedKind` and not in the pass that first needed it: two passes
write tags now, and the field they write belongs to this record. -/
def addRefinedKind (existing : Array String) (kind : String) : Array String :=
  existing.push kind

/-- Fixes inside a segment's window. INCLUSIVE both ends, the pipeline's
dominant convention (`samplesInWindow`). -/
def samplesInWindow (fixes : Array Fix) (startTs endTs : Int) : Array Fix :=
  fixes.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/-- Arithmetic-mean centroid of some fixes, or `none` when there are none. -/
def meanOf (fixes : Array Fix) : Option (Float × Float) :=
  if fixes.isEmpty then none
  else
    let n := Float.ofNat fixes.size
    some (fixes.foldl (· + ·.lat) 0 / n, fixes.foldl (· + ·.lon) 0 / n)

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

/-! ## `mergeAdjacentMoving` -/

def MOVING_MERGE_MAX_GAP_S : Int := 3 * 60

/-- Add `durationS` of `name` to a contribution list, preserving first-seen
order (JS `Map` iteration order). A missing name or a non-positive duration
contributes nothing. -/
private def addContribution (m : Array (String × Float)) (name : Option String) (durationS : Float) :
    Array (String × Float) :=
  match name with
  | none => m
  | some n =>
    if !(durationS > 0) then m
    else match m.findFinIdx? (·.1 == n) with
      | some i => m.set i (n, m[i].2 + durationS) i.isLt
      | none => m.push (n, durationS)

/-- Coalesce adjacent same-mode MOVING legs.

Merges when the gap is ≤ 3 min, neither side is stationary, `effectiveMode`
agrees, and the two cities do not strictly conflict. Numeric fields become
point-count weighted means — speed to 1 dp, the three ratios to 2 dp, matching
the TS's per-field `Math.round` precision. `maxSpeed` is a max, not a mean.

City handling has two distinct rules and both matter: two DIFFERENT defined
cities block the merge outright (a real boundary crossing), but a defined city
beside an untagged leg merges and then DROPS the city, because the merged span
no longer corresponds to one city. -/
def mergeAdjacentMoving (segments : Array Seg) : Array Seg :=
  let merged := segments.foldl (init := (#[] : Array (Seg × Array (String × Float))))
    fun out seg =>
      let segMode := effectiveMode seg
      let segDuration := Float.ofInt (seg.endTs - seg.startTs)
      match out.back? with
      | some (prev, contribs) =>
        let citiesConflict := prev.city.isSome && seg.city.isSome && prev.city != seg.city
        if segMode != "stationary" && effectiveMode prev == segMode
            && seg.startTs - prev.endTs ≤ MOVING_MERGE_MAX_GAP_S && !citiesConflict then
          let w0 := Float.ofInt prev.pointCount
          let w1 := Float.ofInt seg.pointCount
          let wTot := w0 + w1
          let prev' : Seg :=
            { prev with
              endTs := seg.endTs
              pointCount := prev.pointCount + seg.pointCount
              avgSpeed := jsRound ((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot * 10) / 10
              maxSpeed := jsRound (max prev.maxSpeed seg.maxSpeed * 10) / 10
              linearity := jsRound ((prev.linearity * w0 + seg.linearity * w1) / wTot * 100) / 100
              confidence := jsRound ((prev.confidence * w0 + seg.confidence * w1) / wTot * 100) / 100
              confidenceMargin :=
                jsRound ((prev.confidenceMargin * w0 + seg.confidenceMargin * w1) / wTot * 100) / 100
              city := if prev.city != seg.city then none else prev.city }
          out.pop.push (prev', addContribution contribs seg.wayName segDuration)
        else out.push (seg, addContribution #[] seg.wayName segDuration)
      | none => out.push (seg, addContribution #[] seg.wayName segDuration)
  -- Resolve the composite label. A `none` composite leaves the existing name
  -- alone, so a single contributor short-circuits to what the leg already had.
  merged.map fun (seg, contribs) =>
    if contribs.isEmpty then seg
    else match composeWayName contribs with
      | some composite => { seg with wayName := some composite }
      | none => seg

/-! ## `mergeAdjacentStays` -/

def STAY_MERGE_MAX_GAP_S : Int := 5 * 60
def STAY_BRIDGE_MAX_GAP_S : Int := 10 * 60
def STAY_BRIDGE_MAX_AVG_KMH : Float := 2
/-- Mean cadence at or above which the middle is a real stepping excursion, not
a multipath phantom. Multipath happens while the user SITS, so its step evidence
is fidget-level; a browse-heavy errand defeats the avg-speed guard (sub-walking
median fix speed inside a shop) yet steps 50+/min throughout. Steps are the only
DIRECT movement evidence, so a middle that steps like a walk survives as one. -/
def STAY_BRIDGE_MAX_CADENCE : Float := 20
/-- A step record this close on either side of a segment says the watch was
counting through it, so a zero inside is a count and not an absence. -/
def STEPS_LIVE_MARGIN_S : Int := 15 * 60

private def meanCadence (steps : Array StepPoint) (s : Seg) : Float :=
  let durMin := Float.ofInt (s.endTs - s.startTs) / 60
  if durMin ≤ 0 then 0
  else (steps.foldl (fun acc p => if p.ts ≥ s.startTs && p.ts < s.endTs then acc + p.steps else acc) 0) / durMin

/-- The step stream was reporting around `s`: a record within the margin on
either side. Zero-step minutes are not recorded, so the window itself cannot
say whether the watch was on. -/
private def stepsLiveAround (steps : Array StepPoint) (s : Seg) : Bool :=
  steps.any fun p => p.ts ≥ s.startTs - STEPS_LIVE_MARGIN_S && p.ts < s.endTs + STEPS_LIVE_MARGIN_S

/-- Two stays are at the same place when they carry the same non-empty name.

⚠ NOT the same mined place. Tried 2026-09-29 for the carved stop that comes
out `Subway` beside a stay the same election named `O2 Centre` (05-22): the
identity test also merged Currys and Lidl, 57 m apart under one mined cluster
on 06-24, and lost a confirmed row. A mined cluster is wider than a venue, so
its id cannot say two stays are one visit; the name still can. -/
def samePlace (a b : Seg) : Bool :=
  a.place.any (· != "") && a.place == b.place

/-- Collapse same-place stays and bridge over a spurious middle.

Two independent merges, in order:

1. **Direct adjacency** — two stationary segments at the same place ≤ 5 min
   apart. `effectiveMode` is used, so a walk that `biometricCorrect`
   reclassified to stationary still merges with its same-place neighbour.
2. **Bridge** — a middle segment dropped when bracketed by two stays at the same
   place. Two shapes qualify:
   * a brief multipath phantom move: ≤ 10 min, avg ≤ 2 km/h, cadence < 20/min.
     Tested on the RAW `mode`, not `effectiveMode`, so a middle later
     reclassified to stationary still bridges;
   * a no-GPS blackout (`unknown`, zero fixes) of ANY length. That is an absence
     of data rather than an observed excursion, so place identity outranks the
     speculative split and the duration / speed caps do not apply. -/
def mergeAdjacentStays (segments : Array Seg) (steps : Array StepPoint := #[]) : Array Seg :=
  segments.foldl (init := #[]) fun out seg =>
    let prev? := out.back?
    let prevPrev? := out[out.size - 2]?
    match prev? with
    | none => out.push seg
    | some prev =>
      if effectiveMode prev == "stationary" && effectiveMode seg == "stationary"
          && samePlace prev seg
          && seg.startTs - prev.endTs ≤ STAY_MERGE_MAX_GAP_S then
        out.pop.push { prev with endTs := seg.endTs, pointCount := prev.pointCount + seg.pointCount }
      else
        let isBriefPhantomMove :=
          prev.mode != "stationary"
            && prev.endTs - prev.startTs ≤ STAY_BRIDGE_MAX_GAP_S
            && prev.avgSpeed ≤ STAY_BRIDGE_MAX_AVG_KMH
            && meanCadence steps prev < STAY_BRIDGE_MAX_CADENCE
        let isBlackoutGap := prev.mode == "unknown" && prev.pointCount == 0
        -- A brief slow move with NO steps while the watch was counting. Nobody
        -- changes place at walking speed without a footstep (a vehicle is
        -- excluded by the speed cap), so the stays it separates are one place
        -- whatever each was named: 2026-05-22 20:26–20:31 local, five minutes
        -- of GPS drift inside a station wait, 0 steps between records at
        -- 20:16 and 20:35, the halves named Subway and O2 Centre by two reads
        -- of the same spot (#185, 2026-09-29).
        let isSteplessBridge :=
          isBriefPhantomMove && stepsLiveAround steps prev && meanCadence steps prev == 0
        match prevPrev? with
        | some prevPrev =>
          if effectiveMode seg == "stationary" && effectiveMode prevPrev == "stationary"
              && ((samePlace prevPrev seg && (isBriefPhantomMove || isBlackoutGap))
                  || isSteplessBridge) then
            out.pop.pop.push
              { prevPrev with
                endTs := seg.endTs
                pointCount := prevPrev.pointCount + prev.pointCount + seg.pointCount }
          else out.push seg
        | none => out.push seg

/-! ## `attachStayCentroids` -/

/-- Attach each stationary segment's GPS centroid. Moving segments and stays
with no fixes come back unchanged. This is what the jitter merge compares. -/
def attachStayCentroids (segments : Array Seg) (fixes : Array Fix) : Array Seg :=
  segments.map fun seg =>
    if effectiveMode seg != "stationary" then seg
    else match meanOf (samplesInWindow fixes seg.startTs seg.endTs) with
      | none => seg
      | some (lat, lon) => { seg with centroidLat := some lat, centroidLon := some lon }

/-! ## `absorbIntraPlaceWalk` -/

def INTRA_PLACE_WALK_MAX_S : Int := 12 * 60
def INTRA_PLACE_SAME_SPOT_M : Float := 75
def INTRA_PLACE_FOOTPRINT_M : Float := 120
/-- Two stays at the same NAMED place this far apart are two parts of it — a
hospital's clinic and its radiotherapy, 149 m apart on 2026-07-16 — when the
walk between them never leaves `INTRA_PLACE_FOOTPRINT_M` of one or the other. -/
def INTRA_PLACE_TWO_PARTS_M : Float := 2 * INTRA_PLACE_FOOTPRINT_M

/-- A stay's canonical centre: its attached centroid, else the mean of its
in-window fixes. -/
private def stayCentroid (fixes : Array Fix) (s : Seg) : Option (Float × Float) :=
  match s.centroidLat, s.centroidLon with
  | some la, some lo => some (la, lo)
  | _, _ => meanOf (samplesInWindow fixes s.startTs s.endTs)

/-- Demote a short walk to stationary when it is intra-place pottering:
bracketed by two stays at the SAME place and the SAME spot, and its fixes never
leave the building footprint. The user walked to the kitchen and back — real
steps, but no journey.

The geometric sibling of `mergeAdjacentStays`'s multipath bridge: that one keys
off avg speed ≤ 2 km/h (the fixes never really moved), this one accepts genuine
movement and gates on staying inside the place instead. -/
def absorbIntraPlaceWalk (segments : Array Seg) (fixes : Array Fix) : Array Seg :=
  segments.mapIdx fun i seg =>
    if effectiveMode seg != "walking" || seg.endTs - seg.startTs > INTRA_PLACE_WALK_MAX_S then seg
    else match segments[i - 1]?, segments[i + 1]? with
      | some prev, some next =>
        -- `i - 1` truncates to 0 on `Nat`, so at index 0 `prev` is the walk
        -- itself; the stationary test below rejects it, as the TS's `!prev` does.
        if i == 0 || effectiveMode prev != "stationary" || effectiveMode next != "stationary" then seg
        else if !(samePlace prev next) then seg
        else match stayCentroid fixes prev, stayCentroid fixes next with
          | some (pLat, pLon), some (nLat, nLon) =>
            let apart := haversineMeters pLat pLon nLat nLon
            if apart > INTRA_PLACE_TWO_PARTS_M then seg
            else
              let win := samplesInWindow fixes seg.startTs seg.endTs
              if win.isEmpty then seg
              else
                -- The same spot: never beyond the footprint of the stay it
                -- returns to. Two parts: never beyond the footprint of either.
                let fromStay (p : Fix) : Float :=
                  if apart ≤ INTRA_PLACE_SAME_SPOT_M then haversineMeters pLat pLon p.lat p.lon
                  else min (haversineMeters pLat pLon p.lat p.lon) (haversineMeters nLat nLon p.lat p.lon)
                let maxD := win.foldl (fun acc p => max acc (fromStay p)) 0
                if maxD > INTRA_PLACE_FOOTPRINT_M then seg
                else
                  let rounded := (Verified.JsNum.toFixed (jsRound maxD) 0).getD "?"
                  let reason := s!"intra-place movement within {prev.place.getD ""} (stayed {rounded} m from the stay, returned to it) — not a journey leg"
                  { seg with
                    refinedMode := some "stationary"
                    place := prev.place
                    city := prev.city
                    wayName := none
                    centroidLat := some pLat
                    centroidLon := some pLon
                    refinedReason := some (match seg.refinedReason with
                      | some r => if r == "" then reason else s!"{r}; {reason}"
                      | none => reason) }
          | _, _ => seg
      | _, _ => seg

/-! ## `absorbFarFocusPlacePhantom` -/

/-- A stay this close to a focus place's stored centroid genuinely IS it. -/
def FOCUS_AT_PLACE_M : Float := 90
/-- …and this far from it is NOT — the label is an over-reach. A well-established
focus place's veto radius grows past 300 m, so a transient near a well-known
place inherits its name. The 30 m gap above `FOCUS_AT_PLACE_M` stops a
borderline stay from flip-flopping. -/
def FOCUS_PHANTOM_MIN_M : Float := 120

structure KnownPlaceProjection where
  id : Int
  centroidLat : Float
  centroidLon : Float
  deriving Inhabited, BEq, Repr

/-- Swallow a phantom focus-place stay.

When the SAME focus place labels two stays split only by movement — one AT its
stored centroid (the real visit) and one FAR from it (a transient the place's
over-long veto radius caught) — the far one is a labelling artifact that surfaces
as a spurious leave-and-return. It is demoted to walking with its place dropped,
so it coalesces into the surrounding arrival; the real stay is untouched.

Deliberately biased to SWALLOW rather than relabel: a missed brief stop beats a
wrongly-labelled one, and guessing a replacement venue is exactly where a wrong
label would creep in.

Tightly gated to the artifact shape: the same focus id must appear both NEAR and
FAR with NO other stay between them, so this is one visit split by movement and
not a real round trip. Conservative on missing data — a stay whose distance
cannot be computed is never a phantom and never a twin. -/
def absorbFarFocusPlacePhantom (segments : Array Seg) (knownPlaces : Array KnownPlaceProjection)
    (fixes : Array Fix) : Array Seg :=
  let distToFocus (s : Seg) : Option Float :=
    match s.focusPlaceId with
    | none => none
    | some fid =>
      match knownPlaces.find? (·.id == fid) with
      | none => none
      | some fp => (stayCentroid fixes s).map fun (la, lo) => haversineMeters la lo fp.centroidLat fp.centroidLon
  -- Indices are `Fin segments.size`, so every read below is total by type.
  let stayIdxs := (List.finRange segments.size).filter fun i =>
    effectiveMode segments[i] == "stationary" && segments[i].focusPlaceId.isSome
  let noStayBetween (i j : Fin segments.size) : Bool :=
    let lo := min i.val j.val
    let hi := max i.val j.val
    (List.range (hi - lo)).all fun k =>
      let idx := lo + 1 + k
      if h : idx < segments.size then
        idx ≥ hi || effectiveMode segments[idx] != "stationary"
      else true
  let phantoms := stayIdxs.filter fun far =>
    match distToFocus segments[far] with
    | none => false
    | some df =>
      if df < FOCUS_PHANTOM_MIN_M then false
      else stayIdxs.any fun near =>
        near != far
          && segments[near].focusPlaceId == segments[far].focusPlaceId
          && (match distToFocus segments[near] with
              | none => false
              | some dn => !(dn > FOCUS_AT_PLACE_M))
          && noStayBetween far near
  if phantoms.isEmpty then segments
  else segments.mapIdx fun i s =>
    if !(phantoms.any (·.val == i)) then s
    else
      let reason := "far focus-place phantom (label over-reach) — swallowed into the arrival, not a separate visit"
      { s with
        refinedMode := some "walking"
        place := none
        focusPlaceId := none
        city := none
        refinedReason := some (match s.refinedReason with
          | some r => if r == "" then reason else s!"{r}; {reason}"
          | none => reason) }

/-! ## `planJitterStayRuns` -/

/-- Centroid distance under which two stays are "the same spot" for the jitter
consolidation. Sized for indoor / urban-canyon scatter. -/
def JITTER_STAY_MERGE_RADIUS_M : Float := 75

/-- Index ranges `[start, end]` of adjacent stationary fragments that should
collapse into one stay: every segment in the run is stationary, has a centroid,
and sits within 75 m of the run's FIRST segment — the anchor, not its neighbour,
so slow drift cannot chain a run across a city — or carries the anchor's name.

The run must also contain at least one jitter-demoted leg. That guard is
deliberate: it confines the pass to days where indoor GPS fragmented a sit, so
it cannot disturb a normal multi-stay day. Runs of length ≥ 2 only. -/
def planJitterStayRuns (segments : Array Seg) : Array (Nat × Nat) := Id.run do
  let mut runs : Array (Nat × Nat) := #[]
  let mut i := 0
  while h : i < segments.size do
    let anchor := segments[i]
    match anchor.centroidLat, anchor.centroidLon with
    | some aLat, some aLon =>
      if effectiveMode anchor != "stationary" then
        i := i + 1
      else
        let mut j := i
        while hj : j + 1 < segments.size do
          let next := segments[j + 1]
          match next.centroidLat, next.centroidLon with
          | some nLat, some nLon =>
            -- A fragment NAMED as the anchor is the same stay however far its
            -- centroid wandered; stopping there strands it for the phantom
            -- swallow (2026-09-15's Work, once a jitter walk joined the run).
            let sameNamed := anchor.place.isSome && next.place == anchor.place
            if effectiveMode next != "stationary"
                || (haversineMeters aLat aLon nLat nLon > JITTER_STAY_MERGE_RADIUS_M && !sameNamed) then
              break
            j := j + 1
          | _, _ => break
        -- `j < segments.size` is the inner loop's exit condition; the guard
        -- restates it where the tactic can see it.
        if j > i && (List.range (j - i + 1)).any (fun k =>
            if hk : i + k < segments.size then hasRefinedKind segments[i + k] "gps-jitter" else false) then
          runs := runs.push (i, j)
        i := j + 1
    | _, _ => i := i + 1
  return runs

/-! ## Guards (V8 reference values, `lean/experiments/stay-passes-refs.mts`) -/

open Verified.FloatConst (pi)
private def lat0 : Float := 51.52
private def lon0 : Float := -0.13
private def mlat : Float := 1 / 111320
private def mlon : Float := 1 / (111320 * Float.cos (lat0 * pi / 180))
/-- `n` metres north, `e` metres east of the frame origin. -/
private def pt (n e : Float) : Float × Float := (lat0 + n * mlat, lon0 + e * mlon)

-- The frame itself, before any behaviour is compared: the guards below rebuild
-- coordinates this way and must agree with V8 bit-for-bit first.
#guard mlat == 0.00000898311174991017
#guard mlon == 0.00001443669853117444
#guard (pt 100 0).1 == 51.520898311174996
#guard (pt 0 100).2 == -0.12855633014688256

/-- Coordinates a hair either side of each distance threshold, ±1e-6 m.

Two things they are working around. First, the `pt` frame is equirectangular
(111320 m/deg) and haversine is not (111194.9 m/deg), so "120 m east" in the
frame is 119.86 haversine metres and a boundary case built that way sits on the
WRONG side of the bar while looking right.

Second — and this cost a build — a point sitting EXACTLY on the bar is worse
than useless. Distances here are ULP-close, not bit-identical (atan2/sin/cos),
so a knife-edge input can fall on opposite sides in V8 and Lean. An earlier
draft used exact-hit coordinates found by search, and the 75 m one diverged by
one ULP on the very first build. A ±1e-6 m pair is ~10^8 ULPs clear of any libm
disagreement and still pins each constant to six decimal places. -/
private def under75 : Float × Float := (51.52067449119544, lon0)
private def over75 : Float × Float := (51.52067449121344, lon0)
private def under90 : Float × Float := (51.52080938943633, lon0)
private def over90 : Float × Float := (51.52080938945433, lon0)
private def under120 : Float × Float := (51.521079185918104, lon0)
private def over120 : Float × Float := (51.5210791859361, lon0)

-- ±1e-6 m either side of each bar, and no closer: the pair pins the CONSTANT
-- (a probe moving 75 to 75.001 fails) but deliberately NOT the strictness of
-- the comparison — `>` versus `≥` differ only for an input exactly ON the bar,
-- and such an input is not reproducible across two libms. That limit is real
-- and is the price of not having a flaky guard.
#guard Float.abs (haversineMeters lat0 lon0 under75.1 under75.2 - 75) < 1e-5
#guard haversineMeters lat0 lon0 under75.1 under75.2 < 75
#guard haversineMeters lat0 lon0 over75.1 over75.2 > 75
#guard haversineMeters lat0 lon0 under90.1 under90.2 < 90
#guard haversineMeters lat0 lon0 over90.1 over90.2 > 90
#guard haversineMeters lat0 lon0 under120.1 under120.2 < 120
#guard haversineMeters lat0 lon0 over120.1 over120.2 > 120

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

/-! ### `mergeAdjacentMoving` -/

private def mseg (startTs endTs : Int) (mode : Mode) (pointCount : Int := 10) (avgSpeed maxSpeed : Float := 0)
    (linearity : Float := 0.5) (confidence : Float := 0.8) (confidenceMargin : Float := 2)
    (wayName city : Option String := none) (refinedMode : Option Mode := none) : Seg :=
  { startTs, endTs, mode, refinedMode, confidence, confidenceMargin, avgSpeed, maxSpeed, linearity,
    pointCount, wayName, city }

private def mview (out : Array Seg) :
    Array (Int × Int × Int × Float × Float × Float × Float × Float × Option String × Option String) :=
  out.map fun s => (s.startTs, s.endTs, s.pointCount, s.avgSpeed, s.maxSpeed, s.linearity,
    s.confidence, s.confidenceMargin, s.city, s.wayName)

-- Weighted means at each field's own rounding precision (speed 1 dp, ratios 2),
-- `maxSpeed` a max not a mean, and the composite label from DURATIONS.
#guard mview (mergeAdjacentMoving #[
    mseg 0 600 "walking" 10 4.7 6.1 0.62 0.81 2.4 (some "Gower St"),
    mseg 660 1200 "walking" 30 5.3 7.9 0.74 0.93 3.8 (some "Store St")])
  == #[(0, 1200, 40, 5.2, 7.9, 0.71, 0.9, 3.45, none, some "Gower St, Store St")]
-- 181 s is past the 3-minute bar; 180 s exactly still merges (`<=`).
#guard (mergeAdjacentMoving #[mseg 0 600 "walking", mseg 781 1200 "walking"]).size == 2
#guard (mergeAdjacentMoving #[mseg 0 600 "walking", mseg 780 1200 "walking"]).size == 1
-- Stationary never merges here — that is `mergeAdjacentStays`' job, with
-- different rules.
#guard (mergeAdjacentMoving #[mseg 0 600 "stationary", mseg 660 1200 "stationary"]).size == 2
#guard (mergeAdjacentMoving #[mseg 0 600 "walking", mseg 660 1200 "cycling"]).size == 2
-- effectiveMode: a leg refined to walking merges with a walking leg.
#guard (mergeAdjacentMoving
    #[mseg 0 600 "driving" (refinedMode := some "walking"), mseg 660 1200 "walking"]).size == 1
-- Two DIFFERENT defined cities block the merge (a real boundary crossing)…
#guard (mergeAdjacentMoving
    #[mseg 0 600 "walking" (city := some "London"), mseg 660 1200 "walking" (city := some "Brent")]).size == 2
-- …but one tagged beside one untagged merges and DROPS the city…
#guard (mergeAdjacentMoving
    #[mseg 0 600 "walking" (city := some "London"), mseg 660 1200 "walking"])[0]!.city == none
-- …and two agreeing cities keep it.
#guard (mergeAdjacentMoving
    #[mseg 0 600 "walking" (city := some "London"), mseg 660 1200 "walking" (city := some "London")])[0]!.city
  == some "London"
-- Duration decides the label, so the longer leg leads regardless of list order.
#guard (mergeAdjacentMoving
    #[mseg 0 120 "walking" (wayName := some "Short St"), mseg 120 1200 "walking" (wayName := some "Long Road")])[0]!.wayName
  == some "Long Road"
-- A single contributor keeps the existing name.
#guard (mergeAdjacentMoving
    #[mseg 0 600 "walking" (wayName := some "Gower St"), mseg 660 1200 "walking"])[0]!.wayName == some "Gower St"
-- A three-way run collapses in one left-to-right pass.
#guard mview (mergeAdjacentMoving #[
    mseg 0 600 "walking" 10 4 5, mseg 600 1200 "walking" 10 5 6, mseg 1200 1800 "walking" 20 6 9])
  == #[(0, 1800, 40, 5.3, 9, 0.5, 0.8, 2, none, none)]
#guard mergeAdjacentMoving #[] == #[]

/-! ### `mergeAdjacentStays` -/

/-- A segment carrying the STRUCTURE's field defaults. `default` (from
`Inhabited`) does NOT: it zeroes every field, so a guard built on it silently
merges point counts of 0. -/
private def blank : Seg := { startTs := 0, endTs := 0, mode := "" }
private def home (a b : Int) : Seg :=
  { blank with startTs := a, endTs := b, mode := "stationary", place := some "Home" }
private def sview (out : Array Seg) : Array (Int × Int × Mode × Option String × Int) :=
  out.map fun s => (s.startTs, s.endTs, s.mode, s.place, s.pointCount)
private def steps (from_ to_ : Int) (perMin : Float) : Array StepPoint :=
  (Array.range (((to_ - from_) / 60).toNat)).map fun k => ⟨from_ + 60 * Int.ofNat k, perMin⟩

-- Same place, back to back: collapse. 301 s apart is past the bar; 300 exactly
-- still merges.
#guard sview (mergeAdjacentStays #[home 0 600, home 660 1200]) == #[(0, 1200, "stationary", some "Home", 20)]
#guard (mergeAdjacentStays #[home 0 600, home 901 1200]).size == 2
#guard (mergeAdjacentStays #[home 0 600, home 900 1200]).size == 1
#guard (mergeAdjacentStays
    #[home 0 600, { home 660 1200 with place := some "Work" }]).size == 2
-- A stay with NO place never merges — `prev.place` must be truthy.
#guard (mergeAdjacentStays
    #[{ home 0 600 with place := none }, { home 660 1200 with place := none }]).size == 2
-- 09-06's cinema visit (#185 A, verified 2026-09-28): the classifier cuts it
-- into a 36-min stay, a 4.5-min "walk" the biometric pass reclassifies to
-- stationary, and a 168-min stay. Both halves resolve to the same venue and the
-- direct-adjacency merge — which needs EQUAL names — heals it in one pass. The
-- same shape with the halves named differently, or unnamed, stays cut: that is
-- where the carve remnant still bites, and why naming a stay heals its split.
private def cinemaHalf (a b : Int) (name : Option String) : Seg :=
  { blank with startTs := a, endTs := b, mode := "stationary", place := name, pointCount := 10 }
private def cinemaJog : Seg :=
  { blank with startTs := 2160, endTs := 2430, mode := "walking", refinedMode := some "stationary", pointCount := 5 }
private def cinemaDay (first second : Option String) : Array Seg :=
  #[cinemaHalf 0 2160 first, cinemaJog, cinemaHalf 2430 12500 second]
#guard sview (mergeAdjacentStays (cinemaDay (some "YO! Sushi") (some "YO! Sushi")))
  == #[(0, 12500, "stationary", some "YO! Sushi", 25)]
#guard (mergeAdjacentStays (cinemaDay (some "YO! Sushi") (some "Cineworld"))).size == 3
#guard (mergeAdjacentStays (cinemaDay none none)).size == 3

-- effectiveMode: a walk reclassified to stationary merges with its neighbour.
#guard (mergeAdjacentStays
    #[home 0 600, { home 660 1200 with mode := "walking", refinedMode := some "stationary" }]).size == 1
-- BRIDGE shape 1: a brief multipath phantom move is dropped and its points
-- folded into the surviving stay.
#guard sview (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 1.5, pointCount := 4 }, home 900 1800]
    (steps 600 900 5))
  == #[(0, 1800, "stationary", some "Home", 24)]
-- …but a middle that STEPS like a real errand survives (the #329 guard): steps
-- are the only DIRECT movement evidence and they outrank the speed gate.
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 1.5, pointCount := 4 }, home 900 1800]
    (steps 600 900 60)).size == 3
-- Too fast to be multipath; too long; and 600 s exactly still bridges (`<=`).
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 2.5, pointCount := 4 }, home 900 1800]).size == 3
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 1201, mode := "walking", avgSpeed := 1.5, pointCount := 4 }, home 1201 1800]).size == 3
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 1200, mode := "walking", avgSpeed := 1.5, pointCount := 4 }, home 1200 1800]).size == 1
-- BRIDGE shape 2: a no-GPS blackout of ANY length, at 40 km/h and 50 minutes —
-- both caps that veto shape 1 — bridges anyway, because place identity outranks
-- a speculative split over unobserved time.
#guard sview (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 3600, mode := "unknown", avgSpeed := 40, pointCount := 0 }, home 3600 7200])
  == #[(0, 7200, "stationary", some "Home", 20)]
-- An `unknown` middle WITH fixes is not a blackout.
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 3600, mode := "unknown", avgSpeed := 40, pointCount := 5 }, home 3600 7200]).size == 3
-- The bridge tests the middle's RAW mode, so one reclassified to stationary
-- still bridges (2026-05-22).
#guard (mergeAdjacentStays
    #[home 0 600,
      { blank with startTs := 600, endTs := 900, mode := "walking", refinedMode := some "stationary", avgSpeed := 1.5, pointCount := 4 },
      home 900 1800]).size == 1
-- Brackets at DIFFERENT places do not bridge…
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 1.5, pointCount := 4 },
      { home 900 1800 with place := some "Work" }]).size == 3
-- …unless the middle took NO steps while the watch was counting either side of
-- it: then it is drift, and the first stay's name stands.
private def drift : Seg := { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 1.5, pointCount := 4 }
#guard sview (mergeAdjacentStays #[home 0 600, drift, { home 900 1800 with place := some "Work" }]
    #[⟨300, 12⟩, ⟨1000, 9⟩])
  == #[(0, 1800, "stationary", some "Home", 24)]
-- A single step record inside the middle, and it is a walk between two places.
#guard (mergeAdjacentStays #[home 0 600, drift, { home 900 1800 with place := some "Work" }]
    #[⟨300, 12⟩, ⟨700, 6⟩, ⟨1000, 9⟩]).size == 3
-- No record within fifteen minutes on either side: the watch may have been
-- off, and a zero that is an absence bridges nothing.
#guard (mergeAdjacentStays #[home 0 600, drift, { home 900 1800 with place := some "Work" }]
    #[⟨-2000, 12⟩, ⟨3000, 9⟩]).size == 3
#guard mergeAdjacentStays #[] == #[]

/-! ### `attachStayCentroids` -/

private def cfixes : Array Fix := #[
  ⟨100, (pt 0 0).1, (pt 0 0).2⟩, ⟨200, (pt 20 0).1, (pt 20 0).2⟩, ⟨300, (pt 0 40).1, (pt 0 40).2⟩,
  -- Exactly on the closing boundary: the window is INCLUSIVE, so this counts.
  ⟨400, (pt 40 40).1, (pt 40 40).2⟩, ⟨500, (pt 1000 1000).1, (pt 1000 1000).2⟩]

#guard (attachStayCentroids #[{ blank with startTs := 100, endTs := 400, mode := "stationary" }] cfixes)[0]!.centroidLat
  == some 51.520134746676256
#guard (attachStayCentroids #[{ blank with startTs := 100, endTs := 400, mode := "stationary" }] cfixes)[0]!.centroidLon
  == some (-0.12971126602937652)
#guard (attachStayCentroids #[{ blank with startTs := 100, endTs := 400, mode := "walking" }] cfixes)[0]!.centroidLat == none
#guard (attachStayCentroids #[{ blank with startTs := 5000, endTs := 6000, mode := "stationary" }] cfixes)[0]!.centroidLat == none
#guard (attachStayCentroids
    #[{ blank with startTs := 100, endTs := 400, mode := "walking", refinedMode := some "stationary" }] cfixes)[0]!.centroidLat
  == some 51.520134746676256

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

/-! ### `absorbIntraPlaceWalk` -/

private def insideFixes : Array Fix :=
  #[⟨650, (pt 0 30).1, (pt 0 30).2⟩, ⟨750, (pt 0 80).1, (pt 0 80).2⟩]
private def outsideFixes : Array Fix :=
  #[⟨650, (pt 0 30).1, (pt 0 30).2⟩, ⟨750, (pt 0 200).1, (pt 0 200).2⟩]

private def intraCase (walk : Seg) (prevC nextC : Float × Float) (place : Option String := some "Work") : Array Seg :=
  #[{ blank with
      startTs := 0, endTs := 600, mode := "stationary", place := place, city := some "London",
      centroidLat := some prevC.1, centroidLon := some prevC.2 },
    { walk with startTs := 600, endTs := 900, mode := "walking" },
    { blank with
      startTs := 900, endTs := 1800, mode := "stationary", place := place,
      centroidLat := some nextC.1, centroidLon := some nextC.2 }]

private def REASON_80 : String :=
  "intra-place movement within Work (stayed 80 m from the stay, returned to it) — not a journey leg"
private def REASON_120 : String :=
  "intra-place movement within Work (stayed 120 m from the stay, returned to it) — not a journey leg"

-- The 2026-06-17 case: a 5-min kitchen run between two Work stays 2 m apart.
-- The absorbed leg takes the stay's place, city and centroid, and LOSES its
-- way name — it is no longer a leg.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0)) insideFixes)[1]!
  == { blank with
       startTs := 600, endTs := 900, mode := "walking", refinedMode := some "stationary",
       place := some "Work", city := some "London", wayName := none,
       centroidLat := some (pt 0 0).1, centroidLon := some (pt 0 0).2,
       refinedReason := some REASON_80 }
#guard (absorbIntraPlaceWalk (intraCase { blank with wayName := some "Corridor" } (pt 0 0) (pt 2 0)) insideFixes)[1]!.wayName == none
-- The walk leaves the footprint — a real excursion.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0)) outsideFixes)[1]!.refinedMode == none
-- The FOOTPRINT bar from both sides (`> 120` rejects). The reason quotes the
-- rounded distance, so the surviving side also pins the `Math.round`.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0)) #[⟨650, under120.1, under120.2⟩])[1]!.refinedReason
  == some REASON_120
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0)) #[⟨650, over120.1, over120.2⟩])[1]!.refinedMode == none
-- Past the same spot (`> 75`) the stays are two parts of one place: the walk is
-- still absorbed while it stays within the footprint of one or the other…
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) under75) insideFixes)[1]!.refinedMode == some "stationary"
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) over75) insideFixes)[1]!.refinedMode == some "stationary"
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 0 200)) insideFixes)[1]!.refinedMode == some "stationary"
-- …and past `INTRA_PLACE_TWO_PARTS_M` (240 m) they are two places that share a name.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 0 250)) insideFixes)[1]!.refinedMode == none
-- Two parts, but the walk strays beyond the footprint of both: an excursion.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 0 200))
    #[⟨650, (pt 0 30).1, (pt 0 30).2⟩, ⟨750, (pt 130 100).1, (pt 130 100).2⟩])[1]!.refinedMode == none
-- Different places, no place at all, too long, or no fixes: left alone.
#guard (absorbIntraPlaceWalk
    #[{ blank with
        startTs := 0, endTs := 600, mode := "stationary", place := some "Work",
        centroidLat := some (pt 0 0).1, centroidLon := some (pt 0 0).2 },
      { blank with startTs := 600, endTs := 900, mode := "walking" },
      { blank with
        startTs := 900, endTs := 1800, mode := "stationary", place := some "Home",
        centroidLat := some (pt 2 0).1, centroidLon := some (pt 2 0).2 }] insideFixes)[1]!.refinedMode == none
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0) none) insideFixes)[1]!.refinedMode == none
#guard (absorbIntraPlaceWalk
    #[{ blank with
        startTs := 0, endTs := 600, mode := "stationary", place := some "Work",
        centroidLat := some (pt 0 0).1, centroidLon := some (pt 0 0).2 },
      { blank with startTs := 600, endTs := 1321, mode := "walking" },
      { blank with
        startTs := 1321, endTs := 2000, mode := "stationary", place := some "Work",
        centroidLat := some (pt 2 0).1, centroidLon := some (pt 2 0).2 }] insideFixes)[1]!.refinedMode == none
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 2 0)) #[])[1]!.refinedMode == none
-- An existing reason is appended to, not replaced.
#guard (absorbIntraPlaceWalk
    (intraCase { blank with refinedReason := some "earlier note" } (pt 0 0) (pt 2 0)) insideFixes)[1]!.refinedReason
  == some s!"earlier note; {REASON_80}"

/-! ### `absorbFarFocusPlacePhantom` -/

private def FOCUS : Array KnownPlaceProjection := #[⟨7, (pt 0 0).1, (pt 0 0).2⟩]

private def phantomAt (far near : Float × Float) (between : Array Seg := #[]) : Array Seg :=
  #[{ blank with
      startTs := 0, endTs := 600, mode := "stationary", place := some "Work", focusPlaceId := some 7,
      city := some "London", centroidLat := some far.1, centroidLon := some far.2 },
    { blank with startTs := 600, endTs := 900, mode := "walking" }]
  ++ between
  ++ #[{ blank with
         startTs := 900, endTs := 1800, mode := "stationary", place := some "Work", focusPlaceId := some 7,
         centroidLat := some near.1, centroidLon := some near.2 }]

private def PHANTOM_REASON : String :=
  "far focus-place phantom (label over-reach) — swallowed into the arrival, not a separate visit"

-- The 2026-07-10 case: a coffee stop ~190 m from the Work centroid, stamped
-- "Work", beside the real arrival AT the centroid. The far stay is demoted and
-- stripped of place, focus id and city; the real one is untouched.
#guard (absorbFarFocusPlacePhantom (phantomAt (pt 0 190) (pt 0 5)) FOCUS #[])[0]!
  == { blank with
       startTs := 0, endTs := 600, mode := "stationary", refinedMode := some "walking",
       place := none, focusPlaceId := none, city := none,
       centroidLat := some (pt 0 190).1, centroidLon := some (pt 0 190).2,
       refinedReason := some PHANTOM_REASON }
#guard (absorbFarFocusPlacePhantom (phantomAt (pt 0 190) (pt 0 5)) FOCUS #[])[2]!.place == some "Work"
-- The FAR bar from both sides (`< 120` skips): just under is borderline and
-- deliberately left alone, just over is a phantom.
#guard (absorbFarFocusPlacePhantom (phantomAt under120 (pt 0 5)) FOCUS #[])[0]!.refinedMode == none
#guard (absorbFarFocusPlacePhantom (phantomAt over120 (pt 0 5)) FOCUS #[])[0]!.refinedMode == some "walking"
-- The NEAR bar from both sides (`> 90` skips): past it nothing anchors the pair.
#guard (absorbFarFocusPlacePhantom (phantomAt (pt 0 190) under90) FOCUS #[])[0]!.refinedMode == some "walking"
#guard (absorbFarFocusPlacePhantom (phantomAt (pt 0 190) over90) FOCUS #[])[0]!.refinedMode == none
-- Another stay between them makes it a real round trip, not one split visit.
#guard (absorbFarFocusPlacePhantom (phantomAt (pt 0 190) (pt 0 5)
    #[{ blank with
        startTs := 700, endTs := 800, mode := "stationary", place := some "Cafe",
        centroidLat := some (pt 0 100).1, centroidLon := some (pt 0 100).2 }]) FOCUS #[])[0]!.refinedMode == none
-- Different focus ids never pair.
#guard (absorbFarFocusPlacePhantom
    #[{ blank with
        startTs := 0, endTs := 600, mode := "stationary", focusPlaceId := some 7,
        centroidLat := some (pt 0 190).1, centroidLon := some (pt 0 190).2 },
      { blank with startTs := 600, endTs := 900, mode := "walking" },
      { blank with
        startTs := 900, endTs := 1800, mode := "stationary", focusPlaceId := some 8,
        centroidLat := some (pt 0 5).1, centroidLon := some (pt 0 5).2 }] FOCUS #[])[0]!.refinedMode == none
-- A stay whose distance cannot be computed is never a phantom and never a twin.
#guard (absorbFarFocusPlacePhantom
    #[{ blank with startTs := 0, endTs := 600, mode := "stationary", focusPlaceId := some 7 },
      { blank with startTs := 600, endTs := 900, mode := "walking" },
      { blank with
        startTs := 900, endTs := 1800, mode := "stationary", focusPlaceId := some 7,
        centroidLat := some (pt 0 5).1, centroidLon := some (pt 0 5).2 }] FOCUS #[])[0]!.refinedMode == none
#guard absorbFarFocusPlacePhantom #[] FOCUS #[] == #[]

/-! ### `planJitterStayRuns` -/

private def jstayAt (a b : Int) (c : Float × Float) (jitter : Bool := false) : Seg :=
  { blank with
    startTs := a, endTs := b, mode := "stationary", centroidLat := some c.1, centroidLon := some c.2,
    refinedKinds := if jitter then #["gps-jitter"] else #[] }
private def jstay (a b : Int) (offsetM : Float) (jitter : Bool := false) : Seg :=
  jstayAt a b (pt 0 offsetM) jitter

#guard planJitterStayRuns #[jstay 0 600 0 true, jstay 600 1200 20, jstay 1200 1800 40] == #[(0, 2)]
-- No jitter tag anywhere: a normal multi-stay day is untouched.
#guard planJitterStayRuns #[jstay 0 600 0, jstay 600 1200 20, jstay 1200 1800 40] == #[]
-- The radius is measured from the run ANCHOR, not the neighbour, so 50 m + 150 m
-- of drift cannot chain — the run ends at the second fragment.
#guard planJitterStayRuns #[jstay 0 600 0 true, jstay 600 1200 50, jstay 1200 1800 200] == #[(0, 1)]
-- The merge radius from both sides (`> 75` breaks the run).
#guard planJitterStayRuns #[jstay 0 600 0 true, jstayAt 600 1200 under75] == #[(0, 1)]
#guard planJitterStayRuns #[jstay 0 600 0 true, jstayAt 600 1200 over75] == #[]
-- A fragment named as the anchor joins however far its centroid sits (09-15's
-- Work); an unnamed one past 75 m still ends the run.
#guard planJitterStayRuns #[{ jstay 0 600 0 with place := some "Work" }, jstay 600 1200 20 true,
  { jstay 1200 1800 200 with place := some "Work" }] == #[(0, 2)]
#guard planJitterStayRuns #[jstay 0 600 0, jstay 600 1200 20 true, jstay 1200 1800 200] == #[(0, 1)]
-- A moving segment, or a stay with no centroid, breaks the run.
#guard planJitterStayRuns
  #[jstay 0 600 0 true, { blank with startTs := 600, endTs := 700, mode := "walking" }, jstay 700 1300 20 true] == #[]
#guard planJitterStayRuns
  #[jstay 0 600 0 true, { blank with startTs := 600, endTs := 1200, mode := "stationary" }, jstay 1200 1800 20 true] == #[]
-- A run of one is never emitted.
#guard planJitterStayRuns #[jstay 0 600 0 true] == #[]
#guard planJitterStayRuns
  #[jstay 0 600 0 true, jstay 600 1200 20, { blank with startTs := 1200, endTs := 1300, mode := "walking" },
    jstay 1300 1900 1000 true, jstay 1900 2500 1020] == #[(0, 1), (3, 4)]
#guard planJitterStayRuns #[] == #[]

/-! ## `consolidateJitterStays` — the collapse the plan describes

One continuous sit that indoor GPS shattered into several stays, each grabbing a
different nearest POI, becomes one stay re-resolved from the combined centre.
The motivating case (2026-06-09) came out as 7 fragments named "The Plumbers
Arms" / "Keencare Pharmacy" / way-labels; merged, the centre lands 11 m from the
venue that was actually visited.

The OSM call is modelled as an injected `bestPlace` of `(lat, lon, startUnix,
endUnix, tz)`, and `tzLookup` as `tzAt`. That is where the boundary falls in the
TS too — but NOT where it is written: `bestPlace` is a direct import that takes
the adapter, so the V8 reference could not stub it. It was pinned instead with a
fake adapter answering an enclosing landmark NAMED AFTER the coordinate it was
asked about, so the resolved label reports the point the pass chose
(`lean/experiments/consolidate-jitter-stays-refs.mts`). `placeLabel` and
`extractCity` are `osm.ts`'s, not this pass's, so they sit inside the injected
answer; the `?? base.city` fallback around `extractCity` IS this pass's and is
pinned here.

**A defect that was reproduced, then fixed in both arms (#416).** `totalPoints`
used to be `reduce(+) || 1`, so a run whose fragments all carry `pointCount: 0`
divided a zero numerator by 1 and put the combined centroid at (0, 0) — the pass
then resolved a venue in the Gulf of Guinea and named the stay after it. The
`|| 1` prevented a NaN and yielded a wrong answer instead of no answer. This twin
reproduced it deliberately, because a quietly-better centroid here would have
read as a Lean divergence rather than a TS bug.

Both arms now fall back to the UNWEIGHTED mean of the fragment centroids, which
is always available: `planJitterStayRuns` admits a fragment only if it has a
centroid. The merged `pointCount` is the raw sum, so an all-zero run reports 0
rather than a 1 no fragment contributed.

Exact: the centroid is a weighted mean of `Float` centroids, the base pick and
the index rewrite are ordering decisions on `Int`, and the two strings are built
verbatim. -/

/-- What this pass reads off a resolved place. Both fields are computed by
`osm.ts` (`placeLabel` / `extractCity`) from the Nominatim result, so they arrive
here already derived. -/
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

/-- Collapse each planned run into one stay, re-resolving its name from the
point-count-weighted centre of the run. Everything outside a run is passed
through in place. -/
def consolidateJitterStays (segments : Array Seg)
    (bestPlace : Float → Float → Int → Int → String → Option ResolvedPlace)
    (tzAt : Float → Float → String) : Array Seg := Id.run do
  let runs := planJitterStayRuns segments
  -- UNPINNABLE, and provably: with no runs nothing is merged and nothing is
  -- dropped, so the rewrite below reproduces the input segment for segment.
  -- The early return buys a pass over the list, not a decision. Kept to mirror
  -- the TS.
  if runs.isEmpty then return segments
  let mut merged : Array (Nat × Seg) := #[]
  let mut drop : Array Nat := #[]
  for (start, stop) in runs do
    -- `stop < segments.size` by `planJitterStayRuns`'s construction; an index
    -- past the end contributes nothing rather than a default segment.
    let run := (List.range (stop - start + 1)).filterMap fun k =>
      if hk : start + k < segments.size then some segments[start + k] else none
    let first := run.head!
    let last := run.getLast!
    -- Point-count-weighted, falling back to the UNWEIGHTED mean when every
    -- fragment carries `pointCount: 0`. The old fallback was a denominator of
    -- 1 over a zero numerator, i.e. a (0, 0) centroid — see the header.
    let summed := run.foldl (fun s x => s + x.pointCount) 0
    let unweighted := summed == 0
    let denom := Float.ofInt (if unweighted then (run.length : Int) else summed)
    -- Every segment in a run has a centroid: `planJitterStayRuns` refuses one
    -- that does not, which is why the TS casts here rather than testing. That
    -- precondition is also what makes the unweighted mean always available.
    let weighted (pick : Seg → Option Float) : Float :=
      (run.foldl (fun s x =>
        s + (pick x).getD 0 * (if unweighted then 1 else Float.ofInt x.pointCount)) 0) / denom
    let cLat := weighted (·.centroidLat)
    let cLon := weighted (·.centroidLon)
    let place := bestPlace cLat cLon first.startTs last.endTs (tzAt cLat cLon)
    -- The longest leg is the base. `>` is strict, so a tie keeps the EARLIER.
    let base := (run.drop 1).foldl
      (fun a b => if decide (b.endTs - b.startTs > a.endTs - a.startTs) then b else a) first
    let reason := s!"consolidated {run.length} GPS-jitter stay fragments"
    merged := merged.push (start,
      { base with
          startTs := first.startTs
          endTs := last.endTs
          pointCount := summed
          centroidLat := some cLat
          centroidLon := some cLon
          place := match place with | some p => some p.label | none => base.place
          city := match place with
                  | some p => match p.city with | some c => some c | none => base.city
                  | none => base.city
          wayName := none
          refinedReason := match base.refinedReason with
                           | some r => some s!"{r}; {reason}"
                           | none => some reason })
    -- From `start + 1`: the head index carries the merged stay. Starting at
    -- `start` instead is UNPINNABLE, and subsumed by the rewrite's order — it
    -- consults `merged` BEFORE `drop`, so a head marked dropped is emitted
    -- anyway. The TS is the same shape (`if (merged.has(i)) … else if
    -- (!drop.has(i))`), so the redundancy is faithful, not introduced here.
    for k in [start + 1 : stop + 1] do drop := drop.push k
  let mut out : Array Seg := #[]
  for h : i in [0 : segments.size] do
    match merged.find? (·.1 == i) with
    | some (_, m) => out := out.push m
    | none => if !drop.contains i then out := out.push segments[i]
  return out

/-! ### Parity with Node/V8 (`lean/experiments/consolidate-jitter-stays-refs.mts`) -/

section ConsolidateGuards


/-- The centre V8 asked about for `runOf3`, and for the second run of the
two-run day. -/
private def C1_LAT : Float := 51.500280000000004
private def C1_LON : Float := -0.14014
private def C2_LAT : Float := 51.60007499999999
private def C2_LON : Float := -0.200075

/-- Answers at either run's centre, so a two-run day can tell them apart. -/
private def namedAfter : Float → Float → Int → Int → String → Option ResolvedPlace :=
  fun lat lon _ _ _ =>
    if lat == C1_LAT && lon == C1_LON then some { label := "Olivomare" }
    else if lat == C2_LAT && lon == C2_LON then some { label := "Second venue" }
    else if lat == 0 && lon == 0 then some { label := "Null Island" }
    -- The all-zero-pointCount run's centre, written as the arithmetic rather
    -- than a decimal literal: it is the UNWEIGHTED mean of the two fragment
    -- centroids, and spelling it that way is exact where a transcribed literal
    -- would only be nearly so (#416).
    else if lat == (51.5 + 51.5002) / 2 && lon == ((-0.14) + (-0.1401)) / 2 then
      some { label := "Unweighted centre" }
    else if lat == 51.500099999999996 && lon == -0.14005 then some { label := "Tie centre" }
    else if lat == 51.500159999999994 && lon == -0.14008 then some { label := "Pair centre" }
    else none

/-- Europe/London everywhere. The tz is handed straight to the venue scorer, so
only the scorer can act on it; what this module can pin is the COORDINATE the tz
is taken at, which the last guard below does. -/
private def londonTz : Float → Float → String := fun _ _ => "Europe/London"

/-- A walking leg, for the segments that must survive around a run. -/
private def walkSeg (a b : Int) (place : Option String := none) : Seg :=
  { blank with startTs := a, endTs := b, mode := "walking", place }

private def cstay (a b : Int) (lat lon : Float) (n : Int) (jitter : Bool := false)
    (place city : Option String := none) (reason : Option String := none)
    (confidence : Float := 0.8) (avgSpeed : Float := 0) : Seg :=
  { blank with
    startTs := a, endTs := b, mode := "stationary", pointCount := n,
    centroidLat := some lat, centroidLon := some lon, place, city, refinedReason := reason,
    confidence, avgSpeed, refinedKinds := if jitter then #["gps-jitter"] else #[] }

/-- Three co-located fragments; the MIDDLE is longest, so it is the base, and
the point counts differ, so the centroid is not the plain mean. -/
private def runOf3 : Array Seg :=
  #[cstay 0 600 51.5 (-0.14) 10 true none (some "Edge") none 0.1,
    cstay 600 1500 51.5002 (-0.1401) 40 false (some "Middle") (some "London")
      (some "earlier note") 0.55 1.25,
    cstay 1500 1800 51.5004 (-0.1402) 50 false (some "Last") (some "Edge") none 0.9]

private def go (segs : Array Seg) : Array Seg := consolidateJitterStays segs namedAfter londonTz

/-- The fields the collapse writes, per surviving segment. -/
private def shape (segs : Array Seg) :
    Array (Int × Int × Int × Option Float × Float × Option String × Option String × Option String ×
           Option String) :=
  (go segs).map fun s =>
    (s.startTs, s.endTs, s.pointCount, s.centroidLat, s.confidence, s.place, s.city, s.wayName,
     s.refinedReason)

-- One stay, spanning the run, weighted centroid, the MIDDLE's base fields, the
-- resolved label, the base's city (the stub answers none), no way label, and the
-- base's own reason with the consolidation appended after it.
#guard shape runOf3 ==
  #[(0, 1800, 100, some C1_LAT, 0.55, some "Olivomare", some "London", none,
     some "earlier note; consolidated 3 GPS-jitter stay fragments")]
#guard (go runOf3).map (·.centroidLon) == #[some C1_LON]
#guard (go runOf3).map (·.avgSpeed) == #[1.25]
-- The weighted centroid is NOT the plain mean of the three fragment centroids.
#guard C1_LAT != (51.5 + 51.5002 + 51.5004) / 3

-- No jitter tag anywhere: the plan is empty and the day is returned untouched.
#guard go #[cstay 0 600 51.5 (-0.14) 10, cstay 600 1500 51.5002 (-0.1401) 40]
       == #[cstay 0 600 51.5 (-0.14) 10, cstay 600 1500 51.5002 (-0.1401) 40]

-- Segments outside a run keep their place in the list, on both sides.
#guard (go (#[walkSeg (-300) 0 (some "Before")] ++ runOf3
            ++ #[walkSeg 1800 2100 (some "After")])).map (·.place)
       == #[some "Before", some "Olivomare", some "After"]

-- Two runs in one day are collapsed independently, each asking about its OWN
-- centre — the second's label proves the query was not reused.
#guard (go (runOf3 ++ #[walkSeg 1800 2100, cstay 2100 2700 51.6 (-0.2) 10 true,
                        cstay 2700 3300 51.6001 (-0.2001) 30 false (some "Second run")])).map
         (fun s => (s.startTs, s.endTs, s.place))
       == #[(0, 1800, some "Olivomare"), (1800, 2100, none), (2100, 3300, some "Second venue")]
-- …and each counts ITS OWN fragments, not the day's segments (3 and 2, of 6).
#guard (go (runOf3 ++ #[walkSeg 1800 2100, cstay 2100 2700 51.6 (-0.2) 10 true,
                        cstay 2700 3300 51.6001 (-0.2001) 30 false (some "Second run")])).map
         (·.refinedReason)
       == #[some "earlier note; consolidated 3 GPS-jitter stay fragments", none,
            some "consolidated 2 GPS-jitter stay fragments"]

/- Every fragment carries `pointCount: 0`, so the weights sum to zero and the
centroid falls back to the UNWEIGHTED mean of the fragment centroids — which the
resolver here is keyed on, so this pins the COORDINATE the pass asked about, not
merely that it asked. The merged `pointCount` is 0, which is what the fragments
actually contributed.

Until #416 this pinned the defect instead: the denominator fell back to 1 over a
zero numerator, putting the centre at (0, 0), resolving a venue in the Gulf of
Guinea, and reporting a `pointCount` of 1 no fragment had contributed. The guard
was deliberately reproducing it so the twin would not read as a Lean divergence;
both arms are fixed together, so it now pins the answer rather than the bug. -/
#guard shape #[cstay 0 600 51.5 (-0.14) 0 true, cstay 600 1500 51.5002 (-0.1401) 0]
       == #[(0, 1500, 0, some ((51.5 + 51.5002) / 2), 0.8, some "Unweighted centre", none, none,
             some "consolidated 2 GPS-jitter stay fragments")]

-- A tie on duration keeps the EARLIER leg as base: `>` is strict.
#guard (go #[cstay 0 600 51.5 (-0.14) 10 true none (some "EarlierBase") none 0.11,
             cstay 600 1200 51.5002 (-0.1401) 10 false none (some "LaterBase") none 0.99]).map
         (fun s => (s.confidence, s.city, s.place))
       == #[(0.11, some "EarlierBase", some "Tie centre")]

-- A base with no reason of its own gets the consolidation note alone.
#guard (go #[cstay 0 600 51.5 (-0.14) 10 true,
             cstay 600 1500 51.5002 (-0.1401) 40 false (some "Middle")]).map
         (fun s => (s.refinedReason, s.place))
       == #[(some "consolidated 2 GPS-jitter stay fragments", some "Pair centre")]

-- An unresolvable centre leaves the base's own place and city standing.
#guard (consolidateJitterStays runOf3 (fun _ _ _ _ _ => none) londonTz).map
         (fun s => (s.place, s.city))
       == #[(some "Middle", some "London")]
-- A place that DOES carry a city outranks the base's.
#guard (consolidateJitterStays runOf3
          (fun _ _ _ _ _ => some { label := "Olivomare", city := some "Westminster" })
          londonTz).map (fun s => (s.place, s.city))
       == #[(some "Olivomare", some "Westminster")]

-- The window handed to the resolver is the RUN's OUTER bounds — the first
-- fragment's start and the last's end, not the base's own window (600..1500).
#guard (consolidateJitterStays runOf3
          (fun _ _ a b _ => if a == 0 && b == 1800 then some { label := "outer" } else none)
          londonTz).map (·.place)
       == #[some "outer"]
-- …and the tz is taken at the COMBINED centre, not at any fragment's.
#guard (consolidateJitterStays runOf3
          (fun _ _ _ _ tz => if tz == "at-centre" then some { label := "tz ok" } else none)
          (fun lat lon => if lat == C1_LAT && lon == C1_LON then "at-centre" else "elsewhere")).map
         (·.place)
       == #[some "tz ok"]

end ConsolidateGuards

end Verified.Geo.SegmentMerge
