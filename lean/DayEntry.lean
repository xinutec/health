import Verified
import DayEntry.Wire
import DayEntry.OsmHost
import Verified.Geo.WalkMatchAdapt

/-!
# `DayEntry` — the day cascade's JSON boundary, and the C entry point

`namespace Day` lived in `Main.lean`, the root module of the `verified_cli`
EXECUTABLE. That is fine for a process the TS bridge spawns and fatal for a host
that links the fold in: Lean emits `main` into the same object as everything
else in an exe root, so `libverified_Main.a` carried a second `_main`, it won the
link silently, and `rust/day-shell` answered a day request as a decoder model
while printing well-formed JSON. `build.rs` worked around that with
`ld -r -unexported_symbol _main`. This module is the fix the workaround stood in
for: a LIBRARY with no entry point, so there is nothing to collide.

Layering, and why it is three and not two:

    Verified        pure folds + their #guard specs. No Json, anywhere.
    DayEntry.Wire   the float-exact JSON helpers all entry points share.
    DayEntry        this: the day request/response shape + @[export].
    Main            everything else, `Focus`, `StationChain`, and `def main` —
                    the only module that defines an entry point.

`Verified` stays parser-free on purpose; see `DayEntry/Wire.lean`.
-/

open Lean (Json)
open Wire

namespace Day

-- Not `open`ed: `Verified.Hsmm.Seg` is already in scope at the top of this
-- file and the two names would be ambiguous.
abbrev Seg := Verified.Geo.SegmentMerge.Seg
abbrev StepPoint := Verified.Geo.SegmentMerge.StepPoint
abbrev Env := Verified.Geo.PassFold.Env

/-- Table key for a lookup of two coordinates, and for three where the third is
the caller's radius. Bit patterns, per the section note. -/
private def k2 (a b : Float) : String := s!"{a.toBits}|{b.toBits}"
private def k3 (a b c : Float) : String := s!"{a.toBits}|{b.toBits}|{c.toBits}"

private def mkMap (xs : Array (String × α)) : Std.HashMap String α :=
  xs.foldl (fun m (k, v) => m.insert k v) (Std.HashMap.emptyWithCapacity xs.size)

/-- Answer or abort. Never a default: see the section note on the miss policy. -/
private def hit [Inhabited α] (m : Std.HashMap String α) (what key : String) : α :=
  match m[key]? with
  | some v => v
  | none => panic! s!"verified_cli day: uncaptured {what}({key}) — re-capture required"

/-! ### Decoding -/

private def optBits (j : Json) (k : String) : Except String (Option Float) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> jBits v

private def optInt (j : Json) (k : String) : Except String (Option Int) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> v.getInt?

private def optBool (j : Json) (k : String) (dflt : Bool) : Except String Bool :=
  match j.getObjVal? k with
  | .error _ => pure dflt
  | .ok v => if v.isNull then pure dflt else v.getBool?

/-- A field holding an array; absent and `null` both read as empty. -/
private def optArr (j : Json) (k : String) : Except String (Array Json) :=
  match j.getObjVal? k with
  | .error _ => pure #[]
  | .ok v => if v.isNull then pure #[] else v.getArr?

private def nth (a : Array Json) (i : Nat) : Except String Json :=
  match a[i]? with
  | some v => pure v
  | none => throw s!"tuple too short: wanted index {i} of {a.size}"

private def strs (j : Json) : Except String (Array String) := do
  (← j.getArr?).mapM (·.getStr?)

private def parsePathPt (j : Json) : Except String Verified.Geo.PathPt := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- A positional bit pattern that may be `null` — the array-tuple counterpart of
{@link optBits}. The mined statistics are the first wire shape where a nullable
Float sits in a tuple rather than under a key: a mode observed with no HR at all
has `hrMean = null`, which is not the same claim as `hrMean = 0`. -/
private def nthBits (a : Array Json) (i : Nat) : Except String (Option Float) := do
  let v ← nth a i
  if v.isNull then pure none else some <$> jBits v

/-- One mined `mode_biometrics` row, as `fold-payload.ts` writes it. -/
private def parseModeStats (j : Json) : Except String Verified.Geo.ModeBiometrics.ModeStats := do
  let a ← j.getArr?
  return {
    mode := ← (← nth a 0).getStr?
    hrMean := ← nthBits a 1
    hrStd := ← nthBits a 2
    hrSampleCount := (← (← nth a 3).getInt?).toNat
    cadenceMean := ← nthBits a 4
    cadenceStd := ← nthBits a 5
    cadenceSampleCount := (← (← nth a 6).getInt?).toNat
    speedMean := ← nthBits a 7
    speedStd := ← nthBits a 8
    speedSampleCount := (← (← nth a 9).getInt?).toNat
    sampleCount := (← (← nth a 10).getInt?).toNat
  }

private def optPath (j : Json) (k : String) :
    Except String (Option (Array Verified.Geo.PathPt)) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => do
    if v.isNull then pure none else some <$> ((← v.getArr?).mapM parsePathPt)

private def parseBiom (j : Json) : Except String Verified.Geo.SegmentMerge.BiometricEnrichment := do
  return {
    hrMean := ← optBits j "hrMean"
    hrMin := ← optBits j "hrMin"
    hrMax := ← optBits j "hrMax"
    hrStd := ← optBits j "hrStd"
    sampleCount := (← (← j.getObjVal? "sampleCount").getInt?).toNat
    overlapsSleep := ← optBool j "overlapsSleep" false
    sleepFraction := ← jBits (← j.getObjVal? "sleepFraction")
    stepsTotal := ← optBits j "stepsTotal"
  }

private def parseSeg (j : Json) : Except String Seg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    refinedMode := ← optStr j "refinedMode"
    confidence := ← jBits (← j.getObjVal? "confidence")
    confidenceMargin := ← jBits (← j.getObjVal? "confidenceMargin")
    avgSpeed := ← jBits (← j.getObjVal? "avgSpeed")
    maxSpeed := ← jBits (← j.getObjVal? "maxSpeed")
    linearity := ← jBits (← j.getObjVal? "linearity")
    pointCount := ← (← j.getObjVal? "pointCount").getInt?
    place := ← optStr j "place"
    city := ← optStr j "city"
    wayName := ← optStr j "wayName"
    refinedReason := ← optStr j "refinedReason"
    refinedKinds := ← (← optArr j "refinedKinds").mapM (·.getStr?)
    centroidLat := ← optBits j "centroidLat"
    centroidLon := ← optBits j "centroidLon"
    focusPlaceId := ← optInt j "focusPlaceId"
    needsReenrich := ← optBool j "needsReenrich" false
    needsRename := ← optBool j "needsRename" false
    vehicleKind := ← optStr j "vehicleKind"
    roadCorridorFraction := ← optBits j "roadCorridorFraction"
    displayTz := ← optStr j "displayTz"
    snappedPath := ← optPath j "snappedPath"
    matchedPath := ← optPath j "matchedPath"
    walkMatchedPath := ← optPath j "walkMatchedPath"
    walkSmoothedPath := ← optPath j "walkSmoothedPath"
    biometrics := ← match j.getObjVal? "biometrics" with
      | .error _ => pure none
      | .ok v => if v.isNull then pure none else some <$> parseBiom v
  }

