import Verified.Geo.Enrich
import Verified.Geo.VenuePrior
import Verified.Geo.OpeningHours
import Verified.Geo.SegmentMerge
/-!
# Naming a stay

Which label does the timeline show for a coordinate and, optionally, the stay
there? With a stay, every Overpass landmark plus a Nominatim venue candidate
compete on the venue-plausibility ranking, and the winner must clear a floor.
Without one, `pickBestLandmark`: the same ranking with no stay or priors. Both
fall through the same address chain.

Naming is Lean's: `bestPlace` is two mirror reads (landmarks at 100 m, the
zoom-18 geocode, and zoom 16 on the fall-through) and then ranking and `if`s.
Only opening hours and the stay's local hour need tzdata, so the shell samples
the window into `(weekday, minute-of-day)` pairs
({@link Verified.Geo.OpeningHours.openFractionOver}): the shell supplies when,
Lean decides what.

The corpus reaches both arms: enrichment's stationary branch asks the stay arm
for every stay, and `DayChain` asks the no-stay arm. The guards pin which term
moved a candidate, which a corpus name cannot localise.

Two truthiness rules disagree on purpose: `hasSpecificVenue` treats an empty
string as absent, while `nominatimVenueName` takes the first present key, so
`amenity = ""` beside a real `tourism` yields `""` and the candidate is dropped.
-/

namespace Verified.Geo.BestPlace

open Verified.Geo.Enrich (Address extractCity)
open Verified.Geo.VenuePrior (Landmark StayShape VenuePriors rankVenues VENUE_RANK_FLOOR_NATS)
open Verified.Geo.OpeningHours (parseOpeningHours openFractionOver)

/-- A Nominatim reverse-geocode response, as much of one as the naming reads. -/
structure Result where
  displayName : String
  /-- The OSM tag value — `"restaurant"`, `"park"`. Rendered in parentheses
  after the venue name, so an empty one is omitted rather than printed. -/
  type : String
  /-- The top-level key — `"amenity"`, `"leisure"`, `"place"`. -/
  category : String
  address : Address
  deriving Inhabited, BEq, Repr

/-- An Overpass landmark with its raw opening-hours tag, before evaluation
against a stay; the scorer's {@link Verified.Geo.VenuePrior.Landmark} carries
the resolved `openFraction` instead. -/
structure Poi where
  name : String
  type : String
  subtype : String
  distanceM : Float
  /-- Raw OSM `opening_hours`. ~70% of venue POIs lack it. -/
  openingHours : Option String := none
  enclosing : Bool := false
  /-- Standing inside an open space's outline (`Landmarks.ENCLOSING_OPEN_SPACES`):
  names the stay only where nothing else does. -/
  inside : Bool := false
  deriving Inhabited, BEq, Repr

/-- A string field's truthiness: absent and empty both read as false. -/
private def truthy (o : Option String) : Bool := o.any (· != "")

/-- The `??` chain: an empty string is a value and stops the chain. Distinct
from {@link truthy} on purpose — see the module header. -/
private def nullish (xs : List (Option String)) : Option String :=
  xs.foldl (fun acc x => acc.orElse fun _ => x) none

/-! ## Landmarks into candidates -/

/--
Resolve one POI's hours against the stay's sampled minutes into the `Landmark`
the scorer ranks. A parser `none` is no evidence, not closed, and an absent or
empty tag is the same silence.
-/
def toLandmark (samples : List (Nat × Nat)) (hasStay : Bool) (p : Poi) : Landmark :=
  let openFraction :=
    if !hasStay || !truthy p.openingHours then none
    else match parseOpeningHours (p.openingHours.getD "") with
      | none => none
      | some spec => some (openFractionOver spec samples)
  { name := p.name, type := p.type, subtype := p.subtype, distanceM := p.distanceM,
    openFraction := openFraction, enclosing := p.enclosing, reverseGeocoded := false }

/-- The venue name a specific-venue Nominatim result carries — the address
fields hold the name, not the tag value. -/
def nominatimVenueName (r : Result) : Option String :=
  nullish [r.address.amenity, r.address.tourism, r.address.shop, r.address.leisure]

