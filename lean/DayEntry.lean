import Verified
import DayEntry.Wire
import DayEntry.OsmHost
import DayEntry.Host
import Verified.Geo.WalkMatchAdapt

/-!
# `DayEntry` — the day cascade's JSON boundary

The day request comes in as one JSON object (`segsRaw` + `env`), the fold runs,
and the timeline goes back out. Every lookup the fold needs beyond its request —
the OSM tables, the zone at a coordinate, a geocode, a stay's local hours — is
asked of the host mid-fold through `DayEntry.Host.ask` (#1709). Nothing is
carried in the request that the host could answer on demand: there are no
lookup tables here and no miss policy, because a miss is an ask.

Layering, and why it is three and not two:

    Verified        pure folds + their #guard specs. No Json, anywhere.
    DayEntry.Wire   the float-exact JSON helpers all entry points share.
    DayEntry.Host   the one ask, and the pipe it crosses.
    DayEntry        this: the day request/response shape.
    ServeEntry      the mode table `verified_cli serve` dispatches on.

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

/-- Ask key for a lookup of two coordinates, and for three where the third is
the caller's radius. Bit patterns: the host parses them back exactly. -/
private def k2 (a b : Float) : String := s!"{a.toBits}|{b.toBits}"
private def k3 (a b c : Float) : String := s!"{a.toBits}|{b.toBits}|{c.toBits}"

private def mkMap (xs : Array (String × α)) : Std.HashMap String α :=
  xs.foldl (fun m (k, v) => m.insert k v) (Std.HashMap.emptyWithCapacity xs.size)

/-- One ask, parsed as the table's row; the row's answer half, or the default
when the host declines. The row shape (`entry2`/`entry3`/…) is the same one the
golden fixtures record, so a replayed day and a served day read one parser. -/
private def askRow [Inhabited α] (what key : String)
    (entry : Json → Except String (String × α)) : α :=
  ((DayEntry.Host.askAs what key entry).map (·.2)).getD default

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
    -- ⚠ Defaults TRUE when absent: a caller that predates this is not asserting
    -- the direction was unmeasurable, it simply never said (#185).
    directionResolvable := ← optBool j "directionResolvable" true
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

private def namerOf (j : Json) : Except String Namer := do
  return {
    landmarksAt := fun lat lon =>
      askRow "nearbyLandmarks" (k3 lat lon LANDMARK_RADIUS_M)
        (entry3 (fun v => do (← v.getArr?).mapM parsePoi))
    -- `entryGeo` stores `null` as a real answer, so a declined ask and a
    -- geocode that resolved nothing both read `none` here — which is right:
    -- the moving arm names nothing either way.
    geocodeAt := fun lat lon zoom =>
      askRow "reverseGeocode" s!"{lat.toBits}|{lon.toBits}|{zoom}" entryGeo
    stayCtx := fun lat lon s e tz =>
      askRow "bestPlace" s!"{lat.toBits}|{lon.toBits}|{s}|{e}|{tz}" entryPlace
    priors := ← parseVenuePriors j
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
  let namer ← namerOf j
  let homeTz ← (← j.getObjVal? "homeTz").getStr?
  -- Carried in the request rather than asked: these two are columns and a
  -- derived series the host already holds, not questions for the OSM mirror.
  let days := mkMap (← (← optArr j "focusPlaceDays").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← (← nth a 1).getInt?)))
  let speeds := mkMap (← (← optArr j "speedByTs").mapM
    (fun v => do let a ← v.getArr?; return (toString (← (← nth a 0).getInt?), ← jBits (← nth a 1))))
  -- Bound rather than inlined: the Kalman track is both an `Env` field and the
  -- window the re-enrichment closure samples, and those must be the same series.
  let pts ← (← optArr j "points").mapM parsePointF
  let waysAt := fun lat lon =>
    askRow "nearbyWays" (k2 lat lon) (entry2 (fun v => do (← v.getArr?).mapM parseWay))
  -- `enrichMovingSegment` reads only the city fields, so the full response is
  -- narrowed here rather than at the table.
  let geocodeAt := fun (lat lon : Float) (zoom : Int) =>
    (namer.geocodeAt lat lon zoom).map (·.address)
  return {
    points := pts
    rawFixes := ← (← optArr j "rawFixes").mapM parseCoarse
    steps := ← (← optArr j "steps").mapM parseStep
    railStops := ← (← optArr j "railStops").mapM parseRailStops
    nearbyStations := fun lat lon r =>
      askRow "nearbyStations" (k3 lat lon r) (entry3 (fun v => do (← v.getArr?).mapM parseStation))
    linesAtPoint := fun lat lon r => askRow "linesAtPoint" (k3 lat lon r) (entry3 strs)
    nearbyWays := waysAt
    -- `reenrichSplitWalks` re-derives one carve remainder's enrichment from its
    -- OWN geometry. `samplesInWindow` is inclusive at both ends, and an empty
    -- window is `none` — which the pass reads as "leave the leg as it stands",
    -- the same answer the TS's `if (segPoints.length === 0) return` gives.
    reenrich := fun seg =>
      Verified.Geo.Enrich.enrichMovingSegment waysAt geocodeAt seg
        ((pts.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs).map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt))
    -- The road matcher: the corridor read is an ask of the host
    -- (`OsmHost.drivableRoads`), the matcher is `Verified.Geo.Match`'s
    -- quantised road arm through `RoadMatchAdapt`. A leg whose corridor is
    -- declined or empty bails before the matcher runs.
    roadEnv := {
      drivableRoads := DayEntry.OsmHost.drivableRoads
      matcher := Verified.Geo.RoadMatchAdapt.matcher }
    walkEnv := {
      walkableRoads := DayEntry.OsmHost.walkableRoads
      buildingsNear := DayEntry.OsmHost.buildingsNear
      -- The real pedestrian matcher, through the quantisation adapter
      -- (`Verified.Geo.WalkMatchAdapt`). It draws NOTHING without ways, so a
      -- host that declines `walkableRoads` gets the raw leg back.
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
    -- The host answers from a polygon set; where it declines (open sea, a
    -- pole) the home zone is the fallback, as `Env.tzAt`'s doc asks of whoever
    -- supplies the function.
    tzAt := fun lat lon =>
      ((DayEntry.Host.askAs "tzAt" (k2 lat lon) (entry2 (·.getStr?))).map (·.2)).getD homeTz
    homeTz := homeTz
    stationsOnLine := fun line =>
      askRow "stationsOnLine" line (entryS (fun v => do (← v.getArr?).mapM parseLineStation))
    railRouteCache := ← (← optArr j "railRouteCache").mapM parseRouteRow
    busRouteCache := (← (← optArr j "busRouteCache").mapM parseBusRoute).toList
    transitStops := fun lat lon r =>
      askRow "transitStops" (k3 lat lon r)
        (entry3 (fun v => do (← v.getArr?).mapM parseTransitStop))
    hmmDecode := ← (← optArr j "hmmDecode").mapM parseHmmSeg
    hsmmPlaces := (← (← optArr j "hsmmPlaces").mapM parseHsmmPlace).toList
    knownPlaces := ← (← optArr j "knownPlaces").mapM parseKnownPlace
    focusPlaceDays := fun id => days[toString id]?
    hr := (← (← optArr j "hr").mapM parseHr).toList
    sleep := (← (← optArr j "sleep").mapM parseSleep).toList
    displayFixes := ← (← optArr j "displayFixes").mapM parsePedFix
    speedByTs := fun ts => speeds[toString ts]?
    -- `/api/velocity?walkMatch=0`, the raw baseline the map A/Bs the matched
    -- line against. ABSENT MEANS MATCH: every other caller — the gates, the
    -- CLIs, `decode-day` — omits the field and must keep the production draw.
    --
    -- ⚠ It reaches the fold only because the host puts it here. Until #1619 the
    -- query parameter was spent entirely on the cache key, so the two arms
    -- computed the same day and the A/B compared a value with itself.
    walkFlags := { matchDisable := !(← optBool j "walkMatch" true) }
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
    ("walkBuildingsMeasured", match s.walkBuildingsMeasured with | none => Json.null | some b => Json.bool b),
    -- A DEBUG surface (#1464): where the walk matcher's route actually ran,
    -- named way by named way, longest first. ⚠ Nothing consumes it — the day
    -- gate compares `states`, and `parseSeg` does not read it back, so a
    -- replay's INPUT is unchanged by its presence.
    ("walkWayUm", Json.arr (s.walkWayUm.map fun (n, um) =>
      Json.arr #[Json.str n, Lean.toJson um])),
    ("biometrics", match s.biometrics with | none => Json.null | some b => biomJson b)]

/-- One `DayState` on the wire.

⚠ PUBLIC (as `Day.stateJson`) because `ServeEntry`'s `clipinferred` mode re-emits states with this
same encoder. Two encoders for one record would drift, and the drift would show
as a field quietly missing from a clipped day but present in an unclipped one. -/
def stateJson (s : Verified.Geo.DayState.DayState) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("place", jOptS s.place), ("city", jOptS s.city),
    ("wayName", jOptS s.wayName),
    ("asleep", match s.asleep with | none => Json.null | some b => Json.bool b),
    ("tz", jOptS s.tz), ("minutesAsleep", jOptI s.minutesAsleep),
    ("inferred", match s.inferred with | none => Json.null | some b => Json.bool b)]

/-- One leg of an assembled journey. Optional fields ride as `null` rather
than being omitted, the same convention `stateJson` uses one structure over. -/
private def legJson (l : Verified.Eval.Journeys.Leg) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson l.startTs), ("endTs", Lean.toJson l.endTs),
    ("mode", Json.str l.mode), ("line", jOptS l.line),
    ("board", jOptS l.board), ("alight", jOptS l.alight)]

/-- A run of travelling states the timeline collapses into one row.

⚠ ASSEMBLED HERE rather than in the client, which is the point of #229: the
frontend still folds its own (`coalesceJourneys`) and #230 deletes that once
this is read. While both exist, a disagreement between them is a FINDING —
do not reconcile it by tuning the client. -/
private def journeyJson (j : Verified.Eval.Journeys.Journey) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson j.startTs), ("endTs", Lean.toJson j.endTs),
    ("legs", Json.arr (j.legs.map legJson))]

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