private def parsePointF (j : Json) : Except String Shed.PointF := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), ← jBits (← nth a 3)⟩

private def parseCoarse (j : Json) : Except String Verified.Geo.UndergroundRun.CoarseFix := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parsePedFix (j : Json) : Except String Verified.Geo.WalkAnnotate.PedFix := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parseStep (j : Json) : Except String StepPoint := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1)⟩

private def parseHr (j : Json) : Except String Verified.Geo.BiometricWindows.HrPoint := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1)⟩

private def parseSleep (j : Json) : Except String Verified.Geo.BiometricWindows.SleepStage := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← (← nth a 1).getInt?⟩

private def parseKnownPlace (j : Json) : Except String Verified.Geo.SegmentMerge.KnownPlaceProjection := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- `[id, latBits, lonBits, radiusBits, uniqueDaysBits, hourProfile|null,
displayName|null, sleepHoursBits, amenityLabel|null]` — a mined `focus_places`
row as the OSM enrichment stage reads it.

The whole row rather than a projection, unlike `stayPlaces` and `dwellPlaces`
beside it: the stationary branch scores the candidate and then branches its
LABEL on three more fields of the SAME row in one decision, so a split would
only give the halves somewhere to drift apart. -/
private def parseNamedPlace (j : Json) : Except String Verified.Geo.StayEnrich.NamedPlace := do
  let a ← j.getArr?
  let profile ← match a[5]? with
    | some v => if v.isNull then pure none else some <$> ((← v.getArr?).mapM jBits).map Array.toList
    | none => pure none
  let optS (i : Nat) : Except String (Option String) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return {
    cand := {
      id := ← (← nth a 0).getInt?
      centroidLat := ← jBits (← nth a 1)
      centroidLon := ← jBits (← nth a 2)
      radiusM := ← jBits (← nth a 3)
      uniqueDays := ← jBits (← nth a 4)
      hourProfile := profile }
    displayName := ← optS 6
    sleepHours := ← jBits (← nth a 7)
    amenityLabel := ← optS 8 }

private def parseHmmSeg (j : Json) : Except String Verified.Geo.PlaceOverride.HmmSeg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    lineName := ← optStr j "lineName"
    placeId := ← optInt j "placeId"
  }

/-- `[id, displayName|null, latBits|null, lonBits|null]`. -/
private def parseHsmmPlace (j : Json) :
    Except String (Int × Verified.Geo.PlaceOverride.PlaceLookup) := do
  let a ← j.getArr?
  let nm ← match a[1]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  let la ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let lo ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return (← (← nth a 0).getInt?, ⟨nm, la, lo⟩)

private def parseRouteStop (j : Json) : Except String Verified.Geo.LineStoppingPattern.RouteStop := do
  let a ← j.getArr?
  let nm ← match a[0]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨nm, ← jBits (← nth a 1), ← jBits (← nth a 2), (← (← nth a 3).getInt?).toNat⟩

private def parseRailStops (j : Json) :
    Except String Verified.Geo.LineStoppingPattern.RailStopRelation := do
  return {
    stops := ← (← optArr j "stops").mapM parseRouteStop
    lineRef := ← optStr j "lineRef"
    lineName := ← optStr j "lineName"
    osmRelationId := (← (← j.getObjVal? "osmRelationId").getInt?).toNat
    routeType := ← (← j.getObjVal? "routeType").getStr?
  }

private def parseWpt (j : Json) : Except String Verified.Geo.WalkableRoute.Pt := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1)⟩

/-- `[routeKey, [[latBits, lonBits], …]]`. -/
private def parseRouteRow (j : Json) : Except String Verified.Geo.RailReconcile.RouteRow := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getStr?, ← (← (← nth a 1).getArr?).mapM parseWpt⟩

private def parseLatLon (j : Json) : Except String Verified.Geo.Bus.LatLon := do
  let a ← j.getArr?
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1)⟩

private def parseBusStop (j : Json) : Except String Verified.Geo.Bus.BusStop := do
  let a ← j.getArr?
  let nm ← match a[0]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨nm, ← jBits (← nth a 1), ← jBits (← nth a 2), ← (← nth a 3).getInt?⟩

private def parseBusRoute (j : Json) : Except String Verified.Geo.Bus.BusRoute := do
  return {
    routeRef := ← (← j.getObjVal? "routeRef").getStr?
    routeName := ← optStr j "routeName"
    osmRelationId := ← (← j.getObjVal? "osmRelationId").getInt?
    stops := (← (← optArr j "stops").mapM parseBusStop).toList
  }

private def parseStation (j : Json) : Except String Verified.Geo.TubeHop.NearbyStation := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← jBits (← j.getObjVal? "distanceM")
    lat := ← optBits j "lat"
    lon := ← optBits j "lon"
  }

private def parseWay (j : Json) : Except String Verified.Geo.Factors.NearbyWay := do
  return {
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    name := ← optStr j "name"
    distanceM := ← optBits j "distanceM"
  }

/-- A Nominatim reverse-geocode, whole.