/-- A specific-venue Nominatim result as a candidate. Distance 0, since zoom 18
named the building the centroid is on, hence `reverseGeocoded` and barred from
near-field dominance. -/
def nominatimVenueCandidate (r : Result) : Option Landmark :=
  match nominatimVenueName r with
  | none => none
  | some name =>
    if name == "" then none else
    let type := if r.category == "tourism" || r.category == "shop" || r.category == "leisure"
                then r.category else "amenity"
    some { name := name, type := type, subtype := r.type, distanceM := 0,
           openFraction := none, enclosing := false, reverseGeocoded := true }

/-! ## Results out of candidates -/

def landmarkToResult (l : Landmark) : Result :=
  let a : Address :=
    if l.type == "amenity" then { amenity := some l.name }
    else if l.type == "tourism" then { tourism := some l.name }
    else if l.type == "leisure" then { leisure := some l.name }
    else if l.type == "shop" then { shop := some l.name }
    else { pedestrian := some l.name }
  { displayName := l.name, type := l.subtype, category := l.type, address := a }

/--
The detailed address underneath, the landmark's own field on top. Field-wise
`orElse` suffices because `result` only ever comes from
{@link landmarkToResult}, which sets exactly one key.
-/
def mergeAddress (over under : Address) : Address :=
  { amenity := over.amenity.orElse fun _ => under.amenity
    tourism := over.tourism.orElse fun _ => under.tourism
    leisure := over.leisure.orElse fun _ => under.leisure
    shop := over.shop.orElse fun _ => under.shop
    building := over.building.orElse fun _ => under.building
    houseNumber := over.houseNumber.orElse fun _ => under.houseNumber
    road := over.road.orElse fun _ => under.road
    pedestrian := over.pedestrian.orElse fun _ => under.pedestrian
    neighbourhood := over.neighbourhood.orElse fun _ => under.neighbourhood
    suburb := over.suburb.orElse fun _ => under.suburb
    stateDistrict := over.stateDistrict.orElse fun _ => under.stateDistrict
    city := over.city.orElse fun _ => under.city
    town := over.town.orElse fun _ => under.town
    village := over.village.orElse fun _ => under.village
    municipality := over.municipality.orElse fun _ => under.municipality }

def withAddressFrom (result : Result) : Option Result → Result
  | none => result
  | some detailed => { result with address := mergeAddress result.address detailed.address }

/-! ## The three predicates the chain turns on -/

def hasSpecificVenue (r : Result) : Bool :=
  truthy r.address.amenity || truthy r.address.tourism
    || truthy r.address.leisure || truthy r.address.shop

def hasResidentialAddress (r : Result) : Bool :=
  truthy r.address.houseNumber && truthy r.address.road

/-- Squares, parks, plazas, named pedestrian areas — useful even without a
venue. -/
def isLandmarkResult (r : Result) : Bool :=
  r.category == "place" || r.category == "leisure" || truthy r.address.pedestrian

/-! ## The lodging override -/

def LODGING_TOURISM_SUBTYPES : List String :=
  ["hotel", "guest_house", "hostel", "apartment", "motel"]
def LODGING_OVERRIDE_DIST_M : Float := 50

def isLodgingLandmark (l : Landmark) : Bool :=
  l.type == "tourism" && LODGING_TOURISM_SUBTYPES.contains l.subtype

/-- The closest lodging POI within {@link LODGING_OVERRIDE_DIST_M}; the strict
`<` keeps the first of an exact tie. -/
def pickLodgingOverride (landmarks : List Landmark) : Option Landmark :=
  (landmarks.filter fun l => isLodgingLandmark l && decide (l.distanceM ≤ LODGING_OVERRIDE_DIST_M)).foldl
    (fun best l => match best with
      | none => some l
      | some b => if decide (l.distanceM < b.distanceM) then some l else best) none

/-! ## `placeLabel` -/

/-- The bare venue name, the user's choice for the timeline. The type still
rides beside the label in the data. -/
private def named (name _type : String) : String := name

/-- Everything before the first comma of `display_name` (`""` for empty). -/
private def firstPart (s : String) : String :=
  (s.splitOn ",").headD ""