/-- `walkDraw` stays at its `Env` default — `.matcher`, which is what production
draws. `walkFlags` is fed from `env.walkMatch`: absent means match, and
`walkMatch=0` sets `matchDisable` for the raw baseline. -/

def dayResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let envJson ← j.getObjVal? "env"
    let env ← parseEnv envJson
    let modeStats := (← (← optArr envJson "modeStats").mapM parseModeStats).toList
    let wantTrace ← optBool j "trace" false
    -- ONE input, and one chain from here to the episodes (#430 B2). `EnrichFold`
    -- carries the OSM enrichment stage that would otherwise split the chain in
    -- two and force the corrections to start from another arm's output.
    let segsRaw ← (← (← j.getObjVal? "segsRaw").getArr?).mapM parseSeg
    let splitCtx : Stays.SplitContext :=
      { hr := (env.hr.map fun h => ⟨h.ts, h.bpm⟩).toArray
        steps := env.steps.map fun s => ⟨s.ts, s.steps⟩ }
    let segsSplit := Verified.Geo.SplitFold.splitFold env.points splitCtx segsRaw
    -- The OSM enrichment stage, chained on both sides so the two sub-chains
    -- meet here rather than through another arm's output (#430 B2).
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        -- The naming arms read the whole response; the moving arm reads only the
        -- city fields, so the narrowing happens here rather than at the table.
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    -- ⚠ `skipEnrich` SKIPS THE OSM ENRICHMENT STAGE, for #1071. `passLimit`
    -- exonerated the pass cascade (0 passes costs what 38 do), and the same
    -- round still issues 133 mirror queries with NO pass running — so the OSM
    -- reads come from here, and this seam says whether the memory does too.
    --
    -- ⚠ ONLY ON THIS CALL SITE. `decodeOnly` has the same three lines and must
    -- keep running the stage: it is the TIMING harness's parse prefix, and an
    -- ablation flag that silently changed it would move a number nobody was
    -- measuring.
    --
    -- ⚠ A skipped stage is a WRONG day — nothing downstream gets a name, a city
    -- or a station. For reading RSS only; never served, blessed or compared.
    -- ⚠ READ OFF `env`, where `build_day_request` writes it (and `walkMatch`).
    -- The first version read the ROOT, so neither seam ever reached Lean and two
    -- arms of identical code were recorded as an ablation.
    let skipEnrich ← optBool envJson "skipEnrich" false
    -- ⚠ HOISTED out of the branch: `(← …)` may only appear directly in a `do`
    -- block, not nested inside an `if` expression.
    let enrichPlaces := (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
    -- `dbgTrace` so the ablation announces itself FROM LEAN: the Rust warning
    -- only proves the flag was written, not that it was read.
    let segsEnriched :=
      if skipEnrich then dbgTrace "lean: skipEnrich — enrichment stage skipped" fun _ => segsSplit
      else Verified.Geo.EnrichFold.enrichFold enrichReads
        { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
          steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
        enrichPlaces env.points segsSplit
    -- The five corrections that run between the OSM enrichment stage and pass 1
    -- (#430). Same argument as the fold's: they are one stage because the order
    -- is what is being measured — `revertIsolatedCadence` exists to undo the
    -- pass before it, so a shell that re-imposed the sequence would put the
    -- thing under test outside the test. Their observations are the fold's own
    -- `steps` and `hr`, which is why only `modeStats` was added to the wire.
    let segs := Verified.Geo.PreFold.preFold env.biomSteps env.hr modeStats segsEnriched
    -- ⚠ `passLimit` RUNS A PREFIX OF THE CASCADE, for #1071's per-pass memory
    -- attribution. Absent it runs them all, which is every caller but the
    -- ablation harness. A truncated cascade is a WRONG day on purpose — passes
    -- undo one another — so its output is for reading RSS and nothing else.
    let allPasses := Verified.Geo.PassFold.passes env
    let chosen := match ← optInt envJson "passLimit" with
      | some n =>
        dbgTrace s!"lean: passLimit {n} — running {min n.toNat allPasses.size} of {allPasses.size} passes"
          fun _ => allPasses.extract 0 n.toNat
      | none => allPasses
    let (out, trace) := Verified.Geo.PassFold.runPassArrayTraced chosen segs
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
      -- The enrichment stage's output — the seam between the two sub-chains.
      ("segsEnriched", Json.arr (segsEnriched.map segJson)),
      -- The corrections' output — a chain BOUNDARY. Sent
      -- back so a divergence in the five stages is named where it happens
      -- rather than read off the fold's output dozens of decisions later.
      ("segsMid", Json.arr (segs.map segJson)),
      ("segs", Json.arr (out.map segJson)),
      ("states", Json.arr (states.map stateJson)),
      ("episodes", Json.arr (episodes.map episodeJson)),
      ("journeys", Json.arr
        ((Verified.Geo.ServedJourneys.servedJourneys states).map journeyJson)),
      ("passes", Json.arr ((Verified.Geo.PassFold.passNames env).map Json.str)),
      ("changed", Json.arr ((changedPasses segs trace).map Json.str))]
    return Json.mkObj (if !wantTrace then base else base ++ [
      ("trace", Json.arr (trace.map fun (name, segs) =>
        Json.mkObj [("name", Json.str name), ("segs", Json.arr (segs.map segJson))]))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Day
/-! ## `focus` lives here, with its helpers

Beside the day cascade rather than in `ServeEntry` only because this is where
its wire helpers are. A later tidy that moved it beside its siblings would not
be wrong.
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