It used to decode the five city-like fields only, because `extractCity` was the
one consumer. `Verified.Geo.BestPlace` reads the rest, so the projection went
away on both sides at once (#430) — a decoder narrower than the encoder would
silently drop the venue keys the naming turns on. -/
private def parseGeoResult (j : Json) : Except String Verified.Geo.BestPlace.Result := do
  return {
    displayName := ← (← j.getObjVal? "displayName").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    category := ← (← j.getObjVal? "category").getStr?
    address := {
      amenity := ← optStr j "amenity"
      tourism := ← optStr j "tourism"
      leisure := ← optStr j "leisure"
      shop := ← optStr j "shop"
      building := ← optStr j "building"
      houseNumber := ← optStr j "houseNumber"
      road := ← optStr j "road"
      pedestrian := ← optStr j "pedestrian"
      neighbourhood := ← optStr j "neighbourhood"
      suburb := ← optStr j "suburb"
      stateDistrict := ← optStr j "stateDistrict"
      city := ← optStr j "city"
      town := ← optStr j "town"
      village := ← optStr j "village"
      municipality := ← optStr j "municipality"
    }
  }

/-- One Overpass landmark, as `bestPlace` ranks them. `openingHours` is the RAW
tag: `Verified.Geo.BestPlace.toLandmark` parses it against the stay's samples,
because the fraction is a function of both and only the pair is meaningful. -/
private def parsePoi (j : Json) : Except String Verified.Geo.BestPlace.Poi := do
  return {
    name := ← (← j.getObjVal? "name").getStr?
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    distanceM := ← jBits (← j.getObjVal? "distanceM")
    openingHours := ← optStr j "openingHours"
    enclosing := ← optBool j "enclosing" false
  }

private def parseVenueStats (j : Json) : Except String Verified.Geo.VenuePrior.VenueTypeStats := do
  return {
    visits := ← jBits (← j.getObjVal? "visits")
    dwell := (← (← optArr j "dwell").mapM jBits).toList
    hours := (← (← optArr j "hours").mapM jBits).toList
  }

/-- The mined visit-shape priors, or `none` when nothing has been mined.

Association lists rather than maps, and in the encoder's order: `shapeScore`
reads the subtype universe's SIZE off `bySubtype`, so the collection is data and
not just an index. -/
private def parseVenuePriors (j : Json) :
    Except String (Option Verified.Geo.VenuePrior.VenuePriors) := do
  match j.getObjVal? "venuePriors" with
  | .error _ => pure none
  | .ok v =>
    if v.isNull then pure none else do
      let pair := fun (e : Json) => do
        let a ← e.getArr?
        return (← (← nth a 0).getStr?, ← parseVenueStats (← nth a 1))
      return some {
        bySubtype := (← (← optArr v "bySubtype").mapM pair).toList
        byCategory := (← (← optArr v "byCategory").mapM pair).toList
        totalVisits := ← jBits (← v.getObjVal? "totalVisits")
      }

/-- `[latBits, lonBits, zoom, address|null]`.

The zoom crosses as a plain integer rather than as bits: it is an argument the
caller writes as a literal (16 here, 18 by default), not a measured double, and
keying an integer on its float bits would be a spelling both sides have to agree
on for no gain.

`null` is a RESULT — Nominatim resolving nothing — and is stored as such, so a
key present with a null answer is not a miss. -/
private def entryGeo (j : Json) :
    Except String (String × Option Verified.Geo.BestPlace.Result) := do
  let a ← j.getArr?
  let lat ← jBits (← nth a 0)
  let lon ← jBits (← nth a 1)
  let zoom ← (← nth a 2).getInt?
  let ans ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> parseGeoResult v
    | none => pure none
  return (s!"{lat.toBits}|{lon.toBits}|{zoom}", ans)

private def parseTransitStop (j : Json) : Except String Verified.Geo.Bus.TransitStop := do
  return ⟨← (← j.getObjVal? "subtype").getStr?, ← jBits (← j.getObjVal? "distanceM")⟩

private def parseLineStation (j : Json) : Except String Verified.Geo.RailJourney.LineStation := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getStr?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

/-- `[latBits, lonBits, radiusBits, answer]` → a keyed entry. -/
private def entry3 (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  let k := k3 (← jBits (← nth a 0)) (← jBits (← nth a 1)) (← jBits (← nth a 2))
  return (k, ← parse (← nth a 3))

/-- `[latBits, lonBits, answer]` — the two-argument lookups. -/
private def entry2 (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  let k := k2 (← jBits (← nth a 0)) (← jBits (← nth a 1))
  return (k, ← parse (← nth a 2))

/-- `[key, answer]` — the lookups keyed by a name rather than a coordinate. -/
private def entryS (parse : Json → Except String α) (j : Json) : Except String (String × α) := do
  let a ← j.getArr?
  return (← (← nth a 0).getStr?, ← parse (← nth a 1))

/-- `[latBits, lonBits, startTs, endTs, tz, samples, localHour]` — the stay
CONTEXT of one naming question, keyed on all five arguments because it is asked
per merged stay and two stays at one centroid with different windows are
different questions.

It used to carry the ANSWER, `{label, city}`, because `bestPlace` was a shell.
It is now `Verified.Geo.BestPlace`, so what crosses is the part Lean cannot
compute: the stay's minutes and its midpoint hour resolved in the venue's zone.
The zone stays in the KEY as well — it is what those two were resolved against,
and a key without it would spell two different questions the same way. -/
private def entryPlace (j : Json) :
    Except String (String × (List (Nat × Nat) × Int)) := do
  let a ← j.getArr?
  let lat ← jBits (← nth a 0)
  let lon ← jBits (← nth a 1)
  let s ← (← nth a 2).getInt?
  let e ← (← nth a 3).getInt?
  let m ← (← nth a 4).getStr?
  let samples ← (← (← nth a 5).getArr?).mapM fun p => do
    let q ← p.getArr?
    return ((← (← nth q 0).getInt?).toNat, (← (← nth q 1).getInt?).toNat)
  let localHour ← (← nth a 6).getInt?
  return (s!"{lat.toBits}|{lon.toBits}|{s}|{e}|{m}", (samples.toList, localHour))

/-! ### The stages after the fold

`Verified.Geo.DayChain` reads a different closure: two raw-fix series from
OUTSIDE the day, the Fitbit windows before place attribution, the mined places in
two projections, and one shell lookup. Parsed separately from `Env` because they
are a different stage's inputs, not more of the fold's. -/

private def parseStayFix (j : Json) : Except String Verified.Geo.DayState.StayFix := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2)⟩

private def parseRawSleep (j : Json) : Except String Verified.Geo.DayChain.RawSleepWindow := do
  let a ← j.getArr?
  let tz ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← (← nth a 1).getInt?, tz, ← (← nth a 3).getInt?⟩

private def parseStayPlace (j : Json) : Except String Verified.Geo.DayState.StayKnownPlace := do
  let a ← j.getArr?
  let r ← match a[2]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let nm ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> v.getStr?
    | none => pure none
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), r, nm⟩

private def parseDwellPlace (j : Json) :
    Except String Verified.Geo.DwellContinuation.DwellCandidate := do
  let a ← j.getArr?
  let optF (i : Nat) : Except String (Option Float) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  let optI (i : Nat) : Except String (Option Int) := match a[i]? with
    | some v => if v.isNull then pure none else some <$> v.getInt?
    | none => pure none
  return ⟨← jBits (← nth a 0), ← jBits (← nth a 1), ← optF 2, ← optF 3, ← optI 4,
    ← (← nth a 5).getInt?⟩

/-- `nearbyLandmarks`' radius, fixed by `bestPlace`'s only call to it. A literal
rather than a parameter for the same reason the TS writes it inline: the ring is
the picker's, not the caller's. -/
private def LANDMARK_RADIUS_M : Float := 100

/-- The tables the venue naming reads, bound once and shared by the fold's
`bestPlace` and the chain's `sleepPlace` — the same function at two call sites,
which is why they are built here rather than twice. -/
private structure Namer where
  landmarksAt : Float → Float → Array Verified.Geo.BestPlace.Poi
  geocodeAt : Float → Float → Int → Option Verified.Geo.BestPlace.Result
  stayCtx : Float → Float → Int → Int → String → List (Nat × Nat) × Int
  priors : Option Verified.Geo.VenuePrior.VenuePriors
  /-- The three tables' entry counts.
      These exist so the LAYER MEASUREMENT can force the three `mkMap` calls
      without calling the closures above (#433). The other five tables are
      forced by a probe that asks them for a key they hold, but these three are
      reachable only through `Namer.name`, which composes a landmark lookup, a
      geocode lookup and a stay-context lookup — any of which can reach a key a
      probe did not choose, and a miss `panic!`s. A structure field is computed
      when the structure is built, so reading a size here forces the map with no
      key to guess and no miss to risk.
      `dayResult` ignores them and is unaffected: it forces all three through
      the fold regardless, so the same work happens either way. -/
  sizes : Nat

private def namerOf (j : Json) : Except String Namer := do
  let lk := (j.getObjVal? "lookups").toOption.getD (Json.mkObj [])
  let landmarks := mkMap (← (← optArr lk "nearbyLandmarks").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parsePoi)))
  let geocodes := mkMap (← (← optArr lk "reverseGeocode").mapM entryGeo)
  let stays := mkMap (← (← optArr lk "bestPlace").mapM entryPlace)
  return {
    landmarksAt := fun lat lon => hit landmarks "nearbyLandmarks" (k3 lat lon LANDMARK_RADIUS_M)
    geocodeAt := fun lat lon zoom => hit geocodes "reverseGeocode" s!"{lat.toBits}|{lon.toBits}|{zoom}"
    stayCtx := fun lat lon s e tz => hit stays "bestPlace" s!"{lat.toBits}|{lon.toBits}|{s}|{e}|{tz}"
    priors := ← parseVenuePriors j
    sizes := landmarks.size + geocodes.size + stays.size
  }