/-- OSM types that must never name a stay (the user's call): street furniture
is on almost every street, so "waste_basket on Barn Hill" names a stay by
proximity. Highway classes are `HIGHWAY_CLASSES`, which keep the street. -/
def UNNAMEABLE_TYPES : List String :=
  [ -- street furniture: untended, unnamed, everywhere
    "waste_basket", "bench", "post_box", "bicycle_parking", "drinking_water",
    "telephone", "recycling", "street_lamp", "waste_disposal", "bollard",
    "vending_machine", "parking_meter", "clock", "hydrant", "grit_bin" ]

/-- OSM highway classes (the user's call): the geocode resolved to the road, so
the road is kept and only OSM's class word dropped:

    "secondary on First Way"          ->  "First Way"
    "residential on Caledonian Road"  ->  "Caledonian Road" -/
def HIGHWAY_CLASSES : List String :=
  [ "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
    "residential", "service", "living_street", "pedestrian", "track", "road",
    "footway", "path", "cycleway", "bridleway", "steps" ]

/-- ⚠ A house number is precision a stay centroid cannot support (the user's
call: "area by default, street when confident"). Stays named this way spread
79-102 m, and where the truth could check the number it was wrong every time.
The road is kept, as in `HIGHWAY_CLASSES`:

    "Elm Street 187"   ->  "Elm Street"

Only the rendering changes; `hasResidentialAddress` still decides the branch. -/
def placeLabel (r : Result) : String :=
  let a := r.address
  if truthy a.amenity then named (a.amenity.getD "") r.type
  else if truthy a.tourism then named (a.tourism.getD "") r.type
  else if truthy a.leisure then named (a.leisure.getD "") r.type
  else if truthy a.shop then named (a.shop.getD "") r.type
  else if truthy a.building && r.type != "" then a.building.getD ""
  else if truthy a.houseNumber && truthy a.road then a.road.getD ""
  else if truthy a.pedestrian then named (a.pedestrian.getD "") r.type
  else if HIGHWAY_CLASSES.contains r.type && truthy a.road then a.road.getD ""
  else if r.type != "" && !UNNAMEABLE_TYPES.contains r.type && truthy a.road then
    s!"{r.type} on {a.road.getD ""}"
  else if r.type != "" && !UNNAMEABLE_TYPES.contains r.type && truthy a.neighbourhood then
    s!"{r.type} in {a.neighbourhood.getD ""}"
  else firstPart r.displayName

/-! ## The chain -/

/-- Everything the shell answers for one `bestPlace` question. `geocode` is a
function of the zoom: zoom 16 is asked only at the bottom of the chain, and a
recorded table panics on a key the run never asked. -/
structure Reads where
  landmarks : List Poi
  /-- `osm.reverseGeocode(lat, lon, zoom)` at this coordinate. -/
  geocode : Int → Option Result
  /-- The stay's minutes as `(weekday, minute-of-day)` in the venue's tz. -/
  samples : List (Nat × Nat) := []

/-- The zoom the venue naming asks for first — a building-level result. -/
def DETAIL_ZOOM : Int := 18
/-- The fall-through zoom: a square, a park, a neighbourhood. -/
def AREA_ZOOM : Int := 16

/-- Which branch of the chain named the place: the confidence beside a name is
each branch's hit rate on the confirmed corpus stays. -/
inductive Source where
  /-- The stay lies inside the venue's footprint. -/
  | enclosing
  /-- The venue the zoom-18 geocode names, when the ranking agreed. -/
  | geocodeVenue
  /-- A lodging among the landmarks, for an overnight stay. -/
  | lodging
  /-- A venue-free house address, for a residence or a venueless cluster. -/
  | residential
  /-- The ranked landmark, decided by near-field distance dominance. -/
  | nearField
  /-- The ranked landmark, decided by the summed evidence. -/
  | ranked
  /-- The ranked landmark with no stay to score against. -/
  | landmark
  /-- An open space the stay lies inside, where nothing else named it. -/
  | openSpace
  /-- A geocoded address or area, with no venue behind it. -/
  | address
  deriving Inhabited, BEq, Repr

def Source.key : Source → String
  | .enclosing => "enclosing" | .geocodeVenue => "geocodeVenue" | .lodging => "lodging"
  | .residential => "residential" | .nearField => "nearField" | .ranked => "ranked"
  | .landmark => "landmark" | .openSpace => "openSpace" | .address => "address"

/--
`bestPlace`, whole, with the branch that answered (`Source`), or `none` when
nothing names the place. A `stay` selects the plausibility ranking, its absence
`pickBestLandmark`; `preferResidential` enables the overnight overrides.
-/
def bestPlaceSourced (reads : Reads) (stay : Option StayShape) (priors : Option VenuePriors)
    (preferResidential : Bool) : Option (Result × Source) :=
  let landmarks := reads.landmarks.map (toLandmark reads.samples stay.isSome)
  let openSpace := (reads.landmarks.find? (·.inside)).map (toLandmark reads.samples stay.isSome)
  let detailed := reads.geocode DETAIL_ZOOM
  -- `bestLandmark` and `nominatimWon` thread through the chain; the third
  -- component says whether near-field dominance decided the ranking.
  let (bestLandmark, nominatimWon, byNearField) : Option Landmark × Bool × Bool :=
    match stay with
    | some _ =>
      let nomVenue := match detailed with
        | some d => if hasSpecificVenue d then nominatimVenueCandidate d else none
        | none => none
      -- Skipped when a landmark already names the same venue: that one carries
      -- the `opening_hours` tag and this one does not.
      let candidates := match nomVenue with
        | some nv => if landmarks.any (fun l => l.name == nv.name) then landmarks
                     else landmarks ++ [nv]
        | none => landmarks
      if candidates.isEmpty then (none, false, false) else
      match (rankVenues candidates stay priors).head? with
      | none => (none, false, false)
      | some top =>
        let accepted := top.landmark.enclosing || decide (top.total ≥ VENUE_RANK_FLOOR_NATS)
        if !accepted then (none, false, false)
        else match nomVenue with
          | some nv => if top.landmark.name == nv.name then (none, true, false) else (some top.landmark, false, top.nearField)
          | none => (some top.landmark, false, top.nearField)
    | none =>
      if landmarks.isEmpty then (none, false, false)
      else ((rankVenues landmarks none none).head?.map (·.landmark), false, false)
  let rankedSource : Source :=
    if stay.isNone then .landmark else if byNearField then .nearField else .ranked
  if bestLandmark.any (·.enclosing) then
    some (withAddressFrom (landmarkToResult (bestLandmark.getD default)) detailed, .enclosing)
  else if detailed.any (fun d => hasSpecificVenue d && (if stay.isSome then nominatimWon else true))
    then detailed.map (·, .geocodeVenue)
  else rest bestLandmark rankedSource detailed reads.geocode preferResidential landmarks openSpace
where
  /-- The tail of the chain, split out because Lean has no early `return`. The
  order is load-bearing: the lodging override beats the residential address,
  and both beat the landmark. -/
  rest (bestLandmark : Option Landmark) (rankedSource : Source) (detailed : Option Result)
      (geocode : Int → Option Result) (preferResidential : Bool)
      (landmarks : List Landmark) (openSpace : Option Landmark) : Option (Result × Source) :=
    if preferResidential then
      match pickLodgingOverride landmarks with
      | some lodging => some (withAddressFrom (landmarkToResult lodging) detailed, .lodging)
      | none => afterLodging bestLandmark rankedSource detailed geocode preferResidential openSpace
    else afterLodging bestLandmark rankedSource detailed geocode preferResidential openSpace
  /-- `geocode AREA_ZOOM` is applied here and nowhere earlier: this is the only
  branch that asks it, and asking sooner would put an unneeded request on the
  wire. -/
  afterLodging (bestLandmark : Option Landmark) (rankedSource : Source) (detailed : Option Result)
      (geocode : Int → Option Result) (preferResidential : Bool)
      (openSpace : Option Landmark) : Option (Result × Source) :=
    -- The residential shortcut takes only a venue-free address: a zoom-18
    -- result can print the wrong restaurant amenity-first, so a venue-bearing
    -- one falls through to the ranked landmark.
    if preferResidential && detailed.any (fun d => hasResidentialAddress d && !hasSpecificVenue d)
      then detailed.map (·, .residential)
    else match bestLandmark with
    | some bl => some (withAddressFrom (landmarkToResult bl) detailed, rankedSource)
    | none =>
      -- No venue named it: an open space it lies inside does, before any
      -- address.
      match openSpace with
      | some o => some (withAddressFrom (landmarkToResult o) detailed, .openSpace)
      | none =>
      if detailed.any hasResidentialAddress then detailed.map (·, .residential)
      else
        let area := geocode AREA_ZOOM
        match area with
        | some ar => if hasSpecificVenue ar || isLandmarkResult ar then some (ar, .address)
                     else (detailed.orElse fun _ => area).map (·, .address)
        | none => detailed.map (·, .address)

/-- The chain's answer without its branch — what every caller before the
confidence number read, and what the parity guards pin. -/
def bestPlace (reads : Reads) (stay : Option StayShape) (priors : Option VenuePriors)
    (preferResidential : Bool) : Option Result :=
  (bestPlaceSourced reads stay priors preferResidential).map (·.1)

/-- `bestPlace` composed with `placeLabel` and `extractCity` — the shape the
fold's jitter pass and the sleep-place attribution both consume. -/
def resolve (reads : Reads) (stay : Option StayShape) (priors : Option VenuePriors)
    (preferResidential : Bool) : Option Verified.Geo.SegmentMerge.ResolvedPlace :=
  (bestPlaceSourced reads stay priors preferResidential).map fun (r, src) =>
    { label := placeLabel r, city := extractCity (some r.address), source := src.key
      category := r.category, type_ := r.type }

/-! ## Guards

The ranking is guarded in {@link Verified.Geo.VenuePrior}, the parser in
{@link Verified.Geo.OpeningHours}; here, one case per branch of the chain and
its two string functions. -/

section Guards

private def A : Address := {}
private def res (t c : String) (a : Address) : Result :=
  { displayName := "Somewhere, London, UK", type := t, category := c, address := a }
private def poi (n t s : String) (d : Float) : Poi :=
  { name := n, type := t, subtype := s, distanceM := d }

/-! ### `placeLabel` — every branch, in order -/

#guard placeLabel (res "cafe" "amenity" { A with amenity := some "Olivomare" })
  == "Olivomare"  -- was "Olivomare (cafe)" pre-bare-labels
-- An empty `type` drops the parenthetical rather than printing "()".
#guard placeLabel (res "" "amenity" { A with amenity := some "Olivomare" }) == "Olivomare"
#guard placeLabel (res "hotel" "tourism" { A with tourism := some "The Zetter" }) == "The Zetter"
#guard placeLabel (res "park" "leisure" { A with leisure := some "Regent's Park" }) == "Regent's Park"
#guard placeLabel (res "supermarket" "shop" { A with shop := some "Lidl" }) == "Lidl"
-- Building needs a type; without one it falls through to the address.
#guard placeLabel (res "office" "building" { A with building := some "Kings Place" }) == "Kings Place"
private def buildingNoType : Address :=
  { A with building := some "Kings Place", houseNumber := some "90", road := some "York Way" }
-- The number is precision a stay centroid cannot support; the road survives.
-- See `placeLabel`.
#guard placeLabel (res "" "building" buildingNoType) == "York Way"
-- The case this rule exists for: the corpus labelled a flat with the wrong
-- house number.
#guard placeLabel (res "house" "building" { A with houseNumber := some "161", road := some "Elm Street" })
  == "Elm Street"
-- A house number with no road still falls through, rather than printing a bare
-- number. The condition needs both and always did; this pins that it still does.
#guard placeLabel (res "house" "building" { A with houseNumber := some "161" })
  == "Somewhere"
#guard placeLabel (res "square" "place" { A with pedestrian := some "Granary Square" })
  == "Granary Square"
-- The class is OSM's word, not a person's; the street is what locates the user.
-- See `HIGHWAY_CLASSES`.
#guard placeLabel (res "residential" "highway" { A with road := some "Caledonian Road" })
  == "Caledonian Road"
-- …and a type that is neither furniture nor a highway class still says both.
#guard placeLabel (res "attraction" "tourism" { A with road := some "Barn Hill" })
  == "attraction on Barn Hill"
-- …while furniture says neither, falling through to the display name.
#guard placeLabel (res "waste_basket" "amenity" { A with road := some "Barn Hill" })
  != "waste_basket on Barn Hill"
#guard placeLabel (res "suburb" "place" { A with neighbourhood := some "Barnsbury" })
  == "suburb in Barnsbury"
-- Nothing at all: the first comma-separated part of the display name.
#guard placeLabel (res "" "" A) == "Somewhere"
-- An empty field is not a name — truthiness, not presence.
#guard placeLabel (res "cafe" "amenity" { A with amenity := some "", road := some "York Way" })
  == "cafe on York Way"

/-! ### The two truthiness rules disagreeing

The single input they differ on: an empty `amenity` beside a real `tourism`. -/

private def emptyAmenity : Result := res "hotel" "tourism" { A with amenity := some "", tourism := some "The Zetter" }
#guard hasSpecificVenue emptyAmenity == true
-- `??` stops at the empty string, so the candidate is dropped.
#guard nominatimVenueName emptyAmenity == some ""
#guard nominatimVenueCandidate emptyAmenity == none

/-! ### `landmarkToResult` + `withAddressFrom` -/

private def cafe : Landmark :=
  { name := "Olivomare", type := "amenity", subtype := "restaurant", distanceM := 11 }

#guard (landmarkToResult cafe).address.amenity == some "Olivomare"
#guard (landmarkToResult cafe).type == "restaurant"
#guard (landmarkToResult cafe).category == "amenity"
-- A type outside the four venue keys lands in `pedestrian`.
#guard (landmarkToResult { cafe with type := "place" }).address.pedestrian == some "Olivomare"
-- The detailed address flows underneath; the landmark's own key stays on top.
private def detailedAddrFields : Address :=
  { A with amenity := some "Some Cafe", road := some "Lower Belgrave Street",
           houseNumber := some "10", city := some "London" }
private def detailedAddr : Result := res "house" "building" detailedAddrFields
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.amenity == some "Olivomare"
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.road
  == some "Lower Belgrave Street"
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.city == some "London"

/-! ### The lodging override -/

private def hotel (n : String) (d : Float) : Landmark :=
  { name := n, type := "tourism", subtype := "hotel", distanceM := d }

#guard (pickLodgingOverride [hotel "Far" 60]) == none
#guard (pickLodgingOverride [hotel "Far" 60, hotel "Near" 20]).map (·.name) == some "Near"
-- An exact tie keeps the first, which is what a stable sort would do.
#guard (pickLodgingOverride [hotel "First" 20, hotel "Second" 20]).map (·.name) == some "First"
-- A restaurant is not lodging however close it is.
#guard pickLodgingOverride [{ cafe with distanceM := 1 }] == none

/-! ### The chain

One case per branch, with a stay so the plausibility arm runs. -/

private def stay : StayShape := { startUnix := 0, endUnix := 3600, localHour := 13 }

/-- A `geocode` from two fixed answers. Which zoom is asked is pinned by the day
gate, where a lookup miss names the coordinate. -/
private def geo (detail area : Option Result) : Int → Option Result :=
  fun z => if z == DETAIL_ZOOM then detail else if z == AREA_ZOOM then area else none

-- An enclosing institution outranks everything, and takes the detailed address.
private def hospital : Poi :=
  { name := "Hospital U", type := "amenity", subtype := "hospital", distanceM := 40, enclosing := true }
private def enclosingReads : Reads :=
  { landmarks := [hospital, poi "Costa" "amenity" "cafe" 5], geocode := geo (some detailedAddr) none }
#guard (bestPlace enclosingReads (some stay) none false).map placeLabel == some "Hospital U"

-- An open space the stay lies inside names it when no venue does — and only then.
private def parkPoi : Poi :=
  { name := "Big Park", type := "leisure", subtype := "park", distanceM := 130, inside := true }
private def parkOnly : Reads := { landmarks := [parkPoi], geocode := geo none none }
#guard (bestPlaceSourced parkOnly (some stay) none false).map (fun (r, src) => (placeLabel r, src.key))
  == some ("Big Park", "openSpace")
#guard ((bestPlaceSourced { enclosingReads with landmarks := enclosingReads.landmarks ++ [parkPoi] }
    (some stay) none false).map (·.2.key)) == some "enclosing"


