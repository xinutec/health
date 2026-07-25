import Verified.Hsmm.FloatScore
import Verified.JsNum
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
* `planJitterStayRuns` — index ranges of co-located stay fragments to collapse.

Shell, deliberately: `consolidateJitterStays` (async OSM re-resolution — it
consumes the PLAN this module computes) and `mapLimit` (a concurrency helper).

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

/-- `Math.round` — halves go UP, towards +∞. -/
private def jsRound (x : Float) : Float := Float.floor (x + 0.5)

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
  city : Option String := none
  wayName : Option String := none
  refinedReason : Option String := none
  refinedKinds : Array String := #[]
  centroidLat : Option Float := none
  centroidLon : Option Float := none
  focusPlaceId : Option Int := none
  /-- Set by the stay-split rebuilds (`Verified.Geo.StaySplit`) when a segment's
  window changed and its inherited enrichment is therefore no longer evidence
  about it. The `reenrichSplitWalks` pass sends these back through OSM naming. -/
  needsReenrich : Bool := false
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
    else match m.findIdx? (·.1 == n) with
      | some i => m.set! i (n, m[i]!.2 + durationS)
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

private def meanCadence (steps : Array StepPoint) (s : Seg) : Float :=
  let durMin := Float.ofInt (s.endTs - s.startTs) / 60
  if durMin ≤ 0 then 0
  else (steps.foldl (fun acc p => if p.ts ≥ s.startTs && p.ts < s.endTs then acc + p.steps else acc) 0) / durMin

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
          && prev.place.any (· != "") && prev.place == seg.place
          && seg.startTs - prev.endTs ≤ STAY_MERGE_MAX_GAP_S then
        out.pop.push { prev with endTs := seg.endTs, pointCount := prev.pointCount + seg.pointCount }
      else
        let isBriefPhantomMove :=
          prev.mode != "stationary"
            && prev.endTs - prev.startTs ≤ STAY_BRIDGE_MAX_GAP_S
            && prev.avgSpeed ≤ STAY_BRIDGE_MAX_AVG_KMH
            && meanCadence steps prev < STAY_BRIDGE_MAX_CADENCE
        let isBlackoutGap := prev.mode == "unknown" && prev.pointCount == 0
        match prevPrev? with
        | some prevPrev =>
          if effectiveMode seg == "stationary" && effectiveMode prevPrev == "stationary"
              && prevPrev.place.any (· != "") && prevPrev.place == seg.place
              && (isBriefPhantomMove || isBlackoutGap) then
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
        else if !(prev.place.any (· != "")) || prev.place != next.place then seg
        else match stayCentroid fixes prev, stayCentroid fixes next with
          | some (pLat, pLon), some (nLat, nLon) =>
            if haversineMeters pLat pLon nLat nLon > INTRA_PLACE_SAME_SPOT_M then seg
            else
              let win := samplesInWindow fixes seg.startTs seg.endTs
              if win.isEmpty then seg
              else
                let maxD := win.foldl (fun acc p => max acc (haversineMeters pLat pLon p.lat p.lon)) 0
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
  let stayIdxs := (List.range segments.size).filter fun i =>
    effectiveMode segments[i]! == "stationary" && segments[i]!.focusPlaceId.isSome
  let noStayBetween (i j : Nat) : Bool :=
    let lo := min i j
    let hi := max i j
    (List.range (hi - lo)).all fun k =>
      let idx := lo + 1 + k
      idx ≥ hi || effectiveMode segments[idx]! != "stationary"
  let phantoms := stayIdxs.filter fun far =>
    match distToFocus segments[far]! with
    | none => false
    | some df =>
      if df < FOCUS_PHANTOM_MIN_M then false
      else stayIdxs.any fun near =>
        near != far
          && segments[near]!.focusPlaceId == segments[far]!.focusPlaceId
          && (match distToFocus segments[near]! with
              | none => false
              | some dn => !(dn > FOCUS_AT_PLACE_M))
          && noStayBetween far near
  if phantoms.isEmpty then segments
  else segments.mapIdx fun i s =>
    if !(phantoms.contains i) then s
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
so slow drift cannot chain a run across a city.

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
            if effectiveMode next != "stationary"
                || haversineMeters aLat aLon nLat nLon > JITTER_STAY_MERGE_RADIUS_M then
              break
            j := j + 1
          | _, _ => break
        if j > i && (List.range (j - i + 1)).any (fun k => hasRefinedKind segments[i + k]! "gps-jitter") then
          runs := runs.push (i, j)
        i := j + 1
    | _, _ => i := i + 1
  return runs

/-! ## Guards (V8 reference values, `lean/experiments/stay-passes-refs.mts`) -/

private def pi : Float := 3.141592653589793
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
-- Brackets at DIFFERENT places do not bridge.
#guard (mergeAdjacentStays
    #[home 0 600, { blank with startTs := 600, endTs := 900, mode := "walking", avgSpeed := 1.5, pointCount := 4 },
      { home 900 1800 with place := some "Work" }]).size == 3
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
-- The SAME-SPOT bar from both sides (`> 75` rejects), plus a clearly-different
-- building at 200 m.
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) (pt 0 200)) insideFixes)[1]!.refinedMode == none
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) under75) insideFixes)[1]!.refinedMode == some "stationary"
#guard (absorbIntraPlaceWalk (intraCase blank (pt 0 0) over75) insideFixes)[1]!.refinedMode == none
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


end Verified.Geo.SegmentMerge