/-- Name one coordinate.

`stay` is `(startUnix, endUnix, tz)` when there is a window to weigh and `none`
when there is not — the two arms of `bestPlace`. The stay-context lookup sits
inside `Option.map`, so a `none` stay never applies the panicking table and a
naming with no window cannot fail on a key it was never going to need. -/
private def Namer.name (n : Namer) (lat lon : Float) (stay : Option (Int × Int × String))
    (preferResidential : Bool) : Option Verified.Geo.SegmentMerge.ResolvedPlace :=
  let ctx := stay.map fun (s, e, tz) => n.stayCtx lat lon s e tz
  Verified.Geo.BestPlace.resolve
    { landmarks := (n.landmarksAt lat lon).toList
      geocode := n.geocodeAt lat lon
      samples := (ctx.map (·.1)).getD [] }
    (stay.map fun (s, e, _) =>
      ({ startUnix := s, endUnix := e, localHour := (ctx.map (·.2)).getD 0 } :
        Verified.Geo.VenuePrior.StayShape))
    n.priors preferResidential

private def parseChain (j : Json) (segs : Array Seg)
    (points : Array Shed.PointF) (display : Array Verified.Geo.WalkAnnotate.PedFix) :
    Except String Verified.Geo.DayChain.Env := do
  let namer ← namerOf j
  return {
    segments := segs
    points := points.map fun p => ⟨p.ts, p.lat, p.lon, p.speedKmh⟩
    displayFixes := display.map fun p => ⟨p.ts, p.lat, p.lon⟩
    morningFixes := (← (← optArr j "morningFixes").mapM parseStayFix).toList
    prevEveningFixes := (← (← optArr j "prevEveningFixes").mapM parseStayFix).toList
    stayPlaces := (← (← optArr j "stayPlaces").mapM parseStayPlace).toList
    dwellPlaces := ← (← optArr j "dwellPlaces").mapM parseDwellPlace
    sleep := (← (← optArr j "rawSleep").mapM parseRawSleep).toList
    dayEndTs := (← optInt j "dayEndTs").getD 0
    dayStartTs := (← optInt j "dayStartTs").getD 0
    dayTz := (j.getObjValAs? String "dayTz").toOption
    -- ⚠ INJECTED, not computed here, unlike `sleepPlace` below (#1055). The
    -- bracket is two `presence_log` reads plus a `focus_places` centroid — DB,
    -- not mirror — so the fold cannot ask for it and is handed the answer. The
    -- shell also names it, which is what `buildInferredStayState`'s doc has
    -- said all along.
    bracketPlace := (j.getObjValAs? String "bracketPlace").toOption
    -- `bestPlace(preferResidential: true)` composed with `placeLabel`, computed
    -- rather than injected as of #430. No stay window: the sleep attribution
    -- asks about a centroid, not about a visit.
    sleepPlace := fun lat lon => (namer.name lat lon none true).map (·.label)
  }

private def parseEnv (j : Json) : Except String Env := do
  let lk := (j.getObjVal? "lookups").toOption.getD (Json.mkObj [])
  let stations := mkMap (← (← optArr lk "nearbyStations").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parseStation)))
  let lines := mkMap (← (← optArr lk "linesAtPoint").mapM (entry3 strs))
  let ways := mkMap (← (← optArr lk "nearbyWays").mapM
    (entry2 (fun v => do (← v.getArr?).mapM parseWay)))
  let stops := mkMap (← (← optArr lk "transitStops").mapM
    (entry3 (fun v => do (← v.getArr?).mapM parseTransitStop)))
  let onLine := mkMap (← (← optArr lk "stationsOnLine").mapM
    (entryS (fun v => do (← v.getArr?).mapM parseLineStation)))
  let tz := mkMap (← (← optArr lk "tzAt").mapM (entry2 (·.getStr?)))
  let namer ← namerOf j
  -- Not under `lookups`: these two are columns and a derived series, not
  -- questions put to the OSM mirror, so a miss in them is not a capture gap.
  let days := mkMap (← (← optArr j "focusPlaceDays").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← (← nth a 1).getInt?)))
  let speeds := mkMap (← (← optArr j "speedByTs").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← jBits (← nth a 1))))
  -- Bound rather than inlined: the Kalman track is both an `Env` field and the
  -- window the re-enrichment closure samples, and those must be the same series.
  let pts ← (← optArr j "points").mapM parsePointF
  let waysAt := fun lat lon => hit ways "nearbyWays" (k2 lat lon)
  -- `enrichMovingSegment` reads only the city fields, so the full response is
  -- narrowed here rather than at the table.
  let geocodeAt := fun (lat lon : Float) (zoom : Int) =>
    (namer.geocodeAt lat lon zoom).map (·.address)
  return {
    points := pts
    rawFixes := ← (← optArr j "rawFixes").mapM parseCoarse
    steps := ← (← optArr j "steps").mapM parseStep
    railStops := ← (← optArr j "railStops").mapM parseRailStops
    nearbyStations := fun lat lon r => hit stations "nearbyStations" (k3 lat lon r)
    linesAtPoint := fun lat lon r => hit lines "linesAtPoint" (k3 lat lon r)
    nearbyWays := waysAt
    -- `reenrichSplitWalks` re-derives one carve remainder's enrichment from its
    -- OWN geometry. `samplesInWindow` is inclusive at both ends, and an empty
    -- window is `none` — which the pass reads as "leave the leg as it stands",
    -- the same answer the TS's `if (segPoints.length === 0) return` gives.
    reenrich := fun seg =>
      Verified.Geo.Enrich.enrichMovingSegment waysAt geocodeAt seg
        ((pts.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs).map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt))
    -- The pedestrian matcher, whole: two OSM reads answered by whoever LINKS
    -- the fold rather than by the request, and all five solver leaves (#952).
    --
    -- Under `verified_cli` the reads resolve to `c/osm-host-stub.c`, which
    -- answers zero polylines — and a leg whose ways come back empty is skipped
    -- before any leaf runs, so the spawned CLI draws exactly what the shells
    -- drew. That is why `UNFED` below still names `walkEnv`: not because a
    -- field here is a stub, but because the answer depends on the link, and the
    -- day gate's default arm is the one that cannot answer.
    -- The road matcher, the same way and for the same reason: the mirror read
    -- comes from the link, the matcher is `Verified.Geo.Match`'s quantised road
    -- arm through `RoadMatchAdapt`. A leg whose corridor comes back empty bails
    -- before the matcher runs (`ways.length === 0` — the pass's own third
    -- asymmetry), so under `verified_cli` this draws what the shell drew.
    roadEnv := {
      drivableRoads := DayEntry.OsmHost.drivableRoads
      matcher := Verified.Geo.RoadMatchAdapt.matcher }
    walkEnv := {
      walkableRoads := DayEntry.OsmHost.walkableRoads
      buildingsNear := DayEntry.OsmHost.buildingsNear
      -- The real pedestrian matcher, through the quantisation adapter
      -- (`Verified.Geo.WalkMatchAdapt`). It draws NOTHING without ways, so
      -- under `verified_cli` — which links the empty stub — this is still the
      -- shell's answer. It only becomes visible in a host that can answer
      -- `walkableRoads`, which is the point.
      matcher := Verified.Geo.WalkMatchAdapt.matcher
      -- The four smoothing/correction leaves. Every one of them was ALREADY
      -- PORTED — `WalkSmooth.reconstructWalk`, `WalkSmooth.refineMatchedPath`,
      -- `WalkEscape.correctWalkPath`, `WalkEscape.snapPassages` — and each
      -- speaks exactly the type its `Env` field declares (`SmoothedPoint` is
      -- `TPt` is `PathPt`), so this is a wiring, not a port.
      --
      -- MEASURED 2026-08-16, and the reason they are wired together: on
      -- 2026-05-14 both arms agreed on all four legs' display-gate decisions
      -- (use=true/false and rawOff/matchedOff/stray to 3 decimals), yet TS drew
      -- 53 vertices on a leg Lean left bare and Lean drew 97 on a leg TS wrote
      -- to `walkSmoothedPath`. Both were THESE stubs: the corrector attaching a
      -- changed raw line, and the reconstruction swap claiming a leg. Neither
      -- was the matcher and neither was the orchestrator.
      reconstruct := fun fixes ways buildings ev =>
        Verified.Geo.WalkSmooth.reconstructWalk fixes ways buildings {} ev
      refineMatched := fun fixes base => Verified.Geo.WalkSmooth.refineMatchedPath fixes base
      -- The diagnostics arm of `correctWalkPath` is `WALK_CORRECT_DIAG=1` on the
      -- TS side — a debug side channel that decides nothing, which is why the
      -- `Env` field never modelled it and why dropping `.2` here is not a loss.
      -- `stepBudgetM := none` is the TS's `correctOpts = undefined`: the same
      -- defaults with the budget invariant switched off, not a budget of zero.
      correct := fun drawn ways buildings budget =>
        (Verified.Geo.WalkEscape.correctWalkPath drawn ways buildings
          { stepBudgetM := budget }).1
      snapPassages := fun drawn ways buildings =>
        Verified.Geo.WalkEscape.snapPassages drawn ways buildings }
    -- Computed, not injected, as of #430 — see `Verified.Geo.BestPlace`.
    bestPlace := fun lat lon s e m => namer.name lat lon (some (s, e, m)) false
    tzAt := fun lat lon => hit tz "tzAt" (k2 lat lon)
    homeTz := ← (← j.getObjVal? "homeTz").getStr?
    stationsOnLine := fun line => hit onLine "stationsOnLine" line
    railRouteCache := ← (← optArr j "railRouteCache").mapM parseRouteRow
    busRouteCache := (← (← optArr j "busRouteCache").mapM parseBusRoute).toList
    transitStops := fun lat lon r => hit stops "transitStops" (k3 lat lon r)
    hmmDecode := ← (← optArr j "hmmDecode").mapM parseHmmSeg
    hsmmPlaces := (← (← optArr j "hsmmPlaces").mapM parseHsmmPlace).toList
    knownPlaces := ← (← optArr j "knownPlaces").mapM parseKnownPlace
    focusPlaceDays := fun id => days[toString id]?
    hr := (← (← optArr j "hr").mapM parseHr).toList
    sleep := (← (← optArr j "sleep").mapM parseSleep).toList
    displayFixes := ← (← optArr j "displayFixes").mapM parsePedFix
    speedByTs := fun ts => speeds[toString ts]?
  }