-- No landmarks and no geocode names nothing at all.
private def emptyReads : Reads := { landmarks := [], geocode := geo none none }
#guard bestPlace emptyReads (some stay) none false == none

-- No landmarks, a specific-venue geocode: with a stay the Nominatim candidate
-- must win the ranking to be returned, and unopposed it does.
private def costaOnly : Reads :=
  { landmarks := [], geocode := geo (some (res "cafe" "amenity" { A with amenity := some "Costa" })) none }
#guard (bestPlace costaOnly (some stay) none false).map placeLabel == some "Costa"

-- A landmark beats a non-venue geocode and inherits its address.
private def streetGeocode : Result := res "house" "building" { A with road := some "Lower Belgrave Street" }
private def landmarkVsStreet : Reads :=
  { landmarks := [poi "Olivomare" "amenity" "restaurant" 11], geocode := geo (some streetGeocode) none }
#guard (bestPlace landmarkVsStreet (some stay) none false).map placeLabel == some "Olivomare"

-- Nothing nearby and a residential geocode: the street is the honest label.
-- Would catch an edit that widened `hasResidentialAddress` instead.
private def downing : Result :=
  res "house" "building" { A with houseNumber := some "10", road := some "Downing Street" }
private def addressOnly : Reads := { landmarks := [], geocode := geo (some downing) none }
#guard (bestPlace addressOnly none none false).map placeLabel == some "Downing Street"

