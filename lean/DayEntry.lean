import Verified
import DayEntry.Wire
import DayEntry.OsmHost
import DayEntry.Host
import Verified.Geo.WalkMatchAdapt

/-!
# `DayEntry` — the day fold's JSON boundary

The day request comes in as one JSON object (`env`, with the day's stored
decode), the tail names the decoder's segments (`PassFold.passes`), and the
timeline goes out. Every other lookup (OSM tables, zones, geocodes, a stay's
local hours) is asked of the host mid-fold (`DayEntry.Host.ask`), so there are
no lookup tables here and no miss policy: a miss is an ask.

    Verified        pure folds + their #guard specs. No Json, anywhere.
    DayEntry.Wire   the float-exact JSON helpers all entry points share.
    DayEntry.Host   the one ask, and the pipe it crosses.
    DayEntry        this: the day request/response shape.
    ServeEntry      the mode table `verified_cli serve` dispatches on.
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

private def parsePointF (j : Json) : Except String Shed.PointF := do
  let a ← j.getArr?
  return ⟨← (← nth a 0).getInt?, ← jBits (← nth a 1), ← jBits (← nth a 2), ← jBits (← nth a 3)⟩

private def parseCoarse (j : Json) : Except String Verified.Geo.PassFold.CoarseFix := do
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
displayName|null, sleepHoursBits, amenityLabel|null]`: a mined `focus_places`
row, whole, since the stationary branch scores and labels from several of its
fields in one decision. -/
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
    boardStation := ← optStr j "boardStation"
    alightStation := ← optStr j "alightStation"
    boardTs := ← optInt j "boardTs"
    alightTs := ← optInt j "alightTs"
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

private def parseWay (j : Json) : Except String Verified.Geo.RefineMode.NearbyWay := do
  return {
    type := ← (← j.getObjVal? "type").getStr?
    subtype := ← (← j.getObjVal? "subtype").getStr?
    name := ← optStr j "name"
    distanceM := ← optBits j "distanceM"
  }

/-- A Nominatim reverse-geocode, whole: `Verified.Geo.BestPlace` reads the
venue keys, which a narrower decoder would silently drop. -/
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

/-- One Overpass landmark, as `bestPlace` ranks them. `openingHours` is the raw
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
    inside := ← optBool j "inside" false
  }

private def parseVenueStats (j : Json) : Except String Verified.Geo.VenuePrior.VenueTypeStats := do
  return {
    visits := ← jBits (← j.getObjVal? "visits")
    dwell := (← (← optArr j "dwell").mapM jBits).toList
    hours := (← (← optArr j "hours").mapM jBits).toList
  }

/-- The mined visit-shape priors, or `none` when nothing is mined. Association
lists in the encoder's order: `shapeScore` reads the subtype count off
`bySubtype`. -/
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

/-- `[latBits, lonBits, zoom, address|null]`. The zoom is a plain integer (a
literal the caller writes, not a measured double). `null` is Nominatim
resolving nothing, a result, so a key with a null answer is not a miss. -/
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

private def parseLineStation (j : Json) : Except String Verified.Geo.PassFold.LineStation := do
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

/-- `[latBits, lonBits, startTs, endTs, tz, samples, localHour]`: the stay
context of one naming question, keyed on all five arguments since two stays at
one centroid with different windows are different questions. What crosses is
what Lean cannot compute: the stay's minutes and midpoint hour in the venue's
zone, which stays in the key. -/
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

`Verified.Geo.DayChain`'s inputs (raw fixes from outside the day, sleep windows,
mined places, a shell lookup), parsed apart from `Env` as another stage's. -/

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
rather than a parameter: the ring is the picker's, not the caller's. -/
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

/-- One naming's input in the shape `verified_cli serve` mode `bestplace`
reads (`bestPlaceResult` in `ServeEntry`), so a census can replay exactly the
question the fold asked. Floats cross as plain numbers there. -/
private def placeInputJson (pois : List Verified.Geo.BestPlace.Poi)
    (geo : Int → Option Verified.Geo.BestPlace.Result) (samples : List (Nat × Nat))
    (stay : Option Verified.Geo.VenuePrior.StayShape)
    (priors : Option Verified.Geo.VenuePrior.VenuePriors) (preferResidential : Bool) : String :=
  let optS := fun (o : Option String) => match o with | none => Json.null | some v => Json.str v
  let addr := fun (a : Verified.Geo.Enrich.Address) => Json.mkObj
    [("amenity", optS a.amenity), ("tourism", optS a.tourism), ("leisure", optS a.leisure),
     ("shop", optS a.shop), ("building", optS a.building), ("houseNumber", optS a.houseNumber),
     ("road", optS a.road), ("pedestrian", optS a.pedestrian),
     ("neighbourhood", optS a.neighbourhood), ("suburb", optS a.suburb),
     ("stateDistrict", optS a.stateDistrict), ("city", optS a.city), ("town", optS a.town),
     ("village", optS a.village), ("municipality", optS a.municipality)]
  let res := fun (z : Int) => match geo z with
    | none => Json.null
    | some r => Json.mkObj [("displayName", Json.str r.displayName), ("type", Json.str r.type),
                            ("category", Json.str r.category), ("address", addr r.address)]
  let stats := fun (st : Verified.Geo.VenuePrior.VenueTypeStats) => Json.mkObj
    [("visits", Lean.toJson st.visits), ("dwell", Json.arr (st.dwell.map Lean.toJson).toArray),
     ("hours", Json.arr (st.hours.map Lean.toJson).toArray)]
  let pairs := fun (xs : List (String × Verified.Geo.VenuePrior.VenueTypeStats)) =>
    Json.arr (xs.map fun (k, v) => Json.arr #[Json.str k, stats v]).toArray
  (Json.mkObj [
    ("landmarks", Json.arr (pois.map fun p => Json.mkObj
      [("name", Json.str p.name), ("type", Json.str p.type), ("subtype", Json.str p.subtype),
       ("distanceM", Lean.toJson p.distanceM), ("openingHours", optS p.openingHours),
       ("enclosing", Json.bool p.enclosing), ("inside", Json.bool p.inside)]).toArray),
    ("geocode", Json.mkObj [("18", res 18), ("16", res 16)]),
    ("samples", Json.arr (samples.map fun (w, m) => Json.arr #[Lean.toJson w, Lean.toJson m]).toArray),
    ("stay", match stay with
      | none => Json.null
      | some st => Json.mkObj [("startUnix", Lean.toJson st.startUnix), ("endUnix", Lean.toJson st.endUnix),
                               ("localHour", Lean.toJson st.localHour)]),
    ("priors", match priors with
      | none => Json.null
      | some pr => Json.mkObj [("bySubtype", pairs pr.bySubtype), ("byCategory", pairs pr.byCategory),
                               ("totalVisits", Lean.toJson pr.totalVisits)]),
    ("preferResidential", Json.bool preferResidential)]).compress

/-- Name one coordinate. `stay` is `(startUnix, endUnix, tz)` when there is a
window to weigh. The stay-context lookup sits inside `Option.map`, so a naming
without a window never touches the panicking table. -/
private def Namer.name (n : Namer) (lat lon : Float) (stay : Option (Int × Int × String))
    (preferResidential : Bool) : Option Verified.Geo.SegmentMerge.ResolvedPlace :=
  let ctx := stay.map fun (s, e, tz) => n.stayCtx lat lon s e tz
  let pois := (n.landmarksAt lat lon).toList
  let samples := (ctx.map (·.1)).getD []
  let shape := stay.map fun (s, e, _) =>
    ({ startUnix := s, endUnix := e, localHour := (ctx.map (·.2)).getD 0 } :
      Verified.Geo.VenuePrior.StayShape)
  -- The dump is inert without `LEAN_DUMP_DIR`; with it, the geocode table
  -- is read at both zooms, which may ask the host a zoom the chain would not.
  DayEntry.Host.dump "place"
    (fun _ => placeInputJson pois (n.geocodeAt lat lon) samples shape n.priors preferResidential)
    (Verified.Geo.BestPlace.resolve
      { landmarks := pois, geocode := n.geocodeAt lat lon, samples := samples }
      shape n.priors preferResidential)

private def parseChain (j : Json) (segs : Array Seg)
    (points : Array Shed.PointF) (display : Array Verified.Geo.WalkAnnotate.PedFix) :
    Except String Verified.Geo.DayChain.Env := do
  let namer ← namerOf j
  return {
    segments := segs
    points := points
    displayFixes := display.map fun p => ⟨p.ts, p.lat, p.lon⟩
    morningFixes := (← (← optArr j "morningFixes").mapM parseStayFix).toList
    prevEveningFixes := (← (← optArr j "prevEveningFixes").mapM parseStayFix).toList
    stayPlaces := (← (← optArr j "stayPlaces").mapM parseStayPlace).toList
    dwellPlaces := ← (← optArr j "dwellPlaces").mapM parseDwellPlace
    sleep := (← (← optArr j "rawSleep").mapM parseRawSleep).toList
    dayEndTs := (← optInt j "dayEndTs").getD 0
    dayStartTs := (← optInt j "dayStartTs").getD 0
    dayTz := (j.getObjValAs? String "dayTz").toOption
    -- Injected: the bracket is two `presence_log` reads and a `focus_places`
    -- centroid, from the database, which the fold cannot ask for.
    bracketPlace := (j.getObjValAs? String "bracketPlace").toOption
    -- `bestPlace(preferResidential: true)` composed with `placeLabel`, computed
    -- here. No stay window: the sleep attribution asks about a centroid, not
    -- about a visit.
    sleepPlace := fun lat lon => (namer.name lat lon none true).map (·.label)
  }

/-- A walk's remembered result on the wire: lines as exact float bits, the
    way report as `[name, um]` pairs. -/
def walkPatchJson (p : Verified.Geo.WalkAnnotate.WalkPatch) : Json :=
  let line := fun (d : Array Verified.Geo.PathPt) =>
    Json.arr (d.map fun q => Json.arr #[fBits q.lat, fBits q.lon, fBits q.ts])
  let um := fun (w : Array (String × Nat)) =>
    Json.arr (w.map fun (n, x) => Json.arr #[Json.str n, Lean.toJson x])
  let name := fun (n : Option String) => match n with | some s => Json.str s | none => Json.null
  match p with
  | .smoothed d w => Json.mkObj [("k", "s"), ("d", line d), ("w", um w)]
  | .matched d n w => Json.mkObj [("k", "m"), ("d", line d), ("n", name n), ("w", um w)]
  | .plain n w => Json.mkObj [("k", "p"), ("n", name n), ("w", um w)]

def parseWalkPatch (j : Json) : Except String Verified.Geo.WalkAnnotate.WalkPatch := do
  let line := fun (v : Json) => do
    (← v.getArr?).mapM fun q => do
      let a ← q.getArr?
      let some la := a[0]? | throw "patch point: lat"
      let some lo := a[1]? | throw "patch point: lon"
      let some ts := a[2]? | throw "patch point: ts"
      return ({ lat := ← jBits la, lon := ← jBits lo, ts := ← jBits ts } : Verified.Geo.PathPt)
  let um := fun (v : Json) => do
    (← v.getArr?).mapM fun e => do
      let a ← e.getArr?
      let some n := a[0]? | throw "patch way: name"
      let some x := a[1]? | throw "patch way: um"
      return ((← n.getStr?), (← x.getNat?))
  let name ← optStr j "n"
  match ← (← j.getObjVal? "k").getStr? with
  | "s" => return .smoothed (← line (← j.getObjVal? "d")) (← um (← j.getObjVal? "w"))
  | "m" => return .matched (← line (← j.getObjVal? "d")) name (← um (← j.getObjVal? "w"))
  | "p" => return .plain name (← um (← j.getObjVal? "w"))
  | k => throw s!"patch kind {k}"

-- The codec is the identity on what the pass writes, bits included.
private def patchRT (p : Verified.Geo.WalkAnnotate.WalkPatch) : Bool :=
  match parseWalkPatch (walkPatchJson p) with
  | .ok q => q == p
  | .error _ => false
#guard patchRT (.matched #[{ lat := 43.3124365, lon := -1.978038, ts := 1791100000.5 }] (some "Kalea")
  #[("Kalea", 1200000), ("", 7)])
#guard patchRT (.smoothed #[{ lat := -0.0, lon := 0.1, ts := 0 }] #[])
#guard patchRT (.plain none #[("A", 1)])

/-- One matcher call's input, quantised as the matcher sees it, in the shape
`verified_cli matchprof` reads (`parseMatch` in `ServeEntry`). -/
private def matchInputJson (fixes : Array Verified.Geo.PathPt)
    (ways : Array Verified.Geo.OsmCorridor.Way)
    (buildings : Array Verified.Geo.WalkEscape.Ring) : String :=
  open Verified.Geo.WalkMatchAdapt in
  let pt := fun (p : Verified.Geo.QPt) => Json.arr #[Lean.toJson p.la, Lean.toJson p.lo, Lean.toJson p.ts]
  let ll := fun (p : Verified.Geo.QPt) => Json.arr #[Lean.toJson p.la, Lean.toJson p.lo]
  (Json.mkObj [
    ("fixes", Json.arr (fixes.map fun f => pt (pathPtToQ f))),
    ("ways", Json.arr ((waysToQ ways).map fun w =>
      Json.mkObj (("coords", Json.arr (w.coords.map ll)) ::
        match w.name with | some n => [("name", Json.str n)] | none => []))),
    ("buildings", Json.arr ((ringsToQ buildings).map fun r => Json.arr (r.map ll)))]).compress

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
    -- own geometry. `samplesInWindow` is inclusive at both ends, and an empty
    -- window is `none`, which the pass reads as "leave the leg as it stands".
    reenrich := fun seg =>
      Verified.Geo.Enrich.enrichMovingSegment waysAt geocodeAt seg
        ((pts.filter fun p => p.ts ≥ seg.startTs && p.ts ≤ seg.endTs).map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt))
    -- The road matcher: the corridor is an ask (`OsmHost.drivableRoads`), the
    -- matcher `Verified.Geo.Match`'s road arm via `RoadMatchAdapt`. A declined
    -- or empty corridor bails first.
    roadEnv := {
      drivableRoads := DayEntry.OsmHost.drivableRoads
      matcher := Verified.Geo.RoadMatchAdapt.matcher }
    walkEnv := {
      walkableRoads := DayEntry.OsmHost.walkableRoads
      buildingsNear := DayEntry.OsmHost.buildingsNear
      -- The pedestrian matcher via `Verified.Geo.WalkMatchAdapt`; without ways it
      -- draws nothing. Each solver leaf is timed under `walk.<leaf>`.
      matcher := fun fixes ways buildings => DayEntry.Host.timed "walk.matcher" fun _ =>
        DayEntry.Host.dump "match" (fun _ => matchInputJson fixes ways buildings)
          (Verified.Geo.WalkMatchAdapt.matcher fixes ways buildings)
      -- The four smoothing and correction leaves, each speaking its `Env` field's
      -- type, so this is wiring. Wired as one, since the corrector and the
      -- reconstruction swap each changed legs the display gate agreed on.
      reconstruct := fun fixes ways buildings ev => DayEntry.Host.timed "walk.reconstruct" fun _ =>
        Verified.Geo.WalkSmooth.reconstructWalk fixes ways buildings {} ev
      refineMatched := fun fixes base => DayEntry.Host.timed "walk.refine" fun _ =>
        Verified.Geo.WalkSmooth.refineMatchedPath fixes base
      -- `correctWalkPathIn`'s diagnostics decide nothing, so `Env` does not
      -- model them and dropping `.2` here loses nothing. `stepBudgetM := none`
      -- is the defaults with the budget invariant off, not a budget of zero.
      correct := fun drawn ctx budget => DayEntry.Host.timed "walk.correct" fun _ =>
        (Verified.Geo.WalkEscape.correctWalkPathIn ctx drawn { stepBudgetM := budget }).1
      -- A walk's remembered result. Only the serving host keeps
      -- any; a replay answers nothing and every walk is drawn.
      memoGet := fun key => DayEntry.Host.askAs "memo.walkGet" key parseWalkPatch
      memoPut := fun key patch =>
        DayEntry.Host.tell "memo.walkPut" (key ++ "|" ++ (walkPatchJson patch).compress) patch
      snapPassages := fun drawn ctx => DayEntry.Host.timed "walk.snapPassages" fun _ =>
        Verified.Geo.WalkEscape.snapPassagesIn ctx drawn }
    -- Computed, not injected; see `Verified.Geo.BestPlace`.
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
    -- `/api/velocity?walkMatch=0`, the raw baseline the map compares against.
    -- Absent means match, as every other caller expects. It must reach the
    -- fold, not only the cache key, or the A/B compares a value with itself.
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
    -- A debug surface: the ways the walk matcher's route ran along, longest
    -- first. Nothing reads it back, so a replay's input is unchanged.
    ("walkWayUm", Json.arr (s.walkWayUm.map fun (n, um) =>
      Json.arr #[Json.str n, Lean.toJson um])),
    ("roads", Json.arr (s.roads.map Json.str)),
    ("biometrics", match s.biometrics with | none => Json.null | some b => biomJson b)]

/-- One `DayState` on the wire. Public (`Day.stateJson`) because `clipfuture`
re-emits states with it: two encoders would drift. -/
def stateJson (s : Verified.Geo.DayState.DayState) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson s.startTs), ("endTs", Lean.toJson s.endTs),
    ("mode", Json.str s.mode), ("place", jOptS s.place), ("city", jOptS s.city),
    ("placeSource", jOptS s.placeSource),
    -- How often the rule that named `place` has been right.
    ("placeConfidenceKey", jOptS (s.placeSource.bind fun src =>
      Verified.Geo.NameConfidence.key src s.placeShare)),
    ("placeConfidence", match s.placeSource.bind fun src =>
        Verified.Geo.NameConfidence.key src s.placeShare with
      | some k => Lean.toJson (Verified.Geo.NameConfidence.confidence k)
      | none => Json.null),
    ("placeShare", match s.placeShare with | some p => Lean.toJson p | none => Json.null),
    ("placeAt", match s.placeAt with
      | some (lat, lon) => Json.arr #[Lean.toJson lat, Lean.toJson lon]
      | none => Json.null),
    ("wayName", jOptS s.wayName),
    ("roads", Json.arr (s.roads.map Json.str)),
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

/-- A run of travelling states the timeline collapses into one row, assembled
here so the timeline has one list of journeys. -/
private def journeyJson (j : Verified.Eval.Journeys.Journey) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson j.startTs), ("endTs", Lean.toJson j.endTs),
    ("legs", Json.arr (j.legs.map legJson))]

private def episodeJson (e : Verified.Geo.EpisodeGeometry.Episode) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson e.startTs), ("endTs", Lean.toJson e.endTs),
    ("mode", Json.str e.mode), ("kind", Json.str e.kind), ("place", jOptS e.place),
    -- `ts` rides as bits like `lat`/`lon`: a derived vertex's is fractional. No
    -- consumer decodes this yet; one must read `ts` as bits.
    ("points", Json.arr (e.points.map fun p =>
      Json.mkObj [("lat", fBits p.lat), ("lon", fBits p.lon), ("ts", jOptF p.ts)]))]

def MS_TO_KMH : Float := 3.6

/-- The decoder's boundaries fall on whole minutes, so a ride's pull-away may
sit up to one either side of its start. -/
def DECODER_BOUNDARY_SLACK_S : Int := 60
def ZERO_F : Float := 0

/-- `Seg`'s defaults, built once: its Float defaults are literals. -/
def HEAD_SEG : Seg := { startTs := 0, endTs := 0, mode := "" }

private def isVehicle (mode : String) : Bool :=
  mode == "train" || mode == "driving" || mode == "bus" || mode == "cycling"
private def isAfoot (mode : String) : Bool := mode == "walking" || mode == "stationary"

/-- A vehicle/walk or vehicle/stay boundary at fix resolution inside the
decoder's minute grid: among the fix-pair speeds within `DECODER_BOUNDARY_SLACK_S`,
the split with the least squared deviation either side, kept when the vehicle's
side is faster; else the minute stands. -/
def refineBoundary (pts : Array Verified.SpeedFix) (b : Int) (vehicleFirst : Bool) : Int := Id.run do
  -- The fixes within the slack, and the one either side of it: the pair across
  -- the slack's edge can be where the speeds part.
  let lo := (pts.findIdx? fun p => decide (p.ts ≥ b - DECODER_BOUNDARY_SLACK_S)).getD pts.size
  let hi := (pts.findIdx? fun p => decide (p.ts > b + DECODER_BOUNDARY_SLACK_S)).getD pts.size
  let w := pts.extract (lo - 1) (hi + 1)
  -- `v[k]` is the pair `(w[k], w[k+1])`'s speed.
  let v : Array Float := (Array.range (w.size - 1)).filterMap fun k =>
    match w[k]?, w[k + 1]? with
    | some a, some c =>
      if c.ts > a.ts then
        some (Verified.Hsmm.FloatScore.haversineMeters a.lat a.lon c.lat c.lon
          / Float.ofInt (c.ts - a.ts) * MS_TO_KMH)
      else none
    | _, _ => none
  if v.size < 2 || v.size + 1 != w.size then return b
  let stats := fun (xs : Array Float) =>
    let n := Verified.FloatConst.natToFloat xs.size
    let m := xs.foldl (· + ·) ZERO_F / n
    (m, xs.foldl (fun a x => a + (x - m) * (x - m)) ZERO_F)
  let mut best : Option (Float × Int) := none
  for k in [1:v.size] do
    let (ml, sl) := stats (v.extract 0 k)
    let (mr, sr) := stats (v.extract k v.size)
    let faster := if vehicleFirst then ml > mr else mr > ml
    if faster && (best.all fun (s, _) => sl + sr < s) then
      best := some (sl + sr, (w[k]?).map (·.ts) |>.getD b)
  return (best.map (·.2)).getD b

-- A train pulling in at 48 km/h, then a walk at 5: the boundary moves to the
-- fix where the speeds part (the decoder's minute put it 30 s early).
private def rbFix (ts : Int) (lat : Float) : Verified.SpeedFix := ⟨ts, lat, -0.1, 0⟩
private def rbPts : Array Verified.SpeedFix :=
  #[rbFix 940 51.5, rbFix 955 51.5020, rbFix 970 51.5040, rbFix 985 51.5060,
    rbFix 1000 51.5080, rbFix 1015 51.5081, rbFix 1030 51.5082, rbFix 1045 51.5083]
#guard refineBoundary rbPts 970 true == 1000
#guard refineBoundary rbPts 970 false == 970
#guard refineBoundary #[] 970 true == 970

/-- The fastest anyone walks, km/h: the worldline's hard bound on a walk's true
speed (`docs/design/probabilistic-principles.md`, C2). -/
def WALK_MAX_KMH : Float := 12
/-- The fewest pairs of fixes a walk's speed is read from. -/
private def WALK_SPEED_MIN_PAIRS : Nat := 3

/-- A walk between two touching trains whose fixes move faster than walking is
the train (steps taken aboard), so the three become one ride. Over
`WALK_SPEED_MIN_PAIRS` or more consecutive pairs the slowest quarter must still
beat walking, so a real change whose first minute holds the previous ride's end
stays a change. -/
def joinRidesAcrossAboardWalks (hmm : Array Verified.Geo.PlaceOverride.HmmSeg)
    (pts : Array Verified.SpeedFix) : Array Verified.Geo.PlaceOverride.HmmSeg := Id.run do
  let mut out : Array Verified.Geo.PlaceOverride.HmmSeg := #[]
  let mut i := 0
  while i < hmm.size do
    let h := hmm[i]!
    let joined : Option Verified.Geo.PlaceOverride.HmmSeg := match out.back?, hmm[i + 1]? with
      | some prev, some next =>
        if h.mode == "walking" && prev.mode == "train" && next.mode == "train"
            && prev.endTs == h.startTs && h.endTs == next.startTs then
          let w := (pts.filter fun p => p.ts ≥ h.startTs && p.ts ≤ h.endTs).toList
          let speeds := ((w.zip (w.drop 1)).filterMap fun (a, b) =>
            if b.ts > a.ts then
              some (Verified.Hsmm.FloatScore.haversineMeters a.lat a.lon b.lat b.lon
                / Float.ofInt (b.ts - a.ts) * MS_TO_KMH)
            else none).toArray.qsort (· < ·)
          if speeds.size ≥ WALK_SPEED_MIN_PAIRS && speeds[speeds.size / 4]! > WALK_MAX_KMH then
            some { prev with endTs := next.endTs, alightStation := next.alightStation,
                             alightTs := next.alightTs }
          else none
        else none
      | _, _ => none
    match joined with
    | some r =>
      out := out.pop.push r
      i := i + 2
    | none =>
      out := out.push h
      i := i + 1
  return out

private def ride (a b : Int) (bd al : String) : Verified.Geo.PlaceOverride.HmmSeg :=
  { startTs := a, endTs := b, mode := "train", lineName := some "Metropolitan Line",
    boardStation := some bd, alightStation := some al }
private def aboard : Array Verified.Geo.PlaceOverride.HmmSeg :=
  #[ride 0 600 "Farringdon" "Kilburn", { startTs := 600, endTs := 780, mode := "walking" },
    ride 780 900 "Finchley Road" "Wembley Park"]
-- 280 m every 10 s along the walk (100 km/h): one ride, Farringdon → Wembley Park.
#guard (joinRidesAcrossAboardWalks aboard ((List.range 10).toArray.map fun k =>
    rbFix (600 + 10 * Int.ofNat k) (51.5 + 0.0025 * Verified.FloatConst.natToFloat k))).map
    (fun h => (h.startTs, h.endTs, h.boardStation, h.alightStation))
  == #[(0, 900, some "Farringdon", some "Wembley Park")]
-- 15 m every 10 s (5 km/h): a change of trains, kept.
#guard (joinRidesAcrossAboardWalks aboard ((List.range 10).toArray.map fun k =>
    rbFix (600 + 10 * Int.ofNat k) (51.5 + 0.000135 * Verified.FloatConst.natToFloat k))).size == 3
-- Half of the pairs at train speed (the ride before, its edge late), half at a
-- walk: a change of trains, kept.
#guard (joinRidesAcrossAboardWalks aboard ((List.range 10).toArray.map fun k =>
    rbFix (600 + 10 * Int.ofNat k) (51.5 + (if k < 5 then 0.0025 else 0.000135) * Verified.FloatConst.natToFloat k))).size == 3
-- No fixes to read a speed from: kept.
#guard (joinRidesAcrossAboardWalks aboard #[]).size == 3

/-- The decoder's segments with each vehicle ↔ walk-or-stay boundary at fix
resolution (`refineBoundary`). The head's segments and every pass that reads
the decode take these, so no two readers disagree about where a ride ended. -/
def refineDecoderBoundaries (hmm : Array Verified.Geo.PlaceOverride.HmmSeg)
    (pts : Array Verified.SpeedFix) : Array Verified.Geo.PlaceOverride.HmmSeg :=
  hmm.mapIdx fun i h =>
    let startTs := match hmm[i - 1]? with
      | some p =>
        if i > 0 && p.endTs == h.startTs && isVehicle p.mode && isAfoot h.mode then
          refineBoundary pts h.startTs true
        else if i > 0 && p.endTs == h.startTs && isAfoot p.mode && isVehicle h.mode then
          refineBoundary pts h.startTs false
        else h.startTs
      | none => h.startTs
    let endTs := match hmm[i + 1]? with
      | some n =>
        if n.startTs == h.endTs && isVehicle h.mode && isAfoot n.mode then
          refineBoundary pts h.endTs true
        else if n.startTs == h.endTs && isAfoot h.mode && isVehicle n.mode then
          refineBoundary pts h.endTs false
        else h.endTs
      | none => h.endTs
    if startTs < endTs then { h with startTs, endTs } else h

/-- The decoder's segments as the fold's input, measured from the fixes inside
each (mean speed, centroid, count). A train keeps `board → alight · line` as
`wayName` when the chain named both ends, else its line. -/
def decoderSegs (hmm : Array Verified.Geo.PlaceOverride.HmmSeg)
    (pts : Array Verified.SpeedFix)
    (places : List (Int × Verified.Geo.PlaceOverride.PlaceLookup) := []) : Array Seg :=
  let build : Int → Int → String → Option String → Option String → Option Int → Seg :=
    fun startTs endTs mode wayName place placeId =>
    let w := pts.filter fun p => decide (p.ts ≥ startTs) && decide (p.ts ≤ endTs)
    let path := (w.toList.zip w.toList.tail).foldl (fun s (a, b) =>
      s + Verified.Hsmm.FloatScore.haversineMeters a.lat a.lon b.lat b.lon) ZERO_F
    let dur := Float.ofInt (endTs - startTs)
    let n := Verified.FloatConst.natToFloat w.size
    -- A day with no fix at all is at the place the decoder placed it, so the
    -- stay namer names it there. A dark stretch inside a day keeps the name the
    -- rest of the evidence gives it.
    let atPlace := if !pts.isEmpty || mode != "stationary" then none else
      (placeId.bind fun pid => (places.find? (·.1 == pid)).map (·.2)).bind fun pl =>
        match pl.lat, pl.lon with
        | some la, some lo => some (la, lo)
        | _, _ => none
    let centre := if w.isEmpty then (atPlace.map (·.1), atPlace.map (·.2))
      else (some (w.foldl (· + ·.lat) ZERO_F / n), some (w.foldl (· + ·.lon) ZERO_F / n))
    { HEAD_SEG with
      startTs, endTs, mode, wayName, place
      avgSpeed := if dur > ZERO_F then path / dur * MS_TO_KMH else ZERO_F
      pointCount := w.size
      centroidLat := centre.1
      centroidLon := centre.2 }
  (hmm.mapIdx fun i h =>
    let way := if h.mode != "train" then none
      else match h.boardStation, h.alightStation, h.lineName with
        | some b, some a, some l =>
          some (if l == "unknown_rail" then s!"{b} → {a}" else s!"{b} → {a} · {l}")
        | some b, some a, none => some s!"{b} → {a}"
        | _, _, l => l
    -- A wait at a change, from the chain or the decoder, is a stay at the
    -- station and the ride its own span, as the narratives write a change; the
    -- journey referee reads a stay before a ride as its wait. A change: the
    -- other ride is adjacent, or across the in-station walk.
    let trainAt := fun (k : Nat) => (hmm[k]?).any (·.mode == "train")
    let afterTrain := i > 0 && (trainAt (i - 1)
      || (i > 1 && (hmm[i - 1]?).any (·.mode == "walking") && trainAt (i - 2)))
    let beforeTrain := trainAt (i + 1)
      || ((hmm[i + 1]?).any (·.mode == "walking") && trainAt (i + 2))
    let rideStart := if afterTrain then max h.startTs (h.boardTs.getD h.startTs) else h.startTs
    let rideEnd := if beforeTrain then min h.endTs (h.alightTs.getD h.endTs) else h.endTs
    (if rideStart > h.startTs then #[build h.startTs rideStart "stationary" none h.boardStation none] else #[])
      ++ #[build rideStart rideEnd h.mode way (if h.mode == "stationary" then h.boardStation else none) h.placeId]
      ++ (if rideEnd < h.endTs then #[build rideEnd h.endTs "stationary" none h.alightStation none] else #[])).flatten

/-- The passes whose output differs from their input, from the trace rather
than declared: the witness question at real-day scale. -/
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
    let wantTrace ← optBool j "trace" false
    -- The day's segments are the decoder's: a day folds from its stored decode
    -- and the passes that name what it drew (`PassFold.passes`). A day with no
    -- decode is not folded — the server answers that it is being decoded.
    if env.hmmDecode.isEmpty then
      throw "the day has no decode: a day folds from its decode"
    let env := { env with hmmDecode :=
      refineDecoderBoundaries (joinRidesAcrossAboardWalks env.hmmDecode env.points) env.points }
    let segs := decoderSegs env.hmmDecode env.points env.hsmmPlaces
    let namer ← namerOf envJson
    let enrichReads : Verified.Geo.EnrichFold.Reads :=
      { ways := env.nearbyWays
        -- The naming arms read the whole response; the moving arm reads only the
        -- city fields, so the narrowing happens here rather than at the table.
        geocode := fun lat lon zoom => (namer.geocodeAt lat lon zoom).map (·.address)
        stations := env.nearbyStations
        place := fun lat lon pref stay => namer.name lat lon stay pref
        tzAt := env.tzAt }
    let enrichPlaces := (← (← optArr envJson "enrichPlaces").mapM parseNamedPlace).toList
    -- The carved-stop namer, over the day's reads and mined places.
    let env := { env with
      boundarySlackS := DECODER_BOUNDARY_SLACK_S
      nameStay := fun seg =>
        Verified.Geo.EnrichFold.nameStay enrichReads
          { hr := env.hr.map fun h => ⟨h.ts, h.bpm⟩
            steps := (env.steps.map fun s => ⟨s.ts, s.steps⟩).toList }
          enrichPlaces env.points none seg }
    -- Under the head, the train legs the decoder's chain named nothing on (a
    -- mainline or foreign ride) take the cascade's rail-run label, one leg at a
    -- time; the named legs and the changes between them stay as decoded.
    let unnamedRail : Verified.Geo.PassFold.Pass := ("railUnnamed", fun segs =>
      Verified.Geo.RailRunAnnotate.labelUnnamedTrains
        { stationsLookup := fun lat lon =>
            env.nearbyStations lat lon Verified.Geo.RailRunAnnotate.RAIL_RUN_STATION_RADIUS_M
          linesLookup := fun lat lon =>
            env.linesAtPoint lat lon Verified.Geo.PassFold.LINES_AT_POINT_DEFAULT_RADIUS_M }
        segs env.points env.railStops)
    -- The stays take only the enrichment stage's naming (`nameStay`); the
    -- decoder's places then override, and a stay that arrived named keeps it.
    let nameStays : Verified.Geo.PassFold.Pass := ("nameStays", fun segs =>
      segs.map fun s => if s.mode == "stationary" && s.place.isNone then env.nameStay s else s)
    -- A walk or a drive takes its roads and city from the enrichment stage's
    -- moving branch, run over its own fixes, and nothing else of it: that
    -- branch also refines the mode, and under the head the decoder's stands.
    let nameMoves : Verified.Geo.PassFold.Pass := ("nameMoves", fun segs =>
      segs.map fun s =>
        if s.mode != "walking" && s.mode != "driving" then s else
        let pts := (env.points.filter fun p => p.ts ≥ s.startTs && p.ts ≤ s.endTs).map fun p =>
          ({ ts := p.ts, lat := p.lat, lon := p.lon } : Verified.Geo.Enrich.Pt)
        let named := match Verified.Geo.Enrich.enrichMovingSegment enrichReads.ways enrichReads.geocode s pts with
          | some e => { s with wayName := e.wayName, city := e.city }
          | none => s
        if s.mode != "walking" then named else
        -- A walk is labelled by the roads it was on longest (`roadsByTime`), as
        -- the matcher labels one; a five-sample pick named whichever road its
        -- samples hit.
        let roads := Verified.Geo.Enrich.roadsByTime enrichReads.ways pts s.endTs
        -- Every road goes on the segment, so a reader has the whole
        -- attribution, not the three the label has room for.
        let named := { named with roads := roads.map (·.1) }
        match Verified.Geo.SegmentMerge.composeWayName roads with
        | some n => { named with wayName := some n }
        | none => named)
    -- A moving stretch between two stays at one place that never left it is
    -- that stay (`absorbMoveInsidePlace`). After the decoder's places land, since
    -- a dark stay is named by `hsmmOverride`.
    let accOf : Std.HashMap Int Float := env.rawFixes.foldl (fun m f =>
      match f.accuracy with | some a => m.insert f.ts a | none => m) {}
    let accFixes : Array Verified.Geo.SegmentMerge.AccFix := env.points.map fun p =>
      { ts := p.ts, lat := p.lat, lon := p.lon, acc := accOf.getD p.ts 0 }
    let darkMove : Verified.Geo.PassFold.Pass := ("moveInsidePlace", fun segs =>
      Verified.Geo.SegmentMerge.absorbMoveInsidePlace segs accFixes)
    let tail := Verified.Geo.PassFold.passes env
    let tail := match tail.findIdx? (·.1 == "hsmmOverride") with
      | some k => tail.insertIdx! (k + 1) darkMove
      | none => tail.push darkMove
    -- A pause of a minute or two between two walks is part of one walk
    -- (`mergePausesInWalks`), before the walks are named, so the joined walk is
    -- named once from all its fixes.
    let pauses : Verified.Geo.PassFold.Pass := ("pausesInWalks", Verified.Geo.SegmentMerge.mergePausesInWalks)
    let chosen := #[pauses, unnamedRail, nameStays, nameMoves] ++ tail
    let chosen := chosen.map fun (n, f) => (n, fun s => DayEntry.Host.timed s!"pass.{n}" fun _ => f s)
    let (out, trace) := Verified.Geo.PassFold.runPassArrayTraced chosen segs
    -- The fold's output is the chain's input, hence one call: two crossings
    -- could compare different segment lists without saying so.
    let chain ← parseChain envJson out env.points env.displayFixes
    let (states, episodes) := DayEntry.Host.timed "dayChain" fun _ => Verified.Geo.DayChain.dayChain chain
    let base := [
      -- The decoder's segments as the fold received them, before the tail.
      ("segsSplit", Json.arr (segs.map segJson)),
      ("segs", Json.arr (out.map segJson)),
      ("states", Json.arr (states.map stateJson)),
      ("episodes", Json.arr (episodes.map episodeJson)),
      ("journeys", Json.arr
        ((Verified.Geo.ServedJourneys.servedJourneys states).map journeyJson)),
      ("passes", Json.arr ((Verified.Geo.PassFold.passNames env).map Json.str)),
      ("changed", Json.arr ((changedPasses segs trace).map Json.str)),
      -- Read last: it depends on the states, so it runs after everything above.
      ("leanTiming", DayEntry.Host.takeTimings states.size)]
    return Json.mkObj (if !wantTrace then base else base ++ [
      ("trace", Json.arr (trace.map fun (name, segs) =>
        Json.mkObj [("name", Json.str name), ("segs", Json.arr (segs.map segJson))]))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Day
/-! ## `focus` lives here, beside its wire helpers
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

/-- A cluster and everything the mining cron derives from it. The hour profile
goes out serialised and re-parsed, since `serializeHourProfile` rounds to
permille and either alone could drift unseen. -/
private def report (windows : List (Int × Int)) (c : Cluster) : Json :=
  let profile := serializeHourProfile (hourProfileOf c)
  Json.mkObj [
    ("id", Lean.toJson c.id),
    ("lat", fBits c.centroidLat),
    ("lon", fBits c.centroidLon),
    ("dwell", Lean.toJson c.totalDwellSec),
    ("stays", Json.arr ((c.stays.map encStay).toArray)),
    ("visitSs", fBits (visitSpreadOf c)),
    ("label", Json.str (classifyClusterLabel c)),
    ("profile", Json.str profile),
    ("reparsed", match parseHourProfile (some profile) with
      | none => Json.null
      | some xs => Json.arr ((xs.map fBits).toArray)),
    -- `hourProfileForRange` is the runtime counterpart of `hourProfileOf` — it
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