/-! ### Encoding -/

private def jOptS : Option String → Json
  | none => Json.null
  | some s => Json.str s

private def jOptF : Option Float → Json
  | none => Json.null
  | some f => fBits f

private def jOptI : Option Int → Json
  | none => Json.null
  | some i => Lean.toJson i

private def pathJson (p : Array Verified.Geo.PathPt) : Json :=
  Json.arr (p.map fun q => Json.arr #[fBits q.lat, fBits q.lon, fBits q.ts])

private def biomJson (b : Verified.Geo.SegmentMerge.BiometricEnrichment) : Json :=
  Json.mkObj [
    ("hrMean", jOptF b.hrMean), ("hrMin", jOptF b.hrMin), ("hrMax", jOptF b.hrMax),
    ("hrStd", jOptF b.hrStd), ("sampleCount", Lean.toJson b.sampleCount),
    ("overlapsSleep", Json.bool b.overlapsSleep), ("sleepFraction", fBits b.sleepFraction),
    ("stepsTotal", jOptF b.stepsTotal)]

private def segJson (s : Seg) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("refinedMode", jOptS s.refinedMode),
    ("confidence", fBits s.confidence), ("confidenceMargin", fBits s.confidenceMargin),
    ("avgSpeed", fBits s.avgSpeed), ("maxSpeed", fBits s.maxSpeed),
    ("linearity", fBits s.linearity), ("pointCount", Lean.toJson s.pointCount),
    ("place", jOptS s.place), ("city", jOptS s.city), ("wayName", jOptS s.wayName),
    ("refinedReason", jOptS s.refinedReason),
    ("refinedKinds", Json.arr (s.refinedKinds.map Json.str)),
    ("centroidLat", jOptF s.centroidLat), ("centroidLon", jOptF s.centroidLon),
    ("focusPlaceId", jOptI s.focusPlaceId),
    ("needsReenrich", Json.bool s.needsReenrich),
    ("needsRename", Json.bool s.needsRename),
    ("vehicleKind", jOptS s.vehicleKind),
    ("roadCorridorFraction", jOptF s.roadCorridorFraction),
    ("displayTz", jOptS s.displayTz),
    ("snappedPath", match s.snappedPath with | none => Json.null | some p => pathJson p),
    ("matchedPath", match s.matchedPath with | none => Json.null | some p => pathJson p),
    ("walkMatchedPath", match s.walkMatchedPath with | none => Json.null | some p => pathJson p),
    ("walkSmoothedPath", match s.walkSmoothedPath with | none => Json.null | some p => pathJson p),
    ("biometrics", match s.biometrics with | none => Json.null | some b => biomJson b)]

/-- One `DayState` on the wire.

⚠ PUBLIC (as `Day.stateJson`) because `ServeEntry`'s `clipinferred` mode re-emits states with this
same encoder. Two encoders for one record would drift, and the drift would show
as a field quietly missing from a clipped day but present in an unclipped one. -/
def stateJson (s : Verified.Geo.DayState.DayState) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("place", jOptS s.place), ("wayName", jOptS s.wayName),
    ("asleep", match s.asleep with | none => Json.null | some b => Json.bool b),
    ("tz", jOptS s.tz), ("minutesAsleep", jOptI s.minutesAsleep),
    ("inferred", match s.inferred with | none => Json.null | some b => Json.bool b)]