-- The fall-through: no landmark, no residential address, and the zoom-16 area
-- names a square.
private def square : Result := res "square" "place" { A with pedestrian := some "Granary Square" }
private def areaSquare : Reads := { landmarks := [], geocode := geo none (some square) }
#guard (bestPlace areaSquare none none false).map placeLabel == some "Granary Square"

-- …and when the area names nothing either, `detailed ?? area` still answers.
private def areaNothing : Reads := { landmarks := [], geocode := geo none (some (res "" "boundary" A)) }
#guard (bestPlace areaNothing none none false).map placeLabel == some "Somewhere"

-- `preferResidential`: an overnight stay 5 m from a guesthouse slept there,
-- beating a nearer café that wins without the flag.
private def guesthouse : Poi := { name := "Sea View", type := "tourism", subtype := "guest_house", distanceM := 5 }
private def nearerCafe : Poi := { name := "Beach Cafe", type := "amenity", subtype := "cafe", distanceM := 2 }
private def residential : Result :=
  res "house" "building" { A with houseNumber := some "12", road := some "Marine Parade" }
private def lodgingReads : Reads := { landmarks := [nearerCafe, guesthouse], geocode := geo (some residential) none }
#guard (bestPlace lodgingReads none none true).map placeLabel == some "Sea View"
#guard (bestPlace lodgingReads none none false).map placeLabel == some "Beach Cafe"