private def episodeJson (e : Verified.Geo.EpisodeGeometry.Episode) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson e.startTs), ("endTs", Lean.toJson e.endTs),
    ("mode", Json.str e.mode), ("kind", Json.str e.kind), ("place", jOptS e.place),
    -- `ts` rides as bits like its `lat`/`lon` siblings: it is a `Float` now
    -- (#420), and a derived vertex's is fractional, so a JSON number would round
    -- at the boundary the bit encoding exists to avoid. Nothing decodes this
    -- payload yet — the day chain has no serving path (#431) — so a consumer
    -- must read `ts` as bits when one is written.
    ("points", Json.arr (e.points.map fun p =>
      Json.mkObj [("lat", fBits p.lat), ("lon", fBits p.lon), ("ts", jOptF p.ts)]))]

/-- The passes whose output differs from what they were handed — computed from
the trace rather than declared, so it cannot drift from what ran. This is the
witness question at real-day scale: `PassFold.unwitnessed` names the 11 passes
no synthetic day reaches, and a corpus day that fires one retires it. -/
private def changedPasses (input : Array Seg) (trace : Array (String × Array Seg)) : Array String :=
  Id.run do
    let mut prev := input
    let mut out := #[]
    for (name, segs) in trace do
      if segs != prev then out := out.push name
      prev := segs
    return out

/-- The `Env` fields this mode does not feed. Their `Env` defaults are no-ops, so
a pass that needs one runs but decides nothing. Named in the output rather than
left to be inferred from a divergence: an unfed callback and a real disagreement
are different findings, and a parity run that cannot tell them apart reports the
wrong one.

Both entries are SOLVERS — the road and pedestrian matchers, whose street-network
reads and search leaves are 4.31 MiB/day the wire measurement deliberately left
shell-side. `reenrich` was here too and is not any more: it was an OSM read plus
arithmetic, which is a port (`Verified.Geo.Enrich`), not a shell.

⚠ `walkEnv` is now a HALF-TRUTH here and stays only until the gate can tell the
two arms apart. Every one of its seven fields is wired to real Lean; what is
unfed is the LINK — `verified_cli` answers both OSM reads with zero polylines,
and a leg with no ways never reaches a leaf. A host that answers them draws the
same lines the TS does (2026-05-14: the corrector and the reconstruction
bit-identical, the matcher within the quantisation). Removing it from this list
is part of the `LEAN_DAY=on` cutover, because `compare-day`'s classifier reads
it and the default arm would then report a divergence it cannot avoid. -/
private def UNFED : Array String := #["roadEnv", "walkEnv"]

/-- `walkDraw` and `walkFlags` stay at their `Env` defaults — `.matcher`, which
is what production draws, and no flags, which is the request without
`walkMatch=0`. Not in `UNFED` because they are configuration rather than a
callback: the fold gets the production answer, not an empty one. -/

def dayResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let wantTrace ← optBool j "trace" false
    -- ONE input, and one chain from here to the episodes (#430 B2). It used to be
    -- two — the OSM enrichment stage ran between the splits and the corrections
    -- and was not ported, so the corrections had to start from what the TS arm
    -- handed them. `EnrichFold` closed that gap and the day gate measured the
    -- new boundary green on all 33 golden days before this line was joined up.
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let splitCtx : Stays.SplitContext :=
      { hr := (env.hr.map fun h => ⟨h.ts, h.bpm⟩).toArray
        steps := env.steps.map fun s => ⟨s.ts, s.steps⟩ }
    let segsSplit := Verified.Geo.SplitFold.splitFold env.points splitCtx segsRaw
    -- The OSM enrichment stage itself, the piece that used to be the gap between
    -- the two sub-chains (#430 B2). Chained on both sides now.
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        -- The naming arms read the whole response; the moving arm reads only the
        -- city fields, so the narrowing happens here rather than at the table.
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    let segsEnriched := Verified.Geo.EnrichFold.enrichFold enrichReads
      { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
        steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
      (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
      env.points segsSplit
    -- The five corrections that run between the OSM enrichment stage and pass 1
    -- (#430). Same argument as the fold's: they are one stage because the order
    -- is what is being measured — `revertIsolatedCadence` exists to undo the
    -- pass before it, so a shell that re-imposed the sequence would put the
    -- thing under test outside the test. Their observations are the fold's own
    -- `steps` and `hr`, which is why only `modeStats` was added to the wire.
    let segs := Verified.Geo.PreFold.preFold env.biomSteps env.hr modeStats segsEnriched
    let (out, trace) := Verified.Geo.PassFold.runPassesTraced env segs
    -- The fold's output is the chain's input, which is the whole reason these
    -- run in one call rather than two: a second bridge crossing would have to
    -- ship the segments back out and in again, and the two arms could then be
    -- compared against different segment lists without anything saying so.
    let chain ← parseChain envJson out env.points env.displayFixes
    let (states, episodes) := Verified.Geo.DayChain.dayChain chain
    let base := [
      -- The split stage's output — the earliest boundary, and the only one whose
      -- input is not another Lean stage's output.
      ("segsSplit", Json.arr (segsSplit.map segJson)),
      -- The enrichment stage's output — the boundary that used to be the seam.
      ("segsEnriched", Json.arr (segsEnriched.map segJson)),
      -- The corrections' output — the BOUNDARY the chain used to start at. Sent
      -- back so a divergence in the five stages is named where it happens
      -- rather than read off the fold's output dozens of decisions later.
      ("segsMid", Json.arr (segs.map segJson)),
      ("segs", Json.arr (out.map segJson)),
      ("states", Json.arr (states.map stateJson)),
      ("episodes", Json.arr (episodes.map episodeJson)),
      ("passes", Json.arr ((Verified.Geo.PassFold.passNames env).map Json.str)),
      ("changed", Json.arr ((changedPasses segs trace).map Json.str)),
      ("unfed", Json.arr (UNFED.map Json.str))]
    return Json.mkObj (if !wantTrace then base else base ++ [
      ("trace", Json.arr (trace.map fun (name, segs) =>
        Json.mkObj [("name", Json.str name), ("segs", Json.arr (segs.map segJson))]))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-! ### The decode ablation (#433)

#405 measured a bridge call as four layers — request wire, response wire,
per-mode decode, algorithm — and only the last survives the Rust-shell
architecture, where the two arms are one process and there is nothing to
serialise. It also recorded that measuring with `noop` ALONE gets the answer
wrong in the reassuring direction, because `{}` as a reply hides both the
response wire and the decode; on gpsquality that mistake read the floor as a
quarter of the call when it was seven eighths.

`gpsquality` has `gqdecode` for its layer 3. The day mode had nothing, so
`lean/experiments/day-arm-cost.mts` could only report `fold − noop`, which is
layers 2+3+4 added together and therefore an upper bound on the residual rather
than the residual.

This is layer 3: `dayResult`'s parse prefix, and then stop. -/

/-- Force a two-key lookup table by asking it something it CAN answer.

The probe is not decoration. `parseEnv` binds each table's entries with `←`, so
the per-entry parse is forced by the `Except` bind — but `mkMap` on the result is
a plain pure `let` whose only consumers are the closures stored in `Env`, and the
compiler is free to sink such a `let` to its use site (`Main.lean`'s decode-timing
note records the same behaviour biting a timestamp). Whether the hash maps are
built during `parseEnv` or on the fold's first lookup could not be settled by
reading, and a layer measurement that skipped the work it claims to measure would
be worse than none, because it would be quoted.

So each table is asked for the key of its own FIRST entry — a hit, so no `panic!`
fires and no miss-formatting cost enters the measurement — and the answer's size
is folded into the reply, which is what forces it. An empty table has nothing to
build and contributes zero. -/
private def probe2 (lk : Json) (name : String) (f : Float → Float → α) (sz : α → Nat) :
    Except String Nat := do
  match (← optArr lk name)[0]? with
  | none => return 0
  | some e =>
    let a ← e.getArr?
    return sz (f (← jBits (← nth a 0)) (← jBits (← nth a 1)))

/-- As {@link probe2}, for the tables keyed by a radius as well as a coordinate. -/
private def probe3 (lk : Json) (name : String) (f : Float → Float → Float → α) (sz : α → Nat) :
    Except String Nat := do
  match (← optArr lk name)[0]? with
  | none => return 0
  | some e =>
    let a ← e.getArr?
    return sz (f (← jBits (← nth a 0)) (← jBits (← nth a 1)) (← jBits (← nth a 2)))

/-- Layer 2: run the WHOLE chain and return a summary instead of the rows.

`day − dayresp` is the response side — the six `Json.arr (… .map …Json)` AST
builds, `resp.compress`, the wire, and the caller's `JSON.parse`. `dayresp −
daydecode` is then the algorithm alone, which is what `#433` set out to isolate:
the 3.4 s the earlier measurement attributed to "response wire + algorithm,
unseparated" splits here.

`echo` cannot serve this tenant. Its reply is COMPUTED, so there is no input row
to ship back at realistic size — which is why this mode runs the real chain and
withholds only the encode.

# The forcing argument, and why it is CHECKED rather than argued

A handler returning only `changed` would be wrong in a way that looks fine.
`changedPasses segs trace` forces the pass fold, but `let (states, episodes) :=
dayChain chain` is a pure `let` whose result would then go unused — dead-code
elimination removes the call, and the handler would time the fold while claiming
to time the chain.

So the reply carries INTEGER CHECKSUMS over the same values the encoders read:
the timestamp sums and the vertex count. Those cannot be produced without
running the chain, and — the part that matters — they are recomputable from the
full `day` reply, so `day-arm-cost.mts` ASSERTS the two agree instead of
inferring it from a plausible-looking duration. A chain that silently did not
run reads as a mismatch, not as a fast number.

Two admitted biases, both in the same direction as every other choice in this
harness (against the port): the checksum folds are work `day` does not do, and
`passes`/`unfed` are not built here. Both make `dayresp` slower than a pure
"chain without encode", so they UNDERSTATE layer 2 and OVERSTATE the residual. -/
def chainNoEncode (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let splitCtx : Stays.SplitContext :=
      { hr := (env.hr.map fun h => ⟨h.ts, h.bpm⟩).toArray
        steps := env.steps.map fun s => ⟨s.ts, s.steps⟩ }
    let segsSplit := Verified.Geo.SplitFold.splitFold env.points splitCtx segsRaw
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    let segsEnriched := Verified.Geo.EnrichFold.enrichFold enrichReads
      { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
        steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
      (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
      env.points segsSplit
    let segs := Verified.Geo.PreFold.preFold env.biomSteps env.hr modeStats segsEnriched
    let (out, trace) := Verified.Geo.PassFold.runPassesTraced env segs
    let chain ← parseChain envJson out env.points env.displayFixes
    let (states, episodes) := Verified.Geo.DayChain.dayChain chain
    let tsSum (a : Array Seg) : Int := a.foldl (fun acc s => acc + s.startTs + s.endTs) 0
    return Json.mkObj [
      ("nSplit", Lean.toJson segsSplit.size),
      ("nEnriched", Lean.toJson segsEnriched.size),
      ("nMid", Lean.toJson segs.size),
      ("nSegs", Lean.toJson out.size),
      ("nStates", Lean.toJson states.size),
      ("nEpisodes", Lean.toJson episodes.size),
      ("nChanged", Lean.toJson (changedPasses segs trace).size),
      ("sumSegTs", Lean.toJson (tsSum out)),
      ("sumStateTs", Lean.toJson (states.foldl (fun acc s => acc + s.startTs + s.endTs) (0 : Int))),
      ("sumEpisodeTs", Lean.toJson (episodes.foldl (fun acc e => acc + e.startTs + e.endTs) (0 : Int))),
      ("nEpisodePoints", Lean.toJson (episodes.foldl (fun acc e => acc + e.points.size) 0))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

/-- Layer 3: decode the request into the day's own structures and stop.

Mirrors `dayResult`'s parse prefix exactly — same calls, same order — and must
keep mirroring it. `parseChain` is deliberately absent: it takes the fold's
OUTPUT, so it cannot run before the fold and its cost belongs to whatever
handler runs the chain.

The reply is a count rather than `{}` so that the sizes cannot be optimised
away, and small so that layer 2 stays out of it. -/
def decodeOnly (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let places := (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
    let lk := (envJson.getObjVal? "lookups").toOption.getD (Json.mkObj [])
    -- FIVE of the eight maps. The three `namerOf` builds — `nearbyLandmarks`,
    -- `reverseGeocode`, `bestPlace` — are NOT probed, and the reason is a
    -- property of the miss policy rather than an oversight: every route to them
    -- from `Env` goes through `Namer.name`, which composes a landmark lookup
    -- with a geocode lookup and a stay-context lookup, and any of the three can
    -- reach a key this handler did not choose. A miss `panic!`s, and a `panic!`
    -- inside a timing handler both prints and formats its message — cost that
    -- would land in the number and did not come from the decode.
    --
    -- So their hash-map construction is attributed to whatever forces it first,
    -- which is the fold. That UNDERSTATES layer 3 and overstates the residual —
    -- the same direction as every other choice here, against the port.
    let n1 ← probe2 lk "nearbyWays" env.nearbyWays Array.size
    let n2 ← probe2 lk "tzAt" env.tzAt String.length
    let n3 ← probe3 lk "nearbyStations" env.nearbyStations Array.size
    let n4 ← probe3 lk "linesAtPoint" env.linesAtPoint Array.size
    let n5 ← probe3 lk "transitStops" env.transitStops Array.size
    -- The three `namerOf` tables — `nearbyLandmarks`, `reverseGeocode`,
    -- `bestPlace`. They used to be charged to the fold because the only route to
    -- them was `Namer.name`, which composes three lookups and can reach a key a
    -- probe did not choose; a miss `panic!`s, and a panic inside a timing
    -- handler both prints and formats. `Namer.sizes` removes the need to guess a
    -- key at all: it is a structure field, so building the `Namer` builds the
    -- maps. This moves real work out of the residual and into layer 3, which is
    -- where it belongs.
    let namer ← namerOf envJson
    let n := n1 + n2 + n3 + n4 + n5 + namer.sizes
    return Json.mkObj [("n", Lean.toJson
      (n + env.points.size + env.rawFixes.size + env.steps.size + env.displayFixes.size
        + env.railStops.size + env.railRouteCache.size + env.busRouteCache.length
        + env.hmmDecode.size + env.hsmmPlaces.length + env.knownPlaces.size
        + env.hr.length + env.sleep.length
        + modeStats.length + segsRaw.size + places.length))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Day
/-!
# In-process entry point (#952 spike)

`main` above is the process boundary the TS bridge uses: spawn `verified_cli
day`, write JSON to stdin, read JSON from stdout. That transport is 84% of the
day tenant's cost (#433: 9.3 s request wire + 8.0 s typed decode against 3.4 s
of actual work) and it is also why `converge` exists at all — a spawned fold
cannot call back into its caller for a lookup, so `day-serve.ts` runs it 2-7
times, feeding it one more table each round.

Both costs are the WIRE, not the fold. This export is the same `Day.dayResult`
reached through the C ABI instead, so a host that shares the process can call it
directly. It is deliberately the SAME function `main` dispatches to on line
2401: a spike that exported a reimplementation would prove nothing about the
thing that actually runs.

String in, string out, because that is the narrowest possible C ABI that still
carries a real day — `lean_object*` either side, no structs to keep in sync. The
typed decode this leaves in place is the NEXT thing to delete, not this one.
-/
/-! ## `focus` lives here, with its helpers (#982)

Moved out of `Main.lean` because its handler sat in the exe's root module, which
is the one place a host cannot link: a `lean_exe` root emits `main`, and an
archive carrying it wins the link in a foreign host silently. Every helper it
uses — `nth`, `optArr`, `jBits` — was already in this library's `Wire`, so
nothing moved but the namespace itself, byte for byte.

⚠ THAT REASON NO LONGER DISTINGUISHES IT. The same problem was then fixed for
every other handler at once: `Main.lean` is an eleven-line shim and the rest are
`ServeEntry`, a library. So `focus` is here rather than there for the smaller
reason only — this is where its wire helpers are, and it has its own
`health_focus_result` export beside `health_day_result`. A later tidy that moved
it back beside its siblings would not be wrong.
-/

namespace Focus

open Verified.Geo.FocusPlaces
open Verified.Geo.FocusIdentity (ExistingPlace NewCluster matchClusters)
-- The tuple accessors live in `Day` (private, so same-file only, which this is).

private def parseRawPoint (j : Json) : Except String RawPoint := do
  let a ← j.getArr?
  let acc ← match a[3]? with
    | some v => if v.isNull then pure none else some <$> jBits v
    | none => pure none
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), acc⟩

private def parseStay (j : Json) : Except String Stay := do
  let a ← j.getArr?
  return { startTs := ← (← nth a 0).getInt?, endTs := ← (← nth a 1).getInt?,
           centroidLat := ← jBits (← nth a 2), centroidLon := ← jBits (← nth a 3),
           pointCount := (← (← nth a 4).getInt?).toNat, durationSec := ← (← nth a 5).getInt? }

private def parseCluster (j : Json) : Except String Cluster := do
  let stays ← (← optArr j "stays").mapM parseStay
  return { id := ← (← j.getObjVal? "id").getInt?,
           centroidLat := ← jBits (← j.getObjVal? "lat"),
           centroidLon := ← jBits (← j.getObjVal? "lon"),
           stays := stays.toList,
           totalDwellSec := ← (← j.getObjVal? "dwell").getInt? }

private def parseWindow (j : Json) : Except String (Int × Int) := do
  let a ← j.getArr?
  return (← (← nth a 0).getInt?, ← (← nth a 1).getInt?)

private def parseExisting (j : Json) : Except String ExistingPlace := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), ← (← nth a 3).getInt?⟩

private def encStay (s : Stay) : Json :=
  Json.arr #[Lean.toJson s.startTs, Lean.toJson s.endTs, fBits s.centroidLat, fBits s.centroidLon,
             Lean.toJson s.pointCount, Lean.toJson s.durationSec]

/-- A cluster and everything the mining cron derives from it.

The hour profile is emitted BOTH serialised and re-parsed, because
`serializeHourProfile` rounds to permille: comparing only the string would let
`parseHourProfile` drift unseen, and comparing only the parse would hide a
rounding difference the column actually stores. -/
private def report (windows : List (Int × Int)) (c : Cluster) : Json :=
  let profile := serializeHourProfile (hourProfileOf c)
  Json.mkObj [
    ("id", Lean.toJson c.id),
    ("lat", fBits c.centroidLat),
    ("lon", fBits c.centroidLon),
    ("dwell", Lean.toJson c.totalDwellSec),
    ("stays", Json.arr ((c.stays.map encStay).toArray)),
    ("label", Json.str (classifyClusterLabel c)),
    ("profile", Json.str profile),
    ("reparsed", match parseHourProfile (some profile) with
      | none => Json.null
      | some xs => Json.arr ((xs.map fBits).toArray)),
    -- `hourProfileForRange` is the RUNTIME counterpart of `hourProfileOf` — it
    -- scores one live stay against a mined profile — so it is exercised on the
    -- cluster's own first stay rather than left to the guards.
    ("firstStayProfile", match c.stays.head? with
      | none => Json.null
      | some s => Json.str (serializeHourProfile (hourProfileForRange s.startTs s.endTs c.centroidLon))),
    ("sleepH", fBits (sleepHoursOf c)),
    ("sleepFitbitH", fBits (sleepHoursFromFitbit c.stays windows)),
    ("uniqueDays", Lean.toJson (uniqueDayCount c.stays c.centroidLon))]

def focusResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let windows := (← (← optArr j "sleepWindows").mapM parseWindow).toList
    let points := (← (← optArr j "points").mapM parseRawPoint).toList
    let (stays, mined) := detectFocusPlaces points
    let groups ← (← optArr j "clusters").mapM parseCluster
    let old ← (← optArr j "old").mapM parseExisting
    let identity := matchClusters old
      ((mined.map (fun c => ({ centroidLat := c.centroidLat, centroidLon := c.centroidLon } : NewCluster))).toArray)
    return Json.mkObj [
      ("stays", Json.arr ((stays.map encStay).toArray)),
      ("mined", Json.arr ((mined.map (report windows)).toArray)),
      ("names", Json.arr (((assignDisplayNames mined).map
        (fun (id, n) => Json.arr #[Lean.toJson id, Json.str n])).toArray)),
      -- One entry per input cluster: the lobes `splitCluster` returned, which is
      -- the cluster itself when it refused to split.
      ("split", Json.arr (groups.map (fun c => Json.arr (((splitCluster c).map (report windows)).toArray)))),
      ("identity", Json.mkObj [
        ("assignments", Json.arr (identity.assignments.map (fun a =>
          match a.oldId with | none => Json.null | some i => Lean.toJson i))),
        ("deleted", Json.arr (identity.deletedOldIds.map Lean.toJson))])]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Focus

@[export health_focus_result]
def focusResultExport (input : String) : String :=
  match Json.parse input with
  | .error e => (Json.mkObj [("error", Json.str s!"parse: {e}")]).compress
  | .ok j => (Focus.focusResult j).compress

@[export health_day_result]
def dayResultExport (input : String) : String :=
  match Json.parse input with
  | .error e => (Json.mkObj [("error", Json.str s!"parse: {e}")]).compress
  | .ok j => (Day.dayResult j).compress