-- The residential shortcut takes only a venue-free address: with the
-- geocode naming a pizza place, the ranked restaurant names the stay; the same
-- address without the venue is taken and labels as its road.
private def trattoria : Poi := { name := "L'artista", type := "amenity", subtype := "restaurant", distanceM := 13 }
private def pizzaPlace : Poi := { name := "Fireaway Pizza", type := "amenity", subtype := "fast_food", distanceM := 57 }
private def eveningStay : StayShape := ⟨1788715200, 1788719520, 18⟩
private def venueAddress : Result :=
  res "fast_food" "amenity" { A with amenity := some "Fireaway Pizza", houseNumber := some "47", road := some "The Parade" }
private def plainAddress : Result :=
  res "house" "building" { A with houseNumber := some "47", road := some "The Parade" }
private def paradeReads (r : Result) : Reads := { landmarks := [trattoria, pizzaPlace], geocode := geo (some r) none }
#guard (bestPlace (paradeReads venueAddress) (some eveningStay) none true).map placeLabel == some "L'artista"
#guard (bestPlace (paradeReads plainAddress) (some eveningStay) none true).map placeLabel == some "The Parade"
-- Without the flag the ranking names it too.
#guard (bestPlace (paradeReads venueAddress) (some eveningStay) none false).map placeLabel == some "L'artista"

/-! ### Hours resolution -/

private def openPoi : Poi :=
  { name := "Lidl", type := "shop", subtype := "supermarket", distanceM := 8,
    openingHours := some "Mo-Sa 08:00-22:00" }

-- Monday 13:00 is inside the window: fully open.
#guard (toLandmark [(0, 780)] true openPoi).openFraction == some 1
-- Sunday is not in the spec at all: fully closed, which is evidence, not silence.
#guard (toLandmark [(6, 780)] true openPoi).openFraction == some 0
-- No stay ⇒ no hours evidence, even with a parseable tag.
#guard (toLandmark [(0, 780)] false openPoi).openFraction == none
-- Outside the parser's subset ⇒ silence, not closed.
#guard (toLandmark [(0, 780)] true { openPoi with openingHours := some "sunrise-sunset" }).openFraction == none
-- An empty tag is silence too — truthiness again.
#guard (toLandmark [(0, 780)] true { openPoi with openingHours := some "" }).openFraction == none

end Guards

end Verified.Geo.BestPlace
